"""The dashboard's month-by-month trend (P5): revenue, cost, profit and cash from the ledger."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

import pytest
from httpx import AsyncClient

from app.domain.reports.trend import delta_pct, month_starts

D = Decimal


async def _post(client: AsyncClient, api: str, on: str, lines: list[dict[str, str]], memo: str):
    r = await client.post(
        f"{api}/journal-entries", json={"entry_date": on, "memo": memo, "lines": lines}
    )
    assert r.status_code == 201, r.text
    return r.json()


async def _books(client: AsyncClient, api: str) -> None:
    """The fixed clock is 26 July 2026, so a six-month window is February to July."""
    cash, rev, cogs, opex = "1101", "4101", "5101", "6101"
    await _post(client, api, "2026-01-15", [
        {"account": cash, "debit": "500000000"}, {"account": "3102", "credit": "500000000"},
    ], "Capital, before the window")  # fmt: skip
    await _post(client, api, "2026-03-10", [
        {"account": "1201", "debit": "1000000000"}, {"account": rev, "credit": "1000000000"},
    ], "March revenue")  # fmt: skip
    await _post(client, api, "2026-03-20", [
        {"account": cogs, "debit": "700000000"}, {"account": "2102", "credit": "700000000"},
    ], "March vendor cost")  # fmt: skip
    await _post(client, api, "2026-03-25", [
        {"account": opex, "debit": "100000000"}, {"account": cash, "credit": "100000000"},
    ], "March overhead paid in cash")  # fmt: skip
    await _post(client, api, "2026-04-05", [
        {"account": cash, "debit": "400000000"}, {"account": "1201", "credit": "400000000"},
    ], "April receipt")  # fmt: skip
    await _post(client, api, "2026-07-02", [
        {"account": "1201", "debit": "200000000"}, {"account": rev, "credit": "200000000"},
    ], "July revenue")  # fmt: skip


async def _trend(client: AsyncClient, api: str, months: int = 6) -> dict[str, Any]:
    r = await client.get(f"{api}/reports/monthly-trend", params={"months": months})
    assert r.status_code == 200, r.text
    return r.json()


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


def test_the_window_ends_this_month_and_crosses_a_year() -> None:
    assert month_starts(date(2026, 7, 26), 3) == [
        date(2026, 5, 1),
        date(2026, 6, 1),
        date(2026, 7, 1),
    ]
    assert month_starts(date(2026, 1, 5), 3) == [
        date(2025, 11, 1),
        date(2025, 12, 1),
        date(2026, 1, 1),
    ]
    assert len(month_starts(date(2026, 7, 26), 24)) == 24


@pytest.mark.parametrize(
    ("current", "previous", "expected"),
    [
        (D("150"), D("100"), 50.0),
        (D("50"), D("100"), -50.0),
        (D("100"), D("100"), 0.0),
        (D("-50"), D("-100"), 50.0),  # a loss that halves is an improvement
        (D("-150"), D("-100"), -50.0),
        (D("10"), D("0"), None),  # nothing to compare with
        (D("10"), None, None),
    ],
)
def test_the_change_from_last_month(current: Decimal, previous: Decimal | None, expected) -> None:
    assert delta_pct(current, previous) == expected


# ---------------------------------------------------------------------------
# The endpoint
# ---------------------------------------------------------------------------


async def test_every_month_is_present_even_with_no_entries(client: AsyncClient, api: str) -> None:
    body = await _trend(client, api)
    assert [m["month"] for m in body["months"]] == [
        "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07",
    ]  # fmt: skip
    assert all(m["revenue"] == "0.00" and m["cost"] == "0.00" for m in body["months"])
    assert body["current"]["month"] == "2026-07" and body["previous"]["month"] == "2026-06"
    assert body["delta"]["revenue"] is None


async def test_revenue_cost_and_profit_per_month(client: AsyncClient, api: str) -> None:
    await _books(client, api)
    months = {m["month"]: m for m in (await _trend(client, api))["months"]}
    assert months["2026-03"]["revenue"] == "1000000000.00"
    assert months["2026-03"]["cost"] == "800000000.00", "COGS and OPEX both count as cost"
    assert months["2026-03"]["profit"] == "200000000.00"
    assert months["2026-07"]["revenue"] == "200000000.00" and months["2026-07"]["cost"] == "0.00"
    assert months["2026-04"]["revenue"] == "0.00", "a receipt is cash, not revenue"
    assert months["2026-05"]["profit"] == "0.00"


async def test_cash_carries_forward_from_before_the_window(client: AsyncClient, api: str) -> None:
    await _books(client, api)
    months = {m["month"]: m for m in (await _trend(client, api))["months"]}
    assert months["2026-02"]["closing_cash"] == "500000000.00", "January's capital is the opening"
    assert months["2026-02"]["cash_in"] == "0.00"
    assert months["2026-03"]["cash_out"] == "100000000.00"
    assert months["2026-03"]["closing_cash"] == "400000000.00"
    assert months["2026-04"]["cash_in"] == "400000000.00"
    assert months["2026-04"]["closing_cash"] == "800000000.00"
    assert months["2026-07"]["closing_cash"] == "800000000.00", "quiet months hold the balance"


async def test_this_month_against_last(client: AsyncClient, api: str) -> None:
    await _books(client, api)
    body = await _trend(client, api)
    assert body["delta"]["revenue"] is None, "June had no revenue, so there is no percentage"
    await _post(client, api, "2026-06-10", [
        {"account": "1201", "debit": "100000000"}, {"account": "4101", "credit": "100000000"},
    ], "June revenue")  # fmt: skip
    body = await _trend(client, api)
    assert body["previous"]["revenue"] == "100000000.00"
    assert body["delta"]["revenue"] == 100.0, "200M against 100M is +100%"


async def test_a_reversed_entry_nets_to_nothing(client: AsyncClient, api: str) -> None:
    entry = await _post(client, api, "2026-05-10", [
        {"account": "1201", "debit": "300000000"}, {"account": "4101", "credit": "300000000"},
    ], "Booked in error")  # fmt: skip
    r = await client.post(
        f"{api}/journal-entries/{entry['id']}/reverse", json={"entry_date": "2026-05-12"}
    )
    assert r.status_code == 200, r.text
    months = {m["month"]: m for m in (await _trend(client, api))["months"]}
    assert months["2026-05"]["revenue"] == "0.00"


async def test_an_entry_dated_after_today_is_not_in_any_month_yet(
    client: AsyncClient, api: str
) -> None:
    await _post(client, api, "2026-07-30", [
        {"account": "1201", "debit": "5000000"}, {"account": "4101", "credit": "5000000"},
    ], "Scheduled for later")  # fmt: skip
    assert (await _trend(client, api))["current"]["revenue"] == "0.00"


async def test_the_number_of_months_is_bounded(client: AsyncClient, api: str) -> None:
    assert len((await _trend(client, api, 2))["months"]) == 2
    assert len((await _trend(client, api, 24))["months"]) == 24
    for bad in (0, 1, 25):
        r = await client.get(f"{api}/reports/monthly-trend", params={"months": bad})
        assert r.status_code == 422
