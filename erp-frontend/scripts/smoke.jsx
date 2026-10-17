// Render every route to a string, three times: against the seed data, after the
// store mutations have run, and in Bahasa Indonesia.
//
// The second pass matters because several render paths only ever see their real
// data shape after an action: inventory rows split by a condition check-in,
// reversed/adjusted journal entries, settled advances carrying an `actual`, a
// disbursed incentive pool, a project created by confirming a DP.
//
// NOT covered here: modal bodies, which only mount on a click. Those still need
// a browser pass.
//
// Run: npm run verify:render
import './smoke-session.js'
import '../src/index.css'

import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import App from '../src/App'
import { useStore } from '../src/store/useStore.js'
import { useProto } from '../src/store/useProto.js'
import { usePublicInvite, usePublicWalkIn } from '../src/store/usePublicInvite.js'
import { usePublicClient } from '../src/store/usePublicClient.js'
import { clientView, publicEvent, publicGuest, walkInPage } from '../src/store/publicAdapters.js'
// Run through scripts/smoke.config.js (npm run verify:render), which makes the server render
// read live store state — otherwise the post-mutation and Bahasa passes would render seed data
// in English. The signed-in session is planted before the app loads (smoke-session.js).

const ROUTES = [
  '/', '/quotations', '/projects', '/projects/EVT-2026-GALA-01',
  '/finance', '/cash', '/receivables', '/payables', '/pnl', '/accounting', '/accounts',
  '/fixed-assets', '/budgeting',
  '/users', '/reset-password', '/rate/EVT-2026-001', '/simulator', '/cron', '/survey', '/crm', '/crm/CL-01', '/vendors',
  '/vendors/V-01', '/vendors/V-05', '/vendors?view=pipeline', '/vendors?view=po', '/purchase-orders', '/purchase-orders?view=pipeline', '/procurement', '/warehouse',
  '/payroll', '/sales',
  '/workspace', '/workspace/EVT-2026-GALA-01', '/workspace/EVT-2026-GALA-01?task=T-102',
  '/chat', '/chat/ch-gala-general', '/chat/ch-leaders', '/chat/ch-gala-general?task=T-102', '/chat/no-such-channel', '/chat/vc-gala', '/chat/ch-announcements', '/chat/dm-M-01-M-05', '/chat/ch-gala-production?settings=ch-gala-production', '/chat/ch-gala-general?meeting=MTG-1', '/chat/ch-gala-general?meeting=MTG-99',
  '/events', '/events/EV-01', '/events/EV-02', '/events/EV-03', '/events/EV-99', '/events/EV-03?tab=invitation', '/invite/EV-03', '/invite/EV-03/edit?key=wibowo-5h2m',
  '/invite/EV-01', '/invite/EV-02', '/invite/EV-99', '/invite/EV-01?g=7wdrqp', '/invite/EV-01?g=hhk9jd', '/invite/EV-01/edit?key=aurora-7f2k', '/invite/EV-01/edit?key=wrong',
  '/walkin/EV-01', '/walkin/EV-99',
  '/events/EV-01?tab=send', '/events/EV-03?tab=send', '/invite/EV-01/edit?key=aurora-7f2k&tab=send', '/invite/EV-03/edit?key=wibowo-5h2m&tab=send',
  '/events/EV-01?tab=invitation', '/events/EV-01?tab=reminders', '/events/EV-01?tab=checkin', '/events/EV-01?tab=report', '/events/EV-02?tab=guests',
  '/crm?tab=contacts', '/crm?tab=calendar', '/crm/CL-02', '/google-calendar',
  // Round 3, Template Studio: the list, and (pass 2, once one exists) its editor.
  '/events/templates', '/events/templates?edit=studio-1', '/events/templates?edit=studio-99',
]

let failures = 0
const s = () => useStore.getState()


// ---------------------------------------------------------------------------------------------
// The public pages ask the server before drawing anything, and a one-shot server render never runs
// effects, so each pass puts their stores where the answer would have left them.
//   * "no server" (the static demo): the pages fall back to the demo store, as they always did;
//   * "the server answered": a published invitation, a walk-in desk, a client link, and the refusals.
// ---------------------------------------------------------------------------------------------
function primeNoServer(route) {
  const m = /^\/(invite|walkin)\/([^/?]+)/.exec(route)
  if (!m) return
  const [, kind, no] = m
  if (kind === 'walkin') usePublicWalkIn.setState({ status: 'offline', eventNo: no })
  else if (/\/edit/.test(route)) usePublicClient.setState({ status: 'offline', eventNo: no, active: false })
  else usePublicInvite.setState({ status: 'offline', eventNo: no })
}

