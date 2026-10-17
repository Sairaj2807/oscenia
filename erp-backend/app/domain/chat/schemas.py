"""Request and response shapes for chat (channels, DMs, join requests, the workspace).

People are referred to by user id on the wire; ``member_no`` (``M-05``) travels alongside
because it is what stored message text mentions. Whether a caller sees a channel's member and
block lists is decided in the service, not here: only someone who can manage a channel does.
"""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Literal

from pydantic import BaseModel, Field

from app.core.schemas import Schema

AccessName = Literal["project", "divisions", "invite"]
WorkspaceRoleName = Literal["pm", "leader", "staff", "intern"]


# --- the workspace ---------------------------------------------------------------------


class MemberOut(Schema):
    id: uuid.UUID
    member_no: str
    name: str
    initials: str
    workspace_role: WorkspaceRoleName
    division: str | None
    title: str | None
    #: Projects they work on: the PM's are all, a leader's follow their division, staff and
    #: interns are named.
    project_ids: list[uuid.UUID]


class ProjectOut(Schema):
    id: uuid.UUID
    project_no: str
    name: str
    divisions: list[str]
    #: What the workspace's project cards show. No money: a team member sees who it is for, when,
    #: where it stands and who is in charge. Empty where the answer is not on file.
    client_name: str | None = None
    event_date: dt.date | None = None
    stage: str | None = None
    pm_name: str | None = None


class WorkspaceUpdate(BaseModel):
    """Put a login in the workspace, change its place there, or (``null`` role) take it out."""

    workspace_role: WorkspaceRoleName | None
    division: str | None = Field(default=None, max_length=64)
    title: str | None = Field(default=None, max_length=80)


class WorkspaceUserOut(Schema):
    id: uuid.UUID
    email: str
    name: str
    member_no: str | None
    workspace_role: WorkspaceRoleName | None
    division: str | None
    title: str | None


class ProjectMembersOut(Schema):
    user_ids: list[uuid.UUID]


class ProjectDivisionsIn(BaseModel):
    divisions: list[str] = Field(max_length=20)


class ProjectMembersIn(BaseModel):
    user_ids: list[uuid.UUID] = Field(max_length=500)


# --- channels --------------------------------------------------------------------------


class ChannelCreate(BaseModel):
    project_id: uuid.UUID | None = None
    name: str = Field(min_length=1, max_length=80)
    topic: str = Field(default="", max_length=400)
    access: AccessName = "project"
    divisions: list[str] = Field(default_factory=list, max_length=20)
    member_ids: list[uuid.UUID] = Field(default_factory=list, max_length=500)
    blocked_ids: list[uuid.UUID] = Field(default_factory=list, max_length=500)
    listed: bool | None = None


class ChannelUpdate(BaseModel):
    """Every field optional; only the ones sent change. Sending ``member_ids`` or
    ``blocked_ids`` replaces the whole list."""

    name: str | None = Field(default=None, max_length=80)
    topic: str | None = Field(default=None, max_length=400)
    access: AccessName | None = None
    divisions: list[str] | None = Field(default=None, max_length=20)
    member_ids: list[uuid.UUID] | None = Field(default=None, max_length=500)
    blocked_ids: list[uuid.UUID] | None = Field(default=None, max_length=500)
    listed: bool | None = None


class ChannelOut(Schema):
    id: uuid.UUID
    key: str | None
    project_id: uuid.UUID | None
    project_no: str | None
    name: str
    topic: str
    access: AccessName
    divisions: list[str]
    listed: bool
    is_dm: bool
    #: For a DM, the other person.
    dm_with: uuid.UUID | None
    #: Visible but not openable: shown with "Request to join".
    locked: bool
    can_manage: bool
    #: Only for someone who can manage the channel; ``None`` for everyone else.
    member_ids: list[uuid.UUID] | None
    blocked_ids: list[uuid.UUID] | None
    #: For a locked channel: the caller's own latest request, if any.
    my_request: Literal["pending", "approved", "declined"] | None
    #: The channel's change counter: a client that has seen up to ``rev`` is up to date.
    rev: int = 0
    #: How far the caller has read, and what is waiting beyond that (not their own, not deleted).
    last_read_seq: int = 0
    unread: int = 0
    unread_mentions: int = 0


