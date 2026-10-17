"""Files on a task (W2): who may attach, who may remove, and how they are opened.

Ported from the prototype's ``addAttachment`` / ``removeAttachment`` (``useProto.js`` ~408-440)
and ``lib/attachments.js``. The rules, in the prototype's words:

* **Anyone who can see the task may attach**, until it is PM-approved ("This task is done —
  attachments are closed.").
* **At most 10 files per task**; PDF, JPG, PNG or Word, up to 10 MB each (``storage.TASK_FILE``).
* **The uploader or the PM may remove a file** — not once the task is done.

What the server adds is what a browser cannot be trusted with: the type, the extension and the
bytes must agree (a program renamed ``.pdf`` is refused), a ``.docx`` must really be a Word
document, pictures are re-encoded (EXIF and GPS dropped), the size is measured as it streams, and
the file is reached only by a short-lived signed link minted after the access check — the link is
the credential, so it expires in minutes and is minted again when needed.

Like chat's, the row is all this module owns: the stored bytes are content-addressed and may be
shared, so removing a file never deletes them. Every change goes in the task's history
(``attached <name>`` / ``removed <name>``, kind ``attach``) and the audit log, under the task's
row lock.
"""

from __future__ import annotations

import uuid
from pathlib import Path

from fastapi import Request, UploadFile
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.core.clock import Clock
from app.core.config import get_settings
from app.core.errors import Conflict, NotFound, PermissionDenied
from app.core.storage import DOCX, TASK_FILE, get_storage, signed_file_path
from app.domain.audit.service import record_audit
from app.domain.chat.attachments import check_upload_rate, clean_filename
from app.domain.workspace import tasks
from app.domain.workspace.models import (
    ActivityKind,
    TaskActivity,
    TaskAttachment,
    TaskStatus,
    WorkspaceTask,
)

MAX_PER_TASK = 10
DONE_MESSAGE = "This task is done — attachments are closed."


def kind_of(content_type: str) -> str:
    """What the task's file card shows: ``pdf``, ``image`` or ``docx``."""
    if content_type == "application/pdf":
        return "pdf"
    if content_type == DOCX:
        return "docx"
    return "image"


async def _lock(session: AsyncSession, d: tasks.Directory, ref: str) -> WorkspaceTask:
    row = await tasks.find(session, ref, lock=True)
    tasks.require_visible(d, row)
    if row.status == TaskStatus.PM_APPROVED:
        raise Conflict(DONE_MESSAGE)
    return row


async def attach(
    session: AsyncSession,
    d: tasks.Directory,
    clock: Clock,
    ref: str,
    file: UploadFile,
    request: Request | None = None,
) -> WorkspaceTask:
    # Counted and committed first, like chat uploads, so a burst cannot all pass before any counts.
    await check_upload_rate(session, d.me.id, clock)
    row = await _lock(session, d, ref)
    have = (
        await session.execute(
            select(func.count()).select_from(TaskAttachment).where(TaskAttachment.task_id == row.id)
        )
    ).scalar_one()
    if have >= MAX_PER_TASK:
        raise Conflict(f"A task can hold up to {MAX_PER_TASK} files.")

    # The storage layer is synchronous disk I/O: keep it off the event loop.
    stored = await run_in_threadpool(
        get_storage().save,
        file.file,
        kind=TASK_FILE,
        content_type=file.content_type or "",
        filename=file.filename,
    )
    name = clean_filename(file.filename, Path(stored.storage_key).suffix)
    now = clock.now()
    attachment = TaskAttachment(
        task_id=row.id,
        uploader_id=d.me.id,
        storage_key=stored.storage_key,
        filename=name,
        kind=kind_of(stored.content_type),
        content_type=stored.content_type,
        size_bytes=stored.byte_size,
        created_at=now,
    )
    session.add(attachment)
    session.add(
        TaskActivity(
            task_id=row.id, at=now, by_id=d.me.id, kind=ActivityKind.ATTACH, text=f"attached {name}"
        )
    )
    row.rev += 1
    await session.flush()
    await record_audit(
        session, actor=d.me, action="task.attach", entity_type="task", entity_id=row.id,
        detail={"task_no": row.task_no, "file": name, "bytes": stored.byte_size}, request=request,
    )  # fmt: skip
    return row


async def _find_file(
    session: AsyncSession, row: WorkspaceTask, attachment_id: uuid.UUID
) -> TaskAttachment:
    attachment = await session.get(TaskAttachment, attachment_id)
    if attachment is None or attachment.task_id != row.id:
        raise NotFound("There is no such file.")
    return attachment


async def detach(
    session: AsyncSession,
    d: tasks.Directory,
    clock: Clock,
    ref: str,
    attachment_id: uuid.UUID,
    request: Request | None = None,
) -> WorkspaceTask:
    row = await _lock(session, d, ref)
    attachment = await _find_file(session, row, attachment_id)
    if attachment.uploader_id != d.me.id and d.me_member.workspace_role != "pm":
        raise PermissionDenied(
            "Only the person who attached it, or the PM, can remove a file.",
            action="workspace:task-file",
        )
    name = attachment.filename
    await session.execute(delete(TaskAttachment).where(TaskAttachment.id == attachment.id))
    session.add(
        TaskActivity(
            task_id=row.id, at=clock.now(), by_id=d.me.id, kind=ActivityKind.ATTACH,
            text=f"removed {name}",
        )
    )  # fmt: skip
    row.rev += 1
    await session.flush()
    await record_audit(
        session, actor=d.me, action="task.detach", entity_type="task", entity_id=row.id,
        detail={"task_no": row.task_no, "file": name}, request=request,
    )  # fmt: skip
    return row


async def link(
    session: AsyncSession, d: tasks.Directory, ref: str, attachment_id: uuid.UUID
) -> str:
    """A short-lived link to the file, for anyone who can see the task — even a done one."""
    row = await tasks.find(session, ref)
    tasks.require_visible(d, row)
    attachment = await _find_file(session, row, attachment_id)
    if not attachment.storage_key:
        raise NotFound("There is no stored copy of that file (it is a demo record).")
    return signed_file_path(
        attachment.storage_key, ttl_seconds=get_settings().chat_attachment_url_seconds
    )
