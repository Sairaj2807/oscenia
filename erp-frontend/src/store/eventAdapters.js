// Server events → the shapes the events screens read, and the small pure helpers the events store
// is built from. Pure functions over plain data (no store, no network), so
// `scripts/verify-event-adapters.mjs` can check them in Node.
//
// The prototype's shapes are what every events screen reads, so the server's are bent to them:
// an event's `id` is its number (`EV-01`, what the routes use) and the server id is kept as
// `uuid`; a guest is keyed by its server id; a question by its key (`Q-1`); times are Jakarta wall
// clock, as in chat. The server's own extras (`rev`-style fields, `stats`, `rsvpOpen`) ride along.

import { wall } from './chatAdapters.js'

/**
 * `lookups.clientNo(uuid)` / `lookups.projectNo(uuid)` turn the finance store's rows into the
 * business ids the screens compare against; unknown ones fall back to the server id, so a screen
 * degrades to showing nothing rather than crashing (and `relink` fixes it once finance loads).
 */
export function adaptEvent(row, lookups = {}) {
  const clientNo = lookups.clientNo || (() => null)
  const projectNo = lookups.projectNo || (() => null)
  const invite = row.invite
  const published = invite?.published
  return {
    id: row.eventNo,
    uuid: row.id,
    name: row.name,
    clientUuid: row.clientId || null,
    projectUuid: row.projectId || null,
    clientId: row.clientId ? clientNo(row.clientId) || row.clientId : '',
    projectId: row.projectId ? projectNo(row.projectId) || row.projectId : '',
    date: row.date,
    time: row.time,
    venue: row.venue,
    status: row.status,
    rsvpDeadline: row.rsvpDeadline,
    maxPax: row.maxPax,
    rsvpFields: row.rsvpFields,
    feedbackUrl: row.feedbackUrl || '',
    holdWishes: Boolean(row.holdWishes),
    rsvpOpen: Boolean(row.rsvpOpen),
    stats: row.stats || null,
    updatedAt: row.updatedAt,
    // The client link's token: read separately, and only by the roles that may (see useEvents).
    editToken: '',
    // The detail carries these; the list does not, so a list row has the empty draft shape until
    // its detail arrives (the store always fetches both before showing it).
    invite: invite
      ? { templateId: invite.templateId ?? null, accent: invite.accent ?? null, on: invite.on || {}, content: invite.content || {} }
      : { templateId: null, accent: null, on: {}, content: { cover: { eyebrow: '', title: '', subtitle: '', image: null } } },
    published: published
      ? { templateId: published.templateId ?? null, accent: published.accent ?? null, on: published.on || {}, content: published.content || {} }
      : null,
    publishedAt: invite?.publishedAt || null,
    hasUnpublishedChanges: Boolean(invite?.hasUnpublishedChanges),
    review: row.review
      ? {
          state: row.review.state,
          submittedAt: row.review.submittedAt ? wall(row.review.submittedAt) : null,
          submittedBy: row.review.submittedBy || null,
          note: row.review.note || '',
          returnedAt: row.review.returnedAt ? wall(row.review.returnedAt) : null,
        }
      : { state: 'editing', submittedAt: null, submittedBy: null, note: '', returnedAt: null },
    customFields: (row.questions || []).map(adaptQuestion),
    checkpoints: (row.checkpoints || []).map(adaptCheckpoint),
    tables: row.tables || [],
    // Not on the server yet (media upload, messaging); kept empty so the screens that list them
    // render an empty state instead of throwing.
    wishes: [],
    broadcasts: [],
    reminders: [],
    sendLog: [],
    detailLoaded: Boolean(row.invite),
  }
}

export const adaptQuestion = (q) => ({
  id: q.key,
  label: q.label,
  type: q.type,
  options: q.options || [],
  multi: Boolean(q.multi),
  required: Boolean(q.required),
  attendingOnly: Boolean(q.attendingOnly),
})

