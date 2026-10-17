"""The guest list, custom RSVP questions, tables and checkpoints — staff side.

Ported from ``useProto.js`` (``addGuests`` … ``setGuestEmail``, ``addQuestion`` …
``removeQuestion``, ``addTable``, ``addCheckpoint`` … ``removeCheckpoint``). Each mutation
locks its event first, so per-event counters (question and checkpoint numbers, positions)
cannot be handed out twice.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from fastapi import Request
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import links
from app.core.errors import Conflict, Invalid, NotFound
from app.domain.audit.service import record_audit, snapshot
from app.domain.crm.campaigns import scrub_guest
from app.domain.events import rules
from app.domain.events.models import (
    EventCheckpoint,
    EventQuestion,
    EventScan,
    EventTable,
    EventWish,
    Guest,
    GuestCategory,
    InvitedVia,
)
from app.domain.events.service import get_event
from app.domain.masters.models import User

GUEST_LINK_PURPOSE = "guest"


# ---------------------------------------------------------------------------
# Links
# ---------------------------------------------------------------------------


def guest_link_token(guest: Guest) -> str:
    """The guest's personal-link key (R3), scoped to their event and revoked by bumping
    ``link_version``. Deterministic, so staff can copy it again and again."""
    return links.issue(
        GUEST_LINK_PURPOSE, str(guest.id), guest.link_version, scope=(str(guest.event_id),)
    )


def guest_qr(guest: Guest) -> str:
    return links.qr_payload(str(guest.event_id), str(guest.id), guest.link_version)


def read_guest_token(token: str, event_id: uuid.UUID) -> links.Claim | None:
    """The claim in a personal-link token for this event; the caller checks the version."""
    return links.read(GUEST_LINK_PURPOSE, token, scope=(str(event_id),))


# ---------------------------------------------------------------------------
# Guests
# ---------------------------------------------------------------------------


async def list_guests(session: AsyncSession, event_id: uuid.UUID) -> list[Guest]:
    return list(
        (await session.execute(select(Guest).where(Guest.event_id == event_id).order_by(Guest.seq)))
        .scalars()
        .all()
    )


async def get_guest(
    session: AsyncSession, event_id: uuid.UUID, guest_id: uuid.UUID, *, lock: bool = False
) -> Guest:
    stmt = select(Guest).where(Guest.id == guest_id, Guest.event_id == event_id)
    if lock:
        stmt = stmt.with_for_update()
    guest = (await session.execute(stmt)).scalar_one_or_none()
    if guest is None:
        raise NotFound("No such guest at this event.")
    return guest


@dataclass(frozen=True, slots=True)
class GuestRow:
    name: str
    phone: str
    email: str = ""
    table: str = ""
    category: str = ""


@dataclass(frozen=True, slots=True)
class AddResult:
    added: int
    skipped: int


async def add_guests(
    session: AsyncSession,
    event_id: uuid.UUID,
    rows: Iterable[GuestRow],
    *,
    actor: User,
    now: datetime,
    source: str = "manual",
    request: Request | None = None,
) -> AddResult:
    """Adds guests to the client's list, skipping a row with no name, a phone under eight
    digits, or a phone already on the list (or earlier in the same batch)."""
    event = await get_event(session, event_id, lock=True)
    known = set(
        (await session.execute(select(Guest.phone_norm).where(Guest.event_id == event.id)))
        .scalars()
        .all()
    )
    added = skipped = 0
    for row in rows:
        name, phone = row.name.strip(), row.phone.strip()
        norm = rules.norm_phone(phone)
        # Over 32 digits is no phone number, and truncating it to fit could make two
        # different numbers look like one guest.
        valid = rules.MIN_PHONE_DIGITS <= len(norm) <= 32
        if not name or not valid or norm in known:
            skipped += 1
            continue
        known.add(norm)
        session.add(
            Guest(
                event_id=event.id, name=name[:160], phone=phone[:64], phone_norm=norm,
                email=row.email.strip()[:200],
                category=GuestCategory(rules.to_category(row.category)),
                on_master_list=True, pax=0, allergies="", answers={}, consent=False,
                table=rules.clean_table(row.table), note="", walk_in=False, link_version=1,
                created_at=now,
            )
        )  # fmt: skip
        added += 1
    await session.flush()
    if added:
        event.updated_at = now
        await record_audit(
            session, actor=actor, action="guest.add", entity_type="event", entity_id=event.id,
            detail={"added": added, "skipped": skipped, "source": source}, request=request,
        )  # fmt: skip
    return AddResult(added=added, skipped=skipped)


async def import_csv(
    session: AsyncSession,
    event_id: uuid.UUID,
    text: str,
    *,
    actor: User,
    now: datetime,
    request: Request | None = None,
) -> AddResult:
    """The client's guest list as CSV (``parse_guest_csv``); rows without a name and phone
    count as skipped along with the duplicates."""
    parsed, data_rows = rules.read_guest_csv(text)
    result = await add_guests(
        session, event_id,
        [GuestRow(g.name, g.phone, g.email, g.table, g.category) for g in parsed],
        actor=actor, now=now, source="csv", request=request,
    )  # fmt: skip
    return AddResult(added=result.added, skipped=result.skipped + data_rows - len(parsed))


GUEST_AUDIT = ("table", "category", "note", "email")

ERASED_NAME = "Erased guest"
ERASED_MESSAGE = "That guest's personal data was erased, so it cannot be edited."


async def withdraw_consent(
    session: AsyncSession,
    event_id: uuid.UUID,
    guest_id: uuid.UUID,
    *,
    now: datetime,
    actor: User | None = None,
    actor_label: str | None = None,
    request: Request | None = None,
) -> Guest:
    """Stop keeping the guest's contact details for news and offers. Their reply and their place on
    the list stay. Idempotent: withdrawing twice records nothing the second time."""
    await get_event(session, event_id, lock=True)
    guest = await get_guest(session, event_id, guest_id, lock=True)
    if not guest.consent:
        return guest
    guest.consent = False
    guest.consent_at = None  # the database holds the two together
    await session.flush()
    await record_audit(
        session, actor=actor, actor_label=actor_label, action="guest.consent_withdraw",
        entity_type="guest", entity_id=guest.id, after={"consent": False}, request=request,
    )  # fmt: skip
    return guest


async def erase_guest(
    session: AsyncSession,
    event_id: uuid.UUID,
    guest_id: uuid.UUID,
    *,
    now: datetime,
    actor: User | None = None,
    actor_label: str | None = None,
    request: Request | None = None,
) -> Guest:
    """Erase a guest's personal data, keeping the row so nothing else changes.

    Name, phone, email, allergies, answers, the staff note and consent are blanked; the personal
    link and QR stop working; the guest's wishes are removed. Kept on purpose: whether they were
    coming and for how many (the headcount), where they sat, and when they checked in (the report
    and the door's history), none of which can be tied to a person any more. The audit log is
    append-only, so earlier rows keep the guest's id (and any email or note from a past edit);
    this writes a new row that holds ids and counts only. Idempotent."""
    await get_event(session, event_id, lock=True)
    guest = await get_guest(session, event_id, guest_id, lock=True)
    if guest.erased_at is not None:
        return guest
    removed = await session.execute(delete(EventWish).where(EventWish.guest_id == guest.id))
    wishes = getattr(removed, "rowcount", 0)
    guest.name = ERASED_NAME
    guest.phone = ""
    guest.phone_norm = ""  # leaves the one-per-phone index too
    guest.email = ""
    guest.allergies = ""
    guest.answers = {}
    guest.note = ""
    guest.note_by = None
    guest.note_at = None
    guest.consent = False
    guest.consent_at = None
    guest.link_version += 1
    guest.erased_at = now
    await session.flush()
    # A campaign that was made from this guest keeps no trace of them either.
    scrubbed = await scrub_guest(session, guest.id, now=now)
    await record_audit(
        session, actor=actor, actor_label=actor_label, action="guest.erase", entity_type="guest",
        entity_id=guest.id, after={"erased": True},
        detail={
            "wishes_removed": wishes or 0,
            "event_id": str(event_id),
            "campaign_recipients_cleared": scrubbed,
        },
        request=request,
    )  # fmt: skip
    return guest


async def _edit(
    session: AsyncSession,
    event_id: uuid.UUID,
    guest_id: uuid.UUID,
    *,
    actor: User,
    request: Request | None,
    apply: Callable[[Guest], None],
) -> Guest:
    await get_event(session, event_id, lock=True)
    guest = await get_guest(session, event_id, guest_id, lock=True)
    if guest.erased_at is not None:
        raise Conflict(ERASED_MESSAGE)
    before = snapshot(guest, GUEST_AUDIT)
    apply(guest)
    await session.flush()
    await record_audit(
        session, actor=actor, action="guest.update", entity_type="guest", entity_id=guest.id,
        before=before, after=snapshot(guest, GUEST_AUDIT), request=request,
    )  # fmt: skip
    return guest


async def set_table(
    session: AsyncSession, event_id: uuid.UUID, guest_id: uuid.UUID, table: str, *,
    actor: User, request: Request | None = None,
) -> Guest:  # fmt: skip
    """Any text (round 4), trimmed and capped at 30; empty clears it."""

    def apply(g: Guest) -> None:
        g.table = rules.clean_table(table)

    return await _edit(session, event_id, guest_id, actor=actor, request=request, apply=apply)


async def set_category(
    session: AsyncSession, event_id: uuid.UUID, guest_id: uuid.UUID, category: str, *,
    actor: User, request: Request | None = None,
) -> Guest:  # fmt: skip
    if category not in rules.GUEST_CATEGORIES:
        raise Invalid(f"A category is one of {', '.join(rules.GUEST_CATEGORIES)}.")

    def apply(g: Guest) -> None:
        g.category = GuestCategory(category)

    return await _edit(session, event_id, guest_id, actor=actor, request=request, apply=apply)


async def set_note(
    session: AsyncSession, event_id: uuid.UUID, guest_id: uuid.UUID, text: str, *,
    actor: User, now: datetime, request: Request | None = None,
) -> Guest:  # fmt: skip
    """A staff-only note (R5), with who and when; empty text clears it."""
    note = (text or "").strip()[:2000]

    def apply(g: Guest) -> None:
        if note == g.note:
            return
        g.note = note
        g.note_by = actor.full_name if note else None
        g.note_at = now if note else None

    return await _edit(session, event_id, guest_id, actor=actor, request=request, apply=apply)


async def set_email(
    session: AsyncSession, event_id: uuid.UUID, guest_id: uuid.UUID, email: str, *,
    actor: User, request: Request | None = None,
) -> Guest:  # fmt: skip
    """Adds or corrects a guest's email (e.g. one their invitation failed for), so a retry
    can reach them. Empty clears it; anything else must look like an address."""
    value = (email or "").strip()[:200]
    if value and not rules.is_email(value):
        raise Invalid("That does not look like an email address.")

    def apply(g: Guest) -> None:
        g.email = value

    return await _edit(session, event_id, guest_id, actor=actor, request=request, apply=apply)


# ---------------------------------------------------------------------------
# Custom RSVP questions (R7) — staff only; the client's link cannot change them
# ---------------------------------------------------------------------------


async def list_questions(session: AsyncSession, event_id: uuid.UUID) -> list[EventQuestion]:
    return list(
        (
            await session.execute(
                select(EventQuestion)
                .where(EventQuestion.event_id == event_id)
                .order_by(EventQuestion.position)
            )
        )
        .scalars()
        .all()
    )


async def _question(session: AsyncSession, event_id: uuid.UUID, key: str) -> EventQuestion:
    q = (
        await session.execute(
            select(EventQuestion).where(
                EventQuestion.event_id == event_id, EventQuestion.key == key
            )
        )
    ).scalar_one_or_none()
    if q is None:
        raise NotFound("No such question.")
    return q


async def add_question(
    session: AsyncSession, event_id: uuid.UUID, qtype: str, *, now: datetime
) -> EventQuestion:
    """A new, blank question. A choice or dropdown starts with two placeholder options. Keys
    are never reused: a removed question's answers stay in guests' records, and a new
    question must not inherit them."""
    if qtype not in rules.QUESTION_TYPES:
        raise Invalid("A question is short text, multiple choice or a dropdown.")
    event = await get_event(session, event_id, lock=True)
    questions = await list_questions(session, event.id)
    if len(questions) >= rules.MAX_QUESTIONS:
        raise Conflict(f"An event asks at most {rules.MAX_QUESTIONS} questions.")
    event.question_seq += 1
    q = EventQuestion(
        event_id=event.id, key=f"Q-{event.question_seq}",
        position=max((x.position for x in questions), default=0) + 1, label="", type=qtype,
        options=[] if qtype == "text" else ["Option 1", "Option 2"], multi=False,
        required=False, attending_only=True,
    )  # fmt: skip
    session.add(q)
    event.updated_at = now
    await session.flush()
    return q


async def update_question(
    session: AsyncSession, event_id: uuid.UUID, key: str, patch: dict[str, Any], *, now: datetime
) -> EventQuestion:
    """Options are trimmed, de-duplicated and never blank; "several answers" is for choices
    only; a text question has no options, and one turned into a choice gets placeholders."""
    event = await get_event(session, event_id, lock=True)
    q = await _question(session, event.id, key)
    was = q.type
    if isinstance(patch.get("label"), str):
        q.label = patch["label"][:200]
    if patch.get("type") is not None:
        if patch["type"] not in rules.QUESTION_TYPES:
            raise Invalid("A question is short text, multiple choice or a dropdown.")
        q.type = patch["type"]
    if patch.get("options") is not None:
        q.options = rules.clean_options(patch["options"])
    for field in ("multi", "required", "attending_only"):
        if patch.get(field) is not None:
            setattr(q, field, bool(patch[field]))
    if q.type != "choice":
        q.multi = False
    if q.type == "text":
        q.options = []
    elif not q.options and was == "text":
        q.options = ["Option 1", "Option 2"]
    event.updated_at = now
    await session.flush()
    return q


async def move_question(
    session: AsyncSession, event_id: uuid.UUID, key: str, direction: int, *, now: datetime
) -> list[EventQuestion]:
    event = await get_event(session, event_id, lock=True)
    questions = await list_questions(session, event.id)
    i = next((n for n, q in enumerate(questions) if q.key == key), None)
    if i is None:
        raise NotFound("No such question.")
    j = i + (-1 if direction < 0 else 1)
    if not 0 <= j < len(questions):
        raise Conflict("The question is already at that end of the list.")
    questions[i].position, questions[j].position = questions[j].position, questions[i].position
    event.updated_at = now
    await session.flush()
    return sorted(questions, key=lambda q: q.position)


async def remove_question(
    session: AsyncSession, event_id: uuid.UUID, key: str, *, actor: User, now: datetime,
    request: Request | None = None,
) -> None:  # fmt: skip
    """The question goes; guests' earlier answers stay in their record but are not shown."""
    event = await get_event(session, event_id, lock=True)
    q = await _question(session, event.id, key)
    before = snapshot(q, ("key", "label", "type", "options"))
    await session.delete(q)
    event.updated_at = now
    await session.flush()
    await record_audit(
        session, actor=actor, action="question.remove", entity_type="event",
        entity_id=event.id, before=before, after=None, request=request,
    )  # fmt: skip


# ---------------------------------------------------------------------------
# Tables
# ---------------------------------------------------------------------------


async def add_table(
    session: AsyncSession, event_id: uuid.UUID, name: str, *, now: datetime
) -> list[str]:
    clean = rules.clean_table(name)
    if not clean:
        raise Invalid("Give the table a name.")
    event = await get_event(session, event_id, lock=True)
    names = list(
        (
            await session.execute(
                select(EventTable.name)
                .where(EventTable.event_id == event.id)
                .order_by(EventTable.position)
            )
        )
        .scalars()
        .all()
    )
    if clean in names:
        raise Conflict(f"There is already a table {clean}.")
    position = (
        await session.execute(
            select(func.coalesce(func.max(EventTable.position), 0)).where(
                EventTable.event_id == event.id
            )
        )
    ).scalar_one()
    session.add(EventTable(event_id=event.id, name=clean, position=position + 1))
    event.updated_at = now
    await session.flush()
    return [*names, clean]


# ---------------------------------------------------------------------------
# Checkpoints (R1)
# ---------------------------------------------------------------------------


async def list_checkpoints(session: AsyncSession, event_id: uuid.UUID) -> list[EventCheckpoint]:
    return list(
        (
            await session.execute(
                select(EventCheckpoint)
                .where(EventCheckpoint.event_id == event_id)
                .order_by(EventCheckpoint.position)
            )
        )
        .scalars()
        .all()
    )


def _categories(values: Sequence[Any]) -> list[str]:
    return [c for c in dict.fromkeys(values) if c in rules.GUEST_CATEGORIES]


async def add_checkpoint(
    session: AsyncSession, event_id: uuid.UUID, name: str, *, now: datetime
) -> EventCheckpoint:
    clean = (name or "").strip()[:80]
    if not clean:
        raise Invalid("Give the checkpoint a name.")
    event = await get_event(session, event_id, lock=True)
    existing = await list_checkpoints(session, event.id)
    if any(c.name.lower() == clean.lower() for c in existing):
        raise Conflict(f"There is already a checkpoint called {clean}.")
    event.checkpoint_seq += 1
    cp = EventCheckpoint(
        event_id=event.id, key=f"CP-{event.checkpoint_seq}",
        position=max((c.position for c in existing), default=0) + 1, name=clean, categories=[],
    )  # fmt: skip
    session.add(cp)
    event.updated_at = now
    await session.flush()
    return cp


async def _checkpoint(
    session: AsyncSession, event_id: uuid.UUID, checkpoint_id: uuid.UUID
) -> EventCheckpoint:
    cp = (
        await session.execute(
            select(EventCheckpoint).where(
                EventCheckpoint.id == checkpoint_id, EventCheckpoint.event_id == event_id
            )
        )
    ).scalar_one_or_none()
    if cp is None:
        raise NotFound("No such checkpoint at this event.")
    return cp


async def update_checkpoint(
    session: AsyncSession, event_id: uuid.UUID, checkpoint_id: uuid.UUID,
    patch: dict[str, Any], *, now: datetime,
) -> EventCheckpoint:  # fmt: skip
    """Rename a checkpoint, or set who it admits (an empty list = everyone)."""
    event = await get_event(session, event_id, lock=True)
    cp = await _checkpoint(session, event.id, checkpoint_id)
    name = patch["name"].strip()[:80] if isinstance(patch.get("name"), str) else ""
    if name:
        others = await list_checkpoints(session, event.id)
        if any(c.id != cp.id and c.name.lower() == name.lower() for c in others):
            raise Conflict(f"There is already a checkpoint called {name}.")
        cp.name = name
    if patch.get("categories") is not None:
        cp.categories = _categories(patch["categories"])
    event.updated_at = now
    await session.flush()
    return cp


async def remove_checkpoint(
    session: AsyncSession, event_id: uuid.UUID, checkpoint_id: uuid.UUID, *, actor: User,
    now: datetime, request: Request | None = None,
) -> None:  # fmt: skip
    """The last checkpoint stays, and so does one with scans: its log would lose its place."""
    event = await get_event(session, event_id, lock=True)
    cp = await _checkpoint(session, event.id, checkpoint_id)
    if len(await list_checkpoints(session, event.id)) <= 1:
        raise Conflict("An event keeps at least one checkpoint.")
    scanned = (
        await session.execute(
            select(func.count()).select_from(EventScan).where(EventScan.checkpoint_id == cp.id)
        )
    ).scalar_one()
    if scanned:
        raise Conflict(f"{cp.name} has scans logged against it, so it stays.")
    before = snapshot(cp, ("key", "name", "categories"))
    await session.delete(cp)
    event.updated_at = now
    await session.flush()
    await record_audit(
        session, actor=actor, action="checkpoint.remove", entity_type="event",
        entity_id=event.id, before=before, after=None, request=request,
    )  # fmt: skip


async def mark_sent_by_client(
    session: AsyncSession, event_id: uuid.UUID, guest_id: uuid.UUID, *, now: datetime,
    request: Request | None = None,
) -> Guest:  # fmt: skip
    """The client sent this guest their invitation themselves (WhatsApp from their own phone).
    Recorded once; a guest Oscenia already sent to keeps that."""
    await get_event(session, event_id, lock=True)
    guest = await get_guest(session, event_id, guest_id, lock=True)
    if guest.invited_at is None:
        guest.invited_at, guest.invited_via = now, InvitedVia.CLIENT
        await session.flush()
        await record_audit(
            session, actor_label="client link", action="guest.sent_by_client", entity_type="guest",
            entity_id=guest.id, after={"invited_via": InvitedVia.CLIENT.value}, request=request,
        )  # fmt: skip
    return guest


async def regenerate_link(
    session: AsyncSession, event_id: uuid.UUID, guest_id: uuid.UUID, *, actor: User,
    request: Request | None = None,
) -> Guest:  # fmt: skip
    """A leaked personal link (or a screenshot of the QR) stops working at once: the old token
    and QR carry the old version, and only the new one names the guest. The guest's reply stays."""
    await get_event(session, event_id, lock=True)
    guest = await get_guest(session, event_id, guest_id, lock=True)
    before = guest.link_version
    guest.link_version = before + 1
    await session.flush()
    await record_audit(
        session, actor=actor, action="guest.link_regenerate", entity_type="guest",
        entity_id=guest.id, before={"link_version": before},
        after={"link_version": guest.link_version}, request=request,
    )  # fmt: skip
    return guest
