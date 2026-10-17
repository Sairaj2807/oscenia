"""Phase 6 — cash operations.

Ports ``verify-ledger.mjs`` §5 (petty cash reconciles) and ``verify-flows.mjs`` §4 (a top-up
moves money without creating it), §5 (approve → disburse → settle), §16 (the budget
tolerance flags once) and §65 (petty cash cannot be issued anonymously).

Attachments are the one genuinely **new** capability rather than a port: the prototype
stores filenames as bare strings and its own vendor screen admits real uploads need a
backend. A receipt is evidence for an audit, and a filename is not evidence.
"""

from __future__ import annotations

import io
from decimal import Decimal

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.phase6

D = Decimal
PDF = b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n"


async def _balance(client: AsyncClient, api: str, code: str) -> Decimal:
    body = (
        await client.get(
            f"{api}/reports/general-ledger", params={"codes": [code], "period": "all"}
        )
    ).json()
    return Decimal(body["closing"])


async def _total_cash(client: AsyncClient, api: str) -> Decimal:
    return Decimal((await client.get(f"{api}/reports/cash-position")).json()["total"])


async def _fund(client: AsyncClient, api: str, amount: str = "500000000") -> None:
    """Open the books with capital in the main bank."""
    posted = await client.post(
        f"{api}/journal-entries",
        json={
            "entry_date": "2026-05-01",
            "memo": "Opening capital",
            "source": {"kind": "opening", "ref": "FY2026"},
            "lines": [
                {"account": "1101", "debit": amount},
                {"account": "3102", "credit": amount},
            ],
        },
    )
    assert posted.status_code == 201, posted.text


async def _upload(client: AsyncClient, api: str, name: str = "receipt.pdf") -> dict:
    response = await client.post(
        f"{api}/attachments",
        files={"file": (name, io.BytesIO(PDF), "application/pdf")},
    )
    assert response.status_code == 201, response.text
    return response.json()


async def _request(
    client: AsyncClient,
    api: str,
    *,
    category: str = "Field Cash Advance",
    amount: str = "8500000",
    requester: str | None = "Bagus S.",
    project_id: str | None = None,
) -> dict:
    body = {"category": category, "amount": amount}
    if requester is not None:
        body["requested_by"] = requester
    if project_id is not None:
        body["project_id"] = project_id

    response = await client.post(f"{api}/procurement-requests", json=body)
    assert response.status_code == 201, response.text
    return response.json()


async def _move(client: AsyncClient, api: str, request_id: str, to: str) -> dict:
    response = await client.post(
        f"{api}/procurement-requests/{request_id}/transition", json={"status": to}
    )
    assert response.status_code == 200, response.text
    return response.json()


async def _disbursed(client: AsyncClient, api: str, **kw) -> dict:
    request = await _request(client, api, **kw)
    for step in ("Pending", "Approved", "Disbursed"):
        request = await _move(client, api, request["id"], step)
    return request


# ---------------------------------------------------------------------------
# §4 — Petty cash is a float
# ---------------------------------------------------------------------------


async def test_a_top_up_moves_money_without_creating_it(
    client: AsyncClient, api: str
) -> None:
    """§4 — the invariant that makes petty cash a float rather than income."""
    await _fund(client, api)
    before = await _total_cash(client, api)

    response = await client.post(f"{api}/petty-cash/top-up", json={"amount": "15000000"})
    assert response.status_code == 200, response.text

    assert await _total_cash(client, api) == before, "total cash unchanged by a transfer"
    assert await _balance(client, api, "1103") == D("15000000.00")
    assert await _balance(client, api, "1101") == D("485000000.00")


async def test_a_zero_or_negative_top_up_is_refused(
    client: AsyncClient, api: str
) -> None:
    await _fund(client, api)
    assert (
        await client.post(f"{api}/petty-cash/top-up", json={"amount": "0"})
    ).status_code == 422
    assert (
        await client.post(f"{api}/petty-cash/top-up", json={"amount": "-100"})
    ).status_code == 422


