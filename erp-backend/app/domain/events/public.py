"""Public (no login) routes for guests, the client's edit link and the walk-in desk.

Nothing here trusts the caller. Each route is throttled and size-capped, answers unknown,
unpublished and revoked events with the same 404, takes its token in a header (not the path,
which the proxy logs), and returns a projection built for guests: never a staff row.

The rules live in ``attendance`` / ``service`` / ``rules``; these routes only authenticate the
token, limit the caller, project the result and write the audit row.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import re
import secrets
import uuid
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, File, Header, Query, Request, Response, UploadFile
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select

from app.core.clock import ClockDep
from app.core.errors import Conflict, Invalid, NotFound, PermissionDenied, TooManyAttempts
from app.core.storage import get_storage
from app.core.throttle import Throttle, purge_expired
from app.db.session import SessionDep
from app.domain.audit.service import record_audit
from app.domain.events import media, rules, service, studio
from app.domain.events.attendance import (
    RsvpForm,
    WalkInForm,
    add_wish,
    approve_wish,
    guest_by_token,
    live_template,
    register_walk_in,
    set_wish_hidden,
)
from app.domain.events.attendance import submit_rsvp as attendance_submit_rsvp
from app.domain.events.guests import (
    erase_guest,
    guest_link_token,
    guest_qr,
    list_guests,
    list_questions,
    mark_sent_by_client,
    withdraw_consent,
)
from app.domain.events.models import Event, EventInvite, EventStatus, EventWish, Guest
from app.domain.events.schemas import MediaOut
from app.domain.events.templates import BUILTIN_IDS

router = APIRouter(prefix="/public", tags=["public"])

#: What a guest sees for any event that is not open to them: the same words and status
#: whether it never existed, is a draft, or was unpublished.
NOT_AVAILABLE = "This invitation is not available."
_EVENT_NO = re.compile(r"^EV-\d{1,6}$")

# ---------------------------------------------------------------------------
# Rate limits. One policy per kind of request; the scope keeps their counters apart.
# Module-level so tests can swap in a tiny one.
# ---------------------------------------------------------------------------

read_throttle = Throttle("pub-read", limit=60, window_seconds=60, block_seconds=60)
PURGE_ONE_IN = 200


def client_ip(request: Request) -> str:
    """The caller, as the proxy reports it (uvicorn is told which proxy to believe)."""
    return request.client.host if request.client else "unknown"


async def hit(
    session: SessionDep, throttle: Throttle, request: Request, *extra: str, ip: bool = True
) -> None:
    """Count this request against the caller (and any ``extra`` keys), or refuse it.

    Committed before the refusal is raised: an exception rolls the request back, and a
    count that rolls back is a limit that never trips (see ``app/core/throttle.py``).
    """
    keys = [*([f"ip:{client_ip(request)}"] if ip else []), *extra]
    verdict = await throttle.attempt(session, keys)
    # One row per caller IP builds up. Rather than rely on a scheduler (off in some
    # environments), a small share of requests sweeps the stale ones.
    if secrets.randbelow(PURGE_ONE_IN) == 0:
        await purge_expired(session, older_than=dt.timedelta(days=1))
    await session.commit()
    if not verdict.allowed:
        raise TooManyAttempts(
            "Too many requests. Try again shortly.", retry_after=verdict.retry_after
        )


async def read_limited(request: Request, session: SessionDep) -> None:
    await hit(session, read_throttle, request)


ReadLimited = Depends(read_limited)

# ---------------------------------------------------------------------------
# Dependencies: the published event, and the guest a token names
# ---------------------------------------------------------------------------


async def published_event(event_no: str, session: SessionDep) -> tuple[Event, EventInvite]:
    """The event and the invitation guests see, or the one uniform 404."""
    event = await service.get_event_by_no(session, event_no) if _EVENT_NO.match(event_no) else None
    invite = await service.get_invite(session, event.id) if event is not None else None
    open_to_guests = (
        event is not None
        and invite is not None
        and event.status == EventStatus.PUBLISHED
        and bool(invite.published)
    )
    if not open_to_guests or event is None or invite is None:
        raise NotFound(NOT_AVAILABLE)
    return event, invite


Published = Annotated[tuple[Event, EventInvite], Depends(published_event)]


async def guest_from_token(
    session: SessionDep,
    pack: Published,
    x_guest_token: Annotated[str | None, Header(alias="X-Guest-Token")] = None,
) -> Guest | None:
    """The guest a valid personal-link token names, else ``None`` (a forged, revoked or
    malformed token is simply not a guest: no hint which)."""
    if not x_guest_token or len(x_guest_token) > 200:
        return None
    return await guest_by_token(session, pack[0].id, x_guest_token)


TokenGuest = Annotated[Guest | None, Depends(guest_from_token)]

# ---------------------------------------------------------------------------
# What a guest may see
# ---------------------------------------------------------------------------


class PublicEvent(BaseModel):
    event_no: str
    name: str
    date: dt.date
    time: str
    venue: str
    rsvp_deadline: dt.date
    rsvp_open: bool
    is_past: bool
    max_pax: int
    rsvp_fields: dict[str, bool]
    hold_wishes: bool


class PublicInvite(BaseModel):
    template_id: str | None
    accent: str | None
    on: dict[str, bool]
    content: dict[str, Any]


class PublicQuestion(BaseModel):
    key: str
    label: str
    type: str
    options: list[str]
    multi: bool
    required: bool
    attending_only: bool


class PublicWish(BaseModel):
    id: int
    name: str
    text: str
    at: dt.datetime


class PublicGuest(BaseModel):
    """The caller's own reply and link: nothing about anyone else, and no staff fields
    (table, category, note, list membership)."""

    id: uuid.UUID
    name: str
    phone: str
    email: str
    rsvp: str | None
    pax: int
    allergies: str
    answers: dict[str, Any]
    token: str
    qr: str


class PublicInviteOut(BaseModel):
    event: PublicEvent
    invite: PublicInvite
    #: A studio template, compiled, for a browser that has never seen it; ``None`` for a built-in.
    template: dict[str, Any] | None
    questions: list[PublicQuestion]
    wishes: list[PublicWish]
    guest: PublicGuest | None


#: Links are stored as typed, so each one is checked on the way out to a guest's browser.
_LINK_KEYS = frozenset({"mapUrl", "url"})


def safe_content(value: Any) -> Any:
    """The published content with every link run through ``rules.safe_link``."""
    if isinstance(value, dict):
        return {
            k: rules.safe_link(v) if k in _LINK_KEYS and isinstance(v, str) else safe_content(v)
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [safe_content(v) for v in value]
    return value


def public_guest(guest: Guest) -> PublicGuest:
    return PublicGuest(
        id=guest.id, name=guest.name, phone=guest.phone, email=guest.email,
        rsvp=guest.rsvp.value if guest.rsvp else None, pax=guest.pax, allergies=guest.allergies,
        answers=dict(guest.answers or {}), token=guest_link_token(guest), qr=guest_qr(guest),
    )  # fmt: skip


async def visible_wishes(session: SessionDep, event: Event) -> list[PublicWish]:
    rows = (
        await session.execute(
            select(EventWish).where(EventWish.event_id == event.id).order_by(EventWish.id)
        )
    ).scalars()
    return [
        PublicWish(id=w.id, name=w.name, text=w.text, at=w.at)
        for w in rows
        if rules.wish_visible(hidden=w.hidden, approved=w.approved, hold=event.hold_wishes)
    ]


def public_event(event: Event, today: dt.date) -> PublicEvent:
    return PublicEvent(
        event_no=event.event_no, name=event.name, date=event.date, time=event.time,
        venue=event.venue, rsvp_deadline=event.rsvp_deadline,
        rsvp_open=rules.rsvp_open(
            published=True, deadline=event.rsvp_deadline, event_date=event.date, today=today
        ),
        is_past=event.date < today, max_pax=event.max_pax, rsvp_fields=dict(event.rsvp_fields),
        hold_wishes=event.hold_wishes,
    )  # fmt: skip


async def invite_payload(
    session: SessionDep, event: Event, invite: EventInvite, guest: Guest | None, today: dt.date
) -> PublicInviteOut:
    live = invite.published or {}
    template = await live_template(session, invite)
    questions = [
        PublicQuestion(
            key=q.key, label=q.label, type=q.type, options=list(q.options), multi=q.multi,
            required=q.required, attending_only=q.attending_only,
        )
        # All the ready ones: the page decides, per answer, which a guest is asked (attending only).
        for q in rules.questions_for(await list_questions(session, event.id), True)
    ]  # fmt: skip
    return PublicInviteOut(
        event=public_event(event, today),
        invite=PublicInvite(
            template_id=live.get("template_id"), accent=live.get("accent"),
            on=dict(live.get("on") or {}), content=safe_content(live.get("content") or {}),
        ),
        template=template if template and template.get("id") not in BUILTIN_IDS else None,
        questions=questions,
        wishes=await visible_wishes(session, event),
        guest=public_guest(guest) if guest is not None else None,
    )  # fmt: skip


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/invites/{event_no}", response_model=PublicInviteOut, dependencies=[ReadLimited])
async def read_invite(
    response: Response, session: SessionDep, clock: ClockDep, pack: Published, guest: TokenGuest
) -> PublicInviteOut:
    """The published invitation, and (with a valid ``X-Guest-Token``) the caller's own reply.
    Never the draft, the guest list, or any staff field."""
    response.headers["Cache-Control"] = "no-store"
    event, invite = pack
    return await invite_payload(session, event, invite, guest, clock.today())


# ---------------------------------------------------------------------------
# RSVP and wishes
# ---------------------------------------------------------------------------

rsvp_throttle = Throttle("pub-rsvp", limit=10, window_seconds=60, block_seconds=300)
#: Per person (the guest's link, else the phone), so one person cannot be flooded or flood.
rsvp_who_throttle = Throttle("pub-rsvp-who", limit=5, window_seconds=60, block_seconds=300)
wish_throttle = Throttle("pub-wish", limit=10, window_seconds=60, block_seconds=300)
wish_who_throttle = Throttle("pub-wish-who", limit=5, window_seconds=60, block_seconds=300)

ALREADY_REPLIED = "This phone number has already replied. Please use your personal invitation link."


async def rsvp_limited(request: Request, session: SessionDep) -> None:
    await hit(session, rsvp_throttle, request)


async def wish_limited(request: Request, session: SessionDep) -> None:
    await hit(session, wish_throttle, request)


def who_key(guest: Guest | None, fallback: str) -> str:
    """Who is replying, for the per-person limit: the link's guest, else a hash of the phone or
    name (a hash so the table holds no list of numbers)."""
    if guest is not None:
        return f"g:{guest.id}"
    return "x:" + hashlib.sha256(fallback.strip().lower().encode()).hexdigest()[:16]


class PublicRsvpIn(BaseModel):
    name: str = Field(max_length=160)
    phone: str = Field(max_length=64)
    email: str = Field(default="", max_length=200)
    attending: bool
    pax: int = Field(default=1, ge=0, le=50)
    allergies: str = Field(default="", max_length=500)
    consent: bool = False
    answers: dict[str, Any] = Field(default_factory=dict)
    #: A field no person fills in. A bot that fills every box trips it.
    website: str = Field(default="", max_length=200)

    @field_validator("answers")
    @classmethod
    def _bounded(cls, answers: dict[str, Any]) -> dict[str, Any]:
        if len(answers) > 20:
            raise ValueError("too many answers")
        for key, value in answers.items():
            ok = len(key) <= 20 and (
                (isinstance(value, str) and len(value) <= rules.MAX_ANSWER_LENGTH)
                or (
                    isinstance(value, list)
                    and len(value) <= rules.MAX_OPTIONS
                    and all(isinstance(v, str) and len(v) <= 100 for v in value)
                )
            )
            if not ok:
                raise ValueError("an answer is too long")
        return answers


class PublicRsvpOut(BaseModel):
    #: ``None`` only when a bot tripped the trap field (nothing was stored).
    guest: PublicGuest | None


def user_agent(request: Request) -> str:
    return request.headers.get("user-agent", "")[:200]


@router.post(
    "/invites/{event_no}/rsvp", response_model=PublicRsvpOut, dependencies=[Depends(rsvp_limited)]
)
async def submit_rsvp(
    request: Request, session: SessionDep, clock: ClockDep, pack: Published, guest: TokenGuest,
    body: PublicRsvpIn,
    x_guest_token: Annotated[str | None, Header(alias="X-Guest-Token")] = None,
) -> PublicRsvpOut:  # fmt: skip
    """A guest's reply. The personal link is the identity: a phone or email may only claim a
    listed guest who has not replied yet, so nobody can overwrite or probe another guest's
    answer by typing their number. Refusals carry a ``code`` the page can act on."""
    event, _ = pack
    if body.website.strip():
        return PublicRsvpOut(guest=None)
    await hit(
        session, rsvp_who_throttle, request,
        who_key(guest, rules.norm_phone(body.phone)), ip=False,
    )  # fmt: skip

    guests = await list_guests(session, event.id)
    match = None
    if guest is None:
        match = rules.match_guest(guests, phone=body.phone.strip(), email=body.email.strip())
        if match is not None and match.rsvp is not None:
            raise Conflict(ALREADY_REPLIED, code="already_replied")

    questions = await list_questions(session, event.id)
    _, missing = rules.clean_answers(questions, body.attending, body.answers)
    if missing:
        raise Invalid(
            "Please answer the required questions.", code="missing_answers", missing=missing
        )

    form = RsvpForm(
        name=body.name, phone=body.phone, attending=body.attending, email=body.email,
        pax=body.pax, allergies=body.allergies, consent=body.consent, answers=body.answers,
        token=x_guest_token if guest is not None else None,
    )  # fmt: skip
    try:
        row = await attendance_submit_rsvp(
            session, event.id, form, now=clock.now(), today=clock.today()
        )
    except Conflict as exc:
        if "closed" in exc.detail:
            raise Conflict(exc.detail, code="closed") from exc
        raise Conflict(ALREADY_REPLIED, code="already_replied") from exc
    except Invalid as exc:
        raise Invalid(exc.detail, code="invalid") from exc

    await record_audit(
        session, action="guest.rsvp", entity_type="guest", entity_id=row.id,
        actor_label=f"guest {row.id}",
        after={"rsvp": row.rsvp.value if row.rsvp else None, "pax": row.pax},
        detail={
            "via": "link" if guest is not None else ("phone" if match is not None else "new"),
            "user_agent": user_agent(request),
        },
        request=request,
    )  # fmt: skip
    return PublicRsvpOut(guest=public_guest(row))


withdraw_throttle = Throttle("pub-withdraw", limit=5, window_seconds=60, block_seconds=300)


class WithdrawIn(BaseModel):
    #: ``marketing``: stop keeping my contact details for news and offers (my reply stays).
    #: ``all``: erase my personal data from this event (cannot be undone).
    scope: Literal["marketing", "all"]


class WithdrawOut(BaseModel):
    scope: Literal["marketing", "all"]
    done: bool = True


@router.post("/invites/{event_no}/withdraw", response_model=WithdrawOut)
async def withdraw(
    request: Request, session: SessionDep, clock: ClockDep, pack: Published, guest: TokenGuest,
    body: WithdrawIn, response: Response,
) -> WithdrawOut:  # fmt: skip
    """A guest takes back what they gave, using only their own link: stop the marketing consent,
    or erase their personal data. Without a valid link there is nothing to act on."""
    response.headers["Cache-Control"] = "no-store"
    if guest is None:
        raise NotFound("We could not find your reply on this device. Use your personal link.")
    event, _ = pack
    await hit(session, withdraw_throttle, request, f"w:{guest.id}", ip=False)
    who = f"guest {guest.id}"
    if body.scope == "all":
        await erase_guest(
            session, event.id, guest.id, now=clock.now(), actor_label=who, request=request
        )
    else:
        await withdraw_consent(
            session, event.id, guest.id, now=clock.now(), actor_label=who, request=request
        )
    return WithdrawOut(scope=body.scope)


class PublicWishIn(BaseModel):
    text: str = Field(max_length=500)
    name: str = Field(default="", max_length=80)
    website: str = Field(default="", max_length=200)


class PublicWishOut(BaseModel):
    """``waiting`` while the host holds wishes for approval."""

    state: Literal["shown", "waiting"] | None
    wish: PublicWish | None = None


_WISH_CODES = (
    ("does not take wishes", "not_enabled"),
    ("not open", "not_enabled"),
    ("already left", "duplicate"),
    ("all the wishes", "limit"),
    ("may leave", "limit"),
)


@router.post(
    "/invites/{event_no}/wishes", response_model=PublicWishOut, dependencies=[Depends(wish_limited)]
)
async def leave_wish(
    request: Request, session: SessionDep, clock: ClockDep, pack: Published, guest: TokenGuest,
    body: PublicWishIn,
    x_guest_token: Annotated[str | None, Header(alias="X-Guest-Token")] = None,
) -> PublicWishOut:  # fmt: skip
    """A wish. A valid personal link signs it with the guest's listed name; any other (or a
    bad) link is just an anonymous caller who must give a name."""
    event, _ = pack
    if body.website.strip():
        return PublicWishOut(state=None)
    await hit(
        session, wish_who_throttle, request, who_key(guest, body.name or "anon"), ip=False
    )  # fmt: skip
    try:
        wish = await add_wish(
            session, event.id, text=body.text, name=body.name,
            guest_token=x_guest_token if guest is not None else None, now=clock.now(),
        )  # fmt: skip
    except Conflict as exc:
        code = next((c for needle, c in _WISH_CODES if needle in exc.detail), "invalid")
        raise Conflict(exc.detail, code=code) from exc
    except Invalid as exc:
        raise Invalid(exc.detail, code="invalid") from exc

    await record_audit(
        session, action="guest.wish", entity_type="wish", entity_id=str(wish.id),
        actor_label=f"guest {guest.id}" if guest is not None else "anonymous",
        after={"approved": wish.approved}, detail={"user_agent": user_agent(request)},
        request=request,
    )  # fmt: skip
    return PublicWishOut(
        state="shown" if wish.approved else "waiting",
        wish=PublicWish(id=wish.id, name=wish.name, text=wish.text, at=wish.at),
    )


@router.get(
    "/invites/{event_no}/wishes", response_model=list[PublicWish], dependencies=[ReadLimited]
)
async def read_wishes(response: Response, session: SessionDep, pack: Published) -> list[PublicWish]:
    """The wishes guests may see (for refreshing the wall without reloading the page)."""
    response.headers["Cache-Control"] = "no-store"
    return await visible_wishes(session, pack[0])


# ---------------------------------------------------------------------------
# Walk-in desk
# ---------------------------------------------------------------------------

walkin_throttle = Throttle("pub-walkin", limit=10, window_seconds=60, block_seconds=300)


async def walkin_limited(request: Request, session: SessionDep) -> None:
    await hit(session, walkin_throttle, request)


async def desk_event(
    session: SessionDep,
    clock: ClockDep,
    pack: Published,
    x_walkin_token: Annotated[str | None, Header(alias="X-Walkin-Token")] = None,
) -> tuple[Event, EventInvite]:
    """The event, but only for someone holding the venue's signed desk link, and only around
    the event date. Anything else is the same 404 as an event that is not open."""
    event, _ = pack
    held = bool(x_walkin_token) and len(x_walkin_token or "") <= 200
    if (
        not held
        or not service.read_walkin_link(x_walkin_token or "", event, now=clock.now())
        or not rules.walkin_open(event_date=event.date, today=clock.today())
    ):
        raise NotFound(NOT_AVAILABLE)
    return pack


Desk = Annotated[tuple[Event, EventInvite], Depends(desk_event)]


class PublicWalkInPage(BaseModel):
    """What the desk form needs to draw itself in the invitation's colours."""

    event_no: str
    name: str
    template_id: str | None
    accent: str | None
    cover_title: str
    template: dict[str, Any] | None


