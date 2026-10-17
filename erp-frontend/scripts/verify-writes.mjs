// What each store action sends to the API once the app is signed in (W3).
//
// Nothing else guards the write path: verify-flows exercises the demo branch, verify-adapters
// pins the read shapes, and a wrong body is a silent 422 in the browser. Here `fetch` is a
// recorder, the store is marked hydrated, and every action is called the way a page calls it.
// For each: the method and path, the body (snake_case, as the server sees it), and that the
// collections it affects were re-read. The demo branch is checked too: not hydrated means no
// request at all.
//
// Run: npm run verify:writes   (vite-node: the store imports the API client)
import { useStore } from '../src/store/useStore.js'
import { adaptDeal, adaptDeliveryOrder, adaptLatestFeedback, adaptMouTemplate } from '../src/store/adapters.js'

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
}

// --- a fake server ----------------------------------------------------------
let calls = []
const reply = (path, method) => {
  if (method !== 'GET') return { id: 'new-uuid' }
  if (path.startsWith('/api/v1/journal-entries')) return { items: [], total: 0 }
  if (path === '/api/v1/petty-cash') return { balance: '0', opening: '0', toppedUp: '0', disbursed: '0', awaitingApproval: '0', awaitingCount: 0, asOf: '2026-01-01' }
  if (/^\/api\/v1\/projects\/[^/]+\/incentives$/.test(path)) return { projectId: 'p', eventScore: '9.1', threshold: '7', rows: [], pool: '1000', belowThreshold: 0, disbursed: false }
  if (path === '/api/v1/settings') return { budgetTolerancePct: '10', bonusThreshold: '7', commissionPct: '2.5' }
  return []
}
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url)
  const method = init.method || 'GET'
  const path = u.pathname
  const sent = typeof init.body === 'string' ? JSON.parse(init.body) : init.body ? '[form]' : undefined
  calls.push({ method, path, body: sent })
  const body = JSON.stringify(reply(path, method))
  return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) }
}

const s = () => useStore.getState()
const writes = () => calls.filter((c) => c.method !== 'GET')
const reads = () => new Set(calls.filter((c) => c.method === 'GET').map((c) => c.path.replace('/api/v1', '')))

/** Run `act` against a hydrated store; return the one write it made and what it re-read. */
async function live(act, state = {}) {
  calls = []
  useStore.setState({ hydrated: true, mutating: null, ...state })
  await act()
  const w = writes()
  return { w, one: w[0], reads: reads() }
}
async function demo(act) {
  calls = []
  useStore.setState({
    hydrated: false,
    mutating: null,
    taxConfig: { pph23: { label: 'PPh 23', rate: 2, active: true }, ppn: { label: 'PPN', rate: 11, active: true } },
  })
  await act()
  return calls
}

function expect(label, run, { method, path, body, rereads = [], count = 1 }) {
  return run.then(({ w, one, reads: r }) => {
    check(`${label} — ${count} write`, w.length === count, `${w.length}: ${w.map((x) => x.method + ' ' + x.path).join(', ')}`)
    if (!one) return
    check(`${label} — ${method} ${path}`, one.method === method && one.path === `/api/v1${path}`, `${one.method} ${one.path}`)
    if (body) {
      const bad = Object.entries(body).filter(([k, v]) => JSON.stringify(one.body?.[k]) !== JSON.stringify(v))
      check(`${label} — body`, bad.length === 0, bad.map(([k, v]) => `${k}: want ${JSON.stringify(v)}, sent ${JSON.stringify(one.body?.[k])}`).join('; '))
    }
    for (const k of rereads) check(`${label} — re-reads ${k}`, r.has(k))
  })
}

// --- fixtures ---------------------------------------------------------------
const vendor = { id: 'V-01', uuid: 'vend-uuid', name: 'Nusa Rigging', terms: { dpPercent: 50, settlementDays: 14 } }
const project = { id: 'EVT-2026-0001', uuid: 'proj-uuid', stage: 'DP Paid' }
const item = { id: 'CAT-1', uuid: 'cat-uuid', vendorId: 'V-01', item: 'Truss', unitPrice: 1000 }
const account = { code: '6101', name: 'Rent', type: 'opex', group: 'Rent' }
const tag = { id: 'staging', label: 'Staging' }

// --- phase A ----------------------------------------------------------------
console.log('phase A — masters')
await expect('addVendor', live(() => s().addVendor({
  name: ' Acme ', category: 'Lighting', baseline: 5000, npwp: '', pph23Rate: 2,
  bank: { name: 'BCA', account: '123', holder: 'Acme' }, pic: { name: 'Ann', phone: '', email: 'a@x.id' },
  terms: { dpPercent: 30, settlementDays: 7 }, tags: ['staging'],
}), { vendors: [] }), {
  method: 'POST', path: '/vendors', rereads: ['/vendors'],
  body: {
    name: 'Acme', category: 'Lighting', baseline_price: '5000', npwp: null, pph23_rate: 2, bank_name: 'BCA',
    bank_account: '123', bank_holder: 'Acme', pic_name: 'Ann', pic_phone: null, pic_email: 'a@x.id',
    terms_dp_percent: 30, terms_settlement_days: 7, tags: ['staging'],
  },
})

