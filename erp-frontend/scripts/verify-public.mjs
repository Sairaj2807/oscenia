// The public (signed-out) client layer under Node: the adapters from the server's guest, walk-in
// and client payloads, the wire shape of every public call (tokens in headers, never in the path),
// and how a refusal is turned into something a guest can read.
//
//   npm run verify:public      (vite-node, so the ESM imports resolve like they do in the app)

import { clientView, publicEvent, publicGuest, walkInPage } from '../src/store/publicAdapters.js'
import { publicApi, whyPublic } from '../src/lib/publicApi.js'
import { ApiError } from '../src/lib/api.js'
import { rsvpOpen } from '../src/lib/events.js'
import { liveInvite } from '../src/lib/invites.js'

let passed = 0
const failures = []
function check(label, ok, detail = '') {
  if (ok) passed += 1
  else failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
}
const section = (name) => console.log(`\n${name}`)

const invitePayload = {
  event: {
    eventNo: 'EV-01', name: 'Gala', date: '2026-08-14', time: '19:00', venue: 'Ballroom', rsvpDeadline: '2026-08-07',
    rsvpOpen: true, isPast: false, maxPax: 2, rsvpFields: { email: true, allergies: true, pax: true }, holdWishes: false,
  },
  invite: { templateId: 'gala', accent: null, on: { music: true }, content: { cover: { title: 'Gala' }, details: { mapUrl: 'https://maps.example/x' } } },
  template: null,
  questions: [{ key: 'Q-1', label: 'Meal', type: 'dropdown', options: ['Beef', 'Fish'], multi: false, required: true, attendingOnly: true }],
  wishes: [{ id: 3, name: 'Rani', text: 'Congrats', at: '2026-07-21T01:00:00Z' }],
  guest: { id: 'g-1', name: 'Dewi', phone: '0812', email: '', rsvp: null, pax: 0, allergies: '', answers: {}, token: 'tok', qr: 'OSC1:a:b:1:mac' },
}

section('The guest page: the server payload becomes the event the renderer reads')
{
  const e = publicEvent(invitePayload)
  check('it is marked as coming from the server', e.server === true)
  check('id is the event number; only a published event reaches a guest', e.id === 'EV-01' && e.status === 'Published')
  check('what guests see is the published copy', liveInvite(e).templateId === 'gala' && liveInvite(e).content.details.mapUrl.startsWith('https://'))
  check('content keys stay camelCase', 'mapUrl' in liveInvite(e).content.details)
  check('questions become customFields keyed by their key', e.customFields[0].id === 'Q-1' && e.customFields[0].attendingOnly === true)
  check('wishes arrive already visible (the server filtered them)', e.wishes.length === 1 && e.wishes[0].approved === true && e.wishes[0].hidden === false)
  check('the server says whether RSVPs are open and whether the event is past', e.rsvpOpen === true && e.isPast === false)
  check('what has no public side is empty, not undefined', e.broadcasts.length === 0 && e.reminders.length === 0 && e.tables.length === 0)

  const g = publicGuest(invitePayload.guest, 'EV-01')
  check('the caller\'s own guest carries their link token and QR', g.token === 'tok' && g.qr.startsWith('OSC1:') && g.eventId === 'EV-01')
  check('no guest at all stays null', publicGuest(null, 'EV-01') === null)
}

section('RSVP open or closed comes from the server when it says so')
{
  const base = { status: 'Published', rsvpDeadline: '2026-01-01', date: '2026-01-02' }
  check('a server flag of true wins over the frozen demo date', rsvpOpen({ ...base, rsvpOpen: true }) === true)
  check('a server flag of false wins too', rsvpOpen({ ...base, rsvpDeadline: '2099-01-01', date: '2099-02-01', rsvpOpen: false }) === false)
  check('the demo (no flag) still works it out', rsvpOpen({ status: 'Published', rsvpDeadline: '2099-01-01', date: '2099-02-01' }) === true)
}

section('The walk-in desk page')
{
  const p = walkInPage({ eventNo: 'EV-01', name: 'Gala', templateId: 'gala', accent: null, coverTitle: 'Gala Night', template: null })
  check('it carries just what the form draws itself with', p.id === 'EV-01' && p.invite.templateId === 'gala' && p.invite.content.cover.title === 'Gala Night')
}