async def test_the_float_position_reconciles_with_the_ledger(
    client: AsyncClient, api: str
) -> None:
    """§5 — one source of truth, not two that have to agree."""
    await _fund(client, api)
    await client.post(f"{api}/petty-cash/top-up", json={"amount": "40000000"})
    await _disbursed(client, api, amount="8500000")
    await _disbursed(client, api, amount="3200000")

    position = (await client.get(f"{api}/petty-cash")).json()
    assert position["balance"] == "28300000.00", "40M float less 8.5M and 3.2M"
    assert position["balance"] == str(await _balance(client, api, "1103"))
    assert position["disbursed"] == "11700000.00"


async def test_pending_requests_are_reported_as_awaiting_approval(
    client: AsyncClient, api: str
) -> None:
    await _fund(client, api)
    request = await _request(client, api, amount="5000000")
    await _move(client, api, request["id"], "Pending")

    position = (await client.get(f"{api}/petty-cash")).json()
    assert position["awaiting_approval"] == "5000000.00"
    assert position["awaiting_count"] == 1


# ---------------------------------------------------------------------------
# §65 — Petty cash cannot be issued anonymously
# ---------------------------------------------------------------------------


async def test_a_blank_requester_is_refused(client: AsyncClient, api: str) -> None:
    """The client asked for this by name. Defaulting a deliberate blank would defeat it."""
    response = await client.post(
        f"{api}/procurement-requests",
        json={"category": "Transport", "amount": "500000", "requested_by": "   "},
    )
    assert response.status_code == 422
    assert "anonymously" in response.json()["detail"]


async def test_an_omitted_requester_defaults_to_the_signed_in_user(
    client: AsyncClient, api: str
) -> None:
    me = (await client.get(f"{api}/auth/me")).json()
    request = await _request(client, api, requester=None)
    assert request["requested_by"] == me["full_name"]


async def test_the_requester_reaches_the_journal_line(
    client: AsyncClient, api: str
) -> None:
    """Traceability is the whole point — the ledger has to name who asked."""
    await _fund(client, api)
    await client.post(f"{api}/petty-cash/top-up", json={"amount": "20000000"})
    request = await _disbursed(client, api, requester="Rina K.", amount="1500000")

    entries = (
        await client.get(f"{api}/journal-entries", params={"source_kind": "pettycash"})
    ).json()["items"]
    disbursement = next(e for e in entries if e["source_ref"] == request["request_no"])

    notes = " ".join(line["note"] or "" for line in disbursement["lines"])
    assert "Rina K." in notes


async def test_the_recap_groups_by_requester(client: AsyncClient, api: str) -> None:
    """The client's "Recap by Requester", so an auditor can chase a person not a number."""
    await _fund(client, api)
    await client.post(f"{api}/petty-cash/top-up", json={"amount": "50000000"})

    await _disbursed(client, api, requester="Bagus S.", amount="3000000")
    await _disbursed(client, api, requester="Bagus S.", amount="2000000")
    await _disbursed(client, api, requester="Rina K.", amount="1000000")

    rows = (await client.get(f"{api}/procurement-requests/by-requester")).json()
    by_name = {r["requester"]: r for r in rows}

    assert by_name["Bagus S."]["count"] == 2
    assert by_name["Bagus S."]["requested"] == "5000000.00"
    assert by_name["Rina K."]["requested"] == "1000000.00"
    assert by_name["Bagus S."]["still_open"] == "5000000.00", "disbursed, not yet settled"


# ---------------------------------------------------------------------------
# §5 — The approval workflow
# ---------------------------------------------------------------------------


