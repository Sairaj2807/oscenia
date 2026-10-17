"""Events and their invitations: create and edit, the draft editor, review and publish.

Ported from ``useProto.js`` (``createEvent`` … ``regenerateEditToken``). Every mutation
loads its event ``FOR UPDATE``, so two staff — or staff and the client's link — editing the
same event queue rather than overwrite each other's half of a change.

Where the prototype returns ``false`` and does nothing, this layer raises: ``Invalid``
(422) for input that can never be right, ``Conflict`` (409) for a request the event's
current state refuses, ``NotFound`` (404) for an id that does not exist.
"""

from __future__ import annotations

import copy
import re
import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import Request, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import links
from app.core.config import get_settings
from app.core.errors import Conflict, Invalid, NotFound
from app.domain.ar.models import Client, Project
from app.domain.audit.service import record_audit, snapshot
from app.domain.events import media, rules
from app.domain.events.models import (
    Event,
    EventCheckpoint,
    EventInvite,
    EventReview,
    EventStatus,
    EventTable,
    InvitationTemplate,
    ReviewState,
)
from app.domain.events.templates import MUSIC, REQUIRED_SECTIONS, SECTIONS, in_gallery
from app.domain.ledger.numbering import next_document_no
from app.domain.masters.models import User

CLIENT_LINK_PURPOSE = "client-edit"
DEFAULT_TABLES = ("T1", "T2", "T3", "T4", "T5")
_TIME = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")

#: Not patchable on the event: see ``update_event``.
SEALED = frozenset({"date", "time", "venue", "status"})

#: The event fields an audit row records on an edit.
AUDITED_FIELDS = (
    "name", "client_id", "project_id", "date", "time", "venue", "status", "rsvp_deadline",
    "max_pax", "rsvp_fields", "feedback_url", "hold_wishes",
)  # fmt: skip


def clean_time(value: Any) -> str | None:
    """``HH:MM`` or '' (no time yet); ``None`` for anything else."""
    text = str(value or "").strip()
    return text if text == "" or _TIME.match(text) else None


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------


async def get_event_by_no(session: AsyncSession, event_no: str) -> Event | None:
    """The event with this number (``EV-01``), or ``None``. For the public pages, whose links
    carry the number people see rather than a UUID."""
    return (
        await session.execute(select(Event).where(Event.event_no == event_no))
    ).scalar_one_or_none()


async def get_event(session: AsyncSession, event_id: uuid.UUID, *, lock: bool = False) -> Event:
    stmt = select(Event).where(Event.id == event_id)
    if lock:
        stmt = stmt.with_for_update()
    event = (await session.execute(stmt)).scalar_one_or_none()
    if event is None:
        raise NotFound("No such event.")
    return event


async def get_invite(session: AsyncSession, event_id: uuid.UUID) -> EventInvite:
    return (
        await session.execute(select(EventInvite).where(EventInvite.event_id == event_id))
    ).scalar_one()


async def get_template(session: AsyncSession, template_id: str) -> InvitationTemplate | None:
    return await session.get(InvitationTemplate, template_id)


async def latest_review(session: AsyncSession, event_id: uuid.UUID) -> EventReview | None:
    return (
        await session.execute(
            select(EventReview)
            .where(EventReview.event_id == event_id)
            .order_by(EventReview.id.desc())
            .limit(1)
        )
    ).scalar_one_or_none()


def draft_of(invite: EventInvite) -> dict[str, Any]:
    """The draft in the shape ``published`` snapshots, so the two compare directly."""
    return {
        "template_id": invite.template_id,
        "accent": invite.accent,
        "on": dict(invite.toggles),
        "content": invite.content,
    }


def has_unpublished_changes(invite: EventInvite) -> bool:
    return invite.published is not None and invite.published != draft_of(invite)


@dataclass(frozen=True, slots=True)
class ReviewView:
    state: str  # editing | submitted | returned
    submitted_at: datetime | None = None
    submitted_by: str | None = None
    note: str = ""
    returned_at: datetime | None = None


def review_view(row: EventReview | None) -> ReviewView:
    if row is None or row.state == ReviewState.CLOSED:
        return ReviewView(state="editing")
    return ReviewView(
        state=row.state.value,
        submitted_at=row.submitted_at,
        submitted_by=row.submitted_by,
        note=row.note,
        returned_at=row.returned_at,
    )


# ---------------------------------------------------------------------------
# Events
# ---------------------------------------------------------------------------


