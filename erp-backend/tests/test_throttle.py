"""The login throttle and request rate limits, kept in Postgres.

Ported from the phase-8 in-memory tests, plus the two properties the move to the database
exists for: every worker sees the same count, and a failed login's count survives the
request rolling back.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.core.errors import TooManyAttempts
from app.core.throttle import RateLimit, Throttle, login_throttle, purge_expired
from app.seed.chart import DEMO_PASSWORD

pytestmark = pytest.mark.phase8

T0 = datetime(2026, 10, 5, 9, 0, tzinfo=UTC)


def at(seconds: float) -> datetime:
    return T0 + timedelta(seconds=seconds)


async def test_the_throttle_locks_out_after_repeated_failures(db: AsyncSession) -> None:
    throttle = Throttle("t", limit=3, window_seconds=300, block_seconds=900)
    for second in range(3):
        assert (await throttle.check(db, ["email:a@b.c"], now=at(second))).allowed
        await throttle.attempt(db, ["email:a@b.c"], now=at(second))

    verdict = await throttle.check(db, ["email:a@b.c"], now=at(3))
    assert not verdict.allowed
    assert 0 < verdict.retry_after <= 900, "and it says how long to wait"

    assert (await throttle.check(db, ["email:a@b.c"], now=at(2 + 900 + 1))).allowed, (
        "the lockout ends"
    )


async def test_a_correct_password_clears_the_slate(db: AsyncSession) -> None:
    """Two fat-fingered attempts should not leave you one mistake from a lockout."""
    throttle = Throttle("t", limit=3, window_seconds=300, block_seconds=900)
    await throttle.attempt(db, ["email:a@b.c"], now=at(0))
    await throttle.attempt(db, ["email:a@b.c"], now=at(1))

    await throttle.clear(db, ["email:a@b.c"])
    await throttle.attempt(db, ["email:a@b.c"], now=at(2))

    assert (await throttle.check(db, ["email:a@b.c"], now=at(2))).allowed


async def test_failures_age_out_of_the_window(db: AsyncSession) -> None:
    throttle = Throttle("t", limit=3, window_seconds=60, block_seconds=900)
    await throttle.attempt(db, ["email:a@b.c"], now=at(0))
    await throttle.attempt(db, ["email:a@b.c"], now=at(1))
    # Far enough later that the first two have aged out.
    await throttle.attempt(db, ["email:a@b.c"], now=at(500))

    assert (await throttle.check(db, ["email:a@b.c"], now=at(500))).allowed


async def test_either_key_tripping_is_enough(db: AsyncSession) -> None:
    """Per-IP catches a spray across many accounts; per-account catches a grind on one."""
    throttle = Throttle("t", limit=2, window_seconds=300, block_seconds=900)
    await throttle.attempt(db, ["email:one@b.c", "ip:10.0.0.1"], now=at(0))
    await throttle.attempt(db, ["email:two@b.c", "ip:10.0.0.1"], now=at(1))

    assert not (await throttle.check(db, ["email:three@b.c", "ip:10.0.0.1"], now=at(2))).allowed
    assert (await throttle.check(db, ["email:three@b.c", "ip:10.0.0.2"], now=at(2))).allowed


async def test_policies_do_not_share_counters(db: AsyncSession) -> None:
    """An RSVP limit on an IP must not lock that IP out of signing in, or the reverse."""
    strict = Throttle("rsvp", limit=1, window_seconds=60, block_seconds=60)
    await strict.attempt(db, ["ip:10.0.0.1"], now=at(0))

    assert not (await strict.check(db, ["ip:10.0.0.1"], now=at(1))).allowed
    assert (await login_throttle.check(db, ["ip:10.0.0.1"], now=at(1))).allowed


async def test_the_count_is_shared_by_every_worker(engine: AsyncEngine) -> None:
    """The reason for the move: two sessions — two workers — add to one counter."""
    throttle = Throttle("t-shared", limit=2, window_seconds=300, block_seconds=900)
    key = ["ip:192.0.2.77"]
    maker = async_sessionmaker(bind=engine, expire_on_commit=False)
    try:
        async with maker() as worker_a, worker_a.begin():
            await throttle.attempt(worker_a, key, now=at(0))
        async with maker() as worker_b, worker_b.begin():
            await throttle.attempt(worker_b, key, now=at(1))
        async with maker() as worker_c:
            assert not (await throttle.check(worker_c, key, now=at(2))).allowed
    finally:
        async with maker() as cleanup, cleanup.begin():
            await throttle.clear(cleanup, key)


async def test_consume_serves_up_to_the_limit_then_refuses(db: AsyncSession) -> None:
    throttle = Throttle("t", limit=3, window_seconds=60, block_seconds=60)
    for second in range(3):
        await throttle.consume(db, ["ip:10.0.0.9"], now=at(second))

    with pytest.raises(TooManyAttempts) as refused:
        await throttle.consume(db, ["ip:10.0.0.9"], now=at(3))
    assert refused.value.extra["retry_after"] > 0


async def test_old_counters_are_purged_but_live_blocks_are_kept(db: AsyncSession) -> None:
    throttle = Throttle("t-purge", limit=1, window_seconds=60, block_seconds=3600)
    await throttle.attempt(db, ["ip:old"], now=at(0))  # blocked until at(3600)
    stale = Throttle("t-purge", limit=99, window_seconds=60, block_seconds=60)
    await stale.attempt(db, ["ip:stale"], now=at(0))

    removed = await purge_expired(db, older_than=timedelta(minutes=10), now=at(1800))
    assert removed == 1, "the stale counter goes; the live block stays"
    keys = set((await db.execute(select(RateLimit.key))).scalars())
    assert "t-purge:ip:old" in keys and "t-purge:ip:stale" not in keys


# ---------------------------------------------------------------------------
# Over HTTP
# ---------------------------------------------------------------------------


async def test_repeated_bad_logins_are_eventually_refused(
    anon_client: AsyncClient, api: str
) -> None:
    """argon2 makes each guess slow. Slow is not bounded — this is what bounds it."""
    body = {"email": "rahmat@oscenia.co.id", "password": "not-the-password"}

    codes = []
    for _ in range(12):
        codes.append((await anon_client.post(f"{api}/auth/login", json=body)).status_code)

    assert 401 in codes, "the first few are ordinary failures"
    assert 429 in codes, "and then it stops answering"

    final = await anon_client.post(f"{api}/auth/login", json=body)
    assert final.status_code == 429
    assert final.headers["Retry-After"].isdigit(), "RFC 9110 — say how long, not just no"


async def test_a_blocked_key_refuses_without_counting(db: AsyncSession) -> None:
    throttle = Throttle("t", limit=2, window_seconds=300, block_seconds=900)
    assert (await throttle.attempt(db, ["ip:a"], now=at(0))).allowed
    assert (await throttle.attempt(db, ["ip:a"], now=at(1))).allowed, "the 2nd is served"
    refused = await throttle.attempt(db, ["ip:a"], now=at(2))
    assert not refused.allowed and 0 < refused.retry_after <= 900


async def test_a_parallel_burst_cannot_slip_past_the_limit(engine: AsyncEngine) -> None:
    """The reviewer's case: check-then-count let every request in a burst pass the check.
    Counting first, under the row lock, makes them queue — only ``limit`` get through."""
    import asyncio

    throttle = Throttle("t-burst", limit=3, window_seconds=300, block_seconds=900)
    key = ["email:burst"]
    maker = async_sessionmaker(bind=engine, expire_on_commit=False)

    async def one() -> bool:
        async with maker() as worker, worker.begin():
            return (await throttle.attempt(worker, key)).allowed

    try:
        results = await asyncio.gather(*(one() for _ in range(12)))
        assert results.count(True) == 3
    finally:
        async with maker() as cleanup, cleanup.begin():
            await throttle.clear(cleanup, key)


def _app_with_production_sessions(db: AsyncSession) -> AsyncClient:
    """Like the standard client, but the session rolls back when a request raises — exactly
    what ``get_session`` does in production. The shared fixture deliberately does not, since
    other tests keep using their setup rows after an expected error."""
    from httpx import ASGITransport

    from app.db.session import get_session
    from app.main import create_app

    app = create_app()

    async def _session() -> AsyncIterator[AsyncSession]:
        try:
            yield db
        except Exception:
            await db.rollback()
            raise

    app.dependency_overrides[get_session] = _session
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def test_a_failed_login_is_still_counted_after_the_request_rolls_back(
    db: AsyncSession, api: str
) -> None:
    async with _app_with_production_sessions(db) as http:
        response = await http.post(
            f"{api}/auth/login", json={"email": "lina@oscenia.co.id", "password": "wrong"}
        )
    assert response.status_code == 401
    assert (await db.execute(select(func.sum(RateLimit.hits)))).scalar_one() == 2, (
        "one attempt on the account key, one on the IP key — committed before the password "
        "was checked, so the rollback that follows the 401 cannot undo them"
    )


async def test_a_very_long_address_is_a_401_not_a_500(anon_client: AsyncClient, api: str) -> None:
    email = "a" * 64 + "@" + ".".join(["b" * 60] * 4) + ".com"
    response = await anon_client.post(f"{api}/auth/login", json={"email": email, "password": "x"})
    assert response.status_code in (401, 422), response.text


async def test_the_lockout_does_not_leak_which_accounts_exist(
    anon_client: AsyncClient, api: str
) -> None:
    """A 429 for a real address and a 404-shaped one for an invented address would be an
    enumeration oracle just as surely as a different error message."""
    unknown = {"email": "nobody@oscenia.co.id", "password": "wrong"}

    for _ in range(12):
        await anon_client.post(f"{api}/auth/login", json=unknown)

    refused = await anon_client.post(f"{api}/auth/login", json=unknown)
    assert refused.status_code == 429


async def test_a_good_password_still_works_after_a_couple_of_mistakes(
    anon_client: AsyncClient, api: str
) -> None:
    for _ in range(3):
        await anon_client.post(
            f"{api}/auth/login",
            json={"email": "rahmat@oscenia.co.id", "password": "wrong"},
        )

    ok = await anon_client.post(
        f"{api}/auth/login",
        json={"email": "rahmat@oscenia.co.id", "password": DEMO_PASSWORD},
    )
    assert ok.status_code == 200, ok.text
