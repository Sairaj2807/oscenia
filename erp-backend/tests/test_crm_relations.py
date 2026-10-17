"""Client relationships over HTTP: contacts, cycles, greetings, nudges, the calendar, the scan.

"Today" is the suite's frozen demo date, 26 July 2026, so every date below is stated outright and
the expected answers can be read off a calendar. The rules themselves are tested against the
prototype in ``test_crm_rules.py``; this is the storage, the checks and who may do what.
"""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any
from urllib.parse import unquote

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import FrozenClock
from app.domain.audit.models import AuditEvent
from app.domain.crm.models import ClientContact
from app.domain.masters.models import Role

pytestmark = pytest.mark.phase1


async def _client(http: AsyncClient, api: str, name: str = "Aurora Bank", **extra: Any) -> str:
    r = await http.post(f"{api}/clients", json={"name": name, **extra})
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _contact(http: AsyncClient, api: str, cid: str, **body: Any) -> dict[str, Any]:
    r = await http.post(f"{api}/clients/{cid}/contacts", json={"name": "Ibu Sari", **body})
    assert r.status_code == 201, r.text
    return r.json()


async def _cycle(
    http: AsyncClient, api: str, cid: str, name: str, history: list[str]
) -> dict[str, Any]:
    r = await http.post(f"{api}/clients/{cid}/cycles", json={"name": name, "history": history})
    assert r.status_code == 201, r.text
    return r.json()


async def _calendar(http: AsyncClient, api: str, days: int = 90, **params: Any) -> list[dict]:
    r = await http.get(f"{api}/crm/calendar", params={"days": days, **params})
    assert r.status_code == 200, r.text
    return r.json()


# --- contacts --------------------------------------------------------------------------------


async def test_a_contact_is_added_edited_and_removed(client: AsyncClient, api: str) -> None:
    cid = await _client(client, api)
    made = await _contact(client, api, cid, role="HR", phone="0812 3456 7890", birthday="07-28")
    assert made["name"] == "Ibu Sari" and made["birthday"] == "07-28"
    assert made["greet"] is True and made["channel"] == "whatsapp"

    edited = await client.patch(
        f"{api}/clients/{cid}/contacts/{made['id']}",
        json={"role": "Head of HR", "channel": "both", "greet": False},
    )
    assert edited.status_code == 200 and edited.json()["role"] == "Head of HR"
    assert edited.json()["channel"] == "both" and edited.json()["greet"] is False
    assert edited.json()["birthday"] == "07-28", "untouched fields stay"

    cleared = await client.patch(
        f"{api}/clients/{cid}/contacts/{made['id']}", json={"birthday": None}
    )
    assert cleared.json()["birthday"] is None, "an explicit null clears a birthday"

    listed = (await client.get(f"{api}/clients/{cid}/relations")).json()["contacts"]
    assert [c["name"] for c in listed] == ["Ibu Sari"]
    assert (await client.delete(f"{api}/clients/{cid}/contacts/{made['id']}")).status_code == 204
    assert (await client.get(f"{api}/clients/{cid}/relations")).json()["contacts"] == []


@pytest.mark.parametrize(
    ("body", "fragment"),
    [
        ({"birthday": "02-30"}, "MM-DD"),
        ({"birthday": "7-28"}, "MM-DD"),
        ({"birthday": "13-01"}, "MM-DD"),
        ({"email": "not-an-email"}, "email"),
        ({"channel": "pigeon"}, ""),
        ({"name": "   "}, ""),
        ({"unknown_field": 1}, ""),
    ],
)
async def test_a_contact_that_makes_no_sense_is_refused(
    client: AsyncClient, api: str, body: dict[str, Any], fragment: str
) -> None:
    cid = await _client(client, api)
    r = await client.post(f"{api}/clients/{cid}/contacts", json={"name": "X", **body})
    assert r.status_code in (400, 422), r.text
    assert fragment in r.text
    assert (await client.get(f"{api}/clients/{cid}/relations")).json()["contacts"] == []


async def test_a_leap_day_birthday_is_accepted(client: AsyncClient, api: str) -> None:
    cid = await _client(client, api)
    assert (await _contact(client, api, cid, birthday="02-29"))["birthday"] == "02-29"


