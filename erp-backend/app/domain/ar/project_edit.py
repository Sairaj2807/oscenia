"""Editing a project's name, division and event date.

Only those three. Money (contract value, estimated cost), the stage, the client and the quotation
are tied to documents and the ledger and are never edited here. A project name is only a label
(journal memos are snapshots and keep the old one), so it is always safe. The event date is the
one that fans out, so it is guarded and its consequences are spelled out:

* refused once the event has taken place (Post-Event Feedback or Finished), or if cancelled;
* invoices **not yet issued** (status ``Scheduled``) whose billing stage is anchored to the event
  get their due date recomputed from the new date (anchor and offset live on the quotation's
  stages); issued, part-paid and paid invoices are never touched;
* draft delivery orders and kit still in transit are given the new date;
* a linked event invitation is **not** changed: its date is part of what guests were shown, so the
  response says which events still carry the old date and staff update the invitation themselves.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

from fastapi import Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict, Invalid
from app.domain.ar import quotations
from app.domain.ar.models import (
    Invoice,
    InvoiceStatus,
    Project,
    QuotationStage,
    Stage,
    StageAnchor,
)
from app.domain.assets.models import (
    DeliveryOrder,
    DeliveryStatus,
    InventoryItem,
    InventoryStatus,
)
from app.domain.audit.service import record_audit, snapshot
from app.domain.masters.models import User

PROJECT_AUDIT = ("name", "division", "event_date")
#: The event has happened: its date is history.
DATE_LOCKED = (Stage.POST_EVENT_FEEDBACK, Stage.FINISHED)


@dataclass(slots=True)
class ProjectEdit:
    project: Project
    invoices_rescheduled: int = 0
    delivery_orders_updated: int = 0
    items_updated: int = 0
    warnings: list[str] = field(default_factory=list)


async def edit_project(
    session: AsyncSession,
    project_id: uuid.UUID,
    changes: dict[str, Any],
    *,
    actor: User,
    request: Request | None = None,
) -> ProjectEdit:
    """Apply ``name`` / ``division`` / ``event_date`` from ``changes`` (only the keys present)."""
    project = await quotations.get_project(session, project_id)
    if project.cancelled:
        raise Conflict("A cancelled project cannot be edited.")
    before = snapshot(project, PROJECT_AUDIT)
    result = ProjectEdit(project)

    if "name" in changes:
        name = " ".join(str(changes["name"] or "").split())
        if not name:
            raise Invalid("A project needs a name.")
        project.name = name[:200]
    if "division" in changes:
        division = " ".join(str(changes["division"] or "").split())
        if not division:
            raise Invalid("A project needs a division.")
        project.division = division[:64]

    new_date = changes.get("event_date")
    if "event_date" in changes:
        if not isinstance(new_date, date):
            raise Invalid("The event date must be a date.")
        if new_date != project.event_date:
            if project.stage in DATE_LOCKED:
                raise Conflict(
                    "The event has already taken place, so its date can no longer change."
                )
            project.event_date = new_date
            await _cascade(session, project, new_date, result)

    await session.flush()
    await record_audit(
        session, actor=actor, action="project.edit", entity_type="project", entity_id=project.id,
        before=before, after=snapshot(project, PROJECT_AUDIT),
        detail={
            "invoices_rescheduled": result.invoices_rescheduled,
            "delivery_orders_updated": result.delivery_orders_updated,
            "items_updated": result.items_updated,
        },
        request=request,
    )  # fmt: skip
    return result


async def _cascade(
    session: AsyncSession, project: Project, new_date: date, result: ProjectEdit
) -> None:
    # Invoices still only planned, whose due date hangs off the event.
    if project.quotation_id is not None:
        stages = {
            s.stage_no: s
            for s in (
                await session.execute(
                    select(QuotationStage).where(
                        QuotationStage.quotation_id == project.quotation_id
                    )
                )
            ).scalars()
        }
        invoices = (
            await session.execute(
                select(Invoice).where(
                    Invoice.project_id == project.id, Invoice.status == InvoiceStatus.SCHEDULED
                )
            )
        ).scalars()
        for invoice in invoices:
            stage = stages.get(invoice.stage_no)
            if stage is not None and stage.anchor is StageAnchor.EVENT:
                due = new_date + timedelta(days=stage.offset_days)
                if invoice.due_date != due:
                    invoice.due_date = due
                    result.invoices_rescheduled += 1

    for order in (
        await session.execute(
            select(DeliveryOrder).where(
                DeliveryOrder.project_id == project.id, DeliveryOrder.status == DeliveryStatus.DRAFT
            )
        )
    ).scalars():
        order.event_date = new_date
        result.delivery_orders_updated += 1

    for item in (
        await session.execute(
            select(InventoryItem).where(
                InventoryItem.project_id == project.id,
                InventoryItem.status == InventoryStatus.IN_TRANSIT,
            )
        )
    ).scalars():
        item.event_date = new_date
        result.items_updated += 1

    # Imported here: the events domain imports this one.
    from app.domain.events.models import Event

    for event in (
        await session.execute(select(Event).where(Event.project_id == project.id))
    ).scalars():
        if event.date != new_date:
            result.warnings.append(
                f"Event {event.event_no} still shows {event.date.isoformat()}: "
                "update its invitation details to match."
            )
