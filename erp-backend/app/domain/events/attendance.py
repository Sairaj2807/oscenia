"""RSVPs, wishes, check-in and the attendance report.

Ported from ``useProto.js`` (``submitRsvp``, ``addWish`` and moderation, ``scanGuest`` …
``registerWalkIn``) and the report helpers in ``lib/events.js``. ``submit_rsvp`` and
``add_wish`` are the guest-facing rules; their public, token-checked routes arrive in
Phase 2, so for now they are exercised by the tests directly.

Check-in verifies the signed QR (``app/core/links.py``): a code minted under an old link
version — a screenshot of a revoked invitation — no longer checks anyone in.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any

from fastapi import Request
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import links
from app.core.errors import Conflict, Invalid, NotFound
from app.domain.audit.service import record_audit
from app.domain.events import rules
from app.domain.events.guests import (
    get_guest,
    list_checkpoints,
    list_guests,
    list_questions,
    read_guest_token,
)
from app.domain.events.models import (
    Event,
    EventCheckpoint,
    EventInvite,
    EventScan,
    EventStatus,
    EventWish,
    Guest,
    GuestCategory,
    InvitationTemplate,
    RsvpAnswer,
)
from app.domain.events.service import get_event
from app.domain.masters.models import User

# ---------------------------------------------------------------------------
# RSVP (guest-facing; public route in Phase 2)
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class RsvpForm:
    name: str
    phone: str
    attending: bool
    email: str = ""
    pax: Any = 1
    allergies: str = ""
    consent: bool = False
    answers: dict[str, Any] = field(default_factory=dict)
    #: A personal link's token (R3) names the guest outright.
    token: str | None = None


async def guest_by_token(session: AsyncSession, event_id: uuid.UUID, token: str) -> Guest | None:
    claim = read_guest_token(token, event_id)
    if claim is None:
        return None
    try:
        guest_id = uuid.UUID(claim.subject)
    except ValueError:
        return None
    guest = await session.get(Guest, guest_id)
    if guest is None or guest.event_id != event_id or guest.link_version != claim.version:
        return None
    return guest


async def submit_rsvp(
    session: AsyncSession, event_id: uuid.UUID, form: RsvpForm, *, now: datetime, today: date
) -> Guest:
    """A guest's reply from the invitation page. Matched to the client's list by personal
    link, then phone, then email; anyone else becomes an off-list guest.

    A changed reply keeps the client's spelling of the name, any table, and the listed email
    when the guest left it blank; the phone the guest typed wins (reminders go to it).
    Consent given before is kept — an unticked box on a changed reply is not a withdrawal.
    Answers to questions this guest is no longer asked go; answers to a removed question
    stay, unseen.
    """
    event = await get_event(session, event_id, lock=True)
    published = event.status == EventStatus.PUBLISHED
    if not rules.rsvp_open(
        published=published, deadline=event.rsvp_deadline, event_date=event.date, today=today
    ):
        raise Conflict("RSVPs are closed for this event.")
    name, phone = form.name.strip(), form.phone.strip()
    if not name or not phone:
        raise Invalid("Your name and phone number are needed.")
    norm = rules.norm_phone(phone)
    # Refused, not truncated: a cut-off phone would no longer match its own guest next time.
    if len(phone) > 64 or len(norm) > 32:
        raise Invalid("That phone number is too long.")

    questions = await list_questions(session, event.id)
    answers, missing = rules.clean_answers(questions, form.attending, form.answers)
    if missing:
        raise Invalid(f"Please answer: {', '.join(missing)}.")

    attending = form.attending is True
    email = form.email.strip()[:200]
    answer = RsvpAnswer.ATTENDING if attending else RsvpAnswer.DECLINED
    pax = rules.clamp_pax(form.pax, event.max_pax) if attending else 0
    allergies = form.allergies.strip()[:500] if attending else ""
    consent = bool(form.consent)

    existing = await guest_by_token(session, event.id, form.token) if form.token else None
    if existing is None:
        existing = rules.match_guest(await list_guests(session, event.id), phone=phone, email=email)

    if existing is None:
        guest = Guest(
            event_id=event.id, name=name[:160], phone=phone, phone_norm=norm, email=email,
            category=GuestCategory.REGULAR, on_master_list=False, rsvp=answer, pax=pax,
            allergies=allergies, answers=answers, consent=consent,
            consent_at=now if consent else None, responded_at=now, table="", note="",
            walk_in=False, link_version=1, created_at=now,
        )  # fmt: skip
        session.add(guest)
        await session.flush()
        return guest

    if norm and norm != existing.phone_norm:
        clash = (
            await session.execute(
                select(Guest.id).where(
                    Guest.event_id == event.id, Guest.phone_norm == norm, Guest.id != existing.id
                )
            )
        ).first()
        if clash is not None:
            raise Conflict("That phone number belongs to another guest on the list.")

    asked = {q.key for q in rules.questions_for(questions, attending)}
    current = {q.key for q in questions}
    kept = {
        k: v for k, v in (existing.answers or {}).items() if k not in asked and k not in current
    }
    existing.phone, existing.phone_norm = phone, norm
    existing.email = email or existing.email
    existing.rsvp, existing.pax, existing.allergies = answer, pax, allergies
    existing.answers = {**kept, **answers}
    if consent and not existing.consent:
        existing.consent, existing.consent_at = True, now
    existing.responded_at = now
    await session.flush()
    return existing


# ---------------------------------------------------------------------------
# Wishes (D13)
# ---------------------------------------------------------------------------


async def live_template(session: AsyncSession, invite: EventInvite) -> dict[str, Any] | None:
    """The template guests see now. Like the prototype, a studio edit reaches live
    invitations at once; ``published_template`` keeps the copy as it was at publish."""
    tid = (invite.published or {}).get("template_id")
    row = await session.get(InvitationTemplate, tid) if tid else None
    return row.as_dict() if row is not None else invite.published_template


async def add_wish(
    session: AsyncSession,
    event_id: uuid.UUID,
    *,
    text: str,
    name: str = "",
    guest_token: str | None = None,
    now: datetime,
) -> EventWish:
    """A wish from the invitation page. Only a published invitation that shows the wishes
    section takes one. A guest on a personal link signs with their listed name; anyone else
    types one. Each may leave three, never the same words twice."""
    event = await get_event(session, event_id, lock=True)
    invite = (
        await session.execute(select(EventInvite).where(EventInvite.event_id == event.id))
    ).scalar_one()
    live = invite.published if event.status == EventStatus.PUBLISHED else None
    if live is None:
        raise Conflict("This invitation is not open.")
    template = await live_template(session, invite)
    if "wishes" not in rules.visible_sections(
        template, live.get("on") or {}, live.get("content") or {}
    ):
        raise Conflict("This invitation does not take wishes.")

    guest = None
    if guest_token is not None:
        guest = await guest_by_token(session, event.id, guest_token)
        if guest is None:
            raise Invalid("That invitation link is not valid.")
    who = (guest.name if guest else name).strip()[: rules.WISH_NAME_MAX]
    body = text.strip()[: rules.WISH_TEXT_MAX]
    if not who or not body:
        raise Invalid("A name and a few words are needed.")

    wishes = list(
        (await session.execute(select(EventWish).where(EventWish.event_id == event.id))).scalars()
    )
    if guest is not None:
        theirs = [w for w in wishes if w.guest_id == guest.id]
    else:  # off the list, the cap goes by name, any case
        theirs = [w for w in wishes if w.guest_id is None and w.name.lower() == who.lower()]
    if len(wishes) >= rules.WISHES_PER_EVENT:
        raise Conflict("This invitation has all the wishes it can take.")
    if len(theirs) >= rules.WISHES_PER_GUEST:
        raise Conflict(f"Each guest may leave {rules.WISHES_PER_GUEST} wishes.")
    if any(w.text == body for w in theirs):
        raise Conflict("You have already left that wish.")

    wish = EventWish(
        event_id=event.id, guest_id=guest.id if guest else None, name=who, text=body, at=now,
        hidden=False, approved=not event.hold_wishes,
    )  # fmt: skip
    session.add(wish)
    await session.flush()
    return wish


async def list_wishes(session: AsyncSession, event_id: uuid.UUID) -> list[EventWish]:
    return list(
        (
            await session.execute(
                select(EventWish).where(EventWish.event_id == event_id).order_by(EventWish.id)
            )
        ).scalars()
    )


async def _wish(session: AsyncSession, event: Event, wish_id: int) -> EventWish:
    wish = (
        await session.execute(
            select(EventWish).where(EventWish.id == wish_id, EventWish.event_id == event.id)
        )
    ).scalar_one_or_none()
    if wish is None:
        raise NotFound("No such wish.")
    return wish


async def set_wish_hidden(
    session: AsyncSession, event_id: uuid.UUID, wish_id: int, hidden: bool, *,
    actor: User | None = None, actor_label: str | None = None, request: Request | None = None,
) -> EventWish:  # fmt: skip
    """Hides a wish from guests, or shows it again. It is kept on record either way."""
    event = await get_event(session, event_id, lock=True)
    wish = await _wish(session, event, wish_id)
    before = wish.hidden
    wish.hidden = bool(hidden)
    await session.flush()
    await record_audit(
        session, actor=actor, actor_label=actor_label, action="wish.hide", entity_type="event",
        entity_id=event.id, before={"hidden": before}, after={"hidden": wish.hidden},
        detail={"wish_id": wish.id}, request=request,
    )  # fmt: skip
    return wish


async def approve_wish(
    session: AsyncSession, event_id: uuid.UUID, wish_id: int, *,
    actor: User | None = None, actor_label: str | None = None, request: Request | None = None,
) -> EventWish:  # fmt: skip
    """Lets a waiting wish show, and brings back a hidden one."""
    event = await get_event(session, event_id, lock=True)
    wish = await _wish(session, event, wish_id)
    before = {"approved": wish.approved, "hidden": wish.hidden}
    wish.approved, wish.hidden = True, False
    await session.flush()
    await record_audit(
        session, actor=actor, actor_label=actor_label, action="wish.approve",
        entity_type="event", entity_id=event.id, before=before,
        after={"approved": True, "hidden": False}, detail={"wish_id": wish.id}, request=request,
    )  # fmt: skip
    return wish


# ---------------------------------------------------------------------------
# Check-in (R1)
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ScanResult:
    scan: EventScan
    guest: Guest
    checkpoint: EventCheckpoint
    #: For the desk to judge — the scan is logged either way.
    first_arrival: bool
    repeat_here: bool
    admitted: bool


async def _checkpoint(
    session: AsyncSession, event_id: uuid.UUID, checkpoint_id: uuid.UUID | None
) -> EventCheckpoint:
    """The named checkpoint, or the event's first (the entrance) when none is named."""
    checkpoints = await list_checkpoints(session, event_id)
    if checkpoint_id is None:
        return checkpoints[0]
    cp = next((c for c in checkpoints if c.id == checkpoint_id), None)
    if cp is None:
        raise NotFound("No such checkpoint at this event.")
    return cp


