"""Account administration: who has a login, what role it has, and how a password is replaced.

There is no email provider yet, so a lost password is handled the way a small company does it:
the CEO issues a one-time reset link and passes it on. The link is a signed token
(``app/core/links.py``) carrying ``users.password_link_version``; using it, or issuing another,
bumps the version, so it works once and a newer link replaces an older one.

Guard rails, because this is the screen that can lock everyone out:

* the last active CEO cannot be demoted or deactivated, and nobody changes their own role or
  deactivates themselves;
* the system user (the ledger's posting identity) is never listed or editable;
* a role or ``active`` change takes effect on the next request (``current_user`` reads both from
  the database), and deactivating also ends every refresh session;
* every change is audited with ids and field names, never a password or a link.
"""

from __future__ import annotations

import secrets
import uuid
from datetime import datetime, timedelta
from typing import Any

from fastapi import Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import links
from app.core.config import get_settings
from app.core.errors import Conflict, Invalid, NotFound
from app.core.security import hash_password, verify_password
from app.domain.audit.service import record_audit, snapshot
from app.domain.auth.service import issue_tokens, revoke_all, set_password
from app.domain.chat.workspace import set_workspace
from app.domain.masters.models import Role, User, WorkspaceRole
from app.seed.chart import SYSTEM_USER_EMAIL

RESET_PURPOSE = "pwreset"
#: What anyone holding a bad link is told: forged, expired, used and revoked look the same.
RESET_REFUSED = "This password link is not valid. Ask your administrator for a new one."
LANGUAGES = ("en", "id")
USER_AUDIT = ("full_name", "role", "active")


def initials_of(full_name: str) -> str:
    parts = [p for p in full_name.split() if p]
    return "".join(p[0] for p in parts[:2]).upper() or "?"


def temporary_password() -> str:
    """A one-time password to hand over: 16 url-safe characters (the minimum is 12)."""
    return secrets.token_urlsafe(12)


async def list_users(session: AsyncSession) -> list[User]:
    rows = await session.execute(
        select(User).where(User.email != SYSTEM_USER_EMAIL).order_by(User.full_name, User.email)
    )
    return list(rows.scalars().all())


async def get_user(session: AsyncSession, user_id: uuid.UUID, *, lock: bool = False) -> User:
    stmt = select(User).where(User.id == user_id, User.email != SYSTEM_USER_EMAIL)
    if lock:
        stmt = stmt.with_for_update()
    user = (await session.execute(stmt)).scalar_one_or_none()
    if user is None:
        raise NotFound("No such user.")
    return user


async def _another_active_ceo_exists(session: AsyncSession, besides: User) -> bool:
    """Whether someone other than ``besides`` is an active CEO. The CEO rows are locked, so two
    simultaneous demotions cannot each see the other as the one left standing."""
    rows = await session.execute(
        select(User.id)
        .where(User.role == Role.CEO, User.active.is_(True), User.email != SYSTEM_USER_EMAIL)
        .with_for_update()
    )
    return any(uid != besides.id for (uid,) in rows.all())


async def create_user(
    session: AsyncSession,
    *,
    email: str,
    full_name: str,
    role: Role,
    actor: User,
    workspace_role: WorkspaceRole | None = None,
    division: str | None = None,
    title: str | None = None,
    request: Request | None = None,
) -> tuple[User, str]:
    """A new login with a temporary password the person must replace. Returns it once."""
    email = email.strip().lower()
    name = " ".join(full_name.split())
    if not name:
        raise Invalid("A user needs a name.")
    if email == SYSTEM_USER_EMAIL:
        raise Invalid("That address is reserved.")
    exists = (await session.execute(select(User.id).where(User.email == email))).first()
    if exists is not None:
        raise Conflict("There is already an account with that email.")

    password = temporary_password()
    user = User(
        email=email, full_name=name, initials=initials_of(name), role=role,
        password_hash=hash_password(password), must_change_password=True,
    )  # fmt: skip
    session.add(user)
    await session.flush()
    if workspace_role is not None:
        await set_workspace(
            session, user, workspace_role=workspace_role, division=division, title=title
        )
    await record_audit(
        session, actor=actor, action="user.create", entity_type="user", entity_id=user.id,
        after={"role": role.value}, detail={"email": email}, request=request,
    )  # fmt: skip
    return user, password