async def test_a_contact_belongs_to_one_client(client: AsyncClient, api: str) -> None:
    mine = await _client(client, api, "Aurora Bank")
    other = await _client(client, api, "Borneo Mining")
    theirs = await _contact(client, api, other)
    for call in (
        client.patch(f"{api}/clients/{mine}/contacts/{theirs['id']}", json={"role": "x"}),
        client.delete(f"{api}/clients/{mine}/contacts/{theirs['id']}"),
    ):
        assert (await call).status_code == 404
    ghost = str(uuid.uuid4())
    assert (
        await client.post(f"{api}/clients/{ghost}/contacts", json={"name": "x"})
    ).status_code == 404
    assert (await client.get(f"{api}/clients/{ghost}/relations")).status_code == 404


async def test_a_client_holds_at_most_fifty_contacts(
    client: AsyncClient, api: str, db: AsyncSession
) -> None:
    cid = await _client(client, api)
    db.add_all([ClientContact(client_id=uuid.UUID(cid), name=f"P{i}") for i in range(50)])
    await db.flush()
    r = await client.post(f"{api}/clients/{cid}/contacts", json={"name": "One too many"})
    assert r.status_code == 409 and "50" in r.text


# --- settings --------------------------------------------------------------------------------


async def test_the_anniversary_and_the_nudge_lead_are_kept_and_the_anniversary_can_be_cleared(
    client: AsyncClient, api: str
) -> None:
    cid = await _client(client, api)
    fresh = (await client.get(f"{api}/clients/{cid}/relations")).json()
    assert fresh["anniversary"] is None and fresh["nudge_lead_months"] == 3
    assert fresh["greet_anniversary"] is False and fresh["anniversary_channel"] == "whatsapp"

    r = await client.patch(
        f"{api}/clients/{cid}/relations",
        json={"anniversary": "2019-03-01", "greet_anniversary": True, "nudge_lead_months": 4},
    )
    assert r.status_code == 200, r.text
    assert r.json()["anniversary"] == "2019-03-01" and r.json()["nudge_lead_months"] == 4
    assert r.json()["greet_anniversary"] is True

    cleared = await client.patch(f"{api}/clients/{cid}/relations", json={"anniversary": None})
    assert cleared.json()["anniversary"] is None and cleared.json()["nudge_lead_months"] == 4


@pytest.mark.parametrize("months", [0, 13, -1])
async def test_the_nudge_lead_must_be_one_to_twelve_months(
    client: AsyncClient, api: str, months: int
) -> None:
    cid = await _client(client, api)
    r = await client.patch(f"{api}/clients/{cid}/relations", json={"nudge_lead_months": months})
    assert r.status_code == 422


# --- event cycles ----------------------------------------------------------------------------


async def test_a_cycle_keeps_its_months_sorted_and_without_repeats(
    client: AsyncClient, api: str
) -> None:
    cid = await _client(client, api)
    made = await _cycle(client, api, cid, "  Annual   Gala ", ["2025-07", "2024-07", "2025-07"])
    assert made["name"] == "Annual Gala" and made["history"] == ["2024-07", "2025-07"]

    edited = await client.patch(
        f"{api}/clients/{cid}/cycles/{made['id']}", json={"history": ["2026-07", "2023-07"]}
    )
    assert edited.status_code == 200 and edited.json()["history"] == ["2023-07", "2026-07"]
    assert (await client.delete(f"{api}/clients/{cid}/cycles/{made['id']}")).status_code == 204
    assert (await client.get(f"{api}/clients/{cid}/relations")).json()["cycles"] == []


@pytest.mark.parametrize(
    ("name", "history"),
    [
        ("Gala: 2026", []),
        ("Gala", ["2025-13"]),
        ("Gala", ["July 2025"]),
        ("Gala", ["2025-7"]),
        ("  ", []),
    ],
)
async def test_a_cycle_that_makes_no_sense_is_refused(
    client: AsyncClient, api: str, name: str, history: list[str]
) -> None:
    cid = await _client(client, api)
    r = await client.post(f"{api}/clients/{cid}/cycles", json={"name": name, "history": history})
    assert r.status_code in (400, 422), r.text


