"""Round 4: two dates on every money entry, and editable lines at the point of posting.

* ``document_date`` (the date on the receipt / vendor invoice) is stored as the entry's
  ``source_document_date`` on every money endpoint, and on manual entries -- which had been
  accepting it and silently dropping it.
* ``?dry_run`` on receive-payment and pay-DP posts nothing and burns no voucher number.
* ``tax_amount`` overrides withholding, bounded 0..gross.
* ``lines`` replaces the computed lines of the **payment/receipt entry only**, under a guard:
  the control account (1201 / 2102) must move by exactly the computed gross, every account
  must be active and postable, the lines must balance. Companion accruals (DP invoice, vendor
  bill, variance) are never touched.

Records are built here rather than assumed -- the test database carries reference data only.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.ledger.models import JournalEntry

pytestmark = pytest.mark.phase1

D = Decimal


async def _entry_count(db: AsyncSession) -> int:
    total = (await db.execute(select(func.count()).select_from(JournalEntry))).scalar_one()
    return int(total)


async def _entry(client: AsyncClient, api: str, entry_id: str) -> dict[str, Any]:
    response = await client.get(f"{api}/journal-entries/{entry_id}")
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


async def _entries_like(client: AsyncClient, api: str, memo: str) -> list[dict[str, Any]]:
    items = (
        await client.get(f"{api}/journal-entries", params={"q": memo, "limit": 500})
    ).json()["items"]
    return [e for e in items if memo in e["memo"]]


def _lines(entry: dict[str, Any]) -> list[tuple[str, str, str]]:
    return sorted(
        (ln["account_code"], ln["debit"], ln["credit"]) for ln in entry["lines"]
    )


async def _accepted_quote(client: AsyncClient, api: str, name: str) -> dict[str, Any]:
    created = await client.post(f"{api}/clients", json={"name": name})
    assert created.status_code == 201, created.text
    quote = await client.post(
        f"{api}/quotations",
        json={
            "client_id": created.json()["id"],
            "event_type": "Investor Summit",
            "event_date": "2026-11-18",
            "preset": "staged",
            "lines": [
                {"label": "Venue & Staging", "amount": "480000000", "est_cost": "336000000"}
            ],
        },
    )
    assert quote.status_code == 201, quote.text
    quote_id = quote.json()["id"]
    await client.post(f"{api}/quotations/{quote_id}/send")
    accepted = await client.post(f"{api}/quotations/{quote_id}/accept")
    assert accepted.status_code == 200, accepted.text
    body: dict[str, Any] = accepted.json()
    return body


async def _dp_gross(client: AsyncClient, api: str, quote_id: str) -> D:
    """The DP receipt's gross, read off the server's own preview."""
    preview = (
        await client.post(
            f"{api}/quotations/{quote_id}/confirm-down-payment",
            params={"dry_run": True},
            json={"withhold": False},
        )
    ).json()
    receipt = next(e for e in preview["entries"] if e["memo"].startswith("Receipt"))
    return D(next(ln["credit"] for ln in receipt["lines"] if ln["account"] == "1201"))


async def _issued_invoice(client: AsyncClient, api: str, name: str) -> dict[str, Any]:
    """An issued, unpaid stage-two invoice."""
    quote = await _accepted_quote(client, api, name)
    confirmed = await client.post(
        f"{api}/quotations/{quote['id']}/confirm-down-payment", json={}
    )
    assert confirmed.status_code == 201, confirmed.text
    invoices = (await client.get(f"{api}/invoices")).json()
    scheduled = next(
        i
        for i in invoices
        if i["status"] == "Scheduled" and i["project_id"] == confirmed.json()["id"]
    )
    issued = await client.post(f"{api}/invoices/{scheduled['id']}/issue", json={})
    assert issued.status_code == 200, issued.text
    body: dict[str, Any] = issued.json()
    return body


async def _approved_order(
    client: AsyncClient, api: str, *, dp: str = "50", name: str = "Suara Prima"
) -> dict[str, Any]:
    """9,000,000 committed. At 50% the DP is 4,500,000 and default PPh 23 is 2%."""
    vendor = await client.post(
        f"{api}/vendors", json={"name": name, "category": "Audio", "terms_dp_percent": dp}
    )
    assert vendor.status_code == 201, vendor.text
    created = await client.post(
        f"{api}/purchase-orders",
        json={
            "vendor_id": vendor.json()["id"],
            "order_date": "2026-05-10",
            "terms_dp_percent": dp,
            "lines": [{"item_label": "Line array", "qty": "2", "unit_price": "4500000"}],
        },
    )
    assert created.status_code == 201, created.text
    order: dict[str, Any] = created.json()
    approved = await client.post(f"{api}/purchase-orders/{order['id']}/approve")
    assert approved.status_code == 200, approved.text
    return order


# ---------------------------------------------------------------------------
# document_date
# ---------------------------------------------------------------------------


async def test_a_manual_entry_keeps_its_document_date(client: AsyncClient, api: str) -> None:
    """The bug: `SourceIn.document_date` was accepted and then dropped on the floor."""
    response = await client.post(
        f"{api}/journal-entries",
        json={
            "entry_date": "2026-05-12",
            "memo": "Courier invoice",
            "lines": [
                {"account": "6101", "debit": "150000"},
                {"account": "1101", "credit": "150000"},
            ],
            "source": {"document_date": "2026-05-03"},
        },
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["source_document_date"] == "2026-05-03"
    assert body["entry_date"] == "2026-05-12"
    assert (await _entry(client, api, body["id"]))["source_document_date"] == "2026-05-03"


async def test_an_adjustment_keeps_its_document_date(client: AsyncClient, api: str) -> None:
    """Adjust carries the corrected receipt's date onto the replacement, not the reversal."""
    posted = await client.post(
        f"{api}/journal-entries",
        json={
            "entry_date": "2026-05-12",
            "memo": "Courier invoice to correct",
            "lines": [
                {"account": "6101", "debit": "150000"},
                {"account": "1101", "credit": "150000"},
            ],
        },
    )
    assert posted.status_code == 201, posted.text
    adjusted = await client.post(
        f"{api}/journal-entries/{posted.json()['id']}/adjust",
        json={
            "entry_date": "2026-05-14",
            "document_date": "2026-05-04",
            "lines": [
                {"account": "6101", "debit": "175000"},
                {"account": "1101", "credit": "175000"},
            ],
        },
    )
    assert adjusted.status_code == 200, adjusted.text
    reversal, replacement = adjusted.json()
    assert replacement["source_document_date"] == "2026-05-04"
    assert replacement["entry_date"] == "2026-05-14"
    assert reversal["source_document_date"] is None


