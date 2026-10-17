// The server's report answers, in the shapes the pages already read (W4).
//
// Each page was written against what `lib/ledger.js` returns (`incomeStatementFrom`,
// `balanceSheetFrom`, `trialBalance`, `cashByAccount`, `sliceTotals`, `projectCostEntries`), so
// these turn the API's strings and snake_case-then-camelCased fields into exactly those shapes.
// Doing the translation here, once, means a page switches from the browser's figure to the
// server's by changing where it gets the object, not how it uses it.
//
// Pure functions: `verify:adapters` pins them without a server. Money arrives as a string and
// becomes a number only here, at the page boundary (the pages do arithmetic and formatting on
// numbers); the server's two-decimal strings are exact, and Number() of them is exact to the cent.

const n = (v) => (v == null ? 0 : Number(v))

const line = (l) => ({
  code: l.code,
  label: l.label,
  amount: n(l.amount),
  derived: Boolean(l.derived),
  // A rolled-up bucket keeps the codes it was built from, so the page can still drill into it.
  ...(l.codes?.length ? { codes: l.codes } : {}),
})

/** `GET /reports/income-statement` → what `incomeStatementFrom` returns. */
export function adaptIncomeStatement(r) {
  return {
    revenue: r.revenue.map(line),
    cogs: r.cogs.map(line),
    opex: r.opex.map(line),
    tax: r.tax.map(line),
    totalRevenue: n(r.totalRevenue),
    totalCogs: n(r.totalCogs),
    totalOpex: n(r.totalOpex),
    totalTax: n(r.totalTax),
    postedTax: n(r.postedTax),
    provision: n(r.provision),
    taxRate: n(r.taxRate),
    grossProfit: n(r.grossProfit),
    profitBeforeTax: n(r.profitBeforeTax),
    npat: n(r.npat),
    grossMargin: n(r.grossMargin),
    netMargin: n(r.netMargin),
    // Extra, and useful: 1401 as the server sees it (PPh 23 withheld from us, creditable).
    prepaidWithholding: n(r.prepaidWithholding),
    summarised: Boolean(r.summarised),
  }
}

/** `GET /reports/balance-sheet` → what `balanceSheetFrom` returns. */
export function adaptBalanceSheet(r) {
  return {
    assets: r.assets.map(line),
    liabilities: r.liabilities.map(line),
    equity: r.equity.map(line),
    totalAssets: n(r.totalAssets),
    totalLiabilities: n(r.totalLiabilities),
    totalEquity: n(r.totalEquity),
    balanced: Boolean(r.balanced),
    difference: n(r.difference),
    summarised: Boolean(r.summarised),
    // The server says when a narrow window silently drops the opening balances.
    excludesOpeningBalances: Boolean(r.excludesOpeningBalances),
  }
}

/** `GET /reports/trial-balance` → what `trialBalance` returns. */
export function adaptTrialBalance(r) {
  return { debit: n(r.debit), credit: n(r.credit), balanced: Boolean(r.balanced), difference: n(r.difference) }
}

/** `GET /reports/cash-position` → `{ total, accounts }`, accounts as `cashByAccount` returns them. */
export function adaptCashPosition(r) {
  return {
    total: n(r.total),
    accounts: r.accounts.map((a) => ({ code: a.code, name: a.name, balance: n(a.balance), share: n(a.share) })),
    asOf: r.asOf,
  }
}

/** One slice of the P&L (`GET /reports/project-pnl`) → what `sliceTotals` returns, plus the cost lines. */
export function adaptSlice(r) {
  return {
    label: r.label,
    revenue: n(r.revenue),
    cost: n(r.cost),
    profit: n(r.profit),
    margin: n(r.margin),
    start: r.start,
    end: r.end,
    costs: (r.costs || []).map((c) => ({ code: c.code, label: c.label, amount: n(c.amount) })),
  }
}

/** `GET /reports/project-pnl/compare`. */
export function adaptComparison(r) {
  return {
    current: adaptSlice(r.current),
    baseline: adaptSlice(r.baseline),
    deltas: r.deltas.map((d) => ({
      metric: d.metric,
      now: n(d.now),
      was: n(d.was),
      change: n(d.change),
      percent: d.percent == null ? null : n(d.percent),
      improved: d.improved,
      inverse: Boolean(d.inverse),
    })),
    // The baseline window ends before the ledger begins: its zeroes are an absence of data.
    beforeLedger: Boolean(r.beforeLedger),
  }
}

/** `GET /reports/project-costs` → what `projectCostEntries` returns. */
export function adaptCostEntries(rows) {
  return (rows || []).map((r) => ({
    entryId: r.entryId,
    date: r.entryDate,
    memo: r.memo,
    source: { kind: r.sourceKind, ref: r.sourceRef },
    account: r.accountCode,
    note: r.note,
    amount: n(r.amount),
    reversal: Boolean(r.isReversal),
    reversed: Boolean(r.isReversed),
  }))
}

/** `GET /receivables/ageing` or `/payables/ageing`. */
export function adaptAgeing(r) {
  return {
    asOf: r.asOf,
    buckets: r.buckets.map((b) => ({ key: b.key, label: b.label, amount: n(b.amount), count: b.count, share: n(b.share) })),
    total: n(r.total),
    overdue: n(r.overdue),
    scheduled: n(r.scheduled ?? 0),
    scheduledCount: r.scheduledCount ?? 0,
    ledgerBalance: n(r.ledgerBalance),
    difference: n(r.difference),
    reconciled: Boolean(r.reconciled),
    // Payables only: PPh 23 withheld and still owed to the tax office (account 2105).
    withholdingOwed: r.withholdingOwed == null ? null : n(r.withholdingOwed),
  }
}

/**
 * `GET /accounts/tree` → `{ code: balance }` for every account in it, sub-accounts included.
 *
 * The tree is how the chart of accounts is shown; each node carries its own balance (what was posted
 * to that very account, the same figure `accountBalance(journal, code)` gives), so the chart and the
 * reconciliations that need one account's balance (1302/1303 on Fixed Assets) read it from here.
 */
export function adaptAccountBalances(tree) {
  const out = {}
  const walk = (node) => {
    out[node.code] = n(node.balance)
    ;(node.children || []).forEach(walk)
  }
  ;(tree || []).forEach((type) => (type.groups || []).forEach((g) => (g.accounts || []).forEach(walk)))
  return out
}
