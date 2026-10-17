"""Chart-of-accounts request and response models."""

from __future__ import annotations

from pydantic import BaseModel, Field, field_validator

from app.core.schemas import MoneyStr, Schema
from app.domain.accounts.models import AccountType, Side, Statement


class AccountOut(Schema):
    code: str
    name: str
    type: AccountType
    group_label: str
    parent_code: str | None
    is_cash: bool
    is_contra: bool
    tax_key: str | None
    active: bool


class AccountDetail(AccountOut):
    """Everything the Chart of Accounts screen shows per row."""

    #: Number of posted journal lines. Once above zero the code and type are locked.
    usage_count: int
    balance: MoneyStr
    is_header: bool
    is_postable: bool
    child_codes: list[str]

    #: The "Automatic integration" preview the prototype shows before creation: which
    #: statement this lands on, which executive bucket, and its normal balance.
    normal_side: Side
    statement: Statement


class AccountNode(AccountOut):
    children: list[AccountNode] = Field(default_factory=list)
    balance: MoneyStr


class GroupNode(Schema):
    group: str
    accounts: list[AccountNode]


class TypeNode(Schema):
    type: AccountType
    label: str
    groups: list[GroupNode]


class AccountCreate(BaseModel):
    code: str
    name: str
    type: AccountType
    group_label: str | None = None
    parent_code: str | None = None
    is_cash: bool | None = None
    tax_key: str | None = None

    @field_validator("code", "name")
    @classmethod
    def _not_blank(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("must not be blank")
        return v.strip()


class AccountUpdate(BaseModel):
    """Only these fields are patchable.

    ``code`` and ``type`` are absent on purpose. Renumbering or retyping an account that
    carries posted lines would move history onto a different financial statement, so the
    database refuses it outright — see the ``accounts_guarded`` trigger. Renaming is always
    allowed and is the intended way to correct a label.
    """

    name: str | None = None
    group_label: str | None = None
    is_cash: bool | None = None
    tax_key: str | None = None
    active: bool | None = None


class ChartStats(Schema):
    total: int
    postable: int
    deactivated: int
    never_posted: int


class NextCode(Schema):
    code: str
