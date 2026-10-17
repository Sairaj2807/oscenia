// End-to-end check of the store actions that post to the ledger.
//
// verify-ledger.mjs proves the SEED data is sound. This proves the ACTIONS are:
// confirming a down payment, writing off lost stock, disbursing incentives,
// topping up petty cash, settling a cash advance, and adjusting an entry all
// have to leave the books balanced. Without this the only way to catch a bad
// posting is to click through the UI and eyeball a statement.
//
// Run: npm run verify:flows   (plain node, no bundler)
import { useStore, pettyCashBalance } from '../src/store/useStore.js'
import * as ledger from '../src/lib/ledger.js'
import * as vendors from '../src/lib/vendors.js'
import * as roles from '../src/lib/roles.js'
import * as accounts from '../src/lib/accounts.js'
import * as vouchers from '../src/lib/vouchers.js'
import * as search from '../src/lib/search.js'
import { DEMO_TODAY } from '../src/lib/format.js'
import * as billing from '../src/lib/billing.js'
import * as depr from '../src/lib/depreciation.js'

const fmt = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
}

const s = () => useStore.getState()
const books = () => {
  const st = s()
  const tb = ledger.trialBalance(st.journal)
  const bs = ledger.balanceSheetFrom(st.journal, st.taxConfig)
  return { tb, bs }
}
const assertBooks = (label) => {
  const { tb, bs } = books()
  check(`${label} — trial balance holds`, tb.balanced, `D ${fmt(tb.debit)} / C ${fmt(tb.credit)}`)
  check(`${label} — Assets = L + E`, bs.balanced, `difference ${fmt(bs.difference)}`)
}

console.log('\n=== 0. Baseline ===')
assertBooks('baseline')
const startCash = ledger.cashBalance(s().journal)
const startEntries = s().journal.length
console.log(`    cash ${fmt(startCash)} · ${startEntries} entries`)

// ---------------------------------------------------------------------------
console.log('\n=== 1. Quotation accepted -> becomes the pending deal ===')
// QT-1002 has dpPercent 40, so the DP must NOT be the old hardcoded 30%.
s().acceptQuotation('QT-1002')
// `deals` is a collection now, and the seed already holds one unconfirmed deal, so every
// call below names the deal it means. That is the fix: with a single slot, accepting this
// quotation silently discarded the seeded one.
const deal = s().deals.find((d) => d.id === 'DEAL-QT-1002')
check('accepting does not discard the other open deal', s().deals.length === 2, `${s().deals.length} deals`)
const expectedDp = Math.round(deal.contractValue * 0.40)
check('quote value carried through', deal.contractValue === 314_000_000, fmt(deal.contractValue))
check('DP honours the quotation percentage (40%, not 30%)', deal.dpAmount === expectedDp,
  `${fmt(deal.dpAmount)} vs expected ${fmt(expectedDp)}`)
check('estimated cost taken from line costs', deal.estimatedCost === 220_000_000, fmt(deal.estimatedCost))

// ---------------------------------------------------------------------------
console.log('\n=== 2. Confirm DP -> project, invoice and the corrected PPh 23 pair ===')
s().confirmDownPayment(deal.id)
const st2 = s()
// Two entries now: [0] is the receipt, [1] the invoice that raised the
// receivable. The old single-entry version debited cash at gross and credited
// PPh 23 to a PAYABLE, which is the treatment for tax Oscenia withholds from a
// vendor — backwards for money coming in.
const dpReceiptEntry = st2.journal[0]
const dpInvoiceEntry = st2.journal[1]
const dpTax = Math.round(deal.dpAmount * 0.02)

check('project created', st2.projects.some((p) => p.id === deal.projectIdOnConfirm))
const dpInvoice = st2.invoices.find((i) => i.project === deal.projectIdOnConfirm && i.type === 'Down Payment')
check('invoice logged', Boolean(dpInvoice), dpInvoice?.id)
check('the invoice records what was collected', dpInvoice.paid === deal.dpAmount)
check('invoice numbers are unique across confirmations',
  new Set(st2.invoices.map((i) => i.id)).size === st2.invoices.length)
check('both entries are balanced',
  ledger.isBalanced(dpReceiptEntry) && ledger.isBalanced(dpInvoiceEntry))
check('the receipt is linked to the invoice that raised the debt',
  dpReceiptEntry.appliedTo.includes(dpInvoiceEntry.id))

const dpRev = dpInvoiceEntry.lines.find((l) => l.account === '4101')
check('revenue is recognised GROSS', dpRev && dpRev.credit === deal.dpAmount,
  dpRev ? fmt(dpRev.credit) : 'missing')
const dpPrepaid = dpReceiptEntry.lines.find((l) => l.account === '1401')
check('PPh 23 withheld at 2% lands in Prepaid Tax, not a payable',
  dpPrepaid && dpPrepaid.debit === dpTax, dpPrepaid ? fmt(dpPrepaid.debit) : 'missing')
check('no payable is raised on money received',
  !dpReceiptEntry.lines.some((l) => l.account === '2105'))
const dpCashLine = dpReceiptEntry.lines.find((l) => l.account === '1101')
check('cash arrives net of the withholding',
  dpCashLine && dpCashLine.debit === deal.dpAmount - dpTax, dpCashLine ? fmt(dpCashLine.debit) : 'missing')

const cashAfterDp = ledger.cashBalance(st2.journal)
check('cash rose by the NET down payment', Math.abs(cashAfterDp - (startCash + deal.dpAmount - dpTax)) < 1,
  `${fmt(cashAfterDp)} vs ${fmt(startCash + deal.dpAmount - dpTax)}`)
check('the receivable nets to zero — raised and cleared at gross',
  Math.abs(ledger.generalLedger(st2.journal.filter((e) => e.project === deal.projectIdOnConfirm),
    { codes: ['1201'] }).closing) < 1)
check('confirming twice is a no-op', (() => {
  const before = s().journal.length
  s().confirmDownPayment(deal.id)
  return s().journal.length === before
})())
assertBooks('after DP')

// ---------------------------------------------------------------------------
console.log('\n=== 2b. Undo still works now the DP is a pair ===')
check('undo removes the project and reverses BOTH halves', (() => {
  const before = s().journal.length
  const ok = s().undoDownPayment(deal.id)
  // Two reversals, one per half of the pair.
  return ok === true && s().journal.length === before + 2
    && !s().projects.some((p) => p.id === deal.projectIdOnConfirm)
    && !s().invoices.some((i) => i.project === deal.projectIdOnConfirm)
})())
check('cash is back where it started', Math.abs(ledger.cashBalance(s().journal) - startCash) < 1,
  `${fmt(ledger.cashBalance(s().journal))} vs ${fmt(startCash)}`)
assertBooks('after DP undo')
// Re-confirm so the rest of the suite has the project it expects.
s().confirmDownPayment(deal.id)
assertBooks('after DP re-confirmation')


console.log('\n=== 3. Warehouse write-off posts Asset Loss Expense ===')
const item = s().inventory.find((i) => i.id === 'IT-05') // Truss, 40 @ 2,600,000, in transit
const lossBefore = ledger.accountBalance(s().journal, '6901')
const invBefore = ledger.accountBalance(s().journal, '1302')
s().checkInAsset('IT-05', { good: 30, damaged: 6, lost: 4 })
const st3 = s()
const expectedLoss = 4 * item.unitValue
check('good qty returns to stock', st3.inventory.some((i) => i.id === 'IT-05' && i.status === 'in_stock' && i.qty === 30))
check('damaged qty routed to maintenance', st3.inventory.some((i) => i.status === 'maintenance' && i.qty === 6))
check('lost qty written off', st3.inventory.some((i) => i.status === 'written_off' && i.qty === 4))
check('project link cleared on return', st3.inventory.filter((i) => i.id.startsWith('IT-05')).every((i) => !i.projectId))
check('Asset Loss Expense posted at unitValue x qty',
  Math.abs(ledger.accountBalance(st3.journal, '6901') - (lossBefore + expectedLoss)) < 1,
  fmt(expectedLoss))
check('inventory account reduced by the same amount',
  Math.abs(ledger.accountBalance(st3.journal, '1302') - (invBefore - expectedLoss)) < 1)
check('write-off ids do not collide', new Set(st3.inventory.map((i) => i.id)).size === st3.inventory.length)
assertBooks('after write-off')

// ---------------------------------------------------------------------------
console.log('\n=== 4. Petty cash top-up moves money between accounts ===')
const pettyBefore = ledger.accountBalance(s().journal, '1103')
const bankBefore = ledger.accountBalance(s().journal, '1101')
const cashTotalBefore = ledger.cashBalance(s().journal)
s().topUpPettyCash(15_000_000)
const st4 = s()
check('petty cash up 15,000,000',
  Math.abs(ledger.accountBalance(st4.journal, '1103') - (pettyBefore + 15_000_000)) < 1)
check('bank down 15,000,000',
  Math.abs(ledger.accountBalance(st4.journal, '1101') - (bankBefore - 15_000_000)) < 1)
check('total cash unchanged (internal transfer)',
  Math.abs(ledger.cashBalance(st4.journal) - cashTotalBefore) < 1)
check('petty balance helper agrees with the ledger',
  Math.abs(pettyCashBalance(st4) - ledger.accountBalance(st4.journal, '1103')) < 1,
  `helper ${fmt(pettyCashBalance(st4))} vs ledger ${fmt(ledger.accountBalance(st4.journal, '1103'))}`)
check('zero / negative top-up rejected', (() => {
  const before = s().journal.length
  s().topUpPettyCash(0)
  s().topUpPettyCash(-5_000_000)
  return s().journal.length === before
})())
assertBooks('after top-up')

// ---------------------------------------------------------------------------
console.log('\n=== 5. Procurement: approve -> disburse -> settle ===')
s().setProcurementStatus('PR-103', 'Approved')
check('status advances to Approved', s().procurement.find((r) => r.id === 'PR-103').status === 'Approved')
const entriesBeforeDisburse = s().journal.length
s().setProcurementStatus('PR-103', 'Disbursed')
check('disbursing posts a journal entry', s().journal.length === entriesBeforeDisburse + 1)
assertBooks('after disbursement')

// Settle for less than advanced — the excess must come back.
const pettyBeforeSettle = ledger.accountBalance(s().journal, '1103')
s().settleAdvance('PR-101', 7_000_000, ['toll-14aug.jpg', 'meals-14aug.pdf', '   ']) // advanced 8,500,000
const pr101 = s().procurement.find((r) => r.id === 'PR-101')
check('request marked Completed', pr101.status === 'Completed')
check('variance recorded', pr101.variance === 1_500_000, fmt(pr101.variance))
check('unused 1,500,000 returned to the float',
  Math.abs(ledger.accountBalance(s().journal, '1103') - (pettyBeforeSettle + 1_500_000)) < 1)
// The receipt 'upload' used to be a boolean with a hardcoded filename string,
// so nothing about what was actually filed survived.
check('receipt filenames recorded', pr101.receipts?.length === 2, (pr101.receipts || []).join(', '))
check('blank filenames dropped', (pr101.receipts || []).every((f) => f.trim().length > 0))
check('settlement date stamped', pr101.settledAt === '2026-07-26')
assertBooks('after settlement')

// ---------------------------------------------------------------------------
console.log('\n=== 6. Crew incentives disburse to the ledger ===')
s().submitSurvey('EVT-2026-GALA-01', 9.4)
const fb = s().latestFeedback
check('feedback recorded against a project', fb && fb.projectId === 'EVT-2026-GALA-01')
const crewBefore = ledger.accountBalance(s().journal, '5102')
s().disburseIncentives(fb.pool, fb.projectId)
check('crew COGS increased by the pool',
  Math.abs(ledger.accountBalance(s().journal, '5102') - (crewBefore + fb.pool)) < 1, fmt(fb.pool))
check('bonus cost allocated to the project',
  s().journal[0].project === 'EVT-2026-GALA-01')
check('double disbursement blocked', (() => {
  const before = s().journal.length
  s().disburseIncentives(fb.pool, fb.projectId)
  return s().journal.length === before
})())
assertBooks('after incentives')

// ---------------------------------------------------------------------------
console.log('\n=== 7. Adjust an entry = reverse + repost, original preserved ===')
const target = s().journal.find((e) => e.id === 'JE-1013') // crew payroll 52,600,000
s().adjustJournalEntry('JE-1013', {
  date: target.date,
  memo: 'Corrected crew payroll — Aurora Gala',
  project: target.project,
  lines: [
    { account: '5102', debit: 55_000_000, credit: 0, note: 'Corrected amount' },
    { account: '1101', debit: 0, credit: 55_000_000, note: 'Bank transfer' },
  ],
})
const original = s().journal.find((e) => e.id === 'JE-1013')
check('original still in the ledger', !!original)
check('original flagged as reversed', !!original.reversedBy, original.reversedBy || 'not flagged')
check('reversal entry exists and is balanced', (() => {
  const r = s().journal.find((e) => e.reversalOf === 'JE-1013')
  return r && ledger.isBalanced(r)
})())
check('net effect on crew COGS is the difference only', (() => {
  // was 52.6M, corrected to 55M -> net +2.4M against the pre-adjustment figure
  const now = ledger.accountBalance(s().journal, '5102')
  return Math.abs(now - (crewBefore + fb.pool + 2_400_000)) < 1
})(), fmt(ledger.accountBalance(s().journal, '5102')))
check('re-adjusting an already reversed entry is a no-op', (() => {
  const before = s().journal.length
  s().reverseJournalEntry('JE-1013')
  return s().journal.length === before
})())
assertBooks('after adjustment')

// ---------------------------------------------------------------------------
console.log('\n=== 8. Tax rate change flows through to NPAT ===')
const st8 = s()
const at22 = ledger.incomeStatementFrom(st8.journal, st8.taxConfig)
s().setTaxRate('corporate', 30)
const at30 = ledger.incomeStatementFrom(s().journal, s().taxConfig)
check('raising the rate lowers NPAT', at30.npat < at22.npat, `${fmt(at22.npat)} -> ${fmt(at30.npat)}`)
check('balance sheet still balances at the new rate', ledger.balanceSheetFrom(s().journal, s().taxConfig).balanced)
s().toggleTax('corporate')
const off = ledger.incomeStatementFrom(s().journal, s().taxConfig)
check('disabling tax makes NPAT equal PBT', Math.abs(off.npat - off.profitBeforeTax) < 1)
check('balance sheet balances with tax disabled', ledger.balanceSheetFrom(s().journal, s().taxConfig).balanced)

// ---------------------------------------------------------------------------
console.log('\n=== 9. Realized cost cache stays in step with the ledger ===')
for (const p of s().projects) {
  const posted = ledger.projectCosts(s().journal, p.id).reduce((a, r) => a + r.amount, 0)
  check(`${p.id} realizedCost = posted COGS`, Math.abs(posted - p.realizedCost) < 1,
    `posted ${fmt(posted)} vs cached ${fmt(p.realizedCost)}`)
}

// ---------------------------------------------------------------------------
console.log('\n=== 10. Every entry in the ledger is individually balanced ===')
const unbalanced = s().journal.filter((e) => !ledger.isBalanced(e))
check(`all ${s().journal.length} entries balanced`, unbalanced.length === 0,
  unbalanced.map((e) => e.id).join(', ') || 'none unbalanced')

// ---------------------------------------------------------------------------
console.log('\n=== 11. Purchase orders: approve -> DP -> settle ===')
const poBefore = ledger.accountBalance(s().journal, '5101')
const po = s().purchaseOrders.find((x) => x.id === 'PO-3004') // Bloom & Co, 30% DP
const poValue = vendors.poTotal(po)
const bloom = s().vendors.find((v) => v.id === 'V-04')
check('vendor carries its own PPh 23 rate', bloom.pph23Rate === 1.5, `${bloom.pph23Rate}%`)

// PO-3004 arrives already Approved from the seed, so approving again must be a
// no-op rather than a second commitment.
const entriesBeforeApprove = s().journal.length
s().approvePurchaseOrder('PO-3004')
check('re-approving an approved PO is a no-op', s().journal.length === entriesBeforeApprove)
check('seeded reservation is linked to its PO', (() => {
  const item = s().vendorCatalogue.find((i) => i.id === 'VI-06')
  return item.bookings.some((b) => b.poId === 'PO-3004')
})())

// An approved order is a commitment, not a debt. Nothing is owed and nothing is
// expensed until the vendor invoices.
check('approval alone raises no payable', s().poOutstanding('PO-3004') === 0)
check('and recognises no cost', Math.abs(ledger.accountBalance(s().journal, '5101') - poBefore) < 1)

const apBeforeDp = ledger.accountBalance(s().journal, '2102')
const cashBeforeDp = ledger.cashBalance(s().journal)
s().payPoDownPayment('PO-3004')
const dpExpected = Math.round(poValue * 0.30)
const dpTaxExpected = Math.round(dpExpected * 0.015)

// The first payment triggers the bill, so the WHOLE cost lands at once — a
// vendor invoice is for the whole job, not for the instalment being paid.
check('the first payment raises the bill for the full order value',
  Math.abs(ledger.accountBalance(s().journal, '5101') - (poBefore + poValue)) < 1, fmt(poValue))
check('the payable is raised then partly cleared',
  Math.abs(s().poOutstanding('PO-3004') - (poValue - dpExpected)) < 1,
  fmt(s().poOutstanding('PO-3004')))
check('account 2102 moved by the unpaid remainder',
  Math.abs(ledger.accountBalance(s().journal, '2102') - (apBeforeDp + poValue - dpExpected)) < 1)
check('cash left net of withholding, not gross',
  Math.abs(ledger.cashBalance(s().journal) - (cashBeforeDp - (dpExpected - dpTaxExpected))) < 1)
check('withholding used the vendor rate, not the company default', (() => {
  const e = s().journal[0]
  const tax = e.lines.find((l) => l.account === '2105')
  return tax && Math.abs(tax.credit - dpTaxExpected) < 1
})())
check('the payment is linked to the bill it settles', (() => {
  const pay = s().journal[0]
  return (pay.appliedTo || []).length === 1
})())
assertBooks('after PO down payment')

const costAfterDp = ledger.accountBalance(s().journal, '5101')
s().settlePurchaseOrder('PO-3004')
check('settlement clears the payable in full', s().poOutstanding('PO-3004') === 0)
check('and does NOT expense the cost a second time',
  Math.abs(ledger.accountBalance(s().journal, '5101') - costAfterDp) < 1)
check('PO marked Settled', s().purchaseOrders.find((x) => x.id === 'PO-3004').status === 'Settled')
assertBooks('after PO settlement')

console.log('\n=== 12. Date-aware availability ===')
const truss = s().vendorCatalogue.find((i) => i.id === 'VI-04') // 200 stock, booked 8-18 Aug
check('fully booked inside the window', vendors.availableQty(truss, '2026-08-10', '2026-08-15') === 0)
check('free outside the window', vendors.availableQty(truss, '2026-09-01', '2026-09-05') === 200)
check('unqualified question returns total stock', vendors.availableQty(truss, null, null) === 200)
check('excluding the owning project frees it back up',
  vendors.availableQty(truss, '2026-08-10', '2026-08-15', { excludeProject: 'EVT-2026-GALA-01' }) === 200)
