"""Login, refresh and sign-out."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import (
    AuthError,
    hash_password,
    issue_access_token,
    issue_refresh_token,
    needs_rehash,
    verify_password,
)
from app.domain.masters.models import RefreshToken, User


async def _by_email(session: AsyncSession, email: str) -> User | None:
    return (
        await session.execute(select(User).where(User.email == email.strip().lower()))
    ).scalar_one_or_none()


#: An argon2 hash of a value nobody knows, verified against when no account matches so that
#: a miss costs the same time as a hit. Computed once at import.
_DUMMY_HASH = hash_password(uuid.uuid4().hex)


async def authenticate(session: AsyncSession, email: str, password: str) -> User:
    """Verify credentials.

    Every failure returns the same message *and takes the same time*. Both halves matter.

    The identical message stops an attacker learning which addresses have accounts. But
    short-circuiting on ``user is None`` would leak the same fact through timing: argon2
    takes tens of milliseconds, so a missing account would answer in microseconds and a
    real one would not. Verifying against a dummy hash keeps the two indistinguishable.
    """
    user = await _by_email(session, email)
    generic = AuthError("Those credentials are not valid.")

    # Deliberately not short-circuited.
    stored = user.password_hash if user is not None else _DUMMY_HASH
    password_ok = verify_password(password, stored or _DUMMY_HASH)

    if user is None or not password_ok:
        raise generic
    if not user.active:
        # Deliberately the same message: whether an account exists but is disabled is not
        # information an unauthenticated caller is owed.
        raise generic

    # Transparent upgrade if argon2's parameters have moved on since this hash was made.
    if user.password_hash and needs_rehash(user.password_hash):
        user.password_hash = hash_password(password)

    from app.core.clock import get_clock

    user.last_login_at = get_clock().now()
    await session.flush()
    return user


async def issue_tokens(session: AsyncSession, user: User) -> dict[str, object]:
    access, access_expires = issue_access_token(user.id, user.role.value)
    refresh, refresh_expires, jti = issue_refresh_token(user.id)

    session.add(
        RefreshToken(jti=jti, user_id=user.id, expires_at=refresh_expires)
    )
    await session.flush()

    return {
        "access_token": access,
        "refresh_token": refresh,
        "token_type": "bearer",
        "expires_at": access_expires,
        "refresh_expires_at": refresh_expires,
    }


async def rotate(session: AsyncSession, jti: str, user_id: uuid.UUID) -> dict[str, object]:
    """Exchange a refresh token for a new pair, invalidating the old one.

    Rotation is what limits the damage of a stolen refresh token: it is usable once, and
    the legitimate client's next refresh makes the stolen copy worthless.
    """
    record = (
        await session.execute(select(RefreshToken).where(RefreshToken.jti == jti))
    ).scalar_one_or_none()

    if record is None:
        raise AuthError("That session is no longer valid. Sign in again.")

    if record.revoked_at is not None:
        # A refresh token is single-use. Seeing a revoked one again means either a replay
        # of a stolen copy or a client bug, and there is no way to tell which from here —
        # so assume the worse of the two and end every session for this user. The
        # legitimate owner signs in again; a thief loses the foothold.
        await revoke_all(session, record.user_id)
        raise AuthError(
            "That session has already been used. For safety every session has been "
            "signed out — sign in again."
        )
    if record.expires_at <= datetime.now(UTC):
        raise AuthError("That session has expired. Sign in again.")

    user = await session.get(User, user_id)
    if user is None or not user.active:
        raise AuthError("That account is no longer active.")

    record.revoked_at = datetime.now(UTC)
    await session.flush()
    return await issue_tokens(session, user)


async def revoke(session: AsyncSession, jti: str) -> None:
    await session.execute(
        update(RefreshToken)
        .where(RefreshToken.jti == jti, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=datetime.now(UTC))
    )
    await session.flush()


async def revoke_all(session: AsyncSession, user_id: uuid.UUID) -> int:
    """Sign out everywhere — used after a password change or a suspected compromise.

    Returns how many sessions were ended, which is worth surfacing: "signed out of 4 other
    devices" is meaningful to someone who suspects their account was used.
    """
    result = await session.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=datetime.now(UTC))
        .returning(RefreshToken.id)
    )
    revoked = len(result.scalars().all())
    await session.flush()
    return revoked


async def set_password(session: AsyncSession, user: User, password: str) -> None:
    if len(password) < 12:
        from app.core.errors import Invalid

        raise Invalid("A password must be at least 12 characters.")
    user.password_hash = hash_password(password)
    await revoke_all(session, user.id)
    await session.flush()
