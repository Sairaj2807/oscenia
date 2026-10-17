"""What makes a channel's name and access fields valid.

Ported from the prototype's ``channelName`` and ``cleanAccess`` (``useProto.js`` 284-317).
Pure functions: they take the people and projects that exist as arguments, so they are tested
without a database and the service stays a thin layer over them.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass

from app.core.errors import Invalid
from app.domain.chat.access import Access, Member

#: The divisions a company channel may be restricted to (``DIVISIONS`` in ``protoSeed.js``).
#: A project channel is restricted to the divisions that work on that project instead.
DIVISIONS: tuple[str, ...] = ("Field", "Design", "Production")

NAME_MAX = 32
TOPIC_MAX = 120
NOTE_MAX = 200


def clean_channel_name(name: str) -> str:
    """``Gala Day 1!`` -> ``gala-day-1``: lower-case, ``-`` for spaces, letters, digits and
    hyphens only, no leading, trailing or doubled hyphens, at most 32 characters."""
    s = re.sub(r"\s+", "-", name.strip().lower())
    s = re.sub(r"[^a-z0-9-]", "", s)
    s = re.sub(r"-+", "-", s)
    return s.strip("-")[:NAME_MAX]


def clean_topic(topic: str) -> str:
    return topic.strip()[:TOPIC_MAX]


def clean_note(note: str) -> str:
    return note.strip()[:NOTE_MAX]


def _unique(items: Iterable[str]) -> list[str]:
    return list(dict.fromkeys(items))


@dataclass(frozen=True, slots=True)
class CleanAccess:
    access: Access
    divisions: list[str]
    member_ids: list[str]
    blocked_ids: list[str]
    listed: bool


def clean_access(
    *,
    actor_id: str,
    project_id: str | None,
    project_divisions: Mapping[str, Sequence[str]],
    people: Mapping[str, Member],
    access: Access,
    divisions: Iterable[str],
    member_ids: Iterable[str],
    blocked_ids: Iterable[str],
    listed: bool | None,
    was_blocked: Iterable[str] = (),
) -> CleanAccess:
    """The access fields of a channel, cleaned against who exists and what the project has.

    Raises ``Invalid`` when the rule makes no sense (a divisions rule with no division).
    ``was_blocked`` is the channel's current block list, so an edit cannot lift a block on
    the person making it.
    """
    allowed = list(project_divisions.get(project_id, ())) if project_id else list(DIVISIONS)
    chosen = [d for d in _unique(divisions) if d in allowed]
    if access == "divisions" and not chosen:
        raise Invalid("Pick at least one division for a channel restricted by division.")

    was = list(was_blocked)
    # The PM can't be blocked, and nobody blocks themselves — nor lifts a block on themselves.
    blocked = [
        b
        for b in _unique([*blocked_ids, *(w for w in was if w == actor_id)])
        if b in people and (b != actor_id or b in was) and people[b].workspace_role != "pm"
    ]
    members = [m for m in _unique(member_ids) if m in people and m not in blocked]
    # Whoever makes a channel invite-only stays in it.
    if access == "invite" and actor_id not in members and actor_id not in blocked:
        members.append(actor_id)

    if listed is None:
        # An invite-only company channel (#leaders) stays out of sight by default.
        listed = not (access == "invite" and project_id is None)
    return CleanAccess(
        access=access,
        divisions=chosen if access == "divisions" else [],
        member_ids=members,
        blocked_ids=blocked,
        listed=bool(listed),
    )
