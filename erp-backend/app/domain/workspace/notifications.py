"""The task items in the notification bell: what needs your approval, what was given to you, sent
back, signed off or blocked.

Ported from the task half of ``erp-frontend/src/lib/notifications.js``. Like the chat items
(``chat/notifications.py``) they are **worked out from the data on every read**, so an item can
never disagree with the task it points at: approve it and "needs your approval" is simply gone.
What is stored is only what has been *read*, and that stays with the client (``read`` is ``None``),
as in the prototype.

Which items, and who gets them (all only for tasks the caller may see):

* **Needs your approval** — you hold an approval stage on it right now. Pinned to the top.
* **Assigned to you** — someone else gave it to you and it is still open.
* **Sent back** — you are the assignee and the last thing that happened was a rejection by someone
  else.
* **Approved** — you are the assignee and the PM has signed it off (kept for 30 days: a bell is not
  an archive).
* **Blocked** — it is blocked, you are not the one doing it, and you handed it out (or you are the
  PM).

Item ids are stable and carry the moment that makes each one new (``approve:T-102:<time>``): a
re-submission after a rejection rings again, and a client can remember which it has opened.
"""

from __future__ import annotations

import datetime as dt
import uuid
from collections import defaultdict

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import Clock
from app.domain.ar.models import Project
from app.domain.chat.schemas import NotificationOut
from app.domain.chat.service import ChatContext
from app.domain.workspace import task_rules as rules
from app.domain.workspace.models import (
    OPEN_STATUSES,
    ActivityKind,
    ApprovalStage,
    TaskActivity,
    TaskApproval,
    TaskStatus,
    WorkspaceTask,
)

SUBMITTED = "submitted for approval"
APPROVED_DAYS = 30


def _fact(row: WorkspaceTask) -> rules.Task:
    return rules.Task(
        id=str(row.id), project_id=str(row.project_id), division=row.division,
        assignee_id=str(row.assignee_id), assigned_by_id=str(row.assigned_by_id),
        status=row.status.value, deadline=row.deadline,
    )  # fmt: skip


def _stamp(at: dt.datetime) -> str:
    return (at if at.tzinfo else at.replace(tzinfo=dt.UTC)).isoformat()


async def build(session: AsyncSession, ctx: ChatContext, clock: Clock) -> list[NotificationOut]:
    me, members = ctx.me_member, list(ctx.people.values())
    rows = [
        r
        for r in (await session.execute(select(WorkspaceTask))).scalars()
        if rules.can_see_task(me, _fact(r), ctx.project_divisions)
    ]
    if not rows:
        return []
    ids = [r.id for r in rows]
    nos = {
        pid: no
        for pid, no in (
            await session.execute(
                select(Project.id, Project.project_no).where(
                    Project.id.in_({r.project_id for r in rows})
                )
            )
        ).all()
    }
    history: dict[uuid.UUID, list[TaskActivity]] = defaultdict(list)
    for a in (
        await session.execute(
            select(TaskActivity).where(TaskActivity.task_id.in_(ids)).order_by(TaskActivity.id)
        )
    ).scalars():
        history[a.task_id].append(a)
    signed_off = {
        a.task_id: a
        for a in (
            await session.execute(
                select(TaskApproval).where(
                    TaskApproval.task_id.in_(ids), TaskApproval.stage == ApprovalStage.PM
                )
            )
        ).scalars()
    }

    def name(user_id: uuid.UUID) -> str:
        person = ctx.users.get(str(user_id))
        return person.full_name if person is not None else "Someone"

    horizon = clock.now() - dt.timedelta(days=APPROVED_DAYS)
    me_id = ctx.me.id
    items: list[NotificationOut] = []

    def add(row: WorkspaceTask, kind: str, at: dt.datetime, key: str, body: str) -> None:
        items.append(
            NotificationOut(
                id=key, kind=kind, at=at, title=row.title, body=body,  # type: ignore[arg-type]
                to=f"/workspace/{nos.get(row.project_id, '')}?task={row.task_no}", read=None,
            )
        )  # fmt: skip

    for r in rows:
        acts = history[r.id]
        if rules.approval_stage(me, _fact(r), members):
            sub = next((a for a in reversed(acts) if a.text == SUBMITTED), None)
            at = sub.at if sub else r.assigned_at
            stage = "stage 1" if r.status == TaskStatus.SUBMITTED else "final approval"
            by = name(sub.by_id) if sub else "Someone"
            add(
                r, "Needs your approval", at, f"approve:{r.task_no}:{_stamp(at)}",
                f"{r.task_no} · submitted by {by} · {stage}",
            )  # fmt: skip
        if r.assignee_id == me_id:
            given = next((a for a in acts if a.kind == ActivityKind.ASSIGN), None)
            if given and given.by_id != me_id and r.status in OPEN_STATUSES:
                add(
                    r, "Assigned to you", given.at, f"assign:{r.task_no}",
                    f"{r.task_no} · from {name(given.by_id)} · due {r.deadline.isoformat()}",
                )  # fmt: skip
            last = acts[-1] if acts else None
            if last and last.kind == ActivityKind.REJECT and last.by_id != me_id:
                why = last.text.removeprefix("rejected: ")
                add(
                    r, "Sent back", last.at, f"reject:{r.task_no}:{_stamp(last.at)}",
                    f"{name(last.by_id)}: {why}",
                )  # fmt: skip
            pm = signed_off.get(r.id)
            if pm is not None and pm.at >= horizon:
                add(
                    r, "Approved", pm.at, f"done:{r.task_no}",
                    f"{r.task_no} · final approval by {name(pm.by_id)}",
                )  # fmt: skip
        if (
            r.status == TaskStatus.BLOCKED
            and r.assignee_id != me_id
            and (r.assigned_by_id == me_id or me.workspace_role == "pm")
        ):
            block = next((a for a in reversed(acts) if a.kind == ActivityKind.BLOCK), None)
            at = block.at if block else r.assigned_at
            add(
                r, "Blocked", at, f"block:{r.task_no}:{_stamp(at)}",
                f"{name(r.assignee_id)}: {r.blocker_reason}",
            )  # fmt: skip
    return items
