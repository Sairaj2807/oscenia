"""Chat backend C1 — channels, direct messages and join requests over real HTTP.

The world: two projects (A: Field + Production, B: Design + Field), a PM, a Field leader
(reaches A and B), a Design leader (reaches B only), a Field staff member on A and a Design
intern on B, plus a finance login with no workspace persona. Everything goes through the HTTP
boundary because that is where the rules have to hold.
"""

from __future__ import annotations

import uuid

import pytest
from chat_world import World, bootstrap, ids, login, make_channel, world  # noqa: F401
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.audit.models import AuditEvent

# --- who is let in at all -----------------------------------------------------------------


async def test_a_login_with_no_workspace_persona_is_turned_away(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = await login(anon_client, api, world.outsider)
    r = await http.get(f"{api}/chat/bootstrap")
    assert r.status_code == 403
    assert "not in the workspace" in r.json()["detail"]


async def test_chat_needs_a_token(world: World, anon_client: AsyncClient, api: str) -> None:
    anon_client.headers.pop("Authorization", None)
    assert (await anon_client.get(f"{api}/chat/bootstrap")).status_code == 401


# --- creating channels --------------------------------------------------------------------


async def test_the_pm_creates_a_channel_and_the_name_is_cleaned(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = await login(anon_client, api, world.pm)
    c = await make_channel(http, api, project_id=world.a, name="Gala Day 1!", topic="  hi  ")
    assert c["name"] == "gala-day-1" and c["topic"] == "hi"
    assert c["access"] == "project" and c["listed"] is True and c["project_no"]
    assert c["can_manage"] is True and c["locked"] is False
    assert c["member_ids"] == [] and c["blocked_ids"] == []


async def test_a_leader_creates_only_on_a_project_their_division_works_on(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = await login(anon_client, api, world.lead_design)
    ok = await http.post(f"{api}/chat/channels", json={"project_id": world.b, "name": "design"})
    assert ok.status_code == 201
    no_a = await http.post(f"{api}/chat/channels", json={"project_id": world.a, "name": "design"})
    assert no_a.status_code == 403  # Design does not work on A
    company = await http.post(f"{api}/chat/channels", json={"name": "everyone"})
    assert company.status_code == 403  # company channels are the PM's


@pytest.mark.parametrize("who", ["staff", "intern"])
async def test_staff_and_interns_cannot_create_channels(
    who: str, world: World, anon_client: AsyncClient, api: str
) -> None:
    http = await login(anon_client, api, getattr(world, who))
    r = await http.post(f"{api}/chat/channels", json={"project_id": world.a, "name": "mine"})
    assert r.status_code == 403


async def test_a_name_is_unique_within_its_server_ignoring_case(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = await login(anon_client, api, world.pm)
    await make_channel(http, api, project_id=world.a, name="Ops")
    dup = await http.post(f"{api}/chat/channels", json={"project_id": world.a, "name": "ops"})
    assert dup.status_code == 409
    # The same name on another project is a different channel.
    assert (
        await http.post(f"{api}/chat/channels", json={"project_id": world.b, "name": "ops"})
    ).status_code == 201


async def test_a_project_with_no_divisions_has_no_channels(
    world: World,
    make_project,
    anon_client: AsyncClient,
    api: str,  # type: ignore[no-untyped-def]
) -> None:
    bare = await make_project("Bare")
    http = await login(anon_client, api, world.pm)
    r = await http.post(f"{api}/chat/channels", json={"project_id": bare, "name": "x"})
    assert r.status_code == 422
    r = await http.post(f"{api}/chat/channels", json={"project_id": str(uuid.uuid4()), "name": "x"})
    assert r.status_code == 422  # not an unhandled foreign-key error


async def test_a_name_with_no_letters_or_digits_is_refused(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = await login(anon_client, api, world.pm)
    r = await http.post(f"{api}/chat/channels", json={"project_id": world.a, "name": "!!!"})
    assert r.status_code == 422


async def test_a_divisions_rule_needs_a_division(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = await login(anon_client, api, world.pm)
    r = await http.post(
        f"{api}/chat/channels",
        json={"project_id": world.a, "name": "prod", "access": "divisions", "divisions": []},
    )
    assert r.status_code == 422
    ok = await make_channel(
        http, api, project_id=world.a, name="prod", access="divisions", divisions=["Production"]
    )
    assert ok["divisions"] == ["Production"]


async def test_whoever_makes_a_channel_invite_only_stays_in_it(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = await login(anon_client, api, world.lead_field)
    c = await make_channel(
        http, api, project_id=world.a, name="leads", access="invite",
        member_ids=[str(world.staff.id)],
    )  # fmt: skip
    assert set(c["member_ids"]) == {str(world.lead_field.id), str(world.staff.id)}


# --- who sees what ------------------------------------------------------------------------


async def test_each_person_sees_only_their_projects_channels(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = await login(anon_client, api, world.pm)
    ga = await make_channel(http, api, project_id=world.a, name="general")
    gb = await make_channel(http, api, project_id=world.b, name="general")
    co = await make_channel(http, api, name="company")

    assert ids((await bootstrap(http, api))["channels"]) == {ga["id"], gb["id"], co["id"]}

    await login(http, api, world.staff)  # on A
    assert ids((await bootstrap(http, api))["channels"]) == {ga["id"], co["id"]}
    await login(http, api, world.intern)  # on B
    assert ids((await bootstrap(http, api))["channels"]) == {gb["id"], co["id"]}
    await login(http, api, world.lead_design)  # Design: B only
    assert ids((await bootstrap(http, api))["channels"]) == {gb["id"], co["id"]}


async def test_a_divisions_channel_is_only_for_those_divisions(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = await login(anon_client, api, world.pm)
    prod = await make_channel(
        http, api, project_id=world.b, name="design-only", access="divisions", divisions=["Design"]
    )
    await login(http, api, world.intern)  # Design, on B
    assert prod["id"] in ids((await bootstrap(http, api))["channels"])
    await login(http, api, world.lead_field)  # Field leader reaches B but is not Design
    assert prod["id"] not in ids((await bootstrap(http, api))["channels"])


async def test_member_and_block_lists_go_only_to_those_who_can_manage(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = await login(anon_client, api, world.pm)
    c = await make_channel(
        http, api, project_id=world.a, name="ops", access="invite",
        member_ids=[str(world.lead_field.id)],
    )  # fmt: skip

    await login(http, api, world.staff)
    seen = (await bootstrap(http, api))["discoverable"]
    assert [x["id"] for x in seen] == [c["id"]]
    assert seen[0]["locked"] is True
    assert seen[0]["member_ids"] is None and seen[0]["blocked_ids"] is None

    await login(http, api, world.lead_field)  # a leader on A can manage
    mine = next(x for x in (await bootstrap(http, api))["channels"] if x["id"] == c["id"])
    assert mine["member_ids"] is not None


async def test_an_unlisted_channel_is_not_even_shown_locked(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = await login(anon_client, api, world.pm)
    await make_channel(http, api, project_id=world.a, name="secret", access="invite", listed=False)
    await login(http, api, world.staff)
    body = await bootstrap(http, api)
    assert body["discoverable"] == [] and body["channels"] == []


async def test_the_company_invite_only_channel_is_hidden_by_default(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = await login(anon_client, api, world.pm)
    c = await make_channel(http, api, name="leaders", access="invite")
    assert c["listed"] is False
    await login(http, api, world.staff)
    assert (await bootstrap(http, api))["discoverable"] == []


# --- changing a channel -------------------------------------------------------------------


async def test_the_pm_changes_a_channels_name_topic_and_rule(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = await login(anon_client, api, world.pm)
    c = await make_channel(http, api, project_id=world.a, name="ops")
    r = await http.patch(
        f"{api}/chat/channels/{c['id']}",
        json={
            "name": "Ops Room",
            "topic": "rigging",
            "access": "divisions",
            "divisions": ["Field"],
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["name"], body["topic"], body["access"], body["divisions"]) == (
        "ops-room",
        "rigging",
        "divisions",
        ["Field"],
    )


async def test_someone_who_can_see_a_channel_but_not_manage_it_gets_403(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = await login(anon_client, api, world.pm)
    c = await make_channel(http, api, project_id=world.a, name="ops")
    await login(http, api, world.staff)
    r = await http.patch(f"{api}/chat/channels/{c['id']}", json={"topic": "mine now"})
    assert r.status_code == 403


async def test_a_channel_the_caller_cannot_see_is_a_404_not_a_403(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    """403 would confirm the channel exists."""
    http = await login(anon_client, api, world.pm)
    secret = await make_channel(http, api, project_id=world.a, name="secret", access="invite")
    await login(http, api, world.intern)  # not even on project A
    assert (
        await http.patch(f"{api}/chat/channels/{secret['id']}", json={"topic": "x"})
    ).status_code == 404
    assert (
        await http.patch(f"{api}/chat/channels/{uuid.uuid4()}", json={"topic": "x"})
    ).status_code == 404


async def test_renaming_into_a_taken_name_is_a_conflict(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = await login(anon_client, api, world.pm)
    await make_channel(http, api, project_id=world.a, name="one")
    two = await make_channel(http, api, project_id=world.a, name="two")
    r = await http.patch(f"{api}/chat/channels/{two['id']}", json={"name": "ONE"})
    assert r.status_code == 409
    # Keeping its own name is not a clash with itself.
    assert (
        await http.patch(f"{api}/chat/channels/{two['id']}", json={"name": "two"})
    ).status_code == 200


async def test_a_block_keeps_someone_out_and_the_pm_cannot_be_blocked(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = await login(anon_client, api, world.lead_field)
    c = await make_channel(http, api, project_id=world.a, name="ops")
    r = await http.patch(
        f"{api}/chat/channels/{c['id']}",
        json={"blocked_ids": [str(world.staff.id), str(world.pm.id)]},
    )
    assert r.status_code == 200
    assert r.json()["blocked_ids"] == [str(world.staff.id)]  # the PM was ignored

    await login(http, api, world.staff)
    assert c["id"] not in ids((await bootstrap(http, api))["channels"])
    await login(http, api, world.pm)
    assert c["id"] in ids((await bootstrap(http, api))["channels"])


async def test_an_edit_cannot_lift_a_block_on_the_person_making_it(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = await login(anon_client, api, world.pm)
    c = await make_channel(http, api, project_id=world.a, name="ops")
    lead = str(world.lead_field.id)
    # The PM blocks the Field leader; the leader (still a manager on A) tries to lift it.
    await http.patch(f"{api}/chat/channels/{c['id']}", json={"blocked_ids": [lead]})
    await login(http, api, world.lead_field)
    # Blocked means no say over the channel either, so the edit is refused outright.
    r = await http.patch(f"{api}/chat/channels/{c['id']}", json={"blocked_ids": []})
    assert r.status_code == 404  # blocked: cannot open it, cannot manage it


async def test_creating_and_changing_channels_leaves_an_audit_trail(
    world: World, db: AsyncSession, anon_client: AsyncClient, api: str
) -> None:
    http = await login(anon_client, api, world.pm)
    c = await make_channel(http, api, project_id=world.a, name="audited")
    await http.patch(f"{api}/chat/channels/{c['id']}", json={"topic": "changed"})
    actions = (
        (await db.execute(select(AuditEvent.action).where(AuditEvent.entity_id == c["id"])))
        .scalars()
        .all()
    )
    assert {"chat.channel.create", "chat.channel.update"} <= set(actions)


# --- direct messages ----------------------------------------------------------------------


async def test_a_dm_is_made_once_and_both_people_get_the_same_one(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = await login(anon_client, api, world.staff)
    first = await http.post(f"{api}/chat/dms", json={"user_id": str(world.intern.id)})
    again = await http.post(f"{api}/chat/dms", json={"user_id": str(world.intern.id)})
    assert (first.status_code, again.status_code) == (201, 200)
    assert first.json()["id"] == again.json()["id"]
    assert first.json()["is_dm"] is True and first.json()["dm_with"] == str(world.intern.id)

    await login(http, api, world.intern)  # the other side asks
    other = await http.post(f"{api}/chat/dms", json={"user_id": str(world.staff.id)})
    assert other.status_code == 200 and other.json()["id"] == first.json()["id"]
    assert other.json()["dm_with"] == str(world.staff.id)


async def test_nobody_else_sees_a_dm_not_even_the_pm(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = await login(anon_client, api, world.staff)
    dm = (await http.post(f"{api}/chat/dms", json={"user_id": str(world.intern.id)})).json()

    for person in (world.pm, world.lead_field, world.lead_design):
        await login(http, api, person)
        body = await bootstrap(http, api)
        assert dm["id"] not in ids(body["channels"]) | ids(body["discoverable"])
        # Even asking for it by id says nothing that confirms it exists.
        assert (
            await http.patch(f"{api}/chat/channels/{dm['id']}", json={"topic": "x"})
        ).status_code == 404

    await login(http, api, world.staff)
    assert dm["id"] in ids((await bootstrap(http, api))["channels"])
    # A member of the DM can see it but not manage it.
    assert (
        await http.patch(f"{api}/chat/channels/{dm['id']}", json={"topic": "x"})
    ).status_code == 403


async def test_you_cannot_dm_yourself_or_a_stranger(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = await login(anon_client, api, world.staff)
    assert (
        await http.post(f"{api}/chat/dms", json={"user_id": str(world.staff.id)})
    ).status_code == 422
    assert (
        await http.post(f"{api}/chat/dms", json={"user_id": str(uuid.uuid4())})
    ).status_code == 404
    # Someone with no workspace persona is not a team member to message.
    assert (
        await http.post(f"{api}/chat/dms", json={"user_id": str(world.outsider.id)})
    ).status_code == 404


# --- join requests ------------------------------------------------------------------------


async def _locked_channel(http: AsyncClient, api: str, world: World, name: str = "ops") -> str:
    await login(http, api, world.pm)
    return (await make_channel(http, api, project_id=world.a, name=name, access="invite"))["id"]


async def test_a_join_request_is_answered_and_lets_the_person_in(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await _locked_channel(http, api, world)

    await login(http, api, world.staff)
    asked = await http.post(f"{api}/chat/channels/{cid}/join-requests", json={"note": "need it"})
    assert asked.status_code == 201, asked.text
    req = asked.json()
    assert req["status"] == "pending" and req["note"] == "need it" and req["member_no"]
    assert (await bootstrap(http, api))["discoverable"][0]["my_request"] == "pending"
    again = await http.post(f"{api}/chat/channels/{cid}/join-requests", json={})
    assert again.status_code == 409  # one open request at a time

    await login(http, api, world.lead_field)  # a leader on A decides
    pending = (await http.get(f"{api}/chat/channels/{cid}/join-requests")).json()
    assert [p["id"] for p in pending] == [req["id"]]
    done = await http.post(f"{api}/chat/join-requests/{req['id']}/decide", json={"approve": True})
    assert done.status_code == 200 and done.json()["status"] == "approved"
    assert done.json()["decided_by"] == str(world.lead_field.id)
    assert (
        await http.post(f"{api}/chat/join-requests/{req['id']}/decide", json={"approve": False})
    ).status_code == 409  # already answered

    await login(http, api, world.staff)
    body = await bootstrap(http, api)
    assert cid in ids(body["channels"]) and body["discoverable"] == []


async def test_a_declined_request_can_be_made_again(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await _locked_channel(http, api, world)
    await login(http, api, world.staff)
    first = (await http.post(f"{api}/chat/channels/{cid}/join-requests", json={})).json()

    await login(http, api, world.pm)
    declined = await http.post(
        f"{api}/chat/join-requests/{first['id']}/decide", json={"approve": False}
    )
    assert declined.json()["status"] == "declined"

    await login(http, api, world.staff)
    assert (await bootstrap(http, api))["discoverable"][0]["my_request"] == "declined"
    second = await http.post(f"{api}/chat/channels/{cid}/join-requests", json={})
    assert second.status_code == 201 and second.json()["id"] != first["id"]


async def test_you_cannot_ask_into_a_channel_you_cannot_see_locked(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await _locked_channel(http, api, world)
    await login(http, api, world.intern)  # not on project A
    r = await http.post(f"{api}/chat/channels/{cid}/join-requests", json={})
    assert r.status_code == 404

    await login(http, api, world.pm)
    hidden = (
        await make_channel(
            http, api, project_id=world.a, name="hidden", access="invite", listed=False
        )
    )["id"]
    await login(http, api, world.staff)
    assert (
        await http.post(f"{api}/chat/channels/{hidden}/join-requests", json={})
    ).status_code == 404


async def test_only_someone_who_can_manage_a_channel_reads_its_requests(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await _locked_channel(http, api, world)
    await login(http, api, world.staff)
    await http.post(f"{api}/chat/channels/{cid}/join-requests", json={})

    # Locked out of the channel, so it does not even exist as far as they can tell.
    assert (await http.get(f"{api}/chat/channels/{cid}/join-requests")).status_code == 404
    await login(http, api, world.lead_design)  # Design: not on A at all
    assert (await http.get(f"{api}/chat/channels/{cid}/join-requests")).status_code == 404


async def test_nobody_decides_their_own_request(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await _locked_channel(http, api, world)
    # A Field leader reaches A, so can manage it — but is not let into an invite-only one.
    await login(http, api, world.lead_field)
    own = (await http.post(f"{api}/chat/channels/{cid}/join-requests", json={})).json()
    r = await http.post(f"{api}/chat/join-requests/{own['id']}/decide", json={"approve": True})
    assert r.status_code == 422

    await login(http, api, world.pm)  # someone else can
    ok = await http.post(f"{api}/chat/join-requests/{own['id']}/decide", json={"approve": True})
    assert ok.status_code == 200


async def test_approving_a_request_lifts_a_block(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await _locked_channel(http, api, world)
    await login(http, api, world.staff)
    req = (await http.post(f"{api}/chat/channels/{cid}/join-requests", json={})).json()

    await login(http, api, world.pm)  # blocked after asking
    await http.patch(f"{api}/chat/channels/{cid}", json={"blocked_ids": [str(world.staff.id)]})
    await http.post(f"{api}/chat/join-requests/{req['id']}/decide", json={"approve": True})
    chan = next(c for c in (await bootstrap(http, api))["channels"] if c["id"] == cid)
    assert str(world.staff.id) not in chan["blocked_ids"]
    assert str(world.staff.id) in chan["member_ids"]


async def test_deciding_a_request_is_audited(
    world: World, db: AsyncSession, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await _locked_channel(http, api, world)
    await login(http, api, world.staff)
    req = (await http.post(f"{api}/chat/channels/{cid}/join-requests", json={})).json()
    await login(http, api, world.pm)
    await http.post(f"{api}/chat/join-requests/{req['id']}/decide", json={"approve": True})
    actions = (
        (await db.execute(select(AuditEvent.action).where(AuditEvent.entity_id == cid)))
        .scalars()
        .all()
    )
    assert {"chat.join_request.create", "chat.join_request.decide"} <= set(actions)


# --- who is in the workspace --------------------------------------------------------------


async def test_the_pm_puts_a_login_in_the_workspace(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = await login(anon_client, api, world.pm)
    r = await http.patch(
        f"{api}/chat/users/{world.outsider.id}/workspace",
        json={"workspace_role": "staff", "division": "Field", "title": "Rigger"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["member_no"].startswith("M-") and body["title"] == "Rigger"

    await login(http, api, world.outsider)  # finance + a persona: now in
    assert (await http.get(f"{api}/chat/bootstrap")).status_code == 200


async def test_a_leader_without_a_division_is_refused(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = await login(anon_client, api, world.pm)
    r = await http.patch(
        f"{api}/chat/users/{world.outsider.id}/workspace", json={"workspace_role": "leader"}
    )
    assert r.status_code == 422


async def test_leaving_the_workspace_keeps_the_member_number_and_ends_chat(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = await login(anon_client, api, world.pm)
    before = (
        await http.patch(
            f"{api}/chat/users/{world.staff.id}/workspace",
            json={"workspace_role": "staff", "division": "Field"},
        )
    ).json()["member_no"]
    left = await http.patch(
        f"{api}/chat/users/{world.staff.id}/workspace", json={"workspace_role": None}
    )
    assert left.json()["member_no"] == before and left.json()["workspace_role"] is None

    await login(http, api, world.staff)
    assert (await http.get(f"{api}/chat/bootstrap")).status_code == 403


async def test_only_the_ceo_and_pm_manage_the_workspace(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    for person in (world.lead_field, world.staff, world.outsider):
        http = await login(anon_client, api, person)
        r = await http.patch(
            f"{api}/chat/users/{world.staff.id}/workspace", json={"workspace_role": "intern"}
        )
        assert r.status_code == 403, person.email


async def test_project_members_are_staff_and_interns_only(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = await login(anon_client, api, world.pm)
    bad = await http.put(
        f"{api}/chat/projects/{world.a}/members", json={"user_ids": [str(world.lead_field.id)]}
    )
    assert bad.status_code == 422  # leaders follow their division
    ghost = await http.put(
        f"{api}/chat/projects/{world.a}/members", json={"user_ids": [str(uuid.uuid4())]}
    )
    assert ghost.status_code == 404

    ok = await http.put(
        f"{api}/chat/projects/{world.a}/members",
        json={"user_ids": [str(world.staff.id), str(world.intern.id)]},
    )
    assert ok.status_code == 200 and len(ok.json()["user_ids"]) == 2
    await login(http, api, world.intern)
    projects = (await bootstrap(http, api))["projects"]
    assert {p["id"] for p in projects} == {world.a, world.b}


async def test_changing_a_projects_divisions_changes_what_a_leader_reaches(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = await login(anon_client, api, world.pm)
    bad = await http.put(f"{api}/chat/projects/{world.a}/divisions", json={"divisions": ["Bogus"]})
    assert bad.status_code == 422
    ok = await http.put(f"{api}/chat/projects/{world.a}/divisions", json={"divisions": ["Design"]})
    assert ok.status_code == 200 and ok.json()["divisions"] == ["Design"]

    await login(http, api, world.lead_field)  # Field no longer works on A
    assert {p["id"] for p in (await bootstrap(http, api))["projects"]} == {world.b}
    await login(http, api, world.lead_design)  # Design now reaches A too
    assert {p["id"] for p in (await bootstrap(http, api))["projects"]} == {world.a, world.b}


async def test_everyone_in_the_workspace_is_listed_with_their_member_number(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = await login(anon_client, api, world.staff)
    body = await bootstrap(http, api)
    assert body["me"]["id"] == str(world.staff.id)
    everyone = (world.pm, world.lead_field, world.lead_design, world.staff, world.intern)
    assert {m["id"] for m in body["members"]} == {str(u.id) for u in everyone}
    assert all(m["member_no"].startswith("M-") for m in body["members"])
    assert {p["id"] for p in body["projects"]} == {world.a}
