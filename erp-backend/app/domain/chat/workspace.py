"""Putting a login into the workspace: a member number, a division and a workspace role.

One account is both the ERP login and the chat persona, so this is the only place that
decides who is *in* the workspace. ``member_no`` (``M-05``) is what stored message text
refers to, so it is handed out once from a sequence and never reused or edited — an old
mention can then never point at someone else.
"""

from __future__ import annotations

import uuid

from fastapi import Request
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Invalid, NotFound
from app.domain.ar.models import Project
from app.domain.audit.service import record_audit
from app.domain.chat.rules import DIVISIONS
from app.domain.masters.models import ProjectDivision, ProjectMember, User, WorkspaceRole


async def next_member_no(session: AsyncSession) -> str:
    """``M-01``, ``M-02`` … from ``member_no_seq``. A sequence is not rolled back, so a number
    used in a failed transaction is simply skipped, never issued twice."""
    n = (await session.execute(select(func.nextval("member_no_seq")))).scalar_one()
    return f"M-{n:02d}"


async def set_workspace(
    session: AsyncSession,
    user: User,
    *,
    workspace_role: WorkspaceRole | None,
    division: str | None = None,
    title: str | None = None,
) -> User:
    """Put ``user`` in the workspace, change their place in it, or (``None``) take them out.

    Taking someone out keeps their ``member_no``: their past messages and mentions still
    name them, and the number must never be handed to anyone else.
    """
    division = (division or "").strip() or None
    if workspace_role is WorkspaceRole.LEADER and division is None:
        raise Invalid("A division leader needs a division.")

    user.workspace_role = workspace_role
    user.division = division
    user.title = (title or "").strip() or None
    if workspace_role is not None and user.member_no is None:
        user.member_no = await next_member_no(session)
    await session.flush()
    return user


async def get_member(session: AsyncSession, member_no: str) -> User:
    user = (
        await session.execute(select(User).where(User.member_no == member_no))
    ).scalar_one_or_none()
    if user is None:
        raise NotFound(f"There is no team member {member_no}.")
    return user


async def _project(session: AsyncSession, project_id: uuid.UUID) -> Project:
    project = await session.get(Project, project_id)
    if project is None:
        raise NotFound("There is no such project.")
    return project


async def set_project_divisions(
    session: AsyncSession,
    project_id: uuid.UUID,
    divisions: list[str],
    *,
    actor: User,
    request: Request | None = None,
) -> list[str]:
    """The divisions that work on a project (the PM assigns these). A division leader reaches
    a project through this list, so changing it changes which channels they can open."""
    project = await _project(session, project_id)
    unknown = [d for d in divisions if d not in DIVISIONS]
    if unknown:
        raise Invalid(
            f"Unknown division(s): {', '.join(unknown)}. Choose from {', '.join(DIVISIONS)}."
        )
    wanted = list(dict.fromkeys(divisions))
    before = sorted(
        (
            await session.execute(
                select(ProjectDivision.division).where(ProjectDivision.project_id == project.id)
            )
        ).scalars()
    )
    await session.execute(delete(ProjectDivision).where(ProjectDivision.project_id == project.id))
    for d in wanted:
        session.add(ProjectDivision(project_id=project.id, division=d))
    await session.flush()
    await record_audit(
        session, actor=actor, action="chat.project.divisions", entity_type="project",
        entity_id=project.id, before={"divisions": before}, after={"divisions": sorted(wanted)},
        request=request,
    )  # fmt: skip
    return sorted(wanted)


async def set_project_members(
    session: AsyncSession,
    project_id: uuid.UUID,
    user_ids: list[uuid.UUID],
    *,
    actor: User,
    request: Request | None = None,
) -> list[uuid.UUID]:
    """The staff and interns named on a project. Leaders follow their division and the PM sees
    every project, so neither is listed here."""
    project = await _project(session, project_id)
    wanted = list(dict.fromkeys(user_ids))
    users = (
        (await session.execute(select(User).where(User.id.in_(wanted)))).scalars().all()
        if wanted
        else []
    )
    found = {u.id: u for u in users}
    for uid in wanted:
        u = found.get(uid)
        if u is None or not u.active:
            raise NotFound(f"There is no active team member {uid}.")
        if u.workspace_role not in (WorkspaceRole.STAFF, WorkspaceRole.INTERN):
            raise Invalid(
                f"{u.full_name} is not staff or an intern: leaders follow their division and "
                "the project manager sees every project."
            )
    before = sorted(
        str(x)
        for x in (
            await session.execute(
                select(ProjectMember.user_id).where(ProjectMember.project_id == project.id)
            )
        ).scalars()
    )
    await session.execute(delete(ProjectMember).where(ProjectMember.project_id == project.id))
    for uid in wanted:
        session.add(ProjectMember(project_id=project.id, user_id=uid))
    await session.flush()
    await record_audit(
        session, actor=actor, action="chat.project.members", entity_type="project",
        entity_id=project.id, before={"user_ids": before},
        after={"user_ids": sorted(str(x) for x in wanted)}, request=request,
    )  # fmt: skip
    return wanted
