"""The guest list, custom questions, tables and checkpoints — over HTTP.

Ported from ``verify-proto.mjs`` ("step 5", "R1"–"R7", "R4 table"), plus the server-only
rules: signed personal links, one guest per phone per event, never-reused keys.
"""

from __future__ import annotations

import uuid
from typing import Any

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import links
from app.core.clock import DEMO_TODAY, FrozenClock
from app.domain.events.models import EventScan, Guest
from app.domain.masters.models import Role


async def make_event(client: AsyncClient, api: str, **kw: Any) -> dict[str, Any]:
    r = await client.post(f"{api}/events", json={"name": "Gala", "date": "2026-12-10", **kw})
    assert r.status_code == 201, r.text
    return r.json()


async def add(client: AsyncClient, url: str, *guests: dict[str, Any]) -> dict[str, int]:
    r = await client.post(f"{url}/guests", json={"guests": list(guests)})
    assert r.status_code == 200, r.text
    return r.json()


# ---------------------------------------------------------------------------
# Event settings
# ---------------------------------------------------------------------------


async def test_a_partial_rsvp_fields_patch_changes_only_what_was_sent(
    client: AsyncClient, api: str
) -> None:
    ev = await make_event(client, api)
    r = await client.patch(f"{api}/events/{ev['id']}", json={"rsvp_fields": {"pax": False}})
    assert r.json()["rsvp_fields"] == {"email": True, "allergies": True, "pax": False}


# ---------------------------------------------------------------------------
# Guests
# ---------------------------------------------------------------------------


async def test_adding_and_importing_skip_known_and_invalid_phones(
    client: AsyncClient, api: str
) -> None:
    ev = await make_event(client, api)
    url = f"{api}/events/{ev['id']}"
    first = await add(client, url, {"name": "Dewi Wijaya", "phone": "0812 1100 2200"})
    assert first == {"added": 1, "skipped": 0}

    csv = (
        "Phone,Name,Table,Category\r\n"
        '0811 1111 2222,"Wijaya, Budi",VIP 1,vip\n\n'
        "0811 3333 4444,Sari Dewi,,Press\n"
        "+62 812 1100 2200,Dupe of Dewi,,\n"
        "123,Short,,\n"
        "no-phone-row,,,\n"
    )
    r = await client.post(f"{url}/guests/import", json={"csv": csv})
    assert r.json() == {"added": 2, "skipped": 3}
    again = await client.post(f"{url}/guests/import", json={"csv": csv})
    assert again.json()["added"] == 0, "the same file twice adds nobody"

    guests = (await client.get(f"{url}/guests")).json()
    assert [g["name"] for g in guests] == ["Dewi Wijaya", "Wijaya, Budi", "Sari Dewi"]
    budi = guests[1]
    assert (budi["table"], budi["category"], budi["on_master_list"], budi["rsvp"]) == (
        "VIP 1", "VIP", True, None,
    )  # fmt: skip
    assert guests[2]["category"] == "Regular", "an unknown category reads as Regular"


async def test_one_batch_cannot_add_the_same_phone_twice(client: AsyncClient, api: str) -> None:
    ev = await make_event(client, api)
    url = f"{api}/events/{ev['id']}"
    result = await add(
        client, url,
        {"name": "A", "phone": "0811 5555 0001"},
        {"name": "B", "phone": "+62 811 5555 0001"},
        {"name": "  ", "phone": "0811 5555 0002"},
        {"name": "C", "phone": "1" * 40},
    )  # fmt: skip
    assert result == {"added": 1, "skipped": 3}


async def test_guests_are_scoped_to_their_event(client: AsyncClient, api: str) -> None:
    a = await make_event(client, api)
    b = await make_event(client, api, name="Other")
    await add(client, f"{api}/events/{a['id']}", {"name": "Dewi", "phone": "0812 1100 2200"})
    r = await add(client, f"{api}/events/{b['id']}", {"name": "Dewi", "phone": "0812 1100 2200"})
    assert r["added"] == 1, "the same phone may be a guest of two events"
    guest = (await client.get(f"{api}/events/{a['id']}/guests")).json()[0]
    r = await client.put(f"{api}/events/{b['id']}/guests/{guest['id']}/table", json={"table": "T1"})
    assert r.status_code == 404