async def _check_links(
    session: AsyncSession, client_id: uuid.UUID | None, project_id: uuid.UUID | None
) -> uuid.UUID | None:
    """Both optional. A project names its client, so a client left blank is taken from it,
    and a client that disagrees with the project is refused. Returns the client id."""
    if client_id is not None and await session.get(Client, client_id) is None:
        raise Invalid("No such client.")
    if project_id is None:
        return client_id
    project = await session.get(Project, project_id)
    if project is None:
        raise Invalid("No such project.")
    if client_id is not None and project.client_id != client_id:
        raise Invalid(f"{project.project_no} belongs to another client.")
    return project.client_id


async def create_event(
    session: AsyncSession,
    *,
    actor: User,
    now: datetime,
    today: date,
    name: str,
    event_date: date,
    time: str = "19:00",
    venue: str = "",
    client_id: uuid.UUID | None = None,
    project_id: uuid.UUID | None = None,
    request: Request | None = None,
) -> Event:
    """A draft event with a starter invitation and no template yet — staff or the client
    start in the gallery (Invitations v2)."""
    name = name.strip()
    if not name:
        raise Invalid("Give the event a name.")
    clean = clean_time(time)
    if clean is None:
        raise Invalid("The time must look like 19:00.")
    venue = venue.strip()[:300]
    client_id = await _check_links(session, client_id, project_id)

    event = Event(
        event_no=await next_document_no(session, "event"),
        name=name[:160],
        client_id=client_id,
        project_id=project_id,
        date=event_date,
        time=clean,
        venue=venue,
        status=EventStatus.DRAFT,
        rsvp_deadline=rules.default_rsvp_deadline(event_date, today),
        max_pax=2,
        rsvp_fields={"email": True, "allergies": True, "pax": True},
        feedback_url="",
        hold_wishes=False,
        question_seq=0,
        checkpoint_seq=1,
        edit_link_version=1,
        created_at=now,
        updated_at=now,
        created_by=actor.id,
    )
    session.add(event)
    await session.flush()

    session.add(
        EventInvite(
            event_id=event.id,
            template_id=None,
            accent=None,
            toggles={},
            content=rules.blank_content(
                name=event.name, date_=event_date.isoformat(), time=clean, venue=venue
            ),
        )
    )
    session.add(
        EventCheckpoint(
            event_id=event.id, key="CP-1", position=1, name="Main Entrance", categories=[]
        )
    )
    for i, table in enumerate(DEFAULT_TABLES, start=1):
        session.add(EventTable(event_id=event.id, name=table, position=i))
    await session.flush()

    await record_audit(
        session, actor=actor, action="event.create", entity_type="event", entity_id=event.id,
        after=snapshot(event, AUDITED_FIELDS), detail={"event_no": event.event_no},
        request=request,
    )  # fmt: skip
    return event


async def update_event(
    session: AsyncSession,
    event_id: uuid.UUID,
    patch: dict[str, Any],
    *,
    actor: User,
    now: datetime,
    request: Request | None = None,
) -> Event:
    """Event details and RSVP settings. The date, time and venue follow the invitation's
    details (D8) and publishing is its own step, so those fields are refused here."""
    sealed = SEALED & patch.keys()
    if sealed:
        raise Invalid(
            f"{', '.join(sorted(sealed))} cannot be changed here. The date, time and venue "
            "come from the invitation's details, and publishing has its own step."
        )
    event = await get_event(session, event_id, lock=True)
    before = snapshot(event, AUDITED_FIELDS)

    if "name" in patch:
        name = str(patch["name"] or "").strip()
        if not name:
            raise Invalid("Give the event a name.")
        event.name = name[:160]
    if patch.get("rsvp_deadline") is not None:
        event.rsvp_deadline = patch["rsvp_deadline"]
    if patch.get("max_pax") is not None:
        event.max_pax = min(rules.MAX_PAX_LIMIT, max(1, int(patch["max_pax"])))
    if patch.get("rsvp_fields") is not None:
        current = dict(event.rsvp_fields)
        for key in ("email", "allergies", "pax"):
            # An explicit null leaves that field as it is.
            if patch["rsvp_fields"].get(key) is not None:
                current[key] = bool(patch["rsvp_fields"][key])
        event.rsvp_fields = current
    if "feedback_url" in patch:
        url = str(patch["feedback_url"] or "").strip()
        if url and not rules.safe_link(url):
            raise Invalid("The feedback link must start with http:// or https://.")
        event.feedback_url = url[:500]
    if patch.get("hold_wishes") is not None:
        event.hold_wishes = bool(patch["hold_wishes"])
    if "client_id" in patch or "project_id" in patch:
        project_id = patch.get("project_id", event.project_id)
        client_id = patch.get("client_id", event.client_id)
        if "project_id" in patch and "client_id" not in patch and project_id is not None:
            client_id = None  # take the new project's client
        event.client_id = await _check_links(session, client_id, project_id)
        event.project_id = project_id

    event.updated_at = now
    await session.flush()
    await record_audit(
        session, actor=actor, action="event.update", entity_type="event", entity_id=event.id,
        before=before, after=snapshot(event, AUDITED_FIELDS), request=request,
    )  # fmt: skip
    return event