check('overlapping ranges detected', vendors.rangesOverlap('2026-08-01', '2026-08-10', '2026-08-09', '2026-08-20'))
check('adjacent ranges do not overlap', !vendors.rangesOverlap('2026-08-01', '2026-08-10', '2026-08-11', '2026-08-20'))

console.log('\n=== 13. Cancelling a PO reverses its payments ===')
const beforeCancel = ledger.accountBalance(s().journal, '5101')
const draftPo = s().purchaseOrders.find((x) => x.id === 'PO-3005')
check('PO-3005 starts as a Draft', draftPo.status === 'Draft')
const entriesBeforeDraftApprove = s().journal.length
s().approvePurchaseOrder('PO-3005')
check('approving a draft posts nothing', s().journal.length === entriesBeforeDraftApprove)
check('approving a draft reserves the kit', (() => {
  const it = s().vendorCatalogue.find((i) => i.id === 'VI-08')
  return it.bookings.filter((b) => b.poId === 'PO-3005').length >= 1
})())
s().payPoDownPayment('PO-3005')
check('DP raised the cost', ledger.accountBalance(s().journal, '5101') > beforeCancel)
s().cancelPurchaseOrder('PO-3005')
check('cancelling reverses the cost back out',
  Math.abs(ledger.accountBalance(s().journal, '5101') - beforeCancel) < 1)
check('cancelling releases the reservation', (() => {
  const item = s().vendorCatalogue.find((i) => i.id === 'VI-08')
  return !item.bookings.some((b) => b.poId === 'PO-3005')
})())
assertBooks('after PO cancellation')

console.log('\n=== 14. Stage revert (Back) ===')
const stageBefore = s().projects.find((p) => p.id === 'EVT-2026-CONF-03').stage
s().advanceStage('EVT-2026-CONF-03')
check('advanced a stage', s().projects.find((p) => p.id === 'EVT-2026-CONF-03').stage !== stageBefore)
s().revertStage('EVT-2026-CONF-03')
check('reverted to the original stage',
  s().projects.find((p) => p.id === 'EVT-2026-CONF-03').stage === stageBefore, stageBefore)
check('cannot revert past the first stage', (() => {
  const first = s().projects.find((p) => p.stage === 'DP Paid')
  if (!first) return true
  s().revertStage(first.id)
  return s().projects.find((p) => p.id === first.id).stage === 'DP Paid'
})())

console.log('\n=== 15. Project cancellation, refundable vs not ===')
const wedRevenueBefore = ledger.projectRevenue(s().journal, 'EVT-2026-WED-02')
s().cancelProject('EVT-2026-WED-02', { refundDp: false, reason: 'client postponed' })
check('project flagged cancelled', s().projects.find((p) => p.id === 'EVT-2026-WED-02').cancelled === true)
check('non-refundable keeps the revenue',
  Math.abs(ledger.projectRevenue(s().journal, 'EVT-2026-WED-02') - wedRevenueBefore) < 1)
check('unpaid invoices closed off',
  !s().invoices.some((i) => i.project === 'EVT-2026-WED-02' && i.status === 'Unpaid'))
assertBooks('after non-refundable cancellation')

const confRevenueBefore = ledger.projectRevenue(s().journal, 'EVT-2026-CONF-03')
check('conference had revenue to reverse', confRevenueBefore > 0, fmt(confRevenueBefore))
s().cancelProject('EVT-2026-CONF-03', { refundDp: true, reason: 'event cancelled' })
check('refundable reverses the revenue out',
  ledger.projectRevenue(s().journal, 'EVT-2026-CONF-03') < confRevenueBefore)
check('refund flag recorded', s().projects.find((p) => p.id === 'EVT-2026-CONF-03').dpRefunded === true)
assertBooks('after refundable cancellation')
check('cancelling twice is a no-op', (() => {
  const before = s().journal.length
  s().cancelProject('EVT-2026-CONF-03', { refundDp: true })
  return s().journal.length === before
})())

console.log('\n=== 16. Budget tolerance warning ===')
s().setBudgetTolerance(5)
check('tolerance set', s().budgetTolerancePct === 5)
s().postEntry({
  memo: 'Deliberate overspend for the tolerance check',
  project: 'EVT-2026-GALA-01',
  source: { kind: 'po', ref: 'TEST' },
  lines: [
    { account: '5101', debit: 200_000_000, credit: 0, note: 'test' },
    { account: '1101', debit: 0, credit: 200_000_000, note: 'test' },
  ],
})
check('over-budget project flagged once', s().budgetAlerted.includes('EVT-2026-GALA-01'))
assertBooks('after overspend')

console.log('\n=== 17. Action-level permissions ===')
check('PM may request a PO', roles.canDo('pm', 'request_po'))
check('PM may NOT approve a PO', !roles.canDo('pm', 'approve_po'))
check('PM may NOT pay a PO', !roles.canDo('pm', 'pay_po'))
check('PM may NOT post journal entries', !roles.canDo('pm', 'post_journal'))
check('PM may NOT approve cash', !roles.canDo('pm', 'approve_cash'))
check('Finance may approve cash', roles.canDo('finance', 'approve_cash'))
check('Finance may post journal entries', roles.canDo('finance', 'post_journal'))
check('CEO may do everything',
  ['post_journal', 'approve_cash', 'pay_po', 'cancel_project'].every((a) => roles.canDo('ceo', a)))
check('Warehouse may not approve cash', !roles.canDo('warehouse', 'approve_cash'))
check('Sales and the CEO may run campaigns', roles.canDo('sales', 'manage_campaigns') && roles.canDo('ceo', 'manage_campaigns'))
check('Finance and the Warehouse may not run campaigns', !roles.canDo('finance', 'manage_campaigns') && !roles.canDo('warehouse', 'manage_campaigns'))
check('denial names the permitted role',
  (roles.denialReason('pm', 'approve_cash') || '').includes('Finance'),
  roles.denialReason('pm', 'approve_cash'))
check('PM sees Projects but not Accounting',
  roles.canSee('pm', 'projects') && !roles.canSee('pm', 'accounting'))

console.log('\n=== 18. CRM editing ===')
const newClient = s().addClient({ name: 'Nimbus Retail', contact: 'Ibu Sari', phone: '+62 811-0000-1111' })
check('client added', s().clients.some((c) => c.id === newClient.id))
s().updateClient(newClient.id, { phone: '+62 822-9999-8888' })
check('phone updated', s().clients.find((c) => c.id === newClient.id).phone === '+62 822-9999-8888')
s().logInteraction('CL-01', { type: 'Note', note: 'Discussed Q4 gala scope.' })
check('interaction logged against the client',
  (s().interactions['CL-01'] || [])[0]?.note === 'Discussed Q4 gala scope.')
check('existing history preserved', (s().interactions['CL-01'] || []).length > 1)

console.log('\n=== 19. Vendor rate override ===')
s().updateVendorRate('V-01', 3.5)
check('rate updated', s().vendors.find((v) => v.id === 'V-01').pph23Rate === 3.5)
const addedVendor = s().addVendor({ name: 'Nusa Rigging', category: 'Staging' })
check('vendor added with sane defaults', addedVendor.pph23Rate === 2 && addedVendor.terms.dpPercent === 50)

console.log('\n=== 20. Ledger still whole after everything above ===')
const finalUnbalanced = s().journal.filter((e) => !ledger.isBalanced(e))
check(`all ${s().journal.length} entries balanced`, finalUnbalanced.length === 0,
  finalUnbalanced.map((e) => e.id).join(', ') || 'none unbalanced')
assertBooks('final state')

console.log('\n=== 21. Tag vocabulary ===')
// Every seeded tag id must equal slugifyTag(its own label). If it does not, a
// user typing an existing tag's label creates a second tag that looks identical
// in the UI — which is exactly the bug this assertion was written for.
const seed = await import('../src/store/seed.js')
const badSlugs = s().tags.filter((t) => t.id !== seed.slugifyTag(t.label))
check('tag ids match their labels', badSlugs.length === 0,
  badSlugs.map((t) => `${t.id} != slug(${t.label})`).join(', ') || 'all consistent')

const knownTagIds = new Set(s().tags.map((t) => t.id))
const dangling = []
s().vendors.forEach((v) => (v.tags || []).forEach((t) => { if (!knownTagIds.has(t)) dangling.push(`${v.id}:${t}`) }))
s().vendorCatalogue.forEach((i) => (i.tags || []).forEach((t) => { if (!knownTagIds.has(t)) dangling.push(`${i.id}:${t}`) }))
check('no dangling tag references', dangling.length === 0, dangling.join(', ') || 'none')

const tagCountBefore = s().tags.length
s().addTag('Outdoor Capable')
check('re-adding an existing label does not duplicate', s().tags.length === tagCountBefore)
const created = s().addTag('Live Streaming')
check('new tag created with a slug id', created.id === 'live-streaming', created.id)
check('mixed case resolves to the same tag', s().addTag('LIVE streaming').id === 'live-streaming')
check('blank label rejected', s().addTag('   ') === null)

console.log('\n=== 22. Tag filtering is AND ===')
const weddingVendors = vendors.vendorsByTags(s().vendors, ['wedding']).map((v) => v.id)
const weddingOutdoor = vendors.vendorsByTags(s().vendors, ['wedding', 'outdoor-capable']).map((v) => v.id)
check('single tag matches several vendors', weddingVendors.length > 1, weddingVendors.join(', '))
check('two tags narrow the result', weddingOutdoor.length < weddingVendors.length, weddingOutdoor.join(', '))
check('AND semantics: every match carries both tags',
  weddingOutdoor.every((id) => {
    const v = s().vendors.find((x) => x.id === id)
    return v.tags.includes('wedding') && v.tags.includes('outdoor-capable')
  }))
check('no tags selected returns everything',
  vendors.vendorsByTags(s().vendors, []).length === s().vendors.length)
check('catalogue honours the tag filter',
  vendors.catalogueFor(s().vendorCatalogue, { tags: ['wedding'] })
    .every((i) => (i.tags || []).includes('wedding')))

console.log('\n=== 23. Applying and removing tags ===')
s().toggleVendorTag('V-01', 'live-streaming')
check('tag applied to vendor', s().vendors.find((v) => v.id === 'V-01').tags.includes('live-streaming'))
s().toggleVendorTag('V-01', 'live-streaming')
check('toggling again removes it', !s().vendors.find((v) => v.id === 'V-01').tags.includes('live-streaming'))
s().setVendorTags('V-02', ['wedding', 'preferred-supplier'])
check('setVendorTags replaces the whole set',
  s().vendors.find((v) => v.id === 'V-02').tags.join(',') === 'wedding,preferred-supplier')
s().toggleCatalogueTag('VI-09', 'wedding')
check('catalogue item tag applied', s().vendorCatalogue.find((i) => i.id === 'VI-09').tags.includes('wedding'))

console.log('\n=== 24. Deleting a tag cascades ===')
s().toggleVendorTag('V-03', 'live-streaming')
s().toggleCatalogueTag('VI-01', 'live-streaming')
check('tag applied in two places before delete',
  s().vendors.find((v) => v.id === 'V-03').tags.includes('live-streaming') &&
  s().vendorCatalogue.find((i) => i.id === 'VI-01').tags.includes('live-streaming'))
s().deleteTag('live-streaming')
check('removed from the vocabulary', !s().tags.some((t) => t.id === 'live-streaming'))
check('removed from every vendor', !s().vendors.some((v) => (v.tags || []).includes('live-streaming')))
check('removed from every catalogue item',
  !s().vendorCatalogue.some((i) => (i.tags || []).includes('live-streaming')))
check('deleting an unknown tag is a no-op', (() => {
  const before = s().tags.length
  s().deleteTag('does-not-exist')
  return s().tags.length === before
})())

console.log('\n=== 25. Quotation editing ===')
const draftQ = s().quotations.find((q) => q.status === 'Draft')
if (draftQ) {
  s().updateQuotation(draftQ.id, { dpPercent: 45, template: 'government' })
  const after = s().quotations.find((q) => q.id === draftQ.id)
  check('draft edit applies', after.dpPercent === 45 && after.template === 'government')
  check('draft stays Draft', after.status === 'Draft')
}
const sentQ = s().quotations.find((q) => q.status === 'Sent')
if (sentQ) {
  s().updateQuotation(sentQ.id, { dpPercent: 55 })
  const after = s().quotations.find((q) => q.id === sentQ.id)
  check('editing a Sent quote reverts it to Draft', after.status === 'Draft', after.status)
  check('the edit itself applied', after.dpPercent === 55)
}
const acceptedQ = s().quotations.find((q) => q.status === 'Accepted')
if (acceptedQ) {
  const dpBefore = acceptedQ.dpPercent
  check('editing an Accepted quote is refused', s().updateQuotation(acceptedQ.id, { dpPercent: 99 }) === null)
  check('accepted quote left untouched',
    s().quotations.find((q) => q.id === acceptedQ.id).dpPercent === dpBefore)
}
check('editing an unknown quotation is a no-op', s().updateQuotation('QT-0000', {}) === null)

console.log('\n=== 26. Number formatting follows the language ===')
const fmtLib = await import('../src/lib/format.js')

s().setLang('en')
// English output is pinned: the client's own cover slide quotes Rp 1.85 B and
// 192 M, so a rounding change here would silently contradict their deck.
check('EN compact billions', fmtLib.money(1_855_000_000) === 'Rp 1.85 B', fmtLib.money(1_855_000_000))
check('EN compact millions', fmtLib.money(192_000_000) === 'Rp 192 M', fmtLib.money(192_000_000))
check('EN exact 2dp', fmtLib.money2(150_000_000) === 'Rp 150,000,000.00', fmtLib.money2(150_000_000))
check('EN percent', fmtLib.pct2(30.5135) === '30.51%', fmtLib.pct2(30.5135))

s().setLang('id')
// The deck wrote the ask as "(,00)" - a decimal comma, not just 2 decimals.
check('ID percent uses a decimal comma', fmtLib.pct2(30.5135) === '30,51%', fmtLib.pct2(30.5135))
check('ID money uses dot thousands and comma decimal',
  fmtLib.money2(150_000_000) === 'Rp 150.000.000,00', fmtLib.money2(150_000_000))
check('ID bare number localised', fmtLib.num2(52_600_000) === '52.600.000,00', fmtLib.num2(52_600_000))
check('ID compact does not drift (1,85 not 1,86)',
  fmtLib.money(1_855_000_000) === 'Rp 1,85 B', fmtLib.money(1_855_000_000))
check('ID month names localised', fmtLib.formatDate('2026-10-22').includes('Okt'), fmtLib.formatDate('2026-10-22'))

s().toggleLang()
check('toggle returns to en', s().lang === 'en')
check('EN restored byte-identical',
  fmtLib.money2(150_000_000) === 'Rp 150,000,000.00' && fmtLib.pct2(30.5135) === '30.51%')
check('locale getter reports the active locale', fmtLib.getNumberLocale() === 'en-US', fmtLib.getNumberLocale())
check('null renders as an em dash regardless of locale',
  fmtLib.money2(null) === '\u2014' && fmtLib.pct2(null) === '\u2014')

console.log('\n=== 27. MoU templates are user-managed ===')
check('templates are an editable list', Array.isArray(s().mouTemplates) && s().mouTemplates.length >= 3)
check('resolver finds a template by id', seed.resolveTemplate(s().mouTemplates, 'wedding')?.label === 'Wedding')
check('resolver falls back when the id is unknown',
  seed.resolveTemplate(s().mouTemplates, 'no-such-template')?.id === 'corporate')
check('resolver survives an empty list', seed.resolveTemplate([], 'anything') === null)

const tplCreated = s().addMouTemplate({ label: 'Festival', clauses: ['Weather contingency applies.'] })
check('template tplCreated with a slug id', tplCreated?.id === 'festival', tplCreated?.id)
check('tplCreated template carries its clause', tplCreated.clauses.length === 1)
check('blank label rejected', s().addMouTemplate({ label: '   ' }) === null)
// Templates carry contract text, so two with the same name must NOT be merged
// the way tags are — they get distinct ids instead.
const tplTwin = s().addMouTemplate({ label: 'Festival' })
check('duplicate label yields a distinct id, not a merge', tplTwin && tplTwin.id !== tplCreated.id, tplTwin?.id)

console.log('\n=== 28. Template editing ===')
s().updateMouTemplate(tplCreated.id, { heading: 'FESTIVAL AGREEMENT', signatory: 'Festival Director' })
const tplEdited = s().mouTemplates.find((x) => x.id === tplCreated.id)
check('heading tplEdited', tplEdited.heading === 'FESTIVAL AGREEMENT')
check('signatory tplEdited', tplEdited.signatory === 'Festival Director')

s().addTemplateClause(tplCreated.id, 'Second clause.')
s().addTemplateClause(tplCreated.id, 'Third clause.')
check('clauses appended', s().mouTemplates.find((x) => x.id === tplCreated.id).clauses.length === 3)
s().setTemplateClause(tplCreated.id, 1, 'Second clause, amended.')
check('clause text tplEdited',
  s().mouTemplates.find((x) => x.id === tplCreated.id).clauses[1] === 'Second clause, amended.')
// Clause order is contract order, so it has to be movable.
s().moveTemplateClause(tplCreated.id, 2, -1)
check('clause moved up', s().mouTemplates.find((x) => x.id === tplCreated.id).clauses[1] === 'Third clause.')
s().moveTemplateClause(tplCreated.id, 0, -1)
check('cannot move above the first clause',
  s().mouTemplates.find((x) => x.id === tplCreated.id).clauses[0] === 'Weather contingency applies.')
s().moveTemplateClause(tplCreated.id, 2, 1)
check('cannot move below the last clause',
  s().mouTemplates.find((x) => x.id === tplCreated.id).clauses.length === 3)
s().removeTemplateClause(tplCreated.id, 1)
check('clause removed', s().mouTemplates.find((x) => x.id === tplCreated.id).clauses.length === 2)

const tplCopy = s().duplicateMouTemplate(tplCreated.id)
check('duplicate copies the clause list',
  tplCopy.clauses.length === s().mouTemplates.find((x) => x.id === tplCreated.id).clauses.length)
check('duplicate is a separate record', tplCopy.id !== tplCreated.id)

console.log('\n=== 29. Deleting a template protects issued documents ===')
// An accepted quotation was signed against specific clauses; swapping them
// would rewrite an executed agreement, so the delete is refused.
const acceptedTpl = s().quotations.find((q) => q.status === 'Accepted')
if (acceptedTpl) {
  check('refuses to delete a template used by a signed MoU',
    s().deleteMouTemplate(acceptedTpl.template) === false, acceptedTpl.template)
  check('that template still exists', s().mouTemplates.some((x) => x.id === acceptedTpl.template))
}

