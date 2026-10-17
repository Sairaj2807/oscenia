"""Workspace backend T1 — the task rules agree with the prototype's.

``tests/fixtures/task_matrix.json`` holds what the prototype's own code answers (written by
``erp-frontend/scripts/export-task-fixtures.mjs``): every seed person against every seed task and
a grid of made-up ones, and eight scripted flows driven through the real store. The port must give
the same answers to all of them, so the two rule books cannot drift apart unnoticed.

Pure functions, no database. (T2 replays the same flows over HTTP against the real service.)
"""

from __future__ import annotations

import dataclasses
import datetime as dt
import json
from pathlib import Path
from typing import Any

import pytest

from app.domain.chat.access import Member
from app.domain.workspace import task_rules as r

FIXTURE: dict[str, Any] = json.loads(
    (Path(__file__).parent / "fixtures" / "task_matrix.json").read_text("utf-8")
)
PD: dict[str, list[str]] = FIXTURE["project_divisions"]
TODAY = dt.date.fromisoformat(FIXTURE["today"])


def member(m: dict[str, Any]) -> Member:
    return Member(
        id=m["id"], workspace_role=m["workspace_role"], division=m["division"],
        project_ids=tuple(m["project_ids"]),
    )  # fmt: skip


MEMBERS = [member(m) for m in FIXTURE["members"]]
BY_ID = {m.id: m for m in MEMBERS}


def task(t: dict[str, Any]) -> r.Task:
    return r.Task(
        id=t["id"], project_id=t["project_id"], division=t["division"],
        assignee_id=t["assignee_id"], assigned_by_id=t["assigned_by_id"], status=t["status"],
        deadline=dt.date.fromisoformat(t["deadline"]),
    )  # fmt: skip


TASKS = [task(t) for t in FIXTURE["tasks"]]


def test_the_fixture_covers_what_it_should() -> None:
    assert len(MEMBERS) == 10 and len(TASKS) == 171 and len(FIXTURE["scenarios"]) == 8
    statuses = {t.status for t in TASKS}
    assert statuses == {
        "To do", "In progress", "Blocked", "Submitted", "Leader approved", "PM approved",
    }  # fmt: skip
    # Something is allowed and something refused, or the parity below proves little.
    assert any(FIXTURE["stage"][m] for m in FIXTURE["stage"])
    assert any(len(FIXTURE["see"][m]) < len(TASKS) for m in FIXTURE["see"])
    assert FIXTURE["overdue"]


# --- every answer, for every person ---------------------------------------------------------


@pytest.mark.parametrize("mid", [m.id for m in MEMBERS])
def test_who_sees_works_on_submits_and_approves(mid: str) -> None:
    me = BY_ID[mid]
    assert [t.id for t in TASKS if r.can_see_task(me, t, PD)] == FIXTURE["see"][mid], "see"
    assert [t.id for t in TASKS if r.can_work_on(me, t)] == FIXTURE["work"][mid], "work"
    assert [t.id for t in TASKS if r.can_submit(me, t)] == FIXTURE["submit"][mid], "submit"
    stages = {t.id: s for t in TASKS if (s := r.approval_stage(me, t, MEMBERS))}
    assert stages == FIXTURE["stage"][mid], "approval stage"


@pytest.mark.parametrize("mid", [m.id for m in MEMBERS])
def test_who_a_person_may_assign_on_each_project(mid: str) -> None:
    me = BY_ID[mid]
    for project, expected in FIXTURE["assignable"][mid].items():
        got = [m.id for m in r.assignable_members(me, project, MEMBERS, PD)]
        assert got == expected, (mid, project)
        assert r.can_assign(me, project, MEMBERS, PD) is bool(expected)


def test_overdue_is_the_open_tasks_past_their_deadline() -> None:
    assert [t.id for t in TASKS if r.is_overdue(t, TODAY)] == FIXTURE["overdue"]


# --- the flows, replayed through the planned moves ------------------------------------------


