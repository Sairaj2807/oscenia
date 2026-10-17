"""Phase 2 — authentication and role-based access control.

Ports ``verify-flows.mjs`` §17 (action-level permissions) and §37 (PM access matches the
deck), which encode the client's actual access policy:

    A Project Manager may **request**, never approve or pay. Approving cash and posting
    journals are restricted to Finance.

Everything is asserted over real HTTP, because that is where authorisation has to hold. The
prototype's ``canDo`` checks decide whether to render a button; they are a courtesy, not a
control.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from httpx import AsyncClient

from app.core.rbac import (
    ACTIONS,
    ROLE_ACTIONS,
    ROLE_MODULES,
    can_do,
    denial_reason,
    roles_permitted,
)
from app.domain.masters.models import Role
from app.seed.chart import DEMO_PASSWORD

pytestmark = pytest.mark.phase2

BALANCED = [
    {"account": "1101", "debit": "10"},
    {"account": "4102", "credit": "10"},
]
ENTRY = {"entry_date": "2026-05-10", "memo": "rbac probe", "lines": BALANCED}


# ---------------------------------------------------------------------------
# The matrix itself
# ---------------------------------------------------------------------------


ROLES_JS = Path(__file__).resolve().parents[2] / "erp-frontend" / "src" / "lib" / "roles.js"


def _js_object(name: str) -> str:
    """The body of ``export const NAME = { ... }`` in roles.js."""
    match = re.search(rf"export const {name} = \{{(.*?)\n\}}", ROLES_JS.read_text("utf-8"), re.S)
    assert match, f"{name} not found in roles.js"
    return match.group(1)


def test_the_actions_are_the_prototypes_actions() -> None:
    """``roles.js`` is the client-reviewed policy. A drift here is a policy change, not a
    refactor — so it is checked against the source rather than against a count."""
    js_actions = dict(re.findall(r"^\s*(\w+): '([^']*)',", _js_object("ACTIONS"), re.M))
    assert js_actions == ACTIONS


def test_each_role_may_do_exactly_what_the_prototype_allows() -> None:
    body = _js_object("ROLE_ACTIONS")
    for role in Role:
        entry = re.search(rf"\b{role.value}: (\[.*?\]|'all')", body, re.S)
        assert entry, f"{role} missing from ROLE_ACTIONS"
        js = "all" if entry.group(1) == "'all'" else set(re.findall(r"'(\w+)'", entry.group(1)))
        backend = ROLE_ACTIONS[role]
        assert js == (backend if backend == "all" else set(backend)), role


def test_no_role_sees_a_module_the_prototype_hides_from_it() -> None:
    """The server may lag behind (workspace, chat and gcal come with their backends) but may
    never show a role a module the prototype keeps from it."""
    body = _js_object("ROLE_MODULES")
    for role in Role:
        entry = re.search(rf"\b{role.value}: (\[.*?\]|'all')", body, re.S)
        assert entry, f"{role} missing from ROLE_MODULES"
        backend = ROLE_MODULES[role]
        if entry.group(1) == "'all'":
            continue
        assert backend != "all", role
        assert set(backend) <= set(re.findall(r"'(\w+)'", entry.group(1))), role


@pytest.mark.parametrize("action", ["publish_invitation", "manage_templates"])
def test_only_the_ceo_and_pm_publish_invitations_and_design_templates(action: str) -> None:
    assert set(roles_permitted(action)) == {Role.CEO, Role.PM}


def test_every_role_action_is_a_known_action() -> None:
    for role, allowed in ROLE_ACTIONS.items():
        if allowed == "all":
            continue
        unknown = set(allowed) - set(ACTIONS)
        assert not unknown, f"{role} references unknown action(s) {unknown}"


def test_the_ceo_may_do_everything() -> None:
    assert all(can_do(Role.CEO, action) for action in ACTIONS)


@pytest.mark.parametrize("action", ["post_journal", "approve_cash", "approve_po", "pay_po"])
def test_a_pm_may_not_approve_pay_or_post(action: str) -> None:
    """§37 — the restriction the client's deck is explicit about."""
    assert not can_do(Role.PM, action)
    assert can_do(Role.FINANCE, action) or can_do(Role.CEO, action)


