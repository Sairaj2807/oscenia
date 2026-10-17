"""Scheduled-job bookkeeping.

Two tables, both of which exist because a scheduler is not a guarantee. A cron tick can
arrive twice, a process can die mid-run, and an operator will eventually ask "did month-end
actually post?". ``job_runs`` answers all three.

``reminders`` is what the daily jobs produce. The prototype's five cron jobs are seed rows on
a screen — `{ id: 'CJ-2', lastRun: 'Today 08:00' }` — with nothing behind them. These are the
first real implementations, so the output had to be given somewhere to go.
"""

from __future__ import annotations

import enum
import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.domain.masters.models import enum_column


class JobStatus(enum.StrEnum):
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"

    #: Ran, had nothing to do, and says why. Distinct from *succeeded* on purpose: an
    #: operator looking at a month with no depreciation should be able to tell "posted
    #: nothing because nothing was due" from "posted the backlog".
    SKIPPED = "skipped"


class ReminderKind(enum.StrEnum):
    BIRTHDAY = "birthday"
    ANNIVERSARY = "anniversary"
    OVERDUE_INVOICE = "overdue_invoice"
    ASSET_RETURN = "asset_return"
    #: A client event is due to be nudged about (the relationship calendar's event cycle).
    NUDGE = "nudge"


class ReminderStatus(enum.StrEnum):
    OPEN = "open"
    DONE = "done"
    DISMISSED = "dismissed"


class JobRun(Base):
    """One attempt at one job for one period.

    ``UNIQUE (job_key, run_for)`` is the idempotency. ``run_for`` is the period the run
    *covers* — ``'2026-08'`` for month-end depreciation, ``'2026-09-06'`` for a daily sweep —
    **not** the wall-clock time it started. That distinction is the whole point: retrying a
    crashed month-end must land on the same row, not create a second one.
    """

    __tablename__ = "job_runs"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    job_key: Mapped[str] = mapped_column(String(64), index=True)
    run_for: Mapped[str] = mapped_column(String(16))

    status: Mapped[JobStatus] = mapped_column(enum_column(JobStatus, "job_status"))
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    #: What the run did or why it failed, in whatever shape the job finds useful.
    detail: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, server_default="{}")

    #: NULL for a scheduled run; set when a person pressed the button.
    triggered_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )

    __table_args__ = (
        UniqueConstraint("job_key", "run_for", name="job_runs_once"),
        Index("ix_job_runs_recent", "job_key", "started_at"),
    )


class Reminder(Base):
    """Something a person needs to act on, raised by a job.

    ``client_id`` is nullable because not every reminder is about a client — kit that has not
    come back from a venue is about the warehouse. ``ref`` names whatever the reminder is
    about (an invoice number, an item number) as text rather than four nullable foreign keys
    to four different tables.
    """

    __tablename__ = "reminders"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    kind: Mapped[ReminderKind] = mapped_column(enum_column(ReminderKind, "reminder_kind"))
    subject: Mapped[str] = mapped_column(String(300))
    detail: Mapped[str | None] = mapped_column(Text, nullable=True)

    client_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("clients.id"), nullable=True, index=True
    )

    #: The document this is about — 'INV-0045', 'IT-03', or a client number for a birthday.
    #: Deliberately a string: a reminder is a note to a human, and four nullable FKs would
    #: buy referential integrity nobody is going to join on.
    #:
    #: **NOT NULL**, because it is half of the once-per-day constraint below and Postgres
    #: treats NULLs as distinct — a nullable ref would silently switch that constraint off
    #: for exactly the reminders that have no document, which are the ones raised daily.
    ref: Mapped[str] = mapped_column(String(64))

    due_date: Mapped[date] = mapped_column(Date, index=True)
    status: Mapped[ReminderStatus] = mapped_column(
        enum_column(ReminderStatus, "reminder_status"), default=ReminderStatus.OPEN
    )
    raised_by_job: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        # Raising the same reminder every morning until someone acts on it would bury the
        # new ones. One per subject per day, per thing.
        UniqueConstraint("kind", "ref", "due_date", name="reminder_once_per_day"),
        CheckConstraint("length(btrim(subject)) > 0", name="subject_present"),
    )
