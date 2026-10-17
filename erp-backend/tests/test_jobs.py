"""Phase 8 — scheduled jobs and reminders. (The login throttle's tests are in test_throttle.py.)

The prototype's five cron jobs are seed rows on a screen with nothing behind them, so there
is no ported suite for this phase. These are the assertions that make the jobs trustworthy
rather than decorative: a run happens **once** per period, a crashed run is **retried**, and a
job that finds nothing to do says so instead of reporting success.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.masters.models import Role
from app.jobs import definitions
from app.jobs.models import JobRun, JobStatus
from app.jobs.runner import REGISTRY, Job, JobResult, run_job

pytestmark = pytest.mark.phase8

D = Decimal
DEMO_TODAY = date(2026, 7, 26)


# ---------------------------------------------------------------------------
# The registry
# ---------------------------------------------------------------------------


async def test_all_five_prototype_jobs_and_the_file_sweep_are_registered(
    client: AsyncClient, api: str
) -> None:
    """The Cron Jobs screen shows the prototype's five rows; the API returns those and the sweep."""
    jobs = (await client.get(f"{api}/jobs")).json()

    assert {j["name"] for j in jobs} == {
        "Daily birthday & milestone scan",
        "Overdue invoice sweep (AR)",
        "Weekly LTV recompute",
        "In-transit asset return check",
        "Month-end depreciation run",
        "Orphaned file sweep",
    }
    assert all(j["last_run"] is None for j in jobs), "nothing has run yet, and it says so"


async def test_an_unknown_job_is_a_404_not_an_empty_list(client: AsyncClient, api: str) -> None:
    missing = await client.get(f"{api}/jobs/does.not.exist/runs")
    assert missing.status_code == 404
    assert "Known jobs" in missing.text


async def test_sales_cannot_trigger_a_job(client_for, api: str) -> None:
    sales = await client_for(Role.SALES)
    refused = await sales.post(f"{api}/jobs/crm.ltv_recompute/run", json={})
    assert refused.status_code == 403


# ---------------------------------------------------------------------------
# The guard
# ---------------------------------------------------------------------------


async def _probe_job(calls: list[date], *, status: JobStatus = JobStatus.SUCCEEDED) -> Job:
    async def _fn(session: AsyncSession, on: date) -> JobResult:
        calls.append(on)
        return JobResult(status=status, detail={"calls": len(calls)})

    return Job(
        key="test.probe",
        name="Probe",
        schedule="never",
        cron={"hour": 3},
        period_for=lambda on: on.isoformat(),
        fn=_fn,
    )


async def test_a_period_runs_once(db: AsyncSession) -> None:
    calls: list[date] = []
    job = await _probe_job(calls)

    first = await run_job(db, job, on=DEMO_TODAY)
    second = await run_job(db, job, on=DEMO_TODAY)

    assert len(calls) == 1, "the second call did not do the work again"
    assert first.id == second.id, "and it returned the same run"
    assert second.status is JobStatus.SUCCEEDED


async def test_a_different_period_runs_again(db: AsyncSession) -> None:
    calls: list[date] = []
    job = await _probe_job(calls)

    await run_job(db, job, on=DEMO_TODAY)
    await run_job(db, job, on=DEMO_TODAY + timedelta(days=1))

    assert len(calls) == 2


async def test_a_failed_run_is_recorded_and_then_retried(db: AsyncSession) -> None:
    """The reason failures are recorded at all: so the next attempt knows to try again."""
    attempts: list[date] = []

    async def _flaky(session: AsyncSession, on: date) -> JobResult:
        attempts.append(on)
        if len(attempts) == 1:
            raise RuntimeError("the database went away")
        return JobResult(detail={"attempt": len(attempts)})

    job = Job(
        key="test.flaky",
        name="Flaky",
        schedule="never",
        cron={"hour": 3},
        period_for=lambda on: on.isoformat(),
        fn=_flaky,
    )

    # A failed job is a **result, not an exception**. Re-raising would propagate out to
    # whichever transaction the caller opened — the scheduler's, or the request session,
    # which rolls back on any exception — and take the FAILED row with it. The table whose
    # entire purpose is answering "what happened to month-end?" would then be empty for
    # exactly the runs worth asking about.
    failed = await run_job(db, job, on=DEMO_TODAY)

    assert failed.status is JobStatus.FAILED
    assert failed.detail["error"] == "RuntimeError"
    assert "database went away" in failed.detail["message"]

    stored = (
        await db.execute(select(JobRun).where(JobRun.job_key == "test.flaky"))
    ).scalar_one()
    assert stored.id == failed.id

    retried = await run_job(db, job, on=DEMO_TODAY)

    assert retried.id == failed.id, "the retry reuses the row rather than minting a second"
    assert retried.status is JobStatus.SUCCEEDED
    assert len(attempts) == 2


