"""Fixed-asset register, depreciation schedule and runs, and warehouse movements."""

from __future__ import annotations

import uuid
from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, Request, UploadFile, status
from sqlalchemy import select
from starlette.responses import Response

from app.core.clock import ClockDep
from app.core.deps import CurrentUser, require_action
from app.core.errors import Invalid, NotFound
from app.core.money import ZERO, money
from app.core.rbac import can_see
from app.core.storage import get_storage
from app.db.session import SessionDep
from app.domain.assets import delivery, service
from app.domain.assets.models import AssetStatus, DeliveryOrder, FixedAsset, InventoryItem
from app.domain.assets.schedule import build_schedule, due_periods, net_book_value
from app.domain.assets.schemas import (
    AssetCreate,
    AssetOut,
    AssetRevise,
    BacklogOut,
    CheckOutRequest,
    DeliveryOrderCreate,
    DeliveryOrderOut,
    DepreciationRunRequest,
    DisposeRequest,
    ItemCreate,
    ItemOut,
    ItemUpdate,
    MovementOut,
    RegisterOut,
    ReleaseRequest,
    ReturnRequest,
    RunResultOut,
    ScheduleRowOut,
)
from app.domain.audit.service import record_audit
from app.domain.ledger.models import JournalEntry
from app.domain.ledger.numbering import next_document_no
from app.domain.masters.models import User

ManagesAssets = Annotated[User, Depends(require_action("manage_assets"))]
ManagesStock = Annotated[User, Depends(require_action("manage_stock"))]
ManagesDo = Annotated[User, Depends(require_action("manage_do"))]
AddsStock = Annotated[User, Depends(require_action("add_stock"))]

router = APIRouter(tags=["fixed assets"])


def _asset_out(asset: FixedAsset, *, as_of: date) -> AssetOut:
    terms = service.terms_of(asset)
    rows = due_periods(terms, as_of=as_of)
    return AssetOut.model_validate(
        {
            **{c.name: getattr(asset, c.name) for c in FixedAsset.__table__.columns},
            "net_book_value": net_book_value(terms),
            "due": money(sum((r.charge for r in rows), start=ZERO)),
            "overdue_periods": len(rows),
        }
    )


def _item_out(item: InventoryItem) -> ItemOut:
    return ItemOut.model_validate(
        {
            **{c.name: getattr(item, c.name) for c in InventoryItem.__table__.columns},
            "total_value": money(money(item.qty) * money(item.unit_value)),
        }
    )


def _movement_out(item: InventoryItem, entry: JournalEntry | None) -> MovementOut:
    return MovementOut(
        item=_item_out(item),
        entry_id=entry.id if entry is not None else None,
        voucher_no=entry.voucher_no if entry is not None else None,
    )


# ---------------------------------------------------------------------------
# Register
# ---------------------------------------------------------------------------


@router.get("/fixed-assets", response_model=list[AssetOut])
async def list_assets(
    session: SessionDep,
    clock: ClockDep,
    user: CurrentUser,
    asset_status: AssetStatus | None = None,
    as_of: date | None = None,
) -> list[AssetOut]:
    on = as_of or clock.today()
    stmt = select(FixedAsset).order_by(FixedAsset.asset_no)
    if asset_status is not None:
        stmt = stmt.where(FixedAsset.status == asset_status)
    rows = (await session.execute(stmt)).scalars().all()
    return [_asset_out(row, as_of=on) for row in rows]


@router.get("/fixed-assets/register", response_model=RegisterOut)
async def register(
    session: SessionDep, clock: ClockDep, user: CurrentUser, as_of: date | None = None
) -> RegisterOut:
    """Register totals beside what the ledger holds.

    Both are reported. The register is a sub-ledger, and where it disagrees with 1302/1303
    the screen says so rather than quietly preferring one of them.
    """
    totals = await service.register_totals(session, as_of=as_of or clock.today())
    return RegisterOut.model_validate(totals)


@router.post("/fixed-assets", response_model=AssetOut, status_code=status.HTTP_201_CREATED)
async def capitalise(
    session: SessionDep, clock: ClockDep, user: ManagesAssets, body: AssetCreate
) -> AssetOut:
    """Put an asset on the register.

    ``post: false`` registers equipment the books already carry without posting anything —
    the seeded warehouse kit sits inside the opening 1302 balance, and capitalising it again
    would double-count it.
    """
    asset = await service.capitalise(
        session,
        name=body.name,
        acquired_on=body.acquired_on,
        cost=body.cost,
        useful_life_months=body.useful_life_months,
        user=user,
        salvage=body.salvage,
        method=body.method,
        category=body.category,
        inventory_item_id=body.inventory_item_id,
        post=body.post,
        pay_from=body.pay_from,
    )
    return _asset_out(asset, as_of=clock.today())


