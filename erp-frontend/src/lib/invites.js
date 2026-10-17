// Invitation content (Invitations v2): the draft staff and the client edit, the published copy
// guests see, and the helpers both share. Pure functions; scripts/verify-proto.mjs runs them.
import { templateById, templateOf, sectionOn, SECTIONS, MUSIC } from './templates.js'
import { safeImage, safeLink, reminderDate, ruleLabel, isIsoDate } from './events.js'

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** "2026-08-14" → "Friday, 14 August 2026" */
export function longDate(iso) {
  if (!iso) return ''
  const d = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return ''
  return `${WEEKDAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

/** Every section's content, empty. Lists start empty so an untouched section stays hidden. */
export function blankContent({ name = '', date = '', time = '', venue = '' } = {}) {
  return {
    cover: { eyebrow: 'You are invited', title: name, subtitle: '', image: null },
    message: { body: 'We would be delighted to have you with us.' },
    couple: { a: { name: '', parents: '', photo: null, ig: '' }, b: { name: '', parents: '', photo: null, ig: '' } },
    hosts: { names: '', logos: [] },
    countdown: {},
    details: { name: '', date, time, venue, mapUrl: '', sessions: [] },
    agenda: { rows: [] },
    speakers: { people: [] },
    story: { items: [] },
    dresscode: { text: '' },
    gallery: { photos: [] },
    video: { kind: 'link', url: '', file: null },
    music: { kind: 'builtin', trackId: 'soft-piano', file: null },
    rsvp: {},
    wishes: {},
    gift: { accounts: [], address: '' },
  }
}

/** A new event's invitation: no template yet, so staff or the client start in the gallery. */
export function blankInvite(event) {
  return { templateId: null, accent: null, on: {}, content: blankContent(event) }
}

/**
 * Does a section have anything to show? An empty section is skipped on the guest page rather
 * than drawn as a blank band; the editor says what to add.
 */
export function hasContent(sectionId, c) {
  switch (sectionId) {
    case 'message': return Boolean(c.message?.body?.trim())
    case 'couple': return Boolean(c.couple?.a?.name?.trim() || c.couple?.b?.name?.trim())
    case 'hosts': return Boolean(c.hosts?.names?.trim() || c.hosts?.logos?.length)
    case 'agenda': return c.agenda?.rows?.some((r) => r.label?.trim()) || false
    case 'speakers': return c.speakers?.people?.some((p) => p.name?.trim()) || false
    case 'story': return c.story?.items?.some((s) => s.title?.trim() || s.text?.trim()) || false
    case 'dresscode': return Boolean(c.dresscode?.text?.trim())
    case 'gallery': return Boolean(c.gallery?.photos?.length)
    case 'video': return Boolean(c.video?.kind === 'upload' ? c.video.file : c.video?.url?.trim())
    case 'gift': return Boolean(c.gift?.accounts?.some((a) => a.number?.trim()) || c.gift?.address?.trim())
    case 'countdown': return Boolean(c.details?.date)
    default: return true // cover, details, rsvp, wishes
  }
}

/** The sections a renderer draws, in the template's order. */
export function visibleSections(invite, { includeEmpty = false } = {}) {
  const tpl = templateOf(invite)
  if (!tpl) return []
  return tpl.sections.filter((s) => sectionOn(invite, s) && (includeEmpty || hasContent(s, invite.content)))
}

/**
 * Who uses a template (Template Studio): every event whose draft or published copy names it,
 * and how many of those guests can see right now — they show any change to it at once.
 */
export function templateUsage(events, templateId) {
  const uses = events.filter((e) => e.invite?.templateId === templateId || e.published?.templateId === templateId)
  return { events: uses.length, live: uses.filter((e) => liveInvite(e)?.templateId === templateId).length }
}

/** The invitation guests see — null until staff publish it (D7). */
export const liveInvite = (event) => (event?.status === 'Published' ? event.published : null)

/**
 * The pre-v2 single-layout design → the new model, so the two seed events (and anything built
 * on the old shape) keep their words (D12).
 */
export function fromLegacyDesign(event, design, templateId) {
  const content = blankContent(event)
  content.cover = { eyebrow: design.eyebrow || '', title: design.headline || event.name, subtitle: design.subheadline || '', image: design.heroImage || null }
  content.message.body = design.body || ''
  content.details.mapUrl = design.mapUrl || ''
  content.agenda.rows = (design.schedule || []).map((r) => ({ time: r.time || '', label: r.label || '' }))
  content.dresscode.text = design.dressCode || ''
  return { templateId, accent: null, on: {}, content }
}

/** YouTube / Vimeo page link → its embed URL, or '' for anything else. */
export function videoEmbed(url) {
  let u
  try { u = new URL(String(url || '').trim()) } catch { return '' }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return ''
  const host = u.hostname.replace(/^www\.|^m\./, '')
  const id = host === 'youtu.be' ? u.pathname.slice(1)
    : host === 'youtube.com' ? (u.searchParams.get('v') || u.pathname.match(/^\/(?:embed|shorts)\/([\w-]+)/)?.[1])
      : null
  if (id && /^[\w-]{6,20}$/.test(id)) return `https://www.youtube-nocookie.com/embed/${id}`
  const vimeo = host === 'vimeo.com' && u.pathname.match(/^\/(\d{5,12})/)?.[1]
  return vimeo ? `https://player.vimeo.com/video/${vimeo}` : ''
}

