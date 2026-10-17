"""Telling connected people what just happened to a task — after it is committed.

Routes call these *after* ``session.commit()``, for the reason chat's do (``chat/events.py``): a
frame sent before the commit could reach a client that then asks for the task and finds nothing
(or, if the request rolls back, announce something that never happened). Failures are logged and
swallowed there (``events.safely`` / ``quietly``): a broadcast must never fail a write that
already succeeded.

**Who hears is decided per event, from the same rules as the REST routes**: only connected people
who can *see* that task (``task_rules.can_see_task``), each given the task as *they* see it — the
one field that differs is ``my_stage``, the approval they could give. Nothing is sent for a change
that was refused, and there is no subscribe step to go stale: take someone off a project and the
very next event skips them.

Two frames: ``task.created`` / ``task.updated`` carry the whole task; ``notifications.refresh``
tells the people who can see it to read their bell again (its task items are worked out from the
data — see ``notifications.py`` — so the frame carries nothing to get wrong).
"""

from __future__ import annotations

from app.domain.chat.hub import ChatHub
from app.domain.workspace import task_rules as rules
from app.domain.workspace import tasks
from app.domain.workspace.models import WorkspaceTask
from app.domain.workspace.schemas import TaskOut


def audience(hub: ChatHub, d: tasks.Directory, row: WorkspaceTask) -> list[str]:
    """Connected people who may see ``row`` right now."""
    fact = tasks.fact(row)
    return [
        uid
        for uid in hub.connected_user_ids()
        if (person := d.people.get(uid)) is not None
        and rules.can_see_task(person, fact, d.project_divisions)
    ]


def task_event(
    hub: ChatHub, d: tasks.Directory, kind: str, out: TaskOut, row: WorkspaceTask
) -> None:
    """``task.created`` or ``task.updated`` to everyone who can see the task, each with their own
    ``my_stage``; and a nudge to read the bell again."""
    fact, members = tasks.fact(row), d.members
    heard = audience(hub, d, row)
    for uid in heard:
        mine = out.model_copy(
            update={"my_stage": rules.approval_stage(d.people[uid], fact, members)}
        )
        hub.send([uid], {"type": kind, "task": mine.model_dump(mode="json")})
    if heard:
        hub.send(heard, {"type": "notifications.refresh"})
