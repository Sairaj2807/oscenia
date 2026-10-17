// The journal entry, shown — and editable — before it posts (client round 4).
//
// "When a client makes a down payment or a vendor payment is processed, the system should open
// a pop-up window displaying the journal entry prior to posting, allowing for edits to the
// journal details or tax information." And two dates: the one on the receipt, and the day it
// was received, which is the one reports use.
//
// One editable entry per money movement: the receipt or payment itself. The accrual entries
// that come with it ("DP invoiced", the vendor bill, a PO variance) are shown read-only above
// it, because invoices, POs and the open-items lists hang off them. The control line (1201 for
// client money, 2102 for vendor money) is locked for the same reason.
//
// The lines come from the planners in lib/postings.js — the same ones the store posts from —
// so the seeded demo shows real lines with no server. While nobody has touched a line, they
// follow the tax, amount and account fields; once one is edited by hand they freeze, and
// "Reset to calculated" brings the computed ones back. lib/postings.js validateEdited() is the
// guard, here for the Post button and again in the store.
//
// On a live backend (`live`) the lines come from the server's own dry-run instead, re-asked
// whenever the dates, account, withholding, tax or amount change, and are editable the same
// way; the store then sends `lines` only if a line was edited and `tax_amount` only if a figure
// was typed (lib/apiPostings.js). A refusal from the real post (422 `detail`) shows in the
// pop-up, which stays open. `server` is the older read-only preview, still used by Issue.

import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, Hash, Loader2, Lock, Plus, RotateCcw, Trash2, Calculator } from 'lucide-react'
import Modal from './Modal'
import { Field, TextInput, NumberInput, Select, money2, num2 } from './ui'
import { useStore } from '../store/useStore'
import { ACCOUNT_GROUPS, CASH_ACCOUNTS, accountLabel, isPostable } from '../lib/accounts'
import { validateEdited, cleanLines, PLAN_ERRORS } from '../lib/postings'
import { planFromPreview, apiErrorText } from '../lib/apiPostings'
import { appToday } from '../lib/format'
import { useT } from '../i18n'

// The two dates, worded for who issued the paper.
export const CLIENT_DATES = { document: 'Date on receipt', received: 'Date received (used in reports)' }
export const VENDOR_DATES = { document: 'Date on vendor receipt/invoice', received: 'Date received (used in reports)' }

const toDraft = (l) => ({
  account: l.account,
  debit: l.debit ? String(l.debit) : '',
  credit: l.credit ? String(l.credit) : '',
  note: l.note || '',
})
const BLANK = { account: '', debit: '', credit: '', note: '' }
const sum = (lines, side) => lines.reduce((a, l) => a + (Number(l[side]) || 0), 0)

/**
 * The state behind the editor. `planFor(inputs)` is one of the lib/postings.js planners with
 * its context bound; `initial` seeds the inputs (dates, cash account, withholding…).
 * Returns the plan, the lines on screen, the payload to post (`edited`) and its validation.
 *
 * `live` (live backend only): `{ path, body(ask), flow }` -- the dry-run endpoint, the request
 * body for a set of inputs (lib/apiPostings.js builders), and CLIENT_MONEY / VENDOR_MONEY. The
 * plan then comes from the server's dry-run; `planFor` only supplies the "computed at" rate.
 * Both dates start empty and are seeded from the server's answer (its today, not the demo's).
 */
