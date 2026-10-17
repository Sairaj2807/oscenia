"""Accounts Payable endpoints."""

from __future__ import annotations

import uuid
from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, status
from sqlalchemy import select

from app.core.clock import ClockDep
from app.core.deps import CurrentUser, require_action, require_module
from app.core.errors import Conflict, Invalid, NotFound, PermissionDenied
from app.core.money import ZERO
from app.core.rbac import can_do
from app.db.session import SessionDep
from app.domain.accounts.models import Side
from app.domain.ap import service, vendor_lifecycle
from app.domain.ap.models import (
    DELIVERY_STATUSES,
    VENDOR_FILE_KINDS,
    CatalogueItem,
    PoStatus,
    PurchaseOrder,
    PurchaseOrderLine,
    Tag,
    Vendor,
    VendorAttachment,
    VendorStageHistory,
)
from app.domain.ap.schemas import (
    AvailabilityOut,
    BillOut,
    BucketOut,
    CatalogueItemCreate,
    CatalogueItemOut,
    CatalogueItemUpdate,
    CheckIn,
    ChecklistItemOut,
    DeliveryIn,
    PayablesAgeingOut,
    PaymentOut,
    PayRequest,
    PoSettleRequest,
    PostingLineOut,
    PurchaseOrderCreate,
    PurchaseOrderOut,
    StageHistoryOut,
    StageIn,
    TagCreate,
    TagOut,
    TagUpdate,
    VendorCreate,
    VendorFileIn,
    VendorFileOut,
    VendorLifecycleOut,
    VendorOut,
    VendorUpdate,
)
from app.domain.audit.service import record_audit
from app.domain.cash import service as cash_service
from app.domain.cash.models import Attachment
from app.domain.ledger.models import JournalEntry
from app.domain.ledger.numbering import next_document_no
from app.domain.ledger.preview import as_preview_out, dry_run
from app.domain.ledger.schemas import PostingPreviewOut
from app.domain.masters.models import User
from app.domain.reports.queries import open_items

RequestsPo = Annotated[User, Depends(require_action("request_po"))]
ApprovesPo = Annotated[User, Depends(require_action("approve_po"))]
SeesVendors = Annotated[User, Depends(require_module("vendors"))]
PaysPo = Annotated[User, Depends(require_action("pay_po"))]

router = APIRouter(tags=["accounts payable"])

BUCKET_LABELS = {
    "current": "Current",
    "1-30": "1–30 days",
    "31-60": "31–60 days",
    "60+": "60+ days",
}


async def _tags(session: SessionDep, ids: list[str]) -> list[Tag]:
    if not ids:
        return []
    rows = (await session.execute(select(Tag).where(Tag.id.in_(ids)))).scalars().all()
    missing = set(ids) - {t.id for t in rows}
    if missing:
        raise NotFound(f"Unknown tag(s): {', '.join(sorted(missing))}.")
    return list(rows)


# ---------------------------------------------------------------------------
# Tags
# ---------------------------------------------------------------------------


@router.get("/tags", response_model=list[TagOut])
async def list_tags(session: SessionDep, user: CurrentUser) -> list[TagOut]:
    rows = (await session.execute(select(Tag).order_by(Tag.id))).scalars().all()
    return [TagOut.model_validate(row) for row in rows]


@router.post("/tags", response_model=TagOut, status_code=status.HTTP_201_CREATED)
async def create_tag(session: SessionDep, user: RequestsPo, body: TagCreate) -> TagOut:
    if await session.get(Tag, body.id):
        raise Conflict(f"Tag {body.id!r} already exists.")
    tag = Tag(id=body.id, label=body.label)
    session.add(tag)
    await session.flush()
    return TagOut.model_validate(tag)


@router.patch("/tags/{tag_id}", response_model=TagOut)
async def rename_tag(
    session: SessionDep, user: RequestsPo, tag_id: str, body: TagUpdate
) -> TagOut:
    """Rename a tag. The id stays, so every vendor and item keeps it."""
    tag = await session.get(Tag, tag_id)
    if tag is None:
        raise NotFound(f"No tag {tag_id!r}.")
    tag.label = body.label
    await session.flush()
    return TagOut.model_validate(tag)


