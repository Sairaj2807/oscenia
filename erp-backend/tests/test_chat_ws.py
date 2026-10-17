"""Chat backend C3 — the WebSocket handler and what REST writes announce through it.

The handler is driven in-process with a fake socket (see ``chat_ws_fakes``), in the same event
loop and on the same rolled-back session as the HTTP calls, so one test can open sockets for
several people, act over HTTP as one of them, and assert exactly who was told.

The rule behind most of these: **a frame goes only to people who may see what it is about**,
decided at the moment it happens — the same rules as the REST routes, with a project manager
seeing everything except other people's DMs.
"""

from __future__ import annotations

import asyncio
import contextlib
import time
import uuid
from collections.abc import AsyncIterator, Iterator
from datetime import timedelta
from typing import Any
from urllib.parse import quote

import pytest
from chat_world import World, login, make_channel, world  # noqa: F401
from chat_ws_fakes import FakeWS, SharedSessions, settle
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import _encode, issue_access_token, issue_refresh_token
from app.domain.chat import events
from app.domain.chat import hub as hubmod
from app.domain.chat import ws as ws_mod
from app.domain.chat.hub import ChatHub, set_hub

THUMBS = "\U0001f44d"

Sockets = list[tuple[FakeWS, "asyncio.Task[None]"]]


@pytest.fixture
def hub() -> Iterator[ChatHub]:
    h = ChatHub()
    h.leader = True
    set_hub(h)
    yield h
    set_hub(None)


@pytest.fixture
def sessions(db: AsyncSession) -> SharedSessions:
    return SharedSessions(db)


@pytest.fixture
async def sockets(hub: ChatHub) -> AsyncIterator[Sockets]:
    opened: Sockets = []
    yield opened
    for ws, _ in opened:
        ws.client_disconnect()
    for _, task in opened:
        with contextlib.suppress(Exception):
            await asyncio.wait_for(task, 2)
    await hub.shutdown()


def token_for(user: Any) -> str:
    return issue_access_token(user.id, user.role.value)[0]


def start(
    hub: ChatHub, sessions: SharedSessions, sockets: Sockets, origin: str | None = None
) -> FakeWS:
    ws = FakeWS(origin)
    sockets.append((ws, asyncio.create_task(ws_mod.serve(ws, hub, sessions))))
    return ws


async def connect(
    hub: ChatHub, sessions: SharedSessions, sockets: Sockets, user: Any, token: str | None = None
) -> FakeWS:
    ws = start(hub, sessions, sockets)
    ws.client_send({"op": "auth", "token": token or token_for(user)})
    await ws.wait_for("hello")
    return ws


@pytest.fixture
async def live(
    world: World, hub: ChatHub, sessions: SharedSessions, sockets: Sockets
) -> dict[str, FakeWS]:
    """One open socket per person, connected in this order."""
    out: dict[str, FakeWS] = {}
    for name in ("pm", "lead_field", "lead_design", "staff", "intern"):
        out[name] = await connect(hub, sessions, sockets, getattr(world, name))
    return out


async def room(http: AsyncClient, api: str, w: World, name: str = "general") -> str:
    await login(http, api, w.pm)
    return (await make_channel(http, api, project_id=w.a, name=name))["id"]


async def say(http: AsyncClient, api: str, cid: str, text: str) -> dict[str, Any]:
    r = await http.post(f"{api}/chat/channels/{cid}/messages", json={"text": text})
    assert r.status_code == 201, r.text
    return r.json()


def react_url(api: str, mid: str, emoji: str = THUMBS) -> str:
    return f"{api}/chat/messages/{mid}/reactions/{quote(emoji)}"


# =========================================================================================
# The handshake
# =========================================================================================


async def test_hello_is_the_first_frame_and_carries_who_you_are_and_who_is_here(
    world: World, hub: ChatHub, sessions: SharedSessions, sockets: Sockets
) -> None:
    lead = await connect(hub, sessions, sockets, world.lead_field)
    staff = await connect(hub, sessions, sockets, world.staff)
    first = staff.sent[0]
    assert first["type"] == "hello"
    assert first["user_id"] == str(world.staff.id) and first["member_no"] == world.staff.member_no
    assert first["heartbeat_s"] == 25 and "server_time" in first
    assert first["presence"] == {str(world.lead_field.id): "online", str(world.staff.id): "online"}
    assert lead.sent[0]["type"] == "hello"