@dataclasses.dataclass
class World:
    """A tiny stand-in for the database: enough to apply a :class:`r.Move` and read it back."""

    members: list[Member]
    tasks: dict[str, r.Task] = dataclasses.field(default_factory=dict)
    state: dict[str, dict[str, Any]] = dataclasses.field(default_factory=dict)
    counter: int = 0

    def apply(self, tid: str, actor: Member, mv: r.Move) -> None:
        t, s = self.tasks[tid], self.state[tid]
        self.tasks[tid] = dataclasses.replace(t, status=mv.status)
        if mv.blocker_reason is not None:
            s["blocker_reason"] = mv.blocker_reason
        if mv.clears_approvals:
            s["approvals"] = set()
        if mv.approval:
            s["approvals"].add(mv.approval)
        if mv.completes:
            s["completed"] = True
        s["activity"].append({"kind": mv.kind, "text": mv.text, "by": actor.id})

    def snapshot(self, tid: str) -> dict[str, Any]:
        t, s = self.tasks[tid], self.state[tid]
        last = s["activity"][-1]
        return {
            "status": t.status, "blocker_reason": s["blocker_reason"], "division": t.division,
            "assigned_by": t.assigned_by_id, "assignee": t.assignee_id,
            "approvals": sorted(s["approvals"]), "completed": s["completed"],
            "activity": last, "activity_count": len(s["activity"]),
        }  # fmt: skip


def run(step: dict[str, Any], w: World, ids: dict[str, str]) -> bool:
    actor = next(m for m in w.members if m.id == step["as"])
    a = step["args"]
    try:
        if step["do"] == "create":
            assignee = r.plan_create(
                actor, a["project_id"], a["assignee_id"], a["title"],
                dt.date.fromisoformat(a["deadline"]) if a["deadline"] else None,
                w.members, PD, TODAY,
            )  # fmt: skip
            w.counter += 1
            tid = f"N-{w.counter}"
            ids[step["alias"]] = tid
            w.tasks[tid] = r.Task(
                tid, a["project_id"], assignee.division or "", assignee.id, actor.id, "To do",
                dt.date.fromisoformat(a["deadline"]),
            )  # fmt: skip
            w.state[tid] = {
                "blocker_reason": "", "approvals": set(), "completed": False,
                "activity": [{"kind": "assign", "text": "assigned", "by": actor.id}],
            }  # fmt: skip
            if r.joins_project(assignee, a["project_id"]):
                w.members = [
                    dataclasses.replace(m, project_ids=(*m.project_ids, a["project_id"]))
                    if m.id == assignee.id else m
                    for m in w.members
                ]  # fmt: skip
            return True
        tid = ids[step["task"]]
        t = w.tasks[tid]
        mv = {
            "start": lambda: r.start(actor, t),
            "unblock": lambda: r.unblock(actor, t),
            "submit": lambda: r.submit(actor, t),
            "approve": lambda: r.approve(actor, t, w.members),
            "block": lambda: r.block(actor, t, a["reason"]),
            "reject": lambda: r.reject(actor, t, w.members, a["comment"]),
        }[step["do"]]()
        w.apply(tid, actor, mv)
        return True
    except r.Refusal:
        return False


@pytest.mark.parametrize("scenario", FIXTURE["scenarios"], ids=lambda s: s["name"][:50])
def test_every_flow_ends_where_the_prototype_ends(scenario: dict[str, Any]) -> None:
    w, ids = World(list(MEMBERS)), {}
    for n, step in enumerate(scenario["steps"], start=1):
        ok = run(step, w, ids)
        label = f"{scenario['name']} — step {n}: {step['as']} {step['do']}"
        assert ok == step["ok"], label
        if step["do"] == "create":
            if ok:
                tid = ids[step["alias"]]
                assert w.snapshot(tid) == step["result"], label
                joined = next(m for m in w.members if m.id == step["args"]["assignee_id"])
                assert sorted(joined.project_ids) == sorted(step["assignee_projects"]), label
        else:
            assert w.snapshot(ids[step["task"]]) == step["result"], label


# --- the rules the prototype never had to state ---------------------------------------------

