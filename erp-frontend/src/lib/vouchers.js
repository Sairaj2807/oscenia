// Voucher numbering.
//
// The client asked for "improvement of transaction voucher numbering governance
// for traceability and auditing accountability": specific prefixes per
// transaction class (KK cash out, KM cash in, RM reimbursement, FA fixed asset,
// adjustment vouchers) and a numbering scheme "flexibly configured by the
// administrator with unique formats based on periods and transaction
// categories".
//
// So a voucher number is NOT the entry id. `JE-1042` stays as the internal,
// immutable key that journal lines, reversals and source links reference —
// renumbering that would break every existing reference. `voucherNo` is the
// human, auditable document number printed on the voucher and quoted in the
// filing cabinet, and it is the thing the administrator gets to configure.
//
// Format tokens, expanded by formatVoucher():
//
//   [PREFIX]   the series prefix          KK
//   [YEAR]     four-digit year            2026
//   [YY]       two-digit year             26
//   [MONTH]    two-digit month            08
//   [MON]      three-letter month         AUG
//   [DATE]     two-digit day of month     14
//   [SEQ_001]  sequence, zero-padded to
//              the token's digit width    007
//
// Anything else in the format string is passed through verbatim, so the
// client's own examples work as written:
//
//   REVENUE - [MONTH] - [DATE] - [SEQ_001]   ->  REVENUE - 08 - 14 - 001

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

// Reset cadences a sequence can follow. "Never" is a single running counter for
// the life of the company.
export const RESET_PERIODS = [
  { key: 'monthly', label: 'Monthly' },
  { key: 'yearly', label: 'Yearly' },
  { key: 'daily', label: 'Daily' },
  { key: 'never', label: 'Never (continuous)' },
]

// The series as delivered. Editable in the store — this is only the seed.
export const SEED_VOUCHER_SERIES = [
  {
    key: 'km', prefix: 'KM', label: 'Cash In (Kas Masuk)',
    hint: 'Client receipts, refunds in, petty cash returns',
    format: '[PREFIX]-[MONTH]-[DATE]-[SEQ_001]', reset: 'monthly',
  },
  {
    key: 'kk', prefix: 'KK', label: 'Cash Out (Kas Keluar)',
    hint: 'Vendor payments, disbursements, payroll',
    format: '[PREFIX]-[MONTH]-[DATE]-[SEQ_001]', reset: 'monthly',
  },
  {
    key: 'rm', prefix: 'RM', label: 'Reimbursement',
    hint: 'Cash-advance settlement and expense claims',
    format: '[PREFIX]-[MONTH]-[DATE]-[SEQ_001]', reset: 'monthly',
  },
  {
    key: 'fa', prefix: 'FA', label: 'Fixed Asset',
    hint: 'Acquisition, depreciation and write-off',
    format: 'FIXED ASSET (FA) - [MONTH] - [DATE] - [SEQ_001]', reset: 'monthly',
  },
  {
    key: 'rev', prefix: 'REVENUE', label: 'Revenue (accrual)',
    hint: 'Invoices raised — receivable recognised, no cash yet',
    format: '[PREFIX] - [MONTH] - [DATE] - [SEQ_001]', reset: 'monthly',
  },
  {
    key: 'exp', prefix: 'EXPENSE', label: 'Expense (accrual)',
    hint: 'Bills received — payable raised, no cash yet',
    format: '[PREFIX] - [MONTH] - [DATE] - [SEQ_001]', reset: 'monthly',
  },
  {
    key: 'jv', prefix: 'JV', label: 'Adjustment Voucher',
    hint: 'Manual entries, reversals, corrections and opening balances',
    format: '[PREFIX]-[MONTH]-[DATE]-[SEQ_001]', reset: 'monthly',
  },
]

export function seriesByKey(series, key) {
  return (series || []).find((s) => s.key === key) || null
}

// Which counter bucket a date falls into, given the series' reset cadence.
export function periodKey(reset, date) {
  const iso = String(date || '')
  if (reset === 'never') return 'all'
  if (reset === 'yearly') return iso.slice(0, 4)
  if (reset === 'daily') return iso.slice(0, 10)
  return iso.slice(0, 7) // monthly
}

export function counterKey(series, date) {
  return `${series.key}|${periodKey(series.reset, date)}`
}

export function formatVoucher(series, date, seq) {
  const iso = String(date || '')
  const year = iso.slice(0, 4)
  const month = iso.slice(5, 7)
  const day = iso.slice(8, 10)
  const monthIndex = Number(month) - 1

  return String(series.format || '[PREFIX]-[SEQ_001]')
    .replace(/\[PREFIX\]/g, series.prefix ?? '')
    .replace(/\[YEAR\]/g, year)
    .replace(/\[YY\]/g, year.slice(2))
    .replace(/\[MONTH\]/g, month)
    .replace(/\[MON\]/g, MONTHS[monthIndex] || '')
    .replace(/\[DATE\]/g, day)
    // The digits in the token declare the width: SEQ_001 pads to 3, SEQ_00001
    // pads to 5. Anything narrower than the number itself just prints in full.
    .replace(/\[SEQ_(\d+)\]/g, (_, width) => String(seq).padStart(width.length, '0'))
}