@pytest.mark.parametrize(
    "action", ["request_po", "request_advance", "file_expense", "advance_stage"]
)
def test_a_pm_may_request(action: str) -> None:
    assert can_do(Role.PM, action)


def test_finance_may_post_journals_and_approve_cash() -> None:
    assert can_do(Role.FINANCE, "post_journal")
    assert can_do(Role.FINANCE, "approve_cash")
    assert can_do(Role.FINANCE, "manage_coa")


def test_sales_and_warehouse_stay_out_of_the_ledger() -> None:
    for role in (Role.SALES, Role.WAREHOUSE):
        assert not can_do(role, "post_journal")
        assert not can_do(role, "manage_coa")
        assert not can_do(role, "approve_cash")


def test_denial_names_who_is_permitted_instead_of_just_saying_no() -> None:
    reason = denial_reason(Role.PM, "approve_cash")
    assert reason is not None
    assert "Approve and disburse cash" in reason
    assert "CEO" in reason and "Finance" in reason


def test_denial_is_none_when_permitted() -> None:
    assert denial_reason(Role.FINANCE, "post_journal") is None


def test_roles_permitted_is_consistent_with_can_do() -> None:
    for action in ACTIONS:
        for role in Role:
            assert (role in roles_permitted(action)) == can_do(role, action)


# ---------------------------------------------------------------------------
# Login
# ---------------------------------------------------------------------------


