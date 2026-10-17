"""Master-data endpoints. Tax configuration for now; tags and settings follow in later phases."""

from __future__ import annotations

from fastapi import APIRouter
from sqlalchemy import select

from app.core.deps import CurrentUser, EditsTax
from app.core.errors import NotFound
from app.db.session import SessionDep
from app.domain.masters.models import TaxConfig
from app.domain.reports.schemas import TaxConfigOut, TaxConfigUpdate

router = APIRouter(prefix="/tax-config", tags=["tax"])


@router.get("", response_model=list[TaxConfigOut])
async def list_tax_config(session: SessionDep, user: CurrentUser) -> list[TaxConfigOut]:
    """The four configured taxes.

    ``corporate`` has no account and is never posted — the income statement computes it
    live, which is what lets finance change the rate and watch NPAT move.
    """
    rows = (await session.execute(select(TaxConfig).order_by(TaxConfig.key))).scalars().all()
    return [TaxConfigOut.model_validate(row) for row in rows]


@router.patch("/{key}", response_model=TaxConfigOut)
async def update_tax_config(
    session: SessionDep, user: EditsTax, key: str, patch: TaxConfigUpdate
) -> TaxConfigOut:
    """Change a rate or switch a tax on and off.

    Changing ``corporate`` immediately moves Tax Expense and NPAT on the income statement,
    and the Provision for Income Tax row on the balance sheet with it — the sheet stays
    balanced because both derive from the same figure.
    """
    row = (
        await session.execute(select(TaxConfig).where(TaxConfig.key == key))
    ).scalar_one_or_none()
    if row is None:
        raise NotFound(f"No tax configuration {key!r}.")

    for field, value in patch.model_dump(exclude_unset=True).items():
        setattr(row, field, value)
    await session.flush()
    return TaxConfigOut.model_validate(row)