async def test_two_cycles_cannot_share_a_name_in_any_case(client: AsyncClient, api: str) -> None:
    cid = await _client(client, api)
    await _cycle(client, api, cid, "Annual Gala", ["2025-07"])
    again = await client.post(f"{api}/clients/{cid}/cycles", json={"name": "annual gala"})
    assert again.status_code == 409
    other = await _cycle(client, api, cid, "Town Hall", [])
    clash = await client.patch(
        f"{api}/clients/{cid}/cycles/{other['id']}", json={"name": "ANNUAL GALA"}
    )
    assert clash.status_code == 409
    # The same name on another client is fine.
    elsewhere = await _client(client, api, "Borneo Mining")
    await _cycle(client, api, elsewhere, "Annual Gala", [])


async def test_a_client_holds_at_most_twenty_cycles(client: AsyncClient, api: str) -> None:
    cid = await _client(client, api)
    for i in range(20):
        await _cycle(client, api, cid, f"Event {i}", [])
    r = await client.post(f"{api}/clients/{cid}/cycles", json={"name": "Twenty-first"})
    assert r.status_code == 409 and "20" in r.text


# --- the calendar ----------------------------------------------------------------------------


async def test_the_calendar_lists_nudges_birthdays_and_anniversaries_soonest_first(
    client: AsyncClient, api: str
) -> None:
    cid = await _client(client, api, "Aurora Bank")
    await _contact(client, api, cid, name="Ibu Sari", role="HR", birthday="08-05")
    await _cycle(client, api, cid, "Annual Gala", ["2024-11", "2025-11"])
    await client.patch(f"{api}/clients/{cid}/relations", json={"anniversary": "2019-08-10"})

    items = await _calendar(client, api, days=30)
    assert [(i["kind"], i["date"]) for i in items] == [
        ("Event nudge", "2026-08-01"),
        ("Birthday", "2026-08-05"),
        ("Company anniversary", "2026-08-10"),
    ]
    nudge, birthday, anniversary = items
    assert nudge["title"] == "Annual Gala 2026" and nudge["key"] == "Annual Gala:2026-11"
    assert nudge["in_days"] == 6 and nudge["client"] == "Aurora Bank"
    assert birthday["title"] == "Ibu Sari" and birthday["in_days"] == 10
    assert anniversary["title"] == "7 years with Oscenia" and anniversary["in_days"] == 15

    assert [i["date"] for i in await _calendar(client, api, days=7)] == ["2026-08-01"]


async def test_an_overdue_nudge_leads_the_calendar(client: AsyncClient, api: str) -> None:
    cid = await _client(client, api)
    await _cycle(client, api, cid, "Safety Day", ["2024-07", "2025-07"])  # due 1 April, past
    await _contact(client, api, cid, birthday="08-05")
    first = (await _calendar(client, api, days=30))[0]
    assert first["kind"] == "Event nudge" and first["in_days"] < 0 and first["date"] == "2026-04-01"


async def test_the_calendar_can_be_narrowed_to_one_client(client: AsyncClient, api: str) -> None:
    a = await _client(client, api, "Aurora Bank")
    b = await _client(client, api, "Borneo Mining")
    await _contact(client, api, a, name="A person", birthday="08-01")
    await _contact(client, api, b, name="B person", birthday="08-02")
    only = await _calendar(client, api, client_id=b)
    assert [i["title"] for i in only] == ["B person"]
    assert {i["title"] for i in await _calendar(client, api)} == {"A person", "B person"}


