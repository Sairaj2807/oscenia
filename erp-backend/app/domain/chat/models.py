"""Chat channels, who is in them, who is kept out, and who has asked to join.

Ported from the prototype's ``channels`` slice (``useProto.js`` ~284-320, 708-783). A
channel's *rule* (``access`` plus ``divisions``) says who may open it by default;
``chat_channel_members`` lets named people in on top of the rule, and ``chat_channel_blocks``
keeps people out whatever the rule says. The PM is never blocked and never needs letting in.

A direct message is a channel too, with exactly two members and ``dm_lo`` / ``dm_hi`` set to
their ids in sorted order — so one pair of people can only ever have one, and opening it twice
at once cannot make two. Voice rooms and live calls are not stored (they have no media server
yet); what a call *leaves behind* is: a meeting record with its people, transcript and minutes.

``rev`` is a per-channel counter taken under the channel's row lock whenever anything in the
channel changes (phase C2 uses it). Unlike a global identity column it commits in order, so a
client that reconnects and asks "what changed after rev N" can never skip a row.
"""

from __future__ import annotations

import datetime as dt
import enum
import uuid
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.domain.masters.models import enum_column


class ChannelAccess(enum.StrEnum):
    PROJECT = "project"
    DIVISIONS = "divisions"
    INVITE = "invite"


class JoinStatus(enum.StrEnum):
    PENDING = "pending"
    APPROVED = "approved"
    DECLINED = "declined"


class AddedVia(enum.StrEnum):
    CREATOR = "creator"
    SETTINGS = "settings"
    REQUEST = "request"
    DM = "dm"
    SEED = "seed"


_ZERO_UUID = "00000000-0000-0000-0000-000000000000"


class ChatChannel(Base):
    __tablename__ = "chat_channels"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    #: A stable slug for seeded channels (``ch-gala-general``); NULL for ones people make.
    key: Mapped[str | None] = mapped_column(String(64), unique=True, nullable=True)
    #: NULL means a company channel.
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("projects.id"), nullable=True, index=True
    )
    #: Lower-case, ``-`` for spaces, at most 32 characters (``channelName`` in the prototype).
    #: Empty for a DM.
    name: Mapped[str] = mapped_column(String(40), default="")
    topic: Mapped[str] = mapped_column(String(120), default="")
    access: Mapped[ChannelAccess] = mapped_column(
        enum_column(ChannelAccess, "chat_access"), default=ChannelAccess.PROJECT
    )
    divisions: Mapped[list[str]] = mapped_column(
        ARRAY(String(64)), default=list, server_default=text("'{}'")
    )
    #: Whether people who cannot open it see it, locked, with "Request to join".
    listed: Mapped[bool] = mapped_column(Boolean, default=True)

    is_dm: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    dm_lo: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    dm_hi: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )

    rev: Mapped[int] = mapped_column(BigInteger, default=0, server_default="0")
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    archived_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        CheckConstraint("is_dm = (dm_lo IS NOT NULL AND dm_hi IS NOT NULL)", name="dm_has_pair"),
        CheckConstraint("NOT is_dm OR dm_lo < dm_hi", name="dm_pair_sorted"),
        CheckConstraint("is_dm OR name <> ''", name="channel_has_name"),
        CheckConstraint(
            "access <> 'divisions' OR cardinality(divisions) > 0", name="divisions_rule_has_some"
        ),
        # One DM per pair, so opening it twice at once cannot make two.
        Index("uq_chat_dm_pair", "dm_lo", "dm_hi", unique=True, postgresql_where=text("is_dm")),
        # A name is unique within its server (a project, or the company), ignoring case.
        Index(
            "uq_chat_channel_name",
            text(f"coalesce(project_id, '{_ZERO_UUID}'::uuid)"),
            text("lower(name)"),
            unique=True,
            postgresql_where=text("NOT is_dm AND archived_at IS NULL"),
        ),
    )


class ChatChannelMember(Base):
    """Let in by name — on top of the channel's rule. A DM has exactly two of these."""

    __tablename__ = "chat_channel_members"

    channel_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("chat_channels.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    added_via: Mapped[AddedVia] = mapped_column(enum_column(AddedVia, "chat_added_via"))
    added_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (Index("ix_chat_channel_members_user", "user_id"),)


class ChatChannelBlock(Base):
    """Kept out, whatever the rule says. The PM is never blocked; the service refuses it."""

    __tablename__ = "chat_channel_blocks"

    channel_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("chat_channels.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    blocked_by: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    blocked_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class ChatJoinRequest(Base):
    """Someone asking into a channel they can see locked.

    Answers are kept as history; only one request per person per channel can be *pending*.
    """

    __tablename__ = "chat_join_requests"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    channel_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("chat_channels.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE")
    )
    note: Mapped[str] = mapped_column(String(200), default="")
    status: Mapped[JoinStatus] = mapped_column(
        enum_column(JoinStatus, "chat_join_status"), default=JoinStatus.PENDING
    )
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    decided_by: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    decided_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        CheckConstraint(
            "(status = 'pending') = (decided_at IS NULL)", name="decided_iff_not_pending"
        ),
        Index(
            "uq_chat_join_pending",
            "channel_id",
            "user_id",
            unique=True,
            postgresql_where=text("status = 'pending'"),
        ),
    )


