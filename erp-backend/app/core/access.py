"""Who may call the endpoints that used to need nothing but a login.

Until this module, ``GET /journal-entries``, ``/clients``, ``/reports/balance-sheet`` and about
seventy more answered anyone with a valid access token. A chat-only login could read the whole
ledger by calling the API directly; the sidebar hid the screens and that was all. Writes were
gated by ``require_action``; reads were not.

The policy lives here, in one table, so it can be read and reviewed in one place: each entry is
``"METHOD /route-template"`` and the modules whose holders may call it. A caller needs to see
**at least one** of the listed modules (``app.core.rbac.can_see``), the same matrix the sidebar
and ``/auth/me`` already use, so the screen and the server cannot disagree about who sees what.

``enforce_access`` is a router-level dependency (see ``app.main``). It matches the route
*template* (``/projects/{project_id}``), not the URL, so ids cannot dodge it. A route with no
entry here is untouched: it has its own gate (``require_action``, ``require_module``,
``chat_member``…), is public by design, or concerns only the caller's own account.
``tests/test_access_policy.py`` fails if a route is none of those, which is what keeps the next
endpoint someone adds from being quietly open to every login.

What this is not: row-level scoping. A role that may see a module sees that module's data
company-wide, as the product has always worked (a Project Manager's dashboard shows company
cash). Narrowing that is a product decision, not a code one.
"""

from __future__ import annotations

from typing import Final

from fastapi import Request

from app.core.config import get_settings
from app.core.deps import CurrentUser
from app.core.errors import PermissionDenied
from app.core.rbac import ROLE_META, ROLE_MODULES, can_see

_ALL_MODULES: Final[frozenset[str]] = frozenset().union(
    *(m for m in ROLE_MODULES.values() if isinstance(m, frozenset))
)

#: Every module that reads business data. ``workspace`` and ``chat`` are left out on purpose:
#: they have their own live data and their own gates, and a team member holds only those two.
BUSINESS: Final[frozenset[str]] = _ALL_MODULES - {"workspace", "chat"}

#: Reference data the business screens share (accounts, clients, projects, tax rates…). Anyone
#: with a business module reads it; a login with none does not.
_SHARED: Final[tuple[str, ...]] = (
    "GET /accounts",
    "GET /accounts/next-code",
    "GET /accounts/stats",
    "GET /accounts/tree",
    "GET /accounts/{code}",
    "POST /attachments",
    "GET /attachments/{attachment_id}",
    "GET /clients",
    "GET /crew",
    "GET /inventory",
    "GET /invoices",
    "GET /invoices/{invoice_id}",
    "GET /journal-entries",
    "GET /journal-entries/{entry_id}",
    "GET /ops/summary",
    "GET /periods",  # only open / closed per month: "anyone signed in may look"
    "GET /petty-cash",
    "GET /projects",
    "GET /projects/{project_id}",
    "GET /projects/{project_id}/budget",
    "GET /projects/{project_id}/incentives",
    "GET /settings",
    "GET /tags",
    "GET /tax-config",
    "GET /voucher-series",
    "GET /voucher-series/{key}/preview",
    "GET /vendor-catalogue",
    "GET /vendor-catalogue/availability",
    "GET /vendors",
    "GET /vendors/{vendor_id}",
)

