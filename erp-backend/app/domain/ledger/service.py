"""Journal queries, voucher-series administration and period close."""

from __future__ import annotations

import uuid
from datetime import date

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict, Invalid, NotFound
from app.core.money import ZERO, money
from app.domain.ledger.models import (
    AccountingPeriod,
    JournalEntry,
    PeriodStatus,
    SourceKind,
    VoucherCounter,
    VoucherSeries,
)
from app.domain.ledger.numbering import format_voucher, period_key, validate_format
from app.domain.ledger.schemas import SeriesCreate, SeriesUpdate
from app.domain.masters.models import User

MAX_PAGE = 500


async def list_entries(
    session: AsyncSession,
    *,
    start: date | None = None,
    end: date | None = None,
    project_id: uuid.UUID | None = None,
    source_kind: SourceKind | None = None,
    series: str | None = None,
    group_ref: str | None = None,
    query: str | None = None,
    limit: int = 100,
    offset: int = 0,
) -> tuple[list[JournalEntry], int]:
    stmt = select(JournalEntry)
    count_stmt = select(func.count()).select_from(JournalEntry)

    def scope(s):  # type: ignore[no-untyped-def]
        if start is not None:
            s = s.where(JournalEntry.entry_date >= start)
        if end is not None:
            s = s.where(JournalEntry.entry_date <= end)
        if project_id is not None:
            s = s.where(JournalEntry.project_id == project_id)
        if source_kind is not None:
            s = s.where(JournalEntry.source_kind == source_kind)
        if series is not None:
            s = s.where(JournalEntry.series == series)
        if group_ref is not None:
            # The anchor entry is NAMED by the code rather than stamped with it: entries are
            # immutable, so the original cannot be updated when a correction later joins it.
            # Matching its voucher number too is what makes one code return the whole
            # document -- original plus every correction -- which is the client's ask.
            s = s.where(
                (JournalEntry.group_ref == group_ref)
                | (JournalEntry.voucher_no == group_ref)
            )
        if query:
            pattern = f"%{query.strip()}%"
            s = s.where(
                JournalEntry.memo.ilike(pattern)
                | JournalEntry.entry_no.ilike(pattern)
                | JournalEntry.voucher_no.ilike(pattern)
            )
        return s

    total = (await session.execute(scope(count_stmt))).scalar_one()
    rows = (
        (
            await session.execute(
                scope(stmt)
                .order_by(JournalEntry.entry_date.desc(), JournalEntry.entry_no.desc())
                .limit(min(limit, MAX_PAGE))
                .offset(offset)
            )
        )
        .scalars()
        .all()
    )
    return list(rows), total


async def get_entry(session: AsyncSession, entry_id: uuid.UUID) -> JournalEntry:
    entry = (
        await session.execute(select(JournalEntry).where(JournalEntry.id == entry_id))
    ).scalar_one_or_none()
    if entry is None:
        raise NotFound(f"No journal entry {entry_id}.")
    return entry


def entry_total(entry: JournalEntry):  # type: ignore[no-untyped-def]
    """Debit side of the entry — which equals the credit side, by construction."""
    return money(sum((line.debit for line in entry.lines), start=ZERO))


# ---------------------------------------------------------------------------
# Voucher series
# ---------------------------------------------------------------------------


async def create_series(session: AsyncSession, body: SeriesCreate) -> VoucherSeries:
    """Add a document-number series with the administrator's own prefix.

    The format is validated the same way an edit is: a format with no ``[SEQ_nnn]`` token
    would issue the same number forever, so it is refused here rather than discovered later.
    """
    key = body.key.strip().lower()
    if await session.get(VoucherSeries, key) is not None:
        raise Conflict(f"A voucher series keyed '{key}' already exists.")

    validate_format(body.format)
    if not body.prefix.strip():
        raise Invalid("A voucher prefix cannot be blank.")

    series = VoucherSeries(
        key=key,
        prefix=body.prefix.strip(),
        label=body.label.strip(),
        hint=body.hint,
        format=body.format,
        reset=body.reset,
    )
    session.add(series)
    await session.flush()
    return series


