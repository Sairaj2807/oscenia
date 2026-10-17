// Events, invitations and RSVPs (BRD §4): pure helpers shared by the staff screens, the
// public invitation page and the checks in scripts/verify-proto.mjs.

import { DEMO_TODAY } from './format.js'

export const HERO_PRESETS = {
  aurora: 'radial-gradient(120% 90% at 20% 10%, #c6a15b55 0%, transparent 55%), radial-gradient(90% 80% at 90% 30%, #3b5b9a66 0%, transparent 60%), linear-gradient(160deg, #0b1426 0%, #16294a 100%)',
  rose: 'radial-gradient(100% 80% at 80% 0%, #f3c6cf 0%, transparent 60%), radial-gradient(80% 70% at 0% 100%, #e9a5b3aa 0%, transparent 60%), linear-gradient(160deg, #fbf1ef 0%, #f6dfe2 100%)',
  garden: 'radial-gradient(90% 80% at 10% 0%, #c9d8b6 0%, transparent 60%), radial-gradient(80% 70% at 100% 100%, #a9bf93aa 0%, transparent 60%), linear-gradient(160deg, #f7f3ea 0%, #e6ecd9 100%)',
  city: 'radial-gradient(100% 80% at 80% 10%, #4f7cff55 0%, transparent 55%), radial-gradient(70% 60% at 0% 100%, #22d3ee33 0%, transparent 60%), linear-gradient(160deg, #0a0f1f 0%, #111a33 100%)',
}

/** Guest categories (client round 1, R2). Anyone without one is Regular. */
export const GUEST_CATEGORIES = ['VIP', 'Media', 'Regular', 'Vendor']
export const guestCategory = (g) => (GUEST_CATEGORIES.includes(g?.category) ? g.category : 'Regular')
/** Case-insensitive match to a category name; anything else is Regular. */
export const toCategory = (v = '') => GUEST_CATEGORIES.find((c) => c.toLowerCase() === String(v).trim().toLowerCase()) || 'Regular'

/** Most people one invitation may bring, including the guest (R6: raised from 10). */
export const MAX_PAX_LIMIT = 50

/**
 * A guest's personal-link key (R3): opening /invite/<event>?g=<token> brings back their reply
 * and QR on any device. Random for new guests; the seed derives its own deterministically.
 * Prototype: the backend will issue these server-side.
 */
// Table numbers are free text (round 4): "T1", "VIP-1", "Garden 3"… trimmed and capped.
export const MAX_TABLE_LENGTH = 30
export const cleanTable = (v = '') => String(v ?? '').trim().slice(0, MAX_TABLE_LENGTH)
/** What a table field should save: the draft when it differs from the saved table, else null. */
export const pendingTable = (draft, saved) => (cleanTable(draft) !== cleanTable(saved) ? String(draft ?? '') : null)
/** Suggestions for a table field: the event's own tables, then every table already typed. */
export function tableSuggestions(event, guests = []) {
  const seen = new Set()
  for (const tb of [...(event?.tables || []), ...guests.map((g) => g.table)]) {
    const v = cleanTable(tb)
    if (v) seen.add(v)
  }
  return [...seen]
}

export const newGuestToken = () => Math.random().toString(36).slice(2, 10).padEnd(8, '0')

// ---------------------------------------------------------------------------
// Custom RSVP questions (R7): per event, built by Oscenia staff, answered on the invitation.
// ---------------------------------------------------------------------------
export const QUESTION_TYPES = { text: 'Short text', choice: 'Multiple choice', dropdown: 'Dropdown' }
export const MAX_QUESTIONS = 10
export const MAX_ANSWER_LENGTH = 500

const hasOptions = (q) => q.type === 'text' || (q.options || []).length >= 2

/**
 * The questions a guest is asked, given their reply (true = accepting, false = declining,
 * null = not chosen yet). A choice or dropdown with fewer than two options is not ready and
 * is skipped, and so is a blank question.
 */
export function questionsFor(event, attending) {
  return (event?.customFields || []).filter((q) => q.label?.trim() && hasOptions(q) && (attending === true || !q.attendingOnly))
}

const isEmpty = (v) => (Array.isArray(v) ? v.length === 0 : !String(v ?? '').trim())

/**
 * The only place answers are checked, for the form and the store alike. Keeps answers to the
 * questions this guest is asked; drops options that do not exist; one value unless the
 * question allows several; text trimmed and capped. `missing` lists required questions left
 * empty (by label).
 */