async def test_a_failing_job_survives_the_request_that_ran_it(
    client: AsyncClient, api: str
) -> None:
    """The bug this guards against: a 500 rolls the request back, record and all.

    Registered temporarily rather than by breaking a real job, so the assertion is about the
    runner's contract rather than about any one job's internals.
    """

    async def _explode(session: AsyncSession, on: date) -> JobResult:
        raise RuntimeError("vendor API timed out")

    REGISTRY["test.explodes"] = Job(
        key="test.explodes",
        name="Explodes",
        schedule="never",
        cron={"hour": 3},
        period_for=lambda on: on.isoformat(),
        fn=_explode,
    )
    try:
        run = await client.post(f"{api}/jobs/test.explodes/run", json={})

        assert run.status_code == 200, "a failed job is an answer, not a server error"
        assert run.json()["status"] == "failed"
        assert "vendor API timed out" in run.json()["detail"]["message"]

        history = (await client.get(f"{api}/jobs/test.explodes/runs")).json()
        assert len(history) == 1, "and the record outlived the request"
        assert history[0]["status"] == "failed"
    finally:
        REGISTRY.pop("test.explodes", None)


async def test_a_run_still_in_flight_is_refused(db: AsyncSession) -> None:
    calls: list[date] = []
    job = await _probe_job(calls)
    db.add(
        JobRun(
            job_key=job.key,
            run_for=DEMO_TODAY.isoformat(),
            status=JobStatus.RUNNING,
            started_at=datetime.now(UTC),
            detail={},
        )
    )
    await db.flush()

    from app.core.errors import Conflict

    with pytest.raises(Conflict):
        await run_job(db, job, on=DEMO_TODAY)
    assert calls == [], "and it did not run the work alongside the other one"


async def test_a_crashed_run_is_reclaimed_once_its_lease_expires(db: AsyncSession) -> None:
    """A process that dies mid-run leaves a `running` row nobody will ever finish.

    Without the lease that row would block the job forever, which is worse than the crash.
    """
    calls: list[date] = []
    job = await _probe_job(calls)
    db.add(
        JobRun(
            job_key=job.key,
            run_for=DEMO_TODAY.isoformat(),
            status=JobStatus.RUNNING,
            started_at=datetime.now(UTC) - timedelta(hours=4),
            detail={},
        )
    )
    await db.flush()

    run = await run_job(db, job, on=DEMO_TODAY)

    assert run.status is JobStatus.SUCCEEDED
    assert calls == [DEMO_TODAY]


async def test_skipped_is_distinct_from_succeeded(db: AsyncSession) -> None:
    """An operator must be able to tell "nothing was due" from "posted the backlog"."""
    calls: list[date] = []
    job = await _probe_job(calls, status=JobStatus.SKIPPED)

    run = await run_job(db, job, on=DEMO_TODAY)

    assert run.status is JobStatus.SKIPPED
    # And a skip still counts as done — it is not retried tomorrow.
    await run_job(db, job, on=DEMO_TODAY)
    assert len(calls) == 1


# ---------------------------------------------------------------------------
# The jobs themselves
# ---------------------------------------------------------------------------


async def _fund(client: AsyncClient, api: str) -> None:
    posted = await client.post(
        f"{api}/journal-entries",
        json={
            "entry_date": "2025-12-01",
            "memo": "Opening capital",
            "source": {"kind": "opening", "ref": "FY2026"},
            "lines": [
                {"account": "1101", "debit": "900000000"},
                {"account": "3102", "credit": "900000000"},
            ],
        },
    )
    assert posted.status_code == 201, posted.text


