// Vendor catalogue helpers.
//
// The point of this module is date-aware availability. The old catalogue had a
// static `available` count, which meant the same 200 truss segments could be
// promised to two events on the same weekend and nothing would object. Stock is
// now a total, bookings carry a date range, and availability is a question you
// can only answer *for a period*.

import { parseDate, isoDate } from './format.js'

// Two closed date ranges overlap unless one ends before the other starts.
export function rangesOverlap(aFrom, aTo, bFrom, bTo) {
  const a1 = parseDate(aFrom)
  const a2 = parseDate(aTo)
  const b1 = parseDate(bFrom)
  const b2 = parseDate(bTo)
  if (!a1 || !a2 || !b1 || !b2) return false
  return a1 <= b2 && b1 <= a2
}

// Quantity already committed on this item during the window.
export function bookedQty(item, from, to, { excludeProject } = {}) {
  if (!from || !to) return 0
  return (item.bookings || []).reduce((total, b) => {
    if (excludeProject && b.projectId === excludeProject) return total
    return rangesOverlap(from, to, b.from, b.to) ? total + b.qty : total
  }, 0)
}

// What is actually free in the window. With no window given, falls back to
// total stock, which is the honest answer to an unqualified question.
export function availableQty(item, from, to, opts) {
  if (!from || !to) return item.stock
  return Math.max(0, item.stock - bookedQty(item, from, to, opts))
}

export function availabilityStatus(item, from, to, opts) {
  const free = availableQty(item, from, to, opts)
  if (free <= 0) return 'Booked'
  if (free < item.stock * 0.25) return 'Low Stock'
  return 'Available'
}

// A load-in/out window around an event. Kit is needed before the doors open and
// is not back the same night, so a one-day booking would understate demand.
export function eventWindow(eventDate, { setupDays = 2, strikeDays = 1 } = {}) {
  const d = parseDate(eventDate)
  if (!d) return { from: null, to: null }
  const DAY = 24 * 60 * 60 * 1000
  return {
    from: isoDate(d.getTime() - setupDays * DAY),
    to: isoDate(d.getTime() + strikeDays * DAY),
  }
}

// Tag matching is AND, not OR: selecting "Wedding" and "Outdoor" should narrow
// to vendors that can do both, which is the question someone actually has.
export function hasAllTags(entity, tagIds) {
  if (!tagIds || !tagIds.length) return true
  const own = entity?.tags || []
  return tagIds.every((t) => own.includes(t))
}

export function vendorsByTags(vendors, tagIds) {
  return vendors.filter((v) => hasAllTags(v, tagIds))
}

// Which tags are actually in use, so the UI can avoid offering dead filters.
export function tagsInUse(vendors, catalogue) {
  const used = new Set()
  ;[...(vendors || []), ...(catalogue || [])].forEach((e) => (e.tags || []).forEach((t) => used.add(t)))
  return used
}

export function catalogueFor(items, { vendorId, category, subcategory, tags, query } = {}) {
  const q = (query || '').trim().toLowerCase()
  return items.filter((it) => {
    if (vendorId && it.vendorId !== vendorId) return false
    if (category && it.category !== category) return false
    if (subcategory && it.subcategory !== subcategory) return false
    if (!hasAllTags(it, tags)) return false
    if (q && !it.item.toLowerCase().includes(q) && !it.vendor.toLowerCase().includes(q)) return false
    return true
  })
}

// ---------------------------------------------------------------------------
// Cost estimator: the same kind of item, side by side across vendors
// ---------------------------------------------------------------------------

/** Items are compared within one category (and subcategory, where it has one). */
export const quoteGroupKey = (it) => `${it.category || ''}|${it.subcategory || ''}`

/**
 * The groups worth comparing: those with items from at least two vendors, the best covered first.
 * Nothing is invented — with no overlap between vendors the list is empty.
 */
export function quoteGroups(catalogue) {
  const by = new Map()
  for (const it of catalogue || []) {
    const key = quoteGroupKey(it)
    if (!by.has(key)) by.set(key, { key, label: [it.category, it.subcategory].filter(Boolean).join(' · ') || 'Uncategorised', vendors: new Set() })
    by.get(key).vendors.add(it.vendorId)
  }
  return [...by.values()]
    .filter((g) => g.vendors.size >= 2)
    .map((g) => ({ key: g.key, label: g.label, vendors: g.vendors.size }))
    .sort((a, b) => b.vendors - a.vendors || a.label.localeCompare(b.label))
}

