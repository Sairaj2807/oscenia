"""Client relationships: the people we work with, the events they run every year, greetings, and the
calendar of what to do when.

Reading needs the CRM module; every write needs ``edit_client``, the same permission as editing the
client record itself. Nothing here sends a message (see :mod:`app.domain.crm.relations`).
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, status
from starlette.responses import Response

from app.core.clock import ClockDep
from app.core.deps import require_action, require_module
from app.db.session import SessionDep
from app.domain.audit.service import record_audit
from app.domain.crm import relations
from app.domain.crm.schemas import (
    CalendarItem,
    ContactIn,
    ContactOut,
    ContactPatch,
    CycleIn,
    CycleOut,
    CyclePatch,
    GreetingMark,
    GreetingOut,
    HandledOut,
    NudgeHandle,
    RelationsOut,
    SettingsPatch,
)
from app.domain.masters.models import User

CrmUser = Annotated[User, Depends(require_module("crm"))]
EditsClient = Annotated[User, Depends(require_action("edit_client"))]

router = APIRouter(tags=["crm relations"])


@router.get("/clients/{client_id}/relations", response_model=RelationsOut)
async def get_relations(session: SessionDep, user: CrmUser, client_id: uuid.UUID) -> RelationsOut:
    return RelationsOut.model_validate(await relations.relations_of(session, client_id))


@router.patch("/clients/{client_id}/relations", response_model=RelationsOut)
async def patch_relations(
    session: SessionDep,
    user: EditsClient,
    client_id: uuid.UUID,
    body: SettingsPatch,
    request: Request,
) -> RelationsOut:
    """The anniversary, whether to greet it, and how many months ahead to nudge."""
    before, after = await relations.edit_settings(
        session, client_id, body.model_dump(exclude_unset=True)
    )
    await record_audit(
        session, actor=user, action="crm.relations.edit", entity_type="client",
        entity_id=client_id, before=before, after=after, request=request,
    )  # fmt: skip
    return RelationsOut.model_validate(await relations.relations_of(session, client_id))


@router.post(
    "/clients/{client_id}/contacts", response_model=ContactOut, status_code=status.HTTP_201_CREATED
)
async def add_contact(
    session: SessionDep, user: EditsClient, client_id: uuid.UUID, body: ContactIn, request: Request
) -> ContactOut:
    contact = await relations.add_contact(session, client_id, body.model_dump())
    await record_audit(
        session, actor=user, action="crm.contact.add", entity_type="client", entity_id=client_id,
        detail={"contact_id": str(contact.id)}, request=request,
    )  # fmt: skip
    return ContactOut.model_validate(contact)


@router.patch("/clients/{client_id}/contacts/{contact_id}", response_model=ContactOut)
async def edit_contact(
    session: SessionDep,
    user: EditsClient,
    client_id: uuid.UUID,
    contact_id: uuid.UUID,
    body: ContactPatch,
    request: Request,
) -> ContactOut:
    contact, before, after = await relations.edit_contact(
        session, client_id, contact_id, body.model_dump(exclude_unset=True)
    )
    await record_audit(
        session, actor=user, action="crm.contact.edit", entity_type="client", entity_id=client_id,
        before=before, after=after, detail={"contact_id": str(contact.id)}, request=request,
    )  # fmt: skip
    return ContactOut.model_validate(contact)


@router.delete("/clients/{client_id}/contacts/{contact_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_contact(
    session: SessionDep,
    user: EditsClient,
    client_id: uuid.UUID,
    contact_id: uuid.UUID,
    request: Request,
) -> Response:
    await relations.remove_contact(session, client_id, contact_id)
    await record_audit(
        session, actor=user, action="crm.contact.remove", entity_type="client",
        entity_id=client_id, detail={"contact_id": str(contact_id)}, request=request,
    )  # fmt: skip
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/clients/{client_id}/cycles", response_model=CycleOut, status_code=status.HTTP_201_CREATED
)
async def add_cycle(
    session: SessionDep, user: EditsClient, client_id: uuid.UUID, body: CycleIn, request: Request
) -> CycleOut:
    cycle = await relations.add_cycle(session, client_id, body.name, body.history)
    await record_audit(
        session, actor=user, action="crm.cycle.add", entity_type="client", entity_id=client_id,
        after={"name": cycle["name"], "history": cycle["history"]}, request=request,
    )  # fmt: skip
    return CycleOut.model_validate(cycle)


@router.patch("/clients/{client_id}/cycles/{cycle_id}", response_model=CycleOut)
async def edit_cycle(
    session: SessionDep,
    user: EditsClient,
    client_id: uuid.UUID,
    cycle_id: uuid.UUID,
    body: CyclePatch,
    request: Request,
) -> CycleOut:
    cycle = await relations.edit_cycle(
        session, client_id, cycle_id, name=body.name, history=body.history
    )
    await record_audit(
        session, actor=user, action="crm.cycle.edit", entity_type="client", entity_id=client_id,
        after={"name": cycle["name"], "history": cycle["history"]}, request=request,
    )  # fmt: skip
    return CycleOut.model_validate(cycle)


@router.delete("/clients/{client_id}/cycles/{cycle_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_cycle(
    session: SessionDep,
    user: EditsClient,
    client_id: uuid.UUID,
    cycle_id: uuid.UUID,
    request: Request,
) -> Response:
    cycle = await relations.remove_cycle(session, client_id, cycle_id)
    await record_audit(
        session, actor=user, action="crm.cycle.remove", entity_type="client",
        entity_id=client_id, detail={"name": cycle.name}, request=request,
    )  # fmt: skip
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/clients/{client_id}/nudges", response_model=HandledOut, status_code=status.HTTP_201_CREATED
)
async def handle_nudge(
    session: SessionDep,
    clock: ClockDep,
    user: EditsClient,
    client_id: uuid.UUID,
    body: NudgeHandle,
    request: Request,
) -> HandledOut:
    """Somebody reached out about an upcoming edition. It leaves the calendar, and a call is noted
    on the history of the client."""
    row = await relations.handle_nudge(
        session, client_id, key=body.key, note=body.note, user=user,
        today=clock.today(), now=clock.now(),
    )  # fmt: skip
    await record_audit(
        session, actor=user, action="crm.nudge.handle", entity_type="client", entity_id=client_id,
        detail={"key": row.key}, request=request,
    )  # fmt: skip
    return HandledOut.model_validate(row)


@router.post(
    "/clients/{client_id}/greetings",
    response_model=GreetingOut,
    status_code=status.HTTP_201_CREATED,
)
async def mark_greeting_sent(
    session: SessionDep,
    clock: ClockDep,
    user: EditsClient,
    client_id: uuid.UUID,
    body: GreetingMark,
    request: Request,
) -> GreetingOut:
    """Record that a greeting was sent by hand. This does not send anything."""
    row = await relations.mark_greeting_sent(
        session, client_id, kind=body.kind, to=body.to, channel=body.channel, year=body.year,
        user=user, today=clock.today(), now=clock.now(),
    )  # fmt: skip
    await record_audit(
        session, actor=user, action="crm.greeting.mark_sent", entity_type="client",
        entity_id=client_id, detail={"kind": row.kind, "year": row.occasion_year}, request=request,
    )  # fmt: skip
    return GreetingOut.model_validate(
        {
            "id": row.id,
            "kind": row.kind,
            "to": row.to_name,
            "channel": row.channel,
            "occasion_year": row.occasion_year,
            "marked_at": row.marked_at,
        }
    )


@router.get("/crm/calendar", response_model=list[CalendarItem])
async def relationship_calendar(
    session: SessionDep,
    clock: ClockDep,
    user: CrmUser,
    days: int = Query(default=90, ge=1, le=365),
    client_id: uuid.UUID | None = None,
) -> list[CalendarItem]:
    """What is coming up in the next ``days`` days across clients: event nudges (overdue first),
    contacts' birthdays and company anniversaries, each greeting with its text and send links."""
    return await relations.calendar(session, today=clock.today(), days=days, client_id=client_id)
