// A project's budget as the server reports it (backlog item: Budgeting).
//
// The server holds ceilings per category; what was *spent* is worked out from the ledger each time
// (never stored), so the plan and the reality cannot drift. Pure functions: `verify:adapters` pins
// them. Money arrives as strings and becomes numbers only here, at the page boundary.

const n = (v) => (v == null ? 0 : Number(v))

/** `GET /projects/{id}/budget` → bars the screen draws. */
export function adaptBudget(b) {
  return {
    projectId: b.projectId,
    categories: b.categories.map((c) => ({
      key: c.key,
      label: c.label,
      ceiling: n(c.ceiling),
      spent: n(c.spent),
      remaining: n(c.remaining),
      utilisation: n(c.utilisation),
      over: Boolean(c.over),
      codes: [...(c.codes || [])],
    })),
    totalCeiling: n(b.totalCeiling),
    totalSpent: n(b.totalSpent),
    totalRemaining: n(b.totalRemaining),
    utilisation: n(b.utilisation),
  }
}

/** `GET /alerts/budget-breaches` → one row per project that ran past its tolerance (flagged once, ever). */
export function adaptAlerts(rows, projects = []) {
  const byUuid = new Map(projects.map((p) => [p.uuid, p]))
  return (rows || []).map((a) => ({
    projectId: a.projectId,
    project: byUuid.get(a.projectId)?.id ?? null,
    name: byUuid.get(a.projectId)?.name ?? null,
    ceiling: n(a.ceiling),
    spent: n(a.spent),
    overBy: n(a.overBy),
    acknowledged: Boolean(a.acknowledged),
    raisedOn: a.raisedOn,
  }))
}

const slug = (text) => String(text || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

/**
 * The editor's rows → the `PUT /projects/{id}/budget` body.
 *
 * A row keeps its key once it has one (it is how the server tells categories apart); a new row's key
 * is made from its label and made unique. Returns `{ error }` for anything the server would refuse,
 * so the user is told before a request is made.
 */
export function budgetBody(rows) {
  if (!rows.length) return { error: 'Add at least one category.' }
  const taken = new Set(rows.map((r) => r.key).filter(Boolean))
  const out = []
  for (const r of rows) {
    const label = String(r.label || '').trim()
    if (!label) return { error: 'Every category needs a name.' }
    const ceiling = Number(r.ceiling)
    if (!Number.isFinite(ceiling) || ceiling < 0) return { error: `${label}: the ceiling must be zero or more.` }
    if (!r.codes?.length) return { error: `${label}: pick at least one cost account to measure it against.` }
    let key = r.key
    if (!key) {
      const base = slug(label) || 'category'
      key = base
      for (let i = 2; taken.has(key); i += 1) key = `${base}-${i}`
      taken.add(key)
    }
    out.push({ key, label, ceiling: String(ceiling), accountCodes: [...r.codes] })
  }
  return { body: { categories: out } }
}

/** Starting rows for a project with no budget yet: one per direct-cost account, ceilings to fill in. */
export function defaultBudgetRows(costAccounts) {
  return costAccounts
    .filter((a) => a.code !== '6901')
    .map((a) => ({ key: '', label: a.name.replace(/^Event COGS\s*[—-]\s*/, ''), ceiling: 0, codes: [a.code] }))
}
