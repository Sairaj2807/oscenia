// What a money movement WOULD post, before it posts (client round 4).
//
// The client asked to see — and edit — the journal entry in a pop-up before a down payment, a
// client payment or a vendor payment lands. Each planner below returns that entry without
// posting anything, and the store actions build their postings from the same planners, so the
// pop-up and the ledger cannot drift apart.
//
// A plan has two halves:
//   companions  the accrual entries that come with the movement ("DP invoiced", the vendor bill,
//               a PO variance). Read-only: invoices, purchase orders and the open-items lists
//               hang off them, so the pop-up shows them but never edits them.
//   editable    the receipt or payment itself: memo, the two dates, cash account, withholding
//               and its lines. One control line is LOCKED — 1201 Receivable for client money,
//               2102 Payable for vendor money — because the amount it clears is what keeps the
//               invoice, the PO and the open items consistent. Everything else may change, as
//               long as validateEdited() accepts the result.
//
// Two dates, one rule: `date` is the date the money was RECEIVED (or paid). It is the posting
// date, and every report buckets by it. `documentDate` is the date printed on the receipt or
// the vendor's invoice; it changes no figure and rides on the entry's source for reconciling.

import { withholding } from './ledger.js'
import { poTotal, poDpAmount } from './vendors.js'
import { addDays } from './billing.js'
import { appToday } from './format.js'

export const CLIENT_CONTROL = '1201'
export const VENDOR_CONTROL = '2102'
// AR and AP open items are measured on exactly these two accounts.
export const CONTROL_ACCOUNTS = [CLIENT_CONTROL, VENDOR_CONTROL]
/** The control account a code is, or sits under ('1201.01' -> '1201'); else null. */
export const controlAccountOf = (code) => {
  const head = String(code || '').split('.')[0]
  return CONTROL_ACCOUNTS.includes(head) ? head : null
}
// Same tolerance lib/ledger.js uses for "nothing left outstanding".
const EPSILON = 1

const whole = (n) => Math.round(Number(n) || 0)
const isIso = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v

// --- line builders ------------------------------------------------------------------------

/** A client's money in: net cash, PPh 23 they withheld (an asset), receivable cleared at gross. */
export function clientReceiptLines({ gross, tax, rate, cashAccount = '1101', clearNote }) {
  const lines = [{ account: cashAccount, debit: gross - tax, credit: 0, note: 'Net cash received from client' }]
  if (tax) lines.push({ account: '1401', debit: tax, credit: 0, note: `PPh 23 withheld by client @ ${rate}%` })
  lines.push({ account: CLIENT_CONTROL, debit: 0, credit: gross, note: clearNote })
  return lines
}

/** Money out to a vendor: payable cleared at gross, PPh 23 withheld (owed to the tax office), net cash. */
export function vendorPaymentLines({ gross, tax, rate, cashAccount = '1101', settleNote }) {
  const lines = [{ account: VENDOR_CONTROL, debit: gross, credit: 0, note: settleNote }]
  if (tax) lines.push({ account: '2105', debit: 0, credit: tax, note: `PPh 23 withheld @ ${rate}%` })
  lines.push({ account: cashAccount, debit: 0, credit: gross - tax, note: 'Net paid to vendor' })
  return lines
}

/** The bill a purchase order raises the first time it needs a payable. */
export function vendorBillEntry(po, vendor) {
  const total = poTotal(po)
  const name = vendor?.name ?? po.vendorId
  return {
    memo: `Vendor bill — ${po.id} (${name})`,
    project: po.project,
    source: {
      kind: 'po',
      ref: po.id,
      due: addDays(po.date || appToday(), po.terms?.settlementDays ?? 14),
      vendor: name,
    },
    series: 'exp',
    lines: [
      { account: '5101', debit: total, credit: 0, note: `${name} — ${po.id}` },
      { account: VENDOR_CONTROL, debit: 0, credit: total, note: 'Vendor payable raised' },
    ],
  }
}