class PublicWalkInIn(BaseModel):
    name: str = Field(max_length=160)
    phone: str = Field(max_length=64)
    email: str = Field(default="", max_length=200)
    consent: bool = False
    website: str = Field(default="", max_length=200)


class PublicWalkInOut(BaseModel):
    """``walk_in`` is true for someone not on the list, false for a listed guest found by phone."""

    walk_in: bool | None


@router.get(
    "/walkin/{event_no}", response_model=PublicWalkInPage, dependencies=[Depends(walkin_limited)]
)
async def walkin_page(response: Response, session: SessionDep, desk: Desk) -> PublicWalkInPage:
    response.headers["Cache-Control"] = "no-store"
    event, invite = desk
    live = invite.published or {}
    template = await live_template(session, invite)
    cover = (live.get("content") or {}).get("cover") or {}
    return PublicWalkInPage(
        event_no=event.event_no, name=event.name, template_id=live.get("template_id"),
        accent=live.get("accent"), cover_title=str(cover.get("title") or ""),
        template=template if template and template.get("id") not in BUILTIN_IDS else None,
    )  # fmt: skip


@router.post(
    "/walkin/{event_no}", response_model=PublicWalkInOut, dependencies=[Depends(walkin_limited)]
)
async def walkin_register(
    request: Request, session: SessionDep, clock: ClockDep, desk: Desk, body: PublicWalkInIn
) -> PublicWalkInOut:
    """Register at the desk. A listed guest is checked in; anyone else is added as a walk-in.
    The answer says only which, never who else is on the list."""
    event, _ = desk
    if body.website.strip():
        return PublicWalkInOut(walk_in=None)
    try:
        guest, walk_in = await register_walk_in(
            session, event.id, WalkInForm(body.name, body.phone, body.email, body.consent),
            now=clock.now(), actor=None,
        )  # fmt: skip
    except Conflict as exc:
        raise NotFound(NOT_AVAILABLE) from exc
    except Invalid as exc:
        raise Invalid(exc.detail, code="invalid") from exc
    await record_audit(
        session, action="walkin.register", entity_type="guest", entity_id=guest.id,
        actor_label="anonymous", after={"walk_in": walk_in},
        detail={"user_agent": user_agent(request)}, request=request,
    )  # fmt: skip
    return PublicWalkInOut(walk_in=walk_in)


