"""The thin client for Google's OAuth and Calendar endpoints.

Everything that leaves the server for Google goes through this one class, so tests replace it
(``set_google_api``) and no test ever reaches Google. It holds no state: each call is given the
token it needs.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta
from typing import Any, Protocol

import httpx

from app.core.config import get_settings

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
REVOKE_URL = "https://oauth2.googleapis.com/revoke"
USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"
EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events"

#: The narrowest scope that can show a person's events; writing CRM dates back needs the wider one,
#: which is only requested when the person asks for it.
SCOPE_READ = "https://www.googleapis.com/auth/calendar.events.readonly"
SCOPE_WRITE = "https://www.googleapis.com/auth/calendar.events"
SCOPE_IDENTITY = "openid email"


class GoogleError(Exception):
    """Google said no (or could not be reached)."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


class GoogleApi(Protocol):
    async def exchange_code(self, code: str) -> dict[str, Any]: ...
    async def refresh(self, refresh_token: str) -> str: ...
    async def userinfo(self, access_token: str) -> str: ...
    async def list_events(
        self, access_token: str, start: date, end: date
    ) -> list[dict[str, Any]]: ...
    async def create_all_day_event(
        self, access_token: str, *, summary: str, day: date, private_key: str
    ) -> str: ...
    async def revoke(self, token: str) -> None: ...


class HttpGoogleApi:
    """The real thing, over HTTPS."""

    async def _call(self, method: str, url: str, **kwargs: Any) -> dict[str, Any]:
        try:
            async with httpx.AsyncClient(timeout=15) as http:
                response = await http.request(method, url, **kwargs)
        except httpx.HTTPError as err:
            raise GoogleError(502, f"Could not reach Google: {err}") from err
        if response.status_code >= 400:
            raise GoogleError(response.status_code, response.text[:300])
        return response.json() if response.content else {}

    async def exchange_code(self, code: str) -> dict[str, Any]:
        s = get_settings()
        return await self._call(
            "POST",
            TOKEN_URL,
            data={
                "code": code,
                "client_id": s.google_client_id,
                "client_secret": s.google_client_secret,
                "redirect_uri": s.google_redirect_uri,
                "grant_type": "authorization_code",
            },
        )

    async def refresh(self, refresh_token: str) -> str:
        s = get_settings()
        out = await self._call(
            "POST",
            TOKEN_URL,
            data={
                "refresh_token": refresh_token,
                "client_id": s.google_client_id,
                "client_secret": s.google_client_secret,
                "grant_type": "refresh_token",
            },
        )
        return str(out["access_token"])

    async def userinfo(self, access_token: str) -> str:
        out = await self._call(
            "GET", USERINFO_URL, headers={"Authorization": f"Bearer {access_token}"}
        )
        return str(out["email"])

    async def list_events(self, access_token: str, start: date, end: date) -> list[dict[str, Any]]:
        out = await self._call(
            "GET",
            EVENTS_URL,
            headers={"Authorization": f"Bearer {access_token}"},
            params={
                "timeMin": datetime.combine(start, time.min, tzinfo=UTC).isoformat(),
                "timeMax": datetime.combine(
                    end + timedelta(days=1), time.min, tzinfo=UTC
                ).isoformat(),
                "singleEvents": "true",
                "orderBy": "startTime",
                "maxResults": 250,
            },
        )
        events: list[dict[str, Any]] = []
        for item in out.get("items", []):
            when = item.get("start", {})
            day = when.get("date") or str(when.get("dateTime", ""))[:10]
            if not day:
                continue
            events.append(
                {
                    "id": item["id"],
                    "title": item.get("summary") or "(no title)",
                    "date": day,
                    "all_day": "date" in when,
                    "time": None if "date" in when else str(when["dateTime"])[11:16],
                }
            )
        return events

    async def create_all_day_event(
        self, access_token: str, *, summary: str, day: date, private_key: str
    ) -> str:
        out = await self._call(
            "POST",
            EVENTS_URL,
            headers={"Authorization": f"Bearer {access_token}"},
            json={
                "summary": summary,
                "start": {"date": day.isoformat()},
                "end": {"date": (day + timedelta(days=1)).isoformat()},
                "transparency": "transparent",
                "extendedProperties": {"private": {"oscenia_key": private_key}},
            },
        )
        return str(out["id"])

    async def revoke(self, token: str) -> None:
        await self._call("POST", REVOKE_URL, data={"token": token})


_api: GoogleApi | None = None


def get_google_api() -> GoogleApi:
    global _api
    if _api is None:
        _api = HttpGoogleApi()
    return _api


def set_google_api(api: GoogleApi | None) -> None:
    """Tests install a fake here, and put ``None`` back afterwards."""
    global _api
    _api = api