async def test_each_guest_has_a_signed_personal_link_and_qr(client: AsyncClient, api: str) -> None:
    ev = await make_event(client, api)
    url = f"{api}/events/{ev['id']}"
    await add(client, url, {"name": "Dewi", "phone": "0812 1100 2200"})
    g = (await client.get(f"{url}/guests")).json()[0]
    claim = links.read("guest", g["link_token"], scope=(ev["id"],))
    assert claim is not None and claim.subject == g["id"] and claim.version == 1
    assert links.read("guest", g["link_token"], scope=(str(uuid.uuid4()),)) is None
    qr = links.parse_qr(g["qr"])
    assert qr is not None and (qr.event_id, qr.guest_id) == (ev["id"], g["id"])
    again = (await client.get(f"{url}/guests")).json()[0]
    assert again["link_token"] == g["link_token"], "staff can copy the same link again"


async def test_table_category_note_and_email(client: AsyncClient, api: str) -> None:
    ev = await make_event(client, api)
    url = f"{api}/events/{ev['id']}"
    await add(client, url, {"name": "Omar", "phone": "0812 7777 2222"})
    gid = (await client.get(f"{url}/guests")).json()[0]["id"]
    g_url = f"{url}/guests/{gid}"

    assert (await client.put(f"{g_url}/table", json={"table": "  VIP-1  "})).json()[
        "table"
    ] == "VIP-1"
    long = (await client.put(f"{g_url}/table", json={"table": "Garden " + "x" * 60})).json()
    assert len(long["table"]) == 30
    assert (await client.put(f"{g_url}/table", json={"table": "   "})).json()["table"] == ""

    assert (await client.put(f"{g_url}/category", json={"category": "Media"})).json()[
        "category"
    ] == "Media"
    assert (await client.put(f"{g_url}/category", json={"category": "Boss"})).status_code == 422

    note = (
        await client.put(f"{g_url}/note", json={"note": "  Called — stuck in traffic  "})
    ).json()
    assert note["note"] == "Called — stuck in traffic" and note["note_by"] == "R. Hartono"
    assert note["note_at"] is not None
    cleared = (await client.put(f"{g_url}/note", json={"note": ""})).json()
    assert cleared["note"] == "" and cleared["note_by"] is None and cleared["note_at"] is None

    assert (await client.put(f"{g_url}/email", json={"email": "omar at home"})).status_code == 422
    assert (await client.put(f"{g_url}/email", json={"email": " omar@home.id "})).json()[
        "email"
    ] == "omar@home.id"
    assert (await client.put(f"{g_url}/email", json={"email": ""})).json()["email"] == ""


# ---------------------------------------------------------------------------
# Questions (R7)
# ---------------------------------------------------------------------------


async def test_the_question_builder(client: AsyncClient, api: str, db: AsyncSession) -> None:
    ev = await make_event(client, api)
    url = f"{api}/events/{ev['id']}/questions"
    r = await client.post(url, json={"type": "dropdown"})
    q1 = r.json()
    assert r.status_code == 201 and q1["key"] == "Q-1" and q1["options"] == ["Option 1", "Option 2"]

    r = await client.patch(
        f"{url}/Q-1",
        json={"label": "Parking?", "options": ["  Yes ", "Yes", "", "No"], "multi": True},
    )
    assert r.json()["options"] == ["Yes", "No"] and r.json()["multi"] is False
    assert (await client.patch(f"{url}/Q-1", json={"type": "text"})).json()["options"] == []
    assert (await client.patch(f"{url}/Q-1", json={"type": "choice"})).json()["options"] == [
        "Option 1",
        "Option 2",
    ]
    assert (await client.patch(f"{url}/Q-1", json={"type": "nope"})).status_code == 422
    for bad in ("toString", "nope"):
        assert (await client.post(url, json={"type": bad})).status_code == 422

    await client.post(url, json={"type": "text"})
    moved = (await client.post(f"{url}/Q-2/move", json={"direction": -1})).json()
    assert [q["key"] for q in moved] == ["Q-2", "Q-1"]
    assert (await client.post(f"{url}/Q-2/move", json={"direction": -1})).status_code == 409

    # A guest answered Q-1; removing it keeps the answer, and Q-1 is never handed out again.
    await add(client, f"{api}/events/{ev['id']}", {"name": "Dewi", "phone": "0812 1100 2200"})
    guest = (
        await db.execute(select(Guest).where(Guest.event_id == uuid.UUID(ev["id"])))
    ).scalar_one()
    guest.answers = {"Q-1": "Yes"}
    await db.flush()
    assert (await client.delete(f"{url}/Q-1")).status_code == 204
    await db.refresh(guest)
    assert guest.answers == {"Q-1": "Yes"}
    assert (await client.post(url, json={"type": "text"})).json()["key"] == "Q-3"

    for _ in range(12):
        await client.post(url, json={"type": "text"})
    detail = (await client.get(f"{api}/events/{ev['id']}")).json()
    assert len(detail["questions"]) == 10
    assert (await client.post(url, json={"type": "text"})).status_code == 409
    assert (await client.delete(f"{url}/Q-99")).status_code == 404


