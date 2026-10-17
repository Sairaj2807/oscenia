"""Quotations, MoU templates, clients and projects."""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime
from decimal import Decimal

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict, Invalid, NotFound
from app.core.money import ZERO, money
from app.domain.ar import billing
from app.domain.ar.models import (
    STAGE_ORDER,
    Client,
    ClientInteraction,
    InteractionType,
    MouClause,
    MouTemplate,
    Project,
    ProjectStageHistory,
    Quotation,
    QuotationLine,
    QuotationStage,
    QuotationStatus,
    Stage,
)
from app.domain.assets.models import ClientFeedback, IncentiveDisbursement
from app.domain.ledger.numbering import next_document_no
from app.domain.masters.models import User

# ---------------------------------------------------------------------------
# Clients
# ---------------------------------------------------------------------------


async def get_client(session: AsyncSession, client_id: uuid.UUID) -> Client:
    client = (
        await session.execute(select(Client).where(Client.id == client_id))
    ).scalar_one_or_none()
    if client is None:
        raise NotFound(f"No client {client_id}.")
    return client


async def create_client(session: AsyncSession, **fields: object) -> Client:
    client = Client(client_no=await next_document_no(session, "client"), **fields)
    session.add(client)
    await session.flush()
    return client


async def update_client(
    session: AsyncSession, client_id: uuid.UUID, **fields: object
) -> Client:
    """Amend a client's details. Only the keys supplied are touched."""
    client = await get_client(session, client_id)
    for key, value in fields.items():
        if value is not None:
            setattr(client, key, value)
    await session.flush()
    return client


async def get_interaction(
    session: AsyncSession, interaction_id: uuid.UUID
) -> ClientInteraction:
    row = await session.get(ClientInteraction, interaction_id)
    if row is None:
        raise NotFound(f"Interaction {interaction_id} does not exist.")
    return row


async def update_interaction(
    session: AsyncSession,
    interaction_id: uuid.UUID,
    *,
    note: str | None = None,
    on: date | None = None,
    type_: InteractionType | None = None,
) -> ClientInteraction:
    """Edit a note, and record that it was edited.

    `edited_at` is stamped rather than the note being silently rewritten: a CRM note is a
    record of what someone was told, so the fact that it changed is part of the record. The
    author is deliberately not reassigned — whoever wrote it still wrote it.
    """
    interaction = await get_interaction(session, interaction_id)
    if note is not None:
        if not note.strip():
            raise Invalid("A note needs some text.")
        interaction.note = note
    if type_ is not None:
        interaction.type = type_
    if on is not None:
        interaction.interaction_date = on
    interaction.edited_at = datetime.now(UTC)
    await session.flush()
    return interaction


async def delete_interaction(session: AsyncSession, interaction_id: uuid.UUID) -> None:
    interaction = await get_interaction(session, interaction_id)
    await session.delete(interaction)
    await session.flush()


async def log_interaction(
    session: AsyncSession,
    client_id: uuid.UUID,
    *,
    user: User,
    note: str,
    on: date,
    type_: InteractionType = InteractionType.NOTE,
) -> ClientInteraction:
    """Record a CRM note against a client.

    The author is taken from the signed-in user, never from the request — the client asked
    for notes stamped with "the identity of the account staff who inputted it", and a
    self-reported author is not that.
    """
    await get_client(session, client_id)
    if not note.strip():
        raise Invalid("A note needs some text.")

    interaction = ClientInteraction(
        client_id=client_id,
        interaction_date=on,
        type=type_,
        author_user_id=user.id,
        note=note.strip(),
    )
    session.add(interaction)
    await session.flush()
    return interaction


# ---------------------------------------------------------------------------
# Quotations
# ---------------------------------------------------------------------------


async def get_quotation(session: AsyncSession, quotation_id: uuid.UUID) -> Quotation:
    quotation = (
        await session.execute(select(Quotation).where(Quotation.id == quotation_id))
    ).scalar_one_or_none()
    if quotation is None:
        raise NotFound(f"No quotation {quotation_id}.")
    return quotation


def contract_value(quotation: Quotation) -> Decimal:
    return money(sum((line.amount for line in quotation.lines), start=ZERO))


def estimated_cost(quotation: Quotation) -> Decimal:
    return money(sum((line.est_cost for line in quotation.lines), start=ZERO))


