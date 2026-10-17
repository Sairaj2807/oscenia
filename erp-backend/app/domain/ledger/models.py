"""The ledger: entries, lines, applications, periods, and the numbering tables.

Four invariants live in the database, not here — balanced entries, append-only journals,
locked accounts and closed periods. See the migration. This module only describes shape.

Two absences are deliberate and worth stating, because both look like oversights:

* **There is no ``bills`` table.** A payable *is* a journal entry crediting 2102, and AP is
  derived from open items on that control account. Ageing metadata rides on the entry
  (``source_due``, ``source_vendor_id``) precisely so an overhead bill with no purchase
  order still ages.
* **There is no ``paid`` or ``outstanding`` column anywhere.** Those are computed from
  ``entry_applications``. Storing them invites exactly the drift the reconciliation badges
  on the Receivables and Payables screens exist to detect.
"""

from __future__ import annotations

import enum
import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.domain.masters.models import enum_column

MONEY = Numeric(18, 2)


class SourceKind(enum.StrEnum):
    """Where an entry came from. Drives voucher-series auto-classification and drill-down."""

    INVOICE = "invoice"
    PAYMENT = "payment"
    PO = "po"
    PETTYCASH = "pettycash"
    WAREHOUSE = "warehouse"
    PAYROLL = "payroll"
    MANUAL = "manual"
    OPENING = "opening"
    REVERSAL = "reversal"
    ADJUSTMENT = "adjustment"
    DEPRECIATION = "depreciation"


class PeriodStatus(enum.StrEnum):
    OPEN = "open"
    CLOSED = "closed"


class ResetCadence(enum.StrEnum):
    MONTHLY = "monthly"
    YEARLY = "yearly"
    DAILY = "daily"
    NEVER = "never"


# ---------------------------------------------------------------------------
# Journal
# ---------------------------------------------------------------------------