#: The five reactions the prototype offers (``REACTIONS`` in ``chat.js``). The database holds
#: the same list, so a client cannot invent one.
REACTIONS: tuple[str, ...] = ("👍", "🙌", "✅", "👀", "❤️")


class ChatMessage(Base):
    """One message. ``seq`` orders the channel and never changes; ``rev`` moves forward every
    time the message does (an edit, a delete, a reaction), so a reconnecting client can ask
    "what changed after rev N" and not miss a thing.

    Both come from the channel's own counter, taken under its row lock, so they commit in the
    order they were handed out — which a global identity column does not guarantee.

    A deleted message stays as a tombstone (``deleted_at`` set, ``text`` empty) so the stream
    keeps its shape and a reply quoting it still points somewhere.
    """

    __tablename__ = "chat_messages"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    channel_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("chat_channels.id", ondelete="CASCADE")
    )
    seq: Mapped[int] = mapped_column(BigInteger)
    rev: Mapped[int] = mapped_column(BigInteger)
    author_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), ForeignKey("users.id"))
    #: Mentions and task links are stored as ids — ``<@M-05>``, ``<#T-102>`` — so a renamed
    #: person still resolves and a mention can notify the right one.
    text: Mapped[str] = mapped_column(Text, default="")
    kind: Mapped[str] = mapped_column(String(12), default="text", server_default="text")
    quote_id: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True), nullable=True)
    #: Set by the service from the injected clock, never by the database, so the edit window
    #: is measured on the same clock that checks it.
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    edited_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    deleted_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    deleted_by: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    #: The meeting a ``call`` line is the log of; empty for ordinary messages.
    meeting_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("chat_meetings.id", ondelete="SET NULL"), nullable=True
    )
    #: Lets a client retry a send safely: the same id from the same author is the same message.
    client_msg_id: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True), nullable=True)

    __table_args__ = (
        UniqueConstraint("channel_id", "seq", name="uq_chat_messages_channel_seq"),
        # A quote must be in the same channel: the pair is the referenced key.
        UniqueConstraint("channel_id", "id", name="uq_chat_messages_channel_id"),
        ForeignKeyConstraint(
            ["channel_id", "quote_id"],
            ["chat_messages.channel_id", "chat_messages.id"],
            name="fk_chat_messages_quote_same_channel",
        ),
        UniqueConstraint("author_id", "client_msg_id", name="uq_chat_messages_client_msg"),
        CheckConstraint("kind IN ('text', 'call')", name="kind_known"),
        CheckConstraint("char_length(text) <= 4000", name="text_not_too_long"),
        CheckConstraint(
            "deleted_at IS NOT NULL OR length(btrim(text)) > 0", name="live_message_has_text"
        ),
        CheckConstraint("deleted_at IS NULL OR text = ''", name="deleted_message_is_empty"),
        Index("ix_chat_messages_channel_rev", "channel_id", "rev"),
    )


class ChatReaction(Base):
    __tablename__ = "chat_reactions"

    message_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("chat_messages.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    emoji: Mapped[str] = mapped_column(String(16), primary_key=True)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint("emoji IN ('" + "', '".join(REACTIONS) + "')", name="emoji_is_offered"),
    )


class ChatMention(Base):
    """Who a message mentioned. Written when the message is, so "what mentioned me" is an
    index lookup rather than a scan of message text."""

    __tablename__ = "chat_mentions"

    message_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("chat_messages.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    channel_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("chat_channels.id", ondelete="CASCADE")
    )
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))

    __table_args__ = (Index("ix_chat_mentions_user", "user_id", "created_at"),)


class ChatRead(Base):
    """How far a person has read in a channel. Only ever moves forward."""

    __tablename__ = "chat_reads"

    user_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    channel_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("chat_channels.id", ondelete="CASCADE"), primary_key=True
    )
    last_read_seq: Mapped[int] = mapped_column(BigInteger, default=0, server_default="0")


class ChatAttachment(Base):
    """A file in a channel. Uploaded first (``message_id`` empty), then linked when the message
    that carries it is posted — so a client can show upload progress per file and a failed send
    does not lose the upload.

    The file itself lives in the storage backend under a content-addressed ``storage_key``, which
    other modules may share: deleting an attachment (or its message) removes this row, never the
    stored bytes. Reaching the bytes is by a short-lived signed URL minted after an access check;
    an upload nobody attached within a day is removed (``purge_orphans``).
    """

    __tablename__ = "chat_attachments"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    channel_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("chat_channels.id", ondelete="CASCADE")
    )
    message_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("chat_messages.id", ondelete="CASCADE"), nullable=True
    )
    uploader_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), ForeignKey("users.id"))
    storage_key: Mapped[str] = mapped_column(String(200))
    #: What it is called on screen: the uploaded name with any path and control characters
    #: removed. Display only — the stored name is a hash.
    filename: Mapped[str] = mapped_column(String(120))
    content_type: Mapped[str] = mapped_column(String(80))
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    #: Where it sits among the files of its message: the order the sender listed them in.
    position: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint("size_bytes > 0", name="has_bytes"),
        Index("ix_chat_attachments_message", "message_id"),
        # The purge looks for old uploads nobody attached.
        Index(
            "ix_chat_attachments_unlinked",
            "created_at",
            postgresql_where=text("message_id IS NULL"),
        ),
    )


