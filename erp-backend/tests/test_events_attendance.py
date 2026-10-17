"""RSVPs, wishes, check-in, walk-ins and the attendance report.

Ported from ``verify-proto.mjs`` ("events action", "wishes", "step 5", "R1", "R3", "R6",
"R7"). ``submit_rsvp`` and ``add_wish`` are called as services — their public routes are
Phase 2 — and everything staff do goes over HTTP.
"""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import links
from app.core.clock import DEMO_TODAY, FrozenClock
from app.core.errors import Conflict, Invalid
from app.domain.events import attendance
from app.domain.events.attendance import RsvpForm
from app.domain.events.models import Guest

NOW = FrozenClock(DEMO_TODAY).now()


@pytest.fixture
async def gala(client: AsyncClient, api: str) -> dict[str, Any]:
    """A published Gala on 14 Aug (RSVPs open until 7 Aug), with two listed guests and a
    required meal question."""
    ev = (await client.post(f"{api}/events", json={"name": "Gala", "date": "2026-08-14"})).json()
    url = f"{api}/events/{ev['id']}"
    await client.put(f"{url}/invite/template", json={"template_id": "gala"})
    q = (await client.post(f"{url}/questions", json={"type": "dropdown"})).json()
    await client.patch(
        f"{url}/questions/{q['key']}",
        json={"label": "Meal", "options": ["Beef", "Fish"], "required": True},
    )
    await client.post(
        f"{url}/guests",
        json={"guests": [
            {"name": "Dewi Wijaya", "phone": "0812 1100 2200", "email": "dewi@x.id",
             "category": "VIP"},
            {"name": "Budi Santoso", "phone": "0812 1100 3300", "email": "budi@x.id"},
        ]},
    )  # fmt: skip
    r = await client.post(f"{url}/publish", json={})
    assert r.status_code == 200, r.text
    guests = (await client.get(f"{url}/guests")).json()
    return {
        "id": uuid.UUID(ev["id"]),
        "url": url,
        "dewi": guests[0],
        "budi": guests[1],
        "detail": r.json(),
    }


async def guest_row(db: AsyncSession, guest_id: str | uuid.UUID) -> Guest:
    g = await db.get(Guest, uuid.UUID(str(guest_id)))
    assert g is not None
    await db.refresh(g)
    return g


def rsvp(**kw: Any) -> RsvpForm:
    base: dict[str, Any] = {"name": "Someone", "phone": "0811 2222 3333", "attending": True,
                            "answers": {"Q-1": "Fish"}}  # fmt: skip
    return RsvpForm(**{**base, **kw})


# ---------------------------------------------------------------------------
# RSVP
# ---------------------------------------------------------------------------


async def test_a_listed_guests_reply_updates_their_row(
    db: AsyncSession, gala: dict[str, Any]
) -> None:
    dewi = gala["dewi"]
    g = await attendance.submit_rsvp(
        db, gala["id"],
        rsvp(name="Someone Else", phone="+62 812-1100-2200", email="", pax=9,
             allergies="Peanuts", consent=True),
        now=NOW, today=DEMO_TODAY,
    )  # fmt: skip
    assert str(g.id) == dewi["id"]
    assert g.name == "Dewi Wijaya" and g.email == "dewi@x.id", "keeps the client's name and email"
    assert g.rsvp == "Attending" and g.pax == 2, "pax capped at the event maximum"
    assert g.consent and g.consent_at == NOW and g.answers == {"Q-1": "Fish"}


async def test_an_unknown_guest_becomes_an_off_list_decline(
    db: AsyncSession, gala: dict[str, Any]
) -> None:
    g = await attendance.submit_rsvp(
        db,
        gala["id"],
        rsvp(name="Forwarded Friend", attending=False, answers={}),
        now=NOW,
        today=DEMO_TODAY,
    )
    assert not g.on_master_list and g.rsvp == "Declined" and g.pax == 0 and not g.consent


async def test_refusals(db: AsyncSession, client: AsyncClient, gala: dict[str, Any]) -> None:
    with pytest.raises(Invalid):
        await attendance.submit_rsvp(db, gala["id"], rsvp(name="  "), now=NOW, today=DEMO_TODAY)
    with pytest.raises(Invalid, match="Meal"):
        await attendance.submit_rsvp(db, gala["id"], rsvp(answers={}), now=NOW, today=DEMO_TODAY)
    with pytest.raises(Conflict):
        await attendance.submit_rsvp(
            db, gala["id"], rsvp(), now=NOW, today=DEMO_TODAY + timedelta(days=13)
        )
    await client.post(f"{gala['url']}/unpublish")
    with pytest.raises(Conflict):
        await attendance.submit_rsvp(db, gala["id"], rsvp(), now=NOW, today=DEMO_TODAY)


