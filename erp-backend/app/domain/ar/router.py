"""Accounts Receivable endpoints."""

from __future__ import annotations

import uuid
from collections.abc import Iterable, Mapping
from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, Response, status
from sqlalchemy import select

from app.core.clock import ClockDep
from app.core.deps import CurrentUser, ManagesWorkspace, require_action, require_module
from app.core.errors import NotFound
from app.db.session import SessionDep
from app.domain.ar import billing, cancellation, client_history, project_edit, quotations, service
from app.domain.ar.models import (
    Client,
    ClientInteraction,
    InteractionAttachment,
    Invoice,
    MouClause,
    MouTemplate,
    Project,
    Quotation,
)
from app.domain.ar.schemas import (
    BucketOut,
    CancelRequest,
    ClientCreate,
    ClientHistoryOut,
    ClientOut,
    ClientReceiptOut,
    ClientUpdate,
    ConfirmDpRequest,
    InteractionAttach,
    InteractionCreate,
    InteractionOut,
    InteractionUpdate,
    InvoiceOut,
    IssueRequest,
    PaymentRequest,
    PostingLineOut,
    PresetOut,
    ProjectEditOut,
    ProjectOut,
    ProjectPatch,
    ProjectPmSet,
    QuotationCreate,
    QuotationOut,
    QuotationUpdate,
    ReceivablesAgeingOut,
    ResolvedStageOut,
    ResolveRequest,
    StageIn,
    StageMove,
    TemplateCreate,
    TemplateOut,
    TemplateUpdate,
)
from app.domain.cash.models import Attachment
from app.domain.ledger.preview import as_preview_out, dry_run
from app.domain.ledger.schemas import PostingPreviewOut
from app.domain.masters.models import User

EditsClient = Annotated[User, Depends(require_action("edit_client"))]
CrmUser = Annotated[User, Depends(require_module("crm"))]
EditsMou = Annotated[User, Depends(require_action("manage_mou_templates"))]
ConfirmsDp = Annotated[User, Depends(require_action("confirm_dp"))]
CancelsQuotation = Annotated[User, Depends(require_action("cancel_quotation"))]
AdvancesStage = Annotated[User, Depends(require_action("advance_stage"))]
RevertsStage = Annotated[User, Depends(require_action("revert_stage"))]
CancelsProject = Annotated[User, Depends(require_action("cancel_project"))]

router = APIRouter(tags=["accounts receivable"])

BUCKET_LABELS = {
    "current": "Current",
    "1-30": "1–30 days",
    "31-60": "31–60 days",
    "60+": "60+ days",
}


def _specs(stages: list[StageIn] | None, preset: str | None) -> list[billing.StageSpec] | None:
    if stages:
        return [
            billing.StageSpec(s.label, s.basis, s.value, s.anchor, s.offset_days)
            for s in stages
        ]
    if preset:
        return billing.preset_stages(preset)
    return None


# ---------------------------------------------------------------------------
# Clients
# ---------------------------------------------------------------------------


@router.get("/clients", response_model=list[ClientOut])
async def list_clients(session: SessionDep, user: CurrentUser) -> list[ClientOut]:
    rows = (await session.execute(select(Client).order_by(Client.client_no))).scalars().all()
    return [ClientOut.model_validate(row) for row in rows]


@router.get("/clients/{client_id}/history", response_model=ClientHistoryOut)
async def get_client_history(
    session: SessionDep, user: CrmUser, client_id: uuid.UUID
) -> ClientHistoryOut:
    """The client's past events, what they were worth, which vendors worked on them and how the
    client rated them. Derived on read from existing records; nothing is stored."""
    return ClientHistoryOut.model_validate(await client_history.client_history(session, client_id))


@router.post("/clients", response_model=ClientOut, status_code=status.HTTP_201_CREATED)
async def create_client(
    session: SessionDep, user: EditsClient, body: ClientCreate
) -> ClientOut:
    client = await quotations.create_client(session, **body.model_dump())
    return ClientOut.model_validate(client)


