"""The chart of accounts.

Ported from ``erp-frontend/src/lib/accounts.js``. Two rules here are load-bearing and
non-obvious, both enforced by database triggers in the migration rather than by politeness:

* **One nesting level only.** A sub-account's parent may not itself have a parent.
* **A header keeps its own balance.** An account *with children* is a header and nothing new
  may post to it — but the postings already sitting on it do not move, and rollups must sum
  the parent *and* its children. The prototype's own comment explains why: dropping the
  header from the rollup "would quietly delete that balance from Total Cash and from the
  cash-flow screen."
"""

from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Index, String, func
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.domain.masters.models import enum_column


class AccountType(enum.StrEnum):
    ASSET = "asset"
    LIABILITY = "liability"
    EQUITY = "equity"
    REVENUE = "revenue"
    COGS = "cogs"
    OPEX = "opex"
    TAX = "tax"


class Side(enum.StrEnum):
    DEBIT = "debit"
    CREDIT = "credit"


class Statement(enum.StrEnum):
    BALANCE = "balance"
    INCOME = "income"


#: Normal side, statement and executive grouping per type. Straight from ACCOUNT_TYPES in
#: the prototype; the display order is the order of this mapping.
TYPE_META: dict[AccountType, tuple[Side, Statement, str]] = {
    AccountType.ASSET: (Side.DEBIT, Statement.BALANCE, "Assets"),
    AccountType.LIABILITY: (Side.CREDIT, Statement.BALANCE, "Liabilities"),
    AccountType.EQUITY: (Side.CREDIT, Statement.BALANCE, "Equity"),
    AccountType.REVENUE: (Side.CREDIT, Statement.INCOME, "Revenue"),
    AccountType.COGS: (Side.DEBIT, Statement.INCOME, "Cost of Sales (COGS)"),
    AccountType.OPEX: (Side.DEBIT, Statement.INCOME, "Operating Expenses"),
    AccountType.TAX: (Side.DEBIT, Statement.INCOME, "Tax"),
}

TYPE_ORDER: list[AccountType] = list(TYPE_META)


def normal_side(account_type: AccountType) -> Side:
    return TYPE_META[account_type][0]


def statement_of(account_type: AccountType) -> Statement:
    return TYPE_META[account_type][1]


#: Asset Loss Expense. An operating expense company-wide, but absolutely a cost of the job
#: that destroyed the equipment — so it counts against a project's P&L alongside COGS.
#: Single definition on purpose: the prototype once duplicated this and a warehouse
#: write-off silently pushed two figures out of step by the loss amount.
ASSET_LOSS_CODE = "6901"


def is_project_cost_type(account_type: AccountType, code: str) -> bool:
    return account_type is AccountType.COGS or code == ASSET_LOSS_CODE


#: The receivable and payable control accounts. Open-item ageing (AR / AP) is measured as
#: the movement on exactly these two codes, so they must stay postable leaves: no
#: sub-accounts (which would turn them into headers), and no stray lines on them from an
#: edited payment.
CONTROL_ACCOUNTS: frozenset[str] = frozenset({"1201", "2102"})


def control_account_of(code: str) -> str | None:
    """The control account ``code`` is, or sits under (``1201.01`` -> ``1201``)."""
    head = code.split(".", 1)[0]
    return head if head in CONTROL_ACCOUNTS else None


class Account(Base):
    __tablename__ = "accounts"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    #: `unique=True` without `index=True` on purpose. With both, SQLAlchemy emits a separate
    #: CREATE UNIQUE INDEX *after* the table — and the self-referencing FK below
    #: (parent_code -> code) is validated inside CREATE TABLE, so it would find no unique
    #: constraint to point at. Inline UNIQUE gives us the index anyway.
    code: Mapped[str] = mapped_column(String(32), unique=True)
    name: Mapped[str] = mapped_column(String(120))
    type: Mapped[AccountType] = mapped_column(enum_column(AccountType, "account_type"))

    #: Executive-summary bucket, e.g. "Cash & Bank". Free text so finance can regroup the
    #: statement without a migration.
    group_label: Mapped[str] = mapped_column(String(80))

    parent_code: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("accounts.code", onupdate="CASCADE"), nullable=True
    )

    #: Drives Total Cash and the cash-movement report. Inherited by sub-accounts.
    is_cash: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")

    #: Only 1303 Accumulated Depreciation. Carries a credit balance inside an asset type.
    is_contra: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")

    #: Links the account to a tax_config row: 'pph23' | 'pph21' | 'ppn'. Inherited by
    #: sub-accounts alongside is_cash.
    tax_key: Mapped[str | None] = mapped_column(String(16), nullable=True)

    #: Deactivating keeps the balance and the history, and stops accepting new postings.
    active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        CheckConstraint(r"code ~ '^[0-9]+(\.[0-9]+)*$'", name="code_format"),
        CheckConstraint("parent_code IS NULL OR parent_code <> code", name="not_self_parent"),
        CheckConstraint("length(btrim(name)) > 0", name="name_present"),
        Index("ix_accounts_parent_code", "parent_code"),
        Index("ix_accounts_type", "type"),
    )

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<Account {self.code} {self.name}>"