/** Moving the bill to the vendor's actual invoice. Applied against the bill it adjusts. */
export function varianceEntry(po, variance) {
  return {
    memo: variance > 0 ? `Vendor bill reduced to actual — ${po.id}` : `Vendor bill increased to actual — ${po.id}`,
    project: po.project,
    source: { kind: 'po', ref: po.id },
    series: 'exp',
    appliesToBill: true,
    lines: variance > 0
      ? [
        { account: VENDOR_CONTROL, debit: variance, credit: 0, note: 'Payable reduced to actual' },
        { account: '5101', debit: 0, credit: variance, note: 'Cost reduced to actual' },
      ]
      : [
        { account: '5101', debit: -variance, credit: 0, note: 'Cost increased to actual' },
        { account: VENDOR_CONTROL, debit: 0, credit: -variance, note: 'Payable increased to actual' },
      ],
  }
}

// --- shared plumbing ------------------------------------------------------------------------

// The inputs every planner takes. Omitted means today's behaviour.
const inputsOf = (inputs = {}) => ({
  date: inputs.date || appToday(),
  documentDate: inputs.documentDate ?? null,
  memo: inputs.memo ?? null,
  cashAccount: inputs.cashAccount || '1101',
  withhold: inputs.withhold !== false,
  taxAmount: inputs.taxAmount == null || inputs.taxAmount === '' ? null : inputs.taxAmount,
})

const vendorRate = (vendor, taxConfig) => vendor?.pph23Rate ?? taxConfig?.pph23?.rate ?? 0

// Vendor withholding: the vendor's own rate beats the company default; an override wins.
function vendorTax(gross, vendor, taxConfig, inp) {
  const rate = vendorRate(vendor, taxConfig)
  const active = taxConfig?.pph23?.active !== false
  const computed = active ? Math.round(gross * (rate / 100)) : 0
  const tax = inp.withhold ? (inp.taxAmount == null ? computed : whole(inp.taxAmount)) : 0
  return { rate, computed, tax }
}

function movement({ inp, memo, gross, tax, computed, rate, lines, locked, source, project }) {
  return {
    memo: inp.memo ?? memo,
    defaultMemo: memo,
    date: inp.date,
    documentDate: inp.documentDate,
    cashAccount: inp.cashAccount,
    withhold: inp.withhold,
    taxAmount: tax,
    computedTax: computed,
    rate,
    gross,
    net: gross - tax,
    lines,
    locked,
    source,
    project,
  }
}

const fail = (error) => ({ companions: [], editable: null, error })
const dated = (entry, date) => ({ ...entry, date })

// --- planners -------------------------------------------------------------------------------

/**
 * Confirming a client's down payment: "DP invoiced" (companion) and "DP received" (editable).
 * ctx: { deal, taxConfig, invoiceId, projectId }
 */
export function planDpConfirm({ deal, taxConfig, invoiceId, projectId }, inputs) {
  if (!deal) return fail('missing')
  const inp = inputsOf(inputs)
  const gross = whole(deal.dpAmount)
  const computed = withholding(gross, taxConfig, 'pph23')
  const tax = inp.withhold ? (inp.taxAmount == null ? computed.amount : whole(inp.taxAmount)) : 0
  if (tax < 0 || tax > gross) return fail('tax')
  const rate = computed.rate || taxConfig?.pph23?.rate || 0
  const project = projectId || deal.projectIdOnConfirm
  return {
    companions: [dated({
      memo: `DP invoiced — ${deal.name}`,
      project,
      source: { kind: 'invoice', ref: invoiceId },
      lines: [
        { account: CLIENT_CONTROL, debit: gross, credit: 0, note: 'Receivable raised on DP invoice' },
        { account: '4101', debit: 0, credit: gross, note: 'Quotation contract down payment' },
      ],
    }, inp.date)],
    editable: movement({
      inp, gross, tax, rate, computed: computed.amount, project,
      memo: `DP received — ${deal.name}`,
      lines: clientReceiptLines({ gross, tax, rate, cashAccount: inp.cashAccount, clearNote: 'Receivable cleared at gross' }),
      locked: { account: CLIENT_CONTROL, side: 'credit', amount: gross },
      source: { kind: 'payment' },
    }),
    error: null,
  }
}

/**
 * A client's payment against an issued invoice. inputs.amount is the gross received, capped
 * at what is outstanding. ctx: { invoice, taxConfig, projectName, recognitionId }
 */
