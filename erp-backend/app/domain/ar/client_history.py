"""A client's history, derived from what is already recorded (no new tables).

Worth, per the scheduled-job note that lifetime value is "derived on read, never stored", is read
here from the projects, invoices, ratings and purchase orders. Three figures, each named for what it
is, because "lifetime value" can mean any of them:

* ``contracted``: the contract value of the client's projects that were not cancelled;
* ``invoiced``: invoices that have been issued (unpaid, part paid or paid) on those projects;
* ``collected``: invoices that are fully paid (a part payment is only in the ledger).

Satisfaction is the post-event client rating (0-10) the payroll screen already records, one per
project; the client's own average is the mean over their projects that have one.
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import NotFound
from app.core.money import ZERO, money
from app.domain.ap.models import PoStatus, PurchaseOrder, Vendor
from app.domain.ar.models import Client, Invoice, InvoiceStatus, Project, Quotation
from app.domain.assets.models import ClientFeedback

#: Spend with a vendor counts once the order is committed, not while it is a draft or was cancelled.
SPEND_STATUSES = (PoStatus.APPROVED, PoStatus.DP_PAID, PoStatus.SETTLED)
ISSUED = (InvoiceStatus.UNPAID, InvoiceStatus.PARTIALLY_PAID, InvoiceStatus.PAID)


async def client_history(session: AsyncSession, client_id: uuid.UUID) -> dict[str, Any]:
    if await session.get(Client, client_id) is None:
        raise NotFound(f"No client {client_id}.")

    projects = (
        (
            await session.execute(
                select(Project)
                .where(Project.client_id == client_id)
                .order_by(Project.event_date.desc().nulls_last(), Project.project_no.desc())
            )
        )
        .scalars()
        .all()
    )
    ids = [p.id for p in projects]

    types: dict[uuid.UUID, str | None] = {}
    quotation_ids = [p.quotation_id for p in projects if p.quotation_id is not None]
    if quotation_ids:
        for qid, event_type in (
            await session.execute(
                select(Quotation.id, Quotation.event_type).where(Quotation.id.in_(quotation_ids))
            )
        ).all():
            types[qid] = event_type

    ratings: dict[uuid.UUID, Decimal] = {}
    invoiced: dict[uuid.UUID, Decimal] = defaultdict(lambda: ZERO)
    collected: dict[uuid.UUID, Decimal] = defaultdict(lambda: ZERO)
    vendor_spend: dict[uuid.UUID, dict[uuid.UUID, Decimal]] = defaultdict(
        lambda: defaultdict(lambda: ZERO)
    )
    vendor_names: dict[uuid.UUID, str] = {}
    if ids:
        for pid, score in (
            await session.execute(
                select(ClientFeedback.project_id, ClientFeedback.score).where(
                    ClientFeedback.project_id.in_(ids)
                )
            )
        ).all():
            ratings[pid] = score
        for inv in (
            await session.execute(
                select(Invoice).where(Invoice.project_id.in_(ids), Invoice.status.in_(ISSUED))
            )
        ).scalars():
            invoiced[inv.project_id] += inv.amount
            if inv.status is InvoiceStatus.PAID:
                collected[inv.project_id] += inv.amount
        for po, vendor in (
            await session.execute(
                select(PurchaseOrder, Vendor)
                .join(Vendor, Vendor.id == PurchaseOrder.vendor_id)
                .where(PurchaseOrder.project_id.in_(ids), PurchaseOrder.status.in_(SPEND_STATUSES))
            )
        ).all():
            total = sum((ln.qty * ln.unit_price for ln in po.lines), start=ZERO)
            vendor_spend[po.project_id][vendor.id] += total
            vendor_names[vendor.id] = vendor.name

    events: list[dict[str, Any]] = []
    totals_by_type: dict[str, int] = defaultdict(int)
    totals_by_vendor: dict[uuid.UUID, dict[str, Any]] = {}
    contracted = invoiced_total = collected_total = ZERO
    for p in projects:
        event_type = types.get(p.quotation_id) if p.quotation_id else None
        spend = vendor_spend.get(p.id, {})
        events.append(
            {
                "project_id": p.id, "project_no": p.project_no, "name": p.name,
                "event_date": p.event_date, "event_type": event_type, "division": p.division,
                "contract_value": money(p.contract_value), "stage": p.stage.value,
                "cancelled": p.cancelled,
                "rating": ratings.get(p.id),
                "invoiced": money(invoiced.get(p.id, ZERO)),
                "collected": money(collected.get(p.id, ZERO)),
                "vendors": sorted(
                    (
                        {"vendor_id": vid, "name": vendor_names[vid], "spend": money(amount)}
                        for vid, amount in spend.items()
                    ),
                    key=lambda v: -v["spend"],
                ),
            }
        )  # fmt: skip
        if p.cancelled:
            continue
        contracted += p.contract_value
        invoiced_total += invoiced.get(p.id, ZERO)
        collected_total += collected.get(p.id, ZERO)
        if event_type:
            totals_by_type[event_type] += 1
        for vid, amount in spend.items():
            row = totals_by_vendor.setdefault(
                vid, {"vendor_id": vid, "name": vendor_names[vid], "events": 0, "spend": ZERO}
            )
            row["events"] += 1
            row["spend"] += amount

    scores = [ratings[p.id] for p in projects if p.id in ratings and not p.cancelled]
    return {
        "client_id": client_id,
        "contracted": money(contracted),
        "invoiced": money(invoiced_total),
        "collected": money(collected_total),
        "event_count": sum(1 for p in projects if not p.cancelled),
        "avg_rating": (sum(scores, start=ZERO) / len(scores)).quantize(Decimal("0.1"))
        if scores
        else None,
        "preferred_event_types": [
            {"event_type": t, "count": n}
            for t, n in sorted(totals_by_type.items(), key=lambda kv: (-kv[1], kv[0]))
        ],
        "vendors_used": sorted(
            ({**v, "spend": money(v["spend"])} for v in totals_by_vendor.values()),
            key=lambda v: (-v["spend"], v["name"]),
        ),
        "events": events,
    }

