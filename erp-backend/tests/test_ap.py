"""Phase 5 — Accounts Payable.

Ports ``verify-flows.mjs`` §11 (the PO lifecycle), §12 (date-aware availability), §13 and
§63 (cancellation unwinds the whole chain), §19 (vendor rate override), §21–24 (tags), §36
(variance), §59–61 (AP reconciles, the zero-DP bug, paying from the Payables screen) and
§62 (both withholding directions coexist).

The two that matter most:

* **Approval posts nothing.** A purchase order is a commitment, not a debt. Raising the
  payable at approval is what pushed the company into an apparent loss in round 1.
* **PPh 23 runs the other way here.** Tax we withhold from a vendor is a **liability in
  2105**, never the 1401 asset an AR receipt creates. Both must be able to sit on the books
  at once, on opposite sides.
"""

from __future__ import annotations

from decimal import Decimal

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.phase5

D = Decimal


async def _vendor(
    client: AsyncClient,
    api: str,
    *,
    name: str = "Lumina LED",
    rate: str | None = None,
    dp: str = "50",
    days: int = 14,
    tags: list[str] | None = None,
) -> dict:
    body = {
        "name": name,
        "category": "LED / Visual",
        "npwp": "01.324.556.7-051.000",
        "terms_dp_percent": dp,
        "terms_settlement_days": days,
        "tags": tags or [],
    }
    if rate is not None:
        body["pph23_rate"] = rate
    response = await client.post(f"{api}/vendors", json=body)
    assert response.status_code == 201, response.text
    return response.json()