await expect('updateVendor sends only what changed, flat and snake_case', live(() => s().updateVendor('V-01', {
  bank: { name: ' BNI ', account: '999' }, pic: { email: 'new@x.id' }, terms: { dpPercent: 120, settlementDays: 21.6 },
}), { vendors: [vendor] }), {
  method: 'PATCH', path: '/vendors/vend-uuid', rereads: ['/vendors'],
  body: { bank_name: 'BNI', bank_account: '999', pic_email: 'new@x.id', terms_dp_percent: 100, terms_settlement_days: 22 },
})
{
  const got = await live(() => s().updateVendor('V-01', {}), { vendors: [vendor] })
  check('an edit with no changes sends nothing', got.w.length === 0)
  const clear = await live(() => s().updateVendor('V-01', { npwp: '  ' }), { vendors: [vendor] })
  check('clearing a field is sent as an empty text, which the server reads as "clear it"', clear.w[0]?.body?.npwp === '')
  const unsaved = await live(() => s().updateVendor('V-01', { npwp: '1' }), { vendors: [{ ...vendor, uuid: undefined }] })
  check('a vendor with no server id is not edited (it would only change browser memory)', unsaved.w.length === 0)
}

await expect('updateProject sends only what changed, in snake_case', live(() => s().updateProject('EVT-2026-0001', {
  name: ' Aurora Summit ', eventDate: '2026-12-20',
}), { projects: [project] }), {
  method: 'PATCH', path: '/projects/proj-uuid', rereads: ['/projects', '/invoices'],
  body: { name: 'Aurora Summit', event_date: '2026-12-20' },
})
{
  const none = await live(() => s().updateProject('EVT-2026-0001', {}), { projects: [project] })
  check('a project edit with no changes sends nothing', none.w.length === 0)
  const unsaved = await live(() => s().updateProject('EVT-2026-0001', { name: 'X' }), { projects: [{ ...project, uuid: undefined }] })
  check('a project with no server id is not edited', unsaved.w.length === 0)
}
const crewMember = { id: 'CR-01', uuid: 'crew-uuid', name: 'Bagus', baseRate: 5000000, lastRating: 8 }
await expect('addCrew', live(() => s().addCrew({ name: ' Sari ', role: 'Rigger', baseRate: 4000000, lastRating: 6.5 }), { crew: [] }), {
  method: 'POST', path: '/crew', rereads: ['/crew'],
  body: { name: 'Sari', role: 'Rigger', base_rate: '4000000', last_rating: '6.5' },
})
await expect('updateCrew', live(() => s().updateCrew('CR-01', { baseRate: 5500000, lastRating: 12 }), { crew: [crewMember] }), {
  method: 'PATCH', path: '/crew/crew-uuid', rereads: ['/crew'],
  body: { base_rate: '5500000', last_rating: '10' },
})
await expect('setCrewActive off', live(() => s().setCrewActive('CR-01', false), { crew: [crewMember] }), {
  method: 'POST', path: '/crew/crew-uuid/deactivate', rereads: ['/crew'],
})
await expect('setCrewActive on', live(() => s().setCrewActive('CR-01', true), { crew: [crewMember] }), {
  method: 'POST', path: '/crew/crew-uuid/reactivate', rereads: ['/crew'],
})
await expect('deleteCrew', live(() => s().deleteCrew('CR-01'), { crew: [crewMember] }), {
  method: 'DELETE', path: '/crew/crew-uuid', rereads: ['/crew'],
})

await expect('addTag', live(() => s().addTag('Staging Crew'), { tags: [] }), {
  method: 'POST', path: '/tags', body: { id: 'staging-crew', label: 'Staging Crew' }, rereads: ['/tags'],
})
{
  const got = await live(() => s().addTag('Staging Crew'), { tags: [] })
  void got
  const r = await (async () => { useStore.setState({ hydrated: true, tags: [] }); return s().addTag('Staging Crew') })()
  check('addTag resolves to the tag once it is saved', r?.id === 'staging-crew')
  const dup = await (async () => { useStore.setState({ hydrated: true, tags: [tag] }); calls = []; return s().addTag('Staging') })()
  check('typing an existing tag makes no request and returns it', dup?.id === 'staging' && writes().length === 0)
}
await expect('deleteTag', live(() => s().deleteTag('staging'), { tags: [tag] }), {
  method: 'DELETE', path: '/tags/staging', rereads: ['/tags', '/vendors', '/vendor-catalogue'],
})

await expect('setTaxRate', live(() => s().setTaxRate('pph23', '2.5'), { taxConfig: { pph23: { label: 'PPh 23', rate: 2, active: true } } }), {
  method: 'PATCH', path: '/tax-config/pph23', body: { rate: 2.5 }, rereads: ['/tax-config'],
})
await expect('toggleTax', live(() => s().toggleTax('ppn'), { taxConfig: { ppn: { label: 'PPN', rate: 11, active: true } } }), {
  method: 'PATCH', path: '/tax-config/ppn', body: { active: false }, rereads: ['/tax-config'],
})