async def test_receive_payment_stores_both_dates(client: AsyncClient, api: str) -> None:
    invoice = await _issued_invoice(client, api, "Delta Fund")
    paid = await client.post(
        f"{api}/invoices/{invoice['id']}/payments",
        json={
            "amount": "10000000",
            "payment_date": "2026-05-20",
            "document_date": "2026-05-18",
        },
    )
    assert paid.status_code == 200, paid.text
    entry = await _entry(client, api, paid.json()["entry_id"])
    assert entry["entry_date"] == "2026-05-20", "received date is the accounting date"
    assert entry["source_document_date"] == "2026-05-18"


async def test_confirm_dp_puts_the_document_date_on_the_receipt_only(
    client: AsyncClient, api: str
) -> None:
    quote = await _accepted_quote(client, api, "Epsilon Co")
    confirmed = await client.post(
        f"{api}/quotations/{quote['id']}/confirm-down-payment",
        json={"confirmed_on": "2026-05-15", "document_date": "2026-05-14"},
    )
    assert confirmed.status_code == 201, confirmed.text
    project_id = confirmed.json()["id"]

    entries = [
        e
        for e in (
            await client.get(
                f"{api}/journal-entries", params={"project_id": project_id, "limit": 500}
            )
        ).json()["items"]
    ]
    receipt = next(e for e in entries if e["memo"].startswith("Receipt"))
    invoice = next(e for e in entries if e["source_kind"] == "invoice")
    assert receipt["source_document_date"] == "2026-05-14"
    assert receipt["entry_date"] == "2026-05-15"
    assert invoice["source_document_date"] is None, "the DP invoice is a companion"


