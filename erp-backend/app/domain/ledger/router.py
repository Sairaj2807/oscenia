"""Journal, voucher-series and period endpoints.

Note what is **absent**: there is no ``PUT``, ``PATCH`` or ``DELETE`` on a journal entry.
That is the feature, not an omission. A posted entry is corrected by reversing it and
reposting, so the original stays in the audit trail — the client asked for exactly this,
and database triggers enforce it even against raw SQL.
"""

from __future__ import annotations

import uuid
from datetime import date

from fastapi import APIRouter, Query, status

from app.core.deps import CurrentUser, EditsTax, PostsJournal
from app.core.schemas import Page
from app.db.session import SessionDep
from app.domain.accounts.models import Side
from app.domain.ledger import service
from app.domain.ledger.models import SourceKind
from app.domain.ledger.posting import LineIn as PostLine
from app.domain.ledger.posting import SourceIn as PostSource
from app.domain.ledger.posting import adjust_entry, post_entry, reverse_entry
from app.domain.ledger.schemas import (
    AdjustRequest,
    EntryCreate,
    EntryDetail,
    EntryOut,
    OpenItemOut,
    PeriodOut,
    ReverseRequest,
    SeriesCreate,
    SeriesOut,
    SeriesUpdate,
)
from app.domain.reports.queries import linked_entries, open_items

router = APIRouter(tags=["ledger"])


async def _to_out(entry) -> EntryOut:  # type: ignore[no-untyped-def]
    """Serialise one entry, loading its collections explicitly.

    Async on purpose, and the reason is worth keeping: `lines` and `applications` are
    declared `lazy="selectin"`, which loads them eagerly when an entry is **queried** — so
    the list and get endpoints were always fine. But this function is also called on entries
    that were just **created**, where nothing was queried and `session.add()` leaves a
    `viewonly` collection absent. Touching it then is a lazy load with no greenlet context,
    which under asyncio raises `MissingGreenlet` rather than loading.

    That is exactly what happened: adding `applied_to` here for the frontend's open-items
    logic turned every posting endpoint into a 500, and took 111 tests with it. Awaiting the
    attribute costs nothing when it is already loaded, and making the function `async` means
    a future call site cannot quietly reintroduce the bug — it will not compile past `await`.
    """
    lines = await entry.awaitable_attrs.lines
    applications = await entry.awaitable_attrs.applications
    return EntryOut.model_validate(
        {
            **{c.name: getattr(entry, c.name) for c in entry.__table__.columns},
            "lines": lines,
            "applied_to": [a.settled_entry_id for a in applications],
            "total": service.entry_total(entry),
        }
    )


# ---------------------------------------------------------------------------
# Journal
# ---------------------------------------------------------------------------