# ---------------------------------------------------------------------------
# The client's edit link
# ---------------------------------------------------------------------------
# The client designs and submits; they cannot publish, send back, change who may edit, touch
# Template Studio, the guest list, questions, the door or the report. Those stay behind a login.

client_throttle = Throttle("pub-client", limit=120, window_seconds=60, block_seconds=120)
CLIENT_REFUSED = "This link is not valid."


async def client_event(
    request: Request,
    session: SessionDep,
    clock: ClockDep,
    event_no: str,
    x_client_key: Annotated[str | None, Header(alias="X-Client-Key")] = None,
) -> Event:
    """The event the caller's edit key opens. Unknown event, missing key, forged, expired or
    revoked key all give the same refusal, and guessing is rate limited per event and caller."""
    await hit(session, client_throttle, request, f"c:{event_no[:16]}")
    event = await service.get_event_by_no(session, event_no) if _EVENT_NO.match(event_no) else None
    key = x_client_key or ""
    if (
        event is None
        or not key
        or len(key) > 200
        or not service.read_client_link(key, event, now=clock.now())
    ):
        raise PermissionDenied(CLIENT_REFUSED, action="client-link")
    return event


ClientOf = Annotated[Event, Depends(client_event)]


class ClientReview(BaseModel):
    state: str
    note: str


