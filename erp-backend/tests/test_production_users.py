"""Production users: no demo accounts, real ones added by hand, and deactivation that bites.

The demo password is published in the README. That is only safe while no production
database ever holds an account that accepts it, so the reference seed must create none
there, and the replacement path (``app.seed.users``) must produce accounts that work.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Invalid
from app.domain.masters.models import Role, User
from app.seed import chart
from app.seed.chart import DEMO_PASSWORD, SEED_USERS, SYSTEM_USER_EMAIL, seed_users
from app.seed.users import add_user, set_active

REAL_PASSWORD = "a-real-password-for-prod"


async def test_the_reference_seed_creates_no_demo_user_in_production(
    db: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    demo_emails = [email for email, *_ in SEED_USERS]
    await db.execute(User.__table__.delete().where(User.email.in_(demo_emails)))

    monkeypatch.setattr(chart, "get_settings", lambda: SimpleNamespace(env="production"))
    await seed_users(db)

    left = (await db.execute(select(User.email).where(User.email.in_(demo_emails)))).all()
    assert left == [], "no account that accepts the published demo password"
    system = (
        await db.execute(select(User).where(User.email == SYSTEM_USER_EMAIL))
    ).scalar_one()
    assert not system.active and system.password_hash is None


async def test_outside_production_the_demo_users_are_still_seeded(db: AsyncSession) -> None:
    demo_emails = [email for email, *_ in SEED_USERS]
    await db.execute(User.__table__.delete().where(User.email.in_(demo_emails)))

    assert await seed_users(db) == len(SEED_USERS)


async def test_an_added_user_can_sign_in(
    db: AsyncSession, anon_client: AsyncClient, api: str
) -> None:
    user, created = await add_user(db, " Nia@Oscenia.co.id ", "Nia Kartika", Role.PM, REAL_PASSWORD)
    assert created and user.email == "nia@oscenia.co.id" and user.initials == "NK"

    response = await anon_client.post(
        f"{api}/auth/login", json={"email": "nia@oscenia.co.id", "password": REAL_PASSWORD}
    )
    assert response.status_code == 200, response.text


async def test_adding_an_existing_address_resets_its_password_and_role(
    db: AsyncSession, anon_client: AsyncClient, api: str
) -> None:
    _, created = await add_user(db, "lina@oscenia.co.id", "Lina W.", Role.SALES, REAL_PASSWORD)
    assert not created

    old = await anon_client.post(
        f"{api}/auth/login", json={"email": "lina@oscenia.co.id", "password": DEMO_PASSWORD}
    )
    assert old.status_code == 401, "the old password stops working"

    new = await anon_client.post(
        f"{api}/auth/login", json={"email": "lina@oscenia.co.id", "password": REAL_PASSWORD}
    )
    assert new.status_code == 200
    me = await anon_client.get(
        f"{api}/auth/me", headers={"Authorization": f"Bearer {new.json()['access_token']}"}
    )
    assert me.json()["role"] == "sales"


async def test_a_short_password_is_refused(db: AsyncSession) -> None:
    with pytest.raises(Invalid):
        await add_user(db, "short@oscenia.co.id", "Short Pw", Role.SALES, "too-short")


async def test_the_system_user_cannot_be_turned_into_a_login(db: AsyncSession) -> None:
    with pytest.raises(ValueError):
        await add_user(db, SYSTEM_USER_EMAIL, "System", Role.CEO, REAL_PASSWORD)
    with pytest.raises(ValueError):
        await set_active(db, SYSTEM_USER_EMAIL, True)


async def test_deactivating_ends_access_and_every_session(
    db: AsyncSession, anon_client: AsyncClient, api: str
) -> None:
    await add_user(db, "temp@oscenia.co.id", "Temp Staff", Role.WAREHOUSE, REAL_PASSWORD)
    tokens = (
        await anon_client.post(
            f"{api}/auth/login", json={"email": "temp@oscenia.co.id", "password": REAL_PASSWORD}
        )
    ).json()
    bearer = {"Authorization": f"Bearer {tokens['access_token']}"}
    assert (await anon_client.get(f"{api}/auth/me", headers=bearer)).status_code == 200

    await set_active(db, "temp@oscenia.co.id", False)

    assert (await anon_client.get(f"{api}/auth/me", headers=bearer)).status_code == 401
    refresh = await anon_client.post(
        f"{api}/auth/refresh", json={"refresh_token": tokens["refresh_token"]}
    )
    assert refresh.status_code == 401
    login = await anon_client.post(
        f"{api}/auth/login", json={"email": "temp@oscenia.co.id", "password": REAL_PASSWORD}
    )
    assert login.status_code == 401

    await set_active(db, "temp@oscenia.co.id", True)
    login = await anon_client.post(
        f"{api}/auth/login", json={"email": "temp@oscenia.co.id", "password": REAL_PASSWORD}
    )
    assert login.status_code == 200, "reactivating restores sign-in"