async def test_month_end_depreciation_posts_the_backlog(client: AsyncClient, api: str) -> None:
    await _fund(client, api)
    await client.post(
        f"{api}/fixed-assets",
        json={
            "name": "VIP Sofa",
            "acquired_on": "2026-01-15",
            "cost": "120000000",
            "useful_life_months": 36,
        },
    )

    run = await client.post(f"{api}/jobs/depreciation.month_end/run", json={})

    assert run.status_code == 200, run.text
    assert run.json()["status"] == "succeeded"
    assert run.json()["run_for"] == "2026-07", "keyed on the month it covers"
    assert len(run.json()["detail"]["periods"]) > 1, "the whole backlog, not just this month"

    backlog = (await client.get(f"{api}/depreciation/backlog")).json()
    assert backlog["periods"] == []


async def test_month_end_with_nothing_due_is_skipped_not_succeeded(
    client: AsyncClient, api: str
) -> None:
    run = await client.post(f"{api}/jobs/depreciation.month_end/run", json={})

    assert run.json()["status"] == "skipped"
    assert run.json()["detail"]["reason"] == "no depreciation was due"


async def test_running_month_end_twice_posts_once(client: AsyncClient, api: str) -> None:
    await _fund(client, api)
    await client.post(
        f"{api}/fixed-assets",
        json={
            "name": "VIP Sofa",
            "acquired_on": "2026-01-15",
            "cost": "120000000",
            "useful_life_months": 36,
        },
    )

    first = await client.post(f"{api}/jobs/depreciation.month_end/run", json={})
    accumulated = (await client.get(f"{api}/fixed-assets/register")).json()["accumulated"]

    second = await client.post(f"{api}/jobs/depreciation.month_end/run", json={})

    assert second.json()["id"] == first.json()["id"]
    assert (await client.get(f"{api}/fixed-assets/register")).json()[
        "accumulated"
    ] == accumulated


async def test_the_ltv_job_reports_that_it_has_nothing_to_recompute(
    client: AsyncClient, api: str
) -> None:
    """Lifetime value is derived on read, so a weekly recompute would write nothing.

    The job stays registered so the screen still shows five rows and the reason is visible,
    rather than the row silently disappearing.
    """
    run = await client.post(f"{api}/jobs/crm.ltv_recompute/run", json={})

    assert run.json()["status"] == "skipped"
    assert "derived from the ledger on read" in run.json()["detail"]["reason"]
    assert run.json()["run_for"].startswith("2026-W"), "keyed by ISO week"


async def test_the_milestone_scan_raises_a_reminder_for_a_birthday_today(
    client: AsyncClient, api: str, db: AsyncSession
) -> None:
    created = await client.post(
        f"{api}/clients",
        json={"name": "Anindita W.", "contact": "Anindita", "birthday": "26 Jul"},
    )
    assert created.status_code == 201, created.text

    run = await client.post(f"{api}/jobs/crm.milestone_scan/run", json={})
    assert run.json()["status"] == "succeeded", run.text
    assert run.json()["detail"]["reminders_raised"] == 1

    reminders = (await client.get(f"{api}/reminders")).json()
    assert len(reminders) == 1
    assert reminders[0]["kind"] == "birthday"
    assert "Anindita W." in reminders[0]["subject"]


async def test_a_birthday_on_another_day_raises_nothing(
    client: AsyncClient, api: str
) -> None:
    await client.post(f"{api}/clients", json={"name": "Budi S.", "birthday": "03 Mar"})

    run = await client.post(f"{api}/jobs/crm.milestone_scan/run", json={})

    assert run.json()["status"] == "skipped"
    assert (await client.get(f"{api}/reminders")).json() == []


async def test_unreadable_birthdays_are_counted_not_guessed(
    client: AsyncClient, api: str
) -> None:
    """Q10 is parked, so the scan reports what it cannot read instead of inventing a date."""
    await client.post(f"{api}/clients", json={"name": "Unknown", "birthday": "sometime"})
    await client.post(f"{api}/clients", json={"name": "Blank", "birthday": "—"})

    run = await client.post(f"{api}/jobs/crm.milestone_scan/run", json={})

    detail = run.json()["detail"]
    # 'sometime' is unreadable; '—' is simply not recorded, which is a different problem.
    # Both clients also have no anniversary, which is likewise not-recorded rather than bad.
    assert detail["unreadable_dates"] == 1