/** Days, hours and minutes from `nowIso` (the demo clock) to the event; null once it has begun. */
export function countdownTo(date, time, nowIso) {
  if (!date) return null
  const target = Date.parse(`${date}T${time || '00:00'}:00Z`)
  const now = Date.parse(`${nowIso}:00Z`)
  if (Number.isNaN(target) || Number.isNaN(now) || target <= now) return null
  const mins = Math.floor((target - now) / 60000)
  return { days: Math.floor(mins / 1440), hours: Math.floor((mins % 1440) / 60), minutes: mins % 60 }
}

/** How much each list may hold, so a pasted spreadsheet cannot swamp the page or the store. */
export const LIMITS = { photos: 12, logos: 6, people: 12, rows: 30, items: 10, sessions: 4, accounts: 4 }
const TEXT_MAX = 300
const LONG_TEXT = new Set(['body', 'text', 'address'])
const MEDIA_KEYS = new Set(['image', 'photo', 'photos', 'logos', 'file'])

/**
 * One section's content as saved: strings trimmed to length, lists capped, and media fields
 * holding only a stored reference (lib/mediaStore.js) or nothing. Links are kept as typed —
 * the page checks them when drawing (safeLink, videoEmbed) so typing "htt…" is not wiped.
 */
export function cleanSection(value) {
  const walk = (v, key) => {
    // A photo field holds a stored reference; an older inline photo (data URL) is kept whole.
    if (MEDIA_KEYS.has(key) && typeof v === 'string') return safeImage(v) ? v : null
    if (typeof v === 'string') return v.slice(0, LONG_TEXT.has(key) ? 2000 : TEXT_MAX)
    if (Array.isArray(v)) {
      const list = v.map((x) => walk(x, key))
      return (MEDIA_KEYS.has(key) ? list.filter(Boolean) : list).slice(0, LIMITS[key] ?? 50)
    }
    if (v && typeof v === 'object') {
      if ('key' in v && 'size' in v) return typeof v.key === 'string' ? { key: v.key, name: String(v.name || '').slice(0, 120), size: Number(v.size) || 0, type: String(v.type || '') } : null
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]))
    }
    return typeof v === 'boolean' || typeof v === 'number' || v === null ? v : null
  }
  return walk(value, '')
}

/** Built-in background tracks (Invitations v2): generated in the browser, see lib/music.js. */
export const MUSIC_TRACKS = [
  { id: 'soft-piano', name: 'Soft piano' },
  { id: 'warm-strings', name: 'Warm strings' },
  { id: 'evening-glow', name: 'Evening glow' },
]

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/**
 * What publishing the draft would change for guests (D7/D8), for the staff review panel:
 * the template, the accent, sections switched on or off, sections edited — and, when the date
 * moves, which reminders move with it and whether RSVPs would close after the new date.
 */
export function inviteChanges(event) {
  const draft = event.invite
  const live = event.published
  const d = draft.content.details
  const newDate = isIsoDate(d.date) ? d.date : event.date
  const out = { first: !live, changes: [], dateShift: null, venueChange: null, reminders: [], deadlineAfterDate: event.rsvpDeadline > newDate }
  if (newDate !== event.date) {
    out.dateShift = { from: event.date, to: newDate }
    const moved = { ...event, date: newDate }
    out.reminders = (event.reminders || []).filter((r) => r.active).map((r) => ({
      label: ruleLabel(r), from: reminderDate(event, r.daysBefore, r.when), to: reminderDate(moved, r.daysBefore, r.when),
    }))
  }
  if ((d.venue || '') !== (event.venue || '') || (d.time || '') !== (event.time || '')) {
    out.venueChange = { from: `${event.time} · ${event.venue}`, to: `${d.time} · ${d.venue}` }
  }
  if (!live) return out

  const name = (id) => (id === MUSIC ? 'Background music' : SECTIONS[id]?.label || id)
  if (draft.templateId !== live.templateId) out.changes.push(`Template: ${templateById(live.templateId)?.name} → ${templateById(draft.templateId)?.name}`)
  if ((draft.accent || null) !== (live.accent || null)) out.changes.push('Accent colour')
  const tpl = templateById(draft.templateId)
  for (const s of [...(tpl?.sections || []), MUSIC]) {
    const now = s === MUSIC ? Boolean(draft.on?.[MUSIC]) : sectionOn(draft, s)
    const was = s === MUSIC ? Boolean(live.on?.[MUSIC]) : sectionOn(live, s)
    if (now !== was) out.changes.push(`${name(s)}: ${now ? 'shown' : 'hidden'}`)
    else if (now && !same(draft.content[s === MUSIC ? 'music' : s], live.content[s === MUSIC ? 'music' : s])) out.changes.push(`${name(s)}: edited`)
  }
  return out
}

