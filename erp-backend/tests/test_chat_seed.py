"""Chat backend C5 — the demo seed behaves as the prototype's chat does.

The data is the prototype's own (``chat_seed.json``, exported by
``erp-frontend/scripts/export-chat-seed.mjs``), so these tests check two things: the loader
puts it in faithfully, and the server's rules — not the prototype's — give the answers the
prototype's chat gives (what Rina can open, what she sees locked, what is unread).
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.ar.models import Client, Project
from app.domain.chat import tokens
from app.domain.chat.access import Channel, Member, can_open_channel
from app.domain.chat.models import (
    REACTIONS,
    ChatChannel,
    ChatMeeting,
    ChatMeetingFile,
    ChatMeetingNote,
    ChatMeetingPerson,
    ChatMention,
    ChatMessage,
    ChatTranscriptLine,
)
from app.domain.chat.workspace import next_member_no
from app.domain.ledger.numbering import next_document_no
from app.domain.masters.models import Role, User
from app.seed.chart import DEMO_PASSWORD
from app.seed.chat import SEED_FILE, seed_chat

DATA: dict[str, Any] = json.loads(SEED_FILE.read_text("utf-8"))
CLIENTS = ("Aurora Bank", "Keluarga Wibowo", "TechNusa", "Meridian Cosmetics")


async def _seed(db: AsyncSession) -> Any:
    """The demo clients (the projects hang off them), then the chat seed."""
    for name in CLIENTS:
        db.add(Client(client_no=await next_document_no(db, "client"), name=name))
    await db.flush()
    return await seed_chat(db)


async def _login(http: AsyncClient, api: str, email: str) -> AsyncClient:
    r = await http.post(f"{api}/auth/login", json={"email": email, "password": DEMO_PASSWORD})
    assert r.status_code == 200, r.text
    http.headers["Authorization"] = f"Bearer {r.json()['access_token']}"
    return http


async def _bootstrap(http: AsyncClient, api: str) -> dict[str, Any]:
    r = await http.get(f"{api}/chat/bootstrap")
    assert r.status_code == 200, r.text
    return r.json()


def _keys(channels: list[dict[str, Any]]) -> set[str]:
    return {c["key"] for c in channels}


# --- the data itself (no database) --------------------------------------------------------


def test_every_seeded_author_may_open_the_channel_they_posted_in() -> None:
    """A guard on the seed: a message nobody could have posted would make the demo lie."""
    people = {
        m["id"]: Member(
            id=m["id"],
            workspace_role=m["workspace_role"],
            division=m["division"],
            project_ids=tuple(m["project_ids"]),
        )
        for m in DATA["members"]
    }
    channels = {
        c["key"]: Channel(
            id=c["key"],
            project_id=c["project"],
            dm=c["dm"],
            access=c["access"],
            divisions=tuple(c["divisions"]),
            member_ids=frozenset(c["member_ids"]),
            blocked_ids=frozenset(c["blocked_ids"]),
            listed=c["listed"],
        )
        for c in DATA["channels"]
    }
    for m in DATA["messages"]:
        ok = can_open_channel(
            people[m["author"]], channels[m["channel"]], DATA["project_divisions"]
        )
        assert ok, f"{m['key']}: {m['author']} cannot open {m['channel']}"


def test_every_mention_reaction_and_quote_in_the_seed_resolves() -> None:
    members = {m["id"] for m in DATA["members"]}
    by_key = {m["key"]: m for m in DATA["messages"]}
    for m in DATA["messages"]:
        for number in tokens.mention_numbers(m["text"]):
            assert number in members, f"{m['key']} mentions {number}"
        for emoji, who in m["reactions"].items():
            assert emoji in REACTIONS and set(who) <= members
        if m["quote"]:
            quoted = by_key[m["quote"]]
            assert quoted["channel"] == m["channel"] and quoted["at"] < m["at"]


# --- loading it ---------------------------------------------------------------------------


async def test_the_seed_loads_what_the_prototype_has_and_is_idempotent(db: AsyncSession) -> None:
    report = await _seed(db)
    # Agus and Dinda already exist as ERP logins; the other eight are new.
    assert (report.people, report.projects, report.channels, report.messages) == (8, 4, 17, 25)
    assert report.meetings == 2

    again = await seed_chat(db)
    assert (again.people, again.projects, again.channels, again.messages) == (0, 0, 0, 0)
    assert again.meetings == 0
    assert (await db.execute(select(func.count()).select_from(ChatChannel))).scalar_one() == 17
    assert (await db.execute(select(func.count()).select_from(ChatMessage))).scalar_one() == 25


async def test_agus_and_dinda_gain_a_persona_without_losing_their_erp_role(
    db: AsyncSession,
) -> None:
    await _seed(db)
    agus = (await db.execute(select(User).where(User.email == "agus@oscenia.co.id"))).scalar_one()
    dinda = (await db.execute(select(User).where(User.email == "dinda@oscenia.co.id"))).scalar_one()
    assert (agus.role, agus.member_no, agus.workspace_role.value) == (Role.PM, "M-01", "pm")
    # Sales in the ledger, Field leader in chat: the two identities the handover warned about.
    assert (dinda.role, dinda.member_no, dinda.workspace_role.value) == (
        Role.SALES,
        "M-02",
        "leader",
    )
    assert dinda.division == "Field"
    # Ten personas, ten accounts: the two ERP logins were reused, not copied.
    in_workspace = (
        await db.execute(select(func.count()).select_from(User).where(User.member_no.is_not(None)))
    ).scalar_one()
    assert in_workspace == 10
    assert (
        await db.execute(
            select(func.count()).select_from(User).where(User.email == "agus@oscenia.co.id")
        )
    ).scalar_one() == 1


async def test_the_next_person_added_is_never_a_repeat_of_a_seeded_number(
    db: AsyncSession,
) -> None:
    """On a fresh database that is M-11. The sequence is shared by the whole test database and
    other tests have already used some, so what must hold is that it is past M-10 — never
    ``M-01``..``M-10``, which the seeded messages already mention."""
    await _seed(db)
    assert int((await next_member_no(db))[2:]) >= 11


async def test_the_four_projects_exist_with_the_prototypes_names(db: AsyncSession) -> None:
    await _seed(db)
    got = {
        p.project_no: (p.name, p.stage.value)
        for p in (await db.execute(select(Project))).scalars()
        if p.project_no.startswith("EVT-2026-")
    }
    assert got["EVT-2026-GALA-01"] == ("Aurora Bank Annual Gala", "Execution Event")
    assert got["EVT-2026-PROD-04"] == ("Meridian Product Launch", "Finished")
    assert len(got) == 4


async def test_a_missing_demo_client_is_a_clear_error_not_a_crash(db: AsyncSession) -> None:
    with pytest.raises(RuntimeError, match="Aurora Bank"):
        await seed_chat(db)


async def test_messages_are_numbered_in_conversation_order_with_mentions_and_quotes(
    db: AsyncSession,
) -> None:
    await _seed(db)
    announce = (
        await db.execute(select(ChatChannel).where(ChatChannel.key == "ch-announcements"))
    ).scalar_one()
    texts = (
        await db.execute(
            select(ChatMessage.seq, ChatMessage.text)
            .where(ChatMessage.channel_id == announce.id)
            .order_by(ChatMessage.seq)
        )
    ).all()
    assert [seq for seq, _ in texts] == [1, 2] and announce.rev == 2  # the counter matches
    assert texts[0][1].startswith("Morning all.")  # the 20 Jul message comes first

    mentioned = (
        await db.execute(
            select(func.count())
            .select_from(ChatMention)
            .where(ChatMention.channel_id == announce.id)
        )
    ).scalar_one()
    assert mentioned == 2  # <@M-02> and <@M-04> in the 24 Jul message

    field = (
        await db.execute(select(ChatChannel).where(ChatChannel.key == "ch-gala-field"))
    ).scalar_one()
    first, reply = (
        (
            await db.execute(
                select(ChatMessage)
                .where(ChatMessage.channel_id == field.id)
                .order_by(ChatMessage.seq)
            )
        )
        .scalars()
        .all()
    )
    assert reply.quote_id == first.id  # Rina's reply quotes Dinda's catering note


# --- the prototype's own expectations, answered by the server's rules ---------------------


async def test_rina_sees_what_the_prototype_shows_her(
    db: AsyncSession, anon_client: AsyncClient, api: str
) -> None:
    await _seed(db)
    http = await _login(anon_client, api, "rina@oscenia.co.id")
    body = await _bootstrap(http, api)
    assert body["me"]["member_no"] == "M-05"

    # Field staff on the Gala and the Meridian launch.
    assert _keys(body["channels"]) == {
        "ch-announcements", "ch-general",
        "ch-gala-general", "ch-gala-field",
        "ch-meridian-general", "ch-meridian-field",
        "dm-M-01-M-05", "dm-M-02-M-05",
    }  # fmt: skip
    # Listed but locked: Gala #production (she has asked to join) and Meridian #design.
    locked = {c["key"]: c for c in body["discoverable"]}
    assert set(locked) == {"ch-gala-production", "ch-meridian-design"}
    assert locked["ch-gala-production"]["my_request"] == "pending"
    assert locked["ch-meridian-design"]["my_request"] is None
    # The leaders' room is unlisted: not even a locked door.
    assert "ch-leaders" not in _keys(body["channels"]) | set(locked)


async def test_everyone_starts_caught_up_to_the_end_of_24_jul(
    db: AsyncSession, anon_client: AsyncClient, api: str
) -> None:
    await _seed(db)
    http = await _login(anon_client, api, "rina@oscenia.co.id")
    unread = {c["key"]: c["unread"] for c in (await _bootstrap(http, api))["channels"]}
    # Only what was said on 25 and 26 Jul is new to her: one message in each DM.
    assert unread["dm-M-01-M-05"] == 1 and unread["dm-M-02-M-05"] == 1
    assert unread["ch-announcements"] == 0 and unread["ch-gala-general"] == 0
    assert unread["ch-gala-field"] == 0  # her own reply is never unread


async def test_the_pm_sees_every_channel_but_only_his_own_dm(
    db: AsyncSession, anon_client: AsyncClient, api: str
) -> None:
    await _seed(db)
    http = await _login(anon_client, api, "agus@oscenia.co.id")
    keys = _keys((await _bootstrap(http, api))["channels"])
    assert "ch-leaders" in keys and "ch-gala-production" in keys
    assert "dm-M-01-M-05" in keys and "dm-M-02-M-05" not in keys  # Dinda's DM is Dinda's
    assert len(keys) == 16  # fifteen shared channels and one DM


async def test_dinda_decides_rinas_pending_request_and_is_told_about_it(
    db: AsyncSession, anon_client: AsyncClient, api: str
) -> None:
    await _seed(db)
    http = await _login(anon_client, api, "dinda@oscenia.co.id")
    me = (await _bootstrap(http, api))["me"]
    assert (me["member_no"], me["workspace_role"], me["division"]) == ("M-02", "leader", "Field")

    items = (await http.get(f"{api}/chat/notifications")).json()["items"]
    join = next(i for i in items if i["kind"] == "Wants to join")
    assert "Rina M." in join["title"] and "#production" in join["title"]
    assert join["body"] == "I need the rigging schedule for the stage plan."
    # She was mentioned in the 24 Jul announcement — already read, as the prototype has it.
    mention = next(i for i in items if i["kind"] == "Mentioned you")
    assert mention["read"] is True

    rid = (
        await http.get(
            f"{api}/chat/channels/{join['to'].split('/')[2].split('?')[0]}/join-requests"
        )
    ).json()[0]["id"]
    done = await http.post(f"{api}/chat/join-requests/{rid}/decide", json={"approve": True})
    assert done.status_code == 200 and done.json()["status"] == "approved"


# --- the two finished calls ---------------------------------------------------------------


async def test_the_two_calls_load_with_what_they_left_behind(db: AsyncSession) -> None:
    await _seed(db)
    meetings = (
        (await db.execute(select(ChatMeeting).order_by(ChatMeeting.started_at))).scalars().all()
    )
    first, second = meetings
    assert first.access.value == "participants" and second.access.value == "channel"
    assert (first.summary_source, second.summary_source) == (
        "seeded",
        None,
    ) and second.summary is None
    assert (
        first.summary is not None and first.summary["decisions"] and first.summary["action_items"]
    )
    owners = {a["owner_id"] for a in first.summary["action_items"] if a["owner_id"]}
    people = {
        str(p.user_id)
        for p in (
            await db.execute(
                select(ChatMeetingPerson).where(ChatMeetingPerson.meeting_id == first.id)
            )
        ).scalars()
    }
    assert owners <= people, "an action item belongs to someone who was on the call"
    assert len(people) == 3

    def count(model: Any) -> Any:
        return select(func.count()).select_from(model).where(model.meeting_id == first.id)

    assert (await db.execute(count(ChatTranscriptLine))).scalar_one() == 18
    assert (await db.execute(count(ChatMeetingNote))).scalar_one() == 1
    assert (await db.execute(count(ChatMeetingFile))).scalar_one() == 1
    lines = (
        (await db.execute(select(ChatMessage).where(ChatMessage.kind == "call"))).scalars().all()
    )
    assert {m.meeting_id for m in lines} == {first.id, second.id}


async def test_the_server_gives_the_calls_the_privacy_the_prototype_does(
    db: AsyncSession, anon_client: AsyncClient, api: str
) -> None:
    await _seed(db)
    first = (
        await db.execute(select(ChatMeeting).order_by(ChatMeeting.started_at).limit(1))
    ).scalar_one()
    second = (
        await db.execute(select(ChatMeeting).order_by(ChatMeeting.started_at.desc()).limit(1))
    ).scalar_one()
    expect = {
        # first call: on the Gala's general channel, participants only (Dinda, Rina, Hendra)
        ("dinda", first.id): True,  # the host
        ("rina", first.id): True,  # was on it
        ("yoga", first.id): False,  # on the Gala, not on the call: sees "restricted"
        ("agus", first.id): True,  # the PM reads channel calls
        # second call: open to its whole channel
        ("putri", second.id): True,
        ("kevin", second.id): True,
        ("maya", second.id): True,
        ("rina", second.id): None,  # not on TechNusa at all: no such meeting
    }
    for (who, mid), reads in expect.items():
        http = await _login(anon_client, api, f"{who}@oscenia.co.id")
        r = await http.get(f"{api}/chat/meetings/{mid}")
        if reads is None:
            assert r.status_code == 404, (who, r.text)
        else:
            assert r.status_code == 200 and r.json()["can_read"] is reads, (who, r.text)
            assert bool(r.json()["transcript"]) is reads
