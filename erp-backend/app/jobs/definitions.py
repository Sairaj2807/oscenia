"""The five scheduled jobs, from the prototype's Cron Jobs screen.

There they are seed rows — ``{ id: 'CJ-2', name: 'Overdue invoice sweep (AR)',
lastRun: 'Today 08:00' }`` — with nothing behind them. These are the first implementations, so
each one had to be given an actual definition of what it does and what it produces.

Four of the five raise :class:`~app.jobs.models.Reminder` rows. The fifth is honest about
having no work: see :func:`recompute_ltv`.
"""

from __future__ import annotations

from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.money import ZERO, money
from app.core.storage import get_storage
from app.core.storage_sweep import sweep
from app.domain.ar.models import Client, Invoice, InvoiceStatus, Project
from app.domain.assets import service as assets
from app.domain.assets.models import InventoryItem, InventoryStatus
from app.domain.crm import relations as crm_relations
from app.domain.masters.models import Role, User
from app.jobs.models import JobStatus, Reminder, ReminderKind
from app.jobs.runner import Job, JobResult, register

#: Invoices are chased once they are this far past due. Nothing is chased on the due date
#: itself — an invoice due today is not late today.
GRACE_DAYS = 0

#: Kit is queried this long after the event it went out for. A venue load-out takes a day or
#: two; flagging on the event date itself would cry wolf on every job.
IN_TRANSIT_GRACE_DAYS = 2


async def _system_user(session: AsyncSession) -> User:
    """Who a scheduled posting is attributed to.

    Journal entries carry a real ``posted_by``, and "the scheduler" is not a person — so the
    seeded system account is used, and the memo says the run was automatic.
    """
    row = await session.execute(
        select(User).where(User.role == Role.CEO).order_by(User.email).limit(1)
    )
    user = row.scalars().first()
    if user is None:  # pragma: no cover — the seed always creates one
        raise RuntimeError("No system user to attribute scheduled postings to.")
    return user


async def _raise_reminder(
    session: AsyncSession,
    *,
    kind: ReminderKind,
    subject: str,
    ref: str,
    on: date,
    job_key: str,
    client_id: object = None,
    detail: str | None = None,
) -> bool:
    """Add a reminder unless the same one was already raised today.

    Returns whether it was new. Re-raising the same reminder every morning until somebody
    acts on it would bury the ones that are.
    """
    existing = (
        await session.execute(
            select(Reminder.id).where(
                Reminder.kind == kind, Reminder.ref == ref, Reminder.due_date == on
            )
        )
    ).first()
    if existing is not None:
        return False

    session.add(
        Reminder(
            kind=kind,
            subject=subject,
            detail=detail,
            client_id=client_id,
            ref=ref,
            due_date=on,
            raised_by_job=job_key,
        )
    )
    return True


# ---------------------------------------------------------------------------
# CJ-5 — month-end depreciation
# ---------------------------------------------------------------------------


async def run_month_end_depreciation(session: AsyncSession, on: date) -> JobResult:
    """Post whatever depreciation has fallen due.

    The client's "the system periodically generates draft journal entries for upcoming
    periods" — the register schedules the whole life of each asset, and this is the run that
    posts the part which has actually come due. It clears the **whole backlog**, oldest
    period first, not merely the current month: a scheduler that missed August because the
    process was down should catch August up when it next runs, not skip it forever.
    """
    user = await _system_user(session)
    entries = await assets.run_backlog(session, user=user, as_of=on)

    if not entries:
        return JobResult(
            status=JobStatus.SKIPPED,
            detail={"reason": "no depreciation was due", "periods": []},
        )

    total = ZERO
    for entry in entries:
        total += money(sum((line.debit for line in entry.lines), start=ZERO))

    return JobResult(
        detail={
            "periods": [e.source_ref for e in entries],
            "entries": [e.voucher_no for e in entries],
            "total": str(money(total)),
        }
    )


# ---------------------------------------------------------------------------
# CJ-2 — overdue invoice sweep
# ---------------------------------------------------------------------------


