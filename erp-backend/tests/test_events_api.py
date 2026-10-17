"""Events, the invitation editor, review and publish, and Template Studio — over HTTP.

Ported from ``verify-proto.mjs`` ("events actions", "review", "R3 studio"), plus the
permission checks the prototype never made server-side.
"""

from __future__ import annotations

import uuid
from typing import Any

from httpx import AsyncClient
from media_samples import png_bytes
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import DEMO_TODAY, FrozenClock
from app.core.rbac import ROLE_META
from app.domain.audit.models import AuditEvent
from app.domain.masters.models import Role


async def make_event(client: AsyncClient, api: str, **kw: Any) -> dict[str, Any]:
    body = {"name": "Year-end", "date": "2026-12-10", **kw}
    r = await client.post(f"{api}/events", json=body)
    assert r.status_code == 201, r.text
    return r.json()


# ---------------------------------------------------------------------------
# Events
# ---------------------------------------------------------------------------


async def test_a_new_event_is_a_draft_in_the_gallery_with_rsvp_a_week_before(
    client: AsyncClient, api: str
) -> None:
    ev = await make_event(client, api)
    assert ev["event_no"].startswith("EV-") and ev["status"] == "Draft"
    assert ev["rsvp_deadline"] == "2026-12-03" and ev["time"] == "19:00" and ev["max_pax"] == 2
    assert ev["invite"]["template_id"] is None and ev["invite"]["published"] is None
    assert ev["invite"]["content"]["details"]["date"] == "2026-12-10"
    assert ev["invite"]["content"]["cover"]["title"] == "Year-end"
    assert [c["name"] for c in ev["checkpoints"]] == ["Main Entrance"]
    assert ev["tables"] == ["T1", "T2", "T3", "T4", "T5"]
    assert ev["review"]["state"] == "editing" and not ev["rsvp_open"]


async def test_an_event_under_a_week_away_is_not_born_with_rsvps_closed(
    client: AsyncClient, api: str
) -> None:
    ev = await make_event(client, api, name="Pop-up", date="2026-07-29")
    assert DEMO_TODAY.isoformat() == "2026-07-26" and ev["rsvp_deadline"] == "2026-07-29"


async def test_a_project_supplies_its_client_and_a_mismatch_is_refused(
    client: AsyncClient, api: str, make_project: Any
) -> None:
    project_id = await make_project()
    other_project = await make_project("Other")
    ev = await make_event(client, api, project_id=project_id)
    assert ev["project_id"] == project_id and ev["client_id"] is not None
    other = (await client.get(f"{api}/projects/{other_project}")).json()
    r = await client.post(
        f"{api}/events",
        json={"name": "X", "date": "2026-12-10", "project_id": project_id,
              "client_id": other["client_id"]},
    )  # fmt: skip
    assert r.status_code == 422


async def test_editing_details_clamps_pax_and_refuses_sealed_fields(
    client: AsyncClient, api: str
) -> None:
    ev = await make_event(client, api)
    url = f"{api}/events/{ev['id']}"
    r = await client.patch(url, json={"max_pax": 99, "name": " Gala Night "})
    assert r.status_code == 200 and r.json()["max_pax"] == 50 and r.json()["name"] == "Gala Night"
    # Publishing is its own step, and the date, time and venue follow the invitation (D8):
    # each is refused by name rather than silently dropped.
    for field, value in [("status", "Published"), ("date", "2026-09-01"), ("time", "20:00"),
                         ("venue", "Elsewhere")]:  # fmt: skip
        r = await client.patch(url, json={field: value})
        assert r.status_code == 422 and field in r.json()["detail"], field
    after = (await client.get(url)).json()
    assert (after["status"], after["date"], after["time"]) == ("Draft", "2026-12-10", "19:00")
    assert (await client.patch(url, json={"rsvp_deadline": "2026-02-30"})).status_code == 422
    r = await client.patch(url, json={"feedback_url": "javascript:alert(1)"})
    assert r.status_code == 422
    assert (await client.patch(url, json={"name": "  "})).status_code == 422