async def test_pay_dp_and_pay_bill_store_the_document_date(
    client: AsyncClient, api: str
) -> None:
    order = await _approved_order(client, api)
    paid = await client.post(
        f"{api}/purchase-orders/{order['id']}/pay-dp",
        json={"payment_date": "2026-05-21", "document_date": "2026-05-19"},
    )
    assert paid.status_code == 200, paid.text
    entry = await _entry(client, api, paid.json()["entry_id"])
    assert entry["source_document_date"] == "2026-05-19"
    assert entry["entry_date"] == "2026-05-21"

    bill = (await client.get(f"{api}/bills")).json()[0]
    assert (await _entry(client, api, bill["entry_id"]))["source_document_date"] is None

    paid_bill = await client.post(
        f"{api}/bills/{bill['entry_id']}/payments",
        json={"amount": "1000000", "document_date": "2026-05-22"},
    )
    assert paid_bill.status_code == 200, paid_bill.text
    entry = await _entry(client, api, paid_bill.json()["entry_id"])
    assert entry["source_document_date"] == "2026-05-22"


async def test_settle_maps_invoice_date_onto_the_payment(
    client: AsyncClient, api: str
) -> None:
    order = await _approved_order(client, api, dp="0", name="Lumina LED")
    preview = await client.post(
        f"{api}/purchase-orders/{order['id']}/settle",
        params={"dry_run": True},
        json={"invoice_date": "2026-05-09", "payment_date": "2026-05-25"},
    )
    assert preview.status_code == 200, preview.text
    payment = next(e for e in preview.json()["entries"] if e["memo"].startswith("Payment"))
    assert payment["source_document_date"] == "2026-05-09"
    assert payment["entry_date"] == "2026-05-25"


# ---------------------------------------------------------------------------
# dry_run on the two endpoints that lacked it
# ---------------------------------------------------------------------------


async def test_receive_payment_dry_run_posts_nothing(
    client: AsyncClient, api: str, db: AsyncSession
) -> None:
    invoice = await _issued_invoice(client, api, "Zeta Group")
    before = await _entry_count(db)
    payload = {"amount": "10000000", "document_date": "2026-05-18"}

    first = await client.post(
        f"{api}/invoices/{invoice['id']}/payments", params={"dry_run": True}, json=payload
    )
    assert first.status_code == 200, first.text
    second = (
        await client.post(
            f"{api}/invoices/{invoice['id']}/payments", params={"dry_run": True}, json=payload
        )
    ).json()
    body = first.json()
    assert body["dry_run"] is True
    assert await _entry_count(db) == before, "a preview wrote to the ledger"
    assert body["entries"][0]["source_document_date"] == "2026-05-18"
    voucher = body["entries"][0]["voucher_preview"]
    assert second["entries"][0]["voucher_preview"] == voucher, "the counter moved"
    assert (await client.get(f"{api}/invoices/{invoice['id']}")).json()["status"] == "Unpaid"

    paid = await client.post(f"{api}/invoices/{invoice['id']}/payments", json=payload)
    assert paid.status_code == 200, paid.text
    assert paid.json()["voucher_no"] == voucher


async def test_pay_dp_dry_run_posts_nothing(
    client: AsyncClient, api: str, db: AsyncSession
) -> None:
    order = await _approved_order(client, api)
    before = await _entry_count(db)

    first = await client.post(
        f"{api}/purchase-orders/{order['id']}/pay-dp", params={"dry_run": True}, json={}
    )
    assert first.status_code == 200, first.text
    second = (
        await client.post(
            f"{api}/purchase-orders/{order['id']}/pay-dp", params={"dry_run": True}, json={}
        )
    ).json()
    body = first.json()
    assert body["dry_run"] is True
    assert len(body["entries"]) == 2, "the bill and the payment"
    assert await _entry_count(db) == before
    assert [e["voucher_preview"] for e in second["entries"]] == [
        e["voucher_preview"] for e in body["entries"]
    ]
    order_now = (await client.get(f"{api}/purchase-orders/{order['id']}")).json()
    assert order_now["status"] == "Approved"

    paid = await client.post(f"{api}/purchase-orders/{order['id']}/pay-dp", json={})
    assert paid.status_code == 200, paid.text
    assert paid.json()["voucher_no"] == body["entries"][1]["voucher_preview"]