export function usePostingDraft(planFor, initial = {}, live = null) {
  const accounts = useStore((s) => s.accounts)
  const previewPosting = useStore((s) => s.previewPosting)
  const [inputs, setInputs] = useState(() => ({
    date: live ? null : appToday(),
    documentDate: live ? null : appToday(),
    memo: null,
    cashAccount: CASH_ACCOUNTS.find((c) => isPostable(c)) || '1101',
    withhold: true,
    taxAmount: null,
    ...initial,
  }))
  // Lines edited by hand. null = follow the plan.
  const [manual, setManual] = useState(null)
  // The real post's refusal (live), shown until something is changed.
  const [postError, setPostError] = useState(null)
  const taxEdited = Boolean(inputs.withhold) && inputs.taxAmount != null && inputs.taxAmount !== ''

  // --- live: the server's dry-run for the current inputs --------------------------------
  const [srv, setSrv] = useState({ loading: Boolean(live), preview: null, error: null, computedTax: null })
  const ask = {
    date: inputs.date, documentDate: inputs.documentDate, cashAccount: inputs.cashAccount,
    withhold: inputs.withhold, taxAmount: inputs.taxAmount, taxEdited, linesEdited: false,
  }
  const askBody = live ? live.body(ask) : null
  const askKey = live ? `${live.path}|${JSON.stringify(askBody)}` : ''
  const askRef = useRef(null)
  askRef.current = { body: askBody, taxEdited, withhold: inputs.withhold }
  useEffect(() => {
    if (!live) return undefined
    let stale = false
    setSrv((cur) => ({ ...cur, loading: true }))
    // A short pause so typing a tax figure asks once, not once per keystroke.
    const timer = setTimeout(async () => {
      const { body, taxEdited: typed, withhold } = askRef.current
      const result = await previewPosting(live.path, body)
      if (stale) return
      const preview = result?.preview ?? null
      const first = preview ? planFromPreview(preview, live.flow) : null
      const tax = first?.editable?.taxAmount ?? null
      setSrv((cur) => ({
        loading: false,
        preview: preview || cur.preview,
        error: result?.error ?? (result ? null : 'Not connected to the API.'),
        // The server's own figure, captured while no override is in play.
        computedTax: preview && !typed && withhold ? tax : cur.computedTax,
      }))
      if (preview) {
        // Seed the dates the first time: the server's today, and its receipt date if any.
        const on = first.editable?.date || preview.entries?.[0]?.entryDate || null
        setInputs((cur) => (cur.date ? cur : {
          ...cur,
          date: on,
          documentDate: cur.documentDate || first.editable?.documentDate || on,
        }))
      }
    }, 250)
    return () => { stale = true; clearTimeout(timer) }
  }, [askKey]) // eslint-disable-line react-hooks/exhaustive-deps

  let plan
  if (live) {
    let local = null
    try { local = planFor(inputs) } catch { local = null }
    plan = srv.preview
      ? planFromPreview(srv.preview, live.flow, {
        rate: local?.editable?.rate ?? 0,
        computedTax: srv.computedTax ?? local?.editable?.computedTax ?? null,
      })
      : { companions: [], editable: null, error: srv.error ? 'server' : 'loading' }
  } else {
    plan = planFor(inputs)
  }
  const ed = plan?.editable || null
  const calculated = (ed?.lines || []).map(toDraft)
  const lines = manual || calculated
  const raw = {
    documentDate: inputs.documentDate || null,
    date: inputs.date,
    memo: inputs.memo ?? ed?.defaultMemo ?? '',
    cashAccount: inputs.cashAccount,
    withhold: inputs.withhold,
    taxAmount: ed && inputs.withhold ? ed.taxAmount : null,
    lines: ed ? lines : [],
  }
  const validated = validateEdited(plan, raw, accounts)
  // Live: nothing posts while the server is still answering, or has refused.
  const ready = !live || (Boolean(srv.preview) && !srv.loading && !srv.error)
  const check = ready ? validated : { ...validated, ok: false }
  // What the store action (and the API) receives: amounts as numbers, plus what was touched.
  const edited = {
    ...raw,
    lines: ed ? cleanLines(lines) : [],
    linesEdited: Boolean(manual),
    taxEdited,
  }

  const set = (patch) => { setPostError(null); setInputs((cur) => ({ ...cur, ...patch })) }
  const freeze = (fn) => { setPostError(null); setManual((cur) => fn(cur || calculated)) }
  return {
    plan, inputs, set, lines, edited, check,
    live: Boolean(live),
    server: live ? srv : null,
    postError,
    setPostError,
    frozen: Boolean(manual),
    setLine: (i, patch) => freeze((arr) => arr.map((l, idx) => (idx === i ? { ...l, ...patch } : l))),
    addLine: () => freeze((arr) => [...arr, { ...BLANK }]),
    removeLine: (i) => freeze((arr) => arr.filter((_, idx) => idx !== i)),
    reset: () => { setPostError(null); setManual(null) },
  }
}