async def sweep_overdue_invoices(session: AsyncSession, on: date) -> JobResult:
    """Chase invoices that are past their due date and still owe money.

    **Nothing is posted and no status is changed.** "Overdue" is not a state an invoice is
    put into — it is `due_date < today` and a balance still outstanding, computed on read, so
    an invoice stops being overdue the moment it is paid without anybody running a job. What
    this sweep produces is the human follow-up.

    ``Scheduled`` stages are excluded, as they are everywhere else: a billing plan is not a
    debt, so a plan cannot be late.
    """
    cutoff = on - timedelta(days=GRACE_DAYS)
    rows = (
        await session.execute(
            select(Invoice, Project, Client)
            .join(Project, Invoice.project_id == Project.id)
            .join(Client, Project.client_id == Client.id)
            .where(
                Invoice.due_date.is_not(None),
                Invoice.due_date < cutoff,
                Invoice.status.in_((InvoiceStatus.UNPAID, InvoiceStatus.PARTIALLY_PAID)),
            )
            .order_by(Invoice.due_date)
        )
    ).all()

    raised = 0
    outstanding = ZERO
    for invoice, project, client in rows:
        outstanding += money(invoice.amount)
        days = (on - invoice.due_date).days if invoice.due_date else 0
        if await _raise_reminder(
            session,
            kind=ReminderKind.OVERDUE_INVOICE,
            subject=f"{invoice.invoice_no} is {days} day(s) overdue — {client.name}",
            detail=f"{project.name} · {invoice.stage_label} · {money(invoice.amount)}",
            ref=invoice.invoice_no,
            client_id=client.id,
            on=on,
            job_key="ar.overdue_sweep",
        ):
            raised += 1

    detail = {
        "overdue": len(rows),
        "reminders_raised": raised,
        "outstanding": str(money(outstanding)),
    }
    if not rows:
        return JobResult(status=JobStatus.SKIPPED, detail={**detail, "reason": "nothing overdue"})
    return JobResult(detail=detail)


# ---------------------------------------------------------------------------
# CJ-1 — birthday and anniversary scan
# ---------------------------------------------------------------------------


def _matches_today(stored: str | None, on: date) -> bool:
    """Does a free-text date like ``'28 Jul'`` or ``'01 Mar 2019'`` fall on this day?

    Client birthdays are free text in the prototype — ``'28 Jul'``, ``'01 Mar 2019'``, ``'—'``
    — and converting them to real dates is a data-cleanup exercise parked as Q10. Until that
    is answered the scan matches on the day and month it can read, and ignores anything it
    cannot. Matching loosely is right here: the cost of a missed birthday is a missed
    birthday, and the cost of guessing at a bad date is a wrong one.
    """
    if not stored:
        return False
    text = stored.strip()
    if not text or text in {"—", "-"}:
        return False

    parts = text.split()
    if len(parts) < 2:
        return False
    try:
        day = int(parts[0])
    except ValueError:
        return False

    return day == on.day and parts[1][:3].lower() == on.strftime("%b").lower()


