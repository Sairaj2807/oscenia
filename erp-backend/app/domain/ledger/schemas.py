"""Journal, voucher-series and period request/response models."""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel, Field, field_validator

from app.core.schemas import MoneyStr, Schema
from app.domain.ledger.models import PeriodStatus, ResetCadence, SourceKind


class JournalLineIn(BaseModel):
    account: str
    debit: Decimal = Decimal("0")
    credit: Decimal = Decimal("0")
    note: str | None = None


class SourceIn(BaseModel):
    kind: SourceKind = SourceKind.MANUAL
    ref: str | None = None
    due: date | None = None
    document_date: date | None = None
    vendor_id: uuid.UUID | None = None
    settlement: bool = False


class EntryCreate(BaseModel):
    entry_date: date
    memo: str

    #: Join an existing document group instead of standing alone. This is what the
    #: searchable journal-code dropdown on the manual-entry form writes: pick the code a
    #: correction belongs to and it files under that, rather than becoming a third number
    #: nobody connects to the first two.
    group_ref: str | None = None
    lines: list[JournalLineIn] = Field(min_length=2)
    source: SourceIn = Field(default_factory=SourceIn)
    project_id: uuid.UUID | None = None

    #: Explicit series wins over auto-classification. Leave unset in almost every case.
    series: str | None = None

    #: Ids of the entries this one settles. Recording an application is what makes an
    #: invoice stop being an open item.
    applied_to: list[uuid.UUID] = Field(default_factory=list)

    @field_validator("memo")
    @classmethod
    def _memo_present(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("an entry needs a memo")
        return v.strip()


class AdjustRequest(BaseModel):
    """Reverse an entry and repost it with corrected figures."""

    lines: list[JournalLineIn] = Field(min_length=2)
    memo: str | None = None
    entry_date: date | None = None
    #: The date on the corrected receipt / invoice (round 4), kept as the replacement's
    #: `source_document_date`. `entry_date` stays the posting (received) date.
    document_date: date | None = None


class ReverseRequest(BaseModel):
    entry_date: date | None = None
    memo: str | None = None


class JournalLineOut(Schema):
    line_no: int
    account_code: str
    debit: MoneyStr
    credit: MoneyStr
    note: str | None


class EntryOut(Schema):
    id: uuid.UUID
    entry_no: str
    voucher_no: str
    entry_date: date
    memo: str
    project_id: uuid.UUID | None
    series: str
    source_kind: SourceKind
    source_ref: str | None
    group_ref: str | None
    source_due: date | None
    source_document_date: date | None
    source_vendor_id: uuid.UUID | None
    source_settlement: bool
    reversal_of_id: uuid.UUID | None
    reversed_by_id: uuid.UUID | None
    created_at: datetime
    lines: list[JournalLineOut]

    #: The entries this one settles. Write-only until now, which left the client unable to
    #: reconstruct AR and AP the way the prototype does.
    applied_to: list[uuid.UUID]

    total: MoneyStr


class EntryDetail(EntryOut):
    """Adds the linked-document chain the drill-down modal shows."""

    settles: list[uuid.UUID]
    settled_by: list[uuid.UUID]


class OpenItemOut(Schema):
    entry_id: uuid.UUID
    entry_no: str
    voucher_no: str
    entry_date: date
    memo: str
    due: date | None
    vendor_id: uuid.UUID | None
    project_id: uuid.UUID | None
    source_kind: str
    source_ref: str | None
    raised: MoneyStr
    applied: MoneyStr
    outstanding: MoneyStr


# --- voucher series ---------------------------------------------------------


class PreviewLineOut(Schema):
    """One line of a posting that has not happened."""

    account: str
    account_name: str
    debit: MoneyStr
    credit: MoneyStr
    note: str | None


class PreviewEntryOut(Schema):
    entry_date: date
    memo: str
    series: str
    #: What this entry WOULD be numbered. Nothing is reserved -- the counter increment is
    #: rolled back with the rest of the preview, so a confirmation dialog cannot burn a
    #: voucher number by being opened and closed.
    voucher_preview: str
    project_id: uuid.UUID | None
    #: The date on the source document (the receipt / vendor invoice), where one was given.
    #: `entry_date` is the received/recorded date and the one reports use.
    source_document_date: date | None = None
    lines: list[PreviewLineOut]
    total_debit: MoneyStr
    total_credit: MoneyStr
    balanced: bool


class PostingPreviewOut(Schema):
    """Everything an operation would post, for the confirmation the client asked for.

    An operation can post more than one entry -- confirming a down payment creates the
    project, issues the first invoice and records its receipt -- so this is a list, and the
    dialog shows each document rather than pretending they are one.
    """

    dry_run: bool = True
    entries: list[PreviewEntryOut]
    total_debit: MoneyStr
    total_credit: MoneyStr
    balanced: bool


class SeriesOut(Schema):
    key: str
    prefix: str
    label: str
    hint: str | None
    format: str
    reset: ResetCadence
    next_preview: str | None = None


class SeriesCreate(BaseModel):
    """A new document-number series. The client asked to create their own prefixes."""

    #: Normalised to lowercase by the service, so an uppercase key is accepted, not refused.
    key: str = Field(min_length=1, max_length=16, pattern=r"^[A-Za-z0-9_-]+$")
    prefix: str = Field(min_length=1, max_length=32)
    label: str = Field(min_length=1, max_length=80)
    hint: str | None = None
    format: str = "[PREFIX]-[MONTH]-[DATE]-[SEQ_001]"
    reset: ResetCadence = ResetCadence.MONTHLY


class SeriesUpdate(BaseModel):
    prefix: str | None = None
    label: str | None = None
    hint: str | None = None
    format: str | None = None
    reset: ResetCadence | None = None


# --- periods ----------------------------------------------------------------


class PeriodOut(Schema):
    year: int
    month: int
    status: PeriodStatus
    closed_at: datetime | None
    closed_by_id: uuid.UUID | None