await expect('createPurchaseOrder', live(() => s().createPurchaseOrder({
  vendorId: 'V-01', project: 'EVT-2026-0001', eventDate: '2026-12-01',
  lines: [{ itemId: 'CAT-1', item: 'Truss', qty: 2.5, unitPrice: 1000 }],
  terms: { dpPercent: 40, settlementDays: 14 },
}), { vendors: [vendor], projects: [project], vendorCatalogue: [item], purchaseOrders: [] }), {
  method: 'POST', path: '/purchase-orders', rereads: ['/purchase-orders'],
  body: {
    vendor_id: 'vend-uuid', project_id: 'proj-uuid', event_date: '2026-12-01', terms_dp_percent: 40, terms_settlement_days: 14,
    lines: [{ catalogue_item_id: 'cat-uuid', item_label: 'Truss', qty: '2.5', unit_price: '1000' }],
  },
})
{
  const w = await live(() => s().createPurchaseOrder({
    vendorId: 'V-01', project: 'EVT-2026-0001', lines: [{ itemId: 'CAT-1', item: 'Truss', qty: 1, unitPrice: 1 }], terms: {},
  }), { vendors: [{ ...vendor, uuid: undefined }], projects: [project], vendorCatalogue: [item], purchaseOrders: [] })
  check('a PO for a vendor with no server key is refused before any request', w.w.length === 0)
}

await expect('addAccount (sub-account)', live(() => s().addAccount({
  code: '6101.01', name: 'Office rent', type: 'opex', group: 'Rent', parent: '6101', cash: false,
}), { accounts: [account] }), {
  method: 'POST', path: '/accounts', rereads: ['/accounts'],
  body: { code: '6101.01', name: 'Office rent', type: 'opex', group_label: 'Rent', parent_code: '6101', is_cash: false },
})
await expect('updateAccount renames only', live(() => s().updateAccount('6101', { name: 'Premises rent', group: 'Rent' }), { accounts: [account], journal: [] }), {
  method: 'PATCH', path: '/accounts/6101', body: { name: 'Premises rent', group_label: 'Rent' }, rereads: ['/accounts'],
})
{
  const w = await live(() => s().updateAccount('6101', { name: 'x', code: '6102' }), { accounts: [account], journal: [{ lines: [{ account: '6101' }] }] })
  check('a locked code change is refused before any request', w.w.length === 0)
}
await expect('setAccountActive(false)', live(() => s().setAccountActive('6101', false), { accounts: [account] }), {
  method: 'POST', path: '/accounts/6101/deactivate', rereads: ['/accounts'],
})
await expect('setAccountActive(true)', live(() => s().setAccountActive('6101', true), { accounts: [account] }), {
  method: 'POST', path: '/accounts/6101/activate', rereads: ['/accounts'],
})
await expect('deleteAccount', live(() => s().deleteAccount('6101'), { accounts: [account], journal: [] }), {
  method: 'DELETE', path: '/accounts/6101', rereads: ['/accounts'],
})


// --- phase B ----------------------------------------------------------------
console.log('phase B — the sales cycle')
const client = { id: 'CL-01', uuid: 'client-uuid', name: 'Aurora Bank' }
const quote = { id: 'QT-1001', uuid: 'quote-uuid', status: 'Draft', client: 'Aurora Bank', eventType: 'Gala' }
const stages = [
  { label: 'Down Payment', basis: 'percent', value: 50, anchor: 'signing', offsetDays: 0 },
  { label: 'Final Settlement', basis: 'percent', value: 50, anchor: 'event', offsetDays: -7 },
]
const draft = {
  client: 'Aurora Bank', eventType: ' Gala ', eventDate: '2026-12-01', template: 'corporate',
  dpSchedule: stages, dpPercent: 50, lineItems: [{ label: 'Staging', amount: 480000000, estCost: 336000000 }],
}
await expect('addQuotation', live(() => s().addQuotation(draft), { clients: [client], quotations: [] }), {
  method: 'POST', path: '/quotations', rereads: ['/quotations'],
  body: {
    client_id: 'client-uuid', event_type: 'Gala', event_date: '2026-12-01', mou_template_id: 'corporate',
    lines: [{ label: 'Staging', amount: '480000000', est_cost: '336000000' }],
    stages: [
      { label: 'Down Payment', basis: 'percent', value: '50', anchor: 'signing', offset_days: 0 },
      { label: 'Final Settlement', basis: 'percent', value: '50', anchor: 'event', offset_days: -7 },
    ],
  },
})
{
  const w = await live(() => s().addQuotation({ ...draft, client: 'Nobody' }), { clients: [client], quotations: [] })
  check('a quotation for a client with no server key is refused before any request', w.w.length === 0)
}
await expect('updateQuotation (never moves the client)', live(() => s().updateQuotation('QT-1001', draft), { clients: [client], quotations: [quote] }), {
  method: 'PATCH', path: '/quotations/quote-uuid', rereads: ['/quotations'],
  body: { event_type: 'Gala', event_date: '2026-12-01', mou_template_id: 'corporate' },
})
{
  const w = await live(() => s().updateQuotation('QT-1001', draft), { clients: [client], quotations: [quote] })
  check('the patch carries no client_id', !('client_id' in (w.one?.body || {})))
  const r = await live(() => s().updateQuotation('QT-1001', draft), { clients: [client], quotations: [{ ...quote, status: 'Accepted' }] })
  check('an accepted quotation is refused before any request', r.w.length === 0)
}
await expect('sendQuotation', live(() => s().sendQuotation('QT-1001'), { quotations: [quote] }), {
  method: 'POST', path: '/quotations/quote-uuid/send', rereads: ['/quotations'],
})
await expect('acceptQuotation', live(() => s().acceptQuotation('QT-1001'), { quotations: [{ ...quote, status: 'Sent' }] }), {
  method: 'POST', path: '/quotations/quote-uuid/accept', rereads: ['/quotations', '/projects'],
})
await expect('cancelQuotation → decline', live(() => s().cancelQuotation('QT-1001'), { quotations: [{ ...quote, status: 'Sent' }] }), {
  method: 'POST', path: '/quotations/quote-uuid/decline', rereads: ['/quotations'],
})

