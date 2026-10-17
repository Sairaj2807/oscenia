"""The client's own rating link (P6): who can open it, what it shows, and what it can change."""

from __future__ import annotations

from datetime import timedelta
from types import SimpleNamespace
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from test_incentives import _crew, _fund

from app.core.throttle import Throttle
from app.domain.ar.models import Stage
from app.domain.audit.models import AuditEvent
from app.domain.masters.models import Role
from app.domain.payroll import survey, survey_router

HEADER = "X-Survey-Token"


def stranger(staff: AsyncClient) -> AsyncClient:
    """A client with no credentials, on the same app and database as ``staff``."""
    return AsyncClient(transport=staff._transport, base_url="http://test")  # noqa: SLF001


@pytest.fixture(autouse=True)
def roomy_throttle(monkeypatch: pytest.MonkeyPatch) -> None:
    """The frozen clock never ages a window out, so give every test room (one makes it tiny)."""
    monkeypatch.setattr(
        survey_router,
        "survey_throttle",
        Throttle("t-survey", limit=10_000, window_seconds=60, block_seconds=1),
    )


async def rated_project(client: AsyncClient, api: str, make_project, **kw: Any) -> dict[str, Any]:
    """A project at Post-Event Feedback, and the staff-minted link for it."""
    pid = await make_project(stage=kw.pop("stage", Stage.POST_EVENT_FEEDBACK), **kw)
    link = await client.get(f"{api}/projects/{pid}/survey-link")
    assert link.status_code == 200, link.text
    return {"id": pid, **link.json()}


def at(api: str, project_no: str) -> str:
    return f"{api}/public/survey/{project_no}"


async def open_page(client: AsyncClient, api: str, p: dict[str, Any], token: str | None = None):
    token = p["token"] if token is None else token
    return await stranger(client).get(at(api, p["project_no"]), headers={HEADER: token})


async def rate(
    client: AsyncClient, api: str, p: dict[str, Any], score: Any, token: str | None = None
):
    token = p["token"] if token is None else token
    return await stranger(client).post(
        at(api, p["project_no"]), json={"score": score}, headers={HEADER: token}
    )


# ---------------------------------------------------------------------------
# The link and the page
# ---------------------------------------------------------------------------


async def test_staff_get_a_link_and_the_client_sees_only_the_event(
    client: AsyncClient, api: str, make_project
) -> None:
    p = await rated_project(client, api, make_project, name="Aurora Launch")
    assert p["project_no"] and p["token"] and p["expires_at"]
    page = await open_page(client, api, p)
    assert page.status_code == 200, page.text
    body = page.json()
    assert body["name"] == "Aurora Launch" and body["rating"] is None and body["locked"] is False
    assert set(body) == {"project_no", "name", "event_date", "rating", "locked"}, (
        "no client, money, crew or vendors"
    )
    assert page.headers["cache-control"] == "no-store"


async def test_the_same_token_comes_back_until_it_is_regenerated(
    client: AsyncClient, api: str, make_project
) -> None:
    p = await rated_project(client, api, make_project)
    again = (await client.get(f"{api}/projects/{p['id']}/survey-link")).json()
    assert again["token"] == p["token"], "staff can copy it again and again"
    fresh = (await client.post(f"{api}/projects/{p['id']}/survey-link/regenerate", json={})).json()
    assert fresh["token"] != p["token"]
    assert (await open_page(client, api, p)).status_code == 404, "the old copy is revoked"
    assert (await open_page(client, api, p, fresh["token"])).status_code == 200


async def test_the_client_rates_and_the_crew_pool_follows(
    client: AsyncClient, api: str, make_project
) -> None:
    p = await rated_project(client, api, make_project)
    await _crew(client, api, "Bagus", "5000000", "8")
    r = await rate(client, api, p, 9)
    assert r.status_code == 200, r.text
    assert r.json()["rating"] == 9.0
    pool = (await client.get(f"{api}/projects/{p['id']}/incentives")).json()
    assert pool["event_score"] == "9.0" and pool["pool"] == "4500000.00", "5,000,000 x 9/10"


