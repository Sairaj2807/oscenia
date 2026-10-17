"""Role-based access control, ported verbatim from ``erp-frontend/src/lib/roles.js``.

Two layers, because the client's feedback deck needs both:

1. **Module visibility** — which screens a role may see. The frontend uses this to build
   its menu; the API returns it from ``/auth/me`` so the two cannot drift apart.
2. **Action permissions** — what a role may actually *do* on a screen it can see. This is
   the layer that matters, and hiding menus cannot express it. Slide 8 requires that a
   Project Manager can raise a purchase order and a cash advance but "cannot approve main
   cash or journal disbursements (restricted exclusively to Finance)" — so a PM must *see*
   Procurement in order to raise a request, while still being unable to approve one.

The Finance role was added during round 1: the deck restricts approvals to Finance and no
such role existed, which left the PM restriction with nothing to restrict against.

**These tables are not ours to improvise.** They are the client's access policy. If a role
needs a new permission, that is a decision to take with them, not a line to edit here.
"""

from __future__ import annotations

from app.domain.masters.models import Role

#: Display metadata. ``name`` is the person the prototype ships for each role; the seeded
#: demo users use these so a reviewer sees the names they already know.
ROLE_META: dict[Role, dict[str, str]] = {
    Role.CEO: {"label": "CEO", "subtitle": "Full access", "initials": "RH", "name": "R. Hartono"},
    Role.FINANCE: {
        "label": "Finance",
        "subtitle": "Cash, ledger & approvals",
        "initials": "LW",
        "name": "Lina W.",
    },
    Role.PM: {
        "label": "Project Manager",
        "subtitle": "Budget oversight, requests only",
        "initials": "AP",
        "name": "Agus P.",
    },
    Role.SALES: {
        "label": "Sales & Marketing",
        "subtitle": "Quotes, CRM & own commissions",
        "initials": "DA",
        "name": "Dinda A.",
    },
    Role.WAREHOUSE: {
        "label": "Warehouse & Ops",
        "subtitle": "Logistics & inventory",
        "initials": "BS",
        "name": "Bagus S.",
    },
    Role.TEAM: {
        "label": "Team member",
        "subtitle": "Workspace & chat only",
        "initials": "RM",
        "name": "Rina M.",
    },
}

ALL = "all"

#: Which module keys each role may see. ``ALL`` means everything.
#:
#: ``events`` and ``templates`` (Template Studio) are here because the events module has a
#: backend, and so do ``chat`` and ``workspace`` (tasks) and ``gcal`` (Google Calendar, per user).
ROLE_MODULES: dict[Role, str | frozenset[str]] = {
    Role.CEO: ALL,
    Role.FINANCE: frozenset(
        {
            "dashboard",
            "quotations",
            "projects",
            "finance",
            "cash",
            "receivables",
            "payables",
            "pnl",
            "accounting",
            "coa",
            "fixedassets",
            "budgeting",
            "simulator",
            "crm",
            "gcal",
            "vendors",
            "purchaseorders",
            "procurement",
            "payroll",
            "sales",
            "workspace",
            "chat",
        }
    ),
    # A PM oversees the budget plan, raises POs and advances, and watches the pipeline and
    # warehouse — but sees no company-wide ledger.
    Role.PM: frozenset(
        {
            "dashboard",
            "projects",
            "pnl",
            "budgeting",
            "vendors",
            "purchaseorders",
            "procurement",
            "warehouse",
            "events",
            "templates",
            "workspace",
            "chat",
        }
    ),
    Role.SALES: frozenset(
        {
            "dashboard",
            "quotations",
            "projects",
            "crm",
            "gcal",
            "cron",
            "sales",
            "finance",
            "pnl",
            "receivables",
            "events",
            "workspace",
            "chat",
        }
    ),
    Role.WAREHOUSE: frozenset(
        {"dashboard", "projects", "warehouse", "procurement", "workspace", "chat"}
    ),
    # Staff and interns see the workspace and chat and nothing else. What they may open
    # inside either is decided by their workspace persona, not by this table — which is why
    # ``workspace`` and ``chat`` are open to every role: a Sales login can be a Field leader there.
    Role.TEAM: frozenset({"workspace", "chat"}),
}

