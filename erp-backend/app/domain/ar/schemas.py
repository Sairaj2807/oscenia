"""Accounts Receivable request and response models."""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel, Field, field_validator

from app.core.schemas import MoneyStr, Schema
from app.domain.ar.models import (
    InteractionType,
    InvoiceStatus,
    InvoiceType,
    QuotationStatus,
    Stage,
    StageAnchor,
    StageBasis,
)
from app.domain.ledger.schemas import JournalLineIn

# --- clients ----------------------------------------------------------------


class ClientOut(Schema):
    id: uuid.UUID
    client_no: str
    name: str
    contact: str | None
    email: str | None
    phone: str | None
    birthday: str | None
    anniversary: str | None
    personal_brand: str | None
    fav_vendor: str | None
    satisfaction: Decimal


class ClientCreate(BaseModel):
    name: str = Field(min_length=1)
    contact: str | None = None
    email: str | None = None
    phone: str | None = None
    birthday: str | None = None
    anniversary: str | None = None
    personal_brand: str | None = None
    fav_vendor: str | None = None


class FileRef(Schema):
    """A stored file as a note lists it; the bytes come from ``GET /attachments/{id}``."""

    id: uuid.UUID
    filename: str
    byte_size: int


class InteractionOut(Schema):
    id: uuid.UUID
    client_id: uuid.UUID
    interaction_date: date
    type: InteractionType
    author_user_id: uuid.UUID

    #: The author's display name. Carried for the same reason as on a quotation: the CRM
    #: timeline shows who wrote each note, there is no users endpoint for the frontend to
    #: resolve the id against, and a note attributed to a UUID is not attributed at all.
    author_name: str | None = None

    note: str
    edited_at: datetime | None
    attachments: list[FileRef] = []


class InteractionAttach(BaseModel):
    attachment_id: uuid.UUID


class InteractionCreate(BaseModel):
    note: str = Field(min_length=1)
    type: InteractionType = InteractionType.NOTE
    interaction_date: date | None = None


class InteractionUpdate(BaseModel):
    """Editing a note. The author is never reassigned.

    The client asked for CRM notes they could "create, edit, and attach" — create alone was
    already built, and `ClientInteraction.edited_at` existed with nothing to set it.
    """

    note: str | None = Field(default=None, min_length=1)
    type: InteractionType | None = None
    interaction_date: date | None = None


class ClientUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1)
    contact: str | None = None
    email: str | None = None
    phone: str | None = None
    birthday: str | None = None
    anniversary: str | None = None
    personal_brand: str | None = None
    fav_vendor: str | None = None


# --- billing stages ---------------------------------------------------------


class StageIn(BaseModel):
    label: str = Field(min_length=1)
    basis: StageBasis = StageBasis.PERCENT
    value: Decimal = Field(ge=0)
    anchor: StageAnchor = StageAnchor.SIGNING

    #: Signed. Negative means before the anchor, so a settlement a week before the event is
    #: ``anchor=event, offset_days=-7``.
    offset_days: int = 0


class ResolvedStageOut(Schema):
    stage_no: int
    label: str
    basis: StageBasis
    value: Decimal
    anchor: StageAnchor
    offset_days: int
    amount: MoneyStr
    due: date | None
    percent: Decimal
    invoice_type: InvoiceType


class ResolveRequest(BaseModel):
    stages: list[StageIn] = Field(min_length=1)
    contract_value: Decimal = Field(gt=0)
    signing_date: date | None = None
    event_date: date | None = None


class PresetOut(Schema):
    key: str
    label: str
    stages: list[StageIn]


# --- quotations -------------------------------------------------------------


class QuotationLineIn(BaseModel):
    label: str = Field(min_length=1)
    amount: Decimal = Field(ge=0)

    #: Estimated cost per line — what makes the live margin real rather than a hardcoded
    #: 30%, which is what the round-1 build had.
    est_cost: Decimal = Field(default=Decimal("0"), ge=0)


class QuotationLineOut(Schema):
    line_no: int
    label: str
    amount: MoneyStr
    est_cost: MoneyStr


class QuotationCreate(BaseModel):
    client_id: uuid.UUID
    event_type: str = Field(min_length=1)
    event_date: date | None = None
    lines: list[QuotationLineIn] = Field(min_length=1)
    stages: list[StageIn] | None = None
    preset: str | None = Field(default=None, description="50 | 75 | 100 | staged")
    mou_template_id: str | None = None

    @field_validator("preset")
    @classmethod
    def _known_preset(cls, v: str | None) -> str | None:
        if v is not None and v not in {"50", "75", "100", "staged"}:
            raise ValueError("preset must be one of 50, 75, 100, staged")
        return v


