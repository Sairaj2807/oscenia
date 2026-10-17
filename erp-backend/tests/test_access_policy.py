"""Who may call what, for the routes that used to need only a login.

Two kinds of test, because there are two ways this goes wrong:

* **Coverage** (no requests): every route is either gated by its own dependency, public by
  design, about the caller's own account, or listed in ``app.core.access.POLICY``. This is
  what stops the *next* endpoint from being quietly open to every login. It reads the app's
  routes rather than a hand-kept list, so a new route that forgets a gate fails here.
* **Behaviour** (real HTTP): for every role and every policy route, the answer is 403 exactly
  when the role sees none of the route's modules, and is never 403 otherwise.
"""

from __future__ import annotations

import uuid

import pytest
from fastapi import FastAPI
from fastapi.routing import APIRoute

from app.core.access import BUSINESS, POLICY, enforce_access
from app.core.config import get_settings
from app.core.rbac import can_see
from app.domain.masters.models import Role
from app.seed.chart import DEMO_PASSWORD
from app.seed.users import add_user

#: Login-only on purpose: they concern the caller's own account or are filtered by who asks.
OWN_ACCOUNT: frozenset[tuple[str, str]] = frozenset(
    {
        ("POST", "/auth/change-password"),
        ("POST", "/auth/logout-everywhere"),
        ("GET", "/auth/me"),
        ("PATCH", "/auth/me/preferences"),
        ("GET", "/notifications"),  # derived per person
        ("GET", "/search"),  # results are filtered by the caller's modules
        ("GET", "/google/connect"),  # per-user Google connection
        ("DELETE", "/google/connection"),
        ("GET", "/google/events"),
        ("PUT", "/google/options"),
        ("GET", "/google/status"),
        ("POST", "/google/sync-crm-dates"),
    }
)


def _routes() -> list[tuple[APIRoute, str, bool]]:
    """Every APIRoute with its full template and whether its router runs ``enforce_access``.

    Found the way the app registers them. FastAPI keeps a router's ``dependencies=`` on the
    include call, not on the route, so the flag is recorded there.
    """
    recorded: list[tuple[object, str, bool]] = []
    original = FastAPI.include_router

    def record(self, router, *args, **kwargs):  # type: ignore[no-untyped-def]
        guards = [getattr(d, "dependency", None) for d in kwargs.get("dependencies") or []]
        recorded.append((router, kwargs.get("prefix", ""), enforce_access in guards))
        return original(self, router, *args, **kwargs)

    FastAPI.include_router = record  # type: ignore[method-assign]
    try:
        from app.main import create_app

        create_app()
    finally:
        FastAPI.include_router = original  # type: ignore[method-assign]

    out: list[tuple[APIRoute, str, bool]] = []

    def walk(router, prefix: str, guarded: bool):  # type: ignore[no-untyped-def]
        for r in router.routes:
            if isinstance(r, APIRoute):
                out.append((r, prefix + r.path, guarded))
            elif hasattr(r, "original_router"):
                walk(r.original_router, prefix, guarded)

    for router, prefix, guarded in recorded:
        walk(router, prefix, guarded)
    return out


def _dep_names(dependant) -> list[str]:  # type: ignore[no-untyped-def]
    names: list[str] = []
    for d in dependant.dependencies:
        call = d.call
        names.append(getattr(call, "__qualname__", getattr(call, "__name__", str(call))))
        names.extend(_dep_names(d))
    return names


def _kind(route: APIRoute) -> str:
    names = _dep_names(route.dependant)
    if any(
        "require_action" in n
        or "require_module" in n
        or n in ("chat_member", "workspace_member")
        for n in names
    ):
        return "gated"
    return "login" if any(n.endswith("current_user") for n in names) else "public"


def _template(path: str) -> str:
    return path.removeprefix(get_settings().api_prefix)


def test_every_route_is_gated_public_own_account_or_in_the_policy() -> None:
    open_routes = []
    for route, path, _guarded in _routes():
        if _kind(route) != "login":
            continue
        for method in route.methods - {"HEAD", "OPTIONS"}:
            key = (method, _template(path))
            if key not in POLICY and key not in OWN_ACCOUNT:
                open_routes.append(f"{method} {_template(path)}")
    assert not open_routes, (
        "These routes answer any signed-in login. Gate them with require_action / "
        "require_module, or add them to app/core/access.py:\n  " + "\n  ".join(sorted(open_routes))
    )


def test_every_policy_entry_names_a_real_route_and_is_enforced() -> None:
    enforced: dict[tuple[str, str], bool] = {}
    for route, path, guarded in _routes():
        for method in route.methods - {"HEAD", "OPTIONS"}:
            enforced[(method, _template(path))] = guarded

    missing = [f"{m} {p}" for (m, p) in POLICY if (m, p) not in enforced]
    unenforced = [f"{m} {p}" for (m, p) in POLICY if enforced.get((m, p)) is False]
    assert not missing, f"policy entries with no such route (typo or removed route): {missing}"
    assert not unenforced, (
        "policy entries on a router that does not run enforce_access (see app/main.py): "
        f"{unenforced}"
    )


def test_a_team_login_sees_no_business_module() -> None:
    assert not any(can_see(Role.TEAM, m) for m in BUSINESS)


# ---------------------------------------------------------------------------
# Behaviour
# ---------------------------------------------------------------------------

_DUMMY = {"code": "1101", "key": "journal"}


def _concrete(template: str) -> str:
    out = template
    while "{" in out:
        start, end = out.index("{"), out.index("}")
        name = out[start + 1 : end]
        out = out[:start] + _DUMMY.get(name, str(uuid.uuid4())) + out[end + 1 :]
    return out


_CASES = sorted(POLICY.items())


@pytest.mark.parametrize("role", list(Role))
@pytest.mark.parametrize(("key", "modules"), _CASES, ids=[f"{m} {p}" for (m, p), _ in _CASES])
async def test_a_role_is_refused_exactly_when_it_sees_none_of_the_modules(
    client_for, anon_client, db, api: str, role: Role, key: tuple[str, str], modules: frozenset[str]
) -> None:
    method, template = key
    if role is Role.TEAM:
        # No seeded team login in the standard fixtures; make one the way production does.
        await add_user(db, "team-probe@oscenia.co.id", "Team Probe", Role.TEAM, DEMO_PASSWORD)
        await db.flush()
        login = await anon_client.post(
            f"{api}/auth/login",
            json={"email": "team-probe@oscenia.co.id", "password": DEMO_PASSWORD},
        )
        assert login.status_code == 200, login.text
        anon_client.headers["Authorization"] = f"Bearer {login.json()['access_token']}"
        client = anon_client
    else:
        client = await client_for(role)
    response = await client.request(
        method, api + _concrete(template), json=None if method == "GET" else {}
    )

    allowed = any(can_see(role, m) for m in modules)
    if allowed:
        assert response.status_code != 403, (
            f"{role} should reach {method} {template}: {response.text}"
        )
    else:
        assert response.status_code == 403, (
            f"{role} must be refused {method} {template}, got {response.status_code}"
        )
        body = response.json()
        assert body["action"].startswith("module:")
        assert body["permitted"], "the refusal should say who can"
