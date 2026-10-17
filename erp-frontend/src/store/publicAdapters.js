// The server's public payloads (guest invitation, walk-in desk, client link) → the shapes the
// invitation components already read. Pure functions: no store, no network.
//
// The guest page, the renderer and the editor were written against the demo store's event, so the
// server's are bent to it. `server: true` marks an event that came from the API, so the forms know
// to ask the server instead of the demo store.

import { wall } from './chatAdapters.js'

const inviteOf = (i) => ({
  templateId: i?.templateId ?? null,
  accent: i?.accent ?? null,
  on: i?.on || {},
  content: i?.content || {},
})

const quiet = {
  review: { state: 'editing', submittedAt: null, submittedBy: null, note: '', returnedAt: null },
  tables: [],
  checkpoints: [],
  broadcasts: [],
  reminders: [],
  sendLog: [],
}

const question = (q) => ({
  id: q.key,
  label: q.label,
  type: q.type,
  options: q.options || [],
  multi: Boolean(q.multi),
  required: Boolean(q.required),
  attendingOnly: Boolean(q.attendingOnly),
})

/** The caller's own guest row (a personal link, or the reply they just made). */
export function publicGuest(g, eventNo) {
  if (!g) return null
  return {
    id: g.id,
    uuid: g.id,
    eventId: eventNo,
    token: g.token,
    qr: g.qr,
    name: g.name,
    phone: g.phone,
    email: g.email || '',
    rsvp: g.rsvp || null,
    pax: g.pax ?? 0,
    allergies: g.allergies || '',
    answers: g.answers || {},
  }
}

/** `GET /public/invites/{eventNo}` → the event the guest page renders. */
export function publicEvent(d) {
  const e = d.event
  const live = inviteOf(d.invite)
  return {
    ...quiet,
    server: true,
    id: e.eventNo,
    name: e.name,
    date: e.date,
    time: e.time,
    venue: e.venue,
    // Only a published event reaches a guest at all.
    status: 'Published',
    rsvpDeadline: e.rsvpDeadline,
    rsvpOpen: Boolean(e.rsvpOpen),
    isPast: Boolean(e.isPast),
    maxPax: e.maxPax,
    rsvpFields: e.rsvpFields,
    holdWishes: Boolean(e.holdWishes),
    customFields: (d.questions || []).map(question),
    // The server already left out what a guest may not see.
    wishes: (d.wishes || []).map((w) => ({ id: w.id, guestId: null, name: w.name, text: w.text, at: wall(w.at), hidden: false, approved: true })),
    invite: live,
    published: live,
  }
}

/** `GET /public/walkin/{eventNo}` → what the desk form needs to draw itself. */
export function walkInPage(d) {
  return {
    id: d.eventNo,
    name: d.name,
    invite: { templateId: d.templateId ?? null, accent: d.accent ?? null, on: {}, content: { cover: { title: d.coverTitle || '' } } },
    template: d.template || null,
  }
}

const wishOf = (w) => ({
  id: w.id,
  guestId: null,
  name: w.name,
  text: w.text,
  at: wall(w.at),
  hidden: w.state === 'hidden',
  approved: w.state !== 'waiting',
})

/** A guest from the client's list (for sending invitations from their own phone). */
export const clientGuest = (g, eventNo) => ({
  id: g.id,
  uuid: g.id,
  eventId: eventNo,
  token: g.token,
  name: g.name,
  phone: g.phone,
  email: '',
  category: g.category,
  onMasterList: true,
  walkIn: false,
  rsvp: null,
  pax: 0,
  answers: {},
  invitedAt: g.invitedAt ? wall(g.invitedAt) : null,
  invitedVia: g.invitedVia || null,
})

const reviewOf = (r) => ({
  state: r?.state || 'editing',
  submittedAt: null,
  submittedBy: 'client',
  note: r?.note || '',
  returnedAt: null,
})

/** The client's draft as the editor reads it (`invite` is the draft, `published` what guests see). */
export function clientDraft(draft) {
  return {
    invite: inviteOf(draft.invite),
    published: draft.published ? { templateId: draft.published.templateId ?? draft.published.template_id ?? null, accent: draft.published.accent ?? null, on: draft.published.on || {}, content: draft.published.content || {} } : null,
    review: reviewOf(draft.review),
  }
}

/** `GET /public/client/{eventNo}` → the event, the studio templates and the guest list. */
export function clientView(d, key) {
  const e = d.event
  return {
    event: {
      ...quiet,
      server: true,
      id: e.eventNo,
      name: e.name,
      status: e.status,
      date: e.date,
      rsvpDeadline: e.rsvpDeadline,
      holdWishes: Boolean(e.holdWishes),
      customFields: [],
      wishes: (d.wishes || []).map(wishOf),
      editToken: key,
      ...clientDraft(d.draft),
    },
    templates: (d.templates || []).map((t) => ({ ...t, createdAt: '', updatedAt: '', by: '', usedByEvents: 0, liveEvents: 0 })),
    guests: (d.guests || []).map((g) => clientGuest(g, e.eventNo)),
  }
}

export { wishOf as clientWish }