const proj = { id: 'EVT-2026-0001', uuid: 'proj-uuid', stage: 'Design Uploaded', cancelled: false }
await expect('advanceStage', live(() => s().advanceStage('EVT-2026-0001'), { projects: [proj] }), {
  method: 'POST', path: '/projects/proj-uuid/advance-stage', rereads: ['/projects'],
})
await expect('revertStage', live(() => s().revertStage('EVT-2026-0001'), { projects: [proj] }), {
  method: 'POST', path: '/projects/proj-uuid/revert-stage', rereads: ['/projects'],
})
await expect('moveProjectToStage', live(() => s().moveProjectToStage('EVT-2026-0001', 'Vendor Dispatch'), { projects: [proj] }), {
  method: 'POST', path: '/projects/proj-uuid/move-to-stage', body: { stage: 'Vendor Dispatch' }, rereads: ['/projects'],
})
await expect('cancelProject (refund)', live(() => s().cancelProject('EVT-2026-0001', { refundDp: true, reason: 'client left' }), { projects: [proj] }), {
  method: 'POST', path: '/projects/proj-uuid/cancel', body: { reason: 'client left', refund_dp: true },
  rereads: ['/projects', '/invoices', '/purchase-orders'],
})
{
  // Entering the feedback stage must not fire the demo survey (it rated the client with a made-up score).
  const feedbackProj = { ...proj, stage: 'Execution Event' }
  const w = await live(() => s().advanceStage('EVT-2026-0001'), { projects: [feedbackProj], latestFeedback: null })
  check('advancing into feedback sets no demo rating', s().latestFeedback === null)
  void w
}
{
  const deal = adaptDeal({
    id: 'QT-1001', client: 'Aurora Bank', eventType: 'Gala', contractValue: 100, estimatedCost: 70,
    eventDate: '2026-12-01', projectId: null, dpSchedule: [{ amount: 50, percent: 50 }],
  })
  check('an accepted quotation with no project is a pending deal', deal.id === 'DEAL-QT-1001' && deal.confirmed === false && deal.dpAmount === 50)
  check('one with a project is a confirmed deal carrying its number', adaptDeal({ ...deal, id: 'QT-1', client: 'x', eventType: 'y', dpSchedule: [], projectId: 'EVT-1' }).confirmed === true)
}


// --- phase C ----------------------------------------------------------------
console.log('phase C — procurement, petty cash, settings')
const req = { id: 'PR-105', uuid: 'req-uuid', category: 'Petty cash', amount: 500000, status: 'Pending' }
await expect('topUpPettyCash', live(() => s().topUpPettyCash(2500000), {}), {
  method: 'POST', path: '/petty-cash/top-up', body: { amount: '2500000' }, rereads: ['/petty-cash', '/journal-entries'],
})
await expect('addProcurementRequest (named requester)', live(() => s().addProcurementRequest({
  category: 'Petty cash', amount: 750000, project: 'EVT-2026-0001', by: 'Rina M.',
}), { projects: [project], procurement: [] }), {
  method: 'POST', path: '/procurement-requests', rereads: ['/procurement-requests'], count: 2,
  body: { category: 'Petty cash', amount: '750000', project_id: 'proj-uuid', requested_by: 'Rina M.' },
})
{
  // The form says "submitted straight to Pending"; the server opens a Draft, so the same action submits it.
  const got = await live(() => s().addProcurementRequest({ category: 'Petty cash', amount: 1, project: 'EVT-2026-0001', by: 'Rina M.' }), { projects: [project], procurement: [] })
  check('a new request is submitted to Pending in the same action', got.w[1]?.path === '/api/v1/procurement-requests/new-uuid/transition' && got.w[1]?.body?.status === 'Pending', JSON.stringify(got.w.map((x) => x.path)))
}
{
  const w = await live(() => s().addProcurementRequest({ category: 'x', amount: 1, project: 'EVT-2026-0001', by: '  ' }), { projects: [project], procurement: [] })
  check('a blank requester is refused before any request', w.w.length === 0)
}
for (const status of ['Pending', 'Approved', 'Rejected', 'Disbursed']) {
  await expect(`setProcurementStatus ${status}`, live(() => s().setProcurementStatus('PR-105', status), { procurement: [req] }), {
    method: 'POST', path: '/procurement-requests/req-uuid/transition', body: { status }, rereads: ['/procurement-requests', '/petty-cash'],
  })
}
{
  const file = new File([new Uint8Array([1, 2, 3])], 'toll.jpg', { type: 'image/jpeg' })
  const got = await live(() => s().settleAdvance('PR-105', 450000, [file]), { procurement: [{ ...req, status: 'Disbursed' }] })
  check('settleAdvance uploads the receipt first', got.w[0]?.method === 'POST' && got.w[0]?.path === '/api/v1/attachments' && got.w[0]?.body === '[form]')
  check('then settles with the stored attachment ids', got.w[1]?.path === '/api/v1/procurement-requests/req-uuid/settle'
    && JSON.stringify(got.w[1]?.body) === JSON.stringify({ actual: '450000', attachment_ids: ['new-uuid'] }))
  check('and re-reads procurement, petty cash and the journal', ['/procurement-requests', '/petty-cash', '/journal-entries'].every((k) => got.reads.has(k)))
  const none = await live(() => s().settleAdvance('PR-105', 450000, ['toll.jpg']), { procurement: [{ ...req, status: 'Disbursed' }] })
  check('a typed filename is not a receipt: nothing is sent', none.w.length === 0)
}
await expect('setBudgetTolerance', live(() => s().setBudgetTolerance(15), {}), {
  method: 'PATCH', path: '/settings', body: { budget_tolerance_pct: '15' }, rereads: ['/settings'],
})
await expect('setProjectPm names the PM by their server id', live(() => s().setProjectPm('EVT-1', 'user-uuid'), { projects: [{ id: 'EVT-1', uuid: 'proj-uuid' }] }), {
  method: 'PUT', path: '/projects/proj-uuid/pm', body: { user_id: 'user-uuid' }, rereads: ['/projects'],
})
await expect('setProjectPm with no one clears it', live(() => s().setProjectPm('EVT-1', ''), { projects: [{ id: 'EVT-1', uuid: 'proj-uuid' }] }), {
  method: 'PUT', path: '/projects/proj-uuid/pm', body: { user_id: null }, rereads: ['/projects'],
})
await expect('setCommissionPct clamps to 0-100', live(() => s().setCommissionPct(150), {}), {
  method: 'PATCH', path: '/settings', body: { commission_pct: '100' }, rereads: ['/settings'],
})
await expect('setBonusThreshold clamps to 0-10', live(() => s().setBonusThreshold(99), {}), {
  method: 'PATCH', path: '/settings', body: { bonus_threshold: '10' }, rereads: ['/settings'],
})
{
  const got = await live(() => s().setBonusThreshold(8), { bonusThreshold: 1 })
  check('the re-read settings land in the field the page reads', s().bonusThreshold === 7, String(s().bonusThreshold))
  void got
  const w = await live(() => s().addUnplannedCost(), { budgetFlagged: false })
  check('the demo "unplanned cost" posts nothing on a real ledger', w.w.length === 0 && s().budgetFlagged === false)
}