class JournalEntry(Base):
    """A posted entry. **Append-only** — a trigger rejects UPDATE and DELETE.

    The only permitted mutation is stamping ``reversed_by_id``, which is how the original
    of a reverse-and-repost keeps a pointer to the entry that cancelled it. Note that
    ``reversal_of_id`` must therefore be set at INSERT time, not patched afterwards.
    """

    __tablename__ = "journal_entries"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )

    #: Immutable internal key, e.g. 'JE-1042'. Distinct from voucher_no: this is what
    #: applications and reversals reference, so renumbering it would break every link.
    entry_no: Mapped[str] = mapped_column(String(32), unique=True)

    entry_date: Mapped[date] = mapped_column(Date, index=True)
    memo: Mapped[str] = mapped_column(Text)

    #: Project cost-centre tag. A plain UUID for now; phase 4 adds the FK to projects once
    #: that table exists.
    project_id: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True), nullable=True)

    series: Mapped[str] = mapped_column(String(16), ForeignKey("voucher_series.key"))

    #: The human, auditable document number printed on the voucher, e.g. 'KM-05-10-001'.
    #: Administrator-configurable format; never rewritten once issued.
    voucher_no: Mapped[str] = mapped_column(String(64), unique=True)

    source_kind: Mapped[SourceKind] = mapped_column(enum_column(SourceKind, "source_kind"))
    source_ref: Mapped[str | None] = mapped_column(String(64), nullable=True)

    #: Ageing anchor for a payable. Set at bill creation as order date + settlement days.
    source_due: Mapped[date | None] = mapped_column(Date, nullable=True)

    #: Phase 5 adds the FK to vendors. Replaces the prototype's vendor *name string*, which
    #: joined on a mutable display field.
    #: The date on the SOURCE DOCUMENT — a vendor's invoice, typically.
    #:
    #: A payable here is a journal entry rather than a row in a bills table, so a vendor
    #: invoice's own date has nowhere else to live. `entry_date` remains the accounting
    #: date: a bill that arrives in October for September work posts in October, which is
    #: the point — it cannot be backdated into a closed period. This records what the
    #: vendor dated it, so the two can be reconciled.
    #:
    #: Set at INSERT and never updated, because the append-only trigger permits nothing else.
    source_document_date: Mapped[date | None] = mapped_column(Date, nullable=True)

    #: The journal code several entries share, so they read as ONE document.
    #:
    #: The client's objection: an automatic posting plus a later manual correction produced
    #: two or three separate voucher numbers for one logical event, and reconciling a
    #: project at close meant chasing all of them.
    #:
    #: What this does NOT do is reuse a voucher number. Each document keeps its own
    #: immutable `voucher_no`, because a correction is its own filed document and an auditor
    #: has to see it as one — that is deliberate, and `reverse_entry` says so. `group_ref`
    #: is the answer to the different question of which document they all belong to. It
    #: holds the ANCHOR entry's voucher number, so the group is named after the original.
    #:
    #: Set at INSERT and never updated: the append-only trigger permits nothing else, which
    #: also means a group can never be silently re-pointed after the fact.
    group_ref: Mapped[str | None] = mapped_column(String(64), nullable=True)

    source_vendor_id: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True), nullable=True)

    #: A cash-advance settlement, which is a reimbursement whichever way the money moves.
    source_settlement: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")

    reversal_of_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("journal_entries.id"), nullable=True
    )
    reversed_by_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("journal_entries.id"), nullable=True
    )

    posted_by_user_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    lines: Mapped[list[JournalLine]] = relationship(
        back_populates="entry", order_by="JournalLine.line_no", lazy="selectin"
    )

    #: What this entry settles. Loaded eagerly with `selectin` so listing a hundred entries
    #: costs one extra query rather than a hundred — the difference between a journal screen
    #: that opens and one that times out.
    #:
    #: Exposed because the client derives open items from it, exactly as `openItems` does in
    #: the prototype: an entry with any outgoing application is never itself an open item.
    applications: Mapped[list[EntryApplication]] = relationship(
        foreign_keys="EntryApplication.settling_entry_id", lazy="selectin", viewonly=True
    )

    __table_args__ = (
        CheckConstraint("length(btrim(memo)) > 0", name="memo_present"),
        Index("ix_journal_entries_source", "source_kind", "source_ref"),
        Index(
            "ix_journal_entries_group",
            "group_ref",
            postgresql_where=text("group_ref IS NOT NULL"),
        ),
        Index(
            "ix_journal_entries_project",
            "project_id",
            postgresql_where=text("project_id IS NOT NULL"),
        ),
        Index(
            "ix_journal_entries_due",
            "source_due",
            postgresql_where=text("source_due IS NOT NULL"),
        ),
        # Idempotency, replacing four in-memory booleans a stateless API cannot rely on:
        # runDepreciationPeriod (postedThrough) and disburseIncentives (incentivesPaid).
        # A depreciation period and an incentive disbursement each post exactly once.
        Index(
            "uq_journal_entries_source_once",
            "source_kind",
            "source_ref",
            unique=True,
            postgresql_where=text(
                "source_kind IN ('depreciation', 'payroll') AND source_ref IS NOT NULL"
            ),
        ),
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<JournalEntry {self.entry_no} {self.entry_date}>"


class JournalLine(Base):
    """One side of one posting.

    ``one_side`` is an exclusive-or: a line carries a debit **or** a credit, never both and
    never neither. That is exactly ``lineIsValid`` in the prototype's ledger.js.
    """

    __tablename__ = "journal_lines"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    entry_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("journal_entries.id"), index=True
    )
    line_no: Mapped[int] = mapped_column(Integer)
    account_code: Mapped[str] = mapped_column(
        String(32), ForeignKey("accounts.code", onupdate="CASCADE"), index=True
    )
    debit: Mapped[Decimal] = mapped_column(MONEY, default=Decimal("0.00"), server_default="0")
    credit: Mapped[Decimal] = mapped_column(MONEY, default=Decimal("0.00"), server_default="0")
    note: Mapped[str | None] = mapped_column(Text, nullable=True)

    entry: Mapped[JournalEntry] = relationship(back_populates="lines")

    __table_args__ = (
        CheckConstraint("debit >= 0 AND credit >= 0", name="non_negative"),
        CheckConstraint("(debit = 0) <> (credit = 0)", name="one_side"),
        UniqueConstraint("entry_id", "line_no", name="line_unique"),
    )

    def __repr__(self) -> str:  # pragma: no cover
        side = f"Dr {self.debit}" if self.debit else f"Cr {self.credit}"
        return f"<JournalLine {self.account_code} {side}>"


