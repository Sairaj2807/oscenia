import { normPhone, normEmail } from './events.js'

// No seed import. `clientHistory` is demo-only -- there is no endpoint for a client's past
// events -- so it arrives as an argument and hydration passes an empty object. Reading it
// straight from the seed file meant a live client's lifetime value silently included events
// that are not in the database.

// A client's live/in-flight projects (matched by name to the projects board).
export function clientProjects(clientName, projects) {
  return projects.filter((p) => p.client === clientName)
}

// Lifetime Value = total budget spent on Oscenia = past events + live projects.
// Computed (not a static number) so it always reconciles with the history shown.
export function clientLTV(client, projects, history = {}) {
  const hist = history[client.id] || { events: [] }
  const past = hist.events.reduce((a, e) => a + e.value, 0)
  const live = clientProjects(client.name, projects).reduce((a, p) => a + p.contractValue, 0)
  return past + live
}

// Combined history: live projects (with stage) + delivered past events, newest first.
export function clientTimeline(client, projects, history = {}) {
  const hist = history[client.id] || { events: [] }
  const live = clientProjects(client.name, projects).map((p) => ({
    name: p.name,
    date: p.eventDate ? p.eventDate.slice(0, 7) : '—',
    value: p.contractValue,
    vendors: [],
    satisfaction: null,
    stage: p.stage,
    live: true,
  }))
  const past = hist.events.map((e) => ({ ...e, live: false }))
  return [...live, ...past].sort((a, b) => (a.date < b.date ? 1 : -1))
}

// ---------------------------------------------------------------------------
// CRM part 1 — one contact list from every event's guests (BRD §5.1)
// ---------------------------------------------------------------------------
// Guests are pooled across events and de-duplicated by phone — the identity reminders and
// WhatsApp use. Email only groups guests who gave no phone: a couple or an office sharing one
// inbox are different people and must stay separate contacts. Consent is kept
// if the person ever gave it: ticking the box on one RSVP and leaving it unticked on a later
// one is not a withdrawal — withdrawing is an explicit unsubscribe (the backend's job).


export function guestContacts(guests, events) {
  const byKey = new Map()
  const keyOf = (g) => (normPhone(g.phone) ? `p:${normPhone(g.phone)}` : normEmail(g.email) ? `e:${normEmail(g.email)}` : null)
  const sorted = [...guests].sort((a, b) => (a.respondedAt || a.checkedInAt || '').localeCompare(b.respondedAt || b.checkedInAt || ''))
  for (const g of sorted) {
    const ev = events.find((e) => e.id === g.eventId)
    const key = keyOf(g)
    if (!key) continue // nothing to reach them by
    const c = byKey.get(key) || { key, name: g.name, phone: g.phone, email: '', events: [], consent: false, consentAt: null, consentSource: null }
    c.name = g.name
    c.phone = g.phone || c.phone
    c.email = g.email || c.email
    c.events.push({ eventId: g.eventId, name: ev?.name || g.eventId, date: ev?.date || '', rsvp: g.walkIn ? 'Walk-in' : g.rsvp || 'No response', came: Boolean(g.checkedInAt) })
    if (g.consent && (!c.consentAt || g.consentAt > c.consentAt)) {
      c.consent = true
      c.consentAt = g.consentAt
      c.consentSource = ev?.name || g.eventId
    }
    byKey.set(key, c)
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name))
}

// ---------------------------------------------------------------------------
// CRM part 2 — the relationship calendar (BRD §5.2)
// ---------------------------------------------------------------------------

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const monthName = (m) => MONTH_NAMES[m - 1]

/** The month a recurring event usually runs: the most frequent month in its history. */
export function usualMonth(history) {
  const count = {}
  for (const ym of history) count[Number(ym.slice(5, 7))] = (count[Number(ym.slice(5, 7))] || 0) + 1
  const best = Object.entries(count).sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]
  return best ? Number(best[0]) : null
}

