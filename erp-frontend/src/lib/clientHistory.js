// A client's history from the server (`GET /clients/{id}/history`) in the shapes the client page draws.
// Derived on the server from projects, invoices, ratings and purchase orders: nothing here is stored.

const STAGES_DONE = ['Post-Event Feedback', 'Finished']
const num = (v) => Number(v) || 0

/** The page's timeline rows. A project not yet at feedback is "live" and shows its stage; a cancelled one says so. */
export function historyTimeline(history) {
  return (history?.events || [])
    .map((e) => ({
      name: e.name,
      date: e.eventDate ? String(e.eventDate).slice(0, 7) : '—',
      value: num(e.contractValue),
      vendors: (e.vendors || []).map((v) => v.name),
      // The payroll rating is out of ten; the page shows stars out of five.
      satisfaction: e.rating != null ? num(e.rating) / 2 : null,
      stage: e.cancelled ? 'Cancelled' : e.stage,
      live: e.cancelled || !STAGES_DONE.includes(e.stage),
    }))
    .sort((a, b) => (a.date < b.date ? 1 : -1))
}

/** The headline figures: what was contracted, what has been collected, how happy, and which vendors. */
export function historySummary(history) {
  return {
    ltv: num(history?.contracted),
    collected: num(history?.collected),
    avgSat: history?.avgRating != null ? num(history.avgRating) / 2 : null,
    vendorsUsed: (history?.vendorsUsed || []).map((v) => [v.name, v.events]),
    eventCount: history?.eventCount ?? 0,
  }
}
