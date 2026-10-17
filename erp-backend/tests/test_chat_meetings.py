"""Chat backend M — meetings over HTTP: who sees what, who may change it, and the minutes.

The world (``chat_world.py``): project A is Field + Production, project B is Design + Field. A
channel on B can be opened by the PM, the Design leader, the Design intern and the Field leader —
but not by the Field staff member (on A only). That gives every case in one place: a host, a
participant, someone who can open the channel yet was not on the call, someone who cannot, and
someone with no workspace persona at all.
"""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Any

import pytest
from chat_world import World, login, make_channel, world  # noqa: F401
from chat_ws_fakes import FakeWS
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import Invalid
from app.core.throttle import Throttle
from app.domain.chat import meetings, minutes, service
from app.domain.chat.hub import ChatHub, Connection, set_hub
from app.domain.chat.models import MeetingAccess
from app.domain.masters.models import User

START = dt.datetime(2026, 7, 24, 9, 27, tzinfo=dt.UTC)
END = START + dt.timedelta(minutes=18)


async def a_channel(http: AsyncClient, api: str, w: World, project: str) -> str:
    await login(http, api, w.pm)
    return (await make_channel(http, api, project_id=project, name="general"))["id"]


async def held(
    db: AsyncSession,
    channel_id: str,
    host: User,
    others: list[User],
    *,
    talk: bool = True,
    **kw: Any,
) -> uuid.UUID:
    """A finished call, recorded the way the call service will record it."""
    ctx = await service.load_context(db, host)
    said = [
        meetings.NewLine(START + dt.timedelta(minutes=i), (host if i % 2 == 0 else others[0]).id, t)
        for i, t in enumerate(
            [
                "Quick agenda: where we are, open issues, and next steps.",
                "We are waiting on the venue for the load-in window, they promised it this week.",
                "Agreed: we lock the load-in window before we book anything else.",
                "I’ll call the venue manager tomorrow morning and get it in writing.",
            ]
        )
    ]
    row = await meetings.create_meeting(
        db, ctx, channel_id=uuid.UUID(channel_id), started_at=START, ended_at=END, video=True,
        participant_ids=[u.id for u in others], lines=said if talk else [], **kw,
    )  # fmt: skip
    await db.flush()
    return row.id


async def get(http: AsyncClient, api: str, mid: uuid.UUID, expect: int = 200) -> dict[str, Any]:
    r = await http.get(f"{api}/chat/meetings/{mid}")
    assert r.status_code == expect, r.text
    return r.json()


