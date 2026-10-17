"""The posting engine.

**Nothing else in this codebase writes to ``journal_entries``.** Every module that posts —
AR, AP, petty cash, depreciation, payroll — comes through :func:`post_entry`. That is the
invariant that makes every later phase cheap: the validation, numbering, period check and
application linking are written once, here.

The database enforces the same rules independently (see the migration's triggers). This
module exists to fail early with a message a human can act on; the triggers exist because a
migration script or a ``psql`` session will eventually bypass this module.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict, Invalid, NotFound, OutOfBalance, PeriodClosed
from app.core.money import ZERO, money
from app.domain.accounts.models import Account
from app.domain.ledger.models import (
    AccountingPeriod,
    EntryApplication,
    JournalEntry,
    JournalLine,
    PeriodStatus,
    SourceKind,
)
from app.domain.ledger.numbering import next_document_no, next_voucher_no, pick_series

#: Accounts whose movement makes an otherwise cash-free entry a Fixed Asset voucher.
#: Consumables (1301) are deliberately excluded — releasing stock to a project is an
#: expense accrual, not an asset movement.
FIXED_ASSET_CODES = frozenset({"1302", "1303"})


@dataclass(slots=True)
class LineIn:
    """One side of one posting. A debit **or** a credit, never both."""

    account: str
    debit: Decimal = ZERO
    credit: Decimal = ZERO
    note: str | None = None


@dataclass(slots=True)
class SourceIn:
    kind: SourceKind
    ref: str | None = None
    due: date | None = None
    #: The date on the source document, where that differs from the posting date.
    document_date: date | None = None
    vendor_id: uuid.UUID | None = None
    settlement: bool = False


async def _assert_group_exists(session: AsyncSession, group_ref: str) -> None:
    """A journal code must name a voucher that exists.

    Entries are immutable, so a mistyped code cannot be repaired afterwards — the row would
    sit alone in a group forever, and the correction it was meant to join would still look
    unrelated. The dropdown offers real codes; anything else is a mistake, so it is refused
    at the boundary rather than stored.
    """
    found = (
        await session.execute(
            select(JournalEntry.id)
            .where(
                (JournalEntry.voucher_no == group_ref)
                | (JournalEntry.group_ref == group_ref)
            )
            .limit(1)
        )
    ).first()
    if found is None:
        raise Invalid(
            f"No journal entry is filed under {group_ref!r}. A journal code names the "
            "voucher its group is anchored on, so that voucher has to exist first."
        )


async def post_entry(
    session: AsyncSession,
    *,
    entry_date: date,
    memo: str,
    lines: list[LineIn],
    source: SourceIn,
    posted_by_id: uuid.UUID,
    project_id: uuid.UUID | None = None,
    series: str | None = None,
    group_ref: str | None = None,
    applied_to: list[uuid.UUID] | None = None,
    reversal_of_id: uuid.UUID | None = None,
) -> JournalEntry:
    """Validate, number and write one balanced entry, in the caller's transaction.

    Raises :class:`Invalid` for malformed input, :class:`Conflict` for a posting the books
    refuse (a header account, a deactivated account), :class:`PeriodClosed` for a date
    inside a closed period, and :class:`OutOfBalance` when debits do not equal credits.
    """
    memo = (memo or "").strip()
    if not memo:
        raise Invalid("An entry needs a memo. It is the only human description in the ledger.")

    group_ref = (group_ref or "").strip() or None
    if group_ref is not None:
        await _assert_group_exists(session, group_ref)

    normalised = _normalise(lines)
    _assert_balanced(normalised)

    accounts = await _load_accounts(session, [ln.account for ln in normalised])
    await _assert_postable(session, normalised, accounts)
    await _assert_period_open(session, entry_date)

    resolved_series = series or await _auto_series(session, normalised, accounts, source)

    entry = JournalEntry(
        entry_no=await next_document_no(session, "journal_entry"),
        entry_date=entry_date,
        memo=memo,
        project_id=project_id,
        series=resolved_series,
        voucher_no=await next_voucher_no(session, resolved_series, entry_date),
        source_kind=source.kind,
        source_ref=source.ref,
        group_ref=group_ref,
        source_due=source.due,
        source_document_date=source.document_date,
        source_vendor_id=source.vendor_id,
        source_settlement=source.settlement,
        reversal_of_id=reversal_of_id,
        posted_by_user_id=posted_by_id,
    )
    # Assigned through the relationship rather than added individually, so the collection
    # is populated on the returned object. Otherwise `entry.lines` is an unloaded lazy
    # attribute and touching it outside an await raises MissingGreenlet.
    entry.lines = [
        JournalLine(
            line_no=index,
            account_code=line.account,
            debit=line.debit,
            credit=line.credit,
            note=line.note,
        )
        for index, line in enumerate(normalised, start=1)
    ]
    session.add(entry)
    await session.flush()

    for settled_id in applied_to or []:
        if settled_id == entry.id:
            raise Invalid("An entry cannot settle itself.")
        target = await session.get(JournalEntry, settled_id)
        if target is None:
            raise NotFound(f"Cannot apply to entry {settled_id}: it does not exist.")
        session.add(
            EntryApplication(settling_entry_id=entry.id, settled_entry_id=settled_id)
        )

    await session.flush()
    return entry


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def _normalise(lines: list[LineIn]) -> list[LineIn]:
    """Quantise to two places and reject anything that is not one-sided and positive."""
    if len(lines) < 2:
        raise Invalid(
            f"An entry needs at least two lines; got {len(lines)}. Double entry means every "
            "posting has both a debit and a credit."
        )

    out: list[LineIn] = []
    for index, line in enumerate(lines, start=1):
        if not line.account:
            raise Invalid(f"Line {index}: an account code is required.")

        debit = money(line.debit or ZERO)
        credit = money(line.credit or ZERO)

        if debit < ZERO or credit < ZERO:
            raise Invalid(f"Line {index} ({line.account}): amounts cannot be negative.")
        if debit > ZERO and credit > ZERO:
            raise Invalid(
                f"Line {index} ({line.account}): a line carries a debit or a credit, "
                "never both. Split it into two lines."
            )
        if debit == ZERO and credit == ZERO:
            raise Invalid(f"Line {index} ({line.account}): a line must carry an amount.")

        out.append(LineIn(account=line.account, debit=debit, credit=credit, note=line.note))
    return out


def _assert_balanced(lines: list[LineIn]) -> None:
    """Exact. ``Decimal`` is exact arithmetic — there is no tolerance here.

    The prototype's one-rupiah ``EPSILON`` was a float guard and does not carry over. The
    *materiality* half of that constant is a separate business rule and lives in
    ``app.core.money``.
    """
    debit = sum((ln.debit for ln in lines), start=ZERO)
    credit = sum((ln.credit for ln in lines), start=ZERO)
    if debit != credit:
        raise OutOfBalance(
            f"Debits {debit} do not equal credits {credit} — out by {abs(debit - credit)}."
        )


async def _load_accounts(session: AsyncSession, codes: list[str]) -> dict[str, Account]:
    unique = sorted(set(codes))
    rows = (await session.execute(select(Account).where(Account.code.in_(unique)))).scalars().all()
    found = {a.code: a for a in rows}
    missing = [c for c in unique if c not in found]
    if missing:
        raise NotFound(f"Unknown account code(s): {', '.join(missing)}.")
    return found


async def _assert_postable(
    session: AsyncSession, lines: list[LineIn], accounts: dict[str, Account]
) -> None:
    """Refuse a header account or a deactivated one.

    A header is an account *with children*. Nothing new may post to it — but note that
    whatever posted to it before it had children stays exactly where it is, and rollups
    still count it. See ``Account`` for why.
    """
    codes = sorted({ln.account for ln in lines})

    parents = (
        (
            await session.execute(
                select(Account.parent_code)
                .where(Account.parent_code.in_(codes))
                .group_by(Account.parent_code)
            )
        )
        .scalars()
        .all()
    )
    headers = set(parents)

    for code in codes:
        if code in headers:
            raise Conflict(
                f"Account {code} ({accounts[code].name}) has sub-accounts, so it is a header "
                "and no longer accepts postings. Post to one of its sub-accounts instead."
            )
        if not accounts[code].active:
            raise Conflict(
                f"Account {code} ({accounts[code].name}) is deactivated and does not accept "
                "postings. Reactivate it, or choose another account."
            )


async def _assert_period_open(session: AsyncSession, on: date) -> None:
    period = (
        await session.execute(
            select(AccountingPeriod).where(
                AccountingPeriod.year == on.year,
                AccountingPeriod.month == on.month,
            )
        )
    ).scalar_one_or_none()

    if period is not None and period.status is PeriodStatus.CLOSED:
        raise PeriodClosed(
            f"{on.year}-{on.month:02d} is closed; nothing further can be dated inside it. "
            "Reopen the period, or date the entry in an open one."
        )


async def _auto_series(
    session: AsyncSession,
    lines: list[LineIn],
    accounts: dict[str, Account],
    source: SourceIn,
) -> str:
    cash_codes = set(
        (await session.execute(select(Account.code).where(Account.is_cash.is_(True))))
        .scalars()
        .all()
    )
    return pick_series(
        source_kind=source.kind,
        source_settlement=source.settlement,
        lines=[(ln.account, ln.debit, ln.credit) for ln in lines],
        accounts=accounts,
        cash_codes=cash_codes,
        asset_codes=set(FIXED_ASSET_CODES),
    )


# ---------------------------------------------------------------------------
# Reversal and adjustment
# ---------------------------------------------------------------------------


async def reverse_entry(
    session: AsyncSession,
    *,
    entry_id: uuid.UUID,
    posted_by_id: uuid.UUID,
    on: date | None = None,
    memo: str | None = None,
) -> JournalEntry:
    """Post the mirror image of an entry and stamp the original as reversed.

    Inherited ruling 1: journals are never edited or deleted. A correction is a reversal
    plus a fresh posting, so the original stays in the audit trail flagged with what
    cancelled it. The client asked for this in as many words — "eliminating the option of
    unilateral journal deletion to maintain audit trail integrity".

    The reversal gets its **own** voucher number; it does not reuse the original's.
    """
    original = await session.get(JournalEntry, entry_id)
    if original is None:
        raise NotFound(f"Journal entry {entry_id} does not exist.")
    if original.reversed_by_id is not None:
        raise Conflict(
            f"{original.entry_no} has already been reversed. Reversing it twice would "
            "double the correction."
        )
    if original.reversal_of_id is not None:
        raise Conflict(
            f"{original.entry_no} is itself a reversal. Reverse the entry it cancelled, or "
            "post a fresh correcting entry."
        )

    lines = (
        (
            await session.execute(
                select(JournalLine)
                .where(JournalLine.entry_id == entry_id)
                .order_by(JournalLine.line_no)
            )
        )
        .scalars()
        .all()
    )

    mirrored = [
        LineIn(account=ln.account_code, debit=ln.credit, credit=ln.debit, note=ln.note)
        for ln in lines
    ]

    reversal = await post_entry(
        session,
        entry_date=on or original.entry_date,
        memo=memo or f"Reversal of {original.entry_no} — {original.memo}",
        lines=mirrored,
        source=SourceIn(kind=SourceKind.REVERSAL, ref=original.entry_no),
        posted_by_id=posted_by_id,
        project_id=original.project_id,
        series="jv",
        # The correction joins the original's group rather than starting a new one. This is
        # the half that answers the client: one journal code to reconcile by, while each
        # document keeps its own number. An entry that was not already grouped becomes the
        # anchor of its own group, named by its voucher number.
        group_ref=original.group_ref or original.voucher_no,
        reversal_of_id=original.id,
    )

    # The single mutation the append-only trigger permits.
    original.reversed_by_id = reversal.id

    await session.flush()
    return reversal


async def adjust_entry(
    session: AsyncSession,
    *,
    entry_id: uuid.UUID,
    lines: list[LineIn],
    posted_by_id: uuid.UUID,
    memo: str | None = None,
    on: date | None = None,
    document_date: date | None = None,
) -> tuple[JournalEntry, JournalEntry]:
    """Reverse an entry and repost it with corrected figures.

    Returns ``(reversal, replacement)``. The net effect on the books is the difference
    only; the original stays, flagged. Re-adjusting an already-reversed entry is refused
    rather than silently compounding.
    """
    original = await session.get(JournalEntry, entry_id)
    if original is None:
        raise NotFound(f"Journal entry {entry_id} does not exist.")

    reversal = await reverse_entry(
        session,
        entry_id=entry_id,
        posted_by_id=posted_by_id,
        on=on,
        memo=f"Adjustment reversal of {original.entry_no}",
    )

    replacement = await post_entry(
        session,
        entry_date=on or original.entry_date,
        memo=memo or f"Adjustment of {original.entry_no} — {original.memo}",
        lines=lines,
        source=SourceIn(
            kind=SourceKind.ADJUSTMENT, ref=original.entry_no, document_date=document_date
        ),
        posted_by_id=posted_by_id,
        project_id=original.project_id,
        series="jv",
        # Same group as the reversal above. A reverse-and-repost is three filed documents
        # and one logical correction; this is what makes it reconcilable as the latter
        # without pretending it is a single entry.
        group_ref=reversal.group_ref,
    )
    return reversal, replacement


async def entry_totals(session: AsyncSession, entry_id: uuid.UUID) -> tuple[Decimal, Decimal]:
    row = (
        await session.execute(
            select(
                func.coalesce(func.sum(JournalLine.debit), 0),
                func.coalesce(func.sum(JournalLine.credit), 0),
            ).where(JournalLine.entry_id == entry_id)
        )
    ).one()
    return money(row[0]), money(row[1])