class ClientDraft(BaseModel):
    """The unpublished draft the client is working on, and where it stands."""

    invite: PublicInvite
    #: The copy guests see now (the editor compares it with the draft), or ``None``.
    published: dict[str, Any] | None
    has_unpublished_changes: bool
    review: ClientReview


class ClientEventOut(BaseModel):
    event_no: str
    name: str
    status: str
    date: dt.date
    rsvp_deadline: dt.date
    hold_wishes: bool


class ClientGuest(BaseModel):
    """What the client needs to send invitations: name, phone and the personal link. Not the
    table, the notes or the replies."""

    id: uuid.UUID
    name: str
    phone: str
    category: str
    invited_at: dt.datetime | None
    invited_via: str | None
    token: str


class ClientWish(BaseModel):
    id: int
    name: str
    text: str
    at: dt.datetime
    state: Literal["shown", "waiting", "hidden"]


class ClientOut(BaseModel):
    event: ClientEventOut
    draft: ClientDraft
    #: The design team's published templates (the six built-ins are the page's own).
    templates: list[dict[str, Any]]
    wishes: list[ClientWish]
    guests: list[ClientGuest]


def client_wish(w: EventWish, hold: bool) -> ClientWish:
    state = rules.wish_state(hidden=w.hidden, approved=w.approved, hold=hold)
    return ClientWish(id=w.id, name=w.name, text=w.text, at=w.at, state=state)


