"""Report endpoints.

Every report takes the same filter triple (``start``, ``end``, ``project_id``), and named
periods resolve **server-side** so the client and the server cannot disagree about where a
quarter begins.
"""

from __future__ import annotations

import uuid
from datetime import date

from fastapi import APIRouter, Query

from app.core.clock import ClockDep
from app.core.deps import CurrentUser
from app.core.errors import Invalid
from app.core.schemas import MoneyStr, Schema
from app.db.session import SessionDep
from app.domain.accounts.models import AccountType
from app.domain.reports import pnl, queries, statements, trend
from app.domain.reports.periods import NamedPeriod, resolve_period
from app.domain.reports.schemas import (
    BalanceSheetOut,
    CompareMode,
    ComparisonOut,
    CostEntryOut,
    DeltaOut,
    IncomeStatementOut,
    SliceOut,
    StatementLineOut,
)

router = APIRouter(prefix="/reports", tags=["reports"])


# ---------------------------------------------------------------------------
# Ledger reports
# ---------------------------------------------------------------------------


class TrialBalanceOut(Schema):
    debit: MoneyStr
    credit: MoneyStr
    balanced: bool
    difference: MoneyStr
    start: date | None
    end: date | None


class LedgerRowOut(Schema):
    entry_id: uuid.UUID
    entry_no: str
    voucher_no: str
    entry_date: date
    memo: str
    account_code: str
    note: str | None
    debit: MoneyStr
    credit: MoneyStr
    balance: MoneyStr


class GeneralLedgerOut(Schema):
    opening: MoneyStr
    rows: list[LedgerRowOut]
    closing: MoneyStr
    movement: MoneyStr
    total_debit: MoneyStr
    total_credit: MoneyStr

    #: False means this is a consolidated view, whose running balance is a raw net-debit
    #: figure that nets to zero. The UI should say so rather than imply a meaningful total.
    single_account: bool


class CashAccountOut(Schema):
    code: str
    name: str
    balance: MoneyStr
    share: float


class CashPositionOut(Schema):
    total: MoneyStr
    accounts: list[CashAccountOut]
    as_of: date


@router.get("/trial-balance", response_model=TrialBalanceOut)
async def trial_balance(
    session: SessionDep,
    clock: ClockDep,
    user: CurrentUser,
    period: NamedPeriod = NamedPeriod.ALL,
    start: date | None = None,
    end: date | None = None,
    project_id: uuid.UUID | None = None,
) -> TrialBalanceOut:
    """Total debits against total credits. Balanced means **exactly** equal."""
    window = resolve_period(period, clock.today(), start=start, end=end)
    tb = await queries.trial_balance(session, period=window, project_id=project_id)
    return TrialBalanceOut(
        debit=tb.debit,
        credit=tb.credit,
        balanced=tb.balanced,
        difference=tb.difference,
        start=window.start,
        end=window.end,
    )


@router.get("/general-ledger", response_model=GeneralLedgerOut)
async def general_ledger(
    session: SessionDep,
    clock: ClockDep,
    user: CurrentUser,
    codes: list[str] | None = Query(default=None, description="Omit for consolidated"),
    period: NamedPeriod = NamedPeriod.YTD,
    start: date | None = None,
    end: date | None = None,
    project_id: uuid.UUID | None = None,
) -> GeneralLedgerOut:
    """Row per journal line, with opening balance and a running total.

    The opening balance folds in everything before the window rather than dropping it, so
    ``opening + movement == closing`` always holds. A ledger that starts a narrow period at
    zero is lying about the account.
    """
    window = resolve_period(period, clock.today(), start=start, end=end)
    gl = await queries.general_ledger(
        session, codes=codes, period=window, project_id=project_id
    )
    return GeneralLedgerOut(
        opening=gl.opening,
        rows=[LedgerRowOut.model_validate(r) for r in gl.rows],
        closing=gl.closing,
        movement=gl.movement,
        total_debit=gl.total_debit,
        total_credit=gl.total_credit,
        single_account=gl.single_account,
    )