function publicServerPass() {
  console.log('\n=== Public pages — the server answered ===')
  const guestRow = { id: 'g-1', name: 'Dewi', phone: '0812', email: '', rsvp: null, pax: 0, allergies: '', answers: {}, token: 'tok', qr: 'OSC1:a:b:1:mac' }
  const payload = {
    event: { eventNo: 'EV-01', name: 'Smoke Gala', date: '2099-08-14', time: '19:00', venue: 'Ballroom', rsvpDeadline: '2099-08-07', rsvpOpen: true, isPast: false, maxPax: 2, rsvpFields: { email: true, allergies: true, pax: true }, holdWishes: false },
    invite: { templateId: 'gala', accent: null, on: {}, content: { cover: { eyebrow: 'You are invited', title: 'Smoke Gala', subtitle: '', image: null }, details: { name: 'Smoke Gala', date: '2099-08-14', time: '19:00', venue: 'Ballroom', mapUrl: '', sessions: [] } } },
    template: null,
    questions: [{ key: 'Q-1', label: 'Meal', type: 'dropdown', options: ['Beef', 'Fish'], multi: false, required: true, attendingOnly: true }],
    wishes: [{ id: 1, name: 'Rani', text: 'Congratulations', at: '2099-01-01T01:00:00Z' }],
    guest: guestRow,
  }
  const check = (label, route, needles, setup) => {
    try {
      setup()
      const html = renderToString(<MemoryRouter initialEntries={[route]}><App /></MemoryRouter>)
      const missing = needles.filter((n) => !html.includes(n))
      const ok = html.length > 200 && missing.length === 0
      if (!ok) failures++
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(44)} ${ok ? `${html.length} bytes` : `missing: ${missing.join(', ')}`}`)
    } catch (err) {
      failures++
      console.log(`FAIL  ${label.padEnd(44)} ${err.message}`)
    } finally {
      usePublicClient.setState({ active: false, status: 'idle', eventNo: null })
    }
  }

  const ready = () => usePublicInvite.setState({ status: 'ready', eventNo: 'EV-01', event: publicEvent(payload), linked: publicGuest(payload.guest, 'EV-01'), me: publicGuest(payload.guest, 'EV-01') })
  check('guest invitation (personal link)', '/invite/EV-01?g=tok', ['Open invitation', 'Smoke Gala'], ready)
  check('guest invitation (shared link)', '/invite/EV-01', ['Open invitation'], () => usePublicInvite.setState({ status: 'ready', eventNo: 'EV-01', event: publicEvent(payload), linked: null, me: null }))
  check('guest invitation (not available)', '/invite/EV-09', ['This invitation is not available'], () => usePublicInvite.setState({ status: 'missing', eventNo: 'EV-09' }))
  check('guest invitation (server trouble)', '/invite/EV-01', ['Please try again'], () => usePublicInvite.setState({ status: 'error', eventNo: 'EV-01' }))
  check('walk-in desk (venue link)', '/walkin/EV-01?w=desk', ['Check me in', 'Smoke Gala'], () => usePublicWalkIn.setState({ status: 'ready', eventNo: 'EV-01', page: walkInPage({ eventNo: 'EV-01', name: 'Smoke Gala', templateId: 'gala', accent: null, coverTitle: 'Smoke Gala', template: null }) }))
  check('walk-in desk (no venue link)', '/walkin/EV-01', ['This registration link is not available'], () => usePublicWalkIn.setState({ status: 'missing', eventNo: 'EV-01' }))

  const clientData = {
    event: { eventNo: 'EV-02', name: 'Smoke Wedding', status: 'Draft', date: '2099-09-12', rsvpDeadline: '2099-09-05', holdWishes: false },
    draft: { invite: { templateId: 'royal', accent: null, on: {}, content: { cover: { eyebrow: '', title: 'R and B', subtitle: '', image: null }, details: { name: '', date: '2099-09-12', time: '18:00', venue: 'Garden', mapUrl: '', sessions: [] } } }, published: null, hasUnpublishedChanges: false, review: { state: 'editing', note: '' } },
    templates: [],
    wishes: [],
    guests: [{ id: 'g-1', name: 'Dewi', phone: '0812', category: 'Regular', invitedAt: null, invitedVia: null, token: 'tok' }],
  }
  check('client editor (valid key)', '/invite/EV-02/edit?key=k', ['Changes save as you type', 'Smoke Wedding'], () => {
    const view = clientView(clientData, 'k')
    usePublicClient.setState({ active: true, status: 'ready', eventNo: 'EV-02', key: 'k', ...view })
  })
  check('client editor (key refused)', '/invite/EV-02/edit?key=bad', ['This link is not valid'], () => usePublicClient.setState({ active: true, status: 'invalid', eventNo: 'EV-02' }))
}

function renderAll(label) {
  console.log(`\n=== ${label} ===`)
  for (const route of ROUTES) {
    try {
      primeNoServer(route)
      const html = renderToString(
        <MemoryRouter initialEntries={[route]}>
          <App />
        </MemoryRouter>
      )
      const ok = html.length > 200
      if (!ok) failures++
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${route.padEnd(30)} ${html.length} bytes`)
    } catch (err) {
      failures++
      console.log(`FAIL  ${route.padEnd(30)} ${err.message}`)
    }
  }
}

