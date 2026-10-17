"""Phase 7 — fixed assets and depreciation.

Ports ``verify-ledger.mjs`` §7 (the register ties to 1302 and 1303) and ``verify-flows.mjs``
§53–58 (schedules, runs, the backlog, revision and disposal).

The assertions that matter most are the ones about *landing*: an asset must finish its life
exactly on ``cost − salvage``, and a revision must not move a rupiah of what was already
posted. Both are silent when wrong — a schedule that ends a few rupiah short still looks like
a schedule — so they are checked arithmetically rather than by eye.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from httpx import AsyncClient

from app.core.money import ZERO
from app.domain.assets.schedule import (
    AssetTerms,
    RowState,
    add_months,
    build_schedule,
    due_periods,
    months_between,
    period_end,
    period_of,
)
from app.domain.masters.models import Role

pytestmark = pytest.mark.phase7

D = Decimal

LIVES = [1, 2, 3, 7, 12, 36, 37, 60]
METHODS = ["straight-line", "declining"]
FAR_FUTURE = date(2099, 1, 1)


def terms(**kw: object) -> AssetTerms:
    base: dict[str, object] = {
        "acquired_on": date(2026, 1, 15),
        "cost": D("120000000"),
        "salvage": ZERO,
        "useful_life_months": 36,
        "method": "straight-line",
    }
    base.update(kw)
    return AssetTerms(**base)  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# The schedule, as pure arithmetic
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("life", LIVES)
@pytest.mark.parametrize("method", METHODS)
@pytest.mark.parametrize(
    ("cost", "salvage"),
    [
        ("640000000", "0"),
        ("1000000", "333333"),
        ("123456789.99", "0.01"),
        # Deliberately awkward: nothing about 7 ÷ 37 lands on two decimals.
        ("7", "1"),
    ],
)
def test_a_schedule_lands_exactly_on_cost_less_salvage(
    life: int, method: str, cost: str, salvage: str
) -> None:
    """The whole point of the final-period remainder rule.

    Without it an asset ends its life a few rupiah away from its own residual value and
    somebody writes the difference off by hand every month — which is the manual work the
    feature exists to remove.
    """
    rows = build_schedule(
        terms(cost=D(cost), salvage=D(salvage), useful_life_months=life, method=method),
        as_of=FAR_FUTURE,
    )
    assert len(rows) == life
    assert rows[-1].accumulated == D(cost) - D(salvage)
    assert rows[-1].closing == D(salvage)


@pytest.mark.parametrize("life", LIVES)
@pytest.mark.parametrize("method", METHODS)
def test_charges_are_never_negative_and_never_pass_salvage(life: int, method: str) -> None:
    rows = build_schedule(
        terms(cost=D("1000000"), salvage=D("333333"), useful_life_months=life, method=method),
        as_of=FAR_FUTURE,
    )
    assert all(row.charge >= ZERO for row in rows)
    assert all(row.accumulated <= D("1000000") - D("333333") for row in rows)
    assert all(row.closing >= D("333333") for row in rows)


def test_declining_is_front_loaded() -> None:
    """Double-rate means the first charge is heavier than the straight-line equivalent."""
    declining = build_schedule(terms(method="declining"), as_of=FAR_FUTURE)
    straight = build_schedule(terms(method="straight-line"), as_of=FAR_FUTURE)
    assert declining[0].charge > straight[0].charge
    # And both still arrive at the same place.
    assert declining[-1].accumulated == straight[-1].accumulated


def test_declining_is_floored_at_the_straight_line_of_what_remains() -> None:
    """Otherwise the curve approaches salvage forever without ever reaching it.

    Once the floor takes over the charge stops shrinking and goes flat — flat to the cent,
    not to the rupiah, so this compares the spread rather than demanding an exact match.
    """
    rows = build_schedule(terms(method="declining", useful_life_months=12), as_of=FAR_FUTURE)
    charges = [row.charge for row in rows]

    tail = charges[-4:]
    assert max(tail) - min(tail) <= D("0.01"), "the floor should hold the tail flat"

    # And flat is genuinely different from the shrinking curve that precedes it: an
    # unfloored double-declining charge would still be falling by millions here.
    assert charges[0] - charges[1] > D("1000000")


def test_the_final_period_absorbs_the_remainder() -> None:
    """A life that does not divide evenly proves the remainder is not simply dropped."""
    rows = build_schedule(
        terms(cost=D("100"), salvage=ZERO, useful_life_months=3), as_of=FAR_FUTURE
    )
    assert [str(row.charge) for row in rows] == ["33.33", "33.33", "33.34"]


def test_period_end_is_the_last_calendar_day() -> None:
    assert period_end("2026-01") == date(2026, 1, 31)
    assert period_end("2026-02") == date(2026, 2, 28)
    assert period_end("2028-02") == date(2028, 2, 29), "a leap February has 29 days"
    assert period_end("2026-12") == date(2026, 12, 31)


def test_period_arithmetic_crosses_a_year() -> None:
    assert add_months("2026-11", 3) == "2027-02"
    assert add_months("2026-01", -1) == "2025-12"
    assert months_between("2026-01", "2027-01") == 12
    assert period_of(date(2026, 7, 26)) == "2026-07"


def test_a_disposed_asset_owes_nothing() -> None:
    """It stopped accruing on the disposal entry."""
    live = terms(acquired_on=date(2025, 1, 1))
    assert due_periods(live, as_of=date(2026, 7, 26))
    dead = terms(acquired_on=date(2025, 1, 1), disposed=True)
    assert due_periods(dead, as_of=date(2026, 7, 26)) == []


def test_rows_are_marked_posted_due_or_future() -> None:
    rows = build_schedule(
        terms(acquired_on=date(2026, 1, 1), posted_through="2026-03"),
        as_of=date(2026, 7, 26),
    )
    states = {row.period: row.state for row in rows}
    assert states["2026-02"] is RowState.POSTED
    assert states["2026-03"] is RowState.POSTED
    assert states["2026-04"] is RowState.DUE
    assert states["2026-06"] is RowState.DUE
    # July has not ended on 26 July, so its charge is not yet owed.
    assert states["2026-07"] is RowState.FUTURE


# ---------------------------------------------------------------------------
# Revision — prospective, never retrospective
# ---------------------------------------------------------------------------


def test_a_revision_rebases_rather_than_recalculating_from_acquisition() -> None:
    """Recomputing from the start would restate charges the ledger already recorded."""
    revised = terms(
        acquired_on=date(2026, 1, 1),
        useful_life_months=60,
        posted_through="2026-12",
        posted_accumulated=D("24000000"),
        schedule_from="2027-01",
        opening_accumulated=D("24000000"),
    )
    rows = build_schedule(revised, as_of=FAR_FUTURE)

    assert rows[0].period == "2027-01", "the projection starts at the first unposted period"
    assert len(rows) == 48, "twelve of the sixty months are already behind it"
    assert rows[0].opening == D("120000000") - D("24000000")
    assert rows[-1].accumulated == D("120000000"), "and it still finishes on cost less salvage"


# ---------------------------------------------------------------------------
# The register and its runs, over HTTP
# ---------------------------------------------------------------------------


async def _fund(client: AsyncClient, api: str, amount: str = "900000000") -> None:
    posted = await client.post(
        f"{api}/journal-entries",
        json={
            "entry_date": "2025-12-01",
            "memo": "Opening capital",
            "source": {"kind": "opening", "ref": "FY2026"},
            "lines": [
                {"account": "1101", "debit": amount},
                {"account": "3102", "credit": amount},
            ],
        },
    )
    assert posted.status_code == 201, posted.text


async def _capitalise(client: AsyncClient, api: str, **overrides: object) -> dict:
    body: dict[str, object] = {
        "name": "VIP Sofa (gold)",
        "acquired_on": "2026-01-15",
        "cost": "120000000",
        "useful_life_months": 36,
        "salvage": "0",
    }
    body.update(overrides)
    response = await client.post(f"{api}/fixed-assets", json=body)
    assert response.status_code == 201, response.text
    return response.json()


async def _balance(client: AsyncClient, api: str, code: str) -> Decimal:
    body = (
        await client.get(
            f"{api}/reports/general-ledger", params={"codes": [code], "period": "all"}
        )
    ).json()
    return Decimal(body["closing"])


async def test_capitalising_posts_the_acquisition(client: AsyncClient, api: str) -> None:
    await _fund(client, api)
    asset = await _capitalise(client, api)

    assert asset["asset_no"].startswith("FA-")
    assert await _balance(client, api, "1302") == D("120000000")
    assert asset["net_book_value"] == "120000000.00"


async def test_kit_already_carried_in_1302_posts_nothing(client: AsyncClient, api: str) -> None:
    """Seeded warehouse equipment is inside the opening balance already.

    Capitalising it again would double-count 120 million rupiah, which is exactly the bug the
    flag exists to prevent.
    """
    await _fund(client, api)
    before = await _balance(client, api, "1302")

    asset = await _capitalise(client, api, post=False)

    assert await _balance(client, api, "1302") == before
    assert asset["asset_no"].startswith("FA-"), "but it is still on the register"


async def test_a_run_posts_one_entry_with_a_line_per_asset(
    client: AsyncClient, api: str
) -> None:
    """Not one entry per asset — that would bury every other transaction in the journal."""
    await _fund(client, api)
    await _capitalise(client, api, name="VIP Sofa", cost="36000000", useful_life_months=36)
    await _capitalise(client, api, name="LED Wall", cost="72000000", useful_life_months=36)

    run = await client.post(f"{api}/depreciation/run", json={"period": "2026-02"})
    assert run.status_code == 200, run.text
    assert run.json()["posted"] == 1, "one entry"

    entry = (await client.get(f"{api}/journal-entries/{run.json()['entry_ids'][0]}")).json()
    debits = [line for line in entry["lines"] if line["account_code"] == "6103"]
    credits = [line for line in entry["lines"] if line["account_code"] == "1303"]
    assert len(debits) == 2, "one debit line per asset"
    assert len(credits) == 1, "and a single credit for the period total"
    assert entry["series"] == "fa"
    assert entry["entry_date"] == "2026-02-28", "dated the last day of the period"


async def test_running_the_same_period_twice_posts_nothing(
    client: AsyncClient, api: str
) -> None:
    await _fund(client, api)
    await _capitalise(client, api)

    first = await client.post(f"{api}/depreciation/run", json={"period": "2026-02"})
    assert first.json()["posted"] == 1

    second = await client.post(f"{api}/depreciation/run", json={"period": "2026-02"})
    assert second.status_code == 200, second.text
    assert second.json()["posted"] == 0
    assert second.json()["total"] == "0.00"


async def test_the_backlog_clears_oldest_first(client: AsyncClient, api: str) -> None:
    """Order matters: newest-first would advance ``posted_through`` past the older periods."""
    await _fund(client, api)
    await _capitalise(client, api)

    backlog = (await client.get(f"{api}/depreciation/backlog")).json()
    assert backlog["periods"] == sorted(backlog["periods"])
    assert backlog["periods"][0] == "2026-01"

    run = await client.post(f"{api}/depreciation/run", json={})
    assert run.json()["periods"] == sorted(run.json()["periods"])
    assert run.json()["periods"] == backlog["periods"]


async def test_running_the_backlog_twice_posts_nothing_the_second_time(
    client: AsyncClient, api: str
) -> None:
    await _fund(client, api)
    await _capitalise(client, api)

    first = await client.post(f"{api}/depreciation/run", json={})
    assert first.json()["posted"] > 1, "there is a real backlog to clear"
    accumulated = await _balance(client, api, "1303")

    second = await client.post(f"{api}/depreciation/run", json={})
    assert second.json()["posted"] == 0
    assert await _balance(client, api, "1303") == accumulated
    assert (await client.get(f"{api}/depreciation/backlog")).json()["periods"] == []


async def test_depreciation_never_touches_cost(client: AsyncClient, api: str) -> None:
    """Depreciation is not a disposal. 1302 stays where the acquisition left it."""
    await _fund(client, api)
    await _capitalise(client, api)
    cost_before = await _balance(client, api, "1302")

    await client.post(f"{api}/depreciation/run", json={})

    assert await _balance(client, api, "1302") == cost_before
    assert await _balance(client, api, "1303") < ZERO, "1303 is contra and carries a credit"


async def test_the_register_ties_to_1302_and_1303(client: AsyncClient, api: str) -> None:
    """Ledger invariant §7.

    1303 is a contra asset, so its natural-side balance is negative and the addition below is
    correct as written rather than needing a subtraction.
    """
    await _fund(client, api)
    await _capitalise(client, api, name="VIP Sofa", cost="36000000")
    await _capitalise(client, api, name="LED Wall", cost="72000000", useful_life_months=48)
    await client.post(f"{api}/depreciation/run", json={})

    register = (await client.get(f"{api}/fixed-assets/register")).json()

    assert register["reconciled"] is True
    assert Decimal(register["net_book_value"]) == Decimal(register["ledger_net_book_value"])
    assert Decimal(register["cost"]) == Decimal(register["ledger_cost"])
    assert Decimal(register["accumulated"]) == -Decimal(register["ledger_accumulated"])


async def test_the_reconciliation_badge_reads_false_when_they_disagree(
    client: AsyncClient, api: str
) -> None:
    """A badge that can only ever read True is decoration, not a check.

    The drift is forced the way it would really happen: an asset registered as "already
    carried in 1302" when in fact nothing was ever posted there. The screen reports both
    figures and says they disagree, rather than quietly preferring one.
    """
    await _fund(client, api)
    await _capitalise(client, api, post=False)

    register = (await client.get(f"{api}/fixed-assets/register")).json()

    assert Decimal(register["cost"]) == D("120000000"), "the register claims the asset"
    assert Decimal(register["ledger_cost"]) == ZERO, "the ledger has never heard of it"
    assert register["reconciled"] is False


@pytest.mark.slow
async def test_a_full_life_lands_the_ledger_exactly_on_cost_less_salvage(
    client: AsyncClient, api: str
) -> None:
    """Run every period of a short life and check where the books actually end up."""
    await _fund(client, api)
    asset = await _capitalise(
        client,
        api,
        name="Rigging truss",
        acquired_on="2026-01-15",
        cost="10000000",
        salvage="1000000",
        useful_life_months=6,
    )

    schedule = (await client.get(f"{api}/fixed-assets/{asset['id']}/schedule")).json()
    for row in schedule:
        posted = await client.post(f"{api}/depreciation/run", json={"period": row["period"]})
        assert posted.status_code == 200, posted.text

    assert -(await _balance(client, api, "1303")) == D("9000000")
    assert await _balance(client, api, "1302") == D("10000000")

    register = (await client.get(f"{api}/fixed-assets/register")).json()
    assert Decimal(register["net_book_value"]) == D("1000000"), "the salvage value, exactly"
    assert register["reconciled"] is True


# ---------------------------------------------------------------------------
# Revision and disposal, over HTTP
# ---------------------------------------------------------------------------


async def test_revising_a_life_leaves_posted_charges_untouched(
    client: AsyncClient, api: str
) -> None:
    await _fund(client, api)
    asset = await _capitalise(client, api)
    await client.post(f"{api}/depreciation/run", json={})

    posted = Decimal(
        (await client.get(f"{api}/fixed-assets/{asset['id']}")).json()["posted_accumulated"]
    )
    accumulated_in_ledger = await _balance(client, api, "1303")

    revised = await client.patch(
        f"{api}/fixed-assets/{asset['id']}", json={"useful_life_months": 60}
    )
    assert revised.status_code == 200, revised.text

    assert Decimal(revised.json()["posted_accumulated"]) == posted, "not a rupiah restated"
    assert await _balance(client, api, "1303") == accumulated_in_ledger, "and nothing posted"
    assert revised.json()["schedule_from"] is not None, "the projection rebased instead"
    assert Decimal(revised.json()["opening_accumulated"]) == posted


async def test_a_revised_asset_still_finishes_on_salvage(client: AsyncClient, api: str) -> None:
    await _fund(client, api)
    asset = await _capitalise(client, api, salvage="20000000")
    await client.post(f"{api}/depreciation/run", json={})
    await client.patch(f"{api}/fixed-assets/{asset['id']}", json={"useful_life_months": 60})

    schedule = (await client.get(f"{api}/fixed-assets/{asset['id']}/schedule")).json()
    assert Decimal(schedule[-1].get("closing")) == D("20000000")
    assert Decimal(schedule[-1]["accumulated"]) == D("120000000") - D("20000000")


async def test_the_service_refuses_sealed_columns_directly(db, user) -> None:
    """Tested at the service, because over HTTP the guard is unreachable.

    ``AssetRevise`` has no ``cost`` field, so Pydantic drops it before the service is called —
    which means the HTTP test below passes whether or not the guard exists. Every other
    caller reaches it though: the seeder, a data fix, a future admin endpoint. So it is
    exercised where it actually lives.
    """
    from app.core.errors import Invalid
    from app.domain.assets import service as assets

    asset = await assets.capitalise(
        db,
        name="LED Wall",
        acquired_on=date(2026, 1, 15),
        cost=D("120000000"),
        useful_life_months=36,
        user=user,
        post=False,
    )

    for column in ("cost", "posted_accumulated", "posted_through", "asset_no", "status"):
        with pytest.raises(Invalid) as refused:
            await assets.revise(db, asset.id, {column: "anything"})
        assert column in str(refused.value)

    assert asset.cost == D("120000000"), "and nothing was applied on the way out"


async def test_the_ledgers_own_figures_cannot_be_patched(client: AsyncClient, api: str) -> None:
    """Cost is evidenced by the acquisition entry; the posted figures are the ledger's record.

    Refused **by name, with a reason** — not silently dropped. A 200 that quietly ignored the
    field would leave the caller believing the cost had changed.
    """
    await _fund(client, api)
    asset = await _capitalise(client, api)

    refused = await client.patch(
        f"{api}/fixed-assets/{asset['id']}",
        json={"cost": "1", "posted_accumulated": "999", "name": "Renamed"},
    )

    assert refused.status_code == 422
    assert "cost" in refused.text
    assert "posted_accumulated" in refused.text

    unchanged = (await client.get(f"{api}/fixed-assets/{asset['id']}")).json()
    assert unchanged["cost"] == "120000000.00"
    assert unchanged["name"] != "Renamed", "the whole patch is refused, not the sealed half"


async def test_a_rename_on_its_own_is_still_allowed(client: AsyncClient, api: str) -> None:
    """The seal is on the ledger's figures, not on the asset's description."""
    await _fund(client, api)
    asset = await _capitalise(client, api)

    renamed = await client.patch(
        f"{api}/fixed-assets/{asset['id']}", json={"name": "VIP Sofa (silver)"}
    )

    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["name"] == "VIP Sofa (silver)"


async def test_disposal_removes_cost_and_returns_accumulated(
    client: AsyncClient, api: str
) -> None:
    await _fund(client, api)
    asset = await _capitalise(client, api)
    await client.post(f"{api}/depreciation/run", json={})

    accumulated = -(await _balance(client, api, "1303"))
    nbv = D("120000000") - accumulated

    disposed = await client.post(
        f"{api}/fixed-assets/{asset['id']}/dispose", json={"proceeds": "0"}
    )
    assert disposed.status_code == 200, disposed.text

    assert await _balance(client, api, "1302") == ZERO, "cost removed"
    assert await _balance(client, api, "1303") == ZERO, "and its accumulated with it"
    assert await _balance(client, api, "6901") == nbv, "the book value is the loss"
    assert disposed.json()["status"] == "disposed"


async def test_a_disposal_above_book_value_is_a_gain(client: AsyncClient, api: str) -> None:
    """Gains and losses share 6901, signed. A separate gain account adds a statement line
    for no extra clarity."""
    await _fund(client, api)
    asset = await _capitalise(client, api)
    await client.post(f"{api}/depreciation/run", json={})

    accumulated = -(await _balance(client, api, "1303"))
    nbv = D("120000000") - accumulated

    await client.post(
        f"{api}/fixed-assets/{asset['id']}/dispose", json={"proceeds": str(nbv + D("5000000"))}
    )

    assert await _balance(client, api, "6901") == D("-5000000"), "a credit balance: a gain"


async def test_disposing_twice_is_refused(client: AsyncClient, api: str) -> None:
    await _fund(client, api)
    asset = await _capitalise(client, api)
    await client.post(f"{api}/fixed-assets/{asset['id']}/dispose", json={})

    again = await client.post(f"{api}/fixed-assets/{asset['id']}/dispose", json={})
    assert again.status_code == 409
    assert "already been disposed" in again.text


async def test_a_disposed_asset_stops_accruing(client: AsyncClient, api: str) -> None:
    await _fund(client, api)
    asset = await _capitalise(client, api)
    await client.post(f"{api}/fixed-assets/{asset['id']}/dispose", json={})

    assert (await client.get(f"{api}/depreciation/backlog")).json()["periods"] == []
    run = await client.post(f"{api}/depreciation/run", json={})
    assert run.json()["posted"] == 0


async def test_a_disposed_asset_cannot_be_revised(client: AsyncClient, api: str) -> None:
    await _fund(client, api)
    asset = await _capitalise(client, api)
    await client.post(f"{api}/fixed-assets/{asset['id']}/dispose", json={})

    revised = await client.patch(
        f"{api}/fixed-assets/{asset['id']}", json={"useful_life_months": 60}
    )
    assert revised.status_code == 409


async def test_sales_cannot_run_depreciation(client_for, api: str) -> None:
    """``manage_assets`` belongs to Finance and the CEO. The denial names who may."""
    sales = await client_for(Role.SALES)
    refused = await sales.post(f"{api}/depreciation/run", json={})
    assert refused.status_code == 403
    assert "finance" in refused.text.lower()