async def scan_milestones(session: AsyncSession, on: date) -> JobResult:
    """Raise a reminder for every client whose birthday or anniversary is today."""
    clients = (await session.execute(select(Client).order_by(Client.client_no))).scalars().all()

    raised = 0
    matched = 0
    unreadable = 0
    for client in clients:
        for stored, kind, label in (
            (client.birthday, ReminderKind.BIRTHDAY, "Birthday"),
            (client.anniversary, ReminderKind.ANNIVERSARY, "Anniversary"),
        ):
            if not _recorded(stored):
                # Nobody wrote a date down. That is a gap in the CRM, not a date the scan
                # failed to parse, and conflating the two would make the Q10 tally useless.
                continue
            if not _readable(stored):
                # Counted, not corrected. A tally of dates the scan cannot read is the
                # evidence for answering Q10, so it is surfaced rather than discarded.
                unreadable += 1
                continue
            if not _matches_today(stored, on):
                continue
            matched += 1
            if await _raise_reminder(
                session,
                kind=kind,
                subject=f"{label} today — {client.name}",
                detail=f"{client.contact or client.name} · {stored}",
                ref=f"{client.client_no}-{kind.value}",
                client_id=client.id,
                on=on,
                job_key="crm.milestone_scan",
            ):
                raised += 1

    # The structured side: contacts' birthdays, a recorded company anniversary, and event-cycle
    # nudges that fall due today. They sit beside the free-text dates above, not in place of them.
    found = await crm_relations.due_today(session, on)
    for reminder in found:
        matched += 1
        if await _raise_reminder(session, on=on, job_key="crm.milestone_scan", **reminder):
            raised += 1

    detail = {
        "matched": matched,
        "reminders_raised": raised,
        "unreadable_dates": unreadable,
    }
    if matched == 0:
        # No milestone fell today. Distinct from "there was one but the reminder already
        # existed", which is a successful run that raised nothing.
        return JobResult(
            status=JobStatus.SKIPPED, detail={**detail, "reason": "no milestones today"}
        )
    return JobResult(detail=detail)


def _recorded(stored: str | None) -> bool:
    """Whether anybody wrote a date down at all.

    A blank or ``'—'`` is *not* an unreadable date — it is a client whose birthday nobody
    recorded, which is a different problem and does not belong in the Q10 tally.
    """
    return bool(stored and stored.strip() and stored.strip() not in {"—", "-"})


def _readable(stored: str | None) -> bool:
    """Whether a recorded free-text date carries a day and a month the scan can read."""
    if not _recorded(stored):
        return False
    text = (stored or "").strip()
    parts = text.split()
    if len(parts) < 2:
        return False
    try:
        int(parts[0])
    except ValueError:
        return False
    return True


# ---------------------------------------------------------------------------
# CJ-4 — in-transit asset return check
# ---------------------------------------------------------------------------


async def check_in_transit_assets(session: AsyncSession, on: date) -> JobResult:
    """Flag kit that went out to a venue and has not come back.

    Nothing is posted: stock that is late is not stock that is lost. The write-off happens
    when somebody checks it in as lost, which is a decision a person makes.
    """
    cutoff = on - timedelta(days=IN_TRANSIT_GRACE_DAYS)
    rows = (
        (
            await session.execute(
                select(InventoryItem)
                .where(
                    InventoryItem.status == InventoryStatus.IN_TRANSIT,
                    InventoryItem.event_date.is_not(None),
                    InventoryItem.event_date < cutoff,
                )
                .order_by(InventoryItem.item_no)
            )
        )
        .scalars()
        .all()
    )

    raised = 0
    value = ZERO
    for item in rows:
        value_of_item = money(money(item.qty) * money(item.unit_value))
        value += value_of_item
        days = (on - item.event_date).days if item.event_date else 0
        if await _raise_reminder(
            session,
            kind=ReminderKind.ASSET_RETURN,
            subject=f"{item.item} has been out {days} day(s) past its event",
            detail=f"{item.qty} {item.unit or 'units'} · {value_of_item}",
            ref=item.item_no,
            on=on,
            job_key="warehouse.in_transit_check",
        ):
            raised += 1

    detail = {
        "outstanding": len(rows),
        "reminders_raised": raised,
        "value": str(money(value)),
    }
    if not rows:
        return JobResult(
            status=JobStatus.SKIPPED, detail={**detail, "reason": "nothing outstanding"}
        )
    return JobResult(detail=detail)


# ---------------------------------------------------------------------------
# CJ-3 — weekly LTV recompute
# ---------------------------------------------------------------------------


async def recompute_ltv(session: AsyncSession, on: date) -> JobResult:
    """**There is nothing to recompute, and that is the correct outcome.**

    The prototype caches a client's lifetime value, so it needs a weekly job to refresh it.
    Here nothing derivable is stored — lifetime value is summed from the ledger on read, so
    it is never stale and a recompute would write nothing.

    The job is kept registered rather than deleted so the Cron Jobs screen still shows the
    five rows the client reviewed, and so the reason is visible on the screen instead of the
    row silently disappearing. It reports ``skipped`` every week, by design.
    """
    clients = (await session.execute(select(Client.id))).all()
    return JobResult(
        status=JobStatus.SKIPPED,
        detail={
            "reason": "lifetime value is derived from the ledger on read, never stored, "
            "so there is no cached figure to refresh",
            "clients": len(clients),
        },
    )


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------


