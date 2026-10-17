"""Template Studio (client round 3): the design team's own invitation templates.

Ported from ``useProto.js`` (``createTemplate`` … ``archiveTemplate``). The router gates
every write on ``manage_templates`` (CEO and PMs). Built-ins are read-only, and nothing is
ever hard-deleted: an archived template leaves the gallery but keeps drawing the
invitations already on it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from fastapi import Request, UploadFile
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict, Invalid, NotFound
from app.core.storage import ARTWORK
from app.domain.audit.service import record_audit
from app.domain.events import media, rules
from app.domain.events.models import Event, EventInvite, EventStatus, InvitationTemplate
from app.domain.events.templates import (
    ART_SLOTS,
    BUILTIN_TEMPLATES,
    new_template,
    validate_template,
)
from app.domain.ledger.numbering import next_document_no
from app.domain.masters.models import User

#: What a save may change. Anything else in the patch (``id``, ``status``) is ignored.
EDITABLE = ("name", "tagline", "family", "palette", "fonts", "cover", "ornament", "sections", "off")
PALETTE_KEYS = ("bg", "surface", "accent", "text")
FONT_SLOTS = ("heading", "body", "script")
_BUILTIN_ORDER = {t["id"]: i for i, t in enumerate(BUILTIN_TEMPLATES)}
_PHOTO_TYPE = re.compile(r"^image/(jpeg|png|webp)$")
_PHOTO_NAME = re.compile(r"\.(jpe?g|png|webp)$", re.IGNORECASE)


@dataclass(frozen=True, slots=True)
class Usage:
    events: int
    live: int


async def get(session: AsyncSession, template_id: str, *, lock: bool = False) -> InvitationTemplate:
    stmt = select(InvitationTemplate).where(InvitationTemplate.id == template_id)
    if lock:
        stmt = stmt.with_for_update()
    template = (await session.execute(stmt)).scalar_one_or_none()
    if template is None:
        raise NotFound("Unknown template.")
    return template


async def _studio(session: AsyncSession, template_id: str) -> InvitationTemplate:
    template = await get(session, template_id, lock=True)
    if template.builtin:
        raise Conflict("Built-in templates cannot be changed. Duplicate it instead.")
    return template


async def list_templates(session: AsyncSession) -> list[InvitationTemplate]:
    """The six built-ins in their order, then the design team's, oldest first."""
    rows = list((await session.execute(select(InvitationTemplate))).scalars().all())
    return sorted(
        rows,
        key=lambda t: (
            (0, _BUILTIN_ORDER.get(t.id, 0), t.created_at) if t.builtin else (1, 0, t.created_at)
        ),
    )


async def usage(session: AsyncSession) -> dict[str, Usage]:
    """Per template: events whose draft or published copy names it, and how many of those
    guests can see right now — they show any change to it."""
    published_tid = EventInvite.published["template_id"].astext
    rows = (
        await session.execute(
            select(InvitationTemplate.id, Event.status, EventInvite.template_id, published_tid)
            .join(
                EventInvite,
                or_(
                    EventInvite.template_id == InvitationTemplate.id,
                    published_tid == InvitationTemplate.id,
                ),
            )
            .join(Event, Event.id == EventInvite.event_id)
        )
    ).all()
    counts: dict[str, list[int]] = {}
    for tid, status, _draft, live_tid in rows:
        c = counts.setdefault(tid, [0, 0])
        c[0] += 1
        if status == EventStatus.PUBLISHED and live_tid == tid:
            c[1] += 1
    return {tid: Usage(events=e, live=v) for tid, (e, v) in counts.items()}


async def create(
    session: AsyncSession,
    *,
    actor: User,
    now: datetime,
    from_id: str | None = None,
    family: str = "private",
    request: Request | None = None,
) -> InvitationTemplate:
    """A new draft — blank, or a copy of ``from_id`` (a built-in or studio template)."""
    base = (await get(session, from_id)).as_dict() if from_id else None
    if base is None and family not in ("corporate", "private"):
        raise Invalid("Choose a family.")
    template_id = await next_document_no(session, "studio_template")
    data = new_template(template_id, base=base, family=family)
    problem = validate_template(data)
    if problem:
        raise Invalid(problem)
    template = InvitationTemplate(
        **data, builtin=False, created_at=now, updated_at=now, created_by_label=actor.full_name
    )
    session.add(template)
    await session.flush()
    await record_audit(
        session, actor=actor, action="template.create", entity_type="invitation_template",
        entity_id=template.id, after={"name": template.name, "from": from_id},
        request=request,
    )  # fmt: skip
    return template


