"""``GET /notifications`` — the bell's events and CRM items. See ``service`` for the rules."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query

from app.core.clock import ClockDep
from app.core.deps import CurrentUser
from app.db.session import SessionDep
from app.domain.notifications import service
from app.domain.notifications.service import NotificationItem

router = APIRouter(prefix="/notifications", tags=["notifications"])


@router.get("", response_model=list[NotificationItem])
async def list_notifications(
    session: SessionDep,
    clock: ClockDep,
    user: CurrentUser,
    limit: Annotated[int, Query(ge=1, le=100)] = service.DEFAULT_LIMIT,
) -> list[NotificationItem]:
    """Invitations waiting for review, recent RSVPs, and client birthdays and anniversaries —
    each only if the caller's role may see that module. Any signed-in login may ask: a role
    with none of those modules simply gets an empty list. Chat's items are separate
    (``/chat/notifications``) because they need a workspace persona and these do not."""
    return await service.build(session, user, clock, limit=limit)
