// RBAC. Two layers, because the feedback deck needs both.
//
// 1. Module visibility — which screens a role can see. This is the "RBAC
//    illusion" the prototype started with, driven by the role switcher.
//
// 2. Action permissions — what a role may actually DO on a screen it can see.
//    This layer is new. Slide 8 requires that a Project Manager can request a
//    PO and a cash advance but "cannot approve main cash or journal
//    disbursements (restricted exclusively to Finance)". Hiding menus cannot
//    express that: a PM needs to see Procurement in order to raise a request,
//    while still being unable to approve one.
//
// A Finance role was added alongside the PM. The deck restricts approvals to
// Finance, and previously no such role existed — the CEO stood in for it, which
// left the PM restriction with nothing to restrict against.

export const ROLES = {
  ceo: {
    id: 'ceo',
    label: 'CEO',
    subtitle: 'Full access',
    initials: 'RH',
    name: 'R. Hartono',
  },
  finance: {
    id: 'finance',
    label: 'Finance',
    subtitle: 'Cash, ledger & approvals',
    initials: 'LW',
    name: 'Lina W.',
  },
  pm: {
    id: 'pm',
    label: 'Project Manager',
    subtitle: 'Budget oversight, requests only',
    initials: 'AP',
    name: 'Agus P.',
  },
  sales: {
    id: 'sales',
    label: 'Sales & Marketing',
    subtitle: 'Quotes, CRM & own commissions',
    initials: 'DA',
    name: 'Dinda A.',
  },
  warehouse: {
    id: 'warehouse',
    label: 'Warehouse & Ops',
    subtitle: 'Logistics & inventory',
    initials: 'BS',
    name: 'Bagus S.',
  },
  // Staff and interns: a login for the workspace and chat, with no finance access (round 5).
  team: {
    id: 'team',
    label: 'Team member',
    subtitle: 'Workspace & chat only',
    initials: 'RM',
    name: 'Rina M.',
  },
}

// Which module keys each role may see. 'all' = everything.
// `workspace`, `chat` and `events` are the prototype modules. `workspace` and `chat` are open to
// every role: inside them what a person sees is decided by their project persona
// (lib/workspaceAccess.js), not here — a Sales login can be a Field leader there, and a login with
// no persona is told who to ask.
// `gcal` is the Google Calendar page under CRM & Clients (round 3): every role with `crm`.
// `templates` is the Template Studio under Events (round 3): the roles with `manage_templates`.
export const ROLE_MODULES = {
  ceo: 'all',
  finance: [
    'dashboard', 'quotations', 'projects', 'finance', 'cash', 'receivables',
    'payables', 'pnl', 'accounting', 'coa', 'fixedassets', 'budgeting', 'simulator', 'crm', 'gcal', 'vendors',
    'purchaseorders', 'procurement', 'payroll', 'sales', 'workspace', 'chat',
  ],
  // A PM oversees the budget plan, raises POs and advances, and watches the
  // pipeline and warehouse — but sees no company-wide ledger.
  pm: [
    'dashboard', 'projects', 'pnl', 'budgeting', 'vendors', 'purchaseorders',
    'procurement', 'warehouse', 'workspace', 'chat', 'events', 'templates',
  ],
  sales: ['dashboard', 'quotations', 'projects', 'crm', 'gcal', 'cron', 'sales', 'finance', 'pnl', 'receivables', 'events', 'workspace', 'chat'],
  warehouse: ['dashboard', 'projects', 'warehouse', 'procurement', 'workspace', 'chat'],
  team: ['workspace', 'chat'],
}

export function canSee(roleId, moduleKey) {
  const allowed = ROLE_MODULES[roleId]
  if (allowed === 'all') return true
  return (allowed || []).includes(moduleKey)
}

// ---------------------------------------------------------------------------
// Action permissions
// ---------------------------------------------------------------------------

// Every gated action in the system, with the label used when access is denied.
export const ACTIONS = {
  post_journal: 'Post or adjust journal entries',
  manage_coa: 'Add or adjust chart-of-accounts entries',
  manage_assets: 'Capitalise assets and run depreciation',
  edit_tax: 'Change tax rates',
  approve_cash: 'Approve and disburse cash',
  approve_po: 'Approve a purchase order',
  pay_po: 'Pay a purchase order',
  approve_incentive: 'Approve and disburse crew incentives',
  confirm_dp: 'Confirm a client down payment',
  request_po: 'Raise a purchase order',
  request_advance: 'Request a cash advance',
  file_expense: 'File an expense report',
  revert_stage: 'Move a project back a stage',
  cancel_project: 'Cancel a project',
  cancel_quotation: 'Cancel or decline a quotation',
  advance_stage: 'Advance a project stage',
  manage_stock: 'Check stock in and out',
  add_stock: 'Add stock items',
  manage_do: 'Progress a delivery order',
  edit_client: 'Add or edit client records',
  manage_mou_templates: 'Edit MoU / proposal templates',
  publish_invitation: 'Publish an event invitation',
  manage_templates: 'Design invitation templates (Template Studio)',
  manage_workspace: 'Set division and role, and who works on a project',
  manage_users: 'Create and manage user accounts',
  manage_campaigns: 'Prepare, export and mark marketing campaigns',
}

export const ROLE_ACTIONS = {
  ceo: 'all',
  finance: [
    'post_journal', 'manage_coa', 'manage_assets', 'edit_tax', 'approve_cash', 'approve_po', 'pay_po',
    'approve_incentive', 'confirm_dp', 'request_po', 'request_advance',
    'file_expense', 'revert_stage', 'cancel_project', 'cancel_quotation',
  ],
  // The restriction that matters: a PM may request, never approve or pay.
  pm: [
    'request_po', 'request_advance', 'file_expense', 'advance_stage',
    'revert_stage', 'manage_stock', 'publish_invitation', 'manage_templates', 'manage_workspace',
  ],
  sales: ['cancel_quotation', 'advance_stage', 'edit_client', 'request_po', 'manage_mou_templates', 'manage_campaigns'],
  warehouse: ['manage_stock', 'add_stock', 'manage_do', 'request_advance', 'file_expense'],
  team: [],
}

export function canDo(roleId, action) {
  const allowed = ROLE_ACTIONS[roleId]
  if (allowed === 'all') return true
  return (allowed || []).includes(action)
}

// Why an action is blocked, for a tooltip. Names the role that can do it
// instead of just saying no.
export function denialReason(roleId, action) {
  if (canDo(roleId, action)) return null
  const permitted = Object.keys(ROLE_ACTIONS).filter((r) => canDo(r, action))
  const names = permitted.map((r) => ROLES[r]?.label).filter(Boolean)
  const what = ACTIONS[action] || action
  return names.length
    ? `${what} — restricted to ${names.join(' / ')}`
    : `${what} — not permitted for this role`
}
