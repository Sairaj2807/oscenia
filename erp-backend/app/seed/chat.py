"""The prototype's team-chat demo: ten people, the four projects they work on, seventeen
channels and twenty-three messages.

The data is ``chat_seed.json``, exported from the prototype by
``erp-frontend/scripts/export-chat-seed.mjs`` rather than re-typed, so the access rules the
prototype's own checks assert hold here too (Rina, a Field staff member, sees ``#field`` on the
Gala but only a locked ``#production`` she has a pending request to join).

**People.** The ten personas become real accounts. Agus (the PM) and Dinda (sales, and Field
leader in chat) already exist as ERP logins and are *updated* with their workspace persona, not
duplicated — the identity merge the handover describes. The other eight are ``team`` logins.
Their member numbers are the prototype's (``M-05``), set explicitly so the ``<@M-05>`` inside
the seeded messages resolves; the sequence is moved past them so the next person added is
``M-11``.

**Projects.** The backend demo had no projects, and chat hangs off them, so the four are
created here with the prototype's own names, stages and values (no postings: they exist so
channels, divisions and membership have something to point at). A project is matched by its
``project_no``, which is the prototype's id (``EVT-2026-GALA-01``).

**Meetings.** The prototype's two finished calls are loaded with their call lines, people,
transcripts, notes, files and (for the first) minutes, so the minutes screens have something real to
open: the first is open to the people on the call only, the second to its channel with no minutes
yet — the one to try "Write minutes" on.

**What is not loaded:** voice channels — they have no server yet.

Idempotent: a channel whose key already exists is left alone, messages and all. Timestamps in
the prototype are Jakarta wall clock and are read as such.

**A separate step, not part of ``app.seed.demo``.** The finance demo stays exactly as it was:
chat adds projects that reference the demo clients, and a finance seed (or its tests) should
not have to know about chat's constraints. Run the demo first, then this::

    python -m app.seed.demo
    python -m app.seed.chat

Like the demo, it refuses to run with ``ENV=production``: it creates accounts with the
published demo password.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.security import hash_password
from app.db.session import dispose_engine, get_sessionmaker
from app.domain.ar.models import Client, Project, Stage
from app.domain.chat import tokens
from app.domain.chat.access import Channel, Member, visible_channels
from app.domain.chat.models import (
    AddedVia,
    ChannelAccess,
    ChatChannel,
    ChatChannelMember,
    ChatJoinRequest,
    ChatMeeting,
    ChatMeetingFile,
    ChatMeetingNote,
    ChatMeetingPerson,
    ChatMention,
    ChatMessage,
    ChatReaction,
    ChatRead,
    ChatTranscriptLine,
    JoinStatus,
    MeetingAccess,
    MeetingPersonRole,
)
from app.domain.masters.models import (
    ProjectDivision,
    ProjectMember,
    Role,
    User,
    WorkspaceRole,
)
from app.seed.chart import DEMO_PASSWORD

SEED_FILE = Path(__file__).with_name("chat_seed.json")
EMAIL_DOMAIN = "oscenia.co.id"


@dataclass
class ChatSeedReport:
    people: int = 0
    projects: int = 0
    channels: int = 0
    messages: int = 0
    meetings: int = 0


def _at(raw: str) -> datetime:
    """A prototype wall-clock time (``2026-07-24T11:00``) as the Jakarta moment it means."""
    return datetime.fromisoformat(raw).replace(tzinfo=ZoneInfo(get_settings().timezone))


def _email(name: str) -> str:
    return f"{name.split()[0].lower()}@{EMAIL_DOMAIN}"


def _initials(name: str) -> str:
    return "".join(part[0] for part in name.split()[:2]).upper()


async def _people(session: AsyncSession, raw: list[dict[str, Any]]) -> tuple[dict[str, User], int]:
    """Put every persona in the workspace. Returns ``(member id -> user, newly created)``."""
    by_email = {
        u.email: u
        for u in (
            await session.execute(
                select(User).where(User.email.in_([_email(m["name"]) for m in raw]))
            )
        ).scalars()
    }
    users: dict[str, User] = {}
    created = 0
    for m in raw:
        email = _email(m["name"])
        user = by_email.get(email)
        if user is None:
            user = User(
                email=email,
                full_name=m["name"],
                initials=_initials(m["name"]),
                role=Role.TEAM,
                password_hash=hash_password(DEMO_PASSWORD),
            )
            session.add(user)
            created += 1
        if user.workspace_role is None:  # never clobber a persona someone has already set
            user.member_no = m["id"]
            user.workspace_role = WorkspaceRole(m["workspace_role"])
            user.division = m["division"]
            user.title = m["title"]
        users[m["id"]] = user
    await session.flush()

    # Move the sequence past the personas so the next person added is M-11, never a repeat.
    highest = max(int(m["id"].split("-")[1]) for m in raw)
    await session.execute(
        text(
            "SELECT setval('member_no_seq', GREATEST((SELECT last_value FROM member_no_seq), :n))"
        ),
        {"n": highest},
    )
    return users, created


async def _projects(
    session: AsyncSession, raw: list[dict[str, Any]]
) -> tuple[dict[str, Project], int]:
    existing = {
        p.project_no: p
        for p in (
            await session.execute(
                select(Project).where(Project.project_no.in_([r["project_no"] for r in raw]))
            )
        ).scalars()
    }
    out: dict[str, Project] = {}
    created = 0
    for r in raw:
        project = existing.get(r["project_no"])
        if project is None:
            client_id = (
                await session.execute(select(Client.id).where(Client.name == r["client_name"]))
            ).scalar_one_or_none()
            if client_id is None:
                raise RuntimeError(
                    f"Client {r['client_name']!r} is missing: the chat demo hangs its projects "
                    "off the demo clients. Seed those first (app.seed.demo)."
                )
            project = Project(
                project_no=r["project_no"], name=r["name"], client_id=client_id,
                stage=Stage(r["stage"]), stage_since=date.fromisoformat(r["stage_since"]),
                division=r["division"], contract_value=Decimal(r["contract_value"]),
                estimated_cost=Decimal(r["estimated_cost"]),
                event_date=date.fromisoformat(r["event_date"]),
            )  # fmt: skip
            session.add(project)
            created += 1
        out[r["project_no"]] = project
    await session.flush()
    return out, created


async def _meetings(
    session: AsyncSession,
    raw: list[dict[str, Any]],
    users: dict[str, User],
    channels: dict[str, ChatChannel],
) -> dict[str, uuid.UUID]:
    """Record the prototype's finished calls in the channels this run created."""
    made: dict[str, uuid.UUID] = {}
    for mt in raw:
        channel = channels.get(mt["channel"])
        if channel is None:  # its channel was already loaded, meetings and all
            continue
        s = mt["summary"]
        summary = (
            {
                "overview": s["overview"],
                "agenda": s["agenda"],
                "discussion": s["discussion"],
                "decisions": s["decisions"],
                "action_items": [
                    {
                        "text": a["text"],
                        "owner_id": str(users[a["owner"]].id) if a["owner"] else None,
                        "due": a["due"],
                    }
                    for a in s["action_items"]
                ],
            }
            if s
            else None
        )
        row = ChatMeeting(
            channel_id=channel.id, log_channel_id=channel.id, video=mt["video"],
            started_at=_at(mt["started_at"]), ended_at=_at(mt["ended_at"]),
            host_id=users[mt["host"]].id, access=MeetingAccess(mt["access"]),
            files_view_only=mt["files_view_only"], created_at=_at(mt["ended_at"]),
            summary=summary, summary_source="seeded" if s else None,
            summary_at=_at(s["at"]) if s else None, summary_by=users[s["by"]].id if s else None,
        )  # fmt: skip
        session.add(row)
        await session.flush()
        for member in dict.fromkeys(mt["participants"]):
            session.add(
                ChatMeetingPerson(
                    meeting_id=row.id, user_id=users[member].id, role=MeetingPersonRole.PARTICIPANT
                )
            )
        for member in mt["readers"]:
            session.add(
                ChatMeetingPerson(
                    meeting_id=row.id, user_id=users[member].id, role=MeetingPersonRole.READER
                )
            )
        for i, ln in enumerate(mt["transcript"]):
            session.add(
                ChatTranscriptLine(
                    meeting_id=row.id,
                    position=i,
                    at=_at(ln["at"]),
                    speaker_id=users[ln["speaker"]].id,
                    text=ln["text"],
                )  # fmt: skip
            )
        for i, n in enumerate(mt["notes"]):
            session.add(
                ChatMeetingNote(
                    meeting_id=row.id,
                    author_id=users[n["by"]].id,
                    at=_at(n["at"]),
                    text=n["text"],
                    position=i,
                )  # fmt: skip
            )
        for i, f in enumerate(mt["files"]):
            session.add(
                ChatMeetingFile(
                    meeting_id=row.id,
                    uploader_id=users[f["by"]].id,
                    filename=f["name"],
                    kind=f["kind"],
                    size_bytes=f["size"],
                    at=_at(f["at"]),
                    position=i,
                )  # fmt: skip
            )
        made[mt["key"]] = row.id
    await session.flush()
    return made


