"""Vendors, catalogue, bookings, tags and purchase orders.

**There is no ``bills`` table, and that is deliberate.** A payable *is* a journal entry
crediting 2102, so AP is derived from open items on that control account. Ageing metadata
rides on the entry itself (``source_due``, ``source_vendor_id``) precisely so that an
overhead bill with no purchase order still ages correctly — the prototype's seed has one,
and a `bills` table hanging off `purchase_orders` could not represent it.

The other thing worth knowing before reading further: **a purchase order is a commitment,
not a debt.** Approving one posts nothing. The payable is raised lazily, at first payment.
Raising it at approval is what pushed the company into an apparent loss during round 1,
because every approved-but-unstarted order was recognised as cost immediately.
"""

from __future__ import annotations

import enum
import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Column,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Table,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.domain.masters.models import enum_column

MONEY = Numeric(18, 2)
QTY = Numeric(14, 2)


class PoStatus(enum.StrEnum):
    DRAFT = "Draft"
    APPROVED = "Approved"
    DP_PAID = "DP Paid"
    SETTLED = "Settled"
    CANCELLED = "Cancelled"


#: Load-in and strike. A booking blocks the venue window plus two days before and one after,
#: which is what makes availability *date-aware* rather than a simple stock count.
SETUP_DAYS = 2
STRIKE_DAYS = 1


vendor_tags = Table(
    "vendor_tags",
    Base.metadata,
    Column("vendor_id", PgUUID(as_uuid=True), ForeignKey("vendors.id"), primary_key=True),
    Column("tag_id", String(64), ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True),
)

catalogue_tags = Table(
    "catalogue_item_tags",
    Base.metadata,
    Column(
        "item_id",
        PgUUID(as_uuid=True),
        ForeignKey("vendor_catalogue_items.id"),
        primary_key=True,
    ),
    Column("tag_id", String(64), ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True),
)


class Tag(Base):
    """A vocabulary shared by vendors and catalogue items.

    Deleting a tag cascades to both join tables — the prototype's ``deleteTag`` strips it
    from every vendor and item, and a dangling tag reference is worse than none.
    """

    __tablename__ = "tags"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    label: Mapped[str] = mapped_column(String(120))


class Vendor(Base):
    __tablename__ = "vendors"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    vendor_no: Mapped[str] = mapped_column(String(16), unique=True)
    name: Mapped[str] = mapped_column(String(160))
    category: Mapped[str | None] = mapped_column(String(120), nullable=True)
    baseline_price: Mapped[Decimal] = mapped_column(MONEY, default=Decimal("0.00"))

    score: Mapped[Decimal] = mapped_column(Numeric(2, 1), default=Decimal("0"))
    delays: Mapped[int] = mapped_column(Integer, default=0)

    #: Indonesian tax identification number.
    npwp: Mapped[str | None] = mapped_column(String(32), nullable=True)

    #: **Overrides the company default.** The seed has one vendor at 1.5% against a 2%
    #: default, and paying them at the wrong rate misstates both the cost and 2105.
    pph23_rate: Mapped[Decimal | None] = mapped_column(Numeric(6, 3), nullable=True)

    bank_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    bank_account: Mapped[str | None] = mapped_column(String(64), nullable=True)
    bank_holder: Mapped[str | None] = mapped_column(String(160), nullable=True)

    pic_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    pic_phone: Mapped[str | None] = mapped_column(String(64), nullable=True)
    pic_email: Mapped[str | None] = mapped_column(String(200), nullable=True)

    terms_dp_percent: Mapped[Decimal] = mapped_column(Numeric(6, 3), default=Decimal("50"))
    terms_settlement_days: Mapped[int] = mapped_column(Integer, default=14)

    #: Where the supplier stands, from first contact to trading (``ap/vendor_lifecycle.py``). A
    #: vendor that predates the lifecycle was already given orders, so the default is Approved;
    #: the create route starts a new one as a Prospect.
    stage: Mapped[str] = mapped_column(String(16), default="Approved", server_default="Approved")
    stage_since: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    stage_reason: Mapped[str | None] = mapped_column(String(500), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    tags: Mapped[list[Tag]] = relationship(secondary=vendor_tags, lazy="selectin")

    __table_args__ = (
        CheckConstraint("length(btrim(name)) > 0", name="name_present"),
        CheckConstraint("pph23_rate IS NULL OR pph23_rate >= 0", name="rate_non_negative"),
        CheckConstraint(
            "terms_dp_percent >= 0 AND terms_dp_percent <= 100", name="dp_percent_range"
        ),
        CheckConstraint("terms_settlement_days >= 0", name="settlement_days_non_negative"),
        CheckConstraint(
            "stage IN ('Prospect', 'Onboarding', 'Approved', 'Active', 'On hold', 'Blacklisted')",
            name="stage_known",
        ),
    )


class CatalogueItem(Base):
    __tablename__ = "vendor_catalogue_items"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    item_no: Mapped[str] = mapped_column(String(16), unique=True)
    vendor_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("vendors.id"), index=True
    )
    item: Mapped[str] = mapped_column(String(200))
    category: Mapped[str | None] = mapped_column(String(64), nullable=True)
    subcategory: Mapped[str | None] = mapped_column(String(64), nullable=True)
    unit_price: Mapped[Decimal] = mapped_column(MONEY)

    #: Fractional on purpose — the seed rents LED wall by the square metre.
    stock: Mapped[Decimal] = mapped_column(QTY, default=Decimal("0"))
    unit: Mapped[str | None] = mapped_column(String(16), nullable=True)

    tags: Mapped[list[Tag]] = relationship(secondary=catalogue_tags, lazy="selectin")

    __table_args__ = (
        CheckConstraint("unit_price >= 0", name="price_non_negative"),
        CheckConstraint("stock >= 0", name="stock_non_negative"),
    )