async def client_draft(session: SessionDep, event: Event) -> ClientDraft:
    invite = await service.get_invite(session, event.id)
    review = service.review_view(await service.latest_review(session, event.id))
    return ClientDraft(
        invite=PublicInvite(
            template_id=invite.template_id, accent=invite.accent, on=dict(invite.toggles or {}),
            content=dict(invite.content or {}),
        ),
        published=dict(invite.published) if invite.published else None,
        has_unpublished_changes=service.has_unpublished_changes(invite),
        review=ClientReview(state=review.state, note=review.note or ""),
    )  # fmt: skip


async def client_audit(session: SessionDep, request: Request, event: Event, what: str) -> None:
    await record_audit(
        session, actor_label="client link", action="client.edit", entity_type="event",
        entity_id=event.id, detail={"what": what, "user_agent": user_agent(request)},
        request=request,
    )  # fmt: skip


@router.get("/client/{event_no}", response_model=ClientOut)
async def read_client(response: Response, session: SessionDep, event: ClientOf) -> ClientOut:
    """The client's working view: their draft, the gallery, the wishes (all of them, with state)
    and their guest list for sending invitations."""
    response.headers["Cache-Control"] = "no-store"
    invite = await service.get_invite(session, event.id)
    studio_rows = [
        t.as_dict()
        for t in await studio.list_templates(session)
        if not t.builtin and (t.status == "published" or t.id == invite.template_id)
    ]
    wishes = (
        await session.execute(
            select(EventWish).where(EventWish.event_id == event.id).order_by(EventWish.id)
        )
    ).scalars()
    return ClientOut(
        event=ClientEventOut(
            event_no=event.event_no, name=event.name, status=event.status.value, date=event.date,
            rsvp_deadline=event.rsvp_deadline, hold_wishes=event.hold_wishes,
        ),
        draft=await client_draft(session, event),
        templates=studio_rows,
        wishes=[client_wish(w, event.hold_wishes) for w in wishes],
        guests=[
            ClientGuest(
                id=g.id, name=g.name, phone=g.phone, category=g.category.value,
                invited_at=g.invited_at, invited_via=g.invited_via.value if g.invited_via else None,
                token=guest_link_token(g),
            )
            for g in await list_guests(session, event.id)
        ],
    )  # fmt: skip


