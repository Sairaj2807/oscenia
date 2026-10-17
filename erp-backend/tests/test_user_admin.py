"""User administration: who may manage accounts, the guard rails around the last CEO, and how a
password is replaced (own change, and the admin-issued one-time link)."""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from test_events_public import stranger

from app.core.clock import FrozenClock
from app.core.throttle import Throttle
from app.domain.audit.models import AuditEvent
from app.domain.auth import admin, admin_router
from app.domain.masters.models import Role, User

NEW = {"email": "new.person@oscenia.co.id", "full_name": "New Person", "role": "sales"}


async def login(anyone: AsyncClient, api: str, email: str, password: str) -> Any:
    return await anyone.post(f"{api}/auth/login", json={"email": email, "password": password})


async def make_user(client: AsyncClient, api: str, **kw: Any) -> dict[str, Any]:
    r = await client.post(f"{api}/users", json={**NEW, **kw})
    assert r.status_code == 201, r.text
    return {**r.json()["user"], "password": r.json()["temporary_password"]}


async def test_only_the_ceo_manages_users(client_for: Any, api: str) -> None:
    for role in (Role.PM, Role.FINANCE, Role.SALES, Role.WAREHOUSE):
        who = await client_for(role)
        assert (await who.get(f"{api}/users")).status_code == 403, role
        assert (await who.post(f"{api}/users", json=NEW)).status_code == 403, role


async def test_a_new_user_gets_a_temporary_password_they_must_replace(
    client: AsyncClient, api: str
) -> None:
    created = await make_user(client, api)
    assert created["must_change_password"] is True and created["active"] is True
    assert len(created["password"]) >= 12

    anyone = stranger(client)
    r = await login(anyone, api, NEW["email"], created["password"])
    assert r.status_code == 200, r.text
    me = await anyone.get(
        f"{api}/auth/me", headers={"Authorization": f"Bearer {r.json()['access_token']}"}
    )
    assert me.json()["must_change_password"] is True and me.json()["role"] == "sales"

    listed = (await client.get(f"{api}/users")).json()
    assert any(u["email"] == NEW["email"] for u in listed)
    assert all(u["email"] != "system@oscenia.co.id" for u in listed), "the system user is hidden"


async def test_the_same_email_cannot_be_used_twice(client: AsyncClient, api: str) -> None:
    await make_user(client, api)
    again = await client.post(f"{api}/users", json={**NEW, "email": NEW["email"].upper()})
    assert again.status_code == 409


async def test_a_team_member_can_be_created_into_the_workspace(
    client: AsyncClient, api: str
) -> None:
    made = await make_user(
        client, api, email="field.hand@oscenia.co.id", role="team",
        workspace_role="staff", division="Field", title="Stage hand",
    )  # fmt: skip
    assert made["workspace_role"] == "staff" and made["division"] == "Field" and made["member_no"]


async def test_the_last_active_ceo_cannot_be_demoted_or_deactivated(
    client: AsyncClient, api: str, db: AsyncSession
) -> None:
    ceos = (await db.execute(select(User).where(User.role == Role.CEO, User.active))).scalars()
    me = next(u for u in ceos if u.email != "system@oscenia.co.id")

    # Nobody changes their own role or deactivates themselves.
    assert (await client.patch(f"{api}/users/{me.id}", json={"role": "pm"})).status_code == 409
    assert (await client.post(f"{api}/users/{me.id}/deactivate")).status_code == 409

    # With a second CEO the first can be demoted, but then the second is the last one.
    second = await make_user(client, api, email="second.ceo@oscenia.co.id", role="ceo")
    others = [
        u for u in (await client.get(f"{api}/users")).json() if u["role"] == "ceo" and u["active"]
    ]
    assert len(others) >= 2
    for u in others:
        if u["id"] != second["id"] and u["id"] != str(me.id):
            await client.patch(f"{api}/users/{u['id']}", json={"role": "pm"})
    ceo_login = await login(stranger(client), api, second["email"], second["password"])
    c2 = stranger(client)
    c2.headers["Authorization"] = f"Bearer {ceo_login.json()['access_token']}"
    assert (await c2.post(f"{api}/users/{me.id}/deactivate")).status_code == 200
    last = await c2.patch(f"{api}/users/{second['id']}", json={"role": "pm"})
    assert last.status_code == 409, "never leave the company with no active CEO"


async def test_changing_a_role_changes_what_the_next_request_may_do(
    client: AsyncClient, api: str
) -> None:
    person = await make_user(client, api, role="finance")
    anyone = stranger(client)
    token = (await login(anyone, api, person["email"], person["password"])).json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}
    assert (await anyone.get(f"{api}/trial-balance", headers=headers)).status_code != 403

    r = await client.patch(f"{api}/users/{person['id']}", json={"role": "warehouse"})
    assert r.status_code == 200 and r.json()["role"] == "warehouse"
    after = await anyone.post(f"{api}/journal-entries", json={}, headers=headers)
    assert after.status_code == 403, "the same token now has the new role"