class Booking(Base):
    """Stock held for an event window.

    ``purchase_order_id`` is **nullable** on purpose: a hold can be placed without a
    purchase order, and must survive one being cancelled. Cancelling a PO releases only its
    own reservations.
    """

    __tablename__ = "catalogue_bookings"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    item_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("vendor_catalogue_items.id"), index=True
    )
    from_date: Mapped[date] = mapped_column(Date)
    to_date: Mapped[date] = mapped_column(Date)
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("projects.id"), nullable=True
    )
    purchase_order_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("purchase_orders.id"), nullable=True, index=True
    )
    qty: Mapped[Decimal] = mapped_column(QTY)

    __table_args__ = (
        CheckConstraint("qty > 0", name="qty_positive"),
        CheckConstraint("to_date >= from_date", name="window_ordered"),
    )


class PurchaseOrder(Base):
    __tablename__ = "purchase_orders"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    po_no: Mapped[str] = mapped_column(String(32), unique=True)
    vendor_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("vendors.id"), index=True
    )
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("projects.id"), nullable=True, index=True
    )
    status: Mapped[PoStatus] = mapped_column(
        enum_column(PoStatus, "po_status"), default=PoStatus.DRAFT
    )
    order_date: Mapped[date] = mapped_column(Date)
    event_date: Mapped[date | None] = mapped_column(Date, nullable=True)

    terms_dp_percent: Mapped[Decimal] = mapped_column(Numeric(6, 3), default=Decimal("50"))
    terms_settlement_days: Mapped[int] = mapped_column(Integer, default=14)

    dp_paid_at: Mapped[date | None] = mapped_column(Date, nullable=True)
    settled_at: Mapped[date | None] = mapped_column(Date, nullable=True)

    #: What the vendor actually invoiced. May differ from the committed total — the
    #: difference is the variance, and the client asked for it to be tracked explicitly.
    actual_total: Mapped[Decimal | None] = mapped_column(MONEY, nullable=True)

    #: The date ON the vendor's invoice, which is not the date it was recorded.
    #:
    #: It lives here rather than on the bill entry for a mechanical reason: the payable is
    #: raised lazily at the FIRST payment, so on the usual DP-then-settle path the bill
    #: already exists by the time the final invoice arrives — and `ensure_bill` is
    #: idempotent, so a date passed at settlement would be silently dropped. Journal
    #: entries are append-only, so it cannot be added to the bill afterwards either. Beside
    #: `actual_total` is where the vendor's invoice is already described, so this is where
    #: its date belongs. `settled_at` remains the accounting date.
    invoice_date: Mapped[date | None] = mapped_column(Date, nullable=True)

    #: Have the goods arrived? Separate from payment: a PO can be paid and not delivered, or the
    #: other way round. Posts nothing; it is a record staff keep.
    delivery_status: Mapped[str] = mapped_column(
        String(16), default="Not started", server_default="Not started"
    )
    delivery_updated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    delivery_updated_by: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    lines: Mapped[list[PurchaseOrderLine]] = relationship(
        back_populates="order",
        order_by="PurchaseOrderLine.line_no",
        lazy="selectin",
        cascade="all, delete-orphan",
    )

    __table_args__ = (
        CheckConstraint(
            "terms_dp_percent >= 0 AND terms_dp_percent <= 100", name="dp_percent_range"
        ),
        CheckConstraint("actual_total IS NULL OR actual_total >= 0", name="actual_non_negative"),
        CheckConstraint(
            "delivery_status IN ('Not started', 'In progress', 'Delivered')", name="delivery_known"
        ),
    )


