"""create ledger core

Revision ID: 0187739aca69
Revises: 
Create Date: 2026-09-06 13:53:26.692096
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = '0187739aca69'
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# ---------------------------------------------------------------------------
# The four invariants, enforced in the database rather than in Python.
#
# The point of leaving Zustand behind is that the books survive a bad request from any
# client - including a migration script, a fixture, or a well-meaning psql session. The
# service layer checks all of this too, in order to return a decent error message; these
# triggers are what make it *true*.
# ---------------------------------------------------------------------------

BALANCE_FN = """
CREATE OR REPLACE FUNCTION assert_entry_balanced() RETURNS trigger AS $fn$
DECLARE
  d numeric(18,2);
  c numeric(18,2);
  n integer;
  target uuid;
BEGIN
  target := COALESCE(NEW.entry_id, OLD.entry_id);

  SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0), COUNT(*)
    INTO d, c, n
    FROM journal_lines WHERE entry_id = target;

  -- The entry was removed wholesale; nothing left to balance.
  IF n = 0 THEN RETURN NULL; END IF;

  IF n < 2 THEN
    RAISE EXCEPTION 'entry % has % line(s); double entry needs at least 2', target, n;
  END IF;

  -- Exact. NUMERIC is exact arithmetic, so there is no tolerance here. The prototype's
  -- one-rupiah EPSILON was a float guard; its materiality half is a separate business
  -- rule and lives in app/core/money.py.
  IF d <> c THEN
    RAISE EXCEPTION 'entry % out of balance: debits % <> credits % (out by %)',
      target, d, c, abs(d - c);
  END IF;

  RETURN NULL;
END $fn$ LANGUAGE plpgsql;
"""

# DEFERRABLE INITIALLY DEFERRED is essential: lines are inserted one at a time, so an entry
# is legitimately unbalanced mid-transaction. The check runs at COMMIT. That is also why
# tests asserting rejection need SET CONSTRAINTS ALL IMMEDIATE - see tests/conftest.py.
BALANCE_TRIGGER = """
CREATE CONSTRAINT TRIGGER journal_lines_balanced
  AFTER INSERT OR UPDATE OR DELETE ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_entry_balanced();
"""

APPEND_ONLY_ENTRIES = """
CREATE OR REPLACE FUNCTION forbid_journal_entry_mutation() RETURNS trigger AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'journal entry % is never deleted; post a reversal so the original stays in the audit trail',
      OLD.entry_no;
  END IF;

  -- The one permitted update: stamping the back-reference to the entry that reversed this
  -- one. Everything else about a posted entry is immutable.
  IF (to_jsonb(NEW) - 'reversed_by_id') IS DISTINCT FROM (to_jsonb(OLD) - 'reversed_by_id') THEN
    RAISE EXCEPTION
      'journal entry % is immutable; only reversed_by_id may be stamped - reverse and repost instead',
      OLD.entry_no;
  END IF;

  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
"""

APPEND_ONLY_ENTRIES_TRIGGER = """
CREATE TRIGGER journal_entries_immutable
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_journal_entry_mutation();
"""

APPEND_ONLY_LINES = """
CREATE OR REPLACE FUNCTION forbid_journal_line_mutation() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'journal lines are immutable; reverse the entry and repost it';
END $fn$ LANGUAGE plpgsql;
"""

APPEND_ONLY_LINES_TRIGGER = """
CREATE TRIGGER journal_lines_immutable
  BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_journal_line_mutation();
"""

ACCOUNT_GUARD = """
CREATE OR REPLACE FUNCTION guard_account_changes() RETURNS trigger AS $fn$
DECLARE
  used integer;
  kids integer;