@pytest.fixture
def no_ai(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(get_settings(), "ai_provider", "")
    monkeypatch.setattr(get_settings(), "ai_api_key", "")


class FakeAI:
    def __init__(self, content: str | None = None, status: int = 200) -> None:
        self.content = content or (
            '{"overview": "The team locked the load-in window.", "agenda": ["Status"],'
            ' "discussion": [], "decisions": ["Lock the load-in window"],'
            ' "actionItems": [{"text": "Call the venue", "owner": "%s", "due": "2026-07-25"}]}'
        )
        self.status, self.calls, self.owner = status, 0, ""

    async def __call__(self, *_: Any) -> tuple[int, Any]:
        self.calls += 1
        body = self.content % self.owner if "%s" in self.content else self.content
        return self.status, {"choices": [{"message": {"content": body}}]}


@pytest.fixture
def ai(monkeypatch: pytest.MonkeyPatch) -> FakeAI:
    fake = FakeAI()
    monkeypatch.setattr(get_settings(), "ai_provider", "deepseek")
    monkeypatch.setattr(get_settings(), "ai_api_key", "sk-test")
    monkeypatch.setattr(minutes, "_post", fake)
    monkeypatch.setattr(
        meetings,
        "minutes_throttle",
        Throttle("t-minutes", limit=50, window_seconds=60, block_seconds=60),
    )
    return fake


# --- who sees what ----------------------------------------------------------------------


async def test_a_call_leaves_a_line_in_the_channel_and_a_record_behind_it(
    anon_client: AsyncClient, api: str, world: World, db: AsyncSession
) -> None:
    cid = await a_channel(anon_client, api, world, world.b)
    mid = await held(db, cid, world.lead_design, [world.intern])
    await login(anon_client, api, world.intern)
    page = (await anon_client.get(f"{api}/chat/channels/{cid}/messages")).json()["messages"]
    [line] = [m for m in page if m["kind"] == "call"]
    assert line["meeting_id"] == str(mid)
    assert line["text"] == "Video call · 18 min · W-Ld, W-In"  # the host first
    [brief] = (await anon_client.get(f"{api}/chat/channels/{cid}/meetings")).json()
    assert brief["id"] == str(mid) and brief["can_read"] and not brief["can_manage"]
    assert brief["host_id"] == str(world.lead_design.id) and len(brief["participant_ids"]) == 2
    assert "transcript" not in brief, "the list carries nothing that was said"


async def test_people_in_the_channel_who_were_not_on_the_call_see_that_it_happened_only(
    anon_client: AsyncClient, api: str, world: World, db: AsyncSession
) -> None:
    cid = await a_channel(anon_client, api, world, world.b)
    mid = await held(db, cid, world.lead_design, [world.intern])
    await login(anon_client, api, world.lead_field)  # can open the channel, was not on the call
    m = await get(anon_client, api, mid)
    assert m["can_read"] is False and m["can_open_files"] is False
    assert m["transcript"] == [] and m["notes"] == [] and m["files"] == [] and m["summary"] is None
    assert m["participant_ids"], "who was on it is not secret from the channel"
    assert m["reader_ids"] == []

    await login(anon_client, api, world.intern)  # was on the call
    m = await get(anon_client, api, mid)
    assert m["can_read"] and len(m["transcript"]) == 4
    assert [ln["at"] for ln in m["transcript"]] == sorted(ln["at"] for ln in m["transcript"])

    await login(anon_client, api, world.pm)  # the PM reads every channel call
    assert (await get(anon_client, api, mid))["can_read"] is True


async def test_someone_who_cannot_open_the_channel_gets_no_such_meeting(
    anon_client: AsyncClient, api: str, world: World, db: AsyncSession
) -> None:
    cid = await a_channel(anon_client, api, world, world.b)
    mid = await held(db, cid, world.lead_design, [world.intern])
    await login(anon_client, api, world.staff)  # on project A only
    await get(anon_client, api, mid, expect=404)
    assert (await anon_client.get(f"{api}/chat/channels/{cid}/meetings")).status_code == 404
    assert (await anon_client.get(f"{api}/chat/meetings/{uuid.uuid4()}")).status_code == 404
    await login(anon_client, api, world.outsider)  # no workspace persona
    await get(anon_client, api, mid, expect=403)


async def test_a_dm_call_is_for_its_two_people_even_against_the_pm(
    anon_client: AsyncClient, api: str, world: World, db: AsyncSession
) -> None:
    await login(anon_client, api, world.lead_design)
    dm = (await anon_client.post(f"{api}/chat/dms", json={"user_id": str(world.intern.id)})).json()
    mid = await held(db, dm["id"], world.lead_design, [world.intern], access=MeetingAccess.CHANNEL)
    row = await db.get(meetings.ChatMeeting, mid)
    assert row is not None and row.access == MeetingAccess.PARTICIPANTS, "a DM cannot be widened"
    assert (await get(anon_client, api, mid))["can_read"]
    await login(anon_client, api, world.pm)
    await get(anon_client, api, mid, expect=404)  # the PM cannot even open a DM


async def test_a_meeting_cannot_end_before_it_starts(
    anon_client: AsyncClient, api: str, world: World, db: AsyncSession
) -> None:
    cid = await a_channel(anon_client, api, world, world.b)
    ctx = await service.load_context(db, world.lead_design)
    with pytest.raises(Invalid):
        await meetings.create_meeting(
            db, ctx, channel_id=uuid.UUID(cid), started_at=END, ended_at=START, video=False,
            participant_ids=[world.intern.id],
        )  # fmt: skip


# --- who may read it --------------------------------------------------------------------


async def test_the_host_widens_the_minutes_to_the_channel_or_to_named_people(
    anon_client: AsyncClient, api: str, world: World, db: AsyncSession
) -> None:
    cid = await a_channel(anon_client, api, world, world.b)
    mid = await held(db, cid, world.lead_design, [world.intern])
    url = f"{api}/chat/meetings/{mid}/access"

    await login(anon_client, api, world.lead_design)
    r = await anon_client.patch(url, json={"mode": "channel"})
    assert r.status_code == 200 and r.json()["access"] == "channel"
    await login(anon_client, api, world.lead_field)
    assert (await get(anon_client, api, mid))["can_read"] is True

    await login(anon_client, api, world.lead_design)
    named = [str(world.lead_field.id), str(world.staff.id), str(world.intern.id)]
    r = await anon_client.patch(url, json={"mode": "people", "reader_ids": named})
    body = r.json()
    # staff cannot open project B's channels, so cannot be named; the intern was on the call.
    assert r.status_code == 200 and body["reader_ids"] == [str(world.lead_field.id)]
    await login(anon_client, api, world.lead_field)
    seen = await get(anon_client, api, mid)
    assert seen["can_read"] is True and seen["reader_ids"] == [], "readers do not see the list"

    await login(anon_client, api, world.lead_design)
    await anon_client.patch(url, json={"mode": "participants"})
    await login(anon_client, api, world.lead_field)
    assert (await get(anon_client, api, mid))["can_read"] is False, "narrowing takes it back"


async def test_view_only_files_show_a_name_but_open_for_the_host_alone(
    anon_client: AsyncClient, api: str, world: World, db: AsyncSession
) -> None:
    cid = await a_channel(anon_client, api, world, world.b)
    files = [meetings.NewFile(world.lead_design.id, "Run-of-show-v3.pdf", 184320, START, "pdf")]
    mid = await held(db, cid, world.lead_design, [world.intern], files=files)
    url = f"{api}/chat/meetings/{mid}/access"
    await login(anon_client, api, world.lead_design)
    await anon_client.patch(url, json={"mode": "participants", "files_view_only": True})
    await login(anon_client, api, world.intern)
    m = await get(anon_client, api, mid)
    assert m["files"][0]["filename"] == "Run-of-show-v3.pdf" and m["can_open_files"] is False
    await login(anon_client, api, world.lead_design)
    assert (await get(anon_client, api, mid))["can_open_files"] is True


async def test_only_the_host_or_the_pm_may_change_who_reads_and_a_dm_stays_closed(
    anon_client: AsyncClient, api: str, world: World, db: AsyncSession
) -> None:
    cid = await a_channel(anon_client, api, world, world.b)
    mid = await held(db, cid, world.lead_design, [world.intern])
    url = f"{api}/chat/meetings/{mid}/access"
    await login(anon_client, api, world.intern)
    assert (await anon_client.patch(url, json={"mode": "channel"})).status_code == 403
    await login(anon_client, api, world.lead_field)
    assert (await anon_client.patch(url, json={"mode": "channel"})).status_code == 403
    await login(anon_client, api, world.lead_design)
    assert (await anon_client.patch(url, json={"mode": "everyone"})).status_code == 422
    await login(anon_client, api, world.pm)
    assert (await anon_client.patch(url, json={"mode": "channel"})).status_code == 200

    await login(anon_client, api, world.lead_design)
    dm = (await anon_client.post(f"{api}/chat/dms", json={"user_id": str(world.intern.id)})).json()
    dm_meeting = await held(db, dm["id"], world.lead_design, [world.intern])
    wide = await anon_client.patch(
        f"{api}/chat/meetings/{dm_meeting}/access", json={"mode": "channel"}
    )
    assert wide.status_code == 422, "a DM call's minutes stay with its two people"
    same = await anon_client.patch(
        f"{api}/chat/meetings/{dm_meeting}/access", json={"mode": "participants"}
    )
    assert same.status_code == 200


# --- the minutes ------------------------------------------------------------------------


async def test_without_an_ai_service_the_rules_write_the_minutes_and_say_so(
    anon_client: AsyncClient, api: str, world: World, db: AsyncSession, no_ai: None
) -> None:
    cid = await a_channel(anon_client, api, world, world.b)
    mid = await held(db, cid, world.lead_design, [world.intern])
    await login(anon_client, api, world.intern)
    r = await anon_client.post(f"{api}/chat/meetings/{mid}/summary", json={})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["reason"] == "not_configured"
    s = body["meeting"]["summary"]
    assert s["source"] == "offline" and s["provider"] is None and s["by"] == str(world.intern.id)
    assert s["decisions"] == ["We lock the load-in window before we book anything else."]
    [action] = s["action_items"]
    assert action["due"] == "2026-07-25" and action["owner_id"] in {
        str(world.lead_design.id),
        str(world.intern.id),
    }
    assert body["meeting"]["has_summary"] is True


async def test_the_first_minutes_are_anyones_who_can_read_but_replacing_them_is_the_hosts(
    anon_client: AsyncClient, api: str, world: World, db: AsyncSession, no_ai: None
) -> None:
    cid = await a_channel(anon_client, api, world, world.b)
    mid = await held(db, cid, world.lead_design, [world.intern])
    url = f"{api}/chat/meetings/{mid}/summary"
    await login(anon_client, api, world.lead_field)  # cannot read: cannot write
    assert (await anon_client.post(url, json={})).status_code == 403
    await login(anon_client, api, world.intern)
    assert (await anon_client.post(url, json={})).status_code == 200
    assert (await anon_client.post(url, json={})).status_code == 403, "a reader cannot replace"
    await login(anon_client, api, world.lead_design)
    assert (await anon_client.post(url, json={})).status_code == 200
    await login(anon_client, api, world.pm)
    assert (await anon_client.post(url, json={})).status_code == 200
    await login(anon_client, api, world.staff)
    assert (await anon_client.post(url, json={})).status_code == 404


async def test_a_meeting_with_nothing_said_has_nothing_to_summarise(
    anon_client: AsyncClient, api: str, world: World, db: AsyncSession, no_ai: None
) -> None:
    cid = await a_channel(anon_client, api, world, world.b)
    mid = await held(db, cid, world.lead_design, [world.intern], talk=False)
    await login(anon_client, api, world.lead_design)
    r = await anon_client.post(f"{api}/chat/meetings/{mid}/summary", json={})
    assert r.status_code == 422 and "nothing to summarise" in r.text.lower()


async def test_a_connected_ai_writes_the_minutes_from_the_stored_transcript(
    anon_client: AsyncClient, api: str, world: World, db: AsyncSession, ai: FakeAI
) -> None:
    cid = await a_channel(anon_client, api, world, world.b)
    mid = await held(db, cid, world.lead_design, [world.intern])
    ai.owner = world.intern.full_name
    await login(anon_client, api, world.intern)
    body = (
        await anon_client.post(f"{api}/chat/meetings/{mid}/summary", json={"lang": "id"})
    ).json()
    assert ai.calls == 1 and body["reason"] is None
    s = body["meeting"]["summary"]
    assert (s["source"], s["provider"], s["model"]) == ("ai", "deepseek", "deepseek-chat")
    assert s["overview"] == "The team locked the load-in window."
    assert s["action_items"][0]["owner_id"] == str(world.intern.id), "matched by name"
    # And it is what is stored: a fresh read gives the same.
    assert (await get(anon_client, api, mid))["summary"]["overview"] == s["overview"]


async def test_asking_for_rules_never_calls_the_ai_and_a_failing_ai_still_gives_minutes(
    anon_client: AsyncClient, api: str, world: World, db: AsyncSession, ai: FakeAI
) -> None:
    cid = await a_channel(anon_client, api, world, world.b)
    mid = await held(db, cid, world.lead_design, [world.intern])
    await login(anon_client, api, world.lead_design)
    url = f"{api}/chat/meetings/{mid}/summary"
    plain = (await anon_client.post(url, json={"use_ai": False})).json()
    assert ai.calls == 0 and plain["reason"] is None
    assert plain["meeting"]["summary"]["source"] == "offline"

    ai.status = 500
    failed = (await anon_client.post(url, json={})).json()
    assert ai.calls == 1 and failed["reason"] == "failed"
    assert failed["meeting"]["summary"]["source"] == "offline"


async def test_the_daily_cap_turns_the_ai_off_but_never_leaves_someone_without_minutes(
    anon_client: AsyncClient,
    api: str,
    world: World,
    db: AsyncSession,
    ai: FakeAI,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        meetings,
        "minutes_throttle",
        Throttle("t-cap", limit=1, window_seconds=3600, block_seconds=3600),
    )
    cid = await a_channel(anon_client, api, world, world.b)
    mid = await held(db, cid, world.lead_design, [world.intern])
    await login(anon_client, api, world.lead_design)
    url = f"{api}/chat/meetings/{mid}/summary"
    first = (await anon_client.post(url, json={})).json()
    second = (await anon_client.post(url, json={})).json()
    assert first["meeting"]["summary"]["source"] == "ai" and first["reason"] is None
    assert second["meeting"]["summary"]["source"] == "offline" and second["reason"] == "limit"
    assert ai.calls == 1, "over the cap, the AI is not asked"
    # The cap is per person: someone else still has theirs.
    await login(anon_client, api, world.pm)
    assert (await anon_client.post(url, json={})).json()["meeting"]["summary"]["source"] == "ai"


# --- posting the minutes ----------------------------------------------------------------


async def test_minutes_are_posted_once_and_only_when_open_to_the_whole_channel(
    anon_client: AsyncClient, api: str, world: World, db: AsyncSession, no_ai: None
) -> None:
    cid = await a_channel(anon_client, api, world, world.b)
    mid = await held(db, cid, world.lead_design, [world.intern])
    post = f"{api}/chat/meetings/{mid}/post-summary"
    await login(anon_client, api, world.lead_design)
    assert (await anon_client.post(post)).status_code == 409, "no minutes yet"
    await anon_client.post(f"{api}/chat/meetings/{mid}/summary", json={})
    assert (await anon_client.post(post)).status_code == 409, "not open to the channel"
    await anon_client.patch(f"{api}/chat/meetings/{mid}/access", json={"mode": "channel"})

    await login(anon_client, api, world.lead_field)  # can read now, so may post it
    r = await anon_client.post(post)
    assert r.status_code == 201, r.text
    assert r.json()["text"].startswith("Meeting summary (2026-07-24): ")
    assert "Decisions: We lock the load-in window" in r.json()["text"]
    assert (await anon_client.post(post)).status_code == 409, "not twice"
    assert (await get(anon_client, api, mid))["summary_posted_at"] is not None

    page = (await anon_client.get(f"{api}/chat/channels/{cid}/messages")).json()["messages"]
    assert any(m["text"].startswith("Meeting summary") for m in page)


async def test_minutes_that_are_restricted_cannot_be_posted_by_someone_who_cannot_read_them(
    anon_client: AsyncClient, api: str, world: World, db: AsyncSession, no_ai: None
) -> None:
    cid = await a_channel(anon_client, api, world, world.b)
    mid = await held(db, cid, world.lead_design, [world.intern])
    await login(anon_client, api, world.lead_design)
    await anon_client.post(f"{api}/chat/meetings/{mid}/summary", json={})
    await login(anon_client, api, world.lead_field)
    assert (await anon_client.post(f"{api}/chat/meetings/{mid}/post-summary")).status_code == 403
    await login(anon_client, api, world.staff)
    assert (await anon_client.post(f"{api}/chat/meetings/{mid}/post-summary")).status_code == 404


async def test_a_dm_call_is_never_posted(
    anon_client: AsyncClient, api: str, world: World, db: AsyncSession, no_ai: None
) -> None:
    await login(anon_client, api, world.lead_design)
    dm = (await anon_client.post(f"{api}/chat/dms", json={"user_id": str(world.intern.id)})).json()
    mid = await held(db, dm["id"], world.lead_design, [world.intern])
    await anon_client.post(f"{api}/chat/meetings/{mid}/summary", json={})
    r = await anon_client.post(f"{api}/chat/meetings/{mid}/post-summary")
    assert r.status_code == 409 and "whole channel" in r.text


# --- participants read host-first, and connected people are told ---------------------------


async def test_the_participants_are_listed_host_first(
    anon_client: AsyncClient, api: str, world: World, db: AsyncSession
) -> None:
    cid = await a_channel(anon_client, api, world, world.b)
    # The intern has the highest member number: ordered by number alone they would come last.
    mid = await held(db, cid, world.intern, [world.lead_design])
    await login(anon_client, api, world.intern)
    m = await get(anon_client, api, mid)
    assert m["participant_ids"][0] == str(world.intern.id) == m["host_id"]


class Wire:
    """Connected people, as the hub holds them: each one's queue is what they would be sent."""

    def __init__(self) -> None:
        self.hub = ChatHub()
        self.conns: dict[str, Connection] = {}

    def connect(self, user: User) -> None:
        conn = Connection(user_id=str(user.id), ws=FakeWS(), token_exp=9e12)
        assert self.hub.register(conn)
        self.conns[user.email] = conn

    def heard(self, user: User) -> list[dict[str, Any]]:
        import json

        queue = self.conns[user.email].queue
        out = []
        while not queue.empty():
            out.append(json.loads(queue.get_nowait()))
        return [f for f in out if f["type"] == "meeting.updated"]


@pytest.fixture
def wire() -> Any:
    w = Wire()
    set_hub(w.hub)
    yield w
    set_hub(None)


async def test_connected_people_who_can_open_the_channel_are_told_when_the_minutes_change(
    anon_client: AsyncClient, api: str, world: World, db: AsyncSession, wire: Wire, no_ai: None
) -> None:
    cid = await a_channel(anon_client, api, world, world.b)
    mid = await held(db, cid, world.lead_design, [world.intern])
    for u in (world.intern, world.lead_field, world.staff):
        wire.connect(u)
    told = {"meeting_id": str(mid), "channel_id": cid, "type": "meeting.updated"}

    await login(anon_client, api, world.intern)  # the first minutes
    assert (
        await anon_client.post(f"{api}/chat/meetings/{mid}/summary", json={})
    ).status_code == 200
    assert wire.heard(world.intern) == [told] and wire.heard(world.lead_field) == [told]
    assert wire.heard(world.staff) == [], "someone who cannot open the channel hears nothing"

    await login(anon_client, api, world.lead_design)
    r = await anon_client.patch(f"{api}/chat/meetings/{mid}/access", json={"mode": "channel"})
    assert r.status_code == 200
    assert wire.heard(world.intern) == [told] and wire.heard(world.lead_field) == [told]

    assert (await anon_client.post(f"{api}/chat/meetings/{mid}/post-summary")).status_code == 201
    assert told in wire.heard(world.lead_field)
    assert wire.heard(world.staff) == []


async def test_a_refused_change_tells_nobody(
    anon_client: AsyncClient, api: str, world: World, db: AsyncSession, wire: Wire
) -> None:
    cid = await a_channel(anon_client, api, world, world.b)
    mid = await held(db, cid, world.lead_design, [world.intern])
    wire.connect(world.lead_field)
    await login(anon_client, api, world.intern)
    r = await anon_client.patch(f"{api}/chat/meetings/{mid}/access", json={"mode": "channel"})
    assert r.status_code == 403 and wire.heard(world.lead_field) == []
