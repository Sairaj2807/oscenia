"""Cancelling a project: what the prototype's ``cancelProject`` does, on the server.

Three things happen, in this order:

1. **Purchase orders still live on the project are cancelled with it** (settled ones are history,
   and cancelled ones are already done). Each cancellation unwinds what that order posted, by the
   same rule as cancelling it by hand.
2. **With a refund, the client's money goes back**: every receipt is reversed first, then the
   invoice entry it settled — the other order would leave a payment applied to a reversed
   document. Without a refund the revenue stays, because the contract says the deposit is not
   refundable.
3. **Open invoices are cancelled** so nothing keeps asking the client for money on a dead project.
   Invoices already paid stay paid unless they were refunded.

Costs already incurred (a settled order, petty cash) are never reversed either way: they were
really spent, and unwinding them would flatter the project's P&L.

This replaces the first cut, which called ``undo_down_payment`` for a refund. That is a stricter
operation — it refuses once anything else has happened on the project — and the common reason to
cancel *is* that something has happened.
"""

from __future__ import annotations

import uuid
from datetime import date

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict
from app.domain.ap import service as ap
from app.domain.ap.models import PoStatus, PurchaseOrder
from app.domain.ar import quotations
from app.domain.ar.models import Invoice, InvoiceStatus, Project
from app.domain.ledger.models import EntryApplication, JournalEntry
from app.domain.ledger.posting import reverse_entry
from app.domain.masters.models import User

_OPEN = (InvoiceStatus.SCHEDULED, InvoiceStatus.UNPAID, InvoiceStatus.PARTIALLY_PAID)


async def cancel_project(
    session: AsyncSession,
    project_id: uuid.UUID,
    *,
    user: User,
    on: date,
    reason: str,
    refund_dp: bool,
) -> Project:
    project = await quotations.get_project(session, project_id)
    if project.cancelled:
        raise Conflict(f"{project.project_no} is already cancelled.")

    orders = (
        (
            await session.execute(
                select(PurchaseOrder).where(
                    PurchaseOrder.project_id == project_id,
                    PurchaseOrder.status.notin_([PoStatus.SETTLED, PoStatus.CANCELLED]),
                )
            )
        )
        .scalars()
        .all()
    )
    for order in orders:
        await ap.cancel(session, order.id, user=user, on=on)

    invoices = list(
        (await session.execute(select(Invoice).where(Invoice.project_id == project_id)))
        .scalars()
        .all()
    )

    if refund_dp:
        recognitions = {inv.recognition_entry_id for inv in invoices if inv.recognition_entry_id}
        receipts = list(
            (
                await session.execute(
                    select(JournalEntry)
                    .join(EntryApplication, EntryApplication.settling_entry_id == JournalEntry.id)
                    .where(
                        EntryApplication.settled_entry_id.in_(recognitions or [uuid.uuid4()]),
                        JournalEntry.reversed_by_id.is_(None),
                    )
                )
            )
            .scalars()
            .all()
        )
        for receipt in receipts:
            await reverse_entry(session, entry_id=receipt.id, posted_by_id=user.id, on=on)
        for entry_id in recognitions:
            entry = await session.get(JournalEntry, entry_id)
            if entry is not None and entry.reversed_by_id is None:
                await reverse_entry(session, entry_id=entry_id, posted_by_id=user.id, on=on)
        for invoice in invoices:
            invoice.status = InvoiceStatus.CANCELLED
    else:
        for invoice in invoices:
            if invoice.status in _OPEN:
                invoice.status = InvoiceStatus.CANCELLED

    project.cancelled = True
    project.cancelled_at = on
    project.cancel_reason = reason or None
    project.dp_refunded = refund_dp
    await session.flush()
    return project