async def delete_series(session: AsyncSession, key: str) -> None:
    """Remove a series, unless something has been filed under it.

    Numbers already issued name their series, and a voucher number has to stay resolvable
    for as long as the entry does — so a series with entries against it is refused rather
    than leaving documents pointing at a definition that no longer exists.
    """
    series = await session.get(VoucherSeries, key)
    if series is None:
        raise NotFound(f"No voucher series keyed '{key}'.")

    used = (
        await session.execute(
            select(func.count()).select_from(JournalEntry).where(JournalEntry.series == key)
        )
    ).scalar_one()
    if used:
        raise Conflict(
            f"{used} journal entr{'y' if used == 1 else 'ies'} were numbered from "
            f"'{key}'. Deleting it would leave their voucher numbers unexplained."
        )

    # `voucher_counters.series_key` is a foreign key, so a counter row left behind would
    # turn this into an IntegrityError — a 500 where the operation is actually legitimate.
    # With no entries numbered from the series, its counters count nothing.
    await session.execute(
        delete(VoucherCounter).where(VoucherCounter.series_key == key)
    )
    await session.delete(series)
    await session.flush()


async def list_series(session: AsyncSession) -> list[VoucherSeries]:
    return list((await session.execute(select(VoucherSeries))).scalars().all())


async def get_series(session: AsyncSession, key: str) -> VoucherSeries:
    series = (
        await session.execute(select(VoucherSeries).where(VoucherSeries.key == key))
    ).scalar_one_or_none()
    if series is None:
        raise NotFound(f"No voucher series {key!r}.")
    return series


async def update_series(
    session: AsyncSession, key: str, patch: SeriesUpdate
) -> VoucherSeries:
    """Change a series' prefix, label, format or reset cadence.

    Numbers already issued are **never** rewritten — they live on immutable entries, so the
    property holds for free. A format without a ``[SEQ_nnn]`` token is refused, since it
    would issue the same number forever.
    """
    series = await get_series(session, key)
    data = patch.model_dump(exclude_unset=True)

    if "format" in data and data["format"] is not None:
        validate_format(data["format"])
    if "prefix" in data and data["prefix"] is not None and not data["prefix"].strip():
        raise Invalid("A voucher prefix cannot be blank.")

    for field, value in data.items():
        setattr(series, field, value)
    await session.flush()
    return series


async def preview_series(session: AsyncSession, key: str, on: date) -> str:
    """What this series would produce next for a given date."""
    series = await get_series(session, key)
    counter = (
        await session.execute(
            select(VoucherCounter).where(
                VoucherCounter.series_key == key,
                VoucherCounter.period_key == period_key(series.reset, on),
            )
        )
    ).scalar_one_or_none()
    return format_voucher(series, on, counter.next_value if counter else 1)


# ---------------------------------------------------------------------------
# Periods
# ---------------------------------------------------------------------------


async def list_periods(session: AsyncSession) -> list[AccountingPeriod]:
    return list(
        (
            await session.execute(
                select(AccountingPeriod).order_by(
                    AccountingPeriod.year.desc(), AccountingPeriod.month.desc()
                )
            )
        )
        .scalars()
        .all()
    )


async def _period(session: AsyncSession, year: int, month: int) -> AccountingPeriod | None:
    return (
        await session.execute(
            select(AccountingPeriod).where(
                AccountingPeriod.year == year, AccountingPeriod.month == month
            )
        )
    ).scalar_one_or_none()


async def close_period(
    session: AsyncSession, year: int, month: int, *, by: User
) -> AccountingPeriod:
    """Refuse any further entry dated inside this month.

    Note what closing does **not** do: it posts no closing entry rolling income into
    retained earnings. The balance sheet balances by picking up NPAT as a derived equity
    row, which works only while income accounts still carry their balances. A real
    year-end close changes the statement logic too — parked as Q2 in the open questions.
    """
    if not 1 <= month <= 12:
        raise Invalid(f"{month} is not a month.")

    period = await _period(session, year, month)
    if period is None:
        period = AccountingPeriod(year=year, month=month)
        session.add(period)

    if period.status is PeriodStatus.CLOSED:
        raise Conflict(f"{year}-{month:02d} is already closed.")

    from app.core.clock import get_clock

    period.status = PeriodStatus.CLOSED
    period.closed_at = get_clock().now()
    period.closed_by_id = by.id
    await session.flush()
    return period


async def reopen_period(session: AsyncSession, year: int, month: int) -> AccountingPeriod:
    """Reopening is permitted, and deliberately leaves a trace of having been closed."""
    period = await _period(session, year, month)
    if period is None:
        raise NotFound(f"No accounting period {year}-{month:02d}.")
    if period.status is PeriodStatus.OPEN:
        raise Conflict(f"{year}-{month:02d} is already open.")

    period.status = PeriodStatus.OPEN
    period.closed_at = None
    period.closed_by_id = None
    await session.flush()
    return period
