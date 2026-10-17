"""The WebSocket endpoint: ``/api/v1/chat/ws``.

**Authentication is the first frame**, not the URL. A browser cannot set an ``Authorization``
header on a WebSocket, and a token in the query string ends up in access logs and proxy
history. So the client connects, then has five seconds to send ``{"op": "auth", "token": …}``
with its ordinary access token. The ``Origin`` header is checked against the CORS list before
anything is accepted — a page on another site cannot open a socket as a signed-in user.

**Mutations stay on REST.** The socket only *delivers*: new messages, edits, reactions, channel
changes, typing and presence. Sending a message over HTTP means one enforcement path for every
rule, with idempotency and the same problem-document errors; the socket carries no write that
could skip them. The few client frames are ``ping``, ``reauth``, ``typing`` and ``presence``.

**Staying honest about who is on the line.** Access tokens last 30 minutes, so the client sends
``{"op": "reauth", "token": …}`` after each refresh; one that is neither refreshed nor re-sent
within a minute of expiring is cut (4401). Every minute the person's account is looked up again,
so a deactivated user or one removed from the workspace is disconnected within about a minute
even though the change was made in another request.

Close codes: 4401 bad or expired credentials, 4403 not allowed (wrong origin, no workspace
persona), 4408 too slow to keep up, 4410 silent too long, 4429 too many connections, 1009 frame
too large, 1013 this worker is not the chat hub.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
import uuid
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, WebSocket
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.websockets import WebSocketDisconnect

from app.core.config import get_settings
from app.core.errors import PermissionDenied
from app.core.rbac import can_see
from app.core.security import AuthError, decode_token
from app.db.session import get_engine, get_sessionmaker
from app.domain.chat import events
from app.domain.chat import hub as hubmod
from app.domain.chat.hub import ChatHub, Connection, WebSocketLike, acquire_leadership, get_hub
from app.domain.chat.service import load_context
from app.domain.masters.models import User

log = logging.getLogger("chat.ws")

router = APIRouter(prefix="/chat", tags=["chat"])

SessionFactory = Callable[[], AbstractAsyncContextManager[AsyncSession]]


def _now() -> float:
    """Wall-clock seconds, to compare with a token's ``exp``. A function so tests can move it."""
    return time.time()


def _mono() -> float:
    return time.monotonic()


@dataclass(frozen=True, slots=True)
class Identity:
    user_id: str
    member_no: str
    name: str
    stored_status: str
    token_exp: float


async def authenticate(sessions: SessionFactory, token: str) -> Identity:
    """Who this access token is — and whether they may use chat at all.

    Raises ``AuthError`` (4401) for a bad, expired or revoked-account token and
    ``PermissionDenied`` (4403) for a valid login with no workspace persona.
    """
    payload = decode_token(token, expect="access")
    try:
        user_id = uuid.UUID(payload["sub"])
    except (KeyError, ValueError) as exc:
        raise AuthError("That token is not valid.") from exc
    async with sessions() as session:
        user = await session.get(User, user_id)
    if user is None or not user.active:
        raise AuthError("That account is no longer available.")
    _require_chat(user)
    assert user.member_no is not None
    return Identity(
        user_id=str(user.id),
        member_no=user.member_no,
        name=user.full_name,
        stored_status=user.chat_status.value,
        token_exp=float(payload.get("exp", 0)),
    )


def _require_chat(user: User) -> None:
    if not can_see(user.role, "chat") or user.workspace_role is None or user.member_no is None:
        raise PermissionDenied("You are not in the workspace.", action="chat:member")