class BootstrapOut(Schema):
    me: MemberOut
    #: The status the caller chose (online, idle, dnd or invisible).
    my_status: str = "online"
    #: Who is connected right now, as the caller is allowed to see them: user id -> status.
    #: Anyone missing is offline; an invisible person reads as offline to everyone but themselves.
    presence: dict[uuid.UUID, str] = Field(default_factory=dict)
    members: list[MemberOut]
    projects: list[ProjectOut]
    channels: list[ChannelOut]
    discoverable: list[ChannelOut]


class StatusIn(BaseModel):
    status: Literal["online", "idle", "dnd", "invisible"]


class StatusOut(Schema):
    status: str


class DmCreate(BaseModel):
    user_id: uuid.UUID


# --- join requests ---------------------------------------------------------------------


class JoinRequestCreate(BaseModel):
    note: str = Field(default="", max_length=400)


class JoinDecision(BaseModel):
    approve: bool


class JoinRequestOut(Schema):
    id: uuid.UUID
    channel_id: uuid.UUID
    user_id: uuid.UUID
    member_no: str | None
    name: str
    note: str
    status: Literal["pending", "approved", "declined"]
    created_at: dt.datetime
    decided_by: uuid.UUID | None
    decided_at: dt.datetime | None


# --- messages --------------------------------------------------------------------------


class AttachmentOut(Schema):
    id: uuid.UUID
    #: What to show. Display only: any path and control characters are stripped.
    filename: str
    content_type: str
    size_bytes: int
    #: A signed link that works for a few minutes. Ask ``GET /chat/attachments/{id}/url`` for a
    #: fresh one; that re-checks that you may still see the channel.
    url: str


class MessageCreate(BaseModel):
    #: Mentions and task links as stored tokens: ``<@M-05>``, ``<#T-102>``.
    text: str = Field(min_length=1, max_length=20000)
    quote_id: uuid.UUID | None = None
    #: A retry with the same id from the same sender is the same message, not a second.
    client_msg_id: uuid.UUID | None = None
    #: Files uploaded to this channel by you and not yet sent (``POST .../attachments``): at most
    #: five. The message still needs some text — a caption is enough.
    attachment_ids: list[uuid.UUID] = Field(default_factory=list, max_length=20)


class MessageEdit(BaseModel):
    text: str = Field(min_length=1, max_length=20000)


class MessageOut(Schema):
    id: uuid.UUID
    channel_id: uuid.UUID
    #: Orders the channel; never changes.
    seq: int
    #: Moves forward whenever the message does (edit, delete, reaction).
    rev: int
    author_id: uuid.UUID
    author_no: str | None
    text: str
    kind: str
    quote_id: uuid.UUID | None
    created_at: dt.datetime
    edited_at: dt.datetime | None
    deleted: bool
    #: emoji -> who reacted. Empty for a deleted message.
    reactions: dict[str, list[uuid.UUID]]
    mentions: list[uuid.UUID]
    client_msg_id: uuid.UUID | None
    attachments: list[AttachmentOut] = Field(default_factory=list)
    #: For a ``call`` line: the meeting it is the log of.
    meeting_id: uuid.UUID | None = None


class MessagePage(Schema):
    messages: list[MessageOut]
    has_more_before: bool
    has_more_after: bool


class ReadIn(BaseModel):
    seq: int = Field(ge=0)


class ReadOut(Schema):
    channel_id: uuid.UUID
    last_read_seq: int


class SyncIn(BaseModel):
    #: channel id -> the highest ``rev`` the client has seen there.
    cursors: dict[uuid.UUID, int] = Field(max_length=200)


class SyncChannelOut(Schema):
    channel_id: uuid.UUID
    rev: int
    #: Too much changed to replay: drop the local copy and fetch the newest page.
    reset: bool
    messages: list[MessageOut]


class SyncOut(Schema):
    channels: list[SyncChannelOut]


# --- notifications ---------------------------------------------------------------------


