"""Workspace backend T2 — tasks over HTTP: the prototype's flows, who sees what, history, audit.

Two halves. First the prototype's own scripted flows (``tests/fixtures/task_matrix.json``, driven
through its real store) are replayed against the real service, with its demo people, and must end
in the same place step for step. Then the checks the prototype could not make: that a task you may
not see is 404 and not 403, that the history and audit rows are written, that the deadline is
checked on the server, and that a clock — not the browser — decides what is overdue.
"""

from __future__ import annotations

import datetime as dt
import json
import re
import uuid
from pathlib import Path
from typing import Any

from chat_world import World, login, world  # noqa: F401
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from test_chat_seed import _seed as seed_chat_demo

from app.core.clock import FrozenClock
from app.domain.ar.models import Project
from app.domain.audit.models import AuditEvent
from app.domain.masters.models import ProjectMember, User
from app.seed.chart import DEMO_PASSWORD

FIXTURE: dict[str, Any] = json.loads(
    (Path(__file__).parent / "fixtures" / "task_matrix.json").read_text("utf-8")
)
D = "2026-08-30"


# --- the prototype's flows, replayed against the service ------------------------------------


async def test_every_prototype_flow_ends_where_the_prototype_ends(
    db: AsyncSession, anon_client: AsyncClient, api: str
) -> None:
    await seed_chat_demo(db)
    users = {u.member_no: u for u in (await db.execute(select(User))).scalars() if u.member_no}
    projects = {p.project_no: p for p in (await db.execute(select(Project))).scalars()}
    http = anon_client
    tokens: dict[str, str] = {}

    async def as_(member: str) -> None:
        if member not in tokens:
            r = await http.post(
                f"{api}/auth/login", json={"email": users[member].email, "password": DEMO_PASSWORD}
            )
            assert r.status_code == 200, r.text
            tokens[member] = r.json()["access_token"]
        http.headers["Authorization"] = f"Bearer {tokens[member]}"

    def shape(t: dict[str, Any]) -> dict[str, Any]:
        last = t["activity"][-1]
        return {
            "status": t["status"], "blocker_reason": t["blocker_reason"], "division": t["division"],
            "assigned_by": t["assigned_by_no"], "assignee": t["assignee_no"],
            "approvals": sorted(t["approvals"]), "completed": t["completed_at"] is not None,
            "activity": {"kind": last["kind"], "text": last["text"], "by": last["by_no"]},
            "activity_count": len(t["activity"]),
        }  # fmt: skip

    original = {
        (pm.project_id, pm.user_id) for pm in (await db.execute(select(ProjectMember))).scalars()
    }

    async def reset_members() -> None:
        """The prototype starts every flow from the seed; a flow that added someone to a project
        (W1) must not change the next one."""
        for pm in (await db.execute(select(ProjectMember))).scalars():
            if (pm.project_id, pm.user_id) not in original:
                await db.delete(pm)
        await db.flush()

    for sc in FIXTURE["scenarios"]:
        await reset_members()
        ids: dict[str, str] = {}
        for n, step in enumerate(sc["steps"], start=1):
            label = f"{sc['name']} — step {n}: {step['as']} {step['do']}"
            await as_(step["as"])
            a = step["args"]
            if step["do"] == "create":
                project = projects.get(a["project_id"])
                body = {
                    "project_id": str(project.id) if project else a["project_id"],
                    "title": a["title"], "description": a["description"],
                    "assignee_id": str(users[a["assignee_id"]].id),
                    "deadline": a["deadline"] or None, "priority": a["priority"],
                }  # fmt: skip
                r = await http.post(f"{api}/tasks", json=body)
            else:
                ref = ids[step["task"]]
                payload = {
                    "block": {"reason": a.get("reason")},
                    "reject": {"comment": a.get("comment")},
                }
                r = await http.post(f"{api}/tasks/{ref}/{step['do']}", json=payload.get(step["do"]))
            ok = r.status_code < 300
            assert ok == step["ok"], f"{label}: {r.status_code} {r.text}"
            if step["do"] == "create":
                if ok:
                    ids[step["alias"]] = r.json()["id"]
                    assert shape(r.json()) == step["result"], label
                    mine = users[a["assignee_id"]]
                    if mine.workspace_role and mine.workspace_role.value in ("staff", "intern"):
                        rows = (
                            (
                                await db.execute(
                                    select(ProjectMember.project_id).where(
                                        ProjectMember.user_id == mine.id
                                    )
                                )
                            )
                            .scalars()
                            .all()
                        )
                        got = sorted(p.project_no for p in projects.values() if p.id in rows)
                        assert got == sorted(step["assignee_projects"]), label
            else:
                if ok:
                    assert shape(r.json()) == step["result"], label
                else:  # refused: the task is as it was (read as the PM, who sees every task)
                    await as_("M-01")
                    seen = await http.get(f"{api}/tasks/{ids[step['task']]}")
                    assert shape(seen.json()) == step["result"], label


