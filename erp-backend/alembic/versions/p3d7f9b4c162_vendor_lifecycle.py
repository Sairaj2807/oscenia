"""vendor lifecycle

``vendors.stage`` (Prospect, Onboarding, Approved, Active, On hold, Blacklisted) with the stage's
reason and when it began; ``vendor_stage_history`` is every change; ``vendor_checks`` holds the two
hand-ticked onboarding items. Vendors that already exist were already being given orders, so they
start as Approved. ``company_settings.enforce_vendor_stage`` makes a purchase order refuse a vendor
that is not Approved or Active; it is off, so existing behaviour is unchanged until it is switched on.

Revision ID: p3d7f9b4c162
Revises: o2c6e8a3b051
Create Date: 2026-10-13 09:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = 'p3d7f9b4c162'
down_revision: str | None = 'o2c6e8a3b051'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

STAGES = "('Prospect', 'Onboarding', 'Approved', 'Active', 'On hold', 'Blacklisted')"


def upgrade() -> None:
    op.add_column('vendors', sa.Column('stage', sa.String(length=16), server_default='Approved', nullable=False))
    op.add_column('vendors', sa.Column('stage_since', sa.DateTime(timezone=True), nullable=True))
    op.add_column('vendors', sa.Column('stage_reason', sa.String(length=500), nullable=True))
    op.create_check_constraint(op.f('ck_vendors_stage_known'), 'vendors', f'stage IN {STAGES}')
    op.add_column('company_settings', sa.Column('enforce_vendor_stage', sa.Boolean(), server_default=sa.false(), nullable=False))
    op.create_table(
        'vendor_stage_history',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('vendor_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('stage', sa.String(length=16), nullable=False),
        sa.Column('reason', sa.String(length=500), nullable=True),
        sa.Column('created_by', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.CheckConstraint(f'stage IN {STAGES}', name=op.f('ck_vendor_stage_history_stage_known')),
        sa.ForeignKeyConstraint(['vendor_id'], ['vendors.id'], name=op.f('fk_vendor_stage_history_vendor_id_vendors'), ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['created_by'], ['users.id'], name=op.f('fk_vendor_stage_history_created_by_users')),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_vendor_stage_history')),
    )
    op.create_index('ix_vendor_stage_history_vendor', 'vendor_stage_history', ['vendor_id', 'created_at'])
    op.create_table(
        'vendor_checks',
        sa.Column('vendor_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('key', sa.String(length=16), nullable=False),
        sa.Column('done', sa.Boolean(), nullable=False),
        sa.Column('updated_by', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.CheckConstraint("key IN ('agreement', 'reference')", name=op.f('ck_vendor_checks_key_known')),
        sa.ForeignKeyConstraint(['vendor_id'], ['vendors.id'], name=op.f('fk_vendor_checks_vendor_id_vendors'), ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['updated_by'], ['users.id'], name=op.f('fk_vendor_checks_updated_by_users')),
        sa.PrimaryKeyConstraint('vendor_id', 'key', name=op.f('pk_vendor_checks')),
    )


def downgrade() -> None:
    op.drop_table('vendor_checks')
    op.drop_index('ix_vendor_stage_history_vendor', table_name='vendor_stage_history')
    op.drop_table('vendor_stage_history')
    op.drop_column('company_settings', 'enforce_vendor_stage')
    op.drop_constraint(op.f('ck_vendors_stage_known'), 'vendors', type_='check')
    op.drop_column('vendors', 'stage_reason')
    op.drop_column('vendors', 'stage_since')
    op.drop_column('vendors', 'stage')