async def seed_chat(session: AsyncSession, *, data: dict[str, Any] | None = None) -> ChatSeedReport:
    data = data if data is not None else json.loads(SEED_FILE.read_text(encoding="utf-8"))
    report = ChatSeedReport()

    users, report.people = await _people(session, data["members"])
    projects, report.projects = await _projects(session, data["projects"])

    # --- who works on what ----------------------------------------------------------------
    have_div = {
        (pd.project_id, pd.division)
        for pd in (await session.execute(select(ProjectDivision))).scalars()
    }
    for project_no, divisions in data["project_divisions"].items():
        for division in divisions:
            if (projects[project_no].id, division) not in have_div:
                session.add(ProjectDivision(project_id=projects[project_no].id, division=division))
    have_member = {
        (pm.project_id, pm.user_id)
        for pm in (await session.execute(select(ProjectMember))).scalars()
    }
    for m in data["members"]:
        for project_no in m["project_ids"]:
            key = (projects[project_no].id, users[m["id"]].id)
            if key not in have_member:
                session.add(ProjectMember(project_id=key[0], user_id=key[1]))
    await session.flush()

    # --- channels, in the order the prototype has them ------------------------------------
    existing = set(
        (
            await session.execute(select(ChatChannel.key).where(ChatChannel.key.is_not(None)))
        ).scalars()
    )
    new_channels: list[dict[str, Any]] = []
    rows: dict[str, ChatChannel] = {}
    for raw in data["channels"]:
        if raw["key"] in existing:
            continue
        pair = sorted(users[i].id for i in raw["member_ids"]) if raw["dm"] else [None, None]
        channel = ChatChannel(
            key=raw["key"], project_id=projects[raw["project"]].id if raw["project"] else None,
            name=raw["name"], topic=raw["topic"], access=ChannelAccess(raw["access"]),
            divisions=raw["divisions"], listed=raw["listed"], is_dm=raw["dm"],
            dm_lo=pair[0], dm_hi=pair[1],
        )  # fmt: skip
        session.add(channel)
        rows[raw["key"]] = channel
        new_channels.append(raw)
    await session.flush()

    for raw in new_channels:
        channel = rows[raw["key"]]
        for member_id in raw["member_ids"]:
            via = AddedVia.DM if raw["dm"] else AddedVia.SEED
            session.add(
                ChatChannelMember(channel_id=channel.id, user_id=users[member_id].id, added_via=via)
            )
        for req in raw["requests"]:
            session.add(
                ChatJoinRequest(
                    channel_id=channel.id,
                    user_id=users[req["member"]].id,
                    note=req["note"],
                    status=JoinStatus(req["status"]),
                    created_at=_at(req["at"]),
                )  # fmt: skip
            )
    report.channels = len(new_channels)

    # --- meetings: before the messages, because a call line points at its meeting -----------
    meeting_ids = await _meetings(session, data.get("meetings", []), users, rows)
    report.meetings = len(meeting_ids)

    # --- messages: oldest first per channel, so seq follows the conversation ---------------
    by_no = {u.member_no: u.id for u in users.values() if u.member_no}
    by_channel: dict[str, list[dict[str, Any]]] = {}
    for m in data["messages"]:
        by_channel.setdefault(m["channel"], []).append(m)
    ids: dict[str, uuid.UUID] = {}
    last_seq_before: dict[str, int] = {}  # per channel: seq of the newest message by read_through
    read_through = _at(data["read_through"])
    for raw in new_channels:
        channel = rows[raw["key"]]
        ordered = sorted(by_channel.get(raw["key"], []), key=lambda m: (m["at"], m["key"]))
        for seq, m in enumerate(ordered, start=1):
            message = ChatMessage(
                channel_id=channel.id, seq=seq, rev=seq, author_id=users[m["author"]].id,
                text=m["text"], kind=m.get("kind", "text"), created_at=_at(m["at"]),
                quote_id=ids.get(m["quote"]) if m["quote"] else None,
                meeting_id=meeting_ids.get(m["meeting"]) if m.get("meeting") else None,
            )  # fmt: skip
            session.add(message)
            await session.flush()
            ids[m["key"]] = message.id
            for emoji, who in m["reactions"].items():
                for member_id in who:
                    session.add(
                        ChatReaction(
                            message_id=message.id, user_id=users[member_id].id, emoji=emoji
                        )
                    )
            for number in tokens.mention_numbers(m["text"]):
                if number in by_no and by_no[number] != message.author_id:
                    session.add(
                        ChatMention(
                            message_id=message.id,
                            user_id=by_no[number],
                            channel_id=channel.id,
                            created_at=message.created_at,
                        )  # fmt: skip
                    )
            if message.created_at <= read_through:
                last_seq_before[raw["key"]] = seq
            report.messages += 1
        channel.rev = len(ordered)
    await session.flush()

    # --- everyone starts caught up to the end of 24 Jul, in the channels they can open -----
    people = {
        m["id"]: Member(
            id=m["id"],
            workspace_role=m["workspace_role"],
            division=m["division"],
            project_ids=tuple(m["project_ids"]),
        )  # fmt: skip
        for m in data["members"]
    }
    views = [
        Channel(
            id=c["key"],
            project_id=c["project"],
            dm=c["dm"],
            access=c["access"],
            divisions=tuple(c["divisions"]),
            member_ids=frozenset(c["member_ids"]),
            blocked_ids=frozenset(c["blocked_ids"]),
            listed=c["listed"],
        )  # fmt: skip
        for c in new_channels
    ]
    for member_id, member in people.items():
        for view in visible_channels(member, views, data["project_divisions"]):
            seq = last_seq_before.get(view.id, 0)
            if seq:
                session.add(
                    ChatRead(
                        user_id=users[member_id].id,
                        channel_id=rows[view.id].id,
                        last_read_seq=seq,
                    )  # fmt: skip
                )
    await session.flush()
    return report


async def _main() -> None:
    if get_settings().env == "production":
        # These are demo accounts with a published password; real people are added with
        # ``python -m app.seed.users add … --workspace-role …``.
        raise SystemExit("Refusing to load demo chat data with ENV=production.")
    try:
        async with get_sessionmaker()() as session, session.begin():
            report = await seed_chat(session)
    except RuntimeError as exc:  # a missing demo client: say what to run first
        raise SystemExit(str(exc)) from exc
    finally:
        await dispose_engine()
    print(
        f"Seeded team chat: {report.people} people, {report.projects} projects, "
        f"{report.channels} channels, {report.messages} messages, {report.meetings} meetings "
        "(zero everywhere means it was already loaded)."
    )


if __name__ == "__main__":
    asyncio.run(_main())
