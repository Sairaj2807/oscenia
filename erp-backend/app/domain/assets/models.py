"""Fixed assets, inventory and crew.

The register is a **sub-ledger**, not the truth: account 1302 holds the cost and 1303 the
accumulated depreciation, and the register must tie to both. Where it drifts, the screen
says so rather than quietly preferring one.

``posted_through`` and ``posted_accumulated`` record what has actually reached the ledger,
which is what makes a depreciation run idempotent and a life revision prospective.
"""

from __future__ import annotations

import enum
import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.domain.masters.models import enum_column

MONEY = Numeric(18, 2)
QTY = Numeric(14, 2)


class Method(enum.StrEnum):
    STRAIGHT_LINE = "straight-line"

    #: Double-rate, front-loaded, floored at the straight-line of whatever remains so the
    #: asset still finishes on its salvage value rather than approaching it forever.
    DECLINING = "declining"


class AssetStatus(enum.StrEnum):
    ACTIVE = "active"
    DISPOSED = "disposed"


class InventoryType(enum.StrEnum):
    CONSUMABLE = "Consumable"
    FIXED_ASSET = "Fixed Asset"


class InventoryStatus(enum.StrEnum):
    IN_STOCK = "in_stock"
    IN_TRANSIT = "in_transit"
    MAINTENANCE = "maintenance"
    WRITTEN_OFF = "written_off"


class ReturnCondition(enum.StrEnum):
    """How kit comes back from a venue. Lost stock is the one that reaches the ledger."""

    GOOD = "good"
    DAMAGED = "damaged"
    LOST = "lost"


class FixedAsset(Base):
    __tablename__ = "fixed_assets"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    asset_no: Mapped[str] = mapped_column(String(16), unique=True)
    name: Mapped[str] = mapped_column(String(200))
    category: Mapped[str | None] = mapped_column(String(80), nullable=True)
    inventory_item_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("inventory_items.id"), nullable=True
    )

    acquired_on: Mapped[date] = mapped_column(Date)

    #: **Never patchable.** Cost is evidenced by the acquisition entry; changing it here
    #: would put the register out of step with 1302 with nothing in the ledger to explain
    #: the difference.
    cost: Mapped[Decimal] = mapped_column(MONEY)

    salvage: Mapped[Decimal] = mapped_column(MONEY, default=Decimal("0.00"))
    useful_life_months: Mapped[int] = mapped_column(Integer)
    method: Mapped[Method] = mapped_column(
        enum_column(Method, "depreciation_method"), default=Method.STRAIGHT_LINE
    )
    status: Mapped[AssetStatus] = mapped_column(
        enum_column(AssetStatus, "asset_status"), default=AssetStatus.ACTIVE
    )

    #: The last period actually posted, as 'YYYY-MM'. This is what makes a run idempotent:
    #: everything up to and including it has reached the ledger.
    posted_through: Mapped[str | None] = mapped_column(String(7), nullable=True)

    #: The ledger's accumulated figure for this asset. Also never patchable — it is a record
    #: of what was posted, not an opinion.
    posted_accumulated: Mapped[Decimal] = mapped_column(MONEY, default=Decimal("0.00"))

    #: Set when a useful life or method is revised. The schedule restarts here rather than
    #: being recalculated from acquisition, which is what makes revision **prospective**.
    schedule_from: Mapped[str | None] = mapped_column(String(7), nullable=True)
    opening_accumulated: Mapped[Decimal] = mapped_column(MONEY, default=Decimal("0.00"))

    disposed_at: Mapped[date | None] = mapped_column(Date, nullable=True)
    proceeds: Mapped[Decimal | None] = mapped_column(MONEY, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint("cost > 0", name="cost_positive"),
        CheckConstraint("salvage >= 0 AND salvage < cost", name="salvage_below_cost"),
        CheckConstraint("useful_life_months > 0", name="life_positive"),
        CheckConstraint("posted_accumulated >= 0", name="accumulated_non_negative"),
        CheckConstraint("length(btrim(name)) > 0", name="name_present"),
    )


class InventoryItem(Base):
    """Warehouse stock. Three of its movements reach the ledger.

    Consumables are expensed when released to a project; fixed assets stay on the balance
    sheet until they are lost or condemned. That split is the client's "dual-logic
    warehouse".
    """

    __tablename__ = "inventory_items"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    item_no: Mapped[str] = mapped_column(String(16), unique=True)
    item: Mapped[str] = mapped_column(String(200))
    type: Mapped[InventoryType] = mapped_column(enum_column(InventoryType, "inventory_type"))
    qty: Mapped[Decimal] = mapped_column(QTY)
    unit: Mapped[str | None] = mapped_column(String(16), nullable=True)
    unit_value: Mapped[Decimal] = mapped_column(MONEY)
    status: Mapped[InventoryStatus] = mapped_column(
        enum_column(InventoryStatus, "inventory_status"), default=InventoryStatus.IN_STOCK
    )
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("projects.id"), nullable=True
    )
    event_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    #: Set when the item is retired from the warehouse list. An archived item keeps its history and
    #: its ledger entries; it just stops being offered for movements and new delivery orders.
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint("qty >= 0", name="qty_non_negative"),
        CheckConstraint("unit_value >= 0", name="value_non_negative"),
    )

    @property
    def total_value(self) -> Decimal:
        return self.qty * self.unit_value