# ---------------------------------------------------------------------------
# Tables and checkpoints (R1)
# ---------------------------------------------------------------------------


async def test_tables(client: AsyncClient, api: str) -> None:
    ev = await make_event(client, api)
    url = f"{api}/events/{ev['id']}/tables"
    assert (await client.post(url, json={"name": " Garden 3 "})).json()[-1] == "Garden 3"
    assert (await client.post(url, json={"name": "T1"})).status_code == 409
    assert (await client.post(url, json={"name": "  "})).status_code == 422


async def test_checkpoints(client: AsyncClient, api: str, db: AsyncSession) -> None:
    ev = await make_event(client, api)
    url = f"{api}/events/{ev['id']}/checkpoints"
    entrance = ev["checkpoints"][0]
    assert (await client.delete(f"{url}/{entrance['id']}")).status_code == 409, "the last one stays"

    booth = (await client.post(url, json={"name": "Photo Booth"})).json()
    assert booth["key"] == "CP-2"
    assert (await client.post(url, json={"name": "photo booth"})).status_code == 409
    r = await client.patch(
        f"{url}/{booth['id']}",
        json={"name": "Photo Wall", "categories": ["Media", "Nope", "Media"]},
    )
    assert r.json()["name"] == "Photo Wall" and r.json()["categories"] == ["Media"]
    r = await client.patch(f"{url}/{booth['id']}", json={"name": "main entrance"})
    assert r.status_code == 409, "a rename cannot clash either"

    # A checkpoint with a scan logged against it cannot be removed.
    await add(client, f"{api}/events/{ev['id']}", {"name": "Dewi", "phone": "0812 1100 2200"})
    guest = (
        await db.execute(select(Guest).where(Guest.event_id == uuid.UUID(ev["id"])))
    ).scalar_one()
    db.add(
        EventScan(
            event_id=guest.event_id,
            guest_id=guest.id,
            checkpoint_id=uuid.UUID(booth["id"]),
            at=FrozenClock(DEMO_TODAY).now(),
        )
    )
    await db.flush()
    assert (await client.delete(f"{url}/{booth['id']}")).status_code == 409

    lounge = (await client.post(url, json={"name": "VIP Lounge"})).json()
    assert lounge["key"] == "CP-3"
    assert (await client.delete(f"{url}/{lounge['id']}")).status_code == 204
    assert (await client.post(url, json={"name": "Garden"})).json()["key"] == "CP-4", (
        "keys are never reused"
    )


async def test_sales_may_work_the_guest_list(client_for: Any, api: str) -> None:
    sales = await client_for(Role.SALES)
    ev = await make_event(sales, api)
    url = f"{api}/events/{ev['id']}"
    assert (await add(sales, url, {"name": "Dewi", "phone": "0812 1100 2200"}))["added"] == 1
    assert (await sales.post(f"{url}/questions", json={"type": "text"})).status_code == 201
