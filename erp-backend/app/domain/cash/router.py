"""Cash-operations endpoints: petty cash, procurement, attachments and budgets."""

from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, File, UploadFile, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from sqlalchemy import select

from app.core.clock import ClockDep
from app.core.deps import CurrentUser, EditsTax, require_action
from app.core.errors import NotFound
from app.core.money import ZERO, money
from app.core.storage import ATTACHMENT, get_storage
from app.db.session import SessionDep
from app.domain.cash import service
from app.domain.cash.models import Attachment, BudgetAlert, ProcurementRequest, RequestStatus
from app.domain.cash.schemas import (
    AdvanceSettleRequest,
    AlertOut,
    AttachmentOut,
    BudgetOut,
    BudgetUpdate,
    CategoryOut,
    PettyCashOut,
    RequestCreate,
    RequesterRowOut,
    RequestOut,
    SettingsOut,
    SettingsUpdate,
    TopUpRequest,
    TransitionRequest,
)
from app.domain.cash.service import CategoryActual
from app.domain.masters.models import User

ApprovesCash = Annotated[User, Depends(require_action("approve_cash"))]
RequestsAdvance = Annotated[User, Depends(require_action("request_advance"))]
FilesExpense = Annotated[User, Depends(require_action("file_expense"))]

router = APIRouter(tags=["cash operations"])


def _request_out(request: ProcurementRequest) -> RequestOut:
    return RequestOut.model_validate(
        {
            **{
                c.name: getattr(request, c.name)
                for c in ProcurementRequest.__table__.columns
            },
            "receipts": [{"attachment_id": r.attachment_id} for r in request.receipts],
            "variance": (
                money(request.amount) - money(request.actual)
                if request.actual is not None
                else None
            ),
            "from_petty_cash": request.from_petty_cash,
        }
    )


# ---------------------------------------------------------------------------
# Attachments
# ---------------------------------------------------------------------------


@router.post(
    "/attachments", response_model=AttachmentOut, status_code=status.HTTP_201_CREATED
)
async def upload_attachment(
    session: SessionDep, user: CurrentUser, file: UploadFile = File(...)
) -> AttachmentOut:
    """Store a receipt, agreement or pricelist.

    Files are content-addressed: the stored name is a hash of the content, never the
    uploaded filename, which is attacker-controlled. Size is measured while streaming
    rather than taken from ``Content-Length``, which a client can simply lie about.

    Uploading the same file twice is idempotent — it returns a second row pointing at the
    same stored blob.
    """
    # Blocking disk work: run it off the event loop so one upload does not stall every request.
    stored = await run_in_threadpool(
        get_storage().save,
        file.file,
        kind=ATTACHMENT,
        content_type=file.content_type or "application/octet-stream",
        filename=file.filename,
    )

    attachment = Attachment(
        filename=file.filename or "upload",
        content_type=stored.content_type,
        byte_size=stored.byte_size,
        storage_key=stored.storage_key,
        sha256=stored.sha256,
        uploaded_by_user_id=user.id,
    )
    session.add(attachment)
    await session.flush()
    return AttachmentOut.model_validate(attachment)


@router.get("/attachments/{attachment_id}")
async def download_attachment(
    session: SessionDep, user: CurrentUser, attachment_id: uuid.UUID
) -> StreamingResponse:
    attachment = await session.get(Attachment, attachment_id)
    if attachment is None:
        raise NotFound(f"No attachment {attachment_id}.")
    # A vendor's bank letter or tax number is not for every signed-in user to fetch by id.
    from app.core.rbac import can_see
    from app.domain.ap.models import VendorAttachment

    filed_on_a_vendor = (
        await session.execute(
            select(VendorAttachment.id)
            .where(VendorAttachment.attachment_id == attachment_id)
            .limit(1)
        )
    ).first() is not None
    if filed_on_a_vendor and not can_see(user.role, "vendors"):
        raise NotFound(f"No attachment {attachment_id}.")  # the same answer as a missing one

    handle = get_storage().open(attachment.storage_key)
    return StreamingResponse(
        handle,
        media_type=attachment.content_type,
        headers={
            # The original filename is echoed back for the download, quoted so a comma or
            # semicolon in it cannot break the header.
            "Content-Disposition": f'attachment; filename="{attachment.filename}"'
        },
    )


