// Chart of accounts.
//
// Account codes follow the client's first feedback deck (slide 5) so the demo
// matches the mockup they drew: 1101 Main Bank Cash, 2105 PPh 23 Payable, 4101
// Event Revenue DP. `type` is the important field — it is what lets the Income
// Statement and Balance Sheet be *derived* from the journal rather than
// hand-authored, which is the whole point of the accounting rework.
//
// ---------------------------------------------------------------------------
// Round 2: the chart is EDITABLE.
// ---------------------------------------------------------------------------
// The client asked that "financial administrators can independently add,
// configure, and adjust sub-accounts". So the chart is no longer a frozen
// constant — the store owns it and calls syncChart() on every mutation.
//
// The exports below are `let`, not `const`, on purpose. ES module bindings are
// live: reassigning ACCOUNTS here updates every module that imported it,
// including lib/ledger.js, pages/ProjectPnL.jsx and pages/Cash.jsx, without a
// single call site changing and without threading a `chart` argument through
// every ledger function. The tradeoff is a module-level singleton — there is
// exactly one chart per process, which is true of a real ledger anyway, and it
// keeps the plain-node verify scripts (scripts/verify-*.mjs) working unchanged.
//
// Two structural fields were added alongside the edit capability:
//
//   parent — an account may hang off another as a sub-account (1101.01 under
//            1101). An account WITH children becomes a header: nothing new can
//            be posted to it, and its displayed figure is its own balance plus
//            its children's — a header opened later still owns its history.
//   group  — the executive-summary bucket. The client asked to "combine groups
//            of account details into an executive summary", and this is what
//            that summary rolls up by.
//   active — deactivated accounts stay in the ledger and on the statements if
//            they carry a balance, but drop out of the posting dropdown. An
//            account that has ever been posted to is never deleted.

export const ACCOUNT_TYPES = {
  asset: { side: 'debit', statement: 'balance', group: 'Assets' },
  liability: { side: 'credit', statement: 'balance', group: 'Liabilities' },
  equity: { side: 'credit', statement: 'balance', group: 'Equity' },
  revenue: { side: 'credit', statement: 'income', group: 'Revenue' },
  cogs: { side: 'debit', statement: 'income', group: 'Cost of Sales (COGS)' },
  opex: { side: 'debit', statement: 'income', group: 'Operating Expenses' },
  tax: { side: 'debit', statement: 'income', group: 'Tax' },
}

// Order the statements and the COA tree render in.
export const TYPE_ORDER = ['asset', 'liability', 'equity', 'revenue', 'cogs', 'opex', 'tax']

// The chart as delivered. The store seeds from this; the user edits from there.
export const SEED_ACCOUNTS = [
  // --- Assets ---
  { code: '1101', name: 'Main Bank Cash', type: 'asset', group: 'Cash & Bank', cash: true },
  { code: '1102', name: 'Cash on Hand', type: 'asset', group: 'Cash & Bank', cash: true },
  { code: '1103', name: 'Petty Cash', type: 'asset', group: 'Cash & Bank', cash: true },
  { code: '1201', name: 'Accounts Receivable', type: 'asset', group: 'Receivables' },
  { code: '1301', name: 'Inventory — Consumables', type: 'asset', group: 'Inventory & Equipment' },
  { code: '1302', name: 'Inventory — Fixed Assets', type: 'asset', group: 'Inventory & Equipment' },
  // Contra-asset: it carries a CREDIT balance inside an asset type, so
  // accountBalance() reports it negative and the Inventory & Equipment group
  // nets to net book value on the summarised balance sheet — which is exactly
  // how the figure should read.
  { code: '1303', name: 'Accumulated Depreciation', type: 'asset', group: 'Inventory & Equipment', contra: true },
  // Tax withheld FROM Oscenia by a client under PPh 23. It is money already
  // paid to the tax office on our behalf and creditable against the year's
  // corporate tax, so it is an ASSET. 2105 below is the mirror image: tax
  // Oscenia withholds from a vendor and still owes the tax office.
  { code: '1401', name: 'Prepaid Tax — PPh 23', type: 'asset', group: 'Prepaid Taxes', tax: 'pph23' },

  // --- Liabilities ---
  { code: '2101', name: 'Unearned Revenue', type: 'liability', group: 'Payables & Accruals' },
  { code: '2102', name: 'Vendor Payables', type: 'liability', group: 'Payables & Accruals' },
  { code: '2103', name: 'Crew Payables', type: 'liability', group: 'Payables & Accruals' },
  { code: '2105', name: 'PPh 23 Payable', type: 'liability', group: 'Tax Payables', tax: 'pph23' },
  { code: '2106', name: 'PPN Payable', type: 'liability', group: 'Tax Payables', tax: 'ppn' },
  { code: '2107', name: 'PPh 21 Payable', type: 'liability', group: 'Tax Payables', tax: 'pph21' },

  // --- Equity ---
  { code: '3101', name: 'Retained Earnings', type: 'equity', group: 'Equity' },
  { code: '3102', name: 'Paid-in Capital', type: 'equity', group: 'Equity' },

  // --- Revenue ---
  { code: '4101', name: 'Event Revenue DP', type: 'revenue', group: 'Event Revenue' },
  { code: '4102', name: 'Event Revenue', type: 'revenue', group: 'Event Revenue' },

  // --- Cost of sales ---
  { code: '5101', name: 'Event COGS — Vendors', type: 'cogs', group: 'Direct Event Costs' },
  { code: '5102', name: 'Event COGS — Crew', type: 'cogs', group: 'Direct Event Costs' },
  { code: '5103', name: 'Event COGS — Logistics', type: 'cogs', group: 'Direct Event Costs' },
  { code: '5104', name: 'Event COGS — Consumables', type: 'cogs', group: 'Direct Event Costs' },

  // --- Operating expenses ---
  { code: '6101', name: 'Office Overhead', type: 'opex', group: 'Overheads' },
  { code: '6102', name: 'Salaries (non-event)', type: 'opex', group: 'Overheads' },
  { code: '6103', name: 'Depreciation Expense', type: 'opex', group: 'Depreciation' },
  { code: '6901', name: 'Asset Loss Expense', type: 'opex', group: 'Asset Losses' },

  // --- Tax ---
  { code: '7101', name: 'Tax Expense', type: 'tax', group: 'Tax' },
]