@router.get("/cash-position", response_model=CashPositionOut)
async def cash_position(
    session: SessionDep,
    clock: ClockDep,
    user: CurrentUser,
    as_of: date | None = None,
) -> CashPositionOut:
    """Total cash and bank, and each account's share of it.

    Sums every account flagged as cash — including sub-accounts, and including a parent
    that has since become a header, so opening a sub-account never changes the total.
    """
    on = as_of or clock.today()
    total, rows = await queries.cash_balance(session, period=queries.Period(end=on))
    return CashPositionOut(
        total=total,
        accounts=[
            CashAccountOut(
                code=code,
                name=name,
                balance=balance,
                share=float(balance / total) if total else 0.0,
            )
            for code, name, balance in rows
        ],
        as_of=on,
    )


class TrendMonthOut(Schema):
    #: ``YYYY-MM``.
    month: str
    revenue: MoneyStr
    cost: MoneyStr
    #: Revenue less cost, before corporate tax (tax is a provision on the whole profit).
    profit: MoneyStr
    cash_in: MoneyStr
    cash_out: MoneyStr
    closing_cash: MoneyStr


class TrendDeltaOut(Schema):
    """Percent change from the previous month; null when the previous month was zero."""

    revenue: float | None
    cost: float | None
    profit: float | None
    cash_in: float | None
    cash_out: float | None
    closing_cash: float | None


class MonthlyTrendOut(Schema):
    months: list[TrendMonthOut]
    current: TrendMonthOut
    previous: TrendMonthOut | None
    delta: TrendDeltaOut


def _trend_out(row: trend.TrendMonth) -> TrendMonthOut:
    return TrendMonthOut(
        month=row.month, revenue=row.revenue, cost=row.cost, profit=row.profit,
        cash_in=row.cash_in, cash_out=row.cash_out, closing_cash=row.closing_cash,
    )  # fmt: skip


@router.get("/monthly-trend", response_model=MonthlyTrendOut)
async def monthly_trend(
    session: SessionDep,
    clock: ClockDep,
    user: CurrentUser,
    months: int = Query(default=6, ge=2, le=24),
) -> MonthlyTrendOut:
    """The last ``months`` months of revenue, cost, profit and cash, with this month against last.

    Summed from the journal in one grouped query; empty months are included as zeros so a chart has
    no gaps. This is what the dashboard's chart and its "vs last month" arrows read.
    """
    rows = await trend.monthly_trend(session, today=clock.today(), months=months)
    current, previous = rows[-1], rows[-2]
    return MonthlyTrendOut(
        months=[_trend_out(r) for r in rows],
        current=_trend_out(current),
        previous=_trend_out(previous),
        delta=TrendDeltaOut(
            revenue=trend.delta_pct(current.revenue, previous.revenue),
            cost=trend.delta_pct(current.cost, previous.cost),
            profit=trend.delta_pct(current.profit, previous.profit),
            cash_in=trend.delta_pct(current.cash_in, previous.cash_in),
            cash_out=trend.delta_pct(current.cash_out, previous.cash_out),
            closing_cash=trend.delta_pct(current.closing_cash, previous.closing_cash),
        ),
    )


# ---------------------------------------------------------------------------
# Statements
# ---------------------------------------------------------------------------


