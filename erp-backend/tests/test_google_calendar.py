"""Backlog item 8 — Google Calendar.

Nothing here reaches Google: ``FakeGoogle`` is installed in place of the HTTP client. What is pinned
is what this server owns: the signed sign-in state, that the refresh token is stored encrypted and
never returned, that the wider "add events" permission is only used when it was granted, and that
writing CRM dates back adds each one once.
"""

from __future__ import annotations

import time
import uuid
from collections.abc import Iterator
from datetime import date
from typing import Any
from urllib.parse import parse_qs, urlparse

import pytest
from cryptography.fernet import Fernet
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import Invalid
from app.domain.gcal import service
from app.domain.gcal.google import SCOPE_READ, SCOPE_WRITE, GoogleError, set_google_api
from app.domain.gcal.models import GoogleConnection, GoogleSyncedDate

JULY = {"start": "2026-07-01", "end": "2026-07-31"}


class FakeGoogle:
    def __init__(self) -> None:
        self.scope = f"openid email {SCOPE_READ}"
        self.refresh_token: str | None = "refresh-secret-1"
        self.created: list[dict[str, Any]] = []
        self.revoked: list[str] = []
        self.refresh_error: GoogleError | None = None
        self.create_fail_after: int | None = None
        self.events: list[dict[str, Any]] = [
            {
                "id": "e1",
                "title": "Site visit",
                "date": "2026-07-30",
                "all_day": False,
                "time": "09:30",
            }
        ]

    async def exchange_code(self, code: str) -> dict[str, Any]:
        out: dict[str, Any] = {"access_token": "acc", "scope": self.scope}
        if self.refresh_token:
            out["refresh_token"] = self.refresh_token
        return out

    async def refresh(self, refresh_token: str) -> str:
        if self.refresh_error:
            raise self.refresh_error
        assert refresh_token == "refresh-secret-1"
        return "acc"

    async def userinfo(self, access_token: str) -> str:
        return "ceo@example.com"

    async def list_events(self, access_token: str, start: date, end: date) -> list[dict[str, Any]]:
        return self.events

    async def create_all_day_event(
        self, access_token: str, *, summary: str, day: date, private_key: str
    ) -> str:
        if self.create_fail_after is not None and len(self.created) >= self.create_fail_after:
            raise GoogleError(403, "quota")
        self.created.append({"summary": summary, "day": day, "key": private_key})
        return f"gev-{len(self.created)}"

    async def revoke(self, token: str) -> None:
        self.revoked.append(token)


@pytest.fixture
def google(monkeypatch: pytest.MonkeyPatch) -> Iterator[FakeGoogle]:
    settings = get_settings()
    monkeypatch.setattr(settings, "google_client_id", "client-id")
    monkeypatch.setattr(settings, "google_client_secret", "client-secret")
    monkeypatch.setattr(settings, "google_redirect_uri", "http://test/api/v1/google/callback")
    monkeypatch.setattr(settings, "google_token_key", Fernet.generate_key().decode())
    fake = FakeGoogle()
    set_google_api(fake)
    yield fake
    set_google_api(None)


async def _connect(client: AsyncClient, api: str, *, write: bool = False) -> None:
    url = (await client.get(f"{api}/google/connect", params={"write": write})).json()["url"]
    state = parse_qs(urlparse(url).query)["state"][0]
    r = await client.get(f"{api}/google/callback", params={"code": "c", "state": state})
    assert r.status_code == 307 and "google=connected" in r.headers["location"], r.headers


async def _client_with_dates(client: AsyncClient, api: str, **dates: str) -> None:
    r = await client.post(f"{api}/clients", json={"name": "Aurora Bank", **dates})
    assert r.status_code == 201, r.text


async def test_status_says_when_the_server_is_not_set_up(client: AsyncClient, api: str) -> None:
    s = (await client.get(f"{api}/google/status")).json()
    assert s["configured"] is False and s["connected"] is False
    # And connecting says why, instead of sending the person to a broken Google page.
    assert (await client.get(f"{api}/google/connect")).status_code == 409


async def test_the_google_routes_need_a_login(anon_client: AsyncClient, api: str) -> None:
    for path in ("/google/status", "/google/events?start=2026-07-01&end=2026-07-31"):
        assert (await anon_client.get(f"{api}{path}")).status_code == 401