// A sample of what a series currently produces, for the live preview in the
// settings editor. Uses the next sequence so the preview is the real next number.
export function previewVoucher(series, date, seq = 1) {
  return formatVoucher(series, date, seq)
}

// ---------------------------------------------------------------------------
// Journal codes - the document a group of entries belongs to
// ---------------------------------------------------------------------------
//
// The client's complaint was a proliferation of voucher numbers: one automatic posting plus
// a later correction produced two or three numbered documents for a single logical event,
// and reconciling a project at close meant chasing all of them.
//
// The answer is NOT to reuse a number. A correction is its own filed document and an auditor
// needs to see it as one - reverseJournalEntry says exactly that, and it stays true. What was
// missing was a record of which document they all belong to, which is `groupRef`.
//
// A group is named by its ANCHOR entry's voucher number. The anchor is not stamped with its
// own code, and that is forced rather than chosen: on the server a posted entry is immutable
// (a database trigger rejects every UPDATE), so the original cannot be marked when a
// correction joins it later. Every read here therefore matches `groupRef` OR `voucherNo`.

/** The code this entry is filed under - its group's, or its own if it anchors one. */
export function groupCode(entry) {
  return entry?.groupRef || entry?.voucherNo || null
}

/** Every entry filed under one code: the anchor plus each correction. */
export function groupedEntries(journal, code) {
  if (!code) return []
  return (journal || []).filter((e) => e.groupRef === code || e.voucherNo === code)
}

/**
 * Every journal code in use, newest first - what the manual-entry picker offers.
 *
 * Each entry is a potential anchor, so a standalone entry appears here with a count of one.
 * That is the point: picking it is how a later correction joins it.
 */
export function journalCodes(journal) {
  const byCode = new Map()
  for (const entry of journal || []) {
    const code = groupCode(entry)
    if (!code) continue
    const row = byCode.get(code) || { code, memo: entry.memo, date: entry.date, count: 0 }
    row.count += 1
    // The anchor names the group, so the group reads with the anchor's memo and date.
    if (!entry.groupRef) {
      row.memo = entry.memo
      row.date = entry.date
    }
    byCode.set(code, row)
  }
  return [...byCode.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
}

/** Validation shared by the store and the series editor. */
export function seriesDraftError(draft, existing, key = null) {
  const k = String(draft.key || '').trim().toLowerCase()
  if (!k) return 'A series needs a key, for example "pc".'
  if (!/^[a-z0-9-]+$/.test(k)) return 'A key may hold lowercase letters, digits and hyphens only.'
  if (k !== key && (existing || []).some((s) => s.key === k)) return `A series keyed "${k}" already exists.`
  if (!String(draft.prefix || '').trim()) return 'A series needs a prefix.'
  if (!String(draft.label || '').trim()) return 'A series needs a label.'
  if (!/\[SEQ_\d+\]/.test(String(draft.format || ''))) {
    return 'A voucher format must contain a [SEQ_001] token, or every voucher in the period would share a number.'
  }
  return null
}

// ---------------------------------------------------------------------------
// Auto-classification
// ---------------------------------------------------------------------------

// Net effect of an entry on cash. Positive = money in, negative = money out,
// zero = an accrual that moves no cash.
function netCash(lines, cashAccounts) {
  return (lines || []).reduce((a, l) => {
    if (!cashAccounts.includes(l.account)) return a
    return a + (Number(l.debit) || 0) - (Number(l.credit) || 0)
  }, 0)
}

function touchesType(lines, accountOf, type) {
  return (lines || []).some((l) => accountOf(l.account)?.type === type)
}

// Pick the series an entry belongs to. An explicit `series` on the posting
// always wins; this is the fallback so that every entry — including the ones
// posted by operational actions that know nothing about voucher series — still
// lands in the right document class.
//
// `accountOf` and `cashAccounts` are passed in rather than imported so this
// module stays free of a dependency on the live chart.
export function pickSeries({ source, lines }, { accountOf, cashAccounts, assetAccounts = [] }) {
  const kind = source?.kind

  if (kind === 'reversal' || kind === 'adjustment' || kind === 'opening' || kind === 'manual') return 'jv'
  if (kind === 'depreciation') return 'fa'

  // A cash-advance settlement is a reimbursement either way it moves — that is
  // the whole point of the RM class.
  if (kind === 'pettycash' && source?.settlement) return 'rm'

  const net = netCash(lines, cashAccounts)
  if (net > 0) return 'km'
  if (net < 0) return 'kk'

  // No cash moved, so this is an accrual. Fixed-asset movements get their own
  // class; otherwise revenue recognition versus a bill received.
  if (assetAccounts.length && (lines || []).some((l) => assetAccounts.includes(l.account))) return 'fa'
  if (touchesType(lines, accountOf, 'revenue')) return 'rev'
  return 'exp'
}
