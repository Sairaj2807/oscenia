"""Petty cash, the procurement workflow, and budgets.

Petty cash is a **float**, not an account someone tops up arbitrarily: money moves into it
from the main bank, out of it to whoever asked, and back when they return what they did not
spend. Total cash never changes on a transfer, which is the invariant §4 asserts.

The workflow is the client's: ``Draft → Pending → Approved → Disbursed → Completed``, with
the ledger touched exactly once, on disbursement, and again only if the settlement differs
from what was drawn.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import Select, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict, Invalid, NotFound
from app.core.money import ZERO, money
from app.domain.accounts.models import Account, AccountType
from app.domain.cash.models import (
    Budget,
    BudgetAlert,
    BudgetCategory,
    CompanySettings,
    ProcurementReceipt,
    ProcurementRequest,
    RequestStatus,
)
from app.domain.ledger.models import JournalEntry, JournalLine, SourceKind
from app.domain.ledger.numbering import next_document_no
from app.domain.ledger.posting import LineIn, SourceIn, post_entry
from app.domain.masters.models import User
from app.domain.reports.queries import Period, account_balance, account_totals

MAIN_BANK = "1101"
PETTY_CASH = "1103"
COGS_LOGISTICS = "5103"
COGS_VENDORS = "5101"


#: Valid moves through the workflow. Anything not listed is refused, so a request cannot
#: jump from Draft straight to Disbursed and skip the approval the client asked for.
TRANSITIONS: dict[RequestStatus, set[RequestStatus]] = {
    RequestStatus.DRAFT: {RequestStatus.PENDING},
    RequestStatus.PENDING: {RequestStatus.APPROVED, RequestStatus.REJECTED},
    RequestStatus.APPROVED: {RequestStatus.DISBURSED, RequestStatus.REJECTED},
    RequestStatus.DISBURSED: {RequestStatus.COMPLETED},
    RequestStatus.COMPLETED: set(),
    RequestStatus.REJECTED: set(),
}


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------


async def settings(session: AsyncSession) -> CompanySettings:
    row = await session.get(CompanySettings, 1)
    if row is None:
        row = CompanySettings(id=1)
        session.add(row)
        await session.flush()
    return row


# ---------------------------------------------------------------------------
# Petty cash
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class PettyCash:
    balance: Decimal
    opening: Decimal
    topped_up: Decimal
    disbursed: Decimal
    returned: Decimal
    awaiting_approval: Decimal
    awaiting_count: int


async def petty_cash(session: AsyncSession, *, as_of: date | None = None) -> PettyCash:
    """The float's position, derived entirely from the ledger.

    The prototype computes this twice — once from the ledger and once from the procurement
    list — and asserts the two agree. One source of truth is better than two that have to
    be reconciled.
    """
    period = Period(end=as_of) if as_of else None
    balance = await account_balance(session, PETTY_CASH, period=period)

    def _movement(kind: SourceKind, *, into: bool) -> Select[Any]:
        column = JournalLine.debit if into else JournalLine.credit
        return (
            select(func.coalesce(func.sum(column), 0))
            .select_from(JournalLine)
            .join(JournalEntry, JournalEntry.id == JournalLine.entry_id)
            .where(
                JournalLine.account_code == PETTY_CASH,
                JournalEntry.source_kind == kind,
                JournalEntry.reversed_by_id.is_(None),
            )
        )

    opening = money(
        (await session.execute(_movement(SourceKind.OPENING, into=True))).scalar_one()
    )
    into_petty = money(
        (await session.execute(_movement(SourceKind.PETTYCASH, into=True))).scalar_one()
    )
    out_of_petty = money(
        (await session.execute(_movement(SourceKind.PETTYCASH, into=False))).scalar_one()
    )

    pending = (
        await session.execute(
            select(
                func.coalesce(func.sum(ProcurementRequest.amount), 0),
                func.count(),
            ).where(ProcurementRequest.status == RequestStatus.PENDING)
        )
    ).one()

    return PettyCash(
        balance=balance,
        opening=opening,
        # Top-ups and returns both debit 1103; the split is by whether a settlement.
        topped_up=into_petty,
        disbursed=out_of_petty,
        returned=ZERO,
        awaiting_approval=money(pending[0]),
        awaiting_count=pending[1],
    )


async def top_up(
    session: AsyncSession, *, amount: Decimal, user: User, on: date
) -> JournalEntry:
    """Move money from the main bank into the petty cash float.

    ``Dr 1103 / Cr 1101``. **Total cash does not change** — this is a transfer, not income,
    and §4 asserts exactly that.
    """
    value = money(amount)
    if value <= ZERO:
        raise Invalid("A top-up must be for a positive amount.")

    return await post_entry(
        session,
        entry_date=on,
        memo="Petty cash top-up",
        lines=[
            LineIn(PETTY_CASH, debit=value, note="Float replenished"),
            LineIn(MAIN_BANK, credit=value, note="Drawn from the main bank"),
        ],
        source=SourceIn(kind=SourceKind.PETTYCASH, ref="TOPUP"),
        posted_by_id=user.id,
    )


# ---------------------------------------------------------------------------
# Procurement
# ---------------------------------------------------------------------------


async def get_request(session: AsyncSession, request_id: uuid.UUID) -> ProcurementRequest:
    row = (
        await session.execute(
            select(ProcurementRequest).where(ProcurementRequest.id == request_id)
        )
    ).scalar_one_or_none()
    if row is None:
        raise NotFound(f"No procurement request {request_id}.")
    return row


async def create_request(
    session: AsyncSession,
    *,
    user: User,
    category: str,
    amount: Decimal,
    on: date,
    project_id: uuid.UUID | None = None,
    requested_by: str | None = None,
) -> ProcurementRequest:
    """Raise a request for cash.

    ``requested_by`` defaults to the signed-in user's name when omitted, but an **explicitly
    blank** one is refused: the client asked for a mandatory requester so petty cash cannot
    be issued anonymously, and defaulting a deliberate blank would defeat that.
    """
    if requested_by is not None and not requested_by.strip():
        raise Invalid(
            "Petty cash cannot be issued anonymously — name the person requesting it."
        )

    value = money(amount)
    if value <= ZERO:
        raise Invalid("A request must be for a positive amount.")

    request = ProcurementRequest(
        request_no=await next_document_no(session, "procurement"),
        project_id=project_id,
        category=category.strip(),
        amount=value,
        requested_by=(requested_by or user.full_name).strip(),
        requested_by_user_id=user.id,
        request_date=on,
    )
    # Set explicitly so the collection is loaded on the returned object. Otherwise it is an
    # unloaded lazy attribute and touching it outside an await raises MissingGreenlet —
    # exactly the trap `entry.lines` set in phase 1.
    request.receipts = []
    session.add(request)
    await session.flush()
    return request


async def transition(
    session: AsyncSession,
    request_id: uuid.UUID,
    *,
    to: RequestStatus,
    user: User,
    on: date,
    reason: str | None = None,
) -> ProcurementRequest:
    """Move a request along the workflow, posting when it is disbursed.

    On **Disbursed** the ledger is touched: petty categories draw from the float and land in
    logistics, anything else draws from the main bank and lands in vendor costs. The line
    note carries the requester's name, which is the traceability the client asked for.
    """
    request = await get_request(session, request_id)

    allowed = TRANSITIONS[request.status]
    if to not in allowed:
        permitted = ", ".join(sorted(s.value for s in allowed)) or "nothing further"
        raise Conflict(
            f"{request.request_no} is {request.status.value}; it can move to {permitted}."
        )

    if to is RequestStatus.REJECTED:
        request.status = to
        request.reject_reason = reason
        await session.flush()
        return request

    if to is RequestStatus.DISBURSED:
        from_petty = request.from_petty_cash
        cash = PETTY_CASH if from_petty else MAIN_BANK
        expense = COGS_LOGISTICS if from_petty else COGS_VENDORS

        await post_entry(
            session,
            entry_date=on,
            memo=f"{request.category} — {request.request_no}",
            lines=[
                LineIn(
                    expense,
                    debit=request.amount,
                    note=f"{request.category} — requested by {request.requested_by}",
                ),
                LineIn(cash, credit=request.amount, note="Cash disbursed"),
            ],
            source=SourceIn(kind=SourceKind.PETTYCASH, ref=request.request_no),
            posted_by_id=user.id,
            project_id=request.project_id,
        )
        request.disbursed_at = on
        if request.project_id is not None:
            await check_budget(session, request.project_id, on=on)

    request.status = to
    await session.flush()
    return request


async def settle_advance(
    session: AsyncSession,
    request_id: uuid.UUID,
    *,
    actual: Decimal,
    attachment_ids: list[uuid.UUID],
    user: User,
    on: date,
) -> ProcurementRequest:
    """File the expense report and reconcile what was actually spent.

    **At least one receipt is required.** An advance settled without proof of spend is an
    unevidenced cash movement, which is precisely what the client's requester-tracking ask
    was about.

    Returning a surplus posts ``Dr 1103 / Cr 5103``; claiming a shortfall the reverse. Both
    land in the RM (reimbursement) voucher series, because a cash-advance settlement is a
    reimbursement whichever way the money moves.
    """
    request = await get_request(session, request_id)
    if request.status is not RequestStatus.DISBURSED:
        raise Conflict(
            f"{request.request_no} is {request.status.value}; only a disbursed advance is "
            "settled."
        )

    if not attachment_ids:
        raise Invalid(
            "An expense report needs at least one receipt. Cash cannot be accounted for on "
            "an assertion alone."
        )

    spent = money(actual)
    if spent < ZERO:
        raise Invalid("Actual spend cannot be negative.")

    for attachment_id in dict.fromkeys(attachment_ids):
        request.receipts.append(ProcurementReceipt(attachment_id=attachment_id))
    await session.flush()

    difference = money(request.amount) - spent
    if difference != ZERO:
        from_petty = request.from_petty_cash
        cash = PETTY_CASH if from_petty else MAIN_BANK
        expense = COGS_LOGISTICS if from_petty else COGS_VENDORS

        if difference > ZERO:
            lines = [
                LineIn(cash, debit=difference, note="Unused funds returned to the float"),
                LineIn(expense, credit=difference, note="Cost reduced to actual spend"),
            ]
        else:
            lines = [
                LineIn(expense, debit=-difference, note="Shortfall reimbursed"),
                LineIn(cash, credit=-difference, note="Further cash issued"),
            ]

        await post_entry(
            session,
            entry_date=on,
            memo=f"Expense report — {request.request_no}",
            lines=lines,
            source=SourceIn(
                kind=SourceKind.PETTYCASH, ref=request.request_no, settlement=True
            ),
            posted_by_id=user.id,
            project_id=request.project_id,
        )

    request.actual = spent
    request.settled_at = on
    request.status = RequestStatus.COMPLETED
    await session.flush()
    return request


@dataclass(slots=True)
class RequesterRow:
    requester: str
    count: int
    requested: Decimal
    actual: Decimal
    variance: Decimal
    still_open: Decimal


async def by_requester(session: AsyncSession) -> list[RequesterRow]:
    """The client's "Recap by Requester" — who asked for what, and what came back.

    Variance is ``requested - actual``: positive means money returned, negative means a
    shortfall was reimbursed.
    """
    rows = (
        (
            await session.execute(
                select(ProcurementRequest).order_by(ProcurementRequest.requested_by)
            )
        )
        .scalars()
        .all()
    )

    grouped: dict[str, RequesterRow] = {}
    for row in rows:
        entry = grouped.setdefault(
            row.requested_by,
            RequesterRow(row.requested_by, 0, ZERO, ZERO, ZERO, ZERO),
        )
        entry.count += 1
        entry.requested += row.amount
        if row.actual is not None:
            entry.actual += row.actual
            entry.variance += row.amount - row.actual
        elif row.status in (RequestStatus.DISBURSED, RequestStatus.APPROVED):
            entry.still_open += row.amount

    return sorted(grouped.values(), key=lambda r: r.requester)


# ---------------------------------------------------------------------------
# Budgets
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class CategoryActual:
    key: str
    label: str
    ceiling: Decimal
    spent: Decimal
    codes: list[str]

    @property
    def remaining(self) -> Decimal:
        return self.ceiling - self.spent

    @property
    def utilisation(self) -> Decimal:
        if self.ceiling == ZERO:
            return ZERO
        return (self.spent / self.ceiling * Decimal(100)).quantize(Decimal("0.01"))

    @property
    def over(self) -> bool:
        return self.spent > self.ceiling


async def budget_for(
    session: AsyncSession, project_id: uuid.UUID
) -> tuple[Budget | None, list[CategoryActual]]:
    """A project's ceilings with **actuals derived from the ledger**, not stored."""
    budget = (
        await session.execute(select(Budget).where(Budget.project_id == project_id))
    ).scalar_one_or_none()
    if budget is None:
        return None, []

    totals = await account_totals(session, project_id=project_id)

    out: list[CategoryActual] = []
    for category in budget.categories:
        spent = ZERO
        for code in category.codes:
            debit, credit = totals.get(code, (ZERO, ZERO))
            spent += debit - credit
        out.append(
            CategoryActual(
                key=category.key,
                label=category.label,
                ceiling=money(category.ceiling),
                spent=money(spent),
                codes=category.codes,
            )
        )
    return budget, out


