// Double-entry ledger engine.
//
// Entry shape:
//   {
//     id: 'JE-1001',
//     date: '2026-05-10',
//     memo: 'DP received — Aurora Gala',
//     project: 'EVT-2026-GALA-01' | null,
//     source: { kind: 'invoice'|'po'|'pettycash'|'warehouse'|'payroll'|'manual'|'opening',
//               ref: 'INV-0045', doc: {…} },
//     lines: [{ account: '1101', debit: 150000000, credit: 0, note: '…' }],
//     reversalOf: null,   // this entry reverses that one
//     reversedBy: null,   // this entry was reversed by that one
//   }
//
// Every entry must balance: sum(debit) === sum(credit). The Income Statement
// and Balance Sheet are derived from these entries via the chart of accounts —
// they are no longer hand-authored, so if the ledger is wrong the statements
// say so instead of quietly lying.

// Extensioned import so this module is runnable by plain node (see
// scripts/verify-ledger.mjs); Vite resolves it either way.
import { ACCOUNTS, account, CASH_ACCOUNTS, ACCOUNT_TYPES } from './accounts.js'

// Money is stored in whole rupiah. Comparisons use a 1-rupiah tolerance so
// rounding in tax splits can never trip the balance check.
const EPSILON = 1

export function entryDebit(entry) {
  return (entry.lines || []).reduce((a, l) => a + (Number(l.debit) || 0), 0)
}

export function entryCredit(entry) {
  return (entry.lines || []).reduce((a, l) => a + (Number(l.credit) || 0), 0)
}

// The value of the entry — for a balanced entry either side works.
export function entryTotal(entry) {
  return Math.max(entryDebit(entry), entryCredit(entry))
}

export function isBalanced(entry) {
  const lines = entry.lines || []
  if (!lines.length) return false
  return Math.abs(entryDebit(entry) - entryCredit(entry)) < EPSILON
}

// A line may carry a debit OR a credit, never both.
export function lineIsValid(line) {
  const d = Number(line.debit) || 0
  const c = Number(line.credit) || 0
  if (!line.account) return false
  if (d && c) return false
  return d > 0 || c > 0
}

export function entryIsValid(entry) {
  const lines = (entry.lines || []).filter((l) => l.account && ((Number(l.debit) || 0) > 0 || (Number(l.credit) || 0) > 0))
  if (lines.length < 2) return false
  if (!lines.every(lineIsValid)) return false
  return isBalanced({ lines })
}

// ---------------------------------------------------------------------------
// Reversal — how a posted entry gets "edited".
// ---------------------------------------------------------------------------

// Swaps debit and credit on every line. The original stays in the ledger
// marked `reversedBy`, so the audit trail survives. This is why the UI's
// "Adjust" action posts a reversal + a replacement rather than overwriting:
// hard-editing a posted entry destroys the trail an auditor needs.
export function buildReversal(entry, id, date) {
  return {
    id,
    date: date || entry.date,
    memo: `Reversal of ${entry.id} — ${entry.memo}`,
    project: entry.project,
    source: { kind: 'reversal', ref: entry.id },
    lines: (entry.lines || []).map((l) => ({
      account: l.account,
      debit: Number(l.credit) || 0,
      credit: Number(l.debit) || 0,
      note: l.note,
    })),
    series: 'jv',
    voucherNo: null, // stamped by the store, which owns the counters
    appliedTo: [],
    reversalOf: entry.id,
    reversedBy: null,
  }
}

// ---------------------------------------------------------------------------
// Period filtering
// ---------------------------------------------------------------------------

// A period is { from, to } as ISO date strings, either side optional.
export function inPeriod(entry, period) {
  if (!period) return true
  const { from, to } = period
  if (from && entry.date < from) return false
  if (to && entry.date > to) return false
  return true
}

