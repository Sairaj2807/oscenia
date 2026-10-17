"""Vendor files, PO delivery status and a client's history (P3)."""

from __future__ import annotations

from typing import Any

from httpx import AsyncClient
from test_ap import _order, _vendor
from test_ar import _confirmed

from app.domain.masters.models import Role

PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"


async def upload(client: AsyncClient, api: str, name: str = "agreement.pdf") -> dict[str, Any]:
    r = await client.post(f"{api}/attachments", files={"file": (name, PDF, "application/pdf")})
    assert r.status_code == 201, r.text
    return r.json()


# ---------------------------------------------------------------------------
# Vendor files
# ---------------------------------------------------------------------------


async def test_a_file_can_be_filed_against_a_vendor_listed_and_opened(
    client: AsyncClient, api: str
) -> None:
    vendor = await _vendor(client, api)
    file = await upload(client, api)
    r = await client.post(
        f"{api}/vendors/{vendor['id']}/attachments",
        json={"attachment_id": file["id"], "kind": "Agreement", "note": "signed 2026"},
    )
    assert r.status_code == 201, r.text
    rows = r.json()
    assert (
        len(rows) == 1 and rows[0]["kind"] == "Agreement" and rows[0]["filename"] == "agreement.pdf"
    )
    assert rows[0]["note"] == "signed 2026" and rows[0]["uploaded_by"]

    again = await client.post(
        f"{api}/vendors/{vendor['id']}/attachments",
        json={"attachment_id": file["id"], "kind": "Agreement"},
    )
    assert len(again.json()) == 1, "filing it twice is a no-op"
    listed = (await client.get(f"{api}/vendors/{vendor['id']}/attachments")).json()
    assert [f["attachment_id"] for f in listed] == [file["id"]]
    assert (await client.get(f"{api}/attachments/{file['id']}")).status_code == 200


async def test_bad_vendor_file_requests_are_refused(client: AsyncClient, api: str) -> None:
    vendor = await _vendor(client, api)
    file = await upload(client, api)
    body = {"attachment_id": file["id"], "kind": "Selfie"}
    assert (
        await client.post(f"{api}/vendors/{vendor['id']}/attachments", json=body)
    ).status_code == 422
    missing = {"attachment_id": "00000000-0000-0000-0000-000000000000", "kind": "Other"}
    assert (
        await client.post(f"{api}/vendors/{vendor['id']}/attachments", json=missing)
    ).status_code == 404
    ghost = "00000000-0000-0000-0000-000000000000"
    ok = {"attachment_id": file["id"], "kind": "Other"}
    assert (await client.post(f"{api}/vendors/{ghost}/attachments", json=ok)).status_code == 404


async def test_a_vendor_holds_a_limited_number_of_files(
    client: AsyncClient, api: str, monkeypatch: Any
) -> None:
    from app.domain.ap import router as ap_router

    monkeypatch.setattr(ap_router, "MAX_FILES_PER_VENDOR", 1)
    vendor = await _vendor(client, api)
    one, two = await upload(client, api, "a.pdf"), await upload(client, api, "b.pdf")
    # distinct bytes so they are distinct stored files
    two = (
        await client.post(
            f"{api}/attachments", files={"file": ("b.pdf", PDF + b"extra", "application/pdf")}
        )
    ).json()
    first = await client.post(
        f"{api}/vendors/{vendor['id']}/attachments",
        json={"attachment_id": one["id"], "kind": "Other"},
    )
    assert first.status_code == 201
    full = await client.post(
        f"{api}/vendors/{vendor['id']}/attachments",
        json={"attachment_id": two["id"], "kind": "Other"},
    )
    assert full.status_code == 409


