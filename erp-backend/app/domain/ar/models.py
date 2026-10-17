"""Clients, projects, quotations, MoU templates and invoices.

Three absences are deliberate, and each looks like an oversight until you know why:

* **``invoices`` has no ``paid`` column.** Collected-to-date is the sum of applications
  against the invoice's recognition entry. Storing it invites exactly the drift the
  Receivables screen's *Reconciled / Out by X* badge exists to detect.
* **``projects`` has no ``realized_cost``.** The prototype caches it and its own notes list
  that as a known gap; here it is a query over the ledger.
* **A ``Scheduled`` invoice has no recognition entry.** It has posted nothing, so it is not
  a receivable — inherited ruling 3. ``recognition_entry_id`` is filled at issue.
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


class Stage(enum.StrEnum):
    """The milestone pipeline, in order. ``STAGES`` in the prototype."""

    DP_PAID = "DP Paid"
    DESIGN_UPLOADED = "Design Uploaded"
    CLIENT_APPROVAL = "Client Approval"
    VENDOR_DISPATCH = "Vendor Dispatch"
    EXECUTION_EVENT = "Execution Event"
    POST_EVENT_FEEDBACK = "Post-Event Feedback"
    FINISHED = "Finished"


STAGE_ORDER: list[Stage] = list(Stage)


class QuotationStatus(enum.StrEnum):
    DRAFT = "Draft"
    SENT = "Sent"
    ACCEPTED = "Accepted"
    DECLINED = "Declined"


class InvoiceType(enum.StrEnum):
    DOWN_PAYMENT = "Down Payment"
    PROGRESS = "Progress"
    FINAL = "Final"


class InvoiceStatus(enum.StrEnum):
    #: Minted from a billing schedule but not yet issued. **Excluded from AR** — it has
    #: posted nothing, and a plan is not a debt.
    SCHEDULED = "Scheduled"
    UNPAID = "Unpaid"
    PARTIALLY_PAID = "Partially Paid"
    PAID = "Paid"
    CANCELLED = "Cancelled"


class StageBasis(enum.StrEnum):
    PERCENT = "percent"
    AMOUNT = "amount"


class StageAnchor(enum.StrEnum):
    SIGNING = "signing"
    EVENT = "event"


class InteractionType(enum.StrEnum):
    MEETING = "Meeting"
    CALL = "Call"
    QUOTE_SENT = "Quote sent"
    EVENT_CLOSED = "Event closed"
    ANNIVERSARY = "Anniversary"
    NOTE = "Note"


# ---------------------------------------------------------------------------
# CRM
# ---------------------------------------------------------------------------


class Client(Base):
    __tablename__ = "clients"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    client_no: Mapped[str] = mapped_column(String(16), unique=True)
    name: Mapped[str] = mapped_column(String(160))
    contact: Mapped[str | None] = mapped_column(String(120), nullable=True)
    email: Mapped[str | None] = mapped_column(String(200), nullable=True)
    phone: Mapped[str | None] = mapped_column(String(64), nullable=True)

    #: Free text, as in the prototype: '28 Jul', '01 Mar 2019', '—'. Converting these to
    #: real dates is a data-cleanup exercise parked as Q10 in the open questions — the
    #: birthday reminder job currently string-matches them.
    birthday: Mapped[str | None] = mapped_column(String(64), nullable=True)
    anniversary: Mapped[str | None] = mapped_column(String(64), nullable=True)

    personal_brand: Mapped[str | None] = mapped_column(Text, nullable=True)
    fav_vendor: Mapped[str | None] = mapped_column(String(160), nullable=True)

    #: 0-5, unlike crew ratings which are 0-10. Kept as the prototype has it.
    satisfaction: Mapped[Decimal] = mapped_column(Numeric(2, 1), default=Decimal("0"))

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (CheckConstraint("length(btrim(name)) > 0", name="name_present"),)


class ClientInteraction(Base):
    """A CRM note.

    The client asked for a "free-text Note column… without character limits", each entry
    "saved automatically with a timestamp and the identity of the account staff who
    inputted it" — hence ``Text`` and a real ``author_user_id`` foreign key rather than the
    prototype's role-derived display name.
    """

    __tablename__ = "client_interactions"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    client_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("clients.id"), index=True
    )
    interaction_date: Mapped[date] = mapped_column(Date)
    type: Mapped[InteractionType] = mapped_column(
        enum_column(InteractionType, "interaction_type"), default=InteractionType.NOTE
    )
    author_user_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id")
    )
    note: Mapped[str] = mapped_column(Text)
    edited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (CheckConstraint("length(btrim(note)) > 0", name="note_present"),)


class InteractionAttachment(Base):
    """A stored file filed against a CRM note.

    The file itself is an ``attachments`` row (the same store receipts and price lists use); this
    only says which notes it belongs to. Deleting a note, or the attachment, removes the link and
    nothing else, so a file filed against two notes survives the removal of one.
    """

    __tablename__ = "client_interaction_attachments"

    interaction_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("client_interactions.id", ondelete="CASCADE"),
        primary_key=True,
    )
    attachment_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("attachments.id", ondelete="CASCADE"), primary_key=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


# ---------------------------------------------------------------------------
# MoU templates
# ---------------------------------------------------------------------------


class MouTemplate(Base):
    __tablename__ = "mou_templates"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    label: Mapped[str] = mapped_column(String(120))
    heading: Mapped[str] = mapped_column(String(200))
    validity: Mapped[str | None] = mapped_column(String(200), nullable=True)
    signatory: Mapped[str | None] = mapped_column(String(120), nullable=True)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")

    clauses: Mapped[list[MouClause]] = relationship(
        back_populates="template",
        order_by="MouClause.clause_no",
        lazy="selectin",
        cascade="all, delete-orphan",
    )


class MouClause(Base):
    __tablename__ = "mou_template_clauses"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    template_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("mou_templates.id", ondelete="CASCADE"), index=True
    )
    clause_no: Mapped[int] = mapped_column(Integer)
    text: Mapped[str] = mapped_column(Text)

    template: Mapped[MouTemplate] = relationship(back_populates="clauses")

    __table_args__ = (UniqueConstraint("template_id", "clause_no", name="clause_order"),)


# ---------------------------------------------------------------------------
# Quotations
# ---------------------------------------------------------------------------


class Quotation(Base):
    """A priced offer, with a billing schedule attached.

    Contract value and margin are **summed from the lines**, never stored — the client
    asked for a live margin during entry, and a stored total is one more thing to drift.
    """

    __tablename__ = "quotations"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    quotation_no: Mapped[str] = mapped_column(String(32), unique=True)
    client_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("clients.id"), index=True
    )
    mou_template_id: Mapped[str | None] = mapped_column(
        String(64), ForeignKey("mou_templates.id"), nullable=True
    )
    event_type: Mapped[str] = mapped_column(String(160))
    event_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    status: Mapped[QuotationStatus] = mapped_column(
        enum_column(QuotationStatus, "quotation_status"), default=QuotationStatus.DRAFT
    )
    created_by_user_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id")
    )
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    lines: Mapped[list[QuotationLine]] = relationship(
        back_populates="quotation",
        order_by="QuotationLine.line_no",
        lazy="selectin",
        cascade="all, delete-orphan",
    )
    stages: Mapped[list[QuotationStage]] = relationship(
        back_populates="quotation",
        order_by="QuotationStage.stage_no",
        lazy="selectin",
        cascade="all, delete-orphan",
    )


class QuotationLine(Base):
    """A priced line. ``est_cost`` is what makes the live margin possible.

    The prototype's round-1 review found margin hardcoded to 30%; per-line estimated cost
    is what replaced it.
    """

    __tablename__ = "quotation_lines"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    quotation_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("quotations.id", ondelete="CASCADE"), index=True
    )
    line_no: Mapped[int] = mapped_column(Integer)
    label: Mapped[str] = mapped_column(String(200))
    amount: Mapped[Decimal] = mapped_column(MONEY)
    est_cost: Mapped[Decimal] = mapped_column(MONEY, default=Decimal("0.00"))

    quotation: Mapped[Quotation] = relationship(back_populates="lines")

    __table_args__ = (
        CheckConstraint("amount >= 0 AND est_cost >= 0", name="non_negative"),
        UniqueConstraint("quotation_id", "line_no", name="line_order"),
    )


class QuotationStage(Base):
    """One stage of a phased down-payment schedule.

    ``offset_days`` is signed: negative means *before* the anchor, so a final settlement
    seven days before the event is ``anchor=event, offset_days=-7``.
    """

    __tablename__ = "quotation_dp_stages"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    quotation_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("quotations.id", ondelete="CASCADE"), index=True
    )
    stage_no: Mapped[int] = mapped_column(Integer)
    label: Mapped[str] = mapped_column(String(120))
    basis: Mapped[StageBasis] = mapped_column(enum_column(StageBasis, "stage_basis"))
    value: Mapped[Decimal] = mapped_column(Numeric(18, 4))
    anchor: Mapped[StageAnchor] = mapped_column(
        enum_column(StageAnchor, "stage_anchor"), default=StageAnchor.SIGNING
    )
    offset_days: Mapped[int] = mapped_column(Integer, default=0)

    quotation: Mapped[Quotation] = relationship(back_populates="stages")

    __table_args__ = (
        CheckConstraint("value >= 0", name="non_negative"),
        UniqueConstraint("quotation_id", "stage_no", name="stage_order"),
    )


# ---------------------------------------------------------------------------
# Projects
# ---------------------------------------------------------------------------


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    project_no: Mapped[str] = mapped_column(String(32), unique=True)
    name: Mapped[str] = mapped_column(String(200))
    client_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("clients.id"), index=True
    )

    #: A quotation converts exactly once. This unique constraint *is* the idempotency of
    #: confirming a down payment — it replaces the prototype's in-memory `dpConfirmed`
    #: flag, which a stateless API cannot rely on.
    quotation_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("quotations.id"), unique=True, nullable=True
    )

    stage: Mapped[Stage] = mapped_column(
        enum_column(Stage, "project_stage"), default=Stage.DP_PAID
    )
    stage_since: Mapped[date] = mapped_column(Date)
    division: Mapped[str | None] = mapped_column(String(64), nullable=True)
    contract_value: Mapped[Decimal] = mapped_column(MONEY)
    estimated_cost: Mapped[Decimal] = mapped_column(MONEY, default=Decimal("0.00"))
    event_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    pm_user_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )

    cancelled: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    cancelled_at: Mapped[date | None] = mapped_column(Date, nullable=True)
    cancel_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    dp_refunded: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")

    #: Bumping this revokes every copy of the client's survey link (``payroll/survey.py``).
    survey_link_version: Mapped[int] = mapped_column(
        Integer, default=1, server_default="1"
    )

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint("contract_value >= 0", name="contract_non_negative"),
        CheckConstraint("estimated_cost >= 0", name="estimate_non_negative"),
        CheckConstraint("survey_link_version >= 1", name="survey_link_version_positive"),
    )


class ProjectStageHistory(Base):
    """New: the prototype keeps only ``stageSince``, which cannot answer "how long were we
    in Client Approval"."""

    __tablename__ = "project_stage_history"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("projects.id"), index=True
    )
    stage: Mapped[Stage] = mapped_column(enum_column(Stage, "project_stage"))
    entered_on: Mapped[date] = mapped_column(Date)
    by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


