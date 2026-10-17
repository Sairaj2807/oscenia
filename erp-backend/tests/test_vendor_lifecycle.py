"""The vendor lifecycle board (P4): the rule table, then the routes that enforce it."""

from __future__ import annotations

from typing import Any

import pytest
from httpx import AsyncClient
from test_ap import _order, _vendor
from test_vendor_files_delivery_history import upload

from app.domain.ap.vendor_lifecycle import stage_error
from app.domain.masters.models import Role

# ---------------------------------------------------------------------------
# The rule table (a port of the prototype's vendorStageError)
# ---------------------------------------------------------------------------


def _err(**kw: Any) -> tuple[str, str] | None:
    base: dict[str, Any] = {
        "from_": "Prospect",
        "to": "Onboarding",
        "can_approve": True,
        "checklist_complete": True,
        "has_live_po": True,
        "reason": None,
        "resume_to": None,
    }
    return stage_error(**{**base, **kw})


@pytest.mark.parametrize(
    ("kw", "message"),
    [
        ({"to": "Nonsense"}, "Unknown stage."),
        ({"from_": "Active", "to": "Active"}, "The vendor is already there."),
        ({"from_": "Prospect", "to": "Approved"}, "Move a vendor one stage at a time."),
        ({"from_": "Active", "to": "Prospect"}, "Move a vendor one stage at a time."),
        (
            {"from_": "Onboarding", "to": "Approved", "checklist_complete": False},
            "Finish the onboarding checklist first.",
        ),
        (
            {"from_": "Approved", "to": "Active", "has_live_po": False},
            "A vendor becomes active with its first approved purchase order.",
        ),
        (
            {"from_": "Active", "to": "On hold"},
            "Give a reason — it stays on the vendor’s record.",
        ),
        (
            {"from_": "Active", "to": "Blacklisted", "reason": "   "},
            "Give a reason — it stays on the vendor’s record.",
        ),
        (
            {"from_": "Blacklisted", "to": "On hold", "reason": "x"},
            "A blacklisted vendor has to be vetted again: back to Onboarding.",
        ),
        (
            {"from_": "Blacklisted", "to": "Approved"},
            "A blacklisted vendor has to be vetted again: back to Onboarding.",
        ),
        (
            {"from_": "On hold", "to": "Active", "resume_to": "Approved"},
            "A vendor on hold goes back to Approved.",
        ),
        ({"from_": "On hold", "to": "Approved"}, "A vendor on hold goes back to Onboarding."),
    ],
)
def test_a_refused_stage_change_says_why(kw: dict[str, Any], message: str) -> None:
    assert _err(**kw) == ("rule", message)


@pytest.mark.parametrize(
    "kw",
    [
        {"from_": "Prospect", "to": "Onboarding"},
        {"from_": "Onboarding", "to": "Approved"},
        {"from_": "Approved", "to": "Active"},
        {"from_": "Active", "to": "On hold", "reason": "late"},
        {"from_": "Approved", "to": "Blacklisted", "reason": "fraud"},
        {"from_": "On hold", "to": "Approved", "resume_to": "Approved"},
        {"from_": "On hold", "to": "Onboarding"},
        {"from_": "Blacklisted", "to": "Onboarding"},
    ],
)
def test_the_allowed_moves(kw: dict[str, Any]) -> None:
    assert _err(**kw) is None


@pytest.mark.parametrize(
    "kw",
    [
        {"from_": "Onboarding", "to": "Approved"},
        {"from_": "Active", "to": "On hold", "reason": "late"},
        {"from_": "Active", "to": "Blacklisted", "reason": "x"},
        {"from_": "On hold", "to": "Onboarding"},
        {"from_": "Blacklisted", "to": "Onboarding"},
    ],
)
def test_only_someone_who_can_approve_may_approve_hold_or_reactivate(kw: dict[str, Any]) -> None:
    assert _err(**kw, can_approve=False) is not None
    assert _err(**kw, can_approve=False)[0] == "permission"  # type: ignore[index]


def test_a_pm_can_start_onboarding_without_approval_rights() -> None:
    assert _err(from_="Prospect", to="Onboarding", can_approve=False) is None
    assert _err(from_="Approved", to="Active", can_approve=False) is None


# ---------------------------------------------------------------------------
# The routes
# ---------------------------------------------------------------------------


async def _stage(
    client: AsyncClient, api: str, vendor_id: str, stage: str, reason: str | None = None
):
    return await client.post(
        f"{api}/vendors/{vendor_id}/stage", json={"stage": stage, "reason": reason}
    )


async def _complete_record(client: AsyncClient, api: str, vendor_id: str) -> None:
    r = await client.patch(
        f"{api}/vendors/{vendor_id}",
        json={
            "bank_name": "BCA", "bank_account": "123", "bank_holder": "PT Lumina",
            "pic_name": "Dewi", "pic_phone": "0812",
        },
    )  # fmt: skip
    assert r.status_code == 200, r.text


