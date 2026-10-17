"""Meetings: what a call leaves behind, who may read it, and the minutes.

Reading a meeting, changing who can, writing the minutes and posting them to the channel all go
through here, and every one starts the same way: load the meeting, and treat a channel the caller
cannot open as "no such meeting" (404, like a channel). The rules themselves are in
``meeting_rules.py`` (pure, checked against the prototype's answers); this file loads the facts,
applies them and writes.

**Meetings are not created by a person.** ``create_meeting`` is for the call service (a later
phase) and the demo seed: it writes the meeting, its people, transcript, notes and files, and the
``call`` line in the channel. A person can only read one, set who else may, ask for minutes, and
post them.

The minutes are written on the server (``minutes.py``) from the stored transcript, so a client can
neither feed the AI text the meeting never held nor store minutes of its own making.
"""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import Clock, FrozenClock
from app.core.config import Settings, get_settings
from app.core.errors import Conflict, Invalid, NotFound, PermissionDenied
from app.core.throttle import Throttle
from app.domain.chat import meeting_rules as rules
from app.domain.chat import messages, minutes
from app.domain.chat.access import Channel, Member
from app.domain.chat.models import (
    ChatChannel,
    ChatMeeting,
    ChatMeetingFile,
    ChatMeetingNote,
    ChatMeetingPerson,
    ChatMessage,
    ChatTranscriptLine,
    MeetingAccess,
    MeetingPersonRole,
)
from app.domain.chat.schemas import (
    ActionItemOut,
    MeetingBrief,
    MeetingFileOut,
    MeetingNoteOut,
    MeetingOut,
    SummaryOut,
    TranscriptLineOut,
)
from app.domain.chat.service import ChatContext, require_open
from app.domain.masters.models import User

_settings = get_settings()

#: AI minutes per person per day (the spend cap). Over it the rule-based minutes are written.
minutes_throttle = Throttle(
    "chat-minutes",
    limit=_settings.ai_minutes_per_day,
    window_seconds=_settings.ai_minutes_window_seconds,
    block_seconds=_settings.ai_minutes_window_seconds,
)

CALL_LINE_NAMES = 3
POST_MAX_CHARS = 3900


@dataclass(slots=True)
class Loaded:
    """A meeting with the people attached to it and the channel it was held in."""

    row: ChatMeeting
    channel: ChatChannel
    participants: list[uuid.UUID]
    readers: list[uuid.UUID]

    def facts(self) -> rules.Meeting:
        return rules.Meeting(
            id=str(self.row.id),
            host_id=str(self.row.host_id),
            participant_ids=frozenset(str(u) for u in self.participants),
            reader_ids=frozenset(str(u) for u in self.readers),
            access=self.row.access.value,
            files_view_only=self.row.files_view_only,
            log_channel_id=str(self.row.log_channel_id) if self.row.log_channel_id else None,
            summary_posted=self.row.summary_posted_at is not None,
            has_summary=self.row.summary is not None,
        )


# --- loading ----------------------------------------------------------------------------


async def _people(
    session: AsyncSession, ids: Sequence[uuid.UUID]
) -> dict[uuid.UUID, tuple[list[uuid.UUID], list[uuid.UUID]]]:
    found: dict[uuid.UUID, tuple[list[uuid.UUID], list[uuid.UUID]]] = {i: ([], []) for i in ids}
    if not ids:
        return found
    rows = (
        await session.execute(
            select(ChatMeetingPerson).where(ChatMeetingPerson.meeting_id.in_(ids))
        )
    ).scalars()
    for p in rows:
        side = found[p.meeting_id][0 if p.role == MeetingPersonRole.PARTICIPANT else 1]
        side.append(p.user_id)
    return found


def _ordered(ctx: ChatContext, host: uuid.UUID, people: list[uuid.UUID]) -> list[uuid.UUID]:
    """Host first, then by member number — so the list reads the same every time."""

    def key(u: uuid.UUID) -> tuple[int, str]:
        person = ctx.users.get(str(u))
        return (0 if u == host else 1, person.member_no or "" if person else str(u))

    return sorted(people, key=key)