async def test_a_greeting_comes_prepared_with_its_text_and_send_links(
    client: AsyncClient, api: str
) -> None:
    cid = await _client(client, api, "Aurora Bank", phone="0811 900 001", email="hello@aurora.test")
    await _contact(
        client,
        api,
        cid,
        name="Ibu Sari",
        phone="0812 3456 7890",
        email="sari@aurora.test",
        birthday="08-05",
        channel="both",
    )
    await _contact(client, api, cid, name="No Details", birthday="08-06")
    await client.patch(
        f"{api}/clients/{cid}/relations",
        json={
            "anniversary": "2019-08-10",
            "greet_anniversary": True,
            "anniversary_channel": "email",
        },
    )
    items = {i["title"]: i for i in await _calendar(client, api, days=30)}

    sari = items["Ibu Sari"]
    assert sari["greet"] is True and sari["channel"] == "both" and sari["already_sent"] is False
    assert sari["message"].startswith("Happy birthday, Ibu Sari!")
    assert sari["whatsapp_url"].startswith("https://wa.me/6281234567890?text=")
    assert unquote(sari["whatsapp_url"].split("text=", 1)[1]) == sari["message"]
    assert sari["email_url"].startswith("mailto:sari%40aurora.test?subject=Happy%20birthday&body=")

    bare = items["No Details"]
    assert bare["whatsapp_url"] is None and bare["email_url"] is None, "nothing to reach them by"

    company = items["7 years with Oscenia"]
    assert company["greet"] is True and company["channel"] == "email"
    assert "Aurora Bank" in company["message"] and "7 years" in company["message"]
    assert company["whatsapp_url"].startswith("https://wa.me/62811900001?text=")
    assert company["email_url"].startswith("mailto:hello%40aurora.test")


async def test_an_anniversary_in_the_first_year_is_not_a_milestone(
    client: AsyncClient, api: str
) -> None:
    cid = await _client(client, api)
    await client.patch(f"{api}/clients/{cid}/relations", json={"anniversary": "2026-08-01"})
    assert await _calendar(client, api, days=30) == []


# --- handling a nudge ------------------------------------------------------------------------


async def test_handling_a_nudge_removes_it_and_notes_a_call_on_the_client(
    client: AsyncClient, api: str, db: AsyncSession
) -> None:
    cid = await _client(client, api)
    await _cycle(client, api, cid, "Annual Gala", ["2024-11", "2025-11"])
    key = (await _calendar(client, api, days=30))[0]["key"]

    r = await client.post(
        f"{api}/clients/{cid}/nudges", json={"key": key, "note": "Called Ibu Sari."}
    )
    assert r.status_code == 201, r.text
    assert r.json()["key"] == key and r.json()["note"] == "Called Ibu Sari."
    assert await _calendar(client, api, days=30) == []

    notes = (await client.get(f"{api}/clients/{cid}/interactions")).json()
    assert [(n["type"], n["note"]) for n in notes] == [("Call", "Called Ibu Sari.")]
    assert (await client.get(f"{api}/clients/{cid}/relations")).json()["handled_nudges"][0][
        "key"
    ] == key

    again = await client.post(f"{api}/clients/{cid}/nudges", json={"key": key})
    assert again.status_code == 422 or again.status_code == 409
    row = (
        await db.execute(
            select(AuditEvent).where(
                AuditEvent.entity_id == cid, AuditEvent.action == "crm.nudge.handle"
            )
        )
    ).scalar_one()
    assert row.detail == {"key": key}


async def test_a_nudge_that_is_not_due_cannot_be_marked_handled(
    client: AsyncClient, api: str
) -> None:
    cid = await _client(client, api)
    await _cycle(client, api, cid, "Annual Gala", ["2024-11", "2025-11"])
    for key in ("Annual Gala:2030-11", "Invented:2026-11", "nonsense"):
        r = await client.post(f"{api}/clients/{cid}/nudges", json={"key": key})
        assert r.status_code == 422, (key, r.text)
    assert len(await _calendar(client, api, days=30)) == 1


async def test_a_handled_nudge_stays_handled_when_its_event_is_renamed(
    client: AsyncClient, api: str
) -> None:
    cid = await _client(client, api)
    cycle = await _cycle(client, api, cid, "Annual Gala", ["2024-11", "2025-11"])
    await client.post(f"{api}/clients/{cid}/nudges", json={"key": "Annual Gala:2026-11"})
    await client.patch(f"{api}/clients/{cid}/cycles/{cycle['id']}", json={"name": "Yearly Gala"})
    assert await _calendar(client, api, days=30) == []
    handled = (await client.get(f"{api}/clients/{cid}/relations")).json()["handled_nudges"]
    assert [h["key"] for h in handled] == ["Yearly Gala:2026-11"]


# --- marking a greeting sent -----------------------------------------------------------------


