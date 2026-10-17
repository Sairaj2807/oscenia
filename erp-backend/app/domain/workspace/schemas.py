"""Request and response shapes for workspace tasks.

People travel as user ids with their member number (``M-05``) alongside, because the screens and
the history speak in member numbers. A task is always returned whole — its history, its two
approvals and its files — so a client holds one shape whether it came from the list, a single
read, or the answer to an action.
"""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Literal

from pydantic import BaseModel, Field

from app.core.schemas import Schema

PriorityName = Literal["High", "Medium", "Low"]
StatusName = Literal[
    "To do", "In progress", "Blocked", "Submitted", "Leader approved", "PM approved"
]
StageName = Literal["leader", "pm"]
ActivityKindName = Literal["assign", "status", "block", "reject", "approve", "attach"]


class TaskCreate(BaseModel):
    project_id: uuid.UUID
    title: str = Field(max_length=200)
    description: str = Field(default="", max_length=4000)
    assignee_id: uuid.UUID
    deadline: dt.date
    priority: PriorityName = "Medium"


class BlockIn(BaseModel):
    reason: str = Field(max_length=500)


class RejectIn(BaseModel):
    comment: str = Field(max_length=500)


class ApprovalOut(Schema):
    by_id: uuid.UUID
    by_no: str | None
    at: dt.datetime


class ActivityOut(Schema):
    at: dt.datetime
    by_id: uuid.UUID
    by_no: str | None
    kind: ActivityKindName
    text: str


class TaskFileOut(Schema):
    id: uuid.UUID
    filename: str
    kind: Literal["pdf", "image", "docx"]
    size_bytes: int
    uploader_id: uuid.UUID
    uploader_no: str | None
    created_at: dt.datetime
    #: The server holds the bytes. False for a seeded demo record, which has only its details.
    stored: bool


class TaskOut(Schema):
    id: uuid.UUID
    task_no: str
    project_id: uuid.UUID
    project_no: str
    division: str
    title: str
    description: str
    assignee_id: uuid.UUID
    assignee_no: str | None
    assigned_by_id: uuid.UUID
    assigned_by_no: str | None
    assigned_at: dt.datetime
    deadline: dt.date
    priority: PriorityName
    status: StatusName
    blocker_reason: str
    #: ``leader`` and ``pm`` once given; empty until then, and wiped by a rejection.
    approvals: dict[StageName, ApprovalOut]
    completed_at: dt.datetime | None
    #: Open and past its deadline on the server's clock.
    overdue: bool
    rev: int
    #: Oldest first.
    activity: list[ActivityOut]
    attachments: list[TaskFileOut]
    #: The approval the *caller* can give right now, if any (``leader``, ``pm`` or ``None``).
    my_stage: StageName | None


class FileUrlOut(Schema):
    #: A path that serves the file until it expires (minutes). Ask again when it has.
    url: str
