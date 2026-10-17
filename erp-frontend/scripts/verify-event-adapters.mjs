// The events client layer under Node: the adapters, the store's list helpers, and what goes over
// the wire (paths, methods, and above all the invitation content's keys, which must reach the
// server exactly as written).
//
//   npm run verify:events      (vite-node, so the ESM imports resolve like they do in the app)
//
// Fixtures are the server's shapes after the api client has camel-cased them (see
// erp-backend/app/domain/events/schemas.py).

import {
  adaptCheckpoint, adaptEvent, adaptGuest, adaptQuestion, adaptScan, adaptTemplate, adaptWish,
  replaceGuests, replaceScans, studioTemplates, upsertEvent, whyRefused,
} from '../src/store/eventAdapters.js'
import { eventsApi } from '../src/lib/eventsApi.js'
import { eventStats } from '../src/lib/events.js'

let passed = 0
const failures = []
function check(label, ok, detail = '') {
  if (ok) passed += 1
  else failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
}
const section = (name) => console.log(`\n${name}`)

const EV_UUID = '11111111-1111-1111-1111-111111111111'
const CL_UUID = '22222222-2222-2222-2222-222222222222'
const PR_UUID = '33333333-3333-3333-3333-333333333333'
const lookups = { clientNo: (u) => (u === CL_UUID ? 'CL-01' : undefined), projectNo: (u) => (u === PR_UUID ? 'EVT-2026-GALA-01' : undefined) }

const stats = { invited: 4, attending: 2, declined: 1, noResponse: 1, pax: 3, allergies: 1, offList: 1, checkedIn: 2, walkIns: 1 }
const listRow = {
  id: EV_UUID, eventNo: 'EV-01', name: 'Aurora Gala', clientId: CL_UUID, projectId: PR_UUID, date: '2026-08-14', time: '19:00',
  venue: 'Ballroom', status: 'Published', rsvpDeadline: '2026-08-07', maxPax: 2, rsvpFields: { email: true, allergies: true, pax: true },
  feedbackUrl: '', holdWishes: false, rsvpOpen: true, stats, updatedAt: '2026-07-20T10:00:00Z',
}
const detail = {
  ...listRow,
  invite: {
    templateId: 'gala', accent: null, on: { music: true },
    content: { cover: { eyebrow: 'You are invited', title: 'Aurora Gala', subtitle: '', image: null }, details: { name: 'Aurora Gala', mapUrl: 'https://maps.example/x', sessions: [] }, music: { kind: 'builtin', trackId: 'soft-piano', file: null } },
    published: { templateId: 'gala', accent: null, on: { music: true }, content: { cover: { title: 'Aurora Gala' } } },
    publishedAt: '2026-07-19T09:00:00Z', hasUnpublishedChanges: true,
  },
  review: { state: 'submitted', submittedAt: '2026-07-18T03:00:00Z', submittedBy: 'client', note: '', returnedAt: null },
  questions: [{ key: 'Q-1', label: 'Meal', type: 'dropdown', options: ['Beef', 'Fish'], multi: false, required: true, attendingOnly: true }],
  checkpoints: [{ id: 'cp-uuid', key: 'CP-1', name: 'Main Entrance', categories: [] }],
  tables: ['T1', 'T2'],
}

section('An event: the server row becomes the shape the screens read')
{
  const e = adaptEvent(detail, lookups)
  check('id is the event number and the server id is kept', e.id === 'EV-01' && e.uuid === EV_UUID)
  check('client and project are the finance store business ids', e.clientId === 'CL-01' && e.projectId === 'EVT-2026-GALA-01')
  check('and the server ids are kept to re-link', e.clientUuid === CL_UUID && e.projectUuid === PR_UUID)
  check('an unknown client falls back to the server id, not a crash', adaptEvent(detail, {}).clientId === CL_UUID)
  check('no client at all is an empty string', adaptEvent({ ...detail, clientId: null }, lookups).clientId === '')
  check('invite is {templateId, accent, on, content}', e.invite.templateId === 'gala' && e.invite.on.music === true && e.invite.content.details.mapUrl.startsWith('https://'))
  check('content keys stay camelCase (mapUrl, trackId)', 'mapUrl' in e.invite.content.details && e.invite.content.music.trackId === 'soft-piano')
  check('the published copy is kept, and whether it has moved on', e.published.templateId === 'gala' && e.hasUnpublishedChanges === true)
  check('review times are wall clock', e.review.state === 'submitted' && e.review.submittedAt === '2026-07-18T10:00' && e.review.submittedBy === 'client')
  check('questions become customFields keyed by their key', e.customFields.length === 1 && e.customFields[0].id === 'Q-1' && e.customFields[0].attendingOnly === true)
  check('checkpoints keep their id and name', e.checkpoints[0].id === 'cp-uuid' && e.checkpoints[0].name === 'Main Entrance')
  check('the server numbers ride along for the list card', e.stats.invited === 4 && e.stats.noResponse === 1 && e.rsvpOpen === true)
  check('what has no server side yet is empty, not undefined', e.broadcasts.length === 0 && e.reminders.length === 0 && e.sendLog.length === 0 && e.wishes.length === 0)

  const bare = adaptEvent(listRow, lookups)
  check('a row without its detail still renders (empty draft, a cover to read)', bare.invite.content.cover.title === '' && bare.published === null && bare.detailLoaded === false)
  check('and a row with it says so', e.detailLoaded === true)
}

