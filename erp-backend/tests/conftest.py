"""Test harness.

Three things here are less obvious than they look.

**Per-test rollback.** Every test runs inside a transaction that is rolled back at
teardown, so the suite shares one migrated database and stays fast. The session joins the
outer connection's transaction via a SAVEPOINT, so service code may call
``session.commit()`` normally without actually persisting anything.

**The deferred-trigger wrinkle.** The balance trigger added in phase 1 is
``DEFERRABLE INITIALLY DEFERRED`` and fires at COMMIT — which a rolled-back test never
reaches. A test asserting "an unbalanced entry is rejected" would therefore pass
vacuously. The ``db_immediate`` fixture issues ``SET CONSTRAINTS ALL IMMEDIATE`` so those
tests check something real. Use it for every negative constraint test.

**NullPool.** The engine is session-scoped but each test gets its own event loop, and an
asyncpg connection belongs to the loop that opened it. Pooling would hand a connection
from a closed loop to the next test. NullPool opens and closes per connect instead.
"""

from __future__ import annotations

import os

# Must precede any app import: get_settings() is cached, and env decides which database
# the whole suite talks to. Getting this wrong runs the tests against development data.
os.environ["ENV"] = "test"

import asyncio  # noqa: E402
from collections.abc import AsyncIterator, Iterator  # noqa: E402
from pathlib import Path  # noqa: E402
from urllib.parse import urlparse  # noqa: E402

