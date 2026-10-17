"""APScheduler wiring.

The scheduler is deliberately thin: it decides *when*, and :func:`app.jobs.runner.run_job`
decides *whether*. Everything that makes a run safe — the claim, the idempotency, the retry
of a crashed attempt — lives in the runner, so a job triggered by a person through the API
and the same job fired by cron take exactly the same path.

**Off unless switched on.** ``SCHEDULER_ENABLED`` defaults to false so that tests, Alembic
runs and a developer's local server do not quietly post month-end depreciation to whatever
database they happen to be pointing at.

**One process only.** In-process APScheduler across two uvicorn workers means two schedulers,
both firing. Today that is caught by the `job_runs` claim — the second one loses the race and
returns the first one's row — but that is a safety net, not a design. If this ever runs
multiple workers, the scheduler needs to move behind a leader election or out to its own
process.
"""

from __future__ import annotations

import logging

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

from app.core.clock import SystemClock
from app.core.config import get_settings
from app.db.session import get_sessionmaker
from app.jobs import definitions  # noqa: F401  — importing registers the five jobs
from app.jobs.runner import REGISTRY, Job, run_job

log = logging.getLogger("app.jobs.scheduler")


async def _fire(job: Job) -> None:
    """Run one job in its own transaction, and never let it kill the scheduler.

    A job that raises does not reach here: :func:`run_job` records the failure and returns it,
    so the transaction below **commits the FAILED row** rather than rolling it back. That is
    the whole point of the table — the runs worth asking about later are the ones that went
    wrong.

    The catch that remains is for infrastructure: a database that has gone away takes the
    commit with it, and there is nothing useful to record. Swallowing it keeps tomorrow's tick
    alive, which is worth more than a loud death.
    """
    clock = SystemClock()
    try:
        async with get_sessionmaker()() as session, session.begin():
            run = await run_job(session, job, on=clock.today())
        log.info("scheduled job %s finished %s for %s", job.key, run.status, run.run_for)
    except Exception:
        log.exception("scheduled job %s could not run", job.key)


def build_scheduler() -> AsyncIOScheduler:
    settings = get_settings()
    scheduler = AsyncIOScheduler(timezone=settings.timezone)

    for job in REGISTRY.values():
        scheduler.add_job(
            _fire,
            trigger=CronTrigger(timezone=settings.timezone, **job.cron),
            args=[job],
            id=job.key,
            name=job.name,
            # A tick missed because the process was down still runs, within the hour. The
            # jobs are idempotent per period, so a late run is safe and a skipped one is not.
            misfire_grace_time=3600,
            # If two ticks somehow queue up, run one. The claim would refuse the second
            # anyway; this avoids the pointless attempt.
            coalesce=True,
            max_instances=1,
        )

    return scheduler
