"""Crew, client feedback and the incentive pool."""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, Request, status
from pydantic import BaseModel, ConfigDict

from app.core.clock import ClockDep
from app.core.deps import CurrentUser, ManagesWorkspace, require_action
from app.core.schemas import MoneyStr, Schema
from app.db.session import SessionDep
from app.domain.masters.models import User
from app.domain.payroll import service, survey

ApprovesIncentive = Annotated[User, Depends(require_action("approve_incentive"))]

router = APIRouter(tags=["payroll"])


class CrewCreate(BaseModel):
    name: str
    base_rate: Decimal
    role: str | None = None
    last_rating: Decimal = Decimal("0")


class CrewOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    crew_no: str
    name: str
    role: str | None
    base_rate: MoneyStr
    last_rating: Decimal
    active: bool
    deactivated_on: date | None


class CrewPatch(BaseModel):
    """Send only what changes."""

    name: str | None = None
    role: str | None = None
    base_rate: Decimal | None = None
    last_rating: Decimal | None = None


class FeedbackRequest(BaseModel):
    score: Decimal
    submitted_on: date | None = None


class BonusRowOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    crew_id: uuid.UUID
    crew_no: str
    name: str
    role: str | None
    base_rate: MoneyStr
    rating: Decimal
    qualifies: bool
    bonus: MoneyStr
    total: MoneyStr


class PoolOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    project_id: uuid.UUID
    event_score: Decimal | None
    threshold: Decimal
    rows: list[BonusRowOut]
    pool: MoneyStr
    below_threshold: int
    disbursed: bool


class DisburseRequest(BaseModel):
    #: **Mandatory.** Absent, the bonus lands on no project P&L at all, so it is refused.
    project_id: uuid.UUID | None = None
    amount: Decimal | None = None
    disbursed_on: date | None = None


class DisbursementOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    amount: MoneyStr
    entry_id: uuid.UUID
    disbursed_on: date


@router.get("/crew", response_model=list[CrewOut])
async def list_crew(session: SessionDep, user: CurrentUser) -> list[CrewOut]:
    return [CrewOut.model_validate(row) for row in await service.list_crew(session)]


@router.post("/crew", response_model=CrewOut, status_code=status.HTTP_201_CREATED)
async def add_crew(session: SessionDep, user: ApprovesIncentive, body: CrewCreate) -> CrewOut:
    member = await service.add_crew(
        session,
        name=body.name,
        base_rate=body.base_rate,
        role=body.role,
        last_rating=body.last_rating,
    )
    return CrewOut.model_validate(member)


@router.patch("/crew/{crew_id}", response_model=CrewOut)
async def update_crew(
    session: SessionDep, user: ApprovesIncentive, crew_id: uuid.UUID, body: CrewPatch,
    request: Request,
) -> CrewOut:  # fmt: skip
    """Edit a crew member. A paid pool keeps its snapshot; a new rate applies to the rest."""
    member = await service.update_crew(
        session, crew_id, body.model_dump(exclude_unset=True), actor=user, request=request
    )
    return CrewOut.model_validate(member)


@router.post("/crew/{crew_id}/deactivate", response_model=CrewOut)
async def deactivate_crew(
    session: SessionDep, clock: ClockDep, user: ApprovesIncentive, crew_id: uuid.UUID,
    request: Request,
) -> CrewOut:  # fmt: skip
    return CrewOut.model_validate(
        await service.set_crew_active(
            session, crew_id, False, on=clock.today(), actor=user, request=request
        )
    )


@router.post("/crew/{crew_id}/reactivate", response_model=CrewOut)
async def reactivate_crew(
    session: SessionDep, clock: ClockDep, user: ApprovesIncentive, crew_id: uuid.UUID,
    request: Request,
) -> CrewOut:  # fmt: skip
    return CrewOut.model_validate(
        await service.set_crew_active(
            session, crew_id, True, on=clock.today(), actor=user, request=request
        )
    )


@router.delete("/crew/{crew_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_crew(
    session: SessionDep, user: ApprovesIncentive, crew_id: uuid.UUID, request: Request
) -> None:
    """For a member added by mistake. 409 once they may have been paid: deactivate instead."""
    await service.delete_crew(session, crew_id, actor=user, request=request)


@router.put("/projects/{project_id}/feedback", response_model=PoolOut)
async def record_feedback(
    session: SessionDep,
    clock: ClockDep,
    user: CurrentUser,
    project_id: uuid.UUID,
    body: FeedbackRequest,
) -> PoolOut:
    """Record the post-event client rating, and return the pool it implies.

    Once a rating exists every crew member is scored on that one event rating rather than
    their own historical average — which is what "performance bonuses updated from client
    rating" means on the Payroll screen.
    """
    await service.record_feedback(
        session, project_id, score=body.score, on=body.submitted_on or clock.today()
    )
    return PoolOut.model_validate(await service.pool_for(session, project_id))


class SurveyLinkOut(Schema):
    project_no: str
    #: The signed token. The page puts it after the ``#`` of ``/rate/<project_no>``.
    token: str
    expires_at: datetime


@router.get("/projects/{project_id}/survey-link", response_model=SurveyLinkOut)
async def survey_link(
    session: SessionDep, clock: ClockDep, user: ManagesWorkspace, project_id: uuid.UUID,
    request: Request,
) -> SurveyLinkOut:  # fmt: skip
    """The link to send the client so they can rate the event themselves. The same token each time
    until it expires; 409 for a project a client cannot rate yet (or any more)."""
    project, token, expires = await survey.issue_link(
        session, project_id, now=clock.now(), actor=user, request=request
    )
    return SurveyLinkOut(project_no=project.project_no, token=token, expires_at=expires)


@router.post("/projects/{project_id}/survey-link/regenerate", response_model=SurveyLinkOut)
async def regenerate_survey_link(
    session: SessionDep, clock: ClockDep, user: ManagesWorkspace, project_id: uuid.UUID,
    request: Request,
) -> SurveyLinkOut:  # fmt: skip
    """Revoke every copy of the link already sent and return a fresh one."""
    project, token, expires = await survey.issue_link(
        session, project_id, now=clock.now(), regenerate=True, actor=user, request=request
    )
    return SurveyLinkOut(project_no=project.project_no, token=token, expires_at=expires)


@router.get("/projects/{project_id}/incentives", response_model=PoolOut)
async def incentive_pool(session: SessionDep, user: CurrentUser, project_id: uuid.UUID) -> PoolOut:
    """What the crew would be paid, computed live.

    ``bonus = base_rate × (rating ÷ 10)``, gated by the minimum threshold. Nothing is cached:
    a rate change or a re-rating moves the number immediately.
    """
    return PoolOut.model_validate(await service.pool_for(session, project_id))


@router.post(
    "/incentives/disburse",
    response_model=DisbursementOut,
    status_code=status.HTTP_201_CREATED,
)
async def disburse(
    session: SessionDep, clock: ClockDep, user: ApprovesIncentive, body: DisburseRequest
) -> DisbursementOut:
    """Pay the pool, tagged to a project.

    **The project tag is mandatory** — without it the cost allocates nowhere, so the request
    is refused with 422 and nothing is posted. Paying twice is refused with 409.
    """
    record = await service.disburse(
        session,
        project_id=body.project_id,
        user=user,
        on=body.disbursed_on or clock.today(),
        amount=body.amount,
    )
    return DisbursementOut.model_validate(record)
