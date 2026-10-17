// Accounting periods, as the Periods tab lays them out: a window of recent months with the server's
// closed rows laid over it. A month with no row has never been closed, so it is open.

export const MONTHS = 24
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** The last `count` months up to and including the one `today` (YYYY-MM-DD) is in, newest first. */
export function recentMonths(today, count = MONTHS) {
  let year = Number(String(today).slice(0, 4))
  let month = Number(String(today).slice(5, 7))
  const out = []
  for (let i = 0; i < count; i += 1) {
    out.push({ year, month })
    month -= 1
    if (month === 0) { month = 12; year -= 1 }
  }
  return out
}

/** Every month in the window with its server row laid over it; a month with no row is open. */
export function overlayPeriods(months, rows) {
  const byKey = new Map((rows || []).map((r) => [`${r.year}-${r.month}`, r]))
  return months.map((m) => {
    const row = byKey.get(`${m.year}-${m.month}`)
    return { ...m, closed: String(row?.status || '').toLowerCase() === 'closed', closedAt: row?.closedAt || null }
  })
}
