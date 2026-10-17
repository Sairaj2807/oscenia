"""Chat backend C3 — the hub on its own: connections, presence and delivery.

No database, except the leadership lock, which is a Postgres advisory lock by definition.
"""

from __future__ import annotations

import asyncio
import random

import pytest
from chat_ws_fakes import FakeWS, settle
from sqlalchemy.ext.asyncio import AsyncEngine

from app.domain.chat import hub as hubmod
from app.domain.chat.hub import ChatHub, Connection, acquire_leadership

A, B, C = "user-a", "user-b", "user-c"


def conn(user: str, ws: FakeWS | None = None, **kw: object) -> Connection:
    return Connection(user_id=user, ws=ws or FakeWS(), token_exp=1e12, **kw)  # type: ignore[arg-type]


def presence_frames(c: Connection, about: str) -> list[dict[str, object]]:
    """The presence frames queued for ``c`` about ``about``, oldest first."""
    import json

    out = []
    while not c.queue.empty():
        f = json.loads(c.queue.get_nowait())
        if f["type"] == "presence" and f["user_id"] == about:
            out.append(f)
    return out


@pytest.fixture(autouse=True)
def quick_grace(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(hubmod, "PRESENCE_GRACE_SECONDS", 0.05)


# --- connections --------------------------------------------------------------------------


async def test_a_person_may_have_a_few_connections_and_no_more(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(hubmod, "MAX_CONNECTIONS_PER_USER", 2)
    hub = ChatHub()
    assert hub.register(conn(A)) and hub.register(conn(A))
    assert hub.register(conn(A)) is False
    assert hub.register(conn(B)) is True  # someone else is not affected
    assert len(hub.connections(A)) == 2


async def test_unregistering_the_last_connection_removes_the_person() -> None:
    hub = ChatHub()
    c1, c2 = conn(A), conn(A)
    hub.register(c1)
    hub.register(c2)
    hub.unregister(c1)
    assert hub.connected_user_ids() == {A}
    hub.unregister(c2)
    assert hub.connected_user_ids() == set()
    hub.unregister(c2)  # twice is harmless


# --- presence -----------------------------------------------------------------------------


async def test_presence_follows_what_the_person_chose_and_how_active_they_are() -> None:
    hub = ChatHub()
    c = conn(A)
    hub.register(c)
    assert hub.presence_of(A, B) == "online"

    hub.set_activity(c, "idle")  # every connection idle -> idle
    assert hub.presence_of(A, B) == "idle"
    other = conn(A)
    hub.register(other)  # a second, active tab brings them back
    assert hub.presence_of(A, B) == "online"

    hub.set_status(A, "dnd")
    assert hub.presence_of(A, B) == "dnd"  # a chosen status is not overridden by idleness
    hub.set_activity(other, "idle")
    assert hub.presence_of(A, B) == "dnd"


async def test_invisible_reads_as_offline_to_everyone_but_the_person_themselves() -> None:
    hub = ChatHub()
    hub.register(conn(A, stored_status="invisible"))
    assert hub.presence_of(A, B) == "offline"
    assert hub.presence_of(A, A) == "invisible"
    assert A not in hub.snapshot(B) and hub.snapshot(A)[A] == "invisible"


async def test_someone_who_never_connected_is_offline() -> None:
    assert ChatHub().presence_of(A, B) == "offline"


async def test_going_offline_waits_out_a_short_grace_period() -> None:
    hub = ChatHub()
    watcher = conn(B)
    hub.register(watcher)
    c = conn(A)
    hub.register(c)
    presence_frames(watcher, A)  # discard the "online" announcement

    hub.unregister(c)
    assert hub.presence_of(A, B) == "online"  # still within the grace
    assert presence_frames(watcher, A) == []
    await asyncio.sleep(0.15)
    assert hub.presence_of(A, B) == "offline"
    assert [f["status"] for f in presence_frames(watcher, A)] == ["offline"]


async def test_reconnecting_within_the_grace_never_shows_as_offline() -> None:
    """A page reload must not flap everyone's presence list."""
    hub = ChatHub()
    watcher = conn(B)
    hub.register(watcher)
    c = conn(A)
    hub.register(c)
    presence_frames(watcher, A)

    hub.unregister(c)
    hub.register(conn(A))
    await asyncio.sleep(0.15)
    assert hub.presence_of(A, B) == "online"
    assert "offline" not in [f["status"] for f in presence_frames(watcher, A)]


async def test_a_change_of_status_is_announced_to_everyone_as_they_may_see_it() -> None:
    hub = ChatHub()
    me, watcher = conn(A), conn(B)
    hub.register(me)
    hub.register(watcher)
    presence_frames(me, A)
    presence_frames(watcher, A)

    hub.set_status(A, "invisible")
    assert [f["status"] for f in presence_frames(watcher, A)] == ["offline"]
    assert [f["status"] for f in presence_frames(me, A)] == ["invisible"]


# --- delivery -----------------------------------------------------------------------------


async def test_a_frame_reaches_every_connection_of_each_named_person_once() -> None:
    hub = ChatHub()
    a1, a2, b1, c1 = conn(A), conn(A), conn(B), conn(C)
    for c in (a1, a2, b1, c1):
        hub.register(c)
    for c in (a1, a2, b1, c1):  # registering announced each arrival to the others; clear that
        while not c.queue.empty():
            c.queue.get_nowait()

    hub.send([A, A, B, "nobody"], {"type": "x"})
    assert [c.queue.qsize() for c in (a1, a2, b1, c1)] == [1, 1, 1, 0]


async def test_a_broadcast_can_differ_per_person_and_skip_some() -> None:
    hub = ChatHub()
    a, b = conn(A), conn(B)
    hub.register(a)
    hub.register(b)
    for c in (a, b):
        while not c.queue.empty():
            c.queue.get_nowait()

    hub.broadcast(lambda who: {"type": "t", "for": who} if who == A else None)
    assert a.queue.qsize() == 1 and b.queue.qsize() == 0


async def test_a_reader_that_cannot_keep_up_is_cut_off_not_waited_for(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(hubmod, "QUEUE_MAX", 2)
    hub = ChatHub()
    slow_ws = FakeWS()
    slow = conn(A, slow_ws)
    healthy = conn(B)
    hub.register(slow)
    hub.register(healthy)
    for c in (slow, healthy):
        while not c.queue.empty():
            c.queue.get_nowait()

    for n in range(4):  # nothing is draining the slow queue
        hub.send([A, B], {"type": "m", "n": n})
        if not healthy.queue.empty():
            healthy.queue.get_nowait()  # the healthy reader keeps up
    await settle()

    assert slow.closed and slow_ws.close_code == hubmod.CLOSE_SLOW
    assert not healthy.closed  # one slow browser did not hold up the rest


async def test_dropping_a_person_closes_all_their_connections() -> None:
    hub = ChatHub()
    w1, w2, other = FakeWS(), FakeWS(), FakeWS()
    hub.register(conn(A, w1))
    hub.register(conn(A, w2))
    hub.register(conn(B, other))
    await hub.drop_user(A)
    assert (w1.close_code, w2.close_code, other.close_code) == (hubmod.CLOSE_FORBIDDEN,) * 2 + (
        None,
    )


async def test_shutdown_closes_everyone_politely_and_forgets_the_leadership() -> None:
    hub = ChatHub()
    hub.leader = True
    w = FakeWS()
    hub.register(conn(A, w))
    await hub.shutdown()
    assert w.close_code == 1012 and hub.leader is False


# --- the single-worker guard --------------------------------------------------------------


async def test_only_one_process_can_be_the_hub(engine: AsyncEngine) -> None:
    key = random.randint(10_000_000, 99_999_999)  # no collision with the real key
    first = await acquire_leadership(engine, key)
    assert first is not None
    try:
        # A second worker is turned away while the first is alive.
        assert await acquire_leadership(engine, key) is None
    finally:
        await first.close()
    # Giving the lock up lets another take it.
    again = await acquire_leadership(engine, key)
    assert again is not None
    await again.close()
