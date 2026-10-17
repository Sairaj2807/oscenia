"""The client's own rating link.

After an event the client is sent a link; opening it shows the event's name and ten stars, and
choosing one records the rating that decides the crew's bonuses. There is no sign-in, so the link
is the whole credential:

* **A signed token, not a stored one** (``core/links.py``): staff can copy it again and again, and
  nothing secret sits in the database. It expires (``survey_link_days``, default 30) and carries
  the project's ``survey_link_version``, so staff can revoke every copy by bumping the number.
* **Header, not address.** The token travels in ``X-Survey-Token``; the page keeps it after the
  ``#`` so it is never sent in a request line or kept in a proxy's access log.
* **One answer for every refusal.** A forged, expired, revoked or truncated token, a project that
  does not exist, one that is cancelled and one that has not reached Post-Event Feedback are all
  the same 404, so the link cannot be used to learn which projects exist or how far they are.
* **One rating, changeable until the pool is paid.** Rating again replaces the rating (a client who
  tapped the wrong star can fix it). Once the incentive pool has been disbursed the rating is what
  was paid on, and a change is refused (409), so a client cannot rewrite a payout after the fact.
* **Little is shown.** The page returns the event's name and date, the current rating and whether it
  is locked. Not the client, the money, the crew or the vendors.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal

from fastapi import Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import links
from app.core.config import get_settings
from app.core.errors import Conflict, NotFound
from app.domain.ar.models import Project
from app.domain.assets.models import ClientFeedback, IncentiveDisbursement
from app.domain.audit.service import record_audit
from app.domain.masters.models import User
from app.domain.payroll import service

PURPOSE = "survey"
#: What a client is told for every refusal, whatever the reason.
NOT_AVAILABLE = "This survey link is not available."


@dataclass(frozen=True, slots=True)
class SurveyView:
    project: Project
    rating: Decimal | None
    #: The pool has been paid on this rating, so it can no longer change.
    locked: bool


def ttl_seconds() -> int:
    return get_settings().survey_link_days * 24 * 60 * 60


async def issue_link(
    session: AsyncSession, project_id: uuid.UUID, *, now: datetime, regenerate: bool = False,
    actor: User, request: Request | None = None,
) -> tuple[Project, str, datetime]:  # fmt: skip
    """The link for a project, minted again each time it is asked for (same token until it
    expires). ``regenerate`` revokes every earlier copy first. Staff only; the project must be one a
    client can rate, so nobody sends a link that would only say "not available"."""
    project = (
        await session.execute(select(Project).where(Project.id == project_id).with_for_update())
    ).scalar_one_or_none()
    if project is None:
        raise NotFound(f"No project {project_id}.")
    service.ensure_ratable(project)
    if regenerate:
        project.survey_link_version += 1
        await session.flush()
        await record_audit(
            session, actor=actor, action="survey.link_regenerated", entity_type="project",
            entity_id=project.id, request=request,
        )  # fmt: skip
    ttl = ttl_seconds()
    token = links.issue(
        PURPOSE, project.project_no, project.survey_link_version,
        ttl_seconds=ttl, now=int(now.timestamp()),
    )  # fmt: skip
    return project, token, now + timedelta(seconds=ttl)


async def resolve(
    session: AsyncSession, project_no: str, token: str, *, now: datetime, lock: bool = False
) -> Project:
    """The project a token opens, or the one uniform refusal. ``lock`` holds the row, so two ratings
    sent at once are taken one after the other."""
    claim = links.read(PURPOSE, token, require_expiry=True, now=int(now.timestamp()))
    if claim is None or claim.subject != project_no:
        raise NotFound(NOT_AVAILABLE)
    stmt = select(Project).where(Project.project_no == project_no)
    project = (await session.execute(stmt.with_for_update() if lock else stmt)).scalar_one_or_none()
    if (
        project is None
        or claim.version != project.survey_link_version
        or project.cancelled
        or project.stage not in service.RATABLE_STAGES
    ):
        raise NotFound(NOT_AVAILABLE)
    return project


async def _view(session: AsyncSession, project: Project) -> SurveyView:
    row = (
        await session.execute(select(ClientFeedback).where(ClientFeedback.project_id == project.id))
    ).scalar_one_or_none()
    paid = (
        await session.execute(
            select(IncentiveDisbursement.id).where(IncentiveDisbursement.project_id == project.id)
        )
    ).first()
    return SurveyView(project=project, rating=row.score if row else None, locked=paid is not None)


async def read(session: AsyncSession, project_no: str, token: str, *, now: datetime) -> SurveyView:
    return await _view(session, await resolve(session, project_no, token, now=now))


async def rate(
    session: AsyncSession,
    project_no: str,
    token: str,
    score: int,
    *,
    now: datetime,
    request: Request | None = None,
) -> SurveyView:
    """Record (or change) the client's rating. 409 once the pool has been paid."""
    project = await resolve(session, project_no, token, now=now, lock=True)
    before = await _view(session, project)
    if before.locked:
        raise Conflict(
            "The crew bonuses for this event have been paid, so the rating can no longer change."
        )
    today: date = now.date()
    await service.record_feedback(
        session, project.id, score=Decimal(score), on=today, source="client", at=now
    )
    await record_audit(
        session, actor_label=f"client-survey:{project.project_no}", action="survey.rated",
        entity_type="project", entity_id=project.id,
        before={"score": str(before.rating)} if before.rating is not None else None,
        after={"score": str(score)}, request=request,
    )  # fmt: skip
    return await _view(session, project)
