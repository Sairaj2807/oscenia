# ruff: noqa: F811  (the `gala` fixture is imported, then named as a test argument)
"""A guest takes back what they gave: stop the marketing consent, or erase their personal data.

The row stays (anonymised) so the headcount, the report and the door's history do not change;
the audit log is append-only, so the new row holds ids and counts only."""

from __future__ import annotations

from typing import Any

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from test_events_public import gala, path, stranger  # noqa: F401  (gala is a fixture)

from app.domain.audit.models import AuditEvent
from app.domain.masters.models import Role


async def reply(client: AsyncClient, api: str, gala: dict[str, Any], **kw: Any) -> dict[str, Any]:
    """Dewi replies on her own link, ticking the marketing box, and leaves a wish."""
    token = gala["dewi"]["link_token"]
    body = {
        "name": "Dewi", "phone": "0812 1100 2200", "email": "dewi@x.id", "attending": True,
        "pax": 2, "allergies": "peanuts", "consent": True, **kw,
    }  # fmt: skip
    anyone = stranger(client)
    r = await anyone.post(f"{path(gala, api)}/rsvp", json=body, headers={"X-Guest-Token": token})
    assert r.status_code == 200, r.text
    w = await anyone.post(
        f"{path(gala, api)}/wishes",
        json={"text": "Congratulations"},
        headers={"X-Guest-Token": token},
    )
    assert w.status_code == 200, w.text
    return r.json()["guest"]


async def dewi_row(client: AsyncClient, gala: dict[str, Any]) -> dict[str, Any]:
    rows = (await client.get(f"{gala['url']}/guests")).json()
    return next(g for g in rows if g["id"] == gala["dewi"]["id"])


async def test_a_guest_can_stop_the_marketing_consent_and_keep_their_reply(
    client: AsyncClient, api: str, gala: dict[str, Any]
) -> None:
    own = await reply(client, api, gala)
    assert (await dewi_row(client, gala))["consent"] is True

    r = await stranger(client).post(
        f"{path(gala, api)}/withdraw", json={"scope": "marketing"},
        headers={"X-Guest-Token": own["token"]},
    )  # fmt: skip
    assert r.status_code == 200 and r.json() == {"scope": "marketing", "done": True}
    assert r.headers["cache-control"] == "no-store"

    row = await dewi_row(client, gala)
    assert row["consent"] is False and row["consent_at"] is None
    assert row["rsvp"] == "Attending" and row["name"] == "Dewi Wijaya", "the reply stays"
    assert row["erased_at"] is None


async def test_withdrawing_twice_records_one_audit_row(
    client: AsyncClient, api: str, gala: dict[str, Any], db: AsyncSession
) -> None:
    own = await reply(client, api, gala)
    for _ in range(2):
        r = await stranger(client).post(
            f"{path(gala, api)}/withdraw", json={"scope": "marketing"},
            headers={"X-Guest-Token": own["token"]},
        )  # fmt: skip
        assert r.status_code == 200
    rows = (
        (await db.execute(select(AuditEvent).where(AuditEvent.action == "guest.consent_withdraw")))
        .scalars()
        .all()
    )
    assert len(rows) == 1


