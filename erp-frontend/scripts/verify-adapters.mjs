// The API-shape → page-shape translation, checked against fixtures.
//
//   npx vite-node scripts/verify-adapters.mjs
//
// Needs no backend, deliberately. This is the layer where a wrong field name produces a
// blank column rather than an error, and where a money string quietly becoming a float
// produces a balance sheet that is off by a rupiah — both silent, both worth a suite that
// runs anywhere.
//
// The fixtures are the real API shapes, taken from the OpenAPI schema rather than invented:
// if the backend changes a field name, these fail, which is the point.

import {
  adaptAccount, adaptCatalogueItem, adaptClient, adaptCrew, adaptEntry, adaptFixedAsset,
  adaptInventoryItem, adaptInvoice, adaptProcurement, adaptProject, adaptPurchaseOrder,
  adaptDeliveryOrder, adaptPreview, adaptQuotation, deriveSales, adaptTaxConfig, adaptVendor, adaptVoucherSeries,
  amount, index, withRealizedCost,
} from '../src/store/adapters.js'
import { corporateTax, isProjectCostAccount, withholding } from '../src/lib/ledger.js'
import { expandCollections } from '../src/store/hydrate.js'
import { compareQuotes, quoteGroups } from '../src/lib/vendors.js'
import { DEMO_TODAY, appToday, daysUntil, monthStart, realToday, setLiveClock, todayFor, yearStart } from '../src/lib/format.js'
import { flattenGroups, groupHits, refRoute, SEARCH_KINDS } from '../src/lib/search.js'
import { adaptCalendarItem, adaptRelations, contactBody, parseMonths } from '../src/lib/relationsApi.js'
import { adaptCampaign, adaptCampaignDetail, campaignSummary, recipientStatusLabel } from '../src/lib/campaignsApi.js'
import {
  apiErrorText, adjustBody, confirmDpBody, paymentBody, payDpBody, planFromPreview, settleBody,
  toApiPosting, CLIENT_MONEY, VENDOR_MONEY,
} from '../src/lib/apiPostings.js'
import { toSnake } from '../src/lib/api.js'
import {
  adaptAgeing, adaptBalanceSheet, adaptCashPosition, adaptComparison, adaptCostEntries,
  adaptIncomeStatement, adaptSlice, adaptTrialBalance, adaptAccountBalances,
} from '../src/store/reportAdapters.js'
import { adaptJob, adaptOps, adaptReminder, adaptRun } from '../src/store/jobAdapters.js'
import { adaptInteraction } from '../src/store/adapters.js'
import { adaptAlerts, adaptBudget, budgetBody, defaultBudgetRows } from '../src/store/budgetAdapters.js'
import { reportKey } from '../src/store/useReport.js'
import { validateEdited } from '../src/lib/postings.js'

let passed = 0
const failures = []
const check = (label, ok, detail = '') => {
  if (ok) passed += 1
  else failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
}
const section = (n) => console.log(`\n\x1b[2m${n}\x1b[0m`)

const CLIENT_UUID = '11111111-1111-1111-1111-111111111111'
const PROJECT_UUID = '22222222-2222-2222-2222-222222222222'
const VENDOR_UUID = '33333333-3333-3333-3333-333333333333'
const ENTRY_UUID = '44444444-4444-4444-4444-444444444444'
const SETTLED_UUID = '55555555-5555-5555-5555-555555555555'

const clientRow = { id: CLIENT_UUID, clientNo: 'CL-01', name: 'Aurora Bank', satisfaction: '4.8', birthday: '28 Jul', anniversary: null }
const projectRow = {
  id: PROJECT_UUID, projectNo: 'EVT-0001', name: 'Aurora Bank Annual Gala',
  clientId: CLIENT_UUID, stage: 'Execution Event', stageSince: '2026-07-19',
  division: 'Field', contractValue: '480000000.00', estimatedCost: '336000000.00',
  eventDate: '2026-08-14', cancelled: false, cancelReason: null,
}
const vendorRow = {
  id: VENDOR_UUID, vendorNo: 'V-01', name: 'Lumina LED', baselinePrice: '45000000.00',
  score: '4.7', pph23Rate: '1.500', bankName: 'Bank Mandiri', bankAccount: '123',
  bankHolder: 'PT Lumina', picName: 'Pak Hendra', picPhone: '+62', picEmail: 'h@l.co',
  termsDpPercent: '50.000', termsSettlementDays: 14,
}

const ctx = { clients: index([clientRow]), projects: index([projectRow]), vendors: index([vendorRow]) }

// ---------------------------------------------------------------------------
section('1. The id/uuid swap — the one that breaks routing if it is backwards')
// ---------------------------------------------------------------------------

const project = adaptProject(projectRow, ctx)
check('id is the business number', project.id === 'EVT-0001', project.id)
check('uuid keeps the real key', project.uuid === PROJECT_UUID, project.uuid)
check('client is resolved to a name', project.client === 'Aurora Bank', project.client)
check('and the key is kept for mutations', project.clientUuid === CLIENT_UUID)

check('no PM yet: the page gets no name to print', project.pm === undefined)
const withPm = adaptProject({ ...projectRow, pmUserId: 'u-1', pmName: 'Dinda A.' }, ctx)
check('the PM is the server name, and the key is kept to pick from', withPm.pm === 'Dinda A.' && withPm.pmUserId === 'u-1')

const orphan = adaptProject({ ...projectRow, clientId: 'nope' }, ctx)
check('an unresolvable client degrades rather than crashing', orphan.client === '—', orphan.client)

check('client id is its business number', adaptClient(clientRow).id === 'CL-01')
check('vendor id is its business number', adaptVendor(vendorRow).id === 'V-01')

// ---------------------------------------------------------------------------
section('2. Money crosses into Number exactly once, and exactly')
// ---------------------------------------------------------------------------

check('contract value is a number', typeof project.contractValue === 'number')
check('and it is exact', project.contractValue === 480000000, String(project.contractValue))
check('estimated cost is exact', project.estimatedCost === 336000000)
check('null money becomes zero, not NaN', amount(null) === 0)
check('undefined money becomes zero', amount(undefined) === 0)
check('cents survive', amount('1234.56') === 1234.56, String(amount('1234.56')))

// adapters.js documents a bound: doubles are exact for integers below 2^53, which at two
// decimal places is roughly 90 trillion rupiah. Demonstrated rather than asserted — one
// value inside the bound and one outside — so the limit is shown to be real instead of
// being a comment nobody checked.
check('inside the bound, integers are exact', Number.isSafeInteger(835611725900))
check('outside it, they are not', !Number.isSafeInteger(9007199254740993))
check('a real Oscenia figure round-trips to the cent', amount('8356117259.00').toFixed(2) === '8356117259.00')
check('and so does one with cents', amount('117000000.55').toFixed(2) === '117000000.55')

// ---------------------------------------------------------------------------
section('3. Journal entries are reshaped for lib/ledger.js')
// ---------------------------------------------------------------------------

const entryRow = {
  id: ENTRY_UUID, entryNo: 'JE-1001', voucherNo: 'KM/2026/07/001', entryDate: '2026-04-05',
  memo: 'DP received', projectId: PROJECT_UUID, series: 'km',
  sourceKind: 'invoice', sourceRef: 'INV-0038', sourceDue: null, sourceVendorId: null,
  sourceSettlement: false, reversalOfId: null, reversedById: null,
  appliedTo: [SETTLED_UUID],
  lines: [
    { lineNo: 1, accountCode: '1101', debit: '117000000.00', credit: '0.00', note: 'Cash' },
    { lineNo: 2, accountCode: '1201', debit: '0.00', credit: '117000000.00', note: 'AR' },
  ],
  total: '117000000.00',
}

const entry = adaptEntry(entryRow, ctx)
check('id is the entry number', entry.id === 'JE-1001', entry.id)
check('date is flattened from entry_date', entry.date === '2026-04-05')
check('project is the project CODE, as pages compare it', entry.project === 'EVT-0001', entry.project)
check('lines use `account`, as ledger.js expects', entry.lines[0].account === '1101')
check('line debits are numbers', entry.lines[0].debit === 117000000)
check('line credits are numbers', entry.lines[1].credit === 117000000)
check('the line note survives', entry.lines[0].note === 'Cash')
check('source is nested back into an object', entry.source.kind === 'invoice' && entry.source.ref === 'INV-0038')
check('appliedTo carries the settlement links', entry.appliedTo.length === 1 && entry.appliedTo[0] === SETTLED_UUID)

const unscoped = adaptEntry({ ...entryRow, projectId: null }, ctx)
check('an entry with no project stays null', unscoped.project === null)

// This is the condition `openItems` turns on: an entry that settles something is never
// itself an open item. If appliedTo were dropped, every settlement would double-count.
check('an entry with no applications has an empty list', adaptEntry({ ...entryRow, appliedTo: undefined }, ctx).appliedTo.length === 0)