export function planReceivePayment({ invoice, taxConfig, projectName, recognitionId = null }, inputs = {}) {
  if (!invoice) return fail('missing')
  if (invoice.status === 'Scheduled') return fail('scheduled')
  const outstanding = invoice.amount - (invoice.paid || 0)
  if (outstanding <= 0) return fail('settled')
  const gross = Math.min(whole(inputs.amount), outstanding)
  if (gross <= 0) return fail('amount')
  const inp = inputsOf(inputs)
  const computed = withholding(gross, taxConfig, 'pph23')
  const tax = inp.withhold ? (inp.taxAmount == null ? computed.amount : whole(inp.taxAmount)) : 0
  if (tax < 0 || gross - tax < 0) return fail('tax')
  const rate = computed.rate || taxConfig?.pph23?.rate || 0
  return {
    companions: [],
    editable: movement({
      inp, gross, tax, rate, computed: computed.amount, project: invoice.project,
      memo: `Payment received — ${projectName || invoice.project} (${invoice.id})`,
      lines: clientReceiptLines({ gross, tax, rate, cashAccount: inp.cashAccount, clearNote: `Receivable cleared on ${invoice.id}` }),
      locked: { account: CLIENT_CONTROL, side: 'credit', amount: gross },
      source: { kind: 'payment', ref: recognitionId || invoice.id },
    }),
    error: null,
  }
}

/**
 * Paying an open vendor bill from Accounts Payable. ctx: { bill, outstanding, vendor, taxConfig }
 */
export function planPayBill({ bill, outstanding, vendor, taxConfig }, inputs = {}) {
  if (!bill) return fail('missing')
  if (!(outstanding > 0)) return fail('settled')
  const gross = Math.min(whole(inputs.amount), outstanding)
  if (gross <= 0) return fail('amount')
  const inp = inputsOf(inputs)
  const { rate, computed, tax } = vendorTax(gross, vendor, taxConfig, inp)
  if (tax < 0 || gross - tax < 0) return fail('tax')
  const ref = bill.source?.ref || bill.id
  return {
    companions: [],
    editable: movement({
      inp, gross, tax, rate, computed, project: bill.project,
      memo: `Vendor payment — ${bill.source?.vendor || ref}`,
      lines: vendorPaymentLines({ gross, tax, rate, cashAccount: inp.cashAccount, settleNote: `Payable settled — ${ref}` }),
      locked: { account: VENDOR_CONTROL, side: 'debit', amount: gross },
      source: { kind: 'payment', ref: bill.id },
    }),
    error: null,
  }
}

/**
 * The down payment on an approved purchase order. The first payment raises the bill for the
 * whole order (companion) if it was not raised yet. ctx: { po, vendor, taxConfig, bill }
 */
export function planPayPoDp({ po, vendor, taxConfig, bill = null }, inputs = {}) {
  if (!po || po.status !== 'Approved') return fail('status')
  const dp = poDpAmount(po)
  if (dp <= 0) return fail('nodp')
  const inp = inputsOf(inputs)
  const { rate, computed, tax } = vendorTax(dp, vendor, taxConfig, inp)
  if (tax < 0 || dp - tax < 0) return fail('tax')
  const companions = !bill && poTotal(po) > 0 ? [dated(vendorBillEntry(po, vendor), inp.date)] : []
  return {
    companions,
    editable: movement({
      inp, gross: dp, tax, rate, computed, project: po.project,
      memo: `Vendor DP — ${po.id}`,
      lines: vendorPaymentLines({ gross: dp, tax, rate, cashAccount: inp.cashAccount, settleNote: `Payable settled — ${po.id}` }),
      locked: { account: VENDOR_CONTROL, side: 'debit', amount: dp },
      source: { kind: 'payment', ref: bill?.id || po.id },
    }),
    error: null,
  }
}

/**
 * Settling a purchase order against the vendor's actual final invoice: the bill (if never
 * raised) and the variance are companions; paying what is left is the editable movement.
 * When nothing is left to pay there is no movement, only the companions and the dates.
 * ctx: { po, vendor, taxConfig, bill, billOutstanding } — billOutstanding is what the bill
 * still shows today (store.poOutstanding).
 */