DELIVERY_STATUSES = ("Not started", "In progress", "Delivered")
VENDOR_FILE_KINDS = ("Agreement", "NPWP", "Bank letter", "Price list", "Other")


class VendorAttachment(Base):
    """A stored file (an ``attachments`` row) filed against a vendor, with what it is.

    Removing the link leaves the stored file (it may be filed elsewhere); removing the vendor or
    the file removes the link. An ``Agreement`` file ticks the vendor checklist's agreement item.
    """

    __tablename__ = "vendor_attachments"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    vendor_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("vendors.id", ondelete="CASCADE")
    )
    attachment_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("attachments.id", ondelete="CASCADE")
    )
    kind: Mapped[str] = mapped_column(String(24))
    note: Mapped[str | None] = mapped_column(String(200), nullable=True)
    created_by: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint(
            "kind IN ('Agreement', 'NPWP', 'Bank letter', 'Price list', 'Other')",
            name="kind_known",
        ),
        UniqueConstraint("vendor_id", "attachment_id"),
        Index("ix_vendor_attachments_vendor", "vendor_id"),
        Index("ix_vendor_attachments_attachment", "attachment_id"),
    )


class PurchaseOrderLine(Base):
    __tablename__ = "purchase_order_lines"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    purchase_order_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("purchase_orders.id", ondelete="CASCADE"), index=True
    )
    line_no: Mapped[int] = mapped_column(Integer)
    catalogue_item_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("vendor_catalogue_items.id"), nullable=True
    )
    item_label: Mapped[str] = mapped_column(String(200))
    qty: Mapped[Decimal] = mapped_column(QTY)
    unit_price: Mapped[Decimal] = mapped_column(MONEY)

    order: Mapped[PurchaseOrder] = relationship(back_populates="lines")

    __table_args__ = (
        CheckConstraint("qty > 0", name="qty_positive"),
        CheckConstraint("unit_price >= 0", name="price_non_negative"),
        # Named distinctly from quotation_lines' constraint: an explicit UniqueConstraint name
        # is used verbatim, and Postgres constraint names are schema-wide.
        UniqueConstraint("purchase_order_id", "line_no", name="po_line_order"),
    )


class VendorStageHistory(Base):
    """Every stage a vendor has been moved to, with who and why. Never edited."""

    __tablename__ = "vendor_stage_history"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    vendor_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("vendors.id", ondelete="CASCADE")
    )
    stage: Mapped[str] = mapped_column(String(16))
    reason: Mapped[str | None] = mapped_column(String(500), nullable=True)
    created_by: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint(
            "stage IN ('Prospect', 'Onboarding', 'Approved', 'Active', 'On hold', 'Blacklisted')",
            name="stage_known",
        ),
        Index("ix_vendor_stage_history_vendor", "vendor_id", "created_at"),
    )


class VendorCheck(Base):
    """A hand-ticked onboarding item (the agreement, the reference check)."""

    __tablename__ = "vendor_checks"

    vendor_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("vendors.id", ondelete="CASCADE"), primary_key=True
    )
    key: Mapped[str] = mapped_column(String(16), primary_key=True)
    done: Mapped[bool] = mapped_column(Boolean)
    updated_by: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), ForeignKey("users.id"))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint("key IN ('agreement', 'reference')", name="key_known"),
    )
