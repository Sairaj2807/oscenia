"""The global search endpoint.

One GET, because a search box makes a request per keystroke and anything it has to do twice
is a keystroke it cannot keep up with.
"""

from __future__ import annotations

from fastapi import APIRouter, Query

from app.core.deps import CurrentUser
from app.db.session import SessionDep
from app.domain.search import service
from app.domain.search.schemas import SearchOut

router = APIRouter(tags=["search"])


@router.get("/search", response_model=SearchOut)
async def search(
    session: SessionDep,
    user: CurrentUser,
    q: str = Query(description="Free text, a document number, or an amount"),
    limit: int = Query(default=5, ge=1, le=25, description="Hits per kind"),
    kinds: str | None = Query(
        default=None, description="Comma-separated kinds to search; every kind by default"
    ),
) -> SearchOut:
    """Search every record type at once: documents, people, money and stock.

    Returns typed hits grouped by kind, each group ranked by its best hit, so an exact
    document number is not buried under fuzzy name matches. A query shorter than two
    characters returns nothing rather than an error — the first keystrokes of a search are
    not a mistake.
    """
    wanted = [k.strip() for k in kinds.split(",") if k.strip()] if kinds else None
    result = await service.search(
        session, q, limit=limit, kinds=wanted, allowed=service.kinds_for(user.role), user=user
    )
    return SearchOut.model_validate(result)