# ---------------------------------------------------------------------------
# tax_amount
# ---------------------------------------------------------------------------


async def test_pay_dp_takes_a_tax_override(client: AsyncClient, api: str) -> None:
    order = await _approved_order(client, api)
    paid = await client.post(
        f"{api}/purchase-orders/{order['id']}/pay-dp", json={"tax_amount": "45000"}
    )
    assert paid.status_code == 200, paid.text
    body = paid.json()
    assert body["tax"] == "45000.00"
    assert body["net"] == "4455000.00"
    assert ("2105", "0.00", "45000.00") in _lines(await _entry(client, api, body["entry_id"]))


async def test_a_tax_override_above_gross_is_refused(
    client: AsyncClient, api: str, db: AsyncSession
) -> None:
    order = await _approved_order(client, api)
    refused = await client.post(
        f"{api}/purchase-orders/{order['id']}/pay-dp", json={"tax_amount": "4500001"}
    )
    assert refused.status_code == 422, refused.text
    assert "exceeds" in refused.json()["detail"]
    assert not await _entries_like(client, api, "Payment"), "no payment was posted"

    negative = await client.post(
        f"{api}/purchase-orders/{order['id']}/pay-dp", json={"tax_amount": "-1"}
    )
    assert negative.status_code == 422


async def test_confirm_dp_takes_a_tax_override(client: AsyncClient, api: str) -> None:
    quote = await _accepted_quote(client, api, "Eta Partners")
    gross = await _dp_gross(client, api, quote["id"])
    preview = (
        await client.post(
            f"{api}/quotations/{quote['id']}/confirm-down-payment",
            params={"dry_run": True},
            json={"tax_amount": "1234"},
        )
    ).json()
    receipt = next(e for e in preview["entries"] if e["memo"].startswith("Receipt"))
    assert ("1401", "1234.00", "0.00") in [
        (ln["account"], ln["debit"], ln["credit"]) for ln in receipt["lines"]
    ]

    too_much = await client.post(
        f"{api}/quotations/{quote['id']}/confirm-down-payment",
        json={"tax_amount": str(gross + 1)},
    )
    assert too_much.status_code == 422, too_much.text


async def test_settle_takes_a_tax_override(client: AsyncClient, api: str) -> None:
    order = await _approved_order(client, api, dp="0", name="Lumina LED")
    settled = await client.post(
        f"{api}/purchase-orders/{order['id']}/settle", json={"tax_amount": "0"}
    )
    assert settled.status_code == 200, settled.text
    payment = (await _entries_like(client, api, "Payment"))[0]
    assert ("2102", "9000000.00", "0.00") in _lines(payment)
    assert ("1101", "0.00", "9000000.00") in _lines(payment)


# ---------------------------------------------------------------------------
# Edited lines
# ---------------------------------------------------------------------------


