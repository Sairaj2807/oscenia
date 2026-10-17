"""Workspace tasks: who is asked to do what, where it stands, who approved it, and what happened.

Ported from the prototype's ``tasks`` slice (``useProto.js`` ~334-440, ``protoSeed.js`` ~60-160).
A task belongs to a project and to a **division** (copied from the assignee when it is made, as
the prototype does, and never moved: the leader who approves first is the one of that division).

**Status runs one way, with one loop back.** To do -> In progress -> Submitted -> Leader approved
-> PM approved; Blocked is a side room off To do / In progress; a rejection sends a Submitted or
Leader-approved task back to In progress and wipes both approvals. The checks below keep the
columns honest (a blocked task has a reason; ``completed_at`` is set exactly when the PM has
approved); the *rules* about who may move it are in ``task_rules.py`` and are enforced by the
service under the task's row lock.

**Activity is the history** and the bell reads it: its ``kind`` and ``text`` are kept as the
prototype wrote them (``submitted for approval``, ``blocked: <reason>``...), because the
notification for "needs your approval" is worked out from the latest such entry.

``task_no`` (``T-101``) comes from the ``task_no_seq`` sequence; the demo seed sets its own
numbers and moves the sequence past them. A sequence is not rolled back, so a refused create can
leave a gap — a number is an identity, not a count.
"""

from __future__ import annotations

import datetime as dt
import enum
import uuid

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Identity,
    Index,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.domain.masters.models import enum_column


class TaskStatus(enum.StrEnum):
    TODO = "To do"
    IN_PROGRESS = "In progress"
    BLOCKED = "Blocked"
    SUBMITTED = "Submitted"
    LEADER_APPROVED = "Leader approved"
    PM_APPROVED = "PM approved"


#: Everything but done: what the boards show, and what can be overdue.
OPEN_STATUSES = (
    TaskStatus.TODO,
    TaskStatus.IN_PROGRESS,
    TaskStatus.BLOCKED,
    TaskStatus.SUBMITTED,
    TaskStatus.LEADER_APPROVED,
)


class TaskPriority(enum.StrEnum):
    HIGH = "High"
    MEDIUM = "Medium"
    LOW = "Low"


class ApprovalStage(enum.StrEnum):
    LEADER = "leader"
    PM = "pm"


class ActivityKind(enum.StrEnum):
    ASSIGN = "assign"
    STATUS = "status"
    BLOCK = "block"
    REJECT = "reject"
    APPROVE = "approve"
    ATTACH = "attach"


class WorkspaceTask(Base):
    __tablename__ = "workspace_tasks"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    #: ``T-101``. What people say, what a chat message links to, what the screens show.
    task_no: Mapped[str] = mapped_column(String(16), unique=True)
    project_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("projects.id"), index=True
    )
    #: The assignee's division when the task was made. The leader of this division approves first.
    division: Mapped[str] = mapped_column(String(64))
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="", server_default="")
    assignee_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id"), index=True
    )
    assigned_by_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), ForeignKey("users.id"))
    #: Set from the injected clock, never by the database, like chat messages.
    assigned_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    deadline: Mapped[dt.date] = mapped_column(Date)
    priority: Mapped[TaskPriority] = mapped_column(
        enum_column(TaskPriority, "task_priority"), default=TaskPriority.MEDIUM
    )
    status: Mapped[TaskStatus] = mapped_column(
        enum_column(TaskStatus, "task_status"), default=TaskStatus.TODO
    )
    blocker_reason: Mapped[str] = mapped_column(Text, default="", server_default="")
    completed_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    #: Moves forward whenever the task, its approvals, its activity or its files change, so a
    #: client that reconnects can ask "what changed" and a live event can say which version it is.
    rev: Mapped[int] = mapped_column(BigInteger, default=1, server_default="1")

    __table_args__ = (
        CheckConstraint("length(btrim(title)) > 0", name="title_present"),
        CheckConstraint(
            "status <> 'Blocked' OR length(btrim(blocker_reason)) > 0", name="blocked_has_reason"
        ),
        CheckConstraint(
            "(status = 'PM approved') = (completed_at IS NOT NULL)", name="done_when_pm_approved"
        ),
        Index("ix_workspace_tasks_project_status", "project_id", "status"),
    )


class TaskApproval(Base):
    """One stage of approval. A rejection deletes both rows, so the task starts again."""

    __tablename__ = "workspace_task_approvals"

    task_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("workspace_tasks.id", ondelete="CASCADE"), primary_key=True
    )
    stage: Mapped[ApprovalStage] = mapped_column(
        enum_column(ApprovalStage, "task_approval_stage"), primary_key=True
    )
    by_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), ForeignKey("users.id"))
    at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))


class TaskActivity(Base):
    """Append-only history of a task."""

    __tablename__ = "workspace_task_activity"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    task_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("workspace_tasks.id", ondelete="CASCADE")
    )
    at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    by_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), ForeignKey("users.id"))
    kind: Mapped[ActivityKind] = mapped_column(enum_column(ActivityKind, "task_activity_kind"))
    text: Mapped[str] = mapped_column(Text)

    __table_args__ = (Index("ix_workspace_task_activity_task", "task_id", "id"),)


class TaskAttachment(Base):
    """A file on a task. Like chat attachments, the row is all this module owns: the stored bytes
    are content-addressed and may be shared, so deleting a row never deletes the file."""

    __tablename__ = "workspace_task_attachments"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    task_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("workspace_tasks.id", ondelete="CASCADE")
    )
    uploader_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), ForeignKey("users.id"))
    #: Empty for a seeded record that has no bytes behind it.
    storage_key: Mapped[str | None] = mapped_column(String(200), nullable=True)
    filename: Mapped[str] = mapped_column(String(120))
    #: ``pdf``, ``image`` or ``docx`` — what the prototype's card shows.
    kind: Mapped[str] = mapped_column(String(8))
    content_type: Mapped[str] = mapped_column(String(80))
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint("kind IN ('pdf', 'image', 'docx')", name="kind_known"),
        CheckConstraint("size_bytes > 0", name="has_bytes"),
        Index("ix_workspace_task_attachments_task", "task_id", "created_at"),
    )
