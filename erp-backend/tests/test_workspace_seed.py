"""Workspace backend T1 — the task demo seed behaves as the prototype's workspace does.

The data is the prototype's own (``task_seed.json``, exported by
``erp-frontend/scripts/export-task-seed.mjs``), so these tests check that the loader puts it in
faithfully and that the *server's* rules — not the prototype's — give the answers the prototype's
checks assert: Maya has two approvals waiting, the PM sees four blocked tasks, Kevin has three
tasks assigned.
"""

from __future__ import annotations

import json
from collections import Counter
from typing import Any

from httpx import AsyncClient
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from test_chat_seed import DATA as CHAT_DATA
from test_chat_seed import _seed as seed_chat_demo

from app.core.clock import DEMO_TODAY
from app.domain.ar.models import Project
from app.domain.chat import tokens
from app.domain.chat.access import Member
from app.domain.masters.models import User
from app.domain.workspace import task_rules as rules
from app.domain.workspace.models import (
    TaskActivity,
    TaskApproval,
    TaskAttachment,
    TaskStatus,
    WorkspaceTask,
)
from app.seed.chart import DEMO_PASSWORD
from app.seed.tasks import SEED_FILE, seed_tasks

DATA: dict[str, Any] = json.loads(SEED_FILE.read_text("utf-8"))


async def sign_in(http: AsyncClient, api: str, email: str) -> None:
    r = await http.post(f"{api}/auth/login", json={"email": email, "password": DEMO_PASSWORD})
    assert r.status_code == 200, r.text
    http.headers["Authorization"] = f"Bearer {r.json()['access_token']}"


async def seed_all(db: AsyncSession) -> Any:
    await seed_chat_demo(db)
    return await seed_tasks(db)


async def facts(db: AsyncSession) -> tuple[list[rules.Task], list[Member], dict[str, list[str]]]:
    """The loaded tasks and people, as the rules see them (ids are member numbers)."""
    users = {u.id: u for u in (await db.execute(select(User))).scalars() if u.member_no}
    pnos = {p.id: p.project_no for p in (await db.execute(select(Project))).scalars()}
    members = [
        Member(
            id=u.member_no or "",
            workspace_role=u.workspace_role.value if u.workspace_role else "staff",
            division=u.division,
            project_ids=tuple(CHAT_MEMBER_PROJECTS.get(u.member_no or "", ())),
        )  # fmt: skip
        for u in users.values()
    ]
    tasks = [
        rules.Task(
            t.task_no,
            pnos[t.project_id],
            t.division,
            users[t.assignee_id].member_no or "",
            users[t.assigned_by_id].member_no or "",
            t.status.value,
            t.deadline,
        )  # fmt: skip
        for t in (await db.execute(select(WorkspaceTask).order_by(WorkspaceTask.task_no))).scalars()
    ]
    return tasks, members, CHAT_DATA["project_divisions"]


CHAT_MEMBER_PROJECTS = {m["id"]: m["project_ids"] for m in CHAT_DATA["members"]}


async def test_the_seed_loads_what_the_prototype_has_and_is_idempotent(db: AsyncSession) -> None:
    report = await seed_all(db)
    assert (report.tasks, report.activity, report.attachments) == (27, 79, 2)
    assert report.pics == 3  # Dinda is named on three of the four project cards

    again = await seed_tasks(db)
    assert (again.tasks, again.activity, again.attachments, again.pics) == (0, 0, 0, 0)
    assert (await db.execute(select(func.count()).select_from(WorkspaceTask))).scalar_one() == 27
    assert (await db.execute(select(func.count()).select_from(TaskActivity))).scalar_one() == 79

    by_status = Counter(s for s in (await db.execute(select(WorkspaceTask.status))).scalars())
    assert dict(by_status) == {
        TaskStatus.TODO: 7, TaskStatus.IN_PROGRESS: 5, TaskStatus.BLOCKED: 4,
        TaskStatus.SUBMITTED: 3, TaskStatus.LEADER_APPROVED: 3, TaskStatus.PM_APPROVED: 5,
    }  # fmt: skip


