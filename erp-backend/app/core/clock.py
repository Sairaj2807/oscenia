"""The only place in the codebase permitted to ask the OS what time it is.

The prototype hardcodes ``DEMO_TODAY = '2026-07-26'`` in ``src/lib/format.js`` and every
ageing bucket, day counter and depreciation "due" calculation measures against it. Real
time replaces it here, but it has to stay injectable: ageing assertions ported from
``verify-flows.mjs`` carry the original fixed-date numbers, and the demo seeder anchors
its data to a chosen date so the buckets still read sensibly whenever it is run.

Nothing else may call ``date.today()``. Ruff's DTZ rules enforce that, with this module
as the single exemption.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from typing import Annotated, Protocol
from zoneinfo import ZoneInfo

from fastapi import Depends

from app.core.config import get_settings

#: The prototype's fixed clock. Tests default to it so ported assertions keep their numbers.
DEMO_TODAY = date(2026, 7, 26)


class Clock(Protocol):
    def today(self) -> date: ...
    def now(self) -> datetime: ...


class SystemClock:
    """Real time, in the company's operating timezone.

    ``today()`` is deliberately *not* UTC. Oscenia operates in Jakarta (UTC+7), so the
    business day turns over at Jakarta midnight — and for the seven hours either side of
    it, UTC and local disagree about what day it is. Every ageing bucket, DP countdown and
    depreciation due date is computed against ``today()``, so getting this wrong would
    quietly shift all of them by a day for part of each day.

    ``now()`` stays timezone-aware and is stored as UTC; only the *calendar date* is local.
    """

    def today(self) -> date:
        return datetime.now(ZoneInfo(get_settings().timezone)).date()

    def now(self) -> datetime:
        return datetime.now(UTC)


class FrozenClock:
    """A fixed instant, for tests and for anchoring seeded demo data."""

    def __init__(self, at: date | datetime) -> None:
        if isinstance(at, datetime):
            self._at = at if at.tzinfo else at.replace(tzinfo=UTC)
        else:
            self._at = datetime(at.year, at.month, at.day, tzinfo=UTC)

    def today(self) -> date:
        return self._at.date()

    def now(self) -> datetime:
        return self._at

    def advance(self, delta: timedelta) -> None:
        """Move the frozen instant forward — for tests of anything with a time window."""
        self._at += delta


_clock: Clock = SystemClock()


def get_clock() -> Clock:
    """FastAPI dependency. Override in tests with ``app.dependency_overrides``."""
    return _clock


def set_clock(clock: Clock) -> None:
    """Swap the process-wide clock. Used by the seeder and by test fixtures."""
    global _clock
    _clock = clock


def reset_clock() -> None:
    set_clock(SystemClock())


ClockDep = Annotated[Clock, Depends(get_clock)]