# --- the rest: the chat test world ----------------------------------------------------------


async def make(
    http: AsyncClient, api: str, world: World, who: User, assignee: User, project: str, **kw: Any
) -> dict[str, Any]:
    await login(http, api, who)
    body = {
        "project_id": project, "title": "Check the rigging", "assignee_id": str(assignee.id),
        "deadline": D, **kw,
    }  # fmt: skip
    r = await http.post(f"{api}/tasks", json=body)
    assert r.status_code == 201, r.text
    return r.json()


async def tasks_of(http: AsyncClient, api: str, who: User) -> list[str]:
    await login(http, api, who)
    r = await http.get(f"{api}/tasks")
    assert r.status_code == 200, r.text
    return [t["task_no"] for t in r.json()]


async def test_everyone_lists_only_what_the_rules_let_them_see(
    anon_client: AsyncClient, api: str, world: World
) -> None:
    http = anon_client
    t1 = await make(http, api, world, world.pm, world.staff, world.a)  # Field task on A
    t2 = await make(http, api, world, world.lead_design, world.intern, world.b)  # Design task on B
    t3 = await make(http, api, world, world.lead_field, world.staff, world.b)  # Field, on B too
    every = {t["task_no"] for t in (t1, t2, t3)}

    assert set(await tasks_of(http, api, world.pm)) == every
    # The Field leader sees the Field division's tasks and any they assigned (t1 and t3 are Field).
    assert set(await tasks_of(http, api, world.lead_field)) == {t1["task_no"], t3["task_no"]}
    # The Design leader sees Design's, and not the Field ones they did not assign.
    assert set(await tasks_of(http, api, world.lead_design)) == {t2["task_no"]}
    # Staff see every task on their projects: A, and B once t3 made them a member.
    assert set(await tasks_of(http, api, world.staff)) == every
    # An intern sees only their own.
    assert await tasks_of(http, api, world.intern) == [t2["task_no"]]


async def test_a_task_you_may_not_see_is_no_such_task_and_a_login_without_the_module_is_refused(
    anon_client: AsyncClient, api: str, world: World
) -> None:
    http = anon_client
    t = await make(http, api, world, world.lead_design, world.intern, world.b)
    await login(http, api, world.staff)  # not on project B yet
    for ref in (t["task_no"], t["id"], t["task_no"].lower()):
        assert (await http.get(f"{api}/tasks/{ref}")).status_code == 404, ref
    assert (await http.post(f"{api}/tasks/{t['id']}/start")).status_code == 404, (
        "no oracle on moves"
    )
    assert (await http.get(f"{api}/tasks/T-99999")).status_code == 404
    assert (await http.get(f"{api}/tasks/not-a-task")).status_code == 404
    await login(http, api, world.intern)
    assert (await http.get(f"{api}/tasks/{t['task_no'].lower()}")).status_code == 200
    await login(http, api, world.outsider)  # finance, no persona
    assert (await http.get(f"{api}/tasks")).status_code == 403
    http.headers.pop("Authorization")
    assert (await http.get(f"{api}/tasks")).status_code == 401


async def test_a_new_task_has_a_number_a_division_a_history_and_makes_staff_a_member(
    anon_client: AsyncClient, api: str, world: World, db: AsyncSession
) -> None:
    t = await make(anon_client, api, world, world.lead_field, world.staff, world.b)
    assert re.fullmatch(r"T-\d+", t["task_no"]) and int(t["task_no"][2:]) >= 101
    assert (t["status"], t["division"], t["blocker_reason"], t["priority"]) == (
        "To do", "Field", "", "Medium",
    )  # fmt: skip
    assert t["assigned_by_no"] == world.lead_field.member_no
    assert [(a["kind"], a["text"], a["by_no"]) for a in t["activity"]] == [
        ("assign", "assigned", world.lead_field.member_no)
    ]
    assert t["approvals"] == {} and t["completed_at"] is None and t["attachments"] == []
    # Field staff on project A only: being given a task on B makes them a member of B (W1).
    joined = (
        await db.execute(
            select(ProjectMember).where(
                ProjectMember.user_id == world.staff.id,
                ProjectMember.project_id == uuid.UUID(world.b),
            )
        )
    ).scalar_one_or_none()
    assert joined is not None
    actions = (await db.execute(select(AuditEvent.action).order_by(AuditEvent.at))).scalars().all()
    assert "task.create" in actions and "task.assignee_joined_project" in actions
    second = await make(anon_client, api, world, world.lead_field, world.staff, world.b)
    assert int(second["task_no"][2:]) > int(t["task_no"][2:])