// --- phase D ----------------------------------------------------------------
console.log('phase D — assets, warehouse, payroll')
const asset = { id: 'FA-001', uuid: 'asset-uuid', name: 'LED wall', status: 'active', cost: 100, postedThrough: null }
const stock = { id: 'IT-01', uuid: 'item-uuid', item: 'Truss', type: 'Fixed Asset', status: 'in_stock', qty: 10, unit: 'pcs', unitValue: 100, projectUuid: 'proj-uuid' }
const cons = { id: 'IT-02', uuid: 'cons-uuid', item: 'Tape', type: 'Consumable', status: 'in_stock', qty: 50, unit: 'roll', unitValue: 10 }
await expect('capitaliseAsset', live(() => s().capitaliseAsset({
  name: ' LED wall ', category: 'AV', inventoryId: 'IT-01', acquiredOn: '2026-01-05', cost: 120000000, salvage: 0, usefulLifeMonths: 36, method: 'straight-line',
}, { post: false, payFrom: '1101' }), { fixedAssets: [], inventory: [stock] }), {
  method: 'POST', path: '/fixed-assets', rereads: ['/fixed-assets', '/journal-entries'],
  body: { name: 'LED wall', category: 'AV', inventory_item_id: 'item-uuid', acquired_on: '2026-01-05', cost: '120000000', salvage: '0', useful_life_months: 36, method: 'straight-line', post: false, pay_from: '1101' },
})
await expect('runDepreciation (the whole backlog)', live(() => s().runDepreciation(), { fixedAssets: [asset] }), {
  method: 'POST', path: '/depreciation/run', body: {}, rereads: ['/fixed-assets', '/journal-entries'],
})
await expect('runDepreciationPeriod', live(() => s().runDepreciationPeriod('2026-03'), { fixedAssets: [asset] }), {
  method: 'POST', path: '/depreciation/run', body: { period: '2026-03' },
})
await expect('disposeAsset', live(() => s().disposeAsset('FA-001', { proceeds: 5000 }), { fixedAssets: [asset] }), {
  method: 'POST', path: '/fixed-assets/asset-uuid/dispose', body: { proceeds: '5000' }, rereads: ['/fixed-assets', '/journal-entries'],
})
await expect('checkOutAsset', live(() => s().checkOutAsset('IT-01', 'EVT-2026-0001', '2026-12-01'), { inventory: [stock], projects: [project] }), {
  method: 'POST', path: '/inventory/item-uuid/check-out', body: { project_id: 'proj-uuid', event_date: '2026-12-01' }, rereads: ['/inventory'],
})
await expect('checkInAsset (good 6, damaged 3, lost 1)', live(() => s().checkInAsset('IT-01', { good: 6, damaged: 3, lost: 1 }), { inventory: [{ ...stock, status: 'in_transit' }] }), {
  method: 'POST', path: '/inventory/item-uuid/return', body: { condition: 'good', lost_qty: '1', damaged_qty: '3', project_id: 'proj-uuid' },
  rereads: ['/inventory', '/fixed-assets', '/journal-entries'],
})
await expect('releaseConsumable', live(() => s().releaseConsumable('IT-02', 5, 'EVT-2026-0001'), { inventory: [cons], projects: [project] }), {
  method: 'POST', path: '/inventory/cons-uuid/release', body: { qty: '5', project_id: 'proj-uuid' }, rereads: ['/inventory', '/journal-entries'],
})
await expect('resolveMaintenance repaired', live(() => s().resolveMaintenance('IT-01', 'repaired'), { inventory: [{ ...stock, status: 'maintenance' }] }), {
  method: 'POST', path: '/inventory/item-uuid/repair', rereads: ['/inventory'],
})
await expect('resolveMaintenance condemned', live(() => s().resolveMaintenance('IT-01', 'condemned'), { inventory: [{ ...stock, status: 'maintenance' }] }), {
  method: 'POST', path: '/inventory/item-uuid/condemn', rereads: ['/inventory', '/journal-entries'],
})
await expect('addInventoryItem', live(() => s().addInventoryItem({ item: ' Gaffer ', type: 'Consumable', qty: 20, unit: 'roll', unitValue: 50000 }), { inventory: [] }), {
  method: 'POST', path: '/inventory', body: { item: 'Gaffer', type: 'Consumable', qty: '20', unit: 'roll', unit_value: '50000' }, rereads: ['/inventory'],
})
await expect('submitSurvey', live(() => s().submitSurvey('EVT-2026-0001', 9.1), { projects: [{ ...project, name: 'Gala' }], crew: [] }), {
  method: 'PUT', path: '/projects/proj-uuid/feedback', body: { score: '9.1' }, rereads: ['/projects'],
})
await expect('disburseIncentives (the server pays its own pool)', live(() => s().disburseIncentives(123, 'EVT-2026-0001'), { projects: [project], incentivesPaid: false }), {
  method: 'POST', path: '/incentives/disburse', body: { project_id: 'proj-uuid' }, rereads: ['/projects', '/journal-entries'],
})
{
  const w = await live(() => s().disburseIncentives(123, ''), { projects: [project], incentivesPaid: false })
  check('disbursing with no project picked sends nothing', w.w.length === 0)
}
{
  const pools = { 'EVT-1': { eventScore: '8.5', pool: '500', disbursed: false }, 'EVT-2': { eventScore: '9.1', pool: '700', disbursed: true }, 'EVT-3': { eventScore: null } }
  const r = adaptLatestFeedback([
    { id: 'EVT-1', name: 'A', client: 'x', stageSince: '2026-05-01' },
    { id: 'EVT-2', name: 'B', client: 'y', stageSince: '2026-06-01' },
    { id: 'EVT-3', name: 'C', client: 'z', stageSince: '2026-07-01' },
  ], pools)
  check('the latest rated project drives the Payroll card', r.latestFeedback?.projectId === 'EVT-2' && r.latestFeedback.score === 9.1 && r.incentivesPaid === true)
  check('nothing rated means no card', adaptLatestFeedback([{ id: 'EVT-3', stageSince: 'x' }], { 'EVT-3': { eventScore: null } }).latestFeedback === null)
}
for (const [label, act] of [
  ['runCron', () => s().runCron()],
]) {
  const w = await live(act, { mouTemplates: [{ id: 'a', label: 'A', clauses: [] }] })
  check(`${label} has no server side yet: nothing is sent, and it says so`, w.w.length === 0 && s().toasts?.some?.((t) => t.title === 'Not saved') !== false)
}

