"""Depreciation schedules.

**The schedule is a projection, not a set of draft journal entries.**

The client's proposal asks for "automated draft journal generation for upcoming periods
until the end of the asset's useful life". The obvious reading is to write sixty unposted
entries into the journal. Every balance query, both statements, the trial balance and every
invariant test would then have to learn to exclude them — and one missed filter reports
depreciation that has not happened yet. So the projection lives here, in pure functions over
an asset row, and only :func:`app.domain.assets.service.run_period` posts.

Two rules earn their comments below because getting either wrong is a silent wrong number:
the final period absorbs the rounding remainder, and a revised asset is **rebased** rather
than recalculated from acquisition.
"""

from __future__ import annotations

import calendar
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from enum import StrEnum

from app.core.money import ZERO, money

#: A period is a calendar month, written 'YYYY-MM'. It is the grain of the whole feature:
#: charges accrue monthly, the run is keyed on it, and idempotency is enforced on it.
Period = str


class RowState(StrEnum):
    POSTED = "posted"
    DUE = "due"
    FUTURE = "future"


def period_of(on: date) -> Period:
    return f"{on.year:04d}-{on.month:02d}"


def period_end(period: Period) -> date:
    """The last calendar day of a period — the date a monthly charge posts on."""
    year, month = (int(part) for part in period.split("-"))
    return date(year, month, calendar.monthrange(year, month)[1])


def add_months(period: Period, n: int) -> Period:
    year, month = (int(part) for part in period.split("-"))
    total = year * 12 + (month - 1) + n
    return f"{total // 12:04d}-{total % 12 + 1:02d}"


def months_between(start: Period, end: Period) -> int:
    sy, sm = (int(part) for part in start.split("-"))
    ey, em = (int(part) for part in end.split("-"))
    return (ey * 12 + em) - (sy * 12 + sm)


@dataclass(frozen=True, slots=True)
class AssetTerms:
    """Everything the schedule needs, and nothing it does not.

    A plain value object rather than the ORM row, so the arithmetic can be tested without a
    database and reasoned about without a session.
    """

    acquired_on: date
    cost: Decimal
    salvage: Decimal
    useful_life_months: int
    method: str
    posted_through: Period | None = None
    posted_accumulated: Decimal = ZERO
    schedule_from: Period | None = None
    opening_accumulated: Decimal = ZERO
    disposed: bool = False


@dataclass(frozen=True, slots=True)
class ScheduleRow:
    index: int
    period: Period
    ends_on: date
    opening: Decimal
    charge: Decimal
    accumulated: Decimal
    closing: Decimal
    state: RowState


def depreciable_base(terms: AssetTerms) -> Decimal:
    return max(ZERO, money(terms.cost) - money(terms.salvage))


def build_schedule(terms: AssetTerms, *, as_of: date) -> list[ScheduleRow]:
    """One row per month for the whole remaining life.

    The **final period absorbs the rounding remainder**, so accumulated depreciation lands
    exactly on ``cost − salvage`` and never a rupiah past it. Without that an asset ends its
    life a few rupiah short of its own residual value and somebody writes the difference off
    by hand every time — which is the manual work this feature exists to remove.

    A revised asset is **rebased**: ``schedule_from`` moves the projection forward to the
    first unposted period and ``opening_accumulated`` carries the ledger's figure into it, so
    what remains is spread over the life that remains. Recomputing from acquisition instead
    would retroactively restate charges the ledger has already recorded, and the register
    would quietly stop agreeing with account 1303.
    """
    acquired = period_of(terms.acquired_on)
    start = terms.schedule_from or acquired

    elapsed = max(0, months_between(acquired, start))
    life = max(1, terms.useful_life_months - elapsed)

    opened = money(terms.opening_accumulated)
    base = max(ZERO, depreciable_base(terms) - opened)
    cost = money(terms.cost)

    rows: list[ScheduleRow] = []
    accumulated = opened

    for index in range(life):
        period = add_months(start, index)
        opening = cost - accumulated
        remaining = (opened + base) - accumulated

        if terms.method == "declining":
            # Double-declining: twice the straight-line rate on net book value, then
            # straight-lined over what is left once that falls below it — which is what
            # stops the curve approaching salvage forever without reaching it.
            #
            # The annual rate is 2 / (life / 12) charged monthly, i.e. divided by 12 again;
            # written here in its reduced form so the division is exact rather than a
            # 28-digit approximation of two thirds.
            charge = money(opening * 2 / Decimal(life))
            straight = money(remaining / Decimal(life - index))
            charge = max(charge, straight)
        else:
            charge = money(base / Decimal(life))

        # Never below zero, and never past the residual value.
        charge = max(ZERO, min(charge, remaining))
        if index == life - 1:
            charge = remaining

        accumulated += charge
        ends_on = period_end(period)

        if terms.posted_through is not None and period <= terms.posted_through:
            state = RowState.POSTED
        elif ends_on <= as_of:
            state = RowState.DUE
        else:
            state = RowState.FUTURE

        rows.append(
            ScheduleRow(
                index=index,
                period=period,
                ends_on=ends_on,
                opening=opening,
                charge=charge,
                accumulated=accumulated,
                closing=cost - accumulated,
                state=state,
            )
        )

    return rows


def due_periods(terms: AssetTerms, *, as_of: date) -> list[ScheduleRow]:
    """Periods that have fallen due and have not been posted — the backlog.

    A disposed asset owes nothing: it stopped accruing on the disposal entry.
    """
    if terms.disposed:
        return []
    return [row for row in build_schedule(terms, as_of=as_of) if row.state is RowState.DUE]


def net_book_value(terms: AssetTerms) -> Decimal:
    """Cost less what has **actually** been posted to 1303 for this asset.

    Deliberately not derived from the schedule. Deriving it meant a revision silently
    restated history: the projection recomputed every past charge at the new rate and the
    register drifted away from the ledger with nothing posted to explain it.
    """
    return money(terms.cost) - money(terms.posted_accumulated)