def margin(quotation: Quotation) -> Decimal:
    """Live margin from per-line estimates, to two decimals.

    The round-1 build hardcoded 30% here; per-line ``est_cost`` is what replaced it.
    """
    value = contract_value(quotation)
    if value == ZERO:
        return ZERO
    return ((value - estimated_cost(quotation)) / value * Decimal(100)).quantize(
        Decimal("0.01")
    )


async def create_quotation(
    session: AsyncSession,
    *,
    user: User,
    client_id: uuid.UUID,
    event_type: str,
    event_date: date | None,
    lines: list[tuple[str, Decimal, Decimal]],
    stages: list[billing.StageSpec] | None = None,
    mou_template_id: str | None = None,
) -> Quotation:
    await get_client(session, client_id)
    if not lines:
        raise Invalid("A quotation needs at least one priced line.")

    quotation = Quotation(
        quotation_no=await next_document_no(session, "quotation"),
        client_id=client_id,
        mou_template_id=mou_template_id or await _default_template_id(session),
        event_type=event_type,
        event_date=event_date,
        created_by_user_id=user.id,
    )
    quotation.lines = [
        QuotationLine(line_no=i, label=label, amount=money(amount), est_cost=money(cost))
        for i, (label, amount, cost) in enumerate(lines, start=1)
    ]

    specs = stages or billing.preset_stages("50")
    # Validated now rather than at acceptance, so a schedule that does not add up is caught
    # while it is still a draft someone is editing.
    billing.validate(specs, contract_value(quotation))
    quotation.stages = [
        QuotationStage(
            stage_no=i,
            label=s.label,
            basis=s.basis,
            value=s.value,
            anchor=s.anchor,
            offset_days=s.offset_days,
        )
        for i, s in enumerate(specs, start=1)
    ]

    session.add(quotation)
    await session.flush()
    return quotation


async def update_quotation(
    session: AsyncSession,
    quotation_id: uuid.UUID,
    *,
    lines: list[tuple[str, Decimal, Decimal]] | None = None,
    stages: list[billing.StageSpec] | None = None,
    event_type: str | None = None,
    event_date: date | None = None,
    mou_template_id: str | None = None,
) -> Quotation:
    """Edit a draft.

    **Refused once accepted** — the numbers are contractual by then, and a project may
    already hang off them. Editing a *sent* quote drops it back to Draft, because the
    client is holding a copy of figures that no longer apply and must be re-sent.
    """
    quotation = await get_quotation(session, quotation_id)

    if quotation.status is QuotationStatus.ACCEPTED:
        raise Conflict(
            f"{quotation.quotation_no} has been accepted and cannot be edited. "
            "Its figures are contractual. Raise a new quotation instead."
        )

    if event_type is not None:
        quotation.event_type = event_type
    if event_date is not None:
        quotation.event_date = event_date
    if mou_template_id is not None:
        quotation.mou_template_id = mou_template_id

    # Clear-then-flush-then-replace, not a straight reassignment. Both children carry a
    # UNIQUE (parent_id, ordinal), and SQLAlchemy issues the new INSERTs before the orphan
    # DELETEs in a single flush — so line 1 collides with the line 1 being removed. The
    # intermediate flush makes the deletes land first.
    if lines is not None:
        if not lines:
            raise Invalid("A quotation needs at least one priced line.")
        quotation.lines.clear()
        await session.flush()
        quotation.lines = [
            QuotationLine(line_no=i, label=label, amount=money(amount), est_cost=money(cost))
            for i, (label, amount, cost) in enumerate(lines, start=1)
        ]
        await session.flush()

    if stages is not None:
        billing.validate(stages, contract_value(quotation))
        quotation.stages.clear()
        await session.flush()
        quotation.stages = [
            QuotationStage(
                stage_no=i,
                label=s.label,
                basis=s.basis,
                value=s.value,
                anchor=s.anchor,
                offset_days=s.offset_days,
            )
            for i, s in enumerate(stages, start=1)
        ]
        await session.flush()

    if quotation.status is QuotationStatus.SENT:
        quotation.status = QuotationStatus.DRAFT

    await session.flush()
    return quotation