// REQ-01: a payable is a journal entry rather than a row in a bills table, so the vendor's
// own invoice date has nowhere else to live. Dropped here, the column the client asked for
// would render blank on live data while working perfectly on the seed.
const vendorDated = adaptEntry({ ...entryRow, sourceDocumentDate: '2026-06-28' }, ctx)
check('the source document date survives', vendorDated.source.documentDate === '2026-06-28',
  String(vendorDated.source.documentDate))
check('and its absence reads as null, not undefined',
  adaptEntry(entryRow, ctx).source.documentDate === null,
  String(adaptEntry(entryRow, ctx).source.documentDate))

// An invoice's own date comes through the spread, but only if the field name survives the
// conversion -- which is exactly the class of bug this suite exists for.
const datedInvoice = adaptInvoice({
  id: '66666666-6666-6666-6666-666666666666', invoiceNo: 'INV-0042', projectId: PROJECT_UUID,
  type: 'Down Payment', stageLabel: 'Down Payment', stageNo: 1, amount: '144000000.00',
  status: 'Unpaid', dueDate: '2026-07-31', documentDate: '2026-06-28', issuedAt: '2026-07-20',
}, ctx)
check('an invoice carries its document date', datedInvoice.documentDate === '2026-06-28')
check('alongside the date it was recorded', datedInvoice.issuedAt === '2026-07-20')

// ---------------------------------------------------------------------------
section('4. Realised cost is derived from the journal, never stored')
// ---------------------------------------------------------------------------

const costEntry = adaptEntry({
  ...entryRow, id: 'x', entryNo: 'JE-1002', appliedTo: [],
  lines: [
    { lineNo: 1, accountCode: '5101', debit: '200000000.00', credit: '0.00', note: 'Vendor' },
    { lineNo: 2, accountCode: '2102', debit: '0.00', credit: '200000000.00', note: 'AP' },
  ],
}, ctx)

const reversal = adaptEntry({
  ...entryRow, id: 'y', entryNo: 'JE-1003', appliedTo: [],
  lines: [
    { lineNo: 1, accountCode: '2102', debit: '30000000.00', credit: '0.00', note: 'Under' },
    { lineNo: 2, accountCode: '5101', debit: '0.00', credit: '30000000.00', note: 'Cost down' },
  ],
}, ctx)

const [costed] = withRealizedCost([project], [entry, costEntry, reversal], isProjectCostAccount)
check('cost accounts accumulate', costed.realizedCost === 170000000, String(costed.realizedCost))
check('a credit reduces it rather than adding', costed.realizedCost < 200000000)
check('cash and AR lines are not cost', withRealizedCost([project], [entry], isProjectCostAccount)[0].realizedCost === 0)

const [untouched] = withRealizedCost([{ ...project, id: 'EVT-9999' }], [costEntry], isProjectCostAccount)
check('another project is unaffected', untouched.realizedCost === 0)

// ---------------------------------------------------------------------------
section('5. The remaining collections')
// ---------------------------------------------------------------------------

const invoice = adaptInvoice({
  id: 'i1', invoiceNo: 'INV-0038', projectId: PROJECT_UUID, type: 'Down Payment',
  stageLabel: 'Down Payment', stageNo: 1, amount: '117000000.00', status: 'Paid',
  dueDate: '2026-04-05', issuedAt: '2026-03-20', lastPaidAt: '2026-04-05',
  recognitionEntryId: ENTRY_UUID, collected: '117000000.00', outstanding: '0.00',
}, ctx)
check('invoice id is its number', invoice.id === 'INV-0038')
check('collected is renamed to paid, at gross', invoice.paid === 117000000)
check('outstanding is a number', invoice.outstanding === 0)
check('due is flattened', invoice.due === '2026-04-05')
check('invoice resolves its project code', invoice.project === 'EVT-0001')

const po = adaptPurchaseOrder({
  id: 'p1', poNo: 'PO-3001', projectId: PROJECT_UUID, vendorId: VENDOR_UUID,
  status: 'Approved', total: '45000000.00',
  lines: [{ label: 'LED wall', amount: '45000000.00' }],
}, ctx)
check('po resolves its vendor name', po.vendor === 'Lumina LED', po.vendor)
check('po total is a number', po.total === 45000000)
check('po line amounts are numbers', po.lines[0].amount === 45000000)
check('po resolves its project code', po.project === 'EVT-0001', po.project)

// `vendorId` must be the vendor's BUSINESS number, not the key.
//
// Everything reads it that way: `/vendors/:id` routes on it, the PO list resolves the
// vendor with `vendors.find(v => v.id === po.vendorId)`, and the vendor page lists its own
// orders with `po.vendorId === id`. Spread straight through from the API it was a UUID, so
// all of those silently matched nothing — no vendor names on the PO list, links to a route
// that does not resolve, and "no purchase orders raised with this vendor yet" on the vendor
// page, which is the second empty panel in the client's screenshot.
check('po vendorId is the vendor BUSINESS number, not a UUID', po.vendorId === 'V-01', String(po.vendorId))
check('and the vendor key is still carried for mutations', po.vendorUuid === VENDOR_UUID)
check('an unresolvable vendor yields null rather than leaking a UUID into a route',
  adaptPurchaseOrder({ id: 'p2', poNo: 'PO-9999', projectId: PROJECT_UUID, vendorId: 'nope', lines: [] }, ctx)
    .vendorId === null)

const item = adaptInventoryItem({
  id: 'it1', itemNo: 'IT-04', item: 'VIP Sofa (gold)', type: 'Fixed Asset',
  qty: '12.00', unit: 'unit', unitValue: '8000000.00', status: 'in_transit',
  projectId: PROJECT_UUID, eventDate: '2026-08-14',
}, ctx)
check('stock qty is a number', item.qty === 12)
check('unit value is a number', item.unitValue === 8000000)
check('in-transit stock resolves its project code', item.projectId === 'EVT-0001')

const asset = adaptFixedAsset({
  id: 'a1', assetNo: 'FA-001', name: 'VIP Sofa (gold)', category: 'Furniture',
  acquiredOn: '2026-01-01', cost: '96000000.00', salvage: '9600000.00',
  usefulLifeMonths: 60, method: 'straight-line', status: 'active',
  postedThrough: null, postedAccumulated: '0.00', scheduleFrom: null,
  openingAccumulated: '0.00', inventoryItemId: 'it1',
})
check('asset id is its number', asset.id === 'FA-001')
check('cost is a number for lib/depreciation.js', asset.cost === 96000000)
check('salvage is a number', asset.salvage === 9600000)
check('the stock link is carried as inventoryId', asset.inventoryId === 'it1')

const crew = adaptCrew({ id: 'c1', crewNo: 'CR-01', name: 'Agus P.', role: 'Field Lead', baseRate: '5000000.00', lastRating: '9.2' })
check('crew base rate is a number', crew.baseRate === 5000000)
check('crew rating is a number', crew.lastRating === 9.2)

const account = adaptAccount({ code: '1101', name: 'Main Bank Cash', type: 'asset', isCash: true, isContra: false })
check('is_cash becomes cash', account.cash === true)
check('is_contra becomes contra', account.contra === false)

// ---------------------------------------------------------------------------
section('6. Quotations, procurement, catalogue and tax config')
// ---------------------------------------------------------------------------
//
// These four were missing, and each failed silently rather than loudly:
// quotations and procurement were passed through raw, the catalogue was never loaded at
// all, and tax config arrived as a list where every consumer indexes it by name.

const QUOTE_UUID = '66666666-6666-6666-6666-666666666666'
const DRAFT_UUID = '77777777-7777-7777-7777-777777777777'

const quotationRow = {
  id: QUOTE_UUID, quotationNo: 'QT-1001', clientId: CLIENT_UUID, mouTemplateId: 'corporate',
  eventType: 'Investor Summit', eventDate: '2026-11-18', status: 'Accepted',
  createdByUserId: '88888888-8888-8888-8888-888888888888', createdByName: 'Dinda Ayu',
  lines: [{ lineNo: 1, label: 'Venue & Staging', amount: '210000000.00', estCost: '147000000.00' }],
  contractValue: '210000000.00', estimatedCost: '147000000.00', margin: '30.00',
  schedule: [{
    stageNo: 1, label: 'Down Payment', basis: 'percent', value: '30.000', anchor: 'signing',
    offsetDays: 0, amount: '63000000.00', due: '2026-09-22', percent: '30.00',
    invoiceType: 'Down Payment',
  }],
}

// The project points at the quotation, not the other way round.
const projectByQuotation = new Map([[QUOTE_UUID, 'EVT-0001']])
const quote = adaptQuotation(quotationRow, { clients: ctx.clients, projectByQuotation })

