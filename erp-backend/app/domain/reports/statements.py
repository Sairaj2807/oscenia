"""Income statement, balance sheet, and the executive roll-up.

SQL translations of ``incomeStatementFrom`` and ``balanceSheetFrom`` in the prototype's
``lib/ledger.js``. Nothing here is stored.

**The two derived rows are the whole risk in this module.** There is no closing entry — the
prototype has none, and income accounts keep their balances — so:

* equity picks up the period's profit as a derived *Current Period Earnings (NPAT)* row
* corporate tax is *computed*, not posted, so it must be added back as a derived
  *Provision for Income Tax* liability

The identity then holds::

    A = L + E_open + PBT  ==  (L + tax) + (E_open + PBT - tax)

Omit either row and the sheet is out by exactly the tax amount. Both are marked
``derived=True`` and carry no account code, because filing them under a chart bucket would
imply an account that does not exist.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.money import ZERO, is_material, money
from app.domain.accounts.models import TYPE_META, Account, AccountType, Side, normal_side
from app.domain.masters.models import TaxConfig
from app.domain.reports.queries import Period, account_totals

CORPORATE = "corporate"


@dataclass(slots=True)
class Line:
    code: str
    label: str
    amount: Decimal
    derived: bool = False

    #: For a rolled-up bucket: the account codes it was built from, so the executive
    #: summary stays drillable rather than becoming a dead end.
    codes: list[str] = field(default_factory=list)


@dataclass(slots=True)
class TaxRate:
    rate: Decimal
    amount: Decimal


@dataclass(slots=True)
class IncomeStatement:
    revenue: list[Line]
    cogs: list[Line]
    opex: list[Line]
    tax: list[Line]
    total_revenue: Decimal
    total_cogs: Decimal
    total_opex: Decimal
    total_tax: Decimal
    posted_tax: Decimal
    provision: Decimal
    tax_rate: Decimal
    gross_profit: Decimal
    profit_before_tax: Decimal
    npat: Decimal
    gross_margin: Decimal
    net_margin: Decimal

    #: Balance of 1401 — PPh 23 already withheld from us and creditable against the bill
    #: below. Shown beside Tax Expense so finance can see what is still to settle.
    prepaid_withholding: Decimal


@dataclass(slots=True)
class BalanceSheet:
    assets: list[Line]
    liabilities: list[Line]
    equity: list[Line]
    total_assets: Decimal
    total_liabilities: Decimal
    total_equity: Decimal

    @property
    def difference(self) -> Decimal:
        return self.total_assets - (self.total_liabilities + self.total_equity)

    @property
    def balanced(self) -> bool:
        """Exact. NUMERIC is exact arithmetic; there is no tolerance."""
        return self.difference == ZERO


# ---------------------------------------------------------------------------
# Tax
# ---------------------------------------------------------------------------


async def tax_config(session: AsyncSession) -> dict[str, TaxConfig]:
    rows = (await session.execute(select(TaxConfig))).scalars().all()
    return {t.key: t for t in rows}


def corporate_tax(profit_before_tax: Decimal, config: dict[str, TaxConfig]) -> TaxRate:
    """Computed, never posted.

    Zero on a loss: there is no negative tax charge here. Carrying a loss forward against
    future profit is a real feature and a real decision, not something to imply by
    accident — see docs 07 Q2.
    """
    entry = config.get(CORPORATE)
    if entry is None or not entry.active or profit_before_tax <= ZERO:
        return TaxRate(rate=entry.rate if entry else ZERO, amount=ZERO)
    return TaxRate(rate=entry.rate, amount=money(profit_before_tax * entry.rate / Decimal(100)))


def withholding(gross: Decimal, config: dict[str, TaxConfig], key: str = "pph23") -> TaxRate:
    entry = config.get(key)
    if entry is None or not entry.active:
        return TaxRate(rate=ZERO, amount=ZERO)
    return TaxRate(rate=entry.rate, amount=money(gross * entry.rate / Decimal(100)))


# ---------------------------------------------------------------------------
# Statements
# ---------------------------------------------------------------------------


async def _lines_for(
    session: AsyncSession,
    account_type: AccountType,
    totals: dict[str, tuple[Decimal, Decimal]],
    accounts: list[Account],
) -> list[Line]:
    """One line per account of a type, signed to its natural side.

    Rows below materiality are dropped — a statement listing a rupiah of rounding dust is
    noise, and the prototype filters the same way.
    """
    out: list[Line] = []
    for account in accounts:
        if account.type is not account_type:
            continue
        debit, credit = totals.get(account.code, (ZERO, ZERO))
        amount = (
            debit - credit if normal_side(account.type) is Side.DEBIT else credit - debit
        )
        if is_material(amount):
            out.append(Line(code=account.code, label=account.name, amount=amount))
    return sorted(out, key=lambda line: line.code)


def _sum(lines: list[Line]) -> Decimal:
    return money(sum((line.amount for line in lines), start=ZERO))


async def income_statement(
    session: AsyncSession,
    *,
    period: Period | None = None,
    project_id: uuid.UUID | None = None,
) -> IncomeStatement:
    """Revenue through to NPAT.

    Ends at **NPAT**, not a pre-tax figure — the client's roadmap was explicit that the old
    version stopped early and labelled a pre-tax number "Net Profit".
    """
    totals = await account_totals(session, period=period, project_id=project_id)
    accounts = list((await session.execute(select(Account))).scalars().all())
    config = await tax_config(session)

    revenue = await _lines_for(session, AccountType.REVENUE, totals, accounts)
    cogs = await _lines_for(session, AccountType.COGS, totals, accounts)
    opex = await _lines_for(session, AccountType.OPEX, totals, accounts)
    posted_tax_lines = await _lines_for(session, AccountType.TAX, totals, accounts)

    total_revenue = _sum(revenue)
    total_cogs = _sum(cogs)
    total_opex = _sum(opex)
    posted_tax = _sum(posted_tax_lines)

    gross_profit = total_revenue - total_cogs
    profit_before_tax = gross_profit - total_opex

    provision = corporate_tax(profit_before_tax, config)
    total_tax = posted_tax + provision.amount
    npat = profit_before_tax - total_tax

    tax_lines = list(posted_tax_lines)
    if provision.amount != ZERO:
        # Derived: no account code, because none exists. Any manually posted tax lines sit
        # above it and are added on top rather than replaced.
        tax_lines.append(
            Line(
                code="—",
                label=f"Corporate Income Tax ({_pct(provision.rate)}%)",
                amount=provision.amount,
                derived=True,
            )
        )

    prepaid_debit, prepaid_credit = totals.get("1401", (ZERO, ZERO))

    return IncomeStatement(
        revenue=revenue,
        cogs=cogs,
        opex=opex,
        tax=tax_lines,
        total_revenue=total_revenue,
        total_cogs=total_cogs,
        total_opex=total_opex,
        total_tax=total_tax,
        posted_tax=posted_tax,
        provision=provision.amount,
        tax_rate=provision.rate,
        gross_profit=gross_profit,
        profit_before_tax=profit_before_tax,
        npat=npat,
        gross_margin=_margin(gross_profit, total_revenue),
        net_margin=_margin(npat, total_revenue),
        prepaid_withholding=prepaid_debit - prepaid_credit,
    )


async def balance_sheet(
    session: AsyncSession,
    *,
    period: Period | None = None,
) -> BalanceSheet:
    """Assets against liabilities and equity, including the two derived rows.

    Note the absence of a ``project_id`` filter. A balance sheet for one project is not a
    meaningful document — cash, receivables and equity are company-wide — so it is not
    offered rather than offered and quietly wrong.
    """
    totals = await account_totals(session, period=period)
    accounts = list((await session.execute(select(Account))).scalars().all())

    assets = await _lines_for(session, AccountType.ASSET, totals, accounts)
    posted_liabilities = await _lines_for(session, AccountType.LIABILITY, totals, accounts)
    equity_accounts = await _lines_for(session, AccountType.EQUITY, totals, accounts)

    income = await income_statement(session, period=period)

    liabilities = list(posted_liabilities)
    if income.provision != ZERO:
        liabilities.append(
            Line(code="—", label="Provision for Income Tax", amount=income.provision, derived=True)
        )

    equity = [
        *equity_accounts,
        Line(code="—", label="Current Period Earnings (NPAT)", amount=income.npat, derived=True),
    ]
    equity = [line for line in equity if is_material(line.amount) or not line.derived]

    return BalanceSheet(
        assets=assets,
        liabilities=liabilities,
        equity=equity,
        total_assets=_sum(assets),
        total_liabilities=_sum(liabilities),
        total_equity=_sum(equity),
    )


# ---------------------------------------------------------------------------
# Executive roll-up
# ---------------------------------------------------------------------------


async def roll_up(
    session: AsyncSession, lines: list[Line], account_type: AccountType
) -> list[Line]:
    """Collapse statement lines into their executive-summary buckets.

    The client asked for the "ability to combine groups of account details into an
    executive summary". Each bucket keeps the codes it came from, so the summary is still
    drillable — a summary you cannot open is a dead end.

    Derived lines stand alone rather than joining a bucket: filing "Provision for Income
    Tax" under a chart group would imply an account that does not exist.
    """
    accounts = {
        a.code: a for a in (await session.execute(select(Account))).scalars().all()
    }

    buckets: list[Line] = []
    by_label: dict[str, Line] = {}

    for line in lines:
        if line.derived:
            buckets.append(Line(code="—", label=line.label, amount=line.amount, derived=True))
            continue

        account = accounts.get(line.code)
        label = (account.group_label if account else None) or TYPE_META[account_type][2]

        bucket = by_label.get(label)
        if bucket is None:
            bucket = Line(code=label, label=label, amount=ZERO, codes=[])
            by_label[label] = bucket
            buckets.append(bucket)

        bucket.amount += line.amount
        bucket.codes.append(line.code)

    return buckets


def _margin(numerator: Decimal, revenue: Decimal) -> Decimal:
    """Percentage to two decimals — the client asked for ,00 precision specifically."""
    if revenue == ZERO:
        return ZERO
    return (numerator / revenue * Decimal(100)).quantize(Decimal("0.01"))


def _pct(rate: Decimal) -> str:
    """Render a rate without trailing zeros: 22.000 -> 22, 1.500 -> 1.5."""
    normalised = rate.normalize()
    return f"{normalised:f}"


__all__ = [
    "BalanceSheet",
    "IncomeStatement",
    "Line",
    "TaxRate",
    "balance_sheet",
    "corporate_tax",
    "income_statement",
    "roll_up",
    "tax_config",
    "withholding",
]