async def test_a_guest_can_erase_their_data_and_the_numbers_do_not_move(
    client: AsyncClient, api: str, gala: dict[str, Any], db: AsyncSession
) -> None:
    own = await reply(client, api, gala)
    before = (await client.get(f"{gala['url']}/report")).json()["stats"]

    r = await stranger(client).post(
        f"{path(gala, api)}/withdraw", json={"scope": "all"},
        headers={"X-Guest-Token": own["token"]},
    )  # fmt: skip
    assert r.status_code == 200, r.text

    row = await dewi_row(client, gala)
    assert row["name"] == "Erased guest" and row["erased_at"] is not None
    for blank in ("phone", "email", "allergies", "note"):
        assert row[blank] == "", blank
    assert row["answers"] == {} and row["consent"] is False and row["consent_at"] is None
    assert row["rsvp"] == "Attending" and row["pax"] == 2, "the headcount is kept"
    assert row["table"] == "VIP 1", "where they sat is kept"

    after = (await client.get(f"{gala['url']}/report")).json()["stats"]
    # Everything but the allergy count: those are personal (and may be health) data, so they go.
    assert {**after, "allergies": 0} == {**before, "allergies": 0}, "the numbers do not move"
    assert before["allergies"] == 1 and after["allergies"] == 0

    wishes = (await client.get(f"{gala['url']}/wishes")).json()
    assert all(w["guest_id"] != gala["dewi"]["id"] for w in wishes), "their wishes are gone"

    audit = (
        (await db.execute(select(AuditEvent).where(AuditEvent.action == "guest.erase")))
        .scalars()
        .all()
    )
    assert len(audit) == 1 and audit[0].actor_label == f"guest {gala['dewi']['id']}"
    text = str((audit[0].detail, audit[0].before, audit[0].after))
    for personal in ("Dewi", "0812", "dewi@x.id", "peanuts"):
        assert personal not in text, f"{personal!r} was written into the audit row"


async def test_the_old_link_stops_working_after_erasure_and_the_phone_is_free_again(
    client: AsyncClient, api: str, gala: dict[str, Any]
) -> None:
    own = await reply(client, api, gala)
    anyone = stranger(client)
    await anyone.post(
        f"{path(gala, api)}/withdraw",
        json={"scope": "all"},
        headers={"X-Guest-Token": own["token"]},
    )

    page = await anyone.get(path(gala, api), headers={"X-Guest-Token": own["token"]})
    assert page.json()["guest"] is None, "the personal link names nobody now"
    again = await anyone.post(
        f"{path(gala, api)}/withdraw",
        json={"scope": "all"},
        headers={"X-Guest-Token": own["token"]},
    )
    assert again.status_code == 404

    fresh = await anyone.post(
        f"{path(gala, api)}/rsvp",
        json={"name": "Dewi", "phone": "0812 1100 2200", "attending": True, "pax": 1},
    )
    assert fresh.status_code == 200 and fresh.json()["guest"]["id"] != gala["dewi"]["id"]


async def test_without_a_valid_link_there_is_nothing_to_withdraw(
    client: AsyncClient, api: str, gala: dict[str, Any]
) -> None:
    anyone = stranger(client)
    for headers in ({}, {"X-Guest-Token": "garbage"}):
        r = await anyone.post(f"{path(gala, api)}/withdraw", json={"scope": "all"}, headers=headers)
        assert r.status_code == 404, headers
    assert (await dewi_row(client, gala))["erased_at"] is None
    assert (
        await anyone.post(f"{path(gala, api)}/withdraw", json={"scope": "x"})
    ).status_code == 422


async def test_erasing_one_guest_leaves_the_others_alone(
    client: AsyncClient, api: str, gala: dict[str, Any]
) -> None:
    own = await reply(client, api, gala)
    await stranger(client).post(
        f"{path(gala, api)}/withdraw",
        json={"scope": "all"},
        headers={"X-Guest-Token": own["token"]},
    )
    budi = next(
        g
        for g in (await client.get(f"{gala['url']}/guests")).json()
        if g["name"].startswith("Budi")
    )
    assert budi["phone"] and budi["erased_at"] is None


async def test_staff_can_erase_a_guest_on_their_request_and_only_publishers(
    client: AsyncClient, client_for: Any, api: str, gala: dict[str, Any]
) -> None:
    sales = await client_for(Role.SALES)
    denied = await sales.post(f"{gala['url']}/guests/{gala['budi']['id']}/erase")
    assert denied.status_code == 403

    ceo = await client_for(Role.CEO)
    r = await ceo.post(f"{gala['url']}/guests/{gala['budi']['id']}/erase")
    assert r.status_code == 200 and r.json()["name"] == "Erased guest" and r.json()["phone"] == ""
    again = await ceo.post(f"{gala['url']}/guests/{gala['budi']['id']}/erase")
    assert again.status_code == 200, "erasing again is harmless"

    edit = await ceo.put(f"{gala['url']}/guests/{gala['budi']['id']}/note", json={"note": "x"})
    assert edit.status_code == 409, "an erased guest cannot be edited"