async def load_many(
    session: AsyncSession, ctx: ChatContext, rows: Sequence[ChatMeeting]
) -> list[Loaded]:
    people = await _people(session, [m.id for m in rows])
    out: list[Loaded] = []
    for m in rows:
        channel = ctx.channels.get(m.channel_id)
        if channel is None:
            continue
        parts, readers = people[m.id]
        out.append(Loaded(m, channel, _ordered(ctx, m.host_id, parts), readers))
    return out


async def load(session: AsyncSession, ctx: ChatContext, meeting_id: uuid.UUID) -> Loaded:
    """The meeting, or 404 — also when it exists in a channel the caller cannot open."""
    row = await session.get(ChatMeeting, meeting_id)
    if row is None:
        raise NotFound("There is no such meeting.")
    require_open(ctx, row.channel_id)
    [loaded] = await load_many(session, ctx, [row])
    return loaded


async def for_channel(
    session: AsyncSession, ctx: ChatContext, channel_id: uuid.UUID
) -> list[Loaded]:
    require_open(ctx, channel_id)
    rows = (
        (
            await session.execute(
                select(ChatMeeting)
                .where(ChatMeeting.channel_id == channel_id)
                .order_by(ChatMeeting.started_at)
            )
        )
        .scalars()
        .all()
    )
    return await load_many(session, ctx, rows)


# --- how the caller sees it -------------------------------------------------------------


def _caller(ctx: ChatContext) -> Member:
    return ctx.me_member


def _channel_view(ctx: ChatContext, channel_id: uuid.UUID | None) -> Channel | None:
    channel = ctx.channels.get(channel_id) if channel_id else None
    return ctx.view(channel) if channel is not None else None


def _summary_out(m: ChatMeeting) -> SummaryOut | None:
    s = m.summary
    if s is None or m.summary_source not in ("ai", "offline", "seeded"):
        return None
    return SummaryOut(
        overview=s.get("overview", ""),
        agenda=s.get("agenda", []),
        discussion=s.get("discussion", []),
        decisions=s.get("decisions", []),
        action_items=[
            ActionItemOut(
                text=a["text"],
                owner_id=uuid.UUID(a["owner_id"]) if a.get("owner_id") else None,
                due=a.get("due"),
                task_no=a.get("task_no"),
            )
            for a in s.get("action_items", [])
        ],
        source=m.summary_source,  # type: ignore[arg-type]
        provider=m.summary_provider,
        model=m.summary_model,
        at=m.summary_at,
        by=m.summary_by,
    )


def brief(ctx: ChatContext, loaded: Loaded) -> MeetingBrief:
    m, facts = loaded.row, loaded.facts()
    channel = ctx.view(loaded.channel)
    me, pd = _caller(ctx), ctx.project_divisions
    return MeetingBrief(
        id=m.id,
        channel_id=m.channel_id,
        log_channel_id=m.log_channel_id,
        video=m.video,
        started_at=m.started_at,
        ended_at=m.ended_at,
        host_id=m.host_id,
        participant_ids=loaded.participants,
        access=m.access.value,
        files_view_only=m.files_view_only,
        has_summary=m.summary is not None,
        summary_posted_at=m.summary_posted_at,
        can_read=rules.can_see_meeting(me, facts, channel, pd),
        can_manage=rules.can_manage_meeting(me, facts, channel),
        can_open_files=rules.can_open_meeting_files(me, facts, channel, pd),
        can_post_summary=rules.can_post_summary(
            me, facts, channel, _channel_view(ctx, m.log_channel_id), pd
        ),
    )


