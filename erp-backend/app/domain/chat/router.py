"""Chat endpoints: the workspace, channels, direct messages and join requests.

Who may do what, server-side:

* every endpoint needs the ``chat`` module **and** a workspace persona (``ChatMember``);
* creating a channel and changing its settings belong to the project manager and, on a
  project, the division leaders who work on it; the same people decide join requests;
* setting someone's place in the workspace, and who works on a project, needs
  ``manage_workspace`` (CEO, PM).

A channel the caller cannot see answers 404 — never 403 — so private channels and direct
messages do not reveal that they exist. Messages, reactions, read state and presence
are here too. The WebSocket (``ws.py``) only delivers: every write goes through these routes,
each commits first and is announced to connected clients after (``events.py``).
"""

from __future__ import annotations

import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, File, Query, Request, Response, UploadFile, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import ClockDep
from app.core.deps import ChatMember, ManagesWorkspace
from app.core.errors import NotFound
from app.db.session import SessionDep
from app.domain.ar.models import Project
from app.domain.audit.service import record_audit
from app.domain.chat import (
    attachments,
    events,
    messages,
    notifications,
    service,
    views,
    workspace,
)
from app.domain.chat.hub import get_hub
from app.domain.chat.models import ChatMessage
from app.domain.chat.schemas import (
    AttachmentOut,
    BootstrapOut,
    ChannelCreate,
    ChannelOut,
    ChannelUpdate,
    DmCreate,
    JoinDecision,
    JoinRequestCreate,
    JoinRequestOut,
    MessageCreate,
    MessageEdit,
    MessageOut,
    MessagePage,
    NotificationsOut,
    ProjectDivisionsIn,
    ProjectMembersIn,
    ProjectMembersOut,
    ProjectOut,
    ReadIn,
    ReadOut,
    StatusIn,
    StatusOut,
    SyncIn,
    SyncOut,
    WorkspaceUpdate,
    WorkspaceUserOut,
)
from app.domain.masters.models import ChatStatus, User, WorkspaceRole

router = APIRouter(prefix="/chat", tags=["chat"])


async def _channel_response(
    session: AsyncSession, ctx: service.ChatContext, channel_id: uuid.UUID
) -> ChannelOut:
    channel = ctx.channels[channel_id]
    nos = await views.project_numbers(
        session, {channel.project_id} if channel.project_id else set()
    )
    return views.channel_out(ctx, channel, project_nos=nos, requests={})


# --- the workspace ----------------------------------------------------------------------


@router.get("/bootstrap", response_model=BootstrapOut)
async def get_bootstrap(session: SessionDep, user: ChatMember) -> BootstrapOut:
    """Everything the chat screen needs to start: people, the caller's projects, the channels
    they can open and the ones they can see locked."""
    ctx = await service.load_context(session, user)
    body = await views.bootstrap(session, ctx)
    body.presence = {uuid.UUID(uid): st for uid, st in get_hub().snapshot(str(user.id)).items()}
    body.my_status = user.chat_status.value
    return body


@router.patch("/me/status", response_model=StatusOut)
async def set_status(session: SessionDep, user: ChatMember, body: StatusIn) -> StatusOut:
    """The status the caller chooses to show. Connected clients are told how they now look;
    ``invisible`` reads as offline to everyone but its owner."""
    user.chat_status = ChatStatus(body.status)
    await session.commit()
    get_hub().set_status(str(user.id), body.status)
    return StatusOut(status=body.status)


# --- channels ---------------------------------------------------------------------------


@router.post("/channels", response_model=ChannelOut, status_code=status.HTTP_201_CREATED)
async def create_channel(
    session: SessionDep, user: ChatMember, body: ChannelCreate, request: Request
) -> ChannelOut:
    ctx = await service.load_context(session, user)
    channel = await service.create_channel(
        session, ctx, project_id=body.project_id, name=body.name, topic=body.topic,
        access=body.access, divisions=body.divisions, member_ids=body.member_ids,
        blocked_ids=body.blocked_ids, listed=body.listed, request=request,
    )  # fmt: skip
    await session.commit()
    await events.safely(events.channel_event(session, ctx, get_hub(), "channel.created", channel))
    return await _channel_response(session, ctx, channel.id)


