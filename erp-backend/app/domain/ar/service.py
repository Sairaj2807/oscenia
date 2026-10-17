"""Accounts Receivable: issuing invoices, receiving payment, and the DP conversion.

The load-bearing rule in this module is inherited ruling 5, and it was **backwards in the
client's round-1 build**:

    Money in — the client withholds, so we receive NET cash and hold a creditable ASSET in
    1401 Prepaid Tax. Revenue is recognised GROSS. The receivable clears at GROSS.

Nothing here credits 2105; that account is for tax *we* withhold from vendors, and mixing
the two is what moved reported revenue, margin and NPAT last time.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict, Invalid, NotFound
from app.core.money import MATERIALITY, ZERO, money
from app.domain.accounts.models import Side
from app.domain.ar import billing
from app.domain.ar.models import (
    Client,
    Invoice,
    InvoiceStatus,
    Project,
    ProjectStageHistory,
    Quotation,
    QuotationStatus,
    Stage,
)
from app.domain.ledger.models import EntryApplication, JournalEntry, JournalLine, SourceKind
from app.domain.ledger.numbering import next_document_no
from app.domain.ledger.overrides import SubmittedLine, apply_line_override, net_movement
from app.domain.ledger.posting import LineIn, SourceIn, post_entry, reverse_entry
from app.domain.masters.models import User
from app.domain.reports.queries import open_items
from app.domain.reports.statements import tax_config, withholding

AR_CONTROL = "1201"
REVENUE_DP = "4101"
REVENUE_DELIVERY = "4102"
PREPAID_PPH23 = "1401"
DEFAULT_CASH = "1101"


@dataclass(slots=True)
class Receipt:
    """What a payment actually posted — returned so the UI can show the exact lines."""

    entry: JournalEntry
    gross: Decimal
    tax: Decimal
    net: Decimal
    cash_account: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def get_invoice(session: AsyncSession, invoice_id: uuid.UUID) -> Invoice:
    invoice = (
        await session.execute(select(Invoice).where(Invoice.id == invoice_id))
    ).scalar_one_or_none()
    if invoice is None:
        raise NotFound(f"No invoice {invoice_id}.")
    return invoice


async def collected(session: AsyncSession, invoice: Invoice) -> Decimal:
    """Gross collected to date, from the ledger rather than a stored column.

    Sums what non-reversed settling entries moved on 1201 against this invoice's
    recognition entry. A reversed receipt therefore stops counting automatically, which is
    how undoing a payment reopens the invoice.
    """
    if invoice.recognition_entry_id is None:
        return ZERO

    stmt = (
        select(
            func.coalesce(func.sum(JournalLine.credit), 0)
            - func.coalesce(func.sum(JournalLine.debit), 0)
        )
        .select_from(EntryApplication)
        .join(JournalEntry, JournalEntry.id == EntryApplication.settling_entry_id)
        .join(JournalLine, JournalLine.entry_id == JournalEntry.id)
        .where(
            EntryApplication.settled_entry_id == invoice.recognition_entry_id,
            JournalEntry.reversed_by_id.is_(None),
            JournalLine.account_code == AR_CONTROL,
        )
    )
    return money((await session.execute(stmt)).scalar_one())


async def outstanding(session: AsyncSession, invoice: Invoice) -> Decimal:
    if invoice.status in (InvoiceStatus.SCHEDULED, InvoiceStatus.CANCELLED):
        return ZERO
    return money(invoice.amount) - await collected(session, invoice)


async def _refresh_status(session: AsyncSession, invoice: Invoice) -> None:
    paid = await collected(session, invoice)
    if paid >= money(invoice.amount) - MATERIALITY:
        invoice.status = InvoiceStatus.PAID
    elif paid > ZERO:
        invoice.status = InvoiceStatus.PARTIALLY_PAID
    else:
        invoice.status = InvoiceStatus.UNPAID
    await session.flush()


# ---------------------------------------------------------------------------
# Issuing
# ---------------------------------------------------------------------------


async def issue(
    session: AsyncSession,
    invoice_id: uuid.UUID,
    *,
    user: User,
    on: date,
    document_date: date | None = None,
) -> Invoice:
    """Raise the receivable for a scheduled billing stage.

    ``Dr 1201 / Cr 4101`` for a down payment, ``Cr 4102`` otherwise. Before this, the stage
    has posted nothing and is deliberately absent from AR — a plan is not a debt.
    """
    invoice = await get_invoice(session, invoice_id)

    if invoice.status is not InvoiceStatus.SCHEDULED:
        raise Conflict(
            f"{invoice.invoice_no} has already been issued (it is {invoice.status.value}). "
            "Issuing it twice would raise the receivable a second time."
        )

    project = await session.get(Project, invoice.project_id)
    if project is None:
        raise NotFound("The invoice's project no longer exists.")

    revenue = (
        REVENUE_DP if invoice.type.value == "Down Payment" else REVENUE_DELIVERY
    )
    gross = money(invoice.amount)

    entry = await post_entry(
        session,
        # `on` is the accounting date. An invoice recorded in October posts in October even
        # when the document is dated September — which is the whole point: it cannot be
        # backdated into a period that is already closed.
        entry_date=on,
        memo=f"{invoice.stage_label} — {project.name}",
        lines=[
            LineIn(AR_CONTROL, debit=gross, note="Receivable raised at gross"),
            LineIn(revenue, credit=gross, note=invoice.stage_label),
        ],
        source=SourceIn(
            kind=SourceKind.INVOICE,
            ref=invoice.invoice_no,
            due=invoice.due_date,
            document_date=document_date,
        ),
        posted_by_id=user.id,
        project_id=project.id,
    )

    invoice.recognition_entry_id = entry.id
    invoice.status = InvoiceStatus.UNPAID
    invoice.issued_at = on
    # Defaults to the recording date, so an invoice raised the day it is dated needs no
    # second date entered — the common case stays one click.
    invoice.document_date = document_date or on
    await session.flush()
    return invoice


# ---------------------------------------------------------------------------
# Receiving payment
# ---------------------------------------------------------------------------


async def receive_payment(
    session: AsyncSession,
    invoice_id: uuid.UUID,
    *,
    user: User,
    amount: Decimal,
    on: date,
    cash_account: str = DEFAULT_CASH,
    withhold: bool = True,
    tax_amount: Decimal | None = None,
    document_date: date | None = None,
    lines: Sequence[SubmittedLine] | None = None,
) -> Receipt:
    """Record a client receipt, net of PPh 23 withheld by the client.

    ``Dr cash (net) + Dr 1401 (tax) / Cr 1201 (gross)``.

    Gross is **clamped to outstanding**: an overpayment is not a bigger receipt, and letting
    it through would put 1201 into credit and break the AR reconciliation. Withholding can
    be waived or manually overridden — the client asked for both — but tax exceeding the
    payment is refused, since that would post negative cash.

    ``document_date`` is the date on the client's receipt or transfer slip, stored as the
    entry's ``source_document_date``; ``on`` is the date the money was received and is the
    accounting date reports use. ``lines`` replaces the computed lines of this receipt after
    the guard in :mod:`app.domain.ledger.overrides` — 1201 must still be credited by gross.
    """
    invoice = await get_invoice(session, invoice_id)

    if invoice.status is InvoiceStatus.SCHEDULED:
        raise Conflict(
            f"{invoice.invoice_no} is a scheduled stage and has not been issued. "
            "Issue it first — until then there is no receivable to settle."
        )
    if invoice.status is InvoiceStatus.CANCELLED:
        raise Conflict(f"{invoice.invoice_no} is cancelled.")

    remaining = await outstanding(session, invoice)
    if remaining <= ZERO:
        raise Conflict(f"{invoice.invoice_no} is already settled.")

    requested = money(amount)
    if requested <= ZERO:
        raise Invalid("A receipt must be for a positive amount.")

    # Clamped, not refused: paying the last stage of a rounded schedule often overshoots by
    # a rupiah, and that should settle the invoice rather than error.
    gross = min(requested, remaining)

    if tax_amount is not None:
        tax = money(tax_amount)
        if tax < ZERO:
            raise Invalid("Withholding cannot be negative.")
    elif withhold:
        config = await tax_config(session)
        tax = withholding(gross, config).amount
    else:
        tax = ZERO

    if tax > gross:
        raise Invalid(
            f"Withholding of {tax} exceeds the payment of {gross}. "
            "The net cash received cannot be negative."
        )

    net = gross - tax
    project = await session.get(Project, invoice.project_id)

    computed = [LineIn(cash_account, debit=net, note="Net cash received from client")]
    if tax > ZERO:
        computed.append(
            LineIn(PREPAID_PPH23, debit=tax, note="PPh 23 withheld by the client")
        )
    computed.append(LineIn(AR_CONTROL, credit=gross, note="Receivable cleared at gross"))

    posted = await apply_line_override(
        session, computed=computed, submitted=lines, control=AR_CONTROL
    )
    if lines is not None:
        # Report what was actually posted, not what would have been.
        tax = net_movement(posted, PREPAID_PPH23)
        net = gross - tax

    entry = await post_entry(
        session,
        entry_date=on,
        memo=f"Receipt — {invoice.invoice_no}",
        lines=posted,
        source=SourceIn(
            kind=SourceKind.PAYMENT, ref=invoice.invoice_no, document_date=document_date
        ),
        posted_by_id=user.id,
        project_id=project.id if project else None,
        applied_to=[invoice.recognition_entry_id] if invoice.recognition_entry_id else [],
    )

    invoice.last_paid_at = on
    await _refresh_status(session, invoice)

    return Receipt(entry=entry, gross=gross, tax=tax, net=net, cash_account=cash_account)


# ---------------------------------------------------------------------------
# The down-payment conversion
# ---------------------------------------------------------------------------


async def confirm_down_payment(
    session: AsyncSession,
    quotation_id: uuid.UUID,
    *,
    user: User,
    on: date,
    cash_account: str = DEFAULT_CASH,
    withhold: bool = True,
    tax_amount: Decimal | None = None,
    document_date: date | None = None,
    lines: Sequence[SubmittedLine] | None = None,
) -> Project:
    """Convert an accepted quotation into a live project. **One transaction.**

    Creates the project, mints one invoice per billing stage, issues the first, and records
    its receipt — so the books move from "we won the job" to "the money is in" atomically.

    Idempotent by construction: ``projects.quotation_id`` is unique, so a second attempt
    finds the existing project rather than creating a duplicate. That replaces the
    prototype's in-memory ``dpConfirmed`` flag, which a stateless API cannot rely on.

    ``tax_amount``, ``document_date`` and ``lines`` apply to the **receipt** only. The
    down-payment invoice it issues first is a companion accrual and is never edited.
    """
    quotation = (
        await session.execute(select(Quotation).where(Quotation.id == quotation_id))
    ).scalar_one_or_none()
    if quotation is None:
        raise NotFound(f"No quotation {quotation_id}.")

    existing = (
        await session.execute(select(Project).where(Project.quotation_id == quotation_id))
    ).scalar_one_or_none()
    if existing is not None:
        # A no-op rather than an error: a retried request after a dropped connection
        # should be safe, not a duplicate project.
        return existing

    if quotation.status is not QuotationStatus.ACCEPTED:
        raise Conflict(
            f"{quotation.quotation_no} is {quotation.status.value}. Only an accepted "
            "quotation converts into a project."
        )

    contract_value = money(
        sum((line.amount for line in quotation.lines), start=ZERO)
    )
    if contract_value <= ZERO:
        raise Conflict(f"{quotation.quotation_no} has no priced lines.")

    estimated_cost = money(sum((line.est_cost for line in quotation.lines), start=ZERO))
    if estimated_cost == ZERO:
        # The prototype's fallback when no per-line estimate was captured.
        estimated_cost = money(contract_value * Decimal("0.7"))

    specs = [
        billing.StageSpec(
            label=s.label,
            basis=s.basis,
            value=s.value,
            anchor=s.anchor,
            offset_days=s.offset_days,
        )
        for s in quotation.stages
    ] or billing.preset_stages("50")

    schedule = billing.resolve(
        specs, contract_value, signing_date=on, event_date=quotation.event_date
    )

    client = await session.get(Client, quotation.client_id)
    project = Project(
        project_no=await next_document_no(session, "project"),
        name=f"{client.name if client else 'Client'} {quotation.event_type}",
        client_id=quotation.client_id,
        quotation_id=quotation.id,
        stage=Stage.DP_PAID,
        stage_since=on,
        division="Sales",
        contract_value=contract_value,
        estimated_cost=estimated_cost,
        event_date=quotation.event_date,
    )
    session.add(project)
    await session.flush()

    session.add(
        ProjectStageHistory(
            project_id=project.id, stage=Stage.DP_PAID, entered_on=on, by_user_id=user.id
        )
    )

    invoices: list[Invoice] = []
    for stage in schedule:
        invoice = Invoice(
            invoice_no=await next_document_no(session, "invoice"),
            project_id=project.id,
            type=stage.invoice_type,
            stage_label=stage.label,
            stage_no=stage.stage_no,
            amount=stage.amount,
            due_date=stage.due,
            status=InvoiceStatus.SCHEDULED,
        )
        session.add(invoice)
        invoices.append(invoice)
    await session.flush()

    # Stage one is issued and settled now; the rest stay Scheduled, and are deliberately
    # absent from AR until they are issued.
    first = invoices[0]
    await issue(session, first.id, user=user, on=on)
    await receive_payment(
        session,
        first.id,
        user=user,
        amount=first.amount,
        on=on,
        cash_account=cash_account,
        withhold=withhold,
        tax_amount=tax_amount,
        document_date=document_date,
        lines=lines,
    )

    return project


async def undo_down_payment(
    session: AsyncSession, project_id: uuid.UUID, *, user: User, on: date
) -> Project:
    """Unwind a down payment: reverse both entries, and void the project.

    **The project is voided, not deleted** — and that is a deliberate departure from the
    prototype, forced by two rules that did not exist there.

    Undoing posts reversal entries, and those entries carry ``project_id``. Journal entries
    are immutable, so the reference cannot be nulled out afterwards, and the foreign key
    means the project cannot be removed while they point at it. Deleting the project would
    destroy the evidence that the undo happened at all.

    So the ledger keeps the reversal pair, the invoices are marked Cancelled, and the
    project remains as a voided shell that explains why those entries exist. Nothing is
    destroyed; the money simply nets to zero.

    **Refused once anything else has happened.** A posted cost or a later issued stage
    would be left dangling, so the refusal names what is in the way.
    """
    project = await session.get(Project, project_id)
    if project is None:
        raise NotFound(f"No project {project_id}.")

    invoices = list(
        (
            await session.execute(select(Invoice).where(Invoice.project_id == project_id))
        )
        .scalars()
        .all()
    )

    issued_later = [
        inv
        for inv in invoices
        if inv.stage_no > 1 and inv.status is not InvoiceStatus.SCHEDULED
    ]
    if issued_later:
        raise Conflict(
            f"{project.project_no} has later billing stages already issued "
            f"({', '.join(i.invoice_no for i in issued_later)}). Reverse those first."
        )

    dp_entry_ids = {inv.recognition_entry_id for inv in invoices if inv.recognition_entry_id}

    other = (
        await session.execute(
            select(func.count())
            .select_from(JournalEntry)
            .where(
                JournalEntry.project_id == project_id,
                JournalEntry.reversal_of_id.is_(None),
                JournalEntry.reversed_by_id.is_(None),
                JournalEntry.source_kind.notin_([SourceKind.INVOICE, SourceKind.PAYMENT]),
            )
        )
    ).scalar_one()
    if other:
        raise Conflict(
            f"{project.project_no} has {other} other posting(s) — costs, purchase orders or "
            "petty cash. Undoing the down payment would orphan them."
        )

    # Reverse receipts before recognitions: a payment applied to an already-reversed
    # document is a dangling reference, and the order is the whole point.
    receipts = list(
        (
            await session.execute(
                select(JournalEntry)
                .join(
                    EntryApplication,
                    EntryApplication.settling_entry_id == JournalEntry.id,
                )
                .where(
                    EntryApplication.settled_entry_id.in_(dp_entry_ids or [uuid.uuid4()]),
                    JournalEntry.reversed_by_id.is_(None),
                )
            )
        )
        .scalars()
        .all()
    )
    for receipt in receipts:
        await reverse_entry(session, entry_id=receipt.id, posted_by_id=user.id, on=on)

    for entry_id in dp_entry_ids:
        entry = await session.get(JournalEntry, entry_id)
        if entry is not None and entry.reversed_by_id is None:
            await reverse_entry(session, entry_id=entry_id, posted_by_id=user.id, on=on)

    for invoice in invoices:
        invoice.status = InvoiceStatus.CANCELLED

    project.cancelled = True
    project.cancelled_at = on
    project.dp_refunded = True
    project.cancel_reason = project.cancel_reason or "Down payment undone"

    # The quotation is released so it can be converted again once whatever went wrong is
    # sorted out. The unique constraint on projects.quotation_id would otherwise make the
    # voided project block a second, correct attempt forever.
    project.quotation_id = None

    await session.flush()
    return project


# ---------------------------------------------------------------------------
# Ageing
# ---------------------------------------------------------------------------

BUCKETS = ("current", "1-30", "31-60", "60+")


def bucket_for(due: date | None, as_of: date) -> str:
    if due is None:
        return "current"
    overdue = (as_of - due).days
    if overdue <= 0:
        return "current"
    if overdue <= 30:
        return "1-30"
    if overdue <= 60:
        return "31-60"
    return "60+"


@dataclass(slots=True)
class Ageing:
    buckets: dict[str, Decimal]
    counts: dict[str, int]
    total: Decimal
    overdue: Decimal
    scheduled: Decimal
    scheduled_count: int
    ledger_balance: Decimal
    difference: Decimal

    @property
    def reconciled(self) -> bool:
        return self.difference == ZERO


async def ageing(session: AsyncSession, *, as_of: date) -> Ageing:
    """AR ageing, with a live reconciliation against control account 1201.

    Scheduled stages are **excluded from the total** — they have posted nothing, so
    counting them would put AR permanently out of step with 1201 and the badge would never
    read *Reconciled*. They are reported separately instead.
    """
    from app.domain.reports.queries import account_balance

    items = await open_items(session, control=AR_CONTROL, side=Side.DEBIT, as_of=as_of)

    buckets = dict.fromkeys(BUCKETS, ZERO)
    counts = dict.fromkeys(BUCKETS, 0)
    total = ZERO
    overdue = ZERO

    for item in items:
        key = bucket_for(item.due or item.entry_date, as_of)
        buckets[key] += item.outstanding
        counts[key] += 1
        total += item.outstanding
        if key != "current":
            overdue += item.outstanding

    scheduled_rows = (
        (
            await session.execute(
                select(Invoice).where(Invoice.status == InvoiceStatus.SCHEDULED)
            )
        )
        .scalars()
        .all()
    )
    scheduled = money(sum((inv.amount for inv in scheduled_rows), start=ZERO))

    ledger = await account_balance(session, AR_CONTROL)

    return Ageing(
        buckets=buckets,
        counts=counts,
        total=money(total),
        overdue=money(overdue),
        scheduled=scheduled,
        scheduled_count=len(scheduled_rows),
        ledger_balance=ledger,
        difference=money(total) - ledger,
    )


__all__ = [
    "Ageing",
    "Receipt",
    "ageing",
    "bucket_for",
    "collected",
    "confirm_down_payment",
    "get_invoice",
    "issue",
    "outstanding",
    "receive_payment",
    "undo_down_payment",
]
