"""Accounts Payable: the purchase-order lifecycle, bills, payments and variance.

Two rules carry this module, and both were decided during the client's feedback rounds.

**A purchase order is a commitment, not a debt.** Approving posts nothing; it reserves
catalogue stock. The payable is raised lazily, at the first payment. Raising it at approval
is what pushed the company into an apparent loss in round 1, because every
approved-but-unstarted order was recognised as cost immediately.

**PPh 23 runs the other way here.** Money out — *we* withhold from the vendor, so we owe it
onward to the tax office. It is a **liability in 2105**, never the asset in 1401 that a
client receipt produces. The two must never be netted.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict, Invalid, NotFound
from app.core.money import MATERIALITY, ZERO, money
from app.domain.accounts.models import Side
from app.domain.ap.models import (
    SETUP_DAYS,
    STRIKE_DAYS,
    Booking,
    CatalogueItem,
    PoStatus,
    PurchaseOrder,
    Vendor,
)
from app.domain.ledger.models import EntryApplication, JournalEntry, SourceKind
from app.domain.ledger.overrides import SubmittedLine, apply_line_override, net_movement
from app.domain.ledger.posting import LineIn, SourceIn, post_entry, reverse_entry
from app.domain.masters.models import User
from app.domain.reports.queries import open_items
from app.domain.reports.statements import tax_config

AP_CONTROL = "2102"
COGS_VENDORS = "5101"
PPH23_PAYABLE = "2105"
DEFAULT_CASH = "1101"


# ---------------------------------------------------------------------------
# Money on an order
# ---------------------------------------------------------------------------


def order_total(order: PurchaseOrder) -> Decimal:
    return money(sum((line.qty * line.unit_price for line in order.lines), start=ZERO))


def dp_amount(order: PurchaseOrder) -> Decimal:
    return money(order_total(order) * order.terms_dp_percent / Decimal(100))


def variance(order: PurchaseOrder) -> Decimal | None:
    """``committed - actual``. Positive means the vendor came in **under** budget.

    ``None`` until settled: before that there is no actual to compare against, and
    reporting zero would imply the order came in exactly on budget.
    """
    if order.status is not PoStatus.SETTLED or order.actual_total is None:
        return None
    return order_total(order) - money(order.actual_total)


async def get_order(session: AsyncSession, order_id: uuid.UUID) -> PurchaseOrder:
    order = (
        await session.execute(select(PurchaseOrder).where(PurchaseOrder.id == order_id))
    ).scalar_one_or_none()
    if order is None:
        raise NotFound(f"No purchase order {order_id}.")
    return order


async def vendor_rate(session: AsyncSession, vendor: Vendor) -> Decimal:
    """The vendor's own PPh 23 rate, falling back to the company default.

    Zero when the tax is switched off entirely — the config is the master switch, and a
    per-vendor rate does not override that.
    """
    config = await tax_config(session)
    entry = config.get("pph23")
    if entry is None or not entry.active:
        return ZERO
    return vendor.pph23_rate if vendor.pph23_rate is not None else entry.rate


# ---------------------------------------------------------------------------
# Availability
# ---------------------------------------------------------------------------


def event_window(event_date: date) -> tuple[date, date]:
    """Load-in to strike: D-2 through D+1.

    Deliberately not shifted by a timezone — ``verify-flows`` §33 exists because that bug
    happened once and moved every booking window by a day.
    """
    return event_date - timedelta(days=SETUP_DAYS), event_date + timedelta(days=STRIKE_DAYS)


async def booked_qty(
    session: AsyncSession,
    item_id: uuid.UUID,
    start: date,
    end: date,
    *,
    exclude_project: uuid.UUID | None = None,
    exclude_order: uuid.UUID | None = None,
) -> Decimal:
    """How much of an item is held during an overlapping window.

    Two ranges overlap when each starts before the other ends. Adjacent ranges — one ending
    the day the next begins — do **not** overlap, which is what lets the same kit go
    straight from one job to the next.
    """
    stmt = select(func.coalesce(func.sum(Booking.qty), 0)).where(
        Booking.item_id == item_id,
        Booking.from_date <= end,
        Booking.to_date >= start,
    )
    if exclude_project is not None:
        stmt = stmt.where(
            (Booking.project_id.is_(None)) | (Booking.project_id != exclude_project)
        )
    if exclude_order is not None:
        stmt = stmt.where(
            (Booking.purchase_order_id.is_(None))
            | (Booking.purchase_order_id != exclude_order)
        )
    return money((await session.execute(stmt)).scalar_one())


async def available_qty(
    session: AsyncSession,
    item: CatalogueItem,
    start: date,
    end: date,
    *,
    exclude_project: uuid.UUID | None = None,
    exclude_order: uuid.UUID | None = None,
) -> Decimal:
    held = await booked_qty(
        session,
        item.id,
        start,
        end,
        exclude_project=exclude_project,
        exclude_order=exclude_order,
    )
    return money(item.stock) - held


def availability_status(available: Decimal, stock: Decimal) -> str:
    if available <= ZERO:
        return "Booked"
    if stock > ZERO and available < stock * Decimal("0.25"):
        return "Low Stock"
    return "Available"


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------


async def approve(
    session: AsyncSession, order_id: uuid.UUID, *, user: User
) -> PurchaseOrder:
    """Approve an order. **Posts nothing.**

    A commitment is not a debt. What this does is reserve catalogue stock for the event
    window, so the same kit cannot be promised twice.
    """
    order = await get_order(session, order_id)
    if order.status is not PoStatus.DRAFT:
        raise Conflict(f"{order.po_no} is {order.status.value}, not a draft.")
    if not order.lines:
        raise Conflict(f"{order.po_no} has no lines.")

    if order.event_date is not None:
        start, end = event_window(order.event_date)
        for line in order.lines:
            if line.catalogue_item_id is None:
                continue
            item = await session.get(CatalogueItem, line.catalogue_item_id)
            if item is None:
                continue
            free = await available_qty(session, item, start, end, exclude_order=order.id)
            if line.qty > free:
                raise Conflict(
                    f"Not enough {item.item} in that window: {line.qty} needed, "
                    f"{free} free between {start} and {end}."
                )
            session.add(
                Booking(
                    item_id=item.id,
                    from_date=start,
                    to_date=end,
                    project_id=order.project_id,
                    purchase_order_id=order.id,
                    qty=line.qty,
                )
            )

    order.status = PoStatus.APPROVED
    await session.flush()
    return order


async def _bill_for(session: AsyncSession, order: PurchaseOrder) -> JournalEntry | None:
    """The live bill entry for an order, if one has been raised.

    An entry with outgoing applications is a settlement or a variance adjustment, never the
    bill itself — that ``appliedTo`` check is what stopped a variance being counted as its
    own open payable and drifting AP above 2102.
    """
    settles = (
        select(EntryApplication.settling_entry_id)
        .where(EntryApplication.settling_entry_id == JournalEntry.id)
        .exists()
    )
    stmt = (
        select(JournalEntry)
        .where(
            JournalEntry.source_kind == SourceKind.PO,
            JournalEntry.source_ref == order.po_no,
            JournalEntry.reversal_of_id.is_(None),
            JournalEntry.reversed_by_id.is_(None),
            ~settles,
        )
        .order_by(JournalEntry.created_at)
    )
    return (await session.execute(stmt)).scalars().first()


async def ensure_bill(
    session: AsyncSession,
    order: PurchaseOrder,
    *,
    user: User,
    on: date,
    document_date: date | None = None,
) -> JournalEntry:
    """Raise the payable if it has not been raised yet. Idempotent.

    ``Dr 5101 / Cr 2102`` for the **full committed value**, dated with a due date of
    ``order_date + settlement_days`` so it ages from the moment it exists.
    """
    existing = await _bill_for(session, order)
    if existing is not None:
        return existing

    vendor = await session.get(Vendor, order.vendor_id)
    total = order_total(order)

    return await post_entry(
        session,
        entry_date=on,
        memo=f"Bill — {order.po_no} — {vendor.name if vendor else 'vendor'}",
        lines=[
            LineIn(COGS_VENDORS, debit=total, note="Vendor cost recognised at bill"),
            LineIn(AP_CONTROL, credit=total, note="Payable raised"),
        ],
        source=SourceIn(
            kind=SourceKind.PO,
            ref=order.po_no,
            due=order.order_date + timedelta(days=order.terms_settlement_days),
            document_date=document_date,
            vendor_id=order.vendor_id,
        ),
        posted_by_id=user.id,
        project_id=order.project_id,
        series="exp",
    )


@dataclass(slots=True)
class Payment:
    entry: JournalEntry
    gross: Decimal
    tax: Decimal
    net: Decimal
    cash_account: str


async def _bill_outstanding(session: AsyncSession, bill: JournalEntry) -> Decimal:
    items = await open_items(session, control=AP_CONTROL, side=Side.CREDIT)
    for item in items:
        if item.entry_id == bill.id:
            return item.outstanding
    return ZERO


async def pay_bill(
    session: AsyncSession,
    bill_entry_id: uuid.UUID,
    *,
    user: User,
    amount: Decimal,
    on: date,
    cash_account: str = DEFAULT_CASH,
    withhold: bool = True,
    tax_amount: Decimal | None = None,
    document_date: date | None = None,
    lines: Sequence[SubmittedLine] | None = None,
) -> Payment:
    """Pay a vendor bill, withholding PPh 23 on their behalf.

    ``Dr 2102 (gross) / Cr 2105 (tax) / Cr cash (net)``.

    **No cost is recognised again** — the expense landed when the bill was raised. Paying it
    only moves the liability. Clamped to outstanding, for the same reason as an AR receipt.

    ``tax_amount`` overrides the vendor-rate withholding (0 to gross). ``document_date`` is
    the date on the vendor's receipt/invoice, stored as ``source_document_date``; ``on`` is
    the date paid and the accounting date. ``lines`` replaces the computed lines of this
    payment after the guard in :mod:`app.domain.ledger.overrides` — 2102 must still be
    debited by exactly the computed gross.
    """
    bill = await session.get(JournalEntry, bill_entry_id)
    if bill is None:
        raise NotFound(f"No journal entry {bill_entry_id}.")

    remaining = await _bill_outstanding(session, bill)
    if remaining <= ZERO:
        raise Conflict("That bill is already settled.")

    requested = money(amount)
    if requested <= ZERO:
        raise Invalid("A payment must be for a positive amount.")
    gross = min(requested, remaining)

    tax = ZERO
    if tax_amount is not None:
        tax = money(tax_amount)
        if tax < ZERO:
            raise Invalid("Withholding cannot be negative.")
    elif withhold and bill.source_vendor_id is not None:
        vendor = await session.get(Vendor, bill.source_vendor_id)
        if vendor is not None:
            tax = money(gross * await vendor_rate(session, vendor) / Decimal(100))

    if tax > gross:
        raise Invalid(
            f"Withholding of {tax} exceeds the payment of {gross}. "
            "The net cash paid cannot be negative."
        )

    net = gross - tax
    computed = [LineIn(AP_CONTROL, debit=gross, note="Payable settled at gross")]
    if tax > ZERO:
        computed.append(
            LineIn(PPH23_PAYABLE, credit=tax, note="PPh 23 withheld from the vendor")
        )
    computed.append(LineIn(cash_account, credit=net, note="Net cash paid to vendor"))

    posted = await apply_line_override(
        session, computed=computed, submitted=lines, control=AP_CONTROL
    )
    if lines is not None:
        # Report what was actually posted: 2105 is credited, so negate the movement.
        tax = -net_movement(posted, PPH23_PAYABLE)
        net = gross - tax

    entry = await post_entry(
        session,
        entry_date=on,
        memo=f"Payment — {bill.source_ref or bill.entry_no}",
        lines=posted,
        source=SourceIn(
            kind=SourceKind.PAYMENT,
            ref=bill.source_ref,
            document_date=document_date,
            vendor_id=bill.source_vendor_id,
        ),
        posted_by_id=user.id,
        project_id=bill.project_id,
        applied_to=[bill.id],
    )

    await _sync_order_status(session, bill, on=on)
    return Payment(entry=entry, gross=gross, tax=tax, net=net, cash_account=cash_account)


async def _sync_order_status(
    session: AsyncSession, bill: JournalEntry, *, on: date
) -> None:
    """Move the originating order along once its bill is paid down."""
    if bill.source_ref is None:
        return
    order = (
        await session.execute(
            select(PurchaseOrder).where(PurchaseOrder.po_no == bill.source_ref)
        )
    ).scalar_one_or_none()
    if order is None or order.status is PoStatus.CANCELLED:
        return

    remaining = await _bill_outstanding(session, bill)
    if remaining <= MATERIALITY:
        order.status = PoStatus.SETTLED
        order.settled_at = on
        if order.actual_total is None:
            order.actual_total = order_total(order)
    else:
        order.status = PoStatus.DP_PAID
        if order.dp_paid_at is None:
            order.dp_paid_at = on
    await session.flush()


async def pay_down_payment(
    session: AsyncSession,
    order_id: uuid.UUID,
    *,
    user: User,
    on: date,
    cash_account: str = DEFAULT_CASH,
    withhold: bool = True,
    tax_amount: Decimal | None = None,
    document_date: date | None = None,
    lines: Sequence[SubmittedLine] | None = None,
) -> Payment:
    """Raise the bill (lazily, if needed) and pay the agreed down payment.

    ``tax_amount``, ``document_date`` and ``lines`` apply to the **payment** only; the bill
    raised alongside it is a companion accrual and is never edited.
    """
    order = await get_order(session, order_id)
    if order.status is not PoStatus.APPROVED:
        raise Conflict(
            f"{order.po_no} is {order.status.value}; only an approved order takes a "
            "down payment."
        )

    amount = dp_amount(order)
    if amount <= ZERO:
        raise Conflict(
            f"{order.po_no} has a zero down payment. Settle it directly instead — a "
            "zero-DP order never passes through DP Paid."
        )

    bill = await ensure_bill(session, order, user=user, on=on)
    return await pay_bill(
        session,
        bill.id,
        user=user,
        amount=amount,
        on=on,
        cash_account=cash_account,
        withhold=withhold,
        tax_amount=tax_amount,
        document_date=document_date,
        lines=lines,
    )


async def settle(
    session: AsyncSession,
    order_id: uuid.UUID,
    *,
    user: User,
    actual_total: Decimal | None,
    on: date,
    invoice_date: date | None = None,
    cash_account: str = DEFAULT_CASH,
    withhold: bool = True,
    tax_amount: Decimal | None = None,
    lines: Sequence[SubmittedLine] | None = None,
) -> PurchaseOrder:
    """Settle an order against the vendor's actual final invoice.

    Accepts an order in ``DP Paid`` **or** ``Approved`` — a zero-DP order never reaches
    DP Paid but must still be settleable. That was a real bug in the prototype.

    If the actual differs from the committed amount, a variance is posted first so the
    project's cost ends on what was really spent:

    * came in **under**: ``Dr 2102 / Cr 5101``
    * came in **over**:  ``Dr 5101 / Cr 2102``

    Then whatever remains on the payable is paid — or, if the order was overpaid, refunded.

    ``tax_amount`` and ``lines`` apply to that final **payment** only (never the bill or the
    variance), and ``invoice_date`` is stored as the payment's ``source_document_date`` as
    well as the bill's. Edited lines are refused when there is no payment to edit.
    """
    order = await get_order(session, order_id)
    if order.status is PoStatus.SETTLED:
        raise Conflict(f"{order.po_no} is already settled.")
    if order.status not in (PoStatus.APPROVED, PoStatus.DP_PAID):
        raise Conflict(f"{order.po_no} is {order.status.value} and cannot be settled.")

    committed = order_total(order)
    actual = money(actual_total) if actual_total is not None else committed
    if actual < ZERO:
        raise Invalid("An actual invoice cannot be negative.")

    bill = await ensure_bill(session, order, user=user, on=on, document_date=invoice_date)
    delta = committed - actual

    if delta != ZERO:
        # Applied to the bill, so it is recognised as an adjustment *of* that document
        # rather than counted as its own open payable.
        if delta > ZERO:
            variance_lines = [
                LineIn(AP_CONTROL, debit=delta, note="Vendor came in under the order"),
                LineIn(COGS_VENDORS, credit=delta, note="Cost reduced to the actual"),
            ]
        else:
            variance_lines = [
                LineIn(COGS_VENDORS, debit=-delta, note="Cost increased to the actual"),
                LineIn(AP_CONTROL, credit=-delta, note="Vendor came in over the order"),
            ]
        await post_entry(
            session,
            entry_date=on,
            memo=f"Variance — {order.po_no}",
            lines=variance_lines,
            source=SourceIn(kind=SourceKind.PO, ref=order.po_no, vendor_id=order.vendor_id),
            posted_by_id=user.id,
            project_id=order.project_id,
            series="exp",
            applied_to=[bill.id],
        )

    order.actual_total = actual
    if invoice_date is not None:
        order.invoice_date = invoice_date
    await session.flush()

    remaining = await _bill_outstanding(session, bill)
    if remaining > MATERIALITY:
        await pay_bill(
            session,
            bill.id,
            user=user,
            amount=remaining,
            on=on,
            cash_account=cash_account,
            withhold=withhold,
            tax_amount=tax_amount,
            document_date=invoice_date,
            lines=lines,
        )
    elif lines is not None:
        raise Invalid(
            f"{order.po_no} has nothing left to pay at settlement, so there is no payment "
            "whose lines could be edited. Send the request without lines."
        )
    elif remaining < -MATERIALITY:
        await _refund(
            session, order, bill, amount=-remaining, user=user, on=on, cash_account=cash_account
        )

    order.status = PoStatus.SETTLED
    order.settled_at = on
    await session.flush()
    return order


async def _refund(
    session: AsyncSession,
    order: PurchaseOrder,
    bill: JournalEntry,
    *,
    amount: Decimal,
    user: User,
    on: date,
    cash_account: str,
) -> None:
    """Money back from a vendor who was overpaid, with the withholding unwound."""
    vendor = await session.get(Vendor, order.vendor_id)
    rate = await vendor_rate(session, vendor) if vendor else ZERO
    tax = money(amount * rate / Decimal(100))

    lines = [LineIn(cash_account, debit=amount - tax, note="Refund received from vendor")]
    if tax > ZERO:
        lines.append(LineIn(PPH23_PAYABLE, debit=tax, note="Withholding unwound"))
    lines.append(LineIn(AP_CONTROL, credit=amount, note="Overpayment returned"))

    await post_entry(
        session,
        entry_date=on,
        memo=f"Refund — {order.po_no}",
        lines=lines,
        source=SourceIn(kind=SourceKind.PAYMENT, ref=order.po_no, vendor_id=order.vendor_id),
        posted_by_id=user.id,
        project_id=order.project_id,
        applied_to=[bill.id],
    )


async def cancel(
    session: AsyncSession, order_id: uuid.UUID, *, user: User, on: date
) -> PurchaseOrder:
    """Cancel an order and unwind whatever it posted.

    **Payments are reversed before the bill.** Reversing the bill first would leave payments
    applied to a reversed document — filtering only on ``source_kind = 'po'`` and missing
    the payments was a real bug the prototype's §63 exists to catch.

    Only this order's own catalogue reservations are released; a hold placed without a
    purchase order is somebody else's and stays.
    """
    order = await get_order(session, order_id)
    if order.status is PoStatus.CANCELLED:
        raise Conflict(f"{order.po_no} is already cancelled.")

    bill = await _bill_for(session, order)

    if bill is not None:
        settlements = list(
            (
                await session.execute(
                    select(JournalEntry)
                    .join(
                        EntryApplication,
                        EntryApplication.settling_entry_id == JournalEntry.id,
                    )
                    .where(
                        EntryApplication.settled_entry_id == bill.id,
                        JournalEntry.reversed_by_id.is_(None),
                    )
                )
            )
            .scalars()
            .all()
        )
        for settlement in settlements:
            await reverse_entry(session, entry_id=settlement.id, posted_by_id=user.id, on=on)

        await reverse_entry(session, entry_id=bill.id, posted_by_id=user.id, on=on)

    for booking in (
        (
            await session.execute(
                select(Booking).where(Booking.purchase_order_id == order.id)
            )
        )
        .scalars()
        .all()
    ):
        await session.delete(booking)

    order.status = PoStatus.CANCELLED
    await session.flush()
    return order


# ---------------------------------------------------------------------------
# Ageing
# ---------------------------------------------------------------------------

BUCKETS = ("current", "1-30", "31-60", "60+")


def bucket_for(due: date | None, as_of: date) -> str:
    if due is None:
        return "current"
    overdue = (as_of - due).days
    if overdue <= 0:
        return "current"
    if overdue <= 30:
        return "1-30"
    if overdue <= 60:
        return "31-60"
    return "60+"


@dataclass(slots=True)
class Ageing:
    buckets: dict[str, Decimal]
    counts: dict[str, int]
    total: Decimal
    overdue: Decimal
    withholding_owed: Decimal
    ledger_balance: Decimal
    difference: Decimal

    @property
    def reconciled(self) -> bool:
        return self.difference == ZERO


async def ageing(session: AsyncSession, *, as_of: date) -> Ageing:
    """AP ageing, reconciled against 2102, plus what is owed to the tax office."""
    from app.domain.reports.queries import account_balance

    items = await open_items(session, control=AP_CONTROL, side=Side.CREDIT, as_of=as_of)

    buckets = dict.fromkeys(BUCKETS, ZERO)
    counts = dict.fromkeys(BUCKETS, 0)
    total = ZERO
    overdue = ZERO

    for item in items:
        key = bucket_for(item.due or item.entry_date, as_of)
        buckets[key] += item.outstanding
        counts[key] += 1
        total += item.outstanding
        if key != "current":
            overdue += item.outstanding

    ledger = await account_balance(session, AP_CONTROL)

    return Ageing(
        buckets=buckets,
        counts=counts,
        total=money(total),
        overdue=money(overdue),
        withholding_owed=await account_balance(session, PPH23_PAYABLE),
        ledger_balance=ledger,
        difference=money(total) - ledger,
    )


__all__ = [
    "Ageing",
    "Payment",
    "ageing",
    "approve",
    "availability_status",
    "available_qty",
    "booked_qty",
    "bucket_for",
    "cancel",
    "dp_amount",
    "ensure_bill",
    "event_window",
    "get_order",
    "order_total",
    "pay_bill",
    "pay_down_payment",
    "settle",
    "variance",
    "vendor_rate",
]