check('quotation id is the business number', quote.id === 'QT-1001')
check('quotation uuid is the key', quote.uuid === QUOTE_UUID)
check('quotation resolves the client name', quote.client === 'Aurora Bank')
check('mou_template_id becomes template', quote.template === 'corporate')
check('created_by_name becomes createdBy, not a UUID', quote.createdBy === 'Dinda Ayu')
check('an accepted quotation finds its project', quote.projectId === 'EVT-0001')
check('lines become lineItems', Array.isArray(quote.lineItems) && quote.lineItems.length === 1)
check('lineItems carry numbers', quote.lineItems[0].amount === 210000000)
check('est_cost becomes estCost', quote.lineItems[0].estCost === 147000000)
check('contract value is a number', quote.contractValue === 210000000)
check('schedule becomes dpSchedule', quote.dpSchedule.length === 1)
check('stage value is a number', quote.dpSchedule[0].value === 30)
check('stage offsetDays survives', quote.dpSchedule[0].offsetDays === 0)
check('dpPercent is derived from the first stage', quote.dpPercent === 30)

// A draft has no project, and null is the honest answer rather than a made-up number.
const draft = adaptQuotation(
  { ...quotationRow, id: DRAFT_UUID, quotationNo: 'QT-1003', status: 'Draft', createdByName: null },
  { clients: ctx.clients, projectByQuotation }
)
check('a draft quotation has no project', draft.projectId === null)
check('a missing author falls back to a dash', draft.createdBy === '—')

const procurementRow = {
  id: '99999999-9999-9999-9999-999999999999', requestNo: 'PR-101', projectId: PROJECT_UUID,
  category: 'Field Cash Advance', amount: '8500000.00', status: 'Disbursed',
  requestedBy: 'Bagus S.', requestedByUserId: null, requestDate: '2026-07-05',
  disbursedAt: '2026-07-05', actual: null, settledAt: null, rejectReason: null,
  receipts: [{ attachmentId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }],
  variance: null, fromPettyCash: true,
}
const req = adaptProcurement(procurementRow, ctx)
check('procurement id is the request number', req.id === 'PR-101')
check('procurement resolves the project number', req.project === 'EVT-0001')
check('requested_by becomes by', req.by === 'Bagus S.')
check('receipts become a proof flag', req.proof === true)
check('no receipts means no proof', adaptProcurement({ ...procurementRow, receipts: [] }, ctx).proof === false)
check('the receipt ids are kept, in order, so the file can be opened', JSON.stringify(req.receiptIds) === JSON.stringify(['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']))
check('procurement amount is a number', req.amount === 8500000)
check('an unsettled variance stays null', req.variance === null)
check('a settled variance becomes a number',
  adaptProcurement({ ...procurementRow, variance: '250000.00' }, ctx).variance === 250000)

const catalogueRow = {
  id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', itemNo: 'VI-01', vendorId: VENDOR_UUID,
  item: 'LED Video Wall (per m²)', category: 'visual', subcategory: 'LED Wall',
  unitPrice: '2400000.00', stock: '320', unit: 'm²',
  tags: [{ id: 'corporate-gala', label: 'Corporate Gala' }],
}
const catItem = adaptCatalogueItem(catalogueRow, ctx)
check('catalogue id is the item number', catItem.id === 'VI-01')
check('catalogue resolves the vendor name', catItem.vendor === 'Lumina LED')
check('catalogue vendorId is the vendor business number', catItem.vendorId === 'V-01')
check('unit price is a number', catItem.unitPrice === 2400000)
check('stock is a number', catItem.stock === 320)
// Left as objects, TagChip renders "[object Object]".
check('tag objects become tag ids', catItem.tags[0] === 'corporate-gala')

const taxConfig = adaptTaxConfig([
  { key: 'pph23', label: 'PPh 23 — Service withholding', rate: '2.000', active: true, accountCode: '2105' },
  { key: 'ppn', label: 'PPN — Value Added Tax', rate: '11.000', active: false, accountCode: '2106' },
  { key: 'corporate', label: 'Corporate Income Tax', rate: '22.000', active: true, accountCode: null },
])
check('tax config is keyed by name, not a list', taxConfig.pph23 !== undefined)
check('tax rate is a number', taxConfig.pph23.rate === 2)
check('account_code becomes account', taxConfig.pph23.account === '2105')
check('an inactive tax stays inactive', taxConfig.ppn.active === false)
check('a null account survives', taxConfig.corporate.account === null)

// The assertion that matters: the list shape did not throw, it silently withheld nothing.
// These two prove the real consumers now get real numbers.
check('withholding actually withholds through the adapted config',
  withholding(150000000, taxConfig, 'pph23').amount === 3000000)
check('corporate tax produces a provision',
  corporateTax(100000000, taxConfig).amount === 22000000)
check('the raw API list would have withheld nothing (the bug this adapter fixes)',
  withholding(150000000, [{ key: 'pph23', rate: 2, active: true }], 'pph23').amount === 0)

// ---------------------------------------------------------------------------
section('7. A targeted re-read asks for everything it needs, and no more')
// ---------------------------------------------------------------------------
//
// `loadSome` is what every write calls to refresh what it changed. If the dependency
// expansion is wrong the screens do not crash — they render '—' where a resolved name
// belongs, which looks like missing data rather than a bug.

const exp = (keys) => [...expandCollections(keys)].sort()

// projects and journal depend on each other. A naive walk recurses forever.
check('the projects/journal cycle terminates', exp(['projects']).length > 0)
check('refreshing projects pulls the journal (realizedCost is derived from it)',
  exp(['projects']).includes('journal'))
check('refreshing the journal pulls projects (entries render the project number)',
  exp(['journal']).includes('projects'))
check('and each pulls clients, which projects need for a name',
  exp(['journal']).includes('clients'))

// An invoice renders its project number, so projects must come too — and with projects
// come the journal and clients.
check('invoices pull projects', exp(['invoices']).includes('projects'))
check('a purchase order pulls vendors as well as projects',
  exp(['purchaseOrders']).includes('vendors') && exp(['purchaseOrders']).includes('projects'))
check('the catalogue pulls vendors', exp(['vendorCatalogue']).includes('vendors'))
check('quotations pull clients and projects',
  exp(['quotations']).includes('clients') && exp(['quotations']).includes('projects'))

// The point of loadSome over loadAll: it does not drag in everything.
const invoiceSet = exp(['invoices'])
check('a targeted re-read stays targeted', !invoiceSet.includes('fixedAssets'))
check('and does not pull the catalogue', !invoiceSet.includes('vendorCatalogue'))
check('and does not pull tax config', !invoiceSet.includes('taxConfig'))

// Leaf collections have no dependencies at all.
check('tags is a leaf', exp(['tags']).join() === 'tags')
check('accounts is a leaf', exp(['accounts']).join() === 'accounts')

// ---------------------------------------------------------------------------
section('8. Nothing mutates its input')
// ---------------------------------------------------------------------------

const before = JSON.stringify(projectRow)
adaptProject(projectRow, ctx)
check('the API row is left untouched', JSON.stringify(projectRow) === before)

const quoteBefore = JSON.stringify(quotationRow)
adaptQuotation(quotationRow, { clients: ctx.clients, projectByQuotation })
check('the quotation row is left untouched', JSON.stringify(quotationRow) === quoteBefore)

// ---------------------------------------------------------------------------
section('9. Journal codes and voucher series')
// ---------------------------------------------------------------------------

// A group is named by the ANCHOR entry's voucher number, so the anchor carries no code of
// its own. Defaulting the missing field to `undefined` rather than null would make
// `groupRef in entry` true while every comparison against null fails -- the kind of
// difference that only shows up as an empty group on screen.
const anchorEntry = adaptEntry({ ...entryRow, groupRef: undefined }, ctx)
check('an entry with no group reads as null', anchorEntry.groupRef === null,
  String(anchorEntry.groupRef))

const correction = adaptEntry({ ...entryRow, groupRef: 'KM-05-10-001' }, ctx)
check('a correction carries the code it is filed under', correction.groupRef === 'KM-05-10-001')
check('and keeps its own voucher number', correction.voucherNo === entryRow.voucherNo)

const seriesRow = {
  key: 'pc', prefix: 'PC', label: 'Project Close', hint: null,
  format: '[PREFIX]/[YEAR]/[SEQ_0001]', reset: 'yearly', nextPreview: 'PC/2026/0001',
}
const series = adaptVoucherSeries(seriesRow)
check('the series key survives', series.key === 'pc')
check('the reset cadence needs no translation', series.reset === 'yearly')
// The one field the client cannot compute: on live data the server allocates the numbers,
// so its preview is the only true one.
check('the server preview is carried through', series.nextPreview === 'PC/2026/0001')
check('a null hint becomes an empty string, not null', series.hint === '')
check('a series with no preview reads as null',
  adaptVoucherSeries({ ...seriesRow, nextPreview: undefined }).nextPreview === null)

check('the series are hydrated, not seed-only', exp(['voucherSeries']).join() === 'voucherSeries')

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
section('10. Search results (REQ-10)')
// ---------------------------------------------------------------------------

