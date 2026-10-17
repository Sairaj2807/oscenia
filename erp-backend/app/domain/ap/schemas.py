"""Accounts Payable request and response models."""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel, Field, field_validator

from app.core.schemas import MoneyStr, Schema
from app.domain.ap.models import PoStatus
from app.domain.ledger.schemas import JournalLineIn

# --- tags -------------------------------------------------------------------


class TagOut(Schema):
    id: str
    label: str


class TagCreate(BaseModel):
    id: str = Field(min_length=1, pattern=r"^[a-z0-9-]+$")
    label: str = Field(min_length=1)


class TagUpdate(BaseModel):
    """Only the label changes: the id is the slug every vendor and item already points at."""

    label: str = Field(min_length=1)

    @field_validator("label")
    @classmethod
    def _not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("must not be blank")
        return v.strip()


# --- vendors ----------------------------------------------------------------


class VendorOut(Schema):
    id: uuid.UUID
    vendor_no: str
    name: str
    category: str | None
    baseline_price: MoneyStr
    score: Decimal
    delays: int
    npwp: str | None

    #: Null means "use the company default". A vendor-specific rate overrides it.
    pph23_rate: Decimal | None

    bank_name: str | None
    bank_account: str | None
    bank_holder: str | None
    pic_name: str | None
    pic_phone: str | None
    pic_email: str | None
    terms_dp_percent: Decimal
    terms_settlement_days: int
    tags: list[TagOut]
    stage: str
    stage_since: datetime | None
    stage_reason: str | None


class VendorCreate(BaseModel):
    name: str = Field(min_length=1)
    category: str | None = None
    baseline_price: Decimal = Field(default=Decimal("0"), ge=0)
    npwp: str | None = None
    pph23_rate: Decimal | None = Field(default=None, ge=0, le=100)
    bank_name: str | None = None
    bank_account: str | None = None
    bank_holder: str | None = None
    pic_name: str | None = None
    pic_phone: str | None = None
    pic_email: str | None = None
    terms_dp_percent: Decimal = Field(default=Decimal("50"), ge=0, le=100)
    terms_settlement_days: int = Field(default=14, ge=0)
    tags: list[str] = Field(default_factory=list)


class VendorUpdate(BaseModel):
    name: str | None = None
    category: str | None = None
    npwp: str | None = None
    pph23_rate: Decimal | None = Field(default=None, ge=0, le=100)
    bank_name: str | None = None
    bank_account: str | None = None
    bank_holder: str | None = None
    pic_name: str | None = None
    pic_phone: str | None = None
    pic_email: str | None = None
    terms_dp_percent: Decimal | None = Field(default=None, ge=0, le=100)
    terms_settlement_days: int | None = Field(default=None, ge=0)
    score: Decimal | None = Field(default=None, ge=0, le=5)
    delays: int | None = Field(default=None, ge=0)
    tags: list[str] | None = None


# --- catalogue --------------------------------------------------------------


class CatalogueItemOut(Schema):
    id: uuid.UUID
    item_no: str
    vendor_id: uuid.UUID
    item: str
    category: str | None
    subcategory: str | None
    unit_price: MoneyStr
    stock: Decimal
    unit: str | None
    tags: list[TagOut]


class CatalogueItemCreate(BaseModel):
    vendor_id: uuid.UUID
    item: str = Field(min_length=1)
    category: str | None = None
    subcategory: str | None = None
    unit_price: Decimal = Field(ge=0)
    stock: Decimal = Field(default=Decimal("0"), ge=0)
    unit: str | None = None
    tags: list[str] = Field(default_factory=list)


class CatalogueItemUpdate(BaseModel):
    """What can be corrected on a catalogue line. Stock is left out on purpose: lowering it below
    what is already booked for an event would oversell kit, and stock moves by its own rules."""

    item: str | None = Field(default=None, min_length=1)
    category: str | None = None
    subcategory: str | None = None
    unit_price: Decimal | None = Field(default=None, ge=0)
    unit: str | None = None
    tags: list[str] | None = None


class AvailabilityOut(Schema):
    item_id: uuid.UUID
    item: str
    stock: Decimal
    booked: Decimal
    available: Decimal
    status: str
    window_from: date
    window_to: date


# --- purchase orders --------------------------------------------------------


class PoLineIn(BaseModel):
    catalogue_item_id: uuid.UUID | None = None
    item_label: str = Field(min_length=1)

    #: Fractional quantities are legitimate — LED wall is priced by the square metre.
    qty: Decimal = Field(gt=0)
    unit_price: Decimal = Field(ge=0)


class PoLineOut(Schema):
    line_no: int
    catalogue_item_id: uuid.UUID | None
    item_label: str
    qty: Decimal
    unit_price: MoneyStr
    line_total: MoneyStr


class PurchaseOrderCreate(BaseModel):
    vendor_id: uuid.UUID
    project_id: uuid.UUID | None = None
    order_date: date | None = None
    event_date: date | None = None
    lines: list[PoLineIn] = Field(min_length=1)

    #: Default to the vendor's own terms when omitted.
    terms_dp_percent: Decimal | None = Field(default=None, ge=0, le=100)
    terms_settlement_days: int | None = Field(default=None, ge=0)


