"""crm relations

The relationship layer of Client 360: the people we work with at a client (``client_contacts``), a
client's anniversary and nudge lead time (``client_relation_settings``), the events it runs every year
and the months they ran (``client_event_cycles``, ``client_event_editions``), nudges somebody acted on
(``client_nudges_handled``), and greetings marked as sent (``greeting_log``).

It also adds ``nudge`` to the ``reminder_kind`` enum, for the daily scan that raises a reminder on the
day a nudge falls due. Postgres cannot drop a value from an enum, so the downgrade deletes the
``nudge`` reminders and rebuilds the type without it.

Revision ID: t7c1e3a5b607
Revises: s6b0d2f4a596
Create Date: 2026-10-14 17:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = 't7c1e3a5b607'
down_revision: str | None = 's6b0d2f4a596'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

OLD_KINDS = ('birthday', 'anniversary', 'overdue_invoice', 'asset_return')
MONTH_DAY = r"^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$"
CHANNEL = "channel IN ('whatsapp', 'email', 'both')"


def upgrade() -> None:
    # A new enum value may not be used in the transaction that adds it; nothing here does.
    op.execute("ALTER TYPE reminder_kind ADD VALUE IF NOT EXISTS 'nudge'")

    op.create_table(
        'client_contacts',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('client_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('name', sa.String(length=120), nullable=False),
        sa.Column('role', sa.String(length=80), server_default='', nullable=False),
        sa.Column('phone', sa.String(length=64), server_default='', nullable=False),
        sa.Column('email', sa.String(length=200), server_default='', nullable=False),
        sa.Column('birthday', sa.String(length=5), nullable=True),
        sa.Column('greet', sa.Boolean(), server_default='true', nullable=False),
        sa.Column('channel', sa.String(length=10), server_default='whatsapp', nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.CheckConstraint('length(btrim(name)) > 0', name=op.f('ck_client_contacts_name_present')),
        sa.CheckConstraint(f"birthday IS NULL OR birthday ~ '{MONTH_DAY}'", name=op.f('ck_client_contacts_birthday_mm_dd')),
        sa.CheckConstraint(CHANNEL, name=op.f('ck_client_contacts_channel_known')),
        sa.ForeignKeyConstraint(['client_id'], ['clients.id'], name=op.f('fk_client_contacts_client_id_clients'), ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_client_contacts')),
    )
    op.create_index(op.f('ix_client_contacts_client_id'), 'client_contacts', ['client_id'], unique=False)

    op.create_table(
        'client_relation_settings',
        sa.Column('client_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('anniversary', sa.Date(), nullable=True),
        sa.Column('greet_anniversary', sa.Boolean(), server_default='false', nullable=False),
        sa.Column('anniversary_channel', sa.String(length=10), server_default='whatsapp', nullable=False),
        sa.Column('nudge_lead_months', sa.Integer(), server_default='3', nullable=False),
        sa.CheckConstraint('nudge_lead_months BETWEEN 1 AND 12', name=op.f('ck_client_relation_settings_lead_months_range')),
        sa.CheckConstraint("anniversary_channel IN ('whatsapp', 'email', 'both')", name=op.f('ck_client_relation_settings_anniversary_channel_known')),
        sa.ForeignKeyConstraint(['client_id'], ['clients.id'], name=op.f('fk_client_relation_settings_client_id_clients'), ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('client_id', name=op.f('pk_client_relation_settings')),
    )

    op.create_table(
        'client_event_cycles',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('client_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('name', sa.String(length=120), nullable=False),
        sa.CheckConstraint('length(btrim(name)) > 0', name=op.f('ck_client_event_cycles_name_present')),
        sa.CheckConstraint("position(':' in name) = 0", name=op.f('ck_client_event_cycles_name_has_no_colon')),
        sa.ForeignKeyConstraint(['client_id'], ['clients.id'], name=op.f('fk_client_event_cycles_client_id_clients'), ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_client_event_cycles')),
        sa.UniqueConstraint('client_id', 'name', name=op.f('uq_client_event_cycles_client_id_name')),
    )
    op.create_index(op.f('ix_client_event_cycles_client_id'), 'client_event_cycles', ['client_id'], unique=False)

    op.create_table(
        'client_event_editions',
        sa.Column('cycle_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('edition', sa.String(length=7), nullable=False),
        sa.CheckConstraint(r"edition ~ '^\d{4}-(0[1-9]|1[0-2])$'", name=op.f('ck_client_event_editions_edition_yyyy_mm')),
        sa.ForeignKeyConstraint(['cycle_id'], ['client_event_cycles.id'], name=op.f('fk_client_event_editions_cycle_id_client_event_cycles'), ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('cycle_id', 'edition', name=op.f('pk_client_event_editions')),
    )

    op.create_table(
        'client_nudges_handled',
        sa.Column('client_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('key', sa.String(length=160), nullable=False),
        sa.Column('note', sa.Text(), server_default='', nullable=False),
        sa.Column('handled_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('handled_by', postgresql.UUID(as_uuid=True), nullable=True),
        sa.ForeignKeyConstraint(['client_id'], ['clients.id'], name=op.f('fk_client_nudges_handled_client_id_clients'), ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['handled_by'], ['users.id'], name=op.f('fk_client_nudges_handled_handled_by_users')),
        sa.PrimaryKeyConstraint('client_id', 'key', name=op.f('pk_client_nudges_handled')),
    )

    op.create_table(
        'greeting_log',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('client_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('kind', sa.String(length=24), nullable=False),
        sa.Column('to_name', sa.String(length=160), nullable=False),
        sa.Column('channel', sa.String(length=10), nullable=False),
        sa.Column('occasion_year', sa.Integer(), nullable=False),
        sa.Column('marked_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('marked_by', postgresql.UUID(as_uuid=True), nullable=True),
        sa.CheckConstraint("kind IN ('Birthday', 'Company anniversary')", name=op.f('ck_greeting_log_kind_known')),
        sa.CheckConstraint(CHANNEL, name=op.f('ck_greeting_log_channel_known')),
        sa.ForeignKeyConstraint(['client_id'], ['clients.id'], name=op.f('fk_greeting_log_client_id_clients'), ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['marked_by'], ['users.id'], name=op.f('fk_greeting_log_marked_by_users')),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_greeting_log')),
        sa.UniqueConstraint('client_id', 'kind', 'to_name', 'occasion_year', name=op.f('uq_greeting_log_client_id_kind_to_name_occasion_year')),
    )
    op.create_index(op.f('ix_greeting_log_client_id'), 'greeting_log', ['client_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_greeting_log_client_id'), table_name='greeting_log')
    op.drop_table('greeting_log')
    op.drop_table('client_nudges_handled')
    op.drop_table('client_event_editions')
    op.drop_index(op.f('ix_client_event_cycles_client_id'), table_name='client_event_cycles')
    op.drop_table('client_event_cycles')
    op.drop_table('client_relation_settings')
    op.drop_index(op.f('ix_client_contacts_client_id'), table_name='client_contacts')
    op.drop_table('client_contacts')

    # An enum value cannot be dropped: remove what uses it, then rebuild the type without it.
    op.execute("DELETE FROM reminders WHERE kind = 'nudge'")
    op.execute('ALTER TYPE reminder_kind RENAME TO reminder_kind_with_nudge')
    kinds = ', '.join(f"'{k}'" for k in OLD_KINDS)
    op.execute(f'CREATE TYPE reminder_kind AS ENUM ({kinds})')
    op.execute(
        'ALTER TABLE reminders ALTER COLUMN kind TYPE reminder_kind '
        'USING kind::text::reminder_kind'
    )
    op.execute('DROP TYPE reminder_kind_with_nudge')