async def test_login_returns_a_token_pair(anon_client: AsyncClient, api: str) -> None:
    response = await anon_client.post(
        f"{api}/auth/login",
        json={"email": "lina@oscenia.co.id", "password": DEMO_PASSWORD},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["token_type"] == "bearer"
    assert body["access_token"] and body["refresh_token"]
    assert body["access_token"] != body["refresh_token"]


@pytest.mark.parametrize(
    ("email", "password"),
    [
        ("lina@oscenia.co.id", "wrong-password"),
        ("nobody@oscenia.co.id", DEMO_PASSWORD),
        ("system@oscenia.co.id", DEMO_PASSWORD),
    ],
    ids=["wrong-password", "unknown-account", "system-account"],
)
async def test_every_login_failure_looks_identical(
    anon_client: AsyncClient, api: str, email: str, password: str
) -> None:
    """Distinguishing them would hand out a free user-enumeration oracle.

    The system account is included deliberately: it exists, but it has no password hash and
    is inactive, so it must be indistinguishable from an account that does not exist.
    """
    response = await anon_client.post(
        f"{api}/auth/login", json={"email": email, "password": password}
    )
    assert response.status_code == 401
    assert response.json()["detail"] == "Those credentials are not valid."


async def test_a_malformed_email_is_rejected_before_it_reaches_the_database(
    anon_client: AsyncClient, api: str
) -> None:
    response = await anon_client.post(
        f"{api}/auth/login", json={"email": "not-an-email", "password": DEMO_PASSWORD}
    )
    assert response.status_code == 422


# ---------------------------------------------------------------------------
# /auth/me
# ---------------------------------------------------------------------------


async def test_me_resolves_the_matrix_server_side(client_for, api: str) -> None:
    """The UI gates on this rather than reimplementing the policy and drifting from it."""
    client = await client_for(Role.PM)
    body = (await client.get(f"{api}/auth/me")).json()

    assert body["role"] == "pm"
    assert body["role_label"] == "Project Manager"
    assert "request_po" in body["actions"]
    assert "post_journal" not in body["actions"]
    assert "warehouse" in body["modules"]
    assert "accounting" not in body["modules"], "a PM sees no company-wide ledger"
    assert {"publish_invitation", "manage_templates"} <= set(body["actions"])
    assert {"events", "templates"} <= set(body["modules"])


async def test_me_for_the_ceo_lists_every_action(client_for, api: str) -> None:
    client = await client_for(Role.CEO)
    body = (await client.get(f"{api}/auth/me")).json()
    assert set(body["actions"]) == set(ACTIONS)


# ---------------------------------------------------------------------------
# Token handling
# ---------------------------------------------------------------------------


async def test_endpoints_refuse_an_anonymous_caller(
    anon_client: AsyncClient, api: str
) -> None:
    for method, path in [
        ("get", f"{api}/accounts"),
        ("get", f"{api}/journal-entries"),
        ("get", f"{api}/reports/trial-balance"),
        ("get", f"{api}/auth/me"),
    ]:
        response = await getattr(anon_client, method)(path)
        assert response.status_code == 401, path

    posted = await anon_client.post(f"{api}/journal-entries", json=ENTRY)
    assert posted.status_code == 401


async def test_a_garbage_token_is_refused(anon_client: AsyncClient, api: str) -> None:
    anon_client.headers["Authorization"] = "Bearer not.a.jwt"
    response = await anon_client.get(f"{api}/auth/me")
    assert response.status_code == 401


async def test_a_refresh_token_is_not_accepted_as_a_bearer_credential(
    anon_client: AsyncClient, api: str
) -> None:
    """Otherwise a refresh token would grant access for its whole 14-day lifetime."""
    tokens = (
        await anon_client.post(
            f"{api}/auth/login",
            json={"email": "lina@oscenia.co.id", "password": DEMO_PASSWORD},
        )
    ).json()

    anon_client.headers["Authorization"] = f"Bearer {tokens['refresh_token']}"
    response = await anon_client.get(f"{api}/auth/me")
    assert response.status_code == 401
    assert "access token" in response.json()["detail"]


async def test_refresh_rotates_and_invalidates_the_old_token(
    anon_client: AsyncClient, api: str
) -> None:
    """A stolen refresh token is usable at most once."""
    first = (
        await anon_client.post(
            f"{api}/auth/login",
            json={"email": "lina@oscenia.co.id", "password": DEMO_PASSWORD},
        )
    ).json()

    second = await anon_client.post(
        f"{api}/auth/refresh", json={"refresh_token": first["refresh_token"]}
    )
    assert second.status_code == 200
    assert second.json()["refresh_token"] != first["refresh_token"]

    replay = await anon_client.post(
        f"{api}/auth/refresh", json={"refresh_token": first["refresh_token"]}
    )
    assert replay.status_code == 401, "the old token must not work twice"


async def test_logout_revokes_the_refresh_token(
    anon_client: AsyncClient, api: str
) -> None:
    tokens = (
        await anon_client.post(
            f"{api}/auth/login",
            json={"email": "lina@oscenia.co.id", "password": DEMO_PASSWORD},
        )
    ).json()

    assert (
        await anon_client.post(
            f"{api}/auth/logout", json={"refresh_token": tokens["refresh_token"]}
        )
    ).status_code == 204

    refused = await anon_client.post(
        f"{api}/auth/refresh", json={"refresh_token": tokens["refresh_token"]}
    )
    assert refused.status_code == 401


async def test_logout_everywhere_revokes_every_session_of_that_person_only(
    anon_client: AsyncClient, api: str
) -> None:
    async def login(email: str) -> dict[str, str]:
        r = await anon_client.post(
            f"{api}/auth/login", json={"email": email, "password": DEMO_PASSWORD}
        )
        return r.json()

    laptop = await login("lina@oscenia.co.id")
    phone = await login("lina@oscenia.co.id")
    someone_else = await login("rahmat@oscenia.co.id")

    # Not signed in: refused.
    assert (await anon_client.post(f"{api}/auth/logout-everywhere")).status_code == 401

    done = await anon_client.post(
        f"{api}/auth/logout-everywhere",
        headers={"Authorization": f"Bearer {laptop['access_token']}"},
    )
    assert done.status_code == 204

    for tokens in (laptop, phone):
        r = await anon_client.post(
            f"{api}/auth/refresh", json={"refresh_token": tokens["refresh_token"]}
        )
        assert r.status_code == 401, "every device's refresh token is revoked"
    other = await anon_client.post(
        f"{api}/auth/refresh", json={"refresh_token": someone_else["refresh_token"]}
    )
    assert other.status_code == 200, "another person's session is untouched"


# ---------------------------------------------------------------------------
# §17 / §37 — enforcement at the HTTP boundary
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("role", [Role.PM, Role.SALES, Role.WAREHOUSE])
async def test_only_finance_and_the_ceo_may_post_a_journal(
    client_for, api: str, role: Role
) -> None:
    client = await client_for(role)
    response = await client.post(f"{api}/journal-entries", json=ENTRY)

    assert response.status_code == 403, f"{role} must not post journals"
    body = response.json()
    assert body["action"] == "post_journal"
    assert "CEO" in body["permitted"] and "Finance" in body["permitted"]
    assert "restricted to" in body["detail"]


@pytest.mark.parametrize("role", [Role.CEO, Role.FINANCE])
async def test_finance_and_the_ceo_may_post(client_for, api: str, role: Role) -> None:
    client = await client_for(role)
    response = await client.post(f"{api}/journal-entries", json=ENTRY)
    assert response.status_code == 201, response.text


@pytest.mark.parametrize("role", [Role.PM, Role.SALES, Role.WAREHOUSE])
async def test_only_finance_and_the_ceo_may_change_the_chart(
    client_for, api: str, role: Role
) -> None:
    client = await client_for(role)
    response = await client.post(
        f"{api}/accounts",
        json={"code": "1104", "name": "Sneaky account", "type": "asset"},
    )
    assert response.status_code == 403
    assert response.json()["action"] == "manage_coa"


async def test_a_pm_may_read_but_not_write(client_for, api: str) -> None:
    """The distinction the deck draws: a PM oversees the budget, and requests only."""
    client = await client_for(Role.PM)

    assert (await client.get(f"{api}/accounts")).status_code == 200
    assert (await client.get(f"{api}/reports/trial-balance")).status_code == 200

    assert (await client.post(f"{api}/journal-entries", json=ENTRY)).status_code == 403
    assert (
        await client.post(f"{api}/periods/2026/3/close")
    ).status_code == 403


@pytest.mark.parametrize("role", [Role.PM, Role.SALES, Role.WAREHOUSE])
async def test_reversal_and_adjustment_are_gated_too(
    client_for, api: str, role: Role
) -> None:
    """Reversing is posting. Gating the create route alone would leave a way around it."""
    ceo = await client_for(Role.CEO)
    entry = (await ceo.post(f"{api}/journal-entries", json=ENTRY)).json()

    client = await client_for(role)
    assert (
        await client.post(f"{api}/journal-entries/{entry['id']}/reverse")
    ).status_code == 403
    assert (
        await client.post(
            f"{api}/journal-entries/{entry['id']}/adjust", json={"lines": BALANCED}
        )
    ).status_code == 403


async def test_the_posting_user_comes_from_the_token_not_the_request_body(
    client_for, api: str, db
) -> None:
    """Otherwise any caller could claim to be anyone and the audit trail would be fiction.

    The request below tries to attribute the entry to a nil UUID. It must be ignored:
    ``posted_by_user_id`` is stamped from the verified token, never accepted as input.
    """
    from sqlalchemy import select

    from app.domain.ledger.models import JournalEntry
    from app.domain.masters.models import User

    finance = await client_for(Role.FINANCE)
    entry = (
        await finance.post(
            f"{api}/journal-entries",
            json={**ENTRY, "posted_by_user_id": "00000000-0000-0000-0000-000000000000"},
        )
    ).json()

    stored = (
        await db.execute(select(JournalEntry).where(JournalEntry.entry_no == entry["entry_no"]))
    ).scalar_one()
    poster = await db.get(User, stored.posted_by_user_id)

    assert poster is not None
    assert poster.email == "lina@oscenia.co.id"
    assert poster.role is Role.FINANCE


# ---------------------------------------------------------------------------
# Hardening
# ---------------------------------------------------------------------------


async def test_a_missing_account_costs_the_same_time_as_a_wrong_password(
    anon_client: AsyncClient, api: str
) -> None:
    """The identical error message is only half the defence.

    Short-circuiting on "no such user" would skip argon2 entirely, so a missing account
    would answer in microseconds while a real one took tens of milliseconds — leaking
    exactly the fact the identical message exists to hide. Both paths must hash.
    """
    import time

    async def _timed(email: str) -> float:
        start = time.perf_counter()
        await anon_client.post(
            f"{api}/auth/login", json={"email": email, "password": "definitely-wrong"}
        )
        return time.perf_counter() - start

    # Warm up, so first-call import costs do not skew the comparison.
    await _timed("warmup@oscenia.co.id")

    # Best-of-three each way: the minimum is the least noisy estimate of the real cost.
    real = min([await _timed("lina@oscenia.co.id") for _ in range(3)])
    missing = min([await _timed("nobody-here@oscenia.co.id") for _ in range(3)])

    # Both should be dominated by argon2. A short-circuit would make `missing` an order of
    # magnitude faster; allow generous slack for a loaded CI machine.
    assert missing > real / 3, (
        f"missing-account login was {real / missing:.1f}x faster than a real one — "
        "the argon2 path is being skipped, which leaks account existence"
    )


async def test_replaying_a_used_refresh_token_ends_every_session(
    anon_client: AsyncClient, api: str
) -> None:
    """Reuse of a single-use token means replay or a client bug, and we cannot tell which.

    Assume the worse of the two: end every session. The legitimate owner signs in again; a
    thief loses the foothold.
    """
    first = (
        await anon_client.post(
            f"{api}/auth/login",
            json={"email": "lina@oscenia.co.id", "password": DEMO_PASSWORD},
        )
    ).json()

    second = (
        await anon_client.post(
            f"{api}/auth/refresh", json={"refresh_token": first["refresh_token"]}
        )
    ).json()

    # The attacker replays the token the legitimate client already spent.
    replay = await anon_client.post(
        f"{api}/auth/refresh", json={"refresh_token": first["refresh_token"]}
    )
    assert replay.status_code == 401
    assert "every session" in replay.json()["detail"]

    # ...and the legitimate client's newer token is dead too, so the theft cannot persist.
    after = await anon_client.post(
        f"{api}/auth/refresh", json={"refresh_token": second["refresh_token"]}
    )
    assert after.status_code == 401


async def test_a_deactivated_account_loses_access_immediately(
    anon_client: AsyncClient, api: str, db
) -> None:
    """Authorisation reads the database, not the token claim, so this is not deferred."""
    from sqlalchemy import select

    from app.domain.masters.models import User

    tokens = (
        await anon_client.post(
            f"{api}/auth/login",
            json={"email": "lina@oscenia.co.id", "password": DEMO_PASSWORD},
        )
    ).json()
    anon_client.headers["Authorization"] = f"Bearer {tokens['access_token']}"
    assert (await anon_client.get(f"{api}/auth/me")).status_code == 200

    user = (
        await db.execute(select(User).where(User.email == "lina@oscenia.co.id"))
    ).scalar_one()
    user.active = False
    await db.flush()

    response = await anon_client.get(f"{api}/auth/me")
    assert response.status_code == 401
    assert "deactivated" in response.json()["detail"]


def test_the_jwt_secret_must_be_long_enough_and_not_the_default() -> None:
    """HMAC-SHA256 keys below the digest length weaken the MAC for nothing (RFC 7518)."""
    from pydantic import ValidationError

    from app.core.config import Settings

    with pytest.raises(ValidationError, match="at least 32 bytes"):
        Settings(jwt_secret="too-short")

    with pytest.raises(ValidationError, match="set explicitly"):
        Settings(
            env="production", jwt_secret="dev-only-insecure-key-change-me-in-production"
        )