#: Every gated action, with the label used when access is denied.
ACTIONS: dict[str, str] = {
    "post_journal": "Post or adjust journal entries",
    "manage_coa": "Add or adjust chart-of-accounts entries",
    "manage_assets": "Capitalise assets and run depreciation",
    "edit_tax": "Change tax rates",
    "approve_cash": "Approve and disburse cash",
    "approve_po": "Approve a purchase order",
    "pay_po": "Pay a purchase order",
    "approve_incentive": "Approve and disburse crew incentives",
    "confirm_dp": "Confirm a client down payment",
    "request_po": "Raise a purchase order",
    "request_advance": "Request a cash advance",
    "file_expense": "File an expense report",
    "revert_stage": "Move a project back a stage",
    "cancel_project": "Cancel a project",
    "cancel_quotation": "Cancel or decline a quotation",
    "advance_stage": "Advance a project stage",
    "manage_stock": "Check stock in and out",
    "add_stock": "Add stock items",
    "manage_do": "Progress a delivery order",
    "edit_client": "Add or edit client records",
    "manage_mou_templates": "Edit MoU / proposal templates",
    "publish_invitation": "Publish an event invitation",
    "manage_templates": "Design invitation templates (Template Studio)",
    "manage_workspace": "Set division and role, and who works on a project",
    "manage_users": "Create and manage user accounts",
    "manage_campaigns": "Prepare, export and mark marketing campaigns",
}

ROLE_ACTIONS: dict[Role, str | frozenset[str]] = {
    Role.CEO: ALL,
    Role.FINANCE: frozenset(
        {
            "post_journal",
            "manage_coa",
            "manage_assets",
            "edit_tax",
            "approve_cash",
            "approve_po",
            "pay_po",
            "approve_incentive",
            "confirm_dp",
            "request_po",
            "request_advance",
            "file_expense",
            "revert_stage",
            "cancel_project",
            "cancel_quotation",
        }
    ),
    # The restriction that matters: a PM may request, never approve or pay.
    Role.PM: frozenset(
        {
            "request_po",
            "request_advance",
            "file_expense",
            "advance_stage",
            "revert_stage",
            "manage_stock",
            "publish_invitation",
            "manage_templates",
            "manage_workspace",
        }
    ),
    Role.SALES: frozenset(
        {
            "cancel_quotation",
            "advance_stage",
            "edit_client",
            "request_po",
            "manage_mou_templates",
            "manage_campaigns",
        }
    ),
    Role.WAREHOUSE: frozenset(
        {"manage_stock", "add_stock", "manage_do", "request_advance", "file_expense"}
    ),
    Role.TEAM: frozenset(),
}


def can_see(role: Role, module: str) -> bool:
    allowed = ROLE_MODULES.get(role, frozenset())
    return allowed == ALL or module in allowed


def can_do(role: Role, action: str) -> bool:
    allowed = ROLE_ACTIONS.get(role, frozenset())
    return allowed == ALL or action in allowed


def roles_permitted(action: str) -> list[Role]:
    return [role for role in Role if can_do(role, action)]


def denial_reason(role: Role, action: str) -> str | None:
    """Why an action is blocked — naming who *can* do it, rather than just saying no.

    A bare 403 tells a user nothing actionable. "Approve and disburse cash — restricted to
    CEO / Finance" tells them who to ask.
    """
    if can_do(role, action):
        return None

    what = ACTIONS.get(action, action)
    names = [ROLE_META[r]["label"] for r in roles_permitted(action)]
    if names:
        return f"{what} — restricted to {' / '.join(names)}"
    return f"{what} — not permitted for this role"


def visible_modules(role: Role) -> list[str]:
    allowed = ROLE_MODULES.get(role, frozenset())
    if allowed == ALL:
        # Union of every module any role can see, so 'all' is a concrete list to the client.
        every: set[str] = set()
        for modules in ROLE_MODULES.values():
            if modules != ALL:
                every |= set(modules)
        return sorted(every)
    return sorted(allowed)


def permitted_actions(role: Role) -> list[str]:
    allowed = ROLE_ACTIONS.get(role, frozenset())
    return sorted(ACTIONS) if allowed == ALL else sorted(allowed)
