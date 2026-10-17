"""Channels, direct messages and join requests.

Every operation starts from a :class:`ChatContext`: the people in the workspace, which
divisions work on which projects, and every channel with its members and blocks. That is
tens of rows, loaded once per request, so the access rules in ``access.py`` — pure functions
over plain records — run on exactly the data the database holds, and no route carries rule
logic of its own.

Two answers are deliberately different for the same refusal. A channel the caller cannot see
is **404**, so private channels and DMs do not leak their existence; one they can see but may
not change is **403**.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any

from fastapi import Request
from sqlalchemy import delete, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import Clock
from app.core.errors import Conflict, Invalid, NotFound, PermissionDenied
from app.domain.audit.service import record_audit
from app.domain.chat import rules
from app.domain.chat.access import (
    Access,
    Channel,
    Member,
    can_create_channel,
    can_manage_channel,
    can_open_channel,
    discoverable_channels,
    member_project_ids,
    visible_channels,
)
from app.domain.chat.models import (
    AddedVia,
    ChannelAccess,
    ChatChannel,
    ChatChannelBlock,
    ChatChannelMember,
    ChatJoinRequest,
    JoinStatus,
)
from app.domain.masters.models import ProjectDivision, ProjectMember, User


@dataclass
class ChatContext:
    me: User
    #: Active workspace members, by ``str(user.id)``.
    users: dict[str, User]
    people: dict[str, Member]
    project_divisions: dict[str, list[str]]
    channels: dict[uuid.UUID, ChatChannel]
    members: dict[uuid.UUID, set[str]] = field(default_factory=dict)
    blocks: dict[uuid.UUID, set[str]] = field(default_factory=dict)

    @property
    def me_id(self) -> str:
        return str(self.me.id)

    @property
    def me_member(self) -> Member:
        return self.people[self.me_id]

    def view(self, channel: ChatChannel) -> Channel:
        """The channel as the access rules see it."""
        return Channel(
            id=str(channel.id),
            project_id=str(channel.project_id) if channel.project_id else None,
            dm=channel.is_dm,
            access=channel.access.value,
            divisions=tuple(channel.divisions or ()),
            member_ids=frozenset(self.members.get(channel.id, ())),
            blocked_ids=frozenset(self.blocks.get(channel.id, ())),
            listed=channel.listed,
        )

    def can_open(self, channel: ChatChannel) -> bool:
        return can_open_channel(self.me_member, self.view(channel), self.project_divisions)

    def can_manage(self, channel: ChatChannel) -> bool:
        return can_manage_channel(self.me_member, self.view(channel), self.project_divisions)

    def visible(self) -> list[ChatChannel]:
        views = {str(c.id): c for c in self.channels.values()}
        found = visible_channels(
            self.me_member, (self.view(c) for c in views.values()), self.project_divisions
        )
        return _ordered(views[v.id] for v in found)

    def discoverable(self) -> list[ChatChannel]:
        views = {str(c.id): c for c in self.channels.values()}
        found = discoverable_channels(
            self.me_member, (self.view(c) for c in views.values()), self.project_divisions
        )
        return _ordered(views[v.id] for v in found)


def _ordered(channels: Any) -> list[ChatChannel]:
    """Company channels first, then by project; DMs last; by name inside each."""
    return sorted(
        channels,
        key=lambda c: (c.is_dm, c.project_id is not None, str(c.project_id or ""), c.name, c.id),
    )


def _member_of(user: User, project_ids: tuple[str, ...]) -> Member:
    assert user.workspace_role is not None
    return Member(
        id=str(user.id),
        workspace_role=user.workspace_role.value,
        division=user.division,
        project_ids=project_ids,
    )


async def load_context(session: AsyncSession, user: User) -> ChatContext:
    """Everything the access rules need, in a handful of queries."""
    named: dict[uuid.UUID, list[str]] = {}
    for pm in (await session.execute(select(ProjectMember))).scalars():
        named.setdefault(pm.user_id, []).append(str(pm.project_id))

    users = {
        str(u.id): u
        for u in (
            await session.execute(
                select(User).where(User.workspace_role.is_not(None), User.active.is_(True))
            )
        ).scalars()
    }
    people = {uid: _member_of(u, tuple(named.get(u.id, ()))) for uid, u in users.items()}

    project_divisions: dict[str, list[str]] = {}
    for pd in (
        await session.execute(select(ProjectDivision).order_by(ProjectDivision.division))
    ).scalars():
        project_divisions.setdefault(str(pd.project_id), []).append(pd.division)

    channels = {
        c.id: c
        for c in (
            await session.execute(select(ChatChannel).where(ChatChannel.archived_at.is_(None)))
        ).scalars()
    }
    ctx = ChatContext(
        me=user, users=users, people=people, project_divisions=project_divisions, channels=channels
    )
    for cm in (await session.execute(select(ChatChannelMember))).scalars():
        ctx.members.setdefault(cm.channel_id, set()).add(str(cm.user_id))
    for cb in (await session.execute(select(ChatChannelBlock))).scalars():
        ctx.blocks.setdefault(cb.channel_id, set()).add(str(cb.user_id))
    return ctx


def member_projects(ctx: ChatContext, user: User) -> list[str]:
    return member_project_ids(ctx.people.get(str(user.id)), ctx.project_divisions)


# --- finding a channel ------------------------------------------------------------------


def require_open(ctx: ChatContext, channel_id: uuid.UUID) -> ChatChannel:
    channel = ctx.channels.get(channel_id)
    if channel is None or not ctx.can_open(channel):
        raise NotFound("There is no such channel.")
    return channel


def require_manage(ctx: ChatContext, channel_id: uuid.UUID) -> ChatChannel:
    channel = ctx.channels.get(channel_id)
    if channel is None:
        raise NotFound("There is no such channel.")
    if ctx.can_manage(channel):
        return channel
    if ctx.can_open(channel):
        raise PermissionDenied(
            "Only the project manager, or a division leader on this project, can change a channel.",
            action="chat:manage_channel",
        )
    # Cannot even see it: say nothing that confirms it exists.
    raise NotFound("There is no such channel.")


# --- channels ---------------------------------------------------------------------------

AUDITED = ("name", "topic", "access", "divisions", "listed")


def _channel_snapshot(ctx: ChatContext, c: ChatChannel) -> dict[str, Any]:
    return {
        "name": c.name,
        "topic": c.topic,
        "access": c.access.value,
        "divisions": sorted(c.divisions or ()),
        "listed": c.listed,
        "member_ids": sorted(ctx.members.get(c.id, ())),
        "blocked_ids": sorted(ctx.blocks.get(c.id, ())),
    }


def _name_taken(
    ctx: ChatContext, project_id: uuid.UUID | None, name: str, *, except_id: uuid.UUID | None = None
) -> bool:
    return any(
        not c.is_dm
        and c.id != except_id
        and c.project_id == project_id
        and c.name.lower() == name.lower()
        for c in ctx.channels.values()
    )


async def _replace_people(
    session: AsyncSession,
    channel: ChatChannel,
    ctx: ChatContext,
    *,
    member_ids: list[str],
    blocked_ids: list[str],
    creator: bool = False,
) -> None:
    """Make the member and block lists exactly these, touching only what changed."""
    now_members = ctx.members.get(channel.id, set())
    now_blocks = ctx.blocks.get(channel.id, set())

    gone_m = now_members - set(member_ids)
    if gone_m:
        await session.execute(
            delete(ChatChannelMember).where(
                ChatChannelMember.channel_id == channel.id,
                ChatChannelMember.user_id.in_([uuid.UUID(x) for x in gone_m]),
            )
        )
    for uid in member_ids:
        if uid not in now_members:
            via = AddedVia.CREATOR if creator and uid == ctx.me_id else AddedVia.SETTINGS
            session.add(
                ChatChannelMember(channel_id=channel.id, user_id=uuid.UUID(uid), added_via=via)
            )

    gone_b = now_blocks - set(blocked_ids)
    if gone_b:
        await session.execute(
            delete(ChatChannelBlock).where(
                ChatChannelBlock.channel_id == channel.id,
                ChatChannelBlock.user_id.in_([uuid.UUID(x) for x in gone_b]),
            )
        )
    for uid in blocked_ids:
        if uid not in now_blocks:
            session.add(
                ChatChannelBlock(
                    channel_id=channel.id, user_id=uuid.UUID(uid), blocked_by=ctx.me.id
                )
            )
    await session.flush()
    ctx.members[channel.id] = set(member_ids)
    ctx.blocks[channel.id] = set(blocked_ids)


async def create_channel(
    session: AsyncSession,
    ctx: ChatContext,
    *,
    project_id: uuid.UUID | None,
    name: str,
    topic: str,
    access: Access,
    divisions: list[str],
    member_ids: list[uuid.UUID],
    blocked_ids: list[uuid.UUID],
    listed: bool | None,
    request: Request | None = None,
) -> ChatChannel:
    """A new text channel on a project (or the company), by someone who may manage channels
    there."""
    pid = str(project_id) if project_id else None
    if not can_create_channel(ctx.me_member, pid, ctx.project_divisions):
        raise PermissionDenied(
            "Only the project manager, or a division leader on this project, can add channels.",
            action="chat:create_channel",
        )
    if pid is not None and pid not in ctx.project_divisions:
        raise Invalid("That project has no divisions yet, so it has no channels.")

    clean_name = rules.clean_channel_name(name)
    if not clean_name:
        raise Invalid("A channel needs a name with at least one letter or digit.")
    if _name_taken(ctx, project_id, clean_name):
        raise Conflict(f"There is already a #{clean_name} here.")

    cleaned = rules.clean_access(
        actor_id=ctx.me_id,
        project_id=pid,
        project_divisions=ctx.project_divisions,
        people=ctx.people,
        access=access,
        divisions=divisions,
        member_ids=[str(x) for x in member_ids],
        blocked_ids=[str(x) for x in blocked_ids],
        listed=listed,
    )
    channel = ChatChannel(
        project_id=project_id,
        name=clean_name,
        topic=rules.clean_topic(topic),
        access=ChannelAccess(cleaned.access),
        divisions=cleaned.divisions,
        listed=cleaned.listed,
        created_by=ctx.me.id,
    )
    session.add(channel)
    await session.flush()
    ctx.channels[channel.id] = channel
    await _replace_people(
        session, channel, ctx, member_ids=cleaned.member_ids, blocked_ids=cleaned.blocked_ids,
        creator=True,
    )  # fmt: skip
    await record_audit(
        session, actor=ctx.me, action="chat.channel.create", entity_type="chat_channel",
        entity_id=channel.id, after=_channel_snapshot(ctx, channel), request=request,
    )  # fmt: skip
    return channel


async def update_channel(
    session: AsyncSession,
    ctx: ChatContext,
    channel_id: uuid.UUID,
    patch: dict[str, Any],
    *,
    request: Request | None = None,
) -> ChatChannel:
    """Name, topic and who may join — by someone who may manage the channel."""
    channel = require_manage(ctx, channel_id)
    before = _channel_snapshot(ctx, channel)

    name = channel.name
    if patch.get("name") is not None:
        name = rules.clean_channel_name(patch["name"])
        if not name:
            raise Invalid("A channel needs a name with at least one letter or digit.")
        if _name_taken(ctx, channel.project_id, name, except_id=channel.id):
            raise Conflict(f"There is already a #{name} here.")

    pid = str(channel.project_id) if channel.project_id else None
    current_members = sorted(ctx.members.get(channel.id, ()))
    current_blocks = sorted(ctx.blocks.get(channel.id, ()))
    cleaned = rules.clean_access(
        actor_id=ctx.me_id,
        project_id=pid,
        project_divisions=ctx.project_divisions,
        people=ctx.people,
        access=patch.get("access") or channel.access.value,
        divisions=patch["divisions"] if patch.get("divisions") is not None else channel.divisions,
        member_ids=(
            [str(x) for x in patch["member_ids"]]
            if patch.get("member_ids") is not None
            else current_members
        ),
        blocked_ids=(
            [str(x) for x in patch["blocked_ids"]]
            if patch.get("blocked_ids") is not None
            else current_blocks
        ),
        listed=patch["listed"] if patch.get("listed") is not None else channel.listed,
        was_blocked=current_blocks,
    )

    channel.name = name
    if patch.get("topic") is not None:
        channel.topic = rules.clean_topic(patch["topic"])
    channel.access = ChannelAccess(cleaned.access)
    channel.divisions = cleaned.divisions
    channel.listed = cleaned.listed
    await session.flush()
    await _replace_people(
        session, channel, ctx, member_ids=cleaned.member_ids, blocked_ids=cleaned.blocked_ids
    )
    await record_audit(
        session, actor=ctx.me, action="chat.channel.update", entity_type="chat_channel",
        entity_id=channel.id, before=before, after=_channel_snapshot(ctx, channel),
        request=request,
    )  # fmt: skip
    return channel


# --- direct messages --------------------------------------------------------------------


async def open_dm(
    session: AsyncSession, ctx: ChatContext, other_id: uuid.UUID
) -> tuple[ChatChannel, bool]:
    """The caller's DM with another team member, made on first use. Returns ``(channel,
    created)``. Asking twice — or both people asking at once — gives the same channel."""
    other = ctx.users.get(str(other_id))
    if other is None:
        raise NotFound("There is no such team member.")
    if other.id == ctx.me.id:
        raise Invalid("You cannot message yourself.")
    lo, hi = sorted((ctx.me.id, other.id))

    # ON CONFLICT DO NOTHING waits for a concurrent insert of the same pair to finish, so the
    # loser of a race simply reads the winner's row — one DM per pair, never two.
    won = (
        await session.execute(
            pg_insert(ChatChannel)
            .values(
                id=uuid.uuid4(),
                name="",
                topic="",
                access=ChannelAccess.PROJECT,
                divisions=[],
                listed=False,
                is_dm=True,
                dm_lo=lo,
                dm_hi=hi,
                created_by=ctx.me.id,
                rev=0,
            )  # fmt: skip
            .on_conflict_do_nothing(index_elements=["dm_lo", "dm_hi"], index_where=text("is_dm"))
            .returning(ChatChannel.id)
        )
    ).scalar_one_or_none()

    channel = (
        await session.execute(
            select(ChatChannel).where(
                ChatChannel.is_dm.is_(True), ChatChannel.dm_lo == lo, ChatChannel.dm_hi == hi
            )
        )
    ).scalar_one()
    if won is not None:
        for uid in (lo, hi):
            session.add(
                ChatChannelMember(channel_id=channel.id, user_id=uid, added_via=AddedVia.DM)
            )
        await session.flush()
    ctx.channels[channel.id] = channel
    ctx.members[channel.id] = {str(lo), str(hi)}
    return channel, won is not None


# --- join requests ----------------------------------------------------------------------


async def request_join(
    session: AsyncSession,
    ctx: ChatContext,
    channel_id: uuid.UUID,
    note: str,
    *,
    request: Request | None = None,
) -> ChatJoinRequest:
    """Ask into a channel the caller can see locked. One open request at a time."""
    allowed = {c.id for c in ctx.discoverable()}
    if channel_id not in allowed:
        raise NotFound("There is no such channel to ask into.")
    jr = ChatJoinRequest(
        channel_id=channel_id, user_id=ctx.me.id, note=rules.clean_note(note),
        status=JoinStatus.PENDING,
    )  # fmt: skip
    try:
        async with session.begin_nested():
            session.add(jr)
            await session.flush()
    except IntegrityError as exc:
        raise Conflict("You have already asked to join this channel.") from exc
    # created_at is a server default: unloaded after the flush, and touching it later would
    # try a lazy load, which asyncio refuses (MissingGreenlet).
    await session.refresh(jr, ["created_at"])
    await record_audit(
        session, actor=ctx.me, action="chat.join_request.create",
        entity_type="chat_channel", entity_id=channel_id, detail={"request_id": str(jr.id)},
        request=request,
    )  # fmt: skip
    return jr


async def list_join_requests(
    session: AsyncSession,
    ctx: ChatContext,
    channel_id: uuid.UUID,
    *,
    pending_only: bool = True,
) -> list[ChatJoinRequest]:
    require_manage(ctx, channel_id)
    stmt = select(ChatJoinRequest).where(ChatJoinRequest.channel_id == channel_id)
    if pending_only:
        stmt = stmt.where(ChatJoinRequest.status == JoinStatus.PENDING)
    return list((await session.execute(stmt.order_by(ChatJoinRequest.created_at))).scalars())


async def decide_join_request(
    session: AsyncSession,
    ctx: ChatContext,
    request_id: uuid.UUID,
    approve: bool,
    clock: Clock,
    *,
    request: Request | None = None,
) -> ChatJoinRequest:
    """Approve (lets them in, lifting any block) or decline a pending request."""
    jr = await session.get(ChatJoinRequest, request_id)
    if jr is None:
        raise NotFound("There is no such join request.")
    channel = require_manage(ctx, jr.channel_id)
    if jr.user_id == ctx.me.id:
        raise Invalid("You cannot decide your own request.")
    if jr.status is not JoinStatus.PENDING:
        raise Conflict("That request has already been answered.")

    jr.status = JoinStatus.APPROVED if approve else JoinStatus.DECLINED
    jr.decided_by = ctx.me.id
    jr.decided_at = clock.now()
    if approve:
        await session.execute(
            pg_insert(ChatChannelMember)
            .values(channel_id=channel.id, user_id=jr.user_id, added_via=AddedVia.REQUEST)
            .on_conflict_do_nothing()
        )
        await session.execute(
            delete(ChatChannelBlock).where(
                ChatChannelBlock.channel_id == channel.id, ChatChannelBlock.user_id == jr.user_id
            )
        )
        ctx.members.setdefault(channel.id, set()).add(str(jr.user_id))
        ctx.blocks.get(channel.id, set()).discard(str(jr.user_id))
    await session.flush()
    await record_audit(
        session, actor=ctx.me, action="chat.join_request.decide",
        entity_type="chat_channel", entity_id=channel.id,
        detail={"request_id": str(jr.id), "user_id": str(jr.user_id), "approved": approve},
        request=request,
    )  # fmt: skip
    return jr


async def my_requests(session: AsyncSession, ctx: ChatContext) -> dict[uuid.UUID, JoinStatus]:
    """The caller's latest answer per channel."""
    rows = (
        await session.execute(
            select(ChatJoinRequest)
            .where(ChatJoinRequest.user_id == ctx.me.id)
            .order_by(ChatJoinRequest.created_at)
        )
    ).scalars()
    return {r.channel_id: r.status for r in rows}
