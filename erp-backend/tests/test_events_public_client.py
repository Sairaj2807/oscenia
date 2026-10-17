"""The client's edit link over HTTP: what the key lets them do, and what it never does."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from test_events_public import stranger

from app.core import links
from app.core.throttle import Throttle
from app.domain.audit.models import AuditEvent
from app.domain.events import attendance, public, service

NOW = datetime(2026, 7, 26, 9, 0, tzinfo=ZoneInfo("Asia/Jakarta"))


@pytest.fixture
async def draft(client: AsyncClient, api: str) -> dict[str, Any]:
    """A draft (never published) with a template, one listed guest and the client's key."""
    ev = (await client.post(f"{api}/events", json={"name": "Wedding", "date": "2026-09-12"})).json()
    url = f"{api}/events/{ev['id']}"
    await client.put(f"{url}/invite/template", json={"template_id": "royal"})
    await client.post(
        f"{url}/guests",
        json={"guests": [{"name": "Dewi Wijaya", "phone": "0812 1100 2200", "table": "VIP 1"}]},
    )
    key = (await client.get(f"{url}/client-link")).json()["token"]
    return {"id": ev["id"], "no": ev["event_no"], "url": url, "key": key}


def c(api: str, ev: dict[str, Any], tail: str = "") -> str:
    return f"{api}/public/client/{ev['no']}{tail}"


def keyed(key: str) -> dict[str, str]:
    return {"X-Client-Key": key}


async def test_the_key_opens_the_clients_working_view(
    client: AsyncClient, api: str, draft: dict[str, Any]
) -> None:
    r = await stranger(client).get(c(api, draft), headers=keyed(draft["key"]))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["event"]["name"] == "Wedding" and body["draft"]["invite"]["template_id"] == "royal"
    assert body["draft"]["review"]["state"] == "editing"
    guest = body["guests"][0]
    assert guest["name"] == "Dewi Wijaya" and guest["token"] and guest["phone"]
    for staff_only in ("table", "note", "rsvp", "on_master_list", "email"):
        assert staff_only not in guest, staff_only
    assert r.headers["cache-control"] == "no-store"


async def test_a_missing_forged_expired_or_revoked_key_is_one_refusal(
    client: AsyncClient, api: str, draft: dict[str, Any], db: AsyncSession
) -> None:
    anyone = stranger(client)
    good = draft["key"]
    forged = good[:-3] + ("AAA" if not good.endswith("AAA") else "BBB")
    refusals = []
    for headers in ({}, keyed(""), keyed("garbage"), keyed(forged), keyed("x" * 400)):
        r = await anyone.get(c(api, draft), headers=headers)
        assert r.status_code == 403, headers
        refusals.append(r.json()["detail"])
    unknown = await anyone.get(f"{api}/public/client/EV-9999", headers=keyed(good))
    assert unknown.status_code == 403
    assert {*refusals, unknown.json()["detail"]} == {public.CLIENT_REFUSED}, "no hint which"

    event = await service.get_event(db, uuid.UUID(draft["id"]))
    stale = links.issue(
        service.CLIENT_LINK_PURPOSE, str(event.id), event.edit_link_version,
        ttl_seconds=10, now=int(NOW.timestamp()) - 10 * 86400,
    )  # fmt: skip
    assert (await anyone.get(c(api, draft), headers=keyed(stale))).status_code == 403, "expired"

    regenerated = await client.post(f"{draft['url']}/client-link/regenerate")
    new_key = regenerated.json()["token"]
    assert (await anyone.get(c(api, draft), headers=keyed(good))).status_code == 403, "revoked"
    assert (await anyone.get(c(api, draft), headers=keyed(new_key))).status_code == 200


async def test_a_key_opens_only_its_own_event(
    client: AsyncClient, api: str, draft: dict[str, Any]
) -> None:
    other = (
        await client.post(f"{api}/events", json={"name": "Other", "date": "2026-10-01"})
    ).json()
    r = await stranger(client).get(
        f"{api}/public/client/{other['event_no']}", headers=keyed(draft["key"])
    )
    assert r.status_code == 403


