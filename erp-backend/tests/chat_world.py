"""The chat test world: people, projects and the helpers every chat test file shares.

Two projects (A: Field + Production, B: Design + Field), a PM, a Field leader (reaches A and
B), a Design leader (reaches B only), a Field staff member on A and a Design intern on B, plus
a finance login with no workspace persona.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.chat import workspace
from app.domain.masters.models import Role, User, WorkspaceRole
from app.seed.users import add_user

PASSWORD = "a-real-password-for-tests"


@dataclass
class World:
    pm: User
    lead_field: User
    lead_design: User
    staff: User
    intern: User
    outsider: User  # a finance login with no workspace persona
    a: str
    b: str


async def _person(
    db: AsyncSession, email: str, role: Role, ws: WorkspaceRole | None, division: str | None
) -> User:
    user, _ = await add_user(db, email, email.split("@")[0].title(), role, PASSWORD)
    if ws is not None:
        await workspace.set_workspace(db, user, workspace_role=ws, division=division)
    return user


@pytest.fixture
async def world(db: AsyncSession, make_project) -> World:  # type: ignore[no-untyped-def]
    pm = await _person(db, "w-pm@oscenia.co.id", Role.PM, WorkspaceRole.PM, "Management")
    lead_field = await _person(db, "w-lf@oscenia.co.id", Role.TEAM, WorkspaceRole.LEADER, "Field")
    lead_design = await _person(db, "w-ld@oscenia.co.id", Role.TEAM, WorkspaceRole.LEADER, "Design")
    staff = await _person(db, "w-st@oscenia.co.id", Role.TEAM, WorkspaceRole.STAFF, "Field")
    intern = await _person(db, "w-in@oscenia.co.id", Role.TEAM, WorkspaceRole.INTERN, "Design")
    outsider = await _person(db, "w-out@oscenia.co.id", Role.FINANCE, None, None)

    a, b = await make_project("Project A"), await make_project("Project B")
    await workspace.set_project_divisions(db, uuid.UUID(a), ["Field", "Production"], actor=pm)
    await workspace.set_project_divisions(db, uuid.UUID(b), ["Design", "Field"], actor=pm)
    await workspace.set_project_members(db, uuid.UUID(a), [staff.id], actor=pm)
    await workspace.set_project_members(db, uuid.UUID(b), [intern.id], actor=pm)
    return World(pm, lead_field, lead_design, staff, intern, outsider, a, b)


async def login(http: AsyncClient, api: str, user: User) -> AsyncClient:
    r = await http.post(f"{api}/auth/login", json={"email": user.email, "password": PASSWORD})
    assert r.status_code == 200, r.text
    http.headers["Authorization"] = f"Bearer {r.json()['access_token']}"
    return http


async def make_channel(http: AsyncClient, api: str, **body: Any) -> dict[str, Any]:
    r = await http.post(f"{api}/chat/channels", json=body)
    assert r.status_code == 201, r.text
    return r.json()


async def bootstrap(http: AsyncClient, api: str) -> dict[str, Any]:
    r = await http.get(f"{api}/chat/bootstrap")
    assert r.status_code == 200, r.text
    return r.json()


def ids(channels: list[dict[str, Any]]) -> set[str]:
    return {c["id"] for c in channels}
