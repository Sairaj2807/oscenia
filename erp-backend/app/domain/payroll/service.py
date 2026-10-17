"""Crew incentives.

The client's deck asks for incentives to "integrate with Payroll and the General Ledger,
tagged to a Project ID, for explicit cost allocation". The project tag was optional in the
prototype and disbursing without one posted ``project: null`` — the bonus cost landed on no
P&L at all. **Refusing is the whole point of the word mandatory**, so it is refused here with
nothing posted.

The pool is computed live from crew rates and the event's client rating. It is not stored,
for the same reason a receivable is not stored: a rate change or a re-rating should move the
number, and a cached pool would go stale silently.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal

from fastapi import Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict, Invalid, NotFound
from app.core.money import ZERO, money
from app.domain.ar.models import Project, Stage
from app.domain.assets.models import (
    ClientFeedback,
    Crew,
    IncentiveDisbursement,
    IncentiveDisbursementLine,
)
from app.domain.audit.service import record_audit, snapshot
from app.domain.cash.service import settings as company_settings
from app.domain.ledger.models import SourceKind
from app.domain.ledger.numbering import next_document_no
from app.domain.ledger.posting import LineIn, SourceIn, post_entry
from app.domain.masters.models import User

CREW_COGS = "5102"
MAIN_BANK = "1101"

#: Ratings are out of ten. The bonus is a fraction of the base rate in that proportion.
RATING_SCALE = Decimal(10)


@dataclass(frozen=True, slots=True)
class CrewBonus:
    crew_id: uuid.UUID | None
    crew_no: str
    name: str
    role: str | None
    base_rate: Decimal
    rating: Decimal
    qualifies: bool
    bonus: Decimal
    total: Decimal


@dataclass(frozen=True, slots=True)
class IncentivePool:
    project_id: uuid.UUID
    #: The event's client rating, or ``None`` when no post-event feedback exists yet — in
    #: which case each crew member falls back to their own last rating.
    event_score: Decimal | None
    threshold: Decimal
    rows: list[CrewBonus]
    pool: Decimal
    below_threshold: int
    disbursed: bool


async def list_crew(session: AsyncSession, *, active_only: bool = False) -> list[Crew]:
    stmt = select(Crew).order_by(Crew.crew_no)
    if active_only:
        stmt = stmt.where(Crew.active.is_(True))
    return list((await session.execute(stmt)).scalars().all())


async def add_crew(
    session: AsyncSession,
    *,
    name: str,
    base_rate: Decimal,
    role: str | None = None,
    last_rating: Decimal = ZERO,
) -> Crew:
    name = (name or "").strip()
    if not name:
        raise Invalid("A crew member needs a name.")
    rate = money(base_rate)
    if rate < ZERO:
        raise Invalid("A base rate cannot be negative.")
    if not (ZERO <= last_rating <= RATING_SCALE):
        raise Invalid("A rating is out of ten.")

    member = Crew(
        crew_no=await next_document_no(session, "crew"),
        name=name,
        role=role,
        base_rate=rate,
        last_rating=last_rating,
    )
    session.add(member)
    await session.flush()
    return member


RATABLE_STAGES = (Stage.POST_EVENT_FEEDBACK, Stage.FINISHED)


def ensure_ratable(project: Project) -> None:
    """A client rates an event that has happened and still stands. The Survey screen always
    filtered to these, but the endpoint did not, so any signed-in user could rate any project."""
    if project.cancelled:
        raise Conflict("A cancelled project cannot be rated.")
    if project.stage not in RATABLE_STAGES:
        raise Conflict("A project can be rated once it reaches Post-Event Feedback.")


async def record_feedback(
    session: AsyncSession,
    project_id: uuid.UUID,
    *,
    score: Decimal,
    on: date,
    source: str = "staff",
    at: datetime | None = None,
) -> ClientFeedback:
    """Record the post-event client rating.

    One per project — re-rating updates the existing row rather than adding a second, so the
    pool is computed from a single score rather than an accidental average.
    """
    if not (ZERO <= score <= RATING_SCALE):
        raise Invalid("A client rating is out of ten.")
    project = await session.get(Project, project_id)
    if project is None:
        raise NotFound(f"No project {project_id}.")
    ensure_ratable(project)

    row = (
        await session.execute(select(ClientFeedback).where(ClientFeedback.project_id == project_id))
    ).scalar_one_or_none()

    if row is None:
        row = ClientFeedback(
            project_id=project_id, score=score, submitted_on=on, source=source, submitted_at=at
        )
        session.add(row)
    else:
        row.score = score
        row.submitted_on = on
        row.source = source
        row.submitted_at = at

    await session.flush()
    return row


async def pool_for(session: AsyncSession, project_id: uuid.UUID) -> IncentivePool:
    """What the crew would be paid for this event.

    ``bonus = base_rate × (rating ÷ 10)``, paid only when ``rating ≥ threshold``. Once a
    post-event client rating exists every crew member is scored on that one event rating;
    before then each falls back to their own last rating, which is what the Payroll screen
    shows while an event is still running.
    """
    project = await session.get(Project, project_id)
    if project is None:
        raise NotFound(f"No project {project_id}.")

    feedback = (
        await session.execute(select(ClientFeedback).where(ClientFeedback.project_id == project_id))
    ).scalar_one_or_none()
    event_score = feedback.score if feedback is not None else None

    threshold = (await company_settings(session)).bonus_threshold

    paid = (
        await session.execute(
            select(IncentiveDisbursement).where(IncentiveDisbursement.project_id == project_id)
        )
    ).scalar_one_or_none()
    if paid is not None:
        # A pool that was paid is what was paid: the snapshot, not today's crew list and rates.
        lines = (
            (
                await session.execute(
                    select(IncentiveDisbursementLine)
                    .where(IncentiveDisbursementLine.disbursement_id == paid.id)
                    .order_by(IncentiveDisbursementLine.crew_no)
                )
            )
            .scalars()
            .all()
        )
        if lines:
            frozen = [
                CrewBonus(
                    crew_id=ln.crew_id, crew_no=ln.crew_no, name=ln.name, role=ln.role,
                    base_rate=ln.base_rate, rating=ln.rating, qualifies=ln.qualifies,
                    bonus=ln.bonus, total=ln.base_rate + ln.bonus,
                )
                for ln in lines
            ]  # fmt: skip
            return IncentivePool(
                project_id=project_id, event_score=event_score, threshold=threshold, rows=frozen,
                pool=money(paid.amount), below_threshold=sum(1 for r in frozen if not r.qualifies),
                disbursed=True,
            )  # fmt: skip

    rows: list[CrewBonus] = []
    for member in await list_crew(session, active_only=True):
        rating = event_score if event_score is not None else member.last_rating
        qualifies = rating >= threshold
        base = money(member.base_rate)
        bonus = money(base * rating / RATING_SCALE) if qualifies else ZERO
        rows.append(
            CrewBonus(
                crew_id=member.id,
                crew_no=member.crew_no,
                name=member.name,
                role=member.role,
                base_rate=base,
                rating=rating,
                qualifies=qualifies,
                bonus=bonus,
                total=base + bonus,
            )
        )

    disbursed = (
        await session.execute(
            select(IncentiveDisbursement.id).where(IncentiveDisbursement.project_id == project_id)
        )
    ).first() is not None

    return IncentivePool(
        project_id=project_id,
        event_score=event_score,
        threshold=threshold,
        rows=rows,
        pool=money(sum((r.bonus for r in rows), start=ZERO)),
        below_threshold=sum(1 for r in rows if not r.qualifies),
        disbursed=disbursed,
    )


async def disburse(
    session: AsyncSession,
    *,
    project_id: uuid.UUID | None,
    user: User,
    on: date,
    amount: Decimal | None = None,
) -> IncentiveDisbursement:
    """Pay the pool.

    ``Dr 5102 Event COGS — Crew`` against ``Cr 1101 Main Bank Cash``, tagged to the project so
    the bonus lands on the right P&L.

    **The project tag is mandatory.** Without one the cost allocates nowhere, so a missing or
    unknown project is refused before anything is posted. Paying twice is refused by the
    unique constraint on ``project_id`` — the in-memory ``incentivesPaid`` boolean the
    prototype relied on cannot survive a stateless API.
    """
    if project_id is None:
        raise Invalid(
            "Crew incentives must be allocated to a Project ID before disbursement. "
            "Without one the bonus lands on no project P&L at all."
        )
    project = await session.get(Project, project_id)
    if project is None:
        raise NotFound(f"No project {project_id}. Incentives need a real project to land on.")

    pool = await pool_for(session, project_id)
    if pool.disbursed:
        raise Conflict(f"Incentives for {project.project_no} have already been disbursed.")

    payable = money(amount) if amount is not None else pool.pool
    if payable <= ZERO:
        raise Invalid("There is nothing to disburse — no crew member cleared the threshold.")

    entry = await post_entry(
        session,
        entry_date=on,
        memo=f"Crew incentive disbursement — {project.name}",
        lines=[
            LineIn(CREW_COGS, debit=payable, note="Performance bonuses"),
            LineIn(MAIN_BANK, credit=payable, note="Bank transfer to crew"),
        ],
        source=SourceIn(kind=SourceKind.PAYROLL, ref=f"INC-{project.project_no}"),
        posted_by_id=user.id,
        project_id=project_id,
    )

    record = IncentiveDisbursement(
        project_id=project_id, amount=payable, entry_id=entry.id, disbursed_on=on
    )
    session.add(record)
    await session.flush()
    for row in pool.rows:
        session.add(
            IncentiveDisbursementLine(
                disbursement_id=record.id, crew_id=row.crew_id, crew_no=row.crew_no, name=row.name,
                role=row.role, base_rate=row.base_rate, rating=row.rating,
                qualifies=row.qualifies, bonus=row.bonus,
            )
        )  # fmt: skip
    await session.flush()
    return record


# ---------------------------------------------------------------------------
# Editing and removing crew
# ---------------------------------------------------------------------------

CREW_AUDIT = ("name", "role", "base_rate", "last_rating", "active")


async def get_crew(session: AsyncSession, crew_id: uuid.UUID, *, lock: bool = False) -> Crew:
    stmt = select(Crew).where(Crew.id == crew_id)
    if lock:
        stmt = stmt.with_for_update()
    member = (await session.execute(stmt)).scalar_one_or_none()
    if member is None:
        raise NotFound("No such crew member.")
    return member


async def update_crew(
    session: AsyncSession,
    crew_id: uuid.UUID,
    changes: dict[str, object],
    *,
    actor: User,
    request: Request | None = None,
) -> Crew:
    """Edit name, role, base rate or last rating. A pool already paid keeps its own snapshot, so
    a new rate applies to pools not yet disbursed."""
    member = await get_crew(session, crew_id, lock=True)
    before = snapshot(member, CREW_AUDIT)
    if "name" in changes:
        name = " ".join(str(changes["name"] or "").split())
        if not name:
            raise Invalid("A crew member needs a name.")
        member.name = name[:120]
    if "role" in changes:
        role = " ".join(str(changes["role"] or "").split())
        member.role = role[:80] or None
    if "base_rate" in changes:
        rate = money(Decimal(str(changes["base_rate"])))
        if rate < ZERO:
            raise Invalid("A base rate cannot be negative.")
        member.base_rate = rate
    if "last_rating" in changes:
        rating = Decimal(str(changes["last_rating"]))
        if not (ZERO <= rating <= RATING_SCALE):
            raise Invalid("A rating is out of ten.")
        member.last_rating = rating
    await session.flush()
    await record_audit(
        session, actor=actor, action="crew.update", entity_type="crew", entity_id=member.id,
        before=before, after=snapshot(member, CREW_AUDIT), request=request,
    )  # fmt: skip
    return member


async def set_crew_active(
    session: AsyncSession,
    crew_id: uuid.UUID,
    active: bool,
    *,
    on: date,
    actor: User,
    request: Request | None = None,
) -> Crew:
    """Leave a member out of new pools (or put them back). Paid pools are not affected."""
    member = await get_crew(session, crew_id, lock=True)
    if member.active == active:
        return member
    member.active = active
    member.deactivated_on = None if active else on
    await session.flush()
    await record_audit(
        session, actor=actor, action="crew.activate" if active else "crew.deactivate",
        entity_type="crew", entity_id=member.id, after={"active": active}, request=request,
    )  # fmt: skip
    return member


async def delete_crew(
    session: AsyncSession, crew_id: uuid.UUID, *, actor: User, request: Request | None = None
) -> None:
    """Remove a member who was added by mistake. Refused once they may have been paid: a pool that
    was disbursed names them (and one paid before snapshots existed may include them), so the
    record stays and they are deactivated instead."""
    member = await get_crew(session, crew_id, lock=True)
    in_a_paid_pool = (
        await session.execute(
            select(IncentiveDisbursementLine.id)
            .where(IncentiveDisbursementLine.crew_id == member.id)
            .limit(1)
        )
    ).first() is not None
    unsnapshotted = (
        await session.execute(
            select(IncentiveDisbursement.id)
            .where(
                ~select(IncentiveDisbursementLine.id)
                .where(IncentiveDisbursementLine.disbursement_id == IncentiveDisbursement.id)
                .exists()
            )
            .limit(1)
        )
    ).first() is not None
    if in_a_paid_pool or unsnapshotted:
        raise Conflict(
            "This crew member may have been paid in a disbursed pool, so they cannot be deleted. "
            "Deactivate them instead."
        )
    await record_audit(
        session, actor=actor, action="crew.delete", entity_type="crew", entity_id=member.id,
        before=snapshot(member, CREW_AUDIT), detail={"crew_no": member.crew_no}, request=request,
    )  # fmt: skip
    await session.delete(member)
    await session.flush()
