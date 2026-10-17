# ruff: noqa: F811  (the `gala` fixture is imported, then named as a test argument)
"""Public RSVP and wishes: identity, refusals with codes, limits, audit.

Reuses the signed-out client and the published gala from ``test_events_public``.
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from test_events_public import gala, path, stranger  # noqa: F401  (gala is a fixture)

from app.core.throttle import Throttle
from app.domain.audit.models import AuditEvent
from app.domain.events import public


def rsvp_body(**kw: Any) -> dict[str, Any]:
    return {"name": "Siti", "phone": "0811 5555 0001", "attending": True, "pax": 2, **kw}


def tiny(limit: int) -> Throttle:
    return Throttle(f"t-{uuid.uuid4().hex[:8]}", limit=limit, window_seconds=60, block_seconds=60)


async def staff_guests(client: AsyncClient, gala: dict[str, Any]) -> list[dict[str, Any]]:
    return (await client.get(f"{gala['url']}/guests")).json()


# ---------------------------------------------------------------------------
# RSVP
# ---------------------------------------------------------------------------


async def test_a_guest_replies_on_their_personal_link_and_it_reaches_staff(
    client: AsyncClient, api: str, gala: dict[str, Any]
) -> None:
    r = await stranger(client).post(
        f"{path(gala, api)}/rsvp",
        json=rsvp_body(name="Dewi", phone="0812 1100 2200", pax=2),
        headers={"X-Guest-Token": gala["dewi"]["link_token"]},
    )
    assert r.status_code == 200, r.text
    own = r.json()["guest"]
    assert own["rsvp"] == "Attending" and own["pax"] == 2
    assert own["token"] and own["qr"].startswith("OSC1:")

    dewi = next(g for g in await staff_guests(client, gala) if g["id"] == gala["dewi"]["id"])
    assert dewi["rsvp"] == "Attending" and dewi["pax"] == 2
    assert dewi["table"] == "VIP 1", "the reply kept the table staff gave"


async def test_a_stranger_becomes_an_off_list_guest(
    client: AsyncClient, api: str, gala: dict[str, Any]
) -> None:
    r = await stranger(client).post(f"{path(gala, api)}/rsvp", json=rsvp_body())
    assert r.status_code == 200, r.text
    siti = next(g for g in await staff_guests(client, gala) if g["name"] == "Siti")
    assert siti["on_master_list"] is False and siti["rsvp"] == "Attending"


async def test_a_phone_may_claim_a_listed_guest_who_has_not_replied_yet(
    client: AsyncClient, api: str, gala: dict[str, Any]
) -> None:
    r = await stranger(client).post(
        f"{path(gala, api)}/rsvp", json=rsvp_body(name="Budi S.", phone="0812 1100 3300")
    )
    assert r.status_code == 200 and r.json()["guest"]["id"] == gala["budi"]["id"]


async def test_a_phone_cannot_overwrite_a_guest_who_already_replied(
    client: AsyncClient, api: str, gala: dict[str, Any]
) -> None:
    anyone = stranger(client)
    first = await anyone.post(
        f"{path(gala, api)}/rsvp", json=rsvp_body(name="Budi", phone="0812 1100 3300", pax=1)
    )
    assert first.status_code == 200

    attempt = await anyone.post(
        f"{path(gala, api)}/rsvp",
        json=rsvp_body(name="Mallory", phone="0812 1100 3300", attending=False, pax=0),
    )
    assert attempt.status_code == 409 and attempt.json()["code"] == "already_replied"

    budi = next(g for g in await staff_guests(client, gala) if g["id"] == gala["budi"]["id"])
    assert budi["rsvp"] == "Attending" and budi["name"] == "Budi Santoso", "not overwritten"

    with_link = await anyone.post(
        f"{path(gala, api)}/rsvp",
        json=rsvp_body(name="Budi", phone="0812 1100 3300", pax=2),
        headers={"X-Guest-Token": gala["budi"]["link_token"]},
    )
    assert with_link.status_code == 200 and with_link.json()["guest"]["pax"] == 2


async def test_closed_missing_answers_and_bad_input_have_codes_not_one_message(
    client: AsyncClient, api: str, gala: dict[str, Any]
) -> None:
    anyone = stranger(client)
    q = (await client.post(f"{gala['url']}/questions", json={"type": "dropdown"})).json()
    await client.patch(
        f"{gala['url']}/questions/{q['key']}",
        json={"label": "Meal", "options": ["Beef", "Fish"], "required": True},
    )

    missing = await anyone.post(f"{path(gala, api)}/rsvp", json=rsvp_body())
    assert missing.status_code == 422 and missing.json()["code"] == "missing_answers"
    assert missing.json()["missing"] == ["Meal"]

    answers = {q["key"]: "Fish"}
    assert (
        await anyone.post(f"{path(gala, api)}/rsvp", json=rsvp_body(answers=answers))
    ).status_code == 200

    no_phone = await anyone.post(
        f"{path(gala, api)}/rsvp", json=rsvp_body(phone="", answers=answers)
    )
    assert no_phone.status_code == 422 and no_phone.json()["code"] == "invalid"

    await client.patch(gala["url"], json={"rsvp_deadline": "2026-07-01"})
    closed = await anyone.post(
        f"{path(gala, api)}/rsvp", json=rsvp_body(phone="0811 7777 0001", answers=answers)
    )
    assert closed.status_code == 409 and closed.json()["code"] == "closed"


async def test_oversized_or_malformed_fields_are_refused_without_echoing_them(
    client: AsyncClient, api: str, gala: dict[str, Any]
) -> None:
    anyone = stranger(client)
    r = await anyone.post(
        f"{path(gala, api)}/rsvp", json=rsvp_body(name="N" * 500, answers={"Q-1": "x" * 600})
    )
    assert r.status_code == 422
    assert "NNNN" not in r.text and "xxxx" not in r.text, "the input is not echoed back"
    assert r.json()["detail"] == "Please check the form and try again."

    many = {f"Q-{i}": "a" for i in range(40)}
    r = await anyone.post(f"{path(gala, api)}/rsvp", json=rsvp_body(answers=many))
    assert r.status_code == 422


async def test_a_bot_that_fills_the_trap_field_stores_nothing(
    client: AsyncClient, api: str, gala: dict[str, Any]
) -> None:
    before = len(await staff_guests(client, gala))
    r = await stranger(client).post(
        f"{path(gala, api)}/rsvp", json=rsvp_body(website="http://spam")
    )
    assert r.status_code == 200 and r.json()["guest"] is None
    assert len(await staff_guests(client, gala)) == before


async def test_an_unpublished_event_takes_no_rsvp_and_gives_the_same_404(
    client: AsyncClient, api: str, gala: dict[str, Any]
) -> None:
    await client.post(f"{gala['url']}/unpublish")
    r = await stranger(client).post(f"{path(gala, api)}/rsvp", json=rsvp_body())
    assert r.status_code == 404


async def test_rsvps_are_throttled_per_person_and_one_persons_limit_is_their_own(
    client: AsyncClient, api: str, gala: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(public, "rsvp_who_throttle", tiny(2))
    anyone = stranger(client)
    body = rsvp_body(phone="0811 8888 0001")
    codes = [
        (await anyone.post(f"{path(gala, api)}/rsvp", json=body)).status_code for _ in range(4)
    ]
    assert codes[0] == 200 and codes[-1] == 429

    other = await anyone.post(f"{path(gala, api)}/rsvp", json=rsvp_body(phone="0811 8888 0002"))
    assert other.status_code == 200


async def test_every_public_rsvp_is_audited_without_a_user(
    client: AsyncClient, api: str, gala: dict[str, Any], db: AsyncSession
) -> None:
    r = await stranger(client).post(
        f"{path(gala, api)}/rsvp", json=rsvp_body(), headers={"user-agent": "TestPhone/1.0"}
    )
    assert r.status_code == 200
    rows = (
        (await db.execute(select(AuditEvent).where(AuditEvent.action == "guest.rsvp")))
        .scalars()
        .all()
    )
    row = rows[-1]
    assert row.actor_user_id is None and row.actor_label.startswith("guest ")
    assert row.detail["user_agent"] == "TestPhone/1.0" and row.detail["via"] == "new"


# ---------------------------------------------------------------------------
# Wishes
# ---------------------------------------------------------------------------


async def test_a_wish_is_shown_or_waits_depending_on_the_hold(
    client: AsyncClient, api: str, gala: dict[str, Any]
) -> None:
    anyone = stranger(client)
    shown = await anyone.post(f"{path(gala, api)}/wishes", json={"text": "Lovely!", "name": "Rani"})
    assert shown.status_code == 200 and shown.json()["state"] == "shown"

    await client.patch(gala["url"], json={"hold_wishes": True})
    waiting = await anyone.post(
        f"{path(gala, api)}/wishes", json={"text": "Hold me", "name": "Rani"}
    )
    assert waiting.json()["state"] == "waiting"

    listed = (await anyone.get(f"{path(gala, api)}/wishes")).json()
    assert [w["text"] for w in listed] == ["Lovely!"]


async def test_a_personal_link_signs_the_wish_with_the_listed_name(
    client: AsyncClient, api: str, gala: dict[str, Any]
) -> None:
    r = await stranger(client).post(
        f"{path(gala, api)}/wishes",
        json={"text": "Congrats", "name": "ignored"},
        headers={"X-Guest-Token": gala["dewi"]["link_token"]},
    )
    assert r.status_code == 200 and r.json()["wish"]["name"] == "Dewi Wijaya"


async def test_a_bad_link_is_just_an_anonymous_caller_who_must_name_themselves(
    client: AsyncClient, api: str, gala: dict[str, Any]
) -> None:
    anyone = stranger(client)
    bad = {"X-Guest-Token": "garbage"}
    r = await anyone.post(
        f"{path(gala, api)}/wishes", json={"text": "Hi", "name": "Sam"}, headers=bad
    )
    assert r.status_code == 200 and r.json()["wish"]["name"] == "Sam"

    nameless = await anyone.post(f"{path(gala, api)}/wishes", json={"text": "Hi"}, headers=bad)
    assert nameless.status_code == 422 and nameless.json()["code"] == "invalid"


async def test_wish_limits_and_duplicates_have_their_own_codes(
    client: AsyncClient, api: str, gala: dict[str, Any]
) -> None:
    anyone = stranger(client)
    wish = f"{path(gala, api)}/wishes"
    await anyone.post(wish, json={"text": "One", "name": "Kim"})
    dup = await anyone.post(wish, json={"text": "One", "name": "Kim"})
    assert dup.status_code == 409 and dup.json()["code"] == "duplicate"

    await anyone.post(wish, json={"text": "Two", "name": "Kim"})
    await anyone.post(wish, json={"text": "Three", "name": "Kim"})
    over = await anyone.post(wish, json={"text": "Four", "name": "Kim"})
    assert over.status_code == 409 and over.json()["code"] == "limit"


async def test_an_overlong_wish_is_refused_and_a_trap_field_stores_nothing(
    client: AsyncClient, api: str, gala: dict[str, Any]
) -> None:
    anyone = stranger(client)
    wish = f"{path(gala, api)}/wishes"
    long = await anyone.post(wish, json={"text": "w" * 900, "name": "Kim"})
    assert long.status_code == 422 and "wwww" not in long.text

    trap = await anyone.post(wish, json={"text": "spam", "name": "Bot", "website": "x"})
    assert trap.status_code == 200 and trap.json()["state"] is None
    assert (await anyone.get(wish)).json() == []


async def test_a_wish_is_audited_and_throttled(
    client: AsyncClient, api: str, gala: dict[str, Any], db: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:  # fmt: skip
    anyone = stranger(client)
    wish = f"{path(gala, api)}/wishes"
    await anyone.post(wish, json={"text": "Audited", "name": "Kim"})
    rows = (
        (await db.execute(select(AuditEvent).where(AuditEvent.action == "guest.wish")))
        .scalars()
        .all()
    )
    assert rows and rows[0].actor_user_id is None and rows[0].actor_label == "anonymous"

    monkeypatch.setattr(public, "wish_throttle", tiny(1))
    codes = [
        (await anyone.post(wish, json={"text": f"w{i}", "name": "Z"})).status_code for i in range(3)
    ]
    assert codes[-1] == 429
