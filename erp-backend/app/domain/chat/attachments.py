"""Files in chat: upload, link to a message, reach by a short-lived link.

**Two steps.** A file is uploaded to a channel first and linked when the message that carries
it is posted. That lets a client show progress per file, and a failed send does not lose an
upload. Anything uploaded and never attached is removed after a day — lazily, on the next
upload, rather than by a scheduled job: the scheduler's five jobs are the prototype's Cron
screen, and this is housekeeping, not something a person schedules.

**What the server decides, not the client.** The type, the extension and the file's own first
bytes must agree; images are re-decoded and saved afresh (which drops EXIF, GPS included);
SVG is refused outright; size is measured while streaming. All of that is ``app.core.storage``
(the ``CHAT_FILE`` kind). The name shown is the uploaded one with any path, control or
direction-override characters stripped — it is display only; the stored name is a hash.

**Chat owns the row, never the bytes.** Storage is content-addressed and shared with other
modules, so removing an attachment (or deleting its message) removes this row only.

**Reading.** ``url`` is a signed link minted per response, after the caller has been checked
against the channel, and it expires in minutes. A client holding an old message asks
``GET /chat/attachments/{id}/url`` for a fresh one — which re-checks access, so someone removed
from a channel stops getting links even though the message is still on their screen.
"""

from __future__ import annotations

import re
import unicodedata
import uuid
from collections.abc import Sequence
from datetime import timedelta
from pathlib import Path

from fastapi import UploadFile
from fastapi.concurrency import run_in_threadpool
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import Clock
from app.core.config import get_settings
from app.core.errors import Conflict, Invalid, NotFound
from app.core.storage import CHAT_FILE, get_storage, signed_file_path
from app.core.throttle import Throttle
from app.domain.chat.models import ChatAttachment
from app.domain.chat.schemas import AttachmentOut
from app.domain.chat.service import ChatContext, require_open

_settings = get_settings()

MAX_PER_MESSAGE = 5
MAX_UNLINKED_PER_USER = 20
ORPHAN_AFTER = timedelta(hours=24)
FILENAME_MAX = 120

#: Per uploader. Tests swap in a tighter one.
upload_throttle = Throttle(
    "chat-upload",
    limit=_settings.chat_upload_limit,
    window_seconds=_settings.chat_upload_window_seconds,
    block_seconds=_settings.chat_upload_block_seconds,
)


def clean_filename(raw: str | None, ext: str) -> str:
    """What to show for an uploaded name: no directory, no control or format characters (a
    right-to-left override, U+202E, makes a name ending in ``txt.exe`` read as ``exe.txt``),
    whitespace collapsed, not hidden by a leading dot, and short enough to store."""
    name = (raw or "").replace("\\", "/").rsplit("/", 1)[-1]
    name = unicodedata.normalize("NFC", name)
    name = "".join(ch for ch in name if unicodedata.category(ch) not in ("Cc", "Cf"))
    name = re.sub(r"\s+", " ", name).strip().lstrip(".").strip()
    if not name:
        return f"file{ext}"
    if len(name) > FILENAME_MAX:
        suffix = Path(name).suffix[:12]
        name = name[: FILENAME_MAX - len(suffix)].rstrip() + suffix
    return name


async def check_upload_rate(session: AsyncSession, user_id: uuid.UUID, clock: Clock) -> None:
    """Count one upload against the uploader, or 429. Committed straight away, like sends."""
    await upload_throttle.consume(session, [f"user:{user_id}"], now=clock.now())
    await session.commit()


async def purge_orphans(session: AsyncSession, clock: Clock) -> int:
    """Remove uploads nobody attached within a day. Rows only; the bytes may be shared."""
    cutoff = clock.now() - ORPHAN_AFTER
    gone = await session.execute(
        delete(ChatAttachment)
        .where(ChatAttachment.message_id.is_(None), ChatAttachment.created_at < cutoff)
        .returning(ChatAttachment.id)
    )
    return len(gone.scalars().all())


