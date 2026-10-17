"""The bell's events and CRM items: invitations to review, RSVPs, birthdays and anniversaries.

Like the chat items they are worked out from the data on every read, so most tests change the
data (publish, return, resolve, move the date) and check the answer follows. The role matrix
is the other half: the list must never hand a login something its role cannot open.
"""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any

from chat_world import World, login, world  # noqa: F401
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import DEMO_TODAY, FrozenClock
from app.domain.events import attendance
from app.domain.events.attendance import RsvpForm
from app.domain.events.models import Event, EventReview, EventStatus, ReviewState
from app.domain.masters.models import Role
from app.jobs.models import Reminder, ReminderKind, ReminderStatus

NOW = FrozenClock(DEMO_TODAY).now()


async def get_items(http: AsyncClient, api: str, **params: Any) -> list[dict[str, Any]]:
    r = await http.get(f"{api}/notifications", params=params)
    assert r.status_code == 200, r.text
    return r.json()


def kinds(items: list[dict[str, Any]]) -> list[str]:
    return [i["kind"] for i in items]


async def event(http: AsyncClient, api: str, name: str = "Gala", date: str = "2026-08-14") -> str:
    r = await http.post(f"{api}/events", json={"name": name, "date": date})
    assert r.status_code == 201, r.text
    ev = r.json()
    url = f"{api}/events/{ev['id']}"
    assert (
        await http.put(f"{url}/invite/template", json={"template_id": "gala"})
    ).status_code == 200
    return ev["id"]


async def published(http: AsyncClient, api: str, **kw: Any) -> str:
    eid = await event(http, api, **kw)
    r = await http.post(f"{api}/events/{eid}/publish", json={})
    assert r.status_code == 200, r.text
    return eid


async def reply(db: AsyncSession, eid: str, **kw: Any) -> None:
    base: dict[str, Any] = {"name": "Dewi Wijaya", "phone": "0812 1100 2200", "attending": True,
                            "answers": {}}  # fmt: skip
    await attendance.submit_rsvp(
        db, uuid.UUID(eid), RsvpForm(**{**base, **kw}), now=NOW, today=DEMO_TODAY
    )


async def birthday_today(http: AsyncClient, api: str, name: str = "Anindita W.") -> str:
    r = await http.post(f"{api}/clients", json={"name": name, "birthday": "26 Jul"})
    assert r.status_code == 201, r.text
    run = await http.post(f"{api}/jobs/crm.milestone_scan/run", json={})
    assert run.json()["status"] == "succeeded", run.text
    return r.json()["id"]


# --- invitations to review ------------------------------------------------------------------


async def test_a_submitted_invitation_asks_those_who_may_publish_and_closes_when_published(
    client: AsyncClient, api: str
) -> None:
    eid = await event(client, api, "Year-end", "2026-12-10")
    assert await get_items(client, api) == []
    assert (await client.post(f"{api}/events/{eid}/submit")).status_code == 200

    [item] = await get_items(client, api)
    assert item["kind"] == "Invitation to review" and item["title"] == "Year-end"
    assert item["body"] == "Ready to publish for the first time"
    assert item["to"].startswith("/events/EV-") and item["to"].endswith("?tab=invitation")
    assert item["read"] is None and item["id"].startswith("review:EV-")

    assert (await client.post(f"{api}/events/{eid}/publish", json={})).status_code == 200
    assert "Invitation to review" not in kinds(await get_items(client, api))


async def test_a_returned_invitation_leaves_the_bell(client: AsyncClient, api: str) -> None:
    eid = await event(client, api)
    await client.post(f"{api}/events/{eid}/submit")
    assert kinds(await get_items(client, api)) == ["Invitation to review"]
    r = await client.post(f"{api}/events/{eid}/return", json={"note": "Keep the old title."})
    assert r.status_code == 200, r.text
    assert await get_items(client, api) == []


async def test_a_change_to_a_live_invitation_is_worded_as_a_change(
    client: AsyncClient, api: str
) -> None:
    eid = await published(client, api)
    await client.post(f"{api}/events/{eid}/submit")
    [item] = [i for i in await get_items(client, api) if i["kind"] == "Invitation to review"]
    assert item["body"] == "The client changed the live invitation"


async def test_only_the_latest_review_counts_not_an_older_submitted_one(
    client: AsyncClient, api: str, db: AsyncSession
) -> None:
    """The latest row is the current state (the model says so). An older 'submitted' row under
    a newer 'closed' one is history, not something still waiting."""
    eid = uuid.UUID(await event(client, api))
    for state, minutes in [(ReviewState.SUBMITTED, 0), (ReviewState.CLOSED, 5)]:
        db.add(
            EventReview(
                event_id=eid,
                state=state,
                submitted_at=NOW + timedelta(minutes=minutes),
                submitted_by="client",
                note="",
            )  # fmt: skip
        )
        await db.flush()
    assert await get_items(client, api) == []


async def test_two_events_awaiting_review_are_two_items(client: AsyncClient, api: str) -> None:
    a = await event(client, api, "A")
    b = await event(client, api, "B")
    await client.post(f"{api}/events/{a}/submit")
    await client.post(f"{api}/events/{b}/submit")
    items = await get_items(client, api)
    assert sorted(i["title"] for i in items) == ["A", "B"] and len({i["id"] for i in items}) == 2


# --- RSVPs ------------------------------------------------------------------------------------