// --- backlog item 1: tags -------------------------------------------------------------------
console.log('backlog 1 — rename a tag, tag a catalogue item')
await expect('renameTag', live(() => s().renameTag('staging', '  Staging & Truss '), { tags: [tag] }), {
  method: 'PATCH', path: '/tags/staging', body: { label: 'Staging & Truss' }, rereads: ['/tags'],
})
{
  const w = await live(() => s().renameTag('staging', '   '), { tags: [tag] })
  check('a blank new name sends nothing', w.w.length === 0)
}
const line = { id: 'CAT-1', uuid: 'cat-uuid', item: 'Truss', tags: ['staging'] }
await expect('addCatalogueItem posts the server key and money as strings', live(() => s().addCatalogueItem({
  vendorId: 'V-01', item: ' LED Wall ', category: 'visual ', subcategory: '', unitPrice: 2400000, stock: '5', unit: 'm2', tags: ['led'],
}), { vendors: [{ id: 'V-01', uuid: 'vendor-uuid', name: 'Lumina' }], vendorCatalogue: [] }), {
  method: 'POST', path: '/vendor-catalogue', rereads: ['/vendor-catalogue'],
  body: { vendor_id: 'vendor-uuid', item: 'LED Wall', category: 'visual', subcategory: null, unit_price: '2400000', stock: '5', unit: 'm2', tags: ['led'] },
})
await expect('toggleCatalogueTag adds a tag', live(() => s().toggleCatalogueTag('CAT-1', 'led'), { vendorCatalogue: [line] }), {
  method: 'PATCH', path: '/vendor-catalogue/cat-uuid', body: { tags: ['staging', 'led'] }, rereads: ['/vendor-catalogue'],
})
await expect('toggleCatalogueTag removes one that is there', live(() => s().toggleCatalogueTag('CAT-1', 'staging'), { vendorCatalogue: [line] }), {
  method: 'PATCH', path: '/vendor-catalogue/cat-uuid', body: { tags: [] },
})
await expect('toggleCatalogueTag copes with tag objects from the API', live(() => s().toggleCatalogueTag('CAT-1', 'led'), { vendorCatalogue: [{ ...line, tags: [{ id: 'staging', label: 'Staging' }] }] }), {
  method: 'PATCH', path: '/vendor-catalogue/cat-uuid', body: { tags: ['staging', 'led'] },
})