async def _scan(
    session: AsyncSession, guest: Guest, cp: EventCheckpoint, *, now: datetime,
    by: uuid.UUID | None,
) -> ScanResult:  # fmt: skip
    repeat = (
        await session.execute(
            select(func.count())
            .select_from(EventScan)
            .where(EventScan.guest_id == guest.id, EventScan.checkpoint_id == cp.id)
        )
    ).scalar_one() > 0
    scan = EventScan(
        event_id=guest.event_id, guest_id=guest.id, checkpoint_id=cp.id, at=now, by_user_id=by
    )
    session.add(scan)
    first = guest.checked_in_at is None
    if first:
        guest.checked_in_at = now
    await session.flush()
    return ScanResult(
        scan=scan, guest=guest, checkpoint=cp, first_arrival=first, repeat_here=repeat,
        admitted=rules.checkpoint_admits(cp.categories, guest.category.value),
    )  # fmt: skip


async def scan_guest(
    session: AsyncSession, event_id: uuid.UUID, guest_id: uuid.UUID,
    checkpoint_id: uuid.UUID | None, *, actor: User, now: datetime,
) -> ScanResult:  # fmt: skip
    """One scan of a guest at one checkpoint. Every scan is logged — a repeat, or a guest
    outside the checkpoint's categories, is for the desk to judge. The first scan anywhere
    is their arrival."""
    await get_event(session, event_id, lock=True)
    guest = await get_guest(session, event_id, guest_id, lock=True)
    cp = await _checkpoint(session, event_id, checkpoint_id)
    return await _scan(session, guest, cp, now=now, by=actor.id)


