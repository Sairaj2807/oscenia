"""Workspace backend T4 — live task events and the task items in the bell.

Events: connected people who can *see* a task hear about it after the commit, each given the task
as they see it (``my_stage`` differs); a refused change tells nobody; someone taken off a project
stops hearing. The bell: worked out from the data on every read — what needs your approval, was
given to you, sent back, signed off, blocked — for the tasks you may see, with the prototype's own
numbers holding on its demo data.
"""

from __future__ import annotations

import datetime as dt
import json
import uuid
from typing import Any

import pytest
from chat_world import World, login, world  # noqa: F401
from chat_ws_fakes import FakeWS
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from test_chat_seed import _seed as seed_chat_demo

from app.core.clock import FrozenClock
from app.domain.chat import workspace
from app.domain.chat.hub import ChatHub, Connection, set_hub
from app.domain.masters.models import User
from app.seed.chart import DEMO_PASSWORD
from app.seed.tasks import seed_tasks

D = "2026-08-30"


class Wire:
    """Connected people, as the hub holds them: each one's queue is what they would be sent."""

    def __init__(self) -> None:
        self.hub = ChatHub()
        self.conns: dict[str, Connection] = {}

    def connect(self, *users: User) -> None:
        for user in users:
            conn = Connection(user_id=str(user.id), ws=FakeWS(), token_exp=9e12)
            assert self.hub.register(conn)
            self.conns[user.email] = conn

    def heard(self, user: User) -> list[dict[str, Any]]:
        queue = self.conns[user.email].queue
        out = []
        while not queue.empty():
            out.append(json.loads(queue.get_nowait()))
        # (Connecting also broadcasts presence; only the task-related frames matter here.)
        return [
            f
            for f in out
            if f["type"].startswith("task.")
            or f["type"] in ("notifications.refresh", "bootstrap.invalidate")
        ]


@pytest.fixture
def wire() -> Any:
    w = Wire()
    set_hub(w.hub)
    yield w
    set_hub(None)


async def make(
    http: AsyncClient, api: str, who: User, assignee: User, project: str, **kw: Any
) -> dict[str, Any]:
    await login(http, api, who)
    body = {
        "project_id": project,
        "title": "Check the rigging",
        "assignee_id": str(assignee.id),
        "deadline": D,
        **kw,
    }
    r = await http.post(f"{api}/tasks", json=body)
    assert r.status_code == 201, r.text
    return r.json()


async def do(
    http: AsyncClient, api: str, who: User, task: dict[str, Any], action: str, **body: Any
) -> Any:
    await login(http, api, who)
    return await http.post(f"{api}/tasks/{task['id']}/{action}", json=body or None)


def kinds(frames: list[dict[str, Any]]) -> list[str]:
    return [f["type"] for f in frames]


# --- live events ----------------------------------------------------------------------------


async def test_everyone_who_can_see_a_new_task_hears_it_and_nobody_else(
    anon_client: AsyncClient, api: str, world: World, wire: Wire
) -> None:
    wire.connect(world.pm, world.staff, world.lead_field, world.intern, world.lead_design)
    t = await make(anon_client, api, world.pm, world.staff, world.a)  # a Field task on project A
    for who in (world.pm, world.staff, world.lead_field):
        frames = wire.heard(who)
        assert kinds(frames) == ["task.created", "notifications.refresh"], who.email
        assert (
            frames[0]["task"]["task_no"] == t["task_no"] and frames[0]["task"]["status"] == "To do"
        )
    assert wire.heard(world.intern) == [], "Design intern on project B only"
    assert wire.heard(world.lead_design) == [], "not a Field task, not on A"


async def test_each_person_is_given_the_task_as_they_see_it(
    anon_client: AsyncClient, api: str, world: World, wire: Wire
) -> None:
    http = anon_client
    t = await make(http, api, world.pm, world.staff, world.a)
    for who, action in [(world.staff, "start"), (world.staff, "submit")]:
        assert (await do(http, api, who, t, action)).status_code == 200
    wire.connect(world.pm, world.staff, world.lead_field)

    assert (await do(http, api, world.lead_field, t, "approve")).status_code == 200  # stage 1
    mine = {
        u.email: next(f for f in wire.heard(u) if f["type"] == "task.updated")["task"]
        for u in (world.pm, world.staff, world.lead_field)
    }
    assert {k: v["status"] for k, v in mine.items()} == {
        u.email: "Leader approved" for u in (world.pm, world.staff, world.lead_field)
    }
    assert mine[world.pm.email]["my_stage"] == "pm", "the PM now holds the final approval"
    assert mine[world.staff.email]["my_stage"] is None
    assert mine[world.lead_field.email]["my_stage"] is None, (
        "stage 1 is given: nothing left for the leader"
    )


