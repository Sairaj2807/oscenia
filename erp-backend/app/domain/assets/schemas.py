"""Wire shapes for the fixed-asset register, its schedule, and warehouse movements."""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field

from app.core.schemas import MoneyStr
from app.domain.assets.models import (
    AssetStatus,
    DeliveryStatus,
    InventoryStatus,
    InventoryType,
    Method,
    ReturnCondition,
)
from app.domain.assets.schedule import RowState


class AssetCreate(BaseModel):
    name: str
    acquired_on: date
    cost: Decimal
    useful_life_months: int
    salvage: Decimal = Decimal("0.00")
    method: Method = Method.STRAIGHT_LINE
    category: str | None = None
    inventory_item_id: uuid.UUID | None = None

    #: ``False`` registers kit the books already carry — the seeded warehouse equipment is
    #: inside the opening 1302 balance, and posting it again would double-count it.
    post: bool = True
    pay_from: str = "1101"


class AssetRevise(BaseModel):
    """Only estimates are revisable.

    The sealed columns are **declared rather than omitted**, so sending one is refused by name
    with a reason. Leaving them out of the schema would make Pydantic drop them silently and
    return 200 — and a caller who asked to change the cost would walk away believing it had
    changed. Refusing loudly is the only honest answer.
    """

    name: str | None = None
    category: str | None = None
    salvage: Decimal | None = None
    useful_life_months: int | None = None
    method: Method | None = None

    #: Declared only in order to be refused. Cost is evidenced by the acquisition entry, and
    #: the posted figures are the ledger's own record of what reached account 1303.
    cost: Decimal | None = None
    posted_through: str | None = None
    posted_accumulated: Decimal | None = None
    asset_no: str | None = None
    status: AssetStatus | None = None


class AssetOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    asset_no: str
    name: str
    category: str | None
    acquired_on: date
    cost: MoneyStr
    salvage: MoneyStr
    useful_life_months: int
    method: Method
    status: AssetStatus
    posted_through: str | None
    posted_accumulated: MoneyStr
    schedule_from: str | None
    opening_accumulated: MoneyStr
    disposed_at: date | None
    proceeds: MoneyStr | None
    net_book_value: MoneyStr
    due: MoneyStr
    overdue_periods: int


class ScheduleRowOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    index: int
    period: str
    ends_on: date
    opening: MoneyStr
    charge: MoneyStr
    accumulated: MoneyStr
    closing: MoneyStr
    state: RowState


class RegisterOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    count: int
    cost: MoneyStr
    accumulated: MoneyStr
    net_book_value: MoneyStr
    due: MoneyStr
    overdue_periods: int
    monthly: MoneyStr
    ledger_cost: MoneyStr
    ledger_accumulated: MoneyStr
    ledger_net_book_value: MoneyStr

    #: The Fixed Assets screen's reconciliation badge. False means the register and accounts
    #: 1302/1303 disagree, which is shown rather than hidden.
    reconciled: bool


class DisposeRequest(BaseModel):
    proceeds: Decimal = Decimal("0.00")
    disposed_on: date | None = None


class DepreciationRunRequest(BaseModel):
    #: ``'YYYY-MM'``. Omit to clear the whole backlog, oldest period first.
    period: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}$")


class RunResultOut(BaseModel):
    periods: list[str]
    entry_ids: list[uuid.UUID]
    total: MoneyStr
    posted: int


class BacklogOut(BaseModel):
    periods: list[str]
    total: MoneyStr


# ---------------------------------------------------------------------------
# Warehouse
# ---------------------------------------------------------------------------


class ItemCreate(BaseModel):
    item: str
    type: InventoryType
    qty: Decimal
    unit_value: Decimal
    unit: str | None = None


class ItemUpdate(BaseModel):
    """What may change on a stock item. Quantity is not here: it moves only through movements."""

    model_config = ConfigDict(extra="forbid")

    item: str | None = Field(default=None, min_length=1, max_length=200)
    unit: str | None = Field(default=None, max_length=16)
    #: Locked once the item has ledger entries or a fixed-asset record.
    unit_value: Decimal | None = Field(default=None, ge=0)
    type: InventoryType | None = None


class ItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    item_no: str
    item: str
    type: InventoryType
    qty: Decimal
    unit: str | None
    unit_value: MoneyStr
    status: InventoryStatus
    project_id: uuid.UUID | None
    event_date: date | None
    total_value: MoneyStr
    archived_at: datetime | None = None


class ReleaseRequest(BaseModel):
    qty: Decimal
    project_id: uuid.UUID | None = None
    released_on: date | None = None


class CheckOutRequest(BaseModel):
    project_id: uuid.UUID
    event_date: date


class ReturnRequest(BaseModel):
    condition: ReturnCondition
    lost_qty: Decimal = Decimal("0")

    #: Part of the returning quantity that came back damaged. It becomes its own row in
    #: maintenance; the rest stays on this row.
    damaged_qty: Decimal = Decimal("0")
    project_id: uuid.UUID | None = None
    returned_on: date | None = None


class MovementOut(BaseModel):
    item: ItemOut
    #: ``None`` when the movement posts nothing — a clean return, or a repair.
    entry_id: uuid.UUID | None
    voucher_no: str | None


# --- delivery orders --------------------------------------------------------


class DeliveryLineIn(BaseModel):
    inventory_item_id: uuid.UUID | None = None
    #: Free text when the line is not a stock item; defaults to the stock item's name when it is.
    item: str | None = None
    qty: Decimal = Field(gt=0)


class DeliveryOrderCreate(BaseModel):
    project_id: uuid.UUID
    event_date: date | None = None
    lines: list[DeliveryLineIn] = Field(min_length=1)


class DeliveryLineOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    line_no: int
    inventory_item_id: uuid.UUID | None
    item_label: str
    qty: Decimal


class DeliveryOrderOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    do_no: str
    project_id: uuid.UUID
    event_date: date | None
    status: DeliveryStatus
    signed: bool
    dispatched_on: date | None
    received_on: date | None
    #: Whether a drawn signature is on file. The picture is read from ``/signature``, not a URL.
    has_signature: bool = False
    signed_by_name: str | None = None
    signed_at: datetime | None = None
    lines: list[DeliveryLineOut]