async def test_a_greeting_marked_sent_is_remembered_and_cannot_be_marked_twice(
    client: AsyncClient, api: str
) -> None:
    cid = await _client(client, api)
    await _contact(client, api, cid, name="Ibu Sari", birthday="08-05")
    body = {"kind": "Birthday", "to": "Ibu Sari", "channel": "whatsapp", "year": 2026}

    r = await client.post(f"{api}/clients/{cid}/greetings", json=body)
    assert r.status_code == 201, r.text
    assert r.json()["to"] == "Ibu Sari" and r.json()["occasion_year"] == 2026
    assert (await _calendar(client, api, days=30))[0]["already_sent"] is True

    again = await client.post(f"{api}/clients/{cid}/greetings", json=body)
    assert again.status_code == 409 and "already" in again.text
    # Next year's is a different occasion.
    assert (
        await client.post(f"{api}/clients/{cid}/greetings", json={**body, "year": 2027})
    ).status_code == 201
    log = (await client.get(f"{api}/clients/{cid}/relations")).json()["greetings"]
    assert [g["occasion_year"] for g in log] == [2026, 2027]


async def test_only_a_real_occasion_can_be_marked_sent(client: AsyncClient, api: str) -> None:
    cid = await _client(client, api, "Aurora Bank")
    await _contact(client, api, cid, name="Ibu Sari", birthday="08-05")
    await _contact(client, api, cid, name="Pak Dedi")  # no birthday
    base = {"channel": "email", "year": 2026}
    for body in (
        {"kind": "Birthday", "to": "Nobody", **base},
        {"kind": "Birthday", "to": "Pak Dedi", **base},
        {"kind": "Company anniversary", "to": "Aurora Bank", **base},  # no anniversary recorded
        {"kind": "Company anniversary", "to": "Someone else", **base},
        {"kind": "Birthday", "to": "Ibu Sari", "channel": "email", "year": 2031},
        {"kind": "Wedding", "to": "Ibu Sari", **base},
    ):
        r = await client.post(f"{api}/clients/{cid}/greetings", json=body)
        assert r.status_code in (400, 422), (body, r.text)
    assert (await client.get(f"{api}/clients/{cid}/relations")).json()["greetings"] == []

    await client.patch(f"{api}/clients/{cid}/relations", json={"anniversary": "2019-08-10"})
    ok = await client.post(
        f"{api}/clients/{cid}/greetings",
        json={"kind": "Company anniversary", "to": "Aurora Bank", **base},
    )
    assert ok.status_code == 201


# --- who may ---------------------------------------------------------------------------------


@pytest.mark.parametrize("role", [Role.FINANCE])
async def test_a_role_with_the_crm_module_but_not_edit_client_may_read_and_not_write(
    client: AsyncClient, client_for: Any, api: str, role: Role
) -> None:
    cid = await _client(client, api)
    contact = await _contact(client, api, cid, birthday="08-05")
    other = await client_for(role)
    assert (await other.get(f"{api}/clients/{cid}/relations")).status_code == 200
    assert (await other.get(f"{api}/crm/calendar")).status_code == 200
    for call in (
        other.post(f"{api}/clients/{cid}/contacts", json={"name": "x"}),
        other.patch(f"{api}/clients/{cid}/contacts/{contact['id']}", json={"role": "x"}),
        other.delete(f"{api}/clients/{cid}/contacts/{contact['id']}"),
        other.patch(f"{api}/clients/{cid}/relations", json={"nudge_lead_months": 2}),
        other.post(f"{api}/clients/{cid}/cycles", json={"name": "x"}),
        other.post(f"{api}/clients/{cid}/nudges", json={"key": "a:2026-11"}),
        other.post(
            f"{api}/clients/{cid}/greetings",
            json={"kind": "Birthday", "to": "Ibu Sari", "channel": "email", "year": 2026},
        ),
    ):
        r = await call
        assert r.status_code == 403 and r.json()["action"] == "edit_client", r.text