renderAll('Pass 1 — seed data')
publicServerPass()

// Drive the store through every action that changes a rendered data shape.
s().acceptQuotation('QT-1002')
s().confirmDownPayment()
s().checkInAsset('IT-05', { good: 30, damaged: 6, lost: 4 })
s().checkOutAsset('IT-07', 'EVT-2026-CONF-03', '2026-10-22')
s().topUpPettyCash(15_000_000)
s().setProcurementStatus('PR-103', 'Approved')
s().setProcurementStatus('PR-103', 'Disbursed')
s().settleAdvance('PR-101', 7_000_000)
s().submitSurvey('EVT-2026-GALA-01', 9.4)
s().disburseIncentives(s().latestFeedback.pool, 'EVT-2026-GALA-01')
s().adjustJournalEntry('JE-1013', {
  date: '2026-07-18',
  memo: 'Corrected crew payroll',
  project: 'EVT-2026-GALA-01',
  lines: [
    { account: '5102', debit: 55_000_000, credit: 0, note: 'Corrected' },
    { account: '1101', debit: 0, credit: 55_000_000, note: 'Bank' },
  ],
})
s().addInventoryItem({ item: 'Haze Machine', type: 'Fixed Asset', qty: 4, unit: 'unit', unitValue: 3_200_000 })
s().advanceDeliveryOrder('DO-2202')
s().addUnplannedCost()
s().advanceStage('EVT-2026-WED-02')
s().setTaxRate('corporate', 25)
s().toggleTax('ppn')
s().runCron()
// Phases 4-6
s().approvePurchaseOrder('PO-3005')
s().payPoDownPayment('PO-3005')
s().settlePurchaseOrder('PO-3005')
s().approvePurchaseOrder('PO-3004')
s().cancelPurchaseOrder('PO-3004')
s().createPurchaseOrder({
  vendorId: 'V-02',
  project: 'EVT-2026-GALA-01',
  eventDate: '2026-08-14',
  lines: [{ itemId: 'VI-02', item: 'Line Array Speaker', qty: 4, unitPrice: 1_800_000 }],
})
s().revertStage('EVT-2026-GALA-01')
s().cancelProject('EVT-2026-WED-02', { refundDp: true, reason: 'postponed' })
s().cancelQuotation('QT-1003')
s().updateVendorRate('V-01', 3)
s().addVendor({ name: 'Nusa Rigging', category: 'Staging' })
s().addClient({ name: 'Nimbus Retail', contact: 'Ibu Sari', phone: '+62 811-0000-1111' })
s().updateClient('CL-01', { phone: '+62 812-0000-0000' })
s().logInteraction('CL-01', { type: 'Note', note: 'Smoke test note.' })
s().setBudgetTolerance(5)
// Tags + templates
s().addTag('Live Streaming')
s().toggleVendorTag('V-01', 'live-streaming')
s().setVendorTags('V-02', ['wedding', 'preferred-supplier'])
s().deleteTag('rush-friendly')
const smokeTpl = s().addMouTemplate({ label: 'Festival', clauses: ['Weather contingency applies.'] })
s().updateMouTemplate(smokeTpl.id, { heading: 'FESTIVAL AGREEMENT' })
s().addTemplateClause(smokeTpl.id, 'Second clause.')
s().moveTemplateClause(smokeTpl.id, 1, -1)
s().duplicateMouTemplate(smokeTpl.id)
s().updateQuotation('QT-1003', { template: smokeTpl.id, dpPercent: 45 })
// Slide-3 fixes: project cost detail needs POs on a project, and the DP
// rollback path needs exercising in both directions.
s().approvePurchaseOrder('PO-3005')
s().undoDownPayment()
s().moveProjectToStage('EVT-2026-CONF-03', 'Vendor Dispatch')
// Round 2 — the chart of accounts is editable, so the tree has to render with
// a sub-account, a deactivated account and a freshly added top-level account.
s().addAccount({ code: '1101.01', name: 'BCA Operating', type: 'asset', parent: '1101' })
s().addAccount({ code: '6104', name: 'Marketing & Brand', type: 'opex', group: 'Overheads' })
s().addAccount({ code: '6105', name: 'Typo Account', type: 'opex' })
s().updateAccount('6104', { name: 'Marketing, Brand & PR' })
s().setAccountActive('6104', false)
s().deleteAccount('6105')
// Phase B — the AR and phased-DP shapes only exist after these actions, so the
// Scheduled rows, the Partially Paid badge and the multi-stage schedule on the
// Finance card have nothing to render without them.
const smokeQuote = s().addQuotation({
  client: 'Kirana Group',
  eventType: 'Annual Conference',
  eventDate: '2026-12-01',
  dpSchedule: [
    { label: 'Down Payment', basis: 'percent', value: 30, anchor: 'signing', offsetDays: 0 },
    { label: 'Production Milestone', basis: 'amount', value: 100_000_000, anchor: 'event', offsetDays: -30 },
    { label: 'Final Settlement', basis: 'percent', value: 40, anchor: 'event', offsetDays: 7 },
  ],
  lineItems: [
    { label: 'Venue & Staging', amount: 180_000_000, estCost: 126_000_000 },
    { label: 'AV & Vendors', amount: 134_000_000, estCost: 94_000_000 },
  ],
})
s().acceptQuotation(smokeQuote.id)
s().confirmDownPayment()
const smokeScheduled = s().invoices.find((i) => i.status === 'Scheduled')
if (smokeScheduled) {
  s().issueInvoice(smokeScheduled.id)
  // A part payment leaves a Partially Paid row and a live outstanding balance.
  s().receivePayment(smokeScheduled.id, { amount: Math.round(smokeScheduled.amount / 3) })
}
s().receivePayment('INV-0042', { amount: 40_000_000 })
s().receivePayment('INV-0042', { amount: 20_000_000, withhold: false })
// Phase C — the register renders differently before and after a run, and a
// disposed asset is its own row state.
s().runDepreciation()
s().capitaliseAsset({
  name: 'Haze Machine (4 units)', category: 'Atmospherics', acquiredOn: '2026-03-01',
  cost: 12_800_000, salvage: 1_280_000, usefulLifeMonths: 36, method: 'declining',
})
s().capitaliseAsset({
  name: 'Rigging Motors', category: 'Staging', acquiredOn: '2026-05-01',
  cost: 44_000_000, salvage: 4_400_000, usefulLifeMonths: 84, method: 'straight-line',
}, { post: false })
s().runDepreciation()
s().disposeAsset('FA-005', { proceeds: 38_000_000 })
s().updateAsset('FA-002', { usefulLifeMonths: 72 })
// Phase D — payables need an open bill, a part payment and a settled one; the
// petty-cash recap needs more than one requester to group by.
const smokeBill = s().journal.find(
  (e) => e.source?.kind === 'po' && e.source?.ref === 'PO-3004' && !e.reversedBy
)
if (smokeBill) s().payVendorBill(smokeBill.id, { amount: 40_000_000 })
s().addProcurementRequest({ project: 'EVT-2026-GALA-01', category: 'Petty Cash — Transport', amount: 2_400_000, by: 'Rina K.' })
s().addProcurementRequest({ project: 'EVT-2026-GALA-01', category: 'Field Cash Advance', amount: 6_000_000, by: 'Bagus S.' })
s().logInteraction('CL-02', { type: 'Meeting', note: 'Agreed a 50/50 payment split; site survey next Tuesday.' })

