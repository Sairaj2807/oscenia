"""Telling connected people what just happened — after it is committed.

Routes call these *after* ``session.commit()``. A frame sent before the commit could reach a
client that then asks for the message and finds nothing (or, if the request rolls back, announce
something that never happened). And a broadcast must never fail a write that already succeeded:
``safely`` logs and swallows anything that goes wrong here.

**Who hears an event is decided per event, at the moment it happens**, from the same access
rules that guard the REST routes (``access.py``) — there is no subscribe step to go stale. Take
someone out of a channel and the very next message in it skips them; their sockets are told
``channel.removed``. A project manager is in the audience of every channel except other people's
DMs, exactly as over REST.

Frames are plain dicts of JSON-safe values and stay small, so the hub's delivery can later move
behind LISTEN/NOTIFY without touching the callers (see ``hub.py``).
"""

from __future__ import annotations

import dataclasses
import logging
import uuid
from collections.abc import Awaitable, Callable, Iterable
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.chat import messages, notifications, service, views
from app.domain.chat.access import can_manage_channel, can_open_channel, discoverable_channels
from app.domain.chat.hub import ChatHub
from app.domain.chat.models import ChatChannel, ChatJoinRequest, ChatMessage
from app.domain.chat.service import ChatContext

log = logging.getLogger("chat.events")


def quietly(fn: Callable[..., None], *args: Any, **kwargs: Any) -> None:
    """``safely`` for the synchronous events."""
    try:
        fn(*args, **kwargs)
    except Exception:
        log.exception("chat: broadcast failed (the change itself was committed)")


async def safely(work: Awaitable[None]) -> None:
    """Run a broadcast; if it fails, say so in the log and carry on. The write it announces
    has already been committed."""
    try:
        await work
    except Exception:
        log.exception("chat: broadcast failed (the change itself was committed)")


# --- who is in the audience -------------------------------------------------------------


def opens(hub: ChatHub, ctx: ChatContext, channel: ChatChannel) -> set[str]:
    """Connected people who can open ``channel`` right now."""
    view = ctx.view(channel)
    return {
        uid
        for uid in hub.connected_user_ids()
        if (member := ctx.people.get(uid)) is not None
        and can_open_channel(member, view, ctx.project_divisions)
    }


def sees_locked(hub: ChatHub, ctx: ChatContext, channel: ChatChannel) -> set[str]:
    """Connected people who see ``channel`` listed but cannot open it."""
    view = ctx.view(channel)
    return {
        uid
        for uid in hub.connected_user_ids()
        if (member := ctx.people.get(uid)) is not None
        and discoverable_channels(member, [view], ctx.project_divisions)
    }


def visible(hub: ChatHub, ctx: ChatContext, channel: ChatChannel) -> set[str]:
    """Connected people who can see ``channel`` at all: open, or listed and locked."""
    return opens(hub, ctx, channel) | sees_locked(hub, ctx, channel)


def managers(hub: ChatHub, ctx: ChatContext, channel: ChatChannel) -> set[str]:
    view = ctx.view(channel)
    return {
        uid
        for uid in hub.connected_user_ids()
        if (member := ctx.people.get(uid)) is not None
        and can_manage_channel(member, view, ctx.project_divisions)
    }


# --- messages ---------------------------------------------------------------------------


async def message_event(
    session: AsyncSession, ctx: ChatContext, hub: ChatHub, kind: str, message: ChatMessage
) -> None:
    """``message.new``, ``message.updated``, ``message.deleted`` or ``reaction.updated``."""
    channel = ctx.channels.get(message.channel_id)
    if channel is None:
        return
    audience = opens(hub, ctx, channel)
    if not audience:
        return
    out = (await views.message_views(session, ctx, [message]))[0]
    hub.send(
        audience,
        {
            "type": kind,
            "channel_id": str(channel.id),
            "rev": message.rev,
            "message": out.model_dump(mode="json"),
        },
    )


def read_event(hub: ChatHub, user_id: str, channel_id: str, last_read_seq: int) -> None:
    """Keeps the person's other tabs and devices in step."""
    hub.send(
        [user_id],
        {"type": "read.updated", "channel_id": channel_id, "last_read_seq": last_read_seq},
    )


