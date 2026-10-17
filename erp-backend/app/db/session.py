"""Async engine, session factory, and the request-scoped session dependency."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import Depends
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.config import get_settings

_engine: AsyncEngine | None = None
_sessionmaker: async_sessionmaker[AsyncSession] | None = None


def get_engine() -> AsyncEngine:
    global _engine
    if _engine is None:
        settings = get_settings()
        _engine = create_async_engine(
            settings.sqlalchemy_url,
            echo=settings.db_echo,
            pool_size=settings.db_pool_size,
            max_overflow=settings.db_max_overflow,
            pool_pre_ping=True,
        )
    return _engine


def get_sessionmaker() -> async_sessionmaker[AsyncSession]:
    global _sessionmaker
    if _sessionmaker is None:
        _sessionmaker = async_sessionmaker(
            bind=get_engine(),
            expire_on_commit=False,
            autoflush=False,
        )
    return _sessionmaker


async def get_session() -> AsyncIterator[AsyncSession]:
    """One session per request, committed on success and rolled back on any exception.

    Posting is a single transaction by design: an entry, its lines, its application rows
    and its allocated voucher number either all land or none do. Commit-per-request is
    what makes that the default rather than something each service has to remember.
    """
    async with get_sessionmaker()() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise
        else:
            await session.commit()


async def dispose_engine() -> None:
    global _engine, _sessionmaker
    if _engine is not None:
        await _engine.dispose()
    _engine = None
    _sessionmaker = None


# ``scope="function"``: the session commits when the endpoint function returns, BEFORE the response
# is sent. The default (``request``) runs the exit code AFTER the response has gone out, so a client
# that reads straight after a write could be answered before the write was committed: measured at
# 57 stale reads in 150 against a real server, which is a screen that saves and then shows the old
# data. Every handler here returns a fully built response model, so nothing needs the session once
# the function has returned.
SessionDep = Annotated[AsyncSession, Depends(get_session, scope="function")]