def _month(on: date) -> str:
    return f"{on.year:04d}-{on.month:02d}"


def _day(on: date) -> str:
    return on.isoformat()


def _week(on: date) -> str:
    year, week, _ = on.isocalendar()
    return f"{year:04d}-W{week:02d}"


MONTH_END_DEPRECIATION = register(
    Job(
        key="depreciation.month_end",
        name="Month-end depreciation run",
        schedule="Last day of month · 23:00",
        cron={"day": "last", "hour": 23, "minute": 0},
        period_for=_month,
        fn=run_month_end_depreciation,
        description="Posts the whole depreciation backlog, oldest period first.",
    )
)

OVERDUE_SWEEP = register(
    Job(
        key="ar.overdue_sweep",
        name="Overdue invoice sweep (AR)",
        schedule="Every day · 08:00",
        cron={"hour": 8, "minute": 0},
        period_for=_day,
        fn=sweep_overdue_invoices,
        description="Raises a reminder per invoice past its due date. Posts nothing.",
    )
)

MILESTONE_SCAN = register(
    Job(
        key="crm.milestone_scan",
        name="Daily birthday & milestone scan",
        schedule="Every day · 07:00",
        cron={"hour": 7, "minute": 0},
        period_for=_day,
        fn=scan_milestones,
        description="Raises a reminder for each client birthday or anniversary today.",
    )
)

IN_TRANSIT_CHECK = register(
    Job(
        key="warehouse.in_transit_check",
        name="In-transit asset return check",
        schedule="Every day · 20:00",
        cron={"hour": 20, "minute": 0},
        period_for=_day,
        fn=check_in_transit_assets,
        description="Flags kit still out past its event date. Posts nothing.",
    )
)

LTV_RECOMPUTE = register(
    Job(
        key="crm.ltv_recompute",
        name="Weekly LTV recompute",
        schedule="Mondays · 06:00",
        cron={"day_of_week": "mon", "hour": 6, "minute": 0},
        period_for=_week,
        fn=recompute_ltv,
        description="No-op by design: lifetime value is derived on read, never cached.",
    )
)

# ---------------------------------------------------------------------------
# Stored-file sweep
# ---------------------------------------------------------------------------


async def sweep_orphan_files(session: AsyncSession, on: date) -> JobResult:
    """Remove stored files nothing refers to, after the grace period.

    Reports only until ``storage_sweep_delete`` is switched on, so the first runs show what it would
    take. The result carries counts (and a few content-hash keys), never file names or contents.
    """
    settings = get_settings()
    report = await sweep(
        session,
        get_storage(),
        delete=settings.storage_sweep_delete,
        grace_days=settings.storage_sweep_grace_days,
    )
    detail = report.detail()
    if report.orphans == 0 and report.temp_removed == 0:
        return JobResult(status=JobStatus.SKIPPED, detail={**detail, "reason": "no orphaned files"})
    return JobResult(detail=detail)


STORAGE_SWEEP = register(
    Job(
        key="storage.sweep",
        name="Orphaned file sweep",
        schedule="Sundays · 03:00",
        cron={"day_of_week": "sun", "hour": 3, "minute": 0},
        period_for=_week,
        fn=sweep_orphan_files,
        description=(
            "Removes stored files nothing refers to, after 7 days. Only reports until it is "
            "switched on."
        ),
    )
)

__all__ = [
    "IN_TRANSIT_CHECK",
    "LTV_RECOMPUTE",
    "MILESTONE_SCAN",
    "MONTH_END_DEPRECIATION",
    "OVERDUE_SWEEP",
    "STORAGE_SWEEP",
]
