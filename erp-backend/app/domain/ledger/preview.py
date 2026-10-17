"""Show what a posting *would* do, without doing it.

The client asked that a confirmation appear before an entry is posted rather than after, so
the operator can see the lines and stop. That is a preview, not a draft — nothing is stored,
and `07-open-questions.md` explains why a draft could not be: `journal_entries` is
append-only, enforced by a database trigger, so a half-finished entry has nowhere to live.

The preview is produced by **running the real operation and undoing it**, not by a second
implementation that computes the same lines. A parallel implementation is the thing to avoid
here: it would agree with the real one on the day it was written and drift silently after,
and the whole value of a confirmation dialog is that it shows what will actually happen.

Undoing is a SAVEPOINT rollback rather than a session rollback, and that distinction is
load-bearing twice over. In production a session rollback would discard anything else the
request had already done. Under test it is worse: the suite's session joins the fixture's
transaction with ``join_transaction_mode="create_savepoint"``, so a session rollback would
throw away the rows the test itself had set up, and the failure would look like missing
fixtures rather than a preview that reached too far.

What rolls back with it: the voucher number and the document sequence. A preview must not
burn a number — the entry it describes has not been filed.
"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import object_session

from app.core.money import ZERO, money
from app.domain.accounts.models import Account
from app.domain.ledger.models import JournalEntry
from app.domain.ledger.schemas import (
    PostingPreviewOut,
    PreviewEntryOut,
    PreviewLineOut,
)


@dataclass(frozen=True)
class PreviewLine:
    account: str
    account_name: str
    debit: Decimal
    credit: Decimal
    note: str | None


@dataclass(frozen=True)
class PreviewEntry:
    entry_date: date
    memo: str
    series: str
    voucher_preview: str
    project_id: uuid.UUID | None
    lines: list[PreviewLine]
    #: The date on the source document (receipt, vendor invoice); the posting date is
    #: `entry_date`. Defaulted so existing constructors keep working.
    source_document_date: date | None = None

    @property
    def total_debit(self) -> Decimal:
        return money(sum((line.debit for line in self.lines), start=ZERO))

    @property
    def total_credit(self) -> Decimal:
        return money(sum((line.credit for line in self.lines), start=ZERO))

    @property
    def balanced(self) -> bool:
        return self.total_debit == self.total_credit


async def dry_run(
    session: AsyncSession, run: Callable[[], Awaitable[Any]]
) -> list[PreviewEntry]:
    """Run an operation, describe every entry it posted, then undo all of it.

    Raises whatever the operation raises, and undoes the attempt first — so a preview of a
    posting the books refuse returns the same 409 the real call would, which is the point:
    the dialog should not offer a button that cannot work.
    """
    collected: list[JournalEntry] = []

    def _collect(mapper: Any, connection: Any, target: JournalEntry) -> None:
        # Mapper-level listeners are process-wide, so two concurrent dry runs would
        # otherwise each see the other's entries. The session identity is the filter.
        if object_session(target) is session.sync_session:
            collected.append(target)

    event.listen(JournalEntry, "after_insert", _collect)
    savepoint = await session.begin_nested()
    try:
        await run()
        # Read the values out while the savepoint is still open. After the rollback these
        # objects are expired, and touching an expired attribute would emit a SELECT for a
        # row that no longer exists.
        return [await _describe(session, entry) for entry in collected]
    finally:
        event.remove(JournalEntry, "after_insert", _collect)
        if savepoint.is_active:
            await savepoint.rollback()


async def _describe(session: AsyncSession, entry: JournalEntry) -> PreviewEntry:
    lines = await entry.awaitable_attrs.lines
    codes = {line.account_code for line in lines}
    rows = (
        await session.execute(
            select(Account.code, Account.name).where(Account.code.in_(codes))
        )
    ).all()
    names: dict[str, str] = {code: name for code, name in rows}
    return PreviewEntry(
        entry_date=entry.entry_date,
        memo=entry.memo,
        series=entry.series,
        # What it WOULD be numbered. The counter increment rolls back with everything else.
        voucher_preview=entry.voucher_no,
        project_id=entry.project_id,
        source_document_date=entry.source_document_date,
        lines=[
            PreviewLine(
                account=line.account_code,
                account_name=names.get(line.account_code, line.account_code),
                debit=line.debit,
                credit=line.credit,
                note=line.note,
            )
            for line in sorted(lines, key=lambda line: line.line_no)
        ],
    )


def as_preview_out(entries: list[PreviewEntry]) -> PostingPreviewOut:
    """The wire shape, with the totals the dialog puts under the lines."""
    debit = money(sum((entry.total_debit for entry in entries), start=ZERO))
    credit = money(sum((entry.total_credit for entry in entries), start=ZERO))
    return PostingPreviewOut(
        entries=[
            PreviewEntryOut(
                entry_date=entry.entry_date,
                memo=entry.memo,
                series=entry.series,
                voucher_preview=entry.voucher_preview,
                project_id=entry.project_id,
                source_document_date=entry.source_document_date,
                lines=[
                    PreviewLineOut(
                        account=line.account,
                        account_name=line.account_name,
                        debit=line.debit,
                        credit=line.credit,
                        note=line.note,
                    )
                    for line in entry.lines
                ],
                total_debit=entry.total_debit,
                total_credit=entry.total_credit,
                balanced=entry.balanced,
            )
            for entry in entries
        ],
        total_debit=debit,
        total_credit=credit,
        balanced=debit == credit,
    )