async def list_events(session: AsyncSession) -> list[Event]:
    return list(
        (await session.execute(select(Event).order_by(Event.date, Event.event_no))).scalars().all()
    )


# ---------------------------------------------------------------------------
# The invitation draft (Invitations v2) — staff and the client's link both edit it
# ---------------------------------------------------------------------------


async def choose_template(
    session: AsyncSession, event_id: uuid.UUID, template_id: str, *, now: datetime
) -> EventInvite:
    """Picks or changes the template; content and the user's own toggles are kept. A studio
    template must be in the gallery to be newly picked — an invitation already on one that
    was since withdrawn or archived keeps it."""
    event = await get_event(session, event_id, lock=True)
    invite = await get_invite(session, event.id)
    template = await get_template(session, template_id)
    if template is None:
        raise Invalid("Unknown template.")
    if not in_gallery(template.as_dict()) and invite.template_id != template_id:
        raise Conflict("That template is not in the gallery.")
    invite.template_id = template_id
    event.updated_at = now
    await session.flush()
    return invite


async def set_section(
    session: AsyncSession, event_id: uuid.UUID, section_id: str, on: bool, *, now: datetime
) -> EventInvite:
    """Switches a section (or the background music) on or off. Required sections stay on."""
    if section_id != MUSIC and (section_id not in SECTIONS or section_id in REQUIRED_SECTIONS):
        raise Invalid("That section cannot be switched on or off.")
    event = await get_event(session, event_id, lock=True)
    invite = await get_invite(session, event.id)
    invite.toggles = {**invite.toggles, section_id: bool(on)}
    event.updated_at = now
    await session.flush()
    return invite


async def update_content(
    session: AsyncSession, event_id: uuid.UUID, section_id: str, value: Any, *, now: datetime
) -> EventInvite:
    """Replaces one section's content, cleaned. Until the event is first published, the
    details' date, time and venue also go straight onto the event, so its reminders and
    check-in follow; after that they wait for Publish (D8)."""
    event = await get_event(session, event_id, lock=True)
    invite = await get_invite(session, event.id)
    if section_id not in invite.content:
        raise Invalid("Unknown section.")
    try:
        clean = rules.clean_section(value)
    except rules.ContentTooLarge as exc:
        raise Invalid(str(exc)) from exc
    if not isinstance(clean, dict):
        raise Invalid("A section's content is an object.")
    # Files only by the id of an upload this event holds, never a storage key or a browser's own.
    clean = await media.scrub(session, clean, event_id=event.id)

    if section_id == "details" and invite.published is None:
        _details_onto_event(event, clean)

    invite.content = {**invite.content, section_id: clean}
    event.updated_at = now
    await session.flush()
    return invite


def _details_onto_event(event: Event, details: dict[str, Any]) -> None:
    """Date, time and venue from the invitation onto the event — an invalid date or time is
    ignored rather than reaching the event, since every deadline keys off them."""
    parsed = rules.parse_iso_date(details.get("date"))
    if parsed is not None:
        event.date = parsed
    clean = clean_time(details.get("time"))
    if clean is not None:
        event.time = clean
    if isinstance(details.get("venue"), str):
        event.venue = details["venue"].strip()[:300]


async def upload_media(
    session: AsyncSession,
    event_id: uuid.UUID,
    file: UploadFile,
    kind: str,
    *,
    by: str,
    now: datetime,
    actor: User | None = None,
    request: Request | None = None,
) -> dict[str, Any]:
    """Store a photo, video or song for this event's invitation and return the reference to put
    in its content. The event row is not locked: an upload can take minutes."""
    event = await get_event(session, event_id)
    row = await media.upload(
        session, file, kind=media.kind_for(kind), by=by, now=now, event_id=event.id
    )
    await record_audit(
        session, actor=actor, actor_label=None if actor else by,
        action="invitation.media", entity_type="event", entity_id=event.id,
        detail={"file": row.name, "kind": row.kind, "bytes": row.size_bytes}, request=request,
    )  # fmt: skip
    return media.ref_of(row)