async def test_a_new_vendor_starts_as_a_prospect_with_a_history(
    client: AsyncClient, api: str
) -> None:
    v = await _vendor(client, api)
    assert v["stage"] == "Prospect"
    life = (await client.get(f"{api}/vendors/{v['id']}/lifecycle")).json()
    assert life["stage"] == "Prospect" and [h["stage"] for h in life["history"]] == ["Prospect"]
    assert life["checklist_complete"] is False


async def test_the_checklist_reads_the_record_a_filed_agreement_and_hand_ticks(
    client: AsyncClient, api: str
) -> None:
    v = await _vendor(client, api)
    items = lambda life: {i["key"]: i["done"] for i in life["checklist"]}  # noqa: E731
    life = (await client.get(f"{api}/vendors/{v['id']}/lifecycle")).json()
    assert items(life) == {
        "npwp": True, "bank": False, "pic": False, "agreement": False, "reference": False,
    }  # fmt: skip

    await _complete_record(client, api, v["id"])
    file = await upload(client, api)
    await client.post(
        f"{api}/vendors/{v['id']}/attachments",
        json={"attachment_id": file["id"], "kind": "Agreement"},
    )
    life = (await client.get(f"{api}/vendors/{v['id']}/lifecycle")).json()
    assert items(life)["bank"] and items(life)["pic"] and items(life)["agreement"]
    agreement = next(i for i in life["checklist"] if i["key"] == "agreement")
    assert agreement["auto"] is True and life["has_agreement_file"] is True

    r = await client.put(f"{api}/vendors/{v['id']}/checks/reference", json={"done": True})
    assert r.status_code == 200 and r.json()["checklist_complete"] is True


async def test_the_whole_journey_prospect_to_active_and_back_from_a_hold(
    client: AsyncClient, api: str
) -> None:
    v = await _vendor(client, api)
    vid = v["id"]
    assert (await _stage(client, api, vid, "Onboarding")).status_code == 200

    refused = await _stage(client, api, vid, "Approved")
    assert refused.status_code == 409
    assert refused.json()["detail"] == "Finish the onboarding checklist first."

    await _complete_record(client, api, vid)
    await client.put(f"{api}/vendors/{vid}/checks/agreement", json={"done": True})
    await client.put(f"{api}/vendors/{vid}/checks/reference", json={"done": True})
    assert (await _stage(client, api, vid, "Approved")).json()["stage"] == "Approved"

    no_po = await _stage(client, api, vid, "Active")
    assert no_po.status_code == 409 and "first approved purchase order" in no_po.json()["detail"]
    po = await _order(client, api, vid)
    assert (
        await client.post(f"{api}/purchase-orders/{po['id']}/approve", json={})
    ).status_code == 200
    assert (await _stage(client, api, vid, "Active")).json()["stage"] == "Active"

    hold = await _stage(client, api, vid, "On hold", "Late on two events")
    assert hold.json()["stage"] == "On hold" and hold.json()["reason"] == "Late on two events"
    assert hold.json()["resume_to"] == "Active"
    wrong = await _stage(client, api, vid, "Approved")
    assert (
        wrong.status_code == 409
        and wrong.json()["detail"] == "A vendor on hold goes back to Active."
    )
    assert (await _stage(client, api, vid, "Active")).json()["stage"] == "Active"

    history = (await client.get(f"{api}/vendors/{vid}/stage-history")).json()
    assert [h["stage"] for h in history] == [
        "Active", "On hold", "Active", "Approved", "Onboarding", "Prospect",
    ]  # fmt: skip
    assert history[1]["reason"] == "Late on two events" and history[0]["by"]


async def test_a_blacklisted_vendor_is_vetted_again(client: AsyncClient, api: str) -> None:
    v = await _vendor(client, api)
    await _stage(client, api, v["id"], "Onboarding")
    out = await _stage(client, api, v["id"], "Blacklisted", "Invoiced twice")
    assert out.json()["stage"] == "Blacklisted" and out.json()["resume_to"] == "Onboarding"
    assert (await _stage(client, api, v["id"], "Approved")).status_code == 409
    assert (await _stage(client, api, v["id"], "Onboarding")).json()["stage"] == "Onboarding"


