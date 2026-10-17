"""A request-body cap for the public routes.

The proxy allows hundreds of megabytes (it has to, for invitation videos). Anonymous callers
must not get that: a public RSVP is a few hundred bytes, an invitation section is at most 64 KB.
So anything under the public prefix over ``max_bytes`` is refused before it is read in full,
whether the caller declares its size up front or streams it.
"""

from __future__ import annotations

import json
import re
from typing import Any

from starlette.types import ASGIApp, Message, Receive, Scope, Send

PUBLIC_PREFIX = "/api/v1/public/"
MAX_PUBLIC_BODY = 256 * 1024
#: The one public write that carries a file: the client's upload. Its size is limited per kind
#: by the storage layer while it streams (and by the client key it needs), not by this cap.
UPLOAD_PATH = re.compile(r"^/api/v1/public/client/EV-\d{1,6}/media$")


def _is_upload(scope: Scope) -> bool:
    return scope["method"] == "POST" and UPLOAD_PATH.match(scope["path"]) is not None


class _TooLarge(Exception):
    pass


class PublicBodyLimit:
    def __init__(
        self, app: ASGIApp, *, prefix: str = PUBLIC_PREFIX, max_bytes: int = MAX_PUBLIC_BODY
    ) -> None:
        self.app = app
        self.prefix = prefix
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope["type"] != "http"
            or not scope["path"].startswith(self.prefix)
            or _is_upload(scope)
        ):
            await self.app(scope, receive, send)
            return

        declared = dict(scope["headers"]).get(b"content-length", b"")
        if declared.isdigit() and int(declared) > self.max_bytes:
            await self._refuse(send)
            return

        seen = 0
        started = False

        async def limited() -> Message:
            nonlocal seen
            message = await receive()
            if message["type"] == "http.request":
                seen += len(message.get("body", b""))
                if seen > self.max_bytes:
                    raise _TooLarge
            return message

        async def tracked(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, limited, tracked)
        except _TooLarge:
            if not started:
                await self._refuse(send)

    async def _refuse(self, send: Send) -> None:
        body: dict[str, Any] = {
            "type": "https://oscenia.erp/errors/too-large",
            "title": "Request too large",
            "status": 413,
            "detail": "That request is too large.",
        }
        payload = json.dumps(body).encode()
        await send(
            {
                "type": "http.response.start",
                "status": 413,
                "headers": [
                    (b"content-type", b"application/problem+json"),
                    (b"content-length", str(len(payload)).encode()),
                ],
            }
        )
        await send({"type": "http.response.body", "body": payload})