@router.patch("/clients/{client_id}", response_model=ClientOut)
async def update_client(
    session: SessionDep, user: EditsClient, client_id: uuid.UUID, body: ClientUpdate
) -> ClientOut:
    """Amend a client. Only the fields supplied are changed."""
    client = await quotations.update_client(
        session, client_id, **body.model_dump(exclude_unset=True)
    )
    return ClientOut.model_validate(client)


def _interaction_out(
    interaction: ClientInteraction,
    authors: Mapping[uuid.UUID, str],
    files: Mapping[uuid.UUID, list[dict]] | None = None,
) -> InteractionOut:
    return InteractionOut.model_validate(
        {
            **{c.name: getattr(interaction, c.name) for c in ClientInteraction.__table__.columns},
            "author_name": authors.get(interaction.author_user_id),
            "attachments": (files or {}).get(interaction.id, []),
        }
    )


async def _files_for(
    session: SessionDep, ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[dict]]:
    """The files filed against each of these notes, oldest first."""
    if not ids:
        return {}
    rows = (
        await session.execute(
            select(InteractionAttachment.interaction_id, Attachment)
            .join(Attachment, Attachment.id == InteractionAttachment.attachment_id)
            .where(InteractionAttachment.interaction_id.in_(ids))
            .order_by(InteractionAttachment.created_at, Attachment.filename)
        )
    ).all()
    out: dict[uuid.UUID, list[dict]] = {}
    for interaction_id, attachment in rows:
        out.setdefault(interaction_id, []).append(
            {
                "id": attachment.id,
                "filename": attachment.filename,
                "byte_size": attachment.byte_size,
            }
        )
    return out


@router.get("/clients/{client_id}/interactions", response_model=list[InteractionOut])
async def list_interactions(
    session: SessionDep, user: CurrentUser, client_id: uuid.UUID
) -> list[InteractionOut]:
    rows = (
        (
            await session.execute(
                select(ClientInteraction)
                .where(ClientInteraction.client_id == client_id)
                .order_by(ClientInteraction.interaction_date.desc())
            )
        )
        .scalars()
        .all()
    )
    authors = await _author_names(session, [r.author_user_id for r in rows])
    files = await _files_for(session, [r.id for r in rows])
    return [_interaction_out(row, authors, files) for row in rows]


@router.post(
    "/clients/{client_id}/interactions",
    response_model=InteractionOut,
    status_code=status.HTTP_201_CREATED,
)
async def log_interaction(
    session: SessionDep,
    clock: ClockDep,
    user: EditsClient,
    client_id: uuid.UUID,
    body: InteractionCreate,
) -> InteractionOut:
    """Record a CRM note — free text, no length limit.

    The author is the signed-in user, taken from the token rather than the request body.
    The client asked for notes stamped with who wrote them, and a self-reported author is
    not that.
    """
    interaction = await quotations.log_interaction(
        session,
        client_id,
        user=user,
        note=body.note,
        on=body.interaction_date or clock.today(),
        type_=body.type,
    )
    authors = await _author_names(session, [interaction.author_user_id])
    return _interaction_out(interaction, authors)


@router.patch("/interactions/{interaction_id}", response_model=InteractionOut)
async def update_interaction(
    session: SessionDep,
    user: EditsClient,
    interaction_id: uuid.UUID,
    body: InteractionUpdate,
) -> InteractionOut:
    """Edit a note. Stamps `edited_at`; never reassigns the author."""
    interaction = await quotations.update_interaction(
        session,
        interaction_id,
        note=body.note,
        on=body.interaction_date,
        type_=body.type,
    )
    authors = await _author_names(session, [interaction.author_user_id])
    files = await _files_for(session, [interaction.id])
    return _interaction_out(interaction, authors, files)


