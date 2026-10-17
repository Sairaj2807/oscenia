"""search trigram indexes

Chat messages, task titles and event names are now searched with ``ILIKE '%text%'``, which a plain
b-tree cannot serve. ``pg_trgm`` GIN indexes can. The extension is created if the database owner is
allowed to (it is a trusted extension on the ``postgres:16-alpine`` image); where it is not, the
indexes are skipped and the search still works, only by scanning. The search code does not depend on
them either way.

Revision ID: r5f9b1d8e384
Revises: q4e8a0c7d273
Create Date: 2026-10-14 12:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = 'r5f9b1d8e384'
down_revision: str | None = 'q4e8a0c7d273'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

INDEXES = (
    ('ix_chat_messages_text_trgm', 'chat_messages', 'text'),
    ('ix_workspace_tasks_title_trgm', 'workspace_tasks', 'title'),
    ('ix_events_name_trgm', 'events', 'name'),
)


def upgrade() -> None:
    bind = op.get_bind()
    # A savepoint, so a refused CREATE EXTENSION does not abort the whole migration.
    try:
        with bind.begin_nested():
            bind.execute(sa.text('CREATE EXTENSION IF NOT EXISTS pg_trgm'))
    except sa.exc.DBAPIError:
        return
    for name, table, column in INDEXES:
        op.execute(f'CREATE INDEX IF NOT EXISTS {name} ON {table} USING gin ({column} gin_trgm_ops)')


def downgrade() -> None:
    # The extension is left in place: something else may have come to rely on it.
    for name, _table, _column in INDEXES:
        op.execute(f'DROP INDEX IF EXISTS {name}')
