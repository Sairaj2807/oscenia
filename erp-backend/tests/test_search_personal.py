"""Search over what depends on who is asking: chat messages, tasks, events and file names.

The thing under test is the permission matrix, not the ranking. Every record below carries the
same word, so a search for it returns exactly the records the caller may see and the test can
name them. A hit that should not be there is a leak; a missing one is a bug.
"""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Any

import pytest
from chat_world import World, login, make_channel, world  # noqa: F401
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.ar.models import Project
from app.domain.chat.models import ChatAttachment
from app.domain.events.models import Event, Guest
from app.domain.masters.models import Role, User
from app.domain.workspace.models import TaskAttachment

pytestmark = pytest.mark.phase1

WORD = "zephyrine"
NOW = dt.datetime(2026, 10, 14, 9, 0, tzinfo=dt.UTC)


async def _post(http: AsyncClient, api: str, channel: str, text: str) -> dict[str, Any]:
    r = await http.post(f"{api}/chat/channels/{channel}/messages", json={"text": text})
    assert r.status_code == 201, r.text
    return r.json()


async def _no(db: AsyncSession, project_id: str) -> str:
    return (
        await db.execute(select(Project.project_no).where(Project.id == uuid.UUID(project_id)))
    ).scalar_one()


async def _task(http: AsyncClient, api: str, project: str, who: User, title: str) -> dict[str, Any]:
    r = await http.post(
        f"{api}/tasks",
        json={
            "project_id": project,
            "title": title,
            "assignee_id": str(who.id),
            "deadline": "2030-01-01",
        },
    )
    assert r.status_code == 201, r.text
    return r.json()


@pytest.fixture
async def built(
    world: World,
    db: AsyncSession,
    anon_client: AsyncClient,
    api: str,
) -> dict[str, Any]:
    """One of each thing, in places that different people can and cannot reach."""
    http = await login(anon_client, api, world.pm)
    general = await make_channel(http, api, project_id=world.a, name="general")
    design = await make_channel(http, api, project_id=world.b, name="design")
    plan = await _post(
        http, api, general["id"], f"{WORD} rigging plan, ask <@{world.staff.member_no}> to confirm"
    )
    await _post(http, api, design["id"], f"{WORD} colour board")
    gone = await _post(http, api, general["id"], f"{WORD} deleted line")
    assert (await http.delete(f"{api}/chat/messages/{gone['id']}")).status_code == 200

    # Kept out by name: the block is on the channel, not the person.
    ops = await make_channel(
        http, api, project_id=world.a, name="ops", blocked_ids=[str(world.staff.id)]
    )
    await _post(http, api, ops["id"], f"{WORD} in a channel staff is blocked from")

    # A direct message between two people, neither of them staff.
    dm = (await http.post(f"{api}/chat/dms", json={"user_id": str(world.lead_field.id)})).json()
    await _post(http, api, dm["id"], f"{WORD} private between pm and field leader")

    task_a = await _task(http, api, world.a, world.staff, f"{WORD} task on A")
    task_b = await _task(http, api, world.b, world.intern, f"{WORD} task on B")

    db.add_all(
        [
            ChatAttachment(
                channel_id=uuid.UUID(general["id"]),
                message_id=uuid.UUID(plan["id"]),
                uploader_id=world.pm.id,
                storage_key="k-chat",
                filename=f"{WORD}-run-sheet.pdf",
                content_type="application/pdf",
                size_bytes=10,
                created_at=NOW,
            ),
            TaskAttachment(
                task_id=uuid.UUID(task_a["id"]),
                uploader_id=world.pm.id,
                storage_key="k-task",
                filename=f"{WORD}-brief.pdf",
                kind="pdf",
                content_type="application/pdf",
                size_bytes=10,
                created_at=NOW,
            ),
            Event(
                event_no="EV-9101",
                name=f"{WORD} Gala",
                date=dt.date(2030, 1, 1),
                rsvp_deadline=dt.date(2029, 12, 1),
                created_at=NOW,
                updated_at=NOW,
            ),
        ]
    )
    await db.flush()
    return {"general": general, "design": design, "task_a": task_a, "task_b": task_b}


async def _found(
    http: AsyncClient, api: str, who: User | None = None, q: str = WORD
) -> dict[str, list[dict[str, Any]]]:
    if who is not None:
        await login(http, api, who)
    r = await http.get(f"{api}/search", params={"q": q, "limit": 25})
    assert r.status_code == 200, r.text
    return {g["kind"]: g["hits"] for g in r.json()["groups"]}


def _titles(found: dict[str, list[dict[str, Any]]], kind: str) -> set[str]:
    return {h["title"] for h in found.get(kind, [])}


async def test_a_staff_member_finds_what_their_channels_and_project_hold(
    built: dict[str, Any],
    world: World,
    anon_client: AsyncClient,
    api: str,
) -> None:
    found = await _found(anon_client, api, world.staff)
    # General on A only: not B's channel, not the one they are blocked from, not the PM's DM,
    # and not the deleted line.
    assert _titles(found, "chat_message") == {
        f"{WORD} rigging plan, ask @{world.staff.full_name} to confirm"
    }
    assert _titles(found, "task") == {f"{WORD} task on A"}
    assert _titles(found, "file") == {f"{WORD}-run-sheet.pdf", f"{WORD}-brief.pdf"}
    # Staff see the workspace and chat only; an event is not theirs.
    assert "event" not in found


