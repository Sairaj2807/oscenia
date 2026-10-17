"""Project P&L, and the four comparison modes.

Every comparison computes **both sides through the identical code path**. That is not a
tidiness preference: a comparison whose halves are calculated differently is not a
comparison, and the prototype's own notes record getting this wrong once.

One sign convention worth stating, because it looks like a bug otherwise: a cost delta is
**inverse-signed**. Spending less than the comparison period is an improvement, so a fall
in cost reports as a positive change.
"""

from __future__ import annotations

import calendar
import uuid
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Invalid
from app.core.money import ZERO, is_material, money
from app.domain.accounts.models import Account, AccountType
from app.domain.ledger.models import JournalEntry, JournalLine
from app.domain.reports.periods import month_end
from app.domain.reports.queries import Period, account_totals, project_cost_codes


@dataclass(slots=True)
class CostLine:
    code: str
    label: str
    amount: Decimal


@dataclass(slots=True)
class Slice:
    """Revenue and cost for an arbitrary window of the ledger."""

    revenue: Decimal
    cost: Decimal
    label: str = ""
    start: date | None = None
    end: date | None = None
    costs: list[CostLine] = field(default_factory=list)

    @property
    def profit(self) -> Decimal:
        return self.revenue - self.cost

    @property
    def margin(self) -> Decimal:
        """Two decimals — a specific client requirement, not a default."""
        if self.revenue == ZERO:
            return ZERO
        return (self.profit / self.revenue * Decimal(100)).quantize(Decimal("0.01"))


@dataclass(slots=True)
class Delta:
    metric: str
    now: Decimal
    was: Decimal

    #: True for cost, where a decrease is an improvement.
    inverse: bool = False

    @property
    def change(self) -> Decimal:
        return self.now - self.was

    @property
    def improved(self) -> bool | None:
        if self.change == ZERO:
            return None
        return self.change < ZERO if self.inverse else self.change > ZERO

    @property
    def percent(self) -> Decimal | None:
        """None rather than zero when there is no base — a change from nothing has no
        percentage, and rendering 0% would say something false."""
        if self.was == ZERO:
            return None
        return (self.change / abs(self.was) * Decimal(100)).quantize(Decimal("0.01"))


@dataclass(slots=True)
class Comparison:
    current: Slice
    baseline: Slice
    deltas: list[Delta]

    #: True when the baseline window ends before the ledger begins. The prototype warns
    #: rather than rendering a row of zeroes that looks like real data.
    before_ledger: bool = False


async def slice_totals(
    session: AsyncSession,
    *,
    period: Period | None = None,
    project_id: uuid.UUID | None = None,
    label: str = "",
) -> Slice:
    """Revenue and project cost for a period, a project, or both.

    Factored out deliberately: every comparison mode calls this, so both halves of any
    comparison are computed the same way by construction.
    """
    totals = await account_totals(session, period=period, project_id=project_id)
    accounts = {
        a.code: a for a in (await session.execute(select(Account))).scalars().all()
    }
    cost_codes = set(await project_cost_codes(session))

    revenue = ZERO
    cost = ZERO
    cost_lines: list[CostLine] = []

    for code, (debit, credit) in totals.items():
        account = accounts.get(code)
        if account is None:
            continue

        if account.type is AccountType.REVENUE:
            revenue += credit - debit
        elif code in cost_codes:
            # Credits appear as negatives rather than being filtered out — a credit to a
            # cost account is a genuine reduction (a variance, a return), and dropping it
            # would overstate the project's cost.
            amount = debit - credit
            cost += amount
            if is_material(amount):
                cost_lines.append(CostLine(code=code, label=account.name, amount=amount))

    return Slice(
        revenue=money(revenue),
        cost=money(cost),
        label=label,
        start=period.start if period else None,
        end=period.end if period else None,
        costs=sorted(cost_lines, key=lambda line: line.code),
    )


# ---------------------------------------------------------------------------
# Comparison windows
# ---------------------------------------------------------------------------


