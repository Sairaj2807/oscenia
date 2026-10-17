"""campaigns

A marketing campaign is a record of who was meant to be reached, with what, and by whom: ``campaigns``
and ``campaign_recipients``. The audience is a snapshot taken when the campaign is made (the contacts
ticked, and the consent they had then); nothing is sent from the system. ``campaign_no_seq`` hands out
``CMP-0001``. A recipient row also remembers which guests it was merged from, so erasing any of them
blanks it.

Revision ID: u8d2f4b6c718
Revises: t7c1e3a5b607
Create Date: 2026-10-14 19:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = 'u8d2f4b6c718'
down_revision: str | None = 't7c1e3a5b607'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute('CREATE SEQUENCE campaign_no_seq START 1')
    op.create_table(
        'campaigns',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('campaign_no', sa.String(length=16), nullable=False),
        sa.Column('name', sa.String(length=160), nullable=False),
        sa.Column('channel', sa.String(length=10), nullable=False),
        sa.Column('message', sa.Text(), server_default='', nullable=False),
        sa.Column('created_by', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('requested_count', sa.Integer(), nullable=False),
        sa.Column('skipped_count', sa.Integer(), server_default='0', nullable=False),
        sa.Column('unreachable_count', sa.Integer(), server_default='0', nullable=False),
        sa.CheckConstraint("channel IN ('whatsapp', 'email')", name=op.f('ck_campaigns_channel_known')),
        sa.CheckConstraint('length(btrim(name)) > 0', name=op.f('ck_campaigns_name_present')),
        sa.CheckConstraint('char_length(message) <= 2000', name=op.f('ck_campaigns_message_not_too_long')),
        sa.ForeignKeyConstraint(['created_by'], ['users.id'], name=op.f('fk_campaigns_created_by_users')),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_campaigns')),
        sa.UniqueConstraint('campaign_no', name=op.f('uq_campaigns_campaign_no')),
    )
    op.create_table(
        'campaign_recipients',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('campaign_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('position', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(length=160), server_default='', nullable=False),
        sa.Column('phone', sa.String(length=64), server_default='', nullable=False),
        sa.Column('email', sa.String(length=200), server_default='', nullable=False),
        sa.Column('contact_key', sa.String(length=120), nullable=True),
        sa.Column('source_guest_ids', postgresql.ARRAY(postgresql.UUID(as_uuid=True)), server_default=sa.text("'{}'"), nullable=False),
        sa.Column('consent_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('consent_source', sa.String(length=160), nullable=True),
        sa.Column('sent_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('sent_by', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('unsubscribed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('erased_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['campaign_id'], ['campaigns.id'], name=op.f('fk_campaign_recipients_campaign_id_campaigns'), ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['sent_by'], ['users.id'], name=op.f('fk_campaign_recipients_sent_by_users')),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_campaign_recipients')),
        sa.UniqueConstraint('campaign_id', 'position', name='uq_campaign_recipients_campaign_id_position'),
    )
    op.create_index(op.f('ix_campaign_recipients_campaign_id'), 'campaign_recipients', ['campaign_id'], unique=False)
    op.create_index(op.f('ix_campaign_recipients_contact_key'), 'campaign_recipients', ['contact_key'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_campaign_recipients_contact_key'), table_name='campaign_recipients')
    op.drop_index(op.f('ix_campaign_recipients_campaign_id'), table_name='campaign_recipients')
    op.drop_table('campaign_recipients')
    op.drop_table('campaigns')
    op.execute('DROP SEQUENCE campaign_no_seq')