@router.post("/interactions/{interaction_id}/attachments", response_model=InteractionOut)
async def attach_to_interaction(
    session: SessionDep, user: EditsClient, interaction_id: uuid.UUID, body: InteractionAttach
) -> InteractionOut:
    """File an uploaded file (``POST /attachments``) against a note. Filing it twice is a no-op."""
    interaction = await session.get(ClientInteraction, interaction_id)
    if interaction is None:
        raise NotFound(f"No note {interaction_id}.")
    if await session.get(Attachment, body.attachment_id) is None:
        raise NotFound(f"No stored file {body.attachment_id}. Upload it first.")
    already = await session.get(InteractionAttachment, (interaction_id, body.attachment_id))
    if already is None:
        session.add(
            InteractionAttachment(interaction_id=interaction_id, attachment_id=body.attachment_id)
        )
        await session.flush()
    authors = await _author_names(session, [interaction.author_user_id])
    return _interaction_out(interaction, authors, await _files_for(session, [interaction_id]))


@router.delete(
    "/interactions/{interaction_id}/attachments/{attachment_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def detach_from_interaction(
    session: SessionDep, user: EditsClient, interaction_id: uuid.UUID, attachment_id: uuid.UUID
) -> None:
    """Take a file off a note. The stored file stays (it may be filed elsewhere)."""
    if await session.get(ClientInteraction, interaction_id) is None:
        raise NotFound(f"No note {interaction_id}.")
    link = await session.get(InteractionAttachment, (interaction_id, attachment_id))
    if link is not None:
        await session.delete(link)
        await session.flush()


@router.delete("/interactions/{interaction_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_interaction(
    session: SessionDep, user: EditsClient, interaction_id: uuid.UUID
) -> None:
    await quotations.delete_interaction(session, interaction_id)


# ---------------------------------------------------------------------------
# Billing schedules
# ---------------------------------------------------------------------------


@router.get("/billing/presets", response_model=list[PresetOut])
async def list_presets(user: CurrentUser) -> list[PresetOut]:
    """The standard DP schemes: 50%, 75%, 100%, and a 30/40/30 staged plan."""
    return [
        PresetOut(
            key=key,
            label=label,
            stages=[
                StageIn(
                    label=s.label,
                    basis=s.basis,
                    value=s.value,
                    anchor=s.anchor,
                    offset_days=s.offset_days,
                )
                for s in specs
            ],
        )
        for key, (label, specs) in billing.PRESETS.items()
    ]


@router.post("/billing/resolve-schedule", response_model=list[ResolvedStageOut])
async def resolve_schedule(
    clock: ClockDep, user: CurrentUser, body: ResolveRequest
) -> list[ResolvedStageOut]:
    """Turn configured stages into amounts and due dates.

    The result sums to the contract value **exactly** — the final stage absorbs the
    rounding remainder, so a 30/40/30 split of an awkward figure still bills the whole job.
    """
    resolved = billing.resolve(
        [
            billing.StageSpec(s.label, s.basis, s.value, s.anchor, s.offset_days)
            for s in body.stages
        ],
        body.contract_value,
        signing_date=body.signing_date or clock.today(),
        event_date=body.event_date,
    )
    return [ResolvedStageOut.model_validate(s) for s in resolved]


# ---------------------------------------------------------------------------
# Quotations
# ---------------------------------------------------------------------------


async def _author_names(
    session: SessionDep, ids: Iterable[uuid.UUID | None]
) -> dict[uuid.UUID, str]:
    """Display names for a set of user ids, in one query.

    Resolved in a batch rather than per row: `list_quotations` renders every quotation, and a
    lookup inside the loop would be an N+1 on a list that is read on every page load.
    """
    wanted = {i for i in ids if i is not None}
    if not wanted:
        return {}
    rows = (
        await session.execute(select(User.id, User.full_name).where(User.id.in_(wanted)))
    ).all()
    return {row[0]: row[1] for row in rows}