async def test_a_deadline_in_the_past_is_refused_here_though_only_the_modal_checked_it(
    anon_client: AsyncClient, api: str, world: World
) -> None:
    await login(anon_client, api, world.pm)
    base = {"project_id": world.a, "title": "x", "assignee_id": str(world.staff.id)}
    yesterday = await anon_client.post(f"{api}/tasks", json={**base, "deadline": "2026-07-25"})
    assert yesterday.status_code == 422 and "past" in yesterday.text
    today = await anon_client.post(f"{api}/tasks", json={**base, "deadline": "2026-07-26"})
    assert today.status_code == 201, "today is fine (the demo clock is 2026-07-26)"
    for bad in (
        {**base, "deadline": D, "title": "  "}, {**base, "deadline": D, "priority": "Urgent"},
        {"project_id": world.a, "title": "x", "deadline": D},
    ):  # fmt: skip
        assert (await anon_client.post(f"{api}/tasks", json=bad)).status_code == 422, bad
    nobody = {**base, "deadline": D, "project_id": str(uuid.uuid4())}
    assert (await anon_client.post(f"{api}/tasks", json=nobody)).status_code == 404


async def test_refusals_say_not_yours_or_not_in_that_state_or_incomplete(
    anon_client: AsyncClient, api: str, world: World
) -> None:
    http = anon_client
    t = await make(http, api, world, world.pm, world.staff, world.a)
    url = f"{api}/tasks/{t['id']}"
    await login(http, api, world.staff)
    assert (await http.post(f"{url}/submit")).status_code == 409, "not started: wrong state"
    assert (await http.post(f"{url}/block", json={"reason": "  "})).status_code == 422
    assert (await http.post(f"{url}/start")).status_code == 200
    assert (await http.post(f"{url}/start")).status_code == 409
    assert (await http.post(f"{url}/approve")).status_code == 403, "not theirs to give"
    await login(http, api, world.lead_design)  # sees nothing of a Field task on A
    assert (await http.post(f"{url}/approve")).status_code == 404
    await login(http, api, world.pm)
    assert (await http.post(f"{url}/submit")).status_code == 403, "W3: never on someone's behalf"
    assert (await http.post(f"{url}/reject", json={"comment": ""})).status_code == 422


async def test_history_audit_and_the_approval_a_caller_holds_follow_a_task_through(
    anon_client: AsyncClient, api: str, world: World, db: AsyncSession
) -> None:
    http = anon_client
    t = await make(http, api, world, world.pm, world.staff, world.a)
    url = f"{api}/tasks/{t['id']}"

    async def do(who: User, action: str, **body: Any) -> dict[str, Any]:
        await login(http, api, who)
        r = await http.post(f"{url}/{action}", json=body or None)
        assert r.status_code == 200, (action, r.text)
        return r.json()

    await do(world.staff, "start")
    await do(world.staff, "block", reason=" no access card ")
    blocked = (await http.get(url)).json()
    assert (blocked["status"], blocked["blocker_reason"]) == ("Blocked", "no access card")
    await do(world.staff, "unblock")
    submitted = await do(world.staff, "submit")
    assert submitted["my_stage"] is None, "nobody approves their own work"

    await login(http, api, world.lead_field)  # the Field leader holds stage 1
    assert (await http.get(url)).json()["my_stage"] == "leader"
    await login(http, api, world.pm)
    assert (await http.get(url)).json()["my_stage"] is None, "the PM waits for stage 1"
    stage1 = await do(world.lead_field, "approve")
    assert stage1["status"] == "Leader approved" and list(stage1["approvals"]) == ["leader"]
    assert stage1["approvals"]["leader"]["by_no"] == world.lead_field.member_no
    await login(http, api, world.pm)
    assert (await http.get(url)).json()["my_stage"] == "pm"
    done = await do(world.pm, "approve")
    assert done["status"] == "PM approved" and done["completed_at"] is not None
    assert sorted(done["approvals"]) == ["leader", "pm"]
    assert [a["text"] for a in done["activity"]] == [
        "assigned", "started", "blocked: no access card", "unblocked",
        "submitted for approval", "approved (Division Leader)", "approved (PM) — done",
    ]  # fmt: skip
    assert [a["kind"] for a in done["activity"]] == [
        "assign", "status", "block", "status", "status", "approve", "approve",
    ]  # fmt: skip

    rows = (
        (
            await db.execute(
                select(AuditEvent).where(AuditEvent.entity_id == t["id"]).order_by(AuditEvent.at)
            )
        )
        .scalars()
        .all()
    )
    assert [r.action for r in rows] == [
        "task.create", "task.start", "task.block", "task.unblock", "task.submit",
        "task.approve", "task.approve",
    ]  # fmt: skip
    assert (
        rows[-1].after["status"] == "PM approved" and rows[-1].before["status"] == "Leader approved"
    )