async def test_deactivating_signs_the_person_out_everywhere_and_can_be_undone(
    client: AsyncClient, api: str
) -> None:
    person = await make_user(client, api)
    anyone = stranger(client)
    pair = (await login(anyone, api, person["email"], person["password"])).json()

    off = await client.post(f"{api}/users/{person['id']}/deactivate")
    assert off.status_code == 200 and off.json()["active"] is False
    assert (await login(anyone, api, person["email"], person["password"])).status_code == 401
    refresh = await anyone.post(
        f"{api}/auth/refresh", json={"refresh_token": pair["refresh_token"]}
    )
    assert refresh.status_code == 401
    with_old_token = await anyone.get(
        f"{api}/auth/me", headers={"Authorization": f"Bearer {pair['access_token']}"}
    )
    assert with_old_token.status_code == 401, "an access token dies with the account"

    on = await client.post(f"{api}/users/{person['id']}/activate")
    assert on.json()["active"] is True
    assert (await login(anyone, api, person["email"], person["password"])).status_code == 200


async def test_a_reset_link_sets_a_new_password_once(
    client: AsyncClient, api: str, db: AsyncSession
) -> None:
    person = await make_user(client, api)
    issued = await client.post(f"{api}/users/{person['id']}/reset-password")
    assert issued.status_code == 200, issued.text
    token = issued.json()["token"]
    anyone = stranger(client)

    spent = await anyone.post(
        f"{api}/public/password-reset", json={"password": "a-brand-new-password"},
        headers={"X-Reset-Token": token},
    )  # fmt: skip
    assert spent.status_code == 204, spent.text
    assert (await login(anyone, api, person["email"], person["password"])).status_code == 401
    assert (await login(anyone, api, person["email"], "a-brand-new-password")).status_code == 200

    again = await anyone.post(
        f"{api}/public/password-reset", json={"password": "another-password-1"},
        headers={"X-Reset-Token": token},
    )  # fmt: skip
    assert again.status_code == 404, "a link works once"

    row = (await db.execute(select(User).where(User.email == NEW["email"]))).scalar_one()
    assert row.must_change_password is False and row.password_changed_at is not None


async def test_a_newer_link_replaces_the_older_one(client: AsyncClient, api: str) -> None:
    person = await make_user(client, api)
    first = (await client.post(f"{api}/users/{person['id']}/reset-password")).json()["token"]
    second = (await client.post(f"{api}/users/{person['id']}/reset-password")).json()["token"]
    anyone = stranger(client)
    old = await anyone.post(
        f"{api}/public/password-reset", json={"password": "a-brand-new-password"},
        headers={"X-Reset-Token": first},
    )  # fmt: skip
    assert old.status_code == 404
    fresh = await anyone.post(
        f"{api}/public/password-reset", json={"password": "a-brand-new-password"},
        headers={"X-Reset-Token": second},
    )  # fmt: skip
    assert fresh.status_code == 204


async def test_a_bad_link_is_one_404_whatever_is_wrong_with_it(
    client: AsyncClient, api: str, db: AsyncSession, frozen_clock: FrozenClock
) -> None:
    person = await make_user(client, api)
    row = (await db.execute(select(User).where(User.email == NEW["email"]))).scalar_one()
    ceo = (await db.execute(select(User).where(User.role == Role.CEO))).scalars().first()
    assert ceo is not None
    # Issued five days ago with a 24-hour life: expired by the frozen clock.
    expired, _ = await admin.issue_reset_link(
        db, row.id, actor=ceo, now=frozen_clock.now() - timedelta(days=5)
    )
    valid = (await client.post(f"{api}/users/{person['id']}/reset-password")).json()["token"]
    forged = valid[:-3] + ("AAA" if not valid.endswith("AAA") else "BBB")

    anyone = stranger(client)
    seen = set()
    for headers in ({}, {"X-Reset-Token": "garbage"}, {"X-Reset-Token": forged},
                    {"X-Reset-Token": expired}, {"X-Reset-Token": "x" * 400}):  # fmt: skip
        r = await anyone.post(
            f"{api}/public/password-reset", json={"password": "a-brand-new-password"},
            headers=headers,
        )  # fmt: skip
        assert r.status_code == 404, headers
        seen.add(r.json()["detail"])
    assert seen == {admin.RESET_REFUSED}, "no hint which it was"

    # A short password is refused without spending the link.
    short = await anyone.post(
        f"{api}/public/password-reset", json={"password": "short"},
        headers={"X-Reset-Token": valid},
    )  # fmt: skip
    assert short.status_code == 422
    ok = await anyone.post(
        f"{api}/public/password-reset", json={"password": "a-brand-new-password"},
        headers={"X-Reset-Token": valid},
    )  # fmt: skip
    assert ok.status_code == 204


