import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  BookOpen, Scale, TrendingUp, Plus, Calculator, Check, AlertTriangle,
  ChevronRight, RotateCcw, FileText, Trash2, Printer, Link2, Hash,
  Library, Download, Layers, ShieldCheck, Search, Lock,
} from 'lucide-react'
import { useStore } from '../store/useStore'
import { useReport, useCrossCheck } from '../store/useReport'
import { adaptIncomeStatement, adaptBalanceSheet, adaptTrialBalance } from '../store/reportAdapters'
import {
  PageHeader, Card, TableWrap, money, money2, num2, pct2, Badge,
  Field, TextInput, NumberInput, Select, FilterPill, SectionTitle, ActionButton,
} from '../components/ui'
import Modal from '../components/Modal'
import PeriodsPanel from '../components/PeriodsPanel'
import { ACCOUNT_GROUPS, accountLabel, account, normalSide } from '../lib/accounts'
import {
  filterEntries, incomeStatementFrom, balanceSheetFrom, trialBalance,
  entryDebit, entryCredit, isBalanced, entryIsValid, generalLedger,
  rollUpByGroup, openItems, linkedEntries, accountBalance,
} from '../lib/ledger'
import {
  RESET_PERIODS, previewVoucher, counterKey, groupCode, groupedEntries, journalCodes,
  seriesDraftError,
} from '../lib/vouchers'
import { journalVoucherPDF } from '../lib/pdf'
import { JOURNAL_TYPES, filterJournal, journalType, cleanJournalFilters, DEFAULT_JOURNAL_FILTERS } from '../lib/journalView'
import { exportCSV, exportExcel } from '../lib/exports'
import { appToday, quarterStart, monthStart, yearStart } from '../lib/format'
import { useT } from '../i18n'

const TABS = [
  { key: 'journal', label: 'Journal', icon: BookOpen },
  { key: 'ledger', label: 'General Ledger', icon: Library },
  { key: 'income', label: 'Income Statement', icon: TrendingUp },
  { key: 'balance', label: 'Balance Sheet', icon: Scale },
  { key: 'periods', label: 'Periods', icon: Lock },
]

// Period presets. The client asked for "adaptive filtering based on daily,
// monthly, quarterly, to annual dates", so all four cadences are here.
//
// "YTD" is the default so the opening-balance entry is included and the Balance
// Sheet reconciles; a narrower window shows period activity only, which is
// correct for the Income Statement but leaves the Balance Sheet incomplete —
// hence the note rendered under the Balance Sheet tab.
// Boundaries are derived from the reference date, not hardcoded, so they stay
// correct as the date moves. A function, because "today" is only known once the page renders.
const periods = () => [
  { key: 'day', label: 'Today', range: { from: appToday(), to: appToday() } },
  { key: 'month', label: 'This Month', range: { from: monthStart(), to: appToday() } },
  { key: 'quarter', label: 'This Quarter', range: { from: quarterStart(), to: appToday() } },
  { key: 'ytd', label: 'YTD', range: { from: yearStart(), to: appToday() } },
  { key: 'all', label: 'All Time', range: null },
  { key: 'custom', label: 'Custom', range: null },
]

// The journal list's filters (round 4), remembered per browser. Read in an effect — never
// while rendering — and every access guarded, since storage can be blocked or missing.
const JOURNAL_FILTERS_KEY = 'oscenia.journalFilters'
const loadJournalFilters = () => {
  try { return cleanJournalFilters(JSON.parse(localStorage.getItem(JOURNAL_FILTERS_KEY) || 'null')) } catch { return null }
}
const saveJournalFilters = (v) => { try { localStorage.setItem(JOURNAL_FILTERS_KEY, JSON.stringify(v)) } catch { /* not remembered */ } }

const SOURCE_LABEL = {
  invoice: 'Invoice', po: 'Purchase / Vendor', pettycash: 'Petty Cash',
  warehouse: 'Warehouse', payroll: 'Payroll', manual: 'Manual',
  opening: 'Opening Balance', reversal: 'Reversal', adjustment: 'Adjustment',
  depreciation: 'Depreciation', payment: 'Applied Payment',
}

function StatementRow({ label, amount, bold, accent, indent, note, onClick }) {
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag
      onClick={onClick}
      className={`w-full flex items-center justify-between gap-4 py-2 text-left ${
        bold ? 'border-t border-white/10 mt-1 pt-3' : ''
      } ${onClick ? 'group hover:bg-white/[0.03] rounded px-1 -mx-1 transition-colors' : ''}`}
    >
      <span className={`text-sm ${indent ? 'pl-3' : ''} ${bold ? 'font-medium text-white' : 'text-white/65'}`}>
        {label}
        {note && <span className="ml-2 text-[10px] uppercase tracking-wider text-gold/50">{note}</span>}
        {onClick && (
          <ChevronRight size={12} className="ml-1 inline text-transparent group-hover:text-gold/70 transition-colors" />
        )}
      </span>
      <span className={`text-sm tabular-nums shrink-0 ${accent || (bold ? 'text-white' : 'text-white/80')}`}>
        {money2(amount)}
      </span>
    </Tag>
  )
}

// ---------------------------------------------------------------------------
// Manual / adjusting journal entry — the stacked debit/credit form from the
// client's first mockup, including the live BALANCED badge.
//
// Round 2 adds an Applied Payment / Bill Payment mode: pick an open receivable
// or payable and the form pre-fills the settlement, then records the link so
// the two documents stay joined in the ledger history.
// ---------------------------------------------------------------------------
const BLANK_LINE = { account: '', debit: '', credit: '', note: '' }

const APPLY_MODES = {
  ar: {
    key: 'ar', label: 'Applied Payment (AR)', control: '1201', side: 'debit',
    cash: '1101', blurb: 'Settle an open client invoice. Cash in, receivable cleared.',
  },
  ap: {
    key: 'ap', label: 'Bill Payment (AP)', control: '2102', side: 'credit',
    cash: '1101', blurb: 'Settle an open vendor bill. Payable cleared, cash out.',
  },
}