async def test_after_publish_the_date_moves_only_by_publishing(
    client: AsyncClient, api: str
) -> None:
    ev = await make_event(client, api, date="2026-08-14")
    url = f"{api}/events/{ev['id']}"
    await client.put(f"{url}/invite/template", json={"template_id": "gala"})
    published = (await client.post(f"{url}/publish", json={})).json()
    assert (await client.patch(url, json={"date": "2026-09-01"})).status_code == 422
    details = published["invite"]["content"]["details"]
    r = await client.put(
        f"{url}/invite/content/details", json={"value": {**details, "date": "2026-09-01"}}
    )
    assert r.json()["date"] == "2026-08-14", "the draft waits"
    assert (await client.post(f"{url}/publish", json={})).json()["date"] == "2026-09-01"


async def test_studio_keeps_only_known_colour_and_font_slots(client: AsyncClient, api: str) -> None:
    t = f"{api}/invitation-templates"
    tpl = (await client.post(t, json={"from_id": "gala"})).json()
    r = await client.patch(
        f"{t}/{tpl['id']}",
        json={
            "palette": {**tpl["palette"], "junk": {"a": 1}},
            "fonts": {**tpl["fonts"], "extra": "x"},
        },
    )
    assert r.status_code == 200
    assert set(r.json()["palette"]) == {"bg", "surface", "accent", "text"}
    assert set(r.json()["fonts"]) == {"heading", "body", "script"}


async def test_an_unknown_event_is_404(client: AsyncClient, api: str) -> None:
    r = await client.get(f"{api}/events/00000000-0000-0000-0000-000000000000")
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# The editor
# ---------------------------------------------------------------------------


async def test_the_editor(client: AsyncClient, api: str) -> None:
    ev = await make_event(client, api, name="Editor test")
    url = f"{api}/events/{ev['id']}"
    assert (
        await client.put(f"{url}/invite/template", json={"template_id": "nope"})
    ).status_code == 422
    assert (
        await client.put(f"{url}/invite/template", json={"template_id": "royal"})
    ).status_code == 200

    assert (await client.put(f"{url}/invite/sections/rsvp", json={"on": False})).status_code == 422
    assert (await client.put(f"{url}/invite/sections/bogus", json={"on": True})).status_code == 422
    r = await client.put(f"{url}/invite/sections/gift", json={"on": False})
    assert r.json()["invite"]["on"] == {"gift": False}
    assert (await client.put(f"{url}/invite/sections/music", json={"on": True})).status_code == 200

    details = r.json()["invite"]["content"]["details"]
    r = await client.put(
        f"{url}/invite/content/details",
        json={"value": {**details, "date": "2026-12-12", "time": "18:00", "venue": "New Hall"}},
    )
    assert (r.json()["date"], r.json()["time"], r.json()["venue"]) == (
        "2026-12-12",
        "18:00",
        "New Hall",
    )
    r = await client.put(
        f"{url}/invite/content/details", json={"value": {**details, "date": "not-a-date"}}
    )
    assert r.json()["date"] == "2026-12-12", "an invalid date never reaches the event"

    cover = r.json()["invite"]["content"]["cover"]
    r = await client.put(
        f"{url}/invite/content/cover", json={"value": {**cover, "title": "T" * 900}}
    )
    assert len(r.json()["invite"]["content"]["cover"]["title"]) == 300
    assert (await client.put(f"{url}/invite/content/nope", json={"value": {}})).status_code == 422

    await client.put(
        f"{url}/invite/content/agenda",
        json={"value": {"rows": [{"time": "19:00", "label": "Dinner"}]}},
    )
    r = await client.put(f"{url}/invite/template", json={"template_id": "gala"})
    assert r.json()["invite"]["content"]["agenda"]["rows"][0]["label"] == "Dinner"
    assert r.json()["invite"]["on"]["gift"] is False, "changing template keeps content and toggles"

    assert (await client.put(f"{url}/invite/accent", json={"accent": "red"})).status_code == 422
    r = await client.put(f"{url}/invite/accent", json={"accent": "#112233"})
    assert r.json()["invite"]["accent"] == "#112233"
    r = await client.put(f"{url}/invite/accent", json={"accent": None})
    assert r.json()["invite"]["accent"] is None