@router.get("/fixed-assets/{asset_id}", response_model=AssetOut)
async def get_asset(
    session: SessionDep, clock: ClockDep, user: CurrentUser, asset_id: uuid.UUID
) -> AssetOut:
    return _asset_out(await service.get_asset(session, asset_id), as_of=clock.today())


@router.patch("/fixed-assets/{asset_id}", response_model=AssetOut)
async def revise_asset(
    session: SessionDep,
    clock: ClockDep,
    user: ManagesAssets,
    asset_id: uuid.UUID,
    body: AssetRevise,
) -> AssetOut:
    """Revise a useful life or method. **Prospective** — posted charges are never restated."""
    patch = body.model_dump(exclude_unset=True, exclude_none=True)
    if not patch:
        raise Invalid("Nothing to revise.")
    asset = await service.revise(session, asset_id, patch)
    return _asset_out(asset, as_of=clock.today())


@router.get("/fixed-assets/{asset_id}/schedule", response_model=list[ScheduleRowOut])
async def schedule(
    session: SessionDep,
    clock: ClockDep,
    user: CurrentUser,
    asset_id: uuid.UUID,
    as_of: date | None = None,
) -> list[ScheduleRowOut]:
    """The whole remaining life, one row per month.

    A projection, not draft journal entries. Writing sixty unposted entries into the journal
    would mean every balance query, both statements and the trial balance had to learn to
    exclude them — and one missed filter reports depreciation that has not happened.
    """
    asset = await service.get_asset(session, asset_id)
    rows = build_schedule(service.terms_of(asset), as_of=as_of or clock.today())
    return [ScheduleRowOut.model_validate(row) for row in rows]


@router.post("/fixed-assets/{asset_id}/dispose", response_model=AssetOut)
async def dispose_asset(
    session: SessionDep,
    clock: ClockDep,
    user: ManagesAssets,
    asset_id: uuid.UUID,
    body: DisposeRequest,
) -> AssetOut:
    """Remove an asset at cost, returning its accumulated depreciation with it.

    A disposal above book value is a gain and below it a loss; both land in 6901, signed.
    """
    await service.dispose(
        session,
        asset_id,
        proceeds=body.proceeds,
        user=user,
        on=body.disposed_on or clock.today(),
    )
    return _asset_out(await service.get_asset(session, asset_id), as_of=clock.today())


# ---------------------------------------------------------------------------
# Depreciation
# ---------------------------------------------------------------------------


@router.get("/depreciation/backlog", response_model=BacklogOut)
async def backlog(
    session: SessionDep, clock: ClockDep, user: CurrentUser, as_of: date | None = None
) -> BacklogOut:
    """Periods that have fallen due and have not been posted."""
    on = as_of or clock.today()
    periods = await service.backlog_periods(session, as_of=on)
    total = ZERO
    for period in periods:
        for charge in await service.charges_for(session, period, as_of=on):
            total += charge.row.charge
    return BacklogOut(periods=periods, total=money(total))


@router.post("/depreciation/run", response_model=RunResultOut)
async def run_depreciation(
    session: SessionDep, clock: ClockDep, user: ManagesAssets, body: DepreciationRunRequest
) -> RunResultOut:
    """Post depreciation — one named period, or the whole backlog oldest-first.

    **Idempotent.** Running twice posts nothing the second time: every asset's
    ``posted_through`` has moved past the period, so nothing reports as due.
    """
    on = clock.today()
    if body.period is not None:
        entry = await service.run_period(session, body.period, user=user, as_of=on)
        entries = [entry] if entry is not None else []
    else:
        entries = await service.run_backlog(session, user=user, as_of=on)

    total = ZERO
    for entry in entries:
        total += money(sum((line.debit for line in entry.lines), start=ZERO))

    return RunResultOut(
        periods=[e.source_ref for e in entries if e.source_ref is not None],
        entry_ids=[e.id for e in entries],
        total=money(total),
        posted=len(entries),
    )


# ---------------------------------------------------------------------------
# Warehouse
# ---------------------------------------------------------------------------


@router.get("/inventory", response_model=list[ItemOut])
async def list_inventory(
    session: SessionDep, user: CurrentUser, include_archived: bool = False
) -> list[ItemOut]:
    stmt = select(InventoryItem).order_by(InventoryItem.item_no)
    if not include_archived:
        stmt = stmt.where(InventoryItem.archived_at.is_(None))
    rows = (await session.execute(stmt)).scalars().all()
    return [_item_out(row) for row in rows]


