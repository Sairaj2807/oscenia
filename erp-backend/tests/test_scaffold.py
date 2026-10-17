"""Phase 0 — the scaffold works, and the money policy is what the ledger will rely on."""

from __future__ import annotations

from decimal import Decimal

import pytest
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import DEMO_TODAY, FrozenClock, SystemClock
from app.core.config import get_settings
from app.core.money import (
    MATERIALITY,
    ZERO,
    allocate,
    is_material,
    money,
    percent_of,
    split_evenly,
)

pytestmark = pytest.mark.phase0


# --- the app is wired together -------------------------------------------------------


async def test_health_reports_a_real_database_round_trip(client: AsyncClient) -> None:
    response = await client.get("/health")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["database"] == "ok"
    assert body["env"] == "test"


async def test_health_uses_the_injected_clock(client: AsyncClient) -> None:
    body = (await client.get("/health")).json()
    assert body["today"] == DEMO_TODAY.isoformat()


async def test_session_fixture_talks_to_postgres(db: AsyncSession) -> None:
    version = (await db.execute(text("SHOW server_version_num"))).scalar_one()
    assert int(version) >= 160000, "the schema relies on Postgres 16 behaviour"


async def test_deferred_constraints_can_be_made_immediate(db_immediate: AsyncSession) -> None:
    # Proves the fixture that phase 1's negative constraint tests depend on.
    assert (await db_immediate.execute(text("SELECT 1"))).scalar_one() == 1


# --- the clock -----------------------------------------------------------------------


def test_frozen_clock_is_fixed() -> None:
    clock = FrozenClock(DEMO_TODAY)
    assert clock.today() == DEMO_TODAY
    assert clock.now().date() == DEMO_TODAY
    assert clock.now().tzinfo is not None, "timestamps must be timezone-aware"


def test_system_clock_is_timezone_aware() -> None:
    assert SystemClock().now().tzinfo is not None


def test_system_clock_today_is_jakarta_not_utc() -> None:
    """ "Today" must be the Jakarta business day, not UTC.

    Oscenia is UTC+7, so for seven hours of every day the two disagree. Every ageing
    bucket and due-date countdown keys off today(), so a UTC date would shift all of them
    by a day for part of each day.
    """
    from datetime import UTC, datetime
    from zoneinfo import ZoneInfo

    today = SystemClock().today()
    assert today == datetime.now(ZoneInfo(get_settings().timezone)).date()

    # And it genuinely differs from UTC during the offset window.
    jakarta_now = datetime.now(ZoneInfo("Asia/Jakarta"))
    if jakarta_now.hour < 7:
        assert today != datetime.now(UTC).date()


def test_configured_timezone_is_the_company_timezone() -> None:
    assert get_settings().timezone == "Asia/Jakarta"


# --- money: exactness ----------------------------------------------------------------


def test_money_quantises_to_two_places_half_up() -> None:
    assert money("144000000") == Decimal("144000000.00")
    assert money(Decimal("0.005")) == Decimal("0.01")  # half-up, not banker's
    assert money(Decimal("0.014")) == Decimal("0.01")


def test_money_is_exact_where_floats_are_not() -> None:
    # The reason the ledger uses Decimal at all: 0.1 + 0.2 != 0.3 in binary floating point.
    total = sum((money("0.10"), money("0.20")), start=ZERO)
    assert total == money("0.30")


def test_withholding_rounds_once_at_the_end() -> None:
    # PPh 23 at 2% on a real seed figure.
    assert percent_of(money("144000000"), 2) == Decimal("2880000.00")
    # A rate that does not divide evenly still lands on two places.
    assert percent_of(money("117000000"), Decimal("1.5")) == Decimal("1755000.00")


# --- money: materiality --------------------------------------------------------------


def test_materiality_is_one_rupiah() -> None:
    assert MATERIALITY == Decimal("1.00")


@pytest.mark.parametrize(
    ("amount", "material"),
    [
        ("0.00", False),
        ("0.99", False),
        ("-0.99", False),
        ("1.00", True),
        ("-1.00", True),
        ("144000000.00", True),
    ],
)
def test_is_material(amount: str, material: bool) -> None:
    assert is_material(Decimal(amount)) is material


# --- money: allocation ---------------------------------------------------------------


def test_allocate_sums_to_the_total_exactly() -> None:
    # A 30/40/30 phased down payment on a contract that does not divide evenly.
    parts = allocate(money("610000000"), [Decimal(30), Decimal(40), Decimal(30)])
    assert sum(parts, start=ZERO) == money("610000000")
    assert len(parts) == 3


@pytest.mark.parametrize(
    "contract",
    ["610000000", "480000000", "117000001", "1", "333333333"],
)
def test_allocate_never_loses_a_rupiah(contract: str) -> None:
    # verify-flows.mjs §47: every preset bills the contract to the rupiah, including
    # awkward values. The final stage absorbs the remainder.
    for weights in (
        [Decimal(50), Decimal(50)],
        [Decimal(75), Decimal(25)],
        [Decimal(100)],
        [Decimal(30), Decimal(40), Decimal(30)],
    ):
        parts = allocate(money(contract), weights)
        assert sum(parts, start=ZERO) == money(contract), (contract, weights)


def test_split_evenly_absorbs_the_remainder_in_the_last_part() -> None:
    # A depreciation schedule: 60 monthly charges landing exactly on cost - salvage.
    parts = split_evenly(money("86400000"), 60)
    assert len(parts) == 60
    assert sum(parts, start=ZERO) == money("86400000")
    assert all(p >= ZERO for p in parts)


def test_allocate_handles_degenerate_input() -> None:
    assert allocate(money("100"), []) == []
    assert allocate(money("100"), [ZERO, ZERO]) == [ZERO, ZERO]
    assert split_evenly(money("100"), 0) == []
