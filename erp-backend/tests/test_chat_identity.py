"""Chat backend C0 — who is in the workspace.

One account is both the ERP login and the chat persona. These tests pin what the database
and the workspace service guarantee about that identity: member numbers are issued once and
never reused, a leader always has a division, and ``chat_member`` lets in only a login that
is both allowed the chat module and in the workspace.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import chat_member
from app.core.errors import Invalid, PermissionDenied
from app.core.rbac import can_do, can_see
from app.domain.chat.workspace import get_member, next_member_no, set_workspace
from app.domain.masters.models import ChatStatus, Role, User, WorkspaceRole
from app.seed.users import add_user

PASSWORD = "a-real-password-for-tests"


async def _user(db: AsyncSession, email: str, role: Role = Role.TEAM) -> User:
    user, _ = await add_user(db, email, "Test Person", role, PASSWORD)
    return user


async def test_the_team_role_sees_chat_and_can_do_nothing_else() -> None:
    assert can_see(Role.TEAM, "chat")
    assert not can_see(Role.TEAM, "finance")
    assert not can_see(Role.TEAM, "dashboard")
    assert not any(can_do(Role.TEAM, a) for a in ("post_journal", "approve_cash", "request_po"))


async def test_member_numbers_are_issued_in_order_and_formatted(db: AsyncSession) -> None:
    first = await next_member_no(db)
    second = await next_member_no(db)
    assert first.startswith("M-") and second.startswith("M-")
    assert int(second[2:]) == int(first[2:]) + 1


async def test_joining_the_workspace_assigns_a_member_number(db: AsyncSession) -> None:
    user = await _user(db, "ws1@oscenia.co.id")
    assert user.member_no is None and user.workspace_role is None

    await set_workspace(
        db, user, workspace_role=WorkspaceRole.STAFF, division="Field", title="Stage Manager"
    )

    assert user.member_no and user.member_no.startswith("M-")
    assert (user.workspace_role, user.division, user.title) == (
        WorkspaceRole.STAFF,
        "Field",
        "Stage Manager",
    )
    assert (await get_member(db, user.member_no)).id == user.id


async def test_leaving_the_workspace_keeps_the_member_number(db: AsyncSession) -> None:
    """A past message says ``<@M-xx>``; the number must keep meaning that person."""
    user = await _user(db, "ws2@oscenia.co.id")
    await set_workspace(db, user, workspace_role=WorkspaceRole.INTERN, division="Design")
    number = user.member_no

    await set_workspace(db, user, workspace_role=None)
    assert user.workspace_role is None and user.member_no == number

    await set_workspace(db, user, workspace_role=WorkspaceRole.STAFF, division="Design")
    assert user.member_no == number


async def test_two_people_never_share_a_member_number(db: AsyncSession) -> None:
    a = await _user(db, "ws3@oscenia.co.id")
    b = await _user(db, "ws4@oscenia.co.id")
    await set_workspace(db, a, workspace_role=WorkspaceRole.STAFF, division="Field")
    await set_workspace(db, b, workspace_role=WorkspaceRole.STAFF, division="Field")
    assert a.member_no != b.member_no


async def test_a_leader_needs_a_division(db: AsyncSession) -> None:
    user = await _user(db, "ws5@oscenia.co.id")
    with pytest.raises(Invalid):
        await set_workspace(db, user, workspace_role=WorkspaceRole.LEADER, division="  ")


async def test_the_database_refuses_a_leader_without_a_division(db: AsyncSession) -> None:
    """The service checks it, but the books survive a caller that skips the service."""
    user = await _user(db, "ws6@oscenia.co.id")
    user.member_no = "M-90"
    user.workspace_role = WorkspaceRole.LEADER
    user.division = None
    with pytest.raises(IntegrityError, match="leader_needs_division"):
        await db.flush()


async def test_the_database_refuses_a_workspace_role_without_a_member_number(
    db: AsyncSession,
) -> None:
    user = await _user(db, "ws7@oscenia.co.id")
    user.workspace_role = WorkspaceRole.STAFF
    user.member_no = None
    with pytest.raises(IntegrityError, match="workspace_needs_member_no"):
        await db.flush()


async def test_the_database_refuses_a_duplicate_member_number(db: AsyncSession) -> None:
    a = await _user(db, "ws8@oscenia.co.id")
    b = await _user(db, "ws9@oscenia.co.id")
    a.member_no = "M-91"
    await db.flush()
    b.member_no = "M-91"
    with pytest.raises(IntegrityError, match="uq_users_member_no"):
        await db.flush()


async def test_a_new_login_starts_online_and_outside_the_workspace(db: AsyncSession) -> None:
    user = await _user(db, "ws10@oscenia.co.id")
    await db.refresh(user)
    assert user.chat_status is ChatStatus.ONLINE
    assert user.workspace_role is None and user.division is None


# --- the ChatMember gate ----------------------------------------------------------------


async def test_chat_member_lets_in_a_login_that_is_in_the_workspace(db: AsyncSession) -> None:
    user = await _user(db, "ws11@oscenia.co.id")
    await set_workspace(db, user, workspace_role=WorkspaceRole.STAFF, division="Field")
    assert await chat_member(user) is user


async def test_chat_member_turns_away_a_login_with_no_workspace_persona(
    db: AsyncSession,
) -> None:
    """Seeing the chat module is not enough: with no persona there is nothing to open."""
    user = await _user(db, "ws12@oscenia.co.id", Role.FINANCE)
    with pytest.raises(PermissionDenied, match="not in the workspace"):
        await chat_member(user)


async def test_chat_member_names_who_to_ask(db: AsyncSession) -> None:
    user = await _user(db, "ws13@oscenia.co.id")
    with pytest.raises(PermissionDenied) as caught:
        await chat_member(user)
    assert "CEO" in caught.value.extra["permitted"]
    assert "Project Manager" in caught.value.extra["permitted"]


async def test_the_pm_can_manage_the_workspace_and_a_team_member_cannot() -> None:
    assert can_do(Role.PM, "manage_workspace") and can_do(Role.CEO, "manage_workspace")
    assert not can_do(Role.TEAM, "manage_workspace")
    assert not can_do(Role.FINANCE, "manage_workspace")


async def test_listing_workspace_members_by_number(db: AsyncSession) -> None:
    user = await _user(db, "ws14@oscenia.co.id")
    await set_workspace(db, user, workspace_role=WorkspaceRole.PM, division="Management")
    found = (
        await db.execute(select(User).where(User.workspace_role.is_not(None)))
    ).scalars().all()
    assert user in found