BEGIN
  SELECT COUNT(*) INTO used FROM journal_lines WHERE account_code = OLD.code;
  SELECT COUNT(*) INTO kids FROM accounts WHERE parent_code = OLD.code;

  IF TG_OP = 'DELETE' THEN
    IF used > 0 THEN
      RAISE EXCEPTION
        'account % has % posted line(s) and cannot be deleted; deactivate it instead',
        OLD.code, used;
    END IF;
    IF kids > 0 THEN
      RAISE EXCEPTION 'account % has sub-accounts and cannot be deleted', OLD.code;
    END IF;
    RETURN OLD;
  END IF;

  -- Renaming is always allowed. Renumbering or retyping an account with history is not:
  -- retyping would silently move posted transactions onto a different financial statement.
  IF used > 0 THEN
    IF NEW.code IS DISTINCT FROM OLD.code THEN
      RAISE EXCEPTION 'account % has posted lines; its code is locked', OLD.code;
    END IF;
    IF NEW.type IS DISTINCT FROM OLD.type THEN
      RAISE EXCEPTION
        'account % has posted lines; its type is locked - retyping moves history to another statement',
        OLD.code;
    END IF;
  END IF;

  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
"""

ACCOUNT_GUARD_TRIGGER = """
CREATE TRIGGER accounts_guarded
  BEFORE UPDATE OR DELETE ON accounts
  FOR EACH ROW EXECUTE FUNCTION guard_account_changes();
"""

ACCOUNT_NESTING = """
CREATE OR REPLACE FUNCTION guard_account_nesting() RETURNS trigger AS $fn$
DECLARE
  parent_type text;
  grandparent text;
BEGIN
  IF NEW.parent_code IS NULL THEN RETURN NEW; END IF;

  SELECT type::text, parent_code INTO parent_type, grandparent
    FROM accounts WHERE code = NEW.parent_code;

  IF parent_type IS NULL THEN
    RAISE EXCEPTION 'parent account % does not exist', NEW.parent_code;
  END IF;

  IF grandparent IS NOT NULL THEN
    RAISE EXCEPTION
      'sub-accounts nest one level only: % already sits under %', NEW.parent_code, grandparent;
  END IF;

  IF parent_type <> NEW.type::text THEN
    RAISE EXCEPTION
      'sub-account % must share its parent type (% is %)', NEW.code, NEW.parent_code, parent_type;
  END IF;

  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
"""

ACCOUNT_NESTING_TRIGGER = """
CREATE TRIGGER accounts_nesting
  BEFORE INSERT OR UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION guard_account_nesting();
"""

PERIOD_GUARD = """
CREATE OR REPLACE FUNCTION guard_closed_period() RETURNS trigger AS $fn$
DECLARE
  st text;
BEGIN
  SELECT status::text INTO st FROM accounting_periods
    WHERE year = EXTRACT(YEAR FROM NEW.entry_date)::int
      AND month = EXTRACT(MONTH FROM NEW.entry_date)::int;

  IF st = 'closed' THEN
    RAISE EXCEPTION
      'accounting period %-% is closed; nothing further can be dated inside it',
      EXTRACT(YEAR FROM NEW.entry_date)::int,
      LPAD(EXTRACT(MONTH FROM NEW.entry_date)::text, 2, '0');
  END IF;

  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
"""

PERIOD_GUARD_TRIGGER = """
CREATE TRIGGER journal_entries_period_open
  BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION guard_closed_period();