async def test_rating_again_replaces_it_and_it_is_recorded_as_the_clients(
    client: AsyncClient, api: str, make_project, db: AsyncSession
) -> None:
    from app.domain.assets.models import ClientFeedback

    p = await rated_project(client, api, make_project)
    await rate(client, api, p, 4)
    changed = await rate(client, api, p, 8)
    assert changed.json()["rating"] == 8.0
    rows = (await db.execute(select(ClientFeedback))).scalars().all()
    assert len(rows) == 1 and rows[0].source == "client" and rows[0].submitted_at is not None


# ---------------------------------------------------------------------------
# One refusal for everything that is not allowed
# ---------------------------------------------------------------------------


async def test_every_kind_of_bad_link_is_the_same_404(
    client: AsyncClient, api: str, make_project, frozen_clock: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    p = await rated_project(client, api, make_project)
    other = await rated_project(client, api, make_project, name="Another event")
    expired = await rated_project(client, api, make_project, name="Late")
    frozen_clock.advance(timedelta(days=31))  # past the 30 days the link lasts

    tokens = {
        "forged": p["token"][:-4] + "AAAA",
        "garbage": "not-a-token",
        "empty": "",
        "truncated": p["token"][:20],
        "another project's": other["token"],
        "expired": expired["token"],
        "no expiry": f"{p['project_no']}.1.{'A' * 22}",
    }
    answers = {}
    for label, token in tokens.items():
        r = await stranger(client).get(at(api, p["project_no"]), headers={HEADER: token})
        answers[label] = (r.status_code, r.json()["detail"])
    assert set(answers.values()) == {(404, survey.NOT_AVAILABLE)}, answers

    missing = await stranger(client).get(at(api, p["project_no"]))
    assert (missing.status_code, missing.json()["detail"]) == (404, survey.NOT_AVAILABLE)
    nobody = await stranger(client).get(at(api, "EVT-9999-999"), headers={HEADER: p["token"]})
    assert (nobody.status_code, nobody.json()["detail"]) == (404, survey.NOT_AVAILABLE)
    assert (
        await stranger(client).get(at(api, "bad number!"), headers={HEADER: p["token"]})
    ).status_code == 404


async def test_the_token_is_not_accepted_in_the_address(
    client: AsyncClient, api: str, make_project
) -> None:
    p = await rated_project(client, api, make_project)
    r = await stranger(client).get(at(api, p["project_no"]), params={"token": p["token"]})
    assert r.status_code == 404


async def test_a_project_that_is_not_rateable_is_not_available(
    client: AsyncClient, api: str, make_project
) -> None:
    p = await rated_project(client, api, make_project)
    # staff cannot even mint a link for one that is too early
    early = await make_project(stage=Stage.EXECUTION_EVENT)
    refused = await client.get(f"{api}/projects/{early}/survey-link")
    assert refused.status_code == 409

    # a link sent before the project was cancelled stops working
    cancel = await client.post(
        f"{api}/projects/{p['id']}/cancel", json={"reason": "client withdrew"}
    )
    assert cancel.status_code in (200, 201), cancel.text
    assert (await open_page(client, api, p)).status_code == 404
    assert (await rate(client, api, p, 9)).status_code == 404


async def test_a_rating_must_be_a_whole_number_of_stars_from_one_to_ten(
    client: AsyncClient, api: str, make_project
) -> None:
    p = await rated_project(client, api, make_project)
    for bad in (0, 11, -1, 7.5, "x", None):
        assert (await rate(client, api, p, bad)).status_code == 422, bad
    assert (await open_page(client, api, p)).json()["rating"] is None
    for good in (1, 10):
        assert (await rate(client, api, p, good)).status_code == 200


# ---------------------------------------------------------------------------
# After the crew is paid
# ---------------------------------------------------------------------------


async def test_once_the_pool_is_paid_the_rating_is_locked(
    client: AsyncClient, api: str, make_project
) -> None:
    await _fund(client, api)
    p = await rated_project(client, api, make_project)
    await _crew(client, api, "Bagus", "5000000", "8")
    assert (await rate(client, api, p, 9)).status_code == 200
    paid = await client.post(f"{api}/incentives/disburse", json={"project_id": p["id"]})
    assert paid.status_code == 201, paid.text

    page = await open_page(client, api, p)
    assert (
        page.status_code == 200 and page.json()["locked"] is True and page.json()["rating"] == 9.0
    )
    refused = await rate(client, api, p, 2)
    assert refused.status_code == 409
    assert "can no longer change" in refused.json()["detail"]
    assert (await open_page(client, api, p)).json()["rating"] == 9.0


# ---------------------------------------------------------------------------
# Who may mint the link, the limits, the record
# ---------------------------------------------------------------------------


async def test_only_those_who_manage_the_workspace_can_get_or_regenerate_a_link(
    client: AsyncClient, client_for: Any, api: str, make_project
) -> None:
    pid = await make_project(stage=Stage.POST_EVENT_FEEDBACK)
    for role in (Role.WAREHOUSE, Role.SALES, Role.FINANCE):
        who = await client_for(role)
        assert (await who.get(f"{api}/projects/{pid}/survey-link")).status_code == 403, role
        assert (
            await who.post(f"{api}/projects/{pid}/survey-link/regenerate", json={})
        ).status_code == 403, role
    pm = await client_for(Role.PM)
    assert (await pm.get(f"{api}/projects/{pid}/survey-link")).status_code == 200


async def test_guessing_is_rate_limited_and_a_forged_try_counts(
    client: AsyncClient, api: str, make_project, monkeypatch: pytest.MonkeyPatch
) -> None:
    p = await rated_project(client, api, make_project)
    monkeypatch.setattr(
        survey_router,
        "survey_throttle",
        Throttle("t-tight", limit=3, window_seconds=60, block_seconds=300),
    )
    codes = [(await open_page(client, api, p, f"forged.1.{n}")).status_code for n in range(5)]
    assert codes[:3] == [404, 404, 404] and 429 in codes[3:]
    assert (await open_page(client, api, p)).status_code == 429, (
        "even the right link waits its turn"
    )


async def test_a_rating_is_audited_without_the_token(
    client: AsyncClient, api: str, make_project, db: AsyncSession
) -> None:
    p = await rated_project(client, api, make_project)
    await rate(client, api, p, 6)
    await rate(client, api, p, 9)
    rows = (
        (await db.execute(select(AuditEvent).where(AuditEvent.action == "survey.rated")))
        .scalars()
        .all()
    )
    assert len(rows) == 2
    assert {r.actor_label for r in rows} == {f"client-survey:{p['project_no']}"}
    # (the two rows share a transaction time in a test, so they are matched by content, not order)
    assert {(str(r.before), str(r.after)) for r in rows} == {
        ("None", "{'score': '6'}"),
        ("{'score': '6.0'}", "{'score': '9'}"),
    }
    assert all(p["token"] not in str(r.__dict__) for r in rows)
    regen = await client.post(f"{api}/projects/{p['id']}/survey-link/regenerate", json={})
    assert regen.status_code == 200
    assert (
        await db.execute(
            select(func.count())
            .select_from(AuditEvent)
            .where(AuditEvent.action == "survey.link_regenerated")
        )
    ).scalar_one() == 1


async def test_the_link_lifetime_is_a_setting(
    client: AsyncClient, api: str, make_project, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(survey, "get_settings", lambda: SimpleNamespace(survey_link_days=0))
    p = await rated_project(client, api, make_project)
    assert (await open_page(client, api, p)).status_code == 404, "a link with no days left is dead"