async def set_accent(
    session: AsyncSession, event_id: uuid.UUID, accent: str | None, *, now: datetime
) -> EventInvite:
    """The client's own accent colour over the template's, or null for the template's."""
    if accent is not None and not re.fullmatch(r"#[0-9a-fA-F]{6}", accent):
        raise Invalid("The accent must be a hex colour like #c6a15b.")
    event = await get_event(session, event_id, lock=True)
    invite = await get_invite(session, event.id)
    invite.accent = accent
    event.updated_at = now
    await session.flush()
    return invite


# ---------------------------------------------------------------------------
# Review and publish (D7)
# ---------------------------------------------------------------------------


async def submit_for_review(
    session: AsyncSession,
    event_id: uuid.UUID,
    *,
    by: str,
    now: datetime,
    actor: User | None = None,
    request: Request | None = None,
) -> EventReview:
    """The client (or staff) hands the draft to Oscenia. ``by`` is ``client`` for the edit
    link, otherwise the staff member's name. Submitting again while already submitted
    restamps the same review rather than opening a second."""
    event = await get_event(session, event_id, lock=True)
    invite = await get_invite(session, event.id)
    if invite.template_id is None:
        raise Conflict("Choose a template before submitting the invitation.")
    current = await latest_review(session, event.id)
    if current is not None and current.state == ReviewState.SUBMITTED:
        current.submitted_at, current.submitted_by = now, by[:120]
        review = current
    else:
        review = EventReview(
            event_id=event.id, state=ReviewState.SUBMITTED, submitted_at=now,
            submitted_by=by[:120], note="",
        )  # fmt: skip
        session.add(review)
    await session.flush()
    await record_audit(
        session, actor=actor, actor_label=None if actor else "client link",
        action="invitation.submit", entity_type="event", entity_id=event.id,
        after={"review": "submitted"}, request=request,
    )  # fmt: skip
    return review


async def return_to_client(
    session: AsyncSession,
    event_id: uuid.UUID,
    note: str,
    *,
    actor: User,
    now: datetime,
    request: Request | None = None,
) -> EventReview:
    """Staff send a submitted draft back with a note saying what to change."""
    text = (note or "").strip()[:500]
    if not text:
        raise Invalid("Say what the client should change.")
    event = await get_event(session, event_id, lock=True)
    current = await latest_review(session, event.id)
    if current is None or current.state != ReviewState.SUBMITTED:
        raise Conflict("The invitation has not been submitted for review.")
    current.state = ReviewState.RETURNED
    current.note = text
    current.returned_at = now
    current.returned_by = actor.id
    await session.flush()
    await record_audit(
        session, actor=actor, action="invitation.return", entity_type="event",
        entity_id=event.id, after={"review": "returned"}, detail={"note": text},
        request=request,
    )  # fmt: skip
    return current


async def publish(
    session: AsyncSession,
    event_id: uuid.UUID,
    *,
    actor: User,
    now: datetime,
    clamp_deadline: bool = False,
    request: Request | None = None,
) -> Event:
    """Guests get the draft as it is now. Its date, time and venue go onto the event, so
    reminders, the RSVP deadline and check-in follow (D8). ``clamp_deadline`` pulls an RSVP
    deadline that would fall after the new date back to the date itself. Any open review
    closes."""
    event = await get_event(session, event_id, lock=True)
    invite = await get_invite(session, event.id)
    if invite.template_id is None:
        raise Conflict("Choose a template before publishing the invitation.")
    template = await get_template(session, invite.template_id)
    assert template is not None  # foreign key

    before = snapshot(event, AUDITED_FIELDS)
    _details_onto_event(event, invite.content.get("details") or {})
    if clamp_deadline and event.rsvp_deadline > event.date:
        event.rsvp_deadline = event.date
    event.status = EventStatus.PUBLISHED
    event.updated_at = now
    invite.published = copy.deepcopy(draft_of(invite))
    invite.published_template = template.as_dict()
    invite.published_at = now
    invite.published_by = actor.id

    current = await latest_review(session, event.id)
    if current is not None and current.state != ReviewState.CLOSED:
        current.state = ReviewState.CLOSED
        current.closed_at = now
    await session.flush()
    await record_audit(
        session, actor=actor, action="invitation.publish", entity_type="event",
        entity_id=event.id, before=before, after=snapshot(event, AUDITED_FIELDS),
        detail={"template_id": invite.template_id, "clamp_deadline": clamp_deadline},
        request=request,
    )  # fmt: skip
    return event


