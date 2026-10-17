"""Write to the audit log.

One call per change, in the same transaction as the change itself — so a rolled-back
request leaves no audit row claiming something happened, and a committed one always has
its row::

    before = snapshot(event, ["status", "published_at"])
    event.status = "published"
    await record_audit(
        session, actor=user, action="invitation.publish",
        entity_type="event", entity_id=event.id,
        before=before, after=snapshot(event, ["status", "published_at"]),
        request=request,
    )

Only the fields that differ are stored, so the log reads as a list of changes rather than a
pile of full-row copies.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable, Mapping
from typing import Any

from fastapi import Request
from pydantic_core import to_jsonable_python
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import request_id_var
from app.domain.audit.models import AuditEvent
from app.domain.masters.models import User


def snapshot(obj: object, fields: Iterable[str]) -> dict[str, Any]:
    """The named attributes of ``obj`` as a plain dict, for ``before`` / ``after``."""
    return {name: getattr(obj, name) for name in fields}


def changed(
    before: Mapping[str, Any] | None, after: Mapping[str, Any] | None
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """Keep only the keys whose value differs. A create or delete keeps its whole side."""
    if before is None or after is None:
        return (dict(before) if before is not None else None), (
            dict(after) if after is not None else None
        )
    keys = [k for k in {**before, **after} if before.get(k) != after.get(k)]
    return {k: before.get(k) for k in keys}, {k: after.get(k) for k in keys}


def _json(value: Mapping[str, Any] | None) -> dict[str, Any] | None:
    # Decimal, date, UUID and enums arrive from model attributes; JSONB wants plain JSON.
    # Money stays a string (Decimal -> "12.50"), as everywhere else in this API.
    return None if value is None else to_jsonable_python(dict(value))


async def record_audit(
    session: AsyncSession,
    *,
    action: str,
    entity_type: str,
    entity_id: uuid.UUID | str,
    actor: User | None = None,
    actor_label: str | None = None,
    before: Mapping[str, Any] | None = None,
    after: Mapping[str, Any] | None = None,
    detail: Mapping[str, Any] | None = None,
    request: Request | None = None,
) -> AuditEvent | None:
    """Append one row. Returns ``None`` — and writes nothing — for an update that changed
    nothing, so a save that was a no-op does not clutter the history."""
    if actor is None and not actor_label:
        raise ValueError("An audit row needs an actor: a user or a label such as 'guest G-014'.")

    old, new = changed(before, after)
    if old is not None and new is not None and not old and not new:
        return None

    request_id = request_id_var.get()
    event = AuditEvent(
        actor_user_id=actor.id if actor is not None else None,
        actor_label=actor_label or (actor.email if actor is not None else ""),
        action=action,
        entity_type=entity_type,
        entity_id=str(entity_id),
        before=_json(old),
        after=_json(new),
        detail=_json(detail) or {},
        request_id=None if request_id == "-" else request_id,
        ip=request.client.host if request is not None and request.client else None,
    )
    session.add(event)
    await session.flush()
    return event
