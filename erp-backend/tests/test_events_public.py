"""The public (no login) routes for guests: what they may see, and what they may not.

A second, signed-out HTTP client shares the staff client's transport, so a test can set an
event up as staff and then read it as a stranger would.
"""

from __future__ import annotations

import json
import uuid
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.throttle import Throttle
from app.domain.events import attendance, public
from app.domain.events.models import Guest


def stranger(staff: AsyncClient) -> AsyncClient:
    """A client with no credentials, on the same app and database as ``staff``."""
    return AsyncClient(transport=staff._transport, base_url="http://test")  # noqa: SLF001


@pytest.fixture
async def gala(client: AsyncClient, api: str) -> dict[str, Any]:
    """A published gala with two listed guests."""
    ev = (await client.post(f"{api}/events", json={"name": "Gala", "date": "2026-08-14"})).json()
    url = f"{api}/events/{ev['id']}"
    await client.put(f"{url}/invite/template", json={"template_id": "gala"})
    await client.post(
        f"{url}/guests",
        json={"guests": [
            {"name": "Dewi Wijaya", "phone": "0812 1100 2200", "email": "dewi@x.id",
             "category": "VIP", "table": "VIP 1"},
            {"name": "Budi Santoso", "phone": "0812 1100 3300", "email": "budi@x.id"},
        ]},
    )  # fmt: skip
    assert (await client.post(f"{url}/publish", json={})).status_code == 200
    guests = (await client.get(f"{url}/guests")).json()
    return {"id": ev["id"], "no": ev["event_no"], "url": url, "dewi": guests[0], "budi": guests[1]}


def path(gala: dict[str, Any], api: str) -> str:
    return f"{api}/public/invites/{gala['no']}"


async def test_a_published_invitation_can_be_read_without_logging_in(
    client: AsyncClient, api: str, gala: dict[str, Any]
) -> None:
    r = await stranger(client).get(path(gala, api))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["event"]["name"] == "Gala" and body["event"]["event_no"] == gala["no"]
    assert body["event"]["rsvp_open"] is True and body["event"]["is_past"] is False
    assert body["invite"]["template_id"] == "gala"
    assert body["template"] is None, "a built-in template is the page's own, not shipped"
    assert body["guest"] is None
    assert r.headers["cache-control"] == "no-store"


async def test_nothing_about_other_guests_or_staff_ever_leaves(
    client: AsyncClient, api: str, gala: dict[str, Any]
) -> None:
    text = (await stranger(client).get(path(gala, api))).text
    secrets = ("Dewi", "Budi", "0812", "VIP 1", "dewi@x.id", "link_token", "OSC1:", "edit_link")
    for secret in secrets:
        assert secret not in text, f"{secret!r} leaked to an anonymous reader"


async def test_the_draft_is_never_shown_only_what_was_published(
    client: AsyncClient, api: str, gala: dict[str, Any]
) -> None:
    detail = (await client.get(gala["url"])).json()
    cover = {**detail["invite"]["content"]["cover"], "title": "DRAFT ONLY TITLE"}
    r = await client.put(f"{gala['url']}/invite/content/cover", json={"value": cover})
    assert r.status_code == 200

    public_text = (await stranger(client).get(path(gala, api))).text
    assert "DRAFT ONLY TITLE" not in public_text
    assert "Gala" in public_text


@pytest.mark.parametrize("event_no", ["EV-9999", "EV-1; DROP TABLE events", "nonsense", "ev-01"])
async def test_an_unknown_event_is_the_same_404_as_an_unpublished_one(
    client: AsyncClient, api: str, gala: dict[str, Any], event_no: str
) -> None:
    anyone = stranger(client)
    await client.post(f"{gala['url']}/unpublish")
    unpublished = await anyone.get(path(gala, api))
    unknown = await anyone.get(f"{api}/public/invites/{event_no}")

    assert unpublished.status_code == unknown.status_code == 404
    assert unpublished.json()["detail"] == unknown.json()["detail"], "no hint which it was"


async def test_a_draft_that_was_never_published_is_not_there_either(
    client: AsyncClient, api: str
) -> None:
    ev = (await client.post(f"{api}/events", json={"name": "Quiet", "date": "2026-12-01"})).json()
    r = await stranger(client).get(f"{api}/public/invites/{ev['event_no']}")
    assert r.status_code == 404


async def test_a_personal_link_shows_only_that_guests_own_row(
    client: AsyncClient, api: str, gala: dict[str, Any]
) -> None:
    anyone = stranger(client)
    r = await anyone.get(path(gala, api), headers={"X-Guest-Token": gala["dewi"]["link_token"]})
    assert r.status_code == 200
    own = r.json()["guest"]
    assert own["name"] == "Dewi Wijaya" and own["token"] == gala["dewi"]["link_token"]
    assert own["qr"].startswith("OSC1:")
    for hidden in ("table", "category", "note", "on_master_list", "link_version"):
        assert hidden not in own, f"{hidden} is a staff field"
    assert "Budi" not in r.text


async def test_a_forged_or_malformed_token_is_just_not_a_guest(
    client: AsyncClient, api: str, gala: dict[str, Any]
) -> None:
    anyone = stranger(client)
    real = gala["dewi"]["link_token"]
    forged = real[:-4] + ("AAAA" if not real.endswith("AAAA") else "BBBB")
    for token in (forged, "garbage", "a.b.c", "x" * 500, ""):
        r = await anyone.get(path(gala, api), headers={"X-Guest-Token": token})
        assert r.status_code == 200, token
        assert r.json()["guest"] is None, token


