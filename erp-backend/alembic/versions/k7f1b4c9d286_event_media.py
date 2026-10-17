"""event media

Files uploaded for invitations (photos, video, music) and for template artwork. The row's id is
what the invitation's content holds as the file's key; guests fetch it from the public media route.

Revision ID: k7f1b4c9d286
Revises: j6e0a3b8c175
Create Date: 2026-10-12 10:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = 'k7f1b4c9d286'
down_revision: str | None = 'j6e0a3b8c175'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        'event_media',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('event_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('template_id', sa.String(length=40), nullable=True),
        sa.Column('storage_key', sa.String(length=200), nullable=False),
        sa.Column('kind', sa.String(length=16), nullable=False),
        sa.Column('name', sa.String(length=160), nullable=False),
        sa.Column('content_type', sa.String(length=100), nullable=False),
        sa.Column('size_bytes', sa.BigInteger(), nullable=False),
        sa.Column('uploaded_by', sa.String(length=120), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint('(event_id IS NOT NULL) <> (template_id IS NOT NULL)', name=op.f('ck_event_media_one_owner')),
        sa.ForeignKeyConstraint(['event_id'], ['events.id'], name=op.f('fk_event_media_event_id_events'), ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['template_id'], ['invitation_templates.id'], name=op.f('fk_event_media_template_id_invitation_templates'), ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_event_media')),
    )
    op.create_index('ix_event_media_event', 'event_media', ['event_id'], unique=False)
    op.create_index('ix_event_media_template', 'event_media', ['template_id'], unique=False)


def downgrade() -> None:
    op.drop_index('ix_event_media_template', table_name='event_media')
    op.drop_index('ix_event_media_event', table_name='event_media')
    op.drop_table('event_media')
