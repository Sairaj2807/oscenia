"""Throttles: the login lockout, and request rate limits for public routes.

Phase 2 shipped argon2id, which makes each guess expensive — but *slow is not bounded*. An
attacker with a list of common passwords and patience still gets through a hundred thousand
attempts eventually, and nothing in the system counts them. This is the counter.

**Two keys, deliberately.** Per-account, so one user cannot be ground down; and per-client-IP,
so an attacker cannot spread a password-spray across a thousand accounts and stay under every
per-account limit. Either one tripping is enough.

**In Postgres, not in memory.** The counter used to be a dict behind a lock, which was right
for one process and wrong for two: each worker kept its own count and the effective limit
doubled. A row per key in ``rate_limits`` is shared by every worker and survives a restart,
so a lockout cannot be cleared by redeploying. The upsert takes a row lock, so two
concurrent failures on one key both count.

**Windows are fixed, not sliding.** A key's window starts at its first hit and resets once it
has aged out. That can let a patient caller land up to twice the limit across a window
boundary, which is an acceptable price for one row per key instead of one per attempt.

**Attempts are counted before the work, not failures after it.** Counting a failure only
once argon2 has rejected the password leaves a gap: a burst of parallel guesses all pass the
check before any is recorded. ``attempt()`` counts first, atomically, and the login route
commits it before verifying the password; a correct password then clears the count. That
also means a failed login needs no commit-before-raise — its attempt is already saved.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import DateTime, Integer, String, delete, func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, mapped_column

from app.core.errors import TooManyAttempts
from app.db.base import Base

#: Failures allowed inside the window before the key is locked out.
MAX_FAILURES = 8

#: How far back failures are counted, in seconds.
WINDOW_SECONDS = 300

#: How long a tripped key stays locked out, in seconds.
LOCKOUT_SECONDS = 900


class RateLimit(Base):
    """One counter per key — ``login:email:…``, ``login:ip:…``, ``rsvp:ip:…``."""

    __tablename__ = "rate_limits"

    key: Mapped[str] = mapped_column(String(200), primary_key=True)
    hits: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    window_started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    blocked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


@dataclass(frozen=True, slots=True)
class Verdict:
    allowed: bool
    retry_after: int = 0


#: Count one attempt — unless the key is already blocked, when nothing changes. RETURNING
#: tells the caller both outcomes. The upsert holds the row lock until the caller commits,
#: so concurrent attempts on one key queue up and each sees the one before it.
_ATTEMPT = text(
    """
    INSERT INTO rate_limits (key, hits, window_started_at) VALUES (:key, 1, :now)
    ON CONFLICT (key) DO UPDATE SET
      hits = CASE WHEN rate_limits.blocked_until > :now THEN rate_limits.hits
                  WHEN rate_limits.window_started_at <= :window_start THEN 1
                  ELSE rate_limits.hits + 1 END,
      window_started_at = CASE WHEN rate_limits.blocked_until > :now
                                 THEN rate_limits.window_started_at
                               WHEN rate_limits.window_started_at <= :window_start THEN :now
                               ELSE rate_limits.window_started_at END
    RETURNING hits, blocked_until
    """
)


def _utcnow() -> datetime:
    return datetime.now(UTC)


class Throttle:
    """``limit`` hits inside ``window_seconds`` blocks a key for ``block_seconds``.

    Each policy prefixes its keys (``scope``), so the login counter and an RSVP limit never
    share a row even when both are keyed on the same IP.
    """

    def __init__(
        self, scope: str, *, limit: int, window_seconds: int, block_seconds: int
    ) -> None:
        self.scope = scope
        self.limit = limit
        self.window = timedelta(seconds=window_seconds)
        self.block = timedelta(seconds=block_seconds)

    def _keys(self, keys: list[str]) -> list[str]:
        return [f"{self.scope}:{k}" for k in keys]

    async def check(
        self, session: AsyncSession, keys: list[str], *, now: datetime | None = None
    ) -> Verdict:
        """Whether an attempt may proceed. Checks, but does not record."""
        moment = now or _utcnow()
        until = (
            await session.execute(
                select(func.max(RateLimit.blocked_until)).where(
                    RateLimit.key.in_(self._keys(keys)), RateLimit.blocked_until > moment
                )
            )
        ).scalar_one_or_none()
        if until is None:
            return Verdict(allowed=True)
        return Verdict(allowed=False, retry_after=int((until - moment).total_seconds()) + 1)

    async def attempt(
        self, session: AsyncSession, keys: list[str], *, now: datetime | None = None
    ) -> Verdict:
        """Record one attempt against every key and say whether it may proceed.

        Check and count are one statement per key, so a burst of parallel requests cannot
        all pass a check before any of them is counted. The attempt that reaches the limit
        is still allowed and blocks the key for the next one; an attempt against a blocked
        key is refused and not counted. **Commit right after** so the next request sees it.
        """
        moment = now or _utcnow()
        blocked_until: datetime | None = None
        for key in self._keys(keys):
            hits, until = (
                await session.execute(
                    _ATTEMPT, {"key": key, "now": moment, "window_start": moment - self.window}
                )
            ).one()
            if until is not None and until > moment:
                blocked_until = max(blocked_until or until, until)
            elif hits >= self.limit:
                await session.execute(
                    text(
                        "UPDATE rate_limits SET blocked_until = :until, hits = 0, "
                        "window_started_at = :now WHERE key = :key"
                    ),
                    {"until": moment + self.block, "now": moment, "key": key},
                )
        if blocked_until is None:
            return Verdict(allowed=True)
        return Verdict(
            allowed=False, retry_after=int((blocked_until - moment).total_seconds()) + 1
        )

    async def clear(self, session: AsyncSession, keys: list[str]) -> None:
        """Forget these keys — a correct password is proof this was not an attack."""
        await session.execute(delete(RateLimit).where(RateLimit.key.in_(self._keys(keys))))

    async def consume(
        self, session: AsyncSession, keys: list[str], *, now: datetime | None = None
    ) -> None:
        """For request rate limits: count this request, or raise ``TooManyAttempts`` (429
        with Retry-After) if the key is blocked."""
        verdict = await self.attempt(session, keys, now=now)
        if not verdict.allowed:
            raise TooManyAttempts(
                "Too many requests. Try again shortly.", retry_after=verdict.retry_after
            )


async def purge_expired(
    session: AsyncSession, *, older_than: timedelta, now: datetime | None = None
) -> int:
    """Delete counters that are neither blocking nor inside a window ``older_than`` long.

    Public routes create a row per caller IP; this keeps the table to the recent ones.
    """
    moment = now or _utcnow()
    result = await session.execute(
        delete(RateLimit)
        .where(
            RateLimit.window_started_at < moment - older_than,
            or_(RateLimit.blocked_until.is_(None), RateLimit.blocked_until < moment),
        )
        .returning(RateLimit.key)
    )
    return len(result.scalars().all())


#: The sign-in lockout: per account and per caller IP.
login_throttle = Throttle(
    "login", limit=MAX_FAILURES, window_seconds=WINDOW_SECONDS, block_seconds=LOCKOUT_SECONDS
)