/**
 * Run a confirm handler that may return a promise (live posts do). A refusal -- `{ok: false}`
 * from the store's `mutate`, typically the backend's 422 `detail` -- lands in the pop-up, which
 * the caller leaves open; success is the caller's to close. Offline handlers return nothing
 * and this does nothing more.
 */
export async function settlePost(out, draft, setBusy) {
  if (!out || typeof out.then !== 'function') return out
  setBusy?.(true)
  try {
    const res = await out
    if (res && res.ok === false) draft.setPostError(apiErrorText(res.error))
    return res
  } finally {
    setBusy?.(false)
  }
}

// The validation codes, worded for the screen. Line numbers are added around them.
const ERROR_TEXT = {
  date: 'The received date is not a valid date.',
  documentDate: 'The receipt date is not a valid date.',
  lines: 'An entry needs at least two lines.',
  account: 'pick an existing account.',
  inactive: 'that account is inactive.',
  header: 'that is a header account — post to one of its sub-accounts.',
  number: 'amounts must be numbers.',
  negative: 'amounts cannot be negative.',
  side: 'enter a debit or a credit, not both or neither.',
  zero: 'the amount rounds to zero at two decimals.',
  control: 'that is a receivable/payable control account — only the locked line may use one here.',
  unbalanced: 'Debits and credits do not balance.',
  locked: 'The locked control line must keep its account and amount.',
  receiptAfterReceived: 'The receipt is dated after the day it was received. Check the dates — this is allowed.',
}

function Issue({ item, tone }) {
  const t = useT()
  const text = item.code === 'plan' ? t(PLAN_ERRORS[item.planCode] || item.message) : t(ERROR_TEXT[item.code] || item.message)
  return (
    <li className={tone}>
      {item.line ? `${t('Line')} ${item.line}: ` : ''}{text}
    </li>
  )
}