def typing_event(hub: ChatHub, ctx: ChatContext, channel: ChatChannel, user_id: str) -> None:
    hub.send(
        opens(hub, ctx, channel) - {user_id},
        {"type": "typing", "channel_id": str(channel.id), "user_id": user_id},
    )


async def mention_event(
    session: AsyncSession,
    ctx: ChatContext,
    hub: ChatHub,
    channel: ChatChannel,
    message: ChatMessage,
    *,
    already: Iterable[uuid.UUID] = (),
) -> None:
    """``notification.new`` to each person the message mentions who is connected and can open
    the channel. ``already`` are people an earlier version of the message mentioned: an edit
    that keeps a mention does not ring the bell a second time."""
    mentioned = await messages.mentioned_user_ids(session, message.id) - set(already)
    audience = opens(hub, ctx, channel) & {str(u) for u in mentioned}
    if audience:
        item = notifications.mention_item(ctx, message, channel, read=False)
        hub.send(
            audience, {"type": "notification.new", "notification": item.model_dump(mode="json")}
        )


# --- channels ---------------------------------------------------------------------------


async def channel_event(
    session: AsyncSession,
    ctx: ChatContext,
    hub: ChatHub,
    kind: str,
    channel: ChatChannel,
    *,
    before_visible: Iterable[str] = (),
) -> None:
    """``channel.created`` / ``channel.updated`` to everyone who can now see it — each given
    the channel as *they* are allowed to see it — and ``channel.removed`` to anyone who could
    see it before (``before_visible``) and cannot now. Someone who went from open to locked is
    in neither group: they get an update, and see the channel locked."""
    after_open = opens(hub, ctx, channel)
    recipients = after_open | sees_locked(hub, ctx, channel)
    if recipients:
        nos = await views.project_numbers(
            session, {channel.project_id} if channel.project_id else set()
        )
        for uid in recipients:
            mine = dataclasses.replace(ctx, me=ctx.users[uid])
            requests = await service.my_requests(session, mine)
            state = (
                await views.channel_states(session, mine, [channel.id]) if uid in after_open else {}
            )
            out = views.channel_out(mine, channel, project_nos=nos, requests=requests, state=state)
            hub.send([uid], {"type": kind, "channel": out.model_dump(mode="json")})
    for uid in set(before_visible) - recipients:
        hub.send([uid], {"type": "channel.removed", "channel_id": str(channel.id)})


# --- join requests ----------------------------------------------------------------------


def join_request_event(
    hub: ChatHub,
    ctx: ChatContext,
    kind: str,
    channel: ChatChannel,
    jr: ChatJoinRequest,
    *,
    also: Iterable[str] = (),
) -> None:
    """``join_request.created`` to whoever can decide it; ``join_request.decided`` to them and
    to the person who asked."""
    deciders = managers(hub, ctx, channel)
    hub.send(
        deciders | set(also),
        {"type": kind, "request": views.join_request_out(ctx, jr).model_dump(mode="json")},
    )
    # The bell: deciders are asked to act; the person who asked is told the answer.
    if kind == "join_request.created":
        item = notifications.join_item(ctx, jr, channel)
        hub.send(
            deciders, {"type": "notification.new", "notification": item.model_dump(mode="json")}
        )
    elif kind == "join_request.decided":
        answer = notifications.decision_item(ctx, jr, channel)
        hub.send(
            [str(jr.user_id)],
            {"type": "notification.new", "notification": answer.model_dump(mode="json")},
        )


def meeting_event(
    hub: ChatHub, ctx: ChatContext, channel: ChatChannel, meeting_id: uuid.UUID
) -> None:
    """``meeting.updated`` to everyone who can open the channel: the access or the minutes
    changed. It carries no content — each client asks again and is told only what *it* may read
    (the minutes may be restricted from some of the people who hear this)."""
    hub.send(
        opens(hub, ctx, channel),
        {"type": "meeting.updated", "meeting_id": str(meeting_id), "channel_id": str(channel.id)},
    )


def invalidate(hub: ChatHub, reason: str) -> None:
    """Something that reshapes everyone's workspace changed (a role, a project's divisions or
    members): tell every client to fetch the bootstrap again."""
    hub.broadcast(lambda _viewer: {"type": "bootstrap.invalidate", "reason": reason})


def frame(kind: str, **payload: Any) -> dict[str, Any]:
    return {"type": kind, **payload}