section('The numbers on the list agree with the screens\' own counting')
{
  const guests = [
    { onMasterList: true, rsvp: 'Attending', pax: 2, allergies: 'nuts', checkedInAt: 'x' },
    { onMasterList: true, rsvp: 'Attending', pax: 1, allergies: '', checkedInAt: 'x' },
    { onMasterList: true, rsvp: 'Declined' },
    { onMasterList: true, rsvp: null },
    { onMasterList: false, walkIn: false, rsvp: 'Declined' },
    { onMasterList: false, walkIn: true, checkedInAt: 'x' },
  ]
  const s = eventStats(guests)
  check('eventStats has exactly the keys the server sends', JSON.stringify(Object.keys(s).sort()) === JSON.stringify(Object.keys(stats).sort()))
}

section('A guest, a scan, a wish')
{
  const g = adaptGuest({
    id: 'g-uuid', name: 'Ayu', phone: '6281211111111', email: null, category: 'VIP', onMasterList: true, walkIn: false, rsvp: 'Attending', pax: 2, allergies: 'nuts',
    answers: { 'Q-1': 'Beef' }, consent: true, consentAt: '2026-07-20T03:00:00Z', respondedAt: '2026-07-20T03:00:00Z', table: 'T1', note: '', noteBy: null, noteAt: null,
    checkedInAt: '2026-08-14T12:30:00Z', invitedAt: null, invitedVia: null, linkToken: 'tok', qr: 'OSC1:a:b:1:mac',
  }, 'EV-01')
  check('a guest is keyed by its server id and filed under the event number', g.id === 'g-uuid' && g.eventId === 'EV-01')
  check('the signed link token and QR are kept (the prototype\'s own are not)', g.token === 'tok' && g.qr.startsWith('OSC1:'))
  check('answers stay keyed by question key', g.answers['Q-1'] === 'Beef')
  check('times are wall clock, empty where there is none', g.checkedInAt === '2026-08-14T19:30' && g.invitedAt === null && g.email === '')

  const sc = adaptScan({ id: 7, guestId: 'g-uuid', checkpointId: 'cp-uuid', at: '2026-08-14T12:30:00Z' }, 'EV-01')
  check('a scan gets the SC-nnn id the screens expect', sc.id === 'SC-007' && sc.eventId === 'EV-01' && sc.at === '2026-08-14T19:30')

  const w = adaptWish({ id: 3, guestId: null, name: 'Rani', text: 'Congrats', at: '2026-07-21T01:00:00Z', hidden: false, approved: true, state: 'shown' })
  check('a wish keeps its numeric id and the flags the visibility rule reads', w.id === 3 && w.hidden === false && w.approved === true && w.guestId === null)
}

section('Template Studio')
{
  const rows = [
    { id: 'gala', builtin: true, family: 'corporate', name: 'Gala', palette: {}, fonts: {}, sections: [], off: [], art: {}, status: 'published' },
    { id: 'studio-1', builtin: false, family: 'private', name: 'Mine', tagline: 't', palette: { bg: '#000000', surface: '#111111', accent: '#c6a15b', text: '#ffffff' }, fonts: { heading: 'playfair', body: 'inter', script: 'vibes' }, cover: 'centered', ornament: 'none', sections: ['cover', 'details', 'rsvp'], off: [], art: { coverBg: { key: 'k', name: 'a.png', size: 1, type: 'image/png' } }, status: 'draft', createdByLabel: 'R. Hartono', updatedAt: '2026-07-01T00:00:00Z', usedByEvents: 0, liveEvents: 0 },
  ]
  const studio = studioTemplates(rows)
  check('only the studio ones are the store\'s customTemplates (built-ins are the screens\' own)', studio.length === 1 && studio[0].id === 'studio-1')
  check('a studio template keeps its art references and author label', studio[0].art.coverBg.key === 'k' && studio[0].by === 'R. Hartono' && studio[0].status === 'draft')
  check('adaptTemplate of a built-in does not crash', adaptTemplate(rows[0]).id === 'gala')
}