async def test_a_revoked_personal_link_stops_naming_the_guest(
    client: AsyncClient, api: str, gala: dict[str, Any], db: AsyncSession
) -> None:
    token = gala["dewi"]["link_token"]
    guest = await db.get(Guest, uuid.UUID(gala["dewi"]["id"]))
    assert guest is not None
    guest.link_version += 1
    await db.flush()

    r = await stranger(client).get(path(gala, api), headers={"X-Guest-Token": token})
    assert r.status_code == 200 and r.json()["guest"] is None


async def test_only_the_wishes_guests_may_see_are_listed(
    client: AsyncClient, api: str, gala: dict[str, Any], db: AsyncSession
) -> None:
    from datetime import datetime
    from zoneinfo import ZoneInfo

    now = datetime(2026, 7, 26, 9, 0, tzinfo=ZoneInfo("Asia/Jakarta"))
    eid = uuid.UUID(gala["id"])
    await attendance.add_wish(db, eid, text="Congratulations!", name="Rani", now=now)
    hidden = await attendance.add_wish(db, eid, text="Rude words", name="Troll", now=now)
    await client.put(f"{gala['url']}/wishes/{hidden.id}/hidden", json={"hidden": True})
    await client.patch(gala["url"], json={"hold_wishes": True})
    await attendance.add_wish(db, eid, text="Waiting for approval", name="Late", now=now)

    wishes = (await stranger(client).get(path(gala, api))).json()["wishes"]
    assert [w["text"] for w in wishes] == ["Congratulations!"]
    assert set(wishes[0]) == {"id", "name", "text", "at"}, "no guest id, no moderation flags"


async def test_links_in_published_content_are_made_safe(
    client: AsyncClient, api: str, gala: dict[str, Any]
) -> None:
    details = (await client.get(gala["url"])).json()["invite"]["content"]["details"]
    details["mapUrl"] = "javascript:alert(1)"
    await client.put(f"{gala['url']}/invite/content/details", json={"value": details})
    await client.post(f"{gala['url']}/publish", json={})

    content = (await stranger(client).get(path(gala, api))).json()["invite"]["content"]
    assert content["details"]["mapUrl"] == ""


async def test_a_flood_of_reads_is_refused_with_a_retry_after(
    client: AsyncClient, api: str, gala: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        public, "read_throttle",
        Throttle(f"t-{uuid.uuid4().hex[:8]}", limit=2, window_seconds=60, block_seconds=60),
    )  # fmt: skip
    anyone = stranger(client)
    codes = [(await anyone.get(path(gala, api))).status_code for _ in range(4)]
    assert codes[:2] == [200, 200] and codes[-1] == 429

    refused = await anyone.get(path(gala, api))
    assert refused.status_code == 429 and int(refused.headers["retry-after"]) >= 1


async def test_a_huge_public_request_is_refused_before_it_is_read(
    client: AsyncClient, api: str, gala: dict[str, Any]
) -> None:
    anyone = stranger(client)
    big = json.dumps({"x": "a" * (300 * 1024)})
    r = await anyone.post(f"{api}/public/invites/{gala['no']}/rsvp", content=big,
                          headers={"content-type": "application/json"})  # fmt: skip
    assert r.status_code == 413

    small = await anyone.post(f"{api}/public/invites/{gala['no']}/nope", json={"x": 1})
    assert small.status_code in (404, 405), "a small body is not what 413 is for"


async def test_the_questions_guests_are_asked_come_with_the_invitation(
    client: AsyncClient, api: str, gala: dict[str, Any]
) -> None:
    """Questions are 'attending only' by default; the page needs them to ask after a yes."""
    q = (await client.post(f"{gala['url']}/questions", json={"type": "dropdown"})).json()
    await client.patch(
        f"{gala['url']}/questions/{q['key']}",
        json={"label": "Meal", "options": ["Beef", "Fish"], "required": True},
    )
    blank = (await client.post(f"{gala['url']}/questions", json={"type": "text"})).json()
    assert blank["key"] != q["key"]

    questions = (await stranger(client).get(path(gala, api))).json()["questions"]
    assert [x["label"] for x in questions] == ["Meal"], (
        "a blank question is not ready, so not asked"
    )
    assert questions[0]["attending_only"] is True and questions[0]["options"] == ["Beef", "Fish"]


async def test_staff_can_revoke_one_guests_link_and_the_old_one_stops_working(
    client: AsyncClient, api: str, gala: dict[str, Any]
) -> None:
    old = gala["dewi"]["link_token"]
    rotated = await client.post(f"{gala['url']}/guests/{gala['dewi']['id']}/regenerate-link")
    assert rotated.status_code == 200, rotated.text
    new = rotated.json()["link_token"]
    assert new != old and rotated.json()["qr"] != gala["dewi"]["qr"]

    anyone = stranger(client)
    assert (await anyone.get(path(gala, api), headers={"X-Guest-Token": old})).json()[
        "guest"
    ] is None
    named = (await anyone.get(path(gala, api), headers={"X-Guest-Token": new})).json()["guest"]
    assert named and named["name"] == "Dewi Wijaya"

    other = await anyone.get(path(gala, api), headers={"X-Guest-Token": gala["budi"]["link_token"]})
    assert other.json()["guest"]["name"] == "Budi Santoso", "nobody else's link changed"


async def test_only_publishers_can_revoke_a_guests_link(
    client: AsyncClient, api: str, gala: dict[str, Any], client_for
) -> None:
    from app.domain.masters.models import Role

    sales = await client_for(Role.SALES)
    r = await sales.post(f"{gala['url']}/guests/{gala['dewi']['id']}/regenerate-link")
    assert r.status_code == 403