async def send(session: AsyncSession, quotation_id: uuid.UUID) -> Quotation:
    quotation = await get_quotation(session, quotation_id)
    if quotation.status is not QuotationStatus.DRAFT:
        raise Conflict(f"{quotation.quotation_no} is {quotation.status.value}, not a draft.")
    quotation.status = QuotationStatus.SENT
    await session.flush()
    return quotation


async def accept(session: AsyncSession, quotation_id: uuid.UUID, *, on: date) -> Quotation:
    """Mark a quotation won. Conversion into a project is a separate, deliberate step."""
    quotation = await get_quotation(session, quotation_id)
    if quotation.status is QuotationStatus.ACCEPTED:
        raise Conflict(f"{quotation.quotation_no} is already accepted.")
    if quotation.status is QuotationStatus.DECLINED:
        raise Conflict(f"{quotation.quotation_no} was declined.")

    billing.validate(
        [
            billing.StageSpec(s.label, s.basis, s.value, s.anchor, s.offset_days)
            for s in quotation.stages
        ],
        contract_value(quotation),
    )

    quotation.status = QuotationStatus.ACCEPTED
    quotation.accepted_at = _as_datetime(on)
    await session.flush()
    return quotation


async def decline(session: AsyncSession, quotation_id: uuid.UUID) -> Quotation:
    quotation = await get_quotation(session, quotation_id)
    if quotation.status is QuotationStatus.ACCEPTED:
        # Accepted but not yet converted (Finance has not confirmed the down payment) is still
        # only a promise, and can be withdrawn. Once a project hangs off it, cancel that instead.
        converted = (
            await session.execute(
                select(func.count())
                .select_from(Project)
                .where(Project.quotation_id == quotation.id)
            )
        ).scalar_one()
        if converted:
            raise Conflict(
                f"{quotation.quotation_no} has been accepted and is now a project. "
                "Cancel the project instead."
            )
    quotation.status = QuotationStatus.DECLINED
    await session.flush()
    return quotation


def _as_datetime(on: date):  # type: ignore[no-untyped-def]
    from datetime import UTC, datetime

    return datetime(on.year, on.month, on.day, tzinfo=UTC)


async def resolved_schedule(
    session: AsyncSession, quotation: Quotation, *, signing_date: date
) -> list[billing.ResolvedStage]:
    specs = [
        billing.StageSpec(s.label, s.basis, s.value, s.anchor, s.offset_days)
        for s in quotation.stages
    ] or billing.preset_stages("50")
    return billing.resolve(
        specs,
        contract_value(quotation),
        signing_date=signing_date,
        event_date=quotation.event_date,
    )


# ---------------------------------------------------------------------------
# MoU templates
# ---------------------------------------------------------------------------


async def _default_template_id(session: AsyncSession) -> str | None:
    return (
        await session.execute(
            select(MouTemplate.id).where(MouTemplate.is_default.is_(True)).limit(1)
        )
    ).scalar_one_or_none()


async def update_template(
    session: AsyncSession,
    template_id: str,
    *,
    label: str | None,
    heading: str | None,
    validity: str | None,
    signatory: str | None,
    clauses: list[str] | None,
    fields: set[str],
) -> MouTemplate:
    """Edit a template.

    ``fields`` says what the caller actually sent, so ``validity`` / ``signatory`` can be cleared by
    sending null while an omitted field is left alone. A clause list replaces the old one whole;
    blank clauses are refused rather than stored.

    An accepted quotation's MoU is a contractual document, and what it prints is *resolved from the
    template at the time*, so a wording change here changes what a re-print of an accepted MoU
    says. That is the existing design (the template is the source of the wording); the guard against
    losing a signed document's text is the refusal to delete a template an accepted quotation uses.
    """
    template = await session.get(MouTemplate, template_id)
    if template is None:
        raise NotFound(f"No MoU template {template_id!r}.")

    if label is not None:
        template.label = label.strip()
    if heading is not None:
        template.heading = heading.strip()
    if "validity" in fields:
        template.validity = validity.strip() if validity else None
    if "signatory" in fields:
        template.signatory = signatory.strip() if signatory else None

    if clauses is not None:
        cleaned = [c.strip() for c in clauses]
        if any(not c for c in cleaned):
            raise Invalid("A clause cannot be blank.")
        # Clear first and flush: (template_id, clause_no) is unique, so replacing in one go would
        # collide with the rows being replaced.
        template.clauses.clear()
        await session.flush()
        template.clauses = [
            MouClause(clause_no=i, text=text) for i, text in enumerate(cleaned, start=1)
        ]

    await session.flush()
    await session.refresh(template)
    return template


