"""Domain errors and their RFC 7807 representation.

Status codes carry meaning here, and the distinction matters to the frontend:

* **409 Conflict** — a *refused business operation*. Issuing an invoice twice, deleting a
  used account, settling a settled PO. The request was well-formed; the books say no.
* **422** — malformed input.
* **403** — RBAC. The body names the roles that *are* permitted, matching the prototype's
  ``denialReason()``, so the UI can say something useful instead of "forbidden".
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Request
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

_BASE = "https://oscenia.erp/errors"


class DomainError(Exception):
    """Base for every error the business logic raises deliberately."""

    status: int = 400
    slug: str = "domain-error"
    title: str = "Request failed"

    def __init__(self, detail: str, **extra: Any) -> None:
        super().__init__(detail)
        self.detail = detail
        self.extra = extra

    def to_problem(self) -> dict[str, Any]:
        return {
            "type": f"{_BASE}/{self.slug}",
            "title": self.title,
            "status": self.status,
            "detail": self.detail,
            **self.extra,
        }


class NotFound(DomainError):
    status = 404
    slug = "not-found"
    title = "Not found"


class Invalid(DomainError):
    status = 422
    slug = "invalid"
    title = "Invalid request"


class Conflict(DomainError):
    """A refused operation. The default for anything the ledger will not allow."""

    status = 409
    slug = "conflict"
    title = "Operation refused"


class TooManyAttempts(DomainError):
    """Rate limited. Carries ``retry_after`` so the caller is told when, not just no."""

    status = 429
    slug = "too-many-attempts"
    title = "Too many attempts"

    def __init__(self, detail: str, *, retry_after: int) -> None:
        super().__init__(detail, retry_after=retry_after)
        self.retry_after = retry_after


class PermissionDenied(DomainError):
    status = 403
    slug = "permission-denied"
    title = "Permission denied"

    def __init__(self, detail: str, *, action: str, permitted: list[str] | None = None) -> None:
        super().__init__(detail, action=action, permitted=permitted or [])


class OutOfBalance(Conflict):
    """Debits do not equal credits. Exact — there is no tolerance."""

    slug = "out-of-balance"
    title = "Entry does not balance"


class PeriodClosed(Conflict):
    slug = "period-closed"
    title = "Accounting period is closed"


class ImmutableLedger(Conflict):
    """Someone tried to edit or delete a posted entry."""

    slug = "immutable-ledger"
    title = "Journal entries cannot be changed"

    def __init__(self, detail: str = "") -> None:
        super().__init__(
            detail
            or "A posted entry is never edited or deleted. Post a reversal, or adjust it "
            "(reverse and repost), so the original stays in the audit trail."
        )


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(RequestValidationError)
    async def _validation(request: Request, exc: RequestValidationError) -> JSONResponse:
        # A public caller gets one RFC 7807 answer that names the fields but never echoes what
        # they sent; every other route keeps FastAPI's own shape.
        if not request.url.path.startswith("/api/v1/public/"):
            return await request_validation_exception_handler(request, exc)
        fields = sorted({str(e['loc'][-1]) for e in exc.errors() if e.get('loc')})
        return JSONResponse(
            status_code=422,
            content={
                "type": f"{_BASE}/invalid",
                "title": "Invalid",
                "status": 422,
                "detail": "Please check the form and try again.",
                "fields": fields,
            },
            media_type="application/problem+json",
        )

    @app.exception_handler(DomainError)
    async def _handle(_: Request, exc: DomainError) -> JSONResponse:
        headers: dict[str, str] = {}
        if isinstance(exc, TooManyAttempts):
            # RFC 9110 §10.2.3. A 429 without this tells the client to back off but not for
            # how long, so every well-behaved client has to guess.
            headers["Retry-After"] = str(exc.retry_after)
        return JSONResponse(
            status_code=exc.status,
            content=exc.to_problem(),
            media_type="application/problem+json",
            headers=headers or None,
        )