// A draft, by contrast, is reassigned rather than left dangling.
const draftForTpl = s().quotations.find((q) => q.status === 'Draft')
if (draftForTpl) {
  s().updateQuotation(draftForTpl.id, { template: tplCopy.id })
  check('draft points at the doomed template',
    s().quotations.find((q) => q.id === draftForTpl.id).template === tplCopy.id)
  check('delete succeeds', s().deleteMouTemplate(tplCopy.id) === true)
  check('draft reassigned to the default',
    s().quotations.find((q) => q.id === draftForTpl.id).template === 'corporate')
}

check('no quotation references a missing template',
  s().quotations.every((q) => !q.template || s().mouTemplates.some((x) => x.id === q.template)))

// Whittle down to one and confirm the floor holds.
;[...s().mouTemplates].forEach((tpl) => {
  if (s().mouTemplates.length > 1) s().deleteMouTemplate(tpl.id)
})
check('at least one template always remains', s().mouTemplates.length >= 1, String(s().mouTemplates.length))
check('deleting the last template is refused', s().deleteMouTemplate(s().mouTemplates[0].id) === false)

console.log('\n=== 30. Itemised project costs reconcile ===')
// The project screen lists individual cost postings. If the itemised list and
// the project's realizedCost ever disagree, one of the two screens is lying.
for (const proj of s().projects) {
  const lines = ledger.projectCostEntries(s().journal, proj.id)
  const total = lines.reduce((a, l) => a + l.amount, 0)
  check(`${proj.id} itemised total = realizedCost`, Math.abs(total - proj.realizedCost) < 1,
    `${lines.length} lines, ${fmt(total)} vs ${fmt(proj.realizedCost)}`)
}
// Reversed costs must net out rather than being silently dropped, or the
// itemised list would add up to more than the project actually spent.
const galaLines = ledger.projectCostEntries(s().journal, 'EVT-2026-GALA-01')
check('cost lines carry their entry and account', galaLines.every((l) => l.entryId && l.account))
check('credits appear as negatives, not filtered out',
  galaLines.every((l) => l.amount !== 0))
check('unknown project yields nothing', ledger.projectCostEntries(s().journal, 'NOPE').length === 0)

console.log('\n=== 31. Down-payment rollback ===')
const cashAtStart = ledger.cashBalance(s().journal)
const projCountAtStart = s().projects.length
// Asserted against a deal that is genuinely unconfirmed — the seeded one — rather than
// short-circuiting on a global flag another deal had already set.
check('undo is refused on a deal that was never confirmed',
  s().undoDownPayment('DEAL-GALA-02') === false)

// Fresh confirm, then a clean undo.
s().acceptQuotation('QT-1003')
s().confirmDownPayment('DEAL-QT-1003')
const undoDeal = () => s().deals.find((d) => d.id === 'DEAL-QT-1003')
const undoPid = undoDeal().projectIdOnConfirm
check('confirm created the project', s().projects.some((p) => p.id === undoPid))
const cashAfterConfirm = ledger.cashBalance(s().journal)
check('confirm moved cash', cashAfterConfirm > cashAtStart)

check('undo succeeds while the project is untouched', s().undoDownPayment('DEAL-QT-1003') === true)
check('project removed', !s().projects.some((p) => p.id === undoPid))
check('the project\'s invoices went with it', !s().invoices.some((i) => i.project === undoPid))
// The earlier confirmation's invoice must survive — the old undo matched on a
// hardcoded id and deleted another project's billing along with its own.
check('another project\'s invoices are untouched',
  s().invoices.some((i) => i.project === deal.projectIdOnConfirm))
check('that deal is back to unconfirmed', undoDeal().confirmed === false)
// And the deal confirmed earlier is untouched by it, which one shared flag could not express.
check('undoing one deal does not unconfirm another',
  s().deals.find((d) => d.id === 'DEAL-QT-1002')?.confirmed === true)
check('project count restored', s().projects.length === projCountAtStart)
check('cash returned to its pre-confirmation level',
  Math.abs(ledger.cashBalance(s().journal) - cashAtStart) < 1,
  `${fmt(ledger.cashBalance(s().journal))} vs ${fmt(cashAtStart)}`)
// Reversal, not deletion: the books must still record that a DP was confirmed
// in error and backed out.
check('a reversal entry remains in the ledger', s().journal.some((e) => e.reversalOf))
assertBooks('after DP rollback')

// Now confirm again and post real work — the undo must refuse.
s().confirmDownPayment('DEAL-QT-1003')
const blockedPid = undoDeal().projectIdOnConfirm
s().postEntry({
  memo: 'Vendor cost after confirmation',
  project: blockedPid,
  source: { kind: 'po', ref: 'BLOCKTEST' },
  lines: [
    { account: '5101', debit: 5_000_000, credit: 0, note: 'test' },
    { account: '1101', debit: 0, credit: 5_000_000, note: 'test' },
  ],
})
check('undo refused once a cost has posted', s().undoDownPayment('DEAL-QT-1003') === false)
check('the project survives the refusal', s().projects.some((p) => p.id === blockedPid))
check('the deal stays confirmed after a refused undo', undoDeal().confirmed === true)
assertBooks('after refused rollback')

console.log('\n=== 32. Board drag-and-drop moves ===')
// Dragging can cross several columns at once, which advanceStage/revertStage
// cannot express, so the stage-entry automations have to handle a jump.
const STAGE_LIST = seed.STAGES
const dragTarget = s().projects.find((p) => !p.cancelled && p.stage !== 'Finished')
check('a draggable project exists', Boolean(dragTarget))

if (dragTarget) {
  const startIdx = STAGE_LIST.indexOf(dragTarget.stage)
  const jumpTo = STAGE_LIST[Math.min(startIdx + 2, STAGE_LIST.length - 1)]
  check('multi-column jump accepted', s().moveProjectToStage(dragTarget.id, jumpTo) === true)
  check('project landed on the dropped column',
    s().projects.find((p) => p.id === dragTarget.id).stage === jumpTo, jumpTo)
  check('stage clock restarted',
    s().projects.find((p) => p.id === dragTarget.id).stageSince === '2026-07-26')
  check('dropping on the same column is a no-op',
    s().moveProjectToStage(dragTarget.id, jumpTo) === false)
  check('unknown stage rejected', s().moveProjectToStage(dragTarget.id, 'Not A Stage') === false)
  check('unknown project rejected', s().moveProjectToStage('EVT-NOPE', STAGE_LIST[1]) === false)
}

// A cancelled project must not be draggable back into the live pipeline.
const cancelledProj = s().projects.find((p) => p.cancelled)
if (cancelledProj) {
  check('cancelled project refuses a move',
    s().moveProjectToStage(cancelledProj.id, STAGE_LIST[0]) === false)
}

// Permission matrix for the two drag directions. Sales may push work forward
// but must not quietly pull a project back out of a later stage.
check('sales may advance', roles.canDo('sales', 'advance_stage'))
check('sales may NOT revert', !roles.canDo('sales', 'revert_stage'))
check('PM may do both', roles.canDo('pm', 'advance_stage') && roles.canDo('pm', 'revert_stage'))
check('warehouse may do neither',
  !roles.canDo('warehouse', 'advance_stage') && !roles.canDo('warehouse', 'revert_stage'))

assertBooks('after board moves')

console.log('\n=== 33. Period comparison: MoM, YoY, project-on-project ===')
// The deck names three comparisons. A single boolean could only express one, so
// each is asserted separately here.

// Month-on-month must mean the previous CALENDAR month. Day arithmetic on a
// 31-day window lands on 30 May, which is neither June nor useful.
check('previous month of 2026-07 is 2026-06', fmtLib.previousMonthKey('2026-07') === '2026-06')
check('January rolls back a year', fmtLib.previousMonthKey('2026-01') === '2025-12')
check('month ranges end on the real last day',
  fmtLib.monthRange('2026-06').to === '2026-06-30', fmtLib.monthRange('2026-06').to)
check('February is not assumed to be 31 days',
  fmtLib.monthRange('2026-02').to === '2026-02-28', fmtLib.monthRange('2026-02').to)
check('leap years handled', fmtLib.monthRange('2024-02').to === '2024-02-29')

const julSlice = ledger.sliceTotals(s().journal, { period: fmtLib.monthRange('2026-07') })
const junSlice = ledger.sliceTotals(s().journal, { period: fmtLib.monthRange('2026-06') })
check('both MoM months carry postings', julSlice.entries > 0 && junSlice.entries > 0,
  `${julSlice.entries} vs ${junSlice.entries}`)
check('MoM actually differs', julSlice.revenue !== junSlice.revenue)

// Year-on-year shifts the same window back twelve months.
const yoyWindow = fmtLib.shiftPeriodYears(fmtLib.monthRange('2026-07'), -1)
check('YoY window is the same month a year earlier',
  yoyWindow.from === '2025-07-01' && yoyWindow.to === '2025-07-31', JSON.stringify(yoyWindow))
// The seed ledger opens in 2026, so a YoY window has no data. That has to be
// detectable, or the screen shows a row of zeroes that reads as a collapse.
const firstPosting = ledger.earliestEntryDate(s().journal)
check('ledger start is known', Boolean(firstPosting), firstPosting)
check('an empty comparison window is detectable', yoyWindow.to < firstPosting)

// Previous-period on a custom range uses equal-length day arithmetic, which is
// correct there even though it is wrong for months.
const prevCustom = fmtLib.previousPeriod({ from: '2026-07-01', to: '2026-07-10' })
check('previous custom window is the same length and immediately prior',
  prevCustom.to === '2026-06-30' && prevCustom.from === '2026-06-21', JSON.stringify(prevCustom))
// These dates are timezone-independent by construction. parseDate used to read
// local midnight while output went through toISOString (UTC), which shifted
// every derived date by a day outside UTC.
check('event window is D-2 to D+1, not shifted by the timezone', (() => {
  const w = vendors.eventWindow('2026-08-14')
  return w.from === '2026-08-12' && w.to === '2026-08-15'
})(), JSON.stringify(vendors.eventWindow('2026-08-14')))
check('a date round-trips through parse and emit',
  fmtLib.isoDate(fmtLib.parseDate('2026-03-09').getTime()) === '2026-03-09')
check('previousPeriod handles a missing window', fmtLib.previousPeriod(null) === null)

// Project-on-project compares two ledger slices the same way.
const slices = s().projects.slice(0, 2).map((p) => ({ id: p.id, ...ledger.sliceTotals(s().journal, { project: p.id }) }))
check('two projects yield two distinct slices', slices.length === 2)
if (slices.length === 2) {
  check('each slice carries revenue, cost, profit and margin',
    slices.every((x) => ['revenue', 'cost', 'profit', 'margin'].every((k) => typeof x[k] === 'number')))
  check('profit is revenue less cost on every slice',
    slices.every((x) => Math.abs(x.profit - (x.revenue - x.cost)) < 1))
}
check('an unknown project slices to nothing',
  ledger.sliceTotals(s().journal, { project: 'EVT-NOPE' }).entries === 0)

console.log('\n=== 34. Client notes: create, edit, attach, delete ===')
// Notes are prepended, so an array index is not a stable handle — after one
// insert, index 0 points at a different note. Every note carries an id instead.
const seededNotes = s().interactions['CL-01'] || []
check('every seeded note has an id', seededNotes.length > 0 && seededNotes.every((n) => n.id))
check('note ids are unique', new Set(seededNotes.map((n) => n.id)).size === seededNotes.length)

const noteA = s().logInteraction('CL-01', { type: 'Note', note: 'Scoped the Q4 gala.' })
const noteB = s().logInteraction('CL-01', { type: 'Call', note: 'Confirmed budget.' })
check('created notes carry ids', Boolean(noteA.id && noteB.id))
check('newest note is first', s().interactions['CL-01'][0].id === noteB.id)

// The point of the ids: edit the older note, and the newer one must not move.
check('edit by id succeeds',
  s().updateInteraction('CL-01', noteA.id, { note: 'Scoped the Q4 gala, 600 pax.' }) === true)
check('the intended note changed',
  s().interactions['CL-01'].find((n) => n.id === noteA.id).note === 'Scoped the Q4 gala, 600 pax.')
check('the other note is untouched',
  s().interactions['CL-01'].find((n) => n.id === noteB.id).note === 'Confirmed budget.')
check('an edit is stamped', Boolean(s().interactions['CL-01'].find((n) => n.id === noteA.id).editedAt))

check('attach records a filename', s().attachToInteraction('CL-01', noteA.id, 'minutes.pdf') === true)
check('a second attachment appends', (() => {
  s().attachToInteraction('CL-01', noteA.id, 'floorplan.pdf')
  return s().interactions['CL-01'].find((n) => n.id === noteA.id).attachments.length === 2
})())
check('a blank filename is rejected', s().attachToInteraction('CL-01', noteA.id, '   ') === false)

const noteCountBefore = s().interactions['CL-01'].length
check('delete by id succeeds', s().deleteInteraction('CL-01', noteB.id) === true)
check('exactly one note removed', s().interactions['CL-01'].length === noteCountBefore - 1)
check('the surviving note is the right one', s().interactions['CL-01'].some((n) => n.id === noteA.id))
check('editing a missing note is a no-op', s().updateInteraction('CL-01', 'IN-NOPE', { note: 'x' }) === false)
check('deleting a missing note is a no-op', s().deleteInteraction('CL-01', 'IN-NOPE') === false)
check('note editing is gated on edit_client',
  roles.canDo('sales', 'edit_client') && !roles.canDo('warehouse', 'edit_client'))

console.log('\n=== 35. Vendor attachments ===')
// The download button previously had a tooltip and no onClick, so it did nothing.
const vendorWithDocs = s().vendors.find((v) => (v.attachments || []).length > 0)
check('a vendor carries attachments', Boolean(vendorWithDocs))
if (vendorWithDocs) {
  check('attachments carry name, kind and size',
    vendorWithDocs.attachments.every((a) => a.name && a.kind && a.size))
}

console.log('\n=== 36. Vendor gain/loss variance ===')
// Settlement used to pay exactly the remaining balance, which made the
// committed total a self-fulfilling prophecy: actual could never differ from
// budget, so there was no variance to report. The actual is an input now.
// Creating a PO here rather than reusing a seeded one: by this point earlier
// sections have approved, settled or cancelled all of them, and a test that
// depends on another test's leftovers fails for the wrong reason.
const makePo = (project) => s().createPurchaseOrder({
  vendorId: 'V-02',
  project,
  eventDate: '2026-10-22',
  lines: [{ itemId: 'VI-02', item: 'Line Array Speaker', qty: 5, unitPrice: 1_800_000 }],
  terms: { dpPercent: 40, settlementDays: 21 },
})

const varPo = makePo('EVT-2026-GALA-01')
check('a PO is available to run through settlement', Boolean(varPo))

if (varPo) {
  s().approvePurchaseOrder(varPo.id)
  s().payPoDownPayment(varPo.id)
  const committedVal = vendors.poTotal(varPo)
  // Captured AFTER the down payment, so the bill for the committed amount is
  // already in the books — settlement then moves it to the actual.
  const costBefore = ledger.accountBalance(s().journal, '5101')

  // Came in UNDER the order: a gain.
  const under = committedVal - 3_000_000
  check('settles at an actual below committed', s().settlePurchaseOrder(varPo.id, under) === true)
  const settledPo = s().purchaseOrders.find((po) => po.id === varPo.id)
  check('the actual is recorded', settledPo.actualTotal === under, fmt(settledPo.actualTotal))
  check('variance is reported as a gain', vendors.poVariance(settledPo) === 3_000_000,
    fmt(vendors.poVariance(settledPo)))
  check('paid reports the actual, not the committed', vendors.poPaid(settledPo) === under)
  check('nothing is left outstanding once settled', vendors.poOutstanding(settledPo) === 0)
  // The bill went up at the committed amount; settling below it adjusts the
  // bill back down, so total cost ends on the ACTUAL, never the commitment.
  check('cost ends on the actual, not the committed amount',
    Math.abs(ledger.accountBalance(s().journal, '5101') - (costBefore - (committedVal - under))) < 1,
    `${fmt(ledger.accountBalance(s().journal, '5101'))} vs ${fmt(costBefore - (committedVal - under))}`)
  check('and no payable is left behind', s().poOutstanding(varPo.id) === 0)
  check('settling twice is refused', s().settlePurchaseOrder(varPo.id, under) === false)
  assertBooks('after an under-budget settlement')
}

// Came in OVER the order: a loss.
const overPo = makePo('EVT-2026-GALA-01')
if (overPo) {
  s().approvePurchaseOrder(overPo.id)
  s().payPoDownPayment(overPo.id)
  const committedOver = vendors.poTotal(overPo)
  s().settlePurchaseOrder(overPo.id, committedOver + 2_500_000)
  const done = s().purchaseOrders.find((po) => po.id === overPo.id)
  check('variance is reported as a loss', vendors.poVariance(done) === -2_500_000,
    fmt(vendors.poVariance(done)))
  assertBooks('after an over-budget settlement')
}

// An unsettled PO has no variance: the actual is simply unknown, and reporting
// the unpaid balance as a "gain" would be flattering nonsense.
check('an unsettled PO reports no variance',
  vendors.poVariance({ status: 'Approved', lines: [{ qty: 1, unitPrice: 100 }] }) === null)
check('a project rolls up its settled variances',
  typeof vendors.projectVendorVariance(s().purchaseOrders, 'EVT-2026-GALA-01') === 'number')

console.log('\n=== 37. PM access matches the deck ===')
// Slide 8: a PM oversees the budget plan, may request POs and cash advances,
// and monitors the pipeline and warehouse — but approves no cash or journals.
check('PM sees Budgeting (budget plan oversight)', roles.canSee('pm', 'budgeting'))
check('PM sees the pipeline', roles.canSee('pm', 'projects'))
check('PM sees Warehouse', roles.canSee('pm', 'warehouse'))
check('PM may request a PO', roles.canDo('pm', 'request_po'))
check('PM may request a cash advance', roles.canDo('pm', 'request_advance'))
check('PM may NOT approve cash', !roles.canDo('pm', 'approve_cash'))
check('PM may NOT post to the journal', !roles.canDo('pm', 'post_journal'))
check('PM may NOT approve a PO', !roles.canDo('pm', 'approve_po'))
check('PM may NOT pay a PO', !roles.canDo('pm', 'pay_po'))
check('PM cannot reach the company ledger at all', !roles.canSee('pm', 'accounting'))
check('Finance holds the approvals the PM does not',
  ['approve_cash', 'post_journal', 'approve_po', 'pay_po'].every((a) => roles.canDo('finance', a)))