async def test_the_client_designs_and_staff_see_it(
    client: AsyncClient, api: str, draft: dict[str, Any]
) -> None:
    anyone = stranger(client)
    h = keyed(draft["key"])
    assert (
        await anyone.put(c(api, draft, "/template"), json={"template_id": "garden"}, headers=h)
    ).status_code == 200
    assert (
        await anyone.put(c(api, draft, "/sections/story"), json={"on": False}, headers=h)
    ).status_code == 200
    assert (
        await anyone.put(c(api, draft, "/accent"), json={"accent": "#aa5500"}, headers=h)
    ).status_code == 200

    detail = (await client.get(draft["url"])).json()["invite"]
    cover = {**detail["content"]["cover"], "title": "Rani and Budi"}
    r = await anyone.put(c(api, draft, "/content/cover"), json={"value": cover}, headers=h)
    assert r.status_code == 200 and r.json()["has_unpublished_changes"] is False

    staff = (await client.get(draft["url"])).json()["invite"]
    assert staff["template_id"] == "garden" and staff["accent"] == "#aa5500"
    assert staff["on"]["story"] is False and staff["content"]["cover"]["title"] == "Rani and Budi"


async def test_content_keys_reach_the_server_as_written(
    client: AsyncClient, api: str, draft: dict[str, Any]
) -> None:
    details = (await client.get(draft["url"])).json()["invite"]["content"]["details"]
    details["mapUrl"] = "https://maps.example/venue"
    r = await stranger(client).put(
        c(api, draft, "/content/details"), json={"value": details}, headers=keyed(draft["key"])
    )
    assert r.status_code == 200
    saved = (await client.get(draft["url"])).json()["invite"]["content"]["details"]
    assert saved["mapUrl"] == "https://maps.example/venue" and "map_url" not in saved


async def test_bad_design_input_is_refused(
    client: AsyncClient, api: str, draft: dict[str, Any]
) -> None:
    anyone, h = stranger(client), keyed(draft["key"])
    unknown = await anyone.put(c(api, draft, "/template"), json={"template_id": "nope"}, headers=h)
    assert unknown.status_code == 422
    required = await anyone.put(c(api, draft, "/sections/rsvp"), json={"on": False}, headers=h)
    assert required.status_code == 422, "a required section cannot be switched off"
    bad_hex = await anyone.put(c(api, draft, "/accent"), json={"accent": "red"}, headers=h)
    assert bad_hex.status_code == 422


async def test_submitting_records_the_client_and_needs_a_template(
    client: AsyncClient, api: str, draft: dict[str, Any]
) -> None:
    r = await stranger(client).post(c(api, draft, "/submit"), headers=keyed(draft["key"]))
    assert r.status_code == 200 and r.json()["review"]["state"] == "submitted"
    review = (await client.get(draft["url"])).json()["review"]
    assert review["state"] == "submitted" and review["submitted_by"] == "client"

    fresh = (
        await client.post(f"{api}/events", json={"name": "Blank", "date": "2026-11-01"})
    ).json()
    key = (await client.get(f"{api}/events/{fresh['id']}/client-link")).json()["token"]
    refused = await stranger(client).post(
        f"{api}/public/client/{fresh['event_no']}/submit", headers=keyed(key)
    )
    assert refused.status_code == 409, "nothing to review without a template"


async def test_the_key_cannot_publish_or_reach_staff_routes(
    client: AsyncClient, api: str, draft: dict[str, Any]
) -> None:
    anyone, h = stranger(client), keyed(draft["key"])
    assert (await anyone.post(c(api, draft, "/publish"), headers=h)).status_code in (404, 405)
    assert (await anyone.post(f"{draft['url']}/publish", json={}, headers=h)).status_code == 401
    assert (await anyone.get(f"{draft['url']}/guests", headers=h)).status_code == 401
    assert (
        await anyone.post(f"{draft['url']}/client-link/regenerate", headers=h)
    ).status_code == 401
    detail = (await client.get(draft["url"])).json()
    assert detail["status"] == "Draft"


