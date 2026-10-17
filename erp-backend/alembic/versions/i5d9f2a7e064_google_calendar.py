"""google calendar

One Google connection per user (the refresh token stored encrypted) and the record of which CRM
dates were already written to that person's calendar, so the sync adds each one once.

Revision ID: i5d9f2a7e064
Revises: h4c8e1f6d953
Create Date: 2026-10-11 15:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = 'i5d9f2a7e064'
down_revision: str | None = 'h4c8e1f6d953'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table('google_connections',
    sa.Column('user_id', sa.UUID(), nullable=False),
    sa.Column('account_email', sa.String(length=255), nullable=False),
    sa.Column('refresh_token_enc', sa.Text(), nullable=False),
    sa.Column('scopes', sa.Text(), nullable=False),
    sa.Column('show_google', sa.Boolean(), server_default='true', nullable=False),
    sa.Column('add_crm_dates', sa.Boolean(), server_default='false', nullable=False),
    sa.Column('connected_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('user_id'),
    )
    op.create_table('google_synced_dates',
    sa.Column('user_id', sa.UUID(), nullable=False),
    sa.Column('key', sa.String(length=120), nullable=False),
    sa.Column('google_event_id', sa.String(length=255), nullable=False),
    sa.Column('synced_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('user_id', 'key'),
    )


def downgrade() -> None:
    op.drop_table('google_synced_dates')
    op.drop_table('google_connections')