class QuotationUpdate(BaseModel):
    event_type: str | None = None
    event_date: date | None = None
    lines: list[QuotationLineIn] | None = None
    stages: list[StageIn] | None = None
    preset: str | None = None
    mou_template_id: str | None = None


class QuotationOut(Schema):
    id: uuid.UUID
    quotation_no: str
    client_id: uuid.UUID
    mou_template_id: str | None
    event_type: str
    event_date: date | None
    status: QuotationStatus
    created_by_user_id: uuid.UUID

    #: The author's display name. Carried here because a quotation PDF prints "Prepared by"
    #: on a document that goes to the client, and there is no users endpoint for the frontend
    #: to resolve the id against — so without this it would print a UUID.
    created_by_name: str | None = None

    lines: list[QuotationLineOut]

    contract_value: MoneyStr
    estimated_cost: MoneyStr
    margin: Decimal
    schedule: list[ResolvedStageOut]


# --- MoU templates ----------------------------------------------------------


class ClauseOut(Schema):
    clause_no: int
    text: str


class TemplateOut(Schema):
    id: str
    label: str
    heading: str
    validity: str | None
    signatory: str | None
    is_default: bool
    clauses: list[ClauseOut]


class TemplateCreate(BaseModel):
    id: str = Field(min_length=1, pattern=r"^[a-z0-9-]+$")
    label: str = Field(min_length=1)
    heading: str = Field(min_length=1)
    validity: str | None = None
    signatory: str | None = None
    clauses: list[str] = Field(default_factory=list)


class TemplateUpdate(BaseModel):
    """Edit a template. ``clauses`` replaces the whole list (order included), which is how the
    screen's add / remove / move / edit-a-clause all arrive: one save, one consistent template."""

    label: str | None = Field(default=None, min_length=1)
    heading: str | None = Field(default=None, min_length=1)
    validity: str | None = None
    signatory: str | None = None
    clauses: list[str] | None = None


# --- projects ---------------------------------------------------------------


class ProjectOut(Schema):
    id: uuid.UUID
    project_no: str
    name: str
    client_id: uuid.UUID
    quotation_id: uuid.UUID | None
    stage: Stage
    stage_since: date
    division: str | None
    contract_value: MoneyStr
    estimated_cost: MoneyStr
    event_date: date | None
    cancelled: bool
    cancel_reason: str | None
    #: The project's PM. Set through ``PUT /projects/{id}/pm``; ``pm_name`` is filled by the
    #: read endpoints (a join), so it is None on the responses of the other project writes.
    pm_user_id: uuid.UUID | None = None
    pm_name: str | None = None


class HistoryVendorOut(Schema):
    vendor_id: uuid.UUID
    name: str
    spend: MoneyStr


class HistoryEventOut(Schema):
    project_id: uuid.UUID
    project_no: str
    name: str
    event_date: date | None
    event_type: str | None
    division: str | None
    contract_value: MoneyStr
    stage: str
    cancelled: bool
    #: The post-event client rating (0-10), if one was recorded.
    rating: Decimal | None
    invoiced: MoneyStr
    collected: MoneyStr
    vendors: list[HistoryVendorOut]


class HistoryTypeOut(Schema):
    event_type: str
    count: int


class HistoryVendorTotalOut(Schema):
    vendor_id: uuid.UUID
    name: str
    events: int
    spend: MoneyStr


class ClientHistoryOut(Schema):
    """A client's past work, derived from projects, invoices, ratings and purchase orders."""

    client_id: uuid.UUID
    #: Contract value of projects not cancelled.
    contracted: MoneyStr
    #: Issued invoices (unpaid, part paid or paid) on those projects.
    invoiced: MoneyStr
    #: Invoices fully paid (a part payment shows only in the ledger).
    collected: MoneyStr
    event_count: int
    avg_rating: Decimal | None
    preferred_event_types: list[HistoryTypeOut]
    vendors_used: list[HistoryVendorTotalOut]
    events: list[HistoryEventOut]


class ProjectPatch(BaseModel):
    """Only these three can be edited; send just the ones that change."""

    name: str | None = Field(default=None, max_length=200)
    division: str | None = Field(default=None, max_length=64)
    event_date: date | None = None


