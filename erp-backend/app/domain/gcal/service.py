"""Connecting a person's Google Calendar, showing their events, and writing CRM dates to it.

Three rules shape this:

* **A person's calendar is theirs.** One connection per user, a refresh token stored encrypted,
  never returned by any endpoint. Disconnecting revokes it at Google and forgets it here.
* **The narrowest permission that does the job.** Showing events needs read-only access; writing
  CRM dates back needs the wider scope, which is only asked for when the person chooses it. The
  option to push dates
  is refused while only the read scope was granted.
* **Writing back is idempotent.** Each date is written once per year (``google_synced_dates``), so
  running the sync every day adds nothing after the first time.
"""

from __future__ import annotations

import contextlib
import time as _time
import uuid
from datetime import UTC, date, datetime
from typing import Any
from urllib.parse import urlencode

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import Conflict, Invalid, NotFound
from app.core.signing import sign, verify
from app.domain.ar.models import Client
from app.domain.gcal import crypto
from app.domain.gcal.google import (
    AUTH_URL,
    SCOPE_IDENTITY,
    SCOPE_READ,
    SCOPE_WRITE,
    GoogleError,
    get_google_api,
)
from app.domain.gcal.models import GoogleConnection, GoogleSyncedDate
from app.domain.masters.models import User

STATE_SECONDS = 600  # the sign-in at Google has ten minutes to come back
SYNC_HORIZON_DAYS = 60
_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]


def configured() -> bool:
    s = get_settings()
    return bool(
        s.google_client_id
        and s.google_client_secret
        and s.google_redirect_uri
        and s.google_token_key
    )


def _require_configured() -> None:
    if not configured():
        raise Conflict(
            "Google Calendar is not set up on this server yet: it needs the Google client id and "
            "secret, the redirect address and a token key."
        )


# --- the state that carries a sign-in out to Google and back ---------------------------------


def _make_state(user_id: uuid.UUID, write: bool, now: float | None = None) -> str:
    expires = int((now if now is not None else _time.time()) + STATE_SECONDS)
    flag = "w" if write else "r"
    return f"{user_id}.{expires}.{flag}.{sign('google-state', str(user_id), str(expires), flag)}"


def _read_state(state: str, now: float | None = None) -> tuple[uuid.UUID, bool]:
    try:
        user_part, expires, flag, signature = state.split(".", 3)
        user_id = uuid.UUID(user_part)
    except ValueError as err:
        raise Invalid("That Google sign-in did not start here.") from err
    if flag not in {"r", "w"} or not verify(signature, "google-state", user_part, expires, flag):
        raise Invalid("That Google sign-in did not start here.")
    if (now if now is not None else _time.time()) > int(expires):
        raise Invalid("That Google sign-in took too long; start again.")
    return user_id, flag == "w"


# --- status, connecting, disconnecting ---------------------------------------------------------


async def get_connection(session: AsyncSession, user: User) -> GoogleConnection | None:
    return await session.get(GoogleConnection, user.id)


def can_write(connection: GoogleConnection) -> bool:
    return SCOPE_WRITE in connection.scopes.split()


def connect_url(user: User, *, write: bool) -> str:
    _require_configured()
    s = get_settings()
    scopes = f"{SCOPE_IDENTITY} {SCOPE_WRITE if write else SCOPE_READ}"
    return (
        AUTH_URL
        + "?"
        + urlencode(
            {
                "client_id": s.google_client_id,
                "redirect_uri": s.google_redirect_uri,
                "response_type": "code",
                "scope": scopes,
                # Offline access plus a forced consent screen is what makes Google hand back a
                # refresh
                # token every time, not just the first time this person ever connected.
                "access_type": "offline",
                "prompt": "consent",
                "state": _make_state(user.id, write),
            }
        )
    )


async def complete_connection(
    session: AsyncSession, *, state: str, code: str, now: float | None = None
) -> GoogleConnection:
    """Finish the sign-in: swap the code for tokens and keep the refresh token, encrypted."""
    _require_configured()
    user_id, _ = _read_state(state, now)
    if await session.get(User, user_id) is None:
        raise NotFound("That sign-in belongs to someone who no longer exists.")
    api = get_google_api()
    try:
        tokens = await api.exchange_code(code)
        refresh = tokens.get("refresh_token")
        if not refresh:
            raise Invalid(
                "Google did not return a long-lived token. Remove this app's access in your "
                "Google account (myaccount.google.com/permissions) and connect again."
            )
        email = await api.userinfo(str(tokens["access_token"]))
    except GoogleError as err:
        raise Conflict(f"Google refused the sign-in: {err.message}") from err

    connection = await session.get(GoogleConnection, user_id)
    if connection is None:
        connection = GoogleConnection(user_id=user_id)
        session.add(connection)
    connection.account_email = email
    connection.refresh_token_enc = crypto.encrypt(str(refresh))
    connection.scopes = str(tokens.get("scope", ""))
    # Reconnecting with only the read scope switches writing back off: it would be refused anyway.
    if not can_write(connection):
        connection.add_crm_dates = False
    await session.flush()
    return connection