@router.get("/income-statement", response_model=IncomeStatementOut)
async def income_statement(
    session: SessionDep,
    clock: ClockDep,
    user: CurrentUser,
    period: NamedPeriod = NamedPeriod.YTD,
    start: date | None = None,
    end: date | None = None,
    project_id: uuid.UUID | None = None,
    summarised: bool = Query(default=False, description="Roll up into executive buckets"),
) -> IncomeStatementOut:
    """Revenue through to NPAT.

    Corporate tax is **computed from the configured rate, not read from a posted entry**,
    so changing the rate moves Tax Expense and NPAT immediately. That is the client's
    "manual override prior to displaying Tax Expense & Net Profit". Manually posted tax
    lines are added on top of the computed provision rather than replacing it.
    """
    window = resolve_period(period, clock.today(), start=start, end=end)
    stmt = await statements.income_statement(session, period=window, project_id=project_id)

    if summarised:
        revenue = await statements.roll_up(session, stmt.revenue, AccountType.REVENUE)
        cogs = await statements.roll_up(session, stmt.cogs, AccountType.COGS)
        opex = await statements.roll_up(session, stmt.opex, AccountType.OPEX)
        tax = await statements.roll_up(session, stmt.tax, AccountType.TAX)
    else:
        revenue, cogs, opex, tax = stmt.revenue, stmt.cogs, stmt.opex, stmt.tax

    return IncomeStatementOut(
        revenue=[StatementLineOut.model_validate(line) for line in revenue],
        cogs=[StatementLineOut.model_validate(line) for line in cogs],
        opex=[StatementLineOut.model_validate(line) for line in opex],
        tax=[StatementLineOut.model_validate(line) for line in tax],
        total_revenue=stmt.total_revenue,
        total_cogs=stmt.total_cogs,
        gross_profit=stmt.gross_profit,
        total_opex=stmt.total_opex,
        profit_before_tax=stmt.profit_before_tax,
        total_tax=stmt.total_tax,
        posted_tax=stmt.posted_tax,
        provision=stmt.provision,
        npat=stmt.npat,
        tax_rate=stmt.tax_rate,
        gross_margin=stmt.gross_margin,
        net_margin=stmt.net_margin,
        prepaid_withholding=stmt.prepaid_withholding,
        summarised=summarised,
        start=window.start,
        end=window.end,
    )


@router.get("/balance-sheet", response_model=BalanceSheetOut)
async def balance_sheet(
    session: SessionDep,
    clock: ClockDep,
    user: CurrentUser,
    period: NamedPeriod = NamedPeriod.ALL,
    start: date | None = None,
    end: date | None = None,
    summarised: bool = Query(default=False, description="Roll up into executive buckets"),
) -> BalanceSheetOut:
    """Assets against liabilities and equity.

    Two rows are **derived** and carry no account code: *Provision for Income Tax* under
    liabilities, and *Current Period Earnings (NPAT)* under equity. There is no closing
    entry — income accounts keep their balances — so without both the sheet is out by
    exactly the tax amount.

    There is deliberately no ``project_id`` filter. A balance sheet for one project is not
    a meaningful document: cash, receivables and equity are company-wide.
    """
    window = resolve_period(period, clock.today(), start=start, end=end)
    sheet = await statements.balance_sheet(session, period=window)

    if summarised:
        assets = await statements.roll_up(session, sheet.assets, AccountType.ASSET)
        liabilities = await statements.roll_up(
            session, sheet.liabilities, AccountType.LIABILITY
        )
        equity = await statements.roll_up(session, sheet.equity, AccountType.EQUITY)
    else:
        assets, liabilities, equity = sheet.assets, sheet.liabilities, sheet.equity

    return BalanceSheetOut(
        assets=[StatementLineOut.model_validate(line) for line in assets],
        liabilities=[StatementLineOut.model_validate(line) for line in liabilities],
        equity=[StatementLineOut.model_validate(line) for line in equity],
        total_assets=sheet.total_assets,
        total_liabilities=sheet.total_liabilities,
        total_equity=sheet.total_equity,
        balanced=sheet.balanced,
        difference=sheet.difference,
        summarised=summarised,
        as_of=window.end,
        excludes_opening_balances=window.start is not None,
    )


# ---------------------------------------------------------------------------
# Project P&L
# ---------------------------------------------------------------------------


