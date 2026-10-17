"""group related journal entries under one code

The client's complaint was a proliferation of voucher numbers: one automatic posting plus a
later correction produced two or three numbered documents for a single logical event, and
reconciling a project at close meant chasing all of them.

The fix is NOT to reuse a number. Each document keeps its own immutable ``voucher_no``
because a correction *is* its own filed document — ``reverse_entry`` says so in as many
words, and an auditor needs to see it that way. What was missing was any record of which
document they all belong to, so the answer is a separate column rather than a change to
numbering.

``group_ref`` holds the anchor entry's voucher number, so a group is named after the
original. The anchor itself is left unstamped, which is forced rather than chosen: the
append-only trigger rejects every UPDATE on ``journal_entries``, so the original cannot be
marked when a correction later joins it. Queries therefore match ``group_ref`` OR
``voucher_no`` — see ``list_entries``.

Nullable, and the index is partial for the same reason: most entries stand alone, and an
index over a mostly-NULL column is mostly dead weight.

Revision ID: d01b7eab9d71
Revises: 2d94b8f75b28
Create Date: 2026-09-22 13:35:30.328844
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = 'd01b7eab9d71'
down_revision: str | None = '2d94b8f75b28'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('journal_entries', sa.Column('group_ref', sa.String(length=64), nullable=True))
    op.create_index('ix_journal_entries_group', 'journal_entries', ['group_ref'], unique=False, postgresql_where=sa.text('group_ref IS NOT NULL'))


def downgrade() -> None:
    op.drop_index('ix_journal_entries_group', table_name='journal_entries', postgresql_where=sa.text('group_ref IS NOT NULL'))
    op.drop_column('journal_entries', 'group_ref')
