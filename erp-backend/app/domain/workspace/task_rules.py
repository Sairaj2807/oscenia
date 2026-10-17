"""Who may see, assign, move and approve a task.

A line-for-line port of the task half of ``erp-frontend/src/lib/workspaceAccess.js`` and of the
guards in the store's task actions (``useProto.js`` ~334-440). Pure functions over small frozen
records, like ``chat/access.py`` and ``chat/meeting_rules.py``: no database, so
``tests/test_workspace_task_rules.py`` can replay the prototype's own answers
(``tests/fixtures/task_matrix.json``, written from the real code by
``erp-frontend/scripts/export-task-fixtures.mjs``) and fail the moment the two drift apart.

Ids are plain strings: ``M-05`` in the fixtures, a stringified UUID in production.

**The rules worth reading twice**

* The PM sees every task; a leader sees their division's tasks and any they assigned; staff see
  every task on their projects; an intern sees only their own.
* **Only the assignee submits** (decision W3): never the PM or a leader on their behalf.
* **Two approvals, in order** — the leader of the task's division, then the PM — and **nobody
  approves their own work**: if the division's leader is the assignee, stage 1 is skipped and the
  PM approves a Submitted task directly.
* Anyone who may work on a task (its assignee, whoever assigned it, the PM) can start, block and
  unblock it. Approving or rejecting needs an approval stage on that task right now.
* A rejection needs a comment, returns the task to In progress and wipes both approvals.

The moves are *planned* here (``start``, ``block``, … return a :class:`Move`, or raise
:class:`Refusal` saying why not); the service applies them under the task's row lock.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Literal

from app.domain.chat.access import Member, ProjectDivisions, member_project_ids

Status = Literal["To do", "In progress", "Blocked", "Submitted", "Leader approved", "PM approved"]
Stage = Literal["leader", "pm"]
Kind = Literal["assign", "status", "block", "reject", "approve", "attach"]

OPEN_STATUSES: frozenset[str] = frozenset(
    {"To do", "In progress", "Blocked", "Submitted", "Leader approved"}
)


@dataclass(frozen=True, slots=True)
class Task:
    id: str
    project_id: str
    division: str
    assignee_id: str
    assigned_by_id: str
    status: str
    deadline: dt.date | None = None


class Refusal(Exception):
    """A move or create the rules say no to. ``code`` is for the caller to choose a status and a
    message: ``not_allowed`` (not yours to do), ``wrong_status`` (not in the right state),
    ``needs_reason`` / ``needs_comment`` / ``needs_title`` / ``needs_deadline`` / ``past_deadline``
    (what was asked for is incomplete) and ``cannot_assign`` (that person is not yours to give
    a task to on this project)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True, slots=True)
class Move:
    """What a successful action does to a task."""

    status: str
    #: Activity entry: the kind, and the text exactly as the prototype wrote it (the bell reads it).
    kind: Kind
    text: str
    #: ``None`` leaves the reason alone; ``""`` clears it; anything else sets it.
    blocker_reason: str | None = None
    #: Which approval is recorded (``None`` for none).
    approval: Stage | None = None
    #: A rejection wipes both approvals.
    clears_approvals: bool = False
    #: Set ``completed_at`` (the PM's approval completes the task).
    completes: bool = False


# --- who sees what ------------------------------------------------------------------------


def can_see_task(member: Member | None, task: Task, project_divisions: ProjectDivisions) -> bool:
    if member is None:
        return False
    match member.workspace_role:
        case "pm":
            return True
        case "leader":
            return task.division == member.division or task.assigned_by_id == member.id
        case "staff":
            return task.project_id in member_project_ids(member, project_divisions)
        case "intern":
            return task.assignee_id == member.id
    return False


def visible_tasks(
    member: Member | None, tasks: Iterable[Task], project_divisions: ProjectDivisions
) -> list[Task]:
    return [t for t in tasks if can_see_task(member, t, project_divisions)]


def assignable_members(
    member: Member | None,
    project_id: str,
    members: Sequence[Member],
    project_divisions: ProjectDivisions,
) -> list[Member]:
    """People ``member`` may give a task to on ``project_id``. Empty means they cannot assign."""
    if member is None:
        return []

    def on_project(m: Member) -> bool:
        return project_id in member_project_ids(m, project_divisions)

    match member.workspace_role:
        case "pm":
            # Anyone doing the work on the project; the PM oversees rather than takes tasks.
            return [m for m in members if on_project(m) and m.workspace_role != "pm"]
        case "leader":
            # Anyone in their division, on the project yet or not — assigning adds them to it.
            if not on_project(member):
                return []
            return [
                m for m in members if m.division == member.division and m.workspace_role != "pm"
            ]
        case "staff":
            # Peers and interns on their own projects — not upward to a leader or the PM.
            if not on_project(member):
                return []
            return [m for m in members if on_project(m) and m.workspace_role in ("staff", "intern")]
    return []


def can_assign(
    member: Member | None,
    project_id: str,
    members: Sequence[Member],
    project_divisions: ProjectDivisions,
) -> bool:
    return bool(assignable_members(member, project_id, members, project_divisions))