// Invitations v2, phase 4 — the guest page with wishes in every state (shown, waiting,
// hidden) and the music on an uploaded-song setting this server has no file for.
const p = () => useProto.getState()
p().addWish('EV-01', { guestId: 'G-001', text: 'Smoke test wish' })
p().setHoldWishes('EV-01', true)
p().addWish('EV-01', { name: 'Waiting Guest', text: 'Held for approval' })
p().setWishHidden('EV-01', 'W-3', true)
p().updateContent('EV-01', 'music', { kind: 'upload', trackId: 'soft-piano', file: { key: 'm-missing', name: 'song.mp3', size: 1, type: 'audio/mpeg' } })
// Round 3, Template Studio — a design-team template in the gallery (EV-03 still opens on the
// gallery, so it shows there with its badge), with artwork this server has no file for, and
// EV-01's guest page drawn in it.
const studioId = p().createTemplate({ from: 'gala' }, 'ceo')
p().updateTemplate(studioId, { name: 'Smoke Studio', cover: 'split', ornament: 'floral' }, 'ceo')
for (const slot of ['coverBg', 'pageBg', 'frame', 'ornament']) p().setTemplateArt(studioId, slot, { key: `m-missing-${slot}`, name: `${slot}.png`, size: 1, type: 'image/png' }, 'ceo')
p().publishTemplate(studioId, 'ceo')
p().chooseTemplate('EV-01', studioId)
p().publishInvite('EV-01')
// …and a second one left archived, which the list shows behind "Show archived".
p().archiveTemplate(p().createTemplate({ family: 'corporate' }, 'ceo'), 'ceo')
// Phase 5 — batches in every state (sent with a failure then retried, scheduled, cancelled)
// and a guest the client sent their own link to.
p().addGuests('EV-01', [{ name: 'Smoke Noemail', phone: '0812 5555 0001', email: '' }, { name: 'Smoke Later', phone: '0812 5555 0002', email: 'later@x.id' }])
const smokeBatch = p().sendBroadcast('EV-01', { channel: 'both', subject: 'You are invited', message: 'Hi {name}: {link}', audience: 'not_invited' })
p().setGuestEmail(p().guests.find((g) => g.name === 'Smoke Noemail').id, 'smoke@x.id')
p().retryFailed('EV-01', smokeBatch)
p().sendBroadcast('EV-01', { channel: 'whatsapp', message: 'VIP {name}: {link}', audience: 'VIP', scheduledAt: '2026-08-01T09:00' })
p().cancelBroadcast('EV-01', p().sendBroadcast('EV-01', { channel: 'email', subject: 'Later', message: '{link}', audience: 'Media', scheduledAt: '2026-08-02T09:00' }))
p().markSentByClient('EV-01', 'G-025')