@router.patch("/channels/{channel_id}", response_model=ChannelOut)
async def update_channel(
    session: SessionDep, user: ChatMember, channel_id: uuid.UUID, body: ChannelUpdate,
    request: Request,
) -> ChannelOut:  # fmt: skip
    ctx = await service.load_context(session, user)
    hub = get_hub()
    existing = ctx.channels.get(channel_id)
    before = events.visible(hub, ctx, existing) if existing is not None else set()
    channel = await service.update_channel(
        session, ctx, channel_id, body.model_dump(exclude_unset=True), request=request
    )
    await session.commit()
    await events.safely(
        events.channel_event(session, ctx, hub, "channel.updated", channel, before_visible=before)
    )
    return await _channel_response(session, ctx, channel_id)


# --- direct messages --------------------------------------------------------------------


@router.post("/dms", response_model=ChannelOut)
async def open_dm(
    session: SessionDep, user: ChatMember, body: DmCreate, response: Response
) -> ChannelOut:
    """The caller's DM with another team member. 201 when this call made it, 200 when it was
    already there — asking twice, or both people at once, gives the same channel."""
    ctx = await service.load_context(session, user)
    channel, created = await service.open_dm(session, ctx, body.user_id)
    response.status_code = status.HTTP_201_CREATED if created else status.HTTP_200_OK
    await session.commit()
    if created:
        await events.safely(
            events.channel_event(session, ctx, get_hub(), "channel.created", channel)
        )
    return await _channel_response(session, ctx, channel.id)


# --- join requests ----------------------------------------------------------------------


@router.get("/channels/{channel_id}/join-requests", response_model=list[JoinRequestOut])
async def list_join_requests(
    session: SessionDep,
    user: ChatMember,
    channel_id: uuid.UUID,
    which: Annotated[Literal["pending", "all"], Query(alias="status")] = "pending",
) -> list[JoinRequestOut]:
    """Who has asked into a channel. For whoever can manage it; everyone else gets a 404."""
    ctx = await service.load_context(session, user)
    found = await service.list_join_requests(
        session, ctx, channel_id, pending_only=which == "pending"
    )
    return [views.join_request_out(ctx, jr) for jr in found]


@router.post(
    "/channels/{channel_id}/join-requests",
    response_model=JoinRequestOut,
    status_code=status.HTTP_201_CREATED,
)
async def request_join(
    session: SessionDep, user: ChatMember, channel_id: uuid.UUID, body: JoinRequestCreate,
    request: Request,
) -> JoinRequestOut:  # fmt: skip
    ctx = await service.load_context(session, user)
    jr = await service.request_join(session, ctx, channel_id, body.note, request=request)
    await session.commit()
    events.quietly(
        events.join_request_event, get_hub(), ctx, "join_request.created",
        ctx.channels[channel_id], jr,
    )  # fmt: skip
    return views.join_request_out(ctx, jr)


@router.post("/join-requests/{request_id}/decide", response_model=JoinRequestOut)
async def decide_join_request(
    session: SessionDep, clock: ClockDep, user: ChatMember, request_id: uuid.UUID,
    body: JoinDecision, request: Request,
) -> JoinRequestOut:  # fmt: skip
    ctx = await service.load_context(session, user)
    jr = await service.decide_join_request(
        session, ctx, request_id, body.approve, clock, request=request
    )
    await session.commit()
    hub = get_hub()
    channel = ctx.channels.get(jr.channel_id)
    if channel is not None:
        events.quietly(
            events.join_request_event, hub, ctx, "join_request.decided", channel, jr,
            also=[str(jr.user_id)],
        )  # fmt: skip
        if body.approve:  # the person let in now sees it open
            await events.safely(events.channel_event(session, ctx, hub, "channel.updated", channel))
    return views.join_request_out(ctx, jr)