async def disconnect(session: AsyncSession, user: User) -> None:
    connection = await get_connection(session, user)
    if connection is None:
        return
    # Already revoked at Google's end, or the key changed: forgetting it here is the point.
    with contextlib.suppress(GoogleError, Conflict):
        await get_google_api().revoke(crypto.decrypt(connection.refresh_token_enc))
    await session.execute(delete(GoogleSyncedDate).where(GoogleSyncedDate.user_id == user.id))
    await session.delete(connection)
    await session.flush()


async def set_options(
    session: AsyncSession, user: User, *, show_google: bool | None, add_crm_dates: bool | None
) -> GoogleConnection:
    connection = await get_connection(session, user)
    if connection is None:
        raise Conflict("Connect a Google account first.")
    if show_google is not None:
        connection.show_google = show_google
    if add_crm_dates is not None:
        if add_crm_dates and not can_write(connection):
            raise Conflict(
                "Adding CRM dates to Google needs permission to add events. "
                "Connect again and allow it."
            )
        connection.add_crm_dates = add_crm_dates
    await session.flush()
    return connection


# --- talking to Google as this person --------------------------------------------------------


async def _access_token(session: AsyncSession, connection: GoogleConnection) -> str:
    try:
        return await get_google_api().refresh(crypto.decrypt(connection.refresh_token_enc))
    except GoogleError as err:
        if err.status in {400, 401}:
            # Revoked at Google (or expired for good). Keeping a dead connection would make every
            # screen fail the same way, so it is dropped and the person is asked to connect again.
            await session.delete(connection)
            await session.flush()
            raise Conflict("Google no longer accepts this connection; connect again.") from err
        raise Conflict(f"Google could not be reached: {err.message}") from err


async def events_between(
    session: AsyncSession, user: User, start: date, end: date
) -> list[dict[str, Any]]:
    if end < start:
        raise Invalid("The end of the range is before its start.")
    connection = await get_connection(session, user)
    if connection is None:
        raise Conflict("Connect a Google account first.")
    token = await _access_token(session, connection)
    try:
        return await get_google_api().list_events(token, start, end)
    except GoogleError as err:
        raise Conflict(f"Google could not list events: {err.message}") from err


# --- writing CRM dates to the calendar --------------------------------------------------------


def next_occurrence(stored: str | None, today: date) -> date | None:
    """The next time a client's free-text date ("28 Jul", "14 Mar 1975") falls, or ``None``.

    Read loosely, as the daily milestone scan does: a day and a month name are all it needs.
    29 Feb is
    skipped in a year without one rather than moved.
    """
    if not stored:
        return None
    parts = stored.split()
    if len(parts) < 2:
        return None
    try:
        day = int(parts[0])
        month = _MONTHS.index(parts[1][:3].lower()) + 1
    except ValueError:
        return None
    for year in (today.year, today.year + 1):
        try:
            candidate = date(year, month, day)
        except ValueError:
            continue
        if candidate >= today:
            return candidate
    return None


async def sync_crm_dates(session: AsyncSession, user: User, *, today: date) -> dict[str, Any]:
    """Write the next 60 days of client birthdays and anniversaries to this person's calendar.

    Each is written once per year. Returns what happened, so the screen can say so.
    """
    connection = await get_connection(session, user)
    if connection is None:
        raise Conflict("Connect a Google account first.")
    if not connection.add_crm_dates:
        raise Conflict("Turn on 'Add CRM dates to my Google Calendar' first.")
    if not can_write(connection):
        raise Conflict("Connect again and allow adding events.")

    due: list[tuple[str, str, date]] = []
    clients = (await session.execute(select(Client).order_by(Client.client_no))).scalars().all()
    for client in clients:
        for stored, kind, label in (
            (client.birthday, "birthday", "Birthday"),
            (client.anniversary, "anniversary", "Anniversary"),
        ):
            when = next_occurrence(stored, today)
            if when is None or (when - today).days > SYNC_HORIZON_DAYS:
                continue
            due.append((f"{client.client_no}:{kind}:{when.year}", f"{label} — {client.name}", when))

    already = set(
        (
            await session.execute(
                select(GoogleSyncedDate.key).where(GoogleSyncedDate.user_id == user.id)
            )
        ).scalars()
    )
    token = await _access_token(session, connection)
    api = get_google_api()
    added = 0
    error: str | None = None
    for key, summary, when in due:
        if key in already:
            continue
        try:
            event_id = await api.create_all_day_event(
                token, summary=summary, day=when, private_key=key
            )
        except GoogleError as err:
            # Stop and report, rather than raise: raising would roll back the record of the events
            # already written, and the next sync would write them a second time.
            error = f"Google refused an event: {err.message}"
            break
        session.add(
            GoogleSyncedDate(
                user_id=user.id,
                key=key,
                google_event_id=event_id,
                synced_at=datetime.now(UTC),
            )
        )
        added += 1
    await session.flush()
    return {
        "added": added,
        "already_there": len(due) - added - (1 if error else 0),
        "considered": len(due),
        "error": error,
    }
