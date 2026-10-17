"""Authentication endpoints."""

from __future__ import annotations

import hashlib
from datetime import datetime

from fastapi import APIRouter, Request, status
from pydantic import BaseModel, EmailStr, Field

from app.core.clock import ClockDep
from app.core.deps import BearerDep, CurrentUser
from app.core.errors import TooManyAttempts
from app.core.rbac import ROLE_META, permitted_actions, visible_modules
from app.core.schemas import Schema
from app.core.security import decode_token
from app.core.throttle import Throttle, login_throttle
from app.db.session import SessionDep
from app.domain.auth import admin, service
from app.domain.masters.models import Role

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1)


class RefreshRequest(BaseModel):
    refresh_token: str


class TokenPair(Schema):
    access_token: str
    refresh_token: str
    token_type: str
    expires_at: datetime
    refresh_expires_at: datetime


class Me(Schema):
    id: str
    email: str
    full_name: str
    initials: str
    role: Role
    role_label: str

    #: Resolved server-side so the UI never has to reimplement the matrix and drift from it.
    actions: list[str]
    modules: list[str]
    #: The person's screen language, and whether a temporary password still has to be replaced.
    language: str
    must_change_password: bool


def _throttle_keys(request: Request, email: str) -> list[str]:
    """Count attempts against the account *and* the caller.

    Per-account alone lets an attacker spray one common password across a thousand accounts
    and never trip a limit. Per-IP alone lets a botnet grind one account down. Both.

    The address is hashed so the key has a fixed length whatever the e-mail's, and so the
    table holds no list of addresses people tried.
    """
    client = request.client.host if request.client else "unknown"
    account = hashlib.sha256(email.strip().lower().encode()).hexdigest()[:32]
    return [f"email:{account}", f"ip:{client}"]


@router.post("/login", response_model=TokenPair)
async def login(request: Request, session: SessionDep, body: LoginRequest) -> TokenPair:
    """Exchange credentials for an access/refresh pair.

    Every failure returns the same message, whether the account is unknown, the password is
    wrong, or the account is deactivated — distinguishing them would hand out a free
    user-enumeration oracle.

    Repeated failures are **rate limited**. argon2id makes each guess expensive, but expensive
    is not bounded: without a counter an attacker with patience still gets through. The
    lockout is keyed on the account and the caller together, and a correct password clears
    both — two fat-fingered attempts should not leave you one mistake from a lockout.

    The 429 says how long to wait. That is not an information leak: it is returned for an
    unknown address exactly as it is for a real one.
    """
    keys = _throttle_keys(request, body.email)
    # Counted before the password is checked, and committed at once, so parallel guesses
    # queue on the counter instead of all slipping past it (see app/core/throttle.py).
    verdict = await login_throttle.attempt(session, keys)
    await session.commit()
    if not verdict.allowed:
        raise TooManyAttempts(
            "Too many failed sign-in attempts. Try again shortly.",
            retry_after=verdict.retry_after,
        )

    user = await service.authenticate(session, body.email, body.password)
    await login_throttle.clear(session, keys)
    return TokenPair.model_validate(await service.issue_tokens(session, user))


@router.post("/refresh", response_model=TokenPair)
async def refresh(session: SessionDep, body: RefreshRequest) -> TokenPair:
    """Rotate a refresh token for a fresh pair.

    The presented token is revoked as part of the exchange, so a stolen one is usable at
    most once before the legitimate client's next refresh makes it worthless.
    """
    import uuid

    payload = decode_token(body.refresh_token, expect="refresh")
    return TokenPair.model_validate(
        await service.rotate(session, payload["jti"], uuid.UUID(payload["sub"]))
    )


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(session: SessionDep, body: RefreshRequest) -> None:
    """Revoke one refresh token. Idempotent — signing out twice is not an error."""
    payload = decode_token(body.refresh_token, expect="refresh")
    await service.revoke(session, payload["jti"])


@router.post("/logout-everywhere", status_code=status.HTTP_204_NO_CONTENT)
async def logout_everywhere(session: SessionDep, user: CurrentUser) -> None:
    """Revoke every refresh token for the signed-in user."""
    await service.revoke_all(session, user.id)


@router.get("/me", response_model=Me)
async def me(user: CurrentUser) -> Me:
    """Who you are, and what you may do.

    ``actions`` and ``modules`` are resolved from the matrix server-side. The frontend uses
    them to gate its UI without reimplementing the policy, so the two cannot drift.
    """
    return Me(
        id=str(user.id),
        email=user.email,
        full_name=user.full_name,
        initials=user.initials,
        role=user.role,
        role_label=ROLE_META[user.role]["label"],
        actions=permitted_actions(user.role),
        modules=visible_modules(user.role),
        language=user.language,
        must_change_password=user.must_change_password,
    )


class PasswordChange(BaseModel):
    current_password: str = Field(min_length=1, max_length=200)
    new_password: str = Field(min_length=1, max_length=200)


#: Verifying a password is what a thief with a stolen session would do to take the account over.
change_password_throttle = Throttle(
    "auth-change-pw", limit=5, window_seconds=300, block_seconds=900
)


@router.post("/change-password", response_model=TokenPair)
async def change_password(
    request: Request, session: SessionDep, clock: ClockDep, user: CurrentUser, body: PasswordChange
) -> TokenPair:
    """Replace your own password. Every other session is signed out; you get a fresh pair so this
    one carries on. A wrong current password is counted, and too many are refused for a while."""
    verdict = await change_password_throttle.attempt(session, [f"user:{user.id}"])
    await session.commit()
    if not verdict.allowed:
        raise TooManyAttempts(
            "Too many attempts. Try again shortly.", retry_after=verdict.retry_after
        )
    pair = await admin.change_password(
        session, user, body.current_password, body.new_password, now=clock.now(), request=request
    )
    await change_password_throttle.clear(session, [f"user:{user.id}"])
    return TokenPair.model_validate(pair)


class Preferences(BaseModel):
    language: str = Field(min_length=2, max_length=5)


@router.patch("/me/preferences", response_model=Me)
async def set_preferences(session: SessionDep, user: CurrentUser, body: Preferences) -> Me:
    """The person's own settings (today: the screen language)."""
    await admin.set_language(session, user, body.language)
    return await me(user)


__all__ = ["BearerDep", "router"]