export function planSettlePo({ po, vendor, taxConfig, bill = null, billOutstanding = 0 }, inputs = {}) {
  if (!po || (po.status !== 'DP Paid' && po.status !== 'Approved')) return fail('status')
  const inp = inputsOf(inputs)
  const committed = poTotal(po)
  const actual = inputs.actualTotal == null ? committed : Math.max(0, Number(inputs.actualTotal) || 0)
  const variance = committed - actual
  const companions = []
  const raising = !bill && committed > 0
  if (raising) companions.push(dated(vendorBillEntry(po, vendor), inp.date))
  const hasBill = Boolean(bill) || raising
  if (variance !== 0 && hasBill) companions.push(dated(varianceEntry(po, variance), inp.date))
  // What the payable shows once the variance lands — read the way store.poOutstanding reads
  // it, so the plan pays exactly what the action would.
  const after = hasBill ? (bill ? billOutstanding : committed) - variance : 0
  const remaining = after > EPSILON ? after : 0
  const meta = { committed, actual, variance, remaining }
  if (remaining <= 0) return { companions, editable: null, error: null, ...meta }
  const { rate, computed, tax } = vendorTax(remaining, vendor, taxConfig, inp)
  if (tax < 0 || remaining - tax < 0) return { ...fail('tax'), ...meta }
  return {
    companions,
    editable: movement({
      inp, gross: remaining, tax, rate, computed, project: po.project,
      memo: `Vendor final settlement — ${po.id}`,
      lines: vendorPaymentLines({ gross: remaining, tax, rate, cashAccount: inp.cashAccount, settleNote: `Payable settled — ${po.id}` }),
      locked: { account: VENDOR_CONTROL, side: 'debit', amount: remaining },
      source: { kind: 'payment', ref: bill?.id || po.id },
    }),
    error: null,
    ...meta,
  }
}

/**
 * Issuing a scheduled invoice: an accrual, so there is nothing to edit — the pop-up shows the
 * entry read-only. ctx: { invoice, projectName }, inputs: { issuedOn, documentDate }
 */
export function planIssueInvoice({ invoice, projectName }, { issuedOn = null, documentDate = null } = {}) {
  if (!invoice) return fail('missing')
  if (invoice.status !== 'Scheduled') return fail('issued')
  const revenueAccount = invoice.type === 'Down Payment' ? '4101' : '4102'
  return {
    companions: [{
      date: issuedOn || appToday(),
      memo: `${invoice.type} invoiced — ${projectName || invoice.project}`,
      project: invoice.project,
      source: { kind: 'invoice', ref: invoice.id, documentDate },
      lines: [
        { account: CLIENT_CONTROL, debit: invoice.amount, credit: 0, note: `Receivable raised on ${invoice.id}` },
        { account: revenueAccount, debit: 0, credit: invoice.amount, note: invoice.type },
      ],
    }],
    editable: null,
    error: null,
  }
}

// Why a planner refused, in words. The store's own toasts say the same with more context.
export const PLAN_ERRORS = {
  missing: 'That document no longer exists.',
  scheduled: 'This is still a scheduled billing stage. Issue it first, then record the payment.',
  settled: 'Nothing is outstanding.',
  amount: 'Enter an amount greater than zero.',
  tax: 'Withholding cannot be negative or larger than the amount.',
  status: 'This purchase order cannot be paid in its current status.',
  nodp: 'This order has no down payment — settle the balance instead.',
  issued: 'This invoice has already been issued.',
}

/**
 * The PPh 23 a posted receipt or payment actually carries, read off its lines: the 1401 debit
 * on client money, the 2105 credit on vendor money. After an edit this can differ from the
 * planner's figure, and what the operator is told must be what posted.
 */
export function postedWithholding(lines = [], side = 'client') {
  const code = side === 'vendor' ? '2105' : '1401'
  const net = lines.reduce((a, l) => (l.account === code ? a + (Number(l.debit) || 0) - (Number(l.credit) || 0) : a), 0)
  return Math.round((side === 'vendor' ? -net : net) * 100) / 100
}

// --- the guard ------------------------------------------------------------------------------

/** Lines as numbers, the shape postEntry takes. Amounts are kept to the cent. */
export function cleanLines(lines = []) {
  const amount = (v) => (v === '' || v == null ? 0 : Math.round(Number(v) * 100) / 100)
  return lines.map((l) => ({
    account: String(l.account || ''),
    debit: amount(l.debit),
    credit: amount(l.credit),
    note: String(l.note || '').slice(0, 200),
  }))
}