class TemplateIn(BaseModel):
    template_id: str = Field(min_length=1, max_length=40)


class SectionIn(BaseModel):
    on: bool


class ContentIn(BaseModel):
    value: dict[str, Any]


class AccentIn(BaseModel):
    accent: str | None = Field(default=None, max_length=7)


class HoldIn(BaseModel):
    hold: bool


@router.put("/client/{event_no}/template", response_model=ClientDraft)
async def client_template(
    request: Request, session: SessionDep, clock: ClockDep, event: ClientOf, body: TemplateIn
) -> ClientDraft:
    await service.choose_template(session, event.id, body.template_id, now=clock.now())
    await client_audit(session, request, event, f"template:{body.template_id}")
    return await client_draft(session, event)


@router.put("/client/{event_no}/sections/{section_id}", response_model=ClientDraft)
async def client_section(
    request: Request, session: SessionDep, clock: ClockDep, event: ClientOf, section_id: str,
    body: SectionIn,
) -> ClientDraft:  # fmt: skip
    await service.set_section(session, event.id, section_id[:40], body.on, now=clock.now())
    await client_audit(session, request, event, f"section:{section_id[:40]}")
    return await client_draft(session, event)


@router.put("/client/{event_no}/content/{section_id}", response_model=ClientDraft)
async def client_content(
    request: Request, session: SessionDep, clock: ClockDep, event: ClientOf, section_id: str,
    body: ContentIn,
) -> ClientDraft:  # fmt: skip
    await service.update_content(session, event.id, section_id[:40], body.value, now=clock.now())
    await client_audit(session, request, event, f"content:{section_id[:40]}")
    return await client_draft(session, event)