# --- meetings ---------------------------------------------------------------------------


class MeetingAccess(enum.StrEnum):
    """Who may read a meeting's minutes, beyond the people who were on the call."""

    PARTICIPANTS = "participants"
    CHANNEL = "channel"
    PEOPLE = "people"


class MeetingPersonRole(enum.StrEnum):
    PARTICIPANT = "participant"
    #: Named by the host to read the minutes without having been on the call.
    READER = "reader"


class ChatMeeting(Base):
    """What a call leaves behind: who was there, what was said, and the minutes.

    Created when a call ends (the call service, a later phase) or by the demo seed — never by a
    person directly. The host decides who may read it (``access``); the rules are in
    ``meeting_rules.py`` and are re-checked on every read, so losing access to the channel
    takes the minutes with it.
    """

    __tablename__ = "chat_meetings"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    #: The channel the call was held in (a voice room's text channel, a DM, or a text channel).
    channel_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("chat_channels.id", ondelete="CASCADE")
    )
    #: Where the call line was logged and the minutes may be posted: the channel itself, or for
    #: a voice room its home text channel. Empty when no channel the room's callers share could
    #: hold it.
    log_channel_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("chat_channels.id", ondelete="SET NULL"), nullable=True
    )
    video: Mapped[bool] = mapped_column(Boolean, default=False)
    started_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    host_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), ForeignKey("users.id"))

    access: Mapped[MeetingAccess] = mapped_column(
        enum_column(MeetingAccess, "chat_meeting_access"), default=MeetingAccess.PARTICIPANTS
    )
    #: When set, others may see the file names and sizes but only the host (or PM) opens them.
    files_view_only: Mapped[bool] = mapped_column(Boolean, default=False)

    #: ``{overview, agenda[], discussion[], decisions[], action_items[{text, owner_id, due}]}``.
    summary: Mapped[dict[str, Any] | None] = mapped_column(JSONB(none_as_null=True), nullable=True)
    #: ``ai``, ``offline`` (rule-based, no AI service) or ``seeded`` (the demo data).
    summary_source: Mapped[str | None] = mapped_column(String(12), nullable=True)
    summary_provider: Mapped[str | None] = mapped_column(String(32), nullable=True)
    summary_model: Mapped[str | None] = mapped_column(String(64), nullable=True)
    summary_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    summary_by: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    #: Set once the minutes were posted to the channel, so they are not posted twice by accident.
    summary_posted_at: Mapped[dt.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint("ended_at >= started_at", name="ends_after_it_starts"),
        CheckConstraint(
            "(summary IS NULL) = (summary_source IS NULL)", name="summary_has_a_source"
        ),
        Index("ix_chat_meetings_channel", "channel_id", "started_at"),
    )


class ChatMeetingPerson(Base):
    """Who was on a call, and who else the host let read the minutes."""

    __tablename__ = "chat_meeting_people"

    meeting_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("chat_meetings.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id"), primary_key=True
    )
    role: Mapped[MeetingPersonRole] = mapped_column(
        enum_column(MeetingPersonRole, "chat_meeting_person_role")
    )


class ChatTranscriptLine(Base):
    __tablename__ = "chat_transcript_lines"

    meeting_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("chat_meetings.id", ondelete="CASCADE"), primary_key=True
    )
    #: Order within the meeting.
    position: Mapped[int] = mapped_column(Integer, primary_key=True)
    at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    speaker_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), ForeignKey("users.id"))
    text: Mapped[str] = mapped_column(Text)


class ChatMeetingNote(Base):
    """A note typed during the call."""

    __tablename__ = "chat_meeting_notes"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    meeting_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("chat_meetings.id", ondelete="CASCADE")
    )
    author_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), ForeignKey("users.id"))
    at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    text: Mapped[str] = mapped_column(Text)
    position: Mapped[int] = mapped_column(Integer, default=0)

    __table_args__ = (Index("ix_chat_meeting_notes_meeting", "meeting_id", "position"),)


class ChatMeetingFile(Base):
    """A file shared during the call. The listing only: opening the bytes comes with the call
    service that uploads them, so a seeded file has no ``storage_key``."""

    __tablename__ = "chat_meeting_files"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    meeting_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("chat_meetings.id", ondelete="CASCADE")
    )
    uploader_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), ForeignKey("users.id"))
    filename: Mapped[str] = mapped_column(String(120))
    kind: Mapped[str] = mapped_column(String(16), default="file")
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    storage_key: Mapped[str | None] = mapped_column(String(200), nullable=True)
    at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    position: Mapped[int] = mapped_column(Integer, default=0)

    __table_args__ = (Index("ix_chat_meeting_files_meeting", "meeting_id", "position"),)