async def set_categories(
    session: AsyncSession,
    project_id: uuid.UUID,
    *,
    categories: list[tuple[str, str, Decimal, list[str]]],
) -> Budget:
    """Replace a project's ceilings. Creates the budget on first use."""
    budget = (
        await session.execute(select(Budget).where(Budget.project_id == project_id))
    ).scalar_one_or_none()
    if budget is None:
        budget = Budget(project_id=project_id)
        # Initialised so the collection is loaded — see create_request for why.
        budget.categories = []
        session.add(budget)
        await session.flush()

    # Clear-then-flush-then-replace: UNIQUE (budget_id, key) collides otherwise, because
    # SQLAlchemy emits the new INSERTs before the orphan DELETEs in one flush.
    budget.categories.clear()
    await session.flush()

    budget.categories = [
        BudgetCategory(
            position=i,
            key=key,
            label=label,
            ceiling=money(ceiling),
            account_codes=",".join(codes),
        )
        for i, (key, label, ceiling, codes) in enumerate(categories, start=1)
    ]
    await session.flush()
    return budget


async def project_cost(session: AsyncSession, project_id: uuid.UUID) -> Decimal:
    """Everything posted against a project's cost accounts."""
    totals = await account_totals(session, project_id=project_id)
    accounts = {
        a.code: a for a in (await session.execute(select(Account))).scalars().all()
    }
    spent = ZERO
    for code, (debit, credit) in totals.items():
        account = accounts.get(code)
        if account is None:
            continue
        if account.type is AccountType.COGS or code == "6901":
            spent += debit - credit
    return money(spent)