# --- messages ---------------------------------------------------------------------------


@router.get("/channels/{channel_id}/messages", response_model=MessagePage)
async def list_messages(
    session: SessionDep,
    user: ChatMember,
    channel_id: uuid.UUID,
    before: Annotated[int | None, Query(ge=0, description="seq: older than this")] = None,
    after: Annotated[int | None, Query(ge=0, description="seq: newer than this")] = None,
    limit: Annotated[int, Query(ge=1, le=messages.PAGE_MAX)] = messages.PAGE_DEFAULT,
) -> MessagePage:
    """A page of messages, oldest first. No cursor: the newest page. ``before`` pages back
    through history, ``after`` forward. Keyed on ``seq``, so a page never shifts as messages
    arrive."""
    ctx = await service.load_context(session, user)
    page, more_before, more_after = await messages.list_messages(
        session, ctx, channel_id, before=before, after=after, limit=limit
    )
    return MessagePage(
        messages=await views.message_views(session, ctx, page),
        has_more_before=more_before,
        has_more_after=more_after,
    )


@router.post(
    "/channels/{channel_id}/messages",
    response_model=MessageOut,
    status_code=status.HTTP_201_CREATED,
)
async def post_message(
    session: SessionDep,
    clock: ClockDep,
    user: ChatMember,
    channel_id: uuid.UUID,
    body: MessageCreate,
    response: Response,
) -> MessageOut:
    """Post as the caller. Send a ``client_msg_id`` and a retry is safe: the same id from the
    same sender returns the original message (200) instead of posting a second."""
    await messages.check_send_rate(session, user.id, clock)
    ctx = await service.load_context(session, user)
    message, created = await messages.post_message(
        session, ctx, clock, channel_id, body.text, quote_id=body.quote_id,
        client_msg_id=body.client_msg_id, attachment_ids=body.attachment_ids,
    )  # fmt: skip
    if not created:
        response.status_code = status.HTTP_200_OK
    await session.commit()
    if created:
        hub = get_hub()
        await events.safely(events.message_event(session, ctx, hub, "message.new", message))
        await events.safely(
            events.mention_event(session, ctx, hub, ctx.channels[channel_id], message)
        )
    return (await views.message_views(session, ctx, [message]))[0]


@router.post(
    "/channels/{channel_id}/attachments",
    response_model=AttachmentOut,
    status_code=status.HTTP_201_CREATED,
)
async def upload_attachment(
    session: SessionDep,
    clock: ClockDep,
    user: ChatMember,
    channel_id: uuid.UUID,
    file: Annotated[UploadFile, File()],
) -> AttachmentOut:
    """Upload a file to a channel you can open, then send it by naming its id in
    ``attachment_ids`` when you post. PDF, PNG, JPEG, WebP, CSV and plain text; images are
    re-encoded (EXIF and GPS dropped). Uploads nobody attaches are removed after a day."""
    await attachments.check_upload_rate(session, user.id, clock)
    ctx = await service.load_context(session, user)
    attachment = await attachments.upload(session, ctx, clock, channel_id, file)
    await session.commit()
    return attachments.view(attachment)


@router.get("/attachments/{attachment_id}/url", response_model=AttachmentOut)
async def attachment_url(
    session: SessionDep, user: ChatMember, attachment_id: uuid.UUID
) -> AttachmentOut:
    """A fresh link to a file, after re-checking that you may still see its channel. Links in
    messages expire in minutes; ask here when you need one again."""
    ctx = await service.load_context(session, user)
    return attachments.view(await attachments.for_url(session, ctx, attachment_id))