def shift_months(window: Period, months: int) -> Period:
    """Move a window by whole calendar months, clamping to each month's real length.

    31 January shifted back one month is 31 December, but 31 March back one is 28 or 29
    February. Getting this wrong is how a comparison silently loses or gains days — the
    prototype's §33 tests February and leap years for exactly this reason.
    """
    if window.start is None or window.end is None:
        raise Invalid("A shifted comparison needs a bounded period.")

    def _shift(d: date) -> date:
        total = d.year * 12 + (d.month - 1) + months
        year, month = divmod(total, 12)
        month += 1
        return date(year, month, min(d.day, calendar.monthrange(year, month)[1]))

    return Period(start=_shift(window.start), end=_shift(window.end))


def previous_calendar_month(window: Period) -> Period:
    """The whole previous calendar month, regardless of the current window's shape."""
    if window.start is None:
        raise Invalid("A month-on-month comparison needs a start date.")
    first = window.start.replace(day=1)
    prior = first.replace(day=1)
    year, month = (prior.year - 1, 12) if prior.month == 1 else (prior.year, prior.month - 1)
    return Period(start=date(year, month, 1), end=month_end(year, month))


def preceding_window(window: Period) -> Period:
    """An equally-long window ending the day before this one starts."""
    from datetime import timedelta

    if window.start is None or window.end is None:
        raise Invalid("A previous-period comparison needs a bounded period.")
    length = (window.end - window.start).days
    end = window.start - timedelta(days=1)
    return Period(start=end - timedelta(days=length), end=end)


# ---------------------------------------------------------------------------
# Comparison
# ---------------------------------------------------------------------------


def _deltas(current: Slice, baseline: Slice) -> list[Delta]:
    return [
        Delta("revenue", current.revenue, baseline.revenue),
        # Cost is inverse-signed: spending less is better.
        Delta("cost", current.cost, baseline.cost, inverse=True),
        Delta("profit", current.profit, baseline.profit),
        Delta("margin", current.margin, baseline.margin),
    ]


async def compare(
    session: AsyncSession,
    *,
    current_period: Period | None,
    current_project: uuid.UUID | None,
    baseline_period: Period | None,
    baseline_project: uuid.UUID | None,
    current_label: str = "Current",
    baseline_label: str = "Comparison",
    earliest: date | None = None,
) -> Comparison:
    current = await slice_totals(
        session, period=current_period, project_id=current_project, label=current_label
    )
    baseline = await slice_totals(
        session, period=baseline_period, project_id=baseline_project, label=baseline_label
    )

    before_ledger = bool(
        earliest
        and baseline_period
        and baseline_period.end is not None
        and baseline_period.end < earliest
    )

    return Comparison(
        current=current,
        baseline=baseline,
        deltas=_deltas(current, baseline),
        before_ledger=before_ledger,
    )


__all__ = [
    "Comparison",
    "CostLine",
    "Delta",
    "Slice",
    "compare",
    "month_end",  # re-exported from .periods so callers have one obvious import
    "preceding_window",
    "previous_calendar_month",
    "shift_months",
    "slice_totals",
]


async def cost_lines(session: AsyncSession, project_id: uuid.UUID) -> list[dict]:
    """Every line posted to a project cost account for this project, newest first.

    Credits are kept as negatives rather than filtered out, so a reversed cost nets to zero here
    and the itemised list still adds up to the project's cost. Dropping credits would make it
    add up to more than the project actually spent.
    """
    codes = await project_cost_codes(session)
    stmt = (
        select(JournalEntry, JournalLine)
        .join(JournalLine, JournalLine.entry_id == JournalEntry.id)
        .where(JournalEntry.project_id == project_id, JournalLine.account_code.in_(codes))
        .order_by(JournalEntry.entry_date.desc(), JournalEntry.entry_no.desc(), JournalLine.line_no)
    )
    out: list[dict] = []
    for entry, line in (await session.execute(stmt)).all():
        amount = money(line.debit) - money(line.credit)
        if amount == ZERO:
            continue
        out.append(
            {
                "entry_id": entry.id,
                "entry_no": entry.entry_no,
                "voucher_no": entry.voucher_no,
                "entry_date": entry.entry_date,
                "memo": entry.memo,
                "source_kind": entry.source_kind.value,
                "source_ref": entry.source_ref,
                "account_code": line.account_code,
                "note": line.note,
                "amount": amount,
                "is_reversal": entry.reversal_of_id is not None,
                "is_reversed": entry.reversed_by_id is not None,
            }
        )
    return out