async def test_removing_a_file_keeps_the_stored_file_and_an_agreement_needs_approval_rights(
    client: AsyncClient, client_for: Any, api: str
) -> None:
    vendor = await _vendor(client, api)
    agreement, price = await upload(client, api), None
    price = (
        await client.post(
            f"{api}/attachments", files={"file": ("p.pdf", PDF + b"p", "application/pdf")}
        )
    ).json()
    await client.post(
        f"{api}/vendors/{vendor['id']}/attachments",
        json={"attachment_id": agreement["id"], "kind": "Agreement"},
    )
    rows = (
        await client.post(
            f"{api}/vendors/{vendor['id']}/attachments",
            json={"attachment_id": price["id"], "kind": "Price list"},
        )
    ).json()
    link = {r["kind"]: r["id"] for r in rows}

    pm = await client_for(Role.PM)  # may raise POs, may not approve them
    assert (
        await pm.delete(f"{api}/vendors/{vendor['id']}/attachments/{link['Agreement']}")
    ).status_code == 403
    assert (
        await pm.delete(f"{api}/vendors/{vendor['id']}/attachments/{link['Price list']}")
    ).status_code == 204

    ceo = await client_for(Role.CEO)
    assert (
        await ceo.delete(f"{api}/vendors/{vendor['id']}/attachments/{link['Agreement']}")
    ).status_code == 204
    assert (await ceo.get(f"{api}/vendors/{vendor['id']}/attachments")).json() == []
    assert (await ceo.get(f"{api}/attachments/{agreement['id']}")).status_code == 200, "file stays"


async def test_a_vendors_file_is_only_for_people_who_work_with_vendors(
    client: AsyncClient, client_for: Any, api: str
) -> None:
    vendor = await _vendor(client, api)
    file = await upload(client, api)
    await client.post(
        f"{api}/vendors/{vendor['id']}/attachments",
        json={"attachment_id": file["id"], "kind": "Bank letter"},
    )
    warehouse = await client_for(Role.WAREHOUSE)  # no vendors module
    assert (await warehouse.get(f"{api}/vendors/{vendor['id']}/attachments")).status_code == 403
    assert (await warehouse.get(f"{api}/attachments/{file['id']}")).status_code == 404, (
        "a file filed on a vendor is not fetchable by guessing its id"
    )
    plain = await upload(client, api, "receipt.pdf")  # filed nowhere: unchanged behaviour
    assert (await warehouse.get(f"{api}/attachments/{plain['id']}")).status_code == 200


# ---------------------------------------------------------------------------
# PO delivery
# ---------------------------------------------------------------------------


async def test_delivery_status_starts_not_started_and_moves_on_an_approved_order(
    client: AsyncClient, api: str
) -> None:
    vendor = await _vendor(client, api)
    order = await _order(client, api, vendor["id"])
    assert order["delivery_status"] == "Not started"

    draft = await client.put(
        f"{api}/purchase-orders/{order['id']}/delivery", json={"status": "In progress"}
    )
    assert draft.status_code == 409, "a draft order has nothing to deliver yet"

    await client.post(f"{api}/purchase-orders/{order['id']}/approve")
    for status in ("In progress", "Delivered", "Not started"):
        r = await client.put(
            f"{api}/purchase-orders/{order['id']}/delivery", json={"status": status}
        )
        assert r.status_code == 200, r.text
        assert r.json()["delivery_status"] == status and r.json()["delivery_updated_at"]
    bad = await client.put(f"{api}/purchase-orders/{order['id']}/delivery", json={"status": "Lost"})
    assert bad.status_code == 422


async def test_delivery_posts_nothing_and_is_independent_of_payment(
    client: AsyncClient, api: str
) -> None:
    vendor = await _vendor(client, api)
    order = await _order(client, api, vendor["id"])
    await client.post(f"{api}/purchase-orders/{order['id']}/approve")
    before = (await client.get(f"{api}/journal-entries")).json()
    await client.put(f"{api}/purchase-orders/{order['id']}/delivery", json={"status": "Delivered"})
    assert (await client.get(f"{api}/journal-entries")).json() == before
    got = (await client.get(f"{api}/purchase-orders/{order['id']}")).json()
    assert got["status"] == "Approved" and got["delivery_status"] == "Delivered"

    cancelled = await _order(client, api, vendor["id"])
    await client.post(f"{api}/purchase-orders/{cancelled['id']}/cancel")
    refused = await client.put(
        f"{api}/purchase-orders/{cancelled['id']}/delivery", json={"status": "Delivered"}
    )
    assert refused.status_code == 409


