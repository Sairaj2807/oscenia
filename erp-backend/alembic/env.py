from __future__ import annotations

import asyncio
from logging.config import fileConfig

from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config

# Importing the model packages registers them on Base.metadata for autogenerate.
# Each phase appends its own import here.
# ruff: noqa: F401
import app.core.throttle  # noqa: E402  (rate_limits)
import app.domain.accounts.models  # noqa: E402
import app.domain.ap.models  # noqa: E402
import app.domain.ar.models  # noqa: E402
import app.domain.assets.models  # noqa: E402
import app.domain.audit.models  # noqa: E402
import app.domain.cash.models  # noqa: E402
import app.domain.chat.models  # noqa: E402
import app.domain.crm.models  # noqa: E402
import app.domain.events.models  # noqa: E402
import app.domain.gcal.models  # noqa: E402
import app.domain.ledger.models  # noqa: E402
import app.domain.masters.models  # noqa: E402
import app.domain.workspace.models  # noqa: E402
import app.jobs.models  # noqa: E402
from alembic import context
from app.core.config import get_settings
from app.db.base import Base

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

config.set_main_option("sqlalchemy.url", get_settings().sqlalchemy_url)

target_metadata = Base.metadata


def _configure(connection: Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        # Without these two, autogenerate silently ignores type and default changes,
        # which is how a schema and its models drift apart without anyone noticing.
        compare_type=True,
        compare_server_default=True,
        render_as_batch=False,
    )


def run_migrations_offline() -> None:
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection: Connection) -> None:
    _configure(connection)
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()


def run_migrations_online() -> None:
    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
