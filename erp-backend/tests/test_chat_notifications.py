"""Chat backend C4 — the notification list: mentions, join requests and their answers.

The list is worked out from the data on every read (as the prototype does), so these tests
mostly check that it agrees with what the data says *now*: a deleted message, a blocked reader
or a decided request changes the answer without anyone clearing anything.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from chat_world import World, login, make_channel, world  # noqa: F401
from httpx import AsyncClient

from app.core.clock import FrozenClock


async def room(http: AsyncClient, api: str, w: World, name: str = "general") -> str:
    await login(http, api, w.pm)
    return (await make_channel(http, api, project_id=w.a, name=name))["id"]


async def say(http: AsyncClient, api: str, cid: str, text: str) -> dict[str, Any]:
    r = await http.post(f"{api}/chat/channels/{cid}/messages", json={"text": text})
    assert r.status_code == 201, r.text
    return r.json()


async def notes(http: AsyncClient, api: str, **params: Any) -> dict[str, Any]:
    r = await http.get(f"{api}/chat/notifications", params=params)
    assert r.status_code == 200, r.text
    return r.json()


def mention(user: Any) -> str:
    return f"<@{user.member_no}>"


# --- mentions -----------------------------------------------------------------------------


async def test_a_mention_notifies_the_person_mentioned_and_nobody_else(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.lead_field)
    m = await say(http, api, cid, f"hey {mention(world.staff)} see <#T-102>")

    await login(http, api, world.staff)
    got = await notes(http, api)
    assert len(got["items"]) == 1
    item = got["items"][0]
    assert item["id"] == f"mention:{m['id']}" and item["kind"] == "Mentioned you"
    assert item["title"] == f"{world.lead_field.full_name} in #general"
    assert item["body"] == f"hey @{world.staff.full_name} see #T-102"  # tokens made readable
    assert item["to"] == f"/chat/{cid}" and item["read"] is False
    assert got["unread_mentions"] == 1

    for person in (world.lead_field, world.pm):  # the author, and a bystander
        await login(http, api, person)
        assert (await notes(http, api))["items"] == []


async def test_reading_the_channel_clears_the_mention_and_a_later_one_rings_again(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.lead_field)
    await say(http, api, cid, f"first {mention(world.staff)}")

    await login(http, api, world.staff)
    assert (await notes(http, api))["unread_mentions"] == 1
    await http.post(f"{api}/chat/channels/{cid}/read", json={"seq": 1})
    after = await notes(http, api)
    assert after["unread_mentions"] == 0 and after["items"][0]["read"] is True  # still listed

    await login(http, api, world.lead_field)
    await say(http, api, cid, f"second {mention(world.staff)}")
    await login(http, api, world.staff)
    again = await notes(http, api)
    assert again["unread_mentions"] == 1
    assert [i["read"] for i in again["items"]] == [False, True]  # newest first


async def test_a_mention_in_a_dm_says_so_and_names_no_channel(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = await login(anon_client, api, world.staff)
    dm = (await http.post(f"{api}/chat/dms", json={"user_id": str(world.intern.id)})).json()["id"]
    await say(http, api, dm, f"ping {mention(world.intern)}")
    await login(http, api, world.intern)
    item = (await notes(http, api))["items"][0]
    assert item["title"] == f"{world.staff.full_name} in a direct message"
    assert item["to"] == f"/chat/{dm}"


async def test_a_long_message_is_cut_for_the_bell(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.lead_field)
    await say(http, api, cid, f"{mention(world.staff)} " + "word " * 100)
    await login(http, api, world.staff)
    body = (await notes(http, api))["items"][0]["body"]
    assert len(body) == 140 and body.endswith("…")


async def test_deleting_the_message_takes_its_mention_with_it(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.lead_field)
    m = await say(http, api, cid, f"oops {mention(world.staff)}")
    await login(http, api, world.staff)
    assert len((await notes(http, api))["items"]) == 1
    await login(http, api, world.lead_field)
    await http.delete(f"{api}/chat/messages/{m['id']}")
    await login(http, api, world.staff)
    assert (await notes(http, api))["items"] == []


async def test_a_mention_in_a_channel_you_can_no_longer_open_is_hidden(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.lead_field)
    await say(http, api, cid, f"for you {mention(world.staff)} and {mention(world.intern)}")

    await login(http, api, world.intern)  # mentioned, but not on project A: nothing to open
    assert (await notes(http, api))["items"] == []

    await login(http, api, world.staff)
    assert len((await notes(http, api))["items"]) == 1
    await login(http, api, world.pm)
    await http.patch(f"{api}/chat/channels/{cid}", json={"blocked_ids": [str(world.staff.id)]})
    await login(http, api, world.staff)
    assert (await notes(http, api))["items"] == []  # blocked: the channel is gone, so is this


# --- join requests ------------------------------------------------------------------------


async def locked_room(http: AsyncClient, api: str, w: World) -> str:
    await login(http, api, w.pm)
    return (await make_channel(http, api, project_id=w.a, name="ops", access="invite"))["id"]


async def test_a_join_request_is_an_action_for_those_who_can_decide_and_stays_until_decided(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await locked_room(http, api, world)
    await login(http, api, world.staff)
    r = await http.post(f"{api}/chat/channels/{cid}/join-requests", json={"note": "need the plan"})
    rid = r.json()["id"]

    for person in (world.pm, world.lead_field):  # whoever can decide
        await login(http, api, person)
        item = (await notes(http, api))["items"][0]
        assert item["id"] == f"join:{rid}" and item["kind"] == "Wants to join"
        assert item["title"] == f"{world.staff.full_name} wants to join #ops"
        assert item["body"] == "need the plan"
        assert item["to"] == f"/chat/{cid}?settings={cid}"
        assert item["read"] is None  # an action to take, not something to glance at
    for person in (world.staff, world.lead_design, world.intern):
        await login(http, api, person)
        assert (await notes(http, api))["items"] == [], person.email

    await login(http, api, world.lead_field)
    await http.post(f"{api}/chat/join-requests/{rid}/decide", json={"approve": True})
    assert (await notes(http, api))["items"] == []  # decided: gone for the deciders
    await login(http, api, world.pm)
    assert (await notes(http, api))["items"] == []


async def test_the_person_who_asked_is_told_the_answer(
    world: World, anon_client: AsyncClient, api: str, frozen_clock: FrozenClock
) -> None:
    http = anon_client
    cid = await locked_room(http, api, world)
    await login(http, api, world.staff)
    rid = (await http.post(f"{api}/chat/channels/{cid}/join-requests", json={})).json()["id"]
    await login(http, api, world.lead_field)
    await http.post(f"{api}/chat/join-requests/{rid}/decide", json={"approve": True})

    await login(http, api, world.staff)
    item = (await notes(http, api))["items"][0]
    assert item["kind"] == "Added to channel" and item["title"] == "You were added to #ops"
    assert item["body"] == f"by {world.lead_field.full_name}" and item["read"] is None
    assert item["to"] == f"/chat/{cid}"

    # An answer is news for a month, not forever.
    frozen_clock.advance(timedelta(days=31))
    assert (await notes(http, api))["items"] == []


async def test_a_declined_request_says_so(world: World, anon_client: AsyncClient, api: str) -> None:
    http = anon_client
    cid = await locked_room(http, api, world)
    await login(http, api, world.staff)
    rid = (await http.post(f"{api}/chat/channels/{cid}/join-requests", json={})).json()["id"]
    await login(http, api, world.pm)
    await http.post(f"{api}/chat/join-requests/{rid}/decide", json={"approve": False})
    await login(http, api, world.staff)
    item = (await notes(http, api))["items"][0]
    assert item["kind"] == "Request declined"
    assert item["title"] == "Your request to join #ops was declined"


async def test_a_request_from_someone_since_blocked_is_not_put_in_front_of_the_deciders(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await locked_room(http, api, world)
    await login(http, api, world.staff)
    await http.post(f"{api}/chat/channels/{cid}/join-requests", json={})
    await login(http, api, world.pm)
    assert len((await notes(http, api))["items"]) == 1
    await http.patch(f"{api}/chat/channels/{cid}", json={"blocked_ids": [str(world.staff.id)]})
    assert (await notes(http, api))["items"] == []


# --- the list as a whole ------------------------------------------------------------------


async def test_things_to_act_on_come_first_then_newest_first_and_a_limit_applies(
    world: World, anon_client: AsyncClient, api: str, frozen_clock: FrozenClock
) -> None:
    http = anon_client
    ops = await locked_room(http, api, world)
    general = await room(http, api, world, name="general")
    await login(http, api, world.staff)
    await http.post(f"{api}/chat/channels/{ops}/join-requests", json={"note": "first, and oldest"})

    # A request is stamped by the database's own clock; messages by the injected one. Move the
    # latter well past now so the mentions really are newer than the request — otherwise it
    # would head the list on age alone and the "act on it first" rule would go untested.
    frozen_clock.advance(timedelta(days=400))
    await login(http, api, world.lead_field)  # three mentions of the PM, all newer
    for n in range(3):
        await say(http, api, general, f"{n} {mention(world.pm)}")

    await login(http, api, world.pm)
    kinds = [i["kind"] for i in (await notes(http, api))["items"]]
    assert kinds == ["Wants to join", "Mentioned you", "Mentioned you", "Mentioned you"]
    bodies = [i["body"] for i in (await notes(http, api))["items"] if i["kind"] == "Mentioned you"]
    assert [b[0] for b in bodies] == ["2", "1", "0"]  # newest first

    two = await notes(http, api, limit=2)
    assert [i["kind"] for i in two["items"]] == ["Wants to join", "Mentioned you"]
    assert (await http.get(f"{api}/chat/notifications", params={"limit": 0})).status_code == 422
    assert (await http.get(f"{api}/chat/notifications", params={"limit": 101})).status_code == 422


async def test_notifications_need_a_workspace_persona(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = await login(anon_client, api, world.outsider)
    assert (await http.get(f"{api}/chat/notifications")).status_code == 403
    anon_client.headers.pop("Authorization", None)
    assert (await anon_client.get(f"{api}/chat/notifications")).status_code == 401
