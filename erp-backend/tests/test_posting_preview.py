"""`dry_run` — the confirmation the client asked for, before anything posts.

The property under test is not "it returns some lines". It is that the preview and the real
call agree, and that the preview leaves **nothing** behind: no entry, no status change, and
no burnt voucher number. A preview that quietly consumed a document number would leave a gap
in the numbering every time somebody opened a dialog and thought better of it.

Records are built here rather than assumed — the test database carries reference data only.
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


async def _entry_count(db: AsyncSession) -> int:
    total = (await db.execute(select(func.count()).select_from(JournalEntry))).scalar_one()
    return int(total)


async def _accepted_quote(
    client: AsyncClient, api: str, name: str = "Aurora Bank"
) -> dict[str, Any]:
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


async def _scheduled_invoice(
    client: AsyncClient, api: str, name: str = "Aurora Bank"
) -> dict[str, Any]:
    """Confirming a staged quotation leaves the later stages scheduled."""
    quote = await _accepted_quote(client, api, name)
    confirmed = await client.post(
        f"{api}/quotations/{quote['id']}/confirm-down-payment", json={}
    )
    assert confirmed.status_code == 201, confirmed.text

    invoices = (await client.get(f"{api}/invoices")).json()
    scheduled: dict[str, Any] = next(i for i in invoices if i["status"] == "Scheduled")
    return scheduled


async def _settleable_order(client: AsyncClient, api: str) -> dict[str, Any]:
    """A zero-DP order sits in Approved and is settleable from there."""
    vendor = await client.post(
        f"{api}/vendors",
        json={"name": "Lumina LED", "category": "LED / Visual", "terms_dp_percent": "0"},
    )
    assert vendor.status_code == 201, vendor.text
    created = await client.post(
        f"{api}/purchase-orders",
        json={
            "vendor_id": vendor.json()["id"],
            "order_date": "2026-05-10",
            "terms_dp_percent": "0",
            "lines": [{"item_label": "Stage", "qty": "2", "unit_price": "4500000"}],
        },
    )
    assert created.status_code == 201, created.text
    order: dict[str, Any] = created.json()
    approved = await client.post(f"{api}/purchase-orders/{order['id']}/approve")
    assert approved.status_code == 200, approved.text
    return order


# ---------------------------------------------------------------------------
# It previews, and it leaves nothing behind
# ---------------------------------------------------------------------------


async def test_a_dry_run_posts_nothing(
    client: AsyncClient, api: str, db: AsyncSession
) -> None:
    invoice = await _scheduled_invoice(client, api)
    before = await _entry_count(db)

    response = await client.post(
        f"{api}/invoices/{invoice['id']}/issue", params={"dry_run": True}
    )
    assert response.status_code == 200, response.text
    body = response.json()

    assert body["dry_run"] is True
    assert body["entries"], body
    assert await _entry_count(db) == before, "a preview wrote to the ledger"

    still_scheduled = (await client.get(f"{api}/invoices/{invoice['id']}")).json()
    assert still_scheduled["status"] == "Scheduled", "a preview changed the invoice"


async def test_a_dry_run_does_not_burn_a_voucher_number(
    client: AsyncClient, api: str
) -> None:
    """Opening a dialog and closing it must not leave a gap in the numbering."""
    invoice = await _scheduled_invoice(client, api)

    first = (
        await client.post(f"{api}/invoices/{invoice['id']}/issue", params={"dry_run": True})
    ).json()
    second = (
        await client.post(f"{api}/invoices/{invoice['id']}/issue", params={"dry_run": True})
    ).json()

    preview = first["entries"][0]["voucher_preview"]
    assert second["entries"][0]["voucher_preview"] == preview, "the counter moved"

    # And the number the real call takes is the one the preview showed.
    issued = await client.post(f"{api}/invoices/{invoice['id']}/issue")
    assert issued.status_code == 200, issued.text
    entries = (await client.get(f"{api}/journal-entries", params={"limit": 500})).json()
    assert preview in {e["voucher_no"] for e in entries["items"]}


async def test_the_preview_is_what_actually_posts(client: AsyncClient, api: str) -> None:
    """The reason the preview runs the real operation instead of recomputing the lines."""
    invoice = await _scheduled_invoice(client, api)

    previewed = (
        await client.post(f"{api}/invoices/{invoice['id']}/issue", params={"dry_run": True})
    ).json()["entries"][0]

    await client.post(f"{api}/invoices/{invoice['id']}/issue")
    items = (await client.get(f"{api}/journal-entries", params={"limit": 500})).json()["items"]
    posted = next(e for e in items if e["voucher_no"] == previewed["voucher_preview"])
    detail = (await client.get(f"{api}/journal-entries/{posted['id']}")).json()

    assert previewed["memo"] == detail["memo"]
    assert previewed["series"] == detail["series"]
    assert previewed["entry_date"] == detail["entry_date"]
    # The preview calls it `account`; the entry detail calls it `account_code`. Same value,
    # and comparing them is the whole assertion: the preview IS the posting.
    assert [
        (line["account"], line["debit"], line["credit"]) for line in previewed["lines"]
    ] == [
        (line["account_code"], line["debit"], line["credit"]) for line in detail["lines"]
    ]


async def test_a_previewed_line_names_its_account(client: AsyncClient, api: str) -> None:
    """A dialog showing "1201 / 4101" tells an operator nothing they can check."""
    invoice = await _scheduled_invoice(client, api)
    body = (
        await client.post(f"{api}/invoices/{invoice['id']}/issue", params={"dry_run": True})
    ).json()

    entry = body["entries"][0]
    assert entry["lines"], entry
    assert all(line["account_name"] for line in entry["lines"])
    assert entry["balanced"] is True
    assert Decimal(entry["total_debit"]) == Decimal(entry["total_credit"])
    assert body["balanced"] is True


# ---------------------------------------------------------------------------
# Several documents, one operation
# ---------------------------------------------------------------------------


async def test_confirming_a_down_payment_previews_every_document(
    client: AsyncClient, api: str, db: AsyncSession
) -> None:
    """Three things happen in one transaction, so the dialog shows each document."""
    quote = await _accepted_quote(client, api)
    before = await _entry_count(db)

    response = await client.post(
        f"{api}/quotations/{quote['id']}/confirm-down-payment",
        params={"dry_run": True},
        json={},
    )
    # 200 rather than the route's 201: nothing was created.
    assert response.status_code == 200, response.text
    body = response.json()

    assert len(body["entries"]) >= 2, body["entries"]
    assert body["balanced"] is True
    assert await _entry_count(db) == before, "a preview wrote to the ledger"

    # And no project was created — the half a ledger count would not catch.
    projects = (await client.get(f"{api}/projects")).json()
    assert quote["id"] not in {p.get("quotation_id") for p in projects}


# ---------------------------------------------------------------------------
# The payables side
# ---------------------------------------------------------------------------


async def test_settling_previews_the_variance_before_it_posts(
    client: AsyncClient, api: str, db: AsyncSession
) -> None:
    """The figure worth confirming: settling off the committed amount corrects the cost
    first, and that correction is what an operator is really agreeing to."""
    order = await _settleable_order(client, api)
    before = await _entry_count(db)

    response = await client.post(
        f"{api}/purchase-orders/{order['id']}/settle",
        params={"dry_run": True},
        json={"actual_total": "7000000"},
    )
    assert response.status_code == 200, response.text
    body = response.json()

    assert body["dry_run"] is True
    assert body["entries"], body
    assert body["balanced"] is True
    assert await _entry_count(db) == before

    unchanged = (await client.get(f"{api}/purchase-orders/{order['id']}")).json()
    assert unchanged["status"] == "Approved", unchanged["status"]


async def test_the_settle_preview_matches_the_settlement(
    client: AsyncClient, api: str
) -> None:
    order = await _settleable_order(client, api)
    previewed = (
        await client.post(
            f"{api}/purchase-orders/{order['id']}/settle",
            params={"dry_run": True},
            json={"actual_total": "7000000"},
        )
    ).json()

    settled = await client.post(
        f"{api}/purchase-orders/{order['id']}/settle", json={"actual_total": "7000000"}
    )
    assert settled.status_code == 200, settled.text

    items = (await client.get(f"{api}/journal-entries", params={"limit": 500})).json()["items"]
    numbers = {e["voucher_no"] for e in items}
    for entry in previewed["entries"]:
        assert entry["voucher_preview"] in numbers, entry["voucher_preview"]


async def test_paying_a_bill_previews_the_withholding(client: AsyncClient, api: str) -> None:
    """PPh 23 comes out of the payment, so the net is not the figure on the bill."""
    vendor = await client.post(
        f"{api}/vendors",
        json={"name": "Suara Prima", "category": "Audio", "terms_dp_percent": "50"},
    )
    created = await client.post(
        f"{api}/purchase-orders",
        json={
            "vendor_id": vendor.json()["id"],
            "order_date": "2026-05-10",
            "terms_dp_percent": "50",
            "lines": [{"item_label": "Line array", "qty": "2", "unit_price": "4500000"}],
        },
    )
    order = created.json()
    await client.post(f"{api}/purchase-orders/{order['id']}/approve")
    # Paying the DP raises the bill in full and pays half of it, so the balance is an OPEN
    # payable -- which is what `/bills` lists, since payables are derived from the ledger
    # rather than stored.
    paid = await client.post(f"{api}/purchase-orders/{order['id']}/pay-dp")
    assert paid.status_code == 200, paid.text

    bills = (await client.get(f"{api}/bills")).json()
    assert bills, "a half-paid bill is still open"

    body = (
        await client.post(
            f"{api}/bills/{bills[0]['entry_id']}/payments",
            params={"dry_run": True},
            json={"amount": "1000000"},
        )
    ).json()
    assert body["dry_run"] is True
    accounts = {line["account"] for entry in body["entries"] for line in entry["lines"]}
    assert "2105" in accounts, accounts


# ---------------------------------------------------------------------------
# Refusals
# ---------------------------------------------------------------------------


async def test_a_preview_of_a_refused_posting_refuses_too(
    client: AsyncClient, api: str
) -> None:
    """The dialog must not offer a button that cannot work.

    A preview that swallowed the 409 would show an operator a posting and then fail when
    they confirmed it — worse than refusing up front.
    """
    invoice = await _scheduled_invoice(client, api)
    await client.post(f"{api}/invoices/{invoice['id']}/issue")

    response = await client.post(
        f"{api}/invoices/{invoice['id']}/issue", params={"dry_run": True}
    )
    assert response.status_code == 409, response.text


async def test_a_preview_dated_into_a_closed_period_refuses(
    client: AsyncClient, api: str
) -> None:
    invoice = await _scheduled_invoice(client, api)
    closed = await client.post(f"{api}/periods/2026/4/close")
    assert closed.status_code == 200, closed.text

    response = await client.post(
        f"{api}/invoices/{invoice['id']}/issue",
        params={"dry_run": True},
        json={"issued_on": "2026-04-20"},
    )
    assert response.status_code == 409, response.text


async def test_a_refused_preview_leaves_nothing_behind(
    client: AsyncClient, api: str, db: AsyncSession
) -> None:
    """The savepoint is rolled back on the way out, not only on success."""
    invoice = await _scheduled_invoice(client, api)
    await client.post(f"{api}/periods/2026/4/close")
    before = await _entry_count(db)

    await client.post(
        f"{api}/invoices/{invoice['id']}/issue",
        params={"dry_run": True},
        json={"issued_on": "2026-04-20"},
    )
    assert await _entry_count(db) == before

    # And the invoice is still issuable on a date that is open.
    issued = await client.post(f"{api}/invoices/{invoice['id']}/issue")
    assert issued.status_code == 200, issued.text


async def test_without_the_flag_it_still_posts(client: AsyncClient, api: str) -> None:
    """The default has to stay the real thing, or every posting path breaks at once."""
    invoice = await _scheduled_invoice(client, api)
    response = await client.post(f"{api}/invoices/{invoice['id']}/issue")
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "Unpaid"
