"""Who may read a meeting's minutes, change who can, and post them to the channel.

A line-for-line port of ``erp-frontend/src/lib/meetings.js`` (``canSeeMeeting``,
``canManageMeeting``, ``canOpenMeetingFiles``) and of the guards in ``useProto.js``
(``setMeetingAccess``, ``saveMeetingSummary``, ``postMeetingSummary``). Pure functions over small
frozen records, like ``access.py``, so ``tests/test_chat_meeting_rules.py`` can drive them
directly and the routes only have to load the facts.

The rules worth reading twice:

* **A direct-message call is for its two people.** Never the PM, never a named reader, whatever
  the host asks. Its access mode cannot leave ``participants``.
* **The PM reads every channel call**, not DM calls.
* **Losing the channel loses the minutes.** Everything below first asks whether the person can
  still *open the channel*; a participant moved off the project reads nothing.
* **Posting the minutes to the channel is only allowed when they are open to the whole channel**
  (``access == channel``), so posting can never show them to someone the host kept out.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Literal

from app.domain.chat.access import (
    Channel,
    Member,
    ProjectDivisions,
    can_open_channel,
)

AccessMode = Literal["participants", "channel", "people"]
ACCESS_MODES: tuple[AccessMode, ...] = ("participants", "channel", "people")


@dataclass(frozen=True, slots=True)
class Meeting:
    id: str
    host_id: str
    participant_ids: frozenset[str] = field(default_factory=frozenset)
    #: People the host named to read the minutes (only used when ``access == "people"``).
    reader_ids: frozenset[str] = field(default_factory=frozenset)
    access: AccessMode = "participants"
    files_view_only: bool = False
    #: Where the call line and the minutes may be posted. ``None`` when no channel could hold it.
    log_channel_id: str | None = None
    summary_posted: bool = False
    has_summary: bool = False


def can_see_meeting(
    member: Member | None,
    meeting: Meeting,
    channel: Channel | None,
    project_divisions: ProjectDivisions,
) -> bool:
    """Can ``member`` read this meeting's minutes, transcript and file list?"""
    if (
        member is None
        or channel is None
        or not can_open_channel(member, channel, project_divisions)
    ):
        return False
    if member.id == meeting.host_id or member.id in meeting.participant_ids:
        return True
    # A call in a direct message is for its two people: never the PM, never anyone else.
    if channel.dm:
        return False
    if member.workspace_role == "pm":
        return True
    if meeting.access == "channel":
        return True
    return meeting.access == "people" and member.id in meeting.reader_ids


def can_manage_meeting(member: Member | None, meeting: Meeting, channel: Channel | None) -> bool:
    """The host decides who sees the minutes; the PM may too, except for a DM call."""
    if member is None or channel is None:
        return False
    return meeting.host_id == member.id or (member.workspace_role == "pm" and not channel.dm)


def can_open_meeting_files(
    member: Member | None,
    meeting: Meeting,
    channel: Channel | None,
    project_divisions: ProjectDivisions,
) -> bool:
    """View-only files show a name and size to everyone who can read the meeting; only the host
    (or PM) can still open them."""
    return can_see_meeting(member, meeting, channel, project_divisions) and (
        not meeting.files_view_only or can_manage_meeting(member, meeting, channel)
    )


def access_change_allowed(
    member: Member | None, meeting: Meeting, channel: Channel | None, mode: str
) -> bool:
    """May ``member`` set the minutes' access to ``mode``?"""
    if mode not in ACCESS_MODES or not can_manage_meeting(member, meeting, channel):
        return False
    # A DM call's minutes stay with the people on the call, whatever is asked.
    return not (channel is not None and channel.dm and mode != "participants")


def namable(
    people: Iterable[Member], channel: Channel, project_divisions: ProjectDivisions
) -> list[Member]:
    """Of the people the host named, those who can open the channel. The rest could never read
    the minutes, so naming them would only look like a share that does nothing."""
    return [p for p in people if can_open_channel(p, channel, project_divisions)]


def can_write_summary(
    member: Member | None,
    meeting: Meeting,
    channel: Channel | None,
    project_divisions: ProjectDivisions,
) -> bool:
    """Writing the first minutes is open to anyone who can read the meeting; replacing them is
    the host's (or PM's)."""
    if not can_see_meeting(member, meeting, channel, project_divisions):
        return False
    return not meeting.has_summary or can_manage_meeting(member, meeting, channel)


def can_post_summary(
    member: Member | None,
    meeting: Meeting,
    channel: Channel | None,
    log_channel: Channel | None,
    project_divisions: ProjectDivisions,
) -> bool:
    """May ``member`` post the minutes to the channel?

    Only once, only when open to the whole channel, never in a DM, and only to a channel the
    poster can still open (the destination is checked again: access may have changed since).
    """
    if not meeting.has_summary or meeting.summary_posted or meeting.log_channel_id is None:
        return False
    if channel is None or channel.dm or meeting.access != "channel":
        return False
    if not can_see_meeting(member, meeting, channel, project_divisions):
        return False
    return log_channel is not None and can_open_channel(member, log_channel, project_divisions)