async def test_only_those_who_raise_purchase_orders_may_record_delivery(
    client: AsyncClient, client_for: Any, api: str
) -> None:
    vendor = await _vendor(client, api)
    order = await _order(client, api, vendor["id"])
    await client.post(f"{api}/purchase-orders/{order['id']}/approve")
    warehouse = await client_for(Role.WAREHOUSE)  # cannot raise purchase orders
    r = await warehouse.put(
        f"{api}/purchase-orders/{order['id']}/delivery", json={"status": "Delivered"}
    )
    assert r.status_code == 403


# ---------------------------------------------------------------------------
# Client history
# ---------------------------------------------------------------------------


async def test_a_clients_history_is_derived_from_their_projects(
    client: AsyncClient, api: str
) -> None:
    project = await _confirmed(client, api)
    vendor = await _vendor(client, api)
    order = await _order(client, api, vendor["id"], qty="2", price="1000000")
    await client.post(f"{api}/purchase-orders/{order['id']}/approve")
    # tie the order to the project (the create route takes a project_id)
    tied = await client.post(
        f"{api}/purchase-orders",
        json={
            "vendor_id": vendor["id"],
            "project_id": project["id"],
            "order_date": "2026-06-12",
            "lines": [{"item_label": "Truss", "qty": "3", "unit_price": "500000"}],
        },
    )
    assert tied.status_code == 201, tied.text
    await client.post(f"{api}/purchase-orders/{tied.json()['id']}/approve")
    await client.put(
        f"{api}/projects/{project['id']}/feedback", json={"score": "9"}
    )  # too early: refused
    for _ in range(5):
        await client.post(f"{api}/projects/{project['id']}/advance-stage")
    await client.put(f"{api}/projects/{project['id']}/feedback", json={"score": "9"})

    h = (await client.get(f"{api}/clients/{project['client_id']}/history")).json()
    assert h["event_count"] == 1 and h["contracted"] == project["contract_value"]
    assert h["invoiced"] == "240000000.00", "the paid down payment is the only issued invoice"
    assert h["collected"] == "240000000.00"
    assert h["avg_rating"] == "9.0"
    event = h["events"][0]
    assert event["project_no"] == project["project_no"] and event["rating"] == "9.0"
    assert event["event_type"] == "Investor Summit" and event["cancelled"] is False
    assert [v["name"] for v in event["vendors"]] == [vendor["name"]]
    assert event["vendors"][0]["spend"] == "1500000.00", "only the order tied to this project"
    assert h["preferred_event_types"] == [{"event_type": "Investor Summit", "count": 1}]
    assert h["vendors_used"][0]["events"] == 1


async def test_cancelled_projects_and_empty_clients_do_not_count(
    client: AsyncClient, api: str
) -> None:
    gone = await _confirmed(client, api)
    assert (
        await client.post(f"{api}/projects/{gone['id']}/cancel", json={"reason": "x"})
    ).status_code == 200
    h = (await client.get(f"{api}/clients/{gone['client_id']}/history")).json()
    assert h["event_count"] == 0 and h["contracted"] == "0.00" and h["avg_rating"] is None
    assert h["events"][0]["cancelled"] is True, "still listed, never summed"

    fresh = (await client.post(f"{api}/clients", json={"name": "Brand New Client"})).json()
    empty = (await client.get(f"{api}/clients/{fresh['id']}/history")).json()
    assert empty["events"] == [] and empty["event_count"] == 0 and empty["vendors_used"] == []
    missing = await client.get(f"{api}/clients/00000000-0000-0000-0000-000000000000/history")
    assert missing.status_code == 404


async def test_a_clients_history_is_for_those_who_see_crm(
    client: AsyncClient, client_for: Any, api: str
) -> None:
    project = await _confirmed(client, api)
    warehouse = await client_for(Role.WAREHOUSE)
    r = await warehouse.get(f"{api}/clients/{project['client_id']}/history")
    assert r.status_code == 403
