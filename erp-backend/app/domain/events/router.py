"""Events endpoints — staff side (Backend-Build-Plan Phase 1).

Who may do what, server-side:

* every endpoint needs the ``events`` module (CEO, PM, Sales — the roles the prototype
  shows the Events screens to);
* return, publish, unpublish and the client link need ``publish_invitation`` (CEO, PM);
* Template Studio writes need ``manage_templates`` (CEO, PM).

The prototype checks only publish, and only in the UI; the store accepted guest, question
and publish edits from anyone. These are the gaps the plan said to close.
"""

from __future__ import annotations

import uuid
from typing import Annotated, Any

from fastapi import APIRouter, File, Query, Request, UploadFile, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import ClockDep
from app.core.deps import ManagesTemplates, PublishesInvitation, SeesEvents
from app.core.errors import Invalid
from app.db.session import SessionDep
from app.domain.audit.service import record_audit
from app.domain.events import attendance, guests, rules, service, studio
from app.domain.events.models import (
    Event,
    EventCheckpoint,
    EventQuestion,
    EventScan,
    EventStatus,
    EventTable,
    EventWish,
    Guest,
    InvitationTemplate,
)
from app.domain.events.schemas import (
    AccentIn,
    AddResultOut,
    ArtIn,
    CategoryIn,
    CheckpointOut,
    CheckpointUpdate,
    ClientLinkOut,
    CsvIn,
    EmailIn,
    EventCreate,
    EventDetail,
    EventOut,
    EventUpdate,
    GuestOut,
    GuestsIn,
    HiddenIn,
    InviteOut,
    MediaOut,
    MoveIn,
    NameIn,
    NoteIn,
    PublishIn,
    QuestionCreate,
    QuestionOut,
    QuestionUpdate,
    ReportOut,
    ReturnIn,
    ReviewOut,
    ScanIn,
    ScanLogOut,
    ScanOut,
    SectionContent,
    SectionToggle,
    TableIn,
    TemplateChoice,
    TemplateCreate,
    TemplateOut,
    TemplateUpdate,
    WalkInIn,
    WalkInOut,
    WishOut,
)

router = APIRouter(prefix="/events", tags=["events"])
templates_router = APIRouter(prefix="/invitation-templates", tags=["invitation templates"])


# ---------------------------------------------------------------------------
# Shaping
# ---------------------------------------------------------------------------


async def stats_by_event(
    session: AsyncSession, event_ids: list[uuid.UUID]
) -> dict[uuid.UUID, rules.EventStats]:
    """The guest numbers for several events in one query, counted by the report's own rules."""
    by_event: dict[uuid.UUID, list[Guest]] = {i: [] for i in event_ids}
    if event_ids:
        rows = await session.execute(select(Guest).where(Guest.event_id.in_(event_ids)))
        for guest in rows.scalars():
            by_event[guest.event_id].append(guest)
    return {i: rules.event_stats(g) for i, g in by_event.items()}


def event_out(
    event: Event, clock: ClockDep, stats: rules.EventStats | None = None
) -> dict[str, Any]:
    fields = {
        name: getattr(event, name)
        for name in EventOut.model_fields
        if name not in ("rsvp_open", "stats")
    }
    return {
        **fields,
        "stats": stats,
        "status": event.status.value,
        "rsvp_open": rules.rsvp_open(
            published=event.status == EventStatus.PUBLISHED,
            deadline=event.rsvp_deadline,
            event_date=event.date,
            today=clock.today(),
        ),
    }


