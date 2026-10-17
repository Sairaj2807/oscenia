"""User administration endpoints (CEO), and the public page that spends a password-reset link."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Header, Request, status
from pydantic import BaseModel, EmailStr, Field

from app.core.clock import ClockDep
from app.core.deps import ManagesUsers
from app.core.errors import TooManyAttempts
from app.core.rbac import ROLE_META
from app.core.schemas import Schema
from app.core.throttle import Throttle
from app.db.session import SessionDep
from app.domain.auth import admin
from app.domain.masters.models import Role, User, WorkspaceRole

users_router = APIRouter(prefix="/users", tags=["users"])
public_router = APIRouter(prefix="/public", tags=["public"])

reset_throttle = Throttle("pub-pwreset", limit=10, window_seconds=60, block_seconds=300)


class UserAdminOut(Schema):
    id: uuid.UUID
    email: str
    full_name: str
    initials: str
    role: Role
    role_label: str
    active: bool
    last_login_at: datetime | None
    must_change_password: bool
    language: str
    member_no: str | None
    workspace_role: WorkspaceRole | None
    division: str | None
    title: str | None


def user_out(u: User) -> UserAdminOut:
    return UserAdminOut(
        id=u.id, email=u.email, full_name=u.full_name, initials=u.initials, role=u.role,
        role_label=ROLE_META[u.role]["label"], active=u.active, last_login_at=u.last_login_at,
        must_change_password=u.must_change_password, language=u.language, member_no=u.member_no,
        workspace_role=u.workspace_role, division=u.division, title=u.title,
    )  # fmt: skip


class UserCreate(BaseModel):
    email: EmailStr
    full_name: str = Field(min_length=1, max_length=120)
    role: Role
    workspace_role: WorkspaceRole | None = None
    division: str | None = Field(default=None, max_length=64)
    title: str | None = Field(default=None, max_length=80)


class UserPatch(BaseModel):
    full_name: str | None = Field(default=None, min_length=1, max_length=120)
    role: Role | None = None


class CreatedUserOut(Schema):
    user: UserAdminOut
    #: Shown once, here. It is not stored in a readable form and cannot be fetched again.
    temporary_password: str


class ResetLinkOut(Schema):
    #: Put it after ``/reset-password#`` on the app's address; it works once.
    token: str
    expires_at: datetime


@users_router.get("", response_model=list[UserAdminOut])
async def list_users(session: SessionDep, user: ManagesUsers) -> list[UserAdminOut]:
    return [user_out(u) for u in await admin.list_users(session)]


@users_router.post("", response_model=CreatedUserOut, status_code=status.HTTP_201_CREATED)
async def create_user(
    session: SessionDep, user: ManagesUsers, body: UserCreate, request: Request
) -> CreatedUserOut:
    """A new login with a temporary password (shown once); the person must change it."""
    created, password = await admin.create_user(
        session, email=body.email, full_name=body.full_name, role=body.role, actor=user,
        workspace_role=body.workspace_role, division=body.division, title=body.title,
        request=request,
    )  # fmt: skip
    return CreatedUserOut(user=user_out(created), temporary_password=password)


@users_router.patch("/{user_id}", response_model=UserAdminOut)
async def update_user(
    session: SessionDep, user: ManagesUsers, user_id: uuid.UUID, body: UserPatch, request: Request
) -> UserAdminOut:
    return user_out(
        await admin.update_user(
            session, user_id, actor=user, full_name=body.full_name, role=body.role,
            request=request,
        )
    )


@users_router.post("/{user_id}/deactivate", response_model=UserAdminOut)
async def deactivate_user(
    session: SessionDep, user: ManagesUsers, user_id: uuid.UUID, request: Request
) -> UserAdminOut:
    return user_out(await admin.set_active(session, user_id, False, actor=user, request=request))


@users_router.post("/{user_id}/activate", response_model=UserAdminOut)
async def activate_user(
    session: SessionDep, user: ManagesUsers, user_id: uuid.UUID, request: Request
) -> UserAdminOut:
    return user_out(await admin.set_active(session, user_id, True, actor=user, request=request))


@users_router.post("/{user_id}/reset-password", response_model=ResetLinkOut)
async def reset_password(
    session: SessionDep, clock: ClockDep, user: ManagesUsers, user_id: uuid.UUID, request: Request
) -> ResetLinkOut:
    """A one-time password link to hand to the person (no email is sent). A new one replaces it."""
    token, expires = await admin.issue_reset_link(
        session, user_id, actor=user, now=clock.now(), request=request
    )
    return ResetLinkOut(token=token, expires_at=expires)


class PasswordReset(BaseModel):
    password: str = Field(min_length=1, max_length=200)


@public_router.post("/password-reset", status_code=status.HTTP_204_NO_CONTENT)
async def password_reset(
    session: SessionDep,
    clock: ClockDep,
    body: PasswordReset,
    request: Request,
    x_reset_token: Annotated[str | None, Header(alias="X-Reset-Token")] = None,
) -> None:
    """Spend a password link. The token travels in a header, not the address; a bad one of any kind
    is the same 404, and guessing is rate limited per caller."""
    keys = [f"ip:{request.client.host if request.client else 'unknown'}"]
    verdict = await reset_throttle.attempt(session, keys)
    await session.commit()  # counted before the refusal, or the limit never trips
    if not verdict.allowed:
        raise TooManyAttempts(
            "Too many tries. Try again shortly.", retry_after=verdict.retry_after
        )
    await admin.complete_reset(
        session, (x_reset_token or "")[:200], body.password, now=clock.now(), request=request
    )