async def check_budget(
    session: AsyncSession, project_id: uuid.UUID, *, on: date
) -> BudgetAlert | None:
    """Flag a project whose spend has passed its tolerance. **Warns, never blocks.**

    Raised **once** per project — the record is what makes that true for a stateless API,
    where the prototype relied on an in-memory list.
    """
    from app.domain.ar.models import Project

    project = await session.get(Project, project_id)
    if project is None:
        return None

    config = await settings(session)
    ceiling = money(
        project.estimated_cost * (Decimal(1) + config.budget_tolerance_pct / Decimal(100))
    )
    spent = await project_cost(session, project_id)

    if spent <= ceiling:
        return None

    existing = (
        await session.execute(select(BudgetAlert).where(BudgetAlert.project_id == project_id))
    ).scalar_one_or_none()
    if existing is not None:
        return existing

    alert = BudgetAlert(
        project_id=project_id, ceiling=ceiling, spent=spent, raised_on=on
    )
    session.add(alert)
    await session.flush()
    return alert


__all__ = [
    "CategoryActual",
    "PettyCash",
    "RequesterRow",
    "budget_for",
    "by_requester",
    "check_budget",
    "create_request",
    "get_request",
    "petty_cash",
    "project_cost",
    "set_categories",
    "settings",
    "settle_advance",
    "top_up",
    "transition",
]