async def update_user(
    session: AsyncSession,
    user_id: uuid.UUID,
    *,
    actor: User,
    full_name: str | None = None,
    role: Role | None = None,
    request: Request | None = None,
) -> User:
    user = await get_user(session, user_id, lock=True)
    before = snapshot(user, USER_AUDIT)
    if role is not None and role != user.role:
        if user.id == actor.id:
            raise Conflict("You cannot change your own role.")
        if user.role == Role.CEO and user.active and not await _another_active_ceo_exists(
            session, user
        ):
            raise Conflict("There must always be one active CEO.")
        user.role = role
    if full_name is not None:
        name = " ".join(full_name.split())
        if not name:
            raise Invalid("A user needs a name.")
        user.full_name, user.initials = name, initials_of(name)
    await session.flush()
    await record_audit(
        session, actor=actor, action="user.update", entity_type="user", entity_id=user.id,
        before=before, after=snapshot(user, USER_AUDIT), request=request,
    )  # fmt: skip
    return user


async def set_active(
    session: AsyncSession,
    user_id: uuid.UUID,
    active: bool,
    *,
    actor: User,
    request: Request | None = None,
) -> User:
    user = await get_user(session, user_id, lock=True)
    if user.active == active:
        return user
    if not active:
        if user.id == actor.id:
            raise Conflict("You cannot deactivate your own account.")
        if user.role == Role.CEO and not await _another_active_ceo_exists(session, user):
            raise Conflict("There must always be one active CEO.")
    user.active = active
    await session.flush()
    if not active:
        await revoke_all(session, user.id)  # no refresh token outlives the account
    await record_audit(
        session, actor=actor, action="user.activate" if active else "user.deactivate",
        entity_type="user", entity_id=user.id, after={"active": active}, request=request,
    )  # fmt: skip
    return user


async def issue_reset_link(
    session: AsyncSession,
    user_id: uuid.UUID,
    *,
    actor: User,
    now: datetime,
    request: Request | None = None,
) -> tuple[str, datetime]:
    """A one-time link to hand to the person. Issuing another replaces this one."""
    user = await get_user(session, user_id, lock=True)
    if not user.active:
        raise Conflict("Reactivate the account before issuing a password link.")
    user.password_link_version += 1
    await session.flush()
    ttl = get_settings().password_reset_hours * 3600
    token = links.issue(
        RESET_PURPOSE, str(user.id), user.password_link_version,
        ttl_seconds=ttl, now=int(now.timestamp()),
    )  # fmt: skip
    await record_audit(
        session, actor=actor, action="user.reset_link", entity_type="user", entity_id=user.id,
        request=request,
    )  # fmt: skip
    return token, now + timedelta(seconds=ttl)


async def complete_reset(
    session: AsyncSession,
    token: str,
    password: str,
    *,
    now: datetime,
    request: Request | None = None,
) -> User:
    """Set a new password with a reset link. Forged, expired, used and revoked links, and links for
    a deactivated account, are one refusal."""
    claim = links.read(RESET_PURPOSE, token, require_expiry=True, now=int(now.timestamp()))
    user = None
    if claim is not None:
        try:
            user = (
                await session.execute(
                    select(User).where(User.id == uuid.UUID(claim.subject)).with_for_update()
                )
            ).scalar_one_or_none()
        except ValueError:
            user = None
    if (
        claim is None
        or user is None
        or not user.active
        or user.email == SYSTEM_USER_EMAIL
        or claim.version != user.password_link_version
    ):
        raise NotFound(RESET_REFUSED)

    await set_password(session, user, password)  # length rule; ends every session
    user.password_link_version += 1  # this link is spent
    user.must_change_password = False
    user.password_changed_at = now
    await session.flush()
    await record_audit(
        session, actor_label=f"password link {user.id}", action="user.password_reset",
        entity_type="user", entity_id=user.id, request=request,
    )  # fmt: skip
    return user


async def change_password(
    session: AsyncSession,
    user: User,
    current: str,
    new: str,
    *,
    now: datetime,
    request: Request | None = None,
) -> dict[str, Any]:
    """The signed-in person replaces their own password. Every other session ends; a fresh token
    pair is returned so this one carries on."""
    if not verify_password(current, user.password_hash):
        raise Invalid("That is not your current password.")
    if new == current:
        raise Invalid("Choose a password you are not already using.")
    await set_password(session, user, new)
    user.must_change_password = False
    user.password_changed_at = now
    await session.flush()
    await record_audit(
        session, actor=user, action="user.change_password", entity_type="user",
        entity_id=user.id, request=request,
    )  # fmt: skip
    return await issue_tokens(session, user)


async def set_language(session: AsyncSession, user: User, language: str) -> User:
    if language not in LANGUAGES:
        raise Invalid("The language must be en or id.")
    user.language = language
    await session.flush()
    return user
