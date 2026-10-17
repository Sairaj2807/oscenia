"""Task endpoints: ``/api/v1/tasks``.

Who may do what, server-side (the rules are in ``task_rules.py``):

* every endpoint needs the ``workspace`` module **and** a workspace persona (``WorkspaceMember``);
* a person sees the tasks the rules let them see (PM: all; leader: their division's and any they
  assigned; staff: their projects'; intern: their own) — anything else is 404, never 403;
* making a task needs someone to give it to (``assignable_members``); starting, blocking and
  unblocking belong to the assignee, whoever assigned it, and the PM; **only the assignee
  submits**; approving and rejecting need an approval stage on that task right now;
* every answer is the whole task, so a client holds one shape.

Each change commits first and is announced to connected clients after (``events.py``).
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, File, Query, Request, UploadFile, status

from app.core.clock import ClockDep
from app.core.deps import WorkspaceMember
from app.db.session import SessionDep
from app.domain.chat import events as chat_events
from app.domain.chat.hub import get_hub
from app.domain.workspace import events, files, tasks
from app.domain.workspace import task_rules as rules
from app.domain.workspace.models import WorkspaceTask
from app.domain.workspace.schemas import BlockIn, FileUrlOut, RejectIn, TaskCreate, TaskOut

router = APIRouter(prefix="/tasks", tags=["tasks"])


def _announce(kind: str, d: tasks.Directory, out: TaskOut, row: WorkspaceTask) -> None:
    """Tell connected people who can see the task (after the commit; failures are logged, never
    raised: the change itself has already succeeded)."""
    chat_events.quietly(events.task_event, get_hub(), d, kind, out, row)


@router.get("", response_model=list[TaskOut])
async def list_tasks(
    session: SessionDep,
    clock: ClockDep,
    user: WorkspaceMember,
    project_id: Annotated[uuid.UUID | None, Query()] = None,
) -> list[TaskOut]:
    """The tasks the caller may see, oldest assigned first, each whole."""
    d = await tasks.load_directory(session, user)
    return await tasks.views(
        session, d, clock, await tasks.visible_rows(session, d, project_id=project_id)
    )


@router.get("/{ref}", response_model=TaskOut)
async def get_task(
    session: SessionDep, clock: ClockDep, user: WorkspaceMember, ref: str
) -> TaskOut:
    """One task, by id or number (``T-101``). A task you may not see is no such task."""
    d = await tasks.load_directory(session, user)
    row = await tasks.find(session, ref)
    tasks.require_visible(d, row)
    [out] = await tasks.views(session, d, clock, [row])
    return out


@router.post("", response_model=TaskOut, status_code=status.HTTP_201_CREATED)
async def create_task(
    session: SessionDep, clock: ClockDep, user: WorkspaceMember, body: TaskCreate, request: Request
) -> TaskOut:
    """Give someone a task. The assignee must be someone the caller may assign to on that project
    (a leader: their own division, who then joins the project; staff: peers and interns on their
    projects; the PM: anyone doing the work), and the deadline cannot be in the past."""
    d = await tasks.load_directory(session, user)
    # Staff and interns reach a project by being named on it: a task there adds them, which
    # changes everyone's picture of who is on the project.
    person = d.people.get(str(body.assignee_id))
    joins = person is not None and rules.joins_project(person, str(body.project_id))
    row = await tasks.create(session, d, clock, body, request)
    [out] = await tasks.views(session, d, clock, [row])
    await session.commit()
    if joins:
        chat_events.quietly(chat_events.invalidate, get_hub(), "project")
    _announce("task.created", d, out, row)
    return out


async def _move(
    session: SessionDep,
    clock: ClockDep,
    user: WorkspaceMember,
    ref: str,
    action: str,
    request: Request,
    *,
    reason: str = "",
    comment: str = "",
) -> TaskOut:
    d = await tasks.load_directory(session, user)
    row = await tasks.act(
        session, d, clock, ref, action, reason=reason, comment=comment, request=request
    )
    [out] = await tasks.views(session, d, clock, [row])
    await session.commit()
    _announce("task.updated", d, out, row)
    return out


@router.post("/{ref}/start", response_model=TaskOut)
async def start_task(
    session: SessionDep, clock: ClockDep, user: WorkspaceMember, ref: str, request: Request
) -> TaskOut:
    """To do → In progress."""
    return await _move(session, clock, user, ref, "start", request)


@router.post("/{ref}/block", response_model=TaskOut)
async def block_task(
    session: SessionDep, clock: ClockDep, user: WorkspaceMember, ref: str, body: BlockIn,
    request: Request,
) -> TaskOut:  # fmt: skip
    """Blocked, with the reason (required). From To do or In progress."""
    return await _move(session, clock, user, ref, "block", request, reason=body.reason)


@router.post("/{ref}/unblock", response_model=TaskOut)
async def unblock_task(
    session: SessionDep, clock: ClockDep, user: WorkspaceMember, ref: str, request: Request
) -> TaskOut:
    """Blocked → In progress; the reason is cleared."""
    return await _move(session, clock, user, ref, "unblock", request)


@router.post("/{ref}/submit", response_model=TaskOut)
async def submit_task(
    session: SessionDep, clock: ClockDep, user: WorkspaceMember, ref: str, request: Request
) -> TaskOut:
    """In progress → Submitted. Only the person doing the task — never the PM or a leader on their
    behalf."""
    return await _move(session, clock, user, ref, "submit", request)


@router.post("/{ref}/approve", response_model=TaskOut)
async def approve_task(
    session: SessionDep, clock: ClockDep, user: WorkspaceMember, ref: str, request: Request
) -> TaskOut:
    """Give the approval the caller holds on this task right now: the division's leader first
    (Submitted → Leader approved), then the PM (→ PM approved, done). Nobody approves their own
    work; a leader's own task goes straight to the PM."""
    return await _move(session, clock, user, ref, "approve", request)