async def test_connect_asks_only_for_read_access_unless_writing_is_chosen(
    client: AsyncClient, api: str, google: FakeGoogle
) -> None:
    read = (await client.get(f"{api}/google/connect")).json()["url"]
    write = (await client.get(f"{api}/google/connect", params={"write": True})).json()["url"]
    read_scope = parse_qs(urlparse(read).query)["scope"][0]
    write_scope = parse_qs(urlparse(write).query)["scope"][0]
    assert SCOPE_READ in read_scope and SCOPE_WRITE not in read_scope.split()
    assert SCOPE_WRITE in write_scope.split()
    assert parse_qs(urlparse(read).query)["access_type"] == ["offline"]


async def test_connecting_stores_the_token_encrypted_and_never_returns_it(
    client: AsyncClient, api: str, google: FakeGoogle, db: AsyncSession
) -> None:
    await _connect(client, api)
    status = (await client.get(f"{api}/google/status")).json()
    assert status == {
        "configured": True,
        "connected": True,
        "account": "ceo@example.com",
        "can_write": False,
        "show_google": True,
        "add_crm_dates": False,
    }
    row = (await db.execute(select(GoogleConnection))).scalar_one()
    assert "refresh-secret-1" not in row.refresh_token_enc
    assert "refresh-secret-1" not in str(status)


async def test_a_sign_in_that_was_not_started_here_is_refused(
    client: AsyncClient, api: str, google: FakeGoogle
) -> None:
    for state in ("", "garbage", f"{uuid.uuid4()}.9999999999.r.forged"):
        r = await client.get(f"{api}/google/callback", params={"code": "c", "state": state})
        assert r.status_code == 307 and "google=failed" in r.headers["location"]
    assert (await client.get(f"{api}/google/status")).json()["connected"] is False


async def test_a_state_expires_after_ten_minutes(user: Any, google: FakeGoogle) -> None:
    state = service._make_state(user.id, False, now=time.time() - 3600)
    with pytest.raises(Invalid):
        service._read_state(state)
    assert service._read_state(service._make_state(user.id, True)) == (user.id, True)


async def test_declining_at_google_returns_to_the_app_without_connecting(
    client: AsyncClient, api: str, google: FakeGoogle
) -> None:
    r = await client.get(f"{api}/google/callback", params={"error": "access_denied"})
    assert r.status_code == 307 and "google=declined" in r.headers["location"]


async def test_no_refresh_token_from_google_means_no_connection(
    client: AsyncClient, api: str, google: FakeGoogle
) -> None:
    google.refresh_token = None
    url = (await client.get(f"{api}/google/connect")).json()["url"]
    state = parse_qs(urlparse(url).query)["state"][0]
    r = await client.get(f"{api}/google/callback", params={"code": "c", "state": state})
    assert "google=failed" in r.headers["location"]
    assert (await client.get(f"{api}/google/status")).json()["connected"] is False


async def test_events_come_back_for_the_connected_person(
    client: AsyncClient, api: str, google: FakeGoogle
) -> None:
    assert (
        await client.get(f"{api}/google/events", params=JULY)
    ).status_code == 409  # not connected yet
    await _connect(client, api)
    r = await client.get(f"{api}/google/events", params=JULY)
    assert r.status_code == 200 and r.json()[0]["title"] == "Site visit"
    backwards = await client.get(
        f"{api}/google/events", params={"start": "2026-07-31", "end": "2026-07-01"}
    )
    assert backwards.status_code == 422 or backwards.status_code == 400


async def test_adding_crm_dates_needs_the_wider_permission(
    client: AsyncClient, api: str, google: FakeGoogle
) -> None:
    await _connect(client, api)  # read only
    r = await client.put(f"{api}/google/options", json={"add_crm_dates": True})
    assert r.status_code == 409
    assert (await client.put(f"{api}/google/options", json={"show_google": False})).json()[
        "show_google"
    ] is False

    google.scope = f"openid email {SCOPE_WRITE}"
    await _connect(client, api, write=True)
    r = await client.put(f"{api}/google/options", json={"add_crm_dates": True})
    assert r.status_code == 200 and r.json()["add_crm_dates"] is True and r.json()["can_write"]

    # Reconnecting with read only switches writing back off rather than leaving it dangling.
    google.scope = f"openid email {SCOPE_READ}"
    await _connect(client, api)
    assert (await client.get(f"{api}/google/status")).json()["add_crm_dates"] is False