renderAll('Pass 2 — after every mutating action')

// Round 3: the studio template reached the gallery (with its badge) and opens in its editor.
for (const [route, needles] of [['/events/EV-03?tab=invitation', ['Smoke Studio', 'Design team']], ['/events/templates?edit=studio-1', ['Smoke Studio', 'Cover artwork']]]) {
  const html = renderToString(<MemoryRouter initialEntries={[route]}><App /></MemoryRouter>)
  const ok = needles.every((n) => html.includes(n))
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${route.padEnd(30)} shows ${needles.join(' + ')}`)
}

// Each role filters the sidebar differently, which is its own render path.
console.log('\n=== Role switcher ===')
for (const role of ['sales', 'warehouse', 'pm', 'finance', 'ceo']) {
  s().setRole(role)
  try {
    const html = renderToString(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>
    )
    console.log(`PASS  role=${role.padEnd(24)} ${html.length} bytes`)
  } catch (err) {
    failures++
    console.log(`FAIL  role=${role.padEnd(24)} ${err.message}`)
  }
}

s().setLang('id')
renderAll('Pass 3 — Bahasa Indonesia')

console.log(`\n${failures === 0 ? 'ALL RENDER CHECKS PASSED' : failures + ' RENDER CHECK(S) FAILED'}\n`)
process.exit(failures === 0 ? 0 : 1)