const iso = (y, m, d = 1) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`

/**
 * The next edition not yet booked, and the day to nudge the client about it — `leadMonths`
 * before the start of its usual month. "Company A gathers every July → call them in April."
 */
export function nextNudge(cycle, leadMonths, today) {
  const m = usualMonth(cycle.history)
  if (!m) return null
  // A year counts as booked if the event ran (or is booked) at all that year — an edition
  // moved from August to September is still this year's edition.
  const years = new Set(cycle.history.map((h) => Number(h.slice(0, 4))))
  let y = Number(today.slice(0, 4))
  while (years.has(y) || iso(y, m) < iso(Number(today.slice(0, 4)), Number(today.slice(5, 7)))) y++
  const nudge = new Date(Date.UTC(y, m - 1 - leadMonths, 1)).toISOString().slice(0, 10)
  return { month: m, edition: `${y}-${String(m).padStart(2, '0')}`, nudgeOn: nudge }
}

/** "MM-DD" that exists on a calendar (29 Feb allowed; 31 Apr not). */
export function isMonthDay(v) {
  const m = /^(\d{2})-(\d{2})$/.exec(v || '')
  if (!m) return false
  const [mm, dd] = [Number(m[1]), Number(m[2])]
  const max = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mm - 1]
  return Boolean(max) && dd >= 1 && dd <= max
}

/** "MM-DD" or "YYYY-MM-DD" → the next date on or after `today` it falls on. */
export function nextOccurrence(monthDay, today) {
  const md = monthDay.length === 10 ? monthDay.slice(5) : monthDay
  const leap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
  const on = (y) => (md === '02-29' && !leap(y) ? `${y}-02-28` : `${y}-${md}`)
  const y = Number(today.slice(0, 4))
  return on(y) >= today ? on(y) : on(y + 1)
}

const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5)

/**
 * Everything worth a call or a message in the next `days` days: event-cycle nudges (overdue
 * ones included — they are the most urgent), PIC birthdays and company anniversaries.
 */
/**
 * Who a campaign reaches (C1): the ticked contacts who gave marketing consent. The ticked ones
 * without consent are skipped, never messaged — and counted, so the sender is told.
 */
export function campaignAudience(contacts, selectedKeys) {
  const keys = new Set(selectedKeys) // a Set or an array
  const picked = contacts.filter((c) => keys.has(c.key))
  return { recipients: picked.filter((c) => c.consent), skipped: picked.filter((c) => !c.consent) }
}

/** A valid-looking email address (for the simulated Google sign-in). */
export const isEmail = (v = '') => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim())

/**
 * One month as calendar weeks, Monday first (C2). Each cell is { date, day, inMonth, items };
 * the days before the 1st and after the last belong to the neighbouring months and carry no
 * items. `items` are { date: 'YYYY-MM-DD', … } from any source.
 */
export function calendarMonth(year, month, items = []) {
  const first = new Date(Date.UTC(year, month - 1, 1))
  const lead = (first.getUTCDay() + 6) % 7 // Monday = 0
  const daysIn = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const iso = (d) => d.toISOString().slice(0, 10)
  const byDate = {}
  for (const it of items) (byDate[it.date] ||= []).push(it)
  const cells = []
  const start = new Date(first)
  start.setUTCDate(1 - lead)
  const total = Math.ceil((lead + daysIn) / 7) * 7
  for (let i = 0; i < total; i++) {
    const d = new Date(start)
    d.setUTCDate(start.getUTCDate() + i)
    const date = iso(d)
    const inMonth = d.getUTCMonth() === month - 1
    cells.push({ date, day: d.getUTCDate(), inMonth, items: inMonth ? byDate[date] || [] : [] })
  }
  const weeks = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))
  return weeks
}

export function relationshipCalendar(clients, relations, today, days = 90) {
  const items = []
  for (const c of clients) {
    const r = relations[c.id]
    if (!r) continue
    for (const cycle of r.cycles || []) {
      const n = nextNudge(cycle, r.nudgeLeadMonths, today)
      if (!n) continue
      const key = `${cycle.name}:${n.edition}`
      if ((r.handledNudges || []).includes(key)) continue
      const inDays = daysBetween(today, n.nudgeOn)
      if (inDays <= days) {
        items.push({
          kind: 'Event nudge', clientId: c.id, client: c.name, date: n.nudgeOn, inDays, key,
          title: `${cycle.name} ${n.edition.slice(0, 4)}`,
          detail: `Usually in ${monthName(n.month)} — reach out ${r.nudgeLeadMonths} months ahead`,
        })
      }
    }
    for (const p of r.pics || []) {
      if (!p.birthday) continue
      const on = nextOccurrence(p.birthday, today)
      const inDays = daysBetween(today, on)
      if (inDays <= days) items.push({ kind: 'Birthday', clientId: c.id, client: c.name, date: on, inDays, title: p.name, detail: p.role, pic: p })
    }
    if (r.anniversary) {
      const on = nextOccurrence(r.anniversary, today)
      const inDays = daysBetween(today, on)
      const years = Number(on.slice(0, 4)) - Number(r.anniversary.slice(0, 4))
      if (years >= 1 && inDays <= days) items.push({ kind: 'Company anniversary', clientId: c.id, client: c.name, date: on, inDays, title: `${years} years with Oscenia`, detail: c.name })
    }
  }
  return items.sort((a, b) => a.date.localeCompare(b.date))
}
