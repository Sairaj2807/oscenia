"""Cash-operations request and response models."""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel, Field

from app.core.schemas import MoneyStr, Schema
from app.domain.cash.models import RequestStatus

# --- attachments ------------------------------------------------------------


class AttachmentOut(Schema):
    id: uuid.UUID
    filename: str
    content_type: str
    byte_size: int
    sha256: str
    uploaded_by_user_id: uuid.UUID
    created_at: datetime


# --- petty cash -------------------------------------------------------------


class PettyCashOut(Schema):
    balance: MoneyStr
    opening: MoneyStr
    topped_up: MoneyStr
    disbursed: MoneyStr
    awaiting_approval: MoneyStr
    awaiting_count: int
    as_of: date


class TopUpRequest(BaseModel):
    amount: Decimal = Field(gt=0)
    payment_date: date | None = None


# --- procurement ------------------------------------------------------------


class ProcurementReceiptOut(Schema):
    attachment_id: uuid.UUID


class RequestOut(Schema):
    id: uuid.UUID
    request_no: str
    project_id: uuid.UUID | None
    category: str
    amount: MoneyStr
    status: RequestStatus

    #: Mandatory. Petty cash cannot be issued anonymously.
    requested_by: str
    requested_by_user_id: uuid.UUID | None

    request_date: date
    disbursed_at: date | None
    actual: MoneyStr | None
    settled_at: date | None
    reject_reason: str | None
    receipts: list[ProcurementReceiptOut]

    #: ``amount - actual``. Positive means money returned to the float, negative that a
    #: shortfall was reimbursed. Null until settled.
    variance: MoneyStr | None
    from_petty_cash: bool


class RequestCreate(BaseModel):
    category: str = Field(min_length=1)
    amount: Decimal = Field(gt=0)
    project_id: uuid.UUID | None = None
    request_date: date | None = None

    #: Omit to default to the signed-in user. An explicitly blank value is **refused** —
    #: defaulting a deliberate blank would defeat the point of a mandatory requester.
    requested_by: str | None = None


class TransitionRequest(BaseModel):
    status: RequestStatus
    reason: str | None = None
    effective_date: date | None = None


class AdvanceSettleRequest(BaseModel):
    actual: Decimal = Field(ge=0)

    #: At least one. An advance settled without proof of spend is an unevidenced cash
    #: movement, which is what the requester-tracking requirement was about.
    attachment_ids: list[uuid.UUID] = Field(min_length=1)
    settled_on: date | None = None


class RequesterRowOut(Schema):
    requester: str
    count: int
    requested: MoneyStr
    actual: MoneyStr
    variance: MoneyStr
    still_open: MoneyStr


# --- budgets ----------------------------------------------------------------


class CategoryIn(BaseModel):
    key: str = Field(min_length=1, pattern=r"^[a-z0-9-]+$")
    label: str = Field(min_length=1)
    ceiling: Decimal = Field(ge=0)

    #: Which ledger accounts this ceiling is measured against.
    account_codes: list[str] = Field(min_length=1)


class CategoryOut(Schema):
    key: str
    label: str
    ceiling: MoneyStr

    #: Derived from postings, never stored — so the plan and the reality cannot drift.
    spent: MoneyStr
    remaining: MoneyStr
    utilisation: Decimal
    over: bool
    codes: list[str]


class BudgetOut(Schema):
    project_id: uuid.UUID
    categories: list[CategoryOut]
    total_ceiling: MoneyStr
    total_spent: MoneyStr
    total_remaining: MoneyStr
    utilisation: Decimal


class BudgetUpdate(BaseModel):
    categories: list[CategoryIn] = Field(min_length=1)


class AlertOut(Schema):
    project_id: uuid.UUID
    ceiling: MoneyStr
    spent: MoneyStr
    over_by: MoneyStr
    acknowledged: bool
    raised_on: date


class SettingsOut(Schema):
    #: How far over a project's estimate spending may run before it is flagged.
    #: **Warns, never blocks** — the client was explicit that this is a tolerance.
    budget_tolerance_pct: Decimal
    bonus_threshold: Decimal
    #: Sales commission, percent of net contract value.
    commission_pct: Decimal
    #: Purchase orders are refused for a vendor that is not Approved or Active.
    enforce_vendor_stage: bool
    #: A delivery order may be dispatched without a drawn signature.
    allow_unsigned_dispatch: bool


class SettingsUpdate(BaseModel):
    budget_tolerance_pct: Decimal | None = Field(default=None, ge=0, le=1000)
    bonus_threshold: Decimal | None = Field(default=None, ge=0, le=10)
    commission_pct: Decimal | None = Field(default=None, ge=0, le=100)
    enforce_vendor_stage: bool | None = None
    allow_unsigned_dispatch: bool | None = None