function JournalEntryModal({ onClose, adjusting }) {
  const projects = useStore((s) => s.projects)
  const journal = useStore((s) => s.journal)
  const postEntry = useStore((s) => s.postManualEntry)
  const adjustJournalEntry = useStore((s) => s.adjustEntryDocument)
  const t = useT()

  const [mode, setMode] = useState('manual')
  const [applyTo, setApplyTo] = useState('')
  // Which document this entry belongs to. Blank means it stands on its own and anchors a
  // code of its own. An adjustment is never asked: it inherits the original's, in the store.
  const [groupRef, setGroupRef] = useState('')
  const [date, setDate] = useState(adjusting?.date || appToday())
  // Round 4: the date printed on the receipt, beside the date it was received (`date`, which
  // posts and which every report reads). Optional; it rides on the entry's source.
  const [documentDate, setDocumentDate] = useState(adjusting?.source?.documentDate || '')
  const [memo, setMemo] = useState(adjusting ? `Adjustment of ${adjusting.id}` : '')
  const [project, setProject] = useState(adjusting?.project || '')
  const [lines, setLines] = useState(() =>
    adjusting
      ? adjusting.lines.map((l) => ({
        account: l.account,
        debit: l.debit ? String(l.debit) : '',
        credit: l.credit ? String(l.credit) : '',
        note: l.note || '',
      }))
      : [{ ...BLANK_LINE }, { ...BLANK_LINE }]
  )

  // Every code in use, so a later entry can be filed under the document it belongs to
  // instead of becoming another number nobody connects to the first.
  const codes = useMemo(() => journalCodes(journal), [journal])
  const pickedCode = codes.find((c) => c.code === groupRef.trim()) || null

  const cfg = APPLY_MODES[mode]
  const open = useMemo(
    () => (cfg ? openItems(journal, { control: cfg.control, side: cfg.side }) : []),
    [journal, cfg]
  )

  // Selecting a document writes the settlement into the line editor rather than
  // posting behind the user's back — they can still adjust it before posting,
  // which matters when a client pays part of an invoice.
  const applyDocument = (entryId) => {
    setApplyTo(entryId)
    const item = open.find((o) => o.entry.id === entryId)
    if (!item) return
    const amount = Math.round(item.outstanding)
    setDate(appToday())
    setMemo(`${mode === 'ar' ? 'Payment received against' : 'Bill payment against'} ${item.entry.voucherNo || item.entry.id}`)
    setProject(item.entry.project || '')
    setLines(mode === 'ar'
      ? [
        { account: cfg.cash, debit: String(amount), credit: '', note: 'Settlement received' },
        { account: cfg.control, debit: '', credit: String(amount), note: `Clears ${item.entry.voucherNo || item.entry.id}` },
      ]
      : [
        { account: cfg.control, debit: String(amount), credit: '', note: `Clears ${item.entry.voucherNo || item.entry.id}` },
        { account: cfg.cash, debit: '', credit: String(amount), note: 'Paid to vendor' },
      ])
  }

  const setLine = (i, patch) => setLines((arr) => arr.map((l, idx) => (idx === i ? { ...l, ...patch } : l)))
  const addLine = () => setLines((arr) => [...arr, { ...BLANK_LINE }])
  const removeLine = (i) => setLines((arr) => (arr.length > 2 ? arr.filter((_, idx) => idx !== i) : arr))

  const clean = lines
    .filter((l) => l.account && (Number(l.debit) > 0 || Number(l.credit) > 0))
    .map((l) => ({
      account: l.account,
      debit: Number(l.debit) || 0,
      credit: Number(l.credit) || 0,
      note: l.note,
    }))

  const totalDebit = clean.reduce((a, l) => a + l.debit, 0)
  const totalCredit = clean.reduce((a, l) => a + l.credit, 0)
  const draft = { date, memo, project: project || null, lines: clean }
  const needsDocument = mode !== 'manual' && !applyTo
  // A posted entry is immutable, so a mistyped code can never be repaired — the entry would
  // sit alone in a group forever. The server refuses one too; this says so before the trip.
  const badCode = Boolean(groupRef.trim()) && !pickedCode
  const valid = entryIsValid(draft) && memo.trim().length > 0 && !needsDocument && !badCode
  const balanced = clean.length > 0 && isBalanced({ lines: clean })

  const submit = () => {
    if (!valid) return
    const receipt = documentDate ? { documentDate } : {}
    if (adjusting) {
      adjustJournalEntry(adjusting.id, { ...draft, ...receipt })
    } else {
      postEntry({
        ...draft,
        groupRef: groupRef.trim() || null,
        source: mode === 'manual'
          ? { kind: 'manual', ref: null, ...receipt }
          // `ref` is the journal entry being settled, not a document id — the
          // document itself is reachable through that entry's own source.
          : { kind: 'payment', ref: applyTo, ...receipt },
        appliedTo: applyTo ? [applyTo] : [],
      })
    }
    onClose()
  }

  return (
    <Modal
      title={adjusting ? `Adjust ${adjusting.id}` : 'New Journal Entry'}
      subtitle={adjusting
        ? t('Reverses the original and posts a corrected entry — the original stays in the ledger.')
        : t('Asset depreciation, accruals and balance corrections. Debits must equal credits.')}
      size="2xl"
      onClose={onClose}
      footer={
        <>
          <div className="mr-auto flex items-center gap-3 text-xs">
            <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono font-semibold ${
              balanced
                ? 'border-emerald-700 bg-emerald-950/80 text-emerald-300'
                : 'border-amber-700 bg-amber-950/60 text-amber-300'
            }`}>
              {balanced ? <><Check size={13} /> BALANCED</> : <><AlertTriangle size={13} /> OUT BY {money(Math.abs(totalDebit - totalCredit))}</>}
            </span>
          </div>
          <button onClick={onClose} className="btn-ghost">{t('Cancel')}</button>
          <button onClick={submit} disabled={!valid} className="btn-gold">
            <Plus size={14} /> {adjusting ? t('Post adjustment') : t('Post entry')}
          </button>
        </>
      }
    >
      {/* Transaction linking (round 2). An adjustment is already bound to its
          original, so the mode switch only appears on a fresh entry. */}
      {!adjusting && (
        <>
          <div className="flex flex-wrap gap-2">
            <FilterPill active={mode === 'manual'} onClick={() => { setMode('manual'); setApplyTo('') }}>
              {t('Manual entry')}
            </FilterPill>
            {Object.values(APPLY_MODES).map((m) => (
              <FilterPill key={m.key} active={mode === m.key} onClick={() => { setMode(m.key); setApplyTo('') }}>
                {t(m.label)}
              </FilterPill>
            ))}
          </div>

          {cfg && (
            <div className="rounded-lg border border-gold/25 bg-gold/[0.04] p-3 space-y-2">
              <div className="flex items-center gap-1.5 text-[11px] text-gold-light">
                <Link2 size={13} /> {t(cfg.blurb)}
              </div>
              <Select value={applyTo} onChange={(e) => applyDocument(e.target.value)}>
                <option value="">— {t('select an open document')} —</option>
                {open.map((o) => (
                  <option key={o.entry.id} value={o.entry.id}>
                    {(o.entry.voucherNo || o.entry.id)} · {o.entry.memo} · {t('outstanding')} {money2(o.outstanding)}
                  </option>
                ))}
              </Select>
              {!open.length && (
                <div className="text-[11px] text-white/35">
                  {t('Nothing is outstanding on account')} {cfg.control}.
                </div>
              )}
            </div>
          )}
        </>
      )}

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Field label="Date received (used in reports)">
          <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Date on receipt" hint={t('Optional — the date printed on the receipt or invoice')}>
          <TextInput type="date" value={documentDate} onChange={(e) => setDocumentDate(e.target.value)} />
        </Field>
        <Field label="Project ID" hint={t('Optional — leave blank for overheads')}>
          <Select value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">— {t('none')} —</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}
          </Select>
        </Field>
        <Field label="Memo">
          <TextInput value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="e.g. Q3 equipment depreciation" />
        </Field>
      </div>

      {/* Journal code. The client's complaint was a proliferation of voucher numbers: one
          event ending up as two or three unrelated-looking documents. This entry keeps its
          own number — an auditor needs the correction as its own filed document — and files
          under the code of the document it belongs to, which is what reconciliation reads.
          A datalist rather than a <select>: there is one code per posted entry, so the list
          is long enough that it has to be typed into as well as picked from. */}
      {!adjusting && (
        <Field
          label="Journal code"
          hint={t('Optional — leave blank to start a new document')}
        >
          <TextInput
            list="journal-codes"
            value={groupRef}
            onChange={(e) => setGroupRef(e.target.value)}
            placeholder={t('Search a voucher this belongs to')}
          />
          <datalist id="journal-codes">
            {codes.map((c) => (
              <option key={c.code} value={c.code}>{`${c.date} · ${c.memo}`}</option>
            ))}
          </datalist>
          {groupRef.trim() && (
            pickedCode ? (
              <div className="mt-1.5 text-[11px] text-emerald-300">
                {t('Files under')} {pickedCode.code} — {pickedCode.memo}
                {pickedCode.count > 1 && ` · ${pickedCode.count} ${t('documents')}`}
              </div>
            ) : (
              <div className="mt-1.5 text-[11px] text-amber-300">
                {t('No document carries that code. Pick one from the list — a code cannot be corrected once posted.')}
              </div>
            )
          )}
        </Field>
      )}

      <div className="text-[11px] uppercase tracking-wider text-white/35 pt-2">{t('Entry Lines')}</div>

      <div className="space-y-2">
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-12 gap-2 items-start">
            <div className="col-span-12 sm:col-span-5">
              <Select value={l.account} onChange={(e) => setLine(i, { account: e.target.value })}>
                <option value="">— {t('select account')} —</option>
                {ACCOUNT_GROUPS.map((g) => (
                  <optgroup key={g.label} label={g.label}>
                    {g.codes.map((c) => <option key={c} value={c}>{accountLabel(c)}</option>)}
                  </optgroup>
                ))}
              </Select>
              <TextInput
                className="mt-1.5 text-xs"
                value={l.note}
                onChange={(e) => setLine(i, { note: e.target.value })}
                placeholder="Line description"
              />
            </div>
            <div className="col-span-5 sm:col-span-3">
              <NumberInput
                value={l.debit}
                onChange={(e) => setLine(i, { debit: e.target.value, credit: '' })}
                placeholder="Debit"
              />
            </div>
            <div className="col-span-5 sm:col-span-3">
              <NumberInput
                value={l.credit}
                onChange={(e) => setLine(i, { credit: e.target.value, debit: '' })}
                placeholder="Credit"
              />
            </div>
            <div className="col-span-2 sm:col-span-1 flex justify-end pt-2">
              <button
                onClick={() => removeLine(i)}
                disabled={lines.length <= 2}
                className="text-white/30 hover:text-rose-300 disabled:opacity-25 disabled:hover:text-white/30"
                aria-label="Remove line"
              >
                <Trash2 size={15} />
              </button>
            </div>
          </div>
        ))}
      </div>

      <button onClick={addLine} className="btn-ghost text-xs py-1.5"><Plus size={13} /> {t('Add line')}</button>

      <div className="grid grid-cols-3 gap-2 border-t border-white/10 pt-3 text-sm">
        <span className="text-white/50">{t('Totals')}</span>
        <span className="text-right tabular-nums text-emerald-300">{num2(totalDebit)}</span>
        <span className="text-right tabular-nums text-sky-300">{num2(totalCredit)}</span>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Everything a printed voucher needs that the entry itself does not carry:
// who the counterparty was, and which bank account the money moved through.
// ---------------------------------------------------------------------------
function useVoucherContext() {
  const projects = useStore((s) => s.projects)
  const invoices = useStore((s) => s.invoices)
  const procurement = useStore((s) => s.procurement)
  const purchaseOrders = useStore((s) => s.purchaseOrders)
  const vendors = useStore((s) => s.vendors)
  const journal = useStore((s) => s.journal)

  return (entry) => {
    const src = entry.source || {}
    const project = projects.find((p) => p.id === entry.project)

    let counterparty = '—'
    if (src.kind === 'invoice') {
      counterparty = project?.client || invoices.find((i) => i.id === src.ref)?.project || '—'
    } else if (src.kind === 'po') {
      const po = purchaseOrders.find((p) => p.id === src.ref)
      counterparty = vendors.find((v) => v.id === po?.vendorId)?.name || src.ref || '—'
    } else if (src.kind === 'pettycash') {
      counterparty = procurement.find((r) => r.id === src.ref)?.by || '—'
    } else if (src.kind === 'payroll') {
      counterparty = 'Crew & staff'
    }

    // The cash account the entry actually moved, so "source bank account" on
    // the voucher is the real one rather than a hardcoded default.
    const cashLine = (entry.lines || []).find((l) => account(l.account).cash)
    const net = (entry.lines || []).reduce((a, l) => {
      if (!account(l.account).cash) return a
      return a + (Number(l.debit) || 0) - (Number(l.credit) || 0)
    }, 0)

    const links = linkedEntries(journal, entry.id)
    const settledBy = links.settledBy.find((e) => !e.reversedBy)

    return {
      kind: net > 0 ? 'cash-in' : net < 0 ? 'cash-out' : 'accrual',
      accountName: accountLabel,
      projectName: project?.name,
      counterparty,
      bankAccount: cashLine ? accountLabel(cashLine.account) : '—',
      crossRef: settledBy
        ? { voucherNo: settledBy.voucherNo, id: settledBy.id, date: settledBy.date, memo: settledBy.memo }
        : null,
    }
  }
}

// ---------------------------------------------------------------------------
// Drill-down: the full entry, its source document, and what it is linked to.
// ---------------------------------------------------------------------------
function EntryDetailModal({ entry, onClose, onAdjust }) {
  const invoices = useStore((s) => s.invoices)
  const procurement = useStore((s) => s.procurement)
  const deliveryOrders = useStore((s) => s.deliveryOrders)
  const projects = useStore((s) => s.projects)
  const journal = useStore((s) => s.journal)
  const role = useStore((s) => s.role)
  const reverseJournalEntry = useStore((s) => s.reverseEntryDocument)
  const voucherContext = useVoucherContext()
  const t = useT()

  const src = entry.source || {}
  const doc = useMemo(() => {
    if (src.kind === 'invoice') {
      const inv = invoices.find((i) => i.id === src.ref)
      if (!inv) return null
      return {
        heading: `Invoice ${inv.id}`,
        rows: [
          ['Type', inv.type], ['Project', inv.project],
          ['Amount', money2(inv.amount)], ['Status', inv.status], ['Due', inv.due],
        ],
      }
    }
    if (src.kind === 'pettycash') {
      const req = procurement.find((r) => r.id === src.ref)
      if (!req) return null
      return {
        heading: `Request ${req.id}`,
        rows: [
          ['Category', req.category], ['Project', req.project],
          ['Amount', money2(req.amount)], ['Submitted by', req.by], ['Status', req.status],
        ],
      }
    }
    if (src.kind === 'warehouse') {
      const order = deliveryOrders.find((d) => d.id === src.ref)
      if (order) {
        return {
          heading: `Delivery Order ${order.id}`,
          rows: [
            ['Project', order.project], ['Status', order.status],
            ['Items', String(order.lines?.length ?? 0)], ['Event date', order.eventDate || '—'],
          ],
        }
      }
      return { heading: `Stock item ${src.ref}`, rows: [['Reference', src.ref]] }
    }
    return null
  }, [src, invoices, procurement, deliveryOrders])

  const links = useMemo(() => linkedEntries(journal, entry.id), [journal, entry.id])
  // Everything filed under the same journal code: the original and every correction to it.
  const siblings = useMemo(
    () => groupedEntries(journal, groupCode(entry)).filter((e) => e.id !== entry.id),
    [journal, entry]
  )
  const project = projects.find((p) => p.id === entry.project)
  const balanced = isBalanced(entry)

  return (
    <Modal
      title={entry.voucherNo || entry.id}
      subtitle={entry.memo}
      size="2xl"
      onClose={onClose}
      footer={
        <>
          {entry.reversedBy && (
            <span className="mr-auto text-xs text-rose-300 inline-flex items-center gap-1.5">
              <RotateCcw size={13} /> {t('Reversed by')} {entry.reversedBy}
            </span>
          )}
          <button onClick={onClose} className="btn-ghost">{t('Close')}</button>
          <button onClick={() => journalVoucherPDF(entry, voucherContext(entry))} className="btn-ghost">
            <Printer size={14} /> {t('Print voucher')}
          </button>
          {!entry.reversedBy && src.kind !== 'opening' && (
            <>
              <ActionButton
                action="post_journal"
                role={role}
                onClick={() => { reverseJournalEntry(entry.id); onClose() }}
                className="btn-ghost disabled:opacity-30"
              >
                <RotateCcw size={14} /> {t('Reverse')}
              </ActionButton>
              <ActionButton action="post_journal" role={role} onClick={() => onAdjust(entry)} className="btn-gold disabled:opacity-30">
                {t('Adjust')}
              </ActionButton>
            </>
          )}
        </>
      }
    >
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 rounded-lg border border-white/10 bg-navy-900/80 p-3 text-[11px]">
        <div>
          <span className="block text-[9px] uppercase tracking-wider text-white/35">{t('Journal ref')}</span>
          <strong className="text-white/85">{entry.id}</strong>
        </div>
        <div>
          <span className="block text-[9px] uppercase tracking-wider text-white/35">{t('Project ID')}</span>
          <strong className="font-mono text-gold/80">{entry.project || '—'}</strong>
        </div>
        <div>
          <span className="block text-[9px] uppercase tracking-wider text-white/35">{t('Date received')}</span>
          <strong className="text-white/85">{entry.date}</strong>
          {src.documentDate && (
            <span className="mt-0.5 block text-[10px] text-white/45">{t('On receipt')}: {src.documentDate}</span>
          )}
        </div>
        <div>
          <span className="block text-[9px] uppercase tracking-wider text-white/35">{t('Source')}</span>
          <strong className="text-white/85">{SOURCE_LABEL[src.kind] || src.kind}</strong>
        </div>
        <div>
          <span className="block text-[9px] uppercase tracking-wider text-white/35">{t('Status')}</span>
          <strong className={balanced ? 'text-emerald-300' : 'text-rose-300'}>
            {balanced ? 'BALANCED' : 'OUT OF BALANCE'}
          </strong>
        </div>
      </div>

      {project && <div className="text-xs text-white/45">{project.name} · {project.client}</div>}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[480px] text-left font-mono">
          <thead>
            <tr className="border-b border-white/10 text-[9px] uppercase tracking-wider text-white/40">
              <th className="py-1.5 pr-2">{t('Account & Description')}</th>
              <th className="py-1.5 px-2 text-right">{t('Debit')}</th>
              <th className="py-1.5 pl-2 text-right">{t('Credit')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5 text-[11px]">
            {entry.lines.map((l, i) => (
              <tr key={i}>
                <td className="py-2 pr-2">
                  <div className="text-white/90">{accountLabel(l.account)}</div>
                  {l.note && <div className="text-[9px] text-white/40">{l.note}</div>}
                </td>
                <td className="py-2 px-2 text-right text-emerald-300">{l.debit ? num2(l.debit) : '-'}</td>
                <td className="py-2 pl-2 text-right text-sky-300">{l.credit ? num2(l.credit) : '-'}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-white/20 text-[11px] font-bold">
              <td className="py-2 pr-2 uppercase text-white/60">{t('Total')}</td>
              <td className="py-2 px-2 text-right text-emerald-300">{num2(entryDebit(entry))}</td>
              <td className="py-2 pl-2 text-right text-emerald-300">{num2(entryCredit(entry))}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* One journal code, several filed documents. A reverse-and-repost is three numbered
          vouchers and one correction; before this there was no way to see the second fact,
          which is what made the General Ledger read as a proliferation of numbers. */}
      {siblings.length > 0 && (
        <div className="rounded-lg border border-gold/25 bg-gold/[0.04] p-3">
          <div className="flex items-center gap-2 mb-2 text-gold-light">
            <Hash size={14} />
            <span className="text-xs font-medium">{t('Journal code')} {groupCode(entry)}</span>
            <span className="ml-auto text-[10px] text-white/40">
              {siblings.length + 1} {t('documents')}
            </span>
          </div>
          <div className="space-y-1.5">
            {siblings.map((e) => (
              <div key={e.id} className="flex flex-wrap justify-between gap-2 text-[11px]">
                <span className="text-white/40">
                  {e.groupRef ? t('Correction') : t('Original')}
                </span>
                <span className={e.reversedBy ? 'text-white/35 line-through' : 'text-white/85'}>
                  {e.voucherNo || e.id} · {e.date} · {e.memo}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Inter-document linking. The client asked that the billing document and
          the payment proof form "an intact General Ledger history" — this is
          both ends of that chain, from whichever end you opened. */}
      {(links.settles.length > 0 || links.settledBy.length > 0) && (
        <div className="rounded-lg border border-sky-500/25 bg-sky-500/[0.04] p-3">
          <div className="flex items-center gap-2 mb-2 text-sky-200">
            <Link2 size={14} />
            <span className="text-xs font-medium">{t('Linked documents')}</span>
          </div>
          <div className="space-y-1.5">
            {links.settles.map((e) => (
              <div key={e.id} className="flex flex-wrap justify-between gap-2 text-[11px]">
                <span className="text-white/40">{t('Applied against')}</span>
                <span className="text-white/85">{e.voucherNo || e.id} · {e.memo}</span>
              </div>
            ))}
            {links.settledBy.map((e) => (
              <div key={e.id} className="flex flex-wrap justify-between gap-2 text-[11px]">
                <span className="text-white/40">{t('Settled by')}</span>
                <span className={e.reversedBy ? 'text-white/35 line-through' : 'text-white/85'}>
                  {e.voucherNo || e.id} · {e.date} · {money2(entryDebit(e))}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Source document — clicking an entry number opens the original receipt
          or invoice behind it. */}
      <div className="rounded-lg border border-gold/25 bg-gold/[0.04] p-3">
        <div className="flex items-center gap-2 mb-2 text-gold-light">
          <FileText size={14} />
          <span className="text-xs font-medium">{doc ? doc.heading : t('Source document')}</span>
        </div>
        {doc ? (
          <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1.5">
            {doc.rows.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3 text-[11px]">
                <span className="text-white/40">{t(k)}</span>
                <span className="text-white/85 text-right">{v}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-[11px] text-white/40">
            {src.kind === 'opening'
              ? t('Opening balances carried forward — no source document.')
              : t('No linked document for this entry.')}
          </div>
        )}
      </div>

      {/* The no-deletion policy, stated on the record it protects. */}
      <div className="flex items-start gap-2 rounded-lg border border-white/10 bg-white/[0.02] p-3 text-[11px] text-white/45">
        <ShieldCheck size={14} className="text-emerald-400/70 shrink-0 mt-0.5" />
        <span>
          {t('Posted entries cannot be deleted. A correction is a reversal plus a re-posting, so the original stays visible and the audit trail survives.')}
        </span>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Tax settings — configurable rates with manual override.
// ---------------------------------------------------------------------------
function TaxSettings() {
  const taxConfig = useStore((s) => s.taxConfig)
  const setTaxRate = useStore((s) => s.setTaxRate)
  const toggleTax = useStore((s) => s.toggleTax)
  const role = useStore((s) => s.role)
  const t = useT()

  return (
    <Card className="border-gold/25">
      <div className="flex items-center gap-2 mb-1">
        <Calculator size={16} className="text-gold-light" />
        <div className="eyebrow">{t('Tax Configuration')}</div>
      </div>
      <div className="text-xs text-white/45 mb-4">
        {t('Rates are editable. Changing one immediately moves Tax Expense and NPAT.')}
      </div>
      <div className="space-y-2">
        {Object.entries(taxConfig).map(([key, cfg]) => (
          <div key={key} className="flex flex-wrap items-center gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2">
            <ActionButton
              action="edit_tax"
              role={role}
              onClick={() => toggleTax(key)}
              className={`grid h-5 w-5 shrink-0 place-items-center rounded border transition-colors disabled:opacity-40 ${
                cfg.active ? 'border-gold bg-gold text-navy-950' : 'border-white/25 text-transparent'
              }`}
              aria-label={`Toggle ${cfg.label}`}
            >
              <Check size={13} />
            </ActionButton>
            <span className={`flex-1 min-w-[150px] text-sm ${cfg.active ? 'text-white/85' : 'text-white/35'}`}>
              {cfg.label}
            </span>
            {cfg.account && <span className="font-mono text-[10px] text-gold/60">{cfg.account}</span>}
            <div className="flex items-center gap-1">
              <input
                type="number"
                step="0.5"
                value={cfg.rate}
                onChange={(e) => setTaxRate(key, e.target.value)}
                disabled={!cfg.active}
                className="w-16 rounded-md border border-white/10 bg-navy-900 px-2 py-1 text-right text-sm tabular-nums text-white/85 focus:border-gold/50 outline-none disabled:opacity-40"
              />
              <span className="text-xs text-white/40">%</span>
            </div>
          </div>
        ))}
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Voucher numbering — administrator control over the document numbering scheme.
// ---------------------------------------------------------------------------
const BLANK_SERIES = {
  key: '', prefix: '', label: '', hint: '',
  format: '[PREFIX]-[MONTH]-[DATE]-[SEQ_001]', reset: 'monthly',
}

function VoucherSeriesModal({ onClose }) {
  const voucherSeries = useStore((s) => s.voucherSeries)
  const voucherCounters = useStore((s) => s.voucherCounters)
  const updateVoucherSeries = useStore((s) => s.updateVoucherSeries)
  const addVoucherSeries = useStore((s) => s.addVoucherSeries)
  const deleteVoucherSeries = useStore((s) => s.deleteVoucherSeries)
  const seriesUsage = useStore((s) => s.seriesUsage)
  const t = useT()

  const [draft, setDraft] = useState(null)
  const setField = (patch) => setDraft((d) => ({ ...d, ...patch }))
  const draftError = draft ? seriesDraftError(draft, voucherSeries) : null

  return (
    <Modal
      title="Voucher Numbering"
      subtitle={t('Prefixes and formats per transaction class. Numbers already issued are never rewritten — a filed voucher keeps the number it was filed under.')}
      size="2xl"
      onClose={onClose}
      footer={<button onClick={onClose} className="btn-gold">{t('Done')}</button>}
    >
      <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3 text-[11px] text-white/50">
        <div className="text-[10px] uppercase tracking-wider text-white/35 mb-1.5">{t('Format tokens')}</div>
        <div className="grid sm:grid-cols-3 gap-x-6 gap-y-1 font-mono">
          <span>[PREFIX]</span><span>[MONTH] · [MON]</span><span>[DATE]</span>
          <span>[YEAR] · [YY]</span><span>[SEQ_001]</span><span className="text-white/30">{t('anything else is literal')}</span>
        </div>
      </div>

      <div className="space-y-2">
        {voucherSeries.map((s) => {
          const next = (voucherCounters[counterKey(s, appToday())] || 0) + 1
          // On live data the only authority on the next number is the server that allocates
          // it; `voucherCounters` is seed state and would preview a number that is not next.
          const preview = s.nextPreview || previewVoucher(s, appToday(), next)
          const used = seriesUsage(s.key)
          return (
            <div key={s.key} className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <span className="inline-flex items-center gap-1.5 rounded-md border border-gold/30 bg-gold/10 px-2 py-0.5 font-mono text-[11px] text-gold-light">
                  <Hash size={10} />{s.prefix}
                </span>
                <span className="text-sm text-white/85">{s.label}</span>
                <span className="text-[10px] text-white/30">{s.hint}</span>
                <span className="ml-auto font-mono text-[11px] text-emerald-300">{preview}</span>
                {/* Deletable only while nothing has been numbered from it — a typo, in other
                    words. A voucher number has to stay resolvable for as long as its entry
                    does, so a series with history is never removed. */}
                <button
                  onClick={() => deleteVoucherSeries(s.key)}
                  disabled={used > 0}
                  title={used > 0
                    ? `${used} entries were numbered from ${s.prefix}`
                    : `Delete ${s.label}`}
                  className="rounded-md border border-white/10 p-1 text-white/40 hover:border-rose-500/40 hover:text-rose-300 disabled:opacity-25 disabled:hover:border-white/10 disabled:hover:text-white/40"
                >
                  <Trash2 size={12} />
                </button>
              </div>
              <div className="grid sm:grid-cols-3 gap-2">
                <Field label="Prefix">
                  <TextInput
                    value={s.prefix}
                    onChange={(e) => updateVoucherSeries(s.key, { prefix: e.target.value })}
                  />
                </Field>
                <Field label="Format">
                  <TextInput
                    value={s.format}
                    onChange={(e) => updateVoucherSeries(s.key, { format: e.target.value })}
                  />
                </Field>
                <Field label="Sequence resets" hint={`${t('next')} #${next}`}>
                  <Select value={s.reset} onChange={(e) => updateVoucherSeries(s.key, { reset: e.target.value })}>
                    {RESET_PERIODS.map((r) => <option key={r.key} value={r.key}>{t(r.label)}</option>)}
                  </Select>
                </Field>
              </div>
            </div>
          )
        })}
      </div>

      {/* The seven classes above were fixed; the client asked to define their own. */}
      {draft ? (
        <div className="rounded-lg border border-gold/25 bg-gold/[0.04] p-3 space-y-2">
          <div className="grid sm:grid-cols-3 gap-2">
            <Field label="Key" hint={t('lowercase, e.g. pc')}>
              <TextInput value={draft.key} onChange={(e) => setField({ key: e.target.value })} />
            </Field>
            <Field label="Prefix">
              <TextInput value={draft.prefix} onChange={(e) => setField({ prefix: e.target.value })} placeholder="PC" />
            </Field>
            <Field label="Label">
              <TextInput value={draft.label} onChange={(e) => setField({ label: e.target.value })} placeholder="Project Close" />
            </Field>
            <Field label="Format">
              <TextInput value={draft.format} onChange={(e) => setField({ format: e.target.value })} />
            </Field>
            <Field label="Sequence resets">
              <Select value={draft.reset} onChange={(e) => setField({ reset: e.target.value })}>
                {RESET_PERIODS.map((r) => <option key={r.key} value={r.key}>{t(r.label)}</option>)}
              </Select>
            </Field>
            <Field label="Hint" hint={t('Optional')}>
              <TextInput value={draft.hint} onChange={(e) => setField({ hint: e.target.value })} />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {draftError
              ? <span className="text-[11px] text-amber-300">{draftError}</span>
              : <span className="font-mono text-[11px] text-emerald-300">{previewVoucher(draft, appToday(), 1)}</span>}
            <button onClick={() => setDraft(null)} className="btn-ghost ml-auto">{t('Cancel')}</button>
            <button
              onClick={() => { if (addVoucherSeries(draft) !== null) setDraft(null) }}
              disabled={Boolean(draftError)}
              className="btn-gold"
            >
              <Plus size={14} /> {t('Add series')}
            </button>
          </div>
        </div>
      ) : (
        <button onClick={() => setDraft({ ...BLANK_SERIES })} className="btn-ghost self-start">
          <Plus size={14} /> {t('Add series')}
        </button>
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// General Ledger — the multi-dimensional filter view.
// ---------------------------------------------------------------------------
function GeneralLedgerTab({ journal, period, project, accountFilter, onOpenEntry }) {
  const t = useT()

  const codes = accountFilter === 'all' ? null : [accountFilter]
  const gl = useMemo(
    () => generalLedger(journal, { codes, period, project }),
    [journal, accountFilter, period, project] // eslint-disable-line react-hooks/exhaustive-deps
  )

  // A single account reads in its own natural direction, so a liability with a
  // credit balance shows positive. Consolidated across accounts there is no
  // single natural direction, so the column stays a raw net debit and says so.
  const single = accountFilter !== 'all'
  const flip = single && normalSide(accountFilter) === 'credit' ? -1 : 1
  const balanceLabel = single ? t('Balance') : t('Net (Dr − Cr)')

  const exportRows = gl.rows.map((r) => ({
    voucher: r.entry.voucherNo || r.entry.id,
    entry: r.entry.id,
    date: r.entry.date,
    account: accountLabel(r.account),
    memo: r.entry.memo,
    note: r.note || '',
    project: r.entry.project || '',
    debit: r.debit,
    credit: r.credit,
    balance: r.balance * flip,
  }))
  const exportCols = [
    { key: 'voucher', label: 'Voucher No.' }, { key: 'entry', label: 'Journal Ref' },
    { key: 'date', label: 'Date' }, { key: 'account', label: 'Account' },
    { key: 'memo', label: 'Memo' }, { key: 'note', label: 'Line note' },
    { key: 'project', label: 'Project ID' }, { key: 'debit', label: 'Debit' },
    { key: 'credit', label: 'Credit' }, { key: 'balance', label: 'Balance' },
  ]
  const exportName = `GL_${single ? accountFilter : 'ALL'}_${period?.from || 'start'}_${period?.to || 'end'}`
  const exportTitle = `General Ledger — ${single ? accountLabel(accountFilter) : 'All accounts'}`

  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
        <Card>
          <div className="text-xs text-white/40">{t('Opening balance')}</div>
          <div className="mt-1 font-display text-lg text-white/70 tabular-nums">{money2(gl.opening * flip)}</div>
          <div className="text-[10px] text-white/30 mt-0.5">
            {period?.from ? `${t('before')} ${period.from}` : t('no earlier period')}
          </div>
        </Card>
        <Card>
          <div className="text-xs text-white/40">{t('Period debits')}</div>
          <div className="mt-1 font-display text-lg text-emerald-300 tabular-nums">{money2(gl.totalDebit)}</div>
        </Card>
        <Card>
          <div className="text-xs text-white/40">{t('Period credits')}</div>
          <div className="mt-1 font-display text-lg text-sky-300 tabular-nums">{money2(gl.totalCredit)}</div>
        </Card>
        <Card className="border-gold/30">
          <div className="text-xs text-white/40">{t('Closing balance')}</div>
          <div className="mt-1 font-display text-lg text-gold-light tabular-nums">{money2(gl.closing * flip)}</div>
          <div className="text-[10px] text-white/30 mt-0.5">{gl.rows.length} {t('movements')}</div>
        </Card>
      </div>

      <SectionTitle
        icon={Library}
        actions={
          <>
            <button onClick={() => exportCSV(exportName, exportCols, exportRows, { title: exportTitle })} className="btn-ghost text-xs py-1.5">
              <Download size={13} /> CSV
            </button>
            <button onClick={() => exportExcel(exportName, exportCols, exportRows, { title: exportTitle })} className="btn-ghost text-xs py-1.5">
              <Download size={13} /> Excel
            </button>
          </>
        }
      >
        {single ? accountLabel(accountFilter) : t('All accounts consolidated')}
      </SectionTitle>

      <TableWrap>
        <thead>
          <tr>
            <th className="th">{t('Voucher No.')}</th>
            <th className="th">{t('Date')}</th>
            {!single && <th className="th">{t('Account')}</th>}
            <th className="th">{t('Description')}</th>
            <th className="th">{t('Project ID')}</th>
            <th className="th text-right">{t('Debit')}</th>
            <th className="th text-right">{t('Credit')}</th>
            <th className="th text-right">{balanceLabel}</th>
          </tr>
        </thead>
        <tbody>
          <tr className="bg-white/[0.02]">
            <td className="td text-white/40 text-xs" colSpan={single ? 5 : 6}>{t('Opening balance')}</td>
            <td className="td"></td>
            <td className="td text-right tabular-nums text-white/60">{money2(gl.opening * flip)}</td>
          </tr>
          {gl.rows.map((r) => (
            <tr
              key={r.key}
              onClick={() => onOpenEntry(r.entry)}
              className="group cursor-pointer hover:bg-white/[0.03] transition-colors"
            >
              <td className="td font-mono text-[11px] text-gold/80">{r.entry.voucherNo || r.entry.id}</td>
              <td className="td text-white/50">{r.entry.date}</td>
              {!single && <td className="td text-white/70 text-xs">{accountLabel(r.account)}</td>}
              <td className="td text-white/70">
                {r.entry.memo}
                {r.note && <div className="text-[10px] text-white/35">{r.note}</div>}
              </td>
              <td className="td font-mono text-xs text-gold/70">{r.entry.project || '—'}</td>
              <td className="td text-right tabular-nums text-emerald-300">{r.debit ? money2(r.debit) : '—'}</td>
              <td className="td text-right tabular-nums text-sky-300">{r.credit ? money2(r.credit) : '—'}</td>
              <td className="td text-right tabular-nums text-white/80">{money2(r.balance * flip)}</td>
            </tr>
          ))}
          {!gl.rows.length && (
            <tr><td className="td text-white/30" colSpan={single ? 7 : 8}>{t('No movements on this account in this period.')}</td></tr>
          )}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-white/15">
            <td className="td font-medium text-white/70" colSpan={single ? 4 : 5}>{t('Closing balance')}</td>
            <td className="td text-right tabular-nums text-emerald-300">{money2(gl.totalDebit)}</td>
            <td className="td text-right tabular-nums text-sky-300">{money2(gl.totalCredit)}</td>
            <td className="td text-right tabular-nums text-gold-light">{money2(gl.closing * flip)}</td>
          </tr>
        </tfoot>
      </TableWrap>

      {!single && (
        <div className="mt-3 text-[11px] text-white/30">
          {t('Consolidated across every account, the running figure is a raw net debit — pick a single account for a balance in its own natural direction.')}
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
export default function Accounting() {
  const journal = useStore((s) => s.journal)
  const projects = useStore((s) => s.projects)
  const taxConfig = useStore((s) => s.taxConfig)
  const role = useStore((s) => s.role)
  const t = useT()

  // Deep links from the Chart of Accounts land straight on the right account.
  const [params, setParams] = useSearchParams()

  const [tab, setTab] = useState(params.get('tab') || 'journal')
  const [periodKey, setPeriodKey] = useState('ytd')
  const [custom, setCustom] = useState({ from: `${appToday().slice(0, 4)}-01-01`, to: appToday() })
  const [projectFilter, setProjectFilter] = useState('all')
  const [accountFilter, setAccountFilter] = useState(params.get('account') || 'all')
  const [summarised, setSummarised] = useState(true)
  const [entryModal, setEntryModal] = useState(false)
  const [numbering, setNumbering] = useState(false)
  const [detail, setDetail] = useState(null)
  const [adjusting, setAdjusting] = useState(null)
  // Journal list filters: type chip, hide reversed pairs (on by default), search.
  const [jf, setJf] = useState(DEFAULT_JOURNAL_FILTERS)
  const [jfLoaded, setJfLoaded] = useState(false)
  useEffect(() => {
    const saved = loadJournalFilters()
    if (saved) setJf(saved)
    setJfLoaded(true)
  }, [])
  useEffect(() => { if (jfLoaded) saveJournalFilters(jf) }, [jf, jfLoaded])
  const setFilter = (patch) => setJf((cur) => ({ ...cur, ...patch }))

  // Consume the query params once, then clear them so a later in-app tab change
  // is not fought by a stale URL.
  useEffect(() => {
    if (params.get('tab') || params.get('account')) setParams({}, { replace: true })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const period = periodKey === 'custom'
    ? custom
    : periods().find((p) => p.key === periodKey)?.range

  // Journal listing honours both filters. The statements honour the period but
  // ignore the project filter for the Balance Sheet, which is a company-level
  // statement — filtering it by project would not reconcile.
  const listed = useMemo(
    () => filterEntries(journal, { period, project: projectFilter }),
    [journal, period, projectFilter]
  )
  const scoped = useMemo(() => filterEntries(journal, { period }), [journal, period])
  // What the Journal tab lists. Only the list: every statement below reads `listed`/`scoped`.
  const view = useMemo(() => filterJournal(listed, jf), [listed, jf])
  const typeCounts = useMemo(() => {
    const visible = filterJournal(listed, { ...jf, type: 'all' }).shown
    const counts = { all: visible.length }
    for (const e of visible) counts[journalType(e)] = (counts[journalType(e)] || 0) + 1
    return counts
  }, [listed, jf])

  const clientIncome = useMemo(
    () => incomeStatementFrom(filterEntries(journal, { period, project: projectFilter }), taxConfig),
    [journal, period, projectFilter, taxConfig]
  )
  const clientBalance = useMemo(() => balanceSheetFrom(scoped, taxConfig), [scoped, taxConfig])
  const clientTb = useMemo(() => trialBalance(scoped), [scoped])
  // Tax withheld from Oscenia by clients, sitting as an asset in 1401.
  const clientPrepaid = useMemo(() => accountBalance(scoped, '1401'), [scoped])

  // Signed in, the three statements and the 1401 figure are the server's (W4); the demo keeps the
  // browser's own arithmetic. Detailed rows are asked for (the page rolls them up itself, so the drill
  // codes stay exact) and the period goes as explicit dates, so both sides cut the same window.
  const live = useStore((s) => s.hydrated)
  const projectUuid = projectFilter === 'all' ? undefined : projects.find((p) => p.id === projectFilter)?.uuid
  const win = period ? { period: 'custom', start: period.from, end: period.to } : { period: 'all' }
  const incomeReport = useReport('/reports/income-statement', { ...win, projectId: projectUuid }, adaptIncomeStatement, { enabled: live && (projectFilter === 'all' || Boolean(projectUuid)) })
  const balanceReport = useReport('/reports/balance-sheet', win, adaptBalanceSheet, { enabled: live })
  const tbReport = useReport('/reports/trial-balance', win, adaptTrialBalance, { enabled: live })
  const prepaidReport = useReport('/reports/general-ledger', { ...win, codes: ['1401'] }, (r) => Number(r.closing) - Number(r.opening), { enabled: live })
  const income = (live && incomeReport.data) || clientIncome
  const balance = (live && balanceReport.data) || clientBalance
  const tb = (live && tbReport.data) || clientTb
  const prepaidPph23 = live && prepaidReport.data != null ? prepaidReport.data : clientPrepaid
  useCrossCheck('Income statement NPAT', incomeReport.data?.npat, clientIncome.npat)
  useCrossCheck('Income statement revenue', incomeReport.data?.totalRevenue, clientIncome.totalRevenue)
  useCrossCheck('Balance sheet assets', balanceReport.data?.totalAssets, clientBalance.totalAssets)
  useCrossCheck('Balance sheet equity', balanceReport.data?.totalEquity, clientBalance.totalEquity)
  useCrossCheck('Trial balance debit', tbReport.data?.debit, clientTb.debit)
  useCrossCheck('Prepaid withholding 1401', prepaidReport.data, clientPrepaid)

  const projectIds = useMemo(() => {
    const ids = new Set(journal.map((e) => e.project).filter(Boolean))
    projects.forEach((p) => ids.add(p.id))
    return [...ids].sort()
  }, [journal, projects])

  // Drill-down from a statement line into the ledger for the accounts behind it.
  const drillTo = (codes) => {
    setAccountFilter(codes.length === 1 ? codes[0] : 'all')
    setTab('ledger')
  }

  // A statement section, summarised or detailed. Both forms drill down; the
  // summarised one just drills a whole bucket at once.
  const renderSection = (rows, type, { negate = false, accent } = {}) => {
    const shown = summarised ? rollUpByGroup(rows, type) : rows
    return shown.map((r) => (
      <StatementRow
        key={(r.code || '') + r.label}
        label={summarised ? r.label : `${r.code} · ${r.label}`}
        amount={negate ? -r.amount : r.amount}
        accent={accent}
        indent
        note={r.derived ? 'computed' : summarised && r.codes?.length > 1 ? `${r.codes.length} accounts` : null}
        onClick={r.derived ? undefined : () => drillTo(summarised ? r.codes : [r.code])}
      />
    ))
  }

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Accounting"
        title="Accounting System"
        subtitle="Multi-line double-entry bookkeeping. Every operational transaction auto-posts to the ledger, and the Income Statement and Balance Sheet are derived from it — nothing is hand-keyed."
        actions={
          <>
            <span className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium ${
              tb.balanced
                ? 'border-emerald-700/60 bg-emerald-950/50 text-emerald-300'
                : 'border-rose-700 bg-rose-950/60 text-rose-300'
            }`}>
              {tb.balanced ? <Check size={14} /> : <AlertTriangle size={14} />}
              {tb.balanced ? t('Trial balance OK') : t('Out of balance')}
            </span>
            <ActionButton action="post_journal" role={role} onClick={() => setNumbering(true)} className="btn-ghost disabled:opacity-30">
              <Hash size={15} /> {t('Numbering')}
            </ActionButton>
            <ActionButton
              action="post_journal"
              role={role}
              onClick={() => { setAdjusting(null); setEntryModal(true) }}
              className="btn-gold disabled:opacity-30"
            >
              <Plus size={15} /> {t('Add Journal Entry')}
            </ActionButton>
          </>
        }
      />

      {/* Filters — account, Project Cost Center and period, driving every tab */}
      <Card className="mb-5">
        <div className="flex flex-wrap items-end gap-4">
          {tab === 'ledger' && (
            <div className="min-w-[240px]">
              <Field label="Account (COA)">
                <Select value={accountFilter} onChange={(e) => setAccountFilter(e.target.value)}>
                  <option value="all">{t('All accounts (consolidated)')}</option>
                  {ACCOUNT_GROUPS.map((g) => (
                    <optgroup key={g.label} label={g.label}>
                      {g.codes.map((c) => <option key={c} value={c}>{accountLabel(c)}</option>)}
                    </optgroup>
                  ))}
                </Select>
              </Field>
            </div>
          )}
          <div className="min-w-[190px]">
            <Field label="Project Cost Center">
              <Select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}>
                <option value="all">{t('All projects')}</option>
                {projectIds.map((id) => <option key={id} value={id}>{id}</option>)}
              </Select>
            </Field>
          </div>
          <div className="flex-1 min-w-[240px]">
            <div className="text-[11px] uppercase tracking-wider text-white/35 mb-1.5">{t('Period · by received date')}</div>
            <div className="flex flex-wrap gap-2">
              {periods().map((p) => (
                <FilterPill key={p.key} active={periodKey === p.key} onClick={() => setPeriodKey(p.key)}>
                  {t(p.label)}
                </FilterPill>
              ))}
            </div>
          </div>
          {periodKey === 'custom' && (
            <div className="flex flex-wrap gap-2">
              <Field label="From">
                <TextInput type="date" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
              </Field>
              <Field label="To">
                <TextInput type="date" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
              </Field>
            </div>
          )}
        </div>
      </Card>

      <div className="flex flex-wrap gap-2 mb-5">
        {TABS.map((tabItem) => {
          const Icon = tabItem.icon
          return (
            <button
              key={tabItem.key}
              onClick={() => setTab(tabItem.key)}
              className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm transition-colors ${
                tab === tabItem.key ? 'bg-gold text-navy-950' : 'border border-white/15 text-white/70 hover:text-white'
              }`}
            >
              <Icon size={15} /> {t(tabItem.label)}
            </button>
          )
        })}
        {(tab === 'income' || tab === 'balance') && (
          <div className="ml-auto flex flex-wrap gap-2">
            <FilterPill active={summarised} onClick={() => setSummarised(true)}>
              <span className="inline-flex items-center gap-1"><Layers size={11} /> {t('Executive summary')}</span>
            </FilterPill>
            <FilterPill active={!summarised} onClick={() => setSummarised(false)}>{t('Detailed')}</FilterPill>
          </div>
        )}
      </div>

      {tab === 'journal' && (
        <>
          {/* Round 4: the list was "too cluttered". Narrow it by type, hide reversed pairs (an
              entry and its reversal net to zero), search. Reports never read these filters. */}
          <div className="mb-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('Type')}>
              {JOURNAL_TYPES.map(([key, label]) => (
                <FilterPill key={key} active={jf.type === key} onClick={() => setFilter({ type: key })}>
                  {t(label)} · {typeCounts[key] || 0}
                </FilterPill>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative min-w-[220px] flex-1 sm:max-w-sm">
                <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-white/30" />
                <TextInput
                  value={jf.q}
                  onChange={(e) => setFilter({ q: e.target.value })}
                  placeholder={t('Search voucher, memo or project')}
                  className="!pl-8"
                  maxLength={100}
                />
              </div>
              <label className="flex items-center gap-1.5 text-xs text-white/60">
                <input type="checkbox" checked={jf.hideReversed} onChange={(e) => setFilter({ hideReversed: e.target.checked })} className="accent-gold" />
                {t('Hide reversed pairs')}
              </label>
              {jf.hideReversed && view.hidden > 0 && (
                <span className="text-xs text-white/40" data-hidden-reversed>
                  {view.hidden} {t('hidden — reversed entries and their reversals net to zero')} ·{' '}
                  <button onClick={() => setFilter({ hideReversed: false })} className="text-gold-light hover:underline">{t('Show them')}</button>
                </span>
              )}
            </div>
          </div>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-white/40">
            <span>{t('Click any entry to open its source document, its linked payments, and the printable voucher.')}</span>
            <span className="tabular-nums">
              {view.shown.length} / {listed.length} {t('entries')} · {money2(tb.debit)} {t('posted')}
            </span>
          </div>
          <TableWrap>
            <thead>
              <tr>
                <th className="th">{t('Voucher No.')}</th>
                <th className="th">{t('Journal ref')}</th>
                <th className="th">{t('Received')}</th>
                <th className="th">{t('Memo')}</th>
                <th className="th">{t('Project ID')}</th>
                <th className="th">{t('Source')}</th>
                <th className="th text-right">{t('Amount')}</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody>
              {view.shown.map((j) => (
                <tr
                  key={j.id}
                  data-entry
                  onClick={() => setDetail(j)}
                  className="group cursor-pointer hover:bg-white/[0.03] transition-colors"
                >
                  <td className="td font-mono text-[11px] text-gold/80">{j.voucherNo || '—'}</td>
                  <td className="td font-medium text-white">
                    <span className="inline-flex items-center gap-1.5">
                      {j.id}
                      {j.reversedBy && <Badge>Reversed</Badge>}
                      {j.reversalOf && <Badge>Adjustment</Badge>}
                      {(j.appliedTo || []).length > 0 && (
                        <Link2 size={11} className="text-sky-300/70" />
                      )}
                    </span>
                  </td>
                  <td className="td text-white/50">
                    {j.date}
                    {j.source?.documentDate && j.source.documentDate !== j.date && (
                      <div className="text-[10px] text-white/35">{t('Receipt')} {j.source.documentDate}</div>
                    )}
                  </td>
                  <td className="td text-white/70">{j.memo}</td>
                  <td className="td font-mono text-xs text-gold/80">{j.project || '—'}</td>
                  <td className="td text-white/50 text-xs">{SOURCE_LABEL[j.source?.kind] || '—'}</td>
                  <td className="td text-right tabular-nums">{money2(entryDebit(j))}</td>
                  <td className="td text-right">
                    <ChevronRight size={14} className="inline text-white/20 group-hover:text-gold/70 transition-colors" />
                  </td>
                </tr>
              ))}
              {!listed.length && (
                <tr><td className="td text-white/30" colSpan={8}>{t('No entries in this period.')}</td></tr>
              )}
              {listed.length > 0 && !view.shown.length && (
                <tr><td className="td text-white/30" colSpan={8}>{t('No entries match these filters.')}</td></tr>
              )}
            </tbody>
          </TableWrap>
        </>
      )}

      {tab === 'ledger' && (
        <GeneralLedgerTab
          journal={journal}
          period={period}
          project={projectFilter}
          accountFilter={accountFilter}
          onOpenEntry={setDetail}
        />
      )}

      {tab === 'income' && (
        <div className="grid lg:grid-cols-3 gap-4">
          <Card className="lg:col-span-2">
            <div className="eyebrow mb-2">
              {t('Income Statement')} · {projectFilter === 'all' ? t('All projects') : projectFilter}
              {summarised && <span className="ml-2 text-[10px] normal-case tracking-normal text-gold/50">{t('executive view — click a line to trace it')}</span>}
            </div>

            <div className="text-[11px] uppercase tracking-wider text-white/30 mt-3 mb-1">{t('Revenue')}</div>
            {renderSection(income.revenue, 'revenue')}
            <StatementRow label={t('Total Revenue')} amount={income.totalRevenue} bold accent="text-emerald-300" />

            <div className="text-[11px] uppercase tracking-wider text-white/30 mt-4 mb-1">{t('Cost of Sales (COGS)')}</div>
            {renderSection(income.cogs, 'cogs', { negate: true, accent: 'text-rose-300' })}
            <StatementRow label={t('Gross Profit')} amount={income.grossProfit} bold />

            <div className="text-[11px] uppercase tracking-wider text-white/30 mt-4 mb-1">{t('Operating Expenses')}</div>
            {renderSection(income.opex, 'opex', { negate: true, accent: 'text-rose-300' })}
            <StatementRow label={t('Profit Before Tax')} amount={income.profitBeforeTax} bold />

            <div className="text-[11px] uppercase tracking-wider text-white/30 mt-4 mb-1">{t('Tax')}</div>
            {income.tax.length
              ? renderSection(income.tax, 'tax', { negate: true, accent: 'text-amber-300' })
              : <StatementRow label={t('No tax applied')} amount={0} indent />}

            <div className="mt-2 rounded-lg border border-gold/30 bg-gold/[0.06] px-4 py-3 flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-medium text-white">NPAT</div>
                <div className="text-[10px] uppercase tracking-wider text-gold/60">{t('Net Profit After Tax')}</div>
              </div>
              <span className="font-display text-xl text-gold-light tabular-nums">{money2(income.npat)}</span>
            </div>
          </Card>

          <div className="space-y-4">
            <Card>
              <div className="text-xs text-white/40">{t('Gross Margin')}</div>
              <div className="mt-1 font-display text-2xl text-white tabular-nums">{pct2(income.grossMargin)}</div>
            </Card>
            <Card>
              <div className="text-xs text-white/40">{t('Net Margin (after tax)')}</div>
              <div className="mt-1 font-display text-2xl text-emerald-300 tabular-nums">{pct2(income.netMargin)}</div>
            </Card>
            <Card>
              <div className="text-xs text-white/40">{t('Tax Expense')}</div>
              <div className="mt-1 font-display text-xl text-amber-300 tabular-nums">{money2(income.totalTax)}</div>
              <div className="text-[10px] text-white/30 mt-1">{t('at')} {income.taxRate}%</div>
            </Card>

            {/* PPh 23 withheld by clients is tax already paid on Oscenia's
                behalf. It does not change the expense — and so does not move
                NPAT — but it does reduce what is left to settle at year end,
                which is the whole reason the correction matters. */}
            <Card className={prepaidPph23 > 0 ? 'border-emerald-500/25' : ''}>
              <div className="text-xs text-white/40">{t('Prepaid PPh 23 credit')}</div>
              <div className="mt-1 font-display text-xl text-emerald-300 tabular-nums">{money2(prepaidPph23)}</div>
              <div className="text-[10px] text-white/30 mt-1">
                {income.provision > 0
                  ? `${t('leaves')} ${money(Math.max(0, income.provision - prepaidPph23))} ${t('still to settle')}`
                  : t('withheld by clients at source · account 1401')}
              </div>
            </Card>
            <TaxSettings />
          </div>
        </div>
      )}

      {tab === 'periods' && <PeriodsPanel />}

      {tab === 'balance' && (
        <>
          {periodKey !== 'all' && periodKey !== 'ytd' && (
            <Card className="mb-4 border-amber-500/30 bg-amber-500/[0.05]">
              <div className="flex items-start gap-2.5 text-xs text-amber-200">
                <AlertTriangle size={15} className="shrink-0 mt-0.5" />
                <span>
                  {t('A Balance Sheet is a position at a point in time, so it needs every entry up to that date. Narrow periods exclude the opening balances — switch to YTD or All Time for a reconciled sheet.')}
                </span>
              </div>
            </Card>
          )}
          <div className="grid lg:grid-cols-2 gap-4">
            <Card>
              <div className="eyebrow mb-3">{t('Assets')}</div>
              {renderSection(balance.assets, 'asset')}
              <StatementRow label={t('Total Assets')} amount={balance.totalAssets} bold accent="text-gold-light" />
            </Card>
            <Card>
              <div className="eyebrow mb-3">{t('Liabilities & Equity')}</div>
              <div className="text-[11px] uppercase tracking-wider text-white/30 mb-1">{t('Liabilities')}</div>
              {renderSection(balance.liabilities, 'liability')}
              <StatementRow label={t('Total Liabilities')} amount={balance.totalLiabilities} bold />

              <div className="text-[11px] uppercase tracking-wider text-white/30 mt-4 mb-1">{t('Equity')}</div>
              {renderSection(balance.equity, 'equity')}
              <StatementRow label={t('Total Equity')} amount={balance.totalEquity} bold />
              <StatementRow
                label={t('Total Liabilities + Equity')}
                amount={balance.totalLiabilities + balance.totalEquity}
                bold
                accent="text-gold-light"
              />

              <div className={`mt-3 flex items-center gap-2 text-[11px] ${balance.balanced ? 'text-emerald-300' : 'text-rose-300'}`}>
                {balance.balanced
                  ? <><Scale size={13} /> {t('Balanced · Assets = Liabilities + Equity')}</>
                  : <><AlertTriangle size={13} /> {t('Out by')} {money2(balance.difference)}</>}
              </div>
            </Card>
          </div>

          <SectionTitle icon={BookOpen}>{t('Trial Balance')}</SectionTitle>
          <Card>
            <div className="grid grid-cols-3 gap-4 text-sm">
              <span className="text-white/50">{t('Total debits')}</span>
              <span className="text-right tabular-nums text-emerald-300">{money2(tb.debit)}</span>
              <span className="text-right tabular-nums text-sky-300">{money2(tb.credit)}</span>
            </div>
          </Card>
        </>
      )}

      {entryModal && <JournalEntryModal onClose={() => { setEntryModal(false); setAdjusting(null) }} adjusting={adjusting} />}
      {numbering && <VoucherSeriesModal onClose={() => setNumbering(false)} />}
      {detail && (
        <EntryDetailModal
          entry={journal.find((e) => e.id === detail.id) || detail}
          onClose={() => setDetail(null)}
          onAdjust={(e) => { setDetail(null); setAdjusting(e); setEntryModal(true) }}
        />
      )}
    </div>
  )
}