async def _quotation_out(
    session: SessionDep,
    quotation: Quotation,
    today: date,
    authors: Mapping[uuid.UUID, str] | None = None,
) -> QuotationOut:
    schedule = await quotations.resolved_schedule(session, quotation, signing_date=today)
    if authors is None:
        authors = await _author_names(session, [quotation.created_by_user_id])
    return QuotationOut.model_validate(
        {
            **{c.name: getattr(quotation, c.name) for c in Quotation.__table__.columns},
            "created_by_name": authors.get(quotation.created_by_user_id),
            "lines": quotation.lines,
            "contract_value": quotations.contract_value(quotation),
            "estimated_cost": quotations.estimated_cost(quotation),
            "margin": quotations.margin(quotation),
            "schedule": schedule,
        }
    )


@router.get("/quotations", response_model=list[QuotationOut])
async def list_quotations(
    session: SessionDep, clock: ClockDep, user: CurrentUser
) -> list[QuotationOut]:
    rows = (
        (await session.execute(select(Quotation).order_by(Quotation.quotation_no)))
        .scalars()
        .all()
    )
    authors = await _author_names(session, [r.created_by_user_id for r in rows])
    return [
        await _quotation_out(session, row, clock.today(), authors=authors) for row in rows
    ]


@router.get("/quotations/{quotation_id}", response_model=QuotationOut)
async def get_quotation(
    session: SessionDep, clock: ClockDep, user: CurrentUser, quotation_id: uuid.UUID
) -> QuotationOut:
    quotation = await quotations.get_quotation(session, quotation_id)
    return await _quotation_out(session, quotation, clock.today())


@router.post(
    "/quotations", response_model=QuotationOut, status_code=status.HTTP_201_CREATED
)
async def create_quotation(
    session: SessionDep, clock: ClockDep, user: CurrentUser, body: QuotationCreate
) -> QuotationOut:
    """Price a job and attach a billing schedule.

    Contract value and margin are summed from the lines, never stored — the client asked
    for a live margin during entry, and a stored total is one more thing to drift.
    """
    quotation = await quotations.create_quotation(
        session,
        user=user,
        client_id=body.client_id,
        event_type=body.event_type,
        event_date=body.event_date,
        lines=[(line.label, line.amount, line.est_cost) for line in body.lines],
        stages=_specs(body.stages, body.preset),
        mou_template_id=body.mou_template_id,
    )
    return await _quotation_out(session, quotation, clock.today())


@router.patch("/quotations/{quotation_id}", response_model=QuotationOut)
async def update_quotation(
    session: SessionDep,
    clock: ClockDep,
    user: CurrentUser,
    quotation_id: uuid.UUID,
    body: QuotationUpdate,
) -> QuotationOut:
    """Edit a draft. **409 once accepted** — the figures are contractual by then.

    Editing a *sent* quotation drops it back to Draft, because the client is holding a copy
    of numbers that no longer apply and must be re-sent.
    """
    quotation = await quotations.update_quotation(
        session,
        quotation_id,
        lines=(
            [(line.label, line.amount, line.est_cost) for line in body.lines]
            if body.lines is not None
            else None
        ),
        stages=_specs(body.stages, body.preset),
        event_type=body.event_type,
        event_date=body.event_date,
        mou_template_id=body.mou_template_id,
    )
    return await _quotation_out(session, quotation, clock.today())


@router.post("/quotations/{quotation_id}/send", response_model=QuotationOut)
async def send_quotation(
    session: SessionDep, clock: ClockDep, user: CurrentUser, quotation_id: uuid.UUID
) -> QuotationOut:
    quotation = await quotations.send(session, quotation_id)
    return await _quotation_out(session, quotation, clock.today())


@router.post("/quotations/{quotation_id}/accept", response_model=QuotationOut)
async def accept_quotation(
    session: SessionDep, clock: ClockDep, user: CurrentUser, quotation_id: uuid.UUID
) -> QuotationOut:
    """Mark it won. Converting it into a project is a separate, deliberate step."""
    quotation = await quotations.accept(session, quotation_id, on=clock.today())
    return await _quotation_out(session, quotation, clock.today())