// The fixture is the real endpoint's shape after lib/api.js has camel-cased it.
const searchPayload = {
  query: 'aurora',
  total: 2,
  groups: [
    {
      kind: 'project',
      label: 'Projects',
      total: 1,
      hits: [{
        kind: 'project', id: 'EVT-0001', uuid: PROJECT_UUID, title: 'Aurora Bank Annual Gala',
        subtitle: 'Aurora Bank \u00b7 Execution Event', amount: '480000000.00',
        date: '2026-08-14', score: 70,
      }],
    },
    {
      kind: 'purchase_order',
      label: 'Purchase Orders',
      total: 1,
      hits: [{
        kind: 'purchase_order', id: 'PO-3001', uuid: VENDOR_UUID, title: 'PO-3001 \u2014 Lumina LED',
        subtitle: 'Settled', amount: null, date: null, score: 100,
      }],
    },
  ],
}

const searchHits = flattenGroups(searchPayload)
check('every hit is flattened', searchHits.length === 2, String(searchHits.length))
check('the business number stays the id', searchHits[0].id === 'EVT-0001')
check('and the key comes with it', searchHits[0].uuid === PROJECT_UUID)
check('the subtitle becomes meta, which is what the row renders',
  searchHits[0].meta === 'Aurora Bank \u00b7 Execution Event')
// Money arrives as a string from every endpoint. This is the one place it becomes a number.
check('an amount crosses to a number exactly', searchHits[0].value === 480000000,
  String(searchHits[0].value))
check('a hit with no amount reads as null, not 0', searchHits[1].value === null,
  String(searchHits[1].value))

const searchGroups = groupHits(searchHits)
check('the group holding the best hit comes first', searchGroups[0].kind === 'purchase_order',
  searchGroups[0].kind)
check('groups keep their labels', searchGroups[0].label === 'Purchase Orders')
check('a per-kind cap applies', groupHits([...searchHits, ...searchHits], { perKind: 1 })
  .every((g) => g.hits.length === 1))
check('every kind the API can return has a route',
  Object.values(SEARCH_KINDS).every((k) => typeof k.to({ id: 'X' }) === 'string'))
check('an empty payload is not a crash', flattenGroups(undefined).length === 0)

// Messages, tasks and files open through their parent. The server says which, as `kind:id`.
check('a chat hit opens its channel', refRoute('channel:abc-123') === '/chat/abc-123')
check('a task or file hit opens the project workspace',
  refRoute('project:EVT-0002') === '/workspace/EVT-0002')
check('an event hit opens the event', refRoute('event:EV-0001') === '/events/EV-0001')
check('a missing or unknown ref goes home rather than to a broken page',
  refRoute(null) === '/' && refRoute('guest:5') === '/' && refRoute('channel:') === '/')
const richHits = flattenGroups({ groups: [{ kind: 'chat_message', hits: [
  { kind: 'chat_message', id: 'm1', uuid: 'u1', title: 'hello', score: 40, ref: 'channel:c1' },
] }] })
check('the ref survives flattening', richHits[0].ref === 'channel:c1')
check('and routes a chat message to its channel',
  SEARCH_KINDS.chat_message.to(richHits[0]) === '/chat/c1')
check('an event routes by its number', SEARCH_KINDS.event.to({ id: 'EV-0001' }) === '/events/EV-0001')

// ---------------------------------------------------------------------------
section('11. Posting previews (REQ-05)')
// ---------------------------------------------------------------------------

// The confirmation dialog's whole value is being trustworthy, so the figures in it have to
// cross from the wire exactly once and exactly right.
const previewPayload = {
  dryRun: true,
  entries: [{
    entryDate: '2026-05-10',
    memo: 'Down Payment invoiced — Aurora Bank Annual Gala',
    series: 'rev',
    voucherPreview: 'REVENUE - 05 - 10 - 001',
    projectId: PROJECT_UUID,
    lines: [
      { account: '1201', accountName: 'Accounts Receivable', debit: '144000000.00', credit: '0.00', note: 'Receivable raised' },
      { account: '4101', accountName: 'Unearned Revenue', debit: '0.00', credit: '144000000.00', note: null },
    ],
    totalDebit: '144000000.00',
    totalCredit: '144000000.00',
    balanced: true,
  }],
  totalDebit: '144000000.00',
  totalCredit: '144000000.00',
  balanced: true,
}

const preview = adaptPreview(previewPayload)
check('the previewed entry survives', preview.entries.length === 1)
check('the voucher it WOULD take comes through',
  preview.entries[0].voucherPreview === 'REVENUE - 05 - 10 - 001')
check('an account name rides with its code', preview.entries[0].lines[0].accountName === 'Accounts Receivable')
check('a debit crosses to a number, exactly', preview.entries[0].lines[0].debit === 144000000,
  String(preview.entries[0].lines[0].debit))
check('a zero credit is 0, not NaN', preview.entries[0].lines[0].credit === 0)
check('the totals come from the server rather than being re-added here',
  preview.totalDebit === 144000000 && preview.totalCredit === 144000000)
check('and so does the verdict', preview.balanced === true)
check('an empty payload is not a crash', adaptPreview(undefined).entries.length === 0)
check('an empty payload is not silently balanced',
  adaptPreview(undefined).balanced === false)

check('a preview without a receipt date reads null', preview.entries[0].sourceDocumentDate === null)

// ---------------------------------------------------------------------------
section('12. The posting pop-up on the live backend (round 4)')
// ---------------------------------------------------------------------------

// The receipt date rides on each previewed entry; `entryDate` is the received date.
const dpPreview = adaptPreview({
  dryRun: true,
  entries: [
    {
      entryDate: '2026-10-05', memo: 'DP invoiced — Gala', series: 'rev', voucherPreview: 'REV-1',
      projectId: PROJECT_UUID, sourceDocumentDate: null,
      lines: [
        { account: '1201', accountName: 'AR', debit: '144000000.00', credit: '0.00', note: null },
        { account: '4101', accountName: 'Unearned', debit: '0.00', credit: '144000000.00', note: null },
      ],
      totalDebit: '144000000.00', totalCredit: '144000000.00', balanced: true,
    },
    {
      entryDate: '2026-10-05', memo: 'DP received — Gala', series: 'bkm', voucherPreview: 'BKM-1',
      projectId: PROJECT_UUID, sourceDocumentDate: '2026-10-01',
      lines: [
        { account: '1101', accountName: 'Cash', debit: '141120000.00', credit: '0.00', note: 'Net cash' },
        { account: '1401', accountName: 'PPh 23', debit: '2880000.00', credit: '0.00', note: 'PPh 23' },
        { account: '1201', accountName: 'AR', debit: '0.00', credit: '144000000.00', note: 'Cleared' },
      ],
      totalDebit: '144000000.00', totalCredit: '144000000.00', balanced: true,
    },
  ],
  totalDebit: '288000000.00', totalCredit: '288000000.00', balanced: true,
})
check('adaptPreview maps sourceDocumentDate', dpPreview.entries[1].sourceDocumentDate === '2026-10-01',
  String(dpPreview.entries[1].sourceDocumentDate))

const dpPlan = planFromPreview(dpPreview, CLIENT_MONEY, { rate: 2 })
check('the receipt is the editable entry, the invoice a companion',
  dpPlan.editable?.memo === 'DP received — Gala' && dpPlan.companions.length === 1
  && dpPlan.companions[0].memo === 'DP invoiced — Gala')
check('the locked line is 1201 credit at the gross',
  dpPlan.editable.locked.account === '1201' && dpPlan.editable.locked.side === 'credit'
  && dpPlan.editable.locked.amount === 144000000)
check('the tax is read from 1401', dpPlan.editable.taxAmount === 2880000)
check('the receipt date is seeded from the server', dpPlan.editable.documentDate === '2026-10-01')
check('the server plan passes the same guard as a local one',
  validateEdited(dpPlan, { date: '2026-10-05', lines: dpPlan.editable.lines },
    [{ code: '1101' }, { code: '1401' }, { code: '1201' }]).ok)

// A settlement: variance (also clears 2102 but moves no cash), then the payment.
const settlePreview = adaptPreview({
  entries: [
    { entryDate: '2026-10-05', memo: 'Variance', lines: [
      { account: '2102', debit: '5000000.00', credit: '0.00' }, { account: '5101', debit: '0.00', credit: '5000000.00' },
    ] },
    { entryDate: '2026-10-05', memo: 'Final payment', lines: [
      { account: '2102', debit: '45000000.00', credit: '0.00' },
      { account: '2105', debit: '0.00', credit: '900000.00' },
      { account: '1102', debit: '0.00', credit: '44100000.00' },
    ] },
  ],
})
const settlePlan = planFromPreview(settlePreview, VENDOR_MONEY)
check('a variance is not mistaken for the payment', settlePlan.editable?.memo === 'Final payment')
check('vendor lock is 2102 debit',
  settlePlan.editable.locked.side === 'debit' && settlePlan.editable.locked.amount === 45000000)