class PurchaseOrderOut(Schema):
    id: uuid.UUID
    po_no: str
    vendor_id: uuid.UUID
    project_id: uuid.UUID | None
    status: PoStatus
    order_date: date
    event_date: date | None
    terms_dp_percent: Decimal
    terms_settlement_days: int
    dp_paid_at: date | None
    settled_at: date | None
    actual_total: MoneyStr | None
    invoice_date: date | None
    #: Not started, In progress or Delivered: have the goods arrived (separate from payment).
    delivery_status: str
    delivery_updated_at: datetime | None
    lines: list[PoLineOut]

    committed: MoneyStr
    dp_amount: MoneyStr
    outstanding: MoneyStr

    #: ``committed - actual``. Positive means the vendor came in under budget. **Null until
    #: settled** — before that there is no actual, and zero would imply exactly on budget.
    variance: MoneyStr | None


class DeliveryIn(BaseModel):
    status: str = Field(max_length=16)


class VendorFileIn(BaseModel):
    #: The id from ``POST /attachments`` (upload the file first).
    attachment_id: uuid.UUID
    kind: str = Field(max_length=24)
    note: str | None = Field(default=None, max_length=200)


class VendorFileOut(Schema):
    id: uuid.UUID
    attachment_id: uuid.UUID
    kind: str
    note: str | None
    filename: str
    content_type: str
    byte_size: int
    uploaded_by: str
    created_at: datetime


class PoSettleRequest(BaseModel):
    """The vendor's final invoice. Defaults to the committed amount when omitted."""

    actual_total: Decimal | None = Field(default=None, ge=0)

    #: The date on the vendor's invoice, where it differs from the date it was recorded.
    #: A bill that arrives in October for September work still posts in October — this
    #: records what the vendor dated it so the two can be reconciled.
    invoice_date: date | None = None

    payment_date: date | None = None
    cash_account: str = "1101"
    withhold: bool = True

    #: Apply to the final **payment** only -- never the bill or the variance. The payment's
    #: `source_document_date` is `invoice_date`, so there is no separate document date here.
    #: An explicit PPh 23 figure; wins over `withhold`. Refused above the payment's gross.
    tax_amount: Decimal | None = Field(default=None, ge=0)
    #: Replacement payment lines. Guarded: 2102 must still be debited by exactly the
    #: computed gross; accounts active and postable; balanced. Refused if nothing is paid.
    lines: list[JournalLineIn] | None = Field(default=None, min_length=2)


class PayRequest(BaseModel):
    """Pay a bill, or pay a purchase order's down payment."""

    amount: Decimal | None = Field(default=None, gt=0)
    #: The date the money went out -- the accounting date reports use.
    payment_date: date | None = None
    cash_account: str = "1101"
    withhold: bool = True

    #: An explicit PPh 23 figure; wins over `withhold` and the vendor's rate. 0 to gross.
    tax_amount: Decimal | None = Field(default=None, ge=0)
    #: The date on the vendor's receipt/invoice, stored as `source_document_date`.
    document_date: date | None = None
    #: Replacement lines for the payment entry (never the bill it raises or settles).
    #: Guarded: 2102 must still be debited by exactly the computed gross.
    lines: list[JournalLineIn] | None = Field(default=None, min_length=2)


class PostingLineOut(Schema):
    account: str
    debit: MoneyStr
    credit: MoneyStr
    note: str | None


class PaymentOut(Schema):
    entry_id: uuid.UUID
    entry_no: str
    voucher_no: str
    gross: MoneyStr
    tax: MoneyStr
    net: MoneyStr
    cash_account: str
    posting: list[PostingLineOut]
    order: PurchaseOrderOut | None


# --- bills and ageing -------------------------------------------------------


class BillOut(Schema):
    entry_id: uuid.UUID
    entry_no: str
    voucher_no: str
    entry_date: date
    memo: str
    due: date | None
    vendor_id: uuid.UUID | None
    project_id: uuid.UUID | None
    source_ref: str | None
    raised: MoneyStr
    applied: MoneyStr
    outstanding: MoneyStr


class BucketOut(Schema):
    key: str
    label: str
    amount: MoneyStr
    count: int
    share: float


class PayablesAgeingOut(Schema):
    as_of: date
    buckets: list[BucketOut]
    total: MoneyStr
    overdue: MoneyStr

    #: Balance of 2105 — PPh 23 withheld from vendors and owed onward to the tax office.
    #: A **liability**, and the exact opposite of the 1401 asset an AR receipt creates.
    withholding_owed: MoneyStr

    ledger_balance: MoneyStr
    difference: MoneyStr
    reconciled: bool


class StageIn(BaseModel):
    stage: str
    reason: str | None = Field(default=None, max_length=500)


class CheckIn(BaseModel):
    done: bool


class ChecklistItemOut(Schema):
    key: str
    label: str
    done: bool
    manual: bool
    auto: bool


class StageHistoryOut(Schema):
    stage: str
    reason: str | None
    by: str
    at: datetime


class VendorLifecycleOut(Schema):
    vendor_id: uuid.UUID
    stage: str
    since: datetime | None
    reason: str | None
    #: The hand-ticked items as stored; the checklist below is what the rules see.
    checks: dict[str, bool]
    checklist: list[ChecklistItemOut]
    checklist_complete: bool
    has_agreement_file: bool
    has_live_po: bool
    #: Where a vendor on hold or blacklisted goes back to.
    resume_to: str | None
    history: list[StageHistoryOut]