class EntryApplication(Base):
    """Settlement links. **This is Accounts Receivable and Accounts Payable.**

    Replaces the prototype's ``appliedTo: string[]``. The rule that makes open items work,
    straight from ``openItems``:

        An entry with *any* outgoing application — i.e. one that settles something — is
        never itself an open item. It is a settlement or an adjustment *of* that document.

    That single condition is what stopped an upward variance adjustment (which credits 2102
    exactly like a bill does) being counted both as its own open bill and as a reduction of
    the one it adjusts, which drifted the open-items total above its control account.
    """

    __tablename__ = "entry_applications"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    settling_entry_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("journal_entries.id"), index=True
    )
    settled_entry_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("journal_entries.id"), index=True
    )
    #: Null means "the whole movement on the control account", which is the common case.
    amount: Mapped[Decimal | None] = mapped_column(MONEY, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint("settling_entry_id <> settled_entry_id", name="not_self"),
        UniqueConstraint("settling_entry_id", "settled_entry_id", name="pair_once"),
    )


class AccountingPeriod(Base):
    """New in the backend; the prototype has no period concept at all.

    "Closed" means only: no entry may be dated inside it. It does **not** yet post a closing
    entry rolling income into retained earnings — the balance sheet balances by picking up
    NPAT as a *derived* equity row, which works only while income accounts still carry their
    balances. See docs 07-open-questions Q2.
    """

    __tablename__ = "accounting_periods"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    year: Mapped[int] = mapped_column(Integer)
    month: Mapped[int] = mapped_column(Integer)
    status: Mapped[PeriodStatus] = mapped_column(
        enum_column(PeriodStatus, "period_status"), default=PeriodStatus.OPEN
    )
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    closed_by_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )

    __table_args__ = (
        CheckConstraint("month BETWEEN 1 AND 12", name="month_range"),
        CheckConstraint("year BETWEEN 2000 AND 2200", name="year_range"),
        UniqueConstraint("year", "month", name="period_unique"),
    )


# ---------------------------------------------------------------------------
# Numbering
# ---------------------------------------------------------------------------


class DocumentSequence(Base):
    """Row-locked counters for document numbers.

    Replaces the prototype's ``PO-${3001 + purchaseOrders.length}``, which collides after
    any delete and races under any concurrency.
    """

    __tablename__ = "document_sequences"

    key: Mapped[str] = mapped_column(String(32), primary_key=True)
    prefix: Mapped[str] = mapped_column(String(16))
    pad: Mapped[int] = mapped_column(Integer, default=4)
    next_value: Mapped[int] = mapped_column(BigInteger, default=1)

    __table_args__ = (CheckConstraint("pad BETWEEN 1 AND 12", name="pad_range"),)


class VoucherSeries(Base):
    """Administrator-configurable document-number formats.

    ``format_has_seq`` moves the prototype's ``updateVoucherSeries`` validation — reject a
    format lacking a ``[SEQ_nnn]`` token — into the schema, where it cannot be bypassed.
    """

    __tablename__ = "voucher_series"

    key: Mapped[str] = mapped_column(String(16), primary_key=True)
    prefix: Mapped[str] = mapped_column(String(32))
    label: Mapped[str] = mapped_column(String(80))
    hint: Mapped[str | None] = mapped_column(String(200), nullable=True)
    format: Mapped[str] = mapped_column(String(120))
    reset: Mapped[ResetCadence] = mapped_column(
        enum_column(ResetCadence, "reset_cadence"), default=ResetCadence.MONTHLY
    )

    __table_args__ = (
        CheckConstraint(r"format ~ '\[SEQ_[0-9]+\]'", name="format_has_seq"),
        CheckConstraint("length(btrim(prefix)) > 0", name="prefix_present"),
    )


class VoucherCounter(Base):
    """One counter per series per reset period, allocated under ``SELECT … FOR UPDATE``."""

    __tablename__ = "voucher_counters"

    series_key: Mapped[str] = mapped_column(
        String(16), ForeignKey("voucher_series.key"), primary_key=True
    )
    #: '2026-08' monthly, '2026' yearly, '2026-08-14' daily, 'all' for never.
    period_key: Mapped[str] = mapped_column(String(16), primary_key=True)
    next_value: Mapped[int] = mapped_column(BigInteger, default=1)