async def ensure_leader(hub: ChatHub) -> bool:
    """Whether this process is *the* chat hub (see ``hub.py``). Taken once, kept for the
    process's life; a process that was refused tries again on its next connection, so it can
    take over if the first one goes away."""
    if hub.leader:
        return True
    settings = get_settings()
    if settings.env == "test" or not settings.chat_hub_single_worker_guard:
        hub.leader = True
        return True
    async with hub.leader_lock:
        if hub.leader:  # another socket got there while this one waited
            return True
        conn = await acquire_leadership(get_engine(), settings.chat_hub_lock_key)
        if conn is None:
            log.error(
                "chat: another process holds the hub lock — refusing WebSocket upgrades here. "
                "Run chat with a single worker."
            )
            return False
        hub.lock_conn = conn
        hub.leader = True
        return True


async def _close(ws: WebSocketLike, code: int) -> None:
    with contextlib.suppress(Exception):  # already closed is fine
        await ws.close(code)


def _origin_allowed(ws: WebSocketLike) -> bool:
    """Browsers always send ``Origin``; one that is not on the list is another site's page.
    A client with no ``Origin`` at all is not a browser, and has no ambient credentials for a
    hostile page to ride on."""
    origin = ws.headers.get("origin")
    return origin is None or origin in get_settings().cors_origins


def _parse(raw: str) -> dict[str, Any] | None:
    try:
        frame = json.loads(raw)
    except ValueError:
        return None
    return frame if isinstance(frame, dict) else None


async def _writer(conn: Connection) -> None:
    """Drain the connection's queue to the socket. If the socket is gone, stop; the receive
    loop notices the same thing and cleans up."""
    with contextlib.suppress(Exception):
        while True:
            await conn.ws.send_text(await conn.queue.get())


def _say(conn: Connection, **frame: Any) -> None:
    with contextlib.suppress(asyncio.QueueFull):
        conn.queue.put_nowait(json.dumps(frame, separators=(",", ":")))


async def serve(ws: WebSocketLike, hub: ChatHub, sessions: SessionFactory) -> None:
    """Run one connection from handshake to close."""
    if not _origin_allowed(ws):
        await _close(ws, hubmod.CLOSE_FORBIDDEN)
        return
    await ws.accept()
    if not await ensure_leader(hub):
        await _close(ws, hubmod.CLOSE_NOT_LEADER)
        return

    # --- the first frame must authenticate, quickly ----------------------------------------
    try:
        first = await asyncio.wait_for(ws.receive_text(), hubmod.AUTH_TIMEOUT_SECONDS)
    except (TimeoutError, WebSocketDisconnect):
        await _close(ws, hubmod.CLOSE_BAD_AUTH)
        return
    frame = _parse(first)
    if frame is None or frame.get("op") != "auth" or not isinstance(frame.get("token"), str):
        await _close(ws, hubmod.CLOSE_BAD_AUTH)
        return
    try:
        who = await authenticate(sessions, frame["token"])
    except AuthError:
        await _close(ws, hubmod.CLOSE_BAD_AUTH)
        return
    except PermissionDenied:
        await _close(ws, hubmod.CLOSE_FORBIDDEN)
        return

    conn = Connection(
        user_id=who.user_id, ws=ws, token_exp=who.token_exp, stored_status=who.stored_status
    )
    if not hub.register(conn):
        await _close(ws, hubmod.CLOSE_TOO_MANY)
        return

    # Registering announced this person's presence to everyone, themselves included. Drop what
    # that queued for them so ``hello`` is the first frame they see, and carries the whole
    # picture.
    while not conn.queue.empty():
        conn.queue.get_nowait()
    _say(
        conn,
        type="hello",
        user_id=who.user_id,
        member_no=who.member_no,
        server_time=datetime.now(UTC).isoformat(),
        heartbeat_s=hubmod.HEARTBEAT_SECONDS,
        presence=hub.snapshot(who.user_id),
    )
    writer = asyncio.create_task(_writer(conn))
    try:
        await _receive_loop(conn, hub, sessions)
    finally:
        hub.unregister(conn)
        writer.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await writer