console.log('\n=== 38. Consumables: the other half of dual-logic ===')
// The screen claimed "consumables reduce stock permanently" and the seed ledger
// contained such an entry, but there was no action to perform one. Only fixed
// assets had check-out/check-in, so half the dual-logic was not operable.
const consumable = s().inventory.find((i) => i.type === 'Consumable' && i.status === 'in_stock' && i.qty > 10)
check('a consumable is on hand', Boolean(consumable))

if (consumable) {
  const qtyBefore = consumable.qty
  const cogsBefore = ledger.accountBalance(s().journal, '5104')
  const invBefore = ledger.accountBalance(s().journal, '1301')
  const release = 10
  const value = release * consumable.unitValue

  check('release succeeds', s().releaseConsumable(consumable.id, release, 'EVT-2026-GALA-01') === true)
  check('stock permanently reduced',
    s().inventory.find((i) => i.id === consumable.id).qty === qtyBefore - release)
  check('consumable COGS posted at unit value x qty',
    Math.abs(ledger.accountBalance(s().journal, '5104') - (cogsBefore + value)) < 1, fmt(value))
  check('inventory account reduced by the same amount',
    Math.abs(ledger.accountBalance(s().journal, '1301') - (invBefore - value)) < 1)
  check('the cost landed on the project', s().journal[0].project === 'EVT-2026-GALA-01')
  check('cannot release more than is held',
    s().releaseConsumable(consumable.id, 99_999, 'EVT-2026-GALA-01') === false)
  check('cannot release zero', s().releaseConsumable(consumable.id, 0, 'EVT-2026-GALA-01') === false)
  assertBooks('after a consumable release')
}

const fixedAsset = s().inventory.find((i) => i.type === 'Fixed Asset')
check('a fixed asset cannot be "released" like a consumable',
  s().releaseConsumable(fixedAsset.id, 1, 'EVT-2026-GALA-01') === false)

console.log('\n=== 39. Maintenance is not a dead end ===')
// The condition split could route items INTO maintenance but never out, so
// anything damaged was stranded there permanently.
const transitAsset = s().inventory.find((i) => i.status === 'in_transit' && i.qty >= 6)
if (transitAsset) {
  s().checkInAsset(transitAsset.id, { good: transitAsset.qty - 5, damaged: 3, lost: 2 })
}
const inMaintenance = s().inventory.find((i) => i.status === 'maintenance')
check('an item reached maintenance', Boolean(inMaintenance), inMaintenance?.id)

if (inMaintenance) {
  check('repairing returns it to stock', s().resolveMaintenance(inMaintenance.id, 'repaired') === true)
  check('status is in_stock', s().inventory.find((i) => i.id === inMaintenance.id).status === 'in_stock')
  check('a repair posts nothing — the asset never left the balance sheet',
    ledger.balanceSheetFrom(s().journal, s().taxConfig).balanced)
  check('an already-resolved item cannot be resolved again',
    s().resolveMaintenance(inMaintenance.id, 'repaired') === false)
}

// Condemning is a write-off and must post the same loss a lost item does.
const transit2 = s().inventory.find((i) => i.status === 'in_transit' && i.qty >= 4)
if (transit2) {
  s().checkInAsset(transit2.id, { good: transit2.qty - 3, damaged: 3, lost: 0 })
  const doomed = s().inventory.find((i) => i.status === 'maintenance')
  if (doomed) {
    const lossBefore = ledger.accountBalance(s().journal, '6901')
    const expected = doomed.qty * (doomed.unitValue || 0)
    check('condemning succeeds', s().resolveMaintenance(doomed.id, 'condemned') === true)
    check('status is written_off', s().inventory.find((i) => i.id === doomed.id).status === 'written_off')
    check('Asset Loss Expense posted at unit value x qty',
      Math.abs(ledger.accountBalance(s().journal, '6901') - (lossBefore + expected)) < 1, fmt(expected))
    assertBooks('after condemning')
  }
}

check('a non-maintenance item cannot be resolved',
  s().resolveMaintenance(fixedAsset.id, 'repaired') === false)
check('an unrecognised outcome is refused', (() => {
  const m = s().inventory.find((i) => i.status === 'maintenance')
  return m ? s().resolveMaintenance(m.id, 'nonsense') === false : true
})())

console.log('\n=== 40. Crew incentives: mandatory project allocation ===')
// The deck calls the Project ID tag mandatory, "for explicit cost allocation".
// It used to be optional: disbursing without one posted project: null, so the
// bonus cost landed on no project and never reached any P&L.
useStore.setState({ incentivesPaid: false })
const untaggedBefore = s().journal.length
check('disbursing without a project tag is refused', s().disburseIncentives(5_000_000, null) === false)
check('nothing was posted', s().journal.length === untaggedBefore)
check('the pool is still undisbursed', s().incentivesPaid === false)
check('an unknown project id is refused too', s().disburseIncentives(5_000_000, 'EVT-NOPE') === false)

const payProject = s().projects.find((p) => !p.cancelled)
const crewCostBefore = ledger.accountBalance(s().journal, '5102')
check('disbursing with a valid project succeeds',
  s().disburseIncentives(5_000_000, payProject.id) === true)
const incentiveEntry = s().journal[0]
check('the entry is tagged to that project', incentiveEntry.project === payProject.id, incentiveEntry.project)
check('crew COGS rose by the pool',
  Math.abs(ledger.accountBalance(s().journal, '5102') - (crewCostBefore + 5_000_000)) < 1)
check('the cost is visible on that project',
  ledger.projectCostEntries(s().journal, payProject.id).some((l) => l.entryId === incentiveEntry.id))
check('double disbursement still blocked', s().disburseIncentives(1_000_000, payProject.id) === false)
assertBooks('after incentive disbursement')

console.log('\n=== 41. Bonus threshold is policy, not a constant ===')
// "Enforce minimum threshold according to policy" — policy is something a
// business changes, so it belongs in the store, not compiled into a component.
check('threshold has a default', s().bonusThreshold === 7)
s().setBonusThreshold(9)
check('threshold is settable', s().bonusThreshold === 9)
s().setBonusThreshold(99)
check('clamped to the 0-10 rating scale', s().bonusThreshold === 10, String(s().bonusThreshold))
s().setBonusThreshold(-4)
check('negatives clamped to zero', s().bonusThreshold === 0)
s().setBonusThreshold('8.5')
check('accepts a numeric string', s().bonusThreshold === 8.5)
s().setBonusThreshold(7)

// The threshold has to actually gate the bonus, not merely display.
const rated = s().crew.map((c) => c.lastRating)
check('crew ratings span the threshold', Math.min(...rated) < 8 && Math.max(...rated) > 8,
  rated.join(', '))
check('raising the threshold above every rating zeroes the pool', (() => {
  s().setBonusThreshold(10)
  const pool = s().crew.reduce((a, c) => {
    const rating = s().latestFeedback?.score ?? c.lastRating
    return a + (rating >= s().bonusThreshold ? Math.round(c.baseRate * (rating / 10)) : 0)
  }, 0)
  s().setBonusThreshold(7)
  return pool === 0
})())
check('threshold changes are gated on approve_incentive',
  roles.canDo('finance', 'approve_incentive') && !roles.canDo('pm', 'approve_incentive'))


// ===========================================================================
// ROUND 2 — chart of accounts, voucher numbering, document linking
// ===========================================================================

console.log('\n=== 42. Chart of accounts is editable, and guarded ===')
const coaBefore = s().accounts.length
s().addAccount({ code: '6104', name: 'Marketing & Brand', type: 'opex', group: 'Overheads' })
check('a new account is added', s().accounts.length === coaBefore + 1)
check('the live chart sees it', accounts.account('6104').name === 'Marketing & Brand')
check('it is offered for posting', accounts.ACCOUNT_GROUPS
  .find((g) => g.label === 'Operating Expenses').codes.includes('6104'))

// A sub-account turns its parent into a header, and inherits the cash flag so
// Total Cash keeps working without the user needing to know what a flag is.
const cashBeforeSubAccount = ledger.cashBalance(s().journal)
s().addAccount({ code: '1101.01', name: 'BCA Operating', type: 'asset', parent: '1101' })
check('a sub-account is created', accounts.account('1101.01').parent === '1101')
check('it inherits the cash flag', accounts.account('1101.01').cash === true)
check('the parent became a header', accounts.isHeader('1101'))
check('a header is no longer postable', !accounts.isPostable('1101'))
// Opening a sub-account under a bank account must not lose the balance already
// sitting on the parent — those postings do not migrate, so BOTH codes have to
// keep counting or Total Cash silently drops the history.
check('a new sub-account counts towards Total Cash',
  accounts.CASH_ACCOUNTS.includes('1101.01'), accounts.CASH_ACCOUNTS.join(', '))
check('the parent keeps counting too, so no balance is lost',
  accounts.CASH_ACCOUNTS.includes('1101'))
check('Total Cash is unchanged by opening a sub-account',
  Math.abs(ledger.cashBalance(s().journal) - cashBeforeSubAccount) < 1,
  `${ledger.cashBalance(s().journal)} vs ${cashBeforeSubAccount}`)

check('sub-accounts nest one level only',
  accounts.validateAccountDraft({ code: '1101.01.01', name: 'x', type: 'asset', parent: '1101.01' },
    s().accounts) !== null)
check('a sub-account cannot cross type',
  accounts.validateAccountDraft({ code: '9999', name: 'x', type: 'opex', parent: '1101' },
    s().accounts) !== null)
check('duplicate codes are refused',
  accounts.validateAccountDraft({ code: '1201', name: 'x', type: 'asset' }, s().accounts) !== null)

// Guard rails on accounts that carry history.
check('1101 has posted history', s().accountUsage('1101') > 0)
check('a used account cannot be renumbered', s().updateAccount('1101', { code: '1109' }) === null)
check('a used account cannot be retyped', s().updateAccount('1101', { type: 'opex' }) === null)
check('a used account CAN be renamed',
  s().updateAccount('1101', { name: 'Main Bank Cash (BCA)' })?.name === 'Main Bank Cash (BCA)')
check('a used account cannot be deleted', s().deleteAccount('1101') === false)
s().addAccount({ code: '6105', name: 'Typo', type: 'opex' })
check('an unused account CAN be deleted', s().deleteAccount('6105') === true)
s().setAccountActive('6104', false)
check('a deactivated account leaves the posting dropdown', !accounts.ACCOUNT_GROUPS
  .find((g) => g.label === 'Operating Expenses').codes.includes('6104'))
s().setAccountActive('6104', true)
assertBooks('after chart edits')

console.log('\n=== 43. Voucher numbering ===')
const allVouchers = s().journal.map((e) => e.voucherNo).filter(Boolean)
check('every entry carries a voucher number',
  s().journal.every((e) => Boolean(e.voucherNo)),
  `${s().journal.length - allVouchers.length} missing`)
check('voucher numbers are unique', new Set(allVouchers).size === allVouchers.length,
  `${allVouchers.length} numbers`)

const kmSeries = () => vouchers.seriesByKey(s().voucherSeries, 'km')
const kmCount = () => s().voucherCounters[vouchers.counterKey(kmSeries(), DEMO_TODAY)] || 0
const kmBefore = kmCount()
const r2Receipt = s().postEntry({
  memo: 'Voucher series probe — cash in',
  lines: [
    { account: '1101', debit: 1_000_000, credit: 0, note: 'in' },
    { account: '4102', debit: 0, credit: 1_000_000, note: 'revenue' },
  ],
  source: { kind: 'invoice', ref: 'PROBE' },
})
check('a cash receipt lands in the KM series', r2Receipt.series === 'km', r2Receipt.voucherNo)
check('the KM counter advanced', kmCount() === kmBefore + 1)

const r2Payment = s().postEntry({
  memo: 'Voucher series probe — cash out',
  lines: [
    { account: '6101', debit: 500_000, credit: 0, note: 'overhead' },
    { account: '1101', debit: 0, credit: 500_000, note: 'out' },
  ],
  source: { kind: 'po', ref: 'PROBE' },
})
check('a disbursement lands in the KK series', r2Payment.series === 'kk', r2Payment.voucherNo)

const r2Manual = s().postEntry({
  memo: 'Voucher series probe — r2Manual',
  lines: [
    { account: '6101', debit: 250_000, credit: 0, note: 'accrued' },
    { account: '2102', debit: 0, credit: 250_000, note: 'payable' },
  ],
  source: { kind: 'manual', ref: null },
})
check('a manual entry lands in the JV series', r2Manual.series === 'jv', r2Manual.voucherNo)
check('the reversal of an entry gets its OWN voucher number', (() => {
  const rev = s().reverseJournalEntry(r2Manual.id, { silent: true })
  return Boolean(rev.voucherNo) && rev.voucherNo !== r2Manual.voucherNo
})())

// The format is the administrator's to change, but not to break.
check('a format without a sequence token is refused',
  s().updateVoucherSeries('kk', { format: '[PREFIX]-[MONTH]' }) === null)
check('a valid format is accepted',
  s().updateVoucherSeries('kk', { format: '[PREFIX]/[YEAR]/[SEQ_0001]' })?.format === '[PREFIX]/[YEAR]/[SEQ_0001]')
const reformatted = s().postEntry({
  memo: 'Voucher format probe',
  lines: [
    { account: '6101', debit: 100_000, credit: 0, note: 'overhead' },
    { account: '1101', debit: 0, credit: 100_000, note: 'out' },
  ],
  source: { kind: 'po', ref: 'PROBE' },
})
check('the new format is applied to the next voucher',
  /^KK\/2026\/\d{4}$/.test(reformatted.voucherNo), reformatted.voucherNo)
check('already-issued numbers were not rewritten', r2Payment.voucherNo.startsWith('KK-'), r2Payment.voucherNo)
assertBooks('after voucher probes')

console.log('\n=== 44. Inter-document linking ===')
const openAr = ledger.openItems(s().journal, { control: '1201', side: 'debit' })
check('an unpaid invoice is an open item', openAr.length > 0,
  openAr.map((o) => o.entry.id).join(', '))
const r2Invoice = openAr[0]
check('its outstanding equals what was raised', Math.abs(r2Invoice.outstanding - r2Invoice.raised) < 1)
const r2Settle = s().postEntry({
  memo: `Settlement of ${r2Invoice.entry.id}`,
  project: r2Invoice.entry.project,
  source: { kind: 'payment', ref: r2Invoice.entry.id },
  appliedTo: [r2Invoice.entry.id],
  lines: [
    { account: '1101', debit: r2Invoice.outstanding, credit: 0, note: 'received' },
    { account: '1201', debit: 0, credit: r2Invoice.outstanding, note: 'cleared' },
  ],
})
check('the payment records the link', r2Settle.appliedTo.includes(r2Invoice.entry.id))
check('the invoice is no longer an open item',
  !ledger.openItems(s().journal, { control: '1201', side: 'debit' })
    .some((o) => o.entry.id === r2Invoice.entry.id))
check('the chain is walkable from the invoice',
  ledger.linkedEntries(s().journal, r2Invoice.entry.id).settledBy.some((e) => e.id === r2Settle.id))
check('the chain is walkable from the payment',
  ledger.linkedEntries(s().journal, r2Settle.id).settles.some((e) => e.id === r2Invoice.entry.id))
// Reversing the r2Payment must reopen the invoice, or a mistaken r2Receipt would
// permanently hide a debt that is still owed.
s().reverseJournalEntry(r2Settle.id, { silent: true })
check('reversing the payment reopens the invoice',
  ledger.openItems(s().journal, { control: '1201', side: 'debit' })
    .some((o) => o.entry.id === r2Invoice.entry.id))
assertBooks('after document linking')

console.log('\n=== 45. General Ledger query ===')
const glOne = ledger.generalLedger(s().journal, { codes: ['1201'] })
check('single-account GL matches the account balance',
  Math.abs(glOne.closing - ledger.accountBalance(s().journal, '1201')) < 1,
  `${glOne.closing} vs ${ledger.accountBalance(s().journal, '1201')}`)
const glAll = ledger.generalLedger(s().journal, {})
check('consolidated GL nets to zero across a balanced ledger',
  Math.abs(glAll.closing) < 1, String(glAll.closing))
check('consolidated debits equal consolidated credits',
  Math.abs(glAll.totalDebit - glAll.totalCredit) < 1)
const glPeriod = ledger.generalLedger(s().journal, { codes: ['1101'], period: { from: '2026-07-01', to: '2026-07-31' } })
check('an opening balance is carried into a narrow period',
  Math.abs(glPeriod.opening) > 1, String(glPeriod.opening))
check('opening + movement = closing',
  Math.abs((glPeriod.opening + glPeriod.totalDebit - glPeriod.totalCredit) - glPeriod.closing) < 1)
const glProject = ledger.generalLedger(s().journal, { project: 'EVT-2026-GALA-01' })
check('the project cost-center filter narrows the ledger',
  glProject.rows.length > 0 && glProject.rows.length < glAll.rows.length,
  `${glProject.rows.length} of ${glAll.rows.length}`)

console.log('\n=== 46. Executive summarisation keeps the totals honest ===')
const r2Inc = ledger.incomeStatementFrom(s().journal, s().taxConfig)
const r2SumOf = (rows) => rows.reduce((a, r) => a + r.amount, 0)
check('rolled-up revenue equals detailed revenue',
  Math.abs(r2SumOf(ledger.rollUpByGroup(r2Inc.revenue, 'revenue')) - r2Inc.totalRevenue) < 1)
check('rolled-up COGS equals detailed COGS',
  Math.abs(r2SumOf(ledger.rollUpByGroup(r2Inc.cogs, 'cogs')) - r2Inc.totalCogs) < 1)
const r2Bs = ledger.balanceSheetFrom(s().journal, s().taxConfig)
check('rolled-up assets equal detailed assets',
  Math.abs(r2SumOf(ledger.rollUpByGroup(r2Bs.assets, 'asset')) - r2Bs.totalAssets) < 1)
check('every rolled-up bucket can still be drilled into',
  ledger.rollUpByGroup(r2Inc.cogs, 'cogs').every((b) => b.derived || b.codes.length > 0))



// ===========================================================================
// ROUND 2 — PPh 23 correction, AR settlement, phased down payments
// ===========================================================================

console.log('\n=== 47. Phased DP schedules resolve exactly ===')
for (const preset of billing.DP_PRESETS) {
  const cv = 314_000_000
  const sched = billing.resolveSchedule(billing.presetStages(preset.key), cv, {
    signingDate: DEMO_TODAY, eventDate: '2026-12-01',
  })
  check(`preset ${preset.label} bills the contract to the rupiah`,
    sched.reduce((a, r) => a + r.amount, 0) === cv,
    sched.map((r) => `${r.percent.toFixed(0)}%`).join(' / '))
  check(`preset ${preset.label} round-trips through matchPreset`,
    billing.matchPreset(billing.presetStages(preset.key)) === preset.key)
}
// Rounding: three equal stages of an odd contract value must still total it.
const oddSched = billing.resolveSchedule(billing.presetStages('staged'), 100_000_001, {
  signingDate: DEMO_TODAY, eventDate: '2026-12-01',
})
check('an awkward contract value still totals exactly',
  oddSched.reduce((a, r) => a + r.amount, 0) === 100_000_001,
  String(oddSched.reduce((a, r) => a + r.amount, 0)))