async def _item(
    client: AsyncClient, api: str, vendor_id: str, *, stock: str = "320", price: str = "2400000"
) -> dict:
    response = await client.post(
        f"{api}/vendor-catalogue",
        json={
            "vendor_id": vendor_id,
            "item": "LED Video Wall (per m2)",
            "category": "visual",
            "unit_price": price,
            "stock": stock,
            "unit": "m2",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


async def _order(
    client: AsyncClient,
    api: str,
    vendor_id: str,
    *,
    qty: str = "10",
    price: str = "2400000",
    dp: str | None = None,
    event_date: str | None = None,
    item_id: str | None = None,
) -> dict:
    body = {
        "vendor_id": vendor_id,
        "order_date": "2026-06-12",
        "event_date": event_date,
        "lines": [
            {"item_label": "LED Video Wall", "qty": qty, "unit_price": price, **(
                {"catalogue_item_id": item_id} if item_id else {}
            )}
        ],
    }
    if dp is not None:
        body["terms_dp_percent"] = dp
    response = await client.post(f"{api}/purchase-orders", json=body)
    assert response.status_code == 201, response.text
    return response.json()


async def _balance(client: AsyncClient, api: str, code: str) -> Decimal:
    body = (
        await client.get(
            f"{api}/reports/general-ledger", params={"codes": [code], "period": "all"}
        )
    ).json()
    return Decimal(body["closing"])


# ---------------------------------------------------------------------------
# §11 — The lifecycle
# ---------------------------------------------------------------------------


async def test_approval_posts_nothing(client: AsyncClient, api: str) -> None:
    """A commitment is not a debt. This is the round-1 fix that mattered most."""
    vendor = await _vendor(client, api)
    order = await _order(client, api, vendor["id"])

    approved = await client.post(f"{api}/purchase-orders/{order['id']}/approve")
    assert approved.status_code == 200
    assert approved.json()["status"] == "Approved"

    assert await _balance(client, api, "2102") == D("0.00"), "no payable raised"
    assert await _balance(client, api, "5101") == D("0.00"), "no cost recognised"

    tb = (await client.get(f"{api}/reports/trial-balance", params={"period": "all"})).json()
    assert tb["balanced"] is True


async def test_the_first_payment_raises_the_bill_for_the_whole_order(
    client: AsyncClient, api: str
) -> None:
    """The bill is raised lazily — but for the full committed value, not the DP."""
    vendor = await _vendor(client, api)
    order = await _order(client, api, vendor["id"])  # 10 x 2,400,000 = 24,000,000
    await client.post(f"{api}/purchase-orders/{order['id']}/approve")

    payment = await client.post(f"{api}/purchase-orders/{order['id']}/pay-dp", json={})
    assert payment.status_code == 200, payment.text
    body = payment.json()

    assert await _balance(client, api, "5101") == D("24000000.00"), "full cost recognised"
    assert body["gross"] == "12000000.00", "50% down payment"
    assert await _balance(client, api, "2102") == D("12000000.00"), "the unpaid remainder"
    assert body["order"]["status"] == "DP Paid"


async def test_pph23_on_money_out_is_a_liability(client: AsyncClient, api: str) -> None:
    """§62 — the mirror of the AR rule. Nothing here touches 1401."""
    vendor = await _vendor(client, api)
    order = await _order(client, api, vendor["id"])
    await client.post(f"{api}/purchase-orders/{order['id']}/approve")

    body = (
        await client.post(f"{api}/purchase-orders/{order['id']}/pay-dp", json={})
    ).json()

    assert body["gross"] == "12000000.00"
    assert body["tax"] == "240000.00", "PPh 23 at 2%"
    assert body["net"] == "11760000.00"

    assert await _balance(client, api, "2105") == D("240000.00"), "withholding is a LIABILITY"
    assert await _balance(client, api, "1401") == D("0.00"), "nothing touches the prepaid asset"
    assert await _balance(client, api, "1101") == D("-11760000.00"), "cash leaves NET"


async def test_the_vendors_own_rate_overrides_the_company_default(
    client: AsyncClient, api: str
) -> None:
    """§19 — the seed has a vendor at 1.5% against a 2% default."""
    vendor = await _vendor(client, api, name="Bloom & Co", rate="1.5")
    order = await _order(client, api, vendor["id"])
    await client.post(f"{api}/purchase-orders/{order['id']}/approve")

    body = (
        await client.post(f"{api}/purchase-orders/{order['id']}/pay-dp", json={})
    ).json()
    assert body["tax"] == "180000.00", "1.5% of 12,000,000, not 2%"


async def test_settling_does_not_recognise_the_cost_twice(
    client: AsyncClient, api: str
) -> None:
    vendor = await _vendor(client, api)
    order = await _order(client, api, vendor["id"])
    await client.post(f"{api}/purchase-orders/{order['id']}/approve")
    await client.post(f"{api}/purchase-orders/{order['id']}/pay-dp", json={})

    settled = await client.post(f"{api}/purchase-orders/{order['id']}/settle", json={})
    assert settled.status_code == 200
    assert settled.json()["status"] == "Settled"

    assert await _balance(client, api, "5101") == D("24000000.00"), "still the order value"
    assert await _balance(client, api, "2102") == D("0.00"), "no payable left behind"


async def test_a_vendor_invoice_keeps_its_own_date(client: AsyncClient, api: str) -> None:
    """REQ-01 — dual-date tracking, the accounts-payable half.

    A vendor's invoice for September work can arrive in October. It must be recorded in
    October — the period-close trigger would refuse September anyway — while still showing
    the date the vendor put on it, so month-end reconciliation can match the two.

    The date lives on the ORDER rather than on the bill entry for a mechanical reason: the
    payable is raised lazily at the first payment, so on this path the bill already exists
    by the time the final invoice arrives, `ensure_bill` is idempotent, and journal entries
    are append-only. Beside `actual_total` is where the vendor's invoice is already
    described.
    """
    vendor = await _vendor(client, api)
    order = await _order(client, api, vendor["id"])
    await client.post(f"{api}/purchase-orders/{order['id']}/approve")
    await client.post(f"{api}/purchase-orders/{order['id']}/pay-dp", json={})
    assert (await client.get(f"{api}/purchase-orders/{order['id']}")).json()["invoice_date"] is None

    settled = await client.post(
        f"{api}/purchase-orders/{order['id']}/settle",
        json={"invoice_date": "2026-09-28", "payment_date": "2026-10-03"},
    )
    assert settled.status_code == 200
    body = settled.json()
    assert body["invoice_date"] == "2026-09-28", "the vendor's own date"
    assert body["settled_at"] == "2026-10-03", "and the date it was recorded"


async def test_settling_without_an_invoice_date_leaves_it_unset(
    client: AsyncClient, api: str
) -> None:
    """Optional, so nothing is invented for an order settled the day it is invoiced."""
    vendor = await _vendor(client, api)
    order = await _order(client, api, vendor["id"])
    await client.post(f"{api}/purchase-orders/{order['id']}/approve")
    await client.post(f"{api}/purchase-orders/{order['id']}/pay-dp", json={})
    settled = (
        await client.post(f"{api}/purchase-orders/{order['id']}/settle", json={})
    ).json()
    assert settled["invoice_date"] is None


async def test_the_books_balance_through_the_whole_lifecycle(
    client: AsyncClient, api: str
) -> None:
    vendor = await _vendor(client, api)
    order = await _order(client, api, vendor["id"])
    await client.post(f"{api}/purchase-orders/{order['id']}/approve")
    await client.post(f"{api}/purchase-orders/{order['id']}/pay-dp", json={})
    await client.post(f"{api}/purchase-orders/{order['id']}/settle", json={})

    tb = (await client.get(f"{api}/reports/trial-balance", params={"period": "all"})).json()
    assert tb["balanced"] is True


# ---------------------------------------------------------------------------
# §36 — Variance
# ---------------------------------------------------------------------------


async def test_settling_under_budget_reduces_the_cost_to_the_actual(
    client: AsyncClient, api: str
) -> None:
    """§36 — the client asked for gain/loss against the locked budget."""
    vendor = await _vendor(client, api)
    order = await _order(client, api, vendor["id"])  # committed 24,000,000
    await client.post(f"{api}/purchase-orders/{order['id']}/approve")
    await client.post(f"{api}/purchase-orders/{order['id']}/pay-dp", json={})

    settled = (
        await client.post(
            f"{api}/purchase-orders/{order['id']}/settle",
            json={"actual_total": "20000000"},
        )
    ).json()

    assert settled["variance"] == "4000000.00", "positive means under budget"
    assert settled["actual_total"] == "20000000.00"
    assert await _balance(client, api, "5101") == D("20000000.00"), "cost ends on the actual"
    assert await _balance(client, api, "2102") == D("0.00"), "no payable left behind"


async def test_settling_over_budget_increases_the_cost(
    client: AsyncClient, api: str
) -> None:
    vendor = await _vendor(client, api)
    order = await _order(client, api, vendor["id"])
    await client.post(f"{api}/purchase-orders/{order['id']}/approve")
    await client.post(f"{api}/purchase-orders/{order['id']}/pay-dp", json={})

    settled = (
        await client.post(
            f"{api}/purchase-orders/{order['id']}/settle",
            json={"actual_total": "30000000"},
        )
    ).json()

    assert settled["variance"] == "-6000000.00", "negative means over budget"
    assert await _balance(client, api, "5101") == D("30000000.00")
    assert await _balance(client, api, "2102") == D("0.00")


async def test_variance_is_null_until_settled(client: AsyncClient, api: str) -> None:
    """Zero would imply the order came in exactly on budget, which is a different claim."""
    vendor = await _vendor(client, api)
    order = await _order(client, api, vendor["id"])
    assert order["variance"] is None

    approved = (
        await client.post(f"{api}/purchase-orders/{order['id']}/approve")
    ).json()
    assert approved["variance"] is None


async def test_settling_twice_is_refused(client: AsyncClient, api: str) -> None:
    vendor = await _vendor(client, api)
    order = await _order(client, api, vendor["id"])
    await client.post(f"{api}/purchase-orders/{order['id']}/approve")
    await client.post(f"{api}/purchase-orders/{order['id']}/settle", json={})

    again = await client.post(f"{api}/purchase-orders/{order['id']}/settle", json={})
    assert again.status_code == 409
    assert "already settled" in again.json()["detail"]


# ---------------------------------------------------------------------------
# §60 — The zero-DP bug
# ---------------------------------------------------------------------------


async def test_a_zero_dp_order_never_reaches_dp_paid_but_still_settles(
    client: AsyncClient, api: str
) -> None:
    """§60 — this was a real bug: the order was unsettleable and stuck forever."""
    vendor = await _vendor(client, api, dp="0")
    order = await _order(client, api, vendor["id"], dp="0")
    await client.post(f"{api}/purchase-orders/{order['id']}/approve")

    refused = await client.post(f"{api}/purchase-orders/{order['id']}/pay-dp", json={})
    assert refused.status_code == 409
    assert "zero down payment" in refused.json()["detail"]

    settled = await client.post(f"{api}/purchase-orders/{order['id']}/settle", json={})
    assert settled.status_code == 200, "an Approved order must still be settleable"
    assert settled.json()["status"] == "Settled"
    assert await _balance(client, api, "2102") == D("0.00")


# ---------------------------------------------------------------------------
# §59 / §61 — Bills and reconciliation
# ---------------------------------------------------------------------------


async def test_open_bills_equal_ledger_2102(client: AsyncClient, api: str) -> None:
    vendor = await _vendor(client, api)
    order = await _order(client, api, vendor["id"])
    await client.post(f"{api}/purchase-orders/{order['id']}/approve")
    await client.post(f"{api}/purchase-orders/{order['id']}/pay-dp", json={})

    ageing = (await client.get(f"{api}/payables/ageing")).json()
    assert ageing["total"] == "12000000.00"
    assert ageing["ledger_balance"] == "12000000.00"
    assert ageing["difference"] == "0.00"
    assert ageing["reconciled"] is True
    assert ageing["withholding_owed"] == "240000.00"


async def test_an_overhead_bill_with_no_purchase_order_still_ages(
    client: AsyncClient, api: str
) -> None:
    """§59 — the seed has exactly one, and a bills-table design could not represent it."""
    posted = await client.post(
        f"{api}/journal-entries",
        json={
            "entry_date": "2026-05-12",
            "memo": "Meridian Tech — office IT support",
            "source": {"kind": "po", "ref": "BILL-0012", "due": "2026-06-11"},
            "lines": [
                {"account": "6101", "debit": "18500000"},
                {"account": "2102", "credit": "18500000"},
            ],
        },
    )
    assert posted.status_code == 201

    bills = (await client.get(f"{api}/bills")).json()
    mine = next(b for b in bills if b["source_ref"] == "BILL-0012")
    assert mine["due"] == "2026-06-11"
    assert mine["outstanding"] == "18500000.00"

    ageing = (
        await client.get(f"{api}/payables/ageing", params={"as_of": "2026-07-20"})
    ).json()
    buckets = {b["key"]: b for b in ageing["buckets"]}
    assert buckets["31-60"]["amount"] == "18500000.00"


async def test_paying_a_bill_directly_from_the_payables_screen(
    client: AsyncClient, api: str
) -> None:
    """§61 — works for a bill that never had a purchase order."""
    await client.post(
        f"{api}/journal-entries",
        json={
            "entry_date": "2026-05-12",
            "memo": "Overhead bill",
            "source": {"kind": "po", "ref": "BILL-0099", "due": "2026-06-11"},
            "lines": [
                {"account": "6101", "debit": "10000000"},
                {"account": "2102", "credit": "10000000"},
            ],
        },
    )
    bill = next(
        b for b in (await client.get(f"{api}/bills")).json() if b["source_ref"] == "BILL-0099"
    )

    paid = await client.post(
        f"{api}/bills/{bill['entry_id']}/payments", json={"amount": "10000000"}
    )
    assert paid.status_code == 200
    body = paid.json()

    assert body["gross"] == "10000000.00"
    assert body["tax"] == "0.00", "no vendor on the bill, so no rate to withhold at"
    assert await _balance(client, api, "2102") == D("0.00")
    assert await _balance(client, api, "6101") == D("10000000.00"), "cost not recognised twice"


async def test_overpaying_a_bill_is_clamped(client: AsyncClient, api: str) -> None:
    vendor = await _vendor(client, api)
    order = await _order(client, api, vendor["id"])
    await client.post(f"{api}/purchase-orders/{order['id']}/approve")
    await client.post(f"{api}/purchase-orders/{order['id']}/pay-dp", json={})

    bill = (await client.get(f"{api}/bills")).json()[0]
    body = (
        await client.post(
            f"{api}/bills/{bill['entry_id']}/payments", json={"amount": "999999999999"}
        )
    ).json()

    assert body["gross"] == "12000000.00", "clamped to what was outstanding"
    assert await _balance(client, api, "2102") == D("0.00")


async def test_a_settled_bill_refuses_further_payment(
    client: AsyncClient, api: str
) -> None:
    vendor = await _vendor(client, api)
    order = await _order(client, api, vendor["id"])
    await client.post(f"{api}/purchase-orders/{order['id']}/approve")
    await client.post(f"{api}/purchase-orders/{order['id']}/settle", json={})

    bills = (await client.get(f"{api}/bills")).json()
    assert bills == [], "nothing left open"


# ---------------------------------------------------------------------------
# §62 — Both directions coexist
# ---------------------------------------------------------------------------


async def test_1401_and_2105_sit_on_opposite_sides_at_once(
    client: AsyncClient, api: str
) -> None:
    """The whole point of ruling 5: the two withholding directions never net."""
    # Money in: a client withholds from us.
    await client.post(
        f"{api}/journal-entries",
        json={
            "entry_date": "2026-05-10",
            "memo": "Client receipt with PPh 23 withheld",
            "source": {"kind": "payment"},
            "lines": [
                {"account": "1101", "debit": "98000000"},
                {"account": "1401", "debit": "2000000"},
                {"account": "4101", "credit": "100000000"},
            ],
        },
    )

    # Money out: we withhold from a vendor.
    vendor = await _vendor(client, api)
    order = await _order(client, api, vendor["id"])
    await client.post(f"{api}/purchase-orders/{order['id']}/approve")
    await client.post(f"{api}/purchase-orders/{order['id']}/pay-dp", json={})

    assert await _balance(client, api, "1401") == D("2000000.00")
    assert await _balance(client, api, "2105") == D("240000.00")

    sheet = (await client.get(f"{api}/reports/balance-sheet", params={"period": "all"})).json()
    assets = {line["code"] for line in sheet["assets"]}
    liabilities = {line["code"] for line in sheet["liabilities"]}

    assert "1401" in assets, "tax withheld FROM us is an asset"
    assert "2105" in liabilities, "tax withheld BY us is a liability"
    assert sheet["balanced"] is True


# ---------------------------------------------------------------------------
# §13 / §63 — Cancellation unwinds the chain
# ---------------------------------------------------------------------------


async def test_cancelling_reverses_the_payment_and_the_bill(
    client: AsyncClient, api: str
) -> None:
    """§63 — filtering only on source 'po' and missing the payments was the bug."""
    vendor = await _vendor(client, api)
    order = await _order(client, api, vendor["id"])
    await client.post(f"{api}/purchase-orders/{order['id']}/approve")
    await client.post(f"{api}/purchase-orders/{order['id']}/pay-dp", json={})

    cancelled = await client.post(f"{api}/purchase-orders/{order['id']}/cancel")
    assert cancelled.status_code == 200
    assert cancelled.json()["status"] == "Cancelled"

    assert await _balance(client, api, "5101") == D("0.00"), "cost unwound"
    assert await _balance(client, api, "2102") == D("0.00"), "payable gone"
    assert await _balance(client, api, "1101") == D("0.00"), "cash returned"
    assert await _balance(client, api, "2105") == D("0.00"), "withholding unwound"

    tb = (await client.get(f"{api}/reports/trial-balance", params={"period": "all"})).json()
    assert tb["balanced"] is True


async def test_cancelling_twice_is_refused(client: AsyncClient, api: str) -> None:
    vendor = await _vendor(client, api)
    order = await _order(client, api, vendor["id"])
    await client.post(f"{api}/purchase-orders/{order['id']}/cancel")
    again = await client.post(f"{api}/purchase-orders/{order['id']}/cancel")
    assert again.status_code == 409


async def test_cancelling_releases_only_its_own_reservations(
    client: AsyncClient, api: str
) -> None:
    """A hold placed without a purchase order belongs to somebody else and stays."""
    vendor = await _vendor(client, api)
    item = await _item(client, api, vendor["id"], stock="100")

    order = await _order(
        client, api, vendor["id"], qty="40", event_date="2026-08-14", item_id=item["id"]
    )
    await client.post(f"{api}/purchase-orders/{order['id']}/approve")

    before = (
        await client.get(
            f"{api}/vendor-catalogue/availability", params={"event_date": "2026-08-14"}
        )
    ).json()[0]
    assert Decimal(before["available"]) == D("60.00")

    await client.post(f"{api}/purchase-orders/{order['id']}/cancel")

    after = (
        await client.get(
            f"{api}/vendor-catalogue/availability", params={"event_date": "2026-08-14"}
        )
    ).json()[0]
    assert Decimal(after["available"]) == D("100.00"), "the reservation is released"


# ---------------------------------------------------------------------------
# §12 — Date-aware availability
# ---------------------------------------------------------------------------


async def test_stock_is_held_only_inside_the_event_window(
    client: AsyncClient, api: str
) -> None:
    vendor = await _vendor(client, api)
    item = await _item(client, api, vendor["id"], stock="100")
    order = await _order(
        client, api, vendor["id"], qty="100", event_date="2026-08-14", item_id=item["id"]
    )
    await client.post(f"{api}/purchase-orders/{order['id']}/approve")

    during = (
        await client.get(
            f"{api}/vendor-catalogue/availability", params={"event_date": "2026-08-14"}
        )
    ).json()[0]
    assert Decimal(during["available"]) == D("0.00")
    assert during["status"] == "Booked"

    # Load-in is D-2 and strike D+1, so a job a fortnight later is unaffected.
    later = (
        await client.get(
            f"{api}/vendor-catalogue/availability", params={"event_date": "2026-08-28"}
        )
    ).json()[0]
    assert Decimal(later["available"]) == D("100.00")
    assert later["status"] == "Available"


async def test_the_window_covers_load_in_and_strike(client: AsyncClient, api: str) -> None:
    vendor = await _vendor(client, api)
    await _item(client, api, vendor["id"], stock="10")

    body = (
        await client.get(
            f"{api}/vendor-catalogue/availability", params={"event_date": "2026-08-14"}
        )
    ).json()[0]
    assert body["window_from"] == "2026-08-12", "two days of load-in"
    assert body["window_to"] == "2026-08-15", "one day of strike"


async def test_an_overbooked_line_is_refused_and_names_the_item(
    client: AsyncClient, api: str
) -> None:
    vendor = await _vendor(client, api)
    item = await _item(client, api, vendor["id"], stock="50")

    first = await _order(
        client, api, vendor["id"], qty="40", event_date="2026-08-14", item_id=item["id"]
    )
    await client.post(f"{api}/purchase-orders/{first['id']}/approve")

    second = await _order(
        client, api, vendor["id"], qty="20", event_date="2026-08-14", item_id=item["id"]
    )
    response = await client.post(f"{api}/purchase-orders/{second['id']}/approve")

    assert response.status_code == 409
    assert "LED Video Wall" in response.json()["detail"]


async def test_low_stock_is_flagged_before_it_runs_out(
    client: AsyncClient, api: str
) -> None:
    vendor = await _vendor(client, api)
    item = await _item(client, api, vendor["id"], stock="100")
    order = await _order(
        client, api, vendor["id"], qty="80", event_date="2026-08-14", item_id=item["id"]
    )
    await client.post(f"{api}/purchase-orders/{order['id']}/approve")

    body = (
        await client.get(
            f"{api}/vendor-catalogue/availability", params={"event_date": "2026-08-14"}
        )
    ).json()[0]
    assert body["status"] == "Low Stock", "under a quarter free"


# ---------------------------------------------------------------------------
# §21–24 — Tags
# ---------------------------------------------------------------------------


async def test_the_seeded_tag_vocabulary(client: AsyncClient, api: str) -> None:
    tags = {t["id"] for t in (await client.get(f"{api}/tags")).json()}
    assert {"corporate-gala", "conference", "outdoor-capable", "preferred-supplier"} <= tags


async def test_tag_filtering_is_and_not_or(client: AsyncClient, api: str) -> None:
    """§22 — asking for two tags means both."""
    await _vendor(client, api, name="Both", tags=["outdoor-capable", "preferred-supplier"])
    await _vendor(client, api, name="One only", tags=["outdoor-capable"])

    both = await client.get(
        f"{api}/vendors", params={"tags": ["outdoor-capable", "preferred-supplier"]}
    )
    names = {v["name"] for v in both.json()}
    assert names == {"Both"}


async def test_deleting_a_tag_strips_it_from_vendors(
    client: AsyncClient, api: str
) -> None:
    """§24 — a dangling tag reference is worse than no tag."""
    vendor = await _vendor(client, api, name="Tagged", tags=["rush-friendly"])
    assert {t["id"] for t in vendor["tags"]} == {"rush-friendly"}

    assert (await client.delete(f"{api}/tags/rush-friendly")).status_code == 204

    refreshed = (await client.get(f"{api}/vendors/{vendor['id']}")).json()
    assert refreshed["tags"] == []


# ---------------------------------------------------------------------------
# Permissions
# ---------------------------------------------------------------------------


async def test_a_pm_may_raise_but_not_approve_or_pay(
    client: AsyncClient, client_for, api: str
) -> None:
    """§37 — the restriction the client's deck is explicit about."""
    from app.domain.masters.models import Role

    vendor = await _vendor(client, api)

    pm = await client_for(Role.PM)
    raised = await pm.post(
        f"{api}/purchase-orders",
        json={
            "vendor_id": vendor["id"],
            "order_date": "2026-06-12",
            "lines": [{"item_label": "Kit", "qty": "1", "unit_price": "1000000"}],
        },
    )
    assert raised.status_code == 201, "a PM may request"

    order_id = raised.json()["id"]
    assert (
        await pm.post(f"{api}/purchase-orders/{order_id}/approve")
    ).status_code == 403
    assert (
        await pm.post(f"{api}/purchase-orders/{order_id}/pay-dp", json={})
    ).status_code == 403


async def test_only_finance_may_change_a_vendor_rate(
    client: AsyncClient, client_for, api: str
) -> None:
    """It changes what the company withholds and owes the tax office."""
    from app.domain.masters.models import Role

    vendor = await _vendor(client, api)

    pm = await client_for(Role.PM)
    response = await pm.patch(f"{api}/vendors/{vendor['id']}", json={"pph23_rate": "0"})
    assert response.status_code == 403
    assert response.json()["action"] == "pay_po"


async def test_finance_edits_a_vendors_bank_contact_and_terms_and_only_those(
    client: AsyncClient, client_for, api: str
) -> None:
    from app.domain.masters.models import Role

    vendor = await _vendor(client, api)
    finance = await client_for(Role.FINANCE)
    r = await finance.patch(
        f"{api}/vendors/{vendor['id']}",
        json={
            "bank_name": "BNI", "bank_account": "999", "bank_holder": "PT Nusa",
            "pic_email": "new@x.id", "terms_dp_percent": 30, "terms_settlement_days": 7,
            "npwp": "",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["bank_name"] == "BNI" and body["bank_account"] == "999"
    assert body["pic_email"] == "new@x.id" and body["terms_dp_percent"] in (30, "30", 30.0)
    assert body["name"] == vendor["name"], "fields not sent are left alone"

    pm = await client_for(Role.PM)
    denied = await pm.patch(f"{api}/vendors/{vendor['id']}", json={"bank_account": "1"})
    assert denied.status_code == 403, "a bank account decides where money goes: not for the PM"
    assert (await finance.get(f"{api}/vendors/{vendor['id']}")).json()["bank_account"] == "999"