async def test_the_workflow_runs_draft_to_completed(
    client: AsyncClient, api: str
) -> None:
    await _fund(client, api)
    await client.post(f"{api}/petty-cash/top-up", json={"amount": "20000000"})

    request = await _request(client, api, amount="5000000")
    assert request["status"] == "Draft"

    for step in ("Pending", "Approved", "Disbursed"):
        request = await _move(client, api, request["id"], step)
        assert request["status"] == step

    receipt = await _upload(client, api)
    settled = await client.post(
        f"{api}/procurement-requests/{request['id']}/settle",
        json={"actual": "3500000", "attachment_ids": [receipt["id"]]},
    )
    assert settled.status_code == 200, settled.text
    assert settled.json()["status"] == "Completed"


async def test_a_request_cannot_skip_approval(client: AsyncClient, api: str) -> None:
    """Jumping Draft straight to Disbursed would bypass the control the client asked for."""
    request = await _request(client, api)
    response = await client.post(
        f"{api}/procurement-requests/{request['id']}/transition",
        json={"status": "Disbursed"},
    )
    assert response.status_code == 409
    assert "Pending" in response.json()["detail"]


async def test_disbursing_a_petty_category_draws_from_the_float(
    client: AsyncClient, api: str
) -> None:
    await _fund(client, api)
    await client.post(f"{api}/petty-cash/top-up", json={"amount": "20000000"})
    await _disbursed(client, api, category="Petty Cash — Crew Meals", amount="1500000")

    assert await _balance(client, api, "1103") == D("18500000.00"), "from the float"
    assert await _balance(client, api, "5103") == D("1500000.00"), "into logistics"


async def test_disbursing_a_non_petty_category_draws_from_the_bank(
    client: AsyncClient, api: str
) -> None:
    await _fund(client, api)
    await _disbursed(client, api, category="Vendor — Sound Equipment", amount="12000000")

    assert await _balance(client, api, "5101") == D("12000000.00"), "into vendor costs"
    assert await _balance(client, api, "1101") == D("488000000.00"), "from the main bank"
    assert await _balance(client, api, "1103") == D("0.00"), "the float is untouched"


async def test_a_rejected_request_posts_nothing(client: AsyncClient, api: str) -> None:
    await _fund(client, api)
    request = await _request(client, api)
    await _move(client, api, request["id"], "Pending")

    rejected = await client.post(
        f"{api}/procurement-requests/{request['id']}/transition",
        json={"status": "Rejected", "reason": "Not budgeted"},
    )
    assert rejected.json()["status"] == "Rejected"
    assert rejected.json()["reject_reason"] == "Not budgeted"
    assert await _balance(client, api, "1103") == D("0.00")


# ---------------------------------------------------------------------------
# Settlement
# ---------------------------------------------------------------------------


async def test_unused_funds_return_to_the_float(client: AsyncClient, api: str) -> None:
    await _fund(client, api)
    await client.post(f"{api}/petty-cash/top-up", json={"amount": "20000000"})
    request = await _disbursed(client, api, amount="5000000")

    receipt = await _upload(client, api)
    settled = (
        await client.post(
            f"{api}/procurement-requests/{request['id']}/settle",
            json={"actual": "3500000", "attachment_ids": [receipt["id"]]},
        )
    ).json()

    assert settled["actual"] == "3500000.00"
    assert settled["variance"] == "1500000.00", "positive means money came back"
    assert await _balance(client, api, "1103") == D("16500000.00"), "20M - 5M + 1.5M back"
    assert await _balance(client, api, "5103") == D("3500000.00"), "cost is the actual"


async def test_a_shortfall_is_reimbursed(client: AsyncClient, api: str) -> None:
    await _fund(client, api)
    await client.post(f"{api}/petty-cash/top-up", json={"amount": "20000000"})
    request = await _disbursed(client, api, amount="3000000")

    receipt = await _upload(client, api)
    settled = (
        await client.post(
            f"{api}/procurement-requests/{request['id']}/settle",
            json={"actual": "4200000", "attachment_ids": [receipt["id"]]},
        )
    ).json()

    assert settled["variance"] == "-1200000.00", "negative means we paid out more"
    assert await _balance(client, api, "5103") == D("4200000.00")
    assert await _balance(client, api, "1103") == D("15800000.00")


