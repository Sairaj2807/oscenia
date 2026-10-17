"""crew lifecycle

A crew member can be edited and deactivated (``crew.active``), and a paid incentive pool keeps a
snapshot of who was paid what (``incentive_disbursement_lines``), so changing or removing crew later
never rewrites a pool that was already disbursed. Disbursements made before this migration have no
lines and keep being shown from the live crew list.

Revision ID: n1b5d7f2a940
Revises: m9a4b1c6e508
Create Date: 2026-10-12 18:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = 'n1b5d7f2a940'
down_revision: str | None = 'm9a4b1c6e508'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('crew', sa.Column('active', sa.Boolean(), server_default='true', nullable=False))
    op.add_column('crew', sa.Column('deactivated_on', sa.Date(), nullable=True))
    op.create_table(
        'incentive_disbursement_lines',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('disbursement_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('crew_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('crew_no', sa.String(length=16), nullable=False),
        sa.Column('name', sa.String(length=120), nullable=False),
        sa.Column('role', sa.String(length=80), nullable=True),
        sa.Column('base_rate', sa.Numeric(precision=18, scale=2), nullable=False),
        sa.Column('rating', sa.Numeric(precision=3, scale=1), nullable=False),
        sa.Column('qualifies', sa.Boolean(), nullable=False),
        sa.Column('bonus', sa.Numeric(precision=18, scale=2), nullable=False),
        sa.ForeignKeyConstraint(['disbursement_id'], ['incentive_disbursements.id'], name=op.f('fk_incentive_disbursement_lines_disbursement_id_incentive_disbursements'), ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['crew_id'], ['crew.id'], name=op.f('fk_incentive_disbursement_lines_crew_id_crew'), ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_incentive_disbursement_lines')),
    )
    op.create_index('ix_incentive_lines_disbursement', 'incentive_disbursement_lines', ['disbursement_id'], unique=False)
    op.create_index('ix_incentive_lines_crew', 'incentive_disbursement_lines', ['crew_id'], unique=False)


def downgrade() -> None:
    op.drop_index('ix_incentive_lines_crew', table_name='incentive_disbursement_lines')
    op.drop_index('ix_incentive_lines_disbursement', table_name='incentive_disbursement_lines')
    op.drop_table('incentive_disbursement_lines')
    op.drop_column('crew', 'deactivated_on')
    op.drop_column('crew', 'active')