@router.post("/quotations/{quotation_id}/decline", response_model=QuotationOut)
async def decline_quotation(
    session: SessionDep, clock: ClockDep, user: CancelsQuotation, quotation_id: uuid.UUID
) -> QuotationOut:
    quotation = await quotations.decline(session, quotation_id)
    return await _quotation_out(session, quotation, clock.today())


# ---------------------------------------------------------------------------
# MoU templates
# ---------------------------------------------------------------------------


@router.get("/mou-templates", response_model=list[TemplateOut])
async def list_templates(session: SessionDep, user: CurrentUser) -> list[TemplateOut]:
    rows = (
        (await session.execute(select(MouTemplate).order_by(MouTemplate.id))).scalars().all()
    )
    return [TemplateOut.model_validate(row) for row in rows]


@router.post(
    "/mou-templates", response_model=TemplateOut, status_code=status.HTTP_201_CREATED
)
async def create_template(
    session: SessionDep, user: EditsMou, body: TemplateCreate
) -> TemplateOut:
    template = MouTemplate(
        id=body.id,
        label=body.label,
        heading=body.heading,
        validity=body.validity,
        signatory=body.signatory,
    )
    template.clauses = [
        MouClause(clause_no=i, text=text) for i, text in enumerate(body.clauses, start=1)
    ]
    session.add(template)
    await session.flush()
    return TemplateOut.model_validate(template)


@router.patch("/mou-templates/{template_id}", response_model=TemplateOut)
async def update_template(
    session: SessionDep, user: EditsMou, template_id: str, body: TemplateUpdate
) -> TemplateOut:
    """Edit a template's wording. An accepted quotation keeps the MoU it was generated from."""
    template = await quotations.update_template(
        session,
        template_id,
        label=body.label,
        heading=body.heading,
        validity=body.validity,
        signatory=body.signatory,
        clauses=body.clauses,
        fields=body.model_fields_set,
    )
    return TemplateOut.model_validate(template)