@router.delete("/tags/{tag_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_tag(session: SessionDep, user: RequestsPo, tag_id: str) -> None:
    """Deleting a tag strips it from every vendor and catalogue item.

    A dangling tag reference is worse than no tag, so the join rows cascade.
    """
    tag = await session.get(Tag, tag_id)
    if tag is None:
        raise NotFound(f"No tag {tag_id!r}.")
    await session.delete(tag)
    await session.flush()


# ---------------------------------------------------------------------------
# Vendors
# ---------------------------------------------------------------------------


@router.get("/vendors", response_model=list[VendorOut])
async def list_vendors(
    session: SessionDep,
    user: CurrentUser,
    q: str | None = None,
    tags: list[str] | None = Query(default=None, description="AND semantics"),
) -> list[VendorOut]:
    """List vendors, optionally filtered by search text and tags.

    Tag filtering is **AND**: asking for `outdoor-capable` and `preferred-supplier` means
    both, not either. That is what makes the filter useful for narrowing a shortlist.
    """
    rows = (
        (await session.execute(select(Vendor).order_by(Vendor.vendor_no))).scalars().all()
    )
    out = list(rows)

    if q:
        needle = q.strip().lower()
        out = [v for v in out if needle in v.name.lower() or needle in (v.category or "").lower()]
    if tags:
        wanted = set(tags)
        out = [v for v in out if wanted <= {t.id for t in v.tags}]

    return [VendorOut.model_validate(v) for v in out]


@router.get("/vendors/{vendor_id}", response_model=VendorOut)
async def get_vendor(
    session: SessionDep, user: CurrentUser, vendor_id: uuid.UUID
) -> VendorOut:
    vendor = await session.get(Vendor, vendor_id)
    if vendor is None:
        raise NotFound(f"No vendor {vendor_id}.")
    return VendorOut.model_validate(vendor)


@router.post("/vendors", response_model=VendorOut, status_code=status.HTTP_201_CREATED)
async def create_vendor(
    session: SessionDep, user: RequestsPo, body: VendorCreate
) -> VendorOut:
    data = body.model_dump(exclude={"tags"})
    vendor = Vendor(vendor_no=await next_document_no(session, "vendor"), **data)
    vendor.tags = await _tags(session, body.tags)
    session.add(vendor)
    await session.flush()
    vendor_lifecycle.start_as_prospect(session, vendor, user)
    await session.flush()
    return VendorOut.model_validate(vendor)


@router.patch("/vendors/{vendor_id}", response_model=VendorOut)
async def update_vendor(
    session: SessionDep, user: PaysPo, vendor_id: uuid.UUID, body: VendorUpdate
) -> VendorOut:
    """Update a vendor, including their PPh 23 rate.

    The rate is gated on ``pay_po`` rather than ``request_po``: it changes what the company
    withholds and owes the tax office, so it belongs with Finance, not with whoever raises
    the order.
    """
    vendor = await session.get(Vendor, vendor_id)
    if vendor is None:
        raise NotFound(f"No vendor {vendor_id}.")

    data = body.model_dump(exclude_unset=True, exclude={"tags"})
    for field, value in data.items():
        setattr(vendor, field, value)
    if body.tags is not None:
        vendor.tags = await _tags(session, body.tags)

    await session.flush()
    return VendorOut.model_validate(vendor)


# ---------------------------------------------------------------------------
# Catalogue
# ---------------------------------------------------------------------------


@router.get("/vendor-catalogue", response_model=list[CatalogueItemOut])
async def list_catalogue(
    session: SessionDep,
    user: CurrentUser,
    vendor_id: uuid.UUID | None = None,
    category: str | None = None,
    subcategory: str | None = None,
    tags: list[str] | None = Query(default=None, description="AND semantics"),
    q: str | None = None,
) -> list[CatalogueItemOut]:
    stmt = select(CatalogueItem).order_by(CatalogueItem.item_no)
    if vendor_id is not None:
        stmt = stmt.where(CatalogueItem.vendor_id == vendor_id)
    if category is not None:
        stmt = stmt.where(CatalogueItem.category == category)
    if subcategory is not None:
        stmt = stmt.where(CatalogueItem.subcategory == subcategory)

    rows = list((await session.execute(stmt)).scalars().all())
    if q:
        needle = q.strip().lower()
        rows = [i for i in rows if needle in i.item.lower()]
    if tags:
        wanted = set(tags)
        rows = [i for i in rows if wanted <= {t.id for t in i.tags}]

    return [CatalogueItemOut.model_validate(row) for row in rows]


@router.post(
    "/vendor-catalogue", response_model=CatalogueItemOut, status_code=status.HTTP_201_CREATED
)
async def create_catalogue_item(
    session: SessionDep, user: RequestsPo, body: CatalogueItemCreate
) -> CatalogueItemOut:
    if await session.get(Vendor, body.vendor_id) is None:
        raise NotFound(f"No vendor {body.vendor_id}.")

    item = CatalogueItem(
        item_no=await next_document_no(session, "catalogue"),
        **body.model_dump(exclude={"tags"}),
    )
    item.tags = await _tags(session, body.tags)
    session.add(item)
    await session.flush()
    return CatalogueItemOut.model_validate(item)


@router.patch("/vendor-catalogue/{item_id}", response_model=CatalogueItemOut)
async def update_catalogue_item(
    session: SessionDep, user: RequestsPo, item_id: uuid.UUID, body: CatalogueItemUpdate
) -> CatalogueItemOut:
    item = await session.get(CatalogueItem, item_id)
    if item is None:
        raise NotFound(f"No catalogue item {item_id}.")
    for field, value in body.model_dump(exclude_unset=True, exclude={"tags"}).items():
        setattr(item, field, value)
    if body.tags is not None:
        item.tags = await _tags(session, body.tags)
    await session.flush()
    return CatalogueItemOut.model_validate(item)


@router.get("/vendor-catalogue/availability", response_model=list[AvailabilityOut])
async def availability(
    session: SessionDep,
    user: CurrentUser,
    event_date: date | None = None,
    window_from: date | None = None,
    window_to: date | None = None,
    vendor_id: uuid.UUID | None = None,
    exclude_project: uuid.UUID | None = None,
) -> list[AvailabilityOut]:
    """What is free in a given window.

    Give an ``event_date`` and the window becomes load-in to strike (D−2 to D+1), which is
    what a booking actually occupies. Adjacent windows do not overlap, so the same kit can
    go straight from one job to the next.
    """
    if event_date is not None:
        start, end = service.event_window(event_date)
    elif window_from is not None and window_to is not None:
        start, end = window_from, window_to
    else:
        raise Conflict("Provide either an event_date or both window_from and window_to.")

    stmt = select(CatalogueItem).order_by(CatalogueItem.item_no)
    if vendor_id is not None:
        stmt = stmt.where(CatalogueItem.vendor_id == vendor_id)

    out: list[AvailabilityOut] = []
    for item in (await session.execute(stmt)).scalars().all():
        booked = await service.booked_qty(
            session, item.id, start, end, exclude_project=exclude_project
        )
        free = item.stock - booked
        out.append(
            AvailabilityOut(
                item_id=item.id,
                item=item.item,
                stock=item.stock,
                booked=booked,
                available=free,
                status=service.availability_status(free, item.stock),
                window_from=start,
                window_to=end,
            )
        )
    return out


# ---------------------------------------------------------------------------
# Purchase orders
# ---------------------------------------------------------------------------


async def _order_out(session: SessionDep, order: PurchaseOrder) -> PurchaseOrderOut:
    bill = await service._bill_for(session, order)
    outstanding = await service._bill_outstanding(session, bill) if bill else ZERO

    return PurchaseOrderOut.model_validate(
        {
            **{c.name: getattr(order, c.name) for c in PurchaseOrder.__table__.columns},
            "lines": [
                {
                    "line_no": line.line_no,
                    "catalogue_item_id": line.catalogue_item_id,
                    "item_label": line.item_label,
                    "qty": line.qty,
                    "unit_price": line.unit_price,
                    "line_total": line.qty * line.unit_price,
                }
                for line in order.lines
            ],
            "committed": service.order_total(order),
            "dp_amount": service.dp_amount(order),
            "outstanding": outstanding,
            "variance": service.variance(order),
        }
    )


@router.put("/purchase-orders/{order_id}/delivery", response_model=PurchaseOrderOut)
async def set_delivery(
    session: SessionDep, clock: ClockDep, user: RequestsPo, order_id: uuid.UUID, body: DeliveryIn,
    request: Request,
) -> PurchaseOrderOut:  # fmt: skip
    """Record whether the goods have arrived (Not started, In progress, Delivered). Separate from
    payment, posts nothing, and refused for a draft or cancelled order."""
    if body.status not in DELIVERY_STATUSES:
        raise Invalid(f"Delivery status must be one of: {', '.join(DELIVERY_STATUSES)}.")
    order = await session.get(PurchaseOrder, order_id)
    if order is None:
        raise NotFound(f"No purchase order {order_id}.")
    if order.status in (PoStatus.DRAFT, PoStatus.CANCELLED):
        raise Conflict("Delivery can only be tracked on an approved purchase order.")
    before = order.delivery_status
    order.delivery_status = body.status
    order.delivery_updated_at = clock.now()
    order.delivery_updated_by = user.id
    await session.flush()
    await record_audit(
        session, actor=user, action="po.delivery", entity_type="purchase_order",
        entity_id=order.id, before={"delivery_status": before},
        after={"delivery_status": body.status}, request=request,
    )  # fmt: skip
    return await _order_out(session, order)


@router.get("/purchase-orders", response_model=list[PurchaseOrderOut])
async def list_orders(
    session: SessionDep,
    user: CurrentUser,
    vendor_id: uuid.UUID | None = None,
    project_id: uuid.UUID | None = None,
    po_status: PoStatus | None = None,
) -> list[PurchaseOrderOut]:
    stmt = select(PurchaseOrder).order_by(PurchaseOrder.po_no)
    if vendor_id is not None:
        stmt = stmt.where(PurchaseOrder.vendor_id == vendor_id)
    if project_id is not None:
        stmt = stmt.where(PurchaseOrder.project_id == project_id)
    if po_status is not None:
        stmt = stmt.where(PurchaseOrder.status == po_status)

    rows = (await session.execute(stmt)).scalars().all()
    return [await _order_out(session, row) for row in rows]


@router.get("/purchase-orders/{order_id}", response_model=PurchaseOrderOut)
async def get_order(
    session: SessionDep, user: CurrentUser, order_id: uuid.UUID
) -> PurchaseOrderOut:
    return await _order_out(session, await service.get_order(session, order_id))


@router.post(
    "/purchase-orders", response_model=PurchaseOrderOut, status_code=status.HTTP_201_CREATED
)
async def create_order(
    session: SessionDep, clock: ClockDep, user: RequestsPo, body: PurchaseOrderCreate
) -> PurchaseOrderOut:
    """Raise a purchase order. Terms default to the vendor's own."""
    vendor = await session.get(Vendor, body.vendor_id)
    if vendor is None:
        raise NotFound(f"No vendor {body.vendor_id}.")
    # Off by default, so orders and vendors that predate the lifecycle are undisturbed.
    if (await cash_service.settings(session)).enforce_vendor_stage and not (
        vendor_lifecycle.can_order_from(vendor.stage)
    ):
        raise Conflict(
            f"{vendor.name} is {vendor.stage}: only an Approved or Active vendor can be given "
            "a purchase order."
        )

    order = PurchaseOrder(
        po_no=await next_document_no(session, "purchase_order"),
        vendor_id=body.vendor_id,
        project_id=body.project_id,
        order_date=body.order_date or clock.today(),
        event_date=body.event_date,
        terms_dp_percent=(
            body.terms_dp_percent
            if body.terms_dp_percent is not None
            else vendor.terms_dp_percent
        ),
        terms_settlement_days=(
            body.terms_settlement_days
            if body.terms_settlement_days is not None
            else vendor.terms_settlement_days
        ),
    )
    order.lines = [
        PurchaseOrderLine(
            line_no=i,
            catalogue_item_id=line.catalogue_item_id,
            item_label=line.item_label,
            qty=line.qty,
            unit_price=line.unit_price,
        )
        for i, line in enumerate(body.lines, start=1)
    ]
    session.add(order)
    await session.flush()
    return await _order_out(session, order)


@router.post("/purchase-orders/{order_id}/approve", response_model=PurchaseOrderOut)
async def approve_order(
    session: SessionDep, user: ApprovesPo, order_id: uuid.UUID
) -> PurchaseOrderOut:
    """Approve an order. **Posts nothing** — a commitment is not a debt.

    What it does do is reserve catalogue stock for the event window, so the same kit cannot
    be promised to two jobs. An overbooked line is refused and names the item.
    """
    order = await service.approve(session, order_id, user=user)
    return await _order_out(session, order)


@router.post(
    "/purchase-orders/{order_id}/pay-dp", response_model=PaymentOut | PostingPreviewOut
)
async def pay_dp(
    session: SessionDep,
    clock: ClockDep,
    user: PaysPo,
    order_id: uuid.UUID,
    body: PayRequest | None = None,
    dry_run_only: bool = Query(
        default=False,
        alias="dry_run",
        description="Return the lines this would post, and post nothing",
    ),
) -> PaymentOut | PostingPreviewOut:
    """Raise the bill lazily and pay the agreed down payment.

    ``Dr 2102 / Cr 2105 (tax) / Cr cash (net)`` — at the **vendor's** PPh 23 rate, which may
    differ from the company default. `amount` is ignored: the DP is fixed by the order's
    terms. `tax_amount`, `document_date` and `lines` apply to the payment only, never to
    the bill raised alongside it. With `dry_run=true` both entries are previewed and
    nothing is posted.
    """
    body = body or PayRequest()

    async def _pay() -> service.Payment:
        return await service.pay_down_payment(
            session,
            order_id,
            user=user,
            on=body.payment_date or clock.today(),
            cash_account=body.cash_account,
            withhold=body.withhold,
            tax_amount=body.tax_amount,
            document_date=body.document_date,
            lines=body.lines,
        )

    if dry_run_only:
        return as_preview_out(await dry_run(session, _pay))

    payment = await _pay()
    order = await service.get_order(session, order_id)
    return PaymentOut(
        entry_id=payment.entry.id,
        entry_no=payment.entry.entry_no,
        voucher_no=payment.entry.voucher_no,
        gross=payment.gross,
        tax=payment.tax,
        net=payment.net,
        cash_account=payment.cash_account,
        posting=[
            PostingLineOut(
                account=line.account_code,
                debit=line.debit,
                credit=line.credit,
                note=line.note,
            )
            for line in payment.entry.lines
        ],
        order=await _order_out(session, order),
    )


@router.post(
    "/purchase-orders/{order_id}/settle",
    response_model=PurchaseOrderOut | PostingPreviewOut,
)
async def settle_order(
    session: SessionDep,
    clock: ClockDep,
    user: PaysPo,
    order_id: uuid.UUID,
    body: PoSettleRequest | None = None,
    dry_run_only: bool = Query(
        default=False,
        alias="dry_run",
        description="Return the lines this would post, and post nothing",
    ),
) -> PurchaseOrderOut | PostingPreviewOut:
    """Settle against the vendor's actual final invoice.

    Accepts an order in ``DP Paid`` **or** ``Approved`` — a zero-DP order never reaches
    DP Paid but must still be settleable. Any difference from the committed amount posts a
    variance first, so the project's cost ends on what was really spent.
    """
    body = body or PoSettleRequest()

    async def _settle() -> None:
        await service.settle(
            session,
            order_id,
            user=user,
            actual_total=body.actual_total,
            on=body.payment_date or clock.today(),
            invoice_date=body.invoice_date,
            cash_account=body.cash_account,
            withhold=body.withhold,
            tax_amount=body.tax_amount,
            lines=body.lines,
        )

    # Worth previewing precisely because of the variance: settling above or below the
    # committed amount posts a correction to the cost BEFORE the payment, and that is the
    # figure an operator wants to see before agreeing to it.
    if dry_run_only:
        return as_preview_out(await dry_run(session, _settle))

    order = await service.settle(
        session,
        order_id,
        user=user,
        actual_total=body.actual_total,
        on=body.payment_date or clock.today(),
        invoice_date=body.invoice_date,
        cash_account=body.cash_account,
        withhold=body.withhold,
        tax_amount=body.tax_amount,
        lines=body.lines,
    )
    return await _order_out(session, order)


@router.post("/purchase-orders/{order_id}/cancel", response_model=PurchaseOrderOut)
async def cancel_order(
    session: SessionDep, clock: ClockDep, user: ApprovesPo, order_id: uuid.UUID
) -> PurchaseOrderOut:
    """Cancel and unwind. **Payments are reversed before the bill** — the other order would
    leave payments applied to a reversed document."""
    order = await service.cancel(session, order_id, user=user, on=clock.today())
    return await _order_out(session, order)


# ---------------------------------------------------------------------------
# Bills
# ---------------------------------------------------------------------------


@router.get("/bills", response_model=list[BillOut])
async def list_bills(
    session: SessionDep, clock: ClockDep, user: CurrentUser, as_of: date | None = None
) -> list[BillOut]:
    """Open payables — derived from the ledger, not from a bills table.

    An overhead bill raised without a purchase order appears here too, and ages from its
    own due date.
    """
    items = await open_items(
        session, control=service.AP_CONTROL, side=Side.CREDIT, as_of=as_of or clock.today()
    )
    return [
        BillOut(
            entry_id=i.entry_id,
            entry_no=i.entry_no,
            voucher_no=i.voucher_no,
            entry_date=i.entry_date,
            memo=i.memo,
            due=i.due,
            vendor_id=i.vendor_id,
            project_id=i.project_id,
            source_ref=i.source_ref,
            raised=i.raised,
            applied=i.applied,
            outstanding=i.outstanding,
        )
        for i in items
    ]


@router.post("/bills/{entry_id}/payments", response_model=PaymentOut | PostingPreviewOut)
async def pay_bill(
    session: SessionDep,
    clock: ClockDep,
    user: PaysPo,
    entry_id: uuid.UUID,
    body: PayRequest,
    dry_run_only: bool = Query(
        default=False,
        alias="dry_run",
        description="Return the lines this would post, and post nothing",
    ),
) -> PaymentOut | PostingPreviewOut:
    """Pay a bill directly — including one that never had a purchase order.

    **No cost is recognised again**: the expense landed when the bill was raised. This only
    moves the liability, withholding PPh 23 into 2105 on the way.
    """
    bill = await session.get(JournalEntry, entry_id)
    if bill is None:
        raise NotFound(f"No journal entry {entry_id}.")

    amount = body.amount
    if amount is None:
        amount = await service._bill_outstanding(session, bill)

    async def _pay() -> service.Payment:
        return await service.pay_bill(
            session,
            entry_id,
            user=user,
            amount=amount,
            on=body.payment_date or clock.today(),
            cash_account=body.cash_account,
            withhold=body.withhold,
            tax_amount=body.tax_amount,
            document_date=body.document_date,
            lines=body.lines,
        )

    if dry_run_only:
        return as_preview_out(await dry_run(session, _pay))

    payment = await _pay()

    order = None
    if bill.source_ref:
        order = (
            await session.execute(
                select(PurchaseOrder).where(PurchaseOrder.po_no == bill.source_ref)
            )
        ).scalar_one_or_none()

    return PaymentOut(
        entry_id=payment.entry.id,
        entry_no=payment.entry.entry_no,
        voucher_no=payment.entry.voucher_no,
        gross=payment.gross,
        tax=payment.tax,
        net=payment.net,
        cash_account=payment.cash_account,
        posting=[
            PostingLineOut(
                account=line.account_code,
                debit=line.debit,
                credit=line.credit,
                note=line.note,
            )
            for line in payment.entry.lines
        ],
        order=await _order_out(session, order) if order else None,
    )


# ---------------------------------------------------------------------------
# Ageing
# ---------------------------------------------------------------------------


@router.get("/payables/ageing", response_model=PayablesAgeingOut)
async def payables_ageing(
    session: SessionDep, clock: ClockDep, user: CurrentUser, as_of: date | None = None
) -> PayablesAgeingOut:
    """AP ageing, reconciled against 2102, with what is owed to the tax office alongside."""
    on = as_of or clock.today()
    result = await service.ageing(session, as_of=on)

    return PayablesAgeingOut(
        as_of=on,
        buckets=[
            BucketOut(
                key=key,
                label=BUCKET_LABELS[key],
                amount=result.buckets[key],
                count=result.counts[key],
                share=float(result.buckets[key] / result.total) if result.total else 0.0,
            )
            for key in service.BUCKETS
        ],
        total=result.total,
        overdue=result.overdue,
        withholding_owed=result.withholding_owed,
        ledger_balance=result.ledger_balance,
        difference=result.difference,
        reconciled=result.reconciled,
    )


# ---------------------------------------------------------------------------
# Vendor files (agreements, tax and bank documents, price lists)
# ---------------------------------------------------------------------------

MAX_FILES_PER_VENDOR = 25


async def _vendor_files(session: SessionDep, vendor_id: uuid.UUID) -> list[VendorFileOut]:
    rows = await session.execute(
        select(VendorAttachment, Attachment, User.full_name)
        .join(Attachment, Attachment.id == VendorAttachment.attachment_id)
        .join(User, User.id == VendorAttachment.created_by)
        .where(VendorAttachment.vendor_id == vendor_id)
        .order_by(VendorAttachment.created_at, Attachment.filename)
    )
    return [
        VendorFileOut(
            id=link.id, attachment_id=file.id, kind=link.kind, note=link.note,
            filename=file.filename, content_type=file.content_type, byte_size=file.byte_size,
            uploaded_by=who, created_at=link.created_at,
        )
        for link, file, who in rows.all()
    ]  # fmt: skip


@router.get("/vendors/{vendor_id}/attachments", response_model=list[VendorFileOut])
async def list_vendor_files(
    session: SessionDep, user: SeesVendors, vendor_id: uuid.UUID
) -> list[VendorFileOut]:
    if await session.get(Vendor, vendor_id) is None:
        raise NotFound(f"No vendor {vendor_id}.")
    return await _vendor_files(session, vendor_id)


@router.post(
    "/vendors/{vendor_id}/attachments",
    response_model=list[VendorFileOut],
    status_code=status.HTTP_201_CREATED,
)
async def attach_vendor_file(
    session: SessionDep, user: RequestsPo, vendor_id: uuid.UUID, body: VendorFileIn,
    request: Request,
) -> list[VendorFileOut]:  # fmt: skip
    """File an uploaded file (``POST /attachments``) against a vendor. Filing twice is a no-op."""
    if body.kind not in VENDOR_FILE_KINDS:
        raise Invalid(f"The kind must be one of: {', '.join(VENDOR_FILE_KINDS)}.")
    if await session.get(Vendor, vendor_id) is None:
        raise NotFound(f"No vendor {vendor_id}.")
    if await session.get(Attachment, body.attachment_id) is None:
        raise NotFound(f"No stored file {body.attachment_id}. Upload it first.")
    existing = (
        await session.execute(
            select(VendorAttachment).where(
                VendorAttachment.vendor_id == vendor_id,
                VendorAttachment.attachment_id == body.attachment_id,
            )
        )
    ).scalar_one_or_none()
    if existing is None:
        count = len(await _vendor_files(session, vendor_id))
        if count >= MAX_FILES_PER_VENDOR:
            raise Conflict(f"A vendor can hold up to {MAX_FILES_PER_VENDOR} files.")
        link = VendorAttachment(
            vendor_id=vendor_id, attachment_id=body.attachment_id, kind=body.kind,
            note=(body.note or "").strip() or None, created_by=user.id,
        )  # fmt: skip
        session.add(link)
        await session.flush()
        await record_audit(
            session, actor=user, action="vendor.file", entity_type="vendor", entity_id=vendor_id,
            after={"kind": body.kind}, detail={"attachment_id": str(body.attachment_id)},
            request=request,
        )  # fmt: skip
    return await _vendor_files(session, vendor_id)


@router.delete(
    "/vendors/{vendor_id}/attachments/{link_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def detach_vendor_file(
    session: SessionDep, user: RequestsPo, vendor_id: uuid.UUID, link_id: uuid.UUID,
    request: Request,
) -> None:  # fmt: skip
    """Take a file off a vendor. The stored file stays. Removing an Agreement needs the right to
    approve purchase orders: it can decide whether the vendor is still vetted."""
    link = await session.get(VendorAttachment, link_id)
    if link is None or link.vendor_id != vendor_id:
        raise NotFound("No such file on this vendor.")
    if link.kind == "Agreement" and not can_do(user.role, "approve_po"):
        raise PermissionDenied(
            "Removing a signed agreement needs the right to approve purchase orders.",
            action="approve_po",
        )
    await session.delete(link)
    await session.flush()
    await record_audit(
        session, actor=user, action="vendor.file_remove", entity_type="vendor",
        entity_id=vendor_id, before={"kind": link.kind}, request=request,
    )  # fmt: skip


# ---------------------------------------------------------------------------
# Vendor lifecycle
# ---------------------------------------------------------------------------


async def _lifecycle_out(
    session: SessionDep, rows: list[vendor_lifecycle.Lifecycle]
) -> list[VendorLifecycleOut]:
    who = {h.created_by for r in rows for h in r.history}
    names = {
        u.id: u.full_name
        for u in (await session.execute(select(User).where(User.id.in_(who)))).scalars()
    }
    return [
        VendorLifecycleOut(
            vendor_id=r.vendor.id,
            stage=r.vendor.stage,
            since=r.vendor.stage_since,
            reason=r.vendor.stage_reason,
            checks=r.checks,
            checklist=[
                ChecklistItemOut(
                    key=i.key, label=i.label, done=i.done, manual=i.manual, auto=i.auto
                )
                for i in r.items
            ],
            checklist_complete=all(i.done for i in r.items),
            has_agreement_file=r.has_agreement_file,
            has_live_po=r.has_live_po,
            resume_to=r.resume_to,
            history=[
                StageHistoryOut(
                    stage=h.stage, reason=h.reason, by=names.get(h.created_by, "Oscenia staff"),
                    at=h.created_at,
                )
                for h in r.history
            ],
        )
        for r in rows
    ]  # fmt: skip


async def _one_lifecycle(session: SessionDep, vendor_id: uuid.UUID) -> VendorLifecycleOut:
    rows = await vendor_lifecycle.lifecycles(session, [vendor_id])
    if not rows:
        raise NotFound(f"No vendor {vendor_id}.")
    return (await _lifecycle_out(session, rows))[0]


@router.get("/vendor-lifecycle", response_model=list[VendorLifecycleOut])
async def vendor_lifecycles(session: SessionDep, user: SeesVendors) -> list[VendorLifecycleOut]:
    """Every vendor's stage, checklist and history: what the board draws."""
    return await _lifecycle_out(session, await vendor_lifecycle.lifecycles(session))


@router.get("/vendors/{vendor_id}/lifecycle", response_model=VendorLifecycleOut)
async def vendor_lifecycle_of(
    session: SessionDep, user: SeesVendors, vendor_id: uuid.UUID
) -> VendorLifecycleOut:
    return await _one_lifecycle(session, vendor_id)


@router.post("/vendors/{vendor_id}/stage", response_model=VendorLifecycleOut)
async def change_vendor_stage(
    session: SessionDep, user: SeesVendors, vendor_id: uuid.UUID, body: StageIn, request: Request
) -> VendorLifecycleOut:
    """Move a vendor along the board, hold it, blacklist it or bring it back. The rules (one step
    at a time, a complete checklist to approve, a live order to become active, a reason to hold)
    are the prototype's; a refusal says which."""
    vendor = await session.get(Vendor, vendor_id)
    if vendor is None:
        raise NotFound(f"No vendor {vendor_id}.")
    before = await vendor_lifecycle.change_stage(
        session, vendor, body.stage, user=user, reason=body.reason
    )
    await record_audit(
        session, actor=user, action="vendor.stage", entity_type="vendor", entity_id=vendor_id,
        before={"stage": before}, after={"stage": vendor.stage},
        detail={"has_reason": bool(vendor.stage_reason)}, request=request,
    )  # fmt: skip
    return await _one_lifecycle(session, vendor_id)


@router.get("/vendors/{vendor_id}/stage-history", response_model=list[StageHistoryOut])
async def vendor_stage_history(
    session: SessionDep, user: SeesVendors, vendor_id: uuid.UUID
) -> list[StageHistoryOut]:
    if await session.get(Vendor, vendor_id) is None:
        raise NotFound(f"No vendor {vendor_id}.")
    rows = await session.execute(
        select(VendorStageHistory, User.full_name)
        .join(User, User.id == VendorStageHistory.created_by)
        .where(VendorStageHistory.vendor_id == vendor_id)
        .order_by(VendorStageHistory.created_at.desc(), VendorStageHistory.id)
    )
    return [
        StageHistoryOut(stage=h.stage, reason=h.reason, by=who, at=h.created_at)
        for h, who in rows.all()
    ]


@router.put("/vendors/{vendor_id}/checks/{key}", response_model=VendorLifecycleOut)
async def tick_vendor_check(
    session: SessionDep, user: SeesVendors, vendor_id: uuid.UUID, key: str, body: CheckIn,
    request: Request,
) -> VendorLifecycleOut:  # fmt: skip
    """Tick or untick the agreement or the reference check by hand."""
    vendor = await session.get(Vendor, vendor_id)
    if vendor is None:
        raise NotFound(f"No vendor {vendor_id}.")
    await vendor_lifecycle.set_check(session, vendor, key, body.done, user=user)
    await record_audit(
        session, actor=user, action="vendor.check", entity_type="vendor", entity_id=vendor_id,
        after={"key": key, "done": body.done}, request=request,
    )  # fmt: skip
    return await _one_lifecycle(session, vendor_id)