async def view(session: AsyncSession, ctx: ChatContext, loaded: Loaded) -> MeetingOut:
    """What the caller may see of the meeting: the brief for everyone who can open the channel,
    plus what was said for those who may read it."""
    base = brief(ctx, loaded)
    out = MeetingOut(**base.model_dump())
    if not base.can_read:
        return out
    m = loaded.row
    out.summary = _summary_out(m)
    if base.can_manage:
        out.reader_ids = loaded.readers
    out.transcript = [
        TranscriptLineOut.model_validate(ln, from_attributes=True)
        for ln in (
            await session.execute(
                select(ChatTranscriptLine)
                .where(ChatTranscriptLine.meeting_id == m.id)
                .order_by(ChatTranscriptLine.position)
            )
        ).scalars()
    ]
    out.notes = [
        MeetingNoteOut.model_validate(n, from_attributes=True)
        for n in (
            await session.execute(
                select(ChatMeetingNote)
                .where(ChatMeetingNote.meeting_id == m.id)
                .order_by(ChatMeetingNote.position)
            )
        ).scalars()
    ]
    out.files = [
        MeetingFileOut.model_validate(f, from_attributes=True)
        for f in (
            await session.execute(
                select(ChatMeetingFile)
                .where(ChatMeetingFile.meeting_id == m.id)
                .order_by(ChatMeetingFile.position)
            )
        ).scalars()
    ]
    return out


# --- who may read it --------------------------------------------------------------------


async def set_access(
    session: AsyncSession,
    ctx: ChatContext,
    loaded: Loaded,
    *,
    mode: str,
    reader_ids: Sequence[uuid.UUID],
    files_view_only: bool | None,
) -> None:
    facts, channel = loaded.facts(), ctx.view(loaded.channel)
    me = _caller(ctx)
    if not rules.can_manage_meeting(me, facts, channel):
        raise PermissionDenied(
            "Only the host or the project manager can change who reads these minutes.",
            action="chat:meeting-access",
        )
    if not rules.access_change_allowed(me, facts, channel, mode):
        raise Invalid("The minutes of a direct-message call stay with the two people on it.")
    named: list[uuid.UUID] = []
    if mode == "people":
        wanted = [ctx.people[str(u)] for u in dict.fromkeys(reader_ids) if str(u) in ctx.people]
        named = [uuid.UUID(p.id) for p in rules.namable(wanted, channel, ctx.project_divisions)]
        # Someone who was on the call needs no naming.
        named = [u for u in named if u not in loaded.participants]
    row = loaded.row
    row.access = MeetingAccess(mode)
    if files_view_only is not None:
        row.files_view_only = files_view_only
    await session.execute(
        delete(ChatMeetingPerson).where(
            ChatMeetingPerson.meeting_id == row.id,
            ChatMeetingPerson.role == MeetingPersonRole.READER,
        )
    )
    for u in named:
        session.add(ChatMeetingPerson(meeting_id=row.id, user_id=u, role=MeetingPersonRole.READER))
    loaded.readers = named
    await session.flush()


# --- the minutes ------------------------------------------------------------------------


async def _source(
    session: AsyncSession, loaded: Loaded, lang: str, settings: Settings
) -> minutes.Meeting:
    """The meeting as the minutes are written from it: names, transcript, notes."""
    m = loaded.row
    ids = {m.host_id, *loaded.participants}
    lines = (
        (
            await session.execute(
                select(ChatTranscriptLine)
                .where(ChatTranscriptLine.meeting_id == m.id)
                .order_by(ChatTranscriptLine.position)
            )
        )
        .scalars()
        .all()
    )
    notes = (
        (
            await session.execute(
                select(ChatMeetingNote)
                .where(ChatMeetingNote.meeting_id == m.id)
                .order_by(ChatMeetingNote.position)
            )
        )
        .scalars()
        .all()
    )
    ids |= {ln.speaker_id for ln in lines} | {n.author_id for n in notes}
    users = {
        u.id: minutes.Person(u.id, u.full_name)
        for u in (await session.execute(select(User).where(User.id.in_(ids)))).scalars()
    }

    def who(u: uuid.UUID) -> minutes.Person:
        return users.get(u) or minutes.Person(u, "Someone")

    title = loaded.channel.name or "a direct message"
    return minutes.Meeting(
        title=title,
        started_at=m.started_at,
        ended_at=m.ended_at,
        video=m.video,
        participants=[who(u) for u in loaded.participants],
        lines=[minutes.Line(who(ln.speaker_id), ln.text) for ln in lines],
        notes=[minutes.Note(who(n.author_id), n.text) for n in notes],
        lang=lang,
        tz=settings.timezone,
    )


