"""user admin

Users can be created, changed and deactivated from the app, change their own password, and have a
language. ``must_change_password`` marks a temporary password; ``password_link_version`` is the
version inside an admin-issued reset link, bumped on each use and each re-issue so a link works once.

Revision ID: m9a4b1c6e508
Revises: l8a2c5d0e397
Create Date: 2026-10-12 16:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = 'm9a4b1c6e508'
down_revision: str | None = 'l8a2c5d0e397'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('users', sa.Column('must_change_password', sa.Boolean(), server_default='false', nullable=False))
    op.add_column('users', sa.Column('password_changed_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('users', sa.Column('password_link_version', sa.Integer(), server_default='1', nullable=False))
    op.add_column('users', sa.Column('language', sa.String(length=5), server_default='en', nullable=False))
    op.create_check_constraint(op.f('ck_users_language_known'), 'users', "language IN ('en', 'id')")
    op.create_check_constraint(op.f('ck_users_password_link_version_positive'), 'users', 'password_link_version >= 1')


def downgrade() -> None:
    op.drop_constraint(op.f('ck_users_password_link_version_positive'), 'users', type_='check')
    op.drop_constraint(op.f('ck_users_language_known'), 'users', type_='check')
    op.drop_column('users', 'language')
    op.drop_column('users', 'password_link_version')
    op.drop_column('users', 'password_changed_at')
    op.drop_column('users', 'must_change_password')
