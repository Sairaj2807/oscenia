"""The in-process hub: who is connected, what they are told, and who looks online.

One process holds every connection, so a message committed by one request reaches the sockets
of everyone allowed to see it without a broker. That is right for one uvicorn worker and wrong
for two: a second worker would hold its own, separate set of connections and never hear of the
first's events. So the hub takes a Postgres advisory lock for the life of the process
(:func:`acquire_leadership`) and a second worker refuses WebSocket upgrades instead of
quietly delivering half the events. The README states the single-worker rule next to the
scheduler's and the login throttle's.

**The seam for more workers.** Nothing outside this module and ``events.py`` knows delivery is
local: callers hand frames to :meth:`ChatHub.send` and :meth:`ChatHub.broadcast`. A later
``PgNotifyBus`` would carry only a small reference (event type, channel, rev) through
LISTEN/NOTIFY — a payload is capped at 8 KB — and each worker would render the frame for its own
connections from the database. Keep frames small and serialisable; that swap is then mechanical.

**Slow consumers are cut, not waited for.** Each connection has a bounded send queue. A reader
that cannot keep up is closed with 4408 and resyncs on reconnect (``POST /chat/sync``); one slow
browser must never hold up delivery to everybody else, or grow the server's memory without end.

**Presence lives here, in memory.** What is stored is only the status a person *chose*
(``users.chat_status``); whether they are connected is a fact about this process. ``invisible``
reads as ``offline`` to everyone but its owner (``presenceOf`` in the prototype).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from typing import Any, Protocol

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

log = logging.getLogger("chat.hub")

# --- limits -----------------------------------------------------------------------------

FRAME_MAX_BYTES = 16 * 1024
QUEUE_MAX = 256
MAX_CONNECTIONS_PER_USER = 5
HEARTBEAT_SECONDS = 25
IDLE_CLOSE_SECONDS = 60
AUTH_TIMEOUT_SECONDS = 5
RECHECK_SECONDS = 60
TOKEN_GRACE_SECONDS = 60
PRESENCE_GRACE_SECONDS = 10
TYPING_MIN_GAP_SECONDS = 2

# --- close codes (4xxx are ours) --------------------------------------------------------

CLOSE_TOO_BIG = 1009
CLOSE_NOT_LEADER = 1013
CLOSE_BAD_AUTH = 4401
CLOSE_FORBIDDEN = 4403
CLOSE_SLOW = 4408
CLOSE_IDLE = 4410
CLOSE_TOO_MANY = 4429

#: A person's chosen status → what others see while they are connected.
Status = str


class WebSocketLike(Protocol):
    """What the hub and the handler need from a socket — Starlette's ``WebSocket`` has all of
    it, and so does the fake the tests drive."""

    @property
    def headers(self) -> Any: ...

    async def accept(self) -> None: ...
    async def receive_text(self) -> str: ...
    async def send_text(self, data: str) -> None: ...
    async def close(self, code: int = 1000) -> None: ...


@dataclass(eq=False)
class Connection:
    user_id: str
    ws: WebSocketLike
    token_exp: float
    stored_status: Status = "online"
    #: ``active`` or ``idle``, as the client last said.
    activity: str = "active"
    queue: asyncio.Queue[str] = field(default_factory=lambda: asyncio.Queue(maxsize=QUEUE_MAX))
    last_recheck: float = field(default_factory=time.monotonic)
    typing_at: dict[str, float] = field(default_factory=dict)
    closed: bool = False


class ChatHub:
    def __init__(self) -> None:
        self._conns: dict[str, set[Connection]] = {}
        #: The chosen status of everyone who has connected, kept so presence can be answered
        #: without a database read. Updated when someone changes it.
        self._status: dict[str, Status] = {}
        self._grace: dict[str, asyncio.Task[None]] = {}
        self.leader = False
        #: The connection holding the advisory lock; closing it gives the lock up.
        self.lock_conn: AsyncConnection | None = None
        #: Taking the lock is serialised. Two sockets arriving together must not each try: the
        #: second would ask Postgres from a *different session* and be refused the lock this
        #: very process already holds — and turned away as if another worker had it.
        self.leader_lock = asyncio.Lock()

    # --- connections ---------------------------------------------------------------------

    def register(self, conn: Connection) -> bool:
        """Add a connection. ``False`` when this person already has the maximum."""
        mine = self._conns.setdefault(conn.user_id, set())
        if len(mine) >= MAX_CONNECTIONS_PER_USER:
            return False
        mine.add(conn)
        self._status[conn.user_id] = conn.stored_status
        pending = self._grace.pop(conn.user_id, None)
        if pending is not None:
            pending.cancel()  # back within the grace period: never went offline
        self._changed(conn.user_id)
        return True

    def unregister(self, conn: Connection) -> None:
        mine = self._conns.get(conn.user_id)
        if mine is None or conn not in mine:
            return
        mine.discard(conn)
        conn.closed = True
        if mine:
            self._changed(conn.user_id)
            return
        del self._conns[conn.user_id]
        # Keep them looking online for a moment: a page reload reconnects within seconds,
        # and flapping offline-then-online for every refresh helps nobody.
        self._grace[conn.user_id] = asyncio.create_task(self._go_offline(conn.user_id))

    async def _go_offline(self, user_id: str) -> None:
        try:
            await asyncio.sleep(PRESENCE_GRACE_SECONDS)
        except asyncio.CancelledError:
            return
        self._grace.pop(user_id, None)
        self._changed(user_id)

    def connections(self, user_id: str) -> list[Connection]:
        return list(self._conns.get(user_id, ()))

    def connected_user_ids(self) -> set[str]:
        return set(self._conns)

    def all_connections(self) -> list[Connection]:
        return [c for conns in self._conns.values() for c in conns]

    # --- presence ------------------------------------------------------------------------

    def set_status(self, user_id: str, status: Status) -> None:
        self._status[user_id] = status
        for conn in self._conns.get(user_id, ()):
            conn.stored_status = status
        self._changed(user_id)

    def set_activity(self, conn: Connection, activity: str) -> None:
        if conn.activity != activity:
            conn.activity = activity
            self._changed(conn.user_id)

    def _changed(self, user_id: str) -> None:
        """Tell everyone connected how ``user_id`` now looks — each as they are allowed to see
        it (an invisible person reads as offline to everyone but themselves)."""
        self.broadcast(
            lambda viewer: {
                "type": "presence",
                "user_id": user_id,
                "status": self.presence_of(user_id, viewer),
            }
        )

    def presence_of(self, user_id: str, viewer_id: str) -> Status:
        """How ``user_id`` shows up to ``viewer_id``. You see yourself as you set yourself;
        to everyone else, invisible reads as offline."""
        conns = self._conns.get(user_id)
        connected = bool(conns) or user_id in self._grace
        stored = self._status.get(user_id, "online")
        if not connected:
            return "invisible" if (user_id == viewer_id and stored == "invisible") else "offline"
        if stored == "invisible":
            return "invisible" if user_id == viewer_id else "offline"
        if stored == "online" and conns and all(c.activity == "idle" for c in conns):
            return "idle"
        return stored

    def snapshot(self, viewer_id: str) -> dict[str, Status]:
        """Everyone who is not offline, as ``viewer_id`` sees them."""
        out: dict[str, Status] = {}
        for uid in set(self._conns) | set(self._grace):
            status = self.presence_of(uid, viewer_id)
            if status != "offline":
                out[uid] = status
        return out

    async def shutdown(self) -> None:
        """Close every socket politely (1012: service restarting) and give up the lock."""
        for conn in self.all_connections():
            conn.closed = True
            await self._close_quietly(conn, 1012)
        for task in list(self._grace.values()):
            task.cancel()
        self._grace.clear()
        if self.lock_conn is not None:
            with contextlib.suppress(Exception):
                await self.lock_conn.close()
            self.lock_conn = None
        self.leader = False

    # --- delivery ------------------------------------------------------------------------

    def send(self, user_ids: Iterable[str], frame: dict[str, Any]) -> None:
        """Queue ``frame`` for every connection of these people."""
        data = json.dumps(frame, separators=(",", ":"))
        for uid in set(user_ids):
            for conn in list(self._conns.get(uid, ())):
                self._enqueue(conn, data)

    def broadcast(self, frame_for: Callable[[str], dict[str, Any] | None]) -> None:
        """A frame per recipient, for ones that differ by viewer (presence, a channel as one
        person is allowed to see it). ``None`` skips that person."""
        for uid in list(self._conns):
            frame = frame_for(uid)
            if frame is not None:
                self.send([uid], frame)

    def _enqueue(self, conn: Connection, data: str) -> None:
        if conn.closed:
            return
        try:
            conn.queue.put_nowait(data)
        except asyncio.QueueFull:
            # They cannot keep up. Cut them off — they resync on reconnecting — rather than
            # let one slow reader hold memory or hold up everyone else.
            log.warning("chat: dropping slow consumer %s", conn.user_id)
            conn.closed = True
            asyncio.get_running_loop().create_task(self._close_quietly(conn, CLOSE_SLOW))

    @staticmethod
    async def _close_quietly(conn: Connection, code: int) -> None:
        with contextlib.suppress(Exception):  # already gone is fine
            await conn.ws.close(code)

    async def drop_user(self, user_id: str, code: int = CLOSE_FORBIDDEN) -> None:
        """Close every connection of someone who has lost access (left the workspace)."""
        for conn in self.connections(user_id):
            conn.closed = True
            await self._close_quietly(conn, code)


async def acquire_leadership(engine: AsyncEngine, key: int) -> AsyncConnection | None:
    """Take a session-level Postgres advisory lock, or ``None`` if another process has it.

    The returned connection must stay open: closing it releases the lock. Two workers cannot
    both hold it, which is the point — see the module docstring.
    """
    conn = await engine.connect()
    try:
        got = (await conn.execute(text("SELECT pg_try_advisory_lock(:k)"), {"k": key})).scalar_one()
    except Exception:
        await conn.close()
        raise
    if not got:
        await conn.close()
        return None
    return conn


_hub: ChatHub | None = None


def get_hub() -> ChatHub:
    global _hub
    if _hub is None:
        _hub = ChatHub()
    return _hub


def set_hub(hub: ChatHub | None) -> None:
    """Swap the process-wide hub. For tests, which need a fresh one each."""
    global _hub
    _hub = hub