class NotificationOut(Schema):
    #: Stable per thing it points at (``mention:<message id>``), so a client can dedupe a
    #: live ``notification.new`` against the list it fetched.
    id: str
    kind: Literal[
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
    at: dt.datetime
    title: str
    body: str
    #: The in-app path that opens the thing itself.
    to: str
    #: ``False``/``True`` for a mention (read once you have read past it, on any device);
    #: ``None`` where the server keeps no read state and the client does.
    read: bool | None


class NotificationsOut(Schema):
    items: list[NotificationOut]
    unread_mentions: int


# --- meetings ---------------------------------------------------------------------------

MeetingAccessName = Literal["participants", "channel", "people"]


class ActionItemOut(Schema):
    text: str
    #: Always someone who was on the call, or empty.
    owner_id: uuid.UUID | None
    #: ``YYYY-MM-DD`` or empty.
    due: str | None
    #: The task made from it (``T-405``), once there is one: an item is never made a task twice.
    task_no: str | None = None


class SummaryOut(Schema):
    overview: str
    agenda: list[str]
    discussion: list[str]
    decisions: list[str]
    action_items: list[ActionItemOut]
    #: ``ai`` (a connected AI service wrote it), ``offline`` (rules, no AI) or ``seeded`` (the
    #: demo data). Checked on the way in, never taken from a client.
    source: Literal["ai", "offline", "seeded"]
    provider: str | None
    model: str | None
    at: dt.datetime | None
    by: uuid.UUID | None


class TranscriptLineOut(Schema):
    at: dt.datetime
    speaker_id: uuid.UUID
    text: str


class MeetingNoteOut(Schema):
    id: uuid.UUID
    author_id: uuid.UUID
    at: dt.datetime
    text: str


class MeetingFileOut(Schema):
    id: uuid.UUID
    filename: str
    kind: str
    size_bytes: int
    uploader_id: uuid.UUID
    at: dt.datetime


class MeetingBrief(Schema):
    """A meeting as the people who can open its channel see it: that it happened, who was on
    it, and what *they* may do with it. Nothing said in it."""

    id: uuid.UUID
    channel_id: uuid.UUID
    log_channel_id: uuid.UUID | None
    video: bool
    started_at: dt.datetime
    ended_at: dt.datetime
    host_id: uuid.UUID
    participant_ids: list[uuid.UUID]
    access: MeetingAccessName
    files_view_only: bool
    has_summary: bool
    summary_posted_at: dt.datetime | None
    #: The caller may read the minutes, transcript and file list.
    can_read: bool
    can_manage: bool
    can_open_files: bool
    can_post_summary: bool


class MeetingOut(MeetingBrief):
    """The same, with what was said — filled in only when ``can_read``."""

    #: Named readers, for the people who manage the meeting; empty for everyone else.
    reader_ids: list[uuid.UUID] = Field(default_factory=list)
    summary: SummaryOut | None = None
    transcript: list[TranscriptLineOut] = Field(default_factory=list)
    notes: list[MeetingNoteOut] = Field(default_factory=list)
    files: list[MeetingFileOut] = Field(default_factory=list)


class MeetingAccessIn(BaseModel):
    mode: MeetingAccessName
    #: Only used by ``people``: who else may read. People who cannot open the channel are dropped.
    reader_ids: list[uuid.UUID] = Field(default_factory=list, max_length=100)
    files_view_only: bool | None = None


class SummaryRequest(BaseModel):
    lang: Literal["en", "id"] = "en"
    #: False asks for the rule-based minutes (free, no AI), as the prototype's button did.
    use_ai: bool = True


class SummaryResult(Schema):
    meeting: MeetingOut
    #: Why these are not AI-written, when they are not: ``not_configured``, ``limit`` or
    #: ``failed``. Empty when the AI wrote them, or when rules were asked for.
    reason: str | None


class SkippedItem(Schema):
    text: str
    #: Why no task: no owner, no due date, or the rules said no (with their own words).
    why: str


class MeetingTasksOut(Schema):
    meeting: MeetingOut
    #: The numbers of the tasks just made (``T-405``).
    created: list[str]
    skipped: list[SkippedItem]