async def test_edited_lines_post_on_pay_dp_and_the_bill_is_untouched(
    client: AsyncClient, api: str
) -> None:
    order = await _approved_order(client, api)
    edited = [
        {"account": "2102", "debit": "4500000"},
        {"account": "2105", "credit": "90000"},
        {"account": "1101", "credit": "4400000", "note": "Transfer"},
        {"account": "1102", "credit": "10000", "note": "Bank charge paid in cash"},
    ]
    paid = await client.post(
        f"{api}/purchase-orders/{order['id']}/pay-dp", json={"lines": edited}
    )
    assert paid.status_code == 200, paid.text
    body = paid.json()
    assert body["tax"] == "90000.00"
    entry = await _entry(client, api, body["entry_id"])
    assert _lines(entry) == sorted(
        [
            ("2102", "4500000.00", "0.00"),
            ("2105", "0.00", "90000.00"),
            ("1101", "0.00", "4400000.00"),
            ("1102", "0.00", "10000.00"),
        ]
    )

    bill = (await client.get(f"{api}/bills")).json()[0]
    assert D(bill["outstanding"]) == D("4500000"), "the payment still settled half"
    assert _lines(await _entry(client, api, bill["entry_id"])) == sorted(
        [("5101", "9000000.00", "0.00"), ("2102", "0.00", "9000000.00")]
    ), "the companion bill was edited"
    assert entry["applied_to"] == [bill["entry_id"]]


async def test_edited_lines_post_on_a_client_receipt_and_settle_it(
    client: AsyncClient, api: str
) -> None:
    invoice = await _issued_invoice(client, api, "Theta Bank")
    gross = D(invoice["outstanding"])
    edited = [
        {"account": "1101", "debit": str(gross - 1000)},
        {"account": "1102", "debit": "1000"},
        {"account": "1201", "credit": str(gross)},
    ]
    paid = await client.post(
        f"{api}/invoices/{invoice['id']}/payments",
        json={"amount": str(gross), "lines": edited},
    )
    assert paid.status_code == 200, paid.text
    body = paid.json()
    assert body["tax"] == "0.00", "no 1401 line was posted"
    assert body["invoice"]["status"] == "Paid"
    assert D(body["invoice"]["outstanding"]) == 0


async def test_edited_lines_on_confirm_dp_leave_the_invoice_alone(
    client: AsyncClient, api: str
) -> None:
    quote = await _accepted_quote(client, api, "Iota Holdings")
    gross = await _dp_gross(client, api, quote["id"])
    edited = [
        {"account": "1101", "debit": str(gross - 500000)},
        {"account": "1401", "debit": "500000"},
        {"account": "1201", "credit": str(gross)},
    ]
    confirmed = await client.post(
        f"{api}/quotations/{quote['id']}/confirm-down-payment", json={"lines": edited}
    )
    assert confirmed.status_code == 201, confirmed.text
    entries = (
        await client.get(
            f"{api}/journal-entries",
            params={"project_id": confirmed.json()["id"], "limit": 500},
        )
    ).json()["items"]
    receipt = next(e for e in entries if e["memo"].startswith("Receipt"))
    invoice = next(e for e in entries if e["source_kind"] == "invoice")
    money = f"{gross:.2f}"
    assert _lines(receipt) == sorted(
        [
            ("1101", f"{gross - 500000:.2f}", "0.00"),
            ("1401", "500000.00", "0.00"),
            ("1201", "0.00", money),
        ]
    )
    assert _lines(invoice) == sorted([("1201", money, "0.00"), ("4101", "0.00", money)])
    dp_invoice = next(
        i
        for i in (
            await client.get(
                f"{api}/invoices", params={"project_id": confirmed.json()["id"]}
            )
        ).json()
        if i["stage_no"] == 1
    )
    assert dp_invoice["status"] == "Paid"


async def test_edited_lines_on_settle_leave_the_variance_alone(
    client: AsyncClient, api: str
) -> None:
    order = await _approved_order(client, api, dp="0", name="Lumina LED")
    edited = [
        {"account": "2102", "debit": "8000000"},
        {"account": "1101", "credit": "7900000"},
        {"account": "1102", "credit": "100000"},
    ]
    settled = await client.post(
        f"{api}/purchase-orders/{order['id']}/settle",
        json={"actual_total": "8000000", "lines": edited},
    )
    assert settled.status_code == 200, settled.text
    assert settled.json()["status"] == "Settled"
    variance = (await _entries_like(client, api, "Variance"))[0]
    assert _lines(variance) == sorted(
        [("2102", "1000000.00", "0.00"), ("5101", "0.00", "1000000.00")]
    )
    payment = (await _entries_like(client, api, "Payment"))[0]
    assert _lines(payment) == sorted(
        [
            ("2102", "8000000.00", "0.00"),
            ("1101", "0.00", "7900000.00"),
            ("1102", "0.00", "100000.00"),
        ]
    )