@router.post("/{ref}/reject", response_model=TaskOut)
async def reject_task(
    session: SessionDep, clock: ClockDep, user: WorkspaceMember, ref: str, body: RejectIn,
    request: Request,
) -> TaskOut:  # fmt: skip
    """Send it back to In progress, with a comment (required). Both approvals start again."""
    return await _move(session, clock, user, ref, "reject", request, comment=body.comment)


@router.post("/{ref}/attachments", response_model=TaskOut, status_code=status.HTTP_201_CREATED)
async def add_attachment(
    session: SessionDep,
    clock: ClockDep,
    user: WorkspaceMember,
    ref: str,
    request: Request,
    file: Annotated[UploadFile, File()],
) -> TaskOut:
    """Attach a file (PDF, JPG, PNG or Word, up to 10 MB; at most 10 a task). Anyone who can see
    the task may, until it is done. Pictures are re-encoded (EXIF and GPS dropped). Answers the
    whole task, so the new file is in ``attachments``."""
    d = await tasks.load_directory(session, user)
    row = await files.attach(session, d, clock, ref, file, request)
    [out] = await tasks.views(session, d, clock, [row])
    await session.commit()
    _announce("task.updated", d, out, row)
    return out


@router.delete("/{ref}/attachments/{attachment_id}", response_model=TaskOut)
async def remove_attachment(
    session: SessionDep, clock: ClockDep, user: WorkspaceMember, ref: str,
    attachment_id: uuid.UUID, request: Request,
) -> TaskOut:  # fmt: skip
    """Remove a file: the person who attached it, or the PM — not once the task is done."""
    d = await tasks.load_directory(session, user)
    row = await files.detach(session, d, clock, ref, attachment_id, request)
    [out] = await tasks.views(session, d, clock, [row])
    await session.commit()
    _announce("task.updated", d, out, row)
    return out


@router.get("/{ref}/attachments/{attachment_id}/url", response_model=FileUrlOut)
async def attachment_url(
    session: SessionDep, user: WorkspaceMember, ref: str, attachment_id: uuid.UUID
) -> FileUrlOut:
    """A short-lived link to open the file, for anyone who can see the task."""
    d = await tasks.load_directory(session, user)
    return FileUrlOut(url=await files.link(session, d, ref, attachment_id))