async def write_summary(
    session: AsyncSession,
    ctx: ChatContext,
    clock: Clock,
    loaded: Loaded,
    *,
    lang: str,
    use_ai: bool,
    settings: Settings | None = None,
    post: minutes.Post | None = None,
) -> str | None:
    """Write (or replace) the minutes and return why they are not AI-written, if they are not.

    The first minutes may be written by anyone who can read the meeting; replacing them is the
    host's or the PM's. The AI is asked only when connected, requested and under the person's
    daily cap; otherwise the rule-based minutes are written and the reason is returned.
    """
    settings = settings or get_settings()
    if not rules.can_write_summary(
        _caller(ctx), loaded.facts(), ctx.view(loaded.channel), ctx.project_divisions
    ):
        raise PermissionDenied(
            "You cannot write these minutes: they are restricted, or already written and "
            "only the host or the project manager can replace them.",
            action="chat:meeting-summary",
        )
    source = await _source(session, loaded, lang, settings)
    if not source.lines and not source.notes:
        raise Invalid("There is nothing to summarise yet: this meeting has no transcript or notes.")

    ai_allowed = True
    if use_ai and minutes.configured(settings):
        # Count the attempt first and commit it, so a burst cannot all pass before any is counted.
        verdict = await minutes_throttle.attempt(session, [f"user:{ctx.me.id}"], now=clock.now())
        await session.commit()
        ai_allowed = verdict.allowed
    result = await minutes.make(source, settings, ai_allowed=ai_allowed, use_ai=use_ai, post=post)

    row = loaded.row
    fresh = result.as_json()
    # An action item already made into a task keeps its task when the minutes are rewritten (matched
    # by its words), so regenerating never lets the same item become a second task.
    linked = {
        a["text"]: a["task_no"]
        for a in (row.summary or {}).get("action_items", [])
        if a.get("task_no")
    }
    for item in fresh["action_items"]:
        if item["text"] in linked:
            item["task_no"] = linked[item["text"]]
    row.summary = fresh
    row.summary_source = result.source
    row.summary_provider = result.provider
    row.summary_model = result.model
    row.summary_at = clock.now()
    row.summary_by = ctx.me.id
    await session.flush()
    return result.reason


def _post_text(ctx: ChatContext, loaded: Loaded) -> str:
    s = loaded.row.summary or {}
    day = loaded.row.ended_at.date().isoformat()
    parts = [f"Meeting summary ({day}): {s.get('overview', '')}"]
    if s.get("decisions"):
        parts.append(f"Decisions: {'; '.join(s['decisions'])}")
    if s.get("action_items"):
        items = []
        for a in s["action_items"]:
            owner = ctx.users.get(a["owner_id"]) if a.get("owner_id") else None
            items.append(f"{a['text']}{f' (@{owner.full_name})' if owner else ''}")
        parts.append(f"Action items: {'; '.join(items)}")
    return "\n".join(parts)[:POST_MAX_CHARS]


async def post_summary(
    session: AsyncSession, ctx: ChatContext, clock: Clock, loaded: Loaded
) -> ChatMessage:
    """Post the minutes in the channel they were held in — only when they are open to the whole
    channel, so posting can never show them to someone the host kept out."""
    facts, channel = loaded.facts(), ctx.view(loaded.channel)
    me, pd = _caller(ctx), ctx.project_divisions
    if not rules.can_see_meeting(me, facts, channel, pd):
        raise PermissionDenied("These minutes are restricted.", action="chat:meeting-post")
    log = _channel_view(ctx, loaded.row.log_channel_id)
    if not rules.can_post_summary(me, facts, channel, log, pd):
        if not facts.has_summary:
            why = "There are no minutes to post yet."
        elif facts.summary_posted:
            why = "These minutes were already posted."
        elif channel.dm or facts.access != "channel":
            why = "Minutes are posted only when they are open to the whole channel."
        else:
            why = "There is no channel to post these minutes to."
        raise Conflict(why)
    assert loaded.row.log_channel_id is not None
    message, _ = await messages.post_message(
        session, ctx, clock, loaded.row.log_channel_id, _post_text(ctx, loaded)
    )
    loaded.row.summary_posted_at = clock.now()
    await session.flush()
    return message