async def event_detail(session: AsyncSession, event: Event, clock: ClockDep) -> EventDetail:
    invite = await service.get_invite(session, event.id)
    review = service.review_view(await service.latest_review(session, event.id))
    questions = (
        (
            await session.execute(
                select(EventQuestion)
                .where(EventQuestion.event_id == event.id)
                .order_by(EventQuestion.position)
            )
        )
        .scalars()
        .all()
    )
    checkpoints = (
        (
            await session.execute(
                select(EventCheckpoint)
                .where(EventCheckpoint.event_id == event.id)
                .order_by(EventCheckpoint.position)
            )
        )
        .scalars()
        .all()
    )
    tables = (
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
    stats = (await stats_by_event(session, [event.id]))[event.id]
    return EventDetail(
        **event_out(event, clock, stats),
        invite=InviteOut(
            template_id=invite.template_id,
            accent=invite.accent,
            on=invite.toggles,
            content=invite.content,
            published=invite.published,
            published_at=invite.published_at,
            has_unpublished_changes=service.has_unpublished_changes(invite),
        ),
        review=ReviewOut.model_validate(review, from_attributes=True),
        questions=[QuestionOut.model_validate(q) for q in questions],
        checkpoints=[CheckpointOut.model_validate(c) for c in checkpoints],
        tables=list(tables),
    )


# ---------------------------------------------------------------------------
# Events
# ---------------------------------------------------------------------------


@router.get("", response_model=list[EventOut])
async def list_events(
    session: SessionDep, clock: ClockDep, user: SeesEvents
) -> list[dict[str, Any]]:
    events = await service.list_events(session)
    stats = await stats_by_event(session, [e.id for e in events])
    return [event_out(e, clock, stats[e.id]) for e in events]


@router.post("", response_model=EventDetail, status_code=status.HTTP_201_CREATED)
async def create_event(
    session: SessionDep, clock: ClockDep, user: SeesEvents, body: EventCreate, request: Request
) -> EventDetail:
    """A draft with a starter invitation, one entrance checkpoint and tables T1–T5. RSVPs
    close a week before the date — or on the day, for an event less than a week out."""
    event = await service.create_event(
        session, actor=user, now=clock.now(), today=clock.today(), name=body.name,
        event_date=body.date, time=body.time, venue=body.venue, client_id=body.client_id,
        project_id=body.project_id, request=request,
    )  # fmt: skip
    return await event_detail(session, event, clock)


@router.get("/{event_id}", response_model=EventDetail)
async def get_event(
    session: SessionDep, clock: ClockDep, user: SeesEvents, event_id: uuid.UUID
) -> EventDetail:
    return await event_detail(session, await service.get_event(session, event_id), clock)


@router.patch("/{event_id}", response_model=EventDetail)
async def update_event(
    session: SessionDep, clock: ClockDep, user: SeesEvents, event_id: uuid.UUID,
    body: EventUpdate, request: Request,
) -> EventDetail:  # fmt: skip
    event = await service.update_event(
        session, event_id, body.model_dump(exclude_unset=True), actor=user, now=clock.now(),
        request=request,
    )  # fmt: skip
    return await event_detail(session, event, clock)


# ---------------------------------------------------------------------------
# The invitation draft
# ---------------------------------------------------------------------------


@router.put("/{event_id}/invite/template", response_model=EventDetail)
async def choose_template(
    session: SessionDep, clock: ClockDep, user: SeesEvents, event_id: uuid.UUID,
    body: TemplateChoice,
) -> EventDetail:  # fmt: skip
    await service.choose_template(session, event_id, body.template_id, now=clock.now())
    return await event_detail(session, await service.get_event(session, event_id), clock)


@router.put("/{event_id}/invite/sections/{section_id}", response_model=EventDetail)
async def set_section(
    session: SessionDep, clock: ClockDep, user: SeesEvents, event_id: uuid.UUID,
    section_id: str, body: SectionToggle,
) -> EventDetail:  # fmt: skip
    await service.set_section(session, event_id, section_id, body.on, now=clock.now())
    return await event_detail(session, await service.get_event(session, event_id), clock)


@router.put("/{event_id}/invite/content/{section_id}", response_model=EventDetail)
async def update_content(
    session: SessionDep, clock: ClockDep, user: SeesEvents, event_id: uuid.UUID,
    section_id: str, body: SectionContent,
) -> EventDetail:  # fmt: skip
    await service.update_content(session, event_id, section_id, body.value, now=clock.now())
    return await event_detail(session, await service.get_event(session, event_id), clock)


@router.post("/{event_id}/media", response_model=MediaOut, status_code=status.HTTP_201_CREATED)
async def upload_media(
    session: SessionDep, clock: ClockDep, user: SeesEvents, event_id: uuid.UUID, request: Request,
    file: Annotated[UploadFile, File()], kind: Annotated[str, Query()] = "photo",
) -> MediaOut:  # fmt: skip
    """A photo, video or song for the invitation. Put the returned reference in the section's
    content; guests see it from the published copy."""
    ref = await service.upload_media(
        session, event_id, file, kind, by=user.full_name, now=clock.now(), actor=user,
        request=request,
    )
    return MediaOut(**ref)


@router.put("/{event_id}/invite/accent", response_model=EventDetail)
async def set_accent(
    session: SessionDep, clock: ClockDep, user: SeesEvents, event_id: uuid.UUID, body: AccentIn
) -> EventDetail:
    await service.set_accent(session, event_id, body.accent, now=clock.now())
    return await event_detail(session, await service.get_event(session, event_id), clock)


# ---------------------------------------------------------------------------
# Review and publish
# ---------------------------------------------------------------------------


@router.post("/{event_id}/submit", response_model=EventDetail)
async def submit_for_review(
    session: SessionDep, clock: ClockDep, user: SeesEvents, event_id: uuid.UUID, request: Request
) -> EventDetail:
    await service.submit_for_review(
        session, event_id, by=user.full_name, now=clock.now(), actor=user, request=request
    )
    return await event_detail(session, await service.get_event(session, event_id), clock)


@router.post("/{event_id}/return", response_model=EventDetail)
async def return_to_client(
    session: SessionDep, clock: ClockDep, user: PublishesInvitation, event_id: uuid.UUID,
    body: ReturnIn, request: Request,
) -> EventDetail:  # fmt: skip
    await service.return_to_client(
        session, event_id, body.note, actor=user, now=clock.now(), request=request
    )
    return await event_detail(session, await service.get_event(session, event_id), clock)


@router.post("/{event_id}/publish", response_model=EventDetail)
async def publish(
    session: SessionDep, clock: ClockDep, user: PublishesInvitation, event_id: uuid.UUID,
    body: PublishIn, request: Request,
) -> EventDetail:  # fmt: skip
    """Guests get the draft as it is now; its date, time and venue move onto the event."""
    event = await service.publish(
        session, event_id, actor=user, now=clock.now(), clamp_deadline=body.clamp_deadline,
        request=request,
    )  # fmt: skip
    return await event_detail(session, event, clock)


@router.post("/{event_id}/unpublish", response_model=EventDetail)
async def unpublish(
    session: SessionDep, clock: ClockDep, user: PublishesInvitation, event_id: uuid.UUID,
    request: Request,
) -> EventDetail:  # fmt: skip
    event = await service.unpublish(session, event_id, actor=user, now=clock.now(), request=request)
    return await event_detail(session, event, clock)


@router.get("/{event_id}/client-link", response_model=ClientLinkOut)
async def get_client_link(
    session: SessionDep, clock: ClockDep, user: PublishesInvitation, event_id: uuid.UUID
) -> ClientLinkOut:
    """The client's edit link, to copy again. Every copy dies when the link is regenerated."""
    event = await service.get_event(session, event_id)
    token, expires = service.client_link(event, now=clock.now())
    return ClientLinkOut(token=token, version=event.edit_link_version, expires_at=expires)


@router.post("/{event_id}/client-link/regenerate", response_model=ClientLinkOut)
async def regenerate_client_link(
    session: SessionDep, clock: ClockDep, user: PublishesInvitation, event_id: uuid.UUID,
    request: Request,
) -> ClientLinkOut:  # fmt: skip
    """A leaked link stops working at once; the client needs the new one."""
    event, token, expires = await service.regenerate_client_link(
        session, event_id, actor=user, now=clock.now(), request=request
    )
    return ClientLinkOut(token=token, version=event.edit_link_version, expires_at=expires)


# ---------------------------------------------------------------------------
# Template Studio
# ---------------------------------------------------------------------------


def template_out(t: InvitationTemplate, usage: dict[str, studio.Usage]) -> TemplateOut:
    u = usage.get(t.id)
    out = TemplateOut.model_validate(t)
    if u is not None:
        out.used_by_events, out.live_events = u.events, u.live
    return out


@templates_router.get("", response_model=list[TemplateOut])
async def list_templates(session: SessionDep, user: SeesEvents) -> list[TemplateOut]:
    """Every template, every status — the gallery shows built-ins and published ones; the
    studio shows the rest. Each carries how many events use it, and how many live."""
    usage = await studio.usage(session)
    return [template_out(t, usage) for t in await studio.list_templates(session)]


@templates_router.get("/{template_id}", response_model=TemplateOut)
async def get_template(session: SessionDep, user: SeesEvents, template_id: str) -> TemplateOut:
    return template_out(await studio.get(session, template_id), await studio.usage(session))


@templates_router.post("", response_model=TemplateOut, status_code=status.HTTP_201_CREATED)
async def create_template(
    session: SessionDep, clock: ClockDep, user: ManagesTemplates, body: TemplateCreate,
    request: Request,
) -> TemplateOut:  # fmt: skip
    """A new draft — blank in a family, or a copy of ``from_id``."""
    t = await studio.create(
        session, actor=user, now=clock.now(), from_id=body.from_id, family=body.family,
        request=request,
    )  # fmt: skip
    return template_out(t, {})


@templates_router.patch("/{template_id}", response_model=TemplateOut)
async def update_template(
    session: SessionDep, clock: ClockDep, user: ManagesTemplates, template_id: str,
    body: TemplateUpdate, request: Request,
) -> TemplateOut:  # fmt: skip
    """A refused save says why, in the studio's own words (422)."""
    t = await studio.update(
        session, template_id, body.model_dump(exclude_unset=True), actor=user,
        now=clock.now(), request=request,
    )  # fmt: skip
    return template_out(t, await studio.usage(session))


@templates_router.post(
    "/{template_id}/art-upload", response_model=MediaOut, status_code=status.HTTP_201_CREATED
)
async def upload_template_art(
    session: SessionDep, clock: ClockDep, user: ManagesTemplates, template_id: str,
    request: Request, file: Annotated[UploadFile, File()],
) -> MediaOut:  # fmt: skip
    """An artwork file for a studio template; set it on a slot with ``PUT .../art/{slot}``."""
    ref = await studio.upload_art(
        session, template_id, file, actor=user, now=clock.now(), request=request
    )
    return MediaOut(**ref)


@templates_router.put("/{template_id}/art/{slot}", response_model=TemplateOut)
async def set_template_art(
    session: SessionDep, clock: ClockDep, user: ManagesTemplates, template_id: str, slot: str,
    body: ArtIn, request: Request,
) -> TemplateOut:  # fmt: skip
    ref = body.ref.model_dump() if body.ref is not None else None
    t = await studio.set_art(
        session, template_id, slot, ref, actor=user, now=clock.now(), request=request
    )
    return template_out(t, await studio.usage(session))


async def _status(
    session: AsyncSession, clock: ClockDep, user: Any, template_id: str, to: str, request: Request
) -> TemplateOut:
    t = await studio.set_status(
        session, template_id, to, actor=user, now=clock.now(), request=request
    )
    return template_out(t, await studio.usage(session))


@templates_router.post("/{template_id}/publish", response_model=TemplateOut)
async def publish_template(
    session: SessionDep, clock: ClockDep, user: ManagesTemplates, template_id: str,
    request: Request,
) -> TemplateOut:  # fmt: skip
    """Into the gallery. Only a template that validates; never straight from archived."""
    return await _status(session, clock, user, template_id, "published", request)


@templates_router.post("/{template_id}/unpublish", response_model=TemplateOut)
async def unpublish_template(
    session: SessionDep, clock: ClockDep, user: ManagesTemplates, template_id: str,
    request: Request,
) -> TemplateOut:  # fmt: skip
    """Out of the gallery, back to draft — and Restore, for an archived template."""
    return await _status(session, clock, user, template_id, "draft", request)


@templates_router.post("/{template_id}/archive", response_model=TemplateOut)
async def archive_template(
    session: SessionDep, clock: ClockDep, user: ManagesTemplates, template_id: str,
    request: Request,
) -> TemplateOut:  # fmt: skip
    """Leaves the gallery; invitations already on it keep rendering."""
    return await _status(session, clock, user, template_id, "archived", request)


# ---------------------------------------------------------------------------
# Guests
# ---------------------------------------------------------------------------


def guest_out(g: Guest) -> GuestOut:
    fields = {f: getattr(g, f) for f in GuestOut.model_fields if f not in ("link_token", "qr")}
    return GuestOut.model_validate(
        {
            **fields,
            "category": g.category.value,
            "rsvp": g.rsvp.value if g.rsvp else None,
            "invited_via": g.invited_via.value if g.invited_via else None,
            "link_token": guests.guest_link_token(g),
            "qr": guests.guest_qr(g),
        }
    )


@router.get("/{event_id}/guests", response_model=list[GuestOut])
async def list_guests(session: SessionDep, user: SeesEvents, event_id: uuid.UUID) -> list[GuestOut]:
    await service.get_event(session, event_id)
    return [guest_out(g) for g in await guests.list_guests(session, event_id)]


@router.post("/{event_id}/guests", response_model=AddResultOut)
async def add_guests(
    session: SessionDep, clock: ClockDep, user: SeesEvents, event_id: uuid.UUID,
    body: GuestsIn, request: Request,
) -> AddResultOut:  # fmt: skip
    """Adds guests to the client's list, skipping phones already on it or under 8 digits."""
    rows = [guests.GuestRow(g.name, g.phone, g.email, g.table, g.category) for g in body.guests]
    result = await guests.add_guests(
        session, event_id, rows, actor=user, now=clock.now(), request=request
    )
    return AddResultOut(added=result.added, skipped=result.skipped)


@router.post("/{event_id}/guests/import", response_model=AddResultOut)
async def import_guests(
    session: SessionDep, clock: ClockDep, user: SeesEvents, event_id: uuid.UUID,
    body: CsvIn, request: Request,
) -> AddResultOut:  # fmt: skip
    """The client's CSV: columns by header in any order (name, phone, email, table,
    category), or that order without one; commas or semicolons. Importing the same file
    twice adds nobody."""
    result = await guests.import_csv(
        session, event_id, body.csv, actor=user, now=clock.now(), request=request
    )
    return AddResultOut(added=result.added, skipped=result.skipped)


@router.put("/{event_id}/guests/{guest_id}/table", response_model=GuestOut)
async def set_guest_table(
    session: SessionDep, user: SeesEvents, event_id: uuid.UUID, guest_id: uuid.UUID,
    body: TableIn, request: Request,
) -> GuestOut:  # fmt: skip
    return guest_out(
        await guests.set_table(session, event_id, guest_id, body.table, actor=user, request=request)
    )


@router.put("/{event_id}/guests/{guest_id}/category", response_model=GuestOut)
async def set_guest_category(
    session: SessionDep, user: SeesEvents, event_id: uuid.UUID, guest_id: uuid.UUID,
    body: CategoryIn, request: Request,
) -> GuestOut:  # fmt: skip
    return guest_out(
        await guests.set_category(
            session, event_id, guest_id, body.category, actor=user, request=request
        )
    )


@router.put("/{event_id}/guests/{guest_id}/note", response_model=GuestOut)
async def set_guest_note(
    session: SessionDep, clock: ClockDep, user: SeesEvents, event_id: uuid.UUID,
    guest_id: uuid.UUID, body: NoteIn, request: Request,
) -> GuestOut:  # fmt: skip
    """Staff-only (R5); never shown to the guest or the client."""
    return guest_out(
        await guests.set_note(
            session, event_id, guest_id, body.note, actor=user, now=clock.now(), request=request
        )
    )


@router.post("/{event_id}/guests/{guest_id}/regenerate-link", response_model=GuestOut)
async def regenerate_guest_link(
    session: SessionDep, user: PublishesInvitation, event_id: uuid.UUID, guest_id: uuid.UUID,
    request: Request,
) -> GuestOut:  # fmt: skip
    """Revoke this guest's personal link and QR and issue new ones (publishers only)."""
    return guest_out(
        await guests.regenerate_link(session, event_id, guest_id, actor=user, request=request)
    )


@router.post("/{event_id}/guests/{guest_id}/erase", response_model=GuestOut)
async def erase_guest(
    session: SessionDep, clock: ClockDep, user: PublishesInvitation, event_id: uuid.UUID,
    guest_id: uuid.UUID, request: Request,
) -> GuestOut:  # fmt: skip
    """Erase this guest's personal data on their request (cannot be undone). The row stays,
    anonymised, so the headcount, the report and the door's history do not change."""
    return guest_out(
        await guests.erase_guest(
            session, event_id, guest_id, now=clock.now(), actor=user, request=request
        )
    )


@router.put("/{event_id}/guests/{guest_id}/email", response_model=GuestOut)
async def set_guest_email(
    session: SessionDep, user: SeesEvents, event_id: uuid.UUID, guest_id: uuid.UUID,
    body: EmailIn, request: Request,
) -> GuestOut:  # fmt: skip
    return guest_out(
        await guests.set_email(session, event_id, guest_id, body.email, actor=user, request=request)
    )


# ---------------------------------------------------------------------------
# Questions, tables, checkpoints
# ---------------------------------------------------------------------------


@router.post("/{event_id}/questions", response_model=QuestionOut, status_code=201)
async def add_question(
    session: SessionDep, clock: ClockDep, user: SeesEvents, event_id: uuid.UUID,
    body: QuestionCreate,
) -> QuestionOut:  # fmt: skip
    """At most ten per event. Keys are never reused."""
    q = await guests.add_question(session, event_id, body.type, now=clock.now())
    return QuestionOut.model_validate(q)


@router.patch("/{event_id}/questions/{key}", response_model=QuestionOut)
async def update_question(
    session: SessionDep, clock: ClockDep, user: SeesEvents, event_id: uuid.UUID, key: str,
    body: QuestionUpdate,
) -> QuestionOut:  # fmt: skip
    q = await guests.update_question(
        session, event_id, key, body.model_dump(exclude_unset=True), now=clock.now()
    )
    return QuestionOut.model_validate(q)


@router.post("/{event_id}/questions/{key}/move", response_model=list[QuestionOut])
async def move_question(
    session: SessionDep, clock: ClockDep, user: SeesEvents, event_id: uuid.UUID, key: str,
    body: MoveIn,
) -> list[QuestionOut]:  # fmt: skip
    qs = await guests.move_question(session, event_id, key, body.direction, now=clock.now())
    return [QuestionOut.model_validate(q) for q in qs]


@router.delete("/{event_id}/questions/{key}", status_code=204)
async def remove_question(
    session: SessionDep, clock: ClockDep, user: SeesEvents, event_id: uuid.UUID, key: str,
    request: Request,
) -> None:  # fmt: skip
    """Guests' earlier answers stay in their records, unseen."""
    await guests.remove_question(
        session, event_id, key, actor=user, now=clock.now(), request=request
    )


@router.post("/{event_id}/tables", response_model=list[str], status_code=201)
async def add_table(
    session: SessionDep, clock: ClockDep, user: SeesEvents, event_id: uuid.UUID, body: NameIn
) -> list[str]:
    """A suggestion for the table field; a guest's table is free text either way."""
    return await guests.add_table(session, event_id, body.name, now=clock.now())


@router.post("/{event_id}/checkpoints", response_model=CheckpointOut, status_code=201)
async def add_checkpoint(
    session: SessionDep, clock: ClockDep, user: SeesEvents, event_id: uuid.UUID, body: NameIn
) -> CheckpointOut:
    """Names are unique per event, ignoring case."""
    cp = await guests.add_checkpoint(session, event_id, body.name, now=clock.now())
    return CheckpointOut.model_validate(cp)


@router.patch("/{event_id}/checkpoints/{checkpoint_id}", response_model=CheckpointOut)
async def update_checkpoint(
    session: SessionDep, clock: ClockDep, user: SeesEvents, event_id: uuid.UUID,
    checkpoint_id: uuid.UUID, body: CheckpointUpdate,
) -> CheckpointOut:  # fmt: skip
    """Rename, or set who it admits. Unknown categories are dropped; none means everyone."""
    cp = await guests.update_checkpoint(
        session, event_id, checkpoint_id, body.model_dump(exclude_unset=True), now=clock.now()
    )
    return CheckpointOut.model_validate(cp)


@router.delete("/{event_id}/checkpoints/{checkpoint_id}", status_code=204)
async def remove_checkpoint(
    session: SessionDep, clock: ClockDep, user: SeesEvents, event_id: uuid.UUID,
    checkpoint_id: uuid.UUID, request: Request,
) -> None:  # fmt: skip
    """Refused for the last checkpoint, and for one with scans logged against it."""
    await guests.remove_checkpoint(
        session, event_id, checkpoint_id, actor=user, now=clock.now(), request=request
    )


# ---------------------------------------------------------------------------
# Check-in and walk-ins
# ---------------------------------------------------------------------------


def scan_out(result: attendance.ScanResult) -> ScanOut:
    return ScanOut(
        scan_id=result.scan.id,
        at=result.scan.at,
        checkpoint_id=result.checkpoint.id,
        checkpoint_name=result.checkpoint.name,
        first_arrival=result.first_arrival,
        repeat_here=result.repeat_here,
        admitted=result.admitted,
        guest=guest_out(result.guest),
    )


@router.post("/{event_id}/scans", response_model=ScanOut, status_code=201)
async def scan(
    session: SessionDep, clock: ClockDep, user: SeesEvents, event_id: uuid.UUID, body: ScanIn
) -> ScanOut:
    """One scan at one checkpoint, from the list or from a signed access-card code. Every
    scan is logged; ``repeat_here`` and ``admitted`` are for the desk to judge."""
    if (body.guest_id is None) == (body.qr is None):
        raise Invalid("Send either a guest or a scanned code.")
    if body.qr is not None:
        result = await attendance.scan_qr(
            session, event_id, body.qr, body.checkpoint_id, actor=user, now=clock.now()
        )
    else:
        assert body.guest_id is not None
        result = await attendance.scan_guest(
            session, event_id, body.guest_id, body.checkpoint_id, actor=user, now=clock.now()
        )
    return scan_out(result)


@router.get("/{event_id}/scans", response_model=list[ScanLogOut])
async def scan_log(session: SessionDep, user: SeesEvents, event_id: uuid.UUID) -> list[ScanLogOut]:
    """Every scan, oldest first."""
    await service.get_event(session, event_id)
    rows = (
        await session.execute(
            select(EventScan)
            .where(EventScan.event_id == event_id)
            .order_by(EventScan.at, EventScan.id)
        )
    ).scalars()
    return [ScanLogOut.model_validate(s) for s in rows]


@router.post("/{event_id}/guests/{guest_id}/check-in", response_model=ScanOut, status_code=201)
async def check_in(
    session: SessionDep, clock: ClockDep, user: SeesEvents, event_id: uuid.UUID,
    guest_id: uuid.UUID,
) -> ScanOut:  # fmt: skip
    """Arrival at the entrance. 409 if they have already arrived."""
    return scan_out(
        await attendance.check_in(session, event_id, guest_id, actor=user, now=clock.now())
    )


@router.post("/{event_id}/guests/{guest_id}/check-in/undo", response_model=GuestOut)
async def undo_check_in(
    session: SessionDep, user: SeesEvents, event_id: uuid.UUID, guest_id: uuid.UUID,
    request: Request,
) -> GuestOut:  # fmt: skip
    """Removes the latest scan; with none left the guest has not arrived. A walk-in's only
    scan is their record and stays."""
    return guest_out(
        await attendance.undo_check_in(session, event_id, guest_id, actor=user, request=request)
    )


@router.get("/{event_id}/walkin-link", response_model=ClientLinkOut)
async def get_walkin_link(
    session: SessionDep, clock: ClockDep, user: PublishesInvitation, event_id: uuid.UUID
) -> ClientLinkOut:
    """The signed link for the walk-in QR at the registration desk. It expires the day after
    the event, and the public desk form refuses anyone without it."""
    event = await service.get_event(session, event_id)
    token, expires = service.walkin_link(event, now=clock.now())
    return ClientLinkOut(token=token, version=1, expires_at=expires)


@router.post("/{event_id}/walk-ins", response_model=WalkInOut, status_code=201)
async def register_walk_in(
    session: SessionDep, clock: ClockDep, user: SeesEvents, event_id: uuid.UUID, body: WalkInIn,
    request: Request,
) -> WalkInOut:  # fmt: skip
    """Someone on the list is checked in; anyone else is added as a walk-in."""
    guest, walk_in = await attendance.register_walk_in(
        session, event_id,
        attendance.WalkInForm(body.name, body.phone, body.email, body.consent),
        now=clock.now(), actor=user,
    )  # fmt: skip
    await record_audit(
        session, actor=user, action="walkin.register", entity_type="event", entity_id=event_id,
        after={"walk_in": walk_in}, detail={"guest_id": str(guest.id), "by": "staff"},
        request=request,
    )
    return WalkInOut(walk_in=walk_in, guest=guest_out(guest))


# ---------------------------------------------------------------------------
# Wishes
# ---------------------------------------------------------------------------


def wish_out(w: EventWish, hold: bool) -> WishOut:
    return WishOut(
        id=w.id, guest_id=w.guest_id, name=w.name, text=w.text, at=w.at, hidden=w.hidden,
        approved=w.approved,
        state=rules.wish_state(hidden=w.hidden, approved=w.approved, hold=hold),
    )  # fmt: skip


@router.get("/{event_id}/wishes", response_model=list[WishOut])
async def list_wishes(session: SessionDep, user: SeesEvents, event_id: uuid.UUID) -> list[WishOut]:
    """Every wish, with its moderation state: shown, waiting (held for approval) or hidden."""
    event = await service.get_event(session, event_id)
    return [wish_out(w, event.hold_wishes) for w in await attendance.list_wishes(session, event_id)]


@router.put("/{event_id}/wishes/{wish_id}/hidden", response_model=WishOut)
async def set_wish_hidden(
    session: SessionDep, user: SeesEvents, event_id: uuid.UUID, wish_id: int, body: HiddenIn,
    request: Request,
) -> WishOut:  # fmt: skip
    """Hidden wishes stay on record."""
    w = await attendance.set_wish_hidden(
        session, event_id, wish_id, body.hidden, actor=user, request=request
    )
    return wish_out(w, (await service.get_event(session, event_id)).hold_wishes)


@router.post("/{event_id}/wishes/{wish_id}/approve", response_model=WishOut)
async def approve_wish(
    session: SessionDep, user: SeesEvents, event_id: uuid.UUID, wish_id: int, request: Request
) -> WishOut:
    """Lets a waiting wish show, and brings back a hidden one."""
    w = await attendance.approve_wish(session, event_id, wish_id, actor=user, request=request)
    return wish_out(w, (await service.get_event(session, event_id)).hold_wishes)


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------


@router.get("/{event_id}/report", response_model=ReportOut)
async def attendance_report(
    session: SessionDep, user: SeesEvents, event_id: uuid.UUID
) -> ReportOut:
    """Headline numbers, the RSVP × attendance grid, catering counts, scans per checkpoint."""
    return ReportOut.model_validate(await attendance.report(session, event_id))
