"""The bell's non-chat items: client invitations to review, RSVPs, birthdays and anniversaries.

Ported from the events and CRM parts of ``erp-frontend/src/lib/notifications.js``. Like the
chat items (``chat/notifications.py``) they are **worked out from the data on every read**, so
an item can never disagree with the thing it points at: publish the invitation and its "to
review" goes; the reminder job resolves a birthday and it goes.

This is a separate list from chat's on purpose. Chat's needs a workspace persona; the people
who run events and the CRM (CEO, finance, sales) often have none, and must still get their bell.

Who sees what is the same rule the screens use — the ``events`` module for RSVPs, plus the
``publish_invitation`` action for reviews, and the ``crm`` module for client dates.

**Read state is the client's.** ``read`` is always ``None``: the browser remembers what was
opened, as it does for the prototype and for the chat answers. That keeps this list free of
writes. (It is per browser, not per account.)

Not here: "Time to reach out" (the server has no nudge cycles) and tasks (no backend).
"""

from __future__ import annotations

import datetime as dt
from typing import Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import Clock
from app.core.rbac import can_do, can_see
from app.core.schemas import Schema
from app.domain.ar.models import Client
from app.domain.events.models import (
    Event,
    EventInvite,
    EventReview,
    EventStatus,
    Guest,
    ReviewState,
    RsvpAnswer,
)
from app.domain.masters.models import User
from app.jobs.models import Reminder, ReminderKind, ReminderStatus

Kind = Literal[
    "Invitation to review",
    "New RSVP",
    "RSVP declined",
    "Birthday",
    "Company anniversary",
    "Event nudge",
]

RSVPS_SHOWN = 6
#: A birthday reminder is raised on the day. It stays in the bell for a week unless resolved.
REMINDER_DAYS = 7
DEFAULT_LIMIT = 50

_REMINDER_LABEL: dict[ReminderKind, Kind] = {
    ReminderKind.BIRTHDAY: "Birthday",
    ReminderKind.ANNIVERSARY: "Company anniversary",
    ReminderKind.NUDGE: "Event nudge",
}

#: Things only this person can unblock come first; the rest newest first.
_ACTION: set[str] = {"Invitation to review"}


def _reminder_title(label: str, subject: str, client_name: str) -> str:
    """A nudge reads as its own subject; a birthday or anniversary as ``Birthday · Client``."""
    if label == "Event nudge":
        return subject
    return f"{'Birthday' if label == 'Birthday' else 'Anniversary'} · {client_name}"


class NotificationItem(Schema):
    #: Stable per thing it points at (``review:<id>:<time>``) so the client can remember that
    #: it was opened, and a re-submission of the same review rings again.
    id: str
    kind: Kind
    at: dt.datetime
    title: str
    body: str
    #: The in-app path that opens the thing itself.
    to: str
    #: Always ``None``: the browser keeps read state for these.
    read: bool | None = None


def _aware(value: dt.datetime) -> dt.datetime:
    return value if value.tzinfo else value.replace(tzinfo=dt.UTC)


async def _reviews(session: AsyncSession) -> list[NotificationItem]:
    """Invitations a client (or staff) submitted and nobody has published or sent back yet."""
    latest = (
        select(EventReview.event_id, EventReview.id)
        .distinct(EventReview.event_id)
        .order_by(EventReview.event_id, EventReview.id.desc())
        .subquery()
    )
    rows = (
        await session.execute(
            select(EventReview, Event, EventInvite)
            .join(latest, latest.c.id == EventReview.id)
            .join(Event, Event.id == EventReview.event_id)
            .join(EventInvite, EventInvite.event_id == Event.id)
            .where(EventReview.state == ReviewState.SUBMITTED)
        )
    ).all()
    return [
        NotificationItem(
            id=f"review:{event.event_no}:{_aware(review.submitted_at).isoformat()}",
            kind="Invitation to review",
            at=review.submitted_at,
            title=event.name,
            body=(
                "The client changed the live invitation"
                if invite.published
                else "Ready to publish for the first time"
            ),
            to=f"/events/{event.event_no}?tab=invitation",
        )
        for review, event, invite in rows
    ]


async def _rsvps(session: AsyncSession, today: dt.date) -> list[NotificationItem]:
    """The latest few answers on events that are live and still to come."""
    rows = (
        await session.execute(
            select(Guest, Event)
            .join(Event, Event.id == Guest.event_id)
            .where(
                Event.status == EventStatus.PUBLISHED,
                Event.date >= today,
                Guest.responded_at.is_not(None),
            )
            .order_by(Guest.responded_at.desc())
            .limit(RSVPS_SHOWN)
        )
    ).all()
    items: list[NotificationItem] = []
    for guest, event in rows:
        assert guest.responded_at is not None
        attending = guest.rsvp == RsvpAnswer.ATTENDING
        extra = f" (+{guest.pax - 1})" if attending and guest.pax > 1 else ""
        items.append(
            NotificationItem(
                id=f"rsvp:{guest.id}:{_aware(guest.responded_at).isoformat()}",
                kind="New RSVP" if attending else "RSVP declined",
                at=guest.responded_at,
                title=f"{guest.name}{extra}",
                body=f"{event.name}{'' if guest.on_master_list else ' · not on the client’s list'}",
                to=f"/events/{event.event_no}?tab=guests",
            )
        )
    return items


async def _client_dates(session: AsyncSession, today: dt.date) -> list[NotificationItem]:
    """Birthdays, anniversaries and event nudges the daily scan raised and nobody has resolved."""
    rows = (
        await session.execute(
            select(Reminder, Client)
            .join(Client, Client.id == Reminder.client_id)
            .where(
                Reminder.status == ReminderStatus.OPEN,
                Reminder.kind.in_(
                    [ReminderKind.BIRTHDAY, ReminderKind.ANNIVERSARY, ReminderKind.NUDGE]
                ),
                Reminder.due_date >= today - dt.timedelta(days=REMINDER_DAYS),
            )
            .order_by(Reminder.due_date.desc(), Reminder.subject)
        )
    ).all()
    items: list[NotificationItem] = []
    for reminder, client in rows:
        label = _REMINDER_LABEL[reminder.kind]
        # Due items surface as "this morning", so they sort with that day's news.
        at = dt.datetime.combine(reminder.due_date, dt.time(8, 0), tzinfo=dt.UTC)
        ago = (today - reminder.due_date).days
        items.append(
            NotificationItem(
                id=f"rem:{reminder.id}",
                kind=label,
                at=at,
                title=_reminder_title(label, reminder.subject, client.name),
                body="today" if ago <= 0 else f"{ago} day{'s' if ago != 1 else ''} ago",
                to=f"/crm/{client.client_no}",
            )
        )
    return items


async def build(
    session: AsyncSession, user: User, clock: Clock, *, limit: int = DEFAULT_LIMIT
) -> list[NotificationItem]:
    """What is waiting for this login, newest first with things to act on at the top."""
    today = clock.today()
    items: list[NotificationItem] = []
    if can_see(user.role, "events"):
        if can_do(user.role, "publish_invitation"):
            items += await _reviews(session)
        items += await _rsvps(session, today)
    if can_see(user.role, "crm"):
        items += await _client_dates(session, today)
    items.sort(key=lambda i: (0 if i.kind in _ACTION else 1, -_aware(i.at).timestamp()))
    return items[:limit]