async def test_sales_may_edit_and_the_warehouse_may_not_even_read(
    client: AsyncClient, client_for: Any, api: str
) -> None:
    cid = await _client(client, api)
    sales = await client_for(Role.SALES)
    r = await sales.post(f"{api}/clients/{cid}/contacts", json={"name": "Added by sales"})
    assert r.status_code == 201
    warehouse = await client_for(Role.WAREHOUSE)
    assert (await warehouse.get(f"{api}/clients/{cid}/relations")).status_code == 403
    assert (await warehouse.get(f"{api}/crm/calendar")).status_code == 403


async def test_writes_are_audited_without_the_contact_details(
    client: AsyncClient, api: str, db: AsyncSession
) -> None:
    cid = await _client(client, api)
    await _contact(client, api, cid, phone="0812 3456 7890", email="sari@aurora.test")
    rows = (await db.execute(select(AuditEvent).where(AuditEvent.entity_id == cid))).scalars().all()
    assert any(r.action == "crm.contact.add" for r in rows)
    assert "0812" not in str([r.detail for r in rows]) and "sari@" not in str(
        [r.detail for r in rows]
    )


# --- the daily scan --------------------------------------------------------------------------


async def test_the_scan_raises_reminders_for_a_birthday_an_anniversary_and_a_nudge_due_today(
    client: AsyncClient, api: str, frozen_clock: FrozenClock
) -> None:
    frozen_clock.advance(timedelta(days=6))  # 1 August 2026: the day a November event is nudged
    cid = await _client(client, api, "Aurora Bank")
    await _contact(client, api, cid, name="Ibu Sari", role="HR", birthday="08-01")
    await _contact(client, api, cid, name="Pak Dedi", birthday="08-02")  # not today
    await client.patch(f"{api}/clients/{cid}/relations", json={"anniversary": "2019-08-01"})
    await _cycle(client, api, cid, "Annual Gala", ["2024-11", "2025-11"])

    run = await client.post(f"{api}/jobs/crm.milestone_scan/run", json={})
    assert run.json()["status"] == "succeeded", run.text
    assert run.json()["detail"]["reminders_raised"] == 3

    reminders = (await client.get(f"{api}/reminders")).json()
    by_kind = {r["kind"]: r for r in reminders}
    assert set(by_kind) == {"birthday", "anniversary", "nudge"}
    assert "Ibu Sari" in by_kind["birthday"]["subject"] and "Pak Dedi" not in str(reminders)
    assert "7 years" in by_kind["anniversary"]["detail"]
    assert "Annual Gala 2026" in by_kind["nudge"]["subject"]


async def test_the_scan_does_not_raise_a_handled_nudge_or_the_same_reminder_twice(
    client: AsyncClient, api: str, frozen_clock: FrozenClock
) -> None:
    frozen_clock.advance(timedelta(days=6))
    cid = await _client(client, api)
    await _cycle(client, api, cid, "Annual Gala", ["2024-11", "2025-11"])
    await _cycle(client, api, cid, "Town Hall", ["2024-11", "2025-11"])
    await client.post(f"{api}/clients/{cid}/nudges", json={"key": "Annual Gala:2026-11"})

    first = await client.post(f"{api}/jobs/crm.milestone_scan/run", json={})
    assert first.json()["detail"]["reminders_raised"] == 1
    reminders = (await client.get(f"{api}/reminders")).json()
    assert [r["kind"] for r in reminders] == ["nudge"] and "Town Hall" in reminders[0]["subject"]

    again = await client.post(f"{api}/jobs/crm.milestone_scan/run", json={"force": True})
    assert len((await client.get(f"{api}/reminders")).json()) == 1, "once per day, not per run"
    del again


async def test_a_nudge_in_the_bell_reads_as_its_own_line(
    client: AsyncClient, api: str, frozen_clock: FrozenClock
) -> None:
    frozen_clock.advance(timedelta(days=6))
    cid = await _client(client, api, "Aurora Bank")
    await _cycle(client, api, cid, "Annual Gala", ["2024-11", "2025-11"])
    await client.post(f"{api}/jobs/crm.milestone_scan/run", json={})
    found = (await client.get(f"{api}/notifications")).json()
    nudges = [n for n in found if n["kind"] == "Event nudge"]
    assert len(nudges) == 1 and "Annual Gala 2026" in nudges[0]["title"]
    assert nudges[0]["to"].startswith("/crm/")