/**
 * One quote per vendor for a group: that vendor's cheapest item in it, cheapest first, with the
 * vendor's own rating and terms next to it. Lead time is not on the server, so it is not here.
 */
export function compareQuotes(catalogue, vendors, groupKey) {
  const cheapest = new Map()
  for (const it of catalogue || []) {
    if (quoteGroupKey(it) !== groupKey) continue
    const held = cheapest.get(it.vendorId)
    if (!held || Number(it.unitPrice) < Number(held.unitPrice)) cheapest.set(it.vendorId, it)
  }
  const quotes = [...cheapest.values()]
    .map((it) => {
      const v = (vendors || []).find((x) => x.id === it.vendorId)
      return {
        vendorId: it.vendorId,
        vendor: it.vendor,
        item: it.item,
        itemId: it.id,
        unit: it.unit || '',
        unitPrice: Number(it.unitPrice) || 0,
        stock: Number(it.stock) || 0,
        score: v?.score ?? null,
        delays: v?.delays ?? 0,
        dpPercent: v?.terms?.dpPercent ?? null,
        settlementDays: v?.terms?.settlementDays ?? null,
      }
    })
    .sort((a, b) => a.unitPrice - b.unitPrice)
  return { quotes, lowest: quotes.length ? quotes[0].unitPrice : null }
}

// ---------------------------------------------------------------------------
// Purchase orders
// ---------------------------------------------------------------------------

export function poLineTotal(line) {
  return Math.round((Number(line.qty) || 0) * (Number(line.unitPrice) || 0))
}

export function poTotal(po) {
  return (po.lines || []).reduce((a, l) => a + poLineTotal(l), 0)
}

export function poDpAmount(po) {
  return Math.round(poTotal(po) * ((po.terms?.dpPercent ?? 0) / 100))
}

export function poBalance(po) {
  return poTotal(po) - poDpAmount(po)
}

// What has actually been paid, by status. Approval commits but pays nothing.
//
// A settled PO reports its ACTUAL final amount, which is not necessarily the
// amount committed: the whole point of slide 8's "double-check input scheme" is
// that a vendor's real invoice can differ from the order it was raised against.
export function poPaid(po) {
  if (po.status === 'Settled') return po.actualTotal ?? poTotal(po)
  if (po.status === 'DP Paid') return poDpAmount(po)
  return 0
}

export function poOutstanding(po) {
  if (po.status === 'Cancelled' || po.status === 'Settled') return 0
  return poTotal(po) - poPaid(po)
}

// Gain / loss against the committed budget. Positive = came in under the order
// (a gain); negative = the vendor charged more than was committed (a loss).
//
// Only meaningful once settled: before that the actual is simply unknown, and
// reporting the unpaid balance as a "gain" would be flattering nonsense.
export function poVariance(po) {
  if (po.status !== 'Settled') return null
  return poTotal(po) - (po.actualTotal ?? poTotal(po))
}

// Rolled up across a project's live purchase orders.
export function projectVendorVariance(purchaseOrders, projectId) {
  return purchaseOrders
    .filter((po) => po.project === projectId && po.status === 'Settled')
    .reduce((a, po) => a + (poVariance(po) || 0), 0)
}

// Committed spend per project: everything on a live PO, paid or not. This is
// what "locked as budget" means on slide 8 — once a PO is approved the number
// stops moving, and the realized figure is tracked against it separately.
export function committedByProject(purchaseOrders, projectId) {
  return purchaseOrders
    .filter((po) => po.project === projectId && po.status !== 'Cancelled' && po.status !== 'Draft')
    .reduce((a, po) => a + poTotal(po), 0)
}

export function poNextStatus(status) {
  switch (status) {
    case 'Draft': return 'Approved'
    case 'Approved': return 'DP Paid'
    case 'DP Paid': return 'Settled'
    default: return null
  }
}

/**
 * The next step available on a purchase order.
 *
 * Takes the order rather than just its status because `Approved` is ambiguous: an order
 * whose terms carry no down payment has nothing to pay, and `payPoDownPayment` refuses a
 * zero amount. Always answering 'Pay DP' there left those orders parked on `Approved`
 * behind a button that could not do anything — which is one of the three separate causes
 * behind the client's "Settle Balance is unresponsive" report. They go straight to
 * settlement, which `settlePurchaseOrder` has always accepted.
 */
export function poActionLabel(po) {
  switch (po?.status) {
    case 'Draft': return 'Approve'
    case 'Approved': return poDpAmount(po) > 0 ? 'Pay DP' : 'Settle balance'
    case 'DP Paid': return 'Settle balance'
    default: return null
  }
}