async def test_settling_without_a_receipt_is_refused(
    client: AsyncClient, api: str
) -> None:
    """An advance settled on an assertion alone is an unevidenced cash movement."""
    await _fund(client, api)
    await client.post(f"{api}/petty-cash/top-up", json={"amount": "20000000"})
    request = await _disbursed(client, api)

    response = await client.post(
        f"{api}/procurement-requests/{request['id']}/settle",
        json={"actual": "1000000", "attachment_ids": []},
    )
    assert response.status_code == 422


async def test_settling_an_undisbursed_request_is_refused(
    client: AsyncClient, api: str
) -> None:
    request = await _request(client, api)
    receipt = await _upload(client, api)

    response = await client.post(
        f"{api}/procurement-requests/{request['id']}/settle",
        json={"actual": "100", "attachment_ids": [receipt["id"]]},
    )
    assert response.status_code == 409


async def test_settling_exactly_posts_nothing_further(
    client: AsyncClient, api: str
) -> None:
    await _fund(client, api)
    await client.post(f"{api}/petty-cash/top-up", json={"amount": "20000000"})
    request = await _disbursed(client, api, amount="5000000")
    before = await _balance(client, api, "1103")

    receipt = await _upload(client, api)
    settled = (
        await client.post(
            f"{api}/procurement-requests/{request['id']}/settle",
            json={"actual": "5000000", "attachment_ids": [receipt["id"]]},
        )
    ).json()

    assert settled["variance"] == "0.00"
    assert await _balance(client, api, "1103") == before


async def test_the_books_balance_through_the_whole_cycle(
    client: AsyncClient, api: str
) -> None:
    await _fund(client, api)
    await client.post(f"{api}/petty-cash/top-up", json={"amount": "20000000"})
    request = await _disbursed(client, api, amount="5000000")
    receipt = await _upload(client, api)
    await client.post(
        f"{api}/procurement-requests/{request['id']}/settle",
        json={"actual": "3500000", "attachment_ids": [receipt["id"]]},
    )

    tb = (await client.get(f"{api}/reports/trial-balance", params={"period": "all"})).json()
    assert tb["balanced"] is True


# ---------------------------------------------------------------------------
# Attachments — the new capability
# ---------------------------------------------------------------------------


async def test_a_file_is_stored_and_can_be_read_back(
    client: AsyncClient, api: str
) -> None:
    uploaded = await _upload(client, api, "scan.pdf")
    assert uploaded["filename"] == "scan.pdf"
    assert uploaded["byte_size"] == len(PDF)
    assert len(uploaded["sha256"]) == 64

    downloaded = await client.get(f"{api}/attachments/{uploaded['id']}")
    assert downloaded.status_code == 200
    assert downloaded.content == PDF


async def test_an_unaccepted_file_type_is_refused(client: AsyncClient, api: str) -> None:
    """Narrow on purpose: this is an evidence store, not a general file share."""
    response = await client.post(
        f"{api}/attachments",
        files={"file": ("payload.exe", io.BytesIO(b"MZ..."), "application/x-msdownload")},
    )
    assert response.status_code == 422
    assert "not an accepted file type" in response.json()["detail"]


async def test_an_empty_file_is_refused(client: AsyncClient, api: str) -> None:
    response = await client.post(
        f"{api}/attachments",
        files={"file": ("empty.pdf", io.BytesIO(b""), "application/pdf")},
    )
    assert response.status_code == 422


async def test_uploading_the_same_file_twice_is_content_addressed(
    client: AsyncClient, api: str
) -> None:
    """Same bytes, same hash — a duplicate costs no extra storage."""
    first = await _upload(client, api, "a.pdf")
    second = await _upload(client, api, "b.pdf")

    assert first["sha256"] == second["sha256"]
    assert first["id"] != second["id"], "still two records, pointing at one blob"