async def update(
    session: AsyncSession,
    template_id: str,
    patch: dict[str, Any],
    *,
    actor: User,
    now: datetime,
    request: Request | None = None,
) -> InvitationTemplate:
    """Saves the editor's settings. Refused, with the reason, if the result would not
    validate. An archived template is restored before it is edited."""
    template = await _studio(session, template_id)
    if template.status == "archived":
        raise Conflict("Restore the template before editing it.")
    clean = {k: v for k, v in patch.items() if k in EDITABLE and v is not None}
    for key in ("name", "tagline"):
        if isinstance(clean.get(key), str):
            clean[key] = clean[key].strip()
    # Only the known colour and font slots are kept. Anything else would be saved, copied
    # into every published snapshot, and break the response shape if it were not text.
    for key, slots in (("palette", PALETTE_KEYS), ("fonts", FONT_SLOTS)):
        if isinstance(clean.get(key), dict):
            clean[key] = {k: clean[key].get(k) for k in slots}
    before = template.as_dict()
    merged = {**before, **clean}
    problem = validate_template(merged)
    if problem:
        raise Invalid(problem)
    for key in EDITABLE:
        setattr(template, key, merged[key])
    template.updated_at = now
    await session.flush()
    await record_audit(
        session, actor=actor, action="template.update", entity_type="invitation_template",
        entity_id=template.id, before={k: before[k] for k in EDITABLE},
        after={k: merged[k] for k in EDITABLE}, request=request,
    )  # fmt: skip
    return template


def _is_photo(ref: dict[str, Any]) -> bool:
    """JPG, PNG or WebP — never SVG. Some systems send no type; then the name decides."""
    kind = ref.get("type") or ""
    return bool(_PHOTO_TYPE.match(kind)) or (
        not kind and bool(_PHOTO_NAME.search(ref.get("name") or ""))
    )


async def set_art(
    session: AsyncSession,
    template_id: str,
    slot: str,
    ref: dict[str, Any] | None,
    *,
    actor: User,
    now: datetime,
    request: Request | None = None,
) -> InvitationTemplate:
    """Sets or clears one artwork file on a template."""
    if slot not in ART_SLOTS:
        raise Invalid("Unknown artwork slot.")
    clean = rules.clean_section({"file": ref})["file"] if ref is not None else None
    if ref is not None and not (clean and _is_photo(clean)):
        raise Invalid("Artwork must be a JPG, PNG or WebP file.")
    template = await _studio(session, template_id)
    if template.status == "archived":
        raise Conflict("Restore the template before editing it.")
    if clean is not None:
        clean = (await media.scrub(session, {"file": clean}, studio=True))["file"]
        if clean is None:
            raise Invalid("Upload the artwork first, then choose it.")
    before = template.art.get(slot)
    template.art = {**template.art, slot: clean}
    template.updated_at = now
    await session.flush()
    await record_audit(
        session, actor=actor, action="template.art", entity_type="invitation_template",
        entity_id=template.id, before={slot: before}, after={slot: clean}, request=request,
    )  # fmt: skip
    return template


async def upload_art(
    session: AsyncSession,
    template_id: str,
    file: UploadFile,
    *,
    actor: User,
    now: datetime,
    request: Request | None = None,
) -> dict[str, Any]:
    """Store an artwork file for a studio template and return the reference to set on a slot.
    Not locked: an upload takes a moment, and the slot is only set by ``set_art``."""
    template = await get(session, template_id)
    if template.builtin:
        raise Conflict("Built-in templates cannot be changed. Duplicate it instead.")
    if template.status == "archived":
        raise Conflict("Restore the template before editing it.")
    row = await media.upload(
        session, file, kind=ARTWORK, by=actor.full_name, now=now, template_id=template.id
    )
    await record_audit(
        session, actor=actor, action="template.art_upload", entity_type="invitation_template",
        entity_id=template.id, detail={"file": row.name, "bytes": row.size_bytes},
        request=request,
    )  # fmt: skip
    return media.ref_of(row)


async def set_status(
    session: AsyncSession,
    template_id: str,
    status: str,
    *,
    actor: User,
    now: datetime,
    request: Request | None = None,
) -> InvitationTemplate:
    """Into the gallery (published), out of it (draft), or archived. Only a template that
    validates may enter the gallery, and an archived one goes back only by way of Restore
    (archived → draft), never straight to published."""
    template = await _studio(session, template_id)
    if template.status == status:
        raise Conflict(f"The template is already {status}.")
    if template.status == "archived" and status != "draft":
        raise Conflict("Restore the template before adding it to the gallery.")
    problem = validate_template({**template.as_dict(), "status": status})
    if problem:
        raise Invalid(problem)
    before = template.status
    template.status = status
    template.updated_at = now
    await session.flush()
    await record_audit(
        session, actor=actor, action="template.status", entity_type="invitation_template",
        entity_id=template.id, before={"status": before}, after={"status": status},
        request=request,
    )  # fmt: skip
    return template
