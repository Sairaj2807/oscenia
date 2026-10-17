"""Statement and P&L response models."""

from __future__ import annotations

import enum
import uuid
from datetime import date
from decimal import Decimal

from pydantic import BaseModel, Field

from app.core.schemas import MoneyStr, Schema


class StatementLineOut(Schema):
    code: str
    label: str
    amount: MoneyStr

    #: True for the two computed rows — the tax provision and current-period earnings.
    #: They carry no account code, so the UI must not offer a drill-down on them.
    derived: bool = False

    #: For a rolled-up bucket: the codes it was built from, so the summary stays drillable.
    codes: list[str] = Field(default_factory=list)


class IncomeStatementOut(Schema):
    revenue: list[StatementLineOut]
    cogs: list[StatementLineOut]
    opex: list[StatementLineOut]
    tax: list[StatementLineOut]

    total_revenue: MoneyStr
    total_cogs: MoneyStr
    gross_profit: MoneyStr
    total_opex: MoneyStr
    profit_before_tax: MoneyStr
    total_tax: MoneyStr
    posted_tax: MoneyStr
    provision: MoneyStr
    npat: MoneyStr

    tax_rate: Decimal
    gross_margin: Decimal
    net_margin: Decimal

    #: Balance of 1401 — PPh 23 withheld from us and creditable against the bill above.
    prepaid_withholding: MoneyStr

    summarised: bool
    start: date | None
    end: date | None


class BalanceSheetOut(Schema):
    assets: list[StatementLineOut]
    liabilities: list[StatementLineOut]
    equity: list[StatementLineOut]
    total_assets: MoneyStr
    total_liabilities: MoneyStr
    total_equity: MoneyStr
    balanced: bool
    difference: MoneyStr
    summarised: bool
    as_of: date | None

    #: True when the requested window is not open-ended or year-to-date. A balance sheet is
    #: a position at a moment, so a narrow window silently excludes opening balances — the
    #: prototype warns rather than showing a sheet that looks wrong for no visible reason.
    excludes_opening_balances: bool


class CostLineOut(Schema):
    code: str
    label: str
    amount: MoneyStr


class CostEntryOut(Schema):
    """One posted line against a project cost account (what the cost breakdown itemises)."""

    entry_id: uuid.UUID
    entry_no: str
    voucher_no: str
    entry_date: date
    memo: str
    source_kind: str
    source_ref: str | None
    account_code: str
    note: str | None

    #: Debit minus credit, so a reversal nets the original to zero instead of vanishing.
    amount: MoneyStr
    is_reversal: bool
    is_reversed: bool


class SliceOut(Schema):
    label: str
    revenue: MoneyStr
    cost: MoneyStr
    profit: MoneyStr
    margin: Decimal
    start: date | None
    end: date | None
    costs: list[CostLineOut]


class DeltaOut(Schema):
    metric: str
    now: MoneyStr
    was: MoneyStr
    change: MoneyStr
    percent: Decimal | None

    #: True when this metric improved. Cost is inverse-signed: spending less is better.
    improved: bool | None
    inverse: bool


class ComparisonOut(Schema):
    current: SliceOut
    baseline: SliceOut
    deltas: list[DeltaOut]

    #: The baseline window ends before the ledger begins, so its zeroes are an absence of
    #: data rather than a real result.
    before_ledger: bool


class CompareMode(enum.StrEnum):
    MOM = "mom"
    PREV = "prev"
    YOY = "yoy"
    PROJECT = "project"


class TaxConfigOut(Schema):
    key: str
    label: str
    rate: Decimal
    active: bool
    account_code: str | None


class TaxConfigUpdate(BaseModel):
    rate: Decimal | None = Field(default=None, ge=0, le=100)
    active: bool | None = None
