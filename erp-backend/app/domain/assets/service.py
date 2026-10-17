"""Fixed assets, warehouse movements and the register's tie-out to the ledger.

The depreciation run is the most idempotency-sensitive operation in the system. It posts
**one entry per period with a line per asset** — thirty-six separate entries for six assets
over six months would bury every other transaction in the journal — and a partial unique
index on ``(source_kind, source_ref)`` makes a second call for the same period impossible
rather than merely unlikely.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict, Invalid, NotFound
from app.core.money import ZERO, money
from app.domain.assets.models import (
    AssetStatus,
    DeliveryOrder,
    DeliveryOrderLine,
    DeliveryStatus,
    FixedAsset,
    InventoryItem,
    InventoryStatus,
    InventoryType,
    Method,
    ReturnCondition,
)
from app.domain.assets.schedule import (
    AssetTerms,
    Period,
    RowState,
    ScheduleRow,
    add_months,
    build_schedule,
    due_periods,
    net_book_value,
    period_end,
    period_of,
)
from app.domain.ledger.models import JournalEntry, SourceKind
from app.domain.ledger.numbering import next_document_no
from app.domain.ledger.posting import LineIn, SourceIn, post_entry
from app.domain.masters.models import User
from app.domain.reports.queries import account_balance

COST = "1302"
ACCUMULATED = "1303"
CONSUMABLES = "1301"
DEPRECIATION_EXPENSE = "6103"
ASSET_LOSS = "6901"
CONSUMABLE_COGS = "5104"
MAIN_BANK = "1101"


def terms_of(asset: FixedAsset) -> AssetTerms:
    return AssetTerms(
        acquired_on=asset.acquired_on,
        cost=asset.cost,
        salvage=asset.salvage,
        useful_life_months=asset.useful_life_months,
        method=str(asset.method),
        posted_through=asset.posted_through,
        posted_accumulated=asset.posted_accumulated,
        schedule_from=asset.schedule_from,
        opening_accumulated=asset.opening_accumulated,
        disposed=asset.status is AssetStatus.DISPOSED,
    )


async def get_asset(session: AsyncSession, asset_id: uuid.UUID) -> FixedAsset:
    asset = await session.get(FixedAsset, asset_id)
    if asset is None:
        raise NotFound(f"No fixed asset {asset_id}.")
    return asset


async def live_assets(session: AsyncSession) -> list[FixedAsset]:
    rows = await session.execute(
        select(FixedAsset)
        .where(FixedAsset.status == AssetStatus.ACTIVE)
        .order_by(FixedAsset.asset_no)
    )
    return list(rows.scalars().all())


# ---------------------------------------------------------------------------
# Capitalisation
# ---------------------------------------------------------------------------


async def capitalise(
    session: AsyncSession,
    *,
    name: str,
    acquired_on: date,
    cost: Decimal,
    useful_life_months: int,
    user: User,
    salvage: Decimal = ZERO,
    method: Method = Method.STRAIGHT_LINE,
    category: str | None = None,
    inventory_item_id: uuid.UUID | None = None,
    post: bool = True,
    pay_from: str = MAIN_BANK,
) -> FixedAsset:
    """Put an asset on the register, posting the acquisition unless it is already carried.

    ``post=False`` is for kit the books already hold — the seeded warehouse equipment sits
    inside the opening 1302 balance, and capitalising it again would double-count 640 million
    rupiah. It records the asset and posts nothing, which is exactly the client's
    "already carried in 1302" case.
    """
    name = (name or "").strip()
    if not name:
        raise Invalid("The asset needs a name.")
    cost = money(cost)
    salvage = money(salvage)
    if cost <= ZERO:
        raise Invalid("Acquisition cost must be greater than zero.")
    if salvage < ZERO:
        raise Invalid("Salvage value cannot be negative.")
    if salvage >= cost:
        raise Invalid("Salvage value must be less than cost, or there is nothing to depreciate.")
    if useful_life_months <= 0:
        raise Invalid("Useful life must be at least one month.")

    asset = FixedAsset(
        asset_no=await next_document_no(session, "fixed_asset"),
        name=name,
        category=category,
        inventory_item_id=inventory_item_id,
        acquired_on=acquired_on,
        cost=cost,
        salvage=salvage,
        useful_life_months=useful_life_months,
        method=method,
    )
    session.add(asset)
    await session.flush()

    if post:
        await post_entry(
            session,
            entry_date=acquired_on,
            memo=f"Fixed asset acquired — {name}",
            lines=[
                LineIn(COST, debit=cost, note=f"{asset.asset_no} · {name}"),
                LineIn(pay_from, credit=cost, note="Acquisition settled"),
            ],
            source=SourceIn(kind=SourceKind.DEPRECIATION, ref=asset.asset_no),
            posted_by_id=user.id,
        )

    return asset


#: Columns the register owns and the ledger evidences. Patching any of them would put the
#: register out of step with 1302/1303 with nothing posted to explain the difference.
SEALED = frozenset({"cost", "posted_through", "posted_accumulated", "asset_no", "status"})


async def revise(
    session: AsyncSession, asset_id: uuid.UUID, patch: dict[str, object]
) -> FixedAsset:
    """Revise an estimate. **Prospective, never retrospective.**

    Periods already posted keep the charges they were posted at. The schedule rebases to the
    first unposted period, carrying the ledger's accumulated figure forward, and what is left
    to depreciate spreads over the life that remains. Extending a useful life retrospectively
    would lower every past charge and the register would stop agreeing with account 1303.
    """
    asset = await get_asset(session, asset_id)
    if asset.status is AssetStatus.DISPOSED:
        raise Conflict(f"{asset.asset_no} is disposed. A disposed asset is not revised.")

    sealed = SEALED & patch.keys()
    if sealed:
        raise Invalid(
            f"{', '.join(sorted(sealed))} cannot be changed. Cost is evidenced by the "
            "acquisition entry, and the posted figures are the ledger's own record."
        )

    life = patch.get("useful_life_months", asset.useful_life_months)
    method = patch.get("method", asset.method)
    revising = life != asset.useful_life_months or method != asset.method

    for field, value in patch.items():
        setattr(asset, field, value)

    if money(asset.salvage) >= money(asset.cost):
        raise Invalid("Salvage value must be less than cost, or there is nothing to depreciate.")
    if asset.useful_life_months <= 0:
        raise Invalid("Useful life must be at least one month.")

    if revising and asset.posted_through is not None:
        asset.schedule_from = add_months(asset.posted_through, 1)
        asset.opening_accumulated = money(asset.posted_accumulated)

    await session.flush()
    return asset


# ---------------------------------------------------------------------------
# Depreciation
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Charge:
    asset: FixedAsset
    row: ScheduleRow


async def charges_for(session: AsyncSession, period: Period, *, as_of: date) -> list[Charge]:
    charges: list[Charge] = []
    for asset in await live_assets(session):
        for row in due_periods(terms_of(asset), as_of=as_of):
            if row.period == period and row.charge > ZERO:
                charges.append(Charge(asset=asset, row=row))
                break
    return charges


async def backlog_periods(session: AsyncSession, *, as_of: date) -> list[Period]:
    """Every distinct period owed across the register, **oldest first**.

    Order matters: posting the newest period first would advance ``posted_through`` past the
    older ones, and they would never be charged at all.
    """
    periods: set[Period] = set()
    for asset in await live_assets(session):
        periods.update(row.period for row in due_periods(terms_of(asset), as_of=as_of))
    return sorted(periods)


async def run_period(
    session: AsyncSession, period: Period, *, user: User, as_of: date
) -> JournalEntry | None:
    """Post one period's depreciation across every asset that owes it.

    Returns ``None`` when nothing is due — running an up-to-date register is a no-op, not an
    error. A second call for the same period posts nothing: ``posted_through`` means no asset
    reports the period as due any more, and the partial unique index on
    ``(source_kind, source_ref)`` would refuse the entry even if one did.
    """
    charges = await charges_for(session, period, as_of=as_of)
    if not charges:
        return None

    total = money(sum((c.row.charge for c in charges), start=ZERO))
    lines = [
        LineIn(
            DEPRECIATION_EXPENSE,
            debit=c.row.charge,
            note=f"{c.asset.asset_no} · {c.asset.name}",
        )
        for c in charges
    ]
    lines.append(
        LineIn(
            ACCUMULATED,
            credit=total,
            note=f"Accumulated depreciation · {len(charges)} asset(s)",
        )
    )

    entry = await post_entry(
        session,
        entry_date=period_end(period),
        memo=f"Depreciation — {period}",
        lines=lines,
        source=SourceIn(kind=SourceKind.DEPRECIATION, ref=period),
        posted_by_id=user.id,
    )

    for charge in charges:
        # `posted_accumulated` is the register's copy of what 1303 now holds for this asset.
        # Storing it rather than re-deriving it from the schedule is what stops a later
        # revision from restating depreciation that has already been posted.
        charge.asset.posted_through = period
        charge.asset.posted_accumulated = money(charge.asset.posted_accumulated) + charge.row.charge

    await session.flush()
    return entry


async def run_backlog(session: AsyncSession, *, user: User, as_of: date) -> list[JournalEntry]:
    """Clear the backlog, oldest period first.

    This is the operation that answers the client's "eliminates the risk of missing monthly
    fixed asset depreciation bookkeeping".
    """
    posted: list[JournalEntry] = []
    for period in await backlog_periods(session, as_of=as_of):
        entry = await run_period(session, period, user=user, as_of=as_of)
        if entry is not None:
            posted.append(entry)
    return posted


# ---------------------------------------------------------------------------
# Disposal
# ---------------------------------------------------------------------------


async def dispose(
    session: AsyncSession,
    asset_id: uuid.UUID,
    *,
    proceeds: Decimal = ZERO,
    user: User,
    on: date,
) -> JournalEntry:
    """Remove an asset at cost, returning its accumulated depreciation with it.

    ``loss = net book value − proceeds``. A disposal above book value is a gain and below it
    a loss; both land in 6901, signed. A separate gain account would be one more line on the
    statement for no extra clarity.
    """
    asset = await get_asset(session, asset_id)
    if asset.status is AssetStatus.DISPOSED:
        raise Conflict(f"{asset.asset_no} has already been disposed.")

    cash = money(proceeds)
    if cash < ZERO:
        raise Invalid("Disposal proceeds cannot be negative.")

    accumulated = money(asset.posted_accumulated)
    nbv = net_book_value(terms_of(asset))
    loss = nbv - cash

    lines: list[LineIn] = []
    if cash > ZERO:
        lines.append(LineIn(MAIN_BANK, debit=cash, note="Disposal proceeds"))
    if accumulated > ZERO:
        lines.append(
            LineIn(ACCUMULATED, debit=accumulated, note="Accumulated depreciation removed")
        )
    if loss != ZERO:
        lines.append(
            LineIn(
                ASSET_LOSS,
                debit=max(ZERO, loss),
                credit=max(ZERO, -loss),
                note="Loss on disposal" if loss > ZERO else "Gain on disposal",
            )
        )
    lines.append(LineIn(COST, credit=asset.cost, note=f"{asset.asset_no} removed at cost"))

    entry = await post_entry(
        session,
        entry_date=on,
        memo=f"Fixed asset disposed — {asset.name}",
        lines=lines,
        source=SourceIn(kind=SourceKind.DEPRECIATION, ref=f"{asset.asset_no}-DISPOSAL"),
        posted_by_id=user.id,
    )

    asset.status = AssetStatus.DISPOSED
    asset.disposed_at = on
    asset.proceeds = cash
    await session.flush()
    return entry


# ---------------------------------------------------------------------------
# The register, and its tie-out
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class RegisterTotals:
    count: int
    cost: Decimal
    accumulated: Decimal
    net_book_value: Decimal
    due: Decimal
    overdue_periods: int
    monthly: Decimal

    #: What the ledger says, for the screen's reconciliation badge. The register is a
    #: sub-ledger; where the two disagree the screen shows both rather than quietly
    #: preferring one.
    ledger_cost: Decimal
    ledger_accumulated: Decimal
    ledger_net_book_value: Decimal
    reconciled: bool


async def register_totals(session: AsyncSession, *, as_of: date) -> RegisterTotals:
    assets = await live_assets(session)

    cost = money(sum((money(a.cost) for a in assets), start=ZERO))
    accumulated = money(sum((money(a.posted_accumulated) for a in assets), start=ZERO))

    due = ZERO
    overdue = 0
    monthly = ZERO
    for asset in assets:
        terms = terms_of(asset)
        rows = due_periods(terms, as_of=as_of)
        due += money(sum((r.charge for r in rows), start=ZERO))
        overdue += len(rows)
        upcoming = next(
            (r for r in build_schedule(terms, as_of=as_of) if r.state is not RowState.POSTED),
            None,
        )
        monthly += upcoming.charge if upcoming is not None else ZERO

    ledger_cost = await account_balance(session, COST)
    # 1303 is a contra asset and carries a credit balance, so it arrives negative and the
    # addition below is correct as written.
    ledger_accum = await account_balance(session, ACCUMULATED)

    return RegisterTotals(
        count=len(assets),
        cost=cost,
        accumulated=accumulated,
        net_book_value=cost - accumulated,
        due=money(due),
        overdue_periods=overdue,
        monthly=money(monthly),
        ledger_cost=ledger_cost,
        ledger_accumulated=ledger_accum,
        ledger_net_book_value=ledger_cost + ledger_accum,
        reconciled=(cost - accumulated) == (ledger_cost + ledger_accum),
    )


# ---------------------------------------------------------------------------
# Warehouse — the three movements that reach the ledger
# ---------------------------------------------------------------------------


async def get_item(session: AsyncSession, item_id: uuid.UUID) -> InventoryItem:
    item = await session.get(InventoryItem, item_id)
    if item is None:
        raise NotFound(f"No inventory item {item_id}.")
    return item


def _require_live(item: InventoryItem) -> None:
    if item.archived_at is not None:
        raise Conflict(f"{item.item} is archived. Restore it before moving it.")


async def history_of(session: AsyncSession, item: InventoryItem) -> list[str]:
    """What this item has been part of, as short reasons; empty when it has never been used.

    Ledger entries (a release, a write-off) reference it by number; a fixed-asset record or a
    delivery order line references it by key; anything not sitting in stock has been moved. Any
    one of these locks its value and type, and stops it being deleted rather than archived.
    """
    reasons: list[str] = []
    entries = (
        await session.execute(
            select(func.count())
            .select_from(JournalEntry)
            .where(
                JournalEntry.source_kind == SourceKind.WAREHOUSE,
                JournalEntry.source_ref == item.item_no,
            )
        )
    ).scalar_one()
    if entries:
        reasons.append(f"{entries} ledger entr{'y' if entries == 1 else 'ies'}")
    if (
        await session.execute(
            select(FixedAsset.id).where(FixedAsset.inventory_item_id == item.id).limit(1)
        )
    ).first():
        reasons.append("a fixed-asset record")
    if (
        await session.execute(
            select(DeliveryOrderLine.id)
            .where(DeliveryOrderLine.inventory_item_id == item.id)
            .limit(1)
        )
    ).first():
        reasons.append("a delivery order")
    if item.status is not InventoryStatus.IN_STOCK or item.project_id is not None:
        reasons.append(f"movement ({item.status.value})")
    return reasons


async def update_item(
    session: AsyncSession, item_id: uuid.UUID, *, changes: dict[str, object]
) -> tuple[InventoryItem, dict[str, object], dict[str, object]]:
    """Edit a stock item's name and unit; its value and type only while it has no history.

    Returns the item with the before and after of what changed, for the audit log. Quantity is not
    editable here at all: the ledger holds the value of what is in stock, so a quantity changes only
    through a movement that posts.
    """
    item = await get_item(session, item_id)
    _require_live(item)
    before: dict[str, object] = {}
    after: dict[str, object] = {}

    locked = [k for k in ("unit_value", "type") if k in changes and changes[k] != getattr(item, k)]
    if locked:
        reasons = await history_of(session, item)
        if reasons:
            raise Conflict(
                f"{item.item} has {', '.join(reasons)}, so its "
                f"{' and '.join(k.replace('_', ' ') for k in locked)} can no longer be changed."
            )
    for key, value in changes.items():
        current = getattr(item, key)
        if key == "unit" and value == "":
            value = None
        if value == current:
            continue
        before[key] = str(current) if current is not None else None
        after[key] = str(value) if value is not None else None
        setattr(item, key, value)
    await session.flush()
    # Read back what the database stored (a value comes back to two decimals, not as typed).
    await session.refresh(item)
    return item, before, after


async def archive_item(
    session: AsyncSession, item_id: uuid.UUID, *, now: datetime
) -> InventoryItem:
    item = await get_item(session, item_id)
    if item.archived_at is not None:
        return item
    if item.status not in (InventoryStatus.IN_STOCK, InventoryStatus.WRITTEN_OFF):
        state = item.status.value.replace("_", " ")
        raise Conflict(f"{item.item} is {state}; finish that before archiving it.")
    open_order = (
        await session.execute(
            select(DeliveryOrder.do_no)
            .join(DeliveryOrderLine, DeliveryOrderLine.delivery_order_id == DeliveryOrder.id)
            .where(
                DeliveryOrderLine.inventory_item_id == item.id,
                DeliveryOrder.status != DeliveryStatus.RECEIVED,
            )
            .limit(1)
        )
    ).first()
    if open_order is not None:
        raise Conflict(f"{item.item} is on {open_order[0]}, which is not received yet.")
    item.archived_at = now
    await session.flush()
    return item


async def unarchive_item(session: AsyncSession, item_id: uuid.UUID) -> InventoryItem:
    item = await get_item(session, item_id)
    item.archived_at = None
    await session.flush()
    return item


async def delete_item(session: AsyncSession, item_id: uuid.UUID) -> InventoryItem:
    """Delete an item that has never been used; anything with history is archived instead."""
    item = await get_item(session, item_id)
    reasons = await history_of(session, item)
    if reasons:
        raise Conflict(
            f"{item.item} has {', '.join(reasons)}, so it cannot be deleted. Archive it instead."
        )
    await session.delete(item)
    await session.flush()
    return item


async def _write_down_registered_asset(
    session: AsyncSession, inventory_item_id: uuid.UUID, cost_removed: Decimal, *, on: date
) -> Decimal:
    """Shrink a registered asset when some of its physical units are destroyed.

    Returns the share of accumulated depreciation that goes with them, so the caller posts
    only the **remaining book value** as a loss. Expensing the full cost would overstate the
    loss on any asset part-way through its life and leave the register claiming equipment the
    ledger has removed.
    """
    row = await session.execute(
        select(FixedAsset).where(
            FixedAsset.inventory_item_id == inventory_item_id,
            FixedAsset.status == AssetStatus.ACTIVE,
        )
    )
    asset = row.scalars().first()
    if asset is None or money(asset.cost) <= ZERO:
        return ZERO

    share = min(Decimal(1), money(cost_removed) / money(asset.cost))
    accum_share = money(money(asset.posted_accumulated) * share)
    salvage_share = money(money(asset.salvage) * share)
    remaining_cost = max(ZERO, money(asset.cost) - money(cost_removed))

    if remaining_cost <= ZERO:
        # Nothing left means the asset is gone, not merely smaller. The whole of its
        # accumulated depreciation comes back with it.
        accum_share = money(asset.posted_accumulated)
        asset.status = AssetStatus.DISPOSED
        asset.disposed_at = asset.disposed_at or on
    else:
        asset.cost = remaining_cost
        asset.salvage = max(ZERO, money(asset.salvage) - salvage_share)
        asset.posted_accumulated = max(ZERO, money(asset.posted_accumulated) - accum_share)
        # Rebase, so the smaller asset spreads what is left over the life that remains
        # rather than keeping the old, larger monthly charge.
        if asset.posted_through is not None:
            asset.schedule_from = add_months(asset.posted_through, 1)
        asset.opening_accumulated = money(asset.posted_accumulated)

    await session.flush()
    return accum_share


async def release_consumable(
    session: AsyncSession,
    item_id: uuid.UUID,
    *,
    qty: Decimal,
    project_id: uuid.UUID | None,
    user: User,
    on: date,
) -> JournalEntry | None:
    """Issue consumables to a project. **They do not come back.**

    Stock is reduced and the value expensed in one step rather than routing through an
    in-transit state, which is the half of the "dual-logic warehouse" the prototype promised
    in its own subtitle but never made operable.
    """
    item = await get_item(session, item_id)
    _require_live(item)
    if item.type is not InventoryType.CONSUMABLE:
        raise Conflict(f"{item.item} is a fixed asset. Fixed assets are checked out, not released.")

    amount = money(qty)
    if amount <= ZERO:
        raise Invalid("Release a positive quantity.")
    if amount > money(item.qty):
        raise Invalid(f"Only {item.qty} {item.unit or 'units'} of {item.item} are in stock.")

    item.qty = money(item.qty) - amount
    value = money(amount * money(item.unit_value))
    await session.flush()

    if value <= ZERO:
        return None

    return await post_entry(
        session,
        entry_date=on,
        memo=f"Consumables released — {item.item} ({amount} {item.unit or ''})".strip(),
        lines=[
            LineIn(CONSUMABLE_COGS, debit=value, note="Consumables issued to site"),
            LineIn(CONSUMABLES, credit=value, note="Stock permanently reduced"),
        ],
        source=SourceIn(kind=SourceKind.WAREHOUSE, ref=item.item_no),
        posted_by_id=user.id,
        project_id=project_id,
    )


async def return_stock(
    session: AsyncSession,
    item_id: uuid.UUID,
    *,
    condition: ReturnCondition,
    lost_qty: Decimal = ZERO,
    damaged_qty: Decimal = ZERO,
    project_id: uuid.UUID | None,
    user: User,
    on: date,
) -> JournalEntry | None:
    """Check kit back in from a venue. See :func:`check_out` for the other half.

    Only lost stock reaches the ledger. Damaged kit goes to maintenance, where it is either
    repaired back into stock or condemned — and condemning it posts the write-off then.
    """
    return await _return_stock(
        session,
        item_id,
        condition=condition,
        lost_qty=lost_qty,
        damaged_qty=damaged_qty,
        project_id=project_id,
        user=user,
        on=on,
    )


async def check_out(
    session: AsyncSession,
    item_id: uuid.UUID,
    *,
    project_id: uuid.UUID,
    event_date: date,
) -> InventoryItem:
    """Send fixed-asset kit out to a venue.

    **Posts nothing** — equipment on a truck is still the company's equipment, and moving it
    is not a transaction. What this does is make the item *findable*: the in-transit return
    check has nothing to look at until something is actually in transit, and without this
    half of the pair that job could never fire.

    Consumables have no check-out. They are released and never come back — see
    :func:`release_consumable`.
    """
    item = await get_item(session, item_id)
    _require_live(item)
    if item.type is InventoryType.CONSUMABLE:
        raise Conflict(
            f"{item.item} is a consumable. Consumables are released, not checked out — "
            "they do not come back."
        )
    if item.status is not InventoryStatus.IN_STOCK:
        raise Conflict(f"{item.item} is {item.status.value}, so it cannot go out.")

    item.status = InventoryStatus.IN_TRANSIT
    item.project_id = project_id
    item.event_date = event_date
    await session.flush()
    return item


async def _return_stock(
    session: AsyncSession,
    item_id: uuid.UUID,
    *,
    condition: ReturnCondition,
    lost_qty: Decimal = ZERO,
    damaged_qty: Decimal = ZERO,
    project_id: uuid.UUID | None,
    user: User,
    on: date,
) -> JournalEntry | None:
    """Check kit back in from a venue.

    Only lost stock reaches the ledger. Damaged kit goes to maintenance, where it is either
    repaired back into stock or condemned — and condemning it posts the write-off then.
    """
    item = await get_item(session, item_id)
    lost = money(lost_qty)
    if lost < ZERO:
        raise Invalid("Lost quantity cannot be negative.")
    damaged = money(damaged_qty)
    if damaged < ZERO:
        raise Invalid("Damaged quantity cannot be negative.")
    if lost + damaged > money(item.qty):
        raise Invalid(f"Only {item.qty} {item.unit or 'units'} went out.")

    item.status = (
        InventoryStatus.MAINTENANCE
        if condition is ReturnCondition.DAMAGED
        else InventoryStatus.IN_STOCK
    )
    item.project_id = None
    # Cleared so a returned item cannot look overdue to the in-transit check on a later run.
    item.event_date = None

    # A mixed return: what came back good stays on this row, and the damaged part becomes its own
    # row in maintenance (the prototype splits the quantity the same way). If everything that came
    # back is damaged, the row itself goes to maintenance.
    came_back = money(item.qty) - lost
    remaining = came_back
    if damaged > ZERO:
        if damaged >= came_back:
            item.status = InventoryStatus.MAINTENANCE
        else:
            session.add(
                InventoryItem(
                    item_no=await next_document_no(session, "inventory"),
                    item=item.item,
                    type=item.type,
                    qty=damaged,
                    unit=item.unit,
                    unit_value=item.unit_value,
                    status=InventoryStatus.MAINTENANCE,
                )
            )
            remaining = came_back - damaged

    if lost <= ZERO:
        item.qty = remaining
        await session.flush()
        return None

    item.qty = remaining
    if remaining <= ZERO:
        item.status = InventoryStatus.WRITTEN_OFF  # all of it was lost: nothing left to stock
    loss_value = money(lost * money(item.unit_value))
    await session.flush()

    if loss_value <= ZERO:
        return None

    return await _post_write_off(
        session,
        item,
        value=loss_value,
        memo=f"Asset write-off — {item.item} ({lost} {item.unit or ''})".strip(),
        note="Net book value lost on return",
        project_id=project_id,
        user=user,
        on=on,
    )


async def condemn(
    session: AsyncSession, item_id: uuid.UUID, *, user: User, on: date
) -> JournalEntry | None:
    """Write off kit that came back damaged and cannot be repaired.

    The prototype's check-in could route items *into* maintenance but never out again, so
    anything damaged was stranded there.
    """
    item = await get_item(session, item_id)
    if item.status is not InventoryStatus.MAINTENANCE:
        raise Conflict(f"{item.item} is not in maintenance.")

    value = money(money(item.qty) * money(item.unit_value))
    item.status = InventoryStatus.WRITTEN_OFF
    await session.flush()

    if value <= ZERO:
        return None

    return await _post_write_off(
        session,
        item,
        value=value,
        memo=f"Condemned after repair attempt — {item.item} ({item.qty} {item.unit or ''})".strip(),
        note="Beyond economic repair",
        project_id=None,
        user=user,
        on=on,
    )


async def repair(session: AsyncSession, item_id: uuid.UUID) -> InventoryItem:
    """Return repaired kit to stock. Posts nothing — no value has left the business."""
    item = await get_item(session, item_id)
    if item.status is not InventoryStatus.MAINTENANCE:
        raise Conflict(f"{item.item} is not in maintenance.")
    item.status = InventoryStatus.IN_STOCK
    await session.flush()
    return item


async def _post_write_off(
    session: AsyncSession,
    item: InventoryItem,
    *,
    value: Decimal,
    memo: str,
    note: str,
    project_id: uuid.UUID | None,
    user: User,
    on: date,
) -> JournalEntry:
    """The shared write-off posting, returning the register's share of 1303 alongside.

    If this stock is on the fixed-asset register, part of its cost has already been
    depreciated — so the write-off removes that share of accumulated depreciation too and
    only the remaining book value is a loss. Expensing the full cost overstates the loss on
    any asset part-way through its life and leaves the register claiming equipment the ledger
    has removed.
    """
    asset_account = CONSUMABLES if item.type is InventoryType.CONSUMABLE else COST

    accum_share = ZERO
    if item.type is InventoryType.FIXED_ASSET:
        accum_share = await _write_down_registered_asset(session, item.id, value, on=on)
    book_loss = value - accum_share

    lines: list[LineIn] = []
    if book_loss > ZERO:
        lines.append(LineIn(ASSET_LOSS, debit=book_loss, note=note))
    if accum_share > ZERO:
        lines.append(
            LineIn(
                ACCUMULATED,
                debit=accum_share,
                note="Accumulated depreciation removed with the asset",
            )
        )
    lines.append(LineIn(asset_account, credit=value, note="Asset removed from stock at cost"))

    return await post_entry(
        session,
        entry_date=on,
        memo=memo,
        lines=lines,
        source=SourceIn(kind=SourceKind.WAREHOUSE, ref=item.item_no),
        posted_by_id=user.id,
        project_id=project_id,
    )


__all__ = [
    "Charge",
    "RegisterTotals",
    "backlog_periods",
    "capitalise",
    "charges_for",
    "check_out",
    "condemn",
    "dispose",
    "get_asset",
    "get_item",
    "live_assets",
    "period_of",
    "register_totals",
    "release_consumable",
    "repair",
    "return_stock",
    "revise",
    "run_backlog",
    "run_period",
    "terms_of",
]
