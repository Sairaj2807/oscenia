"""Petty cash, procurement requests, attachments and budgets.

Two things here are client requirements rather than design choices:

* **``requested_by`` is NOT NULL.** The round-2 proposal asks for a mandatory Requester Name
  to "eliminate anonymous transactions in petty cash recording". The prototype refuses a
  blank one outright; the database refuses it here.
* **Attachments are real files.** The prototype stores filenames as bare strings and its own
  vendor screen admits real uploads need a storage backend. Procurement receipts are
  evidence for an audit, and a filename is not evidence.

``budget_categories`` deliberately has no ``realized`` column — actuals are derived from
postings, which is also what lets a budget cover any project rather than the single
hardcoded one the prototype carries.
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
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.domain.masters.models import enum_column

MONEY = Numeric(18, 2)


class RequestStatus(enum.StrEnum):
    """The approval workflow from the client's procurement slide."""

    DRAFT = "Draft"
    PENDING = "Pending"
    APPROVED = "Approved"
    DISBURSED = "Disbursed"
    COMPLETED = "Completed"
    REJECTED = "Rejected"


#: Requests whose category matches this are drawn from the petty cash float rather than the
#: main bank, and expensed to logistics rather than vendors.
PETTY_PATTERN = ("petty", "cash advance")


class Attachment(Base):
    """A stored file.

    ``storage_key`` is opaque to callers — the backend decides the layout, so moving from
    local disk to S3 later changes one class and no rows. ``sha256`` is kept so a duplicate
    upload is recognisable and so a file can be verified against what was recorded.
    """

    __tablename__ = "attachments"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    filename: Mapped[str] = mapped_column(String(255))
    content_type: Mapped[str] = mapped_column(String(120))
    byte_size: Mapped[int] = mapped_column(BigInteger)
    #: Deliberately **not** unique. Content addressing means identical bytes produce the
    #: same key, and two attachment rows may legitimately point at one blob — the same
    #: receipt filed against two requests, say. Uniqueness here would forbid that.
    storage_key: Mapped[str] = mapped_column(String(500), index=True)
    sha256: Mapped[str] = mapped_column(String(64), index=True)
    uploaded_by_user_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id")
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint("byte_size > 0", name="size_positive"),
        CheckConstraint("length(btrim(filename)) > 0", name="filename_present"),
    )


class ProcurementRequest(Base):
    __tablename__ = "procurement_requests"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    request_no: Mapped[str] = mapped_column(String(32), unique=True)
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("projects.id"), nullable=True, index=True
    )
    category: Mapped[str] = mapped_column(String(120))
    amount: Mapped[Decimal] = mapped_column(MONEY)
    status: Mapped[RequestStatus] = mapped_column(
        enum_column(RequestStatus, "request_status"), default=RequestStatus.DRAFT
    )

    #: **Mandatory.** Petty cash cannot be issued anonymously — the client asked for this
    #: by name, so recapitulation reports can be grouped by who asked for the money.
    requested_by: Mapped[str] = mapped_column(String(120))
    requested_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )

    request_date: Mapped[date] = mapped_column(Date)
    disbursed_at: Mapped[date | None] = mapped_column(Date, nullable=True)

    #: What was actually spent, recorded at settlement. The difference from ``amount`` is
    #: returned to the float or reimbursed.
    actual: Mapped[Decimal | None] = mapped_column(MONEY, nullable=True)
    settled_at: Mapped[date | None] = mapped_column(Date, nullable=True)
    reject_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    receipts: Mapped[list[ProcurementReceipt]] = relationship(
        back_populates="request", lazy="selectin", cascade="all, delete-orphan"
    )

    __table_args__ = (
        CheckConstraint("amount > 0", name="amount_positive"),
        CheckConstraint("actual IS NULL OR actual >= 0", name="actual_non_negative"),
        CheckConstraint("length(btrim(requested_by)) > 0", name="requester_present"),
    )

    @property
    def from_petty_cash(self) -> bool:
        lowered = self.category.lower()
        return any(token in lowered for token in PETTY_PATTERN)


