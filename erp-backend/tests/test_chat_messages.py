"""Chat backend C2 — messages, reactions, mentions, read state and sync over real HTTP.

Time-dependent rules (the 15-minute edit window) run on the injected frozen clock, which the
tests move forward; nothing here sleeps.
"""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any
from urllib.parse import quote

import pytest
from chat_world import World, bootstrap, ids, login, make_channel, world  # noqa: F401
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import FrozenClock
from app.core.throttle import Throttle
from app.domain.chat import messages
from app.domain.chat.models import ChatMessage

THUMBS = "\U0001f44d"
HEART = "❤️"


@pytest.fixture(autouse=True)
def loose_throttle(monkeypatch: pytest.MonkeyPatch) -> None:
    """The frozen clock never lets a throttle window age out, so every test but the throttle's
    own gets a limit it cannot reach."""
    monkeypatch.setattr(
        messages,
        "send_throttle",
        Throttle("chat-send", limit=10_000, window_seconds=10, block_seconds=1),
    )


async def room(http: AsyncClient, api: str, w: World) -> str:
    """A project channel on A that the PM, both leaders' reach and the staff member can open."""
    await login(http, api, w.pm)
    return (await make_channel(http, api, project_id=w.a, name="general"))["id"]


async def say(http: AsyncClient, api: str, channel: str, text: str, **extra: Any) -> dict[str, Any]:
    r = await http.post(f"{api}/chat/channels/{channel}/messages", json={"text": text, **extra})
    assert r.status_code == 201, r.text
    return r.json()


async def page(http: AsyncClient, api: str, channel: str, **params: Any) -> dict[str, Any]:
    r = await http.get(f"{api}/chat/channels/{channel}/messages", params=params)
    assert r.status_code == 200, r.text
    return r.json()


def react_url(api: str, message: str, emoji: str) -> str:
    return f"{api}/chat/messages/{message}/reactions/{quote(emoji)}"


# --- posting ------------------------------------------------------------------------------


