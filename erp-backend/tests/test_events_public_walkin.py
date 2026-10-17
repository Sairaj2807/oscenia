# ruff: noqa: F811  (the `gala` fixture is imported, then named as a test argument)
"""The public walk-in desk: only with the venue's signed link, only around the event date.

The frozen clock is 2026-07-26, so an event on the 27th is "tomorrow" (inside the window) and the
gala on 14 August is not.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from test_events_public import gala, stranger  # noqa: F401

from app.core.throttle import Throttle
from app.domain.audit.models import AuditEvent
from app.domain.events import public, rules, service
from app.domain.events.models import Event
from app.domain.masters.models import Role

NOW = datetime(2026, 7, 26, 9, 0, tzinfo=ZoneInfo("Asia/Jakarta"))


@pytest.fixture
async def soon(client: AsyncClient, api: str) -> dict[str, Any]:
    """A published event tomorrow, with one listed guest and its desk link."""
    ev = (
        await client.post(f"{api}/events", json={"name": "Tomorrow", "date": "2026-07-27"})
    ).json()
    url = f"{api}/events/{ev['id']}"
    await client.put(f"{url}/invite/template", json={"template_id": "gala"})
    await client.post(
        f"{url}/guests", json={"guests": [{"name": "Dewi Wijaya", "phone": "0812 1100 2200"}]}
    )
    assert (await client.post(f"{url}/publish", json={})).status_code == 200
    link = (await client.get(f"{url}/walkin-link")).json()
    return {"id": ev["id"], "no": ev["event_no"], "url": url, "token": link["token"]}


def desk(api: str, ev: dict[str, Any]) -> str:
    return f"{api}/public/walkin/{ev['no']}"


def at_desk(token: str) -> dict[str, str]:
    return {"X-Walkin-Token": token}


async def test_the_window_runs_from_the_day_before_to_the_day_after() -> None:
    d = date(2026, 8, 14)
    assert rules.walkin_open(event_date=d, today=date(2026, 8, 13))
    assert rules.walkin_open(event_date=d, today=d)
    assert rules.walkin_open(event_date=d, today=date(2026, 8, 15))
    assert not rules.walkin_open(event_date=d, today=date(2026, 8, 12))
    assert not rules.walkin_open(event_date=d, today=date(2026, 8, 16))


async def test_the_desk_link_is_signed_scoped_and_expires(
    client: AsyncClient, soon: dict[str, Any], db: AsyncSession
) -> None:
    event = await db.get(Event, uuid.UUID(soon["id"]))
    other = await db.get(Event, uuid.UUID((await _another_event(client, soon))["id"]))
    assert event is not None and other is not None

    token, expires = service.walkin_link(event, now=NOW)
    assert service.read_walkin_link(token, event, now=NOW)
    assert not service.read_walkin_link(token, other, now=NOW), "another event's desk"
    assert not service.read_walkin_link(token[:-3] + "AAA", event, now=NOW), "forged"
    assert not service.read_walkin_link(token, event, now=NOW + timedelta(days=10)), "expired"
    assert expires.date() >= event.date + timedelta(days=1)


async def _another_event(client: AsyncClient, soon: dict[str, Any]) -> dict[str, Any]:
    api = soon["url"].split("/events/")[0]
    return (
        await client.post(f"{api}/events", json={"name": "Elsewhere", "date": "2026-07-27"})
    ).json()


async def test_the_desk_page_needs_the_venue_link(
    client: AsyncClient, api: str, soon: dict[str, Any]
) -> None:
    anyone = stranger(client)
    ok = await anyone.get(desk(api, soon), headers=at_desk(soon["token"]))
    assert ok.status_code == 200, ok.text
    body = ok.json()
    assert body["name"] == "Tomorrow" and body["event_no"] == soon["no"]
    assert set(body) == {"event_no", "name", "template_id", "accent", "cover_title", "template"}

    for headers in ({}, at_desk(""), at_desk("garbage"), at_desk("x" * 400)):
        refused = await anyone.get(desk(api, soon), headers=headers)
        assert refused.status_code == 404, headers


async def test_outside_the_window_even_the_right_link_is_refused(
    client: AsyncClient, api: str, gala: dict[str, Any]
) -> None:
    token = (await client.get(f"{gala['url']}/walkin-link")).json()["token"]
    r = await stranger(client).get(f"{api}/public/walkin/{gala['no']}", headers=at_desk(token))
    assert r.status_code == 404, "the gala is weeks away"


async def test_a_stranger_is_added_as_a_walk_in_and_checked_in(
    client: AsyncClient, api: str, soon: dict[str, Any]
) -> None:
    r = await stranger(client).post(
        desk(api, soon),
        json={"name": "Walker", "phone": "0813 4444 5555", "email": "w@x.id", "consent": True},
        headers=at_desk(soon["token"]),
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"walk_in": True}, "nothing about anyone else comes back"

    guests = (await client.get(f"{soon['url']}/guests")).json()
    walker = next(g for g in guests if g["name"] == "Walker")
    assert walker["walk_in"] is True and walker["checked_in_at"] and walker["consent"] is True


async def test_a_listed_guest_found_by_phone_is_checked_in_not_added(
    client: AsyncClient, api: str, soon: dict[str, Any]
) -> None:
    r = await stranger(client).post(
        desk(api, soon),
        json={"name": "Dewi", "phone": "0812 1100 2200"},
        headers=at_desk(soon["token"]),
    )
    assert r.status_code == 200 and r.json() == {"walk_in": False}
    guests = (await client.get(f"{soon['url']}/guests")).json()
    assert len(guests) == 1 and guests[0]["checked_in_at"]


async def test_no_link_means_no_registration(
    client: AsyncClient, api: str, soon: dict[str, Any]
) -> None:
    anyone = stranger(client)
    body = {"name": "Intruder", "phone": "0813 9999 0000"}
    assert (await anyone.post(desk(api, soon), json=body)).status_code == 404
    assert (
        await anyone.post(desk(api, soon), json=body, headers=at_desk("nope"))
    ).status_code == 404
    names = [g["name"] for g in (await client.get(f"{soon['url']}/guests")).json()]
    assert "Intruder" not in names


async def test_bad_input_a_trap_field_and_a_flood_are_handled(
    client: AsyncClient, api: str, soon: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    anyone = stranger(client)
    link = at_desk(soon["token"])
    bad = await anyone.post(desk(api, soon), json={"name": "", "phone": "1"}, headers=link)
    assert bad.status_code == 422 and bad.json()["code"] == "invalid"

    trap = await anyone.post(
        desk(api, soon),
        json={"name": "Bot", "phone": "0813 1111 2222", "website": "x"},
        headers=link,
    )
    assert trap.status_code == 200 and trap.json() == {"walk_in": None}
    assert "Bot" not in [g["name"] for g in (await client.get(f"{soon['url']}/guests")).json()]

    monkeypatch.setattr(
        public, "walkin_throttle",
        Throttle(f"t-{uuid.uuid4().hex[:8]}", limit=2, window_seconds=60, block_seconds=60),
    )  # fmt: skip
    codes = [(await anyone.get(desk(api, soon), headers=link)).status_code for _ in range(4)]
    assert codes[-1] == 429


async def test_a_registration_is_audited_without_a_user(
    client: AsyncClient, api: str, soon: dict[str, Any], db: AsyncSession
) -> None:
    await stranger(client).post(
        desk(api, soon), json={"name": "Audited", "phone": "0813 2222 3333"},
        headers={**at_desk(soon["token"]), "user-agent": "Desk/1.0"},
    )  # fmt: skip
    row = (
        (await db.execute(select(AuditEvent).where(AuditEvent.action == "walkin.register")))
        .scalars()
        .first()
    )
    assert row is not None and row.actor_user_id is None and row.actor_label == "anonymous"
    assert row.detail["user_agent"] == "Desk/1.0"


async def test_only_publishers_can_get_the_desk_link(
    client: AsyncClient, api: str, soon: dict[str, Any], client_for
) -> None:
    sales = await client_for(Role.SALES)
    r = await sales.get(f"{soon['url']}/walkin-link")
    assert r.status_code == 403
