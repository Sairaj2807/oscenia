"""delivery orders

The paperwork that travels with kit to an event: a header (number, project, event date, status,
signed) and its lines. A document, not a stock movement. ``delivery_order_no_seq`` hands out
``DO-2201``, ``DO-2202``... (the prototype's own demo orders were DO-2201 and DO-2202).

Revision ID: h4c8e1f6d953
Revises: g3b7d0e5c842
Create Date: 2026-10-11 13:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = 'h4c8e1f6d953'
down_revision: str | None = 'g3b7d0e5c842'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute('CREATE SEQUENCE delivery_order_no_seq START 2201')
    delivery_status = sa.Enum('Draft', 'Dispatched', 'Received', name='delivery_status')
    op.create_table('delivery_orders',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('do_no', sa.String(length=16), nullable=False),
    sa.Column('project_id', sa.UUID(), nullable=False),
    sa.Column('event_date', sa.Date(), nullable=True),
    sa.Column('status', delivery_status, nullable=False),
    sa.Column('signed', sa.Boolean(), server_default='false', nullable=False),
    sa.Column('dispatched_on', sa.Date(), nullable=True),
    sa.Column('received_on', sa.Date(), nullable=True),
    sa.Column('created_by_user_id', sa.UUID(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['created_by_user_id'], ['users.id'], ),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('do_no'),
    )
    op.create_index(op.f('ix_delivery_orders_project_id'), 'delivery_orders', ['project_id'], unique=False)
    op.create_table('delivery_order_lines',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('delivery_order_id', sa.UUID(), nullable=False),
    sa.Column('line_no', sa.Integer(), nullable=False),
    sa.Column('inventory_item_id', sa.UUID(), nullable=True),
    sa.Column('item_label', sa.String(length=200), nullable=False),
    sa.Column('qty', sa.Numeric(precision=14, scale=2), nullable=False),
    sa.CheckConstraint('qty > 0', name=op.f('ck_delivery_order_lines_qty_positive')),
    sa.ForeignKeyConstraint(['delivery_order_id'], ['delivery_orders.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['inventory_item_id'], ['inventory_items.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('delivery_order_id', 'line_no', name='delivery_line_order'),
    )
    op.create_index(op.f('ix_delivery_order_lines_delivery_order_id'), 'delivery_order_lines', ['delivery_order_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_delivery_order_lines_delivery_order_id'), table_name='delivery_order_lines')
    op.drop_table('delivery_order_lines')
    op.drop_index(op.f('ix_delivery_orders_project_id'), table_name='delivery_orders')
    op.drop_table('delivery_orders')
    op.execute('DROP TYPE delivery_status')
    op.execute('DROP SEQUENCE delivery_order_no_seq')
