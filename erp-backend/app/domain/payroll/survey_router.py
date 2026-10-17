"""The client's rating page, no sign-in (``/public/survey``). The rules are in ``survey.py``."""

from __future__ import annotations

import re
from datetime import date
from typing import Annotated

from fastapi import APIRouter, Header, Request, Response
from pydantic import BaseModel, Field

from app.core.clock import ClockDep
from app.core.errors import NotFound, TooManyAttempts
from app.core.schemas import Schema
from app.core.throttle import Throttle
from app.db.session import SessionDep
from app.domain.payroll import survey

router = APIRouter(prefix="/public/survey", tags=["public"])

#: Per caller. A forged token counts like any other attempt, so the link cannot be guessed at.
survey_throttle = Throttle("pub-survey", limit=20, window_seconds=60, block_seconds=300)

_PROJECT_NO = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
TokenHeader = Annotated[str | None, Header(alias="X-Survey-Token")]


class SurveyPage(Schema):
    project_no: str
    name: str
    event_date: date | None
    #: The rating given so far (out of ten), if any.
    rating: float | None
    #: The crew bonuses were paid on it, so it can no longer change.
    locked: bool


class SurveyIn(BaseModel):
    #: Ten stars: a whole number from 1 to 10.
    score: int = Field(ge=1, le=10)


async def _limited(session: SessionDep, request: Request) -> None:
    who = request.client.host if request.client else "unknown"
    verdict = await survey_throttle.attempt(session, [f"ip:{who}"])
    await session.commit()  # counted before any refusal, or the limit never trips
    if not verdict.allowed:
        raise TooManyAttempts("Too many tries. Try again shortly.", retry_after=verdict.retry_after)


def _page(view: survey.SurveyView) -> SurveyPage:
    return SurveyPage(
        project_no=view.project.project_no,
        name=view.project.name,
        event_date=view.project.event_date,
        rating=float(view.rating) if view.rating is not None else None,
        locked=view.locked,
    )


def _checked(project_no: str, token: str | None) -> str:
    # A malformed number or a missing token is the same refusal as a wrong one.
    if not _PROJECT_NO.match(project_no) or not token:
        raise NotFound(survey.NOT_AVAILABLE)
    return token[:200]


@router.get("/{project_no}", response_model=SurveyPage)
async def read_survey(
    project_no: str,
    session: SessionDep,
    clock: ClockDep,
    request: Request,
    response: Response,
    x_survey_token: TokenHeader = None,
) -> SurveyPage:
    response.headers["Cache-Control"] = "no-store"
    await _limited(session, request)
    token = _checked(project_no, x_survey_token)
    return _page(await survey.read(session, project_no, token, now=clock.now()))


@router.post("/{project_no}", response_model=SurveyPage)
async def submit_survey(
    project_no: str,
    body: SurveyIn,
    session: SessionDep,
    clock: ClockDep,
    request: Request,
    response: Response,
    x_survey_token: TokenHeader = None,
) -> SurveyPage:
    response.headers["Cache-Control"] = "no-store"
    await _limited(session, request)
    token = _checked(project_no, x_survey_token)
    view = await survey.rate(
        session, project_no, token, body.score, now=clock.now(), request=request
    )
    return _page(view)