"""

ALL_TRIGGERS = [
    BALANCE_FN,
    BALANCE_TRIGGER,
    APPEND_ONLY_ENTRIES,
    APPEND_ONLY_ENTRIES_TRIGGER,
    APPEND_ONLY_LINES,
    APPEND_ONLY_LINES_TRIGGER,
    ACCOUNT_GUARD,
    ACCOUNT_GUARD_TRIGGER,
    ACCOUNT_NESTING,
    ACCOUNT_NESTING_TRIGGER,
    PERIOD_GUARD,
    PERIOD_GUARD_TRIGGER,
]

DROPS = [
    "DROP TRIGGER IF EXISTS journal_entries_period_open ON journal_entries",
    "DROP TRIGGER IF EXISTS accounts_nesting ON accounts",
    "DROP TRIGGER IF EXISTS accounts_guarded ON accounts",
    "DROP TRIGGER IF EXISTS journal_lines_immutable ON journal_lines",
    "DROP TRIGGER IF EXISTS journal_entries_immutable ON journal_entries",
    "DROP TRIGGER IF EXISTS journal_lines_balanced ON journal_lines",
    "DROP FUNCTION IF EXISTS guard_closed_period()",
    "DROP FUNCTION IF EXISTS guard_account_nesting()",
    "DROP FUNCTION IF EXISTS guard_account_changes()",
    "DROP FUNCTION IF EXISTS forbid_journal_line_mutation()",
    "DROP FUNCTION IF EXISTS forbid_journal_entry_mutation()",
    "DROP FUNCTION IF EXISTS assert_entry_balanced()",
]


def upgrade() -> None:
    # ### commands auto generated by Alembic - please adjust! ###
    op.create_table('accounts',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('code', sa.String(length=32), nullable=False),
    sa.Column('name', sa.String(length=120), nullable=False),
    sa.Column('type', sa.Enum('asset', 'liability', 'equity', 'revenue', 'cogs', 'opex', 'tax', name='account_type'), nullable=False),
    sa.Column('group_label', sa.String(length=80), nullable=False),
    sa.Column('parent_code', sa.String(length=32), nullable=True),
    sa.Column('is_cash', sa.Boolean(), server_default='false', nullable=False),
    sa.Column('is_contra', sa.Boolean(), server_default='false', nullable=False),
    sa.Column('tax_key', sa.String(length=16), nullable=True),
    sa.Column('active', sa.Boolean(), server_default='true', nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint("code ~ '^[0-9]+(\\.[0-9]+)*$'", name=op.f('ck_accounts_code_format')),
    sa.CheckConstraint('length(btrim(name)) > 0', name=op.f('ck_accounts_name_present')),
    sa.CheckConstraint('parent_code IS NULL OR parent_code <> code', name=op.f('ck_accounts_not_self_parent')),
    sa.ForeignKeyConstraint(['parent_code'], ['accounts.code'], name=op.f('fk_accounts_parent_code_accounts'), onupdate='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_accounts')),
    sa.UniqueConstraint('code', name=op.f('uq_accounts_code'))
    )
    op.create_index('ix_accounts_parent_code', 'accounts', ['parent_code'], unique=False)
    op.create_index('ix_accounts_type', 'accounts', ['type'], unique=False)
    op.create_table('document_sequences',
    sa.Column('key', sa.String(length=32), nullable=False),
    sa.Column('prefix', sa.String(length=16), nullable=False),
    sa.Column('pad', sa.Integer(), nullable=False),
    sa.Column('next_value', sa.BigInteger(), nullable=False),
    sa.CheckConstraint('pad BETWEEN 1 AND 12', name=op.f('ck_document_sequences_pad_range')),
    sa.PrimaryKeyConstraint('key', name=op.f('pk_document_sequences'))
    )
    op.create_table('users',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('email', sa.String(length=200), nullable=False),
    sa.Column('password_hash', sa.String(length=200), nullable=True),
    sa.Column('full_name', sa.String(length=120), nullable=False),
    sa.Column('initials', sa.String(length=8), nullable=False),
    sa.Column('role', sa.Enum('ceo', 'finance', 'pm', 'sales', 'warehouse', name='user_role'), nullable=False),
    sa.Column('active', sa.Boolean(), server_default='true', nullable=False),
    sa.Column('last_login_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_users')),
    sa.UniqueConstraint('email', name=op.f('uq_users_email'))
    )
    op.create_table('voucher_series',
    sa.Column('key', sa.String(length=16), nullable=False),
    sa.Column('prefix', sa.String(length=32), nullable=False),
    sa.Column('label', sa.String(length=80), nullable=False),
    sa.Column('hint', sa.String(length=200), nullable=True),
    sa.Column('format', sa.String(length=120), nullable=False),
    sa.Column('reset', sa.Enum('monthly', 'yearly', 'daily', 'never', name='reset_cadence'), nullable=False),
    sa.CheckConstraint("format ~ '\\[SEQ_[0-9]+\\]'", name=op.f('ck_voucher_series_format_has_seq')),
    sa.CheckConstraint('length(btrim(prefix)) > 0', name=op.f('ck_voucher_series_prefix_present')),
    sa.PrimaryKeyConstraint('key', name=op.f('pk_voucher_series'))
    )
    op.create_table('accounting_periods',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('year', sa.Integer(), nullable=False),
    sa.Column('month', sa.Integer(), nullable=False),
    sa.Column('status', sa.Enum('open', 'closed', name='period_status'), nullable=False),
    sa.Column('closed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('closed_by_id', sa.UUID(), nullable=True),
    sa.CheckConstraint('month BETWEEN 1 AND 12', name=op.f('ck_accounting_periods_month_range')),
    sa.CheckConstraint('year BETWEEN 2000 AND 2200', name=op.f('ck_accounting_periods_year_range')),
    sa.ForeignKeyConstraint(['closed_by_id'], ['users.id'], name=op.f('fk_accounting_periods_closed_by_id_users')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_accounting_periods')),
    sa.UniqueConstraint('year', 'month', name='period_unique')
    )
    op.create_table('journal_entries',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('entry_no', sa.String(length=32), nullable=False),
    sa.Column('entry_date', sa.Date(), nullable=False),
    sa.Column('memo', sa.Text(), nullable=False),
    sa.Column('project_id', sa.UUID(), nullable=True),
    sa.Column('series', sa.String(length=16), nullable=False),
    sa.Column('voucher_no', sa.String(length=64), nullable=False),
    sa.Column('source_kind', sa.Enum('invoice', 'payment', 'po', 'pettycash', 'warehouse', 'payroll', 'manual', 'opening', 'reversal', 'adjustment', 'depreciation', name='source_kind'), nullable=False),
    sa.Column('source_ref', sa.String(length=64), nullable=True),
    sa.Column('source_due', sa.Date(), nullable=True),
    sa.Column('source_vendor_id', sa.UUID(), nullable=True),
    sa.Column('source_settlement', sa.Boolean(), server_default='false', nullable=False),
    sa.Column('reversal_of_id', sa.UUID(), nullable=True),
    sa.Column('reversed_by_id', sa.UUID(), nullable=True),
    sa.Column('posted_by_user_id', sa.UUID(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint('length(btrim(memo)) > 0', name=op.f('ck_journal_entries_memo_present')),
    sa.ForeignKeyConstraint(['posted_by_user_id'], ['users.id'], name=op.f('fk_journal_entries_posted_by_user_id_users')),
    sa.ForeignKeyConstraint(['reversal_of_id'], ['journal_entries.id'], name=op.f('fk_journal_entries_reversal_of_id_journal_entries')),
    sa.ForeignKeyConstraint(['reversed_by_id'], ['journal_entries.id'], name=op.f('fk_journal_entries_reversed_by_id_journal_entries')),
    sa.ForeignKeyConstraint(['series'], ['voucher_series.key'], name=op.f('fk_journal_entries_series_voucher_series')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_journal_entries')),
    sa.UniqueConstraint('entry_no', name=op.f('uq_journal_entries_entry_no')),
    sa.UniqueConstraint('voucher_no', name=op.f('uq_journal_entries_voucher_no'))
    )
    op.create_index('ix_journal_entries_due', 'journal_entries', ['source_due'], unique=False, postgresql_where=sa.text('source_due IS NOT NULL'))
    op.create_index(op.f('ix_journal_entries_entry_date'), 'journal_entries', ['entry_date'], unique=False)
    op.create_index('ix_journal_entries_project', 'journal_entries', ['project_id'], unique=False, postgresql_where=sa.text('project_id IS NOT NULL'))
    op.create_index('ix_journal_entries_source', 'journal_entries', ['source_kind', 'source_ref'], unique=False)
    op.create_index('uq_journal_entries_source_once', 'journal_entries', ['source_kind', 'source_ref'], unique=True, postgresql_where=sa.text("source_kind IN ('depreciation', 'payroll') AND source_ref IS NOT NULL"))
    op.create_table('voucher_counters',
    sa.Column('series_key', sa.String(length=16), nullable=False),
    sa.Column('period_key', sa.String(length=16), nullable=False),
    sa.Column('next_value', sa.BigInteger(), nullable=False),
    sa.ForeignKeyConstraint(['series_key'], ['voucher_series.key'], name=op.f('fk_voucher_counters_series_key_voucher_series')),
    sa.PrimaryKeyConstraint('series_key', 'period_key', name=op.f('pk_voucher_counters'))
    )
    op.create_table('entry_applications',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('settling_entry_id', sa.UUID(), nullable=False),
    sa.Column('settled_entry_id', sa.UUID(), nullable=False),
    sa.Column('amount', sa.Numeric(precision=18, scale=2), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint('settling_entry_id <> settled_entry_id', name=op.f('ck_entry_applications_not_self')),
    sa.ForeignKeyConstraint(['settled_entry_id'], ['journal_entries.id'], name=op.f('fk_entry_applications_settled_entry_id_journal_entries')),
    sa.ForeignKeyConstraint(['settling_entry_id'], ['journal_entries.id'], name=op.f('fk_entry_applications_settling_entry_id_journal_entries')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_entry_applications')),
    sa.UniqueConstraint('settling_entry_id', 'settled_entry_id', name='pair_once')
    )
    op.create_index(op.f('ix_entry_applications_settled_entry_id'), 'entry_applications', ['settled_entry_id'], unique=False)
    op.create_index(op.f('ix_entry_applications_settling_entry_id'), 'entry_applications', ['settling_entry_id'], unique=False)
    op.create_table('journal_lines',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('entry_id', sa.UUID(), nullable=False),
    sa.Column('line_no', sa.Integer(), nullable=False),
    sa.Column('account_code', sa.String(length=32), nullable=False),
    sa.Column('debit', sa.Numeric(precision=18, scale=2), server_default='0', nullable=False),
    sa.Column('credit', sa.Numeric(precision=18, scale=2), server_default='0', nullable=False),
    sa.Column('note', sa.Text(), nullable=True),
    sa.CheckConstraint('(debit = 0) <> (credit = 0)', name=op.f('ck_journal_lines_one_side')),
    sa.CheckConstraint('debit >= 0 AND credit >= 0', name=op.f('ck_journal_lines_non_negative')),
    sa.ForeignKeyConstraint(['account_code'], ['accounts.code'], name=op.f('fk_journal_lines_account_code_accounts'), onupdate='CASCADE'),
    sa.ForeignKeyConstraint(['entry_id'], ['journal_entries.id'], name=op.f('fk_journal_lines_entry_id_journal_entries')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_journal_lines')),
    sa.UniqueConstraint('entry_id', 'line_no', name='line_unique')
    )
    op.create_index(op.f('ix_journal_lines_account_code'), 'journal_lines', ['account_code'], unique=False)
    op.create_index(op.f('ix_journal_lines_entry_id'), 'journal_lines', ['entry_id'], unique=False)
    # ### end Alembic commands ###

    for statement in ALL_TRIGGERS:
        op.execute(statement)


def downgrade() -> None:
    for statement in DROPS:
        op.execute(statement)

    # ### commands auto generated by Alembic - please adjust! ###
    op.drop_index(op.f('ix_journal_lines_entry_id'), table_name='journal_lines')
    op.drop_index(op.f('ix_journal_lines_account_code'), table_name='journal_lines')
    op.drop_table('journal_lines')
    op.drop_index(op.f('ix_entry_applications_settling_entry_id'), table_name='entry_applications')
    op.drop_index(op.f('ix_entry_applications_settled_entry_id'), table_name='entry_applications')
    op.drop_table('entry_applications')
    op.drop_table('voucher_counters')
    op.drop_index('uq_journal_entries_source_once', table_name='journal_entries', postgresql_where=sa.text("source_kind IN ('depreciation', 'payroll') AND source_ref IS NOT NULL"))
    op.drop_index('ix_journal_entries_source', table_name='journal_entries')
    op.drop_index('ix_journal_entries_project', table_name='journal_entries', postgresql_where=sa.text('project_id IS NOT NULL'))
    op.drop_index(op.f('ix_journal_entries_entry_date'), table_name='journal_entries')
    op.drop_index('ix_journal_entries_due', table_name='journal_entries', postgresql_where=sa.text('source_due IS NOT NULL'))
    op.drop_table('journal_entries')
    op.drop_table('accounting_periods')
    op.drop_table('voucher_series')
    op.drop_table('users')
    op.drop_table('document_sequences')
    op.drop_index('ix_accounts_type', table_name='accounts')
    op.drop_index('ix_accounts_parent_code', table_name='accounts')
    op.drop_table('accounts')
    # ### end Alembic commands ###