class Crew(Base):
    __tablename__ = "crew"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    crew_no: Mapped[str] = mapped_column(String(16), unique=True)
    name: Mapped[str] = mapped_column(String(120))
    role: Mapped[str | None] = mapped_column(String(80), nullable=True)
    base_rate: Mapped[Decimal] = mapped_column(MONEY)

    #: Out of 10. Used when a project has no post-event client rating yet.
    last_rating: Mapped[Decimal] = mapped_column(Numeric(3, 1), default=Decimal("0"))

    #: A deactivated member is left out of new incentive pools but stays on record (a paid pool
    #: names them).
    active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    deactivated_on: Mapped[date | None] = mapped_column(Date, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint("base_rate >= 0", name="rate_non_negative"),
        CheckConstraint("last_rating >= 0 AND last_rating <= 10", name="rating_range"),
    )


class ClientFeedback(Base):
    """A post-event score, out of 10. Once one exists, every crew member is paid on it."""

    __tablename__ = "client_feedback"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("projects.id"), unique=True
    )
    score: Mapped[Decimal] = mapped_column(Numeric(3, 1))
    submitted_on: Mapped[date] = mapped_column(Date)

    #: Whether the client rated through their own link or staff entered it.
    source: Mapped[str] = mapped_column(String(8), default="staff", server_default="staff")
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        CheckConstraint("score >= 0 AND score <= 10", name="score_range"),
        CheckConstraint("source IN ('staff', 'client')", name="source_known"),
    )


class IncentiveDisbursement(Base):
    """A paid crew incentive pool.

    ``project_id`` is unique: the pool is disbursed once per project. That constraint is
    what replaces the prototype's in-memory ``incentivesPaid`` flag.
    """

    __tablename__ = "incentive_disbursements"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("projects.id"), unique=True
    )
    amount: Mapped[Decimal] = mapped_column(MONEY)
    entry_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("journal_entries.id")
    )
    disbursed_on: Mapped[date] = mapped_column(Date)

    __table_args__ = (CheckConstraint("amount > 0", name="amount_positive"),)


class IncentiveDisbursementLine(Base):
    """Who was in a pool when it was paid, and on what terms: a snapshot, so a later rate change,
    re-rating or removal of a crew member never rewrites a pool that has been disbursed."""

    __tablename__ = "incentive_disbursement_lines"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    disbursement_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("incentive_disbursements.id", ondelete="CASCADE")
    )
    crew_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("crew.id", ondelete="SET NULL"), nullable=True
    )
    crew_no: Mapped[str] = mapped_column(String(16))
    name: Mapped[str] = mapped_column(String(120))
    role: Mapped[str | None] = mapped_column(String(80), nullable=True)
    base_rate: Mapped[Decimal] = mapped_column(MONEY)
    rating: Mapped[Decimal] = mapped_column(Numeric(3, 1))
    qualifies: Mapped[bool] = mapped_column(Boolean)
    bonus: Mapped[Decimal] = mapped_column(MONEY)

    __table_args__ = (
        Index("ix_incentive_lines_disbursement", "disbursement_id"),
        Index("ix_incentive_lines_crew", "crew_id"),
    )


class DeliveryStatus(enum.StrEnum):
    DRAFT = "Draft"
    DISPATCHED = "Dispatched"
    RECEIVED = "Received"


class DeliveryOrder(Base):
    """A delivery order: the document that goes with kit to an event.

    **A document, not a stock movement.** It lists what is going to which project's event and moves
    Draft -> Dispatched -> Received (signed once dispatched), as the prototype's does. It does not
    check stock out or in: that is ``POST /inventory/{id}/check-out`` and ``/return``. Whether a
    dispatch should drive those is the open client question (REQ-07, partial checkout), and
    nothing here decides it for them.
    """

    __tablename__ = "delivery_orders"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    do_no: Mapped[str] = mapped_column(String(16), unique=True)
    project_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("projects.id"), index=True
    )
    event_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    status: Mapped[DeliveryStatus] = mapped_column(
        enum_column(DeliveryStatus, "delivery_status"), default=DeliveryStatus.DRAFT
    )
    signed: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    dispatched_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    received_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    #: The recipient's drawn signature (a re-encoded PNG in the file store), who signed, and when.
    #: Not exposed as a URL: read through ``GET /delivery-orders/{id}/signature`` after a check.
    signature_key: Mapped[str | None] = mapped_column(String(200), nullable=True)
    signed_by_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    signed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_by_user_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id")
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    lines: Mapped[list[DeliveryOrderLine]] = relationship(
        order_by="DeliveryOrderLine.line_no",
        lazy="selectin",
        cascade="all, delete-orphan",
    )

    @property
    def has_signature(self) -> bool:
        return self.signature_key is not None


class DeliveryOrderLine(Base):
    __tablename__ = "delivery_order_lines"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    delivery_order_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("delivery_orders.id", ondelete="CASCADE"), index=True
    )
    line_no: Mapped[int] = mapped_column(Integer)
    #: The stock item it is for, when it is one. Optional: a line can be free text ("cable ramps").
    inventory_item_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("inventory_items.id"), nullable=True
    )
    item_label: Mapped[str] = mapped_column(String(200))
    qty: Mapped[Decimal] = mapped_column(QTY)

    __table_args__ = (
        CheckConstraint("qty > 0", name="qty_positive"),
        UniqueConstraint("delivery_order_id", "line_no", name="delivery_line_order"),
    )
