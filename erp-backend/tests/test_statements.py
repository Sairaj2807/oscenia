"""Phase 3 — statements, project P&L and tax configuration.

Ports ``verify-ledger.mjs`` §3 (income statement), §4 (balance sheet) and §10 (tax config
drives NPAT), and ``verify-flows.mjs`` §8 (rate changes flow through), §30 (itemised project
costs), §33 (period comparison, including February and leap years) and §46 (executive
summarisation keeps the totals honest).

The load-bearing assertion in this file is that **Assets = Liabilities + Equity at every tax
rate**. There is no closing entry, so the sheet only balances because two derived rows are
present: the computed tax provision under liabilities, and NPAT under equity. Drop either
and it is out by exactly the tax amount — which is why §10 sweeps 0%, 22% and 40%.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from httpx import AsyncClient

from app.core.money import ZERO
from app.domain.reports.pnl import (
    month_end,
    preceding_window,
    previous_calendar_month,
    shift_months,
)
from app.domain.reports.queries import Period

pytestmark = pytest.mark.phase3

D = Decimal
MAY10 = "2026-05-10"


async def _post(client: AsyncClient, api: str, lines, **kw) -> dict:
    body = {"entry_date": MAY10, "memo": "statement fixture", "lines": lines}
    body.update(kw)
    response = await client.post(f"{api}/journal-entries", json=body)
    assert response.status_code == 201, response.text
    return response.json()


async def _trading_year(client: AsyncClient, api: str) -> None:
    """A small but complete set of books: capital, revenue, cost and an overhead."""
    await _post(
        client, api,
        [
            {"account": "1101", "debit": "500000000"},
            {"account": "3102", "credit": "500000000"},
        ],
        memo="Opening capital",
        source={"kind": "opening", "ref": "FY2026"},
    )
    await _post(
        client, api,
        [
            {"account": "1201", "debit": "1000000000"},
            {"account": "4101", "credit": "1000000000"},
        ],
        memo="Revenue recognised",
        source={"kind": "invoice", "ref": "INV-9100"},
    )
    await _post(
        client, api,
        [
            {"account": "5101", "debit": "700000000"},
            {"account": "2102", "credit": "700000000"},
        ],
        memo="Vendor costs",
        source={"kind": "po", "ref": "PO-9100"},
    )
    await _post(
        client, api,
        [
            {"account": "6101", "debit": "100000000"},
            {"account": "2102", "credit": "100000000"},
        ],
        memo="Office overhead",
        source={"kind": "po", "ref": "BILL-9100"},
    )


# ---------------------------------------------------------------------------
# §3 — Income statement
# ---------------------------------------------------------------------------


async def test_income_statement_walks_down_to_npat(client: AsyncClient, api: str) -> None:
    await _trading_year(client, api)
    body = (await client.get(f"{api}/reports/income-statement", params={"period": "all"})).json()

    assert body["total_revenue"] == "1000000000.00"
    assert body["total_cogs"] == "700000000.00"
    assert body["gross_profit"] == "300000000.00"
    assert body["total_opex"] == "100000000.00"
    assert body["profit_before_tax"] == "200000000.00"

    # 22% of 200,000,000
    assert body["provision"] == "44000000.00"
    assert body["npat"] == "156000000.00"


async def test_margins_are_two_decimals(client: AsyncClient, api: str) -> None:
    """The client asked for ,00 precision specifically."""
    await _trading_year(client, api)
    body = (await client.get(f"{api}/reports/income-statement", params={"period": "all"})).json()

    assert Decimal(str(body["gross_margin"])) == D("30.00")
    assert Decimal(str(body["net_margin"])) == D("15.60")


async def test_corporate_tax_is_derived_and_carries_no_account_code(
    client: AsyncClient, api: str
) -> None:
    await _trading_year(client, api)
    body = (await client.get(f"{api}/reports/income-statement", params={"period": "all"})).json()

    provision = [line for line in body["tax"] if line["derived"]]
    assert len(provision) == 1
    assert provision[0]["code"] == "—", "a derived row has no account behind it"
    assert "22" in provision[0]["label"]


async def test_prepaid_withholding_is_reported_beside_the_tax_charge(
    client: AsyncClient, api: str
) -> None:
    """1401 is tax already withheld from us and creditable against the bill above."""
    await _trading_year(client, api)
    await _post(
        client, api,
        [
            {"account": "1101", "debit": "980000000"},
            {"account": "1401", "debit": "20000000"},
            {"account": "1201", "credit": "1000000000"},
        ],
        memo="Receipt with PPh 23 withheld",
        source={"kind": "payment"},
    )
    body = (await client.get(f"{api}/reports/income-statement", params={"period": "all"})).json()
    assert body["prepaid_withholding"] == "20000000.00"


# ---------------------------------------------------------------------------
# §4 / §10 — Balance sheet holds at every rate
# ---------------------------------------------------------------------------


async def test_balance_sheet_balances(client: AsyncClient, api: str) -> None:
    await _trading_year(client, api)
    body = (await client.get(f"{api}/reports/balance-sheet", params={"period": "all"})).json()

    assert body["balanced"] is True, f"out by {body['difference']}"
    assert body["difference"] == "0.00"


@pytest.mark.parametrize("rate", ["0", "22", "40"])
async def test_the_sheet_balances_at_every_tax_rate(
    client: AsyncClient, api: str, rate: str
) -> None:
    """§10 — the sweep that proves both derived rows are present and consistent."""
    await _trading_year(client, api)
    await client.patch(f"{api}/tax-config/corporate", json={"rate": rate})

    body = (await client.get(f"{api}/reports/balance-sheet", params={"period": "all"})).json()
    assert body["balanced"] is True, f"at {rate}% the sheet is out by {body['difference']}"


async def test_the_two_derived_rows_are_present_and_named(
    client: AsyncClient, api: str
) -> None:
    await _trading_year(client, api)
    body = (await client.get(f"{api}/reports/balance-sheet", params={"period": "all"})).json()

    liabilities = {line["label"] for line in body["liabilities"] if line["derived"]}
    equity = {line["label"] for line in body["equity"] if line["derived"]}

    assert "Provision for Income Tax" in liabilities
    assert "Current Period Earnings (NPAT)" in equity


async def test_turning_corporate_tax_off_makes_npat_equal_pbt(
    client: AsyncClient, api: str
) -> None:
    """§8 — the rate is a live setting, not a posted entry."""
    await _trading_year(client, api)

    await client.patch(f"{api}/tax-config/corporate", json={"active": False})
    body = (await client.get(f"{api}/reports/income-statement", params={"period": "all"})).json()

    assert body["provision"] == "0.00"
    assert body["npat"] == body["profit_before_tax"]

    sheet = (await client.get(f"{api}/reports/balance-sheet", params={"period": "all"})).json()
    assert sheet["balanced"] is True
    assert not [line for line in sheet["liabilities"] if line["label"].startswith("Provision")]


async def test_raising_the_rate_lowers_npat(client: AsyncClient, api: str) -> None:
    await _trading_year(client, api)

    before = (
        await client.get(f"{api}/reports/income-statement", params={"period": "all"})
    ).json()["npat"]

    await client.patch(f"{api}/tax-config/corporate", json={"rate": "40"})
    after = (
        await client.get(f"{api}/reports/income-statement", params={"period": "all"})
    ).json()["npat"]

    assert Decimal(after) < Decimal(before)


async def test_no_tax_is_charged_on_a_loss(client: AsyncClient, api: str) -> None:
    """A negative charge would be a loss carry-forward, which is a decision nobody made."""
    await _post(
        client, api,
        [
            {"account": "1201", "debit": "100000000"},
            {"account": "4101", "credit": "100000000"},
        ],
        memo="Thin revenue",
        source={"kind": "invoice", "ref": "INV-9200"},
    )
    await _post(
        client, api,
        [
            {"account": "5101", "debit": "400000000"},
            {"account": "2102", "credit": "400000000"},
        ],
        memo="Heavy cost",
        source={"kind": "po", "ref": "PO-9200"},
    )

    body = (await client.get(f"{api}/reports/income-statement", params={"period": "all"})).json()
    assert Decimal(body["profit_before_tax"]) < 0
    assert body["provision"] == "0.00"
    assert body["npat"] == body["profit_before_tax"]

    sheet = (await client.get(f"{api}/reports/balance-sheet", params={"period": "all"})).json()
    assert sheet["balanced"] is True


# ---------------------------------------------------------------------------
# §46 — Executive summarisation
# ---------------------------------------------------------------------------


async def test_rolled_up_totals_equal_the_detailed_ones(
    client: AsyncClient, api: str
) -> None:
    await _trading_year(client, api)

    detailed = (
        await client.get(
            f"{api}/reports/income-statement", params={"period": "all", "summarised": "false"}
        )
    ).json()
    summarised = (
        await client.get(
            f"{api}/reports/income-statement", params={"period": "all", "summarised": "true"}
        )
    ).json()

    for key in ("total_revenue", "total_cogs", "total_opex", "npat", "gross_profit"):
        assert detailed[key] == summarised[key], key

    assert len(summarised["revenue"]) <= len(detailed["revenue"])


async def test_every_bucket_stays_drillable(client: AsyncClient, api: str) -> None:
    """A summary you cannot open is a dead end."""
    await _trading_year(client, api)
    body = (
        await client.get(
            f"{api}/reports/income-statement", params={"period": "all", "summarised": "true"}
        )
    ).json()

    for line in body["cogs"]:
        if not line["derived"]:
            assert line["codes"], f"bucket {line['label']} lost its account codes"


async def test_the_derived_tax_row_is_not_filed_under_a_bucket(
    client: AsyncClient, api: str
) -> None:
    """Filing it under a chart group would imply an account that does not exist."""
    await _trading_year(client, api)
    body = (
        await client.get(
            f"{api}/reports/income-statement", params={"period": "all", "summarised": "true"}
        )
    ).json()

    derived = [line for line in body["tax"] if line["derived"]]
    assert derived
    assert derived[0]["codes"] == []


async def test_the_summarised_balance_sheet_still_balances(
    client: AsyncClient, api: str
) -> None:
    await _trading_year(client, api)
    body = (
        await client.get(
            f"{api}/reports/balance-sheet", params={"period": "all", "summarised": "true"}
        )
    ).json()
    assert body["balanced"] is True


# ---------------------------------------------------------------------------
# §30 — Project P&L
# ---------------------------------------------------------------------------



async def test_project_pnl_itemises_its_costs(
    client: AsyncClient, api: str, make_project
) -> None:
    PROJECT_A = await make_project()
    await _post(
        client, api,
        [
            {"account": "1201", "debit": "480000000"},
            {"account": "4101", "credit": "480000000"},
        ],
        project_id=PROJECT_A,
        source={"kind": "invoice", "ref": "INV-A"},
    )
    await _post(
        client, api,
        [
            {"account": "5101", "debit": "200000000"},
            {"account": "2102", "credit": "200000000"},
        ],
        project_id=PROJECT_A,
        source={"kind": "po", "ref": "PO-A"},
    )
    await _post(
        client, api,
        [
            {"account": "5102", "debit": "60000000"},
            {"account": "1101", "credit": "60000000"},
        ],
        project_id=PROJECT_A,
        source={"kind": "payroll", "ref": "INC-A"},
    )

    body = (
        await client.get(
            f"{api}/reports/project-pnl", params={"project_id": PROJECT_A, "period": "all"}
        )
    ).json()

    assert body["revenue"] == "480000000.00"
    assert body["cost"] == "260000000.00"
    assert body["profit"] == "220000000.00"

    itemised = sum(Decimal(line["amount"]) for line in body["costs"])
    assert itemised == Decimal(body["cost"]), "itemised costs must reconcile with the total"
    assert {line["code"] for line in body["costs"]} == {"5101", "5102"}


async def test_a_credit_to_a_cost_account_appears_as_a_negative(
    client: AsyncClient, api: str, make_project
) -> None:
    """A variance or a return genuinely reduces the project's cost; filtering it out would
    overstate the job."""
    PROJECT_A = await make_project()
    await _post(
        client, api,
        [
            {"account": "5101", "debit": "100000000"},
            {"account": "2102", "credit": "100000000"},
        ],
        project_id=PROJECT_A,
        source={"kind": "po", "ref": "PO-VAR"},
    )
    await _post(
        client, api,
        [
            {"account": "2102", "debit": "30000000"},
            {"account": "5101", "credit": "30000000"},
        ],
        memo="Vendor came in under the order",
        project_id=PROJECT_A,
        source={"kind": "po", "ref": "PO-VAR-ADJ"},
    )

    body = (
        await client.get(
            f"{api}/reports/project-pnl", params={"project_id": PROJECT_A, "period": "all"}
        )
    ).json()
    assert body["cost"] == "70000000.00"


async def test_asset_loss_counts_against_the_project(
    client: AsyncClient, api: str, make_project
) -> None:
    """6901 is company-wide opex, but absolutely a cost of the job that broke the kit."""
    PROJECT_A = await make_project()
    await _post(
        client, api,
        [
            {"account": "6901", "debit": "12000000"},
            {"account": "1302", "credit": "12000000"},
        ],
        memo="Kit destroyed on site",
        project_id=PROJECT_A,
        source={"kind": "warehouse", "ref": "IT-04"},
    )
    body = (
        await client.get(
            f"{api}/reports/project-pnl", params={"project_id": PROJECT_A, "period": "all"}
        )
    ).json()
    assert body["cost"] == "12000000.00"
    assert {line["code"] for line in body["costs"]} == {"6901"}


async def test_project_pnl_isolates_projects(
    client: AsyncClient, api: str, make_project
) -> None:
    PROJECT_A = await make_project("Alpha")
    PROJECT_B = await make_project("Beta")
    await _post(
        client, api,
        [{"account": "5101", "debit": "10"}, {"account": "2102", "credit": "10"}],
        project_id=PROJECT_A,
    )
    await _post(
        client, api,
        [{"account": "5101", "debit": "99"}, {"account": "2102", "credit": "99"}],
        project_id=PROJECT_B,
    )

    a = (
        await client.get(
            f"{api}/reports/project-pnl", params={"project_id": PROJECT_A, "period": "all"}
        )
    ).json()
    b = (
        await client.get(
            f"{api}/reports/project-pnl", params={"project_id": PROJECT_B, "period": "all"}
        )
    ).json()

    assert a["cost"] == "10.00"
    assert b["cost"] == "99.00"


# ---------------------------------------------------------------------------
# §33 — Period arithmetic
# ---------------------------------------------------------------------------


def test_previous_calendar_month_crosses_a_year_boundary() -> None:
    window = Period(start=date(2026, 1, 5), end=date(2026, 1, 20))
    prior = previous_calendar_month(window)
    assert prior.start == date(2025, 12, 1)
    assert prior.end == date(2025, 12, 31)


def test_previous_calendar_month_of_march_is_february() -> None:
    window = Period(start=date(2026, 3, 1), end=date(2026, 3, 31))
    prior = previous_calendar_month(window)
    assert prior.start == date(2026, 2, 1)
    assert prior.end == date(2026, 2, 28), "2026 is not a leap year"


def test_february_in_a_leap_year() -> None:
    assert month_end(2028, 2) == date(2028, 2, 29)
    window = Period(start=date(2028, 3, 1), end=date(2028, 3, 31))
    assert previous_calendar_month(window).end == date(2028, 2, 29)


def test_shifting_a_month_end_clamps_to_the_shorter_month() -> None:
    """31 March shifted back one month is 28 February, not an invalid 31 February."""
    window = Period(start=date(2026, 3, 31), end=date(2026, 3, 31))
    assert shift_months(window, -1).start == date(2026, 2, 28)


def test_year_on_year_shift_handles_a_leap_day() -> None:
    window = Period(start=date(2028, 2, 29), end=date(2028, 2, 29))
    shifted = shift_months(window, -12)
    assert shifted.start == date(2027, 2, 28)


def test_preceding_window_is_the_same_length_and_ends_the_day_before() -> None:
    window = Period(start=date(2026, 5, 10), end=date(2026, 5, 19))
    prior = preceding_window(window)
    assert prior.end == date(2026, 5, 9)
    assert (prior.end - prior.start).days == (window.end - window.start).days


# ---------------------------------------------------------------------------
# Comparison
# ---------------------------------------------------------------------------


async def test_cost_deltas_are_inverse_signed(client: AsyncClient, api: str) -> None:
    """Spending less than the baseline is an improvement, so it reports as positive."""
    await _post(
        client, api,
        [{"account": "5101", "debit": "100"}, {"account": "2102", "credit": "100"}],
        entry_date="2026-04-15",
    )
    await _post(
        client, api,
        [{"account": "5101", "debit": "40"}, {"account": "2102", "credit": "40"}],
        entry_date="2026-05-15",
    )

    body = (
        await client.get(
            f"{api}/reports/project-pnl/compare",
            params={
                "against": "mom",
                "period": "custom",
                "start": "2026-05-01",
                "end": "2026-05-31",
            },
        )
    ).json()

    cost = next(d for d in body["deltas"] if d["metric"] == "cost")
    assert cost["now"] == "40.00"
    assert cost["was"] == "100.00"
    assert cost["inverse"] is True
    assert cost["improved"] is True, "spending less is better"


async def test_a_baseline_before_the_ledger_begins_is_flagged(
    client: AsyncClient, api: str
) -> None:
    """Warning beats rendering a row of zeroes that looks like a real result."""
    await _post(
        client, api,
        [{"account": "5101", "debit": "100"}, {"account": "2102", "credit": "100"}],
        entry_date="2026-05-15",
    )

    body = (
        await client.get(
            f"{api}/reports/project-pnl/compare",
            params={
                "against": "yoy",
                "period": "custom",
                "start": "2026-05-01",
                "end": "2026-05-31",
            },
        )
    ).json()
    assert body["before_ledger"] is True


async def test_comparing_against_another_project(
    client: AsyncClient, api: str, make_project
) -> None:
    PROJECT_A = await make_project("Alpha")
    PROJECT_B = await make_project("Beta")
    await _post(
        client, api,
        [{"account": "5101", "debit": "100"}, {"account": "2102", "credit": "100"}],
        project_id=PROJECT_A,
    )
    await _post(
        client, api,
        [{"account": "5101", "debit": "250"}, {"account": "2102", "credit": "250"}],
        project_id=PROJECT_B,
    )

    body = (
        await client.get(
            f"{api}/reports/project-pnl/compare",
            params={
                "against": "project",
                "project_id": PROJECT_A,
                "other_project_id": PROJECT_B,
                "period": "all",
            },
        )
    ).json()

    cost = next(d for d in body["deltas"] if d["metric"] == "cost")
    assert cost["now"] == "100.00"
    assert cost["was"] == "250.00"


async def test_comparing_against_a_project_without_naming_one_is_refused(
    client: AsyncClient, api: str
) -> None:
    response = await client.get(
        f"{api}/reports/project-pnl/compare",
        params={"against": "project", "period": "all"},
    )
    assert response.status_code == 422


async def test_a_percentage_change_from_nothing_is_null_not_zero(
    client: AsyncClient, api: str
) -> None:
    """A change from a zero base has no percentage; rendering 0% would say something false."""
    await _post(
        client, api,
        [{"account": "5101", "debit": "100"}, {"account": "2102", "credit": "100"}],
        entry_date="2026-05-15",
    )
    body = (
        await client.get(
            f"{api}/reports/project-pnl/compare",
            params={
                "against": "mom",
                "period": "custom",
                "start": "2026-05-01",
                "end": "2026-05-31",
            },
        )
    ).json()
    cost = next(d for d in body["deltas"] if d["metric"] == "cost")
    assert cost["was"] == "0.00"
    assert cost["percent"] is None


# ---------------------------------------------------------------------------
# Tax configuration
# ---------------------------------------------------------------------------


async def test_the_four_configured_taxes(client: AsyncClient, api: str) -> None:
    rows = (await client.get(f"{api}/tax-config")).json()
    by_key = {row["key"]: row for row in rows}

    assert set(by_key) == {"pph23", "pph21", "ppn", "corporate"}
    assert by_key["pph23"]["active"] is True
    assert by_key["pph23"]["account_code"] == "2105"
    assert by_key["ppn"]["active"] is False, "PPN is configured but off until PKP is confirmed"
    assert by_key["corporate"]["account_code"] is None, "corporate tax is never posted"


async def test_only_finance_and_the_ceo_may_change_a_rate(client_for, api: str) -> None:
    from app.domain.masters.models import Role

    pm = await client_for(Role.PM)
    response = await pm.patch(f"{api}/tax-config/corporate", json={"rate": "0"})
    assert response.status_code == 403
    assert response.json()["action"] == "edit_tax"


async def test_an_out_of_range_rate_is_refused(client: AsyncClient, api: str) -> None:
    assert (
        await client.patch(f"{api}/tax-config/corporate", json={"rate": "-5"})
    ).status_code == 422
    assert (
        await client.patch(f"{api}/tax-config/corporate", json={"rate": "150"})
    ).status_code == 422


async def test_an_unknown_tax_key_is_a_404(client: AsyncClient, api: str) -> None:
    assert (await client.patch(f"{api}/tax-config/vat", json={"rate": "5"})).status_code == 404


# ---------------------------------------------------------------------------
# Guards
# ---------------------------------------------------------------------------


async def test_an_empty_ledger_reports_zeroes_rather_than_dividing_by_zero(
    client: AsyncClient, api: str
) -> None:
    body = (await client.get(f"{api}/reports/income-statement", params={"period": "all"})).json()
    assert body["total_revenue"] == "0.00"
    assert Decimal(str(body["gross_margin"])) == ZERO
    assert Decimal(str(body["net_margin"])) == ZERO

    sheet = (await client.get(f"{api}/reports/balance-sheet", params={"period": "all"})).json()
    assert sheet["balanced"] is True


async def test_a_narrow_window_says_it_excludes_opening_balances(
    client: AsyncClient, api: str
) -> None:
    """A balance sheet is a position at a moment; a windowed one silently omits history."""
    body = (
        await client.get(
            f"{api}/reports/balance-sheet",
            params={"period": "custom", "start": "2026-05-01", "end": "2026-05-31"},
        )
    ).json()
    assert body["excludes_opening_balances"] is True

    whole = (await client.get(f"{api}/reports/balance-sheet", params={"period": "all"})).json()
    assert whole["excludes_opening_balances"] is False