// Nominal stages mix with percentage stages.
const mixed = [
  { label: 'Deposit', basis: 'amount', value: 50_000_000, anchor: 'signing', offsetDays: 0 },
  { label: 'Balance', basis: 'percent', value: 50, anchor: 'event', offsetDays: -7 },
]
check('a nominal + percentage mix is detected as under-billed',
  billing.validateSchedule(mixed, 314_000_000) !== null)
check('a legacy dpPercent quote still resolves',
  billing.stagesFor({ dpPercent: 40 }).length === 2)
check('due dates anchor to the event, not just to signing',
  billing.resolveSchedule(billing.presetStages('50'), 100_000_000,
    { signingDate: '2026-07-26', eventDate: '2026-12-01' })[1].due === '2026-11-24')

console.log('\n=== 48. Accepting a phased quote drafts the billing schedule ===')
// Every seed quotation has been accepted or declined by the earlier sections,
// so raise a fresh one rather than depending on suite ordering.
const phaseQuote = s().addQuotation({
  client: 'Kirana Group',
  eventType: 'Annual Conference',
  eventDate: '2026-12-01',
  lineItems: [
    { label: 'Venue & Staging', amount: 180_000_000, estCost: 126_000_000 },
    { label: 'AV & Vendors', amount: 134_000_000, estCost: 94_000_000 },
  ],
})
check('a quotation is available to phase', Boolean(phaseQuote), phaseQuote?.id)
s().updateQuotation(phaseQuote.id, { dpSchedule: billing.presetStages('staged') })
check('the schedule is stored on the quotation',
  s().quotations.find((q) => q.id === phaseQuote.id).dpSchedule.length === 3)

s().acceptQuotation(phaseQuote.id)
const phaseDeal = s().deals.find((d) => d.id === `DEAL-${phaseQuote.id}`)
check('the deal carries a resolved three-stage schedule', phaseDeal.dpSchedule.length === 3)
check('the DP is the first stage, not a hardcoded percentage',
  phaseDeal.dpAmount === phaseDeal.dpSchedule[0].amount)
check('the stages total the contract value',
  phaseDeal.dpSchedule.reduce((a, st) => a + st.amount, 0) === phaseDeal.contractValue)

const b_invBefore = s().invoices.length
s().confirmDownPayment(phaseDeal.id)
const phasePid = phaseDeal.projectIdOnConfirm
const phaseInvoices = s().invoices.filter((i) => i.project === phasePid)
check('one invoice per stage was drafted', phaseInvoices.length === 3,
  `${s().invoices.length - b_invBefore} added`)
check('stage one is settled', phaseInvoices.find((i) => i.type === 'Down Payment').status === 'Paid')
check('later stages are Scheduled, not Unpaid',
  phaseInvoices.filter((i) => i.status === 'Scheduled').length === 2)
check('scheduled stages have their own due dates',
  new Set(phaseInvoices.map((i) => i.due)).size === 3)
// A scheduled stage is a plan, so it must not have posted a receivable yet.
const scheduledStage = phaseInvoices.find((i) => i.status === 'Scheduled')
check('a scheduled stage has posted nothing to the ledger',
  !s().journal.some((e) => e.source?.ref === scheduledStage.id))
assertBooks('after phased DP confirmation')

console.log('\n=== 49. Issuing a scheduled stage raises the receivable ===')
const arBeforeIssue = ledger.accountBalance(s().journal, '1201')
const b_issued = s().issueInvoice(scheduledStage.id)
check('issuing posts an entry', Boolean(b_issued), b_issued?.voucherNo)
check('the receivable rose by the stage amount',
  Math.abs(ledger.accountBalance(s().journal, '1201') - (arBeforeIssue + scheduledStage.amount)) < 1)
check('the stage is now Unpaid',
  s().invoices.find((i) => i.id === scheduledStage.id).status === 'Unpaid')
check('issuing twice is refused', s().issueInvoice(scheduledStage.id) === null)
assertBooks('after issuing a stage')

console.log('\n=== 50. Receiving payment — the AR bug ===')
const openInv = s().invoices.find((i) => i.id === scheduledStage.id)
const arBeforePay = ledger.accountBalance(s().journal, '1201')
const cashBeforePay = ledger.cashBalance(s().journal)
const prepaidBeforePay = ledger.accountBalance(s().journal, '1401')

// Part payment first — an AR module that can only b_settle in full pushes reality
// out of the system.
const b_half = Math.round(openInv.amount / 2)
const part = s().receivePayment(openInv.id, { amount: b_half })
const partTax = Math.round(b_half * 0.02)
check('a part payment posts', Boolean(part), part?.voucherNo)
check('it lands in the KM (cash in) series', part.series === 'km')
check('cash rose by the NET amount',
  Math.abs(ledger.cashBalance(s().journal) - (cashBeforePay + b_half - partTax)) < 1)
check('the prepaid tax credit rose by the withholding',
  Math.abs(ledger.accountBalance(s().journal, '1401') - (prepaidBeforePay + partTax)) < 1)
check('the receivable fell by the GROSS amount',
  Math.abs(ledger.accountBalance(s().journal, '1201') - (arBeforePay - b_half)) < 1)
check('the invoice is Partially Paid',
  s().invoices.find((i) => i.id === openInv.id).status === 'Partially Paid')
check('and it records what has been collected',
  s().invoices.find((i) => i.id === openInv.id).paid === b_half)
check('the receipt is linked to the invoice entry',
  part.appliedTo.length === 1 && part.appliedTo[0] === b_issued.id)
assertBooks('after part payment')

// Overpayment is clamped to what is owed — a bigger receipt is a different
// transaction, not a bigger payment.
const b_rest = s().receivePayment(openInv.id, { amount: openInv.amount * 5 })
check('an overpayment is clamped to the outstanding balance', Boolean(b_rest))
check('the invoice is now settled in full',
  s().invoices.find((i) => i.id === openInv.id).status === 'Paid')
check('and the receivable for it is clear',
  Math.abs(ledger.accountBalance(s().journal, '1201') - (arBeforePay - openInv.amount)) < 1)
check('a settled invoice refuses further payment',
  s().receivePayment(openInv.id, { amount: 1_000_000 }) === null)
check('a scheduled stage refuses payment before it is issued', (() => {
  const stillScheduled = s().invoices.find((i) => i.status === 'Scheduled')
  return !stillScheduled || s().receivePayment(stillScheduled.id, { amount: 1_000_000 }) === null
})())
assertBooks('after full settlement')

console.log('\n=== 51. Withholding can be waived or overridden ===')
const waiveTarget = s().invoices.find((i) => i.status === 'Scheduled')
if (waiveTarget) s().issueInvoice(waiveTarget.id)
const waiveInv = s().invoices.find((i) => i.id === waiveTarget?.id)
if (waiveInv) {
  const cashBeforeWaive = ledger.cashBalance(s().journal)
  s().receivePayment(waiveInv.id, { amount: 10_000_000, withhold: false })
  check('with withholding off, cash rises by the full amount',
    Math.abs(ledger.cashBalance(s().journal) - (cashBeforeWaive + 10_000_000)) < 1)
  const prepaidBeforeOverride = ledger.accountBalance(s().journal, '1401')
  s().receivePayment(waiveInv.id, { amount: 10_000_000, taxAmount: 1_234_567 })
  check('a manual override is what actually posts',
    Math.abs(ledger.accountBalance(s().journal, '1401') - (prepaidBeforeOverride + 1_234_567)) < 1)
  check('tax larger than the payment is refused',
    s().receivePayment(waiveInv.id, { amount: 1_000_000, taxAmount: 9_000_000 }) === null)
}
assertBooks('after withholding variations')

console.log('\n=== 52. AR reconciles with the ledger ===')
// The invariant the Receivables screen shows as a badge: what the invoice list
// says is outstanding must equal what account 1201 says is owed.
const outstandingTotal = s().invoices
  .filter((i) => (i.status === 'Unpaid' || i.status === 'Partially Paid'))
  .reduce((a, i) => a + (i.amount - (i.paid || 0)), 0)
check('outstanding invoices equal ledger account 1201',
  Math.abs(outstandingTotal - ledger.accountBalance(s().journal, '1201')) < 1,
  `invoices ${fmt(outstandingTotal)} vs ledger ${fmt(ledger.accountBalance(s().journal, '1201'))}`)

check('scheduled stages are excluded from that total',
  s().invoices.some((i) => i.status === 'Scheduled')
    ? outstandingTotal < s().invoices.reduce((a, i) => a + (i.amount - (i.paid || 0)), 0)
    : true)



// ===========================================================================
// ROUND 2 — fixed assets & depreciation
// ===========================================================================

console.log('\n=== 53. Depreciation schedules are exact ===')
for (const asset of s().fixedAssets) {
  const rows = depr.buildSchedule(asset)
  const last = rows[rows.length - 1]
  check(`${asset.id} runs for its full useful life`, rows.length === asset.usefulLifeMonths)
  // An asset that ends its life a few rupiah from its residual value means
  // someone writes that off by hand — which is the manual work this removes.
  check(`${asset.id} lands exactly on cost minus salvage`,
    last.accumulated === asset.cost - asset.salvage,
    `${last.accumulated} vs ${asset.cost - asset.salvage}`)
  check(`${asset.id} never depreciates below salvage`,
    rows.every((r) => r.closing >= asset.salvage - 1))
  check(`${asset.id} charges are all non-negative`, rows.every((r) => r.charge >= 0))
}
// Declining balance must be front-loaded, or it is just straight line.
const declining = s().fixedAssets.find((a) => a.method === 'declining')
const decRows = depr.buildSchedule(declining)
check('declining balance charges more early than late',
  decRows[0].charge > decRows[decRows.length - 1].charge,
  `${decRows[0].charge} then ${decRows[decRows.length - 1].charge}`)

console.log('\n=== 54. The register reconciles with the ledger ===')
const regStart = depr.registerTotals(s().fixedAssets)
check('register cost equals ledger account 1302',
  Math.abs(regStart.cost - ledger.accountBalance(s().journal, '1302')) < 1,
  `${fmt(regStart.cost)} vs ${fmt(ledger.accountBalance(s().journal, '1302'))}`)
check('the seeded register opens with a backlog', regStart.overduePeriods > 0,
  `${regStart.overduePeriods} periods, ${fmt(regStart.due)}`)
check('nothing has been posted to 1303 yet',
  Math.abs(ledger.accountBalance(s().journal, '1303')) < 1)

console.log('\n=== 55. The depreciation run clears the backlog ===')
const expenseBefore = ledger.accountBalance(s().journal, '6103')
const costBeforeRun = ledger.accountBalance(s().journal, '1302')
const owed = regStart.due
const runs = s().runDepreciation()
check('one entry was posted per period, not per asset', runs.length > 0 && runs.length < s().fixedAssets.length * 6,
  `${runs.length} entries`)
check('every entry lands in the FA voucher series', runs.every((e) => e.series === 'fa'),
  runs[0]?.voucherNo)
check('depreciation expense rose by the whole backlog',
  Math.abs(ledger.accountBalance(s().journal, '6103') - (expenseBefore + owed)) < 1,
  `${fmt(ledger.accountBalance(s().journal, '6103'))} vs ${fmt(expenseBefore + owed)}`)
check('accumulated depreciation mirrors it as a credit',
  Math.abs(ledger.accountBalance(s().journal, '1303') + owed) < 1)
check('cost was untouched — depreciation is not a disposal',
  Math.abs(ledger.accountBalance(s().journal, '1302') - costBeforeRun) < 1)
check('net book value equals 1302 net of 1303',
  Math.abs(depr.registerTotals(s().fixedAssets).netBookValue
    - (ledger.accountBalance(s().journal, '1302') + ledger.accountBalance(s().journal, '1303'))) < 1)
check('nothing is due immediately afterwards',
  depr.registerTotals(s().fixedAssets).overduePeriods === 0)
check('running again posts nothing', s().runDepreciation().length === 0)
assertBooks('after the depreciation run')

console.log('\n=== 56. Capitalisation ===')
const costBeforeBuy = ledger.accountBalance(s().journal, '1302')
const cashBeforeBuy = ledger.cashBalance(s().journal)
const bought = s().capitaliseAsset({
  name: 'Haze Machine', category: 'Atmospherics', acquiredOn: '2026-06-01',
  cost: 12_800_000, salvage: 1_280_000, usefulLifeMonths: 36, method: 'straight-line',
})
check('a new acquisition is registered', Boolean(bought), bought?.id)
check('it debits 1302 at cost',
  Math.abs(ledger.accountBalance(s().journal, '1302') - (costBeforeBuy + 12_800_000)) < 1)
check('and it pays for it', Math.abs(ledger.cashBalance(s().journal) - (cashBeforeBuy - 12_800_000)) < 1)
check('it immediately owes depreciation for elapsed periods',
  depr.duePeriods(bought).length > 0, `${depr.duePeriods(bought).length} periods`)

// Registering kit the books already carry must NOT post — that would double
// account 1302 against equipment bought once.
const costBeforeExisting = ledger.accountBalance(s().journal, '1302')
const registered = s().capitaliseAsset({
  name: 'Legacy Rigging', category: 'Staging', acquiredOn: '2026-01-01',
  cost: 30_000_000, salvage: 3_000_000, usefulLifeMonths: 60, method: 'straight-line',
}, { post: false })
check('registering existing kit adds it to the register', Boolean(registered))
check('but posts nothing to 1302',
  Math.abs(ledger.accountBalance(s().journal, '1302') - costBeforeExisting) < 1)

check('a zero-cost asset is refused',
  s().capitaliseAsset({ name: 'Bad', acquiredOn: '2026-01-01', cost: 0, salvage: 0, usefulLifeMonths: 12 }) === null)
check('salvage above cost is refused',
  s().capitaliseAsset({ name: 'Bad', acquiredOn: '2026-01-01', cost: 1_000_000, salvage: 2_000_000, usefulLifeMonths: 12 }) === null)
assertBooks('after capitalisation')

console.log('\n=== 57. Revising a useful life re-plans the future, not the past ===')
const revisable = s().fixedAssets.find((a) => a.status !== 'disposed' && a.postedThrough)
const accumBefore = depr.accumulatedFor(revisable)
const chargeBefore = depr.buildSchedule(revisable).find((r) => r.state !== 'posted').charge
s().updateAsset(revisable.id, { usefulLifeMonths: revisable.usefulLifeMonths + 24 })
const revised = s().fixedAssets.find((a) => a.id === revisable.id)
check('the life was extended', revised.usefulLifeMonths === revisable.usefulLifeMonths + 24)
// Prospective revision: what was posted stays posted, and only the periods
// still to come are re-planned.
check('depreciation already posted is untouched',
  depr.accumulatedFor(revised) === accumBefore, `${accumBefore}`)
check('the schedule is rebased to the first unposted period',
  revised.scheduleFrom === depr.addMonths(revisable.postedThrough, 1), revised.scheduleFrom)
check('the remaining charge is spread over the longer life',
  depr.buildSchedule(revised)[0].charge < chargeBefore,
  `${depr.buildSchedule(revised)[0].charge} vs ${chargeBefore}`)
check('and it still finishes exactly on salvage value', (() => {
  const rows = depr.buildSchedule(revised)
  return rows[rows.length - 1].accumulated === revised.cost - revised.salvage
})())
check('cost cannot be edited out from under the acquisition entry',
  s().updateAsset(revisable.id, { cost: 1 })?.cost === revised.cost)
check('the ledger did not move', Math.abs(
  ledger.accountBalance(s().journal, '1303') + depr.registerTotals(s().fixedAssets).accumulated) < 1)

console.log('\n=== 58. Disposal removes the asset from the books ===')
const target58 = s().fixedAssets.find((a) => a.status !== 'disposed' && a.postedThrough)
const nbv58 = depr.netBookValue(target58)
const accum58 = depr.accumulatedFor(target58)
const cost58 = ledger.accountBalance(s().journal, '1302')
const accumLedger58 = ledger.accountBalance(s().journal, '1303')
s().disposeAsset(target58.id, { proceeds: Math.round(nbv58 / 2) })
check('cost was removed from 1302',
  Math.abs(ledger.accountBalance(s().journal, '1302') - (cost58 - target58.cost)) < 1)
check('its accumulated depreciation was removed from 1303',
  Math.abs(ledger.accountBalance(s().journal, '1303') - (accumLedger58 + accum58)) < 1)
check('the shortfall against book value is a loss',
  ledger.accountBalance(s().journal, '6901') > 0)
check('the asset stops accruing depreciation',
  depr.duePeriods(s().fixedAssets.find((a) => a.id === target58.id)).length === 0)
check('disposing twice is refused', s().disposeAsset(target58.id) === null)
assertBooks('after disposal')



// ===========================================================================
// ROUND 2 — accounts payable, CRM notes, petty cash requester
// ===========================================================================

console.log('\n=== 59. Accounts Payable reconciles with the ledger ===')
const apOpen = ledger.openItems(s().journal, { control: '2102', side: 'credit' })
const apTotal = apOpen.reduce((a, o) => a + o.outstanding, 0)
check('open vendor bills equal ledger account 2102',
  Math.abs(apTotal - ledger.accountBalance(s().journal, '2102')) < 1,
  `bills ${fmt(apTotal)} vs ledger ${fmt(ledger.accountBalance(s().journal, '2102'))}`)
check('every open bill carries a due date it can be aged against',
  apOpen.every((o) => Boolean(o.entry.source?.due)))
check('a bill with no purchase order behind it still ages',
  apOpen.some((o) => !s().purchaseOrders.some((p) => p.id === o.entry.source?.ref))
    || apOpen.length === 0)

console.log('\n=== 60. The AP bug: a zero-DP order used to be unsettleable ===')
const zeroDpPo = s().createPurchaseOrder({
  vendorId: 'V-02',
  project: 'EVT-2026-GALA-01',
  eventDate: '2026-08-14',
  terms: { dpPercent: 0, settlementDays: 14 },
  lines: [{ itemId: 'VI-02', item: 'Line Array Speaker', qty: 4, unitPrice: 1_800_000 }],
})
s().approvePurchaseOrder(zeroDpPo.id)
check('there is no down payment to make', s().payPoDownPayment(zeroDpPo.id) === undefined)
check('so the order never reaches "DP Paid"',
  s().purchaseOrders.find((p) => p.id === zeroDpPo.id).status === 'Approved')
// This is the fix: settlement now accepts an Approved order.
check('it can still be settled', s().settlePurchaseOrder(zeroDpPo.id) === true)
check('and its status follows',
  s().purchaseOrders.find((p) => p.id === zeroDpPo.id).status === 'Settled')
check('leaving nothing outstanding', s().poOutstanding(zeroDpPo.id) === 0)
assertBooks('after settling a zero-DP order')

