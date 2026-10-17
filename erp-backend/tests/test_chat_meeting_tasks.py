"""Tasks from the minutes: each action item becomes a task, once, by the same rules as by hand.

World: project B is Design + Field. The Design leader hosts a call with the Design intern in B's
channel; the minutes are written, and the leader turns the action items into tasks. What is
checked: only people who read the meeting may, only for someone they may assign, never twice
(even after the minutes are rewritten), and what could not be made says why.
"""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Any

import pytest
from chat_world import World, login, make_channel, world  # noqa: F401
from chat_ws_fakes import FakeWS
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.domain.chat import meetings, service
from app.domain.chat.hub import ChatHub, Connection, set_hub
from app.domain.masters.models import User
from app.domain.workspace.models import WorkspaceTask

# After the demo clock (2026-07-26), so the minutes' own due dates are still ahead.
START = dt.datetime(2026, 7, 27, 9, 0, tzinfo=dt.UTC)
END = START + dt.timedelta(minutes=18)


@pytest.fixture(autouse=True)
def no_ai(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(get_settings(), "ai_provider", "")
    monkeypatch.setattr(get_settings(), "ai_api_key", "")


async def a_call(
    db: AsyncSession,
    channel_id: str,
    host: User,
    others: list[User],
    lines: list[str] | None = None,
) -> uuid.UUID:
    ctx = await service.load_context(db, host)
    said = [
        meetings.NewLine(START + dt.timedelta(minutes=i), (host if i % 2 == 0 else others[0]).id, t)
        for i, t in enumerate(
            lines
            or [
                "Quick agenda: where we are, open issues, and next steps.",
                "We are waiting on the venue for the load-in window, they promised it this week.",
                "Agreed: we lock the load-in window before we book anything else.",
                "I’ll call the venue manager tomorrow morning and get it in writing.",
            ]
        )
    ]
    row = await meetings.create_meeting(
        db, ctx, channel_id=uuid.UUID(channel_id), started_at=START, ended_at=END, video=True,
        participant_ids=[u.id for u in others], lines=said,
    )  # fmt: skip
    await db.flush()
    return row.id


async def minutes(http: AsyncClient, api: str, who: User, mid: uuid.UUID) -> dict[str, Any]:
    await login(http, api, who)
    r = await http.post(f"{api}/chat/meetings/{mid}/summary", json={})
    assert r.status_code == 200, r.text
    return r.json()["meeting"]


async def channel_on(http: AsyncClient, api: str, w: World, project: str | None) -> str:
    await login(http, api, w.pm)
    body = {"name": "general"} if project is None else {"project_id": project, "name": "general"}
    return (await make_channel(http, api, **body))["id"]


async def test_the_action_items_become_tasks_for_the_people_who_own_them_once(
    anon_client: AsyncClient, api: str, world: World, db: AsyncSession
) -> None:
    http = anon_client
    cid = await channel_on(http, api, world, world.b)
    mid = await a_call(db, cid, world.lead_design, [world.intern])
    shown = await minutes(http, api, world.lead_design, mid)
    [item] = shown["summary"]["action_items"]
    assert item["owner_id"] == str(world.intern.id) and item["task_no"] is None

    r = await http.post(f"{api}/chat/meetings/{mid}/tasks")
    assert r.status_code == 200, r.text
    out = r.json()
    assert len(out["created"]) == 1 and out["skipped"] == []
    [again] = out["meeting"]["summary"]["action_items"]
    assert again["task_no"] == out["created"][0]

    task = (await http.get(f"{api}/tasks/{out['created'][0]}")).json()
    assert (
        task["assignee_no"] == world.intern.member_no
        and task["assigned_by_no"] == world.lead_design.member_no
    )
    assert task["title"].startswith("Call the venue manager") and task["status"] == "To do"
    assert task["description"] == "From meeting 2026-07-27." and task["deadline"] == "2026-07-28"

    second = (await http.post(f"{api}/chat/meetings/{mid}/tasks")).json()
    assert second["created"] == [] and second["skipped"] == [], "never twice"
    count = (await db.execute(select(WorkspaceTask))).scalars().all()
    assert len(count) == 1


async def test_rewriting_the_minutes_keeps_the_link_so_an_item_never_becomes_a_second_task(
    anon_client: AsyncClient, api: str, world: World, db: AsyncSession
) -> None:
    http = anon_client
    cid = await channel_on(http, api, world, world.b)
    mid = await a_call(db, cid, world.lead_design, [world.intern])
    await minutes(http, api, world.lead_design, mid)
    first = (await http.post(f"{api}/chat/meetings/{mid}/tasks")).json()["created"]
    rewritten = await minutes(http, api, world.lead_design, mid)  # the host replaces the minutes
    [item] = rewritten["summary"]["action_items"]
    assert item["task_no"] == first[0], "matched by its words: the task comes along"
    assert (await http.post(f"{api}/chat/meetings/{mid}/tasks")).json()["created"] == []


async def test_what_cannot_be_made_is_listed_with_why(
    anon_client: AsyncClient, api: str, world: World, db: AsyncSession
) -> None:
    http = anon_client
    cid = await channel_on(http, api, world, world.b)
    mid = await a_call(db, cid, world.lead_design, [world.intern])
    row = await db.get(meetings.ChatMeeting, mid)
    assert row is not None
    pm, intern, leader = str(world.pm.id), str(world.intern.id), str(world.lead_design.id)
    row.summary = {
        "overview": "o", "agenda": [], "discussion": [], "decisions": [],
        "action_items": [
            {"text": "Has no owner", "owner_id": None, "due": "2026-08-01"},
            {"text": "Has no day", "owner_id": intern, "due": None},
            {"text": "Owned by the PM", "owner_id": pm, "due": "2026-08-01"},
            {"text": "Due already", "owner_id": intern, "due": "2026-07-20"},
            {"text": "Fine " + "x" * 120, "owner_id": intern, "due": "2026-08-01"},
            {"text": "The leader's own", "owner_id": leader, "due": "2026-08-02"},
        ],
    }  # fmt: skip
    row.summary_source, row.summary_at = "seeded", START
    await db.flush()
    await login(http, api, world.lead_design)
    out = (await http.post(f"{api}/chat/meetings/{mid}/tasks")).json()
    why = {s["text"]: s["why"] for s in out["skipped"]}
    assert why["Has no owner"] == "no owner" and why["Has no day"] == "no due date"
    assert "cannot assign" in why["Owned by the PM"]
    assert "past" in why["Due already"]
    assert len(out["created"]) == 2
    made = [(await http.get(f"{api}/tasks/{n}")).json() for n in out["created"]]
    assert {t["title"][:4] for t in made} == {"Fine", "The "} and max(
        len(t["title"]) for t in made
    ) == 80
    stored = {i["text"]: i["task_no"] for i in out["meeting"]["summary"]["action_items"]}
    assert stored["Has no owner"] is None and stored["Due already"] is None
    assert stored["The leader's own"] in out["created"]


async def test_only_people_who_read_the_meeting_may_and_only_with_minutes_on_a_project_channel(
    anon_client: AsyncClient, api: str, world: World, db: AsyncSession
) -> None:
    http = anon_client
    cid = await channel_on(http, api, world, world.b)
    mid = await a_call(db, cid, world.lead_design, [world.intern])
    await login(http, api, world.lead_design)
    assert (await http.post(f"{api}/chat/meetings/{mid}/tasks")).status_code == 409, (
        "no minutes yet"
    )
    await minutes(http, api, world.lead_design, mid)

    await login(http, api, world.lead_field)  # can open the channel, was not on the call
    assert (await http.post(f"{api}/chat/meetings/{mid}/tasks")).status_code == 403
    await login(http, api, world.staff)  # not on project B at all
    assert (await http.post(f"{api}/chat/meetings/{mid}/tasks")).status_code == 404
    await login(http, api, world.pm)  # the PM reads channel calls and may assign the intern
    assert len((await http.post(f"{api}/chat/meetings/{mid}/tasks")).json()["created"]) == 1

    company = await channel_on(http, api, world, None)
    other = await a_call(db, company, world.pm, [world.lead_design])
    await minutes(http, api, world.pm, other)
    r = await http.post(f"{api}/chat/meetings/{other}/tasks")
    assert r.status_code == 422 and "project" in r.text


async def test_two_items_for_someone_not_yet_on_the_project_add_them_once(
    anon_client: AsyncClient, api: str, world: World, db: AsyncSession
) -> None:
    http = anon_client
    cid = await channel_on(http, api, world, world.b)
    mid = await a_call(db, cid, world.lead_field, [world.lead_design])
    row = await db.get(meetings.ChatMeeting, mid)
    assert row is not None
    staff = str(world.staff.id)  # Field staff on A only: tasks on B make them a member of B
    row.summary = {
        "overview": "o", "agenda": [], "discussion": [], "decisions": [],
        "action_items": [
            {"text": "First", "owner_id": staff, "due": "2026-08-01"},
            {"text": "Second", "owner_id": staff, "due": "2026-08-02"},
        ],
    }  # fmt: skip
    row.summary_source, row.summary_at = "seeded", START
    await db.flush()
    await login(http, api, world.lead_field)
    out = (await http.post(f"{api}/chat/meetings/{mid}/tasks")).json()
    assert len(out["created"]) == 2 and out["skipped"] == []


async def test_the_new_tasks_are_announced_to_the_people_who_can_see_them(
    anon_client: AsyncClient, api: str, world: World, db: AsyncSession
) -> None:
    hub = ChatHub()
    set_hub(hub)
    try:
        conn = Connection(user_id=str(world.intern.id), ws=FakeWS(), token_exp=9e12)
        assert hub.register(conn)
        http = anon_client
        cid = await channel_on(http, api, world, world.b)
        mid = await a_call(db, cid, world.lead_design, [world.intern])
        await minutes(http, api, world.lead_design, mid)
        await http.post(f"{api}/chat/meetings/{mid}/tasks")
        import json

        frames = []
        while not conn.queue.empty():
            frames.append(json.loads(conn.queue.get_nowait()))
        created = [f for f in frames if f["type"] == "task.created"]
        assert len(created) == 1 and created[0]["task"]["assignee_no"] == world.intern.member_no
        assert any(f["type"] == "meeting.updated" for f in frames)
    finally:
        set_hub(None)
