"""Workspace backend T0 — who may use the workspace, and what a project card carries.

The workspace (tasks) is gated like chat: the ``workspace`` module for the login's role, then a
workspace persona for what they may see and do. The chat bootstrap carries the project cards the
workspace pages draw, so a team member — who has no finance data — still sees who a project is
for, when, where it stands and who is in charge, and never its money.
"""

from __future__ import annotations

import uuid
from datetime import date
from typing import Any

import pytest
from chat_world import World, bootstrap, login, world  # noqa: F401
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import workspace_member
from app.core.errors import PermissionDenied
from app.core.rbac import can_see, visible_modules
from app.domain.ar.models import Project
from app.domain.masters.models import Role, User, WorkspaceRole


def person(role: Role, *, ws: WorkspaceRole | None, no: str | None) -> User:
    return User(
        email="x@oscenia.co.id", full_name="X", initials="X", role=role, password_hash="-",
        workspace_role=ws, member_no=no,
    )  # fmt: skip


# --- the gate ---------------------------------------------------------------------------


def test_the_workspace_module_is_open_to_every_role_and_the_persona_decides() -> None:
    """Like chat: a Sales login can be a Field leader, so the module cannot gate on role."""
    assert all(can_see(role, "workspace") for role in Role)
    assert "workspace" in visible_modules(Role.TEAM) and "workspace" in visible_modules(Role.SALES)


async def test_a_login_in_the_workspace_passes() -> None:
    pm = person(Role.PM, ws=WorkspaceRole.PM, no="M-01")
    team = person(Role.TEAM, ws=WorkspaceRole.STAFF, no="M-05")
    assert await workspace_member(pm) is pm
    assert await workspace_member(team) is team


@pytest.mark.parametrize("role", list(Role))
async def test_any_role_with_a_persona_passes(role: Role) -> None:
    sales_leader = person(role, ws=WorkspaceRole.LEADER, no="M-02")
    assert await workspace_member(sales_leader) is sales_leader


@pytest.mark.parametrize("role", list(Role))
async def test_a_login_with_no_persona_is_told_who_to_ask(role: Role) -> None:
    with pytest.raises(PermissionDenied) as err:
        await workspace_member(person(role, ws=None, no=None))
    assert "not in the workspace" in str(err.value)


# --- project cards ----------------------------------------------------------------------


async def test_the_bootstrap_carries_the_project_card_without_any_money(
    anon_client: AsyncClient, api: str, world: World, db: AsyncSession
) -> None:
    project = await db.get(Project, uuid.UUID(world.a))
    assert project is not None
    project.pm_user_id, project.event_date = world.pm.id, date(2026, 8, 14)
    await db.flush()

    await login(anon_client, api, world.staff)  # a team member on project A
    boot = await bootstrap(anon_client, api)
    [card] = [p for p in boot["projects"] if p["id"] == world.a]
    assert card["pm_name"] == world.pm.full_name
    assert card["event_date"] == "2026-08-14" and card["client_name"]
    assert card["stage"] and card["project_no"]
    assert set(card) == {
        "id", "project_no", "name", "divisions", "client_name", "event_date", "stage", "pm_name",
    }  # fmt: skip


async def test_a_project_with_no_pm_or_date_on_file_says_so_with_nulls(
    anon_client: AsyncClient, api: str, world: World
) -> None:
    await login(anon_client, api, world.staff)
    boot: dict[str, Any] = await bootstrap(anon_client, api)
    [card] = [p for p in boot["projects"] if p["id"] == world.a]
    assert card["pm_name"] is None and card["event_date"] is None