# --- creating one (the call service and the seed) ---------------------------------------


@dataclass(slots=True)
class NewLine:
    at: dt.datetime
    speaker_id: uuid.UUID
    text: str


@dataclass(slots=True)
class NewNote:
    author_id: uuid.UUID
    at: dt.datetime
    text: str


@dataclass(slots=True)
class NewFile:
    uploader_id: uuid.UUID
    filename: str
    size_bytes: int
    at: dt.datetime
    kind: str = "file"
    storage_key: str | None = None


def _call_line(ctx: ChatContext, host: User, row: ChatMeeting, people: list[uuid.UUID]) -> str:
    length = max(1, int((row.ended_at - row.started_at).total_seconds() / 60 + 0.5))
    names = [ctx.users[str(u)].full_name for u in people if str(u) in ctx.users]
    shown = ", ".join(names[:CALL_LINE_NAMES])
    more = f" +{len(names) - CALL_LINE_NAMES}" if len(names) > CALL_LINE_NAMES else ""
    return f"{'Video' if row.video else 'Voice'} call · {length} min · {shown}{more}"


async def create_meeting(
    session: AsyncSession,
    ctx: ChatContext,
    *,
    channel_id: uuid.UUID,
    started_at: dt.datetime,
    ended_at: dt.datetime,
    video: bool,
    participant_ids: Sequence[uuid.UUID],
    lines: Sequence[NewLine] = (),
    notes: Sequence[NewNote] = (),
    files: Sequence[NewFile] = (),
    access: MeetingAccess = MeetingAccess.PARTICIPANTS,
    reader_ids: Sequence[uuid.UUID] = (),
    files_view_only: bool = False,
    summary: dict[str, Any] | None = None,
    summary_source: str | None = None,
    summary_at: dt.datetime | None = None,
    log: bool = True,
) -> ChatMeeting:
    """Record a finished call. ``ctx`` is the host's: they are the host, and the call line in the
    channel is theirs. A direct-message call's access is always ``participants``."""
    channel = require_open(ctx, channel_id)
    if ended_at < started_at:
        raise Invalid("A meeting cannot end before it starts.")
    everyone = list(dict.fromkeys([ctx.me.id, *participant_ids]))
    if channel.is_dm:
        access, reader_ids = MeetingAccess.PARTICIPANTS, ()
    row = ChatMeeting(
        channel_id=channel.id,
        log_channel_id=channel.id,
        video=video,
        started_at=started_at,
        ended_at=ended_at,
        host_id=ctx.me.id,
        access=access,
        files_view_only=files_view_only,
        summary=summary,
        summary_source=summary_source if summary is not None else None,
        summary_at=summary_at if summary is not None else None,
        created_at=ended_at,
    )
    session.add(row)
    await session.flush()
    for u in everyone:
        session.add(
            ChatMeetingPerson(meeting_id=row.id, user_id=u, role=MeetingPersonRole.PARTICIPANT)
        )
    for u in dict.fromkeys(reader_ids):
        if u not in everyone:
            session.add(
                ChatMeetingPerson(meeting_id=row.id, user_id=u, role=MeetingPersonRole.READER)
            )
    for i, ln in enumerate(lines):
        session.add(
            ChatTranscriptLine(
                meeting_id=row.id, position=i, at=ln.at, speaker_id=ln.speaker_id, text=ln.text
            )
        )
    for i, n in enumerate(notes):
        session.add(
            ChatMeetingNote(
                meeting_id=row.id, author_id=n.author_id, at=n.at, text=n.text, position=i
            )
        )
    for i, f in enumerate(files):
        session.add(
            ChatMeetingFile(
                meeting_id=row.id,
                uploader_id=f.uploader_id,
                filename=f.filename,
                kind=f.kind,
                size_bytes=f.size_bytes,
                storage_key=f.storage_key,
                at=f.at,
                position=i,
            )  # fmt: skip
        )
    await session.flush()
    if log:
        text = _call_line(ctx, ctx.me, row, everyone)
        await messages.post_message(
            session, ctx, FrozenClock(ended_at), channel.id, text, kind="call", meeting_id=row.id
        )
    return row