async def test_the_next_task_made_is_after_the_demo_ones(db: AsyncSession) -> None:
    await seed_all(db)
    # A sequence is not rolled back between tests, so an earlier run may have used 405 already:
    # what matters is that it is never at or below the demo's highest, T-404.
    assert (await db.execute(text("SELECT nextval('task_no_seq')"))).scalar_one() >= 405


async def test_approvals_files_and_history_come_across(db: AsyncSession) -> None:
    await seed_all(db)
    done = (
        (
            await db.execute(
                select(WorkspaceTask).where(WorkspaceTask.status == TaskStatus.PM_APPROVED)
            )
        )
        .scalars()
        .all()
    )
    assert len(done) == 5 and all(t.completed_at is not None for t in done)
    stages = Counter(a.stage.value for a in (await db.execute(select(TaskApproval))).scalars())
    assert stages == {"leader": 8, "pm": 5}  # 3 leader-approved + 5 done had stage 1; 5 done had 2
    files = (await db.execute(select(TaskAttachment))).scalars().all()
    assert sorted(f.filename for f in files) == [
        "run-of-show-v3-draft.docx",
        "venue-floor-plan-v3.pdf",
    ]
    assert all(f.storage_key is None for f in files), "details only: no bytes behind a demo file"
    blocked = (
        (await db.execute(select(WorkspaceTask).where(WorkspaceTask.status == TaskStatus.BLOCKED)))
        .scalars()
        .all()
    )
    assert len(blocked) == 4 and all(t.blocker_reason for t in blocked)


async def test_every_task_a_chat_message_links_to_exists(db: AsyncSession) -> None:
    await seed_all(db)
    wanted = {n for m in CHAT_DATA["messages"] for n in tokens.task_ids(m["text"])}
    have = set((await db.execute(select(WorkspaceTask.task_no))).scalars())
    assert wanted and wanted <= have, wanted - have


# --- the server's rules give the answers the prototype's own checks assert ------------------


async def test_the_numbers_the_prototype_asserts_hold_under_the_servers_rules(
    db: AsyncSession,
) -> None:
    await seed_all(db)
    tasks, members, pd = await facts(db)
    by_id = {m.id: m for m in members}

    maya = by_id["M-03"]  # Design leader
    assert sum(1 for t in tasks if rules.approval_stage(maya, t, members)) == 2
    pm = by_id["M-01"]
    assert sum(1 for t in rules.visible_tasks(pm, tasks, pd) if t.status == "Blocked") == 4
    kevin = by_id["M-09"]  # intern
    seen = rules.visible_tasks(kevin, tasks, pd)
    assert {t.assignee_id for t in seen} == {"M-09"}, "an intern sees only their own"
    # Four are his; the prototype's "three assigned to him" counts the ones still open.
    assert len(seen) == 4 and sum(1 for t in seen if t.status != "PM approved") == 3
    assert len(rules.visible_tasks(pm, tasks, pd)) == 27


async def test_overdue_open_tasks_on_the_demo_day(db: AsyncSession) -> None:
    await seed_all(db)
    tasks, _, _ = await facts(db)
    overdue = sorted(t.id for t in tasks if rules.is_overdue(t, DEMO_TODAY))
    assert overdue == ["T-102", "T-104", "T-108", "T-304", "T-305", "T-309", "T-402"]


# --- the project cards the workspace draws --------------------------------------------------


async def test_the_project_cards_name_who_is_in_charge(
    db: AsyncSession, anon_client: AsyncClient, api: str
) -> None:
    await seed_all(db)
    http = anon_client
    await sign_in(http, api, "rina@oscenia.co.id")
    boot = (await http.get(f"{api}/chat/bootstrap")).json()
    cards = {p["project_no"]: p for p in boot["projects"]}
    assert set(cards) == {"EVT-2026-GALA-01", "EVT-2026-PROD-04"}  # Rina's two projects
    assert cards["EVT-2026-GALA-01"]["pm_name"] == "Dinda A."
    assert cards["EVT-2026-GALA-01"]["client_name"] == "Aurora Bank"
    assert cards["EVT-2026-GALA-01"]["event_date"] == "2026-08-14"