section('The client link')
{
  const view = clientView({
    event: { eventNo: 'EV-02', name: 'Wedding', status: 'Draft', date: '2026-09-12', rsvpDeadline: '2026-09-05', holdWishes: true },
    draft: {
      invite: { templateId: 'royal', accent: '#aa5500', on: {}, content: { cover: { title: 'R and B' } } },
      published: { template_id: 'gala', accent: null, on: {}, content: {} },
      hasUnpublishedChanges: true,
      review: { state: 'returned', note: 'Please fix the date' },
    },
    templates: [{ id: 'studio-1', family: 'private', name: 'Mine', status: 'published' }],
    wishes: [
      { id: 1, name: 'A', text: 'x', at: '2026-07-21T01:00:00Z', state: 'shown' },
      { id: 2, name: 'B', text: 'y', at: '2026-07-21T01:00:00Z', state: 'waiting' },
      { id: 3, name: 'C', text: 'z', at: '2026-07-21T01:00:00Z', state: 'hidden' },
    ],
    guests: [{ id: 'g-1', name: 'Dewi', phone: '0812', category: 'VIP', invitedAt: null, invitedVia: null, token: 'tok' }],
  }, 'the-key')
  const e = view.event
  check('the draft is the editor\'s invite, the published copy what guests see', e.invite.templateId === 'royal' && e.published.templateId === 'gala')
  check('the review state and the note come through', e.review.state === 'returned' && e.review.note === 'Please fix the date')
  check('wish states become the flags the moderation screen reads', e.wishes[0].approved && !e.wishes[0].hidden && !e.wishes[1].approved && e.wishes[2].hidden)
  check('the guest list carries the personal link and phone, not staff fields', view.guests[0].token === 'tok' && view.guests[0].phone === '0812' && !('table' in view.guests[0]))
  check('the studio templates ride along for the gallery', view.templates[0].id === 'studio-1')
  check('the key is kept on the event for building links', e.editToken === 'the-key')
}