async def test_edited_lines_on_pay_bill_post(client: AsyncClient, api: str) -> None:
    order = await _approved_order(client, api)
    await client.post(f"{api}/purchase-orders/{order['id']}/pay-dp", json={})
    bill = (await client.get(f"{api}/bills")).json()[0]
    paid = await client.post(
        f"{api}/bills/{bill['entry_id']}/payments",
        json={
            "amount": "1000000",
            "lines": [
                {"account": "2102", "debit": "1000000"},
                {"account": "1102", "credit": "1000000"},
            ],
        },
    )
    assert paid.status_code == 200, paid.text
    assert paid.json()["tax"] == "0.00"
    assert ("1102", "0.00", "1000000.00") in _lines(
        await _entry(client, api, paid.json()["entry_id"])
    )


async def test_a_dry_run_shows_the_edited_lines(
    client: AsyncClient, api: str, db: AsyncSession
) -> None:
    order = await _approved_order(client, api)
    before = await _entry_count(db)
    preview = await client.post(
        f"{api}/purchase-orders/{order['id']}/pay-dp",
        params={"dry_run": True},
        json={
            "lines": [
                {"account": "2102", "debit": "4500000"},
                {"account": "1102", "credit": "4500000"},
            ]
        },
    )
    assert preview.status_code == 200, preview.text
    payment = preview.json()["entries"][1]
    assert {ln["account"] for ln in payment["lines"]} == {"2102", "1102"}
    assert await _entry_count(db) == before


# ---------------------------------------------------------------------------
# The guard
# ---------------------------------------------------------------------------


async def _refused(
    client: AsyncClient, api: str, db: AsyncSession, lines: list[dict[str, str]]
) -> dict[str, Any]:
    order = await _approved_order(client, api)

    # The preview refuses identically and, being a savepoint, leaves nothing at all.
    before = await _entry_count(db)
    preview = await client.post(
        f"{api}/purchase-orders/{order['id']}/pay-dp",
        params={"dry_run": True},
        json={"lines": lines},
    )
    assert preview.status_code == 422, preview.text
    assert await _entry_count(db) == before, "a refused preview left something behind"

    # The real call: in production the request transaction rolls back on any error (the
    # test harness shares one session, so the lazily raised bill is visible here); what
    # matters is that no payment was posted and the order did not move.
    response = await client.post(
        f"{api}/purchase-orders/{order['id']}/pay-dp", json={"lines": lines}
    )
    assert response.status_code == 422, response.text
    assert not await _entries_like(client, api, "Payment"), "a refused edit posted"
    still = (await client.get(f"{api}/purchase-orders/{order['id']}")).json()
    assert still["status"] == "Approved"
    body: dict[str, Any] = response.json()
    return body


async def test_a_tampered_control_amount_is_refused(
    client: AsyncClient, api: str, db: AsyncSession
) -> None:
    body = await _refused(
        client,
        api,
        db,
        [{"account": "2102", "debit": "4000000"}, {"account": "1101", "credit": "4000000"}],
    )
    assert "2102" in body["detail"] and "locked" in body["detail"]


async def test_a_tampered_receipt_control_amount_is_refused(
    client: AsyncClient, api: str
) -> None:
    invoice = await _issued_invoice(client, api, "Kappa Ltd")
    refused = await client.post(
        f"{api}/invoices/{invoice['id']}/payments",
        json={
            "amount": "10000000",
            "lines": [
                {"account": "1101", "debit": "9000000"},
                {"account": "1201", "credit": "9000000"},
            ],
        },
    )
    assert refused.status_code == 422, refused.text
    assert "1201" in refused.json()["detail"]