async def test_an_oversized_file_is_refused(client: AsyncClient, api: str) -> None:
    """Measured while streaming, not taken from Content-Length, which a client can fake."""
    from app.core.config import get_settings

    oversized = b"%PDF-" + b"0" * (get_settings().max_upload_bytes + 1)
    response = await client.post(
        f"{api}/attachments",
        files={"file": ("big.pdf", io.BytesIO(oversized), "application/pdf")},
    )
    assert response.status_code == 422
    assert "larger than" in response.json()["detail"]


async def test_a_receipt_is_linked_to_its_request(client: AsyncClient, api: str) -> None:
    await _fund(client, api)
    await client.post(f"{api}/petty-cash/top-up", json={"amount": "20000000"})
    request = await _disbursed(client, api, amount="1000000")

    receipt = await _upload(client, api)
    settled = (
        await client.post(
            f"{api}/procurement-requests/{request['id']}/settle",
            json={"actual": "900000", "attachment_ids": [receipt["id"]]},
        )
    ).json()

    assert [r["attachment_id"] for r in settled["receipts"]] == [receipt["id"]]


# ---------------------------------------------------------------------------
# §16 — Budgets
# ---------------------------------------------------------------------------


async def test_budget_actuals_are_derived_from_postings(
    client: AsyncClient, api: str, make_project
) -> None:
    """No stored `realized` column, so the plan and the reality cannot drift."""
    project_id = await make_project("Aurora Gala")

    await client.put(
        f"{api}/projects/{project_id}/budget",
        json={
            "categories": [
                {
                    "key": "vendors",
                    "label": "Vendors",
                    "ceiling": "150000000",
                    "account_codes": ["5101"],
                },
                {
                    "key": "logistics",
                    "label": "Logistics",
                    "ceiling": "55000000",
                    "account_codes": ["5103"],
                },
            ]
        },
    )

    await client.post(
        f"{api}/journal-entries",
        json={
            "entry_date": "2026-05-12",
            "memo": "Vendor cost",
            "project_id": project_id,
            "source": {"kind": "po", "ref": "PO-1"},
            "lines": [
                {"account": "5101", "debit": "138000000"},
                {"account": "2102", "credit": "138000000"},
            ],
        },
    )

    budget = (await client.get(f"{api}/projects/{project_id}/budget")).json()
    vendors = next(c for c in budget["categories"] if c["key"] == "vendors")

    assert vendors["spent"] == "138000000.00"
    assert vendors["remaining"] == "12000000.00"
    assert Decimal(str(vendors["utilisation"])) == D("92.00")
    assert vendors["over"] is False


async def test_a_category_over_its_ceiling_is_flagged(
    client: AsyncClient, api: str, make_project
) -> None:
    project_id = await make_project()
    await client.put(
        f"{api}/projects/{project_id}/budget",
        json={
            "categories": [
                {
                    "key": "vendors",
                    "label": "Vendors",
                    "ceiling": "100000000",
                    "account_codes": ["5101"],
                }
            ]
        },
    )
    await client.post(
        f"{api}/journal-entries",
        json={
            "entry_date": "2026-05-12",
            "memo": "Overspend",
            "project_id": project_id,
            "source": {"kind": "po", "ref": "PO-2"},
            "lines": [
                {"account": "5101", "debit": "122000000"},
                {"account": "2102", "credit": "122000000"},
            ],
        },
    )

    budget = (await client.get(f"{api}/projects/{project_id}/budget")).json()
    vendors = budget["categories"][0]
    assert vendors["over"] is True
    assert vendors["remaining"] == "-22000000.00"


