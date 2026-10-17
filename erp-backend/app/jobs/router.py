"""Scheduled jobs and the reminders they raise — backs `CronJobs.jsx`.

The prototype's screen lists five jobs with a `lastRun` string baked into the seed. These
endpoints give it real ones, plus a button that actually runs them.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select

from app.core.clock import ClockDep
from app.core.deps import CurrentUser, require_action
from app.core.errors import NotFound
from app.db.session import SessionDep
from app.domain.masters.models import User
from app.jobs import definitions  # noqa: F401  — importing registers the five jobs
from app.jobs.models import JobRun, JobStatus, Reminder, ReminderKind, ReminderStatus
from app.jobs.runner import REGISTRY, get_job, latest_run, run_job

RunsJobs = Annotated[User, Depends(require_action("post_journal"))]

router = APIRouter(tags=["ops"])


class RunOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    job_key: str
    run_for: str
    status: JobStatus
    started_at: datetime
    finished_at: datetime | None
    detail: dict[str, Any]
    triggered_by_user_id: uuid.UUID | None


class JobOut(BaseModel):
    key: str
    name: str
    schedule: str
    description: str
    last_run: RunOut | None


class JobRunRequest(BaseModel):
    #: Which day the run covers. Defaults to today — a month-end job run on any day in
    #: September covers September.
    on: date | None = None


class ReminderOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    kind: ReminderKind
    subject: str
    detail: str | None
    client_id: uuid.UUID | None
    ref: str
    due_date: date
    status: ReminderStatus
    raised_by_job: str


class ReminderResolve(BaseModel):
    status: ReminderStatus = ReminderStatus.DONE


@router.get("/jobs", response_model=list[JobOut])
async def list_jobs(session: SessionDep, user: CurrentUser) -> list[JobOut]:
    """The five jobs, each with its most recent run.

    ``last_run`` is ``null`` for a job that has never run — which is honest, and different
    from the prototype's hardcoded "Today 08:00" on a job with nothing behind it.
    """
    out: list[JobOut] = []
    for job in sorted(REGISTRY.values(), key=lambda j: j.key):
        run = await latest_run(session, job.key)
        out.append(
            JobOut(
                key=job.key,
                name=job.name,
                schedule=job.schedule,
                description=job.description,
                last_run=RunOut.model_validate(run) if run is not None else None,
            )
        )
    return out


@router.get("/jobs/{job_key}/runs", response_model=list[RunOut])
async def job_history(
    session: SessionDep, user: CurrentUser, job_key: str, limit: int = 20
) -> list[RunOut]:
    get_job(job_key)  # 404s on an unknown key rather than returning an empty list
    rows = (
        (
            await session.execute(
                select(JobRun)
                .where(JobRun.job_key == job_key)
                .order_by(JobRun.started_at.desc())
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )
    return [RunOut.model_validate(row) for row in rows]


@router.post("/jobs/{job_key}/run", response_model=RunOut)
async def trigger_job(
    session: SessionDep,
    clock: ClockDep,
    user: RunsJobs,
    job_key: str,
    body: JobRunRequest,
) -> RunOut:
    """Run a job now.

    **Idempotent per period.** A period that already succeeded returns its existing run
    untouched rather than doing the work twice — pressing the button again after month-end
    has posted does not post it again. A period that *failed* is retried, which is why
    failures are recorded rather than only successes.

    A job that blows up returns **200 with ``status: "failed"``** and the error in ``detail``,
    not a 500. Two reasons: the caller pressed a button and wants to know what happened, and a
    500 would roll the request back — taking the record of the failure with it.
    """
    run = await run_job(
        session,
        get_job(job_key),
        on=body.on or clock.today(),
        triggered_by_user_id=user.id,
    )
    return RunOut.model_validate(run)


@router.get("/reminders", response_model=list[ReminderOut])
async def list_reminders(
    session: SessionDep,
    user: CurrentUser,
    reminder_status: ReminderStatus | None = ReminderStatus.OPEN,
    kind: ReminderKind | None = None,
) -> list[ReminderOut]:
    stmt = select(Reminder).order_by(Reminder.due_date.desc(), Reminder.subject)
    if reminder_status is not None:
        stmt = stmt.where(Reminder.status == reminder_status)
    if kind is not None:
        stmt = stmt.where(Reminder.kind == kind)
    rows = (await session.execute(stmt)).scalars().all()
    return [ReminderOut.model_validate(row) for row in rows]


@router.post("/reminders/{reminder_id}/resolve", response_model=ReminderOut)
async def resolve_reminder(
    session: SessionDep, user: CurrentUser, reminder_id: uuid.UUID, body: ReminderResolve
) -> ReminderOut:
    """Mark a reminder done or dismissed. Both are terminal; neither deletes it.

    A dismissed reminder is evidence that somebody looked and decided not to act, which is
    worth more than a missing row.
    """
    reminder = await session.get(Reminder, reminder_id)
    if reminder is None:
        raise NotFound(f"No reminder {reminder_id}.")
    reminder.status = body.status
    await session.flush()
    return ReminderOut.model_validate(reminder)


@router.get("/ops/summary", status_code=status.HTTP_200_OK)
async def ops_summary(session: SessionDep, user: CurrentUser) -> dict[str, Any]:
    """One call for the operations strip: what is registered, what failed, what is open."""
    failed = (
        await session.execute(
            select(JobRun.job_key, JobRun.run_for)
            .where(JobRun.status == JobStatus.FAILED)
            .order_by(JobRun.started_at.desc())
            .limit(10)
        )
    ).all()
    open_count = (
        await session.execute(select(Reminder.id).where(Reminder.status == ReminderStatus.OPEN))
    ).all()
    return {
        "jobs": len(REGISTRY),
        "failed_runs": [{"job_key": k, "run_for": r} for k, r in failed],
        "open_reminders": len(open_count),
    }