/**
 * Whether an edited movement may post. Returns { ok, errors, warnings }; each item is
 * { code, message, line? } so the pop-up can translate it and the store can toast it.
 *
 * Refuses: fewer than two lines; an unknown, inactive or header account; a non-number or
 * negative amount; a line with both or neither side set, judged on the amounts as they will
 * post (to the cent — 0.004 is neither side); debits ≠ credits; the locked control line moved
 * (account, side or amount); any line on the OTHER control account, or on a sub-account of
 * either (1201 inside a vendor payment, 2102 inside a client receipt) — open items are
 * reconciled against those two accounts alone; a received date that is not a real date, or a
 * receipt date given but not a real date. A receipt dated after it was received is only a
 * warning.
 */
export function validateEdited(plan, edited = {}, accounts = []) {
  const errors = []
  const warnings = []
  const err = (code, message, line) => errors.push({ code, message, ...(line == null ? {} : { line }) })

  if (!isIso(edited.date)) err('date', 'The received date is not a valid date.')
  if (edited.documentDate && !isIso(edited.documentDate)) err('documentDate', 'The receipt date is not a valid date.')
  if (isIso(edited.date) && isIso(edited.documentDate) && edited.documentDate > edited.date) {
    warnings.push({ code: 'receiptAfterReceived', message: 'The receipt is dated after the day it was received.' })
  }

  if (!plan || plan.error) {
    err('plan', PLAN_ERRORS[plan?.error] || 'Nothing to post.')
    return { ok: false, errors, warnings }
  }
  const ed = plan.editable
  // Nothing to edit (a settlement with nothing left to pay): only the dates matter.
  if (!ed) return { ok: errors.length === 0, errors, warnings }

  const raw = edited.lines || []
  if (raw.length < 2) err('lines', 'An entry needs at least two lines.')
  // The checks below run on the amounts as they will post, not as typed.
  const lines = cleanLines(raw)
  const lockedAccount = ed.locked.account
  const byCode = new Map(accounts.map((a) => [a.code, a]))
  const isHeader = (code) => accounts.some((a) => a.parent === code)
  raw.forEach((l, i) => {
    const n = i + 1
    const acct = byCode.get(String(l.account || ''))
    if (!l.account) err('account', `Line ${n}: pick an account.`, n)
    else if (!acct) err('account', `Line ${n}: account ${l.account} does not exist.`, n)
    else if (acct.active === false) err('inactive', `Line ${n}: account ${l.account} is inactive.`, n)
    else if (isHeader(acct.code)) err('header', `Line ${n}: ${l.account} is a header account.`, n)
    if (l.account && controlAccountOf(l.account) && String(l.account) !== lockedAccount) {
      err('control', `Line ${n}: ${l.account} is a receivable/payable control account. Only the locked ${lockedAccount} line may touch one here.`, n)
    }
    const d = l.debit === '' || l.debit == null ? 0 : Number(l.debit)
    const c = l.credit === '' || l.credit == null ? 0 : Number(l.credit)
    const { debit: pd, credit: pc } = lines[i]
    if (!Number.isFinite(d) || !Number.isFinite(c)) err('number', `Line ${n}: amounts must be numbers.`, n)
    else if (pd < 0 || pc < 0) err('negative', `Line ${n}: amounts cannot be negative.`, n)
    else if (pd === 0 && pc === 0 && (d !== 0 || c !== 0)) err('zero', `Line ${n}: the amount rounds to zero at two decimals.`, n)
    else if ((pd > 0) === (pc > 0)) err('side', `Line ${n}: enter a debit or a credit, not both or neither.`, n)
  })

  const debit = lines.reduce((a, l) => a + l.debit, 0)
  const credit = lines.reduce((a, l) => a + l.credit, 0)
  if (Math.abs(debit - credit) > 0.005) err('unbalanced', `Debits (${debit}) and credits (${credit}) do not balance.`)

  const { account, side, amount } = ed.locked
  const other = side === 'debit' ? 'credit' : 'debit'
  const onSide = lines.filter((l) => l.account === account).reduce((a, l) => a + l[side], 0)
  const offSide = lines.filter((l) => l.account === account).reduce((a, l) => a + l[other], 0)
  if (Math.abs(onSide - amount) > 0.005 || offSide > 0.005) {
    err('locked', `The ${account} line must stay a ${side} of ${amount}.`)
  }

  return { ok: errors.length === 0, errors, warnings }
}
