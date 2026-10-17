// Writes erp-backend/tests/fixtures/crm_relations_matrix.json: the prototype's own answers (lib/crm.js)
// for the relationship rules, so the backend's Python port is tested against them rather than against
// a second opinion of what they should be.
//
//   node scripts/gen-crm-fixture.mjs
//
// Re-run it only if the rules in lib/crm.js change on purpose; the backend test then shows what moved.

import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { campaignAudience, guestContacts, isMonthDay, nextNudge, nextOccurrence, relationshipCalendar, usualMonth } from '../src/lib/crm.js'

const OUT = fileURLToPath(new URL('../../erp-backend/tests/fixtures/crm_relations_matrix.json', import.meta.url))

const histories = [
  [],
  ['2024-07'],
  ['2024-07', '2025-07'],
  ['2023-11', '2024-11', '2025-12'],
  ['2023-03', '2024-09'], // a tie: the earlier month wins
  ['2022-12', '2023-12', '2024-01'],
  ['2025-01', '2025-01'], // the same month twice in one list
]
const todays = ['2026-01-01', '2026-03-15', '2026-07-01', '2026-07-02', '2026-10-14', '2026-12-31', '2027-02-28']
const leads = [1, 3, 6, 12]

const cases = {
  usualMonth: histories.map((history) => ({ history, out: usualMonth(history) })),
  nextNudge: [],
  isMonthDay: ['01-01', '02-29', '02-30', '04-31', '04-30', '12-31', '13-01', '00-10', '7-28', '07-28', '', null, 'ab-cd', '07-00', '01-32'].map((v) => ({ value: v, out: isMonthDay(v) })),
  nextOccurrence: [],
  calendar: [],
}

for (const history of histories) {
  for (const today of todays) {
    for (const lead of leads) {
      cases.nextNudge.push({ history, today, lead, out: nextNudge({ history }, lead, today) })
    }
  }
}

for (const md of ['01-01', '02-28', '02-29', '07-28', '12-31', '2019-03-01', '2020-02-29', '1999-12-31']) {
  for (const today of ['2026-01-01', '2027-02-28', '2028-02-28', '2028-02-29', '2028-03-01', '2026-07-28', '2026-07-29', '2026-12-31']) {
    cases.nextOccurrence.push({ monthDay: md, today, out: nextOccurrence(md, today) })
  }
}

// Whole calendars. Client ids are plain strings here; the backend test maps them to its own rows.
const clients = [{ id: 'CL-1', name: 'Aurora Bank' }, { id: 'CL-2', name: 'Borneo Mining' }, { id: 'CL-3', name: 'Cendana Hotel' }]
const relationSets = [
  {
    'CL-1': {
      nudgeLeadMonths: 3,
      cycles: [{ name: 'Annual Gala', history: ['2024-07', '2025-07'] }, { name: 'Town Hall', history: ['2025-11'] }],
      handledNudges: [],
      pics: [{ id: 'P1', name: 'Ibu Sari', role: 'HR', birthday: '07-28' }, { id: 'P2', name: 'Pak Dedi', role: 'Ops', birthday: '02-29' }, { id: 'P3', name: 'No Birthday', role: '' }],
      anniversary: '2019-03-01',
    },
    'CL-2': { nudgeLeadMonths: 6, cycles: [{ name: 'Safety Day', history: ['2024-02', '2025-02'] }], handledNudges: ['Safety Day:2026-02'], pics: [], anniversary: '2026-06-01' },
    'CL-3': { nudgeLeadMonths: 1, cycles: [], handledNudges: [], pics: [{ id: 'P9', name: 'Bu Rina', birthday: '12-31' }], anniversary: null },
  },
  {
    'CL-1': { nudgeLeadMonths: 4, cycles: [{ name: 'Annual Gala', history: ['2024-12', '2025-12'] }], handledNudges: [], pics: [{ id: 'P1', name: 'Ibu Sari', birthday: '01-02' }], anniversary: '2020-02-29' },
  },
  {},
]
for (const relations of relationSets) {
  for (const today of ['2026-01-01', '2026-03-15', '2026-07-01', '2026-10-14', '2026-12-30', '2028-02-28']) {
    for (const days of [30, 90, 365]) {
      cases.calendar.push({ today, days, relations, out: relationshipCalendar(clients, relations, today, days) })
    }
  }
}