@router.patch("/messages/{message_id}", response_model=MessageOut)
async def edit_message(
    session: SessionDep, clock: ClockDep, user: ChatMember, message_id: uuid.UUID, body: MessageEdit
) -> MessageOut:
    """The author, within the edit window (15 minutes by the server's clock)."""
    ctx = await service.load_context(session, user)
    mentioned_before = await messages.mentioned_user_ids(session, message_id)
    message = await messages.edit_message(session, ctx, clock, message_id, body.text)
    await session.commit()
    hub = get_hub()
    await events.safely(events.message_event(session, ctx, hub, "message.updated", message))
    await events.safely(
        events.mention_event(
            session, ctx, hub, ctx.channels[message.channel_id], message, already=mentioned_before
        )
    )
    return (await views.message_views(session, ctx, [message]))[0]


@router.delete("/messages/{message_id}", response_model=MessageOut)
async def delete_message(
    session: SessionDep, clock: ClockDep, user: ChatMember, message_id: uuid.UUID
) -> MessageOut:
    """Leaves a "message deleted" placeholder. The author within the window, or the project
    manager at any time. Deleting twice is not an error."""
    ctx = await service.load_context(session, user)
    existing = await session.get(ChatMessage, message_id)
    rev_before = existing.rev if existing is not None else None
    message = await messages.delete_message(session, ctx, clock, message_id)
    await session.commit()
    if message.rev != rev_before:  # deleting twice changes nothing and announces nothing
        await events.safely(
            events.message_event(session, ctx, get_hub(), "message.deleted", message)
        )
    return (await views.message_views(session, ctx, [message]))[0]


@router.put("/messages/{message_id}/reactions/{emoji}", response_model=MessageOut)
async def add_reaction(
    session: SessionDep, user: ChatMember, message_id: uuid.UUID, emoji: str
) -> MessageOut:
    """Idempotent: reacting twice leaves one reaction and does not toggle it off."""
    ctx = await service.load_context(session, user)
    existing = await session.get(ChatMessage, message_id)
    rev_before = existing.rev if existing is not None else None
    message = await messages.set_reaction(session, ctx, message_id, emoji, present=True)
    await session.commit()
    if message.rev != rev_before:
        await events.safely(
            events.message_event(session, ctx, get_hub(), "reaction.updated", message)
        )
    return (await views.message_views(session, ctx, [message]))[0]


@router.delete("/messages/{message_id}/reactions/{emoji}", response_model=MessageOut)
async def remove_reaction(
    session: SessionDep, user: ChatMember, message_id: uuid.UUID, emoji: str
) -> MessageOut:
    ctx = await service.load_context(session, user)
    existing = await session.get(ChatMessage, message_id)
    rev_before = existing.rev if existing is not None else None
    message = await messages.set_reaction(session, ctx, message_id, emoji, present=False)
    await session.commit()
    if message.rev != rev_before:
        await events.safely(
            events.message_event(session, ctx, get_hub(), "reaction.updated", message)
        )
    return (await views.message_views(session, ctx, [message]))[0]


@router.post("/channels/{channel_id}/read", response_model=ReadOut)
async def mark_read(
    session: SessionDep, user: ChatMember, channel_id: uuid.UUID, body: ReadIn
) -> ReadOut:
    """Everything up to ``seq`` counts as seen. Only moves forward."""
    ctx = await service.load_context(session, user)
    last = await messages.mark_read(session, ctx, channel_id, body.seq)
    await session.commit()
    events.quietly(events.read_event, get_hub(), str(user.id), str(channel_id), last)
    return ReadOut(channel_id=channel_id, last_read_seq=last)


@router.get("/notifications", response_model=NotificationsOut)
async def get_notifications(
    session: SessionDep,
    clock: ClockDep,
    user: ChatMember,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
) -> NotificationsOut:
    """What is waiting for the caller in chat: mentions in channels they can still open,
    requests they can decide, and the answers to their own. Worked out from the data each time,
    so it never disagrees with the message or request it points at. Action items come first,
    then newest first. New ones also arrive live as ``notification.new``."""
    ctx = await service.load_context(session, user)
    items = await notifications.build(session, ctx, clock, limit=limit)
    return NotificationsOut(
        items=items,
        unread_mentions=sum(1 for i in items if i.kind == "Mentioned you" and i.read is False),
    )