PM, DINDA, RINA, YOGA = BY_ID["M-01"], BY_ID["M-02"], BY_ID["M-05"], BY_ID["M-06"]
GALA = "EVT-2026-GALA-01"


def test_a_deadline_in_the_past_is_refused_here_though_only_the_modal_checked_it() -> None:
    yesterday = TODAY - dt.timedelta(days=1)
    with pytest.raises(r.Refusal) as err:
        r.plan_create(PM, GALA, RINA.id, "x", yesterday, MEMBERS, PD, TODAY)
    assert err.value.code == "past_deadline"
    assert r.plan_create(PM, GALA, RINA.id, "x", TODAY, MEMBERS, PD, TODAY) is RINA, "today is fine"


def test_every_refusal_says_why() -> None:
    def code(fn: Any) -> str:
        with pytest.raises(r.Refusal) as err:
            fn()
        return err.value.code

    t = r.Task("t", GALA, "Field", RINA.id, PM.id, "To do")
    assert (
        code(lambda: r.plan_create(RINA, GALA, DINDA.id, "x", TODAY, MEMBERS, PD, TODAY))
        == "cannot_assign"
    )
    assert (
        code(lambda: r.plan_create(PM, GALA, RINA.id, " ", TODAY, MEMBERS, PD, TODAY))
        == "needs_title"
    )
    assert (
        code(lambda: r.plan_create(PM, GALA, RINA.id, "x", None, MEMBERS, PD, TODAY))
        == "needs_deadline"
    )
    assert code(lambda: r.start(YOGA, t)) == "not_allowed"
    assert code(lambda: r.start(RINA, dataclasses.replace(t, status="Submitted"))) == "wrong_status"
    assert code(lambda: r.block(RINA, t, " ")) == "needs_reason"
    assert code(lambda: r.submit(PM, t)) == "not_allowed", "W3"
    assert (
        code(lambda: r.reject(DINDA, dataclasses.replace(t, status="Submitted"), MEMBERS, ""))
        == "needs_comment"
    )
    assert code(lambda: r.approve(RINA, t, MEMBERS)) == "not_allowed"


def test_a_move_says_what_to_write_and_the_texts_are_the_prototypes() -> None:
    t = r.Task("t", GALA, "Field", RINA.id, PM.id, "In progress")
    assert r.start(RINA, dataclasses.replace(t, status="To do")) == r.Move(
        "In progress", "status", "started"
    )
    assert r.submit(RINA, t) == r.Move("Submitted", "status", "submitted for approval")
    sub = dataclasses.replace(t, status="Submitted")
    assert r.approve(DINDA, sub, MEMBERS) == r.Move(
        "Leader approved", "approve", "approved (Division Leader)", approval="leader"
    )
    lead = dataclasses.replace(t, status="Leader approved")
    done = r.approve(PM, lead, MEMBERS)
    assert (done.status, done.text, done.completes) == ("PM approved", "approved (PM) — done", True)
    back = r.reject(DINDA, sub, MEMBERS, "  redo it  ")
    assert back == r.Move("In progress", "reject", "rejected: redo it", clears_approvals=True)
    blocked = r.block(RINA, t, "  no card ")
    assert (blocked.text, blocked.blocker_reason) == ("blocked: no card", "no card")
    assert r.unblock(RINA, dataclasses.replace(t, status="Blocked")).blocker_reason == ""


def test_only_staff_and_interns_join_a_project_by_being_given_a_task_on_it() -> None:
    wed = "EVT-2026-WED-02"
    assert r.joins_project(RINA, wed) and not r.joins_project(RINA, GALA)
    assert not r.joins_project(DINDA, wed) and not r.joins_project(PM, wed)


def test_nobody_sees_anything_without_a_persona() -> None:
    t = TASKS[0]
    assert not r.can_see_task(None, t, PD) and not r.can_work_on(None, t)
    assert not r.can_submit(None, t) and r.approval_stage(None, t, MEMBERS) is None
    assert r.assignable_members(None, GALA, MEMBERS, PD) == []
