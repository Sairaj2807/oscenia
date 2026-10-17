"""The audit log — who did what, to which record, when, and what it looked like before and
after (open question Q13).

The journal is already its own audit trail: it is append-only and every entry records who
posted it. Everything else — publishing an invitation, editing a guest, overriding a
check-in warning, changing someone's role — changes rows in place, and without this table
the previous value is simply gone.

**Append-only, enforced by the database**, like the journal: a trigger refuses UPDATE and
DELETE, so the log survives a bug or a raw-SQL session that would rather it said something
else.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class AuditEvent(Base):
    __tablename__ = "audit_log"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    #: The signed-in user. NULL when the actor is not a staff login — a guest RSVPing
    #: through their link, a client on the edit link, or a scheduled job.
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    #: Who, in words, when there is no user: ``guest G-014``, ``client link``, ``job
    #: ar.overdue_sweep``. For a user it is their e-mail at the time, which survives a rename.
    actor_label: Mapped[str] = mapped_column(String(320))  # an e-mail can be 254+

    #: Dotted verb, e.g. ``invitation.publish``, ``guest.update``, ``user.deactivate``.
    action: Mapped[str] = mapped_column(String(64))

    #: What was acted on. ``entity_id`` is text so it can hold a UUID or a business number.
    entity_type: Mapped[str] = mapped_column(String(40))
    entity_id: Mapped[str] = mapped_column(String(64))

    #: Only the fields that changed — the previous and new values. NULL before a create,
    #: NULL after a delete.
    before: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    after: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)

    #: Anything else worth keeping: a reason, an override flag, a note.
    detail: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, server_default="{}")

    request_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    ip: Mapped[str | None] = mapped_column(String(45), nullable=True)

    __table_args__ = (
        CheckConstraint("length(btrim(action)) > 0", name="action_present"),
        Index("ix_audit_log_entity", "entity_type", "entity_id", "at"),
        Index("ix_audit_log_actor", "actor_user_id", "at"),
        Index("ix_audit_log_at", "at"),
    )
