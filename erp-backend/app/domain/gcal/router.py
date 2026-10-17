"""Google Calendar endpoints.

``/google/callback`` is the one route Google itself calls (with the person's browser), so it cannot
carry a bearer token: the signed ``state`` made by ``/google/connect`` is what says who is
returning, and it expires in ten minutes. It ends by redirecting the browser back to the app.
"""

from __future__ import annotations

from datetime import date
from typing import Any
from urllib.parse import urlencode

from fastapi import APIRouter, Query
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from app.core.clock import ClockDep
from app.core.config import get_settings
from app.core.deps import CurrentUser
from app.core.errors import Conflict, Invalid
from app.db.session import SessionDep
from app.domain.gcal import service

router = APIRouter(prefix="/google", tags=["google calendar"])


class StatusOut(BaseModel):
    #: False until the server has Google credentials and a token key; the screen says so plainly.
    configured: bool
    connected: bool
    account: str | None = None
    #: Whether CRM dates can be added to the calendar (the wider permission was granted).
    can_write: bool = False
    show_google: bool = True
    add_crm_dates: bool = False


class ConnectOut(BaseModel):
    url: str


class OptionsIn(BaseModel):
    show_google: bool | None = None
    add_crm_dates: bool | None = None


class EventOut(BaseModel):
    id: str
    title: str
    date: str
    all_day: bool
    time: str | None = None


class SyncOut(BaseModel):
    added: int
    already_there: int
    considered: int
    error: str | None = None


@router.get("/status", response_model=StatusOut)
async def status(session: SessionDep, user: CurrentUser) -> StatusOut:
    connection = await service.get_connection(session, user)
    if connection is None:
        return StatusOut(configured=service.configured(), connected=False)
    return StatusOut(
        configured=service.configured(),
        connected=True,
        account=connection.account_email,
        can_write=service.can_write(connection),
        show_google=connection.show_google,
        add_crm_dates=connection.add_crm_dates,
    )


@router.get("/connect", response_model=ConnectOut)
async def connect(user: CurrentUser, write: bool = False) -> ConnectOut:
    """Where to send the person to sign in at Google; ``write`` asks to be able to add events."""
    return ConnectOut(url=service.connect_url(user, write=write))


@router.get("/callback")
async def callback(
    session: SessionDep,
    state: str = Query(default=""),
    code: str = Query(default=""),
    error: str = Query(default=""),
) -> RedirectResponse:
    """Google sends the browser back here. Always ends by returning to the app, with the outcome."""
    back = get_settings().google_return_url
    if error or not code:
        return RedirectResponse(f"{back}?{urlencode({'google': 'declined'})}")
    try:
        await service.complete_connection(session, state=state, code=code)
    except (Invalid, Conflict) as refusal:
        return RedirectResponse(
            f"{back}?{urlencode({'google': 'failed', 'reason': str(refusal.detail)[:200]})}"
        )
    return RedirectResponse(f"{back}?{urlencode({'google': 'connected'})}")


@router.delete("/connection", status_code=204)
async def disconnect(session: SessionDep, user: CurrentUser) -> None:
    await service.disconnect(session, user)


@router.put("/options", response_model=StatusOut)
async def options(session: SessionDep, user: CurrentUser, body: OptionsIn) -> StatusOut:
    connection = await service.set_options(
        session, user, show_google=body.show_google, add_crm_dates=body.add_crm_dates
    )
    return StatusOut(
        configured=service.configured(),
        connected=True,
        account=connection.account_email,
        can_write=service.can_write(connection),
        show_google=connection.show_google,
        add_crm_dates=connection.add_crm_dates,
    )


@router.get("/events", response_model=list[EventOut])
async def events(
    session: SessionDep,
    user: CurrentUser,
    start: date,
    end: date,
) -> list[dict[str, Any]]:
    """The signed-in person's own Google events between two dates (up to 250)."""
    return await service.events_between(session, user, start, end)


@router.post("/sync-crm-dates", response_model=SyncOut)
async def sync_crm_dates(session: SessionDep, clock: ClockDep, user: CurrentUser) -> dict[str, Any]:
    """Write the next 60 days of client birthdays and anniversaries to this person's calendar."""
    return await service.sync_crm_dates(session, user, today=clock.today())
