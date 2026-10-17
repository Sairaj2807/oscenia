"""Document and voucher numbering.

Ported from ``erp-frontend/src/lib/vouchers.js``, with one substantive change: counters
are allocated under ``SELECT … FOR UPDATE`` instead of being derived from a list length, so
two finance users posting at the same moment cannot mint the same ``KM-09-04-001``.

A voucher number is **not** the entry id:

* ``entry_no`` (``JE-1042``) is the immutable internal key. Applications, reversals and
  source links reference it; renumbering would break every link.
* ``voucher_no`` (``KM-05-10-001``) is the human, auditable document number printed on the
  voucher and quoted in the filing cabinet. It is what the administrator configures.

Already-issued numbers are never rewritten when a format changes. That falls out for free:
``voucher_no`` is stored on the entry, and the entry is immutable.
"""

from __future__ import annotations

import re
from datetime import date
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Invalid
from app.domain.accounts.models import Account, AccountType
from app.domain.ledger.models import (
    DocumentSequence,
    ResetCadence,
    SourceKind,
    VoucherCounter,
    VoucherSeries,
)

MONTHS = ("JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC")

SEQ_TOKEN = re.compile(r"\[SEQ_(\d+)\]")


# ---------------------------------------------------------------------------
# Formatting
# ---------------------------------------------------------------------------


def format_voucher(series: VoucherSeries, on: date, seq: int) -> str:
    """Expand a series format for a date and sequence number.

    Tokens: ``[PREFIX] [YEAR] [YY] [MONTH] [MON] [DATE] [SEQ_001]``. Anything else passes
    through verbatim, so the client's own example works as written::

        REVENUE - [MONTH] - [DATE] - [SEQ_001]   ->   REVENUE - 08 - 14 - 001

    The digit count inside the SEQ token declares the pad width: ``[SEQ_00001]`` pads to 5.
    """
    out = series.format
    out = out.replace("[PREFIX]", series.prefix)
    out = out.replace("[YEAR]", f"{on.year:04d}")
    out = out.replace("[YY]", f"{on.year % 100:02d}")
    out = out.replace("[MONTH]", f"{on.month:02d}")
    out = out.replace("[MON]", MONTHS[on.month - 1])
    out = out.replace("[DATE]", f"{on.day:02d}")
    return SEQ_TOKEN.sub(lambda m: str(seq).zfill(len(m.group(1))), out)


def validate_format(fmt: str) -> None:
    """A format without a sequence token would issue the same number forever."""
    if not SEQ_TOKEN.search(fmt):
        raise Invalid(
            "A voucher format must contain a [SEQ_nnn] token, for example "
            "[PREFIX]-[MONTH]-[DATE]-[SEQ_001]. Without it every voucher would carry the "
            "same number."
        )


def period_key(reset: ResetCadence, on: date) -> str:
    """Which counter bucket a date falls into, given the series' reset cadence."""
    if reset is ResetCadence.NEVER:
        return "all"
    if reset is ResetCadence.YEARLY:
        return f"{on.year:04d}"
    if reset is ResetCadence.DAILY:
        return on.isoformat()
    return f"{on.year:04d}-{on.month:02d}"


# ---------------------------------------------------------------------------
# Auto-classification
# ---------------------------------------------------------------------------


def pick_series(
    *,
    source_kind: SourceKind,
    source_settlement: bool,
    lines: list[tuple[str, Decimal, Decimal]],
    accounts: dict[str, Account],
    cash_codes: set[str],
    asset_codes: set[str],
) -> str:
    """Choose the document class for an entry.

    An explicit series on the posting always wins; this is the fallback, so that entries
    posted by operational actions that know nothing about voucher series still land in the
    right class.

    ``lines`` are ``(account_code, debit, credit)`` triples.
    """
    if source_kind in (
        SourceKind.REVERSAL,
        SourceKind.ADJUSTMENT,
        SourceKind.OPENING,
        SourceKind.MANUAL,
    ):
        return "jv"

    if source_kind is SourceKind.DEPRECIATION:
        return "fa"

    # A cash-advance settlement is a reimbursement whichever way the money moves — that is
    # the whole point of the RM class.
    if source_kind is SourceKind.PETTYCASH and source_settlement:
        return "rm"

    net_cash = sum(
        (debit - credit for code, debit, credit in lines if code in cash_codes),
        start=Decimal(0),
    )
    if net_cash > 0:
        return "km"
    if net_cash < 0:
        return "kk"

    # No cash moved, so this is an accrual. Fixed-asset movements get their own class;
    # otherwise revenue recognition versus a bill received.
    if any(code in asset_codes for code, _, _ in lines):
        return "fa"
    if any(
        (acct := accounts.get(code)) is not None and acct.type == AccountType.REVENUE
        for code, _, _ in lines
    ):
        return "rev"
    return "exp"


# ---------------------------------------------------------------------------
# Allocation
# ---------------------------------------------------------------------------


async def next_document_no(session: AsyncSession, key: str) -> str:
    """Allocate the next document number for a sequence, e.g. ``JE-1042``.

    Locks the counter row for the rest of the transaction, so concurrent posters queue
    rather than collide.
    """
    seq = (
        await session.execute(
            select(DocumentSequence).where(DocumentSequence.key == key).with_for_update()
        )
    ).scalar_one_or_none()

    if seq is None:
        raise Invalid(f"Unknown document sequence {key!r}. Seed it in app/seed/chart.py.")

    value = seq.next_value
    seq.next_value = value + 1
    await session.flush()
    return f"{seq.prefix}-{str(value).zfill(seq.pad)}"


async def next_voucher_no(session: AsyncSession, series_key: str, on: date) -> str:
    """Allocate the next voucher number for a series on a date.

    Same row-lock discipline as ``next_document_no``. The counter row is created on first
    use for the period, which is why the insert is guarded by the same lock.
    """
    series = (
        await session.execute(select(VoucherSeries).where(VoucherSeries.key == series_key))
    ).scalar_one_or_none()
    if series is None:
        raise Invalid(f"Unknown voucher series {series_key!r}.")

    key = period_key(series.reset, on)

    # Create-then-lock, not check-then-create. Two postings that are both the first of a
    # period would otherwise both see no row, both insert, and one would die on the primary
    # key. ON CONFLICT DO NOTHING makes the create idempotent; the SELECT ... FOR UPDATE
    # that follows is what actually serialises the increment.
    await session.execute(
        pg_insert(VoucherCounter)
        .values(series_key=series_key, period_key=key, next_value=1)
        .on_conflict_do_nothing(index_elements=["series_key", "period_key"])
    )

    counter = (
        await session.execute(
            select(VoucherCounter)
            .where(
                VoucherCounter.series_key == series_key,
                VoucherCounter.period_key == key,
            )
            .with_for_update()
        )
    ).scalar_one()

    value = counter.next_value
    counter.next_value = value + 1
    await session.flush()

    return format_voucher(series, on, value)
