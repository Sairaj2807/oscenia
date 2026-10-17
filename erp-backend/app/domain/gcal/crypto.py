"""Encrypting the stored Google refresh token.

A refresh token lets whoever holds it read (and, with the write scope, change) a person's calendar
until they revoke it, so a database dump must not hand it over. The key lives in the environment
(``GOOGLE_TOKEN_KEY``), never in the database. Generate one with:

    python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
"""

from __future__ import annotations

from cryptography.fernet import Fernet, InvalidToken

from app.core.config import get_settings
from app.core.errors import Conflict


def _fernet() -> Fernet:
    key = get_settings().google_token_key
    if not key:
        raise Conflict("Google Calendar is not set up on this server (no token key).")
    try:
        return Fernet(key.encode())
    except ValueError as err:  # not 32 url-safe base64 bytes
        raise Conflict("The Google token key is malformed; generate a new one.") from err


def encrypt(token: str) -> str:
    return _fernet().encrypt(token.encode()).decode()


def decrypt(stored: str) -> str:
    try:
        return _fernet().decrypt(stored.encode()).decode()
    except InvalidToken as err:
        # The key changed since the token was stored: the connection is unusable, not corrupt.
        raise Conflict("The stored Google connection cannot be read; connect again.") from err
