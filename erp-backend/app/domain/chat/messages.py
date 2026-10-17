"""Messages, reactions, mentions and read state.

**Ordering and resuming.** Every change to a channel — a message, an edit, a delete, a
reaction — takes the next number from the channel's own counter (``chat_channels.rev``), under
that row's lock. A message's ``seq`` is the counter when it was posted and never changes; its
``rev`` is the counter at its last change. Because the counter is locked, numbers commit in the
order they were handed out, so "everything after rev N" can never skip a row — which a global
identity column cannot promise, since two transactions can commit out of order.

**The server's clock decides the edit window**, never a time the client sends.

**Nothing is hard-deleted.** A deleted message stays as a tombstone: the stream keeps its
shape and a reply that quoted it still points somewhere.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from datetime import timedelta
from typing import Any

from sqlalchemy import delete, func, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import Clock
from app.core.config import get_settings
from app.core.errors import Conflict, Invalid, NotFound, PermissionDenied
from app.core.throttle import Throttle
from app.domain.chat import attachments, tokens
from app.domain.chat.models import (
    REACTIONS,
    ChatChannel,
    ChatMention,
    ChatMessage,
    ChatReaction,
    ChatRead,
)
from app.domain.chat.service import ChatContext, require_open
from app.domain.masters.models import User

_settings = get_settings()

#: Per sender. Tests swap in a tighter one.
send_throttle = Throttle(
    "chat-send",
    limit=_settings.chat_send_limit,
    window_seconds=_settings.chat_send_window_seconds,
    block_seconds=_settings.chat_send_block_seconds,
)

PAGE_DEFAULT = 50
PAGE_MAX = 100
SYNC_MAX_PER_CHANNEL = 200

#: A client may send the emoji with or without its variation selector.
_CANONICAL = {e.replace("️", ""): e for e in REACTIONS}


def canonical_emoji(raw: str) -> str:
    emoji = _CANONICAL.get(raw.replace("️", ""))
    if emoji is None:
        raise Invalid(f"That reaction is not offered. Choose one of {' '.join(REACTIONS)}.")
    return emoji


def _window() -> timedelta:
    return timedelta(minutes=get_settings().chat_edit_window_minutes)


async def check_send_rate(session: AsyncSession, user_id: uuid.UUID, clock: Clock) -> None:
    """Count one send against the sender, or raise 429. Committed straight away: a counter that
    rolls back with a refused request would never count the burst it is there to stop."""
    await send_throttle.consume(session, [f"user:{user_id}"], now=clock.now())
    await session.commit()


async def _bump(session: AsyncSession, channel_id: uuid.UUID) -> int:
    """The channel's next number. The UPDATE takes the row lock and holds it until commit, so
    concurrent writers to one channel queue up and are numbered in commit order."""
    return (
        await session.execute(
            text("UPDATE chat_channels SET rev = rev + 1 WHERE id = :id RETURNING rev"),
            {"id": channel_id},
        )
    ).scalar_one()


async def _advance_read(
    session: AsyncSession, user_id: uuid.UUID, channel_id: uuid.UUID, seq: int
) -> None:
    stmt = pg_insert(ChatRead).values(user_id=user_id, channel_id=channel_id, last_read_seq=seq)
    await session.execute(
        stmt.on_conflict_do_update(
            index_elements=["user_id", "channel_id"],
            set_={
                "last_read_seq": func.greatest(ChatRead.last_read_seq, stmt.excluded.last_read_seq)
            },
        )
    )


def _resolve_mentions(
    ctx: ChatContext, cleaned: str, *, already: frozenset[str] = frozenset()
) -> dict[str, uuid.UUID]:
    """Member number → user id, for every mention. An unknown one is refused: the client only
    writes tokens for people who exist, so one that names nobody means the request was edited.
    ``already`` are numbers the message mentioned before, tolerated on an edit even if the
    person has since left."""
    by_no = {u.member_no: u.id for u in ctx.users.values() if u.member_no}
    found: dict[str, uuid.UUID] = {}
    for number in tokens.mention_numbers(cleaned):
        if number in by_no:
            found[number] = by_no[number]
        elif number not in already:
            raise Invalid(f"{number} is not someone you can mention.")
    return found


async def _mentioned_numbers(session: AsyncSession, message_id: uuid.UUID) -> dict[str, uuid.UUID]:
    rows = await session.execute(
        select(User.member_no, ChatMention.user_id)
        .join(User, User.id == ChatMention.user_id)
        .where(ChatMention.message_id == message_id)
    )
    return {no: uid for no, uid in rows.all() if no}


async def mentioned_user_ids(session: AsyncSession, message_id: uuid.UUID) -> set[uuid.UUID]:
    """Who a message currently mentions (never its author)."""
    rows = await session.execute(
        select(ChatMention.user_id).where(ChatMention.message_id == message_id)
    )
    return set(rows.scalars())


# --- posting ----------------------------------------------------------------------------


async def post_message(
    session: AsyncSession,
    ctx: ChatContext,
    clock: Clock,
    channel_id: uuid.UUID,
    raw_text: str,
    *,
    quote_id: uuid.UUID | None = None,
    client_msg_id: uuid.UUID | None = None,
    attachment_ids: Sequence[uuid.UUID] = (),
    kind: str = "text",
    meeting_id: uuid.UUID | None = None,
) -> tuple[ChatMessage, bool]:
    """Post as the caller. Returns ``(message, created)``: ``created`` is False when
    ``client_msg_id`` was already used by this sender — the same message, not a second one.

    ``kind="call"`` with a ``meeting_id`` is the log line a finished call leaves in its channel."""
    channel = require_open(ctx, channel_id)
    cleaned = tokens.clean_text(raw_text, max_chars=get_settings().chat_message_max_chars)

    if client_msg_id is not None:
        existing = await _by_client_id(session, ctx.me.id, client_msg_id)
        if existing is not None:
            if existing.channel_id != channel.id:
                raise Conflict("That client_msg_id was already used in another channel.")
            return existing, False

    if quote_id is not None:
        quoted = await session.get(ChatMessage, quote_id)
        if quoted is None or quoted.channel_id != channel.id:
            raise Invalid("A reply can only quote a message in the same channel.")

    mentioned = _resolve_mentions(ctx, cleaned)
    carried = await attachments.check_linkable(session, ctx, channel.id, attachment_ids)

    try:
        # The counter and the row are one unit: if the insert is refused (a retry racing its
        # twin), the number goes back too, so the channel's counter never skips.
        async with session.begin_nested():
            rev = await _bump(session, channel.id)
            message = ChatMessage(
                channel_id=channel.id, seq=rev, rev=rev, author_id=ctx.me.id, text=cleaned,
                kind=kind, quote_id=quote_id, created_at=clock.now(),
                client_msg_id=client_msg_id, meeting_id=meeting_id,
            )  # fmt: skip
            session.add(message)
            await session.flush()
    except IntegrityError:
        if client_msg_id is not None:
            existing = await _by_client_id(session, ctx.me.id, client_msg_id)
            if existing is not None and existing.channel_id == channel.id:
                return existing, False
        raise

    for user_id in mentioned.values():
        if user_id != ctx.me.id:
            session.add(
                ChatMention(
                    message_id=message.id,
                    user_id=user_id,
                    channel_id=channel.id,
                    created_at=message.created_at,
                )  # fmt: skip
            )
    await session.flush()
    await attachments.link(session, message.id, carried)
    # Your own message is read by definition.
    await _advance_read(session, ctx.me.id, channel.id, message.seq)
    return message, True


async def _by_client_id(
    session: AsyncSession, author_id: uuid.UUID, client_msg_id: uuid.UUID
) -> ChatMessage | None:
    return (
        await session.execute(
            select(ChatMessage).where(
                ChatMessage.author_id == author_id, ChatMessage.client_msg_id == client_msg_id
            )
        )
    ).scalar_one_or_none()


# --- reading ----------------------------------------------------------------------------


async def list_messages(
    session: AsyncSession,
    ctx: ChatContext,
    channel_id: uuid.UUID,
    *,
    before: int | None = None,
    after: int | None = None,
    limit: int = PAGE_DEFAULT,
) -> tuple[list[ChatMessage], bool, bool]:
    """A page of messages, oldest first: ``(messages, has_more_before, has_more_after)``.

    With no cursor, the newest page. ``before=N`` is the page of older messages (``seq < N``);
    ``after=N`` the newer ones (``seq > N``). A keyset on ``(channel_id, seq)``, never an
    offset, so a page does not shift when messages arrive.
    """
    channel = require_open(ctx, channel_id)
    if before is not None and after is not None:
        raise Invalid("Ask for messages before a point or after one, not both.")
    limit = max(1, min(limit, PAGE_MAX))
    base = select(ChatMessage).where(ChatMessage.channel_id == channel.id)

    if after is not None:
        rows = list(
            (
                await session.execute(
                    base.where(ChatMessage.seq > after).order_by(ChatMessage.seq).limit(limit + 1)
                )
            ).scalars()
        )
        more_after = len(rows) > limit
        page = rows[:limit]
        older = (
            await session.execute(
                select(func.count())
                .select_from(ChatMessage)
                .where(ChatMessage.channel_id == channel.id, ChatMessage.seq <= after)
            )
        ).scalar_one()
        return page, older > 0, more_after

    stmt = base
    if before is not None:
        stmt = stmt.where(ChatMessage.seq < before)
    rows = list(
        (await session.execute(stmt.order_by(ChatMessage.seq.desc()).limit(limit + 1))).scalars()
    )
    more_before = len(rows) > limit
    return list(reversed(rows[:limit])), more_before, False


# --- changing a message -----------------------------------------------------------------


async def _load(session: AsyncSession, ctx: ChatContext, message_id: uuid.UUID) -> ChatMessage:
    message = await session.get(ChatMessage, message_id)
    if message is None:
        raise NotFound("There is no such message.")
    require_open(ctx, message.channel_id)  # a message in a channel you cannot see is a 404
    return message


async def edit_message(
    session: AsyncSession,
    ctx: ChatContext,
    clock: Clock,
    message_id: uuid.UUID,
    raw_text: str,
) -> ChatMessage:
    message = await _load(session, ctx, message_id)
    if message.author_id != ctx.me.id:
        raise PermissionDenied("You can only edit your own messages.", action="chat:edit_message")
    if message.deleted_at is not None:
        raise Conflict("That message was deleted.")
    if message.kind != "text":
        raise Conflict("That kind of message cannot be edited.")
    if clock.now() - message.created_at > _window():
        raise Conflict(
            f"A message can only be edited for {get_settings().chat_edit_window_minutes} "
            "minutes after it is sent."
        )

    cleaned = tokens.clean_text(raw_text, max_chars=get_settings().chat_message_max_chars)
    before = await _mentioned_numbers(session, message.id)
    now_mentioned = _resolve_mentions(ctx, cleaned, already=frozenset(before))

    # Mentions follow the text: drop the ones taken out, add the new ones.
    gone = [uid for no, uid in before.items() if no not in now_mentioned]
    if gone:
        await session.execute(
            delete(ChatMention).where(
                ChatMention.message_id == message.id, ChatMention.user_id.in_(gone)
            )
        )
    for no, uid in now_mentioned.items():
        if no not in before and uid != ctx.me.id:
            session.add(
                ChatMention(
                    message_id=message.id,
                    user_id=uid,
                    channel_id=message.channel_id,
                    created_at=clock.now(),
                )  # fmt: skip
            )

    rev = await _bump(session, message.channel_id)
    message.text = cleaned
    message.edited_at = clock.now()
    message.rev = rev
    await session.flush()
    return message


async def delete_message(
    session: AsyncSession, ctx: ChatContext, clock: Clock, message_id: uuid.UUID
) -> ChatMessage:
    """Leave a "message deleted" placeholder. The author may delete their own within the
    window; the project manager may delete any message in a channel they can open (never
    inside someone else's DM — they cannot open it). Deleting twice is not an error."""
    message = await _load(session, ctx, message_id)
    if message.deleted_at is not None:
        return message

    is_pm = ctx.me_member.workspace_role == "pm"
    mine = message.author_id == ctx.me.id
    if not is_pm:
        if not mine:
            raise PermissionDenied(
                "Only the author, or the project manager, can delete a message.",
                action="chat:delete_message",
            )
        if message.kind != "text" or clock.now() - message.created_at > _window():
            raise Conflict(
                "You can delete your own message for "
                f"{get_settings().chat_edit_window_minutes} minutes after sending it."
            )

    rev = await _bump(session, message.channel_id)
    message.text = ""
    message.deleted_at = clock.now()
    message.deleted_by = ctx.me.id
    message.rev = rev
    # Nothing left to react to or be mentioned by.
    await session.execute(delete(ChatReaction).where(ChatReaction.message_id == message.id))
    await session.execute(delete(ChatMention).where(ChatMention.message_id == message.id))
    await attachments.drop_for_message(session, message.id)
    await session.flush()
    return message


async def set_reaction(
    session: AsyncSession,
    ctx: ChatContext,
    message_id: uuid.UUID,
    emoji: str,
    *,
    present: bool,
) -> ChatMessage:
    """Add or remove the caller's reaction. Idempotent: asking for what is already so changes
    nothing, so a retried request cannot toggle it back off."""
    emoji = canonical_emoji(emoji)
    message = await _load(session, ctx, message_id)
    if message.deleted_at is not None:
        raise Conflict("You cannot react to a deleted message.")

    if present:
        added = (
            await session.execute(
                pg_insert(ChatReaction)
                .values(message_id=message.id, user_id=ctx.me.id, emoji=emoji)
                .on_conflict_do_nothing()
                .returning(ChatReaction.emoji)
            )
        ).scalar_one_or_none()
        changed = added is not None
    else:
        removed = (
            await session.execute(
                delete(ChatReaction)
                .where(
                    ChatReaction.message_id == message.id,
                    ChatReaction.user_id == ctx.me.id,
                    ChatReaction.emoji == emoji,
                )
                .returning(ChatReaction.emoji)
            )
        ).scalar_one_or_none()
        changed = removed is not None

    if changed:
        message.rev = await _bump(session, message.channel_id)
        await session.flush()
    return message


# --- read state -------------------------------------------------------------------------


async def mark_read(
    session: AsyncSession, ctx: ChatContext, channel_id: uuid.UUID, seq: int
) -> int:
    """Everything up to ``seq`` counts as seen. Only moves forward, and never past the newest
    message, so a stale or hostile number cannot hide what has not arrived yet."""
    channel = require_open(ctx, channel_id)
    newest = (
        await session.execute(select(ChatChannel.rev).where(ChatChannel.id == channel.id))
    ).scalar_one()
    await _advance_read(session, ctx.me.id, channel.id, max(0, min(seq, newest)))
    await session.flush()
    return (
        await session.execute(
            select(ChatRead.last_read_seq).where(
                ChatRead.user_id == ctx.me.id, ChatRead.channel_id == channel.id
            )
        )
    ).scalar_one()


# --- resuming ---------------------------------------------------------------------------


async def sync(
    session: AsyncSession, ctx: ChatContext, cursors: dict[uuid.UUID, int]
) -> list[dict[str, Any]]:
    """What changed in each named channel after the client's ``rev``: new messages, edits,
    deletes and reaction changes alike, oldest change first.

    A channel the caller cannot open is left out without comment. Past 200 changes the answer
    is ``reset``: the client drops its copy and fetches the newest page instead of replaying a
    long tail.
    """
    result: list[dict[str, Any]] = []
    for channel_id, cursor in cursors.items():
        channel = ctx.channels.get(channel_id)
        if channel is None or not ctx.can_open(channel):
            continue
        rows = list(
            (
                await session.execute(
                    select(ChatMessage)
                    .where(ChatMessage.channel_id == channel_id, ChatMessage.rev > cursor)
                    .order_by(ChatMessage.rev)
                    .limit(SYNC_MAX_PER_CHANNEL + 1)
                )
            ).scalars()
        )
        reset = len(rows) > SYNC_MAX_PER_CHANNEL
        rev = (
            await session.execute(select(ChatChannel.rev).where(ChatChannel.id == channel_id))
        ).scalar_one()
        result.append(
            {
                "channel_id": channel_id,
                "rev": rev,
                "reset": reset,
                "messages": [] if reset else rows,
            }
        )
    return result