async def delete_template(session: AsyncSession, template_id: str) -> None:
    """Refused while an accepted quotation uses it.

    An accepted quotation's MoU is a contractual document; deleting the template it was
    generated from would leave that document unreproducible.
    """
    template = await session.get(MouTemplate, template_id)
    if template is None:
        raise NotFound(f"No MoU template {template_id!r}.")

    in_use = (
        await session.execute(
            select(func.count())
            .select_from(Quotation)
            .where(
                Quotation.mou_template_id == template_id,
                Quotation.status == QuotationStatus.ACCEPTED,
            )
        )
    ).scalar_one()
    if in_use:
        raise Conflict(
            f"{template_id!r} is used by {in_use} accepted quotation(s) and cannot be "
            "deleted — their MoUs would become unreproducible."
        )

    remaining = (
        await session.execute(select(func.count()).select_from(MouTemplate))
    ).scalar_one()
    if remaining <= 1:
        raise Conflict("At least one MoU template must remain.")

    fallback = await _default_template_id(session)
    if fallback == template_id:
        fallback = (
            await session.execute(
                select(MouTemplate.id).where(MouTemplate.id != template_id).limit(1)
            )
        ).scalar_one_or_none()

    for quotation in (
        (
            await session.execute(
                select(Quotation).where(Quotation.mou_template_id == template_id)
            )
        )
        .scalars()
        .all()
    ):
        quotation.mou_template_id = fallback

    await session.delete(template)
    await session.flush()


# ---------------------------------------------------------------------------
# Project stages
# ---------------------------------------------------------------------------


async def get_project(session: AsyncSession, project_id: uuid.UUID) -> Project:
    project = (
        await session.execute(select(Project).where(Project.id == project_id))
    ).scalar_one_or_none()
    if project is None:
        raise NotFound(f"No project {project_id}.")
    return project


async def move_stage(
    session: AsyncSession,
    project_id: uuid.UUID,
    *,
    stage: Stage,
    user: User,
    on: date,
) -> Project:
    project = await get_project(session, project_id)
    if project.cancelled:
        raise Conflict(f"{project.project_no} is cancelled.")
    if project.stage is stage:
        return project

    # Stepping back out of Post-Event Feedback withdraws the client's rating, so the incentive
    # pool it produced goes with it: a bonus must not outlive the event that earned it. Once the
    # pool has been paid there is nothing to withdraw — that money has moved.
    feedback_at = STAGE_ORDER.index(Stage.POST_EVENT_FEEDBACK)
    if STAGE_ORDER.index(project.stage) >= feedback_at > STAGE_ORDER.index(stage):
        paid = (
            await session.execute(
                select(IncentiveDisbursement.id).where(
                    IncentiveDisbursement.project_id == project.id
                )
            )
        ).first()
        if paid is None:
            await session.execute(
                delete(ClientFeedback).where(ClientFeedback.project_id == project.id)
            )

    project.stage = stage
    project.stage_since = on
    session.add(
        ProjectStageHistory(
            project_id=project.id, stage=stage, entered_on=on, by_user_id=user.id
        )
    )
    await session.flush()
    return project


async def advance_stage(
    session: AsyncSession, project_id: uuid.UUID, *, user: User, on: date
) -> Project:
    project = await get_project(session, project_id)
    index = STAGE_ORDER.index(project.stage)
    if index >= len(STAGE_ORDER) - 1:
        raise Conflict(f"{project.project_no} is already at the final stage.")
    return await move_stage(
        session, project_id, stage=STAGE_ORDER[index + 1], user=user, on=on
    )


async def revert_stage(
    session: AsyncSession, project_id: uuid.UUID, *, user: User, on: date
) -> Project:
    """Move a project back one stage. Cannot revert past the first."""
    project = await get_project(session, project_id)
    index = STAGE_ORDER.index(project.stage)
    if index == 0:
        raise Conflict(
            f"{project.project_no} is at the first stage; there is nothing to revert to."
        )
    return await move_stage(
        session, project_id, stage=STAGE_ORDER[index - 1], user=user, on=on
    )
