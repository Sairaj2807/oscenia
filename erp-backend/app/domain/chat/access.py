"""Who may open, see, manage and create chat channels.

A line-for-line port of the channel half of ``erp-frontend/src/lib/workspaceAccess.js``
(lines 137-226). Pure functions over small frozen records, so the same rules run on
whatever the database returns — and so ``tests/test_chat_access.py`` can replay the
prototype's own answers (``tests/fixtures/chat_access_matrix.json``) and fail the moment the
two drift apart.

The prototype's checks decide what to draw; these decide what is allowed. Every route and
every WebSocket frame goes through them, because a client that skips the UI skips the
prototype's rules with it.

Ids are plain strings: ``M-05`` in the parity fixtures, a stringified UUID in production.
The order of the checks in :func:`can_open_channel` is the rule book — do not reorder.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Literal

WorkspaceRoleName = Literal["pm", "leader", "staff", "intern"]
Access = Literal["project", "divisions", "invite"]

#: ``project_id -> divisions that work on it`` (``projectDivisions`` in the prototype).
ProjectDivisions = Mapping[str, Sequence[str]]


@dataclass(frozen=True, slots=True)
class Member:
    id: str
    workspace_role: WorkspaceRoleName
    division: str | None = None
    #: Staff and interns only: the projects they are named on. Leaders and the PM derive
    #: theirs from ``ProjectDivisions``.
    project_ids: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class Channel:
    id: str
    project_id: str | None = None
    dm: bool = False
    access: Access = "project"
    divisions: tuple[str, ...] = ()
    member_ids: frozenset[str] = field(default_factory=frozenset)
    blocked_ids: frozenset[str] = field(default_factory=frozenset)
    listed: bool = True
    voice: bool = False


def member_project_ids(member: Member | None, project_divisions: ProjectDivisions) -> list[str]:
    """Project ids this member works on."""
    if member is None:
        return []
    if member.workspace_role == "pm":
        return list(project_divisions)
    if member.workspace_role == "leader":
        return [pid for pid, divs in project_divisions.items() if member.division in divs]
    return list(member.project_ids)


def can_open_channel(
    member: Member | None, channel: Channel | None, project_divisions: ProjectDivisions
) -> bool:
    """Can ``member`` open ``channel``?"""
    if member is None or channel is None:
        return False
    # Direct messages are for their two people only — the PM included, who otherwise sees all.
    if channel.dm:
        return member.id in channel.member_ids
    if member.workspace_role == "pm":
        return True
    if member.id in channel.blocked_ids:
        return False
    # Someone moved off the project loses its channels, even ones they were let into.
    if channel.project_id and channel.project_id not in member_project_ids(
        member, project_divisions
    ):
        return False
    if member.id in channel.member_ids:
        return True
    if channel.access == "invite":
        return False
    return channel.access == "project" or member.division in channel.divisions


def visible_channels(
    member: Member | None, channels: Iterable[Channel], project_divisions: ProjectDivisions
) -> list[Channel]:
    """Channels a member can open: company-wide, their projects', ones they are let into,
    their DMs."""
    if member is None:
        return []
    return [c for c in channels if can_open_channel(member, c, project_divisions)]


def discoverable_channels(
    member: Member | None, channels: Iterable[Channel], project_divisions: ProjectDivisions
) -> list[Channel]:
    """Channels ``member`` sees listed but cannot open — shown locked, with "Request to join".
    Only on projects they work on (or company-wide), never when blocked, never a DM or an
    unlisted one."""
    if member is None or member.workspace_role == "pm":
        return []
    project_ids = member_project_ids(member, project_divisions)
    found: list[Channel] = []
    for c in channels:
        if c.dm or can_open_channel(member, c, project_divisions):
            continue
        if not c.listed or member.id in c.blocked_ids:
            continue
        if not c.project_id or c.project_id in project_ids:
            found.append(c)
    return found


def can_manage_channel(
    member: Member | None, channel: Channel | None, project_divisions: ProjectDivisions
) -> bool:
    """Who may change a channel's settings and decide join requests: the PM anywhere; on a
    project, also the leaders whose division works on it. Company channels are the PM's."""
    if member is None or channel is None or channel.dm:
        return False
    if member.workspace_role == "pm":
        return True
    # Blocked from a channel means no say over it either.
    if member.id in channel.blocked_ids:
        return False
    return (
        bool(channel.project_id)
        and member.workspace_role == "leader"
        and member.division in project_divisions.get(channel.project_id or "", ())
    )


def can_create_channel(
    member: Member | None, project_id: str | None, project_divisions: ProjectDivisions
) -> bool:
    """May ``member`` add channels to this server (``project_id``, or None for the company)?"""
    return can_manage_channel(member, Channel(id="", project_id=project_id), project_divisions)


def home_channel(channels: Iterable[Channel], project_id: str | None) -> Channel | None:
    """The main text channel of a project (or of the company): the first one open to
    everybody there. Found by its rule, so a renamed #general still counts.

    The prototype prefers one *named* ``general``; this record carries no name, so the caller
    passes channels already ordered the way it wants ties broken.
    """
    texts = [c for c in channels if not c.dm and not c.voice and c.project_id == project_id]
    open_ = [c for c in texts if c.access == "project"]
    pool = open_ or texts
    return pool[0] if pool else None