async def test_a_big_party_is_accepted_up_to_the_event_cap(
    db: AsyncSession, client: AsyncClient, gala: dict[str, Any]
) -> None:
    await client.patch(gala["url"], json={"max_pax": 20})
    g = await attendance.submit_rsvp(db, gala["id"], rsvp(pax=12), now=NOW, today=DEMO_TODAY)
    assert g.pax == 12
    g = await attendance.submit_rsvp(db, gala["id"], rsvp(pax=40), now=NOW, today=DEMO_TODAY)
    assert g.pax == 20


async def test_a_personal_link_names_the_guest_whatever_phone_they_type(
    db: AsyncSession, client: AsyncClient, gala: dict[str, Any]
) -> None:
    budi = gala["budi"]
    g = await attendance.submit_rsvp(
        db,
        gala["id"],
        rsvp(token=budi["link_token"], phone="0899 0000 0001"),
        now=NOW,
        today=DEMO_TODAY,
    )
    assert str(g.id) == budi["id"] and g.phone == "0899 0000 0001"

    # Bumping the version revokes the link: the old token no longer names Budi.
    g.link_version = 2
    await db.flush()
    stranger = await attendance.submit_rsvp(
        db,
        gala["id"],
        rsvp(token=budi["link_token"], phone="0899 0000 0002"),
        now=NOW,
        today=DEMO_TODAY,
    )
    assert stranger.id != g.id and not stranger.on_master_list


async def test_a_link_cannot_take_another_guests_phone(
    db: AsyncSession, gala: dict[str, Any]
) -> None:
    with pytest.raises(Conflict):
        await attendance.submit_rsvp(
            db, gala["id"], rsvp(token=gala["budi"]["link_token"], phone=gala["dewi"]["phone"]),
            now=NOW, today=DEMO_TODAY,
        )  # fmt: skip


async def test_a_changed_reply_keeps_consent_and_replaces_answers(
    db: AsyncSession, gala: dict[str, Any]
) -> None:
    phone = gala["dewi"]["phone"]
    first = await attendance.submit_rsvp(
        db, gala["id"], rsvp(phone=phone, consent=True), now=NOW, today=DEMO_TODAY
    )
    consented_at = first.consent_at
    later = NOW + timedelta(hours=1)
    again = await attendance.submit_rsvp(
        db,
        gala["id"],
        rsvp(phone=phone, attending=False, answers={}, consent=False),
        now=later,
        today=DEMO_TODAY,
    )
    assert again.rsvp == "Declined" and again.consent and again.consent_at == consented_at
    assert again.answers == {}, "declining clears answers to accept-only questions"


async def test_answers_to_a_removed_question_stay_unseen(
    db: AsyncSession, client: AsyncClient, gala: dict[str, Any]
) -> None:
    phone = gala["dewi"]["phone"]
    await attendance.submit_rsvp(db, gala["id"], rsvp(phone=phone), now=NOW, today=DEMO_TODAY)
    await client.delete(f"{gala['url']}/questions/Q-1")
    g = await attendance.submit_rsvp(
        db, gala["id"], rsvp(phone=phone, answers={}), now=NOW, today=DEMO_TODAY
    )
    assert g.answers == {"Q-1": "Fish"}


async def test_a_reply_matches_the_stored_phone_however_it_is_typed(
    db: AsyncSession, gala: dict[str, Any]
) -> None:
    first = await attendance.submit_rsvp(
        db, gala["id"], rsvp(phone="0811-2222-3333"), now=NOW, today=DEMO_TODAY
    )
    again = await attendance.submit_rsvp(
        db, gala["id"], rsvp(phone="+62 811 2222 3333"), now=NOW, today=DEMO_TODAY
    )
    assert again.id == first.id


async def test_an_overlong_phone_is_refused_not_truncated(
    db: AsyncSession, gala: dict[str, Any]
) -> None:
    padded = "0812-" + "-" * 70 + "1100-2200"
    with pytest.raises(Invalid):
        await attendance.submit_rsvp(db, gala["id"], rsvp(phone=padded), now=NOW, today=DEMO_TODAY)


# ---------------------------------------------------------------------------
# Wishes
# ---------------------------------------------------------------------------


async def wish(db: AsyncSession, gala: dict[str, Any], **kw: Any) -> Any:
    return await attendance.add_wish(db, gala["id"], now=NOW, **kw)