// ---------------------------------------------------------------------------
// PO pipeline (client round 1, V1)
// ---------------------------------------------------------------------------
// The board the team asked for — PO Issued → DP Paid → In Progress → Delivered → Fully Paid —
// mixes money and delivery. The accounting statuses stay exactly as they are (they post to the
// ledger); delivery is a separate status beside them, and the board combines the two.

export const DELIVERY_STATUSES = ['Not started', 'In progress', 'Delivered']
export const PIPELINE = ['PO Issued', 'DP Paid', 'In Progress', 'Delivered / Completed', 'Fully Paid']

/**
 * The board column for a PO, given its delivery status (default 'Not started'). Drafts and
 * cancelled orders are not live commitments, so they are off the board (null). Once settled, an
 * order is Fully Paid whatever its delivery; before that, delivery progress wins over payment.
 */
export function pipelineStage(po, delivery = 'Not started') {
  if (!po || po.status === 'Draft' || po.status === 'Cancelled') return null
  if (po.status === 'Settled') return 'Fully Paid'
  if (delivery === 'Delivered') return 'Delivered / Completed'
  if (delivery === 'In progress') return 'In Progress'
  if (po.status === 'DP Paid') return 'DP Paid'
  return 'PO Issued'
}

/**
 * The five-step progress strip on a board card (client round 3): one entry per PIPELINE stage,
 * each 'done', 'todo' or — for an order whose terms carry no down payment — 'skipped' on DP Paid.
 * Before settlement the steps report what actually happened, so an order delivered with its DP
 * still unpaid shows that gap. Settling against the vendor's final invoice closes the order, so a
 * settled one reads complete. `current` marks the board column the order sits in.
 */
export function pipelineSteps(po, delivery = 'Not started') {
  const stage = pipelineStage(po, delivery)
  if (!stage) return []
  const noDp = poDpAmount(po) <= 0
  const settled = po.status === 'Settled'
  const done = {
    'PO Issued': true,
    'DP Paid': settled || po.status === 'DP Paid',
    'In Progress': settled || delivery === 'In progress' || delivery === 'Delivered',
    'Delivered / Completed': settled || delivery === 'Delivered',
    'Fully Paid': settled,
  }
  return PIPELINE.map((s) => ({
    stage: s,
    state: s === 'DP Paid' && noDp ? 'skipped' : done[s] ? 'done' : 'todo',
    current: s === stage,
  }))
}

// ---------------------------------------------------------------------------
// Vendor lifecycle (client round 2, V2)
// ---------------------------------------------------------------------------
// Where each supplier stands, from first contact to trading: Prospect → Onboarding → Approved
// → Active. On hold and Blacklisted sit off the board. Only an Approved or Active vendor can be
// given a new purchase order — that is the point of vetting them first.
//
// Approving and blacklisting follow the purchase-order rule (`approve_po`: CEO and finance). A
// PM may bring a vendor in and start onboarding, never approve one.

export const VENDOR_STAGES = ['Prospect', 'Onboarding', 'Approved', 'Active']
export const VENDOR_OFF_BOARD = ['On hold', 'Blacklisted']
export const VENDOR_ALL_STAGES = [...VENDOR_STAGES, ...VENDOR_OFF_BOARD]

// A vendor the lifecycle has never recorded was on the books before it existed (or came from
// the backend), and every such vendor was already being given orders — so Approved, not Prospect.
export const DEFAULT_VENDOR_STAGE = 'Approved'

// Stages are keyed by the vendor's uuid when it has one (backend data) and by its number
// otherwise (the demo), so a demo vendor and a backend vendor can never share a record —
// business numbers like V-06 are reused between the two.
export const vendorKey = (vendor) => vendor?.uuid || vendor?.id

export function vendorStageOf(vendorStages, vendorId) {
  return vendorStages?.[vendorId]?.stage || DEFAULT_VENDOR_STAGE
}

/** May this vendor be given a new purchase order? */
export function canOrderFrom(stage) {
  return stage === 'Approved' || stage === 'Active'
}

/** Items ticked by hand on the onboarding checklist (the rest are read from the vendor record). */
export const MANUAL_CHECKS = ['agreement', 'reference']

/**
 * What onboarding needs before a vendor can be approved. Three items come from the vendor record
 * itself, so filling in the record ticks them; the agreement can come from an attached MoU or a
 * tick, and the reference check is always a tick.
 */
