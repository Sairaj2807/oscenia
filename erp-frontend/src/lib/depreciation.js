// Fixed-asset depreciation.
//
// The client asked to "eliminate manual calculations and the risk of missing
// monthly fixed asset depreciation bookkeeping": once an acquisition is
// finalised the system should schedule the whole life of the asset and produce
// the journal entries period by period.
//
// ---------------------------------------------------------------------------
// Why the schedule is not made of draft journal entries
// ---------------------------------------------------------------------------
// The proposal asks for "automated draft journal generation ... for upcoming
// periods until the end of the asset's useful life". The obvious reading is to
// write 60 unposted entries into the journal. That would mean every balance
// function, both statements, the trial balance and every verify suite had to
// learn to exclude them — one missed filter and the books silently report
// depreciation that has not happened yet.
//
// So the schedule lives here instead, as a pure projection of the asset. It is
// the same information (period, charge, net book value, and what is due) with
// none of the risk, and it is what a real ERP does: a depreciation schedule is
// a sub-ledger, and only the run posts.

import { parseDate, isoDate, appToday } from './format.js'

export const METHODS = [
  { key: 'straight-line', label: 'Straight line', hint: 'Equal charge every month' },
  { key: 'declining', label: 'Declining balance', hint: 'Double-rate, front-loaded' },
]

// 'YYYY-MM' for a date.
export function periodOf(iso) {
  return String(iso || '').slice(0, 7)
}

// Last calendar day of a 'YYYY-MM' period — the date a monthly charge posts on.
export function periodEnd(period) {
  const [y, m] = String(period).split('-').map(Number)
  if (!y || !m) return period
  // Day 0 of the next month is the last day of this one.
  return isoDate(Date.UTC(y, m, 0))
}

export function addMonths(period, n) {
  const [y, m] = String(period).split('-').map(Number)
  const total = y * 12 + (m - 1) + n
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}`
}

export function monthsBetween(fromPeriod, toPeriod) {
  const [fy, fm] = String(fromPeriod).split('-').map(Number)
  const [ty, tm] = String(toPeriod).split('-').map(Number)
  return (ty * 12 + tm) - (fy * 12 + fm)
}

export function depreciableBase(asset) {
  return Math.max(0, Math.round((asset.cost || 0) - (asset.salvage || 0)))
}

// The full life of the asset, one row per month.
//
// The final period absorbs any rounding remainder, so accumulated depreciation
// lands exactly on cost minus salvage. Without that an asset ends its life a
// few rupiah away from its own residual value, and someone writes that off by
// hand every time — which is the manual work this feature exists to remove.
//
// A revised asset is REBASED rather than recalculated from acquisition. When a
// useful life is extended, the periods already posted keep the charges they
// were posted at — `scheduleFrom` moves the projection forward and
// `openingAccumulated` carries the ledger figure into it, and the remaining
// depreciable value is spread over the remaining life. Recomputing from the
// start instead would retroactively rewrite what the ledger already recorded,
// and the register would quietly disagree with account 1303.
export function buildSchedule(asset, { asOf = appToday() } = {}) {
  const acquired = periodOf(asset.acquiredOn)
  const start = asset.scheduleFrom || acquired
  const elapsed = Math.max(0, monthsBetween(acquired, start))
  const life = Math.max(1, Math.round(Number(asset.usefulLifeMonths) || 0) - elapsed)
  const opened = Math.round(Number(asset.openingAccumulated) || 0)
  const base = Math.max(0, depreciableBase(asset) - opened)
  const posted = asset.postedThrough || null

  const rows = []
  let accumulated = opened

  for (let i = 0; i < life; i++) {
    const period = addMonths(start, i)
    const opening = (asset.cost || 0) - accumulated
    const remaining = (opened + base) - accumulated

    let charge
    if (asset.method === 'declining') {
      // Double-declining: twice the straight-line rate applied to net book
      // value, then straight-lined once that falls below what is left.
      const annualRate = 2 / (life / 12)
      charge = Math.round((opening * annualRate) / 12)
      const straight = Math.round(remaining / (life - i))
      if (charge < straight) charge = straight
    } else {
      charge = Math.round(base / life)
    }

    // Never depreciate past the residual value.
    charge = Math.max(0, Math.min(charge, remaining))
    // Last period takes whatever rounding left behind.
    if (i === life - 1) charge = remaining

    accumulated += charge
    const end = periodEnd(period)

    rows.push({
      index: i,
      period,
      periodEnd: end,
      opening,
      charge,
      accumulated,
      closing: (asset.cost || 0) - accumulated,
      state: posted && period <= posted
        ? 'posted'
        : end <= asOf
          ? 'due'
          : 'future',
    })
  }

  return rows
}

// Periods that have fallen due and have not been posted — the backlog the
// client is worried about missing.
export function duePeriods(asset, { asOf = appToday() } = {}) {
  if (asset.status === 'disposed') return []
  return buildSchedule(asset, { asOf }).filter((r) => r.state === 'due')
}

// What has ACTUALLY been posted to account 1303 for this asset.
//
// Stored on the asset rather than re-derived from the schedule. Deriving it
// meant that revising a useful life silently restated history: the schedule
// recomputed every past charge at the new rate, and the register's accumulated
// figure drifted away from the ledger's without anything being posted.
export function accumulatedFor(asset) {
  return Math.round(Number(asset.postedAccumulated) || 0)
}

export function netBookValue(asset) {
  return (asset.cost || 0) - accumulatedFor(asset)
}

// Register-wide totals, for the screen's stat row.
export function registerTotals(assets, { asOf = appToday() } = {}) {
  const live = (assets || []).filter((a) => a.status !== 'disposed')
  const cost = live.reduce((a, x) => a + (x.cost || 0), 0)
  const accumulated = live.reduce((a, x) => a + accumulatedFor(x), 0)
  const due = live.reduce((a, x) => a + duePeriods(x, { asOf }).reduce((b, r) => b + r.charge, 0), 0)
  const overduePeriods = live.reduce((a, x) => a + duePeriods(x, { asOf }).length, 0)
  const monthly = live.reduce((a, x) => {
    const next = buildSchedule(x, { asOf }).find((r) => r.state !== 'posted')
    return a + (next?.charge || 0)
  }, 0)
  return {
    count: live.length,
    cost,
    accumulated,
    netBookValue: cost - accumulated,
    due,
    overduePeriods,
    monthly,
  }
}

// Validation for the acquisition form.
export function validateAsset(draft) {
  if (!String(draft.name || '').trim()) return 'The asset needs a name.'
  if (!(Number(draft.cost) > 0)) return 'Acquisition cost must be greater than zero.'
  if (!parseDate(draft.acquiredOn)) return 'Enter a valid acquisition date.'
  if (!(Number(draft.usefulLifeMonths) > 0)) return 'Useful life must be at least one month.'
  if (Number(draft.salvage) < 0) return 'Salvage value cannot be negative.'
  if (Number(draft.salvage) >= Number(draft.cost)) {
    return 'Salvage value must be less than cost, or there is nothing to depreciate.'
  }
  return null
}