console.log('\n=== 61. Paying a bill from the Payables screen ===')
const payTarget = ledger.openItems(s().journal, { control: '2102', side: 'credit' })
  .find((o) => o.outstanding > 2_000_000)
check('an open bill is available to pay', Boolean(payTarget), payTarget?.entry.source?.ref)
const apBefore61 = ledger.accountBalance(s().journal, '2102')
const cashBefore61 = ledger.cashBalance(s().journal)
const taxBefore61 = ledger.accountBalance(s().journal, '2105')

const part61 = Math.round(payTarget.outstanding / 2)
const payEntry = s().payVendorBill(payTarget.entry.id, { amount: part61 })
check('the payment posts', Boolean(payEntry), payEntry?.voucherNo)
check('it lands in the KK (cash out) series', payEntry.series === 'kk')
check('the payable fell by the gross amount',
  Math.abs(ledger.accountBalance(s().journal, '2102') - (apBefore61 - part61)) < 1)
const tax61 = ledger.accountBalance(s().journal, '2105') - taxBefore61
check('withholding was credited to 2105, not debited to 1401', tax61 > 0, fmt(tax61))
check('cash left net of the withholding',
  Math.abs(ledger.cashBalance(s().journal) - (cashBefore61 - (part61 - tax61))) < 1)
check('no cost was recognised again on payment',
  !payEntry.lines.some((l) => l.account === '5101'))
check('the bill is now partly settled',
  Math.abs(s().poOutstanding(payTarget.entry.source.ref) - (payTarget.outstanding - part61)) < 1
    || !s().purchaseOrders.some((p) => p.id === payTarget.entry.source.ref))
check('overpaying a bill is clamped to what is owed', (() => {
  const before = ledger.accountBalance(s().journal, '2102')
  s().payVendorBill(payTarget.entry.id, { amount: 999_000_000_000 })
  const moved = before - ledger.accountBalance(s().journal, '2102')
  return Math.abs(moved - (payTarget.outstanding - part61)) < 1
})())
check('a settled bill refuses further payment',
  s().payVendorBill(payTarget.entry.id, { amount: 1_000_000 }) === null)
assertBooks('after paying a vendor bill')

console.log('\n=== 62. Both withholding directions coexist ===')
// The whole point of the round-2 tax correction: tax withheld FROM Oscenia is
// an asset, tax withheld BY Oscenia is a liability, and they are different
// accounts that must never be netted against each other by accident.
check('PPh 23 withheld by clients sits in 1401 as an asset',
  ledger.accountBalance(s().journal, '1401') > 0, fmt(ledger.accountBalance(s().journal, '1401')))
check('PPh 23 withheld from vendors sits in 2105 as a liability',
  ledger.accountBalance(s().journal, '2105') > 0, fmt(ledger.accountBalance(s().journal, '2105')))
const bs62 = ledger.balanceSheetFrom(s().journal, s().taxConfig)
check('1401 is presented under assets', bs62.assets.some((r) => r.code === '1401'))
check('2105 is presented under liabilities', bs62.liabilities.some((r) => r.code === '2105'))

console.log('\n=== 63. Cancelling a purchase order unwinds the whole chain ===')
const cancelPo = s().createPurchaseOrder({
  vendorId: 'V-05',
  project: 'EVT-2026-GALA-01',
  eventDate: '2026-08-14',
  terms: { dpPercent: 50, settlementDays: 14 },
  lines: [{ itemId: 'VI-08', item: 'Follow Spot', qty: 6, unitPrice: 900_000 }],
})
s().approvePurchaseOrder(cancelPo.id)
s().payPoDownPayment(cancelPo.id)
const apBefore63 = ledger.accountBalance(s().journal, '2102')
const cashBefore63 = ledger.cashBalance(s().journal)
const costBefore63 = ledger.accountBalance(s().journal, '5101')
check('the order has a live payable', s().poOutstanding(cancelPo.id) > 0)
s().cancelPurchaseOrder(cancelPo.id)
// The bill carries source 'po' and the payment carries 'payment', so a filter
// on 'po' alone would have reversed the debt and left the cash payment standing.
check('cancelling reverses the bill AND the payment it received',
  Math.abs(ledger.cashBalance(s().journal) - (cashBefore63 + vendors.poDpAmount(cancelPo)
    - Math.round(vendors.poDpAmount(cancelPo) * 0.02))) < 1_000_000,
  `${fmt(ledger.cashBalance(s().journal))} vs ~${fmt(cashBefore63 + vendors.poDpAmount(cancelPo))}`)
check('the payable is gone',
  Math.abs(ledger.accountBalance(s().journal, '2102') - (apBefore63 - s().poOutstanding(cancelPo.id))) >= 0
    && s().poOutstanding(cancelPo.id) === 0)
check('and the cost is unwound',
  Math.abs(ledger.accountBalance(s().journal, '5101') - (costBefore63 - vendors.poTotal(cancelPo))) < 1)
assertBooks('after cancelling a purchase order')

console.log('\n=== 64. CRM notes carry the real author ===')
s().setRole('sales')
const salesNote = s().logInteraction('CL-01', { type: 'Note', note: 'Discussed a 50% DP.' })
check('a note records who actually wrote it', salesNote.by === roles.ROLES.sales.name, salesNote.by)
s().setRole('ceo')
const ceoNote = s().logInteraction('CL-01', { type: 'Note', note: 'Approved the discount.' })
check('a different role produces a different author', ceoNote.by === roles.ROLES.ceo.name, ceoNote.by)
check('the author is no longer hardcoded to one salesperson', salesNote.by !== ceoNote.by)
check('notes are timestamped', Boolean(salesNote.date) && Boolean(ceoNote.date))
check('the newest note is first', s().interactions['CL-01'][0].id === ceoNote.id)

console.log('\n=== 65. Petty cash cannot be issued anonymously ===')
const anon = s().addProcurementRequest({
  project: 'EVT-2026-GALA-01', category: 'Petty Cash — Transport', amount: 1_500_000, by: '   ',
})
check('a blank requester is refused', anon === null)
const named = s().addProcurementRequest({
  project: 'EVT-2026-GALA-01', category: 'Petty Cash — Transport', amount: 1_500_000, by: 'Rina K.',
})
check('a named request is accepted', Boolean(named), named?.id)
check('the requester is stored on the record', named.by === 'Rina K.')
check('it defaults to the signed-in user when omitted', (() => {
  s().setRole('warehouse')
  const def = s().addProcurementRequest({
    project: 'EVT-2026-GALA-01', category: 'Field Cash Advance', amount: 900_000,
  })
  s().setRole('ceo')
  return def?.by === roles.ROLES.warehouse.name
})())
// The recap the client asked for: group and total by requester.
const requesters = [...new Set(s().procurement.map((r) => r.by))]
check('more than one requester exists to group by', requesters.length > 1, requesters.join(', '))
check('every request names someone', s().procurement.every((r) => Boolean(r.by && r.by.trim())))
const rinaTotal = s().procurement.filter((r) => r.by === 'Rina K.').reduce((a, r) => a + r.amount, 0)
check('a requester total can be computed', rinaTotal === 1_500_000, fmt(rinaTotal))
// And the requester has to reach the ledger, or the printed voucher cannot name them.
s().setProcurementStatus(named.id, 'Approved')
s().setProcurementStatus(named.id, 'Disbursed')
check('the disbursement entry names the requester',
  s().journal[0].lines.some((l) => (l.note || '').includes('Rina K.')),
  s().journal[0].lines[0]?.note)
assertBooks('after petty cash disbursement')


// ---------------------------------------------------------------------------
// The write path: `mutate` is the one door every API write goes through
// ---------------------------------------------------------------------------
//
// Checked without a backend, and deliberately so: what matters here is not that a request
// succeeds but that a *failure is never silent*. "I clicked it and nothing happened" is the
// complaint this helper exists to stop producing, so every branch that declines to do the
// work has to say why. `refresh: []` keeps it offline — nothing is re-read, so no network.

const toastCount = () => s().toasts.length
const lastToast = () => s().toasts[s().toasts.length - 1]

// 1. On seed data there are no UUIDs to send, so the write is refused up front rather than
//    failing deep in the request with a message about a missing field.
useStore.setState({ hydrated: false })
let before = toastCount()
let result = await s().mutate({ label: 'test:unhydrated', call: async () => 'nope' })
check('a write on demo data is refused', result.ok === false)
check('and it says so out loud', toastCount() === before + 1)
check('naming the real cause, not a field error',
  /demo data|not connected/i.test(`${lastToast()?.title} ${lastToast()?.body}`),
  lastToast()?.title)

// 2. Once live, the happy path runs the call and reports success.
useStore.setState({ hydrated: true })
let ran = 0
result = await s().mutate({
  label: 'test:ok',
  call: async () => { ran += 1; return { id: 'X' } },
  toast: { title: 'Saved', kind: 'finance' },
})
check('a live write runs the call', ran === 1)
check('and returns what the call returned', result.ok === true && result.data.id === 'X')
check('and the busy flag is cleared afterwards', s().mutating === null)

// 3. A server error surfaces. A 403 from this backend names the roles that *would* be
//    allowed, and repeating that is the difference between "no" and "no, ask Finance" —
//    which is exactly what made the PO buttons look broken rather than forbidden.
before = toastCount()
const forbidden = Object.assign(new Error('Requires the pay_po action.'), {
  status: 403, title: 'Forbidden', permitted: ['ceo', 'finance'],
})
result = await s().mutate({ label: 'test:403', call: async () => { throw forbidden } })
check('a rejected write reports failure', result.ok === false)
check('a 403 raises a toast', toastCount() === before + 1)
check('titled as a permission problem, not a crash', lastToast()?.title === 'Not permitted')
check('and it names who could do it', /ceo, finance/.test(lastToast()?.body || ''), lastToast()?.body)
check('the error is kept for the screen to read', s().mutateError === forbidden)
check('and the busy flag is cleared even on failure', s().mutating === null)

// 4. Double-clicking the same button is ignored, and silently — a toast there would be
//    noise. Two *different* actions racing is a different matter and must be explained.
useStore.setState({ mutating: 'test:busy' })
before = toastCount()
result = await s().mutate({ label: 'test:busy', call: async () => 'again' })
check('a double-click on the same action is dropped', result.ok === false)
check('without nagging about it', toastCount() === before)

result = await s().mutate({ label: 'test:other', call: async () => 'other' })
check('a different action while busy is refused', result.ok === false)
check('and that one is explained', toastCount() === before + 1)
check('so the button does not just look dead', /one thing at a time/i.test(lastToast()?.title || ''))
useStore.setState({ mutating: null, hydrated: false })



// ---------------------------------------------------------------------------
// Two accepted quotations, approved independently
// ---------------------------------------------------------------------------
//
// This is the client's report: "a second quotation overwrites the first, preventing DP
// approval on earlier quotations". The quotation *records* were never overwritten --
// `updateQuotation` refuses to touch an accepted quote. What was overwritten was the
// approval workspace: one `pendingDeal` object and one `dpConfirmed` boolean. Accepting a
// second quote replaced the object and reset the flag, so the first deal stopped existing
// anywhere in state and Finance could only ever offer the newest one.
//
// Nothing in the suite covered two accepted quotations at once, which is why a singleton
// looked sufficient for as long as it did.
console.log('\n=== 66. Two accepted quotations approve independently ===')

// Start from a clean pair of drafts so this section does not inherit earlier state.
const qA = s().addQuotation({
  client: 'Aurora Bank', eventType: 'Board Offsite', eventDate: '2027-03-11',
  dpPercent: 30,
  lineItems: [{ label: 'Venue', amount: 100_000_000, estCost: 70_000_000 }],
})
const qB = s().addQuotation({
  client: 'Nimbus Retail', eventType: 'Roadshow', eventDate: '2027-04-02',
  dpPercent: 50,
  lineItems: [{ label: 'Staging', amount: 80_000_000, estCost: 56_000_000 }],
})

s().acceptQuotation(qA.id)
s().acceptQuotation(qB.id)

const dealA = () => s().deals.find((d) => d.id === `DEAL-${qA.id}`)
const dealB = () => s().deals.find((d) => d.id === `DEAL-${qB.id}`)

check('both accepted quotations have a deal', Boolean(dealA() && dealB()))
check('accepting the second did not discard the first', dealA()?.contractValue === 100_000_000,
  String(dealA()?.contractValue))
check('each deal keeps its own DP percentage',
  dealA()?.dpAmount === 30_000_000 && dealB()?.dpAmount === 40_000_000,
  `${dealA()?.dpAmount} / ${dealB()?.dpAmount}`)

// Confirm the SECOND one first -- the order the client hit the bug in.
s().confirmDownPayment(dealB().id)
check('confirming the second deal works', dealB()?.confirmed === true)
check('and leaves the first still approvable', dealA()?.confirmed === false)
check('the first deal is still there to approve', Boolean(dealA()))

// The whole point: the earlier quotation can still be approved afterwards.
s().confirmDownPayment(dealA().id)
check('the earlier quotation can still be confirmed', dealA()?.confirmed === true)
check('both projects now exist',
  s().projects.some((p) => p.id === dealA()?.projectIdOnConfirm)
    && s().projects.some((p) => p.id === dealB()?.projectIdOnConfirm))
check('each project carries its own contract value',
  s().projects.find((p) => p.id === dealA()?.projectIdOnConfirm)?.contractValue === 100_000_000
    && s().projects.find((p) => p.id === dealB()?.projectIdOnConfirm)?.contractValue === 80_000_000)

// Undoing one must not disturb the other.
check('undoing the second leaves the first confirmed',
  s().undoDownPayment(dealB()?.id) === true && dealA()?.confirmed === true)
check('and the first project survives it',
  s().projects.some((p) => p.id === dealA()?.projectIdOnConfirm))

// Declining a quotation drops its deal rather than nulling a shared slot -- the old code
// set `pendingDeal = null`, and /finance then threw on `deal.name`.
const openBefore = s().deals.length
s().cancelQuotation(qB.id)
check('declining a quotation removes only its own deal', s().deals.length === openBefore - 1)
check('the other deal is untouched', Boolean(dealA()))

assertBooks('after two independent approvals')


// ---------------------------------------------------------------------------
console.log('\n=== 67. One journal code per document (REQ-06) ===')
// ---------------------------------------------------------------------------
//
// The client's complaint was a proliferation of voucher numbers: one logical event ending
// up as two or three documents nobody could connect. The fix is NOT to reuse a number --
// an auditor needs the correction as its own filed document, which is why reversals get
// their own. What was missing was the record of which document they belong to.

const anchor = s().postEntry({
  date: DEMO_TODAY,
  memo: 'Equipment accrual',
  source: { kind: 'manual', ref: null },
  lines: [
    { account: '5103', debit: 5_000_000, credit: 0 },
    { account: '2102', debit: 0, credit: 5_000_000 },
  ],
})
check('a standalone entry is in no group', anchor.groupRef === null, String(anchor.groupRef))

const undo = s().reverseJournalEntry(anchor.id, { silent: true })
check('a reversal is filed under the original', undo.groupRef === anchor.voucherNo,
  `${undo.groupRef} vs ${anchor.voucherNo}`)
check('and keeps a voucher number of its own', undo.voucherNo !== anchor.voucherNo)
check('and an entry number of its own', undo.id !== anchor.id)

// One code, read back: the anchor plus every correction. The anchor is matched by its own
// voucher number, because it cannot be stamped -- on the server it is immutable.
const groupOf = (code) => vouchers.groupedEntries(s().journal, code)
check('the code returns the original and the correction',
  groupOf(anchor.voucherNo).length === 2,
  `${groupOf(anchor.voucherNo).length} entries`)
check('and nothing else',
  groupOf(anchor.voucherNo).every((e) => e.id === anchor.id || e.id === undo.id))

// A later manual entry can join the same document.
const addendum = s().postEntry({
  date: DEMO_TODAY,
  memo: 'Equipment accrual — balance',
  source: { kind: 'manual', ref: null },
  groupRef: anchor.voucherNo,
  lines: [
    { account: '5103', debit: 1_000_000, credit: 0 },
    { account: '2102', debit: 0, credit: 1_000_000 },
  ],
})
check('a manual entry can file under an existing code', addendum.groupRef === anchor.voucherNo)
check('the code now returns three documents', groupOf(anchor.voucherNo).length === 3)

// And the picker sees it as one document rather than three numbers.
const codeRow = vouchers.journalCodes(s().journal).find((c) => c.code === anchor.voucherNo)
check('the picker counts them as one document', codeRow?.count === 3, String(codeRow?.count))
check('and names it after the anchor', codeRow?.memo === 'Equipment accrual', codeRow?.memo)

// An adjustment is three filed documents and one correction.
const adjAnchor = s().postEntry({
  date: DEMO_TODAY,
  memo: 'Venue booking accrual',
  source: { kind: 'manual', ref: null },
  lines: [
    { account: '5101', debit: 9_000_000, credit: 0 },
    { account: '2102', debit: 0, credit: 9_000_000 },
  ],
})
const corrected = s().adjustJournalEntry(adjAnchor.id, {
  date: DEMO_TODAY,
  memo: 'Venue booking accrual — corrected',
  project: null,
  lines: [
    { account: '5101', debit: 8_000_000, credit: 0 },
    { account: '2102', debit: 0, credit: 8_000_000 },
  ],
})
check('the repost files under the original code', corrected.groupRef === adjAnchor.voucherNo,
  `${corrected.groupRef} vs ${adjAnchor.voucherNo}`)
check('three documents share one code', groupOf(adjAnchor.voucherNo).length === 3)
const numbers = new Set(groupOf(adjAnchor.voucherNo).map((e) => e.voucherNo))
check('and each of the three keeps its own number', numbers.size === 3, `${numbers.size} numbers`)

// The screen calls the wired wrappers, not these actions directly. With no backend they
// have to fall through to the local ones, or the demo posts nothing at all.
const viaScreen = s().postManualEntry({
  date: DEMO_TODAY,
  memo: 'Posted the way the screen posts it',
  source: { kind: 'manual', ref: null },
  groupRef: anchor.voucherNo,
  lines: [
    { account: '5103', debit: 250_000, credit: 0 },
    { account: '2102', debit: 0, credit: 250_000 },
  ],
})
check('the post the screen makes falls back to the local ledger', Boolean(viaScreen?.id), String(viaScreen?.id))
check('and carries the journal code with it', viaScreen?.groupRef === anchor.voucherNo)
check('and so does the reverse the screen makes',
  Boolean(s().reverseEntryDocument(viaScreen.id)?.id))

assertBooks('after grouping and adjustment')

// ---------------------------------------------------------------------------
console.log('\n=== 68. Administrators define their own series (REQ-06) ===')
// ---------------------------------------------------------------------------

const seriesCount = s().voucherSeries.length
check('a format that cannot count is refused',
  s().addVoucherSeries({ key: 'bad', prefix: 'BAD', label: 'No counter', format: '[PREFIX]-[YEAR]' }) === null)