async def test_wishes_rules(db: AsyncSession, client: AsyncClient, gala: dict[str, Any]) -> None:
    w1 = await wish(db, gala, name="  Tamu  ", text="  Selamat!  ")
    assert (w1.name, w1.text, w1.approved) == ("Tamu", "Selamat!", True)

    dewi = gala["dewi"]
    w2 = await wish(db, gala, guest_token=dewi["link_token"], name="Impostor", text="Second note")
    assert w2.name == "Dewi Wijaya", "a personal-link guest signs with their listed name"
    with pytest.raises(Conflict, match="already"):
        await wish(db, gala, guest_token=dewi["link_token"], text="Second note")
    await wish(db, gala, guest_token=dewi["link_token"], text="Third note")
    await wish(db, gala, guest_token=dewi["link_token"], text="Fourth note")
    with pytest.raises(Conflict, match="3"):
        await wish(db, gala, guest_token=dewi["link_token"], text="Fifth note")

    await wish(db, gala, name="TAMU", text="Another")
    await wish(db, gala, name="tamu", text="And another")
    with pytest.raises(Conflict):
        await wish(db, gala, name="Tamu", text="One more")

    with pytest.raises(Invalid):
        await wish(db, gala, name="Blank", text="   ")
    with pytest.raises(Invalid):
        await wish(db, gala, name="  ", text="No name")
    with pytest.raises(Invalid):
        await wish(db, gala, guest_token="G.1.forged", text="Hi")
    long = await wish(db, gala, name="Long", text="x" * 900)
    assert len(long.text) == 500


async def test_a_guest_of_another_event_cannot_sign(
    db: AsyncSession, client: AsyncClient, api: str, gala: dict[str, Any]
) -> None:
    other = (
        await client.post(f"{api}/events", json={"name": "Other", "date": "2026-08-20"})
    ).json()
    await client.post(
        f"{api}/events/{other['id']}/guests",
        json={"guests": [{"name": "X", "phone": "0811 4444 5555"}]},
    )
    token = (await client.get(f"{api}/events/{other['id']}/guests")).json()[0]["link_token"]
    with pytest.raises(Invalid):
        await wish(db, gala, guest_token=token, text="Wrong event")


async def test_moderation_over_http(
    db: AsyncSession, client: AsyncClient, gala: dict[str, Any]
) -> None:
    url = gala["url"]
    shown = await wish(db, gala, name="Tamu", text="Selamat!")
    await client.patch(url, json={"hold_wishes": True})
    held = await wish(db, gala, name="Held", text="Please approve me")
    states = {w["id"]: w["state"] for w in (await client.get(f"{url}/wishes")).json()}
    assert states == {shown.id: "shown", held.id: "waiting"}, "the hold leaves shown wishes up"

    assert (await client.post(f"{url}/wishes/{held.id}/approve")).json()["state"] == "shown"
    waiting = await wish(db, gala, name="Held two", text="Waiting too")
    await client.patch(url, json={"hold_wishes": False})
    assert {w["id"]: w["state"] for w in (await client.get(f"{url}/wishes")).json()}[
        waiting.id
    ] == "shown"

    r = await client.put(f"{url}/wishes/{shown.id}/hidden", json={"hidden": True})
    assert r.json()["state"] == "hidden"
    assert (await client.put(f"{url}/wishes/{shown.id}/hidden", json={"hidden": False})).json()[
        "state"
    ] == "shown"
    assert (await client.post(f"{url}/wishes/999999/approve")).status_code == 404


async def test_wishes_follow_the_published_copy(
    db: AsyncSession, client: AsyncClient, gala: dict[str, Any]
) -> None:
    url = gala["url"]
    await client.put(f"{url}/invite/sections/wishes", json={"on": False})
    assert await wish(db, gala, name="Draft only", text="Still open"), (
        "a draft toggle waits for publish"
    )
    await client.post(f"{url}/publish", json={})
    with pytest.raises(Conflict):
        await wish(db, gala, name="After", text="Section is off now")
    await client.post(f"{url}/unpublish")
    with pytest.raises(Conflict):
        await wish(db, gala, name="Late", text="Unpublished")


# ---------------------------------------------------------------------------
# Check-in
# ---------------------------------------------------------------------------


async def test_check_in_and_undo(client: AsyncClient, gala: dict[str, Any]) -> None:
    g_url = f"{gala['url']}/guests/{gala['dewi']['id']}"
    r = await client.post(f"{g_url}/check-in")
    assert r.status_code == 201 and r.json()["first_arrival"] and r.json()["guest"]["checked_in_at"]
    assert r.json()["checkpoint_name"] == "Main Entrance"
    assert (await client.post(f"{g_url}/check-in")).status_code == 409, (
        "a second tap never overwrites"
    )
    assert (await client.post(f"{g_url}/check-in/undo")).json()["checked_in_at"] is None
    assert (await client.post(f"{g_url}/check-in/undo")).status_code == 409