async def test_an_rsvp_on_an_upcoming_published_event_shows_attending_or_declined(
    client: AsyncClient, api: str, db: AsyncSession
) -> None:
    eid = await published(client, api)
    await reply(db, eid, name="Dewi Wijaya", pax=3)
    await reply(db, eid, name="Budi Santoso", phone="0812 1100 3300", attending=False)

    by_kind = {i["kind"]: i for i in await get_items(client, api)}
    assert by_kind["New RSVP"]["title"] == "Dewi Wijaya (+1)"  # pax is capped at the max, 2
    assert by_kind["RSVP declined"]["title"] == "Budi Santoso"
    assert by_kind["New RSVP"]["body"] == "Gala · not on the client’s list"
    assert by_kind["New RSVP"]["to"].endswith("?tab=guests")


async def test_rsvps_on_a_draft_or_a_past_event_are_not_news(
    client: AsyncClient, api: str, db: AsyncSession, frozen_clock: FrozenClock
) -> None:
    # A reply on a live event, then the event is taken back to a draft (unpublished).
    eid = await published(client, api, name="Soon", date="2026-08-14")
    await reply(db, eid, name="Late Reply", phone="0811 0000 0001")
    assert len(await get_items(client, api)) == 1
    row = await db.get(Event, uuid.UUID(eid))
    assert row is not None
    row.status = EventStatus.DRAFT
    await db.flush()
    assert await get_items(client, api) == []
    row.status = EventStatus.PUBLISHED
    await db.flush()
    frozen_clock.advance(timedelta(days=30))
    assert await get_items(client, api) == []


async def test_only_the_latest_six_rsvps_are_listed(
    client: AsyncClient, api: str, db: AsyncSession
) -> None:
    eid = await published(client, api)
    for n in range(8):
        await reply(db, eid, name=f"Guest {n}", phone=f"0811 000 00{n}")
    assert len(await get_items(client, api)) == 6


# --- client dates ----------------------------------------------------------------------------


async def test_a_birthday_reminder_shows_until_resolved(client: AsyncClient, api: str) -> None:
    await birthday_today(client, api)
    [item] = await get_items(client, api)
    assert item["kind"] == "Birthday" and item["title"] == "Birthday · Anindita W."
    assert item["body"] == "today" and item["to"].startswith("/crm/CL-")

    [rem] = (await client.get(f"{api}/reminders")).json()
    r = await client.post(f"{api}/reminders/{rem['id']}/resolve", json={"status": "done"})
    assert r.status_code == 200, r.text
    assert await get_items(client, api) == []


async def test_only_birthdays_and_anniversaries_and_only_recent_ones(
    client: AsyncClient, api: str, db: AsyncSession
) -> None:
    cid = uuid.UUID(await birthday_today(client, api))
    today = DEMO_TODAY

    def reminder(
        kind: ReminderKind, ref: str, days_ago: int, status: Any = ReminderStatus.OPEN
    ) -> Reminder:
        return Reminder(
            kind=kind, subject=f"{kind.value} {ref}", client_id=cid, ref=ref,
            due_date=today - timedelta(days=days_ago), status=status, raised_by_job="test",
        )  # fmt: skip

    db.add_all([
        reminder(ReminderKind.ANNIVERSARY, "A-new", 3),
        reminder(ReminderKind.ANNIVERSARY, "A-old", 8),            # a week ago: gone
        reminder(ReminderKind.OVERDUE_INVOICE, "INV-1", 0),        # not a bell kind
        reminder(ReminderKind.ASSET_RETURN, "IT-1", 0),            # not a bell kind
        reminder(ReminderKind.BIRTHDAY, "B-dismissed", 1, ReminderStatus.DISMISSED),
    ])  # fmt: skip
    await db.flush()

    items = await get_items(client, api)
    assert sorted(kinds(items)) == ["Birthday", "Company anniversary"]
    anniversary = next(i for i in items if i["kind"] == "Company anniversary")
    assert anniversary["body"] == "3 days ago"


# --- who sees what ---------------------------------------------------------------------------


async def test_each_role_sees_only_what_it_may_open(
    client_for: Any, api: str, db: AsyncSession
) -> None:
    ceo = await client_for(Role.CEO)
    eid = await published(ceo, api, name="Gala")
    await reply(db, eid)
    review = await event(ceo, api, "To review", "2026-12-10")
    await ceo.post(f"{api}/events/{review}/submit")
    await birthday_today(ceo, api)

    expected = {
        Role.CEO: {"Invitation to review", "New RSVP", "Birthday"},
        Role.PM: {"Invitation to review", "New RSVP"},
        Role.SALES: {"New RSVP", "Birthday"},  # may run events, but publishing is not theirs
        Role.FINANCE: {"Birthday"},
        Role.WAREHOUSE: set(),
    }
    for role, kinds_seen in expected.items():
        http = await client_for(role)
        assert set(kinds(await get_items(http, api))) == kinds_seen, role


async def test_a_workspace_only_login_gets_an_empty_list_not_an_error(
    anon_client: AsyncClient, api: str, world: World
) -> None:
    await login(anon_client, api, world.staff)  # Role.TEAM: chat and nothing else
    assert await get_items(anon_client, api) == []


async def test_it_needs_a_signed_in_login(anon_client: AsyncClient, api: str) -> None:
    assert (await anon_client.get(f"{api}/notifications")).status_code == 401


async def test_action_items_come_first_then_newest(
    client: AsyncClient, api: str, db: AsyncSession
) -> None:
    eid = await published(client, api)
    await reply(db, eid)
    await birthday_today(client, api)
    review = await event(client, api, "Review me", "2026-12-10")
    await client.post(f"{api}/events/{review}/submit")
    items = await get_items(client, api)
    assert items[0]["kind"] == "Invitation to review"
    ats = [i["at"] for i in items[1:]]
    assert ats == sorted(ats, reverse=True)
    assert len(await get_items(client, api, limit=2)) == 2