/** Has the draft moved on from what guests see? */
export const hasUnpublishedChanges = (event) => Boolean(event.published) && !same(event.invite, event.published)

// --- wishes (D13) ---------------------------------------------------------------------

/** How long a wish may be, and how many one guest (or one name, off the list) may leave. */
export const WISH_LIMITS = { text: 500, name: 80, perGuest: 3, total: 500 }

/**
 * The wishes guests see: not hidden, and — while the event holds wishes for approval —
 * approved. A wish left while the hold was off is approved as it arrives, so switching the
 * hold on later does not take it down.
 */
export const visibleWishes = (event) => (event?.wishes || []).filter((w) => !w.hidden && (!event.holdWishes || w.approved))

/** A wish's state for the moderation list: shown | waiting | hidden. */
export const wishState = (event, w) => (w.hidden ? 'hidden' : event.holdWishes && !w.approved ? 'waiting' : 'shown')

// --- Add to calendar (.ics) ---------------------------------------------------------

// Event times are wall-clock times at the venue. The prototype takes every venue to be on
// Jakarta time (WIB, UTC+7, no daylight saving); the backend will store each event's zone.
const TZ = 'Asia/Jakarta'
const TZ_OFFSET_MIN = 7 * 60
const EVENT_HOURS = 3 // the model has no end time: a calendar entry gets three hours

const icsText = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1')
const isTime = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t || '')
// "2026-08-14" + minutes from that midnight → "20260814T190000" (minutes may cross midnight).
const icsLocal = (date, mins) => new Date(Date.parse(`${date}T00:00:00Z`) + mins * 60000).toISOString().replace(/[-:]/g, '').slice(0, 15)
const icsDay = (date, plusDays = 0) => icsLocal(date, plusDays * 1440).slice(0, 8)
const utf8 = new TextEncoder()

/** Lines longer than 75 octets continue on the next line after a space (RFC 5545 §3.1). */
function fold(line) {
  const out = []
  let cur = ''
  let bytes = 0
  for (const ch of line) {
    const n = utf8.encode(ch).length
    // A continuation line starts with a space, which counts toward its 75.
    if (bytes + n > (out.length ? 74 : 75)) {
      out.push(cur)
      cur = ''
      bytes = 0
    }
    cur += ch
    bytes += n
  }
  out.push(cur)
  return out.join('\r\n ')
}

/**
 * The invitation as a calendar file: one entry for the main event and one per extra session
 * with a date (a wedding's ceremony and reception). `link` goes in the description so the
 * guest can find their invitation again; `now` is the demo clock ("2026-07-26T10:30", WIB).
 */
export function icsFile(event, invite, { link = '', now = '' } = {}) {
  const c = invite.content
  const d = c.details
  const title = c.cover.title || event?.name || 'Invitation'
  const items = [{ ...d, name: title }, ...(d.sessions || []).map((s) => ({ ...s, name: `${title} — ${s.name || 'Session'}` }))]
    .filter((x) => isIsoDate(x.date))
  const [sd, st] = (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(now) ? now : '2026-01-01T00:00').split('T')
  const [sh, sm] = st.split(':').map(Number)
  const dtstamp = `${icsLocal(sd, sh * 60 + sm - TZ_OFFSET_MIN)}Z`
  const url = safeLink(link)
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Oscenia Events//Invitations//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VTIMEZONE', `TZID:${TZ}`, 'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:+0700', 'TZOFFSETTO:+0700', 'TZNAME:WIB', 'END:STANDARD', 'END:VTIMEZONE',
  ]
  items.forEach((x, i) => {
    lines.push('BEGIN:VEVENT', `UID:${event?.id || 'sample'}-${i}@invite.oscenia.events`, `DTSTAMP:${dtstamp}`)
    if (isTime(x.time)) {
      const [h, m] = x.time.split(':').map(Number)
      const start = h * 60 + m
      lines.push(`DTSTART;TZID=${TZ}:${icsLocal(x.date, start)}`, `DTEND;TZID=${TZ}:${icsLocal(x.date, start + EVENT_HOURS * 60)}`)
    } else {
      lines.push(`DTSTART;VALUE=DATE:${icsDay(x.date)}`, `DTEND;VALUE=DATE:${icsDay(x.date, 1)}`)
    }
    lines.push(`SUMMARY:${icsText(x.name)}`)
    if (x.venue) lines.push(`LOCATION:${icsText(x.venue)}`)
    if (url) lines.push(`DESCRIPTION:${icsText(`Your invitation: ${url}`)}`, `URL:${url}`)
    lines.push('END:VEVENT')
  })
  lines.push('END:VCALENDAR')
  return `${lines.map(fold).join('\r\n')}\r\n`
}

/** "Rama & Sinta" → "rama-sinta.ics" */
export function icsName(title) {
  const slug = String(title || '').normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-').toLowerCase().slice(0, 60)
  return `${slug || 'invitation'}.ics`
}