check('vendor tax is read from 2105', settlePlan.editable.taxAmount === 900000)
check('nothing to pay means nothing editable',
  planFromPreview(adaptPreview({ entries: [settlePreview.entries[0]] }), VENDOR_MONEY).editable === null)

// Request bodies, as they leave lib/api.js.
const edited = {
  date: '2026-10-05', documentDate: '2026-10-01', memo: 'x', cashAccount: '1102', withhold: true,
  taxAmount: 2880000, taxEdited: false, linesEdited: false,
  lines: [
    { account: '1102', debit: 141120000, credit: 0, note: 'Net' },
    { account: '1201', debit: 0, credit: 141120000, note: '' },
  ],
}
const plain = toSnake(confirmDpBody(edited))
check('confirm-DP sends confirmed_on and document_date',
  plain.confirmed_on === '2026-10-05' && plain.document_date === '2026-10-01', JSON.stringify(plain))
check('and the cash account and withholding', plain.cash_account === '1102' && plain.withhold === true)
check('an untouched tax is left to the server', !('tax_amount' in plain))
check('untouched lines are left to the server', !('lines' in plain))
check('the memo is not sent (no endpoint takes one)', !('memo' in plain))

const touched = toSnake(paymentBody(144000000, { ...edited, taxEdited: true, linesEdited: true }))
check('a payment sends amount, and payment_date as the received date',
  touched.amount === '144000000' && touched.payment_date === '2026-10-05', JSON.stringify(touched).slice(0, 120))
check('a typed tax is sent as a string', touched.tax_amount === '2880000')
check('edited lines are sent, money as strings',
  touched.lines?.length === 2 && touched.lines[0].debit === '141120000' && touched.lines[1].credit === '141120000'
  && touched.lines[1].note === null)
check('withholding off sends no tax even if typed',
  !('taxAmount' in toApiPosting({ ...edited, withhold: false, taxEdited: true })))
check('a payment without the pop-up still sends its arguments',
  JSON.stringify(paymentBody(5, null, { date: null, cashAccount: '1101', withhold: false, taxAmount: null }))
    === JSON.stringify({ amount: '5', paymentDate: null, cashAccount: '1101', withhold: false }))
check('pay-DP takes no amount', !('amount' in payDpBody(edited)) && payDpBody(edited).documentDate === '2026-10-01')

const settled = toSnake(settleBody(50000000, { invoiceDate: '2026-09-28', edited }))
check('settle sends the receipt date as invoice_date, the received date as payment_date',
  settled.invoice_date === '2026-10-01' && settled.payment_date === '2026-10-05' && !('document_date' in settled),
  JSON.stringify(settled))
check('settle without the pop-up keeps actual_total and invoice_date',
  JSON.stringify(settleBody(null, { invoiceDate: '2026-09-28' })) === JSON.stringify({ invoiceDate: '2026-09-28' }))
check('adjust sends document_date when given',
  toSnake(adjustBody({ date: '2026-10-05', documentDate: '2026-10-02', lines: [] })).document_date === '2026-10-02')
check('and omits it when not', !('documentDate' in adjustBody({ lines: [] })))

check('a 422 detail becomes the message',
  apiErrorText({ problem: { detail: 'The 1201 line must move by 144000000.00' }, message: 'x' })
    === 'The 1201 line must move by 144000000.00')
check('a schema 422 list is flattened',
  apiErrorText({ problem: { detail: [{ msg: 'too short' }, { msg: 'bad date' }] } }) === 'too short; bad date')

section('Report answers become the shapes the pages read (W4)')
{
  const is = adaptIncomeStatement({
    revenue: [{ code: '4101', label: 'Event revenue', amount: '1000000000.00', derived: false, codes: [] }],
    cogs: [{ code: '5101', label: 'Vendors', amount: '700000000.00', derived: false, codes: [] }],
    opex: [], tax: [{ code: '—', label: 'Corporate Income Tax (22%)', amount: '44000000.00', derived: true, codes: [] }],
    totalRevenue: '1000000000.00', totalCogs: '700000000.00', grossProfit: '300000000.00', totalOpex: '100000000.00',
    profitBeforeTax: '200000000.00', totalTax: '44000000.00', postedTax: '0.00', provision: '44000000.00', npat: '156000000.00',
    taxRate: '22', grossMargin: '30.00', netMargin: '15.60', prepaidWithholding: '3000000.00', summarised: false,
  })
  check('income statement: money strings become numbers', is.totalRevenue === 1000000000 && is.npat === 156000000 && typeof is.provision === 'number')
  check('income statement: rows keep code, label and the derived flag', is.revenue[0].code === '4101' && is.tax[0].derived === true && is.tax[0].code === '—')
  check('income statement: the fields a page reads exist under the names it reads', ['grossProfit', 'profitBeforeTax', 'totalTax', 'taxRate', 'grossMargin', 'netMargin'].every((k) => k in is))
  const bs = adaptBalanceSheet({
    assets: [{ code: '1101', label: 'Cash', amount: '5.00', derived: false, codes: ['1101', '1102'] }], liabilities: [], equity: [],
    totalAssets: '5.00', totalLiabilities: '0.00', totalEquity: '5.00', balanced: true, difference: '0.00', summarised: true,
    excludesOpeningBalances: true,
  })
  check('balance sheet: totals, balanced flag and the opening-balance warning', bs.totalAssets === 5 && bs.balanced === true && bs.excludesOpeningBalances === true)
  check('balance sheet: a rolled-up row keeps the codes it was built from', JSON.stringify(bs.assets[0].codes) === JSON.stringify(['1101', '1102']))
  const tb = adaptTrialBalance({ debit: '10.00', credit: '10.00', balanced: true, difference: '0.00' })
  check('trial balance', tb.debit === 10 && tb.credit === 10 && tb.balanced === true)
  const cash = adaptCashPosition({ total: '7.50', asOf: '2026-07-26', accounts: [{ code: '1101', name: 'Main Bank', balance: '7.50', share: 1 }] })
  check('cash position: total and per-account balances', cash.total === 7.5 && cash.accounts[0].balance === 7.5 && cash.accounts[0].name === 'Main Bank')
  const slice = adaptSlice({ label: 'Current', revenue: '100.00', cost: '60.00', profit: '40.00', margin: '40.00', start: null, end: null, costs: [{ code: '5101', label: 'Vendors', amount: '60.00' }] })
  check('P&L slice: revenue, cost, profit, margin and cost lines', slice.profit === 40 && slice.margin === 40 && slice.costs[0].amount === 60)
  const cmp = adaptComparison({
    current: { label: 'Current', revenue: '10', cost: '5', profit: '5', margin: '50', start: null, end: null, costs: [] },
    baseline: { label: 'Baseline', revenue: '0', cost: '0', profit: '0', margin: '0', start: null, end: null, costs: [] },
    deltas: [{ metric: 'cost', now: '5', was: '8', change: '-3', percent: null, improved: true, inverse: true }], beforeLedger: true,
  })
  check('comparison: deltas keep their sign and the inverse flag; before-ledger survives', cmp.deltas[0].change === -3 && cmp.deltas[0].inverse === true && cmp.deltas[0].percent === null && cmp.beforeLedger === true)
  const costs = adaptCostEntries([{ entryId: 'e1', entryNo: 'JE-1', voucherNo: 'V-1', entryDate: '2026-06-01', memo: 'm', sourceKind: 'po', sourceRef: 'PO-1', accountCode: '5101', note: 'n', amount: '-5.00', isReversal: true, isReversed: false }])
  check('cost lines: the shape projectCostEntries gave (source object, reversal flags, signed amount)',
    costs[0].source.kind === 'po' && costs[0].source.ref === 'PO-1' && costs[0].account === '5101' && costs[0].amount === -5 && costs[0].reversal === true && costs[0].reversed === false && costs[0].date === '2026-06-01')
  const bal = adaptAccountBalances([{ type: 'asset', label: 'Assets', groups: [{ group: 'Cash', accounts: [{ code: '1101', balance: '500.00', children: [{ code: '1101.01', balance: '20.50', children: [] }] }, { code: '1102', balance: '-3.00', children: [] }] }] }])
  check('account balances: every node, sub-accounts included, as numbers with their sign', bal['1101'] === 500 && bal['1101.01'] === 20.5 && bal['1102'] === -3)
  check('no tree, no balances', Object.keys(adaptAccountBalances(null)).length === 0)
  const ageing = adaptAgeing({ asOf: '2026-07-26', buckets: [{ key: 'current', label: 'Current', amount: '9.00', count: 1, share: 0.9 }], total: '10.00', overdue: '1.00', scheduled: '0.00', scheduledCount: 0, ledgerBalance: '10.00', difference: '0.00', reconciled: true, withholdingOwed: '2.00' })
  check('ageing: buckets, totals, reconciliation and (payables) withholding owed', ageing.buckets[0].amount === 9 && ageing.overdue === 1 && ageing.reconciled === true && ageing.withholdingOwed === 2)
  check('ageing: receivables carry no withholding', adaptAgeing({ asOf: 'x', buckets: [], total: '0', overdue: '0', ledgerBalance: '0', difference: '0', reconciled: true }).withholdingOwed === null)
}

