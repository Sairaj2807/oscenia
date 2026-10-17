// The posting pop-up (client round 4) against the live backend: request bodies, and the
// server's dry-run read back as a plan the editor can work on.
//
// Pure functions, so `verify-adapters.mjs` can pin the wire shapes without a server. Keys are
// camelCase here; `lib/api.js` turns them into the backend's snake_case on the way out.
//
// What crosses, per the backend contract (docs/finance-backend/STATUS.md, round 4 Unit 3):
//   - the received date as `paymentDate` (`confirmedOn` for a client DP) -- the posting date
//   - the receipt date as `documentDate` (`invoiceDate` when settling a PO)
//   - `cashAccount`, `withhold`
//   - `taxAmount` only when the operator typed a figure (otherwise the server computes it)
//   - `lines` only when the operator edited a line (otherwise the server's computed lines post)
// Money is sent as a string, as everywhere else in the client.
//
// The memo is not sent: none of these endpoints takes one, so the editor shows the server's.

import { CLIENT_CONTROL, VENDOR_CONTROL } from './postings.js'

const money = (n) => String(Math.round((Number(n) || 0) * 100) / 100)
const orNull = (v) => (v === '' || v == null ? null : v)

/** Edited lines on the wire: `[{account, debit, credit, note}]`, amounts as strings. */
export function apiLines(lines = []) {
  return lines.map((l) => ({
    account: String(l.account || ''),
    debit: money(l.debit),
    credit: money(l.credit),
    note: l.note ? String(l.note) : null,
  }))
}

/**
 * The shared part of every money body, from the pop-up's `edited` payload.
 * `dateKey` names the received-date field; `documentKey` the receipt-date field.
 */
export function toApiPosting(edited, { dateKey = 'paymentDate', documentKey = 'documentDate' } = {}) {
  if (!edited) return {}
  const body = {
    [dateKey]: orNull(edited.date),
    [documentKey]: orNull(edited.documentDate),
  }
  if (edited.cashAccount) body.cashAccount = edited.cashAccount
  if (edited.withhold != null) body.withhold = edited.withhold !== false
  if (edited.taxEdited && edited.withhold !== false && orNull(edited.taxAmount) != null) {
    body.taxAmount = money(edited.taxAmount)
  }
  if (edited.linesEdited && edited.lines?.length) body.lines = apiLines(edited.lines)
  return body
}

/** POST /quotations/{id}/confirm-down-payment */
export const confirmDpBody = (edited) => toApiPosting(edited, { dateKey: 'confirmedOn' })

/** POST /invoices/{id}/payments — and POST /bills/{entry}/payments, same shape. */
export function paymentBody(amount, edited, fallback = {}) {
  const base = edited
    ? toApiPosting(edited)
    : {
      paymentDate: orNull(fallback.date),
      cashAccount: fallback.cashAccount || '1101',
      withhold: fallback.withhold !== false,
      ...(orNull(fallback.taxAmount) != null ? { taxAmount: money(fallback.taxAmount) } : {}),
    }
  return { amount: money(amount), ...base }
}

/** POST /purchase-orders/{id}/pay-dp — the DP is fixed by the order's terms, so no amount. */
export const payDpBody = (edited) => toApiPosting(edited)

/** POST /purchase-orders/{id}/settle — the receipt date IS the vendor's invoice date. */
export function settleBody(actualTotal, { invoiceDate = null, edited = null } = {}) {
  const posting = edited ? toApiPosting(edited, { documentKey: 'invoiceDate' }) : {}
  return {
    ...(actualTotal == null ? {} : { actualTotal: money(actualTotal) }),
    ...posting,
    invoiceDate: orNull(edited ? edited.documentDate : invoiceDate) ?? orNull(invoiceDate),
  }
}

/** POST /journal-entries/{id}/adjust */
export function adjustBody(draft = {}) {
  return {
    entryDate: draft.date || undefined,
    memo: draft.memo || undefined,
    ...(draft.documentDate || draft.source?.documentDate
      ? { documentDate: draft.documentDate || draft.source.documentDate }
      : {}),
    lines: (draft.lines || []).map((l) => ({
      account: l.account,
      debit: String(Math.round(Number(l.debit) || 0)),
      credit: String(Math.round(Number(l.credit) || 0)),
      note: l.note || null,
    })),
  }
}

// --- the server's dry-run, as a plan -------------------------------------------------------

/** Which side of which control account a money movement clears. */
export const CLIENT_MONEY = { account: CLIENT_CONTROL, side: 'credit', taxAccount: '1401', taxSide: 'debit' }
export const VENDOR_MONEY = { account: VENDOR_CONTROL, side: 'debit', taxAccount: '2105', taxSide: 'credit' }

const isCash = (code) => String(code || '').startsWith('11')
const onAccount = (lines, account, side) => lines
  .filter((l) => l.account === account)
  .reduce((a, l) => a + (Number(l[side]) || 0), 0)

/**
 * Read an adapted preview (`adaptPreview`) as a lib/postings.js plan: the payment/receipt entry
 * is `editable`, everything else (DP invoice, vendor bill, variance, refund) a read-only
 * companion. The payment is the last entry that clears the control account on its side AND
 * moves cash -- a variance clears 2102 too, but touches no cash account.
 *
 * `flow` is CLIENT_MONEY or VENDOR_MONEY; `rate` / `computedTax` are for the "computed at"
 * hint, which the server does not return.
 */
export function planFromPreview(preview, flow = CLIENT_MONEY, { rate = 0, computedTax = null } = {}) {
  const entries = preview?.entries || []
  let at = -1
  entries.forEach((e, i) => {
    const clears = onAccount(e.lines, flow.account, flow.side) > 0
    if (clears && e.lines.some((l) => isCash(l.account))) at = i
  })
  const companions = entries
    .filter((_, i) => i !== at)
    .map((e) => ({ date: e.entryDate, memo: e.memo, lines: e.lines, documentDate: e.sourceDocumentDate ?? null }))
  if (at < 0) return { companions, editable: null, error: null, server: true }

  const pay = entries[at]
  const other = flow.side === 'debit' ? 'credit' : 'debit'
  const gross = onAccount(pay.lines, flow.account, flow.side) - onAccount(pay.lines, flow.account, other)
  const tax = onAccount(pay.lines, flow.taxAccount, flow.taxSide)
  return {
    companions,
    editable: {
      memo: pay.memo,
      defaultMemo: pay.memo,
      date: pay.entryDate,
      documentDate: pay.sourceDocumentDate ?? null,
      taxAmount: tax,
      computedTax: computedTax ?? tax,
      rate,
      gross,
      net: gross - tax,
      lines: pay.lines.map((l) => ({ account: l.account, debit: l.debit, credit: l.credit, note: l.note || '' })),
      locked: { account: flow.account, side: flow.side, amount: gross },
      voucherPreview: pay.voucherPreview,
    },
    error: null,
    server: true,
  }
}

/** A refusal in words: the backend's `detail`, a validation list flattened, or the message. */
export function apiErrorText(err) {
  if (!err) return 'The request failed.'
  if (typeof err === 'string') return err
  const detail = err.problem?.detail
  if (Array.isArray(detail)) {
    return detail.map((d) => d?.msg || String(d)).join('; ') || err.message
  }
  const permitted = err.permitted?.length ? ` Allowed: ${err.permitted.join(', ')}.` : ''
  return `${detail || err.message || 'The request failed.'}${permitted}`
}