client_upload_throttle = Throttle(
    "pub-client-upload", limit=20, window_seconds=60, block_seconds=120
)


@router.post("/client/{event_no}/media", response_model=MediaOut, status_code=201)
async def client_upload(
    request: Request, session: SessionDep, clock: ClockDep, event: ClientOf,
    file: Annotated[UploadFile, File()], kind: Annotated[str, Query(max_length=10)] = "photo",
) -> MediaOut:  # fmt: skip
    """A photo, video or song from the client. Needs the edit key; the file's size and type are
    checked while it streams, and the event can only hold so many (``events.media``)."""
    await hit(session, client_upload_throttle, request, f"u:{event.id}")
    ref = await service.upload_media(
        session, event.id, file, kind, by="client link", now=clock.now(), actor=None,
        request=request,
    )
    return MediaOut(**ref)


@router.put("/client/{event_no}/accent", response_model=ClientDraft)
async def client_accent(
    request: Request, session: SessionDep, clock: ClockDep, event: ClientOf, body: AccentIn
) -> ClientDraft:
    await service.set_accent(session, event.id, body.accent, now=clock.now())
    await client_audit(session, request, event, "accent")
    return await client_draft(session, event)


@router.post("/client/{event_no}/submit", response_model=ClientDraft)
async def client_submit(
    request: Request, session: SessionDep, clock: ClockDep, event: ClientOf
) -> ClientDraft:
    """Hand the draft to Oscenia for review (recorded as submitted by the client link)."""
    await service.submit_for_review(
        session, event.id, by="client", now=clock.now(), actor=None, request=request
    )
    return await client_draft(session, event)