// The contact list: guests pooled across events and merged by phone (email only for guests with no
// phone), consent kept if it was ever given. Names are simple and tie-free so the sort is unambiguous.
const events = [
  { id: 'EV-1', name: 'Gala 2025', date: '2025-07-10' },
  { id: 'EV-2', name: 'Launch 2026', date: '2026-03-02' },
  { id: 'EV-3', name: 'Summit 2026', date: '2026-09-09' },
]
const guest = (id, eventId, over) => ({
  id, eventId, name: id, phone: '', email: '', rsvp: 'Attending', walkIn: false, checkedInAt: null,
  respondedAt: null, consent: false, consentAt: null, ...over,
})
const guestSets = {
  empty: [],
  samePhoneTwoFormats: [
    guest('g1', 'EV-1', { name: 'Anton', phone: '0812 3456 7890', respondedAt: '2025-07-01T10:00', consent: true, consentAt: '2025-07-01T10:00' }),
    guest('g2', 'EV-2', { name: 'Anton S', phone: '+62 812-3456-7890', email: 'anton@x.test', respondedAt: '2026-02-20T09:00', checkedInAt: '2026-03-02T19:00' }),
  ],
  consentKeptWhenLaterUnticked: [
    guest('g1', 'EV-1', { name: 'Budi', phone: '0811111111', respondedAt: '2025-07-01T10:00', consent: true, consentAt: '2025-07-01T10:00' }),
    guest('g2', 'EV-2', { name: 'Budi', phone: '0811111111', respondedAt: '2026-02-20T09:00', consent: false }),
  ],
  latestConsentWins: [
    guest('g1', 'EV-1', { name: 'Citra', phone: '0822222222', respondedAt: '2025-07-01T10:00', consent: true, consentAt: '2025-07-01T10:00' }),
    guest('g2', 'EV-3', { name: 'Citra', phone: '0822222222', respondedAt: '2026-08-01T10:00', consent: true, consentAt: '2026-08-01T10:00' }),
  ],
  emailGroupsOnlyWithoutPhone: [
    guest('g1', 'EV-1', { name: 'Dewi', email: 'Shared@Office.test', respondedAt: '2025-07-01T10:00' }),
    guest('g2', 'EV-2', { name: 'Dewi', email: ' shared@office.test ', respondedAt: '2026-02-20T09:00', consent: true, consentAt: '2026-02-20T09:00' }),
    guest('g3', 'EV-2', { name: 'Eko', phone: '0833333333', email: 'shared@office.test', respondedAt: '2026-02-21T09:00' }),
  ],
  nothingToReachThemBy: [
    guest('g1', 'EV-1', { name: 'Faisal' }),
    guest('g2', 'EV-1', { name: 'Gita', phone: '0844444444' }),
  ],
  walkInAndNoResponse: [
    guest('g1', 'EV-2', { name: 'Hana', phone: '0855555555', walkIn: true, rsvp: null, checkedInAt: '2026-03-02T20:00' }),
    guest('g2', 'EV-3', { name: 'Hana', phone: '0855555555', rsvp: null }),
    guest('g3', 'EV-3', { name: 'Indra', phone: '0866666666', rsvp: 'Declined', respondedAt: '2026-08-02T09:00' }),
  ],
  orderedByWhenTheyAnswered: [
    guest('g2', 'EV-2', { name: 'Joko Late', phone: '0877777777', respondedAt: '2026-02-20T09:00' }),
    guest('g1', 'EV-1', { name: 'Joko Early', phone: '0877777777', email: 'j@x.test', respondedAt: '2025-07-01T10:00' }),
  ],
  sortedByName: [
    guest('g1', 'EV-1', { name: 'Zainal', phone: '0801' }),
    guest('g2', 'EV-1', { name: 'Adi', phone: '0802' }),
    guest('g3', 'EV-1', { name: 'Maya', phone: '0803' }),
  ],
}
cases.contacts = Object.entries(guestSets).map(([name, guests]) => ({ name, guests, events, out: guestContacts(guests, events) }))

// The audience of a campaign: ticked contacts, split by consent.
cases.audience = []
for (const set of ['consentKeptWhenLaterUnticked', 'emailGroupsOnlyWithoutPhone', 'walkInAndNoResponse', 'samePhoneTwoFormats']) {
  const contacts = guestContacts(guestSets[set], events)
  const keys = contacts.map((c) => c.key)
  for (const picked of [[], keys, keys.slice(0, 1), [...keys.slice(-1), 'p:99999999'], ['e:nobody@x.test']]) {
    const out = campaignAudience(contacts, picked)
    cases.audience.push({ set, picked, recipients: out.recipients.map((c) => c.key), skipped: out.skipped.map((c) => c.key) })
  }
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, `${JSON.stringify({ clients, ...cases }, null, 1)}\n`)
console.log(`wrote ${OUT}: ${cases.nextNudge.length} nextNudge, ${cases.nextOccurrence.length} nextOccurrence, ${cases.calendar.length} calendars, ${cases.contacts.length} contact sets, ${cases.audience.length} audiences`)