async def _ready_to_sync(client: AsyncClient, api: str, google: FakeGoogle) -> None:
    google.scope = f"openid email {SCOPE_WRITE}"
    await _connect(client, api, write=True)
    await client.put(f"{api}/google/options", json={"add_crm_dates": True})


async def test_sync_writes_each_upcoming_date_once(
    client: AsyncClient, api: str, google: FakeGoogle, db: AsyncSession
) -> None:
    # The app clock is 26 Jul 2026: the birthday is two days off, the anniversary is out of range.
    await _client_with_dates(client, api, birthday="28 Jul", anniversary="3 Jan 2010")
    await _ready_to_sync(client, api, google)

    first = (await client.post(f"{api}/google/sync-crm-dates")).json()
    assert first == {"added": 1, "already_there": 0, "considered": 1, "error": None}
    assert [c["day"] for c in google.created] == [date(2026, 7, 28)]
    assert google.created[0]["summary"] == "Birthday — Aurora Bank"

    again = (await client.post(f"{api}/google/sync-crm-dates")).json()
    assert again == {"added": 0, "already_there": 1, "considered": 1, "error": None}
    assert len(google.created) == 1
    assert len((await db.execute(select(GoogleSyncedDate))).scalars().all()) == 1


async def test_sync_is_refused_unless_switched_on(
    client: AsyncClient, api: str, google: FakeGoogle
) -> None:
    assert (await client.post(f"{api}/google/sync-crm-dates")).status_code == 409  # no connection
    await _connect(client, api)
    assert (await client.post(f"{api}/google/sync-crm-dates")).status_code == 409  # switched off


async def test_a_failure_part_way_keeps_what_was_written_and_says_so(
    client: AsyncClient, api: str, google: FakeGoogle, db: AsyncSession
) -> None:
    await _client_with_dates(client, api, birthday="28 Jul", anniversary="30 Jul 2010")
    await _ready_to_sync(client, api, google)
    google.create_fail_after = 1

    r = (await client.post(f"{api}/google/sync-crm-dates")).json()
    assert r["added"] == 1 and r["considered"] == 2 and "refused" in r["error"]
    # The one that went through is on record, so the retry does not write it twice.
    google.create_fail_after = None
    retry = (await client.post(f"{api}/google/sync-crm-dates")).json()
    assert retry["added"] == 1 and retry["already_there"] == 1 and retry["error"] is None
    assert len(google.created) == 2


async def test_a_connection_google_has_revoked_is_dropped(
    client: AsyncClient, api: str, google: FakeGoogle
) -> None:
    await _connect(client, api)
    google.refresh_error = GoogleError(400, "invalid_grant")
    r = await client.get(f"{api}/google/events", params=JULY)
    assert r.status_code == 409 and "connect again" in r.text
    assert (await client.get(f"{api}/google/status")).json()["connected"] is False


async def test_disconnecting_revokes_at_google_and_forgets_everything(
    client: AsyncClient, api: str, google: FakeGoogle, db: AsyncSession
) -> None:
    await _client_with_dates(client, api, birthday="28 Jul")
    await _ready_to_sync(client, api, google)
    await client.post(f"{api}/google/sync-crm-dates")

    assert (await client.delete(f"{api}/google/connection")).status_code == 204
    assert google.revoked == ["refresh-secret-1"]
    assert (await client.get(f"{api}/google/status")).json()["connected"] is False
    assert (await db.execute(select(GoogleSyncedDate))).scalars().all() == []
    # Disconnecting when not connected is not an error.
    assert (await client.delete(f"{api}/google/connection")).status_code == 204


@pytest.mark.parametrize(
    ("stored", "expected"),
    [
        ("28 Jul", date(2026, 7, 28)),
        ("14 Mar 1975", date(2027, 3, 14)),
        ("26 Jul", date(2026, 7, 26)),
        ("29 Feb", None),
        ("someday", None),
        ("", None),
        (None, None),
    ],
)
def test_next_occurrence_reads_the_loose_dates_the_crm_holds(
    stored: str | None, expected: date | None
) -> None:
    got = service.next_occurrence(stored, date(2026, 7, 26))
    # 29 Feb: 2027 has none and 2026 is past, so it is skipped rather than moved.
    assert got == expected or (stored == "29 Feb" and got is None)
