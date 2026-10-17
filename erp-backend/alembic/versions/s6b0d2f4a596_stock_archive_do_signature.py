"""stock archive and delivery-order signature

``inventory_items.archived_at`` retires an item without losing its history. A delivery order gets the
recipient's drawn signature (``signature_key`` in the file store, who signed and when), and
``company_settings.allow_unsigned_dispatch`` lets a business that is not using the pad yet keep
dispatching unsigned; it is off by default, so dispatch needs a signature.

Revision ID: s6b0d2f4a596
Revises: r5f9b1d8e384
Create Date: 2026-10-14 15:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = 's6b0d2f4a596'
down_revision: str | None = 'r5f9b1d8e384'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('inventory_items', sa.Column('archived_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('delivery_orders', sa.Column('signature_key', sa.String(length=200), nullable=True))
    op.add_column('delivery_orders', sa.Column('signed_by_name', sa.String(length=120), nullable=True))
    op.add_column('delivery_orders', sa.Column('signed_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('company_settings', sa.Column('allow_unsigned_dispatch', sa.Boolean(), server_default='false', nullable=False))


def downgrade() -> None:
    op.drop_column('company_settings', 'allow_unsigned_dispatch')
    op.drop_column('delivery_orders', 'signed_at')
    op.drop_column('delivery_orders', 'signed_by_name')
    op.drop_column('delivery_orders', 'signature_key')
    op.drop_column('inventory_items', 'archived_at')