// ---------------------------------------------------------------------------
// The live registry. Reassigned by syncChart(); read everywhere else.
// ---------------------------------------------------------------------------

export let ACCOUNTS = SEED_ACCOUNTS
export let CASH_ACCOUNTS = []
export let ACCOUNT_GROUPS = []

let BY_CODE = {}
let CHILDREN = {}

// Rebuild every derived index from the current chart. Called by syncChart and
// once at module load so the derived exports are never stale.
function reindex() {
  BY_CODE = Object.fromEntries(ACCOUNTS.map((a) => [a.code, a]))

  CHILDREN = {}
  ACCOUNTS.forEach((a) => {
    if (!a.parent) return
    ;(CHILDREN[a.parent] || (CHILDREN[a.parent] = [])).push(a.code)
  })

  // Headers stay in. If an administrator opens sub-accounts under 1101, the
  // postings already sitting on 1101 do not move — dropping the header here
  // would quietly delete that balance from Total Cash and from the cash-flow
  // screen. Nothing NEW can land on a header (isPostable refuses it), so the
  // parent and its children are distinct accounts and summing both is correct.
  CASH_ACCOUNTS = ACCOUNTS.filter((a) => a.cash).map((a) => a.code)

  // Options for the manual journal-entry dropdown. Header accounts and
  // deactivated accounts are deliberately absent — you cannot post to either.
  ACCOUNT_GROUPS = TYPE_ORDER.map((type) => ({
    label: ACCOUNT_TYPES[type].group,
    codes: ACCOUNTS.filter((a) => a.type === type && isPostable(a)).map((a) => a.code),
  })).filter((g) => g.codes.length)
}

// Swap in a new chart. The store calls this on every COA mutation.
export function syncChart(accounts) {
  ACCOUNTS = accounts
  reindex()
  return ACCOUNTS
}

export function resetChart() {
  return syncChart(SEED_ACCOUNTS)
}

reindex()

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function account(code) {
  return BY_CODE[code] || { code, name: `Unmapped ${code}`, type: 'opex', group: 'Unmapped' }
}

export function accountLabel(code) {
  const a = account(code)
  return `${a.code} · ${a.name}`
}

export function accountExists(code) {
  return Boolean(BY_CODE[code])
}

// An account with children is a header — a heading on the statement, not a
// place transactions land. Posting to a header would double count it against
// its own children.
export function childrenOf(code) {
  return CHILDREN[code] || []
}

export function isHeader(codeOrAccount) {
  const code = typeof codeOrAccount === 'string' ? codeOrAccount : codeOrAccount?.code
  return childrenOf(code).length > 0
}

export function isPostable(codeOrAccount) {
  const a = typeof codeOrAccount === 'string' ? account(codeOrAccount) : codeOrAccount
  if (!a) return false
  return a.active !== false && !isHeader(a.code)
}

// Which side increases this account. Used to turn raw debit/credit sums into
// a signed balance that reads naturally on a statement.
export function normalSide(code) {
  return ACCOUNT_TYPES[account(code).type]?.side ?? 'debit'
}

export function accountsByType(type) {
  return ACCOUNTS.filter((a) => a.type === type)
}

