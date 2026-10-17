"""Month-by-month revenue, cost, profit and cash, straight from the ledger.

What the dashboard's revenue chart and its "vs last month" arrows read. Nothing is stored: each
month is summed from the journal, so a reversal, a back-dated entry or a closed period shows up
exactly as it does on the statements.

* **Revenue** is what REVENUE accounts earned in the month (credits less debits).
* **Cost** is COGS plus OPEX (debits less credits). Corporate tax is not a cost of the month: it
  is a provision worked out on the whole profit (see ``statements.income_statement``), so it is
  left out rather than guessed per month. Profit here is therefore *before tax*.
* **Cash in / out** are the debits and credits to cash and bank accounts; **closing cash** is the
  balance of those accounts at the end of the month, so it carries forward from before the window.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from sqlalchemy import extract, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.money import ZERO, money
from app.domain.accounts.models import Account, AccountType
from app.domain.ledger.models import JournalEntry, JournalLine


@dataclass(slots=True)
class TrendMonth:
    month: str  # "2026-07"
    revenue: Decimal = ZERO
    cost: Decimal = ZERO
    cash_in: Decimal = ZERO
    cash_out: Decimal = ZERO
    closing_cash: Decimal = ZERO

    @property
    def profit(self) -> Decimal:
        return self.revenue - self.cost


def month_starts(today: date, months: int) -> list[date]:
    """The first day of each of the last ``months`` months, oldest first, ending with this month."""
    index = today.year * 12 + (today.month - 1)
    return [date((i // 12), (i % 12) + 1, 1) for i in range(index - months + 1, index + 1)]


def delta_pct(current: Decimal, previous: Decimal | None) -> float | None:
    """Percentage change from ``previous``; ``None`` when there is nothing to compare with.

    Measured against the size of the previous figure, so a loss that shrinks reads as improving.
    """
    if previous is None or previous == 0:
        return None
    return round(float((current - previous) / abs(previous)) * 100, 1)


async def monthly_trend(session: AsyncSession, *, today: date, months: int) -> list[TrendMonth]:
    """One row per month for the last ``months`` months, oldest first, empty months included."""
    starts = month_starts(today, months)
    first = starts[0]
    rows = {s.strftime("%Y-%m"): TrendMonth(month=s.strftime("%Y-%m")) for s in starts}

    year = extract("year", JournalEntry.entry_date)
    month = extract("month", JournalEntry.entry_date)
    grouped = await session.execute(
        select(
            year,
            month,
            Account.type,
            Account.is_cash,
            func.coalesce(func.sum(JournalLine.debit), 0),
            func.coalesce(func.sum(JournalLine.credit), 0),
        )
        .join(JournalEntry, JournalLine.entry_id == JournalEntry.id)
        .join(Account, JournalLine.account_code == Account.code)
        .where(JournalEntry.entry_date >= first, JournalEntry.entry_date <= today)
        .group_by(year, month, Account.type, Account.is_cash)
    )
    for y, m, kind, is_cash, debit, credit in grouped.all():
        row = rows.get(f"{int(y):04d}-{int(m):02d}")
        if row is None:
            continue
        debit, credit = money(debit), money(credit)
        if kind is AccountType.REVENUE:
            row.revenue += credit - debit
        elif kind in (AccountType.COGS, AccountType.OPEX):
            row.cost += debit - credit
        if is_cash:
            row.cash_in += debit
            row.cash_out += credit

    # Cash carries forward: the balance before the window, then each month's movement.
    opening = await session.execute(
        select(
            func.coalesce(func.sum(JournalLine.debit), 0)
            - func.coalesce(func.sum(JournalLine.credit), 0)
        )
        .join(JournalEntry, JournalLine.entry_id == JournalEntry.id)
        .join(Account, JournalLine.account_code == Account.code)
        .where(Account.is_cash.is_(True), JournalEntry.entry_date < first)
    )
    balance = money(opening.scalar_one())
    out = []
    for s in starts:
        row = rows[s.strftime("%Y-%m")]
        balance += row.cash_in - row.cash_out
        row.closing_cash = money(balance)
        row.revenue, row.cost = money(row.revenue), money(row.cost)
        row.cash_in, row.cash_out = money(row.cash_in), money(row.cash_out)
        out.append(row)
    return out