async def test_the_client_moderates_wishes(
    client: AsyncClient, api: str, draft: dict[str, Any], db: AsyncSession
) -> None:
    anyone, h = stranger(client), keyed(draft["key"])
    await client.put(f"{draft['url']}/invite/template", json={"template_id": "gala"})
    await client.post(f"{draft['url']}/publish", json={})
    eid = uuid.UUID(draft["id"])
    one = await attendance.add_wish(db, eid, text="Nice", name="Rani", now=NOW)

    held = await anyone.put(c(api, draft, "/hold-wishes"), json={"hold": True}, headers=h)
    assert held.status_code == 200 and held.json()["hold_wishes"] is True
    waiting = await attendance.add_wish(db, eid, text="Later", name="Ben", now=NOW)

    view = (await anyone.get(c(api, draft), headers=h)).json()
    states = {w["text"]: w["state"] for w in view["wishes"]}
    assert states == {"Nice": "shown", "Later": "waiting"}

    approved = await anyone.post(c(api, draft, f"/wishes/{waiting.id}/approve"), headers=h)
    assert approved.json()["state"] == "shown"
    hidden = await anyone.post(c(api, draft, f"/wishes/{one.id}/hide"), headers=h)
    assert hidden.json()["state"] == "hidden"
    shown = await anyone.post(c(api, draft, f"/wishes/{one.id}/show"), headers=h)
    assert shown.json()["state"] == "shown"
    bad = await anyone.post(c(api, draft, f"/wishes/{one.id}/delete"), headers=h)
    assert bad.status_code == 422


async def test_marking_a_guest_as_sent_is_recorded_once(
    client: AsyncClient, api: str, draft: dict[str, Any]
) -> None:
    guest_id = (await client.get(f"{draft['url']}/guests")).json()[0]["id"]
    anyone, h = stranger(client), keyed(draft["key"])
    first = await anyone.post(c(api, draft, f"/guests/{guest_id}/sent"), headers=h)
    assert first.status_code == 200 and first.json()["invited_via"] == "client"
    again = await anyone.post(c(api, draft, f"/guests/{guest_id}/sent"), headers=h)
    assert again.json()["invited_at"] == first.json()["invited_at"], "recorded once"

    staff = (await client.get(f"{draft['url']}/guests")).json()[0]
    assert staff["invited_via"] == "client" and staff["invited_at"]
    elsewhere = await anyone.post(c(api, draft, f"/guests/{uuid.uuid4()}/sent"), headers=h)
    assert elsewhere.status_code == 404


async def test_client_edits_are_audited_as_the_client_link(
    client: AsyncClient, api: str, draft: dict[str, Any], db: AsyncSession
) -> None:
    await stranger(client).put(
        c(api, draft, "/accent"), json={"accent": "#112233"},
        headers={**keyed(draft["key"]), "user-agent": "Laptop/1"},
    )  # fmt: skip
    rows = (
        (await db.execute(select(AuditEvent).where(AuditEvent.action == "client.edit")))
        .scalars()
        .all()
    )
    assert rows and rows[-1].actor_user_id is None and rows[-1].actor_label == "client link"
    assert rows[-1].detail["what"] == "accent" and rows[-1].detail["user_agent"] == "Laptop/1"


async def test_guessing_keys_is_rate_limited(
    client: AsyncClient, api: str, draft: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        public, "client_throttle",
        Throttle(f"t-{uuid.uuid4().hex[:8]}", limit=3, window_seconds=60, block_seconds=60),
    )  # fmt: skip
    anyone = stranger(client)
    codes = [
        (await anyone.get(c(api, draft), headers=keyed(f"guess{i}"))).status_code for i in range(6)
    ]
    assert codes[:3] == [403, 403, 403] and codes[-1] == 429
