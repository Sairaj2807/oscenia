// Writes the prototype's events seed — EV-01/02/03 with their guests, scans and wishes — to
// erp-backend/app/seed/events_seed.json, which the backend's demo seeder loads.
//
// Exported rather than re-typed: the guest list is generated (names, phones, answers), and
// scripts/verify-proto.mjs asserts exact counts over it (the 16/4/5/6 reconciliation grid).
// A hand port would drift; this keeps the two seeds identical. Re-run after changing
// src/store/protoSeed.js:   node scripts/export-events-seed.mjs
//
// Broadcasts, reminders and the send log are left out: their tables arrive with backend
// Phase 4 (messaging).

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { seedEvents, seedGuests, seedScans } from '../src/store/protoSeed.js'
import { seedClients } from '../src/store/seed.js'

const clientName = Object.fromEntries(seedClients.map((c) => [c.id, c.name]))
const invite = (i) => (i ? { template_id: i.templateId, accent: i.accent ?? null, on: i.on || {}, content: i.content } : null)

const events = seedEvents.map((e) => ({
  event_no: e.id,
  name: e.name,
  client_name: clientName[e.clientId] || null,
  prototype_project: e.projectId || null,
  date: e.date,
  time: e.time,
  venue: e.venue,
  status: e.status,
  rsvp_deadline: e.rsvpDeadline,
  max_pax: e.maxPax,
  rsvp_fields: e.rsvpFields,
  feedback_url: e.feedbackUrl || '',
  hold_wishes: Boolean(e.holdWishes),
  tables: e.tables,
  checkpoints: e.checkpoints,
  questions: e.customFields || [],
  question_seq: e.questionSeq || 0,
  invite: invite(e.invite),
  published: invite(e.published),
  review: e.review,
  wishes: (e.wishes || []).map((w) => ({ guest: w.guestId, name: w.name, text: w.text, at: w.at, hidden: w.hidden, approved: w.approved })),
}))

const guests = seedGuests.map((g) => ({
  key: g.id, event_no: g.eventId, name: g.name, phone: g.phone, email: g.email || '', category: g.category,
  on_master_list: g.onMasterList, rsvp: g.rsvp, pax: g.pax, allergies: g.allergies || '', answers: g.answers || {},
  consent: g.consent, consent_at: g.consentAt, responded_at: g.respondedAt, table: g.table || '', note: g.note || '',
  note_by: g.noteBy, note_at: g.noteAt, checked_in_at: g.checkedInAt, walk_in: g.walkIn,
  invited_at: g.invitedAt, invited_via: g.invitedVia,
}))

const scans = seedScans.map((s) => ({ event_no: s.eventId, guest: s.guestId, checkpoint: s.checkpointId, at: s.at }))

const out = fileURLToPath(new URL('../../erp-backend/app/seed/events_seed.json', import.meta.url))
writeFileSync(out, `${JSON.stringify({ events, guests, scans }, null, 1)}\n`)
console.log(`wrote ${events.length} events, ${guests.length} guests, ${scans.length} scans to ${out}`)