@pytest.mark.parametrize(
    "frame",
    ["not json at all", '{"op": "ping"}', '{"op": "auth"}', '{"op": "auth", "token": 5}', "[1, 2]"],
)
async def test_a_first_frame_that_is_not_a_valid_auth_ends_the_connection(
    frame: str, world: World, hub: ChatHub, sessions: SharedSessions, sockets: Sockets
) -> None:
    ws = start(hub, sessions, sockets)
    ws.client_send(frame)
    assert await ws.wait_closed() == hubmod.CLOSE_BAD_AUTH
    assert ws.of("hello") == []


async def test_a_token_that_is_wrong_expired_or_the_wrong_kind_is_refused(
    world: World, hub: ChatHub, sessions: SharedSessions, sockets: Sockets
) -> None:
    expired = _encode(world.staff.id, "access", timedelta(seconds=-5), role="team")[0]
    refresh = issue_refresh_token(world.staff.id)[0]  # a refresh token is not a credential here
    for token in ("garbage", expired, refresh):
        ws = start(hub, sessions, sockets)
        ws.client_send({"op": "auth", "token": token})
        assert await ws.wait_closed() == hubmod.CLOSE_BAD_AUTH, token[:20]


async def test_a_login_with_no_workspace_persona_is_forbidden_not_unauthenticated(
    world: World, hub: ChatHub, sessions: SharedSessions, sockets: Sockets
) -> None:
    ws = start(hub, sessions, sockets)
    ws.client_send({"op": "auth", "token": token_for(world.outsider)})
    assert await ws.wait_closed() == hubmod.CLOSE_FORBIDDEN


async def test_a_deactivated_account_cannot_connect(
    world: World, db: AsyncSession, hub: ChatHub, sessions: SharedSessions, sockets: Sockets
) -> None:
    world.staff.active = False
    await db.flush()
    ws = start(hub, sessions, sockets)
    ws.client_send({"op": "auth", "token": token_for(world.staff)})
    assert await ws.wait_closed() == hubmod.CLOSE_BAD_AUTH