async def test_a_link_for_a_deactivated_account_is_refused_and_none_is_issued(
    client: AsyncClient, api: str
) -> None:
    person = await make_user(client, api)
    token = (await client.post(f"{api}/users/{person['id']}/reset-password")).json()["token"]
    await client.post(f"{api}/users/{person['id']}/deactivate")
    r = await stranger(client).post(
        f"{api}/public/password-reset", json={"password": "a-brand-new-password"},
        headers={"X-Reset-Token": token},
    )  # fmt: skip
    assert r.status_code == 404
    assert (await client.post(f"{api}/users/{person['id']}/reset-password")).status_code == 409


async def test_guessing_reset_links_is_rate_limited(
    client: AsyncClient, api: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        admin_router, "reset_throttle",
        Throttle(f"t-{uuid.uuid4().hex[:8]}", limit=2, window_seconds=60, block_seconds=60),
    )  # fmt: skip
    anyone = stranger(client)
    codes = [
        (
            await anyone.post(
                f"{api}/public/password-reset",
                json={"password": "a-brand-new-password"},
                headers={"X-Reset-Token": "guess"},
            )
        ).status_code
        for _ in range(4)
    ]
    assert codes[:2] == [404, 404] and codes[-1] == 429


async def test_changing_your_own_password_keeps_this_session_and_ends_the_others(
    client: AsyncClient, api: str
) -> None:
    person = await make_user(client, api)
    anyone = stranger(client)
    laptop = (await login(anyone, api, person["email"], person["password"])).json()
    phone = (await login(anyone, api, person["email"], person["password"])).json()
    auth = {"Authorization": f"Bearer {laptop['access_token']}"}

    wrong = await anyone.post(
        f"{api}/auth/change-password",
        json={"current_password": "not-it-at-all-1", "new_password": "a-brand-new-password"},
        headers=auth,
    )  # fmt: skip
    assert wrong.status_code == 422

    ok = await anyone.post(
        f"{api}/auth/change-password",
        json={"current_password": person["password"], "new_password": "a-brand-new-password"},
        headers=auth,
    )  # fmt: skip
    assert ok.status_code == 200, ok.text
    fresh = ok.json()
    me = await anyone.get(
        f"{api}/auth/me", headers={"Authorization": f"Bearer {fresh['access_token']}"}
    )
    assert me.json()["must_change_password"] is False

    gone = await anyone.post(f"{api}/auth/refresh", json={"refresh_token": phone["refresh_token"]})
    assert gone.status_code == 401, "the other device is signed out"
    assert (await login(anyone, api, person["email"], "a-brand-new-password")).status_code == 200
    assert (await login(anyone, api, person["email"], person["password"])).status_code == 401

    same = await anyone.post(
        f"{api}/auth/change-password",
        json={"current_password": "a-brand-new-password", "new_password": "a-brand-new-password"},
        headers={"Authorization": f"Bearer {fresh['access_token']}"},
    )  # fmt: skip
    assert same.status_code == 422 and "not already using" in same.json()["detail"]


async def test_guessing_the_current_password_is_rate_limited(client: AsyncClient, api: str) -> None:
    person = await make_user(client, api)
    anyone = stranger(client)
    token = (await login(anyone, api, person["email"], person["password"])).json()["access_token"]
    codes = []
    for _ in range(7):
        r = await anyone.post(
            f"{api}/auth/change-password",
            json={"current_password": "guess-guess-guess", "new_password": "a-brand-new-password"},
            headers={"Authorization": f"Bearer {token}"},
        )
        codes.append(r.status_code)
    assert codes[:5] == [422] * 5 and codes[-1] == 429


async def test_the_screen_language_is_kept_per_person(client: AsyncClient, api: str) -> None:
    person = await make_user(client, api)
    anyone = stranger(client)
    token = (await login(anyone, api, person["email"], person["password"])).json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}
    assert (await anyone.get(f"{api}/auth/me", headers=headers)).json()["language"] == "en"

    r = await anyone.patch(f"{api}/auth/me/preferences", json={"language": "id"}, headers=headers)
    assert r.status_code == 200 and r.json()["language"] == "id"
    assert (await anyone.get(f"{api}/auth/me", headers=headers)).json()["language"] == "id"
    bad = await anyone.patch(f"{api}/auth/me/preferences", json={"language": "xx"}, headers=headers)
    assert bad.status_code == 422


async def test_account_changes_are_audited_without_secrets(
    client: AsyncClient, api: str, db: AsyncSession
) -> None:
    person = await make_user(client, api)
    link = (await client.post(f"{api}/users/{person['id']}/reset-password")).json()["token"]
    await client.post(f"{api}/users/{person['id']}/deactivate")

    rows = (
        (await db.execute(select(AuditEvent).where(AuditEvent.action.like("user.%"))))
        .scalars()
        .all()
    )
    actions = {r.action for r in rows}
    assert {"user.create", "user.reset_link", "user.deactivate"} <= actions
    text = " ".join(str((r.before, r.after, r.detail)) for r in rows)
    assert person["password"] not in text and link not in text, "no password or link in the log"
