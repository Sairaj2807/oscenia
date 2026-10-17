"""vendor files and PO delivery status

``vendor_attachments`` files a stored file (an ``attachments`` row) against a vendor, with a kind
(Agreement, NPWP, Bank letter, Price list, Other). ``purchase_orders.delivery_status`` records whether
the goods have arrived (Not started, In progress, Delivered), which is separate from payment.

Revision ID: o2c6e8a3b051
Revises: n1b5d7f2a940
Create Date: 2026-10-12 20:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = 'o2c6e8a3b051'
down_revision: str | None = 'n1b5d7f2a940'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('purchase_orders', sa.Column('delivery_status', sa.String(length=16), server_default='Not started', nullable=False))
    op.add_column('purchase_orders', sa.Column('delivery_updated_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('purchase_orders', sa.Column('delivery_updated_by', postgresql.UUID(as_uuid=True), nullable=True))
    op.create_foreign_key(op.f('fk_purchase_orders_delivery_updated_by_users'), 'purchase_orders', 'users', ['delivery_updated_by'], ['id'])
    op.create_check_constraint(
        op.f('ck_purchase_orders_delivery_known'), 'purchase_orders',
        "delivery_status IN ('Not started', 'In progress', 'Delivered')",
    )
    op.create_table(
        'vendor_attachments',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('vendor_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('attachment_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('kind', sa.String(length=24), nullable=False),
        sa.Column('note', sa.String(length=200), nullable=True),
        sa.Column('created_by', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.CheckConstraint("kind IN ('Agreement', 'NPWP', 'Bank letter', 'Price list', 'Other')", name=op.f('ck_vendor_attachments_kind_known')),
        sa.ForeignKeyConstraint(['vendor_id'], ['vendors.id'], name=op.f('fk_vendor_attachments_vendor_id_vendors'), ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['attachment_id'], ['attachments.id'], name=op.f('fk_vendor_attachments_attachment_id_attachments'), ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['created_by'], ['users.id'], name=op.f('fk_vendor_attachments_created_by_users')),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_vendor_attachments')),
        sa.UniqueConstraint('vendor_id', 'attachment_id', name=op.f('uq_vendor_attachments_vendor_id_attachment_id')),
    )
    op.create_index('ix_vendor_attachments_vendor', 'vendor_attachments', ['vendor_id'], unique=False)
    op.create_index('ix_vendor_attachments_attachment', 'vendor_attachments', ['attachment_id'], unique=False)


def downgrade() -> None:
    op.drop_index('ix_vendor_attachments_attachment', table_name='vendor_attachments')
    op.drop_index('ix_vendor_attachments_vendor', table_name='vendor_attachments')
    op.drop_table('vendor_attachments')
    op.drop_constraint(op.f('ck_purchase_orders_delivery_known'), 'purchase_orders', type_='check')
    op.drop_constraint(op.f('fk_purchase_orders_delivery_updated_by_users'), 'purchase_orders', type_='foreignkey')
    op.drop_column('purchase_orders', 'delivery_updated_by')
    op.drop_column('purchase_orders', 'delivery_updated_at')
    op.drop_column('purchase_orders', 'delivery_status')
