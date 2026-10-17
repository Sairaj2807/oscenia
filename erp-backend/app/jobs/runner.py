"""The job registry and the guard that makes a run safe to repeat.

A scheduler is not a guarantee. A tick can fire twice, a process can die halfway through a
month-end posting, and an operator will eventually need to know whether depreciation actually
ran for August. All three are the same problem, and ``job_runs`` is the answer to all three:
one row per ``(job_key, run_for)``, claimed before the work starts.

``run_for`` is the period the run **covers**, not the moment it started. Retrying a crashed
month-end has to land on the same row rather than mint a second one, so a job that covers
August is keyed ``'2026-08'`` however many times it is attempted and on whatever day.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict, NotFound
from app.jobs.models import JobRun, JobStatus

log = logging.getLogger("app.jobs")

#: How long a ``running`` row is believed before it is treated as a crashed process and
#: reclaimed. Long enough that a slow month-end is not stolen from itself, short enough that
#: a crash does not block tomorrow's attempt.
STALE_AFTER = timedelta(minutes=30)


@dataclass(frozen=True, slots=True)
class JobResult:
    """What a job did. ``SKIPPED`` means it ran and found nothing to do, and says so."""

    status: JobStatus = JobStatus.SUCCEEDED
    detail: dict[str, Any] = field(default_factory=dict)


JobFn = Callable[[AsyncSession, date], Awaitable[JobResult]]


@dataclass(frozen=True, slots=True)
class Job:
    key: str
    name: str

    #: Human text for the Cron Jobs screen, matching the prototype's wording.
    schedule: str

    #: APScheduler cron fields. Kept as data so the registry stays declarative and the
    #: scheduler module has nothing to decide.
    cron: dict[str, Any]

    #: What period a run on this date covers. Month-end depreciation covers the month it
    #: falls in; daily sweeps cover that day.
    period_for: Callable[[date], str]

    fn: JobFn

    description: str = ""


REGISTRY: dict[str, Job] = {}


def register(job: Job) -> Job:
    REGISTRY[job.key] = job
    return job


def get_job(key: str) -> Job:
    job = REGISTRY.get(key)
    if job is None:
        raise NotFound(f"No job {key!r}. Known jobs: {', '.join(sorted(REGISTRY))}.")
    return job


def _utcnow() -> datetime:
    return datetime.now(UTC)


async def latest_run(session: AsyncSession, job_key: str) -> JobRun | None:
    row = await session.execute(
        select(JobRun).where(JobRun.job_key == job_key).order_by(JobRun.started_at.desc()).limit(1)
    )
    return row.scalars().first()


async def run_job(
    session: AsyncSession,
    job: Job,
    *,
    on: date,
    triggered_by_user_id: uuid.UUID | None = None,
) -> JobRun:
    """Run one job for the period the given date falls in, at most once.

    A period that already succeeded (or was skipped with nothing to do) returns its existing
    row untouched — the work is not repeated. A period that **failed** is retried, which is
    the point of recording the failure rather than only the success. A period still marked
    running is left alone until its lease expires, so two schedulers cannot both post
    month-end.
    """
    run_for = job.period_for(on)

    existing = (
        await session.execute(
            select(JobRun)
            .where(JobRun.job_key == job.key, JobRun.run_for == run_for)
            .with_for_update()
        )
    ).scalar_one_or_none()

    if existing is not None:
        if existing.status in (JobStatus.SUCCEEDED, JobStatus.SKIPPED):
            return existing
        if existing.status is JobStatus.RUNNING:
            started = existing.started_at
            if started.tzinfo is None:
                started = started.replace(tzinfo=UTC)
            if _utcnow() - started < STALE_AFTER:
                raise Conflict(
                    f"{job.key} is already running for {run_for}. "
                    "If a previous attempt crashed, it is retried automatically "
                    f"after {int(STALE_AFTER.total_seconds() // 60)} minutes."
                )
        # Failed, or a stale running row from a process that died. Reclaim it.
        run = existing
        run.status = JobStatus.RUNNING
        run.started_at = _utcnow()
        run.finished_at = None
        run.detail = {}
        run.triggered_by_user_id = triggered_by_user_id
    else:
        run = JobRun(
            job_key=job.key,
            run_for=run_for,
            status=JobStatus.RUNNING,
            started_at=_utcnow(),
            detail={},
            triggered_by_user_id=triggered_by_user_id,
        )
        session.add(run)

    await session.flush()

    try:
        # The body runs inside a savepoint so a failure rolls back whatever it had done
        # without taking the claim row with it — otherwise the record of the failure would
        # be rolled back too, and there would be nothing to retry from.
        async with session.begin_nested():
            result = await job.fn(session, on)
    except Exception as exc:
        # **Recorded, not re-raised**, and the distinction is load-bearing.
        #
        # Re-raising propagates out to whichever transaction the caller opened — the
        # scheduler's `session.begin()`, or the request session, which rolls back on any
        # exception. Either one takes the FAILED row down with it, and the table whose whole
        # purpose is answering "did month-end run, and what happened?" would be empty for
        # precisely the runs worth asking about.
        #
        # So a failed job is a *result*, not an exception: the row is written, the traceback
        # is logged, and the caller gets a run it can inspect. Callers that care check
        # `run.status`.
        run.status = JobStatus.FAILED
        run.finished_at = _utcnow()
        run.detail = {"error": type(exc).__name__, "message": str(exc)[:500]}
        await session.flush()
        log.exception("job %s failed for %s", job.key, run_for)
        return run

    run.status = result.status
    run.finished_at = _utcnow()
    run.detail = result.detail
    await session.flush()
    log.info("job %s %s for %s: %s", job.key, run.status, run_for, result.detail)
    return run