def _slice_dict(s: pnl.Slice) -> dict:
    return {
        "label": s.label,
        "revenue": s.revenue,
        "cost": s.cost,
        "profit": s.profit,
        "margin": s.margin,
        "start": s.start,
        "end": s.end,
        "costs": s.costs,
    }


@router.get("/project-pnl", response_model=SliceOut)
async def project_pnl(
    session: SessionDep,
    clock: ClockDep,
    user: CurrentUser,
    project_id: uuid.UUID | None = None,
    period: NamedPeriod = NamedPeriod.ALL,
    start: date | None = None,
    end: date | None = None,
) -> SliceOut:
    """Revenue, cost and margin for a project, a period, or both.

    Cost lines are the project cost accounts — COGS plus 6901 Asset Loss Expense, which is
    an operating expense company-wide but absolutely a cost of the job that destroyed the
    equipment. Credits appear as negatives rather than being filtered out: a credit to a
    cost account is a real reduction, and dropping it would overstate the project.
    """
    window = resolve_period(period, clock.today(), start=start, end=end)
    result = await pnl.slice_totals(
        session, period=window, project_id=project_id, label="Current"
    )
    return SliceOut.model_validate(_slice_dict(result))


@router.get("/project-costs", response_model=list[CostEntryOut])
async def project_costs(
    session: SessionDep, user: CurrentUser, project_id: uuid.UUID
) -> list[CostEntryOut]:
    """The itemised cost lines behind a project's cost figure, newest first."""
    return [CostEntryOut.model_validate(r) for r in await pnl.cost_lines(session, project_id)]


@router.get("/project-pnl/compare", response_model=ComparisonOut)
async def compare_pnl(
    session: SessionDep,
    clock: ClockDep,
    user: CurrentUser,
    against: CompareMode,
    project_id: uuid.UUID | None = None,
    other_project_id: uuid.UUID | None = None,
    period: NamedPeriod = NamedPeriod.MONTH,
    start: date | None = None,
    end: date | None = None,
) -> ComparisonOut:
    """Compare a slice against an earlier window or another project.

    Both halves are computed through the identical code path, which is the only way a
    comparison means anything. Cost deltas are **inverse-signed**: spending less than the
    baseline is an improvement, so a fall in cost reports as positive.

    ``mom`` is the whole previous calendar month; ``prev`` an equally-long preceding
    window; ``yoy`` the same window a year earlier; ``project`` the same window for another
    project. Comparison against a **budget** arrives with budgets in phase 6.
    """
    window = resolve_period(period, clock.today(), start=start, end=end)
    earliest = await queries.earliest_entry_date(session)

    baseline_project = project_id
    if against is CompareMode.PROJECT:
        if other_project_id is None:
            raise Invalid("Comparing against another project needs `other_project_id`.")
        baseline_window = window
        baseline_project = other_project_id
        label = "Other project"
    elif against is CompareMode.MOM:
        baseline_window = pnl.previous_calendar_month(window)
        label = "Previous month"
    elif against is CompareMode.PREV:
        baseline_window = pnl.preceding_window(window)
        label = "Previous period"
    else:
        baseline_window = pnl.shift_months(window, -12)
        label = "A year earlier"

    comparison = await pnl.compare(
        session,
        current_period=window,
        current_project=project_id,
        baseline_period=baseline_window,
        baseline_project=baseline_project,
        baseline_label=label,
        earliest=earliest,
    )

    return ComparisonOut(
        current=SliceOut.model_validate(_slice_dict(comparison.current)),
        baseline=SliceOut.model_validate(_slice_dict(comparison.baseline)),
        deltas=[
            DeltaOut(
                metric=d.metric,
                now=d.now,
                was=d.was,
                change=d.change,
                percent=d.percent,
                improved=d.improved,
                inverse=d.inverse,
            )
            for d in comparison.deltas
        ],
        before_ledger=comparison.before_ledger,
    )