export function cleanAnswers(event, attending, raw = {}) {
  const answers = {}
  const missing = []
  for (const q of questionsFor(event, attending)) {
    let v = raw[q.id]
    if (q.type === 'text') {
      v = String(v ?? '').trim().slice(0, MAX_ANSWER_LENGTH)
    } else {
      const picked = (Array.isArray(v) ? v : v ? [v] : []).filter((o) => q.options.includes(o))
      v = q.type === 'choice' && q.multi ? [...new Set(picked)] : picked[0] || ''
    }
    if (isEmpty(v)) {
      if (q.required) missing.push(q.label.trim())
    } else {
      answers[q.id] = v
    }
  }
  return { answers, missing }
}

/** An answer as text for tables and CSV: several choices joined with "; ". */
export const answerText = (value) => (Array.isArray(value) ? value.join('; ') : value || '')

/** How often each option was picked by guests attending — the catering numbers. */
export function answerCounts(q, guests) {
  const attending = guests.filter((g) => g.rsvp === 'Attending')
  const counts = Object.fromEntries((q.options || []).map((o) => [o, 0]))
  let none = 0
  for (const g of attending) {
    const v = g.answers?.[q.id]
    const picked = (Array.isArray(v) ? v : v ? [v] : []).filter((o) => Object.hasOwn(counts, o))
    if (!picked.length) none++
    for (const o of picked) counts[o]++
  }
  return { counts, none }
}

/** The checkpoint every event starts with (R1). */
export const DEFAULT_CHECKPOINTS = [{ id: 'CP-1', name: 'Main Entrance', categories: [] }]
export const eventCheckpoints = (event) => (event?.checkpoints?.length ? event.checkpoints : DEFAULT_CHECKPOINTS)
/** Whether a checkpoint admits this guest: an empty category list means everyone. */
export const checkpointAdmits = (cp, guest) => !cp?.categories?.length || cp.categories.includes(guestCategory(guest))

/** A real calendar date as YYYY-MM-DD (rejects '', '2026-02-30', …). */
export function isIsoDate(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v || '')) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}

/** Normalised for matching: digits only for phones (leading 0 → 62), lower-case emails. */
export const normPhone = (p = '') => {
  const d = p.replace(/\D/g, '')
  return d.startsWith('0') ? `62${d.slice(1)}` : d
}
export const normEmail = (e = '') => e.trim().toLowerCase()

/**
 * The guest an RSVP belongs to. The phone decides first. An email match only claims a guest
 * who has not replied yet: a couple or an office sharing one inbox must not overwrite each
 * other's replies. Anyone else (a forwarded link) becomes a new, off-list guest.
 */
export function matchGuest(guests, eventId, { phone, email }) {
  const p = normPhone(phone)
  const e = normEmail(email)
  const mine = guests.filter((g) => g.eventId === eventId)
  const byPhone = p && mine.find((g) => normPhone(g.phone) === p)
  if (byPhone) return byPhone
  // Only when exactly one unreplied guest has that email — two people on one inbox is
  // ambiguous, and guessing would put one person's answer under the other's name.
  const byEmail = e ? mine.filter((g) => normEmail(g.email) === e && !g.rsvp) : []
  return byEmail.length === 1 ? byEmail[0] : undefined
}

/** RSVPs close at the deadline (end of that day) and never reopen after the event. */
export function rsvpOpen(event, today = DEMO_TODAY) {
  if (typeof event.rsvpOpen === 'boolean') return event.rsvpOpen // from the server
  return event.status === 'Published' && today <= event.rsvpDeadline && today <= event.date
}

export function guestStatus(g) {
  if (g.walkIn) return 'Walk-in'
  return g.rsvp || 'No response'
}

export function eventStats(guests) {
  const attending = guests.filter((g) => g.rsvp === 'Attending')
  return {
    invited: guests.filter((g) => g.onMasterList).length,
    attending: attending.length,
    declined: guests.filter((g) => g.rsvp === 'Declined').length,
    noResponse: guests.filter((g) => g.onMasterList && !g.rsvp && !g.walkIn).length,
    pax: attending.reduce((n, g) => n + (g.pax || 1), 0),
    allergies: attending.filter((g) => g.allergies).length,
    offList: guests.filter((g) => !g.onMasterList && !g.walkIn).length,
    checkedIn: guests.filter((g) => g.checkedInAt).length,
    walkIns: guests.filter((g) => g.walkIn).length,
  }
}

/** The four cells of the post-event reconciliation grid (BRD §4.5). */
export function reconcile(guests) {
  const yes = (g) => g.rsvp === 'Attending'
  const came = (g) => Boolean(g.checkedInAt)
  return {
    rsvpCame: guests.filter((g) => yes(g) && came(g)),
    rsvpNoShow: guests.filter((g) => yes(g) && !came(g)),
    noRsvpCame: guests.filter((g) => !yes(g) && came(g)),
    noRsvpNoShow: guests.filter((g) => !yes(g) && !came(g)),
  }
}