@router.post("/sync", response_model=SyncOut)
async def sync(session: SessionDep, user: ChatMember, body: SyncIn) -> SyncOut:
    """After a reconnect: send the highest ``rev`` seen per channel and get back everything
    that changed since — messages, edits, deletes and reactions. A channel you cannot open is
    left out. ``reset`` means too much changed to replay: refetch the newest page."""
    ctx = await service.load_context(session, user)
    changes = await messages.sync(session, ctx, body.cursors)
    return SyncOut(channels=await views.sync_views(session, ctx, changes))


# --- who is in the workspace (CEO, PM) --------------------------------------------------


@router.patch("/users/{user_id}/workspace", response_model=WorkspaceUserOut)
async def set_user_workspace(
    session: SessionDep, actor: ManagesWorkspace, user_id: uuid.UUID, body: WorkspaceUpdate,
    request: Request,
) -> WorkspaceUserOut:  # fmt: skip
    """Put a login in the workspace, change its role, division or title, or take it out
    (``workspace_role: null``). The member number is kept when someone leaves."""
    person = await session.get(User, user_id)
    if person is None:
        raise NotFound("There is no such user.")
    before = {
        "workspace_role": person.workspace_role.value if person.workspace_role else None,
        "division": person.division,
        "title": person.title,
    }
    await workspace.set_workspace(
        session,
        person,
        workspace_role=WorkspaceRole(body.workspace_role) if body.workspace_role else None,
        division=body.division,
        title=body.title,
    )
    await record_audit(
        session, actor=actor, action="chat.workspace.set", entity_type="user",
        entity_id=person.id, before=before,
        after={
            "workspace_role": person.workspace_role.value if person.workspace_role else None,
            "division": person.division,
            "title": person.title,
        },
        detail={"member_no": person.member_no}, request=request,
    )  # fmt: skip
    await session.commit()
    hub = get_hub()
    if person.workspace_role is None:  # taken out of the workspace: no more live updates
        await events.safely(hub.drop_user(str(person.id)))
    events.quietly(events.invalidate, hub, "workspace")
    return WorkspaceUserOut(
        id=person.id,
        email=person.email,
        name=person.full_name,
        member_no=person.member_no,
        workspace_role=person.workspace_role.value if person.workspace_role else None,
        division=person.division,
        title=person.title,
    )


@router.put("/projects/{project_id}/divisions", response_model=ProjectOut)
async def set_project_divisions(
    session: SessionDep, actor: ManagesWorkspace, project_id: uuid.UUID,
    body: ProjectDivisionsIn, request: Request,
) -> ProjectOut:  # fmt: skip
    """Which divisions work on a project. A leader reaches a project through this list."""
    divisions = await workspace.set_project_divisions(
        session, project_id, body.divisions, actor=actor, request=request
    )
    await session.commit()
    events.quietly(events.invalidate, get_hub(), "project")
    project = (await session.execute(select(Project).where(Project.id == project_id))).scalar_one()
    return ProjectOut(
        id=project.id, project_no=project.project_no, name=project.name, divisions=divisions
    )


@router.put("/projects/{project_id}/members", response_model=ProjectMembersOut)
async def set_project_members(
    session: SessionDep, actor: ManagesWorkspace, project_id: uuid.UUID,
    body: ProjectMembersIn, request: Request,
) -> ProjectMembersOut:  # fmt: skip
    """The staff and interns named on a project."""
    ids = await workspace.set_project_members(
        session, project_id, body.user_ids, actor=actor, request=request
    )
    await session.commit()
    events.quietly(events.invalidate, get_hub(), "project")
    return ProjectMembersOut(user_ids=ids)