async def test_checkpoint_scans(client: AsyncClient, gala: dict[str, Any]) -> None:
    url = gala["url"]
    lounge = (await client.post(f"{url}/checkpoints", json={"name": "VIP Lounge"})).json()
    await client.patch(f"{url}/checkpoints/{lounge['id']}", json={"categories": ["VIP"]})
    booth = (await client.post(f"{url}/checkpoints", json={"name": "Photo Booth"})).json()
    budi = gala["budi"]

    first = (
        await client.post(
            f"{url}/scans", json={"guest_id": budi["id"], "checkpoint_id": lounge["id"]}
        )
    ).json()
    assert first["first_arrival"] and not first["admitted"], "logged even when not admitted"
    arrived = first["guest"]["checked_in_at"]
    for _ in range(2):
        r = (
            await client.post(
                f"{url}/scans", json={"guest_id": budi["id"], "checkpoint_id": booth["id"]}
            )
        ).json()
    assert r["repeat_here"] and not r["first_arrival"] and r["guest"]["checked_in_at"] == arrived
    vip = (
        await client.post(
            f"{url}/scans", json={"guest_id": gala["dewi"]["id"], "checkpoint_id": lounge["id"]}
        )
    ).json()
    assert vip["admitted"]

    unknown = {"guest_id": budi["id"], "checkpoint_id": str(uuid.uuid4())}
    assert (await client.post(f"{url}/scans", json=unknown)).status_code == 404
    assert (await client.post(f"{url}/scans", json={})).status_code == 422

    undo = f"{url}/guests/{budi['id']}/check-in/undo"
    assert (await client.post(undo)).json()["checked_in_at"] == arrived, (
        "undo removes only the latest scan"
    )
    await client.post(undo)
    assert (await client.post(undo)).json()["checked_in_at"] is None, "the last undo un-arrives"
    log = (await client.get(f"{url}/scans")).json()
    assert [s["guest_id"] for s in log] == [gala["dewi"]["id"]]
    assert (await client.delete(f"{url}/checkpoints/{lounge['id']}")).status_code == 409


async def test_qr_scans_check_the_signature_event_and_version(
    db: AsyncSession, client: AsyncClient, api: str, gala: dict[str, Any]
) -> None:
    url, dewi = gala["url"], gala["dewi"]
    r = await client.post(f"{url}/scans", json={"qr": dewi["qr"]})
    assert r.status_code == 201 and r.json()["guest"]["id"] == dewi["id"]

    other = (
        await client.post(f"{api}/events", json={"name": "Other", "date": "2026-08-20"})
    ).json()
    assert (
        await client.post(f"{api}/events/{other['id']}/scans", json={"qr": dewi["qr"]})
    ).status_code == 422
    legacy = f"OSCENIA:EV-01:{dewi['id']}"
    assert (await client.post(f"{url}/scans", json={"qr": legacy})).status_code == 422
    forged = links.qr_payload(str(gala["id"]), dewi["id"], 1)[:-2] + "AA"
    assert (await client.post(f"{url}/scans", json={"qr": forged})).status_code == 422

    (await guest_row(db, dewi["id"])).link_version = 2
    await db.flush()
    assert (await client.post(f"{url}/scans", json={"qr": dewi["qr"]})).status_code == 422, (
        "a revoked card"
    )


async def test_walk_ins(client: AsyncClient, gala: dict[str, Any]) -> None:
    url = gala["url"]
    budi = gala["budi"]
    r = (
        await client.post(
            f"{url}/walk-ins",
            json={"name": "Typed Differently", "phone": budi["phone"], "consent": True},
        )
    ).json()
    assert not r["walk_in"] and r["guest"]["id"] == budi["id"] and r["guest"]["checked_in_at"]
    assert r["guest"]["name"] == "Budi Santoso" and r["guest"]["consent"]
    again = (
        await client.post(
            f"{url}/walk-ins", json={"name": "Budi", "phone": budi["phone"], "consent": False}
        )
    ).json()
    assert again["guest"]["consent"], "an unticked box never withdraws earlier consent"

    new = (
        await client.post(
            f"{url}/walk-ins", json={"name": "New Face", "phone": "0819 8888 7777", "consent": True}
        )
    ).json()
    g = new["guest"]
    assert (
        new["walk_in"]
        and g["walk_in"]
        and not g["on_master_list"]
        and g["checked_in_at"]
        and g["consent_at"]
    )
    assert (await client.post(f"{url}/guests/{g['id']}/check-in/undo")).status_code == 409
    assert (
        await client.post(f"{url}/walk-ins", json={"name": "x", "phone": "12"})
    ).status_code == 422

    await client.post(f"{url}/unpublish")
    assert (
        await client.post(f"{url}/walk-ins", json={"name": "Late", "phone": "0819 1234 5678"})
    ).status_code == 409


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------