async def test_a_hit_opens_its_parent_and_never_carries_a_raw_token(
    built: dict[str, Any],
    world: World,
    db: AsyncSession,
    anon_client: AsyncClient,
    api: str,
) -> None:
    found = await _found(anon_client, api, world.staff)
    (message,) = found["chat_message"]
    assert message["ref"] == f"channel:{built['general']['id']}"
    assert "<@" not in message["title"] and "M-" not in message["title"]
    assert message["subtitle"].startswith("#general")
    (task,) = found["task"]
    assert task["ref"] == f"project:{await _no(db, world.a)}"
    refs = {h["ref"] for h in found["file"]}
    assert refs == {f"channel:{built['general']['id']}", f"project:{await _no(db, world.a)}"}
    # The attachment's storage key is never part of a hit.
    assert "k-chat" not in str(found) and "k-task" not in str(found)


async def test_an_intern_sees_only_their_own_task_and_their_own_project_channel(
    built: dict[str, Any],
    world: World,
    anon_client: AsyncClient,
    api: str,
) -> None:
    found = await _found(anon_client, api, world.intern)
    assert _titles(found, "task") == {f"{WORD} task on B"}
    assert _titles(found, "chat_message") == {f"{WORD} colour board"}
    assert "file" not in found  # the only files are on A's task and A's channel


async def test_a_leader_sees_their_division_and_not_the_other_divisions_work(
    built: dict[str, Any],
    world: World,
    anon_client: AsyncClient,
    api: str,
) -> None:
    found = await _found(anon_client, api, world.lead_design)
    assert _titles(found, "task") == {f"{WORD} task on B"}
    assert _titles(found, "chat_message") == {f"{WORD} colour board"}


async def test_the_pm_finds_everything_including_their_own_dm(
    built: dict[str, Any],
    world: World,
    anon_client: AsyncClient,
    api: str,
) -> None:
    found = await _found(anon_client, api, world.pm)
    titles = _titles(found, "chat_message")
    assert f"{WORD} private between pm and field leader" in titles
    assert f"{WORD} colour board" in titles
    assert not any("deleted line" in t for t in titles)
    assert _titles(found, "task") == {f"{WORD} task on A", f"{WORD} task on B"}


async def test_a_dm_is_found_only_by_its_two_people(
    built: dict[str, Any],
    world: World,
    anon_client: AsyncClient,
    api: str,
) -> None:
    private = f"{WORD} private between pm and field leader"
    assert private in _titles(await _found(anon_client, api, world.lead_field), "chat_message")
    for outsider in (world.staff, world.lead_design, world.intern):
        assert private not in _titles(await _found(anon_client, api, outsider), "chat_message")
    dm = [
        h
        for h in (await _found(anon_client, api, world.lead_field))["chat_message"]
        if h["title"] == private
    ]
    assert dm[0]["subtitle"].startswith("Direct message")


async def test_a_blocked_member_does_not_find_the_blocked_channel(
    built: dict[str, Any],
    world: World,
    anon_client: AsyncClient,
    api: str,
) -> None:
    line = f"{WORD} in a channel staff is blocked from"
    assert line not in _titles(await _found(anon_client, api, world.staff), "chat_message")
    assert line in _titles(await _found(anon_client, api, world.lead_field), "chat_message")


async def test_a_login_with_no_workspace_persona_finds_no_chat_or_tasks(
    built: dict[str, Any],
    world: World,
    anon_client: AsyncClient,
    api: str,
) -> None:
    found = await _found(anon_client, api, world.outsider)
    for kind in ("chat_message", "task", "file", "event"):
        assert kind not in found, "finance has no persona and no events module"


async def test_events_are_found_by_roles_with_the_events_module_only(
    built: dict[str, Any],
    world: World,
    client_for: Any,
    api: str,
) -> None:
    for role in (Role.CEO, Role.SALES):
        found = await _found(await client_for(role), api)
        assert _titles(found, "event") == {f"{WORD} Gala"}, role
    # A Team login (staff or intern) has no events module at all.
    assert "event" not in await _found(await client_for(Role.CEO), api, world.staff)


async def test_a_mention_token_alone_does_not_match(
    built: dict[str, Any],
    world: World,
    anon_client: AsyncClient,
    api: str,
) -> None:
    # The stored text holds `<@M-xx>`; a search for the member number must not find the message
    # through the token, because nobody reading it sees one.
    found = await _found(anon_client, api, world.staff, q=str(world.staff.member_no))
    assert "chat_message" not in found


async def test_a_deleted_message_and_its_text_are_gone_from_search(
    built: dict[str, Any],
    world: World,
    anon_client: AsyncClient,
    api: str,
) -> None:
    found = await _found(anon_client, api, world.pm, q="deleted line")
    assert "chat_message" not in found


async def test_the_kind_filter_narrows_to_one_kind(
    built: dict[str, Any],
    world: World,
    anon_client: AsyncClient,
    api: str,
) -> None:
    await login(anon_client, api, world.pm)
    r = await anon_client.get(f"{api}/search", params={"q": WORD, "kinds": "task"})
    assert [g["kind"] for g in r.json()["groups"]] == ["task"]


async def test_guests_are_not_searchable(
    built: dict[str, Any],
    db: AsyncSession,
    client: AsyncClient,
    api: str,
) -> None:
    event = (await db.execute(select(Event).where(Event.event_no == "EV-9101"))).scalar_one()
    db.add(
        Guest(
            event_id=event.id,
            name="Quillon Marchetti",
            phone="+62 811 5550123",
            email="quillon@example.test",
            note="seat near the stage",
            created_at=NOW,
        )
    )
    await db.flush()
    for q in ("Quillon", "5550123", "quillon@example", "near the stage"):
        r = await client.get(f"{api}/search", params={"q": q})
        assert r.status_code == 200
        assert r.json()["total"] == 0, q