async def test_publishing_snapshots_the_draft_and_later_edits_wait(
    client: AsyncClient, api: str
) -> None:
    ev = await make_event(client, api)
    url = f"{api}/events/{ev['id']}"
    r = await client.post(f"{url}/publish", json={})
    assert r.status_code == 409, "no template, no publish"

    await client.put(f"{url}/invite/template", json={"template_id": "gala"})
    r = await client.post(f"{url}/publish", json={})
    body = r.json()
    assert body["status"] == "Published" and body["invite"]["published"]["template_id"] == "gala"
    assert body["rsvp_open"] and not body["invite"]["has_unpublished_changes"]

    details = body["invite"]["content"]["details"]
    r = await client.put(
        f"{url}/invite/content/details",
        json={"value": {**details, "date": "2026-12-20", "venue": "Later Hall"}},
    )
    assert r.json()["date"] == "2026-12-10", "once published, a new date waits in the draft"
    cover = body["invite"]["content"]["cover"]
    r = await client.put(
        f"{url}/invite/content/cover", json={"value": {**cover, "title": "Draft title"}}
    )
    assert r.json()["invite"]["published"]["content"]["cover"]["title"] != "Draft title"
    assert r.json()["invite"]["has_unpublished_changes"]

    r = await client.post(f"{url}/unpublish")
    assert r.json()["status"] == "Draft" and r.json()["invite"]["published"] is not None
    assert (await client.post(f"{url}/unpublish")).status_code == 409
    r = await client.post(f"{url}/publish", json={})
    b = r.json()
    assert b["invite"]["published"]["content"]["cover"]["title"] == "Draft title"
    assert (b["date"], b["venue"]) == ("2026-12-20", "Later Hall")


async def test_publish_can_pull_a_late_deadline_back_to_the_new_date(
    client: AsyncClient, api: str
) -> None:
    ev = await make_event(client, api, date="2026-12-10")
    url = f"{api}/events/{ev['id']}"
    await client.put(f"{url}/invite/template", json={"template_id": "summit"})
    details = ev["invite"]["content"]["details"]
    await client.post(f"{url}/publish", json={})
    await client.put(
        f"{url}/invite/content/details", json={"value": {**details, "date": "2026-12-01"}}
    )
    r = await client.post(f"{url}/publish", json={"clamp_deadline": True})
    assert r.json()["date"] == "2026-12-01" and r.json()["rsvp_deadline"] == "2026-12-01"


# ---------------------------------------------------------------------------
# Review
# ---------------------------------------------------------------------------


async def test_submit_return_and_publish_closes_the_review(
    client: AsyncClient, api: str, db: AsyncSession
) -> None:
    ev = await make_event(client, api)
    url = f"{api}/events/{ev['id']}"
    assert (await client.post(f"{url}/submit")).status_code == 409, "nothing to submit yet"
    await client.put(f"{url}/invite/template", json={"template_id": "royal"})
    assert (await client.post(f"{url}/return", json={"note": "x"})).status_code == 409

    r = await client.post(f"{url}/submit")
    assert (
        r.json()["review"]["state"] == "submitted"
        and r.json()["review"]["submitted_by"] == "R. Hartono"
    )
    assert (await client.post(f"{url}/return", json={"note": "   "})).status_code == 422
    r = await client.post(f"{url}/return", json={"note": "Please keep the old title."})
    assert r.json()["review"] == {
        **r.json()["review"],
        "state": "returned",
        "note": "Please keep the old title.",
    }

    r = await client.post(f"{url}/submit")
    assert r.json()["review"]["state"] == "submitted" and r.json()["review"]["note"] == ""
    r = await client.post(f"{url}/publish", json={})
    assert r.json()["review"]["state"] == "editing"

    actions = (
        (
            await db.execute(
                select(AuditEvent.action)
                .where(AuditEvent.entity_id == ev["id"])
                .order_by(AuditEvent.at)
            )
        )
        .scalars()
        .all()
    )
    assert {"event.create", "invitation.submit", "invitation.return", "invitation.publish"} <= set(
        actions
    )


