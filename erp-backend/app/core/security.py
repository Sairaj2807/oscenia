"""Password hashing and JWT issue/verify.

argon2id for passwords — memory-hard, so a leaked hash table is expensive to attack even
with GPUs, which is not true of bcrypt at default cost or of anything SHA-based.

Two token types, deliberately asymmetric:

* an **access** token, short-lived (30 minutes), sent on every request
* a **refresh** token, long-lived (14 days), carrying nothing but the subject and a token
  id, checked against the database so it can be revoked, and single-use

The access token carries a ``role`` claim for convenience, but **authorisation does not
trust it**: ``current_user`` loads the user from the database on every request and
``require_action`` checks ``user.role``. So changing a role or deactivating an account takes
effect on the very next request, not at the next refresh. The claim is there for logging and
for a client that wants a hint without a round-trip.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError

from app.core.config import get_settings
from app.core.errors import DomainError

_hasher = PasswordHasher()

TokenType = Literal["access", "refresh"]


class AuthError(DomainError):
    status = 401
    slug = "unauthenticated"
    title = "Not authenticated"


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, hashed: str | None) -> bool:
    """False rather than raising, so a missing hash and a wrong password look identical.

    A user seeded without a password (the system account, for instance) must not be
    loggable-in, and must not be distinguishable from a wrong guess.
    """
    if not hashed:
        return False
    try:
        return _hasher.verify(hashed, password)
    except (VerifyMismatchError, InvalidHashError):
        return False


def needs_rehash(hashed: str) -> bool:
    """True when argon2's parameters have moved on since this hash was made."""
    try:
        return _hasher.check_needs_rehash(hashed)
    except InvalidHashError:
        return False


def _encode(
    subject: uuid.UUID, token_type: TokenType, lifetime: timedelta, **claims: Any
) -> tuple[str, datetime]:
    settings = get_settings()
    now = datetime.now(UTC)
    expires = now + lifetime
    payload: dict[str, Any] = {
        "sub": str(subject),
        "typ": token_type,
        "iat": int(now.timestamp()),
        "exp": int(expires.timestamp()),
        "jti": uuid.uuid4().hex,
        **claims,
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm), expires


def issue_access_token(user_id: uuid.UUID, role: str) -> tuple[str, datetime]:
    settings = get_settings()
    return _encode(
        user_id, "access", timedelta(minutes=settings.access_token_minutes), role=role
    )


def issue_refresh_token(user_id: uuid.UUID) -> tuple[str, datetime, str]:
    """Returns ``(token, expiry, jti)``. The jti is what the database records."""
    settings = get_settings()
    token, expires = _encode(user_id, "refresh", timedelta(days=settings.refresh_token_days))
    jti = decode_token(token, expect="refresh")["jti"]
    return token, expires, jti


def decode_token(token: str, *, expect: TokenType) -> dict[str, Any]:
    settings = get_settings()
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except jwt.ExpiredSignatureError as exc:
        raise AuthError("That session has expired. Sign in again.") from exc
    except jwt.InvalidTokenError as exc:
        raise AuthError("That token is not valid.") from exc

    if payload.get("typ") != expect:
        # A refresh token presented as a bearer credential would otherwise grant access for
        # its whole long lifetime, defeating the point of splitting the two.
        raise AuthError(f"Expected a {expect} token.")

    return payload
