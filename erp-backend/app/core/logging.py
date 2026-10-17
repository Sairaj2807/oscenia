"""Structured logging, and a request id that survives across log lines.

The problem this solves: when a posting fails at 2am, the useful question is "what else
happened in that request?" — and without a correlation id the answer is a guess, because a
dozen requests interleave in the log. Every line emitted while handling a request carries the
same ``request_id``, and the response carries it too, so a user can quote the id from a failed
call and the log can be searched for exactly that.

Output is JSON when ``LOG_JSON`` is on (for anything shipping logs somewhere) and plain text
otherwise, because a developer reading a terminal should not have to parse JSON by eye.
"""

from __future__ import annotations

import json
import logging
import sys
import time
import uuid
from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from typing import Any

from fastapi import FastAPI, Request, Response

#: Set per request, read by the log filter. A ContextVar rather than a global because
#: requests are handled concurrently on one event loop and a global would bleed between them.
request_id_var: ContextVar[str] = ContextVar("request_id", default="-")

HEADER = "X-Request-ID"


class RequestIdFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = request_id_var.get()
        return True


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "request_id": getattr(record, "request_id", "-"),
            "message": record.getMessage(),
        }
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False)


def configure_logging(*, level: str = "INFO", as_json: bool = False) -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.addFilter(RequestIdFilter())
    handler.setFormatter(
        JsonFormatter()
        if as_json
        else logging.Formatter("%(asctime)s %(levelname)-7s [%(request_id)s] %(name)s: %(message)s")
    )

    root = logging.getLogger()
    # Replace rather than append: calling this twice (a reload, a test) would otherwise
    # duplicate every line, which is the sort of thing nobody notices until an incident.
    root.handlers = [handler]
    root.setLevel(level.upper())


def install_request_id(app: FastAPI) -> None:
    log = logging.getLogger("app.request")

    @app.middleware("http")
    async def _tag(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        # An id supplied by the caller is honoured so a trace can span the frontend and the
        # backend — but it is length-capped, because it ends up in a response header and in
        # every log line, and neither should be attacker-sized.
        incoming = (request.headers.get(HEADER) or "").strip()[:64]
        request_id = incoming or uuid.uuid4().hex[:16]
        token = request_id_var.set(request_id)

        started = time.perf_counter()
        try:
            response = await call_next(request)
            response.headers[HEADER] = request_id
            # Logged inside the try, before the reset below: a completion line without the
            # id it belongs to is exactly the line you cannot search for later.
            log.info(
                "%s %s %s %.0fms",
                request.method,
                request.url.path,
                response.status_code,
                (time.perf_counter() - started) * 1000,
            )
            return response
        except Exception:
            log.exception(
                "%s %s failed after %.0fms",
                request.method,
                request.url.path,
                (time.perf_counter() - started) * 1000,
            )
            raise
        finally:
            request_id_var.reset(token)