async def test_a_refused_change_tells_nobody(
    anon_client: AsyncClient, api: str, world: World, wire: Wire
) -> None:
    http = anon_client
    t = await make(http, api, world.pm, world.staff, world.a)
    wire.connect(world.pm, world.staff, world.lead_field)
    for who in (world.pm, world.staff, world.lead_field):
        wire.heard(who)  # (their own connection saw the creation)
    refused = await do(http, api, world.pm, t, "submit")  # only the assignee submits
    assert refused.status_code == 403
    assert (await do(http, api, world.staff, t, "approve")).status_code == 403
    for who in (world.pm, world.staff, world.lead_field):
        assert wire.heard(who) == [], who.email


async def test_someone_taken_off_the_project_stops_hearing(
    anon_client: AsyncClient, api: str, world: World, wire: Wire, db: AsyncSession
) -> None:
    http = anon_client
    t = await make(http, api, world.pm, world.staff, world.a)
    wire.connect(world.staff)
    assert (await do(http, api, world.staff, t, "start")).status_code == 200
    assert "task.updated" in kinds(wire.heard(world.staff))

    await workspace.set_project_members(db, uuid.UUID(world.a), [], actor=world.pm)
    assert (await do(http, api, world.pm, t, "block", reason="venue")).status_code == 200
    assert wire.heard(world.staff) == [], "no subscribe step to go stale: the next event skips them"


async def test_a_task_that_adds_someone_to_a_project_tells_everyone_to_read_the_workspace_again(
    anon_client: AsyncClient, api: str, world: World, wire: Wire
) -> None:
    wire.connect(world.pm, world.staff, world.intern)
    await make(anon_client, api, world.lead_field, world.staff, world.b)  # staff joins project B
    assert "bootstrap.invalidate" in kinds(wire.heard(world.intern))
    # And one that adds nobody does not.
    await make(anon_client, api, world.pm, world.staff, world.a)
    assert "bootstrap.invalidate" not in kinds(wire.heard(world.intern))


async def test_files_announce_the_task_too(
    anon_client: AsyncClient, api: str, world: World, wire: Wire, tmp_path: Any
) -> None:
    from app.core.storage import LocalDiskStorage, set_storage

    set_storage(LocalDiskStorage(tmp_path))
    try:
        t = await make(anon_client, api, world.pm, world.staff, world.a)
        wire.connect(world.staff, world.lead_field)
        await login(anon_client, api, world.staff)
        r = await anon_client.post(
            f"{api}/tasks/{t['id']}/attachments",
            files={"file": ("a.pdf", b"%PDF-1.4\n%%EOF\n", "application/pdf")},
        )
        assert r.status_code == 201, r.text
        frame = next(f for f in wire.heard(world.lead_field) if f["type"] == "task.updated")
        assert [a["filename"] for a in frame["task"]["attachments"]] == ["a.pdf"]
    finally:
        set_storage(None)


# --- the bell -------------------------------------------------------------------------------


async def bell(http: AsyncClient, api: str, who: User) -> list[dict[str, Any]]:
    await login(http, api, who)
    r = await http.get(f"{api}/chat/notifications")
    assert r.status_code == 200, r.text
    return [i for i in r.json()["items"] if i["kind"] in TASK_KINDS]


TASK_KINDS = {"Needs your approval", "Assigned to you", "Sent back", "Approved", "Blocked"}


async def test_the_bell_follows_a_task_from_assignment_to_sign_off(
    anon_client: AsyncClient, api: str, world: World
) -> None:
    http = anon_client
    t = await make(http, api, world.pm, world.staff, world.a)
    mine = await bell(http, api, world.staff)
    assert [(i["kind"], i["body"]) for i in mine] == [
        ("Assigned to you", f"{t['task_no']} · from {world.pm.full_name} · due {D}")
    ]
    assert (
        mine[0]["to"] == f"/workspace/{t['project_no']}?task={t['task_no']}"
        and mine[0]["read"] is None
    )
    assert await bell(http, api, world.pm) == [], "the person who gave it has nothing to do"
    assert await bell(http, api, world.lead_design) == [], (
        "and someone who cannot see it hears nothing"
    )

    for action in ("start", "submit"):
        assert (await do(http, api, world.staff, t, action)).status_code == 200
    still = [i["kind"] for i in await bell(http, api, world.staff)]
    assert still == ["Assigned to you"], "submitted is still open, so it is still theirs"
    lead = await bell(http, api, world.lead_field)
    assert [(i["kind"], i["body"]) for i in lead] == [
        ("Needs your approval", f"{t['task_no']} · submitted by {world.staff.full_name} · stage 1")
    ]
    assert await bell(http, api, world.pm) == [], "the PM waits for stage 1"

    await do(http, api, world.lead_field, t, "approve")
    assert await bell(http, api, world.lead_field) == [], "given: gone"
    pm = await bell(http, api, world.pm)
    assert [i["body"] for i in pm] == [
        f"{t['task_no']} · submitted by {world.staff.full_name} · final approval"
    ]

    await do(http, api, world.pm, t, "approve")
    assert await bell(http, api, world.pm) == []
    done = [i for i in await bell(http, api, world.staff) if i["kind"] == "Approved"]
    assert [i["body"] for i in done] == [f"{t['task_no']} · final approval by {world.pm.full_name}"]