import asyncpg  # noqa: E402
import pytest  # noqa: E402
from alembic.config import Config as AlembicConfig  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import (  # noqa: E402
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.pool import NullPool  # noqa: E402

from alembic import command  # noqa: E402
from app.core.clock import DEMO_TODAY, FrozenClock, get_clock  # noqa: E402
from app.core.config import get_settings  # noqa: E402
from app.db.session import get_session  # noqa: E402
from app.domain.masters.models import (
    Role,  # noqa: E402
    User,  # noqa: E402
)
from app.main import create_app  # noqa: E402
from app.seed.chart import (  # noqa: E402
    DEMO_PASSWORD,
    SEED_USERS,
    SYSTEM_USER_EMAIL,
    seed_all,
)

BACKEND_ROOT = Path(__file__).resolve().parents[1]


def _dsn_parts(url: str) -> tuple[str, str, str, int, str]:
    """Split a SQLAlchemy async URL into asyncpg connection parts."""
    parsed = urlparse(url.replace("postgresql+asyncpg://", "postgresql://"))
    return (
        parsed.username or "postgres",
        parsed.password or "",
        parsed.hostname or "localhost",
        parsed.port or 5432,
        (parsed.path or "/").lstrip("/"),
    )


async def _ensure_test_database() -> None:
    """Create the test database if it is not there yet.

    Saves anyone from having to remember the docker-compose init service, and makes a
    fresh clone a one-command setup.
    """
    user, password, host, port, dbname = _dsn_parts(get_settings().sqlalchemy_url)
    conn = await asyncpg.connect(
        user=user, password=password, host=host, port=port, database="postgres"
    )
    try:
        exists = await conn.fetchval("SELECT 1 FROM pg_database WHERE datname = $1", dbname)
        if not exists:
            # CREATE DATABASE cannot run inside a transaction block.
            await conn.execute(f'CREATE DATABASE "{dbname}" OWNER "{user}"')
    finally:
        await conn.close()


async def _seed_reference_data() -> None:
    """Commit the chart, voucher series, sequences and demo users once per session.

    These are *reference* data, not test fixtures: every test needs account 1101 to exist
    and needs somewhere to draw a JE number from. They are committed deliberately, outside
    the per-test transaction, so each test's own writes still roll back cleanly.
    """
    engine = create_async_engine(get_settings().sqlalchemy_url, poolclass=NullPool)
    maker = async_sessionmaker(bind=engine, expire_on_commit=False)
    async with maker() as session:
        await seed_all(session)
        await session.commit()
    await engine.dispose()


@pytest.fixture(scope="session")
def migrated_database() -> Iterator[None]:
    """Create, migrate and seed the test database once per session."""
    asyncio.run(_ensure_test_database())

    cfg = AlembicConfig(str(BACKEND_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_ROOT / "alembic"))
    command.upgrade(cfg, "head")

    asyncio.run(_seed_reference_data())
    yield


@pytest.fixture(scope="session")
def engine(migrated_database: None) -> Iterator[AsyncEngine]:
    """Session-scoped engine.

    Deliberately a *synchronous* fixture: ``create_async_engine`` does not need a running
    loop, and a session-scoped async fixture would need a session-scoped event loop,
    which then fights the function-scoped loop each test runs in.
    """
    eng = create_async_engine(get_settings().sqlalchemy_url, poolclass=NullPool)
    yield eng
    asyncio.run(eng.dispose())


@pytest.fixture
async def db(engine: AsyncEngine) -> AsyncIterator[AsyncSession]:
    """A session whose every write is rolled back at teardown."""
    async with engine.connect() as connection:
        transaction = await connection.begin()
        maker = async_sessionmaker(
            bind=connection,
            expire_on_commit=False,
            join_transaction_mode="create_savepoint",
        )
        async with maker() as session:
            yield session
        if transaction.is_active:
            await transaction.rollback()


@pytest.fixture
async def db_immediate(db: AsyncSession) -> AsyncSession:
    """As ``db``, but deferred constraints fire immediately.

    Required by any test asserting that a constraint *rejects* something — otherwise the
    check would only run at a COMMIT the test never performs.
    """
    await db.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
    return db


@pytest.fixture
def frozen_clock() -> FrozenClock:
    """The prototype's fixed clock, so ported ageing assertions keep their numbers."""
    return FrozenClock(DEMO_TODAY)


EMAIL_FOR_ROLE = {role: email for email, _, _, role in SEED_USERS}


@pytest.fixture
async def anon_client(
    db: AsyncSession, frozen_clock: FrozenClock
) -> AsyncIterator[AsyncClient]:
    """An HTTP client with no credentials, wired to the rolled-back session.

    Tests go through real HTTP rather than calling services directly. That is the point:
    the boundary is what the React app will use, so the boundary is what gets tested.
    """
    app = create_app()

    async def _session_override() -> AsyncIterator[AsyncSession]:
        yield db

    app.dependency_overrides[get_session] = _session_override
    app.dependency_overrides[get_clock] = lambda: frozen_clock

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield http

    app.dependency_overrides.clear()


async def _sign_in(http: AsyncClient, api: str, role: Role) -> str:
    response = await http.post(
        f"{api}/auth/login",
        json={"email": EMAIL_FOR_ROLE[role], "password": DEMO_PASSWORD},
    )
    assert response.status_code == 200, response.text
    return response.json()["access_token"]


@pytest.fixture
async def client_for(anon_client: AsyncClient, api: str):
    """Factory: an authenticated client for any role.

    ``client = await client_for(Role.PM)`` — used by the RBAC tests, which need to assert
    that a Project Manager may request but never approve or post.
    """

    async def _make(role: Role) -> AsyncClient:
        token = await _sign_in(anon_client, api, role)
        anon_client.headers["Authorization"] = f"Bearer {token}"
        return anon_client

    return _make


@pytest.fixture
async def client(anon_client: AsyncClient, api: str) -> AsyncClient:
    """Authenticated as the CEO — the role with every permission.

    Most tests are about accounting behaviour, not authorisation, so they should not have
    to think about roles. The tests that *are* about authorisation use ``client_for``.
    """
    token = await _sign_in(anon_client, api, Role.CEO)
    anon_client.headers["Authorization"] = f"Bearer {token}"
    return anon_client


@pytest.fixture
def api() -> str:
    return get_settings().api_prefix


@pytest.fixture
async def user(db: AsyncSession) -> User:
    """The system user, used as ``posted_by`` throughout the ledger tests."""
    from sqlalchemy import select

    return (await db.execute(select(User).where(User.email == SYSTEM_USER_EMAIL))).scalar_one()


@pytest.fixture
async def make_project(db: AsyncSession):
    """Create a real client and project, and return the project id.

    Journal entries carry a real foreign key to `projects` from phase 4 onward, so a test
    that tags an entry with an invented UUID is posting to a cost centre that does not
    exist — which is exactly what the constraint is there to stop.
    """
    from datetime import date
    from decimal import Decimal

    from app.domain.ar.models import Client, Project
    from app.domain.ledger.numbering import next_document_no

    async def _make(
        name: str = "Test Project", contract: str = "480000000", stage: object = None
    ) -> str:
        client = Client(
            client_no=await next_document_no(db, "client"), name=f"{name} Client"
        )
        db.add(client)
        await db.flush()

        project = Project(
            project_no=await next_document_no(db, "project"),
            name=name,
            client_id=client.id,
            stage_since=date(2026, 5, 10),
            contract_value=Decimal(contract),
            **({"stage": stage} if stage is not None else {}),
        )
        db.add(project)
        await db.flush()
        return str(project.id)

    return _make
