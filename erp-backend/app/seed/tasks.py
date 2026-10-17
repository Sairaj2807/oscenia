"""The prototype's task demo: 27 tasks across the four projects, with the history each has built up.

The data is ``task_seed.json``, exported from the prototype by
``erp-frontend/scripts/export-task-seed.mjs`` rather than re-typed, so the access rules the
prototype's own checks assert (Maya has two approvals waiting, the PM sees four blocked tasks,
Kevin has three tasks assigned) hold here too.

**Needs the chat seed first** (``python -m app.seed.chat``): the people, the projects and who
works on them are chat's. Then::

    python -m app.seed.tasks

**Task numbers.** The prototype's own (``T-101`` … ``T-404``) are kept, because chat messages
link to them (``<#T-102>``); the ``task_no_seq`` sequence is moved past the highest so the next
task made is ``T-405``.

**What it also does:** names the person in charge on each project card where the prototype's name
matches a workspace member (so "PIC" is not blank), without touching one already set.

Idempotent: a task whose number already exists is left alone, history and all. Like the other
demo seeds it refuses to run with ``ENV=production``.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.db.session import dispose_engine, get_sessionmaker
from app.domain.ar.models import Project
from app.domain.masters.models import User
from app.domain.workspace.models import (
    ActivityKind,
    ApprovalStage,
    TaskActivity,
    TaskApproval,
    TaskAttachment,
    TaskPriority,
    TaskStatus,
    WorkspaceTask,
)
from app.seed.chat import _at

SEED_FILE = Path(__file__).with_name("task_seed.json")

_CONTENT_TYPES = {
    "pdf": "application/pdf",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "image": "image/png",
}


@dataclass
class TaskSeedReport:
    tasks: int = 0
    activity: int = 0
    attachments: int = 0
    pics: int = 0


async def seed_tasks(
    session: AsyncSession, *, data: dict[str, Any] | None = None
) -> TaskSeedReport:
    data = data if data is not None else json.loads(SEED_FILE.read_text(encoding="utf-8"))
    report = TaskSeedReport()

    users = {
        u.member_no: u
        for u in (await session.execute(select(User).where(User.member_no.is_not(None)))).scalars()
    }
    projects = {p.project_no: p for p in (await session.execute(select(Project))).scalars()}
    needed_people = {
        who
        for t in data["tasks"]
        for who in (t["assignee"], t["assigned_by"], *(a["by"] for a in t["activity"]))
    }
    missing = sorted(needed_people - set(users)) + sorted(
        {t["project"] for t in data["tasks"]} - set(projects)
    )
    if missing:
        raise RuntimeError(
            f"{missing} are missing: the task demo hangs off the chat demo's people and projects. "
            "Seed those first (python -m app.seed.chat)."
        )

    existing = set((await session.execute(select(WorkspaceTask.task_no))).scalars())
    for raw in data["tasks"]:
        if raw["task_no"] in existing:
            continue
        task = WorkspaceTask(
            task_no=raw["task_no"], project_id=projects[raw["project"]].id,
            division=raw["division"],
            title=raw["title"], description=raw["description"],
            assignee_id=users[raw["assignee"]].id, assigned_by_id=users[raw["assigned_by"]].id,
            assigned_at=_at(raw["assigned_at"]), deadline=date.fromisoformat(raw["deadline"]),
            priority=TaskPriority(raw["priority"]), status=TaskStatus(raw["status"]),
            blocker_reason=raw["blocker_reason"],
            completed_at=_at(raw["completed_at"]) if raw["completed_at"] else None,
            created_at=_at(raw["assigned_at"]), rev=max(1, len(raw["activity"])),
        )  # fmt: skip
        session.add(task)
        await session.flush()
        for stage, a in raw["approvals"].items():
            session.add(
                TaskApproval(
                    task_id=task.id,
                    stage=ApprovalStage(stage),
                    by_id=users[a["by"]].id,
                    at=_at(a["at"]),
                )  # fmt: skip
            )
        for a in raw["activity"]:  # oldest first, so the identity column follows the history
            session.add(
                TaskActivity(
                    task_id=task.id,
                    at=_at(a["at"]),
                    by_id=users[a["by"]].id,
                    kind=ActivityKind(a["kind"]),
                    text=a["text"],
                )  # fmt: skip
            )
            report.activity += 1
        for f in raw["attachments"]:
            session.add(
                TaskAttachment(
                    task_id=task.id,
                    uploader_id=users[f["by"]].id,
                    storage_key=None,
                    filename=f["name"],
                    kind=f["kind"],
                    content_type=_CONTENT_TYPES[f["kind"]],
                    size_bytes=f["size"],
                    created_at=_at(f["at"]),
                )  # fmt: skip
            )
            report.attachments += 1
        report.tasks += 1
    await session.flush()

    # The next task made is T-405, never a repeat.
    highest = max(int(t["task_no"].split("-")[1]) for t in data["tasks"])
    await session.execute(
        text("SELECT setval('task_no_seq', GREATEST((SELECT last_value FROM task_no_seq), :n))"),
        {"n": highest},
    )

    # "PIC" on a project card: the person the prototype names, where they are a member.
    for project_no, member in data["project_pm"].items():
        project = projects.get(project_no)
        if project is not None and member and project.pm_user_id is None and member in users:
            project.pm_user_id = users[member].id
            report.pics += 1
    await session.flush()
    return report


async def _main() -> None:
    if get_settings().env == "production":
        raise SystemExit("Refusing to load demo task data with ENV=production.")
    try:
        async with get_sessionmaker()() as session, session.begin():
            report = await seed_tasks(session)
    except RuntimeError as exc:  # the chat demo has not been loaded
        raise SystemExit(str(exc)) from exc
    finally:
        await dispose_engine()
    print(
        f"Seeded workspace tasks: {report.tasks} tasks, {report.activity} activity entries, "
        f"{report.attachments} files, {report.pics} project leads named "
        "(zero everywhere means it was already loaded)."
    )


if __name__ == "__main__":
    asyncio.run(_main())