@router.post("/inventory", response_model=ItemOut, status_code=status.HTTP_201_CREATED)
async def add_item(session: SessionDep, user: AddsStock, body: ItemCreate) -> ItemOut:
    item = InventoryItem(
        item_no=await next_document_no(session, "inventory"),
        item=body.item,
        type=body.type,
        qty=body.qty,
        unit=body.unit,
        unit_value=body.unit_value,
    )
    session.add(item)
    await session.flush()
    return _item_out(item)


@router.patch("/inventory/{item_id}", response_model=ItemOut)
async def edit_item(
    session: SessionDep, user: ManagesStock, item_id: uuid.UUID, body: ItemUpdate, request: Request
) -> ItemOut:
    """Rename an item or change its unit; its value and type only while it has no history.

    Quantity cannot be set here. The ledger holds the value of what is in stock, so quantity moves
    only through a release, a check-out or a return, each of which posts what it should.
    """
    # An explicit null clears a unit; for every other field it just means "leave it".
    changes = {
        k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None or k == "unit"
    }
    item, before, after = await service.update_item(session, item_id, changes=changes)
    await record_audit(
        session, actor=user, action="inventory.edit", entity_type="inventory_item",
        entity_id=item.id, before=before, after=after, request=request,
    )  # fmt: skip
    return _item_out(item)


@router.post("/inventory/{item_id}/archive", response_model=ItemOut)
async def archive_item(
    session: SessionDep, clock: ClockDep, user: ManagesStock, item_id: uuid.UUID, request: Request
) -> ItemOut:
    """Retire an item from the warehouse list. Its history and ledger entries stay."""
    item = await service.archive_item(session, item_id, now=clock.now())
    await record_audit(
        session, actor=user, action="inventory.archive", entity_type="inventory_item",
        entity_id=item.id, detail={"item_no": item.item_no}, request=request,
    )  # fmt: skip
    return _item_out(item)


@router.post("/inventory/{item_id}/unarchive", response_model=ItemOut)
async def unarchive_item(
    session: SessionDep, user: ManagesStock, item_id: uuid.UUID, request: Request
) -> ItemOut:
    item = await service.unarchive_item(session, item_id)
    await record_audit(
        session, actor=user, action="inventory.unarchive", entity_type="inventory_item",
        entity_id=item.id, detail={"item_no": item.item_no}, request=request,
    )  # fmt: skip
    return _item_out(item)


@router.delete("/inventory/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_item(
    session: SessionDep, user: ManagesStock, item_id: uuid.UUID, request: Request
) -> Response:
    """Delete an item that was never used. Anything with history is archived, not deleted."""
    item = await service.delete_item(session, item_id)
    await record_audit(
        session, actor=user, action="inventory.delete", entity_type="inventory_item",
        entity_id=item_id, detail={"item_no": item.item_no, "item": item.item}, request=request,
    )  # fmt: skip
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/inventory/{item_id}/release", response_model=MovementOut)
async def release(
    session: SessionDep,
    clock: ClockDep,
    user: ManagesStock,
    item_id: uuid.UUID,
    body: ReleaseRequest,
) -> MovementOut:
    """Issue consumables to a project. They do not come back, so stock drops permanently."""
    entry = await service.release_consumable(
        session,
        item_id,
        qty=body.qty,
        project_id=body.project_id,
        user=user,
        on=body.released_on or clock.today(),
    )
    return _movement_out(await service.get_item(session, item_id), entry)


@router.post("/inventory/{item_id}/check-out", response_model=MovementOut)
async def check_out(
    session: SessionDep,
    user: ManagesStock,
    item_id: uuid.UUID,
    body: CheckOutRequest,
) -> MovementOut:
    """Send fixed-asset kit out to a venue.

    Posts nothing — equipment on a truck is still the company's equipment. What it does is
    make the item findable by the in-transit return check, which has nothing to look at
    until something is actually in transit.
    """
    item = await service.check_out(
        session, item_id, project_id=body.project_id, event_date=body.event_date
    )
    return _movement_out(item, None)


