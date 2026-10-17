"""Phase 4 — Accounts Receivable.

Ports ``verify-ledger.mjs`` §6 (AR ties to unpaid invoices) and ``verify-flows.mjs`` §1
(quotation accepted), §2 / §2b (confirm and undo the down payment), §31 (rollback refused
once cost has posted), §47 / §48 (phased schedules resolve exactly), §49–52 (issuing,
receiving, withholding, reconciliation) and §14 / §15 (stage revert, cancellation).

The two assertions that matter most:

* **PPh 23 runs the right way on money in** — revenue gross, cash net, withholding an asset
  in 1401, nothing credited to 2105. This was backwards in the client's round-1 build.
* **Outstanding invoices equal ledger 1201, with scheduled stages excluded.** A plan is not
  a debt, and counting one would put AR permanently out of step with its control account.
"""

from __future__ import annotations

from decimal import Decimal

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.phase4

D = Decimal


async def _client_id(client: AsyncClient, api: str, name: str = "Aurora Bank") -> str:
    response = await client.post(f"{api}/clients", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()["id"]


async def _quote(
    client: AsyncClient,
    api: str,
    *,
    lines=None,
    preset: str | None = "50",
    stages=None,
    event_date: str | None = "2026-11-18",
    name: str = "Aurora Bank",
) -> dict:
    body = {
        "client_id": await _client_id(client, api, name),
        "event_type": "Investor Summit",
        "event_date": event_date,
        "lines": lines
        or [
            {
                "label": "Venue & Staging",
                "amount": "480000000",
                "est_cost": "336000000",
            }
        ],
    }
    if stages is not None:
        body["stages"] = stages
    elif preset:
        body["preset"] = preset

    response = await client.post(f"{api}/quotations", json=body)
    assert response.status_code == 201, response.text
    return response.json()


async def _accepted(client: AsyncClient, api: str, **kw) -> dict:
    quote = await _quote(client, api, **kw)
    await client.post(f"{api}/quotations/{quote['id']}/send")
    accepted = await client.post(f"{api}/quotations/{quote['id']}/accept")
    assert accepted.status_code == 200, accepted.text
    return accepted.json()


async def _confirmed(client: AsyncClient, api: str, **kw) -> dict:
    quote = await _accepted(client, api, **kw)
    response = await client.post(
        f"{api}/quotations/{quote['id']}/confirm-down-payment", json={}
    )
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
# §47 — Schedules resolve exactly
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("preset", ["50", "75", "100", "staged"])
@pytest.mark.parametrize(
    "contract", ["610000000", "480000000", "117000001", "1", "333333333"]
)
async def test_every_preset_bills_the_contract_to_the_rupiah(
    client: AsyncClient, api: str, preset: str, contract: str
) -> None:
    """§47 — including deliberately awkward values that do not divide evenly."""
    presets = {p["key"]: p["stages"] for p in (await client.get(f"{api}/billing/presets")).json()}

    resolved = await client.post(
        f"{api}/billing/resolve-schedule",
        json={
            "stages": presets[preset],
            "contract_value": contract,
            "signing_date": "2026-05-10",
            "event_date": "2026-11-18",
        },
    )
    assert resolved.status_code == 200, resolved.text
    stages = resolved.json()

    total = sum(Decimal(s["amount"]) for s in stages)
    assert total == Decimal(contract), f"{preset} on {contract} billed {total}"


async def test_the_final_stage_absorbs_the_rounding_remainder(
    client: AsyncClient, api: str
) -> None:
    presets = {p["key"]: p["stages"] for p in (await client.get(f"{api}/billing/presets")).json()}
    stages = (
        await client.post(
            f"{api}/billing/resolve-schedule",
            json={
                "stages": presets["staged"],
                "contract_value": "1",
                "signing_date": "2026-05-10",
                "event_date": "2026-11-18",
            },
        )
    ).json()
    assert sum(Decimal(s["amount"]) for s in stages) == D("1.00")


async def test_due_dates_anchor_to_signing_and_event(
    client: AsyncClient, api: str
) -> None:
    presets = {p["key"]: p["stages"] for p in (await client.get(f"{api}/billing/presets")).json()}
    stages = (
        await client.post(
            f"{api}/billing/resolve-schedule",
            json={
                "stages": presets["50"],
                "contract_value": "480000000",
                "signing_date": "2026-05-10",
                "event_date": "2026-11-18",
            },
        )
    ).json()

    assert stages[0]["due"] == "2026-05-10", "the DP is due on signing"
    assert stages[1]["due"] == "2026-11-11", "settlement is seven days before the event"


async def test_a_schedule_that_does_not_total_the_contract_is_refused(
    client: AsyncClient, api: str
) -> None:
    """A schedule billing 90% is a missing stage, not a rounding problem."""
    response = await client.post(
        f"{api}/billing/resolve-schedule",
        json={
            "stages": [
                {"label": "DP", "basis": "percent", "value": "50"},
                {"label": "Rest", "basis": "percent", "value": "40"},
            ],
            "contract_value": "100000000",
        },
    )
    assert response.status_code == 422
    assert "90" in response.json()["detail"]


async def test_stage_types_are_dp_progress_final(client: AsyncClient, api: str) -> None:
    presets = {p["key"]: p["stages"] for p in (await client.get(f"{api}/billing/presets")).json()}
    stages = (
        await client.post(
            f"{api}/billing/resolve-schedule",
            json={
                "stages": presets["staged"],
                "contract_value": "100000000",
                "signing_date": "2026-05-10",
                "event_date": "2026-11-18",
            },
        )
    ).json()
    assert [s["invoice_type"] for s in stages] == ["Down Payment", "Progress", "Final"]


# ---------------------------------------------------------------------------
# §1 — Quotations
# ---------------------------------------------------------------------------


async def test_margin_comes_from_per_line_estimates(client: AsyncClient, api: str) -> None:
    """Round 1 hardcoded 30% here; per-line est_cost is what replaced it."""
    quote = await _quote(
        client, api,
        lines=[
            {"label": "Venue", "amount": "300000000", "est_cost": "180000000"},
            {"label": "Production", "amount": "200000000", "est_cost": "120000000"},
        ],
    )
    assert quote["contract_value"] == "500000000.00"
    assert quote["estimated_cost"] == "300000000.00"
    assert Decimal(str(quote["margin"])) == D("40.00")


async def test_a_sent_quotation_edited_returns_to_draft(
    client: AsyncClient, api: str
) -> None:
    """The client is holding figures that no longer apply, so it must be re-sent."""
    quote = await _quote(client, api)
    await client.post(f"{api}/quotations/{quote['id']}/send")

    patched = await client.patch(
        f"{api}/quotations/{quote['id']}",
        json={"lines": [{"label": "Venue", "amount": "500000000", "est_cost": "300000000"}]},
    )
    assert patched.status_code == 200
    assert patched.json()["status"] == "Draft"


async def test_an_accepted_quotation_cannot_be_edited(
    client: AsyncClient, api: str
) -> None:
    quote = await _accepted(client, api)
    response = await client.patch(
        f"{api}/quotations/{quote['id']}", json={"event_type": "Something else"}
    )
    assert response.status_code == 409
    assert "contractual" in response.json()["detail"]


async def test_accepting_twice_is_refused(client: AsyncClient, api: str) -> None:
    quote = await _accepted(client, api)
    assert (
        await client.post(f"{api}/quotations/{quote['id']}/accept")
    ).status_code == 409


# ---------------------------------------------------------------------------
# §2 — Confirming the down payment
# ---------------------------------------------------------------------------


async def test_confirming_creates_project_invoices_and_the_linked_pair(
    client: AsyncClient, api: str
) -> None:
    project = await _confirmed(client, api)

    assert project["project_no"].startswith("EVT-")
    assert project["stage"] == "DP Paid"
    assert project["contract_value"] == "480000000.00"

    invoices = (
        await client.get(f"{api}/invoices", params={"project_id": project["id"]})
    ).json()
    assert len(invoices) == 2, "one invoice per billing stage"
    assert invoices[0]["status"] == "Paid", "stage one is issued and settled"
    assert invoices[1]["status"] == "Scheduled", "later stages wait"


async def test_pph23_runs_the_right_way_on_money_in(
    client: AsyncClient, api: str
) -> None:
    """§12 — the rule that was backwards in round 1.

    Revenue GROSS, cash NET, withholding an ASSET in 1401. Nothing touches 2105, which is
    for tax *we* withhold from vendors.
    """
    await _confirmed(client, api)

    gross = D("240000000.00")  # 50% of 480,000,000
    tax = D("4800000.00")  # PPh 23 at 2%

    assert await _balance(client, api, "4101") == gross, "revenue recognised GROSS"
    assert await _balance(client, api, "1101") == gross - tax, "cash arrives NET"
    assert await _balance(client, api, "1401") == tax, "withholding is an ASSET"
    assert await _balance(client, api, "2105") == D("0.00"), "nothing credited to the payable"
    assert await _balance(client, api, "1201") == D("0.00"), "receivable cleared at GROSS"


async def test_confirming_twice_returns_the_same_project(
    client: AsyncClient, api: str
) -> None:
    """Idempotent by unique constraint, so a retried request is safe rather than duplicating."""
    quote = await _accepted(client, api)
    first = await client.post(f"{api}/quotations/{quote['id']}/confirm-down-payment", json={})
    second = await client.post(f"{api}/quotations/{quote['id']}/confirm-down-payment", json={})

    assert first.json()["id"] == second.json()["id"]
    assert len((await client.get(f"{api}/projects")).json()) == 1


async def test_an_unaccepted_quotation_cannot_be_converted(
    client: AsyncClient, api: str
) -> None:
    quote = await _quote(client, api)
    response = await client.post(
        f"{api}/quotations/{quote['id']}/confirm-down-payment", json={}
    )
    assert response.status_code == 409
    assert "accepted" in response.json()["detail"]


async def test_the_books_balance_after_confirmation(
    client: AsyncClient, api: str
) -> None:
    await _confirmed(client, api)
    tb = (await client.get(f"{api}/reports/trial-balance", params={"period": "all"})).json()
    assert tb["balanced"] is True


# ---------------------------------------------------------------------------
# §2b / §31 — Undoing
# ---------------------------------------------------------------------------


async def test_undo_reverses_both_halves_and_voids_the_project(
    client: AsyncClient, api: str
) -> None:
    """The money nets to zero, and the project is voided rather than deleted.

    Deleting it would orphan the reversal entries that carry its id — and journal entries
    are immutable, so the reference cannot be nulled either. Voiding keeps the evidence.
    """
    project = await _confirmed(client, api)

    response = await client.post(f"{api}/projects/{project['id']}/undo-down-payment")
    assert response.status_code == 200
    assert response.json()["cancelled"] is True

    assert await _balance(client, api, "1101") == D("0.00"), "cash returns to where it was"
    assert await _balance(client, api, "1401") == D("0.00")
    assert await _balance(client, api, "1201") == D("0.00")
    assert await _balance(client, api, "4101") == D("0.00")

    invoices = (
        await client.get(f"{api}/invoices", params={"project_id": project["id"]})
    ).json()
    assert {i["status"] for i in invoices} == {"Cancelled"}

    tb = (await client.get(f"{api}/reports/trial-balance", params={"period": "all"})).json()
    assert tb["balanced"] is True


async def test_undoing_releases_the_quotation_for_another_attempt(
    client: AsyncClient, api: str
) -> None:
    """The unique constraint would otherwise let a voided project block a correct retry."""
    quote = await _accepted(client, api)
    first = (
        await client.post(f"{api}/quotations/{quote['id']}/confirm-down-payment", json={})
    ).json()

    await client.post(f"{api}/projects/{first['id']}/undo-down-payment")

    second = await client.post(
        f"{api}/quotations/{quote['id']}/confirm-down-payment", json={}
    )
    assert second.status_code == 201
    assert second.json()["id"] != first["id"]


async def test_undo_is_refused_once_a_cost_has_posted(
    client: AsyncClient, api: str
) -> None:
    """§31 — undoing would orphan the cost entries, so it names what is in the way."""
    project = await _confirmed(client, api)

    await client.post(
        f"{api}/journal-entries",
        json={
            "entry_date": "2026-05-12",
            "memo": "Vendor cost against the project",
            "project_id": project["id"],
            "source": {"kind": "po", "ref": "PO-1"},
            "lines": [
                {"account": "5101", "debit": "50000000"},
                {"account": "2102", "credit": "50000000"},
            ],
        },
    )

    response = await client.post(f"{api}/projects/{project['id']}/undo-down-payment")
    assert response.status_code == 409
    assert "posting" in response.json()["detail"]


# ---------------------------------------------------------------------------
# §49–52 — Issuing, receiving, reconciling
# ---------------------------------------------------------------------------


async def test_issuing_a_scheduled_stage_raises_the_receivable(
    client: AsyncClient, api: str
) -> None:
    project = await _confirmed(client, api)
    invoices = (
        await client.get(f"{api}/invoices", params={"project_id": project["id"]})
    ).json()
    later = invoices[1]

    assert later["recognition_entry_id"] is None, "a scheduled stage has posted nothing"

    issued = await client.post(f"{api}/invoices/{later['id']}/issue")
    assert issued.status_code == 200
    assert issued.json()["status"] == "Unpaid"
    assert issued.json()["recognition_entry_id"] is not None

    # 4102 for a settlement, not 4101 which is for down payments.
    assert await _balance(client, api, "4102") == D("240000000.00")


async def test_a_late_invoice_keeps_both_dates_and_posts_on_the_later_one(
    client: AsyncClient, api: str
) -> None:
    """REQ-01 — dual-date tracking.

    The client's case: a previous month's invoice arrives late. It must be recorded now,
    not backdated into a month that is closed, while still showing the date the document
    actually carries. So the posting takes the RECORDING date and the invoice keeps its own.

    Before this, the endpoint accepted no body at all and always used today — there was no
    way to express either date.
    """
    project = await _confirmed(client, api)
    invoices = (
        await client.get(f"{api}/invoices", params={"project_id": project["id"]})
    ).json()
    later = invoices[1]

    issued = await client.post(
        f"{api}/invoices/{later['id']}/issue",
        json={"issued_on": "2026-10-03", "document_date": "2026-09-28"},
    )
    assert issued.status_code == 200
    body = issued.json()
    assert body["document_date"] == "2026-09-28", "the document keeps its own date"
    assert body["issued_at"] == "2026-10-03", "and the recording date is when it was raised"

    # The accounting date is the recording date. This is the half that matters: dating the
    # posting September would push it into a period that may already be closed.
    entry = (await client.get(f"{api}/journal-entries/{body['recognition_entry_id']}")).json()
    assert entry["entry_date"] == "2026-10-03"
    # And the source carries the document's date, so the two reconcile.
    assert entry["source_document_date"] == "2026-09-28"


async def test_an_invoice_dated_the_day_it_is_raised_needs_only_one_date(
    client: AsyncClient, api: str
) -> None:
    """The common case stays one click: omit the document date and it follows the posting."""
    project = await _confirmed(client, api)
    invoices = (
        await client.get(f"{api}/invoices", params={"project_id": project["id"]})
    ).json()
    issued = (
        await client.post(
            f"{api}/invoices/{invoices[1]['id']}/issue", json={"issued_on": "2026-10-03"}
        )
    ).json()
    assert issued["document_date"] == "2026-10-03"
    assert issued["issued_at"] == "2026-10-03"


async def test_issuing_with_no_body_still_works(client: AsyncClient, api: str) -> None:
    """The body is optional, so every existing caller is unaffected."""
    project = await _confirmed(client, api)
    invoices = (
        await client.get(f"{api}/invoices", params={"project_id": project["id"]})
    ).json()
    response = await client.post(f"{api}/invoices/{invoices[1]['id']}/issue")
    assert response.status_code == 200
    # Dated today by the injectable clock, and the document date follows it.
    assert response.json()["document_date"] == response.json()["issued_at"]


async def test_issuing_twice_is_refused(client: AsyncClient, api: str) -> None:
    project = await _confirmed(client, api)
    invoices = (
        await client.get(f"{api}/invoices", params={"project_id": project["id"]})
    ).json()
    await client.post(f"{api}/invoices/{invoices[1]['id']}/issue")

    again = await client.post(f"{api}/invoices/{invoices[1]['id']}/issue")
    assert again.status_code == 409


async def test_paying_a_scheduled_stage_is_refused(
    client: AsyncClient, api: str
) -> None:
    project = await _confirmed(client, api)
    invoices = (
        await client.get(f"{api}/invoices", params={"project_id": project["id"]})
    ).json()

    response = await client.post(
        f"{api}/invoices/{invoices[1]['id']}/payments", json={"amount": "1000"}
    )
    assert response.status_code == 409
    assert "not been issued" in response.json()["detail"]


async def test_a_partial_payment_leaves_the_balance_open(
    client: AsyncClient, api: str
) -> None:
    project = await _confirmed(client, api)
    invoices = (
        await client.get(f"{api}/invoices", params={"project_id": project["id"]})
    ).json()
    later = invoices[1]
    await client.post(f"{api}/invoices/{later['id']}/issue")

    receipt = await client.post(
        f"{api}/invoices/{later['id']}/payments", json={"amount": "100000000"}
    )
    assert receipt.status_code == 200
    body = receipt.json()

    assert body["gross"] == "100000000.00"
    assert body["tax"] == "2000000.00"
    assert body["net"] == "98000000.00"
    assert body["invoice"]["status"] == "Partially Paid"
    assert body["invoice"]["outstanding"] == "140000000.00"


async def test_an_overpayment_is_clamped_to_outstanding(
    client: AsyncClient, api: str
) -> None:
    """An overpayment is not a bigger receipt — letting it through would push 1201 negative."""
    project = await _confirmed(client, api)
    invoices = (
        await client.get(f"{api}/invoices", params={"project_id": project["id"]})
    ).json()
    later = invoices[1]
    await client.post(f"{api}/invoices/{later['id']}/issue")

    body = (
        await client.post(
            f"{api}/invoices/{later['id']}/payments", json={"amount": "999999999999"}
        )
    ).json()

    assert body["gross"] == "240000000.00", "clamped to what was outstanding"
    assert body["invoice"]["status"] == "Paid"


async def test_a_settled_invoice_refuses_further_payment(
    client: AsyncClient, api: str
) -> None:
    project = await _confirmed(client, api)
    invoices = (
        await client.get(f"{api}/invoices", params={"project_id": project["id"]})
    ).json()

    response = await client.post(
        f"{api}/invoices/{invoices[0]['id']}/payments", json={"amount": "1000"}
    )
    assert response.status_code == 409
    assert "settled" in response.json()["detail"]


async def test_withholding_can_be_waived(client: AsyncClient, api: str) -> None:
    project = await _confirmed(client, api)
    invoices = (
        await client.get(f"{api}/invoices", params={"project_id": project["id"]})
    ).json()
    later = invoices[1]
    await client.post(f"{api}/invoices/{later['id']}/issue")

    body = (
        await client.post(
            f"{api}/invoices/{later['id']}/payments",
            json={"amount": "240000000", "withhold": False},
        )
    ).json()

    assert body["tax"] == "0.00"
    assert body["net"] == "240000000.00"


async def test_withholding_can_be_overridden(client: AsyncClient, api: str) -> None:
    """The client asked for a manual override; the UI warns, the API allows."""
    project = await _confirmed(client, api)
    invoices = (
        await client.get(f"{api}/invoices", params={"project_id": project["id"]})
    ).json()
    later = invoices[1]
    await client.post(f"{api}/invoices/{later['id']}/issue")

    body = (
        await client.post(
            f"{api}/invoices/{later['id']}/payments",
            json={"amount": "240000000", "tax_amount": "1234567"},
        )
    ).json()
    assert body["tax"] == "1234567.00"
    assert body["net"] == "238765433.00"


async def test_tax_exceeding_the_payment_is_refused(
    client: AsyncClient, api: str
) -> None:
    """It would post negative cash."""
    project = await _confirmed(client, api)
    invoices = (
        await client.get(f"{api}/invoices", params={"project_id": project["id"]})
    ).json()
    later = invoices[1]
    await client.post(f"{api}/invoices/{later['id']}/issue")

    response = await client.post(
        f"{api}/invoices/{later['id']}/payments",
        json={"amount": "1000", "tax_amount": "5000"},
    )
    assert response.status_code == 422
    assert "exceeds" in response.json()["detail"]


async def test_the_receipt_returns_the_exact_posting(
    client: AsyncClient, api: str
) -> None:
    """The prototype's modal previews the lines before submission; the API returns them."""
    project = await _confirmed(client, api)
    invoices = (
        await client.get(f"{api}/invoices", params={"project_id": project["id"]})
    ).json()
    later = invoices[1]
    await client.post(f"{api}/invoices/{later['id']}/issue")

    posting = (
        await client.post(
            f"{api}/invoices/{later['id']}/payments", json={"amount": "240000000"}
        )
    ).json()["posting"]

    by_account = {line["account"]: line for line in posting}
    assert by_account["1101"]["debit"] == "235200000.00"
    assert by_account["1401"]["debit"] == "4800000.00"
    assert by_account["1201"]["credit"] == "240000000.00"


# ---------------------------------------------------------------------------
# §52 / §6 — AR reconciles with the ledger
# ---------------------------------------------------------------------------


async def test_outstanding_invoices_equal_ledger_1201(
    client: AsyncClient, api: str
) -> None:
    """§6 and §52 — the reconciliation the Receivables badge shows."""
    project = await _confirmed(client, api)
    invoices = (
        await client.get(f"{api}/invoices", params={"project_id": project["id"]})
    ).json()
    await client.post(f"{api}/invoices/{invoices[1]['id']}/issue")

    ageing = (await client.get(f"{api}/receivables/ageing")).json()
    assert ageing["total"] == "240000000.00"
    assert ageing["ledger_balance"] == "240000000.00"
    assert ageing["difference"] == "0.00"
    assert ageing["reconciled"] is True


async def test_scheduled_stages_are_excluded_from_ar(
    client: AsyncClient, api: str
) -> None:
    """A plan is not a debt. Counting one would put AR permanently out of step with 1201."""
    await _confirmed(client, api)

    ageing = (await client.get(f"{api}/receivables/ageing")).json()
    assert ageing["total"] == "0.00", "the DP is settled and the rest is only scheduled"
    assert ageing["scheduled"] == "240000000.00"
    assert ageing["scheduled_count"] == 1
    assert ageing["reconciled"] is True


async def test_ageing_buckets_an_overdue_invoice(client: AsyncClient, api: str) -> None:
    project = await _confirmed(client, api)
    invoices = (
        await client.get(f"{api}/invoices", params={"project_id": project["id"]})
    ).json()
    await client.post(f"{api}/invoices/{invoices[1]['id']}/issue")

    # The settlement is due 2026-11-11; look from well after that.
    ageing = (
        await client.get(f"{api}/receivables/ageing", params={"as_of": "2026-12-20"})
    ).json()

    buckets = {b["key"]: b for b in ageing["buckets"]}
    assert buckets["31-60"]["amount"] == "240000000.00"
    assert ageing["overdue"] == "240000000.00"


async def test_reversing_a_receipt_reopens_the_invoice(
    client: AsyncClient, api: str
) -> None:
    project = await _confirmed(client, api)
    invoices = (
        await client.get(f"{api}/invoices", params={"project_id": project["id"]})
    ).json()
    dp = invoices[0]

    entries = (await client.get(f"{api}/journal-entries", params={"source_kind": "payment"})).json()
    receipt_id = entries["items"][0]["id"]

    await client.post(f"{api}/journal-entries/{receipt_id}/reverse")

    refreshed = (await client.get(f"{api}/invoices/{dp['id']}")).json()
    assert refreshed["outstanding"] == "240000000.00", "the receivable is open again"


# ---------------------------------------------------------------------------
# §14 / §15 — Stages and cancellation
# ---------------------------------------------------------------------------


async def test_stages_advance_and_revert(client: AsyncClient, api: str) -> None:
    project = await _confirmed(client, api)

    advanced = await client.post(f"{api}/projects/{project['id']}/advance-stage")
    assert advanced.json()["stage"] == "Design Uploaded"

    reverted = await client.post(f"{api}/projects/{project['id']}/revert-stage")
    assert reverted.json()["stage"] == "DP Paid"


async def test_cannot_revert_past_the_first_stage(client: AsyncClient, api: str) -> None:
    project = await _confirmed(client, api)
    response = await client.post(f"{api}/projects/{project['id']}/revert-stage")
    assert response.status_code == 409
    assert "first stage" in response.json()["detail"]


async def test_cancelling_without_a_refund_keeps_the_revenue(
    client: AsyncClient, api: str
) -> None:
    """§15 — costs already incurred are never reversed, and nor is unrefunded revenue."""
    project = await _confirmed(client, api)

    response = await client.post(
        f"{api}/projects/{project['id']}/cancel",
        json={"reason": "Client postponed indefinitely", "refund_dp": False},
    )
    assert response.status_code == 200
    assert response.json()["cancelled"] is True

    assert await _balance(client, api, "4101") == D("240000000.00")


# ---------------------------------------------------------------------------
# CRM
# ---------------------------------------------------------------------------


async def test_a_note_records_who_actually_wrote_it(
    client: AsyncClient, api: str
) -> None:
    """§64 — the author comes from the token, not the request body."""
    client_id = await _client_id(client, api)
    me = (await client.get(f"{api}/auth/me")).json()

    note = await client.post(
        f"{api}/clients/{client_id}/interactions",
        json={"note": "Agreed 50% DP. Site survey next Tuesday."},
    )
    assert note.status_code == 201
    assert note.json()["author_user_id"] == me["id"]
    # And the name travels with it: the CRM timeline shows who wrote each note, and there is
    # no users endpoint for the frontend to resolve the id against. A null here would print
    # an unattributed note, which is the silent version of getting the author wrong.
    assert note.json()["author_name"] == me["full_name"]


async def test_an_empty_note_is_refused(client: AsyncClient, api: str) -> None:
    client_id = await _client_id(client, api)
    response = await client.post(
        f"{api}/clients/{client_id}/interactions", json={"note": "   "}
    )
    assert response.status_code == 422


async def test_a_note_can_be_edited_and_records_that_it_was(
    client: AsyncClient, api: str
) -> None:
    """The client asked for notes they could "create, edit, and attach".

    `edited_at` existed on the model with nothing to set it, so an edit was indistinguishable
    from the original. A CRM note is a record of what somebody was told, so the fact that it
    later changed is part of the record.
    """
    client_id = await _client_id(client, api)
    created = (
        await client.post(
            f"{api}/clients/{client_id}/interactions",
            json={"note": "Wants the gala in blue."},
        )
    ).json()
    assert created["edited_at"] is None

    edited = await client.patch(
        f"{api}/interactions/{created['id']}",
        json={"note": "Wants the gala in gold, not blue."},
    )
    assert edited.status_code == 200
    body = edited.json()
    assert body["note"] == "Wants the gala in gold, not blue."
    assert body["edited_at"] is not None
    # Whoever wrote it still wrote it.
    assert body["author_user_id"] == created["author_user_id"]


async def test_editing_a_note_to_blank_is_refused(client: AsyncClient, api: str) -> None:
    client_id = await _client_id(client, api)
    created = (
        await client.post(
            f"{api}/clients/{client_id}/interactions", json={"note": "Something real."}
        )
    ).json()
    response = await client.patch(f"{api}/interactions/{created['id']}", json={"note": "   "})
    assert response.status_code == 422


async def test_a_note_can_be_deleted(client: AsyncClient, api: str) -> None:
    client_id = await _client_id(client, api)
    created = (
        await client.post(
            f"{api}/clients/{client_id}/interactions", json={"note": "Logged in error."}
        )
    ).json()

    assert (await client.delete(f"{api}/interactions/{created['id']}")).status_code == 204
    remaining = (await client.get(f"{api}/clients/{client_id}/interactions")).json()
    assert created["id"] not in {n["id"] for n in remaining}
    # And it is gone, not merely hidden.
    assert (
        await client.patch(f"{api}/interactions/{created['id']}", json={"note": "back"})
    ).status_code == 404


async def test_a_client_can_be_amended_in_place(client: AsyncClient, api: str) -> None:
    """The phone number is the field that goes stale most often, so the CRM edits it inline."""
    client_id = await _client_id(client, api)
    before = (await client.get(f"{api}/clients")).json()
    original = [c for c in before if c["id"] == client_id][0]

    response = await client.patch(
        f"{api}/clients/{client_id}", json={"phone": "+62 811 9999 111"}
    )
    assert response.status_code == 200
    assert response.json()["phone"] == "+62 811 9999 111"
    # Only what was sent changed.
    assert response.json()["name"] == original["name"]
    assert response.json()["client_no"] == original["client_no"]


# ---------------------------------------------------------------------------
# MoU templates
# ---------------------------------------------------------------------------


async def test_the_three_seeded_templates(client: AsyncClient, api: str) -> None:
    templates = (await client.get(f"{api}/mou-templates")).json()
    assert {t["id"] for t in templates} == {"corporate", "wedding", "government"}
    assert [t for t in templates if t["is_default"]][0]["id"] == "corporate"
    assert all(t["clauses"] for t in templates)


async def test_deleting_a_template_used_by_an_accepted_quotation_is_refused(
    client: AsyncClient, api: str
) -> None:
    """Its MoU is contractual and would become unreproducible."""
    await _accepted(client, api)

    response = await client.delete(f"{api}/mou-templates/corporate")
    assert response.status_code == 409
    assert "unreproducible" in response.json()["detail"]


# ---------------------------------------------------------------------------
# Permissions
# ---------------------------------------------------------------------------


async def test_only_finance_and_the_ceo_may_confirm_a_down_payment(
    client: AsyncClient, client_for, api: str
) -> None:
    from app.domain.masters.models import Role

    quote = await _accepted(client, api)

    pm = await client_for(Role.PM)
    response = await pm.post(
        f"{api}/quotations/{quote['id']}/confirm-down-payment", json={}
    )
    assert response.status_code == 403
    assert response.json()["action"] == "confirm_dp"