section('On the wire')
{
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined })
    return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) }
  }
  const last = () => calls[calls.length - 1]

  await publicApi.invite('EV-01', 'tok-123')
  check('the guest\'s token is a header, never in the path or query', last().headers['X-Guest-Token'] === 'tok-123' && !last().url.includes('tok-123') && last().url.endsWith('/public/invites/EV-01'))
  check('and no staff session is sent', !('Authorization' in last().headers))

  await publicApi.rsvp('EV-01', { name: 'Siti', phone: '0811', attending: true, pax: 2, allergies: '', consent: false, answers: { 'Q-1': 'Fish' }, website: '' }, 'tok-123')
  check('an RSVP is a POST with snake_case fields and the token header', last().method === 'POST' && last().url.endsWith('/rsvp') && last().body.attending === true && last().headers['X-Guest-Token'] === 'tok-123')
  check('answers keyed by question key survive (not turned into _q-1)', last().body.answers['Q-1'] === 'Fish' && !('_q-1' in last().body.answers))

  await publicApi.walkIn('EV-01', { name: 'W', phone: '0813', email: '', consent: true, website: '' }, 'desk-tok')
  check('the desk token is its own header', last().headers['X-Walkin-Token'] === 'desk-tok' && last().url.endsWith('/public/walkin/EV-01'))

  await publicApi.client('EV-02', 'client-key')
  check('the client key is a header too', last().headers['X-Client-Key'] === 'client-key' && !last().url.includes('client-key'))

  await publicApi.clientSetContent('EV-02', 'client-key', 'details', { mapUrl: 'https://m', sessions: [{ mapUrl: 'x' }] })
  check('invitation content keys reach the server as written (mapUrl, not map_url)', last().body.value.mapUrl === 'https://m' && last().body.value.sessions[0].mapUrl === 'x' && !('map_url' in last().body.value))

  await publicApi.clientWish('EV-02', 'client-key', 3, 'approve')
  check('wish moderation is a POST to the action', last().method === 'POST' && last().url.endsWith('/wishes/3/approve'))

  await publicApi.withdraw('EV-01', 'all', 'tok-123')
  check('withdrawing is a POST of the scope, with the guest token in a header', last().method === 'POST' && last().url.endsWith('/public/invites/EV-01/withdraw') && last().body.scope === 'all' && last().headers['X-Guest-Token'] === 'tok-123' && !last().url.includes('tok-123'))
  await publicApi.withdraw('EV-01', 'marketing', 'tok-123')
  check('stopping marketing is the other scope', last().body.scope === 'marketing')

  await publicApi.passwordReset('reset-tok', 'a-brand-new-password')
  check('a password link is spent with the token in a header, never in the address', last().method === 'POST' && last().url.endsWith('/public/password-reset') && last().headers['X-Reset-Token'] === 'reset-tok' && !last().url.includes('reset-tok') && !('Authorization' in last().headers) && last().body.password === 'a-brand-new-password')

  await publicApi.survey('EVT-2026-001', 'sv-tok')
  check('the survey page is read with the token in a header, never in the address', last().method === 'GET' && last().url.endsWith('/public/survey/EVT-2026-001') && last().headers['X-Survey-Token'] === 'sv-tok' && !last().url.includes('sv-tok') && !('Authorization' in last().headers))
  await publicApi.rateSurvey('EVT-2026-001', 'sv-tok', 8)
  check('a rating is a POST of the stars, with the token in a header', last().method === 'POST' && last().url.endsWith('/public/survey/EVT-2026-001') && last().body.score === 8 && last().headers['X-Survey-Token'] === 'sv-tok' && !last().url.includes('sv-tok'))

  const { usersApi, passwordProblem } = await import('../src/lib/usersApi.js')
  await usersApi.create({ email: 'a@b.id', fullName: 'A B', role: 'sales' })
  check('a new user is a POST with snake_case fields', last().method === 'POST' && last().url.endsWith('/users') && last().body.full_name === 'A B' && last().body.role === 'sales')
  await usersApi.update('u-1', { role: 'pm' })
  check('a role change is a PATCH', last().method === 'PATCH' && last().url.endsWith('/users/u-1') && last().body.role === 'pm')
  await usersApi.deactivate('u-1')
  check('deactivating is its own POST', last().method === 'POST' && last().url.endsWith('/users/u-1/deactivate'))
  await usersApi.resetLink('u-1')
  check('a password link is requested with a POST', last().method === 'POST' && last().url.endsWith('/users/u-1/reset-password'))
  await usersApi.changePassword('old-password-1', 'new-password-123')
  check('changing your own password sends both, snake_case', last().url.endsWith('/auth/change-password') && last().body.current_password === 'old-password-1' && last().body.new_password === 'new-password-123')
  await usersApi.setLanguage('id')
  check('the language is saved with a PATCH', last().method === 'PATCH' && last().url.endsWith('/auth/me/preferences') && last().body.language === 'id')
  check('a short password is refused before it is sent', passwordProblem('short', 'short') !== null)
  check('a mismatch is refused before it is sent', passwordProblem('long-enough-pass', 'different-pass-1') !== null)
  check('a good pair passes', passwordProblem('long-enough-pass', 'long-enough-pass') === null)
}

section('A refusal says something a guest can read')
{
  check('an unreachable server is "offline", not a crash', whyPublic(new TypeError('Failed to fetch')).code === 'offline')
  check('a 429 says to wait', whyPublic(new ApiError(429, { title: 'Too many', detail: 'Too many requests. Try again shortly.', retry_after: 7 })).code === 'slow_down')
  const closed = whyPublic(new ApiError(409, { detail: 'RSVPs are closed for this event.', code: 'closed' }))
  check('a coded refusal keeps its code and words', closed.code === 'closed' && closed.message.includes('closed'))
  const missing = whyPublic(new ApiError(422, { detail: 'Please answer the required questions.', code: 'missing_answers', missing: ['Meal'] }))
  check('missing answers name the questions', missing.code === 'missing_answers' && missing.missing[0] === 'Meal')
  check('a 404 is "not found"', whyPublic(new ApiError(404, { detail: 'This invitation is not available.' })).code === 'not_found')
}

console.log('')
if (failures.length) {
  console.log(`\x1b[31m${failures.length} failed\x1b[0m, ${passed} passed`)
  failures.forEach((f) => console.log(`  \x1b[31m✗\x1b[0m ${f}`))
  process.exit(1)
}
console.log(`\x1b[32m✓ ${passed} public-layer assertions passed\x1b[0m (no backend needed)`)