section('List helpers')
{
  const a = adaptEvent({ ...listRow, id: 'a', eventNo: 'EV-02', date: '2026-09-01' }, lookups)
  const b = adaptEvent({ ...listRow, id: 'b', eventNo: 'EV-01', date: '2026-08-14' }, lookups)
  const list = upsertEvent(upsertEvent([], a), b)
  check('events are kept in date order', list.map((e) => e.id).join() === 'EV-01,EV-02')
  const older = { ...b, name: 'stale', updatedAt: '2026-01-01T00:00:00Z' }
  check('an older copy does not replace a newer one', upsertEvent(list, older).find((e) => e.id === 'EV-01').name === 'Aurora Gala')
  const withWishes = list.map((e) => (e.id === 'EV-01' ? { ...e, wishes: [{ id: 1 }] } : e))
  const refreshed = upsertEvent(withWishes, { ...b, updatedAt: '2026-08-01T00:00:00Z', wishes: [] })
  check('a refresh from the list does not wipe wishes already loaded', refreshed.find((e) => e.id === 'EV-01').wishes.length === 1)

  const guests = [{ id: '1', eventId: 'EV-01' }, { id: '2', eventId: 'EV-02' }]
  check('replacing one event\'s guests leaves the others', replaceGuests(guests, 'EV-01', [{ id: '3', eventId: 'EV-01' }]).map((g) => g.id).sort().join() === '2,3')
  check('and its scans likewise', replaceScans([{ id: 's', eventId: 'EV-02' }], 'EV-01', []).length === 1)

  check('a refusal shows the server\'s own sentence', whyRefused({ message: 'Only CEO and PM may publish.' }) === 'Only CEO and PM may publish.')
  check('a 403 names who can', whyRefused({ status: 403, message: 'Not allowed', permitted: ['CEO', 'PM'] }).includes('CEO, PM'))
  check('adaptQuestion and adaptCheckpoint tolerate missing optional fields', adaptQuestion({ key: 'Q-2', label: 'x', type: 'text' }).options.length === 0 && adaptCheckpoint({ id: 'c', key: 'CP-2', name: 'Bar' }).categories.length === 0)
}

section('On the wire')
{
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : undefined })
    return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) }
  }
  const last = () => calls[calls.length - 1]

  await eventsApi.setContent(EV_UUID, 'details', { name: 'Gala', mapUrl: 'https://m', sessions: [{ id: 's1', mapUrl: 'x' }] })
  check('content goes PUT /invite/content/{section}', last().method === 'PUT' && last().url.endsWith(`/events/${EV_UUID}/invite/content/details`))
  check('and its keys reach the server exactly as written (mapUrl, not map_url)', last().body.value.mapUrl === 'https://m' && last().body.value.sessions[0].mapUrl === 'x' && !('map_url' in last().body.value))

  await eventsApi.update(EV_UUID, { maxPax: 4, holdWishes: true })
  check('ordinary bodies are snake-cased', last().method === 'PATCH' && last().body.max_pax === 4 && last().body.hold_wishes === true)

  await eventsApi.publish(EV_UUID, true)
  check('publish sends clamp_deadline', last().url.endsWith('/publish') && last().body.clamp_deadline === true)

  await eventsApi.removeQuestion(EV_UUID, 'Q-1')
  check('a question is addressed by its key', last().method === 'DELETE' && last().url.endsWith('/questions/Q-1'))

  await eventsApi.scan(EV_UUID, { qr: 'OSC1:a:b:1:mac', checkpointId: 'cp-uuid' })
  check('a scan sends the server QR and checkpoint', last().url.endsWith('/scans') && last().body.qr === 'OSC1:a:b:1:mac' && last().body.checkpoint_id === 'cp-uuid')

  await eventsApi.setTemplateArt('studio-1', 'coverBg', { key: 'k', name: 'a.png', size: 1, type: 'image/png' })
  check('template art goes by slot', last().method === 'PUT' && last().url.endsWith('/invitation-templates/studio-1/art/coverBg') && last().body.ref.key === 'k')
}

console.log('')
if (failures.length) {
  console.log(`\x1b[31m${failures.length} failed\x1b[0m, ${passed} passed`)
  failures.forEach((f) => console.log(`  \x1b[31m✗\x1b[0m ${f}`))
  process.exit(1)
}
console.log(`\x1b[32m✓ ${passed} event-adapter assertions passed\x1b[0m (no backend needed)`)
