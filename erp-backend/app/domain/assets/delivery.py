"""Delivery orders: the paperwork that travels with kit to an event.

A document, not a stock movement (see :class:`DeliveryOrder`). Draft -> Dispatched -> Received,
signed from the moment it is dispatched; nothing moves back, and a received order is final.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal

from fastapi import UploadFile
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.core.errors import Conflict, Invalid, NotFound
from app.core.storage import SIGNATURE, get_storage
from app.domain.ar.models import Project
from app.domain.assets.models import (
    DeliveryOrder,
    DeliveryOrderLine,
    DeliveryStatus,
    InventoryItem,
)
from app.domain.assets.schemas import DeliveryLineIn
from app.domain.cash.service import settings
from app.domain.masters.models import User

_NEXT = {
    DeliveryStatus.DRAFT: DeliveryStatus.DISPATCHED,
    DeliveryStatus.DISPATCHED: DeliveryStatus.RECEIVED,
}


async def list_orders(session: AsyncSession) -> list[DeliveryOrder]:
    rows = await session.execute(select(DeliveryOrder).order_by(DeliveryOrder.do_no.desc()))
    return list(rows.scalars().all())


async def create_order(
    session: AsyncSession,
    *,
    user: User,
    project_id: uuid.UUID,
    event_date: date | None,
    lines: list[DeliveryLineIn],
) -> DeliveryOrder:
    project = await session.get(Project, project_id)
    if project is None:
        raise NotFound(f"No project {project_id}.")
    if project.cancelled:
        raise Conflict(f"{project.project_no} is cancelled; kit cannot be sent to it.")

    built: list[DeliveryOrderLine] = []
    for number, line in enumerate(lines, start=1):
        label = (line.item or "").strip()
        if line.inventory_item_id is not None:
            stock = await session.get(InventoryItem, line.inventory_item_id)
            if stock is None:
                raise NotFound(f"No stock item {line.inventory_item_id}.")
            if stock.archived_at is not None:
                raise Conflict(f"{stock.item} is archived and cannot go on a delivery order.")
            label = label or stock.item
        if not label:
            raise Invalid(f"Line {number} needs an item: a stock item or a description.")
        built.append(
            DeliveryOrderLine(
                line_no=number,
                inventory_item_id=line.inventory_item_id,
                item_label=label,
                qty=line.qty.quantize(Decimal("0.01")),
            )
        )

    n = (await session.execute(func.nextval("delivery_order_no_seq"))).scalar_one()
    order = DeliveryOrder(
        do_no=f"DO-{n}",
        project_id=project_id,
        event_date=event_date if event_date is not None else project.event_date,
        created_by_user_id=user.id,
    )
    order.lines = built
    session.add(order)
    await session.flush()
    return order


async def _locked(session: AsyncSession, order_id: uuid.UUID) -> DeliveryOrder:
    order = (
        await session.execute(
            select(DeliveryOrder).where(DeliveryOrder.id == order_id).with_for_update()
        )
    ).scalar_one_or_none()
    if order is None:
        raise NotFound(f"No delivery order {order_id}.")
    return order


async def sign(
    session: AsyncSession,
    order_id: uuid.UUID,
    *,
    file: UploadFile,
    signed_by_name: str,
    now: datetime,
) -> DeliveryOrder:
    """Attach the recipient's drawn signature to a draft order.

    The file is a PNG from a canvas, checked against its own bytes and re-encoded by the store like
    any picture. It can be replaced while the order is a draft; once dispatched it is the record.
    """
    name = " ".join(signed_by_name.split())
    if not name:
        raise Invalid("Say who signed.")
    order = await _locked(session, order_id)
    if order.status is not DeliveryStatus.DRAFT:
        raise Conflict(f"{order.do_no} has been dispatched; its signature is final.")
    stored = await run_in_threadpool(
        get_storage().save,
        file.file,
        kind=SIGNATURE,
        content_type=file.content_type or "application/octet-stream",
        filename=file.filename or "signature.png",
    )
    order.signature_key = stored.storage_key
    order.signed_by_name = name[:120]
    order.signed_at = now
    await session.flush()
    return order


async def advance(session: AsyncSession, order_id: uuid.UUID, *, on: date) -> DeliveryOrder:
    """Draft -> Dispatched (signed) -> Received. Anything else is refused."""
    order = await _locked(session, order_id)
    following = _NEXT.get(order.status)
    if following is None:
        raise Conflict(f"{order.do_no} has been received; there is nothing after that.")
    if (
        following is DeliveryStatus.DISPATCHED
        and order.signature_key is None
        and not (await settings(session)).allow_unsigned_dispatch
    ):
        raise Conflict(f"{order.do_no} needs the recipient's signature before it is dispatched.")
    order.status = following
    if following is DeliveryStatus.DISPATCHED:
        # Signed means a signature is on file; with the setting on, an unsigned dispatch says so.
        order.signed = order.signature_key is not None
        order.dispatched_on = on
    else:
        order.received_on = on
    await session.flush()
    return order