async def unpublish(
    session: AsyncSession,
    event_id: uuid.UUID,
    *,
    actor: User,
    now: datetime,
    request: Request | None = None,
) -> Event:
    """Guests can no longer open the invitation. The last published copy is kept."""
    event = await get_event(session, event_id, lock=True)
    if event.status != EventStatus.PUBLISHED:
        raise Conflict("The invitation is not published.")
    event.status = EventStatus.DRAFT
    event.updated_at = now
    await session.flush()
    await record_audit(
        session, actor=actor, action="invitation.unpublish", entity_type="event",
        entity_id=event.id, before={"status": "Published"}, after={"status": "Draft"},
        request=request,
    )  # fmt: skip
    return event


# ---------------------------------------------------------------------------
# The client edit link (D14)
# ---------------------------------------------------------------------------


def client_link(event: Event, *, now: datetime) -> tuple[str, datetime]:
    """A signed, expiring edit-link token at the event's current version, and when it
    expires. Re-minting is safe: every copy dies together when the version is bumped."""
    ttl = get_settings().client_link_days * 86400
    issued = int(now.timestamp())
    token = links.issue(
        CLIENT_LINK_PURPOSE, str(event.id), event.edit_link_version, ttl_seconds=ttl, now=issued
    )
    return token, datetime.fromtimestamp(issued + ttl, tz=UTC)


async def regenerate_client_link(
    session: AsyncSession,
    event_id: uuid.UUID,
    *,
    actor: User,
    now: datetime,
    request: Request | None = None,
) -> tuple[Event, str, datetime]:
    """A leaked client link stops working; the client needs the new one."""
    event = await get_event(session, event_id, lock=True)
    before = {"edit_link_version": event.edit_link_version}
    event.edit_link_version += 1
    event.updated_at = now
    await session.flush()
    await record_audit(
        session, actor=actor, action="invitation.client_link_regenerate", entity_type="event",
        entity_id=event.id, before=before, after={"edit_link_version": event.edit_link_version},
        request=request,
    )  # fmt: skip
    token, expires = client_link(event, now=now)
    return event, token, expires


def read_client_link(token: str, event: Event, *, now: datetime) -> bool:
    """Whether ``token`` is a live edit link for ``event`` — for Phase 2's client routes."""
    claim = links.read(CLIENT_LINK_PURPOSE, token, require_expiry=True, now=int(now.timestamp()))
    return (
        claim is not None
        and claim.subject == str(event.id)
        and claim.version == event.edit_link_version
    )


# ---------------------------------------------------------------------------
# The walk-in desk link: the QR at the registration desk
# ---------------------------------------------------------------------------

WALKIN_PURPOSE = "walkin-desk"


def walkin_link(event: Event, *, now: datetime) -> tuple[str, datetime]:
    """A signed token for the walk-in QR, valid until the end of the day after the event. It is
    what proves a caller was handed the venue's link, not just that they know an event number."""
    tz = ZoneInfo(get_settings().timezone)
    expires = datetime.combine(event.date + timedelta(days=2), time(0, 0), tzinfo=tz)
    issued = int(now.timestamp())
    ttl = max(3600, int(expires.timestamp()) - issued)
    token = links.issue(WALKIN_PURPOSE, str(event.id), 1, ttl_seconds=ttl, now=issued)
    return token, datetime.fromtimestamp(issued + ttl, tz=UTC)


def read_walkin_link(token: str, event: Event, *, now: datetime) -> bool:
    """Whether ``token`` is a live desk link for ``event``."""
    claim = links.read(WALKIN_PURPOSE, token, require_expiry=True, now=int(now.timestamp()))
    return claim is not None and claim.subject == str(event.id)


async def set_hold_wishes(
    session: AsyncSession, event_id: uuid.UUID, hold: bool, *, actor_label: str, now: datetime,
    request: Request | None = None,
) -> Event:  # fmt: skip
    """New wishes wait for approval while this is on; the ones already showing stay up."""
    event = await get_event(session, event_id, lock=True)
    before = {"hold_wishes": event.hold_wishes}
    event.hold_wishes = bool(hold)
    event.updated_at = now
    await session.flush()
    await record_audit(
        session, actor_label=actor_label, action="event.update", entity_type="event",
        entity_id=event.id, before=before, after={"hold_wishes": event.hold_wishes},
        request=request,
    )  # fmt: skip
    return event