def approval_stage(member: Member | None, task: Task, members: Sequence[Member]) -> Stage | None:
    """Which approval ``member`` can give on ``task`` right now: ``leader``, ``pm`` or ``None``."""
    if member is None or member.id == task.assignee_id:
        return None
    assignee = next((m for m in members if m.id == task.assignee_id), None)
    leader_is_assignee = (
        assignee is not None
        and assignee.workspace_role == "leader"
        and assignee.division == task.division
    )
    if task.status == "Submitted":
        if member.workspace_role == "leader" and member.division == task.division:
            return "leader"
        if member.workspace_role == "pm" and leader_is_assignee:
            return "pm"
    if task.status == "Leader approved" and member.workspace_role == "pm":
        return "pm"
    return None


def can_work_on(member: Member | None, task: Task) -> bool:
    """The person on a task may move it along; so may whoever assigned it, and the PM."""
    if member is None:
        return False
    return (
        member.workspace_role == "pm"
        or task.assignee_id == member.id
        or task.assigned_by_id == member.id
    )


def can_submit(member: Member | None, task: Task) -> bool:
    """Only the person doing the task submits it for approval."""
    return member is not None and task.assignee_id == member.id


def is_overdue(task: Task, today: dt.date) -> bool:
    return task.status in OPEN_STATUSES and task.deadline is not None and task.deadline < today


# --- making a task ------------------------------------------------------------------------


def plan_create(
    member: Member | None,
    project_id: str,
    assignee_id: str,
    title: str,
    deadline: dt.date | None,
    members: Sequence[Member],
    project_divisions: ProjectDivisions,
    today: dt.date,
) -> Member:
    """Check a new task and return the assignee. Raises :class:`Refusal` otherwise.

    The prototype's store only checks the person and the wording; the date was checked in the
    modal alone, so a client that skipped the screen could set a deadline in the past. Here the
    server refuses it.
    """
    allowed = assignable_members(member, project_id, members, project_divisions)
    assignee = next((m for m in allowed if m.id == assignee_id), None)
    if assignee is None:
        raise Refusal("cannot_assign", "You cannot assign a task to that person on this project.")
    if not title.strip():
        raise Refusal("needs_title", "A task needs a title.")
    if deadline is None:
        raise Refusal("needs_deadline", "A task needs a deadline.")
    if deadline < today:
        raise Refusal("past_deadline", "The deadline cannot be in the past.")
    return assignee


def joins_project(assignee: Member, project_id: str) -> bool:
    """Staff and interns reach a project only by being named on it, so being given a task there
    makes them a member. Leaders and the PM reach it through their division, never "added"."""
    return assignee.workspace_role in ("staff", "intern") and project_id not in assignee.project_ids


# --- moving it ----------------------------------------------------------------------------


def _need_work(member: Member | None, task: Task) -> None:
    if not can_work_on(member, task):
        raise Refusal(
            "not_allowed", "Only the assignee, whoever assigned it, or the PM can do that."
        )


def _need_status(task: Task, allowed: Sequence[str], what: str) -> None:
    if task.status not in allowed:
        raise Refusal("wrong_status", f"A task that is {task.status} cannot be {what}.")


def start(member: Member | None, task: Task) -> Move:
    _need_work(member, task)
    _need_status(task, ["To do"], "started")
    return Move("In progress", "status", "started")


def block(member: Member | None, task: Task, reason: str) -> Move:
    if not reason.strip():
        raise Refusal("needs_reason", "Say what is blocking it.")
    _need_work(member, task)
    _need_status(task, ["To do", "In progress"], "blocked")
    return Move("Blocked", "block", f"blocked: {reason.strip()}", blocker_reason=reason.strip())


def unblock(member: Member | None, task: Task) -> Move:
    _need_work(member, task)
    _need_status(task, ["Blocked"], "unblocked")
    return Move("In progress", "status", "unblocked", blocker_reason="")


def submit(member: Member | None, task: Task) -> Move:
    """Only the assignee — never the PM or a leader on their behalf (decision W3)."""
    if not can_submit(member, task):
        raise Refusal("not_allowed", "Only the person doing the task can submit it.")
    _need_work(member, task)
    _need_status(task, ["In progress"], "submitted")
    return Move("Submitted", "status", "submitted for approval")


def approve(member: Member | None, task: Task, members: Sequence[Member]) -> Move:
    stage = approval_stage(member, task, members)
    if stage is None:
        raise Refusal("not_allowed", "You do not hold an approval on this task right now.")
    if stage == "leader":
        return Move("Leader approved", "approve", "approved (Division Leader)", approval="leader")
    return Move("PM approved", "approve", "approved (PM) — done", approval="pm", completes=True)


def reject(member: Member | None, task: Task, members: Sequence[Member], comment: str) -> Move:
    if not comment.strip():
        raise Refusal("needs_comment", "Say why it is being sent back.")
    if approval_stage(member, task, members) is None:
        raise Refusal("not_allowed", "You do not hold an approval on this task right now.")
    return Move("In progress", "reject", f"rejected: {comment.strip()}", clears_approvals=True)