async def test_a_rejection_rings_the_assignee_and_a_resubmission_rings_the_approver_again(
    anon_client: AsyncClient, api: str, world: World, frozen_clock: FrozenClock
) -> None:
    http = anon_client
    t = await make(http, api, world.pm, world.staff, world.a)
    await do(http, api, world.staff, t, "start")
    await do(http, api, world.staff, t, "submit")
    first = (await bell(http, api, world.lead_field))[0]["id"]
    await do(http, api, world.lead_field, t, "reject", comment="needs the stage plan")
    back = [i for i in await bell(http, api, world.staff) if i["kind"] == "Sent back"]
    assert [i["body"] for i in back] == [f"{world.lead_field.full_name}: needs the stage plan"]
    assert await bell(http, api, world.lead_field) == []
    # Submitted again: a different moment, so a different id: it rings again.
    frozen_clock.advance(dt.timedelta(minutes=5))
    await do(http, api, world.staff, t, "submit")
    second = (await bell(http, api, world.lead_field))[0]["id"]
    assert second != first and second.startswith(f"approve:{t['task_no']}:")
    assert not [i for i in await bell(http, api, world.staff) if i["kind"] == "Sent back"], (
        "answered: no longer the last word"
    )


async def test_a_blocked_task_rings_whoever_handed_it_out_and_the_pm_but_not_the_assignee(
    anon_client: AsyncClient, api: str, world: World
) -> None:
    http = anon_client
    t = await make(http, api, world.lead_field, world.staff, world.a)  # handed out by the leader
    await do(http, api, world.staff, t, "block", reason="no access card")
    for who in (world.lead_field, world.pm):
        items = await bell(http, api, who)
        assert [(i["kind"], i["body"]) for i in items] == [
            ("Blocked", f"{world.staff.full_name}: no access card")
        ], who.email
    assert [i["kind"] for i in await bell(http, api, world.staff)] == ["Assigned to you"], (
        "not told of their own block"
    )
    await do(http, api, world.staff, t, "unblock")
    assert await bell(http, api, world.pm) == []


async def test_what_needs_your_approval_comes_first(
    anon_client: AsyncClient, api: str, world: World
) -> None:
    http = anon_client
    a = await make(http, api, world.pm, world.staff, world.a)
    await do(http, api, world.staff, a, "start")
    await do(http, api, world.staff, a, "submit")
    await make(
        http, api, world.pm, world.lead_field, world.a
    )  # given to the leader: "Assigned to you"
    await login(http, api, world.lead_field)
    items = (await http.get(f"{api}/chat/notifications")).json()["items"]
    assert [i["kind"] for i in items][:2] == ["Needs your approval", "Assigned to you"]


# --- the prototype's own numbers, on its own demo data ---------------------------------------


async def test_the_numbers_the_prototype_asserts_hold_in_the_servers_bell(
    db: AsyncSession, anon_client: AsyncClient, api: str
) -> None:
    await seed_chat_demo(db)
    await seed_tasks(db)

    async def items(email: str) -> list[dict[str, Any]]:
        r = await anon_client.post(
            f"{api}/auth/login", json={"email": email, "password": DEMO_PASSWORD}
        )
        assert r.status_code == 200, r.text
        anon_client.headers["Authorization"] = f"Bearer {r.json()['access_token']}"
        got = await anon_client.get(f"{api}/chat/notifications", params={"limit": 100})
        return [i for i in got.json()["items"] if i["kind"] in TASK_KINDS]

    maya = await items("maya@oscenia.co.id")  # Design leader
    assert sum(1 for i in maya if i["kind"] == "Needs your approval") == 2
    pm = await items("agus@oscenia.co.id")
    assert sum(1 for i in pm if i["kind"] == "Blocked") == 4
    kevin = await items("kevin@oscenia.co.id")  # intern
    assert sum(1 for i in kevin if i["kind"] == "Assigned to you") == 3
    assert [i["kind"] for i in maya][:2] == ["Needs your approval", "Needs your approval"], (
        "pinned first"
    )