# ---------------------------------------------------------------------------
# Invoices
# ---------------------------------------------------------------------------


class Invoice(Base):
    __tablename__ = "invoices"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    invoice_no: Mapped[str] = mapped_column(String(32), unique=True)
    project_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("projects.id"), index=True
    )
    type: Mapped[InvoiceType] = mapped_column(enum_column(InvoiceType, "invoice_type"))

    #: The billing stage this came from, e.g. "Down Payment", "Final Settlement".
    stage_label: Mapped[str] = mapped_column(String(120))
    stage_no: Mapped[int] = mapped_column(Integer, default=1)

    amount: Mapped[Decimal] = mapped_column(MONEY)
    status: Mapped[InvoiceStatus] = mapped_column(
        enum_column(InvoiceStatus, "invoice_status"), default=InvoiceStatus.SCHEDULED
    )
    due_date: Mapped[date | None] = mapped_column(Date, nullable=True)

    #: The date ON the invoice document, which is not necessarily the date it was recorded.
    #:
    #: The accounting date stays `journal_entries.entry_date` — every report and the
    #: period-close trigger read that, and it is what stops an invoice arriving after a
    #: month closes from being backdated into it. This column answers the different
    #: question of what the document itself is dated, for display and reconciliation.
    #: Nullable because most invoices are raised the day they are dated.
    document_date: Mapped[date | None] = mapped_column(Date, nullable=True)

    #: When the receivable was actually raised — the "Main Date" in the client's wording.
    issued_at: Mapped[date | None] = mapped_column(Date, nullable=True)
    last_paid_at: Mapped[date | None] = mapped_column(Date, nullable=True)

    #: The entry that raised the receivable. NULL while Scheduled — a scheduled stage has
    #: posted nothing, which is precisely why it is excluded from AR.
    recognition_entry_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("journal_entries.id"), nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint("amount >= 0", name="amount_non_negative"),
        UniqueConstraint("project_id", "stage_no", name="one_invoice_per_stage"),
    )