// --- backlog item 2: MoU templates ----------------------------------------------------------
console.log('backlog 2 — MoU templates')
const tpl = { id: 'corporate', label: 'Corporate', heading: 'MOU', validity: 'v', signatory: 's', clauses: ['One', 'Two'] }
await expect('saveMouTemplate sends the whole edited template once', live(() => s().saveMouTemplate('corporate', { ...tpl, label: 'Corporate 2027', validity: '', clauses: ['Two', 'One', 'Three'] }), { mouTemplates: [tpl] }), {
  method: 'PATCH', path: '/mou-templates/corporate', rereads: ['/mou-templates'],
  body: { label: 'Corporate 2027', heading: 'MOU', validity: null, signatory: 's', clauses: ['Two', 'One', 'Three'] },
})
await expect('addMouTemplate', live(() => s().addMouTemplate({ label: 'Gala Dinner', clauses: ['Scope.'] }), { mouTemplates: [tpl] }), {
  method: 'POST', path: '/mou-templates', rereads: ['/mou-templates'],
  body: { id: 'gala-dinner', label: 'Gala Dinner', clauses: ['Scope.'] },
})
await expect('addMouTemplate makes the id unique against what is loaded', live(() => s().addMouTemplate({ label: 'Corporate' }), { mouTemplates: [tpl] }), {
  method: 'POST', path: '/mou-templates', body: { id: 'corporate-2' },
})
await expect('duplicateMouTemplate is a create from the source', live(() => s().duplicateMouTemplate('corporate'), { mouTemplates: [tpl] }), {
  method: 'POST', path: '/mou-templates', body: { label: 'Corporate (copy)', clauses: ['One', 'Two'] },
})
await expect('deleteMouTemplate', live(() => s().deleteMouTemplate('corporate'), { mouTemplates: [tpl, { ...tpl, id: 'wedding' }], quotations: [] }), {
  method: 'DELETE', path: '/mou-templates/corporate', rereads: ['/mou-templates', '/quotations'],
})
{
  const keep = await live(() => s().updateMouTemplate('corporate', { label: 'x' }), { mouTemplates: [tpl] })
  check('editing outside the manager (no Save) sends nothing: the manager saves whole', keep.w.length === 0)
}
{
  const m = adaptMouTemplate({ id: 'a', label: 'A', heading: 'H', validity: null, signatory: null, isDefault: true, clauses: [{ clauseNo: 2, text: 'Second' }, { clauseNo: 1, text: 'First' }] })
  check('a template from the API: clauses come back as text, in clause order', JSON.stringify(m.clauses) === JSON.stringify(['First', 'Second']))
  check('and a missing validity or signatory is an empty string the inputs can show', m.validity === '' && m.signatory === '' && m.isDefault === true)
}

// --- backlog item 6: a real file on a CRM note ----------------------------------------------
console.log('backlog 6 — files on CRM notes')
{
  const file = new File([new Uint8Array([37, 80, 68, 70])], 'brief.pdf', { type: 'application/pdf' })
  const note = { id: 'note-uuid', date: '2026-07-01', note: 'x', attachments: [] }
  const got = await live(() => s().attachToInteraction('CL-01', 'note-uuid', file), { clients: [{ id: 'CL-01', uuid: 'cl-uuid' }], interactions: { 'CL-01': [note] } })
  check('a real file is uploaded first', got.w[0]?.path === '/api/v1/attachments' && got.w[0]?.body === '[form]')
  check('then filed against the note by its stored id', got.w[1]?.path === '/api/v1/interactions/note-uuid/attachments' && JSON.stringify(got.w[1]?.body) === JSON.stringify({ attachment_id: 'new-uuid' }))
  const typed = await live(() => s().attachToInteraction('CL-01', 'note-uuid', 'brief.pdf'), { interactions: { 'CL-01': [note] } })
  check('a typed name is not a file: nothing is sent', typed.w.length === 0)
  await expect('detachFromInteraction', live(() => s().detachFromInteraction('CL-01', 'note-uuid', 'file-uuid'), { clients: [{ id: 'CL-01', uuid: 'cl-uuid' }], interactions: { 'CL-01': [note] } }), {
    method: 'DELETE', path: '/interactions/note-uuid/attachments/file-uuid',
  })
}