/** What the guest's QR code carries: which event, which guest. The desk scans this. */
// Signed in, the server's signed code (`OSC1:...`) comes with the guest and is the only one it accepts.
export const qrPayload = (guest) => guest.qr || `OSCENIA:${guest.eventId}:${guest.id}`

export function parseQr(text) {
  const m = /^OSCENIA:(EV-\d+):(G-\d+)$/.exec(text.trim())
  return m ? { eventId: m[1], guestId: m[2] } : null
}

/** Fills a message template: {name} {event} {date} {venue} {link} {feedback}. */
export function fillTemplate(template, { guest, event, link }) {
  return template
    .replaceAll('{name}', guest?.name?.split(' ')[0] || 'there')
    .replaceAll('{event}', event.name)
    .replaceAll('{date}', event.date)
    .replaceAll('{venue}', event.venue)
    .replaceAll('{link}', link || '')
    .replaceAll('{feedback}', safeLink(event.feedbackUrl || ''))
}

/** A guest's own invitation link (R3), from the event link. */
export const personalLink = (eventLink, guest) => (guest?.token ? `${eventLink}?g=${guest.token}` : eventLink)

// Invitation content is typed by the client and shown on a public page, so links and images
// are allow-listed: http(s) links only (no `javascript:`), and images only as uploaded data.
export const safeLink = (url = '') => (/^https?:\/\/[^\s"'<>]+$/i.test(url.trim()) ? url.trim() : '')
export const safeImage = (src = '') => (/^data:image\/(png|jpe?g|webp);base64,[a-z0-9+/=]+$/i.test(src) ? src : '')

/**
 * The client's guest list as CSV. Columns by header (name, phone, email, table, category — any order,
 * any case); without a header row, that order is assumed. Quoted cells may hold commas.
 */
export function parseGuestCsv(text) {
  const rows = []
  const lines = text.split(/\r?\n/)
  // Excel in an Indonesian (or most European) locale saves CSV with semicolons.
  const first = lines.find((l) => l.trim()) || ''
  const sep = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ','
  for (const raw of lines) {
    if (!raw.trim()) continue
    const cells = []
    let cell = ''
    let quoted = false
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i]
      if (quoted) {
        if (ch === '"' && raw[i + 1] === '"') { cell += '"'; i++ }
        else if (ch === '"') quoted = false
        else cell += ch
      } else if (ch === '"') quoted = true
      else if (ch === sep) { cells.push(cell.trim()); cell = '' }
      else cell += ch
    }
    cells.push(cell.trim())
    rows.push(cells)
  }
  if (!rows.length) return []
  const head = rows[0].map((h) => h.toLowerCase())
  const hasHeader = head.includes('name') || head.includes('phone')
  const col = (name, fallback) => (hasHeader ? head.indexOf(name) : fallback)
  const idx = { name: col('name', 0), phone: col('phone', 1), email: col('email', 2), table: col('table', 3), category: col('category', 4) }
  return rows.slice(hasHeader ? 1 : 0)
    .map((r) => ({
      name: r[idx.name] || '',
      phone: r[idx.phone] || '',
      email: idx.email >= 0 ? r[idx.email] || '' : '',
      table: idx.table >= 0 ? r[idx.table] || '' : '',
      category: toCategory(idx.category >= 0 ? r[idx.category] : ''),
    }))
    .filter((r) => r.name && r.phone)
}

/**
 * Guests a message rule reaches. Before the event: those attending, or listed guests yet to
 * reply. After it (R4): those who came, or those who said yes and did not.
 */
export function reminderAudience(rule, guests) {
  switch (rule.audience) {
    case 'attending': return guests.filter((g) => g.rsvp === 'Attending')
    case 'attended': return guests.filter((g) => g.checkedInAt)
    case 'noshow': return guests.filter((g) => g.rsvp === 'Attending' && !g.checkedInAt)
    default: return guests.filter((g) => g.onMasterList && !g.rsvp && !g.walkIn)
  }
}

export const AUDIENCES = {
  before: { attending: 'Guests attending', pending: 'Guests who have not replied' },
  after: { attended: 'Guests who came', noshow: 'RSVP’d but did not come' },
}

/** "D-3" before the event, "D+1" after it. */
export const ruleLabel = (rule) => `D${rule.when === 'after' ? '+' : '-'}${rule.daysBefore}`

/** The date a rule fires: n days before the event, or after it for a follow-up. */
export function reminderDate(event, days, when = 'before') {
  if (!isIsoDate(event.date)) return ''
  const d = new Date(`${event.date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + (when === 'after' ? days : -days))
  return d.toISOString().slice(0, 10)
}