section('Scheduled jobs, runs and reminders (Daily Jobs)')
{
  const ok = adaptRun({ id: 'r1', jobKey: 'depreciation.month_end', runFor: '2026-07', status: 'succeeded', startedAt: '2026-07-31T23:00:00Z', finishedAt: '2026-07-31T23:00:02Z', detail: { posted: 3, periods: ['2026-07'], note: null }, triggeredByUserId: null })
  check('a run: flat facts only (no nested objects, no nulls), no failure text', JSON.stringify(ok.facts) === JSON.stringify([{ key: 'posted', value: '3' }]) && ok.failure === null)
  const bad = adaptRun({ id: 'r2', jobKey: 'ar.overdue_sweep', runFor: '2026-07-26', status: 'failed', startedAt: 'a', finishedAt: null, detail: { error: 'boom' } })
  check('a failed run carries its reason', bad.failure === 'boom' && bad.status === 'failed')
  check('a failed run with no reason still says it failed', adaptRun({ id: 'r3', jobKey: 'x', runFor: 'x', status: 'failed', detail: {} }).failure === 'The run failed.')
  const job = adaptJob({ key: 'crm.milestone_scan', name: 'Milestone scan', schedule: 'daily 07:00', description: 'd', lastRun: null })
  check('a job that never ran has no last run', job.lastRun === null && job.key === 'crm.milestone_scan')
  check('and one that did carries its adapted run', adaptJob({ key: 'k', name: 'n', schedule: 's', description: '', lastRun: { id: 'r', jobKey: 'k', runFor: 'p', status: 'skipped', detail: {} } }).lastRun.status === 'skipped')
  const rem = adaptReminder({ id: 'm1', kind: 'overdue_invoice', subject: 'INV-9 is 12 days late', detail: null, clientId: null, ref: 'INV-9', dueDate: '2026-07-14', status: 'open', raisedByJob: 'ar.overdue_sweep' })
  check('a reminder: a readable kind, an empty string for a missing detail', rem.kindLabel === 'Overdue invoice' && rem.detail === '' && rem.raisedBy === 'ar.overdue_sweep')
  check('an unknown reminder kind is shown as it is', adaptReminder({ id: 'm2', kind: 'new_kind', subject: 's', status: 'open' }).kindLabel === 'new_kind')
  const o = adaptOps({ jobs: 5, failedRuns: [{ id: 'r', jobKey: 'k', runFor: 'p', status: 'failed', detail: { error: 'x' } }], openReminders: 2 })
  check('ops summary: counts and the failed runs', o.jobs === 5 && o.openReminders === 2 && o.failedRuns[0].failure === 'x')
}

section('Per-project budgets (Budgeting)')
{
  const b = adaptBudget({ projectId: 'p', categories: [{ key: 'vendors', label: 'Vendors', ceiling: '100.00', spent: '120.00', remaining: '-20.00', utilisation: '120.00', over: true, codes: ['5101'] }], totalCeiling: '100.00', totalSpent: '120.00', totalRemaining: '-20.00', utilisation: '120.00' })
  check('a budget: numbers, the over flag and the accounts each ceiling is measured against', b.categories[0].spent === 120 && b.categories[0].over === true && b.categories[0].codes[0] === '5101' && b.totalRemaining === -20)
  const al = adaptAlerts([{ projectId: 'u1', ceiling: '100', spent: '130', overBy: '30', acknowledged: false, raisedOn: '2026-07-01' }], [{ uuid: 'u1', id: 'EVT-1', name: 'Gala' }])
  check('an alert is shown against the project number the screens use', al[0].project === 'EVT-1' && al[0].name === 'Gala' && al[0].overBy === 30)
  check('an alert for a project we do not hold still renders (no number)', adaptAlerts([{ projectId: 'zz', ceiling: '1', spent: '2', overBy: '1', raisedOn: 'x' }], [])[0].project === null)
  const good = budgetBody([{ key: 'vendors', label: 'Vendors', ceiling: 150000000, codes: ['5101'] }, { key: '', label: 'Crew & Talent', ceiling: '80000000', codes: ['5102', '6901'] }])
  check('the editor body: string ceilings, account codes, a new row gets a key from its name', good.body.categories[0].ceiling === '150000000' && good.body.categories[1].key === 'crew-talent' && good.body.categories[1].accountCodes.length === 2)
  const dup = budgetBody([{ key: 'vendors', label: 'Vendors', ceiling: 1, codes: ['5101'] }, { key: '', label: 'Vendors', ceiling: 1, codes: ['5101'] }])
  check('a new row whose name matches an existing key gets a unique key', dup.body.categories[1].key === 'vendors-2')
  check('no categories is refused before any request', budgetBody([]).error !== undefined)
  check('a nameless row is refused', budgetBody([{ key: '', label: ' ', ceiling: 1, codes: ['5101'] }]).error !== undefined)
  check('a negative ceiling is refused', budgetBody([{ key: '', label: 'X', ceiling: -5, codes: ['5101'] }]).error !== undefined)
  check('a category with no account to measure against is refused', budgetBody([{ key: '', label: 'X', ceiling: 5, codes: [] }]).error !== undefined)
  const rows = defaultBudgetRows([{ code: '5101', name: 'Event COGS — Vendors' }, { code: '6901', name: 'Asset Loss Expense' }, { code: '5102', name: 'Event COGS - Crew' }])
  check('a new budget starts with one row per direct-cost account (not the asset-loss account), named plainly', rows.length === 2 && rows[0].label === 'Vendors' && rows[1].label === 'Crew')
}

section('The report hook (W4)')
{
  check('equal parameters in any order are the same request', reportKey('/reports/x', { b: 2, a: 1 }) === reportKey('/reports/x', { a: 1, b: 2 }))
  check('empty parameters do not change the request', reportKey('/reports/x', { a: 1, b: '', c: null, d: undefined }) === reportKey('/reports/x', { a: 1 }))
  check('a different period is a different request', reportKey('/reports/x', { period: 'ytd' }) !== reportKey('/reports/x', { period: 'all' }))
  check('a list parameter is part of the key', reportKey('/reports/gl', { codes: ['1101', '1102'] }) === '/reports/gl?codes=1101,1102')
  check('no parameters at all', reportKey('/reports/cash-position') === '/reports/cash-position?')
}

section('A CRM note with files')
{
  const n = adaptInteraction({ id: 'n1', interactionDate: '2026-07-01', authorName: 'Dinda', note: 'x', type: 'Note', editedAt: null, attachments: [{ id: 'f1', filename: 'brief.pdf', byteSize: 1234 }] })
  check('a note: stored files carry an id to open, a name and a size', n.attachments.length === 1 && n.attachments[0].id === 'f1' && n.attachments[0].name === 'brief.pdf' && n.attachments[0].size === 1234)
  check('a note with no files has an empty list', adaptInteraction({ id: 'n2', interactionDate: 'd', note: 'x', type: 'Note' }).attachments.length === 0)
}

section('Stock archive and the delivery-order signature')

const stockProjects = new Map([[PROJECT_UUID, { projectNo: 'EVT-0001' }]])
const archivedRow = adaptInventoryItem({
  id: VENDOR_UUID, itemNo: 'IT-90', item: 'Old truss', type: 'Fixed Asset', qty: '2.00', unit: 'pc',
  unitValue: '1500000.00', status: 'in_stock', projectId: null, archivedAt: '2026-10-01T08:00:00Z',
}, { projects: stockProjects })
check('an archived item keeps its date', archivedRow.archivedAt === '2026-10-01T08:00:00Z')
check('a live item has none', adaptInventoryItem({ id: VENDOR_UUID, itemNo: 'IT-91', item: 'x', type: 'Consumable', qty: '1', unitValue: '1', projectId: null }, { projects: stockProjects }).archivedAt === null)

const signedOrder = adaptDeliveryOrder({
  id: PROJECT_UUID, doNo: 'DO-2300', projectId: PROJECT_UUID, status: 'Draft', signed: false,
  hasSignature: true, signedByName: 'Pak Hendra', signedAt: '2026-10-14T09:00:00Z',
  dispatchedOn: null, receivedOn: null, eventDate: null, lines: [],
}, { projects: stockProjects })
check('the order says a signature is on file', signedOrder.hasSignature === true)
check('and who signed it', signedOrder.signedByName === 'Pak Hendra')
check('the picture itself is never carried on the record', !('signature' in signedOrder) && !('signatureKey' in signedOrder))
const unsignedOrder = adaptDeliveryOrder({ id: PROJECT_UUID, doNo: 'DO-2301', projectId: PROJECT_UUID, status: 'Draft', lines: [] }, { projects: stockProjects })
check('an order with no signature reads as unsigned', unsignedOrder.hasSignature === false && unsignedOrder.signedByName === null)