async def _receive_loop(conn: Connection, hub: ChatHub, sessions: SessionFactory) -> None:
    ws = conn.ws
    while True:
        try:
            raw = await asyncio.wait_for(ws.receive_text(), hubmod.IDLE_CLOSE_SECONDS)
        except TimeoutError:
            await _close(ws, hubmod.CLOSE_IDLE)
            return
        except WebSocketDisconnect:
            return
        if conn.closed:
            return
        if len(raw.encode()) > hubmod.FRAME_MAX_BYTES:
            await _close(ws, hubmod.CLOSE_TOO_BIG)
            return

        # A token that has run out and not been replaced ends the session.
        if _now() > conn.token_exp + hubmod.TOKEN_GRACE_SECONDS:
            await _close(ws, hubmod.CLOSE_BAD_AUTH)
            return
        # Every so often, look the person up again: deactivated, or taken out of the workspace.
        if _mono() - conn.last_recheck > hubmod.RECHECK_SECONDS:
            conn.last_recheck = _mono()
            if not await _still_allowed(conn, sessions):
                await _close(ws, hubmod.CLOSE_FORBIDDEN)
                return

        frame = _parse(raw)
        if frame is None:
            _say(conn, type="error", code="bad_frame", detail="Send a JSON object.")
            continue
        if not await _handle(conn, hub, sessions, frame):
            return


async def _still_allowed(conn: Connection, sessions: SessionFactory) -> bool:
    async with sessions() as session:
        user = await session.get(User, uuid.UUID(conn.user_id))
    if user is None or not user.active:
        return False
    try:
        _require_chat(user)
    except PermissionDenied:
        return False
    return True


async def _handle(
    conn: Connection, hub: ChatHub, sessions: SessionFactory, frame: dict[str, Any]
) -> bool:
    """One client frame. Returns ``False`` when the connection should end."""
    op = frame.get("op")

    if op == "ping":
        _say(conn, type="pong")
    elif op == "reauth":
        token = frame.get("token")
        try:
            who = await authenticate(sessions, token) if isinstance(token, str) else None
        except (AuthError, PermissionDenied):
            who = None
        if who is None or who.user_id != conn.user_id:
            await _close(conn.ws, hubmod.CLOSE_BAD_AUTH)
            return False
        conn.token_exp = who.token_exp
        _say(conn, type="reauthed")
    elif op == "presence":
        state = frame.get("state")
        if state in ("active", "idle"):
            hub.set_activity(conn, state)
        else:
            _say(conn, type="error", code="bad_frame", detail="state is 'active' or 'idle'.")
    elif op == "typing":
        await _typing(conn, hub, sessions, frame.get("channel_id"))
    elif op == "auth":
        _say(conn, type="error", code="already_authenticated", detail="Already signed in.")
    else:
        _say(conn, type="error", code="unknown_op", detail=f"Unknown op {op!r}.")
    return True


async def _typing(
    conn: Connection, hub: ChatHub, sessions: SessionFactory, raw_channel: object
) -> None:
    try:
        channel_id = uuid.UUID(str(raw_channel))
    except ValueError:
        _say(conn, type="error", code="bad_frame", detail="channel_id is not valid.")
        return
    key = str(channel_id)
    now = _mono()
    # Typing arrives at every keystroke; one notice every couple of seconds is plenty.
    if now - conn.typing_at.get(key, -1e9) < hubmod.TYPING_MIN_GAP_SECONDS:
        return
    conn.typing_at[key] = now
    async with sessions() as session:
        user = await session.get(User, uuid.UUID(conn.user_id))
        if user is None:
            return
        ctx = await load_context(session, user)
    channel = ctx.channels.get(channel_id)
    # Not a channel they can open: say nothing, so typing cannot probe for channels.
    if channel is None or not ctx.can_open(channel):
        return
    events.typing_event(hub, ctx, channel, conn.user_id)


@router.websocket("/ws")
async def chat_ws(websocket: WebSocket) -> None:
    await serve(websocket, get_hub(), get_sessionmaker())
