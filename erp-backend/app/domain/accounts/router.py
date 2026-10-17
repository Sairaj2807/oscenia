"""Chart of accounts endpoints — backs the prototype's ChartOfAccounts screen."""

from __future__ import annotations

from fastapi import APIRouter, Query, status

from app.core.deps import CurrentUser, ManagesCoa
from app.db.session import SessionDep
from app.domain.accounts import service
from app.domain.accounts.models import AccountType
from app.domain.accounts.schemas import (
    AccountCreate,
    AccountDetail,
    AccountOut,
    AccountUpdate,
    ChartStats,
    NextCode,
    TypeNode,
)

router = APIRouter(prefix="/accounts", tags=["chart of accounts"])


@router.get("", response_model=list[AccountOut])
async def list_accounts(
    session: SessionDep,
    user: CurrentUser,
    type: AccountType | None = None,
    q: str | None = Query(default=None, description="Matches code, name or group"),
    include_inactive: bool = False,
) -> list[AccountOut]:
    accounts = await service.list_accounts(
        session, type_=type, query=q, include_inactive=include_inactive
    )
    return [AccountOut.model_validate(a) for a in accounts]


@router.get("/tree", response_model=list[TypeNode])
async def account_tree(
    session: SessionDep, user: CurrentUser, include_inactive: bool = False
) -> list[TypeNode]:
    """type → executive group → account → sub-accounts, as the screen renders it."""
    return [TypeNode.model_validate(n) for n in await service.tree(
        session, include_inactive=include_inactive
    )]


@router.get("/stats", response_model=ChartStats)
async def chart_stats(session: SessionDep, user: CurrentUser) -> ChartStats:
    """Totals, plus the never-posted-to count that warns about chart fragmentation."""
    return ChartStats.model_validate(await service.stats(session))


@router.get("/next-code", response_model=NextCode)
async def next_code(
    session: SessionDep,
    user: CurrentUser,
    parent: str | None = None,
    type: AccountType | None = None,
) -> NextCode:
    return NextCode(code=await service.next_code(session, parent=parent, type_=type))


@router.get("/{code}", response_model=AccountDetail)
async def get_account(session: SessionDep, user: CurrentUser, code: str) -> AccountDetail:
    return AccountDetail.model_validate(await service.detail(session, code))


@router.post("", response_model=AccountDetail, status_code=status.HTTP_201_CREATED)
async def create_account(
    session: SessionDep, user: ManagesCoa, draft: AccountCreate
) -> AccountDetail:
    """Sub-accounts inherit ``is_cash`` and ``tax_key`` from their parent."""
    account = await service.create(session, draft)
    return AccountDetail.model_validate(await service.detail(session, account.code))


@router.patch("/{code}", response_model=AccountDetail)
async def update_account(
    session: SessionDep, user: ManagesCoa, code: str, patch: AccountUpdate
) -> AccountDetail:
    """Rename and regroup freely.

    ``code`` and ``type`` are deliberately not patchable: once an account carries posted
    lines, changing either would move history onto a different financial statement, and the
    database refuses it.
    """
    await service.update(session, code, patch)
    return AccountDetail.model_validate(await service.detail(session, code))


@router.post("/{code}/deactivate", response_model=AccountDetail)
async def deactivate_account(session: SessionDep, user: ManagesCoa, code: str) -> AccountDetail:
    """Keeps the balance and the history; stops accepting new postings."""
    await service.set_active(session, code, False)
    return AccountDetail.model_validate(await service.detail(session, code))


@router.post("/{code}/activate", response_model=AccountDetail)
async def activate_account(session: SessionDep, user: ManagesCoa, code: str) -> AccountDetail:
    await service.set_active(session, code, True)
    return AccountDetail.model_validate(await service.detail(session, code))


@router.delete("/{code}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_account(session: SessionDep, user: ManagesCoa, code: str) -> None:
    """Only ever possible when the account has no posted lines and no sub-accounts.

    Otherwise this returns 409 and names deactivation as the alternative.
    """
    await service.delete(session, code)