async def upload(
    session: AsyncSession,
    ctx: ChatContext,
    clock: Clock,
    channel_id: uuid.UUID,
    file: UploadFile,
) -> ChatAttachment:
    channel = require_open(ctx, channel_id)
    await purge_orphans(session, clock)
    waiting = (
        await session.execute(
            select(func.count())
            .select_from(ChatAttachment)
            .where(ChatAttachment.uploader_id == ctx.me.id, ChatAttachment.message_id.is_(None))
        )
    ).scalar_one()
    if waiting >= MAX_UNLINKED_PER_USER:
        raise Conflict(
            f"You have {waiting} uploads waiting to be sent. Send or discard them before "
            "uploading more."
        )

    # The storage layer is synchronous disk I/O: keep it off the event loop.
    stored = await run_in_threadpool(
        get_storage().save,
        file.file,
        kind=CHAT_FILE,
        content_type=file.content_type or "",
        filename=file.filename,
    )
    attachment = ChatAttachment(
        channel_id=channel.id,
        message_id=None,
        uploader_id=ctx.me.id,
        storage_key=stored.storage_key,
        filename=clean_filename(file.filename, Path(stored.storage_key).suffix),
        content_type=stored.content_type,
        size_bytes=stored.byte_size,
        created_at=clock.now(),
    )
    session.add(attachment)
    await session.flush()
    return attachment


async def check_linkable(
    session: AsyncSession, ctx: ChatContext, channel_id: uuid.UUID, ids: Sequence[uuid.UUID]
) -> list[ChatAttachment]:
    """The uploads a message may carry: the sender's own, to this channel, not already sent.

    One answer for every way it can fail — missing, someone else's, another channel's, already
    attached — so a guess at an id learns nothing about other people's uploads.
    """
    unique = list(dict.fromkeys(ids))
    if not unique:
        return []
    if len(unique) > MAX_PER_MESSAGE:
        raise Invalid(f"A message can carry at most {MAX_PER_MESSAGE} files.")
    rows = (
        (await session.execute(select(ChatAttachment).where(ChatAttachment.id.in_(unique))))
        .scalars()
        .all()
    )
    by_id = {a.id: a for a in rows}
    for attachment_id in unique:
        a = by_id.get(attachment_id)
        if (
            a is None
            or a.uploader_id != ctx.me.id
            or a.channel_id != channel_id
            or a.message_id is not None
        ):
            raise Invalid("One of those files is not available to send here.")
    return [by_id[i] for i in unique]


async def link(
    session: AsyncSession, message_id: uuid.UUID, attachments: list[ChatAttachment]
) -> None:
    """Attach the files to the message, remembering the order the sender listed them in."""
    for position, a in enumerate(attachments):
        await session.execute(
            update(ChatAttachment)
            .where(ChatAttachment.id == a.id)
            .values(message_id=message_id, position=position)
        )
        a.message_id = message_id
        a.position = position


async def drop_for_message(session: AsyncSession, message_id: uuid.UUID) -> None:
    """A deleted message keeps no files. The stored bytes are left alone (see module note)."""
    await session.execute(delete(ChatAttachment).where(ChatAttachment.message_id == message_id))


async def for_url(
    session: AsyncSession, ctx: ChatContext, attachment_id: uuid.UUID
) -> ChatAttachment:
    """The attachment, if the caller may see it — else 404, whatever the reason."""
    attachment = await session.get(ChatAttachment, attachment_id)
    if attachment is None:
        raise NotFound("There is no such file.")
    require_open(ctx, attachment.channel_id)
    if attachment.message_id is None and attachment.uploader_id != ctx.me.id:
        raise NotFound("There is no such file.")  # someone else's upload, not yet sent
    return attachment


def view(attachment: ChatAttachment) -> AttachmentOut:
    return AttachmentOut(
        id=attachment.id,
        filename=attachment.filename,
        content_type=attachment.content_type,
        size_bytes=attachment.size_bytes,
        url=signed_file_path(
            attachment.storage_key, ttl_seconds=get_settings().chat_attachment_url_seconds
        ),
    )