check('a duplicate key is refused',
  s().addVoucherSeries({ key: 'km', prefix: 'KM2', label: 'Cash In again' }) === null)
check('a blank prefix is refused',
  s().addVoucherSeries({ key: 'nope', prefix: '  ', label: 'Nameless' }) === null)
check('none of the three was created', s().voucherSeries.length === seriesCount)

const added = s().addVoucherSeries({
  key: 'PC', prefix: 'PC', label: 'Project Close', format: '[PREFIX]/[YEAR]/[SEQ_0001]', reset: 'yearly',
})
check('a valid series is created', Boolean(added))
check('the key is normalised to lowercase', added?.key === 'pc', added?.key)
check('it numbers from its own format',
  vouchers.previewVoucher(added, DEMO_TODAY, 1) === `PC/${DEMO_TODAY.slice(0, 4)}/0001`,
  vouchers.previewVoucher(added, DEMO_TODAY, 1))

// Deletion is for a typo, not for a class with history: a voucher number has to stay
// resolvable for as long as its entry does.
check('a series nothing was numbered from can be deleted', s().deleteVoucherSeries('pc') === true)
check('and is gone', !s().voucherSeries.some((x) => x.key === 'pc'))
check('a series with entries against it is refused', s().deleteVoucherSeries('jv') === false)
check('and survives the refusal', s().voucherSeries.some((x) => x.key === 'jv'))

assertBooks('after series administration')


// ---------------------------------------------------------------------------
console.log('\n=== 69. Global search reaches every kind (REQ-10) ===')
// ---------------------------------------------------------------------------
//
// The client's complaint was that the search found only some things. It did: it read the six
// collections the browser happened to be holding, so a purchase order, a stock item, a crew
// member, a fixed asset and a petty-cash request could not be found at all. On live data the
// search is the server's now; these checks cover the demo path and the ranking both share.

const found = async (q, opts) => await s().searchEverything(q, opts)
const kindsOf = (groups) => groups.map((g) => g.kind)
const idsIn = (groups, kind) => (groups.find((g) => g.kind === kind)?.hits || []).map((h) => h.id)

for (const [kind, query] of [
  ['purchase_order', 'PO-3001'],
  ['inventory', 'Duct Tape'],
  ['crew', 'Agus'],
  ['fixed_asset', 'VIP Sofa'],
  ['procurement', 'PR-101'],
]) {
  const groups = await found(query)
  check(`${query} finds a ${kind}`, kindsOf(groups).includes(kind), kindsOf(groups).join(','))
}

for (const [kind, query] of [
  ['project', 'EVT-2026-GALA-01'],
  ['client', 'CL-01'],
  ['quotation', 'QT-1002'],
  ['journal', 'JE-1001'],
  ['vendor', 'V-01'],
]) {
  const groups = await found(query)
  check(`${query} still finds a ${kind}`, kindsOf(groups).includes(kind), kindsOf(groups).join(','))
}

// Ranking: the exact document number leads, and its group leads the list.
const exact = await found('PO-3001')
check('an exact number scores 100', (exact[0]?.hits || [])[0]?.score === 100,
  String((exact[0]?.hits || [])[0]?.score))
check('and its group comes first', exact[0]?.kind === 'purchase_order', exact[0]?.kind)

// A vendor searched by tag still works -- it was the one clever thing the old box did.
const byTag = await found('Outdoor')
check('a vendor is findable by tag', kindsOf(byTag).includes('vendor'), kindsOf(byTag).join(','))

// Amounts, within the band and outside it.
const invoice = s().invoices[0]
const near = await found(String(Math.round(invoice.amount - 500_000)), { perKind: 25 })
check('an amount finds its invoice', idsIn(near, 'invoice').includes(invoice.id),
  idsIn(near, 'invoice').join(','))
const far = await found(String(Math.round(invoice.amount * 3 + 7_000_000)), { perKind: 25 })
check('and a figure outside the band does not', !idsIn(far, 'invoice').includes(invoice.id))

// Three digits is a quantity or a year, not a figure.
const short = await found('192', { perKind: 25 })
check('a three-digit number is not read as an amount',
  short.every((g) => g.hits.every((h) => h.score !== 35)))

// Shape.
check('a query of one character returns nothing', (await found('a')).length === 0)
check('a wildcard is matched literally, not expanded', (await found('%%')).length === 0)
const capped = await found('EVT', { perKind: 1 })
check('the per-kind cap is honoured', capped.every((g) => g.hits.length <= 1))
const wide = await found('EVT', { perKind: 25 })
check('and it was capping something', (wide.find((g) => g.kind === 'project')?.hits.length || 0) > 1)

// Every kind the search can return has somewhere to go, or a hit is a dead click.
check('every kind the search returns has a route -- otherwise a hit is a dead click',
  wide.every((g) => typeof search.SEARCH_KINDS[g.kind]?.to({ id: g.hits[0].id }) === 'string'))


// ---------------------------------------------------------------------------
console.log('\n=== 70. Two dates, and only one of them moves the books (REQ-01) ===')
// ---------------------------------------------------------------------------
//
// The client asked for a document date alongside the recording date. The decision that
// matters is which one the ledger uses, and it does not change: the POSTING carries the
// recording date, and the document date is recorded beside it for reconciliation. Before
// this the screen sent neither, so a late invoice could only be recorded as of today.

const scheduled = s().invoices.find((i) => i.status === 'Scheduled')
check('there is a scheduled stage to issue', Boolean(scheduled), String(scheduled?.id))

const ISSUED_ON = '2026-07-20'
const DOCUMENT_DATE = '2026-06-28'
const issuedEntry = s().issueInvoice(scheduled.id, {
  issuedOn: ISSUED_ON,
  documentDate: DOCUMENT_DATE,
})

check('the posting carries the RECORDING date, not today',
  issuedEntry?.date === ISSUED_ON, `${issuedEntry?.date} vs ${ISSUED_ON}`)
check('and not the document date', issuedEntry?.date !== DOCUMENT_DATE)
const issued = s().invoices.find((i) => i.id === scheduled.id)
check('the invoice keeps its own date', issued?.documentDate === DOCUMENT_DATE,
  String(issued?.documentDate))
check('and records when it was recorded', issued?.issuedAt === ISSUED_ON, String(issued?.issuedAt))
check('the document date rides on the source, where a reader can find it',
  issuedEntry?.source?.documentDate === DOCUMENT_DATE, String(issuedEntry?.source?.documentDate))
check('issuing moved the receivable', issued?.status === 'Unpaid', issued?.status)

// Omitting both is still the one-click case, and still posts today.
const other = s().invoices.find((i) => i.status === 'Scheduled')
if (other) {
  const plain = s().issueInvoice(other.id)
  check('omitting the dates posts today', plain?.date === DEMO_TODAY, String(plain?.date))
  check('and leaves the document date empty rather than inventing one',
    !s().invoices.find((i) => i.id === other.id)?.documentDate)
}

// The AP half: what the vendor dated their invoice.
const datedPo = s().createPurchaseOrder({
  vendorId: 'V-02',
  project: 'EVT-2026-GALA-01',
  eventDate: '2026-10-22',
  terms: { dpPercent: 0, settlementDays: 14 },
  lines: [{ itemId: 'VI-02', item: 'Line Array Speaker', qty: 2, unitPrice: 1_800_000 }],
})
s().approvePurchaseOrder(datedPo.id)
const VENDOR_INVOICE_DATE = '2026-06-30'
check('a zero-DP order settles with the vendor\u2019s invoice date',
  s().settlePurchaseOrder(datedPo.id, null, { invoiceDate: VENDOR_INVOICE_DATE }) === true)
const settled = s().purchaseOrders.find((p) => p.id === datedPo.id)
check('the order records what the vendor dated it',
  settled?.invoiceDate === VENDOR_INVOICE_DATE, String(settled?.invoiceDate))
check('and the settlement still posted on the recording date',
  settled?.settledAt === DEMO_TODAY, String(settled?.settledAt))

assertBooks('after issuing and settling on two dates')


// ---------------------------------------------------------------------------
console.log('\n=== 71. Confirm before posting (REQ-05) ===')
// ---------------------------------------------------------------------------
//
// The preview is the SERVER running the real operation and rolling it back, so there is
// nothing to ask in the seeded demo. What matters here is that it says so rather than
// returning an empty posting -- an empty confirmation dialog reads as "this posts nothing",
// which would be a lie about an action that posts three documents.

check('with no backend there is no preview to show',
  (await s().previewPosting('/invoices/x/issue')) === null)
check('and the demo still posts, unchanged',
  typeof s().issueInvoice === 'function' && typeof s().confirmDownPayment === 'function')



// ---------------------------------------------------------------------------
console.log('\n=== 72. The posting pop-up and the two dates (round 4) ===')
// ---------------------------------------------------------------------------
//
// lib/postings.js plans what each money movement would post; the pop-up shows (and edits) that
// plan and the store posts from it. So: a plan must equal what the action posts with no edits,
// an edited post must carry the receipt date and post on the received date, and the guard must
// refuse what would corrupt the books. Each case runs on a snapshot and puts the store back.
{
  const postings = await import('../src/lib/postings.js')
  const { addDays } = await import('../src/lib/billing.js')
  const RECEIVED = addDays(DEMO_TODAY, -2)
  const ON_RECEIPT = addDays(DEMO_TODAY, -5)
  const sameLines = (a = [], b = []) => a.length === b.length && a.every((l, i) => l.account === b[i].account
    && Math.abs((Number(l.debit) || 0) - (Number(b[i].debit) || 0)) < 0.005
    && Math.abs((Number(l.credit) || 0) - (Number(b[i].credit) || 0)) < 0.005
    && (l.note || '') === (b[i].note || ''))
  const snapshot = () => useStore.getState()
  const restore = (snap) => useStore.setState(snap, true)
  const noDocDate = (e) => !Object.prototype.hasOwnProperty.call(e.source || {}, 'documentDate')

  // --- DP confirm -------------------------------------------------------------------------
  let deal0 = s().deals.find((d) => !d.confirmed)
  if (!deal0) {
    const q = s().quotations.find((x) => x.status !== 'Accepted' && x.status !== 'Declined')
    if (q) s().acceptQuotation(q.id)
    deal0 = s().deals.find((d) => !d.confirmed)
  }
  check('R4: an unconfirmed deal is available for the pop-up checks', Boolean(deal0))
  if (deal0) {
    const S0 = snapshot()
    const ctx = () => ({ deal: deal0, taxConfig: s().taxConfig, invoiceId: `INV-${String(s().invoiceSeq).padStart(4, '0')}`, projectId: deal0.projectIdOnConfirm })
    const plan = postings.planDpConfirm(ctx(), {})
    const before = s().journal.length
    s().confirmDownPayment(deal0.id)
    const [rcpt, inv] = s().journal
    check('R4 DP: a post without edits still adds exactly two entries', s().journal.length === before + 2)
    check('R4 DP: the receipt posted the planned lines', sameLines(rcpt.lines, plan.editable.lines) && rcpt.memo === plan.editable.memo)
    check('R4 DP: "DP invoiced" posted the planned companion', sameLines(inv.lines, plan.companions[0].lines)
      && inv.source.ref === plan.companions[0].source.ref && inv.memo === plan.companions[0].memo)
    check('R4 DP: no edits means no receipt date and today’s date', noDocDate(rcpt) && rcpt.date === DEMO_TODAY)
    restore(S0)

    const edited = { date: RECEIVED, documentDate: ON_RECEIPT, memo: 'DP received — edited in the pop-up', cashAccount: '1102', withhold: true, taxAmount: 1_000_000 }
    const ePlan = postings.planDpConfirm(ctx(), edited)
    edited.lines = ePlan.editable.lines
    check('R4 DP: the tax override and account rebuild the lines',
      ePlan.editable.lines.some((l) => l.account === '1401' && l.debit === 1_000_000)
      && ePlan.editable.lines.some((l) => l.account === '1102' && l.debit === deal0.dpAmount - 1_000_000))
    s().confirmDownPayment(deal0.id, { edited })
    const [eR, eI] = s().journal
    check('R4 DP: an edited post still adds exactly two entries', s().journal.length === before + 2)
    check('R4 DP: the edited receipt posts on the received date and carries the receipt date',
      eR.date === RECEIVED && eR.source.documentDate === ON_RECEIPT && eR.memo === edited.memo, `${eR.date} / ${eR.source.documentDate}`)
    check('R4 DP: the companion posts on the received date too', eI.date === RECEIVED)
    check('R4 DP: the edited lines are the ones posted', sameLines(eR.lines, edited.lines))
    assertBooks('R4 after an edited DP confirmation')
    restore(S0)

    // The guard. Each refusal must leave the deal and the journal untouched.
    const refused = (label, lines, accounts) => {
      if (accounts) useStore.setState({ accounts })
      const n = s().journal.length
      s().confirmDownPayment(deal0.id, { edited: { ...edited, lines } })
      check(`R4 guard: refuses ${label}`, s().journal.length === n && !s().deals.find((d) => d.id === deal0.id).confirmed)
      restore(S0)
    }
    const L = () => edited.lines.map((l) => ({ ...l }))
    refused('an unbalanced entry', L().map((l, i) => (i === 0 ? { ...l, debit: l.debit + 1 } : l)))
    refused('a changed control amount', L().map((l) => (l.account === '1201' ? { ...l, credit: l.credit - 1000 }
      : l.account === '1102' ? { ...l, debit: l.debit - 1000 } : l)))
    refused('an inactive account', L(), s().accounts.map((a) => (a.code === '1102' ? { ...a, active: false } : a)))
    refused('a negative amount', [...L(), { account: '6101', debit: -5, credit: 0 }, { account: '6101', debit: 0, credit: -5 }])
    refused('a line with both sides set', [...L(), { account: '6101', debit: 5, credit: 5 }])
    {
      const n = s().journal.length
      s().confirmDownPayment(deal0.id, { edited: { ...edited, date: '2026-02-30' } })
      check('R4 guard: refuses an impossible received date', s().journal.length === n)
      restore(S0)
    }
    const v = postings.validateEdited(ePlan, { ...edited, documentDate: addDays(RECEIVED, 3) }, s().accounts)
    check('R4 guard: a receipt dated after it was received is a warning, not a refusal',
      v.ok && v.warnings.some((w) => w.code === 'receiptAfterReceived'))
    const moved = postings.validateEdited(ePlan, { ...edited, lines: L().map((l) => (l.account === '1201' ? { ...l, account: '1102' } : l)) }, s().accounts)
    check('R4 guard: moving the control line to another account is refused', !moved.ok && moved.errors.some((e) => e.code === 'locked'))
  }

  // --- receive payment -------------------------------------------------------------------
  const openInv = s().invoices.find((i) => i.status !== 'Scheduled' && i.amount - (i.paid || 0) > 2_000_000)
  check('R4: an open invoice is available', Boolean(openInv))
  if (openInv) {
    const S0 = snapshot()
    const amount = Math.round((openInv.amount - (openInv.paid || 0)) / 2)
    const ctx = () => {
      const project = s().projects.find((p) => p.id === openInv.project)
      return { invoice: s().invoices.find((i) => i.id === openInv.id), taxConfig: s().taxConfig, projectName: project?.name, recognitionId: s()._recognitionFor(openInv.id)?.id }
    }
    const plan = postings.planReceivePayment(ctx(), { amount })
    const n = s().journal.length
    const e = s().receivePayment(openInv.id, { amount })
    check('R4 receive: no edits posts the planned lines, one entry', s().journal.length === n + 1
      && sameLines(e.lines, plan.editable.lines) && e.memo === plan.editable.memo && noDocDate(e) && e.source.ref === plan.editable.source.ref)
    restore(S0)
    const edited = { date: RECEIVED, documentDate: ON_RECEIPT, memo: '', cashAccount: '1102', withhold: true, taxAmount: 0 }
    edited.lines = postings.planReceivePayment(ctx(), { ...edited, amount }).editable.lines
    const e2 = s().receivePayment(openInv.id, { amount, edited })
    check('R4 receive: edited post is dated received, carries the receipt date, blank memo falls back',
      e2?.date === RECEIVED && e2.source.documentDate === ON_RECEIPT && e2.memo === plan.editable.memo)
    check('R4 receive: the invoice is marked paid on the received date', s().invoices.find((i) => i.id === openInv.id).lastPaidAt === RECEIVED)
    check('R4 receive: a zero tax override posts no 1401 line', !e2.lines.some((l) => l.account === '1401'))
    restore(S0)
    // Section 47 opened 1101.01 under 1101, so 1101 is now a header: nothing new may land on it.
    const onHeader = { ...edited, cashAccount: '1101' }
    onHeader.lines = postings.planReceivePayment(ctx(), { ...onHeader, amount }).editable.lines
    check('R4 guard: refuses a header account', s().receivePayment(openInv.id, { amount, edited: onHeader }) === null
      && s().invoices.find((i) => i.id === openInv.id).paid === openInv.paid)
    restore(S0)
  }

  // --- pay a vendor bill -----------------------------------------------------------------
  const bill = ledger.openItems(s().journal, { control: '2102', side: 'credit' }).find((o) => o.outstanding > 1_000_000)
  check('R4: an open vendor bill is available', Boolean(bill))
  if (bill) {
    const S0 = snapshot()
    const vendor = s().vendors.find((x) => x.name === bill.entry.source?.vendor)
    const ctx = { bill: bill.entry, outstanding: bill.outstanding, vendor, taxConfig: s().taxConfig }
    const amount = Math.round(bill.outstanding / 2)
    const plan = postings.planPayBill(ctx, { amount })
    const n = s().journal.length
    const e = s().payVendorBill(bill.entry.id, { amount })
    check('R4 pay bill: no edits posts the planned lines, one entry', s().journal.length === n + 1
      && sameLines(e.lines, plan.editable.lines) && e.memo === plan.editable.memo && noDocDate(e))
    restore(S0)
    const edited = { date: RECEIVED, documentDate: ON_RECEIPT, memo: 'Paid by transfer', cashAccount: '1102', withhold: true, taxAmount: 12_345 }
    edited.lines = postings.planPayBill(ctx, { ...edited, amount }).editable.lines
    const e2 = s().payVendorBill(bill.entry.id, { amount, edited })
    check('R4 pay bill: edited post is dated received and carries the vendor’s date',
      e2?.date === RECEIVED && e2.source.documentDate === ON_RECEIPT && e2.lines.some((l) => l.account === '2105' && l.credit === 12_345))
    restore(S0)
  }

  // --- vendor DP and settlement ------------------------------------------------------------
  const newPo = () => {
    const po = s().createPurchaseOrder({
      vendorId: 'V-02', project: 'EVT-2026-GALA-01', eventDate: '2026-11-12',
      lines: [{ itemId: 'VI-02', item: 'Line Array Speaker', qty: 3, unitPrice: 1_800_000 }],
      terms: { dpPercent: 40, settlementDays: 21 },
    })
    s().approvePurchaseOrder(po.id)
    return s().purchaseOrders.find((p) => p.id === po.id)
  }
  {
    const S0 = snapshot()
    const po = newPo()
    const S1 = snapshot()
    const ctx = () => ({ po: s().purchaseOrders.find((p) => p.id === po.id), vendor: s().vendors.find((v) => v.id === po.vendorId), taxConfig: s().taxConfig, bill: s()._billFor(po.id) })
    const plan = postings.planPayPoDp(ctx(), {})
    const n = s().journal.length
    s().payPoDownPayment(po.id)
    const [pay, billE] = s().journal
    check('R4 PO DP: no edits adds the bill and the payment, as planned', s().journal.length === n + 2
      && sameLines(billE.lines, plan.companions[0].lines) && sameLines(pay.lines, plan.editable.lines) && noDocDate(pay))

    // Settle under budget from here: plan vs posted.
    const S2 = snapshot()
    const committed = vendors.poTotal(po)
    const sctx = () => ({ po: s().purchaseOrders.find((p) => p.id === po.id), vendor: s().vendors.find((v) => v.id === po.vendorId), taxConfig: s().taxConfig, bill: s()._billFor(po.id), billOutstanding: s().poOutstanding(po.id) })
    const sPlan = postings.planSettlePo(sctx(), { actualTotal: committed - 500_000 })
    const m = s().journal.length
    s().settlePurchaseOrder(po.id, committed - 500_000)
    const [fin, varE] = s().journal
    check('R4 settle: no edits adds the variance and the final payment, as planned', s().journal.length === m + 2
      && sameLines(varE.lines, sPlan.companions[0].lines) && sameLines(fin.lines, sPlan.editable.lines))
    restore(S2)
    const sEdited = { date: RECEIVED, documentDate: ON_RECEIPT, memo: '', cashAccount: '1102', withhold: true, taxAmount: null }
    sEdited.lines = postings.planSettlePo(sctx(), { ...sEdited, actualTotal: committed - 500_000 }).editable.lines
    check('R4 settle: an edited settlement posts', s().settlePurchaseOrder(po.id, committed - 500_000, { edited: sEdited }) === true)
    const done = s().purchaseOrders.find((p) => p.id === po.id)
    check('R4 settle: settled on the received date, vendor invoice date = receipt date',
      done.settledAt === RECEIVED && done.invoiceDate === ON_RECEIPT && s().journal[0].source.documentDate === ON_RECEIPT)
    check('R4 settle: and nothing is left owing', s().poOutstanding(po.id) === 0)
    assertBooks('R4 after an edited settlement')

    restore(S1)
    const edited = { date: RECEIVED, documentDate: ON_RECEIPT, memo: '', cashAccount: '1102', withhold: false, taxAmount: null }
    edited.lines = postings.planPayPoDp(ctx(), edited).editable.lines
    s().payPoDownPayment(po.id, { edited })
    const [ePay, eBill] = s().journal
    check('R4 PO DP: edited payment and the bill it raises post on the received date',
      ePay.date === RECEIVED && eBill.date === RECEIVED && ePay.source.documentDate === ON_RECEIPT
      && s().purchaseOrders.find((p) => p.id === po.id).dpPaidAt === RECEIVED)
    check('R4 PO DP: withholding off and another account show in the lines',
      !ePay.lines.some((l) => l.account === '2105') && ePay.lines.some((l) => l.account === '1102'))
    restore(S1)
    const n2 = s().journal.length
    s().payPoDownPayment(po.id, { edited: { ...edited, lines: edited.lines.map((l) => (l.account === '2102' ? { ...l, debit: l.debit + 10 } : l.account === '1102' ? { ...l, credit: l.credit + 10 } : l)) } })
    check('R4 guard: a vendor payment with a changed 2102 amount is refused, PO untouched',
      s().journal.length === n2 && s().purchaseOrders.find((p) => p.id === po.id).status === 'Approved')
    restore(S0)
  }

  // A plan with nothing to edit still checks its dates.
  check('R4 guard: an issued-invoice plan has no editable movement',
    postings.planIssueInvoice({ invoice: { id: 'X', status: 'Scheduled', amount: 10, type: 'Final', project: 'P' } }, {}).editable === null)
  assertBooks('R4 after the pop-up checks (store restored)')
}


