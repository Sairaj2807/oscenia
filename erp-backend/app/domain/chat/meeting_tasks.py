"""Tasks from the minutes: each action item becomes a task, once.

Ported from the prototype's ``createTasksFromMeeting`` (``useProto.js`` ~657-676). The rules that
make it safe to press the button:

* **It is the caller making the tasks**, through the same checks as making one by hand
  (``workspace/tasks.create``): only for someone they may assign to on that project, only with a
  deadline that has not passed. An item the rules refuse is *skipped with the reason*, not
  forced — the PM can still make it by hand.
* **Only people who read the meeting may do it**, and only on a call held in a project's channel
  (a task belongs to a project).
* **Never twice.** An item remembers the task made from it (``task_no`` in the stored minutes) and
  is passed over afterwards; rewriting the minutes keeps the link (``meetings.write_summary``).
* An item with no owner, or no due date, is skipped: a task needs someone and a day.
* The task's title is the item's first 80 characters; its description says which call it came
  from.
"""

from __future__ import annotations

import copy
import datetime as dt
import uuid
from dataclasses import dataclass, field
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import Clock
from app.core.config import get_settings
from app.core.errors import Conflict, Invalid, PermissionDenied
from app.domain.chat import meeting_rules as rules
from app.domain.chat.meetings import Loaded
from app.domain.chat.service import ChatContext
from app.domain.workspace import tasks
from app.domain.workspace.models import WorkspaceTask
from app.domain.workspace.schemas import TaskCreate

TITLE_MAX = 80


@dataclass
class Made:
    directory: tasks.Directory
    rows: list[WorkspaceTask] = field(default_factory=list)
    skipped: list[tuple[str, str]] = field(default_factory=list)


async def create_tasks(
    session: AsyncSession,
    ctx: ChatContext,
    clock: Clock,
    loaded: Loaded,
    request: Request | None = None,
) -> Made:
    facts, channel = loaded.facts(), ctx.view(loaded.channel)
    if not rules.can_see_meeting(ctx.me_member, facts, channel, ctx.project_divisions):
        raise PermissionDenied("You cannot read this meeting.", action="chat:meeting-tasks")
    row = loaded.row
    if row.summary is None:
        raise Conflict("There are no minutes to take tasks from yet.")
    project_id = loaded.channel.project_id
    if project_id is None:
        raise Invalid("Tasks belong to a project; this call was not on one.")

    d = await tasks.load_directory(session, ctx.me)
    day = row.started_at.astimezone(ZoneInfo(get_settings().timezone)).date().isoformat()
    summary: dict[str, Any] = copy.deepcopy(row.summary)
    made = Made(directory=d)
    for item in summary.get("action_items", []):
        if item.get("task_no"):
            continue  # already a task: never twice
        text = item["text"]
        if not item.get("owner_id"):
            made.skipped.append((text, "no owner"))
            continue
        if not item.get("due"):
            made.skipped.append((text, "no due date"))
            continue
        body = TaskCreate(
            project_id=project_id,
            title=text[:TITLE_MAX],
            description=f"From meeting {day}.",
            assignee_id=uuid.UUID(item["owner_id"]),
            deadline=dt.date.fromisoformat(item["due"]),
        )
        try:
            created = await tasks.create(session, d, clock, body, request)
        except (PermissionDenied, Invalid) as refusal:
            made.skipped.append((text, refusal.detail))
            continue
        item["task_no"] = created.task_no
        made.rows.append(created)
    if made.rows:
        row.summary = summary  # a new dict, so the change is noticed
        await session.flush()
    return made