@router.get("/journal-entries", response_model=Page[EntryOut])
async def list_entries(
    session: SessionDep,
    user: CurrentUser,
    start: date | None = None,
    end: date | None = None,
    project_id: uuid.UUID | None = None,
    source_kind: SourceKind | None = None,
    series: str | None = None,
    group_ref: str | None = Query(
        default=None, description="Every entry filed under one journal code"
    ),
    q: str | None = Query(default=None, description="Matches memo, entry no or voucher no"),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> Page[EntryOut]:
    entries, total = await service.list_entries(
        session,
        start=start,
        end=end,
        project_id=project_id,
        source_kind=source_kind,
        series=series,
        group_ref=group_ref,
        query=q,
        limit=limit,
        offset=offset,
    )
    items = [await _to_out(e) for e in entries]
    return Page(items=items, total=total)


@router.get("/journal-entries/{entry_id}", response_model=EntryDetail)
async def get_entry(
    session: SessionDep, user: CurrentUser, entry_id: uuid.UUID
) -> EntryDetail:
    """One entry, with both halves of its linked-document chain."""
    entry = await service.get_entry(session, entry_id)
    settles, settled_by = await linked_entries(session, entry_id)
    return EntryDetail.model_validate(
        {
            **(await _to_out(entry)).model_dump(),
            "settles": settles,
            "settled_by": settled_by,
        }
    )


@router.post(
    "/journal-entries", response_model=EntryOut, status_code=status.HTTP_201_CREATED
)
async def create_entry(
    session: SessionDep, user: PostsJournal, body: EntryCreate
) -> EntryOut:
    """Post one balanced entry.

    The server validates balance, refuses header and deactivated accounts and closed
    periods, and mints both the entry number and the voucher number. None of those are
    accepted from the request.
    """
    entry = await post_entry(
        session,
        entry_date=body.entry_date,
        memo=body.memo,
        lines=[
            PostLine(account=ln.account, debit=ln.debit, credit=ln.credit, note=ln.note)
            for ln in body.lines
        ],
        source=PostSource(
            kind=body.source.kind,
            ref=body.source.ref,
            due=body.source.due,
            document_date=body.source.document_date,
            vendor_id=body.source.vendor_id,
            settlement=body.source.settlement,
        ),
        posted_by_id=user.id,
        project_id=body.project_id,
        series=body.series,
        group_ref=body.group_ref,
        applied_to=body.applied_to,
    )
    return await _to_out(entry)


@router.post("/journal-entries/{entry_id}/reverse", response_model=EntryOut)
async def reverse(
    session: SessionDep,
    user: PostsJournal,
    entry_id: uuid.UUID,
    body: ReverseRequest | None = None,
) -> EntryOut:
    """Post the mirror image and stamp the original as reversed.

    The reversal gets its own voucher number; it does not reuse the original's.
    """
    body = body or ReverseRequest()
    reversal = await reverse_entry(
        session,
        entry_id=entry_id,
        posted_by_id=user.id,
        on=body.entry_date,
        memo=body.memo,
    )
    return await _to_out(reversal)


@router.post("/journal-entries/{entry_id}/adjust", response_model=list[EntryOut])
async def adjust(
    session: SessionDep, user: PostsJournal, entry_id: uuid.UUID, body: AdjustRequest
) -> list[EntryOut]:
    """Reverse and repost with corrected figures.

    Returns ``[reversal, replacement]``. The original stays in the ledger, flagged; the net
    effect on the books is the difference only.
    """
    reversal, replacement = await adjust_entry(
        session,
        entry_id=entry_id,
        lines=[
            PostLine(account=ln.account, debit=ln.debit, credit=ln.credit, note=ln.note)
            for ln in body.lines
        ],
        posted_by_id=user.id,
        memo=body.memo,
        on=body.entry_date,
        document_date=body.document_date,
    )
    return [await _to_out(reversal), await _to_out(replacement)]


@router.get("/open-items", response_model=list[OpenItemOut])
async def list_open_items(
    session: SessionDep,
    user: CurrentUser,
    control: str = Query(description="Control account: 1201 for AR, 2102 for AP"),
    side: Side = Query(default=Side.DEBIT, description="The side that OPENS an item"),
    as_of: date | None = None,
) -> list[OpenItemOut]:
    """Documents still awaiting settlement — this is what AR and AP are made of."""
    items = await open_items(session, control=control, side=side, as_of=as_of)
    return [OpenItemOut.model_validate(i) for i in items]


# ---------------------------------------------------------------------------
# Voucher series
# ---------------------------------------------------------------------------


@router.get("/voucher-series", response_model=list[SeriesOut])
async def list_series(session: SessionDep, user: CurrentUser) -> list[SeriesOut]:
    series = await service.list_series(session)
    return [SeriesOut.model_validate(s) for s in series]


@router.post(
    "/voucher-series", response_model=SeriesOut, status_code=status.HTTP_201_CREATED
)
async def create_series(
    session: SessionDep, user: EditsTax, body: SeriesCreate, on: date | None = None
) -> SeriesOut:
    """Create a series with a custom prefix or code.

    The client asked to define their own; the seven seeded ones were fixed. Returns the
    series with a preview of the next number it would issue, so the format can be checked
    before anything is filed under it.
    """
    from app.core.clock import get_clock

    created = await service.create_series(session, body)
    preview = await service.preview_series(session, created.key, on or get_clock().today())
    return SeriesOut.model_validate({**{
        c.name: getattr(created, c.name) for c in created.__table__.columns
    }, "next_preview": preview})


@router.delete("/voucher-series/{key}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_series(session: SessionDep, user: EditsTax, key: str) -> None:
    """Remove a series. **409 if anything has been numbered from it.**"""
    await service.delete_series(session, key)


@router.patch("/voucher-series/{key}", response_model=SeriesOut)
async def update_series(
    session: SessionDep, user: EditsTax, key: str, patch: SeriesUpdate, on: date | None = None
) -> SeriesOut:
    """Edit a series' prefix, format or reset cadence.

    A format lacking a ``[SEQ_nnn]`` token is refused — it would issue the same number
    forever. Numbers already issued are never rewritten.
    """
    from app.core.clock import get_clock

    updated = await service.update_series(session, key, patch)
    preview = await service.preview_series(session, key, on or get_clock().today())
    return SeriesOut.model_validate({**{
        c.name: getattr(updated, c.name) for c in updated.__table__.columns
    }, "next_preview": preview})


@router.get("/voucher-series/{key}/preview", response_model=SeriesOut)
async def preview_series(
    session: SessionDep, user: CurrentUser, key: str, on: date | None = None
) -> SeriesOut:
    from app.core.clock import get_clock

    series = await service.get_series(session, key)
    preview = await service.preview_series(session, key, on or get_clock().today())
    return SeriesOut.model_validate({**{
        c.name: getattr(series, c.name) for c in series.__table__.columns
    }, "next_preview": preview})


# ---------------------------------------------------------------------------
# Periods
# ---------------------------------------------------------------------------


@router.get("/periods", response_model=list[PeriodOut])
async def list_periods(session: SessionDep, user: CurrentUser) -> list[PeriodOut]:
    return [PeriodOut.model_validate(p) for p in await service.list_periods(session)]


@router.post("/periods/{year}/{month}/close", response_model=PeriodOut)
async def close_period(
    session: SessionDep, user: PostsJournal, year: int, month: int
) -> PeriodOut:
    """Nothing further can be dated inside a closed period."""
    return PeriodOut.model_validate(
        await service.close_period(session, year, month, by=user)
    )


@router.post("/periods/{year}/{month}/reopen", response_model=PeriodOut)
async def reopen_period(
    session: SessionDep, user: PostsJournal, year: int, month: int
) -> PeriodOut:
    return PeriodOut.model_validate(await service.reopen_period(session, year, month))