@router.delete("/mou-templates/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_template(session: SessionDep, user: EditsMou, template_id: str) -> None:
    """Refused while an accepted quotation uses it — its MoU would become unreproducible."""
    await quotations.delete_template(session, template_id)


# ---------------------------------------------------------------------------
# Projects
# ---------------------------------------------------------------------------


async def _project_out(session: SessionDep, project: Project) -> ProjectOut:
    out = ProjectOut.model_validate(project)
    if project.pm_user_id is not None:
        pm = await session.get(User, project.pm_user_id)
        out.pm_name = pm.full_name if pm else None
    return out


@router.get("/projects", response_model=list[ProjectOut])
async def list_projects(session: SessionDep, user: CurrentUser) -> list[ProjectOut]:
    rows = (
        await session.execute(
            select(Project, User.full_name)
            .outerjoin(User, User.id == Project.pm_user_id)
            .order_by(Project.project_no)
        )
    ).all()
    out = []
    for project, pm_name in rows:
        item = ProjectOut.model_validate(project)
        item.pm_name = pm_name
        out.append(item)
    return out


@router.get("/projects/{project_id}", response_model=ProjectOut)
async def get_project(
    session: SessionDep, user: CurrentUser, project_id: uuid.UUID
) -> ProjectOut:
    return await _project_out(session, await quotations.get_project(session, project_id))


@router.patch("/projects/{project_id}", response_model=ProjectEditOut)
async def edit_project(
    session: SessionDep, user: ManagesWorkspace, project_id: uuid.UUID, body: ProjectPatch,
    request: Request,
) -> ProjectEditOut:  # fmt: skip
    """Fix a project's name, division or event date (``manage_workspace``: CEO, PM). Money, stage
    and client are never edited here. A new event date moves the due dates of invoices not yet
    issued; the response says what moved and what staff must still update by hand."""
    result = await project_edit.edit_project(
        session, project_id, body.model_dump(exclude_unset=True), actor=user, request=request
    )
    return ProjectEditOut(
        project=await _project_out(session, result.project),
        invoices_rescheduled=result.invoices_rescheduled,
        delivery_orders_updated=result.delivery_orders_updated,
        items_updated=result.items_updated,
        warnings=result.warnings,
    )


@router.put("/projects/{project_id}/pm", response_model=ProjectOut)
async def set_project_pm(
    session: SessionDep, user: ManagesWorkspace, project_id: uuid.UUID, body: ProjectPmSet
) -> ProjectOut:
    """Name the project's PM (or clear it with ``null``). Same permission as setting who works
    on a project: ``manage_workspace`` (CEO, PM)."""
    project = await quotations.get_project(session, project_id)
    if body.user_id is not None:
        person = await session.get(User, body.user_id)
        if person is None or not person.active:
            raise NotFound(f"No active user {body.user_id}.")
    project.pm_user_id = body.user_id
    await session.flush()
    return await _project_out(session, project)


@router.post("/projects/{project_id}/advance-stage", response_model=ProjectOut)
async def advance_stage(
    session: SessionDep, clock: ClockDep, user: AdvancesStage, project_id: uuid.UUID
) -> ProjectOut:
    project = await quotations.advance_stage(
        session, project_id, user=user, on=clock.today()
    )
    return ProjectOut.model_validate(project)


@router.post("/projects/{project_id}/revert-stage", response_model=ProjectOut)
async def revert_stage(
    session: SessionDep, clock: ClockDep, user: RevertsStage, project_id: uuid.UUID
) -> ProjectOut:
    """Move back one stage. Cannot revert past the first."""
    project = await quotations.revert_stage(
        session, project_id, user=user, on=clock.today()
    )
    return ProjectOut.model_validate(project)


@router.post("/projects/{project_id}/move-to-stage", response_model=ProjectOut)
async def move_to_stage(
    session: SessionDep,
    clock: ClockDep,
    user: AdvancesStage,
    project_id: uuid.UUID,
    body: StageMove,
) -> ProjectOut:
    project = await quotations.move_stage(
        session, project_id, stage=body.stage, user=user, on=clock.today()
    )
    return ProjectOut.model_validate(project)


@router.post("/projects/{project_id}/cancel", response_model=ProjectOut)
async def cancel_project(
    session: SessionDep,
    clock: ClockDep,
    user: CancelsProject,
    project_id: uuid.UUID,
    body: CancelRequest,
) -> ProjectOut:
    """Cancel a project, optionally refunding the down payment.

    **Costs already incurred are never reversed.** They were really spent, and unwinding
    them would understate what the cancellation cost the company. Only the revenue side is
    reversed, and only when a refund is actually made.
    """
    project = await cancellation.cancel_project(
        session,
        project_id,
        user=user,
        on=clock.today(),
        reason=body.reason,
        refund_dp=body.refund_dp,
    )
    return ProjectOut.model_validate(project)


# ---------------------------------------------------------------------------
# Deals
# ---------------------------------------------------------------------------


@router.post(
    "/quotations/{quotation_id}/confirm-down-payment",
    response_model=ProjectOut | PostingPreviewOut,
    status_code=status.HTTP_201_CREATED,
)
async def confirm_down_payment(
    session: SessionDep,
    clock: ClockDep,
    user: ConfirmsDp,
    response: Response,
    quotation_id: uuid.UUID,
    body: ConfirmDpRequest | None = None,
    dry_run_only: bool = Query(
        default=False,
        alias="dry_run",
        description="Return the lines this would post, and post nothing",
    ),
) -> ProjectOut | PostingPreviewOut:
    """Convert an accepted quotation into a live project. **One transaction.**

    Creates the project, mints one invoice per billing stage, issues the first and records
    its receipt. Idempotent: a second call returns the existing project rather than
    creating a duplicate, because ``projects.quotation_id`` is unique.
    """
    body = body or ConfirmDpRequest()

    async def _confirm() -> None:
        await service.confirm_down_payment(
            session,
            quotation_id,
            user=user,
            on=body.confirmed_on or clock.today(),
            cash_account=body.cash_account,
            withhold=body.withhold,
            tax_amount=body.tax_amount,
            document_date=body.document_date,
            lines=body.lines,
        )

    # Three documents in one transaction — the receivable, the receipt, and the project
    # itself — so the preview is a list and the dialog shows each of them.
    if dry_run_only:
        # 200, not this route's 201: a preview creates nothing, and saying otherwise is the
        # kind of small lie that makes a client write a special case.
        response.status_code = status.HTTP_200_OK
        return as_preview_out(await dry_run(session, _confirm))

    project = await service.confirm_down_payment(
        session,
        quotation_id,
        user=user,
        on=body.confirmed_on or clock.today(),
        cash_account=body.cash_account,
        withhold=body.withhold,
        tax_amount=body.tax_amount,
        document_date=body.document_date,
        lines=body.lines,
    )
    return ProjectOut.model_validate(project)


@router.post("/projects/{project_id}/undo-down-payment", response_model=ProjectOut)
async def undo_down_payment(
    session: SessionDep, clock: ClockDep, user: ConfirmsDp, project_id: uuid.UUID
) -> ProjectOut:
    """Unwind a down payment: reverse both entries and void the project.

    The project is **voided, not deleted**. Its reversal entries carry its id and journal
    entries are immutable, so removing it would orphan the evidence that the undo happened.
    The quotation is released, so it can be converted again once whatever went wrong is
    sorted out.

    **409 once anything else has happened** — a posted cost or a later issued stage would
    be left dangling, so the refusal names what is in the way.
    """
    project = await service.undo_down_payment(
        session, project_id, user=user, on=clock.today()
    )
    return ProjectOut.model_validate(project)


# ---------------------------------------------------------------------------
# Invoices
# ---------------------------------------------------------------------------


async def _invoice_out(session: SessionDep, invoice: Invoice) -> InvoiceOut:
    return InvoiceOut.model_validate(
        {
            **{c.name: getattr(invoice, c.name) for c in Invoice.__table__.columns},
            "collected": await service.collected(session, invoice),
            "outstanding": await service.outstanding(session, invoice),
        }
    )


@router.get("/invoices", response_model=list[InvoiceOut])
async def list_invoices(
    session: SessionDep,
    user: CurrentUser,
    project_id: uuid.UUID | None = None,
    invoice_status: str | None = None,
) -> list[InvoiceOut]:
    stmt = select(Invoice).order_by(Invoice.invoice_no)
    if project_id is not None:
        stmt = stmt.where(Invoice.project_id == project_id)
    if invoice_status is not None:
        stmt = stmt.where(Invoice.status == invoice_status)
    rows = (await session.execute(stmt)).scalars().all()
    return [await _invoice_out(session, row) for row in rows]


@router.get("/invoices/{invoice_id}", response_model=InvoiceOut)
async def get_invoice(
    session: SessionDep, user: CurrentUser, invoice_id: uuid.UUID
) -> InvoiceOut:
    return await _invoice_out(session, await service.get_invoice(session, invoice_id))


@router.post(
    "/invoices/{invoice_id}/issue", response_model=InvoiceOut | PostingPreviewOut
)
async def issue_invoice(
    session: SessionDep,
    clock: ClockDep,
    user: ConfirmsDp,
    invoice_id: uuid.UUID,
    body: IssueRequest | None = None,
    dry_run_only: bool = Query(
        default=False,
        alias="dry_run",
        description="Return the lines this would post, and post nothing",
    ),
) -> InvoiceOut | PostingPreviewOut:
    """Raise the receivable for a scheduled stage. **409 if already issued.**

    Takes both of the client's dates. `issued_on` is the accounting date and defaults to
    today; `document_date` is what the invoice itself is dated. This endpoint previously
    accepted no body at all, so a receivable could only ever be recorded as of today.

    With `dry_run=true` it returns the posting instead of performing it — the confirmation
    the client asked to see *before* an entry hits the ledger. The preview is the real
    operation, undone, so it cannot drift from what the confirmed call will do.
    """
    body = body or IssueRequest()

    async def _issue() -> None:
        await service.issue(
            session,
            invoice_id,
            user=user,
            on=body.issued_on or clock.today(),
            document_date=body.document_date,
        )

    if dry_run_only:
        return as_preview_out(await dry_run(session, _issue))

    invoice = await service.issue(
        session,
        invoice_id,
        user=user,
        on=body.issued_on or clock.today(),
        document_date=body.document_date,
    )
    return await _invoice_out(session, invoice)


@router.post(
    "/invoices/{invoice_id}/payments",
    response_model=ClientReceiptOut | PostingPreviewOut,
)
async def receive_payment(
    session: SessionDep,
    clock: ClockDep,
    user: ConfirmsDp,
    invoice_id: uuid.UUID,
    body: PaymentRequest,
    dry_run_only: bool = Query(
        default=False,
        alias="dry_run",
        description="Return the lines this would post, and post nothing",
    ),
) -> ClientReceiptOut | PostingPreviewOut:
    """Record a client receipt, net of PPh 23 withheld by the client.

    ``Dr cash (net) + Dr 1401 (tax) / Cr 1201 (gross)``. Gross is clamped to outstanding —
    an overpayment is not a bigger receipt. Withholding may be waived or overridden, but
    tax exceeding the payment is refused.

    `payment_date` is the received date (the accounting date); `document_date` is the date
    on the receipt. `lines` replaces the computed lines under a guard (1201 must still be
    credited by the computed gross). With `dry_run=true` nothing is posted.
    """

    async def _receive() -> service.Receipt:
        return await service.receive_payment(
            session,
            invoice_id,
            user=user,
            amount=body.amount,
            on=body.payment_date or clock.today(),
            cash_account=body.cash_account,
            withhold=body.withhold,
            tax_amount=body.tax_amount,
            document_date=body.document_date,
            lines=body.lines,
        )

    if dry_run_only:
        return as_preview_out(await dry_run(session, _receive))

    receipt = await _receive()
    invoice = await service.get_invoice(session, invoice_id)
    return ClientReceiptOut(
        entry_id=receipt.entry.id,
        entry_no=receipt.entry.entry_no,
        voucher_no=receipt.entry.voucher_no,
        gross=receipt.gross,
        tax=receipt.tax,
        net=receipt.net,
        cash_account=receipt.cash_account,
        invoice=await _invoice_out(session, invoice),
        posting=[
            PostingLineOut(
                account=line.account_code,
                debit=line.debit,
                credit=line.credit,
                note=line.note,
            )
            for line in receipt.entry.lines
        ],
    )


# ---------------------------------------------------------------------------
# Ageing
# ---------------------------------------------------------------------------


@router.get("/receivables/ageing", response_model=ReceivablesAgeingOut)
async def receivables_ageing(
    session: SessionDep, clock: ClockDep, user: CurrentUser, as_of: date | None = None
) -> ReceivablesAgeingOut:
    """AR ageing, with a live reconciliation against control account 1201.

    Scheduled stages are reported separately and **excluded from the total**: they have
    posted nothing, so counting them would put AR permanently out of step with the control
    account and the reconciliation would never read true.
    """
    on = as_of or clock.today()
    result = await service.ageing(session, as_of=on)

    return ReceivablesAgeingOut(
        as_of=on,
        buckets=[
            BucketOut(
                key=key,
                label=BUCKET_LABELS[key],
                amount=result.buckets[key],
                count=result.counts[key],
                share=(
                    float(result.buckets[key] / result.total) if result.total else 0.0
                ),
            )
            for key in service.BUCKETS
        ],
        total=result.total,
        overdue=result.overdue,
        scheduled=result.scheduled,
        scheduled_count=result.scheduled_count,
        ledger_balance=result.ledger_balance,
        difference=result.difference,
        reconciled=result.reconciled,
    )
