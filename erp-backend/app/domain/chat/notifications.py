"""The chat items in the notification bell: mentions, join requests and their answers.

Ported from ``erp-frontend/src/lib/notifications.js``. Like there, a notification is **worked
out from the data, not stored** — so it can never disagree with the message or request it
points at: delete the message and its "mentioned you" is simply gone; decide the request and
its "wants to join" goes with it. What the prototype stores, and this keeps, is only what has
been *read*:

* a **mention** is read once the person has read past its message in that channel
  (``chat_reads``), so reading the channel clears it on every device;
* a **join request** needs an answer, not a glance: it stays until decided (``read`` is null);
* the **answer** to your own request has no server-side read state yet (``read`` is null) — the
  client keeps that, as the prototype does with ``notifRead``.

Tasks join this list too (``workspace/notifications.py``: needs your approval, assigned to you,
sent back, approved, blocked). What is *not* here: events and CRM items, which have their own list
(``notifications/service.py``) because they do not need a workspace persona.

Access is re-checked on every read. A mention in a channel you can no longer open is hidden, a
blocked requester's request is hidden from the people who decide, and a deleted message takes
its mentions with it.
"""

from __future__ import annotations

import re
import uuid
from datetime import datetime, timedelta
from typing import Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import Clock
from app.domain.chat.models import (
    ChatChannel,
    ChatJoinRequest,
    ChatMention,
    ChatMessage,
    ChatRead,
    JoinStatus,
)
from app.domain.chat.schemas import NotificationOut
from app.domain.chat.service import ChatContext

Kind = Literal[
    "Mentioned you",
    "Wants to join",
    "Added to channel",
    "Request declined",
    "Needs your approval",
    "Assigned to you",
    "Sent back",
    "Approved",
    "Blocked",
]

MENTIONS_SCANNED = 200
DECISIONS_KEPT = 20
DECISION_DAYS = 30
BODY_MAX = 140

#: Things only this person can unblock come first; the rest newest first.
_ACTION: set[str] = {"Wants to join", "Needs your approval"}


def _name(ctx: ChatContext, user_id: uuid.UUID | str) -> str:
    person = ctx.users.get(str(user_id))
    return person.full_name if person is not None else "Someone"


def _plain(ctx: ChatContext, text: str) -> str:
    """Stored text → a line for the bell: tokens made readable, whitespace collapsed, cut to
    length (``<@M-05>`` → ``@Rina M.``; ``<#T-102>`` → ``#T-102``)."""
    by_no = {u.member_no: u.full_name for u in ctx.users.values() if u.member_no}
    text = re.sub(r"<@(M-\d+)>", lambda m: "@" + by_no.get(m.group(1), m.group(1)), text)
    text = re.sub(r"<#(T-\d+)>", r"#\1", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text if len(text) <= BODY_MAX else text[: BODY_MAX - 1] + "…"


def mention_item(
    ctx: ChatContext, message: ChatMessage, channel: ChatChannel, *, read: bool | None
) -> NotificationOut:
    who = _name(ctx, message.author_id)
    return NotificationOut(
        id=f"mention:{message.id}",
        kind="Mentioned you",
        at=message.created_at,
        # A DM has no channel name.
        title=f"{who} in a direct message" if channel.is_dm else f"{who} in #{channel.name}",
        body=_plain(ctx, message.text),
        to=f"/chat/{channel.id}",
        read=read,
    )


def join_item(ctx: ChatContext, jr: ChatJoinRequest, channel: ChatChannel) -> NotificationOut:
    return NotificationOut(
        id=f"join:{jr.id}",
        kind="Wants to join",
        at=jr.created_at,
        title=f"{_name(ctx, jr.user_id)} wants to join #{channel.name}",
        body=jr.note or "No note",
        to=f"/chat/{channel.id}?settings={channel.id}",
        read=None,
    )


def decision_item(ctx: ChatContext, jr: ChatJoinRequest, channel: ChatChannel) -> NotificationOut:
    yes = jr.status is JoinStatus.APPROVED
    assert jr.decided_at is not None
    return NotificationOut(
        id=f"joined:{jr.id}",
        kind="Added to channel" if yes else "Request declined",
        at=jr.decided_at,
        title=(
            f"You were added to #{channel.name}"
            if yes
            else f"Your request to join #{channel.name} was declined"
        ),
        body=f"by {_name(ctx, jr.decided_by)}" if jr.decided_by else "",
        to=f"/chat/{channel.id}",
        read=None,
    )


def _ordered(items: list[NotificationOut]) -> list[NotificationOut]:
    newest_first = sorted(items, key=lambda i: i.at, reverse=True)
    return sorted(newest_first, key=lambda i: 0 if i.kind in _ACTION else 1)  # stable


async def build(
    session: AsyncSession, ctx: ChatContext, clock: Clock, *, limit: int = 50
) -> list[NotificationOut]:
    me = ctx.me.id
    items: list[NotificationOut] = []

    # --- @mentions in channels I can still open ---------------------------------------
    read_to = {
        cid: seq
        for cid, seq in (
            await session.execute(
                select(ChatRead.channel_id, ChatRead.last_read_seq).where(ChatRead.user_id == me)
            )
        ).all()
    }
    rows = (
        await session.execute(
            select(ChatMessage)
            .join(ChatMention, ChatMention.message_id == ChatMessage.id)
            .where(ChatMention.user_id == me, ChatMessage.deleted_at.is_(None))
            # Newest first; messages that tie on the clock fall back to their order in the
            # channel, so "newest" never depends on how the database happens to return rows.
            .order_by(ChatMention.created_at.desc(), ChatMessage.seq.desc())
            .limit(MENTIONS_SCANNED)
        )
    ).scalars()
    for message in rows:
        channel = ctx.channels.get(message.channel_id)
        if channel is None or not ctx.can_open(channel):
            continue
        read = message.seq <= read_to.get(message.channel_id, 0)
        items.append(mention_item(ctx, message, channel, read=read))

    # --- requests I can decide ---------------------------------------------------------
    managed = [c.id for c in ctx.channels.values() if not c.is_dm and ctx.can_manage(c)]
    if managed:
        pending = (
            await session.execute(
                select(ChatJoinRequest).where(
                    ChatJoinRequest.channel_id.in_(managed),
                    ChatJoinRequest.status == JoinStatus.PENDING,
                    ChatJoinRequest.user_id != me,
                )
            )
        ).scalars()
        for jr in pending:
            # A request from someone since blocked is not worth the deciders' attention.
            if str(jr.user_id) in ctx.blocks.get(jr.channel_id, set()):
                continue
            items.append(join_item(ctx, jr, ctx.channels[jr.channel_id]))

    # --- the answers to my own requests ------------------------------------------------
    since: datetime = clock.now() - timedelta(days=DECISION_DAYS)
    answered = (
        await session.execute(
            select(ChatJoinRequest)
            .where(
                ChatJoinRequest.user_id == me,
                ChatJoinRequest.status != JoinStatus.PENDING,
                ChatJoinRequest.decided_at > since,
            )
            .order_by(ChatJoinRequest.decided_at.desc())
            .limit(DECISIONS_KEPT)
        )
    ).scalars()
    for jr in answered:
        channel = ctx.channels.get(jr.channel_id)
        if channel is not None:
            items.append(decision_item(ctx, jr, channel))

    # --- tasks: what needs my approval, was given to me, sent back, signed off or blocked ---
    from app.domain.workspace import notifications as task_notifications  # (it imports this module)

    items += await task_notifications.build(session, ctx, clock)

    return _ordered(items)[:limit]
