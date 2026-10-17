"""The contact list across events, and marketing campaigns.

Reading the list and the campaigns needs the CRM module. Making a campaign, marking people
reached and unsubscribing a contact need ``manage_campaigns``. Nothing here sends a message (see
:mod:`app.domain.crm.campaigns`).
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Request, status
from starlette.responses import Response

from app.core.clock import ClockDep
from app.core.deps import require_action, require_module
from app.db.session import SessionDep
from app.domain.audit.service import record_audit
from app.domain.crm import campaigns
from app.domain.crm.schemas import (
    CampaignCreate,
    CampaignDetail,
    CampaignOut,
    GuestContactOut,
    RecipientOut,
    Unsubscribe,
    UnsubscribeOut,
)
from app.domain.masters.models import User

CrmUser = Annotated[User, Depends(require_module("crm"))]
RunsCampaigns = Annotated[User, Depends(require_action("manage_campaigns"))]

router = APIRouter(tags=["crm campaigns"])


@router.get("/crm/contacts", response_model=list[GuestContactOut])
async def list_contacts(
    session: SessionDep,
    user: CrmUser,
    event: str | None = None,
    attended: bool = False,
    consented: bool = False,
    q: str | None = None,
) -> list[GuestContactOut]:
    """Every guest from every event, pooled into one list and merged by phone. Guests who were
    erased or who gave no way to reach them are not in it."""
    return await campaigns.list_contacts(
        session, event_no=event, attended=attended, consented=consented, q=q
    )


@router.post("/crm/contacts/unsubscribe", response_model=UnsubscribeOut)
async def unsubscribe(
    session: SessionDep, clock: ClockDep, user: RunsCampaigns, body: Unsubscribe
) -> UnsubscribeOut:
    """Withdraw a contact's marketing consent. They are left out of every campaign from now on, and
    flagged in any they have not been reached by yet."""
    guests, pending = await campaigns.unsubscribe(session, body.key, user=user, now=clock.now())
    return UnsubscribeOut(guests=guests, pending_recipients=pending)


@router.post("/crm/campaigns", response_model=CampaignDetail, status_code=status.HTTP_201_CREATED)
async def create_campaign(
    session: SessionDep,
    clock: ClockDep,
    user: RunsCampaigns,
    body: CampaignCreate,
    request: Request,
) -> CampaignDetail:
    """Record a campaign to the contacts ticked.

    The audience is worked out here, from the keys alone: only contacts who agreed to marketing
    messages and can be reached on the channel are in it, and a campaign that would reach nobody is
    refused (422). The audience is fixed from then on."""
    campaign = await campaigns.create_campaign(
        session, user=user, name=body.name, channel=body.channel, message=body.message,
        keys=body.keys, now=clock.now(),
    )  # fmt: skip
    await record_audit(
        session, actor=user, action="crm.campaign.create", entity_type="campaign",
        entity_id=campaign.id,
        detail={
            "campaign_no": campaign.campaign_no,
            "channel": campaign.channel,
            "requested": campaign.requested_count,
            "skipped": campaign.skipped_count,
            "unreachable": campaign.unreachable_count,
        },
        request=request,
    )  # fmt: skip
    return await campaigns.detail(session, campaign.id)


@router.get("/crm/campaigns", response_model=list[CampaignOut])
async def list_campaigns(session: SessionDep, user: CrmUser) -> list[CampaignOut]:
    return await campaigns.list_campaigns(session)


@router.get("/crm/campaigns/{campaign_id}", response_model=CampaignDetail)
async def get_campaign(
    session: SessionDep, user: CrmUser, campaign_id: uuid.UUID
) -> CampaignDetail:
    return await campaigns.detail(session, campaign_id)


@router.get("/crm/campaigns/{campaign_id}/export")
async def export_campaign(session: SessionDep, user: CrmUser, campaign_id: uuid.UUID) -> Response:
    """The recipients as a CSV. A cell that starts like a formula is written as text."""
    body, filename = await campaigns.export_csv(session, campaign_id)
    return Response(
        content=body,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post(
    "/crm/campaigns/{campaign_id}/recipients/{recipient_id}/mark-sent",
    response_model=RecipientOut,
)
async def mark_recipient_sent(
    session: SessionDep,
    clock: ClockDep,
    user: RunsCampaigns,
    campaign_id: uuid.UUID,
    recipient_id: uuid.UUID,
    request: Request,
) -> RecipientOut:
    """Record that this person was reached, by hand. Nothing is sent."""
    await campaigns.mark_sent(session, campaign_id, recipient_id, user=user, now=clock.now())
    await record_audit(
        session, actor=user, action="crm.campaign.mark_sent", entity_type="campaign",
        entity_id=campaign_id, detail={"recipient_id": str(recipient_id)}, request=request,
    )  # fmt: skip
    found = await campaigns.detail(session, campaign_id)
    return next(r for r in found.recipients if r.id == recipient_id)


@router.post("/crm/campaigns/{campaign_id}/mark-sent", response_model=CampaignDetail)
async def mark_campaign_sent(
    session: SessionDep,
    clock: ClockDep,
    user: RunsCampaigns,
    campaign_id: uuid.UUID,
    request: Request,
) -> CampaignDetail:
    """Mark everyone still to be reached. Unsubscribed and erased people are left as they are."""
    count = await campaigns.mark_all_sent(session, campaign_id, user=user, now=clock.now())
    await record_audit(
        session, actor=user, action="crm.campaign.mark_all_sent", entity_type="campaign",
        entity_id=campaign_id, detail={"marked": count}, request=request,
    )  # fmt: skip
    return await campaigns.detail(session, campaign_id)