section('Client relationships come in the shapes the CRM screens draw')

const relationsRow = {
  contacts: [{ id: 'c1', name: 'Ibu Sari', role: 'HR', phone: '0812', email: '', birthday: '07-28', greet: false, channel: 'both' }],
  anniversary: '2019-03-01', greetAnniversary: true, anniversaryChannel: 'email', nudgeLeadMonths: 4,
  cycles: [{ id: 'y1', name: 'Annual Gala', history: ['2024-07', '2025-07'] }],
  handledNudges: [{ key: 'Annual Gala:2026-07', note: 'Called.', handledAt: '2026-04-02T09:00:00Z' }],
  greetings: [{ id: 'g1', kind: 'Birthday', to: 'Ibu Sari', channel: 'whatsapp', occasionYear: 2026, markedAt: '2026-07-28T08:00:00Z' }],
}
const rel = adaptRelations(relationsRow)
check('a contact becomes a PIC the panel draws', rel.pics[0].name === 'Ibu Sari' && rel.pics[0].birthday === '07-28')
check('a switched-off greeting stays off', rel.pics[0].greet === false && rel.pics[0].channel === 'both')
check('the anniversary settings carry across', rel.anniversary === '2019-03-01' && rel.greetAnniversary === true && rel.anniversaryChannel === 'email' && rel.nudgeLeadMonths === 4)
check('a cycle keeps its id and months', rel.cycles[0].id === 'y1' && rel.cycles[0].history.length === 2)
check('handled nudges read as keys, with the outreach beside them', rel.handledNudges[0] === 'Annual Gala:2026-07' && rel.outreach[0].note === 'Called.')
check('a greeting sent keeps its year', rel.greetings[0].year === 2026)
check('nothing at all adapts to an empty shape, not a crash', adaptRelations(null).pics.length === 0 && adaptRelations(undefined).nudgeLeadMonths === 3)

check('a blank birthday is sent as null so it clears', contactBody({ name: ' X ', birthday: '' }).birthday === null)
check('a contact body is trimmed and keeps its greeting choice', contactBody({ name: ' X ', greet: false }).name === 'X' && contactBody({ name: 'X', greet: false }).greet === false)
check('months are read from commas, spaces and lines', JSON.stringify(parseMonths('2024-07, 2025-07\n2026-07;2027-07')) === JSON.stringify(['2024-07', '2025-07', '2026-07', '2027-07']))
check('no months is an empty list', parseMonths('').length === 0 && parseMonths(undefined).length === 0)

const calItem = adaptCalendarItem({
  kind: 'Birthday', clientId: 'uuid-1', clientNo: 'CL-01', client: 'Aurora', date: '2026-08-05', inDays: 10,
  key: null, title: 'Ibu Sari', detail: 'HR', picId: 'c1', greet: true, channel: 'whatsapp', alreadySent: false,
  message: 'Happy birthday', whatsappUrl: 'https://wa.me/62812?text=Hi', emailUrl: null,
})
check('a calendar item links by client number and keeps the uuid for writes', calItem.clientId === 'CL-01' && calItem.clientUuid === 'uuid-1')
check('a birthday carries its person and the prepared links', calItem.pic.id === 'c1' && calItem.whatsappUrl.startsWith('https://wa.me/') && calItem.emailUrl === null)
check('a nudge has no person', adaptCalendarItem({ kind: 'Event nudge', clientNo: 'CL-01', clientId: 'u', key: 'A:2026-11', title: 'A 2026' }).pic === null)

section('Campaigns come in the shapes the CRM screen draws')

const campaignRow = {
  id: 'cmp-1', campaignNo: 'CMP-0007', name: 'Year-end offer', channel: 'whatsapp', message: 'Hi {name}',
  createdAt: '2026-10-14T09:00:00Z', createdBy: 'Rina', requestedCount: 5, skippedCount: 1,
  unreachableCount: 1, recipientCount: 3, sentCount: 2,
  recipients: [
    { id: 'r1', position: 1, name: 'Anton', phone: '0812', email: '', consentAt: '2026-07-01T10:00:00Z', consentSource: 'Gala', sentAt: null, unsubscribedAt: null, erased: false, status: 'pending', link: 'https://wa.me/62812?text=Hi%20Anton' },
    { id: 'r2', position: 2, name: '', phone: '', email: '', consentAt: null, consentSource: null, sentAt: null, unsubscribedAt: null, erased: true, status: 'erased', link: null },
  ],
}
const campaign = adaptCampaign(campaignRow)
check('a campaign keeps its number and counts', campaign.no === 'CMP-0007' && campaign.count === 3 && campaign.sent === 2 && campaign.skipped === 1 && campaign.unreachable === 1)
check('the summary says how many were left out and why', campaignSummary(campaign) === '3 recipients · 2 reached · 1 skipped (no consent) · 1 no phone')
check('an email campaign names the missing address, not the phone', campaignSummary({ ...campaign, channel: 'email' }).includes('no email'))
const detail = adaptCampaignDetail(campaignRow)
check('the detail carries its recipients', detail.recipients.length === 2 && detail.recipients[0].consentSource === 'Gala')
check('a pending recipient has a send link', detail.recipients[0].link.startsWith('https://wa.me/'))
check('an erased recipient is blank, flagged, and has no link', detail.recipients[1].erased === true && detail.recipients[1].name === '' && detail.recipients[1].link === null)
check('statuses read as words', recipientStatusLabel('pending') === 'To reach' && recipientStatusLabel('unsubscribed') === 'Unsubscribed' && recipientStatusLabel('odd') === 'odd')

section('The sales leaderboard is derived from accepted quotations')
{
  const q = (createdBy, status, contractValue, projectId) => ({ createdBy, status, contractValue, projectId })
  const rows = deriveSales(
    [q('Dinda', 'Accepted', 100, 'P-1'), q('Dinda', 'Accepted', 50, 'P-2'), q('Dinda', 'Sent', 999, null), q('Bima', 'Accepted', 70, 'P-3'), q('Bima', 'Accepted', 500, 'P-4')],
    [{ id: 'P-4', cancelled: true }, { id: 'P-1', cancelled: false }],
    3,
  )
  const dinda = rows.find((r) => r.name === 'Dinda')
  const bima = rows.find((r) => r.name === 'Bima')
  check('accepted quotations are counted and summed per person', dinda.closedWon === 2 && dinda.contractTotal === 150)
  check('a quotation that is not accepted is left out', dinda.contractTotal !== 1149)
  check('a cancelled project does not count', bima.closedWon === 1 && bima.contractTotal === 70)
  check('every row carries the one company rate', rows.every((r) => r.commissionPct === 3))
  check('nothing accepted gives an empty board', deriveSales([], [], 2.5).length === 0)
}

section('The cost estimator compares the same kind of item across vendors')
{
  const it = (id, vendorId, vendor, category, subcategory, unitPrice, stock) => ({ id, vendorId, vendor, category, subcategory, unitPrice, stock, item: `${vendor} ${id}`, unit: 'm2' })
  const cat = [
    it('I1', 'V1', 'Lumina', 'AV', 'LED', 42, 5), it('I2', 'V1', 'Lumina', 'AV', 'LED', 40, 2),
    it('I3', 'V2', 'BrightRig', 'AV', 'LED', 37.5, 3), it('I4', 'V3', 'Solo', 'Decor', 'Floral', 9, 1),
  ]
  const groups = quoteGroups(cat)
  check('only groups with two or more vendors are offered', groups.length === 1 && groups[0].key === 'AV|LED' && groups[0].vendors === 2)
  const { quotes, lowest } = compareQuotes(cat, [{ id: 'V1', score: 4.5, delays: 1, terms: { dpPercent: 50, settlementDays: 14 } }], 'AV|LED')
  check('one quote per vendor, that vendor cheapest item', quotes.length === 2 && quotes.find((x) => x.vendorId === 'V1').unitPrice === 40)
  check('cheapest first, and the lowest price is reported', quotes[0].vendorId === 'V2' && lowest === 37.5)
  check('the vendor rating and terms come along', quotes.find((x) => x.vendorId === 'V1').score === 4.5 && quotes.find((x) => x.vendorId === 'V1').dpPercent === 50)
  check('no overlap between vendors gives no groups and no lowest', quoteGroups([cat[3]]).length === 0 && compareQuotes([], [], 'x').lowest === null)
}

section('Today: the demo keeps its frozen date, a real login uses the real one')
{
  check('signed out, today is the demo date', todayFor(false) === DEMO_TODAY)
  check('signed in, today is the real date', todayFor(true) === realToday() && /^\d{4}-\d{2}-\d{2}$/.test(realToday()))
  check('and it is not the frozen one', realToday() !== DEMO_TODAY)
  check('the app clock is the demo date until the server data is loaded', appToday() === DEMO_TODAY && monthStart() === '2026-07-01' && yearStart() === '2026-01-01')
  setLiveClock(true)
  check('then it is the real date, and the helpers that default to it follow', appToday() === realToday() && daysUntil(realToday()) === 0 && monthStart() === `${realToday().slice(0, 7)}-01` && yearStart() === `${realToday().slice(0, 4)}-01-01`)
  setLiveClock(false)
  check('and back to the demo date on sign-out', appToday() === DEMO_TODAY)
}

