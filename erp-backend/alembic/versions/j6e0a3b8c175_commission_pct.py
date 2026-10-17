"""sales commission rate

One company-wide rate on ``company_settings`` (percent of net contract value) that the sales
leaderboard multiplies by. The existing single row takes the server default, 2.5.

Revision ID: j6e0a3b8c175
Revises: i5d9f2a7e064
Create Date: 2026-10-11 18:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = 'j6e0a3b8c175'
down_revision: str | None = 'i5d9f2a7e064'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('company_settings', sa.Column('commission_pct', sa.Numeric(precision=5, scale=3), server_default='2.5', nullable=False))
    op.create_check_constraint(op.f('ck_company_settings_commission_range'), 'company_settings', 'commission_pct >= 0 AND commission_pct <= 100')


def downgrade() -> None:
    op.drop_constraint(op.f('ck_company_settings_commission_range'), 'company_settings', type_='check')
    op.drop_column('company_settings', 'commission_pct')