# ---------------------------------------------------------------------------
# Petty cash
# ---------------------------------------------------------------------------


@router.get("/petty-cash", response_model=PettyCashOut)
async def petty_cash_position(
    session: SessionDep, clock: ClockDep, user: CurrentUser, as_of: date | None = None
) -> PettyCashOut:
    """The float's position, derived entirely from the ledger.

    The prototype computes this twice — once from the ledger, once from the request list —
    and asserts the two agree. One source of truth beats two that must be reconciled.
    """
    on = as_of or clock.today()
    result = await service.petty_cash(session, as_of=on)
    return PettyCashOut(
        balance=result.balance,
        opening=result.opening,
        topped_up=result.topped_up,
        disbursed=result.disbursed,
        awaiting_approval=result.awaiting_approval,
        awaiting_count=result.awaiting_count,
        as_of=on,
    )


@router.post("/petty-cash/top-up", response_model=PettyCashOut)
async def top_up(
    session: SessionDep, clock: ClockDep, user: ApprovesCash, body: TopUpRequest
) -> PettyCashOut:
    """Replenish the float from the main bank.

    ``Dr 1103 / Cr 1101``. **Total cash does not change** — this is a transfer between two
    cash accounts, not income.
    """
    on = body.payment_date or clock.today()
    await service.top_up(session, amount=body.amount, user=user, on=on)
    result = await service.petty_cash(session, as_of=on)
    return PettyCashOut(
        balance=result.balance,
        opening=result.opening,
        topped_up=result.topped_up,
        disbursed=result.disbursed,
        awaiting_approval=result.awaiting_approval,
        awaiting_count=result.awaiting_count,
        as_of=on,
    )


# ---------------------------------------------------------------------------
# Procurement
# ---------------------------------------------------------------------------


@router.get("/procurement-requests", response_model=list[RequestOut])
async def list_requests(
    session: SessionDep,
    user: CurrentUser,
    request_status: RequestStatus | None = None,
    project_id: uuid.UUID | None = None,
    requester: str | None = None,
    since: date | None = None,
) -> list[RequestOut]:
    stmt = select(ProcurementRequest).order_by(ProcurementRequest.request_no)
    if request_status is not None:
        stmt = stmt.where(ProcurementRequest.status == request_status)
    if project_id is not None:
        stmt = stmt.where(ProcurementRequest.project_id == project_id)
    if requester is not None:
        stmt = stmt.where(ProcurementRequest.requested_by == requester)
    if since is not None:
        stmt = stmt.where(ProcurementRequest.request_date >= since)

    rows = (await session.execute(stmt)).scalars().all()
    return [_request_out(row) for row in rows]


@router.post(
    "/procurement-requests", response_model=RequestOut, status_code=status.HTTP_201_CREATED
)
async def create_request(
    session: SessionDep, clock: ClockDep, user: RequestsAdvance, body: RequestCreate
) -> RequestOut:
    """Raise a request for cash.

    ``requested_by`` defaults to the signed-in user. An **explicitly blank** one is refused
    with 422: petty cash cannot be issued anonymously, and defaulting a deliberate blank
    would defeat the requirement.
    """
    request = await service.create_request(
        session,
        user=user,
        category=body.category,
        amount=body.amount,
        on=body.request_date or clock.today(),
        project_id=body.project_id,
        requested_by=body.requested_by,
    )
    return _request_out(request)


@router.post("/procurement-requests/{request_id}/transition", response_model=RequestOut)
async def transition_request(
    session: SessionDep,
    clock: ClockDep,
    user: ApprovesCash,
    request_id: uuid.UUID,
    body: TransitionRequest,
) -> RequestOut:
    """Move a request through ``Draft → Pending → Approved → Disbursed → Completed``.

    Only the listed moves are allowed — a request cannot jump from Draft to Disbursed and
    skip the approval. The ledger is touched on **Disbursed**, routed by category: petty
    categories draw from the float into logistics, everything else from the main bank into
    vendor costs. The line note names the requester.
    """
    request = await service.transition(
        session,
        request_id,
        to=body.status,
        user=user,
        on=body.effective_date or clock.today(),
        reason=body.reason,
    )
    return _request_out(request)


