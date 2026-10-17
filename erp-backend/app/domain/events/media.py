"""Uploaded invitation media: photos, video and music on an event, artwork on a template.

Every file is stored once, content-addressed, and shared with any other record holding the same
bytes — so the storage key is never put in an invitation. An ``EventMedia`` row stands in for it:
its id is the ``key`` of the file reference in the content, and content may only name an id that
belongs to its own event (or, for artwork, to a studio template). Guests fetch the file from the
public ``/public/media/{id}`` route, which only needs that id.
"""

from __future__ import annotations

import asyncio
import contextlib
import secrets
import uuid
from collections.abc import Mapping
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from fastapi import UploadFile
from sqlalchemy import String, cast, delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.core.errors import Conflict, Invalid, TooManyAttempts
from app.core.storage import MUSIC, PHOTO, VIDEO, FileKind, get_storage
from app.domain.chat.attachments import clean_filename
from app.domain.events.models import EventInvite, EventMedia, InvitationTemplate

#: What an invitation editor may upload, by the ``kind`` the page names.
EVENT_KINDS: dict[str, FileKind] = {"photo": PHOTO, "video": VIDEO, "music": MUSIC}

#: Per event / per template: enough for a gallery, a video and a song, not a file locker.
MAX_EVENT_FILES = 100
MAX_EVENT_BYTES = 1024 * 1024 * 1024
MAX_TEMPLATE_FILES = 30
MAX_TEMPLATE_BYTES = 200 * 1024 * 1024

#: An upload that is never put in the content is cleaned away after this long.
ORPHAN_AFTER = timedelta(days=7)
SWEEP_ONE_IN = 10

#: Uploads being processed at once. Each is decoded and written on a worker thread, and a
#: 200 MB video is slow: past this the caller is told to retry rather than queued without limit.
_slots = asyncio.Semaphore(4)


def ref_of(row: EventMedia) -> dict[str, Any]:
    """The file reference content holds: ``{key, name, size, type}``."""
    return {
        "key": str(row.id),
        "name": row.name,
        "size": row.size_bytes,
        "type": row.content_type,
    }


async def _owner_usage(
    session: AsyncSession, *, event_id: uuid.UUID | None, template_id: str | None
) -> tuple[int, int]:
    stmt = select(func.count(), func.coalesce(func.sum(EventMedia.size_bytes), 0))
    stmt = stmt.where(
        EventMedia.event_id == event_id if event_id else EventMedia.template_id == template_id
    )
    files, total = (await session.execute(stmt)).one()
    return int(files), int(total)


async def upload(
    session: AsyncSession,
    file: UploadFile,
    *,
    kind: FileKind,
    by: str,
    now: datetime,
    event_id: uuid.UUID | None = None,
    template_id: str | None = None,
) -> EventMedia:
    """Store one upload and record it against its owner. Raises ``Invalid`` for a file that
    is the wrong type, too large or not what it claims, ``Conflict`` when the owner is full."""
    assert (event_id is None) != (template_id is None)
    max_files, max_bytes = (
        (MAX_EVENT_FILES, MAX_EVENT_BYTES) if event_id else (MAX_TEMPLATE_FILES, MAX_TEMPLATE_BYTES)
    )
    files, total = await _owner_usage(session, event_id=event_id, template_id=template_id)
    if files >= max_files:
        raise Conflict(f"That can hold up to {max_files} uploaded files.")
    if _slots.locked():
        raise TooManyAttempts(
            "The server is busy with other uploads. Try again in a moment.", retry_after=10
        )
    async with _slots:
        # The storage layer is synchronous disk I/O: keep it off the event loop.
        stored = await run_in_threadpool(
            get_storage().save,
            file.file,
            kind=kind,
            content_type=file.content_type or "",
            filename=file.filename,
        )
    if total + stored.byte_size > max_bytes:
        # The bytes stay in the store (content-addressed, maybe shared); only the claim is refused.
        raise Conflict(f"That would go over the {max_bytes // (1024 * 1024)} MB for this item.")
    row = EventMedia(
        event_id=event_id,
        template_id=template_id,
        storage_key=stored.storage_key,
        kind=kind.name,
        name=clean_filename(file.filename, Path(stored.storage_key).suffix)[:160],
        content_type=stored.content_type,
        size_bytes=stored.byte_size,
        uploaded_by=by[:120],
        created_at=now,
    )
    session.add(row)
    await session.flush()
    if secrets.randbelow(SWEEP_ONE_IN) == 0:
        await sweep(session, event_id=event_id, template_id=template_id, now=now)
    return row