async def test_a_message_is_posted_and_listed_in_order(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    first = await say(http, api, cid, "hello")
    second = await say(http, api, cid, "again")

    assert (first["seq"], first["rev"], second["seq"]) == (1, 1, 2)
    assert first["author_id"] == str(world.staff.id) and first["author_no"] == world.staff.member_no
    assert first["deleted"] is False and first["reactions"] == {} and first["kind"] == "text"

    got = await page(http, api, cid)
    assert [m["text"] for m in got["messages"]] == ["hello", "again"]
    assert got["has_more_before"] is False and got["has_more_after"] is False


async def test_text_is_trimmed_and_control_characters_are_dropped(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    m = await say(http, api, cid, "  line one\r\nline\x00 two\x07  ")
    assert m["text"] == "line one\nline two"


@pytest.mark.parametrize("bad", ["", "   ", "\x00\x01"])
async def test_an_empty_message_is_refused(
    bad: str, world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    r = await http.post(f"{api}/chat/channels/{cid}/messages", json={"text": bad})
    assert r.status_code == 422


async def test_a_message_over_the_limit_is_refused(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    ok = await http.post(f"{api}/chat/channels/{cid}/messages", json={"text": "x" * 4000})
    assert ok.status_code == 201
    r = await http.post(f"{api}/chat/channels/{cid}/messages", json={"text": "x" * 4001})
    assert r.status_code == 422


async def test_markup_is_stored_as_typed_never_interpreted(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    """The server keeps what was sent; the renderer escapes it. Nothing here may turn text
    into markup or a link."""
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    for raw in ("<script>alert(1)</script>", "javascript:alert(1)", '<img src=x onerror="y">'):
        assert (await say(http, api, cid, raw))["text"] == raw


async def test_you_cannot_post_where_you_cannot_see(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.intern)  # not on project A
    r = await http.post(f"{api}/chat/channels/{cid}/messages", json={"text": "hi"})
    assert r.status_code == 404
    assert (await http.get(f"{api}/chat/channels/{cid}/messages")).status_code == 404
    r = await http.post(f"{api}/chat/channels/{uuid.uuid4()}/messages", json={"text": "hi"})
    assert r.status_code == 404


async def test_a_blocked_member_can_no_longer_read_or_post(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    await say(http, api, cid, "before the block")
    await login(http, api, world.pm)
    await http.patch(f"{api}/chat/channels/{cid}", json={"blocked_ids": [str(world.staff.id)]})
    await login(http, api, world.staff)
    assert (await http.get(f"{api}/chat/channels/{cid}/messages")).status_code == 404
    assert (
        await http.post(f"{api}/chat/channels/{cid}/messages", json={"text": "still here?"})
    ).status_code == 404


# --- mentions and quotes ------------------------------------------------------------------


async def test_a_mention_is_recorded_and_unknown_ones_are_refused(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    lead = world.lead_field.member_no
    m = await say(http, api, cid, f"over to <@{lead}> and <@{lead}> and <#T-102>")
    assert m["mentions"] == [str(world.lead_field.id)]  # once, however often it is written

    r = await http.post(f"{api}/chat/channels/{cid}/messages", json={"text": "hi <@M-9999>"})
    assert r.status_code == 422


async def test_mentioning_yourself_notifies_nobody(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    m = await say(http, api, cid, f"note to self <@{world.staff.member_no}>")
    assert m["mentions"] == []


async def test_a_reply_quotes_a_message_in_the_same_channel(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.pm)
    other = (await make_channel(http, api, project_id=world.a, name="other"))["id"]
    await login(http, api, world.staff)
    original = await say(http, api, cid, "original")
    reply = await say(http, api, cid, "reply", quote_id=original["id"])
    assert reply["quote_id"] == original["id"]

    foreign = await say(http, api, other, "elsewhere")
    for bad in (foreign["id"], str(uuid.uuid4())):
        r = await http.post(
            f"{api}/chat/channels/{cid}/messages", json={"text": "x", "quote_id": bad}
        )
        assert r.status_code == 422, bad


async def test_a_reply_can_quote_a_deleted_message(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    original = await say(http, api, cid, "oops")
    await http.delete(f"{api}/chat/messages/{original['id']}")
    reply = await say(http, api, cid, "re: oops", quote_id=original["id"])
    assert reply["quote_id"] == original["id"]


# --- retries ------------------------------------------------------------------------------


async def test_a_retried_send_is_the_same_message_not_a_second(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    key = str(uuid.uuid4())
    body = {"text": "once", "client_msg_id": key}
    first = await http.post(f"{api}/chat/channels/{cid}/messages", json=body)
    again = await http.post(f"{api}/chat/channels/{cid}/messages", json=body)
    assert (first.status_code, again.status_code) == (201, 200)
    assert first.json()["id"] == again.json()["id"]

    assert len((await page(http, api, cid))["messages"]) == 1
    # The retry did not spend a sequence number, so the channel has no gap.
    assert (await say(http, api, cid, "next"))["seq"] == 2


async def test_the_same_client_id_cannot_be_reused_in_another_channel(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.pm)
    other = (await make_channel(http, api, project_id=world.a, name="other"))["id"]
    await login(http, api, world.staff)
    key = str(uuid.uuid4())
    await say(http, api, cid, "here", client_msg_id=key)
    r = await http.post(
        f"{api}/chat/channels/{other}/messages", json={"text": "there", "client_msg_id": key}
    )
    assert r.status_code == 409


async def test_two_senders_may_use_the_same_client_id(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    key = str(uuid.uuid4())
    await login(http, api, world.staff)
    a = await say(http, api, cid, "mine", client_msg_id=key)
    await login(http, api, world.lead_field)
    b = await say(http, api, cid, "theirs", client_msg_id=key)
    assert a["id"] != b["id"]


# --- editing and deleting -----------------------------------------------------------------


async def test_the_author_edits_within_the_window_and_it_is_marked(
    world: World, anon_client: AsyncClient, api: str, frozen_clock: FrozenClock
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    m = await say(http, api, cid, "teh plan")
    frozen_clock.advance(timedelta(minutes=5))
    r = await http.patch(f"{api}/chat/messages/{m['id']}", json={"text": "the plan"})
    assert r.status_code == 200, r.text
    edited = r.json()
    assert edited["text"] == "the plan" and edited["edited_at"] is not None
    assert edited["seq"] == m["seq"] and edited["rev"] > m["rev"]  # seq never moves, rev does


async def test_the_edit_window_is_fifteen_minutes_by_the_servers_clock(
    world: World, anon_client: AsyncClient, api: str, frozen_clock: FrozenClock
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    m = await say(http, api, cid, "timed")

    frozen_clock.advance(timedelta(minutes=15))  # exactly fifteen: still allowed
    assert (
        await http.patch(f"{api}/chat/messages/{m['id']}", json={"text": "on the line"})
    ).status_code == 200

    frozen_clock.advance(timedelta(seconds=1))  # one second past
    late = await http.patch(f"{api}/chat/messages/{m['id']}", json={"text": "too late"})
    assert late.status_code == 409
    assert (await page(http, api, cid))["messages"][0]["text"] == "on the line"


async def test_only_the_author_edits(world: World, anon_client: AsyncClient, api: str) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    m = await say(http, api, cid, "mine")
    for person in (world.lead_field, world.pm):
        await login(http, api, person)
        r = await http.patch(f"{api}/chat/messages/{m['id']}", json={"text": "hijack"})
        assert r.status_code == 403


async def test_an_edit_keeps_mentions_in_step_with_the_text(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    lead, pm = world.lead_field, world.pm
    m = await say(http, api, cid, f"<@{lead.member_no}> please look")
    assert m["mentions"] == [str(lead.id)]

    r = await http.patch(
        f"{api}/chat/messages/{m['id']}", json={"text": f"<@{pm.member_no}> please look"}
    )
    assert r.json()["mentions"] == [str(pm.id)]  # one taken out, one added
    bad = await http.patch(f"{api}/chat/messages/{m['id']}", json={"text": "<@M-9999> hi"})
    assert bad.status_code == 422


async def test_the_author_deletes_within_the_window_and_leaves_a_placeholder(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    m = await say(http, api, cid, f"secret <@{world.lead_field.member_no}>")
    await http.put(react_url(api, m["id"], THUMBS))

    r = await http.delete(f"{api}/chat/messages/{m['id']}")
    assert r.status_code == 200
    gone = r.json()
    assert gone["deleted"] is True and gone["text"] == ""
    assert gone["reactions"] == {} and gone["mentions"] == []
    assert gone["seq"] == m["seq"]
    # The stream keeps its shape: the placeholder is still in the list.
    listed = (await page(http, api, cid))["messages"]
    assert [x["deleted"] for x in listed] == [True]


async def test_deleting_twice_is_not_an_error_and_changes_nothing(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    m = await say(http, api, cid, "bye")
    first = (await http.delete(f"{api}/chat/messages/{m['id']}")).json()
    again = await http.delete(f"{api}/chat/messages/{m['id']}")
    assert again.status_code == 200 and again.json()["rev"] == first["rev"]


async def test_after_the_window_only_the_pm_can_delete(
    world: World, anon_client: AsyncClient, api: str, frozen_clock: FrozenClock
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    m = await say(http, api, cid, "old news")
    frozen_clock.advance(timedelta(minutes=16))

    assert (await http.delete(f"{api}/chat/messages/{m['id']}")).status_code == 409  # the author
    await login(http, api, world.lead_field)
    assert (await http.delete(f"{api}/chat/messages/{m['id']}")).status_code == 403  # a leader
    await login(http, api, world.pm)
    assert (await http.delete(f"{api}/chat/messages/{m['id']}")).status_code == 200  # the PM


async def test_an_edit_or_delete_of_a_deleted_message(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    m = await say(http, api, cid, "gone")
    await http.delete(f"{api}/chat/messages/{m['id']}")
    assert (
        await http.patch(f"{api}/chat/messages/{m['id']}", json={"text": "back"})
    ).status_code == 409


async def test_a_message_in_a_channel_you_cannot_see_is_a_404(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    m = await say(http, api, cid, "private to A")
    await login(http, api, world.intern)
    assert (
        await http.patch(f"{api}/chat/messages/{m['id']}", json={"text": "x"})
    ).status_code == 404
    assert (await http.delete(f"{api}/chat/messages/{m['id']}")).status_code == 404
    assert (await http.put(react_url(api, m["id"], THUMBS))).status_code == 404
    assert (
        await http.patch(f"{api}/chat/messages/{uuid.uuid4()}", json={"text": "x"})
    ).status_code == 404


# --- direct messages ----------------------------------------------------------------------


async def test_a_dm_carries_messages_only_its_two_people_can_read(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    await login(http, api, world.staff)
    dm = (await http.post(f"{api}/chat/dms", json={"user_id": str(world.intern.id)})).json()["id"]
    m = await say(http, api, dm, "between us")

    await login(http, api, world.intern)
    assert [x["text"] for x in (await page(http, api, dm))["messages"]] == ["between us"]

    # Not even the PM: not to read, not to delete, not to react.
    await login(http, api, world.pm)
    assert (await http.get(f"{api}/chat/channels/{dm}/messages")).status_code == 404
    assert (await http.delete(f"{api}/chat/messages/{m['id']}")).status_code == 404
    assert (await http.put(react_url(api, m["id"], THUMBS))).status_code == 404
    assert (await http.post(f"{api}/chat/sync", json={"cursors": {dm: 0}})).json()["channels"] == []


# --- reactions ----------------------------------------------------------------------------


async def test_a_reaction_is_added_once_and_removed(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    m = await say(http, api, cid, "nice")

    added = (await http.put(react_url(api, m["id"], THUMBS))).json()
    assert added["reactions"] == {THUMBS: [str(world.staff.id)]} and added["rev"] > m["rev"]
    again = (await http.put(react_url(api, m["id"], THUMBS))).json()
    assert again["reactions"] == added["reactions"] and again["rev"] == added["rev"]  # not a toggle

    removed = (await http.delete(react_url(api, m["id"], THUMBS))).json()
    assert removed["reactions"] == {}
    again = (await http.delete(react_url(api, m["id"], THUMBS))).json()
    assert again["rev"] == removed["rev"]


async def test_reactions_from_several_people_are_kept_apart(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    m = await say(http, api, cid, "vote")
    await http.put(react_url(api, m["id"], THUMBS))
    await login(http, api, world.lead_field)
    out = (await http.put(react_url(api, m["id"], THUMBS))).json()
    assert set(out["reactions"][THUMBS]) == {str(world.staff.id), str(world.lead_field.id)}
    out = (await http.delete(react_url(api, m["id"], THUMBS))).json()  # only removes their own
    assert out["reactions"][THUMBS] == [str(world.staff.id)]


async def test_only_the_five_offered_reactions_are_accepted(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    m = await say(http, api, cid, "x")
    assert (await http.put(react_url(api, m["id"], "\U0001f525"))).status_code == 422
    # The heart arrives with or without its variation selector and is stored one way.
    out = (await http.put(react_url(api, m["id"], "❤"))).json()
    assert list(out["reactions"]) == [HEART]


async def test_you_cannot_react_to_a_deleted_message(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    m = await say(http, api, cid, "x")
    await http.delete(f"{api}/chat/messages/{m['id']}")
    assert (await http.put(react_url(api, m["id"], THUMBS))).status_code == 409


# --- pages --------------------------------------------------------------------------------


async def test_paging_back_through_history_has_no_gaps_or_repeats(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    for n in range(1, 8):
        await say(http, api, cid, f"m{n}")

    newest = await page(http, api, cid, limit=3)
    assert [m["seq"] for m in newest["messages"]] == [5, 6, 7] and newest["has_more_before"]

    seen = [m["seq"] for m in newest["messages"]]
    cursor = newest["messages"][0]["seq"]
    while True:
        older = await page(http, api, cid, before=cursor, limit=3)
        seen = [m["seq"] for m in older["messages"]] + seen
        if not older["has_more_before"]:
            break
        cursor = older["messages"][0]["seq"]
    assert seen == list(range(1, 8))


async def test_paging_forward_from_a_point(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    for n in range(1, 6):
        await say(http, api, cid, f"m{n}")

    one = await page(http, api, cid, after=2, limit=2)
    assert [m["seq"] for m in one["messages"]] == [3, 4]
    assert one["has_more_after"] is True and one["has_more_before"] is True
    rest = await page(http, api, cid, after=4, limit=2)
    assert [m["seq"] for m in rest["messages"]] == [5] and rest["has_more_after"] is False


async def test_asking_for_before_and_after_together_is_refused(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    r = await http.get(f"{api}/chat/channels/{cid}/messages", params={"before": 5, "after": 1})
    assert r.status_code == 422


# --- read state ---------------------------------------------------------------------------


def channel_state(body: dict[str, Any], cid: str) -> dict[str, Any]:
    return next(c for c in body["channels"] if c["id"] == cid)


async def test_unread_counts_what_others_posted_beyond_what_you_have_read(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.lead_field)
    await say(http, api, cid, "one")
    await say(http, api, cid, "two")

    await login(http, api, world.staff)
    mine = channel_state(await bootstrap(http, api), cid)
    assert (mine["unread"], mine["last_read_seq"], mine["rev"]) == (2, 0, 2)

    r = await http.post(f"{api}/chat/channels/{cid}/read", json={"seq": 1})
    assert r.json()["last_read_seq"] == 1
    assert channel_state(await bootstrap(http, api), cid)["unread"] == 1


async def test_reading_only_moves_forward_and_never_past_the_newest_message(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.lead_field)
    await say(http, api, cid, "one")
    await say(http, api, cid, "two")
    await login(http, api, world.staff)

    far = await http.post(f"{api}/chat/channels/{cid}/read", json={"seq": 999})
    assert far.json()["last_read_seq"] == 2  # capped at what exists
    back = await http.post(f"{api}/chat/channels/{cid}/read", json={"seq": 0})
    assert back.json()["last_read_seq"] == 2  # never backwards
    assert channel_state(await bootstrap(http, api), cid)["unread"] == 0
    assert (await http.post(f"{api}/chat/channels/{cid}/read", json={"seq": -1})).status_code == 422


async def test_your_own_and_deleted_messages_are_not_unread(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    await say(http, api, cid, "mine")
    assert channel_state(await bootstrap(http, api), cid)["unread"] == 0  # your own, read already

    await login(http, api, world.lead_field)
    gone = await say(http, api, cid, "retracted")
    await http.delete(f"{api}/chat/messages/{gone['id']}")
    await login(http, api, world.staff)
    assert channel_state(await bootstrap(http, api), cid)["unread"] == 0


async def test_your_own_messages_never_count_as_unread_even_if_your_marker_lags(
    world: World, db: AsyncSession, anon_client: AsyncClient, api: str, frozen_clock: FrozenClock
) -> None:
    """Posting normally moves your own read marker past your message, which would hide a
    missing author filter. Here the marker lags — a message of yours sent from another device
    that this one has not read up to — so only the filter keeps it out of the count."""
    http = anon_client
    cid = await room(http, api, world)
    await db.execute(text("UPDATE chat_channels SET rev = 5 WHERE id = :id"), {"id": cid})
    db.add(
        ChatMessage(
            channel_id=uuid.UUID(cid),
            seq=5,
            rev=5,
            author_id=world.staff.id,
            text="from my phone",
            created_at=frozen_clock.now(),
        )  # fmt: skip
    )
    await db.flush()

    await login(http, api, world.staff)
    assert channel_state(await bootstrap(http, api), cid)["unread"] == 0

    await login(http, api, world.lead_field)
    await say(http, api, cid, "an answer")
    await login(http, api, world.staff)
    assert channel_state(await bootstrap(http, api), cid)["unread"] == 1


async def test_unread_mentions_are_counted_separately(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.lead_field)
    await say(http, api, cid, "no mention")
    await say(http, api, cid, f"hey <@{world.staff.member_no}>")

    await login(http, api, world.staff)
    state = channel_state(await bootstrap(http, api), cid)
    assert (state["unread"], state["unread_mentions"]) == (2, 1)
    await http.post(f"{api}/chat/channels/{cid}/read", json={"seq": 2})
    state = channel_state(await bootstrap(http, api), cid)
    assert (state["unread"], state["unread_mentions"]) == (0, 0)


async def test_you_cannot_mark_read_where_you_cannot_see(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.intern)
    assert (await http.post(f"{api}/chat/channels/{cid}/read", json={"seq": 1})).status_code == 404


# --- the revision counter and resuming ----------------------------------------------------


async def test_every_change_takes_the_next_number_from_the_channel(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    m = await say(http, api, cid, "start")  # rev 1
    await http.put(react_url(api, m["id"], THUMBS))  # rev 2
    await http.patch(f"{api}/chat/messages/{m['id']}", json={"text": "changed"})  # rev 3
    second = await say(http, api, cid, "second")  # rev 4

    # seq is the counter at posting time: unique and ordered, but edits and reactions use
    # numbers too, so it is not contiguous. The counter itself (rev) has no gaps.
    assert (second["seq"], second["rev"]) == (4, 4)
    assert channel_state(await bootstrap(http, api), cid)["rev"] == 4
    first = (await page(http, api, cid))["messages"][0]
    assert (first["seq"], first["rev"]) == (1, 3)  # position fixed, revision moved on


async def test_sync_returns_exactly_what_changed_since_the_clients_rev(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.lead_field)
    a = await say(http, api, cid, "a")
    b = await say(http, api, cid, "b")

    await login(http, api, world.staff)
    full = (await http.post(f"{api}/chat/sync", json={"cursors": {cid: 0}})).json()["channels"][0]
    assert [m["text"] for m in full["messages"]] == ["a", "b"] and full["rev"] == 2
    assert full["reset"] is False

    caught_up = (await http.post(f"{api}/chat/sync", json={"cursors": {cid: 2}})).json()
    assert caught_up["channels"][0]["messages"] == []

    # An edit, a reaction and a delete are all changes a reconnecting client must see.
    await login(http, api, world.lead_field)
    await http.patch(f"{api}/chat/messages/{a['id']}", json={"text": "a (edited)"})
    await http.put(react_url(api, b["id"], THUMBS))
    c = await say(http, api, cid, "c")
    await http.delete(f"{api}/chat/messages/{c['id']}")

    await login(http, api, world.staff)
    since = (await http.post(f"{api}/chat/sync", json={"cursors": {cid: 2}})).json()["channels"][0]
    by_text = {m["id"]: m for m in since["messages"]}
    assert set(by_text) == {a["id"], b["id"], c["id"]}
    assert by_text[a["id"]]["text"] == "a (edited)"
    assert by_text[b["id"]]["reactions"] == {THUMBS: [str(world.lead_field.id)]}
    assert by_text[c["id"]]["deleted"] is True
    assert [m["rev"] for m in since["messages"]] == sorted(m["rev"] for m in since["messages"])
    assert since["rev"] == 6


async def test_sync_leaves_out_channels_you_cannot_open_without_comment(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    await say(http, api, cid, "hi")
    await login(http, api, world.intern)
    out = await http.post(f"{api}/chat/sync", json={"cursors": {cid: 0, str(uuid.uuid4()): 0}})
    assert out.status_code == 200 and out.json()["channels"] == []


async def test_sync_asks_for_a_reset_when_too_much_changed(
    world: World, anon_client: AsyncClient, api: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(messages, "SYNC_MAX_PER_CHANNEL", 3)
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    for n in range(4):
        await say(http, api, cid, f"m{n}")
    got = (await http.post(f"{api}/chat/sync", json={"cursors": {cid: 0}})).json()["channels"][0]
    assert got["reset"] is True and got["messages"] == [] and got["rev"] == 4
    near = (await http.post(f"{api}/chat/sync", json={"cursors": {cid: 2}})).json()["channels"][0]
    assert near["reset"] is False and len(near["messages"]) == 2


async def test_a_channel_you_can_see_locked_shows_no_counters(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    await login(http, api, world.pm)
    locked = await make_channel(http, api, project_id=world.a, name="ops", access="invite")
    await login(http, api, world.staff)
    seen = (await bootstrap(http, api))["discoverable"]
    assert [c["id"] for c in seen] == [locked["id"]]
    assert (seen[0]["rev"], seen[0]["unread"]) == (0, 0)
    assert ids((await bootstrap(http, api))["channels"]) == set()


# --- rate limit ---------------------------------------------------------------------------


async def test_a_sender_who_floods_a_channel_is_slowed_down(
    world: World, anon_client: AsyncClient, api: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        messages,
        "send_throttle",
        Throttle("chat-send-test", limit=3, window_seconds=60, block_seconds=60),
    )
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    for n in range(3):
        await say(http, api, cid, f"ok {n}")
    r = await http.post(f"{api}/chat/channels/{cid}/messages", json={"text": "one too many"})
    assert r.status_code == 429
    assert r.json()["retry_after"] > 0

    await login(http, api, world.lead_field)  # someone else is not affected
    await say(http, api, cid, "still fine")