async def scan_qr(
    session: AsyncSession, event_id: uuid.UUID, payload: str,
    checkpoint_id: uuid.UUID | None, *, actor: User, now: datetime,
) -> ScanResult:  # fmt: skip
    """A scanned access card. Only a code we signed, for this event, at the guest's current
    link version, checks anyone in — one answer for every kind of bad code."""
    claim = links.parse_qr(payload)
    refused = Invalid("That code is not a valid invitation for this event.")
    if claim is None or claim.event_id != str(event_id):
        raise refused
    try:
        guest_id = uuid.UUID(claim.guest_id)
    except ValueError:
        raise refused from None
    await get_event(session, event_id, lock=True)
    guest = await session.get(Guest, guest_id, with_for_update=True)
    if guest is None or guest.event_id != event_id or guest.link_version != claim.version:
        raise refused
    cp = await _checkpoint(session, event_id, checkpoint_id)
    return await _scan(session, guest, cp, now=now, by=actor.id)


async def check_in(
    session: AsyncSession, event_id: uuid.UUID, guest_id: uuid.UUID, *, actor: User, now: datetime
) -> ScanResult:
    """Arrival at the first checkpoint. Refused if they have already arrived, so a second
    tap never overwrites the first arrival time."""
    await get_event(session, event_id, lock=True)
    guest = await get_guest(session, event_id, guest_id, lock=True)
    if guest.checked_in_at is not None:
        raise Conflict(f"{guest.name} has already arrived.")
    cp = await _checkpoint(session, event_id, None)
    return await _scan(session, guest, cp, now=now, by=actor.id)