async def test_a_pm_may_start_onboarding_but_not_approve_hold_or_tick_nothing_after(
    client: AsyncClient, client_for: Any, api: str
) -> None:
    v = await _vendor(client, api)
    pm = await client_for(Role.PM)
    assert (await _stage(pm, api, v["id"], "Onboarding")).status_code == 200
    assert (
        await pm.put(f"{api}/vendors/{v['id']}/checks/reference", json={"done": True})
    ).status_code == 200

    ceo = await client_for(Role.CEO)  # `client_for` re-signs the one shared client
    await _complete_record(ceo, api, v["id"])
    await ceo.put(f"{api}/vendors/{v['id']}/checks/agreement", json={"done": True})
    pm = await client_for(Role.PM)
    denied = await _stage(pm, api, v["id"], "Approved")
    assert denied.status_code == 403
    assert denied.json()["detail"] == "Only finance or the CEO can approve a vendor."
    hold = await _stage(pm, api, v["id"], "On hold", "x")
    assert hold.status_code == 403
    ceo = await client_for(Role.CEO)
    assert (await _stage(ceo, api, v["id"], "Approved")).status_code == 200

    # once approved the checklist is settled
    late = await ceo.put(f"{api}/vendors/{v['id']}/checks/reference", json={"done": False})
    assert late.status_code == 409


async def test_a_role_that_cannot_touch_vendors_cannot_move_or_tick_one(
    client: AsyncClient, client_for: Any, api: str
) -> None:
    v = await _vendor(client, api)
    warehouse = await client_for(Role.WAREHOUSE)
    assert (await _stage(warehouse, api, v["id"], "Onboarding")).status_code in (403, 404)
    assert (
        await warehouse.put(f"{api}/vendors/{v['id']}/checks/reference", json={"done": True})
    ).status_code in (403, 404)
    ceo = await client_for(Role.CEO)
    assert (await ceo.get(f"{api}/vendors/{v['id']}/lifecycle")).json()["stage"] == "Prospect"


async def test_only_the_two_hand_checks_can_be_ticked_and_unknown_vendors_are_404(
    client: AsyncClient, api: str
) -> None:
    v = await _vendor(client, api)
    assert (
        await client.put(f"{api}/vendors/{v['id']}/checks/npwp", json={"done": True})
    ).status_code == 422
    ghost = "00000000-0000-0000-0000-000000000000"
    assert (await _stage(client, api, ghost, "Onboarding")).status_code == 404
    assert (await client.get(f"{api}/vendors/{ghost}/lifecycle")).status_code == 404


async def test_the_board_endpoint_lists_every_vendor_with_its_checklist(
    client: AsyncClient, api: str
) -> None:
    a = await _vendor(client, api, name="A Vendor")
    b = await _vendor(client, api, name="B Vendor")
    await _stage(client, api, b["id"], "Onboarding")
    rows = {r["vendor_id"]: r for r in (await client.get(f"{api}/vendor-lifecycle")).json()}
    assert rows[a["id"]]["stage"] == "Prospect" and rows[b["id"]]["stage"] == "Onboarding"
    assert len(rows[a["id"]]["checklist"]) == 5


async def test_the_stage_is_enforced_on_new_orders_only_when_the_setting_is_on(
    client: AsyncClient, api: str
) -> None:
    v = await _vendor(client, api)
    # off by default: a Prospect can be given an order (nothing changes for existing data)
    assert (await client.get(f"{api}/settings")).json()["enforce_vendor_stage"] is False
    assert (await _order(client, api, v["id"]))["status"] == "Draft"

    on = await client.patch(f"{api}/settings", json={"enforce_vendor_stage": True})
    assert on.status_code == 200 and on.json()["enforce_vendor_stage"] is True
    body = {
        "vendor_id": v["id"], "order_date": "2026-06-12",
        "lines": [{"item_label": "x", "qty": "1", "unit_price": "1000"}],
    }  # fmt: skip
    refused = await client.post(f"{api}/purchase-orders", json=body)
    assert (
        refused.status_code == 409
        and "only an Approved or Active vendor" in refused.json()["detail"]
    )

    await _stage(client, api, v["id"], "Onboarding")
    await _complete_record(client, api, v["id"])
    await client.put(f"{api}/vendors/{v['id']}/checks/agreement", json={"done": True})
    await client.put(f"{api}/vendors/{v['id']}/checks/reference", json={"done": True})
    await _stage(client, api, v["id"], "Approved")
    assert (await client.post(f"{api}/purchase-orders", json=body)).status_code == 201

    await _stage(client, api, v["id"], "On hold", "audit")
    assert (await client.post(f"{api}/purchase-orders", json=body)).status_code == 409


async def test_a_vendor_that_predates_the_lifecycle_is_approved(
    client: AsyncClient, api: str, db: Any
) -> None:
    from app.domain.ap.models import Vendor

    legacy = Vendor(vendor_no="V-LEGACY", name="Old Supplier")
    db.add(legacy)
    await db.flush()
    life = (await client.get(f"{api}/vendors/{legacy.id}/lifecycle")).json()
    assert life["stage"] == "Approved" and life["history"] == []