async def test_regenerating_the_client_link_revokes_the_old_one(
    client: AsyncClient, api: str
) -> None:
    from app.domain.events import service
    from app.domain.events.models import Event

    ev = await make_event(client, api)
    url = f"{api}/events/{ev['id']}"
    old = (await client.get(f"{url}/client-link")).json()
    again = (await client.get(f"{url}/client-link")).json()
    assert old["version"] == again["version"] == 1
    new = (await client.post(f"{url}/client-link/regenerate")).json()
    assert new["version"] == 2 and new["token"] != old["token"]

    now = FrozenClock(DEMO_TODAY).now()
    row = Event(id=uuid.UUID(ev["id"]), edit_link_version=2)
    assert service.read_client_link(new["token"], row, now=now)
    assert not service.read_client_link(old["token"], row, now=now)


# ---------------------------------------------------------------------------
# Permissions
# ---------------------------------------------------------------------------


async def test_sales_work_on_events_but_cannot_publish_or_design(client_for: Any, api: str) -> None:
    sales = await client_for(Role.SALES)
    ev = await make_event(sales, api)
    url = f"{api}/events/{ev['id']}"
    assert (
        await sales.put(f"{url}/invite/template", json={"template_id": "gala"})
    ).status_code == 200
    assert (await sales.post(f"{url}/submit")).status_code == 200
    for path, body in [("publish", {}), ("return", {"note": "x"}), ("unpublish", None),
                       ("client-link/regenerate", None)]:  # fmt: skip
        r = await sales.post(f"{url}/{path}", json=body)
        assert r.status_code == 403, path
        assert set(r.json()["permitted"]) == {
            ROLE_META[Role.CEO]["label"],
            ROLE_META[Role.PM]["label"],
        }
    assert (await sales.get(f"{url}/client-link")).status_code == 403
    assert (await sales.post(f"{api}/invitation-templates", json={})).status_code == 403
    assert (await sales.get(f"{api}/invitation-templates")).status_code == 200


async def test_finance_and_warehouse_do_not_see_events(client_for: Any, api: str) -> None:
    for role in (Role.FINANCE, Role.WAREHOUSE):
        http = await client_for(role)
        assert (await http.get(f"{api}/events")).status_code == 403
        assert (
            await http.post(f"{api}/events", json={"name": "X", "date": "2026-12-01"})
        ).status_code == 403


async def test_a_pm_publishes(client_for: Any, api: str) -> None:
    pm = await client_for(Role.PM)
    ev = await make_event(pm, api)
    await pm.put(f"{api}/events/{ev['id']}/invite/template", json={"template_id": "launch"})
    assert (await pm.post(f"{api}/events/{ev['id']}/publish", json={})).status_code == 200


# ---------------------------------------------------------------------------
# Template Studio
# ---------------------------------------------------------------------------