async def test_the_report_fills_every_cell(
    db: AsyncSession, client: AsyncClient, gala: dict[str, Any]
) -> None:
    url, dewi, budi = gala["url"], gala["dewi"], gala["budi"]
    await attendance.submit_rsvp(
        db, gala["id"], rsvp(phone=dewi["phone"], pax=2), now=NOW, today=DEMO_TODAY
    )
    await attendance.submit_rsvp(
        db,
        gala["id"],
        rsvp(phone="0811 0000 0001", answers={"Q-1": "Beef"}),
        now=NOW,
        today=DEMO_TODAY,
    )
    await client.post(f"{url}/guests/{dewi['id']}/check-in")
    walk = (
        await client.post(f"{url}/walk-ins", json={"name": "Walker", "phone": "0819 1234 5678"})
    ).json()

    report = (await client.get(f"{url}/report")).json()
    grid = report["grid"]
    assert grid["rsvp_came"] == [dewi["id"]]
    assert len(grid["rsvp_no_show"]) == 1
    assert grid["no_rsvp_came"] == [walk["guest"]["id"]]
    assert grid["no_rsvp_no_show"] == [budi["id"]]
    s = report["stats"]
    assert (s["invited"], s["attending"], s["checked_in"], s["walk_ins"], s["off_list"]) == (
        2,
        2,
        2,
        1,
        1,
    )
    meal = report["answers"][0]
    assert (
        meal["label"] == "Meal"
        and meal["counts"] == {"Beef": 1, "Fish": 1}
        and meal["no_answer"] == 0
    )
    assert report["checkpoints"][0]["scans"] == 2

    rows = (await db.execute(select(Guest).where(Guest.event_id == gala["id"]))).scalars().all()
    assert len(rows) == 4


# ---------------------------------------------------------------------------
# Ids from another event
# ---------------------------------------------------------------------------


async def test_checkpoints_and_wishes_of_another_event_are_not_found(
    db: AsyncSession, client: AsyncClient, api: str, gala: dict[str, Any]
) -> None:
    other = (
        await client.post(f"{api}/events", json={"name": "Other", "date": "2026-08-20"})
    ).json()
    foreign_cp = other["checkpoints"][0]["id"]
    url = gala["url"]
    scan = {"guest_id": gala["dewi"]["id"], "checkpoint_id": foreign_cp}
    assert (await client.post(f"{url}/scans", json=scan)).status_code == 404
    assert (
        await client.patch(f"{url}/checkpoints/{foreign_cp}", json={"name": "Mine"})
    ).status_code == 404
    assert (await client.delete(f"{url}/checkpoints/{foreign_cp}")).status_code == 404

    w = await attendance.add_wish(db, gala["id"], name="Tamu", text="Selamat!", now=NOW)
    o = f"{api}/events/{other['id']}"
    assert (await client.put(f"{o}/wishes/{w.id}/hidden", json={"hidden": True})).status_code == 404
    assert (await client.post(f"{o}/wishes/{w.id}/approve")).status_code == 404


async def test_a_staff_walk_in_leaves_an_audit_row_naming_who_registered_them(
    client: AsyncClient, api: str, db: AsyncSession
) -> None:
    from sqlalchemy import select

    from app.domain.audit.models import AuditEvent

    ev = (await client.post(f"{api}/events", json={"name": "Desk", "date": "2026-08-14"})).json()
    await client.put(f"{api}/events/{ev['id']}/invite/template", json={"template_id": "gala"})
    assert (await client.post(f"{api}/events/{ev['id']}/publish", json={})).status_code == 200
    r = await client.post(
        f"{api}/events/{ev['id']}/walk-ins",
        json={"name": "Walker W", "phone": "0813 4444 5555", "email": "", "consent": False},
    )
    assert r.status_code == 201 and r.json()["walk_in"] is True
    rows = (
        (await db.execute(select(AuditEvent).where(AuditEvent.action == "walkin.register")))
        .scalars()
        .all()
    )
    assert rows and rows[-1].actor_user_id is not None and rows[-1].after == {"walk_in": True}
    assert "Walker" not in str(rows[-1].detail), "no name or phone in the audit row"