@router.put("/client/{event_no}/hold-wishes", response_model=ClientEventOut)
async def client_hold_wishes(
    request: Request, session: SessionDep, clock: ClockDep, event: ClientOf, body: HoldIn
) -> ClientEventOut:
    row = await service.set_hold_wishes(
        session, event.id, body.hold, actor_label="client link", now=clock.now(), request=request
    )
    return ClientEventOut(
        event_no=row.event_no, name=row.name, status=row.status.value, date=row.date,
        rsvp_deadline=row.rsvp_deadline, hold_wishes=row.hold_wishes,
    )  # fmt: skip


@router.post("/client/{event_no}/wishes/{wish_id}/{action}", response_model=ClientWish)
async def client_wish_action(
    request: Request, session: SessionDep, event: ClientOf, wish_id: int,
    action: Literal["hide", "show", "approve"],
) -> ClientWish:  # fmt: skip
    """Hide a wish, show it again, or approve a waiting one."""
    if action == "approve":
        wish = await approve_wish(
            session, event.id, wish_id, actor_label="client link", request=request
        )
    else:
        wish = await set_wish_hidden(
            session, event.id, wish_id, action == "hide", actor_label="client link", request=request
        )
    return client_wish(wish, event.hold_wishes)


@router.post("/client/{event_no}/guests/{guest_id}/sent", response_model=ClientGuest)
async def client_mark_sent(
    request: Request, session: SessionDep, clock: ClockDep, event: ClientOf, guest_id: uuid.UUID
) -> ClientGuest:
    g = await mark_sent_by_client(session, event.id, guest_id, now=clock.now(), request=request)
    return ClientGuest(
        id=g.id, name=g.name, phone=g.phone, category=g.category.value, invited_at=g.invited_at,
        invited_via=g.invited_via.value if g.invited_via else None, token=guest_link_token(g),
    )  # fmt: skip


# ---------------------------------------------------------------------------
# Uploaded media, for guests, the client's editor and the staff preview
# ---------------------------------------------------------------------------
# One URL shape for all of them. An <img>, <video> or <audio> cannot send a token, so the
# upload's id (122 random bits, only ever written into content people can already see) is the
# credential. A draft's photo is therefore fetchable by someone who holds its id; that is the
# price of the editor preview, and nothing lists the ids.

media_throttle = Throttle("pub-media", limit=600, window_seconds=60, block_seconds=30)


@router.get("/media/{media_id}")
async def public_media(media_id: str, request: Request, session: SessionDep) -> Response:
    """The file (with Range for video and music), or the one uniform 404."""
    await hit(session, media_throttle, request)
    row = await media.get_media(session, media_id[:40])
    if row is None:
        raise NotFound("That file is not available.")
    return get_storage().serve(row.storage_key, public=True)