@router.post("/procurement-requests/{request_id}/settle", response_model=RequestOut)
async def settle_advance(
    session: SessionDep,
    clock: ClockDep,
    user: FilesExpense,
    request_id: uuid.UUID,
    body: AdvanceSettleRequest,
) -> RequestOut:
    """File the expense report and reconcile the advance.

    **At least one receipt is required** — an advance settled on an assertion alone is an
    unevidenced cash movement. Returning a surplus puts money back in the float; a shortfall
    is reimbursed. Either way it posts in the RM series, because a settlement is a
    reimbursement whichever direction the money goes.
    """
    request = await service.settle_advance(
        session,
        request_id,
        actual=body.actual,
        attachment_ids=body.attachment_ids,
        user=user,
        on=body.settled_on or clock.today(),
    )
    return _request_out(request)


@router.get("/procurement-requests/by-requester", response_model=list[RequesterRowOut])
async def recap_by_requester(
    session: SessionDep, user: CurrentUser
) -> list[RequesterRowOut]:
    """Who asked for what, and what came back — the client's "Recap by Requester"."""
    return [RequesterRowOut.model_validate(row) for row in await service.by_requester(session)]


# ---------------------------------------------------------------------------
# Budgets
# ---------------------------------------------------------------------------


def _budget_out(project_id: uuid.UUID, categories: list[CategoryActual]) -> BudgetOut:
    ceiling = money(sum((c.ceiling for c in categories), start=ZERO))
    spent = money(sum((c.spent for c in categories), start=ZERO))
    return BudgetOut(
        project_id=project_id,
        categories=[CategoryOut.model_validate(c) for c in categories],
        total_ceiling=ceiling,
        total_spent=spent,
        total_remaining=ceiling - spent,
        utilisation=(
            (spent / ceiling * Decimal(100)).quantize(Decimal("0.01"))
            if ceiling
            else ZERO
        ),
    )


@router.get("/projects/{project_id}/budget", response_model=BudgetOut)
async def get_budget(
    session: SessionDep, user: CurrentUser, project_id: uuid.UUID
) -> BudgetOut:
    """Ceilings, with actuals **derived from postings** rather than stored."""
    budget, categories = await service.budget_for(session, project_id)
    if budget is None:
        raise NotFound(f"No budget set for project {project_id}.")
    return _budget_out(project_id, categories)


@router.put("/projects/{project_id}/budget", response_model=BudgetOut)
async def set_budget(
    session: SessionDep, user: ApprovesCash, project_id: uuid.UUID, body: BudgetUpdate
) -> BudgetOut:
    await service.set_categories(
        session,
        project_id,
        categories=[
            (c.key, c.label, c.ceiling, c.account_codes) for c in body.categories
        ],
    )
    _, categories = await service.budget_for(session, project_id)
    return _budget_out(project_id, categories)


@router.get("/alerts/budget-breaches", response_model=list[AlertOut])
async def budget_breaches(session: SessionDep, user: CurrentUser) -> list[AlertOut]:
    """Projects flagged for running past their tolerance.

    One row per project, ever — the alert is a record, not a recurring nag, which is what
    makes "flag once" true for a stateless API.
    """
    rows = (await session.execute(select(BudgetAlert))).scalars().all()
    return [
        AlertOut(
            project_id=row.project_id,
            ceiling=row.ceiling,
            spent=row.spent,
            over_by=money(row.spent) - money(row.ceiling),
            acknowledged=row.acknowledged,
            raised_on=row.raised_on,
        )
        for row in rows
    ]


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------


@router.get("/settings", response_model=SettingsOut)
async def get_settings(session: SessionDep, user: CurrentUser) -> SettingsOut:
    return SettingsOut.model_validate(await service.settings(session))


@router.patch("/settings", response_model=SettingsOut)
async def update_settings(
    session: SessionDep, user: EditsTax, body: SettingsUpdate
) -> SettingsOut:
    """Adjust company policy.

    The budget tolerance **warns, never blocks**: the client was explicit that spending past
    it should raise a flag, not stop the job.
    """
    row = await service.settings(session)
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(row, field, value)
    await session.flush()
    return SettingsOut.model_validate(row)