// ---------------------------------------------------------------------------
// Periods tab
// ---------------------------------------------------------------------------
{
  const { recentMonths, overlayPeriods } = await import('../src/lib/periods.js')
  const m = recentMonths('2026-02-15', 4)
  check('the window runs back from this month across a year end', JSON.stringify(m) === JSON.stringify([{ year: 2026, month: 2 }, { year: 2026, month: 1 }, { year: 2025, month: 12 }, { year: 2025, month: 11 }]))
  const laid = overlayPeriods(m, [{ year: 2026, month: 1, status: 'closed', closedAt: '2026-02-01T00:00:00Z' }, { year: 2025, month: 12, status: 'open', closedAt: null }])
  check('a closed row marks its month closed', laid[1].closed === true && laid[1].closedAt.startsWith('2026-02-01'))
  check('a reopened row and a month with no row are both open', laid[2].closed === false && laid[0].closed === false)
  check('there is a row for every month asked for, in order', laid.length === 4 && laid[0].month === 2)
}

// ---------------------------------------------------------------------------
// Client history (from the server)
// ---------------------------------------------------------------------------
{
  const { historyTimeline, historySummary } = await import('../src/lib/clientHistory.js')
  const h = {
    contracted: '480000000.00', collected: '240000000.00', avgRating: '9.0', eventCount: 2,
    vendorsUsed: [{ name: 'Lumina LED', events: 2, spend: '1500000.00' }],
    events: [
      { name: 'Summit', eventDate: '2026-11-18', contractValue: '480000000.00', stage: 'Finished', cancelled: false, rating: '9.0', vendors: [{ name: 'Lumina LED' }] },
      { name: 'Gala', eventDate: '2027-02-01', contractValue: '100000000.00', stage: 'DP Paid', cancelled: false, rating: null, vendors: [] },
      { name: 'Dropped', eventDate: '2026-05-01', contractValue: '1.00', stage: 'DP Paid', cancelled: true, rating: null, vendors: [] },
    ],
  }
  const rows = historyTimeline(h)
  check('the timeline is newest first', rows.map((r) => r.name).join() === 'Gala,Summit,Dropped')
  check('a rating out of ten becomes stars out of five', rows[1].satisfaction === 4.5 && rows[0].satisfaction === null)
  check('an event not yet at feedback is live and shows its stage', rows[0].live === true && rows[0].stage === 'DP Paid')
  check('a finished event is not live', rows[1].live === false)
  check('a cancelled event says so', rows[2].stage === 'Cancelled' && rows[2].live === true)
  const sum = historySummary(h)
  check('the headline figures come from the server', sum.ltv === 480000000 && sum.collected === 240000000 && sum.avgSat === 4.5 && sum.eventCount === 2)
  check('vendors used are name and number of events', JSON.stringify(sum.vendorsUsed) === JSON.stringify([['Lumina LED', 2]]))
  check('no history is empty, not an error', historyTimeline(null).length === 0 && historySummary(null).avgSat === null)
}

// --- vendor lifecycle (P4) ---------------------------------------------------------------------------
{
  const { adaptVendorLifecycles } = await import('../src/store/adapters.js')
  const { checklistFor, resumeStageOf, vendorStageOf, vendorKey } = await import('../src/lib/vendors.js')
  const rows = [{
    vendorId: 'uuid-1', stage: 'On hold', since: '2026-10-13T09:00:00Z', reason: 'Late on two events',
    checks: { reference: true },
    checklist: [
      { key: 'npwp', label: 'Tax ID (NPWP) recorded', done: true, manual: false, auto: false },
      { key: 'agreement', label: 'Signed agreement (MoU) on file', done: true, manual: true, auto: true },
      { key: 'reference', label: 'Reference checked with a past client', done: false, manual: true, auto: false },
    ],
    checklistComplete: false, hasAgreementFile: true, hasLivePo: true, resumeTo: 'Active',
    history: [
      { stage: 'Prospect', reason: null, by: 'Agus P.', at: '2026-10-01T09:00:00Z' },
      { stage: 'On hold', reason: 'Late on two events', by: 'Dewi', at: '2026-10-13T09:00:00Z' },
    ],
  }]
  const map = adaptVendorLifecycles(rows)
  const entry = map['uuid-1']
  check('the lifecycle is keyed by the vendor uuid, which is what vendorKey gives a live vendor', Boolean(entry) && vendorKey({ uuid: 'uuid-1', id: 'V-01' }) === 'uuid-1')
  check('the stage, who moved it last and why come from the server', entry.stage === 'On hold' && entry.by === 'Dewi' && entry.reason === 'Late on two events')
  check('the history keeps its order and drops an empty reason', entry.history.length === 2 && entry.history[0].reason === undefined && entry.history[1].reason === 'Late on two events')
  check('the checklist is the server answer, so a filed agreement counts without a tick', checklistFor({}, entry).items.find((i) => i.key === 'agreement').done === true && checklistFor({}, entry).done === 2)
  check('an incomplete server checklist is not complete', checklistFor({}, entry).complete === false)
  check('on hold goes back to where the server says', resumeStageOf(entry) === 'Active')
  check('a vendor the server has no record of is Approved', vendorStageOf(map, 'uuid-none') === 'Approved')
  check('the demo still works without a server answer', checklistFor({ npwp: 'x' }, { checks: {} }).done === 1)
}

// --- monthly trend (P5) ------------------------------------------------------------------------------
{
  const { trendSeries, trendIsEmpty, cardDelta, monthLabel } = await import('../src/lib/trend.js')
  const trend = {
    months: [
      { month: '2026-05', revenue: '0.00', cost: '0.00', profit: '0.00' },
      { month: '2026-06', revenue: '100000000.00', cost: '60000000.00', profit: '40000000.00' },
      { month: '2026-07', revenue: '1234500000.00', cost: '0.00', profit: '1234500000.00' },
    ],
    delta: { revenue: 1134.5, closingCash: null },
  }
  const pts = trendSeries(trend)
  check('a month label is the month name', monthLabel('2026-07') === 'Jul' && monthLabel('2026-12') === 'Dec' && monthLabel('2027-01') === 'Jan')
  check('the chart plots revenue in millions of rupiah to one decimal', pts[1].v === 100 && pts[2].v === 1234.5)
  check('cost and profit ride along for the tooltip', pts[1].cost === 60 && pts[1].profit === 40)
  check('an empty month is a zero, not a gap', pts[0].v === 0 && pts.length === 3)
  check('no revenue in any month is reported as empty', trendIsEmpty({ months: [{ revenue: '0.00' }, { revenue: '0' }] }) === true && trendIsEmpty(trend) === false)
  check('a missing trend is empty and draws nothing', trendSeries(null).length === 0 && trendIsEmpty(null) === true)
  check('a stat card arrow is a whole percentage, or none when there is nothing to compare', cardDelta(12.4) === 12 && cardDelta(-7.6) === -8 && cardDelta(0) === 0 && cardDelta(null) === undefined)
}

// --- client survey link (P6) -------------------------------------------------------------------------
{
  const { surveyUrl, canSendSurvey, daysLeft } = await import('../src/lib/surveyLink.js')
  check('the survey address puts the token after the hash, never in the path or query', surveyUrl('https://erp.example/', 'EVT-2026-001', 'abc.1.def') === 'https://erp.example/rate/EVT-2026-001#abc.1.def')
  check('a project number is encoded in the path', surveyUrl('https://x', 'A B', 't').includes('/rate/A%20B#'))
  check('only a project at feedback or finished can be sent a survey', canSendSurvey({ stage: 'Post-Event Feedback' }) && canSendSurvey({ stage: 'Finished' }) && !canSendSurvey({ stage: 'Execution Event' }) && !canSendSurvey(null))
  check('a cancelled project cannot be sent a survey', !canSendSurvey({ stage: 'Finished', cancelled: true }))
  const now = Date.parse('2026-07-26T00:00:00Z')
  check('days left are rounded up and never negative', daysLeft('2026-08-25T00:00:00Z', now) === 30 && daysLeft('2026-07-26T06:00:00Z', now) === 1 && daysLeft('2026-07-01T00:00:00Z', now) === 0 && daysLeft('garbage', now) === 0)
}

console.log('')
if (failures.length) {
  console.log(`\x1b[31m${failures.length} failed\x1b[0m, ${passed} passed`)
  failures.forEach((f) => console.log(`  \x1b[31m✗\x1b[0m ${f}`))
  process.exit(1)
}
console.log(`\x1b[32m✓ ${passed} adapter assertions passed\x1b[0m (no backend needed)`)
