"""Meeting endpoints: what a call left behind, who may read it, and the minutes.

Who may do what, server-side (the rules are in ``meeting_rules.py``):

* every endpoint needs the ``chat`` module and a workspace persona (``ChatMember``);
* a meeting in a channel the caller cannot open answers 404, like the channel itself;
* anyone who can open the channel sees *that* a meeting happened and who was on it; only people
  the rules allow read the minutes, transcript, notes and file names (``can_read``);
* the host (or, for a channel call, the PM) changes who may read, and may replace written minutes;
* anyone who can read the meeting may write the first minutes, and the server writes them from
  the stored transcript — the client sends only the language and whether to use the AI.

Meetings are created by the call service and the demo seed, never over HTTP by a person.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Request, status

from app.core.clock import ClockDep
from app.core.deps import ChatMember
from app.db.session import SessionDep
from app.domain.chat import events, meeting_tasks, meetings, messages, service, views
from app.domain.chat.hub import get_hub
from app.domain.chat.schemas import (
    MeetingAccessIn,
    MeetingBrief,
    MeetingOut,
    MeetingTasksOut,
    MessageOut,
    SkippedItem,
    SummaryRequest,
    SummaryResult,
)
from app.domain.workspace import events as workspace_events
from app.domain.workspace import tasks as workspace_tasks

router = APIRouter(prefix="/chat", tags=["chat"])


@router.get("/channels/{channel_id}/meetings", response_model=list[MeetingBrief])
async def list_meetings(
    session: SessionDep, user: ChatMember, channel_id: uuid.UUID
) -> list[MeetingBrief]:
    """The calls held in a channel, oldest first: that each happened, who was on it, and what the
    caller may do with it. Nothing that was said."""
    ctx = await service.load_context(session, user)
    return [meetings.brief(ctx, m) for m in await meetings.for_channel(session, ctx, channel_id)]


@router.get("/meetings/{meeting_id}", response_model=MeetingOut)
async def get_meeting(session: SessionDep, user: ChatMember, meeting_id: uuid.UUID) -> MeetingOut:
    """One meeting. For someone who may not read it, ``can_read`` is false and the minutes,
    transcript, notes and files are empty."""
    ctx = await service.load_context(session, user)
    return await meetings.view(session, ctx, await meetings.load(session, ctx, meeting_id))


@router.patch("/meetings/{meeting_id}/access", response_model=MeetingOut)
async def set_access(
    session: SessionDep, user: ChatMember, meeting_id: uuid.UUID, body: MeetingAccessIn
) -> MeetingOut:
    """Who may read the minutes and open the files — the host, or the PM (not for a DM call).
    ``people`` names extra readers; anyone who cannot open the channel is dropped. A DM call's
    minutes always stay with the two people on it."""
    ctx = await service.load_context(session, user)
    loaded = await meetings.load(session, ctx, meeting_id)
    await meetings.set_access(
        session, ctx, loaded, mode=body.mode, reader_ids=body.reader_ids,
        files_view_only=body.files_view_only,
    )  # fmt: skip
    out = await meetings.view(session, ctx, loaded)
    await session.commit()
    events.quietly(events.meeting_event, get_hub(), ctx, loaded.channel, loaded.row.id)
    return out


@router.post("/meetings/{meeting_id}/summary", response_model=SummaryResult)
async def write_summary(
    session: SessionDep, clock: ClockDep, user: ChatMember, meeting_id: uuid.UUID,
    body: SummaryRequest,
) -> SummaryResult:  # fmt: skip
    """Write the minutes (summary, agenda, discussion, decisions, action items) from the stored
    transcript and notes. An AI service writes them when one is connected and the caller is under
    their daily cap; otherwise rules do, and ``reason`` says why. Anyone who can read the meeting
    may write the first minutes; replacing them is the host's or the PM's."""
    ctx = await service.load_context(session, user)
    loaded = await meetings.load(session, ctx, meeting_id)
    reason = await meetings.write_summary(
        session, ctx, clock, loaded, lang=body.lang, use_ai=body.use_ai
    )
    out = await meetings.view(session, ctx, loaded)
    await session.commit()
    events.quietly(events.meeting_event, get_hub(), ctx, loaded.channel, loaded.row.id)
    return SummaryResult(meeting=out, reason=reason)


@router.post(
    "/meetings/{meeting_id}/post-summary",
    response_model=MessageOut,
    status_code=status.HTTP_201_CREATED,
)
async def post_summary(
    session: SessionDep, clock: ClockDep, user: ChatMember, meeting_id: uuid.UUID
) -> MessageOut:
    """Post the minutes in the channel — once, and only when they are open to the whole channel
    (never a DM call), so posting cannot show them to someone the host kept out."""
    await messages.check_send_rate(session, user.id, clock)
    ctx = await service.load_context(session, user)
    loaded = await meetings.load(session, ctx, meeting_id)
    message = await meetings.post_summary(session, ctx, clock, loaded)
    await session.commit()
    hub = get_hub()
    await events.safely(events.message_event(session, ctx, hub, "message.new", message))
    events.quietly(events.meeting_event, hub, ctx, loaded.channel, loaded.row.id)
    return (await views.message_views(session, ctx, [message]))[0]


@router.post("/meetings/{meeting_id}/tasks", response_model=MeetingTasksOut)
async def tasks_from_meeting(
    session: SessionDep, clock: ClockDep, user: ChatMember, meeting_id: uuid.UUID, request: Request
) -> MeetingTasksOut:
    """Turn the minutes' action items into tasks, as if the caller had made each by hand: only for
    people they may assign on the call's project, with a due date that has not passed, and never
    twice (an item remembers its task, even when the minutes are rewritten). What could not be
    made is listed with why."""
    ctx = await service.load_context(session, user)
    loaded = await meetings.load(session, ctx, meeting_id)
    made = await meeting_tasks.create_tasks(session, ctx, clock, loaded, request)
    out = await meetings.view(session, ctx, loaded)
    await session.commit()
    hub = get_hub()
    for row in made.rows:
        [shown] = await workspace_tasks.views(session, made.directory, clock, [row])
        events.quietly(workspace_events.task_event, hub, made.directory, "task.created", shown, row)
    events.quietly(events.meeting_event, hub, ctx, loaded.channel, loaded.row.id)
    return MeetingTasksOut(
        meeting=out,
        created=[r.task_no for r in made.rows],
        skipped=[SkippedItem(text=t, why=w) for t, w in made.skipped],
    )
