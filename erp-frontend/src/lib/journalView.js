// The journal LIST, filtered (client round 4: "the journal module is currently too cluttered").
//
// Every money event writes two entries (the accrual, then the linked payment), a reversal adds
// one more and an adjustment two. All of them are real and stay in the books; this only decides
// what the Journal tab lists. Reports, balances and the trial balance never read it — they
// keep using every entry, which is why hiding a reversed pair is safe: an entry and its
// reversal net to zero on every account. Only a plain pair hides — an entry reversed once,
// whose reversal stands. In a chain (E1 reversed by R1, R1 reversed in turn by R2) E1 is live
// again, so every link of the chain stays on the list.
//
// Type chips, mapped from the entry's source.kind (and, for payments, the accounts it moves):
//   Client invoices   invoice
//   Client payments   payment touching 1201 Receivable, or any other payment that brings cash in
//   Vendor bills      po, purchase_order (bills and PO variance adjustments)
//   Vendor payments   payment touching 2102 Payable, or any other payment that sends cash out;
//                     payroll and pettycash (money paid out to crew and suppliers)
//   Manual            manual, opening, and anything not listed here
//   Assets & stock    depreciation, warehouse, fixed_asset, inventory
//   Corrections       reversal, adjustment, and any entry that is itself a reversal (reversalOf)

import { account } from './accounts.js'

export const JOURNAL_TYPES = [
  ['all', 'All'],
  ['client-invoices', 'Client invoices'],
  ['client-payments', 'Client payments'],
  ['vendor-bills', 'Vendor bills'],
  ['vendor-payments', 'Vendor payments'],
  ['manual', 'Manual'],
  ['assets', 'Assets & stock'],
  ['corrections', 'Corrections'],
]

const touches = (entry, code) => (entry.lines || []).some((l) => l.account === code)
const cashNet = (entry) => (entry.lines || []).reduce(
  (a, l) => (account(l.account).cash ? a + (Number(l.debit) || 0) - (Number(l.credit) || 0) : a), 0,
)

/** Which chip an entry belongs to. */
export function journalType(entry) {
  const kind = entry?.source?.kind
  if (entry?.reversalOf || kind === 'reversal' || kind === 'adjustment') return 'corrections'
  if (kind === 'invoice') return 'client-invoices'
  if (kind === 'po' || kind === 'purchase_order') return 'vendor-bills'
  if (kind === 'payment') {
    if (touches(entry, '2102')) return 'vendor-payments'
    if (touches(entry, '1201')) return 'client-payments'
    return cashNet(entry) < 0 ? 'vendor-payments' : 'client-payments'
  }
  if (kind === 'payroll' || kind === 'pettycash') return 'vendor-payments'
  if (kind === 'depreciation' || kind === 'warehouse' || kind === 'fixed_asset' || kind === 'inventory') return 'assets'
  return 'manual'
}

/**
 * Ids of entries that are half of a plain reversed pair: an entry and the reversal that undid
 * it, where the entry is not itself a reversal and the reversal was not reversed in turn.
 * A pair that belongs to a longer chain stays visible, so the hidden set always nets to zero.
 */
export function reversedPairIds(entries) {
  const ids = new Set()
  const byId = new Map(entries.map((e) => [e.id, e]))
  for (const e of entries) {
    const r = e.reversedBy ? byId.get(e.reversedBy) : null
    if (!r || r.reversalOf !== e.id) continue
    if (e.reversalOf || r.reversedBy) continue
    ids.add(e.id); ids.add(r.id)
  }
  return ids
}

export const DEFAULT_JOURNAL_FILTERS = { type: 'all', hideReversed: true, q: '' }

/**
 * Filter the list. Returns { shown, hidden } where `hidden` is how many entries the
 * "Hide reversed pairs" switch took out (after the type and search filters), so the screen
 * can say so and offer them back. Never mutates `entries`.
 */
export function filterJournal(entries, { type = 'all', hideReversed = true, q = '' } = {}) {
  const needle = String(q || '').trim().toLowerCase()
  const matched = entries.filter((e) => (type === 'all' || journalType(e) === type)
    && (!needle || [e.voucherNo, e.id, e.memo, e.project].some((v) => String(v || '').toLowerCase().includes(needle))))
  if (!hideReversed) return { shown: matched, hidden: 0 }
  // Pairs are found across the whole list, so a pair split by a type chip still hides.
  const pairs = reversedPairIds(entries)
  const shown = matched.filter((e) => !pairs.has(e.id))
  return { shown, hidden: matched.length - shown.length }
}

/** Saved filters, cleaned: anything unknown falls back to the default. */
export function cleanJournalFilters(raw) {
  const v = raw && typeof raw === 'object' ? raw : {}
  return {
    type: JOURNAL_TYPES.some(([k]) => k === v.type) ? v.type : 'all',
    hideReversed: v.hideReversed !== false,
    q: typeof v.q === 'string' ? v.q.slice(0, 100) : '',
  }
}
