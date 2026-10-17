"""FastAPI application factory."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import APIRouter, Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from app.core.access import enforce_access
from app.core.body_limit import PublicBodyLimit
from app.core.clock import ClockDep
from app.core.config import get_settings
from app.core.errors import install_error_handlers
from app.core.logging import configure_logging, install_request_id
from app.db.session import SessionDep, dispose_engine
from app.domain.accounts.router import router as accounts_router
from app.domain.ap.router import router as ap_router
from app.domain.ar.router import router as ar_router
from app.domain.assets.router import router as assets_router
from app.domain.auth.admin_router import public_router as password_reset_router
from app.domain.auth.admin_router import users_router
from app.domain.auth.router import router as auth_router
from app.domain.cash.router import router as cash_router
from app.domain.chat.hub import get_hub
from app.domain.chat.meeting_router import router as chat_meeting_router
from app.domain.chat.router import router as chat_router
from app.domain.chat.ws import router as chat_ws_router
from app.domain.crm.campaigns_router import router as crm_campaigns_router
from app.domain.crm.router import router as crm_router
from app.domain.events.public import router as public_router
from app.domain.events.router import router as events_router
from app.domain.events.router import templates_router as invitation_templates_router
from app.domain.files.router import router as files_router
from app.domain.gcal.router import router as gcal_router
from app.domain.ledger.router import router as ledger_router
from app.domain.masters.router import router as masters_router
from app.domain.notifications.router import router as notifications_router
from app.domain.payroll.router import router as payroll_router
from app.domain.payroll.survey_router import router as survey_router
from app.domain.reports.router import router as reports_router
from app.domain.search.router import router as search_router
from app.domain.workspace.router import router as workspace_router
from app.jobs.router import router as jobs_router

log = logging.getLogger("app")

health = APIRouter(tags=["ops"])


@health.get("/health")
async def health_check(session: SessionDep, clock: ClockDep) -> dict[str, Any]:
    """Liveness plus a real database round-trip.

    A health check that does not touch the database is a health check that stays green
    while every request fails.
    """
    result = await session.execute(text("SELECT 1"))
    return {
        "status": "ok",
        "database": "ok" if result.scalar_one() == 1 else "unexpected",
        "today": clock.today().isoformat(),
        "env": get_settings().env,
    }


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    """Start the scheduler if it is switched on, and always let go of the engine."""
    scheduler = None
    if get_settings().scheduler_enabled:
        from app.jobs.scheduler import build_scheduler

        scheduler = build_scheduler()
        scheduler.start()
        log.info("scheduler started with %d jobs", len(scheduler.get_jobs()))

    try:
        yield
    finally:
        # Close chat sockets politely and give up the hub lock before the engine goes.
        await get_hub().shutdown()
        if scheduler is not None:
            # Do not wait on a running job: a month-end posting that is mid-flight has
            # already claimed its row, so the retry after restart is safe and blocking
            # shutdown on it is not worth the hang.
            scheduler.shutdown(wait=False)
        await dispose_engine()


def create_app() -> FastAPI:
    settings = get_settings()

    app = FastAPI(
        title="Oscenia ERP — Finance API",
        version="0.1.0",
        description=(
            "Double-entry ledger, AR, AP, cash, fixed assets and project P&L for Oscenia "
            "Events. Journals are append-only; corrections are reverse-and-repost."
        ),
        lifespan=lifespan,
        debug=settings.debug,
    )

    configure_logging(level=settings.log_level, as_json=settings.log_json)
    install_request_id(app)

    # Inside CORS, so a refused body still carries the CORS headers the browser needs to read it.
    app.add_middleware(PublicBodyLimit)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    install_error_handlers(app)

    app.include_router(health)

    # Domain routers, registered as each phase lands.
    prefix = settings.api_prefix
    # Role check for the routes that used to need only a login (see app/core/access.py).
    guarded = [Depends(enforce_access)]
    app.include_router(auth_router, prefix=prefix)
    app.include_router(users_router, prefix=prefix)
    app.include_router(password_reset_router, prefix=prefix)
    app.include_router(accounts_router, prefix=prefix, dependencies=guarded)
    app.include_router(ap_router, prefix=prefix, dependencies=guarded)
    app.include_router(ar_router, prefix=prefix, dependencies=guarded)
    app.include_router(assets_router, prefix=prefix, dependencies=guarded)
    app.include_router(cash_router, prefix=prefix, dependencies=guarded)
    app.include_router(chat_router, prefix=prefix)
    app.include_router(chat_meeting_router, prefix=prefix)
    app.include_router(chat_ws_router, prefix=prefix)
    app.include_router(crm_router, prefix=prefix, dependencies=guarded)
    app.include_router(crm_campaigns_router, prefix=prefix)
    app.include_router(events_router, prefix=prefix)
    app.include_router(public_router, prefix=prefix)
    app.include_router(invitation_templates_router, prefix=prefix)
    app.include_router(files_router, prefix=prefix)
    app.include_router(gcal_router, prefix=prefix)
    app.include_router(ledger_router, prefix=prefix, dependencies=guarded)
    app.include_router(masters_router, prefix=prefix, dependencies=guarded)
    app.include_router(notifications_router, prefix=prefix)
    app.include_router(payroll_router, prefix=prefix, dependencies=guarded)
    app.include_router(survey_router, prefix=prefix)
    app.include_router(reports_router, prefix=prefix, dependencies=guarded)
    app.include_router(search_router, prefix=prefix)
    app.include_router(workspace_router, prefix=prefix)
    app.include_router(jobs_router, prefix=prefix, dependencies=guarded)

    return app


app = create_app()
