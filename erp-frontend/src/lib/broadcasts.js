// Sending invitations (Invitations v2, D9): Oscenia's platform send by WhatsApp and/or email,
// and the client sending each guest their own link from their own WhatsApp. Pure helpers,
// shared by the store, the Send invitations screens and scripts/verify-proto.mjs.
//
// Prototype: the platform send is simulated. Each guest's outcome is worked out from their
// contact details and their link key, so the same guest always gets the same result. The
// backend sends through a WhatsApp Business API provider and an email service.
import { DEMO_TODAY } from './format.js'
import { fillTemplate, normPhone, guestCategory, GUEST_CATEGORIES } from './events.js'
import { isEmail } from './crm.js'
import { longDate } from './invites.js'

export const BROADCAST_CHANNELS = { whatsapp: 'WhatsApp', email: 'Email', both: 'WhatsApp + email' }
export const BROADCAST_LIMITS = { message: 1000, subject: 150 }
export const PLACEHOLDERS = ['{name}', '{link}', '{event}', '{date}', '{venue}']

export const DEFAULT_INVITE_MESSAGE = 'Dear {name}, you are warmly invited to {event} on {date} at {venue}. Your personal invitation, with your RSVP and QR code: {link}'
export const DEFAULT_INVITE_SUBJECT = 'You are invited: {event}'

/** Status of one message, in the order it moves; `failed` can happen at any point. */
export const DELIVERY_STATUSES = ['queued', 'sent', 'delivered', 'read', 'failed']

/** 'all', 'not_invited' or a guest category. */
export const isAudience = (a) => a === 'all' || a === 'not_invited' || GUEST_CATEGORIES.includes(a)
/** How a batch's audience reads in the history and the send log. */
export const audienceLabel = (a) => (a === 'all' ? 'all guests' : a === 'not_invited' ? 'not invited yet' : a)

/**
 * The guests a batch goes to. Only the client's list: walk-ins came to the desk, and a guest
 * who replied from a forwarded link already has the invitation.
 */
export function broadcastAudience(guests, audience) {
  const listed = guests.filter((g) => g.onMasterList && !g.walkIn)
  if (audience === 'all') return listed
  if (audience === 'not_invited') return listed.filter((g) => !g.invitedAt)
  return GUEST_CATEGORIES.includes(audience) ? listed.filter((g) => guestCategory(g) === audience) : []
}

// FNV-1a: a stable number from a string, so a simulated result never changes between runs.
const hash = (s) => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

/**
 * The simulated outcome of one message to one guest on one channel. No phone number fails on
 * WhatsApp, a missing or broken email fails on email; otherwise it is read, delivered or (the
 * phone is off) only sent — decided by the guest's link key.
 */
export function deliveryOf(guest, channel) {
  if (channel === 'whatsapp' && normPhone(guest.phone || '').length < 8) return { status: 'failed', reason: 'No phone number' }
  if (channel === 'email') {
    if (!String(guest.email || '').trim()) return { status: 'failed', reason: 'No email address' }
    if (!isEmail(guest.email)) return { status: 'failed', reason: 'Email address is not valid' }
  }
  const h = hash(`${guest.token}:${channel}`) % 10
  return { status: h < 4 ? 'read' : h < 9 ? 'delivered' : 'sent', reason: '' }
}

/** One recipient row per guest per channel ("both" = a WhatsApp row and an email row). */
export function recipientRows(guests, channel, at) {
  const chans = channel === 'both' ? ['whatsapp', 'email'] : [channel]
  return guests.flatMap((g) => chans.map((c) => ({ guestId: g.id, channel: c, ...deliveryOf(g, c), at })))
}

/** Rows by status, for a batch's summary line. */
export function statusCounts(recipients = []) {
  const out = Object.fromEntries(DELIVERY_STATUSES.map((s) => [s, 0]))
  for (const r of recipients) out[r.status] = (out[r.status] || 0) + 1
  return out
}

/** The message as this guest receives it, with their own link and the date written out. */
export const inviteMessage = (template, event, guest, link) =>
  fillTemplate(template, { guest, event: { ...event, date: longDate(event.date) || event.date }, link })

/** WhatsApp's click-to-chat link: opens a chat with the guest, the message typed in. */
export const waLink = (phone, text) => `https://wa.me/${normPhone(phone || '')}?text=${encodeURIComponent(text)}`

const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/

/**
 * Why a batch cannot go out, in words for the screen — or '' when it can. The store refuses
 * on the same rules. `now` (the demo clock) is only needed to check a scheduled time; the
 * screen leaves it out while rendering and the store checks it on save.
 */
export function broadcastProblem(event, guests, { channel, subject = '', message = '', audience, scheduledAt = null } = {}, now = '', today = DEMO_TODAY) {
  if (event?.status !== 'Published') return 'Publish the invitation first — until then guests cannot open their links.'
  if (event.date < today) return 'This event is over.'
  if (!Object.hasOwn(BROADCAST_CHANNELS, channel || '')) return 'Choose WhatsApp, email or both.'
  const text = String(message).trim()
  if (!text) return 'Write a message.'
  if (text.length > BROADCAST_LIMITS.message) return `The message is too long (at most ${BROADCAST_LIMITS.message} characters).`
  if (!text.includes('{link}')) return 'Put {link} in the message — it becomes each guest’s own invitation link.'
  if (channel !== 'whatsapp') {
    if (!String(subject).trim()) return 'Add an email subject.'
    if (String(subject).trim().length > BROADCAST_LIMITS.subject) return `The subject is too long (at most ${BROADCAST_LIMITS.subject} characters).`
  }
  if (!isAudience(audience)) return 'Choose who to send to.'
  if (scheduledAt) {
    if (!STAMP.test(scheduledAt)) return 'Pick a date and time to send.'
    if (now && scheduledAt <= now) return 'Pick a time later than now.'
    if (scheduledAt.slice(0, 10) > event.date) return 'Schedule it before the event.'
  } else if (!broadcastAudience(guests, audience).length) {
    return 'Nobody to send to in this group.'
  }
  return ''
}