async def test_the_studio_lifecycle(client_for: Any, api: str) -> None:
    pm = await client_for(Role.PM)
    t = f"{api}/invitation-templates"
    listed = (await pm.get(t)).json()
    assert [x["id"] for x in listed[:6]] == [
        "gala",
        "launch",
        "summit",
        "royal",
        "minimal",
        "garden",
    ]

    assert (await pm.post(t, json={"from_id": "nope"})).status_code == 404
    r = await pm.post(t, json={"from_id": "royal"})
    assert r.status_code == 201
    tpl = r.json()
    tid = tpl["id"]
    assert tid.startswith("studio-") and tpl["status"] == "draft" and tpl["name"] == "Royal copy"
    assert tpl["fonts"]["script"] == "vibes" and tpl["created_by_label"] == "Agus P."

    r = await pm.patch(f"{t}/{tid}", json={"palette": {**tpl["palette"], "accent": "gold"}})
    assert r.status_code == 422 and "hex colour" in r.json()["detail"]
    r = await pm.patch(
        f"{t}/{tid}",
        json={"name": " Batik Night ", "cover": "framed", "status": "published", "id": "gala"},
    )
    assert (r.json()["name"], r.json()["cover"], r.json()["status"], r.json()["id"]) == (
        "Batik Night", "framed", "draft", tid,
    )  # fmt: skip
    assert (await pm.patch(f"{t}/gala", json={"name": "Mine"})).status_code == 409

    svg = {"key": "m-x", "name": "x.svg", "size": 1, "type": "image/svg+xml"}
    up = await pm.post(
        f"{t}/{tid}/art-upload", files={"file": ("cover.png", png_bytes(), "image/png")}
    )
    assert up.status_code == 201, up.text
    png = up.json()
    assert (await pm.put(f"{t}/{tid}/art/coverBg", json={"ref": svg})).status_code == 422
    assert (await pm.put(f"{t}/{tid}/art/logo", json={"ref": png})).status_code == 422
    r = await pm.put(f"{t}/{tid}/art/coverBg", json={"ref": png})
    assert r.json()["art"]["coverBg"]["key"] == png["key"]

    # The gallery: a draft cannot be picked; once added it can; archived leaves the gallery
    # but the invitation already on it keeps it.
    ev = await make_event(pm, api, name="Studio test")
    e_url = f"{api}/events/{ev['id']}"
    assert (await pm.put(f"{e_url}/invite/template", json={"template_id": tid})).status_code == 409
    assert (await pm.post(f"{t}/{tid}/publish")).json()["status"] == "published"
    assert (await pm.put(f"{e_url}/invite/template", json={"template_id": tid})).status_code == 200
    await pm.post(f"{e_url}/publish", json={})
    got = (await pm.get(f"{t}/{tid}")).json()
    assert (got["used_by_events"], got["live_events"]) == (1, 1)

    assert (await pm.post(f"{t}/{tid}/archive")).json()["status"] == "archived"
    other = await make_event(pm, api, name="Other", date="2026-12-11")
    assert (
        await pm.put(f"{api}/events/{other['id']}/invite/template", json={"template_id": tid})
    ).status_code == 409
    assert (await pm.put(f"{e_url}/invite/template", json={"template_id": tid})).status_code == 200
    assert (await pm.patch(f"{t}/{tid}", json={"name": "Edit while archived"})).status_code == 409
    assert (await pm.put(f"{t}/{tid}/art/frame", json={"ref": png})).status_code == 409
    assert (await pm.post(f"{t}/{tid}/publish")).status_code == 409, "Restore first"
    assert (await pm.post(f"{t}/{tid}/unpublish")).json()["status"] == "draft"
    assert (await pm.patch(f"{t}/{tid}", json={"name": "Restored"})).status_code == 200
    assert (await pm.post(f"{t}/gala/archive")).status_code == 409, "built-ins are read-only"


async def test_a_blank_template_in_each_family(client: AsyncClient, api: str) -> None:
    t = f"{api}/invitation-templates"
    corp = (await client.post(t, json={"family": "corporate"})).json()
    priv = (await client.post(t, json={"family": "private"})).json()
    assert corp["sections"][0] == "cover" and "agenda" in corp["sections"]
    assert "couple" in priv["sections"] and corp["id"] != priv["id"]


# ---------------------------------------------------------------------------
# The guest numbers on the list (so the events list needs no guest fetch)
# ---------------------------------------------------------------------------


async def test_the_list_and_detail_carry_the_same_guest_numbers_as_the_report(
    client: AsyncClient, api: str
) -> None:
    empty = await make_event(client, api, name="Empty")
    busy = await make_event(client, api, name="Busy")
    added = await client.post(
        f"{api}/events/{busy['id']}/guests",
        json={
            "guests": [
                {"name": "Ayu", "phone": "0812 1111 1111"},
                {"name": "Bima", "phone": "0812 2222 2222"},
            ]
        },
    )
    assert added.status_code == 200, added.text
    guest = (await client.get(f"{api}/events/{busy['id']}/guests")).json()[0]
    arrived = await client.post(f"{api}/events/{busy['id']}/guests/{guest['id']}/check-in")
    assert arrived.status_code == 201

    report = (await client.get(f"{api}/events/{busy['id']}/report")).json()["stats"]
    rows = {e["id"]: e for e in (await client.get(f"{api}/events")).json()}
    detail = (await client.get(f"{api}/events/{busy['id']}")).json()

    assert rows[busy["id"]]["stats"] == report == detail["stats"]
    assert report["invited"] == 2 and report["checked_in"] == 1
    assert set(rows[empty["id"]]["stats"].values()) == {0}, "an event with no guests is all zeros"
