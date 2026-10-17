"""crm note attachments

A stored file filed against a CRM note. The file is an ``attachments`` row (receipts and price
lists use the same store); this table only says which notes it belongs to. Removing a note or an
attachment removes the link and nothing else.

Revision ID: g3b7d0e5c842
Revises: f2a6c9d4b731
Create Date: 2026-10-11 12:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = 'g3b7d0e5c842'
down_revision: str | None = 'f2a6c9d4b731'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table('client_interaction_attachments',
    sa.Column('interaction_id', sa.UUID(), nullable=False),
    sa.Column('attachment_id', sa.UUID(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['attachment_id'], ['attachments.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['interaction_id'], ['client_interactions.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('interaction_id', 'attachment_id'),
    )


def downgrade() -> None:
    op.drop_table('client_interaction_attachments')