/** Read-only entry card: a companion, or the server's preview. */
function EntryCard({ entry, badge }) {
  const t = useT()
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {badge}
        <span className="text-sm text-white/85">{entry.memo}</span>
        <span className="ml-auto text-[10px] text-white/35">{entry.date || entry.entryDate}</span>
      </div>
      <table className="w-full text-left font-mono text-[11px]">
        <thead>
          <tr className="border-b border-white/10 text-[9px] uppercase tracking-wider text-white/40">
            <th className="py-1.5 pr-2">{t('Account')}</th>
            <th className="py-1.5 px-2 text-right">{t('Debit')}</th>
            <th className="py-1.5 pl-2 text-right">{t('Credit')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {entry.lines.map((line, j) => (
            <tr key={j}>
              <td className="py-1.5 pr-2">
                <span className="text-white/85">{line.accountName ? `${line.account} · ${line.accountName}` : accountLabel(line.account)}</span>
                {line.note && <div className="text-[9px] text-white/35">{line.note}</div>}
              </td>
              <td className="py-1.5 px-2 text-right text-emerald-300">{line.debit ? num2(line.debit) : '-'}</td>
              <td className="py-1.5 pl-2 text-right text-sky-300">{line.credit ? num2(line.credit) : '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * The editor body: companions, the two dates, memo, cash account, withholding and the lines.
 * Render it inside any Modal; the caller owns the footer (see PostingModal, or the Receive
 * Payment / Pay Bill dialogs, which put their amount field above it).
 */
export function PostingEditor({ draft, dateLabels = CLIENT_DATES }) {
  const t = useT()
  const { plan, inputs, set, lines, check, frozen, setLine, addLine, removeLine, reset } = draft
  const ed = plan?.editable || null
  const cash = CASH_ACCOUNTS.filter((c) => isPostable(c))
  const lockedAt = ed
    ? lines.findIndex((l) => l.account === ed.locked.account && Number(l[ed.locked.side]) > 0)
    : -1
  const debit = sum(lines, 'debit')
  const credit = sum(lines, 'credit')
  const errors = check.errors.map((e) => (e.code === 'plan' ? { ...e, planCode: plan?.error } : e))

  const srv = draft.server
  const serverState = plan?.error === 'server' || plan?.error === 'loading'

  return (
    <div className="space-y-3" data-posting-editor>
      {draft.postError && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/[0.06] p-3 text-[12px] text-rose-200" data-post-error>
          <div className="font-medium">{t('Not posted')}</div>
          <div className="mt-0.5 text-rose-200/80">{draft.postError}</div>
        </div>
      )}
      {srv?.loading && (
        <div className="flex items-center gap-2 text-[12px] text-white/50">
          <Loader2 size={13} className="animate-spin" /> {t('Working out what this would post…')}
        </div>
      )}
      {srv?.error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/[0.06] p-3 text-[12px] text-rose-200" data-server-error>
          <div className="font-medium">{t('This cannot be posted')}</div>
          <div className="mt-0.5 text-rose-200/80">{srv.error}</div>
        </div>
      )}
      {plan?.error && !serverState && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/[0.06] p-3 text-[12px] text-rose-200">
          <div className="font-medium">{t('This cannot be posted')}</div>
          <div className="mt-0.5 text-rose-200/80">{t(PLAN_ERRORS[plan.error] || 'Nothing to post.')}</div>
        </div>
      )}

      {plan?.companions?.length > 0 && (
        <div className="space-y-2">
          <div className="text-[10px] uppercase tracking-wider text-white/35">{t('Posts with it — read-only')}</div>
          {plan.companions.map((c, i) => (
            <EntryCard key={i} entry={c} badge={<span className="rounded-md border border-white/15 px-1.5 py-0.5 text-[10px] text-white/45"><Lock size={9} className="mr-1 inline" />{t('Linked')}</span>} />
          ))}
        </div>
      )}

      {dateLabels && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={dateLabels.document} hint={t('The date printed on the paper. Changes no figure.')}>
            <TextInput type="date" value={inputs.documentDate || ''} onChange={(e) => set({ documentDate: e.target.value })} aria-label={t(dateLabels.document)} />
          </Field>
          <Field label={dateLabels.received} hint={t('The posting date — every report reads this one.')}>
            <TextInput type="date" value={inputs.date || ''} onChange={(e) => set({ date: e.target.value })} aria-label={t(dateLabels.received)} />
          </Field>
        </div>
      )}

      {ed && (
        <div className="rounded-lg border border-gold/25 bg-gold/[0.03] p-3 space-y-3" data-editable-entry>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-gold-light">{t('This entry — editable')}</span>
            {frozen && (
              <button onClick={reset} className="ml-auto inline-flex items-center gap-1 text-[11px] text-gold-light hover:underline">
                <RotateCcw size={11} /> {t('Reset to calculated')}
              </button>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
            <Field label="Memo">
              {/* The live endpoints take no memo, so there it is the server's, shown as is. */}
              <TextInput value={inputs.memo ?? ed.defaultMemo} onChange={(e) => set({ memo: e.target.value })} maxLength={200} disabled={draft.live} />
            </Field>
            <Field label="Cash / bank account">
              <Select value={inputs.cashAccount} onChange={(e) => set({ cashAccount: e.target.value })}>
                {cash.map((c) => <option key={c} value={c}>{accountLabel(c)}</option>)}
              </Select>
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-3 rounded-md border border-white/10 bg-white/[0.02] px-3 py-2">
            <Calculator size={14} className="text-gold-light" />
            <label className="flex items-center gap-1.5 text-[11px] text-white/70">
              <input type="checkbox" checked={inputs.withhold} onChange={(e) => set({ withhold: e.target.checked })} className="accent-gold" />
              {t('PPh 23 withheld')}
            </label>
            {inputs.withhold && (
              <>
                <NumberInput
                  aria-label={t('Tax amount')}
                  value={inputs.taxAmount ?? ed.taxAmount}
                  onChange={(e) => set({ taxAmount: e.target.value })}
                  min={0}
                  className="!w-40"
                />
                <span className="text-[11px] text-white/40">{t('Computed at')} {ed.rate}%: {money2(ed.computedTax)}</span>
                {inputs.taxAmount != null && (
                  <button onClick={() => set({ taxAmount: null })} className="text-[11px] text-gold-light hover:underline">{t('Use computed')}</button>
                )}
              </>
            )}
          </div>

          {frozen && (
            <div className="text-[10px] text-amber-300/80">
              {t('Lines edited by hand — they no longer follow the tax, amount or account fields.')}
            </div>
          )}

          <div className="space-y-2">
            {lines.map((l, i) => {
              const locked = i === lockedAt
              return (
                <div key={i} className="grid grid-cols-12 items-start gap-2" data-line={i}>
                  <div className="col-span-12 sm:col-span-5">
                    <div className="flex items-center gap-1.5">
                      {locked && <Lock size={12} className="shrink-0 text-gold-light" aria-label={t('Locked')} />}
                      <Select value={l.account} disabled={locked} onChange={(e) => setLine(i, { account: e.target.value })} aria-label={`${t('Account')} ${i + 1}`}>
                        <option value="">— {t('select account')} —</option>
                        {l.account && !ACCOUNT_GROUPS.some((g) => g.codes.includes(l.account)) && (
                          <option value={l.account}>{accountLabel(l.account)}</option>
                        )}
                        {ACCOUNT_GROUPS.map((g) => (
                          <optgroup key={g.label} label={g.label}>
                            {g.codes.map((c) => <option key={c} value={c}>{accountLabel(c)}</option>)}
                          </optgroup>
                        ))}
                      </Select>
                    </div>
                    <TextInput className="mt-1.5 text-xs" value={l.note} onChange={(e) => setLine(i, { note: e.target.value })} placeholder={t('Line description')} maxLength={200} />
                  </div>
                  <div className="col-span-5 sm:col-span-3">
                    <NumberInput value={l.debit} disabled={locked} onChange={(e) => setLine(i, { debit: e.target.value, ...(e.target.value ? { credit: '' } : {}) })} placeholder={t('Debit')} aria-label={`${t('Debit')} ${i + 1}`} />
                  </div>
                  <div className="col-span-5 sm:col-span-3">
                    <NumberInput value={l.credit} disabled={locked} onChange={(e) => setLine(i, { credit: e.target.value, ...(e.target.value ? { debit: '' } : {}) })} placeholder={t('Credit')} aria-label={`${t('Credit')} ${i + 1}`} />
                  </div>
                  <div className="col-span-2 flex justify-end pt-2 sm:col-span-1">
                    <button onClick={() => removeLine(i)} disabled={locked || lines.length <= 2}
                      className="text-white/30 hover:text-rose-300 disabled:opacity-25 disabled:hover:text-white/30" aria-label={t('Remove line')}>
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
          <button onClick={addLine} className="btn-ghost py-1.5 text-xs"><Plus size={13} /> {t('Add line')}</button>

          <div className="grid grid-cols-3 gap-2 border-t border-white/10 pt-3 text-sm">
            <span className="text-white/50">{t('Totals')}</span>
            <span className="text-right tabular-nums text-emerald-300">{num2(debit)}</span>
            <span className="text-right tabular-nums text-sky-300">{num2(credit)}</span>
          </div>
          <div className="text-[10px] text-white/35">
            {t('The locked line clears the invoice or bill at its full amount, so open items and the PO stay consistent.')}
          </div>
        </div>
      )}

      {(errors.length > 0 || check.warnings.length > 0) && !plan?.error && (
        <ul className="space-y-0.5 rounded-lg border border-white/10 bg-white/[0.02] p-3 text-[11px]">
          {errors.map((e, i) => <Issue key={`e${i}`} item={e} tone="text-rose-300" />)}
          {check.warnings.map((w, i) => <Issue key={`w${i}`} item={w} tone="text-amber-300" />)}
        </ul>
      )}
    </div>
  )
}

/** The BALANCED / OUT BY badge for a footer. */
export function BalanceBadge({ draft }) {
  const ed = draft.plan?.editable
  if (!ed) return null
  const gap = sum(draft.lines, 'debit') - sum(draft.lines, 'credit')
  const balanced = Math.abs(gap) < 0.005
  return (
    <span data-balance={balanced ? 'balanced' : 'unbalanced'} className={`mr-auto inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[11px] font-semibold ${
      balanced ? 'border-emerald-700 bg-emerald-950/80 text-emerald-300' : 'border-rose-700 bg-rose-950/60 text-rose-300'
    }`}>
      {balanced ? <><Check size={13} /> BALANCED</> : <><AlertTriangle size={13} /> OUT BY {money2(Math.abs(gap))}</>}
    </span>
  )
}

/** The server's own dry-run, read-only (live backend). */
function ServerPreview({ preview, loading, error }) {
  const t = useT()
  const entries = preview?.entries || []
  return (
    <>
      {loading && (
        <div className="flex items-center gap-2 py-6 text-sm text-white/50">
          <Loader2 size={15} className="animate-spin" /> {t('Working out what this would post…')}
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/[0.06] p-3 text-[12px] text-rose-200">
          <div className="font-medium">{t('This cannot be posted')}</div>
          <div className="mt-0.5 text-rose-200/80">{error}</div>
        </div>
      )}
      {!loading && !error && !entries.length && (
        <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3 text-[12px] text-white/45">
          {t('This action posts nothing to the ledger.')}
        </div>
      )}
      {entries.map((entry, i) => (
        <EntryCard key={`${entry.voucherPreview}-${i}`} entry={entry} badge={(
          <span className="inline-flex items-center gap-1.5 rounded-md border border-gold/30 bg-gold/10 px-2 py-0.5 font-mono text-[11px] text-gold-light">
            <Hash size={10} />{entry.voucherPreview}
          </span>
        )} />
      ))}
      {entries.length > 1 && (
        <div className="text-[11px] text-white/40">
          {entries.length} {t('documents, posted in one transaction — either all of them land or none do.')}
        </div>
      )}
    </>
  )
}

/**
 * The pop-up. Local mode (the demo): `planFor` + `initial`, full editing, `onConfirm(edited)`.
 * Live mode: also pass `live` (see usePostingDraft) and the editor works on the server's
 * dry-run; `onConfirm` may return the store's promise, and a refusal stays in the pop-up.
 * Server mode (read-only, Issue): pass `server` (the useConfirmPosting state); `onConfirm(null)`.
 */
export default function PostingModal({
  title, subtitle, confirmLabel = 'Post', planFor, initial, dateLabels = CLIENT_DATES,
  server = null, live = null, busy = false, onConfirm, onClose,
}) {
  const t = useT()
  // The hook always runs (hooks cannot be conditional); in server mode its plan is unused.
  const draft = usePostingDraft(server ? () => null : planFor, initial, server ? null : live)
  const [posting, setPosting] = useState(false)
  const serverBalanced = server?.preview?.balanced
  const canPost = server
    ? Boolean(server.preview) && !server.error && !server.loading
    : draft.check.ok

  return (
    <Modal
      title={title}
      subtitle={subtitle}
      size="2xl"
      onClose={onClose}
      footer={
        <>
          {server ? (server.preview && (
            <span className={`mr-auto inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[11px] font-semibold ${
              serverBalanced ? 'border-emerald-700 bg-emerald-950/80 text-emerald-300' : 'border-rose-700 bg-rose-950/60 text-rose-300'
            }`}>
              {serverBalanced
                ? <><Check size={13} /> BALANCED</>
                : <><AlertTriangle size={13} /> OUT BY {money2(Math.abs(server.preview.totalDebit - server.preview.totalCredit))}</>}
            </span>
          )) : <BalanceBadge draft={draft} />}
          <button onClick={onClose} className="btn-ghost">{t('Cancel')}</button>
          <button onClick={() => settlePost(onConfirm(server ? null : draft.edited), draft, setPosting)} disabled={!canPost || busy || posting} className="btn-gold" data-post>
            {busy || posting ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
            {' '}{t(confirmLabel)}
          </button>
        </>
      }
    >
      {server ? <ServerPreview {...server} /> : <PostingEditor draft={draft} dateLabels={dateLabels} />}
    </Modal>
  )
}