def test_free_text_dates_are_matched_loosely() -> None:
    on = date(2026, 7, 26)
    assert definitions._matches_today("26 Jul", on)
    assert definitions._matches_today("26 July 1988", on)
    assert definitions._matches_today(" 26 jul ", on)
    assert not definitions._matches_today("25 Jul", on)
    assert not definitions._matches_today("26 Aug", on)
    assert not definitions._matches_today("—", on)
    assert not definitions._matches_today(None, on)
    assert not definitions._matches_today("sometime", on)


async def _overdue_invoice(client: AsyncClient, api: str, db: AsyncSession) -> dict:
    """An issued invoice whose due date has passed.

    Built through the real AR flow — quotation, acceptance, down payment — because that is
    the only way an invoice comes into existence. Only the due date is reached in and moved
    into the past, which is the one thing a test cannot arrange by waiting.
    """
    quote = await client.post(
        f"{api}/quotations",
        json={
            "client_id": (
                await client.post(f"{api}/clients", json={"name": "Aurora Bank"})
            ).json()["id"],
            "event_type": "Investor Summit",
            "event_date": "2026-11-18",
            "lines": [{"label": "Venue & Staging", "amount": "480000000"}],
            "preset": "50",
        },
    )
    assert quote.status_code == 201, quote.text
    await client.post(f"{api}/quotations/{quote.json()['id']}/send")
    await client.post(f"{api}/quotations/{quote.json()['id']}/accept")
    confirmed = await client.post(
        f"{api}/quotations/{quote.json()['id']}/confirm-down-payment", json={}
    )
    assert confirmed.status_code == 201, confirmed.text

    scheduled = [
        inv
        for inv in (await client.get(f"{api}/invoices")).json()
        if inv["status"] == "Scheduled"
    ]
    issued = await client.post(f"{api}/invoices/{scheduled[0]['id']}/issue")
    assert issued.status_code == 200, issued.text

    from app.domain.ar.models import Invoice

    row = await db.get(Invoice, issued.json()["id"])
    assert row is not None
    row.due_date = date(2026, 6, 1)
    await db.flush()
    return issued.json()


async def test_the_overdue_sweep_raises_reminders_but_posts_nothing(
    client: AsyncClient, api: str, db: AsyncSession
) -> None:
    """Overdue is `due_date < today` computed on read, not a status somebody sets."""
    invoice = await _overdue_invoice(client, api, db)
    before = (await client.get(f"{api}/journal-entries")).json()

    run = await client.post(f"{api}/jobs/ar.overdue_sweep/run", json={})

    assert run.json()["status"] == "succeeded", run.text
    assert run.json()["detail"]["overdue"] == 1
    after = (await client.get(f"{api}/journal-entries")).json()
    assert len(after) == len(before), "the sweep posted nothing"

    reminders = (await client.get(f"{api}/reminders")).json()
    assert reminders[0]["kind"] == "overdue_invoice"
    assert reminders[0]["ref"] == invoice["invoice_no"]
    assert "55 day(s) overdue" in reminders[0]["subject"]


async def test_a_scheduled_stage_is_never_overdue(client: AsyncClient, api: str) -> None:
    """Ruling 3, again: a billing plan is not a debt, so a plan cannot be late."""
    quote = await client.post(
        f"{api}/quotations",
        json={
            "client_id": (
                await client.post(f"{api}/clients", json={"name": "Aurora Bank"})
            ).json()["id"],
            "event_type": "Investor Summit",
            "event_date": "2026-01-10",
            "lines": [{"label": "Venue & Staging", "amount": "480000000"}],
            "preset": "50",
        },
    )
    await client.post(f"{api}/quotations/{quote.json()['id']}/send")
    await client.post(f"{api}/quotations/{quote.json()['id']}/accept")
    await client.post(f"{api}/quotations/{quote.json()['id']}/confirm-down-payment", json={})

    scheduled = [
        inv
        for inv in (await client.get(f"{api}/invoices")).json()
        if inv["status"] == "Scheduled"
    ]
    assert scheduled, "there is a scheduled stage with a due date in the past"

    run = await client.post(f"{api}/jobs/ar.overdue_sweep/run", json={})

    assert run.json()["status"] == "skipped"
    assert (await client.get(f"{api}/reminders")).json() == []