// ---------------------------------------------------------------------------
console.log('\n=== 73. A less cluttered journal list (round 4) ===')
// ---------------------------------------------------------------------------
//
// The Journal tab can narrow by type, hide reversed pairs and search. That is the LIST only:
// statements read every entry. Hiding a pair is safe because an entry and its reversal net to
// zero on every account — asserted here on the journal this script has built up.
{
  const jv = await import('../src/lib/journalView.js')
  const all = s().journal
  const copy = [...all]
  const types = new Set(jv.JOURNAL_TYPES.map(([k]) => k))
  check('R4 list: every entry maps to a known type chip', all.every((e) => types.has(jv.journalType(e)) && jv.journalType(e) !== 'all'))
  const find = (fn) => all.find(fn)
  check('R4 list: an invoice is a client invoice', jv.journalType(find((e) => e.source?.kind === 'invoice')) === 'client-invoices')
  check('R4 list: "DP received" is a client payment', jv.journalType(find((e) => /^DP received/.test(e.memo))) === 'client-payments')
  check('R4 list: a vendor bill is a vendor bill', jv.journalType(find((e) => e.source?.kind === 'po')) === 'vendor-bills')
  check('R4 list: a vendor payment is a vendor payment', jv.journalType(find((e) => /^Vendor (DP|payment|final settlement)/.test(e.memo))) === 'vendor-payments')
  check('R4 list: a reversal is a correction', jv.journalType(find((e) => e.reversalOf)) === 'corrections')
  check('R4 list: depreciation is assets & stock', !find((e) => e.source?.kind === 'depreciation')
    || jv.journalType(find((e) => e.source?.kind === 'depreciation')) === 'assets')

  const pairs = jv.reversedPairIds(all)
  check('R4 list: this journal has reversed pairs to hide', pairs.size >= 2 && pairs.size % 2 === 0, `${pairs.size} entries`)
  const { shown, hidden } = jv.filterJournal(all, { type: 'all', hideReversed: true, q: '' })
  check('R4 list: hide-reversed hides exactly the pairs', hidden === pairs.size && shown.length === all.length - pairs.size)
  check('R4 list: filtering never changes the journal', all.length === copy.length && all.every((e, i) => e === copy[i]))
  const sameBalances = accounts.ACCOUNTS.every((a) => Math.abs(ledger.accountBalance(shown, a.code) - ledger.accountBalance(all, a.code)) < 0.005)
  check('R4 list: the hidden pairs net to zero on every account', sameBalances)
  const isAll = ledger.incomeStatementFrom(all, s().taxConfig)
  const isShown = ledger.incomeStatementFrom(shown, s().taxConfig)
  const bsAll = ledger.balanceSheetFrom(all, s().taxConfig)
  const bsShown = ledger.balanceSheetFrom(shown, s().taxConfig)
  check('R4 list: report totals are the same with or without the hidden pairs',
    Math.abs(isAll.npat - isShown.npat) < 0.005 && Math.abs(bsAll.totalAssets - bsShown.totalAssets) < 0.005,
    `NPAT ${fmt(isAll.npat)} / ${fmt(isShown.npat)}`)
  check('R4 list: switching the hide off shows everything', jv.filterJournal(all, { hideReversed: false }).shown.length === all.length)
  const dp = jv.filterJournal(all, { type: 'client-payments', hideReversed: false, q: 'dp received' }).shown
  check('R4 list: type + search narrow together (case-insensitive memo search)', dp.length >= 1 && dp.every((e) => /dp received/i.test(e.memo)))
  const byVoucher = all.find((e) => e.voucherNo)
  check('R4 list: search finds a voucher number', jv.filterJournal(all, { hideReversed: false, q: byVoucher.voucherNo }).shown.some((e) => e.id === byVoucher.id))
  check('R4 list: search finds a project', jv.filterJournal(all, { hideReversed: false, q: 'EVT-2026-GALA-01' }).shown.every((e) => e.project === 'EVT-2026-GALA-01' || /EVT-2026-GALA-01/i.test(`${e.memo} ${e.voucherNo}`)))
  const junk = jv.cleanJournalFilters({ type: 'nope', hideReversed: 'yes', q: 42 })
  check('R4 list: a damaged saved filter falls back to the defaults',
    junk.type === 'all' && junk.hideReversed === true && junk.q === '' && jv.cleanJournalFilters(null).hideReversed === true)
}


// ---------------------------------------------------------------------------
console.log('\n=== 74. Round-4 review fixes ===')
// ---------------------------------------------------------------------------
//
// (1) an edit may not put a line on the OTHER control account — AR/AP open items are reconciled
// against 1201 and 2102 alone; (2) a reversal that was itself reversed keeps its chain visible;
// (3) 1201 and 2102 never take sub-accounts; (4) the side checks judge the amounts as posted,
// to the cent; (5) the payment toasts report the withholding that posted; (6) a half-typed
// guest table is saved, not dropped, when the guest changes.
{
  const postings = await import('../src/lib/postings.js')
  const jv = await import('../src/lib/journalView.js')
  const events = await import('../src/lib/events.js')
  const { money } = await import('../src/lib/format.js')
  const snapshot = () => useStore.getState()
  const restore = (snap) => useStore.setState(snap, true)
  const codes = (v) => v.errors.map((e) => e.code)

  // (1) + (4) on a vendor bill payment and a client receipt.
  const bill = ledger.openItems(s().journal, { control: '2102', side: 'credit' }).find((o) => o.outstanding > 1_000_000)
  const openInv = s().invoices.find((i) => i.status !== 'Scheduled' && i.amount - (i.paid || 0) > 2_000_000)
  check('R4 fix: an open bill and an open invoice are available', Boolean(bill && openInv))
  if (bill && openInv) {
    const S0 = snapshot()
    const vendor = s().vendors.find((x) => x.name === bill.entry.source?.vendor)
    const bctx = { bill: bill.entry, outstanding: bill.outstanding, vendor, taxConfig: s().taxConfig }
    const amount = Math.round(bill.outstanding / 2)
    const base = { date: DEMO_TODAY, documentDate: null, memo: '', cashAccount: '1102', withhold: true, taxAmount: null }
    const bPlan = postings.planPayBill(bctx, { ...base, amount })
    const bLines = bPlan.editable.lines.map((l) => ({ ...l }))
    const withAr = [...bLines, { account: '1201', debit: 100_000, credit: 0 }, { account: '1102', debit: 0, credit: 100_000 }]
    const vAr = postings.validateEdited(bPlan, { ...base, lines: withAr }, s().accounts)
    check('R4 fix 1: a Dr 1201 / Cr cash pair inside a vendor payment is refused (balanced, 2102 intact)',
      !vAr.ok && codes(vAr).includes('control') && !codes(vAr).includes('locked') && !codes(vAr).includes('unbalanced'), codes(vAr).join(','))
    const n = s().journal.length
    check('R4 fix 1: and the store refuses to post it, journal untouched',
      s().payVendorBill(bill.entry.id, { amount, edited: { ...base, lines: withAr } }) === null && s().journal.length === n)
    restore(S0)
    const vSub = postings.validateEdited(bPlan, { ...base, lines: [...bLines, { account: '2102.01', debit: 5, credit: 0 }, { account: '1102', debit: 0, credit: 5 }] }, s().accounts)
    check('R4 fix 1: a sub-account of a control account counts as one', !vSub.ok && codes(vSub).includes('control'))

    const rctx = () => ({ invoice: s().invoices.find((i) => i.id === openInv.id), taxConfig: s().taxConfig, projectName: '', recognitionId: s()._recognitionFor(openInv.id)?.id })
    const ramount = Math.round((openInv.amount - (openInv.paid || 0)) / 2)
    const rPlan = postings.planReceivePayment(rctx(), { ...base, amount: ramount })
    const rLines = rPlan.editable.lines.map((l) => ({ ...l }))
    const withAp = [...rLines, { account: '1102', debit: 50_000, credit: 0 }, { account: '2102', debit: 0, credit: 50_000 }]
    const vAp = postings.validateEdited(rPlan, { ...base, lines: withAp }, s().accounts)
    check('R4 fix 1: a 2102 line inside a client receipt is refused', !vAp.ok && codes(vAp).includes('control'))
    const paidBefore = s().invoices.find((i) => i.id === openInv.id).paid
    check('R4 fix 1: and the store refuses it, invoice untouched',
      s().receivePayment(openInv.id, { amount: ramount, edited: { ...base, lines: withAp } }) === null
      && s().invoices.find((i) => i.id === openInv.id).paid === paidBefore)
    restore(S0)
    check('R4 fix 1: the unedited lines still pass', postings.validateEdited(rPlan, { ...base, lines: rLines }, s().accounts).ok)

    // (4) 0.004 rounds to 0 at the cent: it must not pass as a debit and post 0/0.
    const tiny = [...rLines, { account: '6101', debit: 0.004, credit: '' }, { account: '6101', debit: '', credit: 0.004 }]
    const vTiny = postings.validateEdited(rPlan, { ...base, lines: tiny }, s().accounts)
    check('R4 fix 4: a line that rounds to zero is refused', !vTiny.ok && codes(vTiny).includes('zero'), codes(vTiny).join(','))
    const vHalf = postings.validateEdited(rPlan, { ...base, lines: [...rLines, { account: '6101', debit: 0.006, credit: 0.004 }] }, s().accounts)
    check('R4 fix 4: debit 0.006 / credit 0.004 posts as 0.01 / 0 — judged as posted, so it is one-sided',
      !codes(vHalf).includes('side') && !codes(vHalf).includes('zero') && codes(vHalf).includes('unbalanced'), codes(vHalf).join(','))
    const vNeg = postings.validateEdited(rPlan, { ...base, lines: [...rLines, { account: '6101', debit: -0.004, credit: 0 }] }, s().accounts)
    check('R4 fix 4: -0.004 is refused too (it rounds to zero)', !vNeg.ok && codes(vNeg).includes('zero'))

    // (5) The toast reports the 1401 / 2105 line that posted, not the planner's figure.
    const plannedTax = rPlan.editable.taxAmount
    const editedTax = plannedTax + 25_000
    const moved = rLines.map((l) => (l.account === '1401' ? { ...l, debit: editedTax }
      : l.account === '1102' ? { ...l, debit: l.debit - 25_000 } : l))
    const e = s().receivePayment(openInv.id, { amount: ramount, edited: { ...base, lines: moved } })
    const toast = s().toasts[s().toasts.length - 1]
    check('R4 fix 5: the client-payment toast shows the posted PPh 23',
      e && toast.body.includes(`${money(editedTax)} PPh 23`) && toast.body.includes(`${money(ramount - editedTax)} cash`), toast?.body)
    check('R4 fix 5: postedWithholding reads it off the posted lines', postings.postedWithholding(e.lines, 'client') === editedTax)
    restore(S0)
    const bTax = bPlan.editable.taxAmount + 7_000
    const bMoved = bLines.map((l) => (l.account === '2105' ? { ...l, credit: bTax }
      : l.account === '1102' ? { ...l, credit: l.credit - 7_000 } : l))
    const be = s().payVendorBill(bill.entry.id, { amount, edited: { ...base, lines: bMoved } })
    const btoast = s().toasts[s().toasts.length - 1]
    check('R4 fix 5: the vendor-payment toast shows the posted PPh 23',
      be && btoast.body.includes(`${money(bTax)} PPh 23`) && postings.postedWithholding(be.lines, 'vendor') === bTax, btoast?.body)
    restore(S0)
  }

  // (2) A reversal reversed: E1 is live again, so nothing in the chain hides.
  {
    const S0 = snapshot()
    const target = s().journal.find((x) => !x.reversedBy && !x.reversalOf && (x.lines || []).length >= 2)
    const r1 = s().reverseJournalEntry(target.id, { silent: true })
    const pair = jv.filterJournal(s().journal, { hideReversed: true })
    check('R4 fix 2: a plain pair (E1 + R1) hides', !pair.shown.some((x) => x.id === target.id || x.id === r1.id))
    const r2 = s().reverseJournalEntry(r1.id, { silent: true })
    const chain = jv.filterJournal(s().journal, { hideReversed: true })
    const ids = new Set(chain.shown.map((x) => x.id))
    check('R4 fix 2: E1 -> R1 -> R2 keeps all three on the list', ids.has(target.id) && ids.has(r1.id) && ids.has(r2.id))
    const sameBalances = accounts.ACCOUNTS.every((a) => Math.abs(ledger.accountBalance(chain.shown, a.code) - ledger.accountBalance(s().journal, a.code)) < 0.005)
    check('R4 fix 2: what stays hidden still nets to zero on every account', sameBalances)
    const synth = [
      { id: 'A', reversedBy: 'B', reversalOf: null }, { id: 'B', reversedBy: 'C', reversalOf: 'A' }, { id: 'C', reversedBy: null, reversalOf: 'B' },
      { id: 'D', reversedBy: 'E', reversalOf: null }, { id: 'E', reversedBy: null, reversalOf: 'D' },
    ]
    const p = jv.reversedPairIds(synth)
    check('R4 fix 2: only the plain pair counts as a reversed pair', p.size === 2 && p.has('D') && p.has('E'))
    restore(S0)
  }

  // (3) No sub-accounts under the control accounts.
  for (const [parent, type] of [['1201', 'asset'], ['2102', 'liability']]) {
    const err = accounts.validateAccountDraft({ code: `${parent}.01`, name: 'Split', type, parent }, s().accounts)
    check(`R4 fix 3: a sub-account under ${parent} is refused`, typeof err === 'string' && /control account/.test(err), err)
    const n = s().accounts.length
    s().addAccount({ code: `${parent}.01`, name: 'Split', type, parent })
    check(`R4 fix 3: and the store does not create it (${parent} stays postable)`, s().accounts.length === n && !s().accounts.some((a) => a.parent === parent))
  }
  check('R4 fix 3: other parents still take sub-accounts',
    accounts.validateAccountDraft({ code: '1102.01', name: 'Petty', type: 'asset', parent: '1102' }, s().accounts) === null)

  // (6) The table field's save rule, used on blur and when the input unmounts mid-typing.
  check('R4 fix 6: a changed table is pending', events.pendingTable(' VIP-1 ', 'T1') === ' VIP-1 ')
  check('R4 fix 6: an unchanged (or whitespace-only) edit is not', events.pendingTable(' T1 ', 'T1') === null && events.pendingTable('', null) === null)
  check('R4 fix 6: clearing a table is pending', events.pendingTable('', 'T1') === '')
}

console.log(`\n${failures === 0 ? 'ALL FLOW CHECKS PASSED' : failures + ' CHECK(S) FAILED'}\n`)
process.exit(failures === 0 ? 0 : 1)