// Distinct executive-summary buckets for a type, in chart order. Drives the
// summarised Income Statement and Balance Sheet.
export function groupsForType(type) {
  const seen = []
  ACCOUNTS.filter((a) => a.type === type).forEach((a) => {
    const g = a.group || ACCOUNT_TYPES[type]?.group || 'Other'
    if (!seen.includes(g)) seen.push(g)
  })
  return seen
}

export function accountsInGroup(type, group) {
  return ACCOUNTS.filter(
    (a) => a.type === type && (a.group || ACCOUNT_TYPES[type]?.group || 'Other') === group
  )
}

// Every distinct group label currently in use, for the group picker on the COA
// screen — the user can reuse an existing bucket or type a new one.
export function allGroups() {
  return [...new Set(ACCOUNTS.map((a) => a.group).filter(Boolean))].sort()
}

// ---------------------------------------------------------------------------
// Tree — the COA screen renders type -> group -> account -> sub-accounts.
// ---------------------------------------------------------------------------

export function chartTree(accounts = ACCOUNTS) {
  const kids = {}
  accounts.forEach((a) => {
    if (a.parent) (kids[a.parent] || (kids[a.parent] = [])).push(a)
  })
  const roots = accounts.filter((a) => !a.parent || !accounts.some((x) => x.code === a.parent))

  const byCode = (a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)

  return TYPE_ORDER.map((type) => {
    const groups = []
    roots
      .filter((a) => a.type === type)
      .sort(byCode)
      .forEach((a) => {
        const label = a.group || ACCOUNT_TYPES[type]?.group || 'Other'
        let bucket = groups.find((g) => g.group === label)
        if (!bucket) groups.push((bucket = { group: label, accounts: [] }))
        bucket.accounts.push({ ...a, children: (kids[a.code] || []).slice().sort(byCode) })
      })
    return { type, label: ACCOUNT_TYPES[type].group, groups }
  }).filter((t) => t.groups.length)
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

// Suggest the next free sub-account code under a parent: 1101 -> 1101.01.
export function nextChildCode(parentCode, accounts = ACCOUNTS) {
  const existing = accounts
    .filter((a) => a.parent === parentCode)
    .map((a) => Number(String(a.code).split('.')[1]))
    .filter((n) => Number.isFinite(n))
  const next = (existing.length ? Math.max(...existing) : 0) + 1
  return `${parentCode}.${String(next).padStart(2, '0')}`
}

// Suggest the next free top-level code inside a type, following the existing
// numbering convention (assets 1xxx, liabilities 2xxx, …).
export function nextCodeForType(type, accounts = ACCOUNTS) {
  const codes = accounts
    .filter((a) => a.type === type && !a.parent)
    .map((a) => Number(a.code))
    .filter(Number.isFinite)
  if (!codes.length) return ''
  return String(Math.max(...codes) + 1)
}

// The receivable and payable control accounts (lib/postings.js locks a line on one of them in
// every client receipt and vendor payment).
export const CONTROL_ACCOUNT_CODES = ['1201', '2102']

// Returns an error string, or null when the draft is safe to save.
// `originalCode` is set when editing, so an account does not collide with itself.
export function validateAccountDraft(draft, accounts = ACCOUNTS, originalCode = null) {
  const code = String(draft.code || '').trim()
  const name = String(draft.name || '').trim()

  if (!code) return 'An account code is required.'
  if (!/^[0-9]+(\.[0-9]+)*$/.test(code)) return 'Codes are numeric, optionally dotted for sub-accounts (e.g. 1101.01).'
  if (!name) return 'An account name is required.'
  if (!ACCOUNT_TYPES[draft.type]) return 'Choose an account type.'

  if (code !== originalCode && accounts.some((a) => a.code === code)) {
    return `Account ${code} already exists.`
  }

  if (draft.parent) {
    const parent = accounts.find((a) => a.code === draft.parent)
    if (!parent) return `Parent account ${draft.parent} does not exist.`
    if (parent.code === code) return 'An account cannot be its own parent.'
    // 1201 Receivable and 2102 Payable stay postable leaves: AR/AP open items are measured on
    // them, and every client receipt and vendor payment posts its locked line there. A
    // sub-account would turn them into headers and make those postings fail.
    if (CONTROL_ACCOUNT_CODES.includes(parent.code)) {
      return `${parent.code} is a control account (receivables/payables are reconciled against it) and cannot have sub-accounts.`
    }
    if (parent.type !== draft.type) {
      return `A sub-account must share its parent's type — ${parent.code} is ${ACCOUNT_TYPES[parent.type]?.group}.`
    }
    // One level of nesting. Deeper trees make the statements harder to read
    // than they make the chart expressive, which is the "lean architecture"
    // principle the client asked for.
    if (parent.parent) return 'Sub-accounts nest one level only.'
  }

  return null
}