async def test_the_in_transit_check_flags_kit_that_has_not_come_back(
    client: AsyncClient, api: str, make_project
) -> None:
    project = await make_project()
    item = await client.post(
        f"{api}/inventory",
        json={
            "item": "LED Wall",
            "type": "Fixed Asset",
            "qty": "4",
            "unit": "panel",
            "unit_value": "8000000",
        },
    )
    assert item.status_code == 201, item.text

    out = await client.post(
        f"{api}/inventory/{item.json()['id']}/check-out",
        json={"project_id": project, "event_date": "2026-07-10"},
    )
    assert out.status_code == 200, out.text
    assert out.json()["item"]["status"] == "in_transit"
    assert out.json()["entry_id"] is None, "moving kit to a venue is not a transaction"

    run = await client.post(f"{api}/jobs/warehouse.in_transit_check/run", json={})

    assert run.json()["detail"]["outstanding"] == 1
    reminders = (await client.get(f"{api}/reminders")).json()
    assert reminders[0]["kind"] == "asset_return"
    assert "16 day(s) past its event" in reminders[0]["subject"]


async def test_kit_returned_stops_being_flagged(
    client: AsyncClient, api: str, make_project
) -> None:
    project = await make_project()
    item = await client.post(
        f"{api}/inventory",
        json={"item": "LED Wall", "type": "Fixed Asset", "qty": "4", "unit_value": "8000000"},
    )
    await client.post(
        f"{api}/inventory/{item.json()['id']}/check-out",
        json={"project_id": project, "event_date": "2026-07-10"},
    )
    await client.post(
        f"{api}/inventory/{item.json()['id']}/return", json={"condition": "good"}
    )

    run = await client.post(f"{api}/jobs/warehouse.in_transit_check/run", json={})

    assert run.json()["status"] == "skipped"


async def test_a_consumable_cannot_be_checked_out(
    client: AsyncClient, api: str, make_project
) -> None:
    project = await make_project()
    item = await client.post(
        f"{api}/inventory",
        json={"item": "Gaffer tape", "type": "Consumable", "qty": "100", "unit_value": "50000"},
    )

    refused = await client.post(
        f"{api}/inventory/{item.json()['id']}/check-out",
        json={"project_id": project, "event_date": "2026-07-10"},
    )

    assert refused.status_code == 409
    assert "released, not checked out" in refused.text


async def test_the_same_reminder_is_not_raised_twice_in_a_day(
    client: AsyncClient, api: str, db: AsyncSession
) -> None:
    """Re-raising every morning until somebody acts would bury the new ones."""
    await client.post(f"{api}/clients", json={"name": "Anindita W.", "birthday": "26 Jul"})
    await client.post(f"{api}/jobs/crm.milestone_scan/run", json={})

    # Force a second pass over the same day by clearing the run guard, so it is the
    # reminder's own constraint being tested rather than the job runner's.
    await db.execute(
        JobRun.__table__.delete().where(JobRun.job_key == "crm.milestone_scan")
    )
    second = await client.post(f"{api}/jobs/crm.milestone_scan/run", json={})

    assert second.json()["detail"]["reminders_raised"] == 0
    assert len((await client.get(f"{api}/reminders")).json()) == 1


async def test_a_reminder_can_be_resolved(client: AsyncClient, api: str) -> None:
    await client.post(f"{api}/clients", json={"name": "Anindita W.", "birthday": "26 Jul"})
    await client.post(f"{api}/jobs/crm.milestone_scan/run", json={})
    reminder = (await client.get(f"{api}/reminders")).json()[0]

    done = await client.post(f"{api}/reminders/{reminder['id']}/resolve", json={})

    assert done.json()["status"] == "done"
    assert (await client.get(f"{api}/reminders")).json() == [], "gone from the open list"
    assert len(
        (await client.get(f"{api}/reminders", params={"reminder_status": "done"})).json()
    ) == 1, "but not deleted"


def test_every_registered_job_has_a_distinct_key_and_a_schedule() -> None:
    assert len(REGISTRY) == 6
    assert all(job.schedule and job.description for job in REGISTRY.values())
    assert len({job.name for job in REGISTRY.values()}) == 6