async def test_an_unbalanced_edit_is_refused(
    client: AsyncClient, api: str, db: AsyncSession
) -> None:
    body = await _refused(
        client,
        api,
        db,
        [{"account": "2102", "debit": "4500000"}, {"account": "1101", "credit": "4400000"}],
    )
    assert "balance" in body["detail"]


async def test_an_inactive_account_is_refused(
    client: AsyncClient, api: str, db: AsyncSession
) -> None:
    deactivated = await client.post(f"{api}/accounts/1103/deactivate")
    assert deactivated.status_code == 200, deactivated.text
    body = await _refused(
        client,
        api,
        db,
        [{"account": "2102", "debit": "4500000"}, {"account": "1103", "credit": "4500000"}],
    )
    assert "deactivated" in body["detail"]


async def test_an_unknown_account_is_refused(
    client: AsyncClient, api: str, db: AsyncSession
) -> None:
    body = await _refused(
        client,
        api,
        db,
        [{"account": "2102", "debit": "4500000"}, {"account": "9999", "credit": "4500000"}],
    )
    assert "9999" in body["detail"]


async def test_a_two_sided_or_negative_line_is_refused(
    client: AsyncClient, api: str, db: AsyncSession
) -> None:
    await _refused(
        client,
        api,
        db,
        [
            {"account": "2102", "debit": "4500000", "credit": "1"},
            {"account": "1101", "credit": "4499999"},
        ],
    )
    await _refused(
        client,
        api,
        db,
        [
            {"account": "2102", "debit": "4500000"},
            {"account": "1101", "credit": "4600000"},
            {"account": "1102", "credit": "-100000"},
        ],
    )


async def test_lines_on_a_settlement_with_nothing_to_pay_are_refused(
    client: AsyncClient, api: str
) -> None:
    order = await _approved_order(client, api, dp="0", name="Lumina LED")
    refused = await client.post(
        f"{api}/purchase-orders/{order['id']}/settle",
        json={
            "actual_total": "0",
            "lines": [
                {"account": "2102", "debit": "1"},
                {"account": "1101", "credit": "1"},
            ],
        },
    )
    assert refused.status_code == 422, refused.text
    assert "nothing left to pay" in refused.json()["detail"]


async def test_a_line_on_the_receivable_inside_a_vendor_payment_is_refused(
    client: AsyncClient, api: str, db: AsyncSession
) -> None:
    # Balanced, and 2102 still moves by exactly the DP -- but a Dr 1201 / Cr 1101 pair
    # would move the receivable with no invoice behind it.
    body = await _refused(
        client,
        api,
        db,
        [
            {"account": "2102", "debit": "4500000"},
            {"account": "1101", "credit": "4500000"},
            {"account": "1201", "debit": "100000"},
            {"account": "1101", "credit": "100000"},
        ],
    )
    assert "1201" in body["detail"] and "control" in body["detail"]


async def test_a_contra_line_on_the_locked_control_account_is_refused(
    client: AsyncClient, api: str, db: AsyncSession
) -> None:
    # Nets to the right figure on 2102, but through a credit beside a bigger debit.
    body = await _refused(
        client,
        api,
        db,
        [
            {"account": "2102", "debit": "4600000"},
            {"account": "2102", "credit": "100000"},
            {"account": "1101", "credit": "4500000"},
        ],
    )
    assert "2102" in body["detail"] and "locked" in body["detail"]


async def test_a_line_on_the_payable_inside_a_client_receipt_is_refused(
    client: AsyncClient, api: str
) -> None:
    invoice = await _issued_invoice(client, api, "Lambda Ltd")
    refused = await client.post(
        f"{api}/invoices/{invoice['id']}/payments",
        json={
            "amount": "10000000",
            "lines": [
                {"account": "1101", "debit": "10000000"},
                {"account": "1201", "credit": "10000000"},
                {"account": "1101", "debit": "50000"},
                {"account": "2102", "credit": "50000"},
            ],
        },
    )
    assert refused.status_code == 422, refused.text
    assert "2102" in refused.json()["detail"]
    after = (await client.get(f"{api}/invoices/{invoice['id']}")).json()
    assert D(after["collected"]) == D("0")