# ---------------------------------------------------------------------------
# Content may only name its own media
# ---------------------------------------------------------------------------


def _is_ref(value: Any) -> bool:
    return isinstance(value, Mapping) and "key" in value and "size" in value


def ref_ids(value: Any) -> set[uuid.UUID]:
    """The media ids a cleaned content value refers to (browser-local ``m-…`` keys and anything
    else that is not an id are skipped)."""
    found: set[uuid.UUID] = set()

    def walk(v: Any) -> None:
        if _is_ref(v):
            with contextlib.suppress(ValueError):
                found.add(uuid.UUID(str(v["key"])))
        elif isinstance(v, Mapping):
            for x in v.values():
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)

    walk(value)
    return found


async def scrub(
    session: AsyncSession,
    value: Any,
    *,
    event_id: uuid.UUID | None = None,
    studio: bool = False,
) -> Any:
    """``value`` with every file reference checked against the uploads this owner holds.

    A reference to anything else — a browser-local key, another event's file, a forged id —
    is dropped (a list loses the entry, a single field becomes null). A kept reference takes
    its name, size and type from the stored row, not from what the caller sent."""
    ids = ref_ids(value)
    rows: dict[str, EventMedia] = {}
    if ids:
        stmt = select(EventMedia).where(EventMedia.id.in_(ids))
        stmt = stmt.where(
            EventMedia.template_id.is_not(None) if studio else EventMedia.event_id == event_id
        )
        rows = {str(r.id): r for r in (await session.execute(stmt)).scalars()}

    def walk(v: Any) -> Any:
        if _is_ref(v):
            try:
                row = rows.get(str(uuid.UUID(str(v["key"]))))
            except ValueError:
                row = None
            return ref_of(row) if row else None
        if isinstance(v, Mapping):
            return {k: walk(x) for k, x in v.items()}
        if isinstance(v, list):
            return [kept for x in v if (kept := walk(x)) is not None or not _is_ref(x)]
        return v

    return walk(value)


# ---------------------------------------------------------------------------
# Serving, and clearing away uploads nobody used
# ---------------------------------------------------------------------------


async def get_media(session: AsyncSession, media_id: str) -> EventMedia | None:
    try:
        key = uuid.UUID(media_id)
    except ValueError:
        return None
    return await session.get(EventMedia, key)


async def is_referenced(session: AsyncSession, media_id: uuid.UUID) -> bool:
    """Whether any draft, published copy or template artwork still names this upload."""
    needle = f"%{media_id}%"
    invite = (
        await session.execute(
            select(EventInvite.event_id)
            .where(
                or_(
                    cast(EventInvite.content, String).like(needle),
                    cast(EventInvite.published, String).like(needle),
                    cast(EventInvite.published_template, String).like(needle),
                )
            )
            .limit(1)
        )
    ).first()
    if invite is not None:
        return True
    template = (
        await session.execute(
            select(InvitationTemplate.id)
            .where(cast(InvitationTemplate.art, String).like(needle))
            .limit(1)
        )
    ).first()
    return template is not None


async def sweep(
    session: AsyncSession,
    *,
    event_id: uuid.UUID | None,
    template_id: str | None,
    now: datetime,
) -> int:
    """Drop this owner's uploads that were never put in any content and are past
    ``ORPHAN_AFTER``. Only the rows go: the stored bytes may be shared with other records, so
    they are left for a store-wide clean-up that can see every reference."""
    stmt = select(EventMedia.id).where(EventMedia.created_at < now - ORPHAN_AFTER)
    stmt = stmt.where(
        EventMedia.event_id == event_id if event_id else EventMedia.template_id == template_id
    )
    stale = [i for (i,) in (await session.execute(stmt)).all()]
    gone = [i for i in stale if not await is_referenced(session, i)]
    if gone:
        await session.execute(delete(EventMedia).where(EventMedia.id.in_(gone)))
    return len(gone)


def kind_for(name: str) -> FileKind:
    kind = EVENT_KINDS.get(name)
    if kind is None:
        raise Invalid("kind must be photo, video or music.")
    return kind
