// The server's month-by-month trend (`GET /reports/monthly-trend`) in the shapes the dashboard draws.
// Revenue, cost and profit come from the ledger, so nothing here is stored or invented: a month with
// no entries is a zero, and a percentage with nothing to compare against is null (shown as no arrow).

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const num = (v) => Number(v) || 0

/** "2026-07" -> "Jul". */
export const monthLabel = (month) => MONTHS[(Number(String(month).slice(5, 7)) || 1) - 1]

/** The chart's points: revenue in millions of rupiah, with cost and profit beside it for the tooltip. */
export function trendSeries(trend) {
  return (trend?.months || []).map((m) => ({
    m: monthLabel(m.month),
    v: Math.round(num(m.revenue) / 1e5) / 10,
    cost: Math.round(num(m.cost) / 1e5) / 10,
    profit: Math.round(num(m.profit) / 1e5) / 10,
  }))
}

/** True when no month has any revenue, so the chart can say so instead of drawing a flat line as a result. */
export const trendIsEmpty = (trend) => (trend?.months || []).every((m) => num(m.revenue) === 0)

/** A percentage change as the stat card wants it: a whole number, or undefined for no arrow. */
export const cardDelta = (pct) => (pct == null ? undefined : Math.round(num(pct)))