class ProcurementReceipt(Base):
    """Proof of spend against a cash advance. At least one is required to settle."""

    __tablename__ = "procurement_receipts"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    request_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("procurement_requests.id"), index=True
    )
    attachment_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("attachments.id")
    )

    request: Mapped[ProcurementRequest] = relationship(back_populates="receipts")

    __table_args__ = (
        UniqueConstraint("request_id", "attachment_id", name="receipt_once"),
    )


class Budget(Base):
    """A per-project spending plan.

    One per project, unlike the prototype's single hardcoded budget covering one job.
    """

    __tablename__ = "budgets"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("projects.id"), unique=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    categories: Mapped[list[BudgetCategory]] = relationship(
        back_populates="budget",
        order_by="BudgetCategory.position",
        lazy="selectin",
        cascade="all, delete-orphan",
    )


class BudgetCategory(Base):
    """A ceiling for one class of spend.

    **No ``realized`` column.** Actuals are summed from the ledger against the account codes
    this category covers, so the plan and the reality cannot drift apart.
    """

    __tablename__ = "budget_categories"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    budget_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("budgets.id", ondelete="CASCADE"), index=True
    )
    position: Mapped[int] = mapped_column(Integer)
    key: Mapped[str] = mapped_column(String(64))
    label: Mapped[str] = mapped_column(String(120))
    ceiling: Mapped[Decimal] = mapped_column(MONEY)

    #: Which ledger accounts this category is measured against, comma-separated.
    account_codes: Mapped[str] = mapped_column(String(200))

    budget: Mapped[Budget] = relationship(back_populates="categories")

    __table_args__ = (
        CheckConstraint("ceiling >= 0", name="ceiling_non_negative"),
        UniqueConstraint("budget_id", "key", name="category_once"),
    )

    @property
    def codes(self) -> list[str]:
        return [c.strip() for c in self.account_codes.split(",") if c.strip()]


class CompanySettings(Base):
    """Single-row policy table. The prototype keeps these as loose store fields."""

    __tablename__ = "company_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)

    #: How far over a project's estimate spending may run before it is flagged. **Warns,
    #: never blocks** — the client was explicit that this is a tolerance, not a gate.
    budget_tolerance_pct: Mapped[Decimal] = mapped_column(
        Numeric(6, 3), default=Decimal("10")
    )

    #: Minimum client rating for a crew bonus, out of 10. Used in phase 7.
    bonus_threshold: Mapped[Decimal] = mapped_column(Numeric(3, 1), default=Decimal("7"))

    #: Sales commission as a percentage of net contract value: one company rate that the sales
    #: leaderboard multiplies by. Not per person (the client has not asked for that).
    commission_pct: Mapped[Decimal] = mapped_column(
        Numeric(5, 3), default=Decimal("2.5"), server_default="2.5"
    )

    #: When on, a purchase order can only be raised against a vendor that is Approved or Active.
    #: Off by default so vendors and orders that predate the lifecycle are undisturbed.
    enforce_vendor_stage: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false"
    )

    #: When on, a delivery order can be dispatched without a drawn signature (for a business not yet
    #: using the pad). Off by default: dispatch needs the recipient's signature.
    allow_unsigned_dispatch: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false"
    )

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        CheckConstraint("id = 1", name="single_row"),
        CheckConstraint("budget_tolerance_pct >= 0", name="tolerance_non_negative"),
        CheckConstraint("bonus_threshold >= 0 AND bonus_threshold <= 10", name="threshold_range"),
        CheckConstraint("commission_pct >= 0 AND commission_pct <= 100", name="commission_range"),
    )


class BudgetAlert(Base):
    """Records that a project has been flagged, so it is flagged **once**.

    The prototype warns once per project via an in-memory list. A stateless API cannot rely
    on that, so the fact is recorded — same reasoning as the idempotency constraints in
    phase 1.
    """

    __tablename__ = "budget_alerts"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("projects.id"), unique=True
    )
    ceiling: Mapped[Decimal] = mapped_column(MONEY)
    spent: Mapped[Decimal] = mapped_column(MONEY)
    acknowledged: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    raised_on: Mapped[date] = mapped_column(Date)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