export function vendorChecklist(vendor, checks = {}) {
  const has = (s) => Boolean(String(s || '').trim())
  const items = [
    { key: 'npwp', label: 'Tax ID (NPWP) recorded', done: has(vendor?.npwp) },
    { key: 'bank', label: 'Bank account recorded', done: has(vendor?.bank?.account) && has(vendor?.bank?.holder) },
    { key: 'pic', label: 'Person in charge with a phone or email', done: has(vendor?.pic?.name) && (has(vendor?.pic?.phone) || has(vendor?.pic?.email)) },
    {
      key: 'agreement', label: 'Signed agreement (MoU) on file', manual: true,
      done: Boolean(checks.agreement) || (vendor?.attachments || []).some((a) => a.kind === 'Agreement'),
      auto: (vendor?.attachments || []).some((a) => a.kind === 'Agreement'),
    },
    { key: 'reference', label: 'Reference checked with a past client', manual: true, done: Boolean(checks.reference) },
  ]
  return { items, done: items.filter((i) => i.done).length, total: items.length, complete: items.every((i) => i.done) }
}

/** The one forward step from a board stage, or null at the end. */
export function nextVendorStage(stage) {
  const i = VENDOR_STAGES.indexOf(stage)
  return i >= 0 && i < VENDOR_STAGES.length - 1 ? VENDOR_STAGES[i + 1] : null
}

export const VENDOR_STEP_LABEL = { Onboarding: 'Start onboarding', Approved: 'Approve vendor', Active: 'Mark active' }

/**
 * Why a stage change is refused, or null when it is allowed. Pure, so the store and the screen
 * agree on every rule:
 *  - forward one step at a time along the board;
 *  - Approved needs the checklist complete, and `approve_po`;
 *  - Active needs a live purchase order (that is what "trading" means);
 *  - On hold / Blacklisted from anywhere, with a reason, and `approve_po`;
 *  - back from On hold to where it was; back from Blacklisted only to Onboarding (vet it again).
 */
export function vendorStageError({ from, to, canApprove, checklistComplete, hasLivePo, reason, resumeTo }) {
  if (!VENDOR_ALL_STAGES.includes(to)) return 'Unknown stage.'
  if (from === to) return 'The vendor is already there.'
  if (VENDOR_OFF_BOARD.includes(to)) {
    if (!canApprove) return 'Only finance or the CEO can put a vendor on hold or blacklist one.'
    // Lifting a blacklisting is a fresh vetting (back to Onboarding), not a softer hold.
    if (from === 'Blacklisted') return 'A blacklisted vendor has to be vetted again: back to Onboarding.'
    if (!String(reason || '').trim()) return 'Give a reason — it stays on the vendor’s record.'
    return null
  }
  if (from === 'On hold') {
    if (!canApprove) return 'Only finance or the CEO can reactivate a vendor.'
    return to === (resumeTo || 'Onboarding') ? null : `A vendor on hold goes back to ${resumeTo || 'Onboarding'}.`
  }
  if (from === 'Blacklisted') {
    if (!canApprove) return 'Only finance or the CEO can reactivate a vendor.'
    return to === 'Onboarding' ? null : 'A blacklisted vendor has to be vetted again: back to Onboarding.'
  }
  if (nextVendorStage(from) !== to) return 'Move a vendor one stage at a time.'
  if (to === 'Approved') {
    if (!canApprove) return 'Only finance or the CEO can approve a vendor.'
    if (!checklistComplete) return 'Finish the onboarding checklist first.'
  }
  if (to === 'Active' && !hasLivePo) return 'A vendor becomes active with its first approved purchase order.'
  return null
}

/**
 * The checklist as shown: the server's own answer when signed in (it also knows a filed Agreement file),
 * otherwise worked out here from the vendor record and the hand ticks.
 */
export function checklistFor(vendor, entry) {
  if (entry?.checklist) {
    const items = entry.checklist.map((i) => ({ ...i }))
    return { items, done: items.filter((i) => i.done).length, total: items.length, complete: items.every((i) => i.done) }
  }
  return vendorChecklist(vendor, entry?.checks)
}

/** The board stage a vendor on hold returns to: the server's answer, else the last board stage in its history. */
export function resumeStageOf(entry) {
  if (entry?.resumeTo) return entry.resumeTo
  const back = [...(entry?.history || [])].reverse().find((h) => VENDOR_STAGES.includes(h.stage))
  return back?.stage || 'Onboarding'
}