// --- backlog item 7: delivery orders --------------------------------------------------------
console.log('backlog 7 — delivery orders')
{
  const stockLine = { id: 'IT-01', uuid: 'item-uuid', item: 'Truss', type: 'Fixed Asset', status: 'in_stock', qty: 10, unit: 'pcs' }
  await expect('createDeliveryOrder: a stock line and a free-text line, quantities as strings', live(() => s().createDeliveryOrder({
    project: 'EVT-2026-0001', eventDate: '2026-12-01',
    lines: [{ itemId: 'IT-01', item: 'Truss', qty: 4 }, { itemId: null, item: ' Cable ramps ', qty: 6 }, { itemId: 'IT-01', item: 'x', qty: 0 }],
  }), { projects: [project], inventory: [stockLine], deliveryOrders: [] }), {
    method: 'POST', path: '/delivery-orders', rereads: ['/delivery-orders'],
    body: { project_id: 'proj-uuid', event_date: '2026-12-01', lines: [
      { inventory_item_id: 'item-uuid', item: null, qty: '4' },
      { inventory_item_id: null, item: 'Cable ramps', qty: '6' },
    ] },
  })
  const none = await live(() => s().createDeliveryOrder({ project: 'EVT-2026-0001', lines: [{ itemId: null, item: '', qty: 3 }, { itemId: 'IT-01', qty: 0 }] }), { projects: [project], inventory: [stockLine], deliveryOrders: [] })
  check('a draft with nothing in it sends nothing', none.w.length === 0)
  const orphan = await live(() => s().createDeliveryOrder({ project: 'EVT-NOPE', lines: [{ itemId: null, item: 'x', qty: 1 }] }), { projects: [project], inventory: [], deliveryOrders: [] })
  check('a project with no server key sends nothing', orphan.w.length === 0)
  await expect('advanceDeliveryOrder', live(() => s().advanceDeliveryOrder('DO-2203'), { deliveryOrders: [{ id: 'DO-2203', uuid: 'do-uuid', project: 'EVT-2026-0001', status: 'Draft', lines: [] }] }), {
    method: 'POST', path: '/delivery-orders/do-uuid/advance', rereads: ['/delivery-orders'],
  })
  const o = adaptDeliveryOrder({ id: 'u', doNo: 'DO-2203', projectId: 'pu', status: 'Dispatched', signed: true, dispatchedOn: '2026-07-26', receivedOn: null, eventDate: '2026-12-01', lines: [{ lineNo: 1, inventoryItemId: 'su', itemLabel: 'Truss', qty: '4.00' }, { lineNo: 2, inventoryItemId: null, itemLabel: 'Ramps', qty: '6.00' }] }, { projects: new Map([['pu', { projectNo: 'EVT-1' }]]) })
  check('an order from the API: its number, the project number the screens use, quantities as numbers', o.id === 'DO-2203' && o.project === 'EVT-1' && o.lines[0].qty === 4 && o.signed === true)
  check('a free-text line gets a key the table can use', o.lines[1].itemId === 'line-2' && o.lines[1].stockUuid === null)
}

// --- backlog item 3: fixed-asset edit -------------------------------------------------------
console.log('backlog 3 — editing a fixed asset')
{
  const a = { id: 'FA-001', uuid: 'asset-uuid', name: 'LED wall', category: 'AV', status: 'active', cost: 120000000, salvage: 0, usefulLifeMonths: 36, method: 'straight-line', acquiredOn: '2026-01-05', postedThrough: null }
  await expect('updateAsset sends only what can be revised', live(() => s().updateAsset('FA-001', { name: ' LED wall 2.6mm ', salvage: 5000000, usefulLifeMonths: 48, method: 'declining', cost: 1, postedThrough: '2026-03' }), { fixedAssets: [a] }), {
    method: 'PATCH', path: '/fixed-assets/asset-uuid', rereads: ['/fixed-assets'],
    body: { name: 'LED wall 2.6mm', salvage: '5000000', useful_life_months: 48, method: 'declining' },
  })
  {
    const w = await live(() => s().updateAsset('FA-001', { cost: 5 }), { fixedAssets: [a] })
    check('cost alone is not revisable: nothing is sent', w.w.length === 0)
    const bad = await live(() => s().updateAsset('FA-001', { usefulLifeMonths: 0 }), { fixedAssets: [a] })
    check('a life of zero is refused before any request', bad.w.length === 0)
    const big = await live(() => s().updateAsset('FA-001', { salvage: 999999999 }), { fixedAssets: [a] })
    check('a salvage value above cost is refused before any request', big.w.length === 0)
  }
}

console.log('the demo (not signed in) sends nothing')
for (const [label, act] of [
  ['addVendor', () => s().addVendor({ name: 'Demo', category: 'x', terms: {} })],
  ['addTag', () => s().addTag('Demo tag')],
  ['addCatalogueItem', () => s().addCatalogueItem({ vendorId: 'V-01', item: 'Demo', unitPrice: 1 })],
  ['setTaxRate', () => s().setTaxRate('pph23', 3)],
  ['toggleTax', () => s().toggleTax('ppn')],
  ['advanceStage', () => s().advanceStage('EVT-2026-GALA-01')],
  ['sendQuotation', () => s().sendQuotation('QT-1001')],
  ['topUpPettyCash', () => s().topUpPettyCash(100)],
  ['setBudgetTolerance', () => s().setBudgetTolerance(5)],
  ['runDepreciation', () => s().runDepreciation()],
  ['disburseIncentives', () => s().disburseIncentives(0, 'x')],
]) {
  const c = await demo(act)
  check(`${label} makes no request in the demo`, c.length === 0, `${c.length} request(s)`)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