export function filterEntries(entries, { period, project } = {}) {
  return entries.filter((e) => {
    if (!inPeriod(e, period)) return false
    if (project && project !== 'all' && e.project !== project) return false
    return true
  })
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

// Raw debit/credit totals per account code.
export function accountTotals(entries) {
  const totals = {}
  entries.forEach((e) => {
    (e.lines || []).forEach((l) => {
      if (!l.account) return
      const t = totals[l.account] || (totals[l.account] = { debit: 0, credit: 0 })
      t.debit += Number(l.debit) || 0
      t.credit += Number(l.credit) || 0
    })
  })
  return totals
}

// Signed balance in the account's natural direction: an asset with more debits
// than credits is positive; a liability with more credits than debits is
// positive. So every statement line reads as a positive number when normal.
export function accountBalance(entries, code) {
  const t = accountTotals(entries)[code]
  if (!t) return 0
  const side = ACCOUNT_TYPES[account(code).type]?.side ?? 'debit'
  return side === 'debit' ? t.debit - t.credit : t.credit - t.debit
}

export function cashBalance(entries) {
  return CASH_ACCOUNTS.reduce((a, code) => a + accountBalance(entries, code), 0)
}

export function cashByAccount(entries) {
  return CASH_ACCOUNTS.map((code) => ({
    code,
    name: account(code).name,
    balance: accountBalance(entries, code),
  }))
}

// Debits must equal credits across the whole ledger. Surfaced in the UI as the
// "Balanced" indicator — if this ever goes false, a posting is wrong.
export function trialBalance(entries) {
  const totals = accountTotals(entries)
  let debit = 0
  let credit = 0
  Object.values(totals).forEach((t) => { debit += t.debit; credit += t.credit })
  return { debit, credit, balanced: Math.abs(debit - credit) < EPSILON }
}

// ---------------------------------------------------------------------------
// General Ledger
// ---------------------------------------------------------------------------

// Chronological order, ties broken by id so the running balance is stable
// across re-renders. The journal array itself is newest-first for display.
function byDateThenId(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

// The multi-dimensional ledger view the client asked for: "presents individual
// account movements as well as consolidation of all accounts at once",
// filterable by period and by Project Cost Center.
//
// Returns one row per matching journal LINE — which is what a general ledger
// is, as opposed to the entry-level list on the Journal tab. Movements dated
// before the period open are folded into `opening` rather than dropped, so the
// closing balance is a real balance and not just the period's activity.
//
//   codes   — array of account codes, or null for every account (consolidated)
//   period  — { from, to }, either side optional
//   project — a Project ID, or 'all'
export function generalLedger(entries, { codes = null, period = null, project = null } = {}) {
  const inProject = (e) => !project || project === 'all' || e.project === project
  const inCodes = (code) => !codes || codes.includes(code)

  let opening = 0
  const rows = []
  let totalDebit = 0
  let totalCredit = 0

  ;[...entries]
    .filter(inProject)
    .sort(byDateThenId)
    .forEach((e) => {
      ;(e.lines || []).forEach((l, i) => {
        if (!inCodes(l.account)) return
        const debit = Number(l.debit) || 0
        const credit = Number(l.credit) || 0
        if (!debit && !credit) return

        if (period?.from && e.date < period.from) {
          opening += debit - credit
          return
        }
        if (period?.to && e.date > period.to) return

        totalDebit += debit
        totalCredit += credit
        rows.push({
          key: `${e.id}-${i}`,
          entry: e,
          account: l.account,
          note: l.note,
          debit,
          credit,
        })
      })
    })

  // Running balance as a net debit. The screen flips the sign for a
  // credit-normal account so the figure reads positive when it is normal.
  let running = opening
  rows.forEach((r) => {
    running += r.debit - r.credit
    r.balance = running
  })

  return { opening, rows, closing: running, totalDebit, totalCredit }
}

// ---------------------------------------------------------------------------
// Inter-document linking
// ---------------------------------------------------------------------------

// How much of `entry` hits a control account in a given direction.
function controlMovement(entry, control, side) {
  return (entry.lines || [])
    .filter((l) => l.account === control)
    .reduce((a, l) => {
      const d = Number(l.debit) || 0
      const c = Number(l.credit) || 0
      return a + (side === 'debit' ? d - c : c - d)
    }, 0)
}

// Documents still awaiting settlement on a control account.
//
// This is what makes "Applied Payment / Bill Payment directly from the journal
// entry form" possible: an invoice that raised a receivable (a debit to 1201)
// stays open until payment entries crediting 1201 and pointing at it via
// `appliedTo` have cleared the balance.
//
//   control — the control account: '1201' for AR, '2102' for AP
//   side    — the direction that OPENS the item: 'debit' for AR, 'credit' for AP
export function openItems(entries, { control, side = 'debit' } = {}) {
  const live = entries.filter((e) => !e.reversalOf && !e.reversedBy)

  return live
    .map((entry) => {
      // An entry that points at another document is a settlement or an
      // adjustment OF that document, never a new open item. Without this an
      // upward variance adjustment — which credits the payables control just
      // like a bill does — was counted both as its own open bill and as a
      // reduction of the one it adjusts, so the open-items total drifted above
      // the control account it is supposed to reconcile with.
      if ((entry.appliedTo || []).length) return null

      const raised = controlMovement(entry, control, side)
      if (raised <= EPSILON) return null

      // Anything pointed at this entry that moves the control account the other
      // way is a settlement of it. Reversed payments stop counting, which is
      // how an undone receipt reopens the invoice.
      const payments = entries.filter(
        (p) => (p.appliedTo || []).includes(entry.id) && !p.reversedBy
      )
      const applied = payments.reduce(
        (a, p) => a - controlMovement(p, control, side),
        0
      )

      return {
        entry,
        raised,
        applied,
        outstanding: raised - applied,
        payments,
      }
    })
    .filter((r) => r && r.outstanding > EPSILON)
}

// Every entry that has been applied against `entryId`, plus the entry it was
// itself applied to — the two halves of the chain shown in the drill-down.
export function linkedEntries(entries, entryId) {
  const self = entries.find((e) => e.id === entryId)
  return {
    settles: (self?.appliedTo || []).map((id) => entries.find((e) => e.id === id)).filter(Boolean),
    settledBy: entries.filter((e) => (e.appliedTo || []).includes(entryId)),
  }
}

// ---------------------------------------------------------------------------
// Derived statements
// ---------------------------------------------------------------------------

// Roll statement lines up into their executive-summary buckets. The client
// asked for the "ability to combine groups of account details into an executive
// summary for ease of management analysis" — this is that roll-up, and every
// bucket keeps the codes it came from so the summary can still drill down.
export function rollUpByGroup(rows, type) {
  const buckets = []
  rows.forEach((r) => {
    // Derived lines (the computed tax provision, current-period earnings) have
    // no account behind them, so they stand on their own rather than being
    // filed under a bucket that would imply a chart entry exists.
    const label = r.derived
      ? r.label
      : account(r.code).group || ACCOUNT_TYPES[type]?.group || 'Other'
    let bucket = buckets.find((b) => b.label === label)
    if (!bucket) buckets.push((bucket = { code: r.derived ? '—' : label, label, amount: 0, codes: [], derived: r.derived }))
    bucket.amount += r.amount
    if (!r.derived) bucket.codes.push(r.code)
  })
  return buckets
}

function linesFor(entries, type) {
  return ACCOUNTS
    .filter((a) => a.type === type)
    .map((a) => ({ code: a.code, label: a.name, amount: accountBalance(entries, a.code) }))
    .filter((r) => Math.abs(r.amount) > EPSILON)
}

// Income Statement, ending at NPAT (Net Profit After Tax) as the client asked.
// The old version stopped at a pre-tax figure and labelled it "Net Profit".
//
// Corporate tax is computed live from taxConfig rather than read from a posted
// entry, so editing the rate in the Tax Settings card immediately moves Tax
// Expense and NPAT — that is the "manual override prior to displaying Tax
// Expense & Net Profit" the deck asked for. Any manually posted tax entries
// (type 'tax') are added on top.
export function incomeStatementFrom(entries, taxConfig) {
  const revenue = linesFor(entries, 'revenue')
  const cogs = linesFor(entries, 'cogs')
  const opex = linesFor(entries, 'opex')
  const postedTaxLines = linesFor(entries, 'tax')

  const sum = (rows) => rows.reduce((a, r) => a + r.amount, 0)
  const totalRevenue = sum(revenue)
  const totalCogs = sum(cogs)
  const totalOpex = sum(opex)
  const postedTax = sum(postedTaxLines)

  const grossProfit = totalRevenue - totalCogs
  const profitBeforeTax = grossProfit - totalOpex

  const provision = corporateTax(profitBeforeTax, taxConfig)
  const totalTax = postedTax + provision.amount
  const npat = profitBeforeTax - totalTax

  const tax = [
    ...postedTaxLines,
    ...(provision.amount
      ? [{ code: '—', label: `Corporate Income Tax (${provision.rate}%)`, amount: provision.amount, derived: true }]
      : []),
  ]

  return {
    revenue, cogs, opex, tax,
    totalRevenue, totalCogs, totalOpex, totalTax,
    postedTax, provision: provision.amount, taxRate: provision.rate,
    grossProfit, profitBeforeTax, npat,
    grossMargin: totalRevenue ? (grossProfit / totalRevenue) * 100 : 0,
    netMargin: totalRevenue ? (npat / totalRevenue) * 100 : 0,
  }
}

// Balance Sheet.
//
// Equity carries the opening balance posted to 3101/3102 plus the profit earned
// this period, which still sits in the income accounts (no closing entry in a
// prototype). Because the tax provision is computed rather than posted, it is
// added back as a liability line — without it the sheet would be out by exactly
// the tax amount. Assets = Liabilities + Equity then holds:
//   A = L + E_open + PBT  ==  (L + tax) + (E_open + PBT − tax)
export function balanceSheetFrom(entries, taxConfig) {
  const assets = linesFor(entries, 'asset')
  const postedLiabilities = linesFor(entries, 'liability')
  const equityAccounts = linesFor(entries, 'equity')

  const sum = (rows) => rows.reduce((a, r) => a + r.amount, 0)
  const income = incomeStatementFrom(entries, taxConfig)

  const liabilities = [
    ...postedLiabilities,
    ...(income.provision
      ? [{ code: '—', label: 'Provision for Income Tax', amount: income.provision, derived: true }]
      : []),
  ]

  const equity = [
    ...equityAccounts,
    { code: '—', label: 'Current Period Earnings (NPAT)', amount: income.npat, derived: true },
  ].filter((r) => Math.abs(r.amount) > EPSILON)

  const totalAssets = sum(assets)
  const totalLiabilities = sum(liabilities)
  const totalEquity = sum(equity)

  return {
    assets, liabilities, equity,
    totalAssets, totalLiabilities, totalEquity,
    balanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < EPSILON,
    difference: totalAssets - (totalLiabilities + totalEquity),
  }
}

// What counts as a cost of a project: cost of sales, plus asset losses, which
// are an operating expense company-wide but are absolutely a cost of the job
// that destroyed the equipment.
//
// Single definition on purpose. This used to be duplicated — projectCosts()
// included 6901 while the store's realizedCost cache only counted COGS, so a
// warehouse write-off silently pushed the two out of step by the loss amount.
export function isProjectCostAccount(code) {
  const a = account(code)
  return a.type === 'cogs' || code === '6901'
}

// Cost actually posted against a project. Lets the Project P&L use real
// postings instead of synthesised percentages.
export function projectCosts(entries, projectId) {
  const scoped = entries.filter((e) => e.project === projectId)
  return ACCOUNTS
    .filter((a) => isProjectCostAccount(a.code))
    .map((a) => ({ code: a.code, label: a.name, amount: accountBalance(scoped, a.code) }))
    .filter((r) => Math.abs(r.amount) > EPSILON)
}

// Revenue and cost for an arbitrary slice of the ledger — a period, a project,
// or both. Factored out because the P&L now compares slices against each other
// (month on month, year on year, project on project) and every comparison has
// to be computed the same way as the figure it is being compared to.
export function sliceTotals(entries, { period, project } = {}) {
  const scoped = filterEntries(entries, { period, project })
  const cost = ACCOUNTS
    .filter((a) => isProjectCostAccount(a.code))
    .reduce((acc, a) => acc + accountBalance(scoped, a.code), 0)
  const revenue = ACCOUNTS
    .filter((a) => a.type === 'revenue')
    .reduce((acc, a) => acc + accountBalance(scoped, a.code), 0)
  return {
    revenue,
    cost,
    profit: revenue - cost,
    margin: revenue ? ((revenue - cost) / revenue) * 100 : 0,
    entries: scoped.length,
  }
}

// Earliest posting date in the ledger. A comparison window that sits entirely
// before this has no data by definition, which is worth saying rather than
// rendering as a row of zeroes.
export function earliestEntryDate(entries) {
  return (entries || []).reduce((min, e) => (!min || e.date < min ? e.date : min), null)
}

// Every individual cost line posted against a project, newest first.
//
// Credits are included as negatives rather than filtered out, so a reversed
// cost nets to zero here and the total still reconciles with the project's
// realizedCost. Dropping credits would make the itemised list add up to more
// than the project actually spent.
export function projectCostEntries(entries, projectId) {
  return entries
    .filter((e) => e.project === projectId)
    .flatMap((e) =>
      (e.lines || [])
        .filter((l) => isProjectCostAccount(l.account))
        .map((l) => ({
          entryId: e.id,
          date: e.date,
          memo: e.memo,
          source: e.source,
          account: l.account,
          note: l.note,
          amount: (Number(l.debit) || 0) - (Number(l.credit) || 0),
          reversal: Boolean(e.reversalOf),
          reversed: Boolean(e.reversedBy),
        }))
        .filter((r) => r.amount !== 0)
    )
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
}

export function projectRevenue(entries, projectId) {
  const scoped = entries.filter((e) => e.project === projectId)
  return ACCOUNTS
    .filter((a) => a.type === 'revenue')
    .reduce((a, acc) => a + accountBalance(scoped, acc.code), 0)
}

// ---------------------------------------------------------------------------
// Tax
// ---------------------------------------------------------------------------

// Tax is rounded to the cent, half up: exactly what the server does (`money()`), so the
// browser and the reports cannot differ by the odd fraction a whole-rupiah rounding drops.
export function roundCents(x) {
  return Math.round((x + Number.EPSILON) * 100) / 100
}

// Withholding on a gross amount. The client's mockup shows PPh 23 at 2% on a
// 150,000,000 DP producing a 3,000,000 payable and 147,000,000 net revenue.
export function withholding(gross, taxConfig, key = 'pph23') {
  const cfg = taxConfig?.[key]
  if (!cfg?.active) return { rate: 0, amount: 0, net: gross }
  const amount = roundCents(gross * (cfg.rate / 100))
  return { rate: cfg.rate, amount, net: gross - amount }
}

// Corporate tax on profit before tax, for the Income Statement's NPAT line.
export function corporateTax(profitBeforeTax, taxConfig) {
  const cfg = taxConfig?.corporate
  if (!cfg?.active || profitBeforeTax <= 0) return { rate: cfg?.rate ?? 0, amount: 0 }
  return { rate: cfg.rate, amount: roundCents(profitBeforeTax * (cfg.rate / 100)) }
}