async def test_a_rejection_clears_both_approvals_and_the_task_starts_again(
    anon_client: AsyncClient, api: str, world: World
) -> None:
    http = anon_client
    t = await make(http, api, world, world.pm, world.staff, world.a)
    url = f"{api}/tasks/{t['id']}"
    for who, action in [
        (world.staff, "start"),
        (world.staff, "submit"),
        (world.lead_field, "approve"),
    ]:
        await login(http, api, who)
        assert (await http.post(f"{url}/{action}")).status_code == 200
    await login(http, api, world.pm)
    r = await http.post(f"{url}/reject", json={"comment": "  needs the stage plan "})
    back = r.json()
    assert (back["status"], back["approvals"]) == ("In progress", {})
    assert back["activity"][-1]["text"] == "rejected: needs the stage plan"
    await login(http, api, world.staff)
    assert (await http.post(f"{url}/submit")).status_code == 200


async def test_what_is_overdue_is_decided_by_the_servers_clock(
    anon_client: AsyncClient, api: str, world: World, frozen_clock: FrozenClock
) -> None:
    t = await make(anon_client, api, world, world.pm, world.staff, world.a, deadline="2026-07-27")
    assert t["overdue"] is False
    frozen_clock.advance(dt.timedelta(days=2))
    await login(anon_client, api, world.pm)
    assert (await anon_client.get(f"{api}/tasks/{t['id']}")).json()["overdue"] is True
    for action, who in [("start", world.staff), ("submit", world.staff)]:
        await login(anon_client, api, who)
        await anon_client.post(f"{api}/tasks/{t['id']}/{action}")
    await login(anon_client, api, world.lead_field)
    await anon_client.post(f"{api}/tasks/{t['id']}/approve")
    await login(anon_client, api, world.pm)
    done = (await anon_client.post(f"{api}/tasks/{t['id']}/approve")).json()
    assert done["status"] == "PM approved" and done["overdue"] is False, "done is never overdue"


async def test_the_list_can_be_narrowed_to_a_project(
    anon_client: AsyncClient, api: str, world: World
) -> None:
    await make(anon_client, api, world, world.pm, world.staff, world.a)
    await make(anon_client, api, world, world.lead_design, world.intern, world.b)
    await login(anon_client, api, world.pm)
    on_a = (await anon_client.get(f"{api}/tasks", params={"project_id": world.a})).json()
    assert len(on_a) == 1 and on_a[0]["project_id"] == world.a
    assert on_a[0]["project_no"]


async def test_every_change_moves_the_revision_and_a_title_is_stored_trimmed(
    anon_client: AsyncClient, api: str, world: World
) -> None:
    http = anon_client
    t = await make(http, api, world, world.pm, world.staff, world.a, title="  Check the rigging  ")
    assert t["title"] == "Check the rigging" and t["rev"] == 1
    url = f"{api}/tasks/{t['id']}"
    revs = [t["rev"]]
    for who, action, body in [
        (world.staff, "start", None), (world.staff, "block", {"reason": "no card"}),
        (world.staff, "unblock", None), (world.staff, "submit", None),
    ]:  # fmt: skip
        await login(http, api, who)
        r = await http.post(f"{url}/{action}", json=body)
        assert r.status_code == 200, r.text
        revs.append(r.json()["rev"])
    assert revs == [1, 2, 3, 4, 5], "one step forward for every change, none for a refusal"
    await login(http, api, world.staff)
    assert (await http.post(f"{url}/start")).status_code == 409
    assert (await http.get(url)).json()["rev"] == 5


async def test_someone_with_no_division_cannot_be_given_a_task(
    anon_client: AsyncClient, api: str, world: World, db: AsyncSession
) -> None:
    from chat_world import PASSWORD  # noqa: F401

    from app.domain.chat import workspace
    from app.domain.masters.models import Role, WorkspaceRole
    from app.seed.users import add_user

    drifter, _ = await add_user(db, "drifter@oscenia.co.id", "Drifter", Role.TEAM, PASSWORD)
    await workspace.set_workspace(db, drifter, workspace_role=WorkspaceRole.STAFF, division=None)
    await workspace.set_project_members(
        db, uuid.UUID(world.a), [world.staff.id, drifter.id], actor=world.pm
    )
    await login(anon_client, api, world.pm)
    r = await anon_client.post(
        f"{api}/tasks",
        json={"project_id": world.a, "title": "x", "assignee_id": str(drifter.id), "deadline": D},
    )
    assert r.status_code == 422 and "no division" in r.text
