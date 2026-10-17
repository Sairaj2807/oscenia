"""guest erasure

``guests.erased_at``: when a guest's personal data was erased. The row stays, anonymised.

Revision ID: l8a2c5d0e397
Revises: k7f1b4c9d286
Create Date: 2026-10-12 14:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = 'l8a2c5d0e397'
down_revision: str | None = 'k7f1b4c9d286'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('guests', sa.Column('erased_at', sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column('guests', 'erased_at')
