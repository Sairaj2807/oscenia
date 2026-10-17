"""Ledger queries: balances, trial balance, general ledger, open items.

SQL translations of ``erp-frontend/src/lib/ledger.js``. **Nothing here is stored.** Cash,
AR, AP, the statements and project P&L are all derived at query time, which is the
prototype's architecture and the reason its numbers can never silently disagree with the
journal.

The one rule worth restating, because everything about AR and AP depends on it:

    An entry that settles something is never itself an open item.

See :class:`~app.domain.ledger.models.EntryApplication`.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import Select, case, exists, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.money import MATERIALITY, ZERO, money
from app.domain.accounts.models import Account, AccountType, Side, normal_side
from app.domain.ledger.models import EntryApplication, JournalEntry, JournalLine


@dataclass(slots=True)
class Period:
    """A closed date range. Both ends inclusive; either may be open-ended."""

    start: date | None = None
    end: date | None = None

    def applies(self) -> bool:
        return self.start is not None or self.end is not None


def _scope(
    stmt: Select,
    *,
    period: Period | None = None,
    project_id: uuid.UUID | None = None,
    include_reversed: bool = True,
) -> Select:
    if period and period.start is not None:
        stmt = stmt.where(JournalEntry.entry_date >= period.start)
    if period and period.end is not None:
        stmt = stmt.where(JournalEntry.entry_date <= period.end)
    if project_id is not None:
        stmt = stmt.where(JournalEntry.project_id == project_id)
    if not include_reversed:
        stmt = stmt.where(
            JournalEntry.reversed_by_id.is_(None), JournalEntry.reversal_of_id.is_(None)
        )
    return stmt


# ---------------------------------------------------------------------------
# Balances
# ---------------------------------------------------------------------------


async def account_totals(
    session: AsyncSession,
    *,
    period: Period | None = None,
    project_id: uuid.UUID | None = None,
) -> dict[str, tuple[Decimal, Decimal]]:
    """Raw ``{code: (debit, credit)}`` over the scoped set."""
    stmt = _scope(
        select(
            JournalLine.account_code,
            func.coalesce(func.sum(JournalLine.debit), 0),
            func.coalesce(func.sum(JournalLine.credit), 0),
        ).join(JournalEntry, JournalLine.entry_id == JournalEntry.id),
        period=period,
        project_id=project_id,
    ).group_by(JournalLine.account_code)

    return {
        code: (money(debit), money(credit))
        for code, debit, credit in (await session.execute(stmt)).all()
    }


async def account_balance(
    session: AsyncSession,
    code: str,
    *,
    period: Period | None = None,
    project_id: uuid.UUID | None = None,
) -> Decimal:
    """Balance signed to the account's **natural side**.

    A debit-normal account returns ``debit - credit``; a credit-normal account the reverse.
    So 1303 Accumulated Depreciation — a contra account inside an asset type — returns a
    *negative* number, which is exactly why ``net_book_value == balance(1302) +
    balance(1303)`` holds rather than needing a subtraction.
    """
    account = (
        await session.execute(select(Account).where(Account.code == code))
    ).scalar_one_or_none()
    if account is None:
        return ZERO

    totals = await account_totals(session, period=period, project_id=project_id)
    debit, credit = totals.get(code, (ZERO, ZERO))
    return debit - credit if normal_side(account.type) is Side.DEBIT else credit - debit


async def cash_balance(
    session: AsyncSession, *, period: Period | None = None
) -> tuple[Decimal, list[tuple[str, str, Decimal]]]:
    """Total cash, and the per-account breakdown.

    Sums every account flagged ``is_cash`` — including user-created sub-accounts, and
    including a parent that has since become a header. Opening a sub-account under 1101
    must not change Total Cash, which is why headers keep their own balance.
    """
    codes = (
        (await session.execute(select(Account.code, Account.name).where(Account.is_cash.is_(True))))
        .all()
    )
    totals = await account_totals(session, period=period)

    rows: list[tuple[str, str, Decimal]] = []
    total = ZERO
    for code, name in codes:
        debit, credit = totals.get(code, (ZERO, ZERO))
        balance = debit - credit  # every cash account is an asset, so debit-normal
        rows.append((code, name, balance))
        total += balance
    return total, sorted(rows, key=lambda r: r[0])


# ---------------------------------------------------------------------------
# Trial balance
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class TrialBalance:
    debit: Decimal
    credit: Decimal

    @property
    def balanced(self) -> bool:
        """Exact. NUMERIC is exact arithmetic; there is no tolerance."""
        return self.debit == self.credit

    @property
    def difference(self) -> Decimal:
        return self.debit - self.credit


async def trial_balance(
    session: AsyncSession,
    *,
    period: Period | None = None,
    project_id: uuid.UUID | None = None,
) -> TrialBalance:
    stmt = _scope(
        select(
            func.coalesce(func.sum(JournalLine.debit), 0),
            func.coalesce(func.sum(JournalLine.credit), 0),
        ).join(JournalEntry, JournalLine.entry_id == JournalEntry.id),
        period=period,
        project_id=project_id,
    )
    debit, credit = (await session.execute(stmt)).one()
    return TrialBalance(debit=money(debit), credit=money(credit))


# ---------------------------------------------------------------------------
# General ledger
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class LedgerRow:
    entry_id: uuid.UUID
    entry_no: str
    voucher_no: str
    entry_date: date
    memo: str
    account_code: str
    note: str | None
    debit: Decimal
    credit: Decimal
    balance: Decimal


@dataclass(slots=True)
class GeneralLedger:
    opening: Decimal
    rows: list[LedgerRow]
    closing: Decimal
    total_debit: Decimal
    total_credit: Decimal
    single_account: bool

    @property
    def movement(self) -> Decimal:
        return self.closing - self.opening


async def general_ledger(
    session: AsyncSession,
    *,
    codes: list[str] | None = None,
    period: Period | None = None,
    project_id: uuid.UUID | None = None,
) -> GeneralLedger:
    """Row per matching journal *line*, with a running balance.

    The **opening balance** folds in everything before ``period.start`` rather than dropping
    it — a ledger that starts a narrow period at zero is lying about the account. So
    ``opening + movement == closing`` always holds.

    For a single account the running balance is signed to that account's natural side. For a
    consolidated view it is a raw net-debit figure, which nets to zero across all accounts;
    ``single_account`` tells the caller which it is looking at, so the UI can say so rather
    than implying a meaningful total.
    """
    single = bool(codes) and len(codes or []) == 1
    sign = Decimal(1)
    if single:
        account = (
            await session.execute(select(Account).where(Account.code == (codes or [])[0]))
        ).scalar_one_or_none()
        if account is not None and normal_side(account.type) is Side.CREDIT:
            sign = Decimal(-1)

    def with_codes(stmt: Select) -> Select:
        return stmt.where(JournalLine.account_code.in_(codes)) if codes else stmt

    # Opening: everything strictly before the window.
    opening = ZERO
    if period and period.start is not None:
        pre = with_codes(
            _scope(
                select(
                    func.coalesce(func.sum(JournalLine.debit), 0),
                    func.coalesce(func.sum(JournalLine.credit), 0),
                ).join(JournalEntry, JournalLine.entry_id == JournalEntry.id),
                period=Period(end=period.start - timedelta(days=1)),
                project_id=project_id,
            )
        )
        pre_debit, pre_credit = (await session.execute(pre)).one()
        opening = money((money(pre_debit) - money(pre_credit)) * sign)

    stmt = with_codes(
        _scope(
            select(
                JournalEntry.id,
                JournalEntry.entry_no,
                JournalEntry.voucher_no,
                JournalEntry.entry_date,
                JournalEntry.memo,
                JournalLine.account_code,
                JournalLine.note,
                JournalLine.debit,
                JournalLine.credit,
            ).join(JournalEntry, JournalLine.entry_id == JournalEntry.id),
            period=period,
            project_id=project_id,
        )
    ).order_by(JournalEntry.entry_date, JournalEntry.entry_no, JournalLine.line_no)

    running = opening
    rows: list[LedgerRow] = []
    total_debit = ZERO
    total_credit = ZERO

    for r in (await session.execute(stmt)).all():
        debit, credit = money(r.debit), money(r.credit)
        total_debit += debit
        total_credit += credit
        running += (debit - credit) * sign
        rows.append(
            LedgerRow(
                entry_id=r.id,
                entry_no=r.entry_no,
                voucher_no=r.voucher_no,
                entry_date=r.entry_date,
                memo=r.memo,
                account_code=r.account_code,
                note=r.note,
                debit=debit,
                credit=credit,
                balance=money(running),
            )
        )

    return GeneralLedger(
        opening=opening,
        rows=rows,
        closing=money(running),
        total_debit=total_debit,
        total_credit=total_credit,
        single_account=single,
    )


# ---------------------------------------------------------------------------
# Open items — the AR/AP engine
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class OpenItem:
    entry_id: uuid.UUID
    entry_no: str
    voucher_no: str
    entry_date: date
    memo: str
    due: date | None
    vendor_id: uuid.UUID | None
    project_id: uuid.UUID | None
    source_kind: str
    source_ref: str | None
    raised: Decimal
    applied: Decimal
    outstanding: Decimal


def _movement(control: str, side: Side):  # type: ignore[no-untyped-def]
    """Net movement on the control account, in the direction that *opens* an item."""
    debit = func.coalesce(
        func.sum(case((JournalLine.account_code == control, JournalLine.debit), else_=0)), 0
    )
    credit = func.coalesce(
        func.sum(case((JournalLine.account_code == control, JournalLine.credit), else_=0)), 0
    )
    return (debit - credit) if side is Side.DEBIT else (credit - debit)


async def open_items(
    session: AsyncSession,
    *,
    control: str,
    side: Side = Side.DEBIT,
    as_of: date | None = None,
) -> list[OpenItem]:
    """Documents still awaiting settlement on a control account.

    ``control='1201', side=DEBIT`` is Accounts Receivable; ``control='2102',
    side=CREDIT`` is Accounts Payable.

    Three conditions, all load-bearing:

    1. Reversals and reversed entries are excluded — so reversing a payment automatically
       *reopens* the invoice it settled.
    2. An entry with any outgoing application is skipped. It is a settlement or an
       adjustment, never a new open item. Without this a variance adjustment (which credits
       2102 exactly as a bill does) is counted both as its own open bill and as a reduction
       of the one it adjusts, and the open-items total drifts above its control account.
    3. Anything below materiality is settled. A document with under a rupiah outstanding is
       not worth chasing.
    """
    movement = _movement(control, side)

    settles = exists().where(EntryApplication.settling_entry_id == JournalEntry.id)

    candidates = (
        select(
            JournalEntry.id,
            JournalEntry.entry_no,
            JournalEntry.voucher_no,
            JournalEntry.entry_date,
            JournalEntry.memo,
            JournalEntry.source_due,
            JournalEntry.source_vendor_id,
            JournalEntry.project_id,
            JournalEntry.source_kind,
            JournalEntry.source_ref,
            movement.label("raised"),
        )
        .join(JournalLine, JournalLine.entry_id == JournalEntry.id)
        .where(
            JournalEntry.reversed_by_id.is_(None),
            JournalEntry.reversal_of_id.is_(None),
            ~settles,
        )
        .group_by(JournalEntry.id)
        .having(movement > MATERIALITY)
    )
    if as_of is not None:
        candidates = candidates.where(JournalEntry.entry_date <= as_of)

    rows = (await session.execute(candidates)).all()
    if not rows:
        return []

    ids = [r.id for r in rows]

    # Everything applied against those documents, by non-reversed settling entries, moving
    # the control account the *other* way. Note this is the mirrored movement computed once,
    # not the original negated: sum(-(sum(...))) is a nested aggregate and Postgres refuses
    # it outright.
    settle_movement = _movement(control, Side.CREDIT if side is Side.DEBIT else Side.DEBIT)
    applied_stmt = (
        select(
            EntryApplication.settled_entry_id,
            settle_movement.label("applied"),
        )
        .select_from(EntryApplication)
        .join(JournalEntry, JournalEntry.id == EntryApplication.settling_entry_id)
        .join(JournalLine, JournalLine.entry_id == JournalEntry.id)
        .where(
            EntryApplication.settled_entry_id.in_(ids),
            JournalEntry.reversed_by_id.is_(None),
        )
        .group_by(EntryApplication.settled_entry_id)
    )
    applied_by_id = {
        entry_id: money(total) for entry_id, total in (await session.execute(applied_stmt)).all()
    }

    items: list[OpenItem] = []
    for r in rows:
        raised = money(r.raised)
        applied = applied_by_id.get(r.id, ZERO)
        outstanding = raised - applied
        if outstanding <= MATERIALITY:
            continue
        items.append(
            OpenItem(
                entry_id=r.id,
                entry_no=r.entry_no,
                voucher_no=r.voucher_no,
                entry_date=r.entry_date,
                memo=r.memo,
                due=r.source_due,
                vendor_id=r.source_vendor_id,
                project_id=r.project_id,
                source_kind=str(r.source_kind),
                source_ref=r.source_ref,
                raised=raised,
                applied=applied,
                outstanding=outstanding,
            )
        )

    items.sort(key=lambda i: (i.due or i.entry_date, i.entry_no))
    return items


async def linked_entries(
    session: AsyncSession, entry_id: uuid.UUID
) -> tuple[list[uuid.UUID], list[uuid.UUID]]:
    """``(settles, settled_by)`` — the two halves of the drill-down chain."""
    settles = (
        (
            await session.execute(
                select(EntryApplication.settled_entry_id).where(
                    EntryApplication.settling_entry_id == entry_id
                )
            )
        )
        .scalars()
        .all()
    )
    settled_by = (
        (
            await session.execute(
                select(EntryApplication.settling_entry_id).where(
                    EntryApplication.settled_entry_id == entry_id
                )
            )
        )
        .scalars()
        .all()
    )
    return list(settles), list(settled_by)


# ---------------------------------------------------------------------------
# Project costs — used by phase 3's P&L, defined here beside the other queries
# ---------------------------------------------------------------------------


async def project_cost_codes(session: AsyncSession) -> list[str]:
    """COGS accounts plus 6901 Asset Loss Expense.

    Asset Loss is an operating expense company-wide but absolutely a cost of the job that
    destroyed the equipment. Single definition on purpose: the prototype once had this in
    two places and a warehouse write-off pushed the two figures out of step.
    """
    stmt = select(Account.code).where(
        or_(Account.type == AccountType.COGS, Account.code == "6901")
    )
    return sorted((await session.execute(stmt)).scalars().all())


async def earliest_entry_date(session: AsyncSession) -> date | None:
    """So a comparison window ending before the ledger begins can warn rather than
    render a misleading row of zeroes."""
    return (await session.execute(select(func.min(JournalEntry.entry_date)))).scalar_one_or_none()


__all__ = [
    "GeneralLedger",
    "LedgerRow",
    "OpenItem",
    "Period",
    "TrialBalance",
    "account_balance",
    "account_totals",
    "cash_balance",
    "earliest_entry_date",
    "general_ledger",
    "linked_entries",
    "open_items",
    "project_cost_codes",
    "trial_balance",
]