export const adaptCheckpoint = (c) => ({ id: c.id, key: c.key, name: c.name, categories: c.categories || [] })

/** A guest row. `eventNo` is the event's number: the screens filter guests by `g.eventId === ev.id`. */
export function adaptGuest(g, eventNo) {
  return {
    id: g.id,
    uuid: g.id,
    eventId: eventNo,
    token: g.linkToken,
    qr: g.qr,
    name: g.name,
    phone: g.phone,
    email: g.email || '',
    category: g.category,
    onMasterList: Boolean(g.onMasterList),
    walkIn: Boolean(g.walkIn),
    rsvp: g.rsvp || null,
    pax: g.pax ?? null,
    allergies: g.allergies || '',
    answers: g.answers || {},
    consent: Boolean(g.consent),
    consentAt: g.consentAt ? wall(g.consentAt) : null,
    erasedAt: g.erasedAt ? wall(g.erasedAt) : null,
    respondedAt: g.respondedAt ? wall(g.respondedAt) : null,
    table: g.table || '',
    note: g.note || '',
    noteBy: g.noteBy || '',
    noteAt: g.noteAt ? wall(g.noteAt) : null,
    checkedInAt: g.checkedInAt ? wall(g.checkedInAt) : null,
    invitedAt: g.invitedAt ? wall(g.invitedAt) : null,
    invitedVia: g.invitedVia || null,
  }
}

/** A scan-log row (`GET /scans`). The server's id is a number. */
export const adaptScan = (s, eventNo) => ({
  id: `SC-${String(s.id).padStart(3, '0')}`,
  eventId: eventNo,
  guestId: s.guestId,
  checkpointId: s.checkpointId,
  at: wall(s.at),
})

export const adaptWish = (w) => ({
  id: w.id,
  guestId: w.guestId || null,
  name: w.name,
  text: w.text,
  at: wall(w.at),
  hidden: Boolean(w.hidden),
  approved: Boolean(w.approved),
})

/** A studio template. The built-ins are the screens' own static ones; the server's copy of them is
 *  left out here. */
export function adaptTemplate(t) {
  return {
    id: t.id,
    family: t.family,
    name: t.name,
    tagline: t.tagline || '',
    palette: t.palette,
    fonts: t.fonts,
    cover: t.cover,
    ornament: t.ornament,
    sections: t.sections,
    off: t.off || [],
    art: t.art || {},
    status: t.status,
    createdAt: t.updatedAt,
    updatedAt: t.updatedAt,
    by: t.createdByLabel || '',
    usedByEvents: t.usedByEvents ?? 0,
    liveEvents: t.liveEvents ?? 0,
  }
}

export const studioTemplates = (rows) => (rows || []).filter((t) => !t.builtin).map(adaptTemplate)

/** Put an event into the list (by id), keeping the list in the server's order: date, then number.
 *  An older copy (by `updatedAt`) of one already held does not replace the newer. */
export function upsertEvent(list, event) {
  const i = list.findIndex((e) => e.id === event.id)
  const sort = (xs) => [...xs].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
  if (i < 0) return sort([...list, event])
  if (event.updatedAt && list[i].updatedAt && event.updatedAt < list[i].updatedAt) return list
  return list.map((e, j) => (j === i ? { ...event, wishes: event.wishes.length ? event.wishes : list[i].wishes } : e))
}

/** Replace one event's guests, leaving every other event's alone. */
export const replaceGuests = (all, eventNo, fresh) => [...all.filter((g) => g.eventId !== eventNo), ...fresh]
export const replaceScans = (all, eventNo, fresh) => [...all.filter((s) => s.eventId !== eventNo), ...fresh]

/** The message to show for a refused action: the server's own sentence, else a plain one. */
export function whyRefused(err) {
  if (err?.status === 404) return 'That is no longer available to you.'
  if (err?.status === 403 && err.permitted?.length) return `${err.message} (${err.permitted.join(', ')} can do this.)`
  return err?.message || 'The server did not accept that.'
}