# --- the cases the first pass of breakage checks showed were missing -------------------------


async def test_a_task_you_gave_yourself_and_your_own_block_do_not_ring_you(
    anon_client: AsyncClient, api: str, world: World
) -> None:
    http = anon_client
    t = await make(http, api, world.lead_field, world.lead_field, world.a)  # a leader's own task
    assert await bell(http, api, world.lead_field) == [], (
        "you gave it to yourself: no 'assigned to you'"
    )
    await do(http, api, world.lead_field, t, "block", reason="waiting for the venue")
    assert await bell(http, api, world.lead_field) == [], "nor are you told of your own block"
    pm = await bell(http, api, world.pm)
    assert [i["kind"] for i in pm] == ["Blocked"], "the PM is"


async def test_someone_who_can_see_a_blocked_task_but_did_not_hand_it_out_is_not_rung(
    anon_client: AsyncClient, api: str, world: World
) -> None:
    http = anon_client
    t = await make(http, api, world.pm, world.staff, world.a)  # the PM assigned it
    await do(http, api, world.staff, t, "block", reason="no access card")
    # The Field leader can see it (their division) but neither handed it out nor is the PM.
    assert [i["kind"] for i in await bell(http, api, world.lead_field)] == []
    assert [i["kind"] for i in await bell(http, api, world.pm)] == ["Blocked"]


async def test_a_sign_off_leaves_the_bell_after_thirty_days(
    anon_client: AsyncClient, api: str, world: World, frozen_clock: FrozenClock
) -> None:
    http = anon_client
    t = await make(http, api, world.pm, world.staff, world.a)
    for who, action in [
        (world.staff, "start"),
        (world.staff, "submit"),
        (world.lead_field, "approve"),
        (world.pm, "approve"),
    ]:
        assert (await do(http, api, who, t, action)).status_code == 200
    assert [i["kind"] for i in await bell(http, api, world.staff) if i["kind"] == "Approved"] == [
        "Approved"
    ]
    frozen_clock.advance(dt.timedelta(days=29))
    assert [i["kind"] for i in await bell(http, api, world.staff) if i["kind"] == "Approved"] == [
        "Approved"
    ]
    frozen_clock.advance(dt.timedelta(days=2))
    assert [i for i in await bell(http, api, world.staff) if i["kind"] == "Approved"] == []


async def test_the_bell_shows_only_tasks_you_may_see(
    anon_client: AsyncClient, api: str, world: World
) -> None:
    http = anon_client
    t = await make(http, api, world.lead_design, world.intern, world.b)  # Design task on project B
    await do(http, api, world.intern, t, "start")
    await do(http, api, world.intern, t, "submit")
    # The Field leader (reaches B, but it is a Design task) is not a stage holder and cannot see it.
    assert await bell(http, api, world.lead_field) == []
    assert [i["kind"] for i in await bell(http, api, world.lead_design)] == ["Needs your approval"]
    assert [i["kind"] for i in await bell(http, api, world.staff)] == [], "staff on project A only"


async def test_a_new_approval_outranks_newer_items_in_the_bell(
    anon_client: AsyncClient, api: str, world: World, frozen_clock: FrozenClock
) -> None:
    http = anon_client
    t = await make(http, api, world.pm, world.staff, world.a)
    await do(http, api, world.staff, t, "start")
    await do(http, api, world.staff, t, "submit")
    frozen_clock.advance(dt.timedelta(hours=1))  # something newer lands for the leader afterwards
    await make(http, api, world.pm, world.lead_field, world.a)
    await login(http, api, world.lead_field)
    items = (await http.get(f"{api}/chat/notifications")).json()["items"]
    assert [i["kind"] for i in items][:2] == ["Needs your approval", "Assigned to you"], "pinned"
    assert items[0]["at"] < items[1]["at"], "older, yet first: the one that needs action"


async def test_taken_off_the_project_you_stop_hearing_about_its_tasks_in_the_bell(
    anon_client: AsyncClient, api: str, world: World, db: AsyncSession
) -> None:
    http = anon_client
    await make(http, api, world.pm, world.staff, world.a)
    assert [i["kind"] for i in await bell(http, api, world.staff)] == ["Assigned to you"]
    await workspace.set_project_members(db, uuid.UUID(world.a), [], actor=world.pm)
    assert await bell(http, api, world.staff) == [], "still the assignee, but can no longer see it"
