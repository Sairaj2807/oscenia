"""Editing a project's name, division and event date, and what a new date carries with it."""

from __future__ import annotations

from typing import Any

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from test_ar import _confirmed

from app.domain.audit.models import AuditEvent
from app.domain.masters.models import Role


async def invoices_of(client: AsyncClient, api: str, project: dict[str, Any]) -> dict[str, Any]:
    rows = (await client.get(f"{api}/invoices", params={"project_id": project["id"]})).json()
    return {r["stage_label"]: r for r in rows}


async def test_a_name_and_division_can_be_fixed(
    client: AsyncClient, api: str, db: AsyncSession
) -> None:
    project = await _confirmed(client, api)
    r = await client.patch(
        f"{api}/projects/{project['id']}",
        json={"name": "  Aurora   Summit 2026 ", "division": "Field"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["project"]["name"] == "Aurora Summit 2026"
    assert r.json()["project"]["division"] == "Field"
    assert r.json()["invoices_rescheduled"] == 0

    blank = await client.patch(f"{api}/projects/{project['id']}", json={"name": "   "})
    assert blank.status_code == 422

    audit = (
        (await db.execute(select(AuditEvent).where(AuditEvent.action == "project.edit")))
        .scalars()
        .all()
    )
    assert audit and audit[-1].before["name"] != audit[-1].after["name"]


async def test_money_stage_and_client_cannot_be_edited_here(client: AsyncClient, api: str) -> None:
    project = await _confirmed(client, api)
    r = await client.patch(
        f"{api}/projects/{project['id']}",
        json={"contract_value": "1", "estimated_cost": "1", "stage": "Finished", "name": "Same"},
    )
    assert r.status_code == 200
    out = r.json()["project"]
    assert out["contract_value"] == project["contract_value"]
    assert out["stage"] == project["stage"] and out["client_id"] == project["client_id"]


async def test_a_new_event_date_moves_only_invoices_not_yet_issued(
    client: AsyncClient, api: str
) -> None:
    project = await _confirmed(client, api)  # 50% preset: DP at signing, settlement 7 days before
    before = await invoices_of(client, api, project)
    assert before["Down Payment"]["status"] == "Paid"
    assert before["Final Settlement"]["status"] == "Scheduled"
    assert before["Final Settlement"]["due_date"] == "2026-11-11"

    r = await client.patch(f"{api}/projects/{project['id']}", json={"event_date": "2026-12-20"})
    assert r.status_code == 200, r.text
    assert r.json()["project"]["event_date"] == "2026-12-20"
    assert r.json()["invoices_rescheduled"] == 1

    after = await invoices_of(client, api, project)
    assert after["Final Settlement"]["due_date"] == "2026-12-13", "7 days before the new date"
    assert after["Down Payment"]["due_date"] == before["Down Payment"]["due_date"], (
        "paid: untouched"
    )


async def test_an_issued_event_anchored_invoice_keeps_its_due_date(
    client: AsyncClient, api: str
) -> None:
    project = await _confirmed(client, api)
    final = (await invoices_of(client, api, project))["Final Settlement"]
    issued = await client.post(f"{api}/invoices/{final['id']}/issue", json={})
    assert issued.status_code == 200, issued.text

    r = await client.patch(f"{api}/projects/{project['id']}", json={"event_date": "2026-12-20"})
    assert r.json()["invoices_rescheduled"] == 0
    assert (await invoices_of(client, api, project))["Final Settlement"]["due_date"] == "2026-11-11"


async def test_a_linked_invitation_is_reported_not_silently_changed(
    client: AsyncClient, api: str
) -> None:
    project = await _confirmed(client, api)
    ev = await client.post(
        f"{api}/events",
        json={"name": "Summit", "date": "2026-11-18", "project_id": project["id"]},
    )
    assert ev.status_code == 201, ev.text
    r = await client.patch(f"{api}/projects/{project['id']}", json={"event_date": "2026-12-20"})
    assert r.status_code == 200
    assert any(ev.json()["event_no"] in w for w in r.json()["warnings"])
    still = (await client.get(f"{api}/events/{ev.json()['id']}")).json()
    assert still["date"] == "2026-11-18", "the invitation date is for staff to change"


async def test_the_date_is_locked_once_the_event_has_happened_or_the_project_is_cancelled(
    client: AsyncClient, api: str
) -> None:
    done = await _confirmed(client, api)
    for _ in range(5):
        assert (await client.post(f"{api}/projects/{done['id']}/advance-stage")).status_code == 200
    locked = await client.patch(f"{api}/projects/{done['id']}", json={"event_date": "2027-01-05"})
    assert locked.status_code == 409 and "taken place" in locked.json()["detail"]
    # The name is only a label: still editable.
    assert (
        await client.patch(f"{api}/projects/{done['id']}", json={"name": "Renamed after"})
    ).status_code == 200

    gone = await _confirmed(client, api, name="Another Client")
    cancelled = await client.post(f"{api}/projects/{gone['id']}/cancel", json={"reason": "x"})
    assert cancelled.status_code == 200, cancelled.text
    refused = await client.patch(f"{api}/projects/{gone['id']}", json={"name": "Nope"})
    assert refused.status_code == 409


async def test_only_the_ceo_and_pm_may_edit_a_project(
    client: AsyncClient, client_for: Any, api: str
) -> None:
    project = await _confirmed(client, api)
    for role in (Role.SALES, Role.FINANCE, Role.WAREHOUSE):
        who = await client_for(role)
        r = await who.patch(f"{api}/projects/{project['id']}", json={"name": "Hijack"})
        assert r.status_code == 403, role
    pm = await client_for(Role.PM)
    ok = await pm.patch(f"{api}/projects/{project['id']}", json={"name": "By the PM"})
    assert ok.status_code == 200
