"""Turning the service's rows into what a caller is allowed to see.

The rule that matters here: a channel's member and block lists go only to someone who can
manage it. Everyone else gets the channel without them, so a locked or invite-only channel
does not reveal who is in it.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable
from typing import Any

from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.ar.models import Client, Project
from app.domain.chat import attachments
from app.domain.chat.access import member_project_ids
from app.domain.chat.models import (
    ChatAttachment,
    ChatChannel,
    ChatJoinRequest,
    ChatMention,
    ChatMessage,
    ChatReaction,
    ChatRead,
    JoinStatus,
)
from app.domain.chat.schemas import (
    AttachmentOut,
    BootstrapOut,
    ChannelOut,
    JoinRequestOut,
    MemberOut,
    MessageOut,
    ProjectOut,
    SyncChannelOut,
)
from app.domain.chat.service import ChatContext, member_projects, my_requests
from app.domain.masters.models import User


def member_out(ctx: ChatContext, user: User) -> MemberOut:
    assert user.workspace_role is not None and user.member_no is not None
    ids = member_project_ids(ctx.people.get(str(user.id)), ctx.project_divisions)
    return MemberOut(
        id=user.id,
        member_no=user.member_no,
        name=user.full_name,
        initials=user.initials,
        workspace_role=user.workspace_role.value,
        division=user.division,
        title=user.title,
        project_ids=[uuid.UUID(i) for i in ids],
    )


def channel_out(
    ctx: ChatContext,
    channel: ChatChannel,
    *,
    project_nos: dict[uuid.UUID, str],
    requests: dict[uuid.UUID, JoinStatus],
    state: dict[uuid.UUID, tuple[int, int, int]] | None = None,
) -> ChannelOut:
    locked = not ctx.can_open(channel)
    can_manage = ctx.can_manage(channel)
    roster = ctx.members.get(channel.id, set())
    dm_with = None
    if channel.is_dm:
        others = roster - {ctx.me_id}
        dm_with = uuid.UUID(next(iter(others))) if others else None
    show_lists = can_manage and not channel.is_dm
    # Unread counts only for channels the caller can open: a locked one has nothing to count.
    last_read, unread, unread_mentions = (state or {}).get(channel.id, (0, 0, 0))
    return ChannelOut(
        id=channel.id,
        key=channel.key,
        project_id=channel.project_id,
        project_no=project_nos.get(channel.project_id) if channel.project_id else None,
        name=channel.name,
        topic=channel.topic,
        access=channel.access.value,
        divisions=list(channel.divisions or ()),
        listed=channel.listed,
        is_dm=channel.is_dm,
        dm_with=dm_with,
        locked=locked,
        can_manage=can_manage,
        member_ids=sorted(uuid.UUID(x) for x in roster) if show_lists else None,
        blocked_ids=(
            sorted(uuid.UUID(x) for x in ctx.blocks.get(channel.id, set())) if show_lists else None
        ),
        my_request=requests[channel.id].value if locked and channel.id in requests else None,
        rev=0 if locked else channel.rev,
        last_read_seq=last_read,
        unread=unread,
        unread_mentions=unread_mentions,
    )


async def project_numbers(session: AsyncSession, ids: set[uuid.UUID]) -> dict[uuid.UUID, str]:
    if not ids:
        return {}
    rows = await session.execute(select(Project.id, Project.project_no).where(Project.id.in_(ids)))
    return {pid: no for pid, no in rows.all()}


async def bootstrap(session: AsyncSession, ctx: ChatContext) -> BootstrapOut:
    visible = ctx.visible()
    locked = ctx.discoverable()
    mine = {uuid.UUID(p) for p in member_projects(ctx, ctx.me)}
    wanted = mine | {c.project_id for c in [*visible, *locked] if c.project_id}
    nos = await project_numbers(session, wanted)
    cards = {
        p.id: (p, client, pm)
        for p, client, pm in (
            await session.execute(
                select(Project, Client.name, User.full_name)
                .join(Client, Client.id == Project.client_id)
                .outerjoin(User, User.id == Project.pm_user_id)
                .where(Project.id.in_(mine))
            )
        ).all()
    }
    requests = await my_requests(session, ctx)
    state = await channel_states(session, ctx, [c.id for c in visible])
    members = sorted(ctx.users.values(), key=lambda u: int((u.member_no or "M-0")[2:]))
    return BootstrapOut(
        me=member_out(ctx, ctx.me),
        members=[member_out(ctx, u) for u in members],
        projects=[
            ProjectOut(
                id=pid,
                project_no=nos.get(pid, ""),
                name=cards[pid][0].name if pid in cards else "",
                divisions=ctx.project_divisions.get(str(pid), []),
                client_name=cards[pid][1] if pid in cards else None,
                event_date=cards[pid][0].event_date if pid in cards else None,
                stage=cards[pid][0].stage.value if pid in cards else None,
                pm_name=cards[pid][2] if pid in cards else None,
            )
            for pid in sorted(mine, key=lambda p: nos.get(p, ""))
        ],
        channels=[
            channel_out(ctx, c, project_nos=nos, requests=requests, state=state) for c in visible
        ],
        discoverable=[channel_out(ctx, c, project_nos=nos, requests=requests) for c in locked],
    )


def join_request_out(ctx: ChatContext, jr: ChatJoinRequest) -> JoinRequestOut:
    person = ctx.users.get(str(jr.user_id))
    return JoinRequestOut(
        id=jr.id,
        channel_id=jr.channel_id,
        user_id=jr.user_id,
        member_no=person.member_no if person else None,
        name=person.full_name if person else "",
        note=jr.note,
        status=jr.status.value,
        created_at=jr.created_at,
        decided_by=jr.decided_by,
        decided_at=jr.decided_at,
    )


async def channel_states(
    session: AsyncSession, ctx: ChatContext, channel_ids: Iterable[uuid.UUID]
) -> dict[uuid.UUID, tuple[int, int, int]]:
    """``channel -> (last_read_seq, unread, unread_mentions)`` for the caller.

    Unread is what lies beyond how far they have read, leaving out their own messages and
    deleted ones. Two grouped queries however many channels there are.
    """
    ids = list(channel_ids)
    if not ids:
        return {}
    me = ctx.me.id
    read_to = {
        cid: seq
        for cid, seq in (
            await session.execute(
                select(ChatRead.channel_id, ChatRead.last_read_seq).where(
                    ChatRead.user_id == me, ChatRead.channel_id.in_(ids)
                )
            )
        ).all()
    }
    joined = and_(ChatRead.channel_id == ChatMessage.channel_id, ChatRead.user_id == me)
    unread = {
        cid: n
        for cid, n in (
            await session.execute(
                select(ChatMessage.channel_id, func.count())
                .select_from(ChatMessage)
                .outerjoin(ChatRead, joined)
                .where(
                    ChatMessage.channel_id.in_(ids),
                    ChatMessage.author_id != me,
                    ChatMessage.deleted_at.is_(None),
                    ChatMessage.seq > func.coalesce(ChatRead.last_read_seq, 0),
                )
                .group_by(ChatMessage.channel_id)
            )
        ).all()
    }
    mentions = {
        cid: n
        for cid, n in (
            await session.execute(
                select(ChatMessage.channel_id, func.count())
                .select_from(ChatMention)
                .join(ChatMessage, ChatMessage.id == ChatMention.message_id)
                .outerjoin(ChatRead, joined)
                .where(
                    ChatMention.user_id == me,
                    ChatMessage.channel_id.in_(ids),
                    ChatMessage.seq > func.coalesce(ChatRead.last_read_seq, 0),
                )
                .group_by(ChatMessage.channel_id)
            )
        ).all()
    }
    return {cid: (read_to.get(cid, 0), unread.get(cid, 0), mentions.get(cid, 0)) for cid in ids}


async def message_views(
    session: AsyncSession, ctx: ChatContext, messages: list[ChatMessage]
) -> list[MessageOut]:
    """Messages with their reactions and mentions, in the order given. A deleted message
    carries no text and no reactions — it is a placeholder."""
    if not messages:
        return []
    ids = [m.id for m in messages]
    reactions: dict[uuid.UUID, dict[str, list[uuid.UUID]]] = {}
    for mid, emoji, uid in (
        await session.execute(
            select(ChatReaction.message_id, ChatReaction.emoji, ChatReaction.user_id)
            .where(ChatReaction.message_id.in_(ids))
            .order_by(ChatReaction.created_at, ChatReaction.user_id)
        )
    ).all():
        reactions.setdefault(mid, {}).setdefault(emoji, []).append(uid)
    carried: dict[uuid.UUID, list[AttachmentOut]] = {}
    for att in (
        await session.execute(
            select(ChatAttachment)
            .where(ChatAttachment.message_id.in_(ids))
            .order_by(ChatAttachment.position, ChatAttachment.created_at, ChatAttachment.id)
        )
    ).scalars():
        assert att.message_id is not None
        carried.setdefault(att.message_id, []).append(attachments.view(att))
    mentioned: dict[uuid.UUID, list[uuid.UUID]] = {}
    for mid, uid in (
        await session.execute(
            select(ChatMention.message_id, ChatMention.user_id).where(
                ChatMention.message_id.in_(ids)
            )
        )
    ).all():
        mentioned.setdefault(mid, []).append(uid)

    def number(user_id: uuid.UUID) -> str | None:
        person = ctx.users.get(str(user_id))
        return person.member_no if person else None

    return [
        MessageOut(
            id=m.id,
            channel_id=m.channel_id,
            seq=m.seq,
            rev=m.rev,
            author_id=m.author_id,
            author_no=number(m.author_id),
            text=m.text,
            kind=m.kind,
            meeting_id=m.meeting_id,
            quote_id=m.quote_id,
            created_at=m.created_at,
            edited_at=m.edited_at,
            deleted=m.deleted_at is not None,
            reactions=reactions.get(m.id, {}),
            mentions=sorted(mentioned.get(m.id, [])),
            client_msg_id=m.client_msg_id,
            attachments=carried.get(m.id, []),
        )
        for m in messages
    ]


async def sync_views(
    session: AsyncSession, ctx: ChatContext, changes: list[dict[str, Any]]
) -> list[SyncChannelOut]:
    out: list[SyncChannelOut] = []
    for change in changes:
        out.append(
            SyncChannelOut(
                channel_id=change["channel_id"],
                rev=change["rev"],
                reset=change["reset"],
                messages=await message_views(session, ctx, change["messages"]),
            )
        )
    return out