@router.post("/inventory/{item_id}/return", response_model=MovementOut)
async def check_in(
    session: SessionDep,
    clock: ClockDep,
    user: ManagesStock,
    item_id: uuid.UUID,
    body: ReturnRequest,
) -> MovementOut:
    """Check kit back in. Only lost stock reaches the ledger; damage goes to maintenance."""
    entry = await service.return_stock(
        session,
        item_id,
        condition=body.condition,
        lost_qty=body.lost_qty,
        damaged_qty=body.damaged_qty,
        project_id=body.project_id,
        user=user,
        on=body.returned_on or clock.today(),
    )
    return _movement_out(await service.get_item(session, item_id), entry)


@router.post("/inventory/{item_id}/repair", response_model=MovementOut)
async def repair(session: SessionDep, user: ManagesStock, item_id: uuid.UUID) -> MovementOut:
    """Return repaired kit to stock. Posts nothing — no value has left the business."""
    return _movement_out(await service.repair(session, item_id), None)


@router.post("/inventory/{item_id}/condemn", response_model=MovementOut)
async def condemn(
    session: SessionDep, clock: ClockDep, user: ManagesStock, item_id: uuid.UUID
) -> MovementOut:
    """Write off kit beyond economic repair.

    If it is on the fixed-asset register, its share of accumulated depreciation comes back
    with it and only the remaining book value is a loss.
    """
    entry = await service.condemn(session, item_id, user=user, on=clock.today())
    return _movement_out(await service.get_item(session, item_id), entry)


# ---------------------------------------------------------------------------
# Delivery orders
# ---------------------------------------------------------------------------


@router.get("/delivery-orders", response_model=list[DeliveryOrderOut])
async def list_delivery_orders(session: SessionDep, user: CurrentUser) -> list[DeliveryOrderOut]:
    return [DeliveryOrderOut.model_validate(o) for o in await delivery.list_orders(session)]


@router.post(
    "/delivery-orders", response_model=DeliveryOrderOut, status_code=status.HTTP_201_CREATED
)
async def create_delivery_order(
    session: SessionDep, user: ManagesDo, body: DeliveryOrderCreate
) -> DeliveryOrderOut:
    """Draft a delivery order for an event. A document: it does not move stock."""
    order = await delivery.create_order(
        session,
        user=user,
        project_id=body.project_id,
        event_date=body.event_date,
        lines=body.lines,
    )
    return DeliveryOrderOut.model_validate(order)


@router.post("/delivery-orders/{order_id}/advance", response_model=DeliveryOrderOut)
async def advance_delivery_order(
    session: SessionDep, clock: ClockDep, user: ManagesDo, order_id: uuid.UUID, request: Request
) -> DeliveryOrderOut:
    """Draft -> Dispatched -> Received. Dispatch needs the recipient's signature on file, unless
    the company setting ``allow_unsigned_dispatch`` is on."""
    order = await delivery.advance(session, order_id, on=clock.today())
    await record_audit(
        session, actor=user, action="delivery_order.advance", entity_type="delivery_order",
        entity_id=order.id, after={"status": order.status.value, "signed": order.signed},
        request=request,
    )  # fmt: skip
    return DeliveryOrderOut.model_validate(order)


@router.put("/delivery-orders/{order_id}/signature", response_model=DeliveryOrderOut)
async def sign_delivery_order(
    session: SessionDep,
    clock: ClockDep,
    user: ManagesDo,
    order_id: uuid.UUID,
    request: Request,
    signed_by_name: str = Form(max_length=120),
    file: UploadFile = File(...),
) -> DeliveryOrderOut:
    """Attach the recipient's drawn signature (a PNG from the signature pad) to a draft order."""
    order = await delivery.sign(
        session, order_id, file=file, signed_by_name=signed_by_name, now=clock.now()
    )
    await record_audit(
        session, actor=user, action="delivery_order.sign", entity_type="delivery_order",
        entity_id=order.id, detail={"signed_by": order.signed_by_name}, request=request,
    )  # fmt: skip
    return DeliveryOrderOut.model_validate(order)


@router.get("/delivery-orders/{order_id}/signature")
async def delivery_order_signature(
    session: SessionDep, user: CurrentUser, order_id: uuid.UUID
) -> Response:
    """The signature picture, for the delivery-order PDF. Only roles that see the warehouse get it;
    anyone else is told there is none, the same as for an order that is unsigned."""
    order = await session.get(DeliveryOrder, order_id)
    if order is None or order.signature_key is None or not can_see(user.role, "warehouse"):
        raise NotFound("There is no signature for that delivery order.")
    handle = get_storage().open(order.signature_key)
    try:
        body = handle.read()
    finally:
        handle.close()
    return Response(
        content=body, media_type="image/png", headers={"Cache-Control": "private, no-store"}
    )