async def undo_check_in(
    session: AsyncSession, event_id: uuid.UUID, guest_id: uuid.UUID, *, actor: User,
    request: Request | None = None,
) -> Guest:  # fmt: skip
    """Undoes the guest's latest scan; with none left they have not arrived. A walk-in keeps
    their first scan — it is their whole record."""
    event = await get_event(session, event_id, lock=True)
    guest = await get_guest(session, event_id, guest_id, lock=True)
    if guest.checked_in_at is None:
        raise Conflict(f"{guest.name} has not arrived.")
    scans = list(
        (
            await session.execute(
                select(EventScan)
                .where(EventScan.guest_id == guest.id)
                .order_by(EventScan.at.desc(), EventScan.id.desc())
            )
        ).scalars()
    )
    if guest.walk_in and len(scans) <= 1:
        raise Conflict("A walk-in's check-in is their record and cannot be undone.")
    if scans:
        await session.delete(scans[0])
    if len(scans) <= 1:
        guest.checked_in_at = None
    await session.flush()
    await record_audit(
        session, actor=actor, action="checkin.undo", entity_type="guest", entity_id=guest.id,
        detail={"event_id": str(event.id), "scans_left": max(0, len(scans) - 1)},
        request=request,
    )  # fmt: skip
    return guest


@dataclass(frozen=True, slots=True)
class WalkInForm:
    name: str
    phone: str
    email: str = ""
    consent: bool = False


async def register_walk_in(
    session: AsyncSession, event_id: uuid.UUID, form: WalkInForm, *, now: datetime,
    actor: User | None = None,
) -> tuple[Guest, bool]:  # fmt: skip
    """A guest registering at the desk (decision 10). Someone on the list is simply checked
    in; anyone else is added as a walk-in. Either way their consent choice is recorded for
    the CRM — ticking adds it, leaving it unticked never withdraws an earlier yes. Returns
    the guest and whether they are a new walk-in."""
    event = await get_event(session, event_id, lock=True)
    if event.status != EventStatus.PUBLISHED:
        raise Conflict("The invitation is not published.")
    name, norm = form.name.strip(), rules.norm_phone(form.phone)
    if not name or not rules.MIN_PHONE_DIGITS <= len(norm) <= 32:
        raise Invalid("A name and a phone number are needed.")
    entrance = await _checkpoint(session, event.id, None)
    by = actor.id if actor else None

    listed = (
        await session.execute(
            select(Guest)
            .where(Guest.event_id == event.id, Guest.phone_norm == norm)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if listed is not None:
        if listed.checked_in_at is None:
            await _scan(session, listed, entrance, now=now, by=by)
        listed.email = listed.email or form.email.strip()[:200]
        if form.consent and not listed.consent:
            listed.consent, listed.consent_at = True, now
        await session.flush()
        return listed, False

    guest = Guest(
        event_id=event.id, name=name[:160], phone=form.phone.strip()[:64], phone_norm=norm,
        email=form.email.strip()[:200], category=GuestCategory.REGULAR, on_master_list=False,
        pax=1, allergies="", answers={}, consent=bool(form.consent),
        consent_at=now if form.consent else None, table="", note="", walk_in=True,
        checked_in_at=now, link_version=1, created_at=now,
    )  # fmt: skip
    session.add(guest)
    await session.flush()
    session.add(
        EventScan(
            event_id=event.id, guest_id=guest.id, checkpoint_id=entrance.id, at=now, by_user_id=by
        )
    )
    await session.flush()
    return guest, True


# ---------------------------------------------------------------------------
# The attendance report (BRD §4.5)
# ---------------------------------------------------------------------------


async def report(session: AsyncSession, event_id: uuid.UUID) -> dict[str, Any]:
    """Headline numbers, the reconciliation grid, catering counts per question and scans
    per checkpoint — everything the Report tab draws."""
    await get_event(session, event_id)
    guests = await list_guests(session, event_id)
    stats = rules.event_stats(guests)
    grid = rules.reconcile(guests)
    answers = []
    for q in rules.questions_for(await list_questions(session, event_id), True):
        if q.type == "text":
            continue  # free text has nothing to count
        counts, none = rules.answer_counts(q, guests)
        answers.append({"key": q.key, "label": q.label, "counts": counts, "no_answer": none})
    scan_rows = (
        await session.execute(
            select(EventScan.checkpoint_id, func.count())
            .where(EventScan.event_id == event_id)
            .group_by(EventScan.checkpoint_id)
        )
    ).all()
    scans = {cp_id: int(n) for cp_id, n in scan_rows}
    checkpoints = await list_checkpoints(session, event_id)
    return {
        "stats": stats,
        "grid": {k: [g.id for g in v] for k, v in grid.items()},
        "answers": answers,
        "checkpoints": [
            {"id": c.id, "name": c.name, "scans": scans.get(c.id, 0)} for c in checkpoints
        ],
    }