_GROUPS: Final[tuple[tuple[frozenset[str], tuple[str, ...]], ...]] = (
    (BUSINESS, _SHARED),
    (
        frozenset({"budgeting", "dashboard", "pnl", "finance"}),
        ("GET /alerts/budget-breaches",),
    ),
    (
        frozenset({"quotations", "finance", "sales"}),
        ("GET /billing/presets", "POST /billing/resolve-schedule", "GET /mou-templates"),
    ),
    (frozenset({"payables", "finance", "accounting"}), ("GET /bills",)),
    (frozenset({"crm", "projects", "events"}), ("GET /clients/{client_id}/interactions",)),
    (
        frozenset({"warehouse", "procurement", "projects"}),
        ("GET /delivery-orders", "GET /delivery-orders/{order_id}/signature"),
    ),
    (
        frozenset({"fixedassets", "accounting", "finance"}),
        (
            "GET /depreciation/backlog",
            "GET /fixed-assets",
            "GET /fixed-assets/register",
            "GET /fixed-assets/{asset_id}",
            "GET /fixed-assets/{asset_id}/schedule",
        ),
    ),
    (
        frozenset({"cron", "accounting", "fixedassets", "finance"}),
        ("GET /jobs", "GET /jobs/{job_key}/runs"),
    ),
    (
        frozenset({"accounting", "finance", "cash", "receivables", "payables"}),
        ("GET /open-items",),
    ),
    (frozenset({"receivables", "finance", "dashboard"}), ("GET /receivables/ageing",)),
    (frozenset({"payables", "finance", "dashboard"}), ("GET /payables/ageing",)),
    (
        frozenset({"procurement", "finance", "warehouse"}),
        ("GET /procurement-requests", "GET /procurement-requests/by-requester"),
    ),
    # Rating a finished project feeds the crew incentive: the payroll module's job.
    (frozenset({"payroll"}), ("PUT /projects/{project_id}/feedback",)),
    (
        frozenset({"purchaseorders", "procurement", "vendors", "finance", "warehouse", "projects"}),
        ("GET /purchase-orders", "GET /purchase-orders/{order_id}"),
    ),
    (
        frozenset({"quotations", "finance", "projects", "sales", "crm"}),
        ("GET /quotations", "GET /quotations/{quotation_id}"),
    ),
    # Creating, revising, sending and accepting a quotation changed money-adjacent state for
    # any login. Now only the quotations module may.
    (
        frozenset({"quotations"}),
        (
            "POST /quotations",
            "PATCH /quotations/{quotation_id}",
            "POST /quotations/{quotation_id}/accept",
            "POST /quotations/{quotation_id}/send",
        ),
    ),
    (frozenset({"cron", "crm"}), ("GET /reminders", "POST /reminders/{reminder_id}/resolve")),
    # A Project Manager oversees the budget and may read the statements, never post to them
    # (the deck, and test_a_pm_may_read_but_not_write). Sales, Warehouse and a team login may not.
    (
        frozenset({"accounting", "finance", "budgeting"}),
        (
            "GET /reports/balance-sheet",
            "GET /reports/income-statement",
            "GET /reports/trial-balance",
            "GET /reports/general-ledger",
        ),
    ),
    (
        frozenset({"cash", "dashboard", "finance", "accounting"}),
        ("GET /reports/cash-position",),
    ),
    (frozenset({"dashboard", "pnl", "finance"}), ("GET /reports/monthly-trend",)),
    (
        frozenset({"pnl", "dashboard", "budgeting", "projects", "finance"}),
        (
            "GET /reports/project-costs",
            "GET /reports/project-pnl",
            "GET /reports/project-pnl/compare",
        ),
    ),
)


def _build() -> dict[tuple[str, str], frozenset[str]]:
    table: dict[tuple[str, str], frozenset[str]] = {}
    for modules, routes in _GROUPS:
        for route in routes:
            method, _, path = route.partition(" ")
            key = (method, path)
            if key in table:
                raise RuntimeError(f"access policy lists {route} twice")
            table[key] = modules
    return table


#: ``(method, route template without the API prefix)`` → the modules, any one of which suffices.
POLICY: Final[dict[tuple[str, str], frozenset[str]]] = _build()


async def enforce_access(request: Request, user: CurrentUser) -> None:
    """Refuse a login whose role sees none of the modules this route belongs to."""
    route = request.scope.get("route")
    template = getattr(route, "path", None)
    if template is None:
        return
    key = (request.method, template.removeprefix(get_settings().api_prefix))
    modules = POLICY.get(key)
    if modules is None or any(can_see(user.role, m) for m in modules):
        return

    permitted = [
        ROLE_META[r]["label"] for r in ROLE_MODULES if any(can_see(r, m) for m in modules)
    ]
    raise PermissionDenied(
        "This part of Oscenia is not available to this login.",
        action="module:" + "|".join(sorted(modules)),
        permitted=permitted,
    )