async def test_the_tolerance_warns_once_and_never_blocks(
    client: AsyncClient, api: str, make_project
) -> None:
    """§16 — the client was explicit that this raises a flag, not a barrier."""
    await _fund(client, api)
    project_id = await make_project("Tight Budget", contract="10000000")

    # The project's estimate is what the tolerance measures against; make it small.
    for _ in range(2):
        await _disbursed(
            client,
            api,
            category="Vendor — Sound",
            amount="9000000",
            project_id=project_id,
        )

    alerts = (await client.get(f"{api}/alerts/budget-breaches")).json()
    mine = [a for a in alerts if a["project_id"] == project_id]

    assert len(mine) == 1, "flagged once, not once per posting"
    assert Decimal(mine[0]["over_by"]) > 0


async def test_the_tolerance_is_configurable(client: AsyncClient, api: str) -> None:
    defaults = (await client.get(f"{api}/settings")).json()
    assert Decimal(str(defaults["budget_tolerance_pct"])) == D("10")

    updated = await client.patch(f"{api}/settings", json={"budget_tolerance_pct": "25"})
    assert updated.status_code == 200
    assert Decimal(str(updated.json()["budget_tolerance_pct"])) == D("25")


async def test_the_commission_rate_is_a_company_setting(client: AsyncClient, api: str) -> None:
    defaults = (await client.get(f"{api}/settings")).json()
    assert Decimal(str(defaults["commission_pct"])) == D("2.5")

    updated = await client.patch(f"{api}/settings", json={"commission_pct": "3.75"})
    assert updated.status_code == 200
    assert Decimal(str(updated.json()["commission_pct"])) == D("3.75")
    # The other settings are untouched by a partial update.
    assert Decimal(str(updated.json()["budget_tolerance_pct"])) == D("10")

    for bad in ("-1", "101"):
        refused = await client.patch(f"{api}/settings", json={"commission_pct": bad})
        assert refused.status_code == 422


async def test_a_project_without_a_budget_is_a_404(
    client: AsyncClient, api: str, make_project
) -> None:
    project_id = await make_project()
    assert (
        await client.get(f"{api}/projects/{project_id}/budget")
    ).status_code == 404


async def test_replacing_budget_categories_does_not_collide(
    client: AsyncClient, api: str, make_project
) -> None:
    """UNIQUE (budget_id, key) collides unless the deletes are flushed first."""
    project_id = await make_project()
    payload = {
        "categories": [
            {"key": "vendors", "label": "Vendors", "ceiling": "100", "account_codes": ["5101"]}
        ]
    }
    assert (
        await client.put(f"{api}/projects/{project_id}/budget", json=payload)
    ).status_code == 200

    payload["categories"][0]["ceiling"] = "200"
    second = await client.put(f"{api}/projects/{project_id}/budget", json=payload)
    assert second.status_code == 200
    assert second.json()["categories"][0]["ceiling"] == "200.00"


# ---------------------------------------------------------------------------
# Permissions
# ---------------------------------------------------------------------------


async def test_a_pm_may_request_but_not_approve_cash(
    client: AsyncClient, client_for, api: str
) -> None:
    """§37 again, in the module the client's deck used to make the point."""
    from app.domain.masters.models import Role

    pm = await client_for(Role.PM)

    raised = await pm.post(
        f"{api}/procurement-requests",
        json={"category": "Transport", "amount": "500000", "requested_by": "Agus P."},
    )
    assert raised.status_code == 201, "a PM may request"

    request_id = raised.json()["id"]
    blocked = await pm.post(
        f"{api}/procurement-requests/{request_id}/transition", json={"status": "Pending"}
    )
    assert blocked.status_code == 403
    assert blocked.json()["action"] == "approve_cash"


async def test_only_finance_may_top_up_the_float(
    client: AsyncClient, client_for, api: str
) -> None:
    from app.domain.masters.models import Role

    warehouse = await client_for(Role.WAREHOUSE)
    response = await warehouse.post(f"{api}/petty-cash/top-up", json={"amount": "1000000"})
    assert response.status_code == 403
    assert response.json()["action"] == "approve_cash"