async def test_a_client_that_never_authenticates_is_cut_off(
    hub: ChatHub, sessions: SharedSessions, sockets: Sockets, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(hubmod, "AUTH_TIMEOUT_SECONDS", 0.1)
    ws = start(hub, sessions, sockets)
    assert await ws.wait_closed() == hubmod.CLOSE_BAD_AUTH


async def test_a_page_on_another_site_cannot_open_a_socket(
    world: World, hub: ChatHub, sessions: SharedSessions, sockets: Sockets
) -> None:
    evil = start(hub, sessions, sockets, origin="https://evil.example")
    assert await evil.wait_closed() == hubmod.CLOSE_FORBIDDEN
    assert evil.accepted is False  # refused before the handshake completed

    ok = start(hub, sessions, sockets, origin="http://localhost:5173")  # on the CORS list
    ok.client_send({"op": "auth", "token": token_for(world.staff)})
    await ok.wait_for("hello")
    assert ok.accepted


async def test_a_worker_that_is_not_the_hub_refuses_upgrades(
    hub: ChatHub, sessions: SharedSessions, sockets: Sockets, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def not_leader(_: ChatHub) -> bool:
        return False

    monkeypatch.setattr(ws_mod, "ensure_leader", not_leader)
    ws = start(hub, sessions, sockets)
    assert await ws.wait_closed() == hubmod.CLOSE_NOT_LEADER
    assert ws.of("hello") == []


async def test_a_person_cannot_open_more_connections_than_the_limit(
    world: World,
    hub: ChatHub,
    sessions: SharedSessions,
    sockets: Sockets,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(hubmod, "MAX_CONNECTIONS_PER_USER", 1)
    await connect(hub, sessions, sockets, world.staff)
    extra = start(hub, sessions, sockets)
    extra.client_send({"op": "auth", "token": token_for(world.staff)})
    assert await extra.wait_closed() == hubmod.CLOSE_TOO_MANY
    assert extra.of("hello") == []


# =========================================================================================
# The protocol, once connected
# =========================================================================================


async def test_ping_is_answered_and_nonsense_is_reported_not_fatal(
    world: World, hub: ChatHub, sessions: SharedSessions, sockets: Sockets
) -> None:
    ws = await connect(hub, sessions, sockets, world.staff)
    ws.client_send({"op": "ping"})
    await ws.wait_for("pong")
    ws.client_send({"op": "dance"})
    ws.client_send("}{")
    ws.client_send({"op": "auth", "token": token_for(world.staff)})
    ws.client_send({"op": "presence", "state": "asleep"})
    await ws.wait_for("error", count=4)
    assert [e["code"] for e in ws.of("error")] == [
        "unknown_op",
        "bad_frame",
        "already_authenticated",
        "bad_frame",
    ]
    ws.client_send({"op": "ping"})  # still alive after all of that
    await ws.wait_for("pong", count=2)
    assert ws.close_code is None


async def test_an_oversized_frame_closes_the_connection(
    world: World,
    hub: ChatHub,
    sessions: SharedSessions,
    sockets: Sockets,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ws = await connect(hub, sessions, sockets, world.staff)
    monkeypatch.setattr(hubmod, "FRAME_MAX_BYTES", 50)
    ws.client_send({"op": "ping", "padding": "x" * 100})
    assert await ws.wait_closed() == hubmod.CLOSE_TOO_BIG


async def test_a_connection_that_goes_silent_is_closed(
    world: World,
    hub: ChatHub,
    sessions: SharedSessions,
    sockets: Sockets,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ws = await connect(hub, sessions, sockets, world.staff)
    monkeypatch.setattr(hubmod, "IDLE_CLOSE_SECONDS", 0.1)
    ws.client_send({"op": "ping"})  # the loop picks up the new limit on its next wait
    await ws.wait_for("pong")
    assert await ws.wait_closed() == hubmod.CLOSE_IDLE


# --- keeping the session honest ------------------------------------------------------------


async def test_a_token_that_expires_without_being_renewed_ends_the_session(
    world: World,
    hub: ChatHub,
    sessions: SharedSessions,
    sockets: Sockets,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ws = await connect(hub, sessions, sockets, world.staff)
    monkeypatch.setattr(ws_mod, "_now", lambda: time.time() + 2 * 3600)
    ws.client_send({"op": "ping"})
    assert await ws.wait_closed() == hubmod.CLOSE_BAD_AUTH


async def test_reauth_extends_the_session_and_only_for_the_same_person(
    world: World,
    hub: ChatHub,
    sessions: SharedSessions,
    sockets: Sockets,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ws = await connect(hub, sessions, sockets, world.staff)
    later = _encode(world.staff.id, "access", timedelta(hours=5), role="team")[0]
    ws.client_send({"op": "reauth", "token": later})
    await ws.wait_for("reauthed")

    monkeypatch.setattr(ws_mod, "_now", lambda: time.time() + 2 * 3600)  # past the old token
    ws.client_send({"op": "ping"})
    await ws.wait_for("pong")
    assert ws.close_code is None

    # Someone else's token is not a renewal.
    ws.client_send({"op": "reauth", "token": token_for(world.lead_field)})
    assert await ws.wait_closed() == hubmod.CLOSE_BAD_AUTH


@pytest.mark.parametrize("how", ["deactivated", "removed from the workspace"])
async def test_someone_who_loses_access_is_disconnected_at_the_next_recheck(
    how: str,
    world: World,
    db: AsyncSession,
    hub: ChatHub,
    sessions: SharedSessions,
    sockets: Sockets,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ws = await connect(hub, sessions, sockets, world.staff)
    monkeypatch.setattr(hubmod, "RECHECK_SECONDS", -1)  # look them up on every frame
    if how == "deactivated":
        world.staff.active = False
    else:
        world.staff.workspace_role = None
    await db.flush()
    ws.client_send({"op": "ping"})
    assert await ws.wait_closed() == hubmod.CLOSE_FORBIDDEN


async def test_taking_someone_out_of_the_workspace_cuts_their_sockets_at_once(
    world: World, live: dict[str, FakeWS], anon_client: AsyncClient, api: str
) -> None:
    http = await login(anon_client, api, world.pm)
    r = await http.patch(
        f"{api}/chat/users/{world.staff.id}/workspace", json={"workspace_role": None}
    )
    assert r.status_code == 200
    assert await live["staff"].wait_closed() == hubmod.CLOSE_FORBIDDEN
    for other in ("pm", "lead_field", "lead_design", "intern"):  # everyone else reshapes
        await live[other].wait_for("bootstrap.invalidate")
        assert live[other].close_code is None


async def test_changing_a_projects_divisions_or_members_tells_everyone_to_refetch(
    world: World, live: dict[str, FakeWS], anon_client: AsyncClient, api: str
) -> None:
    http = await login(anon_client, api, world.pm)
    await http.put(f"{api}/chat/projects/{world.a}/divisions", json={"divisions": ["Field"]})
    await http.put(
        f"{api}/chat/projects/{world.a}/members", json={"user_ids": [str(world.staff.id)]}
    )
    for ws in live.values():
        await ws.wait_for("bootstrap.invalidate", count=2)


# =========================================================================================
# Messages: who hears what
# =========================================================================================


async def test_a_new_message_reaches_exactly_the_people_who_can_read_the_channel(
    world: World, live: dict[str, FakeWS], anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    sent = await say(http, api, cid, "hello team")

    for name in ("pm", "lead_field", "staff"):  # the sender too: that is how a client reconciles
        frame = await live[name].wait_for("message.new")
        assert frame["channel_id"] == cid and frame["rev"] == 1
        assert frame["message"]["id"] == sent["id"] and frame["message"]["text"] == "hello team"
    await settle()
    for name in ("lead_design", "intern"):  # not on project A
        assert live[name].of("message.new") == [], name


async def test_edits_deletes_and_reactions_are_announced_once_each(
    world: World, live: dict[str, FakeWS], anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    m = await say(http, api, cid, "first draft")
    watcher = live["lead_field"]

    await http.patch(f"{api}/chat/messages/{m['id']}", json={"text": "second draft"})
    updated = await watcher.wait_for("message.updated")
    assert updated["message"]["text"] == "second draft" and updated["rev"] == 2

    await http.put(react_url(api, m["id"]))
    await http.put(react_url(api, m["id"]))  # idempotent: changes nothing, announces nothing
    reacted = await watcher.wait_for("reaction.updated")
    assert reacted["message"]["reactions"] == {THUMBS: [str(world.staff.id)]}
    await http.delete(react_url(api, m["id"]))
    await watcher.wait_for("reaction.updated", count=2)

    await http.delete(f"{api}/chat/messages/{m['id']}")
    await http.delete(f"{api}/chat/messages/{m['id']}")  # twice: one announcement
    gone = await watcher.wait_for("message.deleted")
    assert gone["message"]["deleted"] is True and gone["message"]["text"] == ""
    await settle()
    assert len(watcher.of("reaction.updated")) == 2 and len(watcher.of("message.deleted")) == 1
    assert [f["rev"] for f in watcher.of("message.new") + watcher.of("message.updated")] == [1, 2]


async def test_a_retried_send_announces_only_the_first(
    world: World, live: dict[str, FakeWS], anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    body = {"text": "once", "client_msg_id": str(uuid.uuid4())}
    await http.post(f"{api}/chat/channels/{cid}/messages", json=body)
    await http.post(f"{api}/chat/channels/{cid}/messages", json=body)
    await live["lead_field"].wait_for("message.new")
    await settle()
    assert len(live["lead_field"].of("message.new")) == 1


async def test_a_dm_is_told_to_its_two_people_and_nobody_else_not_even_the_pm(
    world: World, live: dict[str, FakeWS], anon_client: AsyncClient, api: str
) -> None:
    http = await login(anon_client, api, world.staff)
    dm = (await http.post(f"{api}/chat/dms", json={"user_id": str(world.intern.id)})).json()
    await live["staff"].wait_for("channel.created")
    await live["intern"].wait_for("channel.created")
    assert live["staff"].of("channel.created")[0]["channel"]["dm_with"] == str(world.intern.id)

    await say(http, api, dm["id"], "just between us")
    await live["staff"].wait_for("message.new")
    await live["intern"].wait_for("message.new")
    await settle()
    for name in ("pm", "lead_field", "lead_design"):
        assert live[name].of("message.new") == [], name
        assert live[name].of("channel.created") == [], name


async def test_blocking_someone_ends_what_they_hear_and_tells_them_the_channel_is_gone(
    world: World, live: dict[str, FakeWS], anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)  # as the PM
    await http.patch(f"{api}/chat/channels/{cid}", json={"blocked_ids": [str(world.staff.id)]})

    gone = await live["staff"].wait_for("channel.removed")
    assert gone["channel_id"] == cid
    await login(http, api, world.lead_field)
    await say(http, api, cid, "after the block")
    await live["pm"].wait_for("message.new")
    await settle()
    assert live["staff"].of("message.new") == []  # the very next message skips them


# =========================================================================================
# Channels
# =========================================================================================


async def test_a_new_open_channel_is_shown_to_those_who_can_open_it_only(
    world: World, live: dict[str, FakeWS], anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    frame = await live["staff"].wait_for("channel.created")
    assert frame["channel"]["id"] == cid and frame["channel"]["locked"] is False
    await live["lead_field"].wait_for("channel.created")
    await settle()
    for name in ("lead_design", "intern"):
        assert live[name].of("channel.created") == [], name


async def test_a_locked_channel_is_shown_locked_and_only_managers_see_who_is_in_it(
    world: World, live: dict[str, FakeWS], anon_client: AsyncClient, api: str
) -> None:
    http = await login(anon_client, api, world.pm)
    await make_channel(http, api, project_id=world.a, name="ops", access="invite")

    staff = (await live["staff"].wait_for("channel.created"))["channel"]
    assert staff["locked"] is True and staff["can_manage"] is False
    assert staff["member_ids"] is None and staff["blocked_ids"] is None

    lead = (await live["lead_field"].wait_for("channel.created"))["channel"]
    assert lead["can_manage"] is True and lead["member_ids"] is not None
    pm = (await live["pm"].wait_for("channel.created"))["channel"]
    assert pm["locked"] is False
    await settle()
    assert live["intern"].of("channel.created") == []  # not on the project: no hint it exists


async def test_changing_a_channels_rule_moves_people_between_open_locked_and_gone(
    world: World, live: dict[str, FakeWS], anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await live["staff"].wait_for("channel.created")

    # Open -> invite-only but listed: they can still see it, locked.
    await http.patch(f"{api}/chat/channels/{cid}", json={"access": "invite"})
    now_locked = (await live["staff"].wait_for("channel.updated"))["channel"]
    assert now_locked["locked"] is True
    assert live["staff"].of("channel.removed") == []

    # Then unlisted: they cannot see it at all any more.
    await http.patch(f"{api}/chat/channels/{cid}", json={"listed": False})
    gone = await live["staff"].wait_for("channel.removed")
    assert gone["channel_id"] == cid


async def test_a_join_request_is_announced_to_those_who_can_decide_and_the_answer_to_the_asker(
    world: World, live: dict[str, FakeWS], anon_client: AsyncClient, api: str
) -> None:
    http = await login(anon_client, api, world.pm)
    cid = (await make_channel(http, api, project_id=world.a, name="ops", access="invite"))["id"]

    await login(http, api, world.staff)
    asked = (
        await http.post(f"{api}/chat/channels/{cid}/join-requests", json={"note": "please"})
    ).json()
    for name in ("pm", "lead_field"):
        got = await live[name].wait_for("join_request.created")
        assert got["request"]["id"] == asked["id"] and got["request"]["note"] == "please"
    await settle()
    assert live["staff"].of("join_request.created") == []  # the asker is not told they asked
    assert live["intern"].of("join_request.created") == []

    await login(http, api, world.lead_field)
    await http.post(f"{api}/chat/join-requests/{asked['id']}/decide", json={"approve": True})
    decided = await live["staff"].wait_for("join_request.decided")
    assert decided["request"]["status"] == "approved"
    opened = await live["staff"].wait_for("channel.updated")
    assert opened["channel"]["locked"] is False  # they are in now


# =========================================================================================
# Read state, typing and presence
# =========================================================================================


async def test_reading_is_told_to_the_readers_other_devices_and_no_one_else(
    world: World,
    hub: ChatHub,
    sessions: SharedSessions,
    sockets: Sockets,
    live: dict[str, FakeWS],
    anon_client: AsyncClient,
    api: str,
) -> None:
    second_device = await connect(hub, sessions, sockets, world.staff)
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.lead_field)
    await say(http, api, cid, "read me")

    await login(http, api, world.staff)
    await http.post(f"{api}/chat/channels/{cid}/read", json={"seq": 1})
    for ws in (live["staff"], second_device):
        got = await ws.wait_for("read.updated")
        assert got["channel_id"] == cid and got["last_read_seq"] == 1
    await settle()
    assert live["lead_field"].of("read.updated") == []


async def test_typing_reaches_the_others_in_the_channel_but_not_the_typist_or_outsiders(
    world: World, live: dict[str, FakeWS], anon_client: AsyncClient, api: str
) -> None:
    cid = await room(anon_client, api, world)
    live["staff"].client_send({"op": "typing", "channel_id": cid})
    for name in ("pm", "lead_field"):
        got = await live[name].wait_for("typing")
        assert got["channel_id"] == cid and got["user_id"] == str(world.staff.id)
    await settle()
    for name in ("staff", "lead_design", "intern"):
        assert live[name].of("typing") == [], name


async def test_typing_is_rate_limited_per_channel(
    world: World, live: dict[str, FakeWS], anon_client: AsyncClient, api: str
) -> None:
    cid = await room(anon_client, api, world)
    for _ in range(5):
        live["staff"].client_send({"op": "typing", "channel_id": cid})
    await live["lead_field"].wait_for("typing")
    await settle()
    assert len(live["lead_field"].of("typing")) == 1


async def test_typing_in_a_channel_you_cannot_open_says_nothing_to_anyone(
    world: World, live: dict[str, FakeWS], anon_client: AsyncClient, api: str
) -> None:
    cid = await room(anon_client, api, world)  # project A: the intern is not on it
    live["intern"].client_send({"op": "typing", "channel_id": cid})
    live["intern"].client_send({"op": "typing", "channel_id": str(uuid.uuid4())})
    live["intern"].client_send({"op": "typing", "channel_id": "not-a-uuid"})
    await live["intern"].wait_for("error")  # only the malformed one is reported
    await settle()
    for ws in live.values():
        assert ws.of("typing") == []
    assert [e["code"] for e in live["intern"].of("error")] == ["bad_frame"]


async def test_presence_follows_connecting_activity_and_the_status_people_choose(
    world: World, live: dict[str, FakeWS], anon_client: AsyncClient, api: str
) -> None:
    watcher, staff_id = live["lead_field"], str(world.staff.id)

    def latest(ws: FakeWS) -> str:
        return [f for f in ws.of("presence") if f["user_id"] == staff_id][-1]["status"]

    await watcher.wait_for("presence", count=1)
    assert latest(watcher) == "online"  # staff connected after the watcher

    live["staff"].client_send({"op": "presence", "state": "idle"})
    for _ in range(100):
        if latest(watcher) == "idle":
            break
        await asyncio.sleep(0.01)
    assert latest(watcher) == "idle"

    http = await login(anon_client, api, world.staff)
    assert (
        await http.patch(f"{api}/chat/me/status", json={"status": "invisible"})
    ).status_code == 200
    for _ in range(100):
        if latest(watcher) == "offline":
            break
        await asyncio.sleep(0.01)
    assert latest(watcher) == "offline"  # invisible reads as offline to others...
    own = [f for f in live["staff"].of("presence") if f["user_id"] == staff_id][-1]
    assert own["status"] == "invisible"  # ...but not to the person themselves


async def test_the_bootstrap_lists_who_is_here_as_the_caller_may_see_them(
    world: World, live: dict[str, FakeWS], anon_client: AsyncClient, api: str
) -> None:
    http = await login(anon_client, api, world.staff)
    await http.patch(f"{api}/chat/me/status", json={"status": "invisible"})

    mine = (await http.get(f"{api}/chat/bootstrap")).json()
    assert mine["my_status"] == "invisible"
    assert mine["presence"][str(world.staff.id)] == "invisible"
    assert mine["presence"][str(world.pm.id)] == "online"

    await login(http, api, world.lead_field)
    theirs = (await http.get(f"{api}/chat/bootstrap")).json()
    assert str(world.staff.id) not in theirs["presence"]  # invisible: not in the list at all
    assert theirs["my_status"] == "online"


async def test_a_bad_status_is_refused(
    world: World, hub: ChatHub, anon_client: AsyncClient, api: str
) -> None:
    http = await login(anon_client, api, world.staff)
    assert (await http.patch(f"{api}/chat/me/status", json={"status": "away"})).status_code == 422


async def test_going_offline_is_announced_after_the_grace_period(
    world: World, live: dict[str, FakeWS], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(hubmod, "PRESENCE_GRACE_SECONDS", 0.05)
    live["staff"].client_disconnect()
    watcher, staff_id = live["lead_field"], str(world.staff.id)
    for _ in range(200):
        seen = [f["status"] for f in watcher.of("presence") if f["user_id"] == staff_id]
        if seen and seen[-1] == "offline":
            break
        await asyncio.sleep(0.01)
    assert seen[-1] == "offline"


# =========================================================================================
# A broadcast must never fail a write that already succeeded
# =========================================================================================


async def test_a_failing_broadcast_does_not_fail_the_request(
    world: World,
    live: dict[str, FakeWS],
    anon_client: AsyncClient,
    api: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)

    async def boom(*_: object, **__: object) -> None:
        raise RuntimeError("the hub is on fire")

    monkeypatch.setattr(events, "message_event", boom)
    r = await http.post(f"{api}/chat/channels/{cid}/messages", json={"text": "still saved"})
    assert r.status_code == 201  # the write committed; only the announcement was lost
    listed = (await http.get(f"{api}/chat/channels/{cid}/messages")).json()["messages"]
    assert [m["text"] for m in listed] == ["still saved"]


# =========================================================================================
# Commit first, announce after
# =========================================================================================


async def test_every_write_is_committed_before_it_is_announced(
    world: World,
    db: AsyncSession,
    live: dict[str, FakeWS],
    anon_client: AsyncClient,
    api: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A frame sent before the commit could reach a client that then asks for the message and
    finds nothing — or announce something a rolled-back request never did. For each kind of
    write, after the write and before its announcement there must be a commit."""
    from app.domain.chat import messages, service

    log: list[str] = []

    def tracked(owner: Any, name: str, label: str) -> None:
        original = getattr(owner, name)

        async def wrapper(*a: Any, **kw: Any) -> Any:
            result = await original(*a, **kw)
            log.append(label)
            return result

        monkeypatch.setattr(owner, name, wrapper)

    for owner, name in (
        (messages, "post_message"),
        (messages, "edit_message"),
        (messages, "delete_message"),
        (messages, "set_reaction"),
        (service, "create_channel"),
    ):
        tracked(owner, name, "write")
    for name in ("message_event", "channel_event"):
        tracked(events, name, "event")

    real_commit = db.commit

    async def logged_commit() -> None:
        log.append("commit")
        await real_commit()

    monkeypatch.setattr(db, "commit", logged_commit)

    http = anon_client
    cid = await room(http, api, world)  # a channel write
    await login(http, api, world.staff)
    m = await say(http, api, cid, "one")  # a message write
    await http.patch(f"{api}/chat/messages/{m['id']}", json={"text": "two"})
    await http.put(react_url(api, m["id"]))
    await http.delete(f"{api}/chat/messages/{m['id']}")

    assert log.count("event") >= 5
    last_write: int | None = None
    committed_since_write = True
    for entry in log:
        if entry == "write":
            last_write, committed_since_write = 0, False
        elif entry == "commit":
            committed_since_write = True
        elif entry == "event" and last_write is not None:
            assert committed_since_write, f"announced before committing: {log}"


# =========================================================================================
# The single-worker guard (found by running a real server: the tests skip it)
# =========================================================================================


class _GuardSettings:
    env = "development"
    chat_hub_single_worker_guard = True
    chat_hub_lock_key = 1


class _FakeLockConn:
    async def close(self) -> None:
        return None


async def test_sockets_arriving_together_do_not_race_each_other_for_the_hub_lock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Two first connections at once: the second used to ask Postgres from another session and
    be refused the lock this very process was already taking, so it was turned away as if a
    different worker held it. Found by a live run; the in-process tests switch the guard off."""
    calls: list[int] = []

    async def acquire(_engine: object, key: int) -> _FakeLockConn | None:
        calls.append(key)
        await asyncio.sleep(0.05)  # long enough for the other sockets to arrive meanwhile
        return _FakeLockConn()

    monkeypatch.setattr(ws_mod, "get_settings", lambda: _GuardSettings())
    monkeypatch.setattr(ws_mod, "get_engine", lambda: None)
    monkeypatch.setattr(ws_mod, "acquire_leadership", acquire)
    fresh = ChatHub()
    results = await asyncio.gather(*(ws_mod.ensure_leader(fresh) for _ in range(4)))
    assert results == [True] * 4
    assert len(calls) == 1  # one attempt, however many sockets arrived at once
    await fresh.shutdown()


async def test_a_process_refused_the_lock_asks_again_on_its_next_connection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """So it can take over if the process that held the lock goes away."""
    answers: list[_FakeLockConn | None] = [None, _FakeLockConn()]

    async def acquire(_engine: object, _key: int) -> _FakeLockConn | None:
        return answers.pop(0)

    monkeypatch.setattr(ws_mod, "get_settings", lambda: _GuardSettings())
    monkeypatch.setattr(ws_mod, "get_engine", lambda: None)
    monkeypatch.setattr(ws_mod, "acquire_leadership", acquire)
    fresh = ChatHub()
    assert await ws_mod.ensure_leader(fresh) is False
    assert fresh.leader is False
    assert await ws_mod.ensure_leader(fresh) is True
    await fresh.shutdown()


# =========================================================================================
# C4: notifications and files, live
# =========================================================================================


async def test_a_mention_rings_the_bell_of_those_mentioned_who_can_open_the_channel(
    world: World, live: dict[str, FakeWS], anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.lead_field)
    text = f"<@{world.staff.member_no}> and <@{world.intern.member_no}> please look"
    m = await say(http, api, cid, text)

    got = await live["staff"].wait_for("notification.new")
    item = got["notification"]
    assert item["id"] == f"mention:{m['id']}" and item["kind"] == "Mentioned you"
    assert item["read"] is False and item["to"] == f"/chat/{cid}"
    assert item["title"] == f"{world.lead_field.full_name} in #general"
    await settle()
    # The intern is mentioned but not on project A; the author and bystanders are not mentioned.
    for name in ("intern", "lead_field", "pm", "lead_design"):
        assert live[name].of("notification.new") == [], name


async def test_an_edit_rings_only_for_the_mentions_it_adds(
    world: World, live: dict[str, FakeWS], anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.lead_field)
    m = await say(http, api, cid, f"<@{world.staff.member_no}> first")
    await live["staff"].wait_for("notification.new")

    both = f"<@{world.staff.member_no}> and <@{world.pm.member_no}> first"
    await http.patch(f"{api}/chat/messages/{m['id']}", json={"text": both})
    await live["pm"].wait_for("notification.new")  # newly mentioned
    await settle()
    assert len(live["staff"].of("notification.new")) == 1  # keeping a mention does not ring again


async def test_join_requests_and_their_answers_arrive_as_notifications(
    world: World, live: dict[str, FakeWS], anon_client: AsyncClient, api: str
) -> None:
    http = await login(anon_client, api, world.pm)
    cid = (await make_channel(http, api, project_id=world.a, name="ops", access="invite"))["id"]
    await login(http, api, world.staff)
    rid = (
        await http.post(f"{api}/chat/channels/{cid}/join-requests", json={"note": "please"})
    ).json()["id"]

    for name in ("pm", "lead_field"):
        got = await live[name].wait_for("notification.new")
        assert got["notification"]["kind"] == "Wants to join"
        assert got["notification"]["id"] == f"join:{rid}"
    await settle()
    assert live["staff"].of("notification.new") == []  # you are not told you asked

    await login(http, api, world.lead_field)
    await http.post(f"{api}/chat/join-requests/{rid}/decide", json={"approve": True})
    answer = await live["staff"].wait_for("notification.new")
    assert answer["notification"]["kind"] == "Added to channel"
    assert answer["notification"]["title"] == "You were added to #ops"


async def test_a_message_with_files_carries_working_links_in_its_live_frame(
    world: World,
    live: dict[str, FakeWS],
    anon_client: AsyncClient,
    api: str,
    tmp_path: Any,
) -> None:
    from app.core.storage import LocalDiskStorage, set_storage

    set_storage(LocalDiskStorage(tmp_path))
    try:
        http = anon_client
        cid = await room(http, api, world)
        await login(http, api, world.staff)
        pdf = b"%PDF-1.4\n1 0 obj\n<< >>\nendobj\n%%EOF\n"
        up = await http.post(
            f"{api}/chat/channels/{cid}/attachments",
            files={"file": ("plan.pdf", pdf, "application/pdf")},
        )
        assert up.status_code == 201
        sent = await http.post(
            f"{api}/chat/channels/{cid}/messages",
            json={"text": "the plan", "attachment_ids": [up.json()["id"]]},
        )
        assert sent.status_code == 201

        frame = await live["lead_field"].wait_for("message.new")
        carried = frame["message"]["attachments"]
        assert [a["filename"] for a in carried] == ["plan.pdf"]
        assert (await http.get(carried[0]["url"])).content == pdf  # the live link works
        await settle()
        assert live["intern"].of("message.new") == []  # and nobody outside heard of the file
    finally:
        set_storage(None)
