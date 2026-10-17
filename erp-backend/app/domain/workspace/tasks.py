"""Tasks: making them, moving them, and showing them to the people who may see them.

The rules are in ``task_rules.py`` (pure, replayed against the prototype's own answers); this
file loads the facts, applies a move and writes it down. Two things matter here that the rules
cannot say:

* **A move is made under the task's row lock.** Two approvers, or an approver and the assignee,
  acting on one task at the same moment queue up: the second one reads the status the first
  left and is refused (or allowed) by the rules on *that*, not on what it saw a moment ago.
* **A task the caller may not see is "no such task" (404), never 403**, so asking reveals
  nothing; one they can see but may not move is 403 (not theirs to do) or 409 (not in that
  state), with a message that says why.

Every change writes the task's history (what the bell reads) and an audit row, in the same
transaction as the change.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from fastapi import Request
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import Clock
from app.core.errors import Conflict, Invalid, NotFound, PermissionDenied
from app.domain.ar.models import Project
from app.domain.audit.service import record_audit
from app.domain.chat.access import Member
from app.domain.chat.service import _member_of
from app.domain.masters.models import ProjectDivision, ProjectMember, User
from app.domain.workspace import task_rules as rules
from app.domain.workspace.models import (
    ActivityKind,
    ApprovalStage,
    TaskActivity,
    TaskApproval,
    TaskAttachment,
    TaskPriority,
    TaskStatus,
    WorkspaceTask,
)
from app.domain.workspace.schemas import (
    ActivityOut,
    ApprovalOut,
    TaskCreate,
    TaskFileOut,
    TaskOut,
)

# --- who is asking, and who else there is -------------------------------------------------


@dataclass
class Directory:
    """The people and project reach the rules need, loaded once per request."""

    me: User
    users: dict[str, User]
    people: dict[str, Member]
    project_divisions: dict[str, list[str]]

    @property
    def me_member(self) -> Member:
        return self.people[str(self.me.id)]

    @property
    def members(self) -> list[Member]:
        return list(self.people.values())

    def number(self, user_id: uuid.UUID) -> str | None:
        person = self.users.get(str(user_id))
        return person.member_no if person is not None else None


async def load_directory(session: AsyncSession, user: User) -> Directory:
    named: dict[uuid.UUID, list[str]] = {}
    for pm in (await session.execute(select(ProjectMember))).scalars():
        named.setdefault(pm.user_id, []).append(str(pm.project_id))
    users = {
        str(u.id): u
        for u in (
            await session.execute(
                select(User).where(User.workspace_role.is_not(None), User.active.is_(True))
            )
        ).scalars()
    }
    divisions: dict[str, list[str]] = {}
    for pd in (
        await session.execute(select(ProjectDivision).order_by(ProjectDivision.division))
    ).scalars():
        divisions.setdefault(str(pd.project_id), []).append(pd.division)
    return Directory(
        me=user,
        users=users,
        people={uid: _member_of(u, tuple(named.get(u.id, ()))) for uid, u in users.items()},
        project_divisions=divisions,
    )


def fact(row: WorkspaceTask) -> rules.Task:
    """The task as the rules see it (ids as strings)."""
    return rules.Task(
        id=str(row.id),
        project_id=str(row.project_id),
        division=row.division,
        assignee_id=str(row.assignee_id),
        assigned_by_id=str(row.assigned_by_id),
        status=row.status.value,
        deadline=row.deadline,
    )


def as_error(refusal: rules.Refusal) -> Exception:
    """A refusal from the rules as the right kind of problem: not yours (403), not in that state
    (409), or incomplete (422)."""
    if refusal.code in ("not_allowed", "cannot_assign"):
        return PermissionDenied(refusal.message, action="workspace:task")
    if refusal.code == "wrong_status":
        return Conflict(refusal.message)
    return Invalid(refusal.message)


# --- finding and showing ------------------------------------------------------------------


async def find(session: AsyncSession, ref: str, *, lock: bool = False) -> WorkspaceTask:
    """A task by its id or its number (``T-101``)."""
    try:
        stmt = select(WorkspaceTask).where(WorkspaceTask.id == uuid.UUID(ref))
    except ValueError:
        stmt = select(WorkspaceTask).where(WorkspaceTask.task_no == ref.strip().upper())
    if lock:
        stmt = stmt.with_for_update()
    row = (await session.execute(stmt)).scalar_one_or_none()
    if row is None:
        raise NotFound("There is no such task.")
    return row


def require_visible(d: Directory, row: WorkspaceTask) -> None:
    if not rules.can_see_task(d.me_member, fact(row), d.project_divisions):
        raise NotFound("There is no such task.")


async def visible_rows(
    session: AsyncSession, d: Directory, *, project_id: uuid.UUID | None = None
) -> list[WorkspaceTask]:
    stmt = select(WorkspaceTask).order_by(WorkspaceTask.assigned_at, WorkspaceTask.task_no)
    if project_id is not None:
        stmt = stmt.where(WorkspaceTask.project_id == project_id)
    rows = (await session.execute(stmt)).scalars().all()
    return [r for r in rows if rules.can_see_task(d.me_member, fact(r), d.project_divisions)]


async def views(
    session: AsyncSession, d: Directory, clock: Clock, rows: Sequence[WorkspaceTask]
) -> list[TaskOut]:
    """Whole tasks for the caller: history, approvals and files included, in a few queries."""
    if not rows:
        return []
    ids = [r.id for r in rows]
    nos: dict[uuid.UUID, str] = {
        pid: no
        for pid, no in (
            await session.execute(
                select(Project.id, Project.project_no).where(
                    Project.id.in_({r.project_id for r in rows})
                )
            )
        ).all()
    }
    approvals: dict[uuid.UUID, dict[str, ApprovalOut]] = {}
    for a in (
        await session.execute(select(TaskApproval).where(TaskApproval.task_id.in_(ids)))
    ).scalars():
        approvals.setdefault(a.task_id, {})[a.stage.value] = ApprovalOut(
            by_id=a.by_id, by_no=d.number(a.by_id), at=a.at
        )
    history: dict[uuid.UUID, list[ActivityOut]] = {}
    for h in (
        await session.execute(
            select(TaskActivity).where(TaskActivity.task_id.in_(ids)).order_by(TaskActivity.id)
        )
    ).scalars():
        history.setdefault(h.task_id, []).append(
            ActivityOut(
                at=h.at, by_id=h.by_id, by_no=d.number(h.by_id), kind=h.kind.value, text=h.text
            )
        )
    files: dict[uuid.UUID, list[TaskFileOut]] = {}
    for f in (
        await session.execute(
            select(TaskAttachment)
            .where(TaskAttachment.task_id.in_(ids))
            .order_by(TaskAttachment.created_at, TaskAttachment.id)
        )
    ).scalars():
        files.setdefault(f.task_id, []).append(
            TaskFileOut.model_validate(
                {
                    "id": f.id,
                    "filename": f.filename,
                    "kind": f.kind,
                    "size_bytes": f.size_bytes,
                    "uploader_id": f.uploader_id,
                    "uploader_no": d.number(f.uploader_id),
                    "created_at": f.created_at,
                    "stored": f.storage_key is not None,
                }
            )
        )
    today, members, me = clock.today(), d.members, d.me_member
    out: list[TaskOut] = []
    for r in rows:
        t = fact(r)
        # Plain values in, validated into the response model: the model owns the exact types.
        out.append(
            TaskOut.model_validate(
                {
                    "id": r.id,
                    "task_no": r.task_no,
                    "project_id": r.project_id,
                    "project_no": nos.get(r.project_id, ""),
                    "division": r.division,
                    "title": r.title,
                    "description": r.description,
                    "assignee_id": r.assignee_id,
                    "assignee_no": d.number(r.assignee_id),
                    "assigned_by_id": r.assigned_by_id,
                    "assigned_by_no": d.number(r.assigned_by_id),
                    "assigned_at": r.assigned_at,
                    "deadline": r.deadline,
                    "priority": r.priority.value,
                    "status": r.status.value,
                    "blocker_reason": r.blocker_reason,
                    "approvals": approvals.get(r.id, {}),
                    "completed_at": r.completed_at,
                    "overdue": rules.is_overdue(t, today),
                    "rev": r.rev,
                    "activity": history.get(r.id, []),
                    "attachments": files.get(r.id, []),
                    "my_stage": rules.approval_stage(me, t, members),
                }
            )
        )
    return out


# --- making one ---------------------------------------------------------------------------


async def create(
    session: AsyncSession,
    d: Directory,
    clock: Clock,
    body: TaskCreate,
    request: Request | None = None,
) -> WorkspaceTask:
    project = await session.get(Project, body.project_id)
    if project is None:
        raise NotFound("There is no such project.")
    try:
        assignee = rules.plan_create(
            d.me_member, str(project.id), str(body.assignee_id), body.title, body.deadline,
            d.members, d.project_divisions, clock.today(),
        )  # fmt: skip
    except rules.Refusal as refusal:
        raise as_error(refusal) from refusal
    if not assignee.division:
        raise Invalid("That person has no division yet, so a task cannot be filed under one.")

    assignee_user = d.users[assignee.id]
    now = clock.now()
    number = (await session.execute(select(func.nextval("task_no_seq")))).scalar_one()
    row = WorkspaceTask(
        task_no=f"T-{number}", project_id=project.id, division=assignee.division,
        title=body.title.strip(), description=body.description.strip(),
        assignee_id=assignee_user.id, assigned_by_id=d.me.id, assigned_at=now,
        deadline=body.deadline, priority=TaskPriority(body.priority), status=TaskStatus.TODO,
        blocker_reason="", created_at=now, rev=1,
    )  # fmt: skip
    session.add(row)
    await session.flush()
    session.add(
        TaskActivity(
            task_id=row.id, at=now, by_id=d.me.id, kind=ActivityKind.ASSIGN, text="assigned"
        )
    )
    # Staff and interns reach a project only by being named on it, so a task there makes them a
    # member (W1). Leaders and the PM reach it through their division.
    already = (
        await session.execute(
            select(ProjectMember).where(
                ProjectMember.project_id == project.id, ProjectMember.user_id == assignee_user.id
            )
        )
    ).scalar_one_or_none()
    if already is None and rules.joins_project(assignee, str(project.id)):
        session.add(ProjectMember(project_id=project.id, user_id=assignee_user.id))
        await record_audit(
            session, actor=d.me, action="task.assignee_joined_project", entity_type="project",
            entity_id=project.id, after={"member": assignee_user.member_no, "via": row.task_no},
            request=request,
        )  # fmt: skip
    await session.flush()
    await record_audit(
        session, actor=d.me, action="task.create", entity_type="task", entity_id=row.id,
        after={"task_no": row.task_no, "assignee": assignee_user.member_no, "status": "To do"},
        detail={"project": project.project_no}, request=request,
    )  # fmt: skip
    return row


# --- moving one ---------------------------------------------------------------------------


async def act(
    session: AsyncSession,
    d: Directory,
    clock: Clock,
    ref: str,
    action: str,
    *,
    reason: str = "",
    comment: str = "",
    request: Request | None = None,
) -> WorkspaceTask:
    """Start, block, unblock, submit, approve or reject, if the rules allow it *now*."""
    row = await find(session, ref, lock=True)
    require_visible(d, row)
    me, t = d.me_member, fact(row)
    try:
        move = {
            "start": lambda: rules.start(me, t),
            "block": lambda: rules.block(me, t, reason),
            "unblock": lambda: rules.unblock(me, t),
            "submit": lambda: rules.submit(me, t),
            "approve": lambda: rules.approve(me, t, d.members),
            "reject": lambda: rules.reject(me, t, d.members, comment),
        }[action]()
    except rules.Refusal as refusal:
        raise as_error(refusal) from refusal
    await apply(session, d, clock, row, move, action, request)
    return row


async def apply(
    session: AsyncSession,
    d: Directory,
    clock: Clock,
    row: WorkspaceTask,
    move: rules.Move,
    action: str,
    request: Request | None,
) -> None:
    now = clock.now()
    before: dict[str, Any] = {"status": row.status.value, "blocker_reason": row.blocker_reason}
    row.status = TaskStatus(move.status)
    if move.blocker_reason is not None:
        row.blocker_reason = move.blocker_reason
    if move.clears_approvals:
        await session.execute(delete(TaskApproval).where(TaskApproval.task_id == row.id))
    if move.approval:
        session.add(
            TaskApproval(task_id=row.id, stage=ApprovalStage(move.approval), by_id=d.me.id, at=now)
        )
    if move.completes:
        row.completed_at = now
    session.add(
        TaskActivity(
            task_id=row.id, at=now, by_id=d.me.id, kind=ActivityKind(move.kind), text=move.text
        )
    )
    row.rev += 1
    await session.flush()
    await record_audit(
        session, actor=d.me, action=f"task.{action}", entity_type="task", entity_id=row.id,
        before=before, after={"status": row.status.value, "blocker_reason": row.blocker_reason},
        detail={"task_no": row.task_no, "text": move.text}, request=request,
    )  # fmt: skip