class ProjectEditOut(Schema):
    project: ProjectOut
    #: What a changed event date carried with it (see ``ar/project_edit.py``).
    invoices_rescheduled: int
    delivery_orders_updated: int
    items_updated: int
    #: Things staff still have to do by hand, e.g. an invitation that shows the old date.
    warnings: list[str]


class ProjectPmSet(BaseModel):
    #: ``null`` clears the PM.
    user_id: uuid.UUID | None


class StageMove(BaseModel):
    stage: Stage


class CancelRequest(BaseModel):
    reason: str = Field(default="", max_length=2000)
    refund_dp: bool = False


# --- invoices ---------------------------------------------------------------


class InvoiceOut(Schema):
    id: uuid.UUID
    invoice_no: str
    project_id: uuid.UUID
    type: InvoiceType
    stage_label: str
    stage_no: int
    amount: MoneyStr
    status: InvoiceStatus
    due_date: date | None
    document_date: date | None
    issued_at: date | None
    last_paid_at: date | None
    recognition_entry_id: uuid.UUID | None

    #: Derived from the ledger, never stored — storing them invites the drift the
    #: Receivables reconciliation badge exists to detect.
    collected: MoneyStr
    outstanding: MoneyStr


class IssueRequest(BaseModel):
    """Raising a receivable, with both dates the client asked for.

    `issued_on` is the **Main Date**: when the receivable is recorded, and therefore the
    accounting date of the posting. It defaults to today, which is what the endpoint used to
    hardcode with no way to override — so an invoice entered late could only ever post to
    the current month.

    `document_date` is the date on the invoice itself. It changes no report; it is there so
    a document dated last month and recorded this month can be reconciled as both.
    """

    issued_on: date | None = None
    document_date: date | None = None


class PaymentRequest(BaseModel):
    amount: Decimal = Field(gt=0)
    payment_date: date | None = None
    cash_account: str = "1101"

    #: The client withholds PPh 23 by default. Waivable, and overridable with an explicit
    #: figure — the prototype supports both and warns on the override.
    withhold: bool = True
    tax_amount: Decimal | None = Field(default=None, ge=0)

    #: The date on the client's receipt / transfer slip, stored as the entry's
    #: `source_document_date`. `payment_date` stays the accounting (received) date.
    document_date: date | None = None

    #: Replace the computed receipt lines (round 4, REQ-05 v2). Guarded: 1201 must still be
    #: credited by exactly the computed gross; accounts active and postable; balanced.
    lines: list[JournalLineIn] | None = Field(default=None, min_length=2)


class PostingLineOut(Schema):
    account: str
    debit: MoneyStr
    credit: MoneyStr
    note: str | None


class ClientReceiptOut(Schema):
    entry_id: uuid.UUID
    entry_no: str
    voucher_no: str
    gross: MoneyStr
    tax: MoneyStr
    net: MoneyStr
    cash_account: str
    invoice: InvoiceOut

    #: The exact lines written, so the UI can show them as the prototype's receive-payment
    #: modal does before submission.
    posting: list[PostingLineOut]


class ConfirmDpRequest(BaseModel):
    confirmed_on: date | None = None
    cash_account: str = "1101"
    withhold: bool = True

    #: The three fields below apply to the DP **receipt** only, never to the DP invoice.
    #: An explicit PPh 23 figure; wins over `withhold`. Refused above the receipt's gross.
    tax_amount: Decimal | None = Field(default=None, ge=0)
    #: The date on the client's receipt, stored as the receipt's `source_document_date`.
    document_date: date | None = None
    #: Replacement receipt lines, under the same guard as `PaymentRequest.lines`.
    lines: list[JournalLineIn] | None = Field(default=None, min_length=2)


# --- ageing -----------------------------------------------------------------


class BucketOut(Schema):
    key: str
    label: str
    amount: MoneyStr
    count: int
    share: float


class ReceivablesAgeingOut(Schema):
    as_of: date
    buckets: list[BucketOut]
    total: MoneyStr
    overdue: MoneyStr

    #: Scheduled stages are reported separately and **excluded from the total** — they have
    #: posted nothing, and counting them would put AR permanently out of step with 1201.
    scheduled: MoneyStr
    scheduled_count: int

    ledger_balance: MoneyStr
    difference: MoneyStr
    reconciled: bool
