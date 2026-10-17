import { useMemo, useState } from 'react'
import { openStoredFile } from '../lib/files'
import {
  Wallet, Receipt, Upload, Check, X, Plus, ArrowUpCircle, CreditCard, TrendingUp, TrendingDown,
  Paperclip, Trash2, UserRound,
} from 'lucide-react'
import { useStore, pettyCashBalance } from '../store/useStore'
import { pettyCashStart } from '../store/seed'
import {
  PageHeader, Card, TableWrap, Badge, money, money2, SectionTitle,
  Field, TextInput, NumberInput, Select, FilterPill,
} from '../components/ui'
import Modal from '../components/Modal'
import { formatDate, todayFor } from '../lib/format'
import { ROLES } from '../lib/roles'
import { useT } from '../i18n'

// The client's feedback deck redefined this workflow with two extra stages:
// DRAFT -> PENDING -> APPROVED -> DISBURSED -> COMPLETED. "Completed" only
// arrives once the expense report is filed and the variance settled, which is
// what makes the last stage mean something.
const FLOW = ['Draft', 'Pending', 'Approved', 'Disbursed', 'Completed']

const CATEGORIES = [
  'Field Cash Advance',
  'Petty Cash — Crew Meals',
  'Petty Cash — Transport',
  'Vendor — Sound',
  'Vendor — Lighting',
  'Decor / Floral',
]

function TopUpModal({ onClose }) {
  const topUpPettyCash = useStore((s) => s.topUpPettyCash)
  const t = useT()
  const [amount, setAmount] = useState(10_000_000)

  return (
    <Modal
      title="Top Up Petty Cash"
      subtitle={t('Moves money from the main bank account into the operational float.')}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="btn-ghost">{t('Cancel')}</button>
          <button
            onClick={() => { topUpPettyCash(Number(amount)); onClose() }}
            disabled={!(Number(amount) > 0)}
            className="btn-gold"
          >
            <ArrowUpCircle size={14} /> {t('Top up')}
          </button>
        </>
      }
    >
      <Field label="Amount (Rp)">
        <NumberInput value={amount} onChange={(e) => setAmount(e.target.value)} min={0} step={1_000_000} />
      </Field>
      <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3 text-xs space-y-1.5">
        <div className="flex justify-between">
          <span className="text-white/40">{t('Debit')}</span>
          <span className="font-mono text-white/85">1103 · Petty Cash</span>
        </div>
        <div className="flex justify-between">
          <span className="text-white/40">{t('Credit')}</span>
          <span className="font-mono text-white/85">1101 · Main Bank Cash</span>
        </div>
      </div>
    </Modal>
  )
}

function NewRequestModal({ onClose }) {
  const projects = useStore((s) => s.projects)
  const addProcurementRequest = useStore((s) => s.addProcurementRequest)
  const role = useStore((s) => s.role)
  const t = useT()
  const active = projects.filter((p) => p.stage !== 'Finished')
  const [form, setForm] = useState({
    project: active[0]?.id || '',
    category: CATEGORIES[0],
    amount: 5_000_000,
    // Defaults to whoever is signed in, but stays editable: a coordinator
    // often raises a request on behalf of the crew member who needs the cash,
    // and the name that matters is the one who receives it.
    by: ROLES[role]?.name || '',
  })
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  return (
    <Modal
      title="New Request"
      subtitle={t('Submitted straight to Pending for Finance approval.')}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="btn-ghost">{t('Cancel')}</button>
          <button
            onClick={() => {
              addProcurementRequest({ ...form, by: form.by.trim(), amount: Number(form.amount) })
              onClose()
            }}
            disabled={!form.project || !form.by.trim() || !(Number(form.amount) > 0)}
            className="btn-gold"
          >
            <Plus size={14} /> {t('Submit request')}
          </button>
        </>
      }
    >
      <Field label="Project ID">
        <Select value={form.project} onChange={set('project')}>
          {active.map((p) => <option key={p.id} value={p.id}>{p.id} — {p.name}</option>)}
        </Select>
      </Field>
      <Field label="Category">
        <Select value={form.category} onChange={set('category')}>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </Select>
      </Field>
      <Field label="Amount (Rp)">
        <NumberInput value={form.amount} onChange={set('amount')} min={0} step={500_000} />
      </Field>
      {/* Mandatory: petty cash may not be issued to nobody. */}
      <Field
        label="Requester name"
        hint={t('Who is asking for the cash — required, and carried onto the printed voucher')}
      >
        <TextInput
          value={form.by}
          onChange={set('by')}
          placeholder={t('e.g. Bagus S.')}
          className={form.by.trim() ? '' : 'border-amber-500/50'}
        />
      </Field>
    </Modal>
  )
}

// Actual-spend entry. The old Upload button only flipped a boolean; the deck
// asked for a real expense report plus automatic settlement of the difference.
function ExpenseReportModal({ request, onClose }) {
  const settleAdvance = useStore((s) => s.settleAdvance)
  const live = useStore((s) => s.hydrated)
  const t = useT()
  const [actual, setActual] = useState(request.amount)
  // A field cash advance normally comes back as several receipts, not one.
  const [receipts, setReceipts] = useState([])
  const [filename, setFilename] = useState('')

  const addReceipt = () => {
    const name = filename.trim()
    if (!name || receipts.includes(name)) return
    setReceipts((r) => [...r, name])
    setFilename('')
  }

  const spent = Number(actual) || 0
  const variance = request.amount - spent
  const returning = variance > 0

  return (
    <Modal
      title="Expense Report"
      subtitle={`${request.id} · ${request.category}`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="btn-ghost">{t('Cancel')}</button>
          <button
            onClick={() => { settleAdvance(request.id, spent, receipts); onClose() }}
            disabled={!receipts.length}
            className="btn-gold"
          >
            <Check size={14} /> {t('File & settle')}
          </button>
        </>
      }
    >
      <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2.5 text-sm">
        <span className="text-white/50">{t('Advance disbursed')}</span>
        <span className="tabular-nums text-white">{money2(request.amount)}</span>
      </div>

      <Field label="Actual spend (Rp)">
        <NumberInput value={actual} onChange={(e) => setActual(e.target.value)} min={0} />
      </Field>

      {/* Filenames only — the prototype has no file storage, so this records
          which receipts were filed rather than pretending to hold them. */}
      <Field label="Receipts / proof of spend" hint={live ? t('Choose the receipt files; they are stored with the request') : t('Names are recorded; the prototype stores no files')}>
        {live ? (
          <input
            type="file"
            multiple
            accept="image/*,application/pdf"
            onChange={(e) => { setReceipts((r) => [...r, ...Array.from(e.target.files || [])]); e.target.value = '' }}
            className="block w-full text-xs text-white/70 file:mr-3 file:rounded-md file:border file:border-white/15 file:bg-white/5 file:px-3 file:py-1.5 file:text-white/80"
          />
        ) : null}
        <div className={live ? 'hidden' : 'flex items-center gap-2'}>
          <div className="flex flex-1 items-center gap-2 rounded-lg border border-white/10 bg-navy-900 px-3 py-2 focus-within:border-gold/50">
            <Upload size={14} className="text-white/40 shrink-0" />
            <input
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addReceipt() } }}
              placeholder={t('e.g. toll-receipt-14aug.jpg')}
              className="w-full bg-transparent text-sm text-white/85 placeholder:text-white/30 outline-none"
            />
          </div>
          <button onClick={addReceipt} disabled={!filename.trim()} className="btn-ghost px-2.5 py-2">
            <Plus size={14} />
          </button>
        </div>
      </Field>

      {receipts.length > 0 ? (
        <div className="space-y-1.5">
          {receipts.map((f) => (
            <div key={typeof f === 'string' ? f : `${f.name}:${f.size}`} className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/[0.05] px-3 py-1.5">
              <Paperclip size={12} className="text-emerald-300 shrink-0" />
              <span className="min-w-0 flex-1 truncate text-[11px] text-emerald-200">{typeof f === 'string' ? f : f.name}</span>
              <button
                onClick={() => setReceipts((r) => r.filter((x) => x !== f))}
                className="text-white/30 hover:text-rose-300 shrink-0"
                aria-label="Remove receipt"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-white/20 px-3 py-3 text-center text-[11px] text-white/35">
          {t('At least one receipt is required before the advance can be settled.')}
        </div>
      )}

      <div className={`rounded-lg border p-3 ${
        variance === 0
          ? 'border-white/10 bg-white/[0.02]'
          : returning
            ? 'border-emerald-500/40 bg-emerald-500/[0.06]'
            : 'border-amber-500/40 bg-amber-500/[0.06]'
      }`}>
        <div className="flex items-center gap-2 text-xs">
          {variance === 0
            ? <span className="text-white/60">{t('Settles exactly — no adjustment needed.')}</span>
            : returning
              ? <span className="inline-flex items-center gap-1.5 text-emerald-200">
                <TrendingDown size={14} /> {t('Returning')} <strong>{money2(variance)}</strong> {t('to the float')}
              </span>
              : <span className="inline-flex items-center gap-1.5 text-amber-200">
                <TrendingUp size={14} /> {t('Reimbursing')} <strong>{money2(-variance)}</strong> {t('shortfall')}
              </span>}
        </div>
      </div>
    </Modal>
  )
}

export default function Procurement() {
  const procurement = useStore((s) => s.procurement)
  const setProcurementStatus = useStore((s) => s.setProcurementStatus)
  const pushToast = useStore((s) => s.pushToast)
  // The file is fetched with the session's token; say so when it cannot be had.
  const openReceipt = (id, name) =>
    openStoredFile(id, name).catch(() => pushToast({ title: 'Could not open the receipt', body: 'The file could not be fetched from the server. Try again.', kind: 'redflag' }))
  const balance = useStore(pettyCashBalance)
  const live = useStore((s) => s.hydrated)
  // Signed in, the opening float is what the server's ledger says; the demo keeps its seeded figure.
  const opening = useStore((s) => (s.hydrated && s.pettyCash ? s.pettyCash.opening : pettyCashStart))
  const topUps = useStore((s) => s.pettyCashTopUps)
  const t = useT()

  const [statusFilter, setStatusFilter] = useState('all')
  const [projectFilter, setProjectFilter] = useState('all')
  const [requesterFilter, setRequesterFilter] = useState('all')
  const [dateFrom, setDateFrom] = useState('')
  const [topUp, setTopUp] = useState(false)
  const [newRequest, setNewRequest] = useState(false)
  const [report, setReport] = useState(null)

  const projectIds = [...new Set(procurement.map((r) => r.project))]
  const requesters = [...new Set(procurement.map((r) => r.by).filter(Boolean))].sort()

  const visible = useMemo(() => procurement.filter((r) => {
    if (statusFilter !== 'all' && r.status !== statusFilter) return false
    if (projectFilter !== 'all' && r.project !== projectFilter) return false
    if (requesterFilter !== 'all' && r.by !== requesterFilter) return false
    if (dateFrom && (r.date || '') < dateFrom) return false
    return true
  }), [procurement, statusFilter, projectFilter, requesterFilter, dateFrom])

  // "Petty Cash recapitulation reports can be filtered and grouped based on the
  // requester's name, simplifying the process of clarifying expenditure
  // evidence, verifying authorization, and auditing fund accountability."
  const byRequester = useMemo(() => {
    const map = {}
    procurement.forEach((r) => {
      const key = r.by || '\u2014'
      const row = map[key] || (map[key] = { by: key, count: 0, requested: 0, actual: 0, open: 0 })
      row.count += 1
      row.requested += r.amount
      row.actual += r.actual != null ? r.actual : 0
      if (!['Completed', 'Rejected'].includes(r.status)) row.open += r.amount
    })
    return Object.values(map)
      .map((r) => ({ ...r, variance: r.actual ? r.requested - r.actual : 0 }))
      .sort((a, b) => b.requested - a.requested)
  }, [procurement])

  const spent = procurement
    .filter((r) => ['Paid', 'Disbursed', 'Completed'].includes(r.status) && /petty|cash/i.test(r.category))
    .reduce((a, r) => a + (r.actual != null ? r.actual : r.amount), 0)

  const pending = procurement.filter((r) => r.status === 'Pending').reduce((a, r) => a + r.amount, 0)

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Spend Control"
        title="Procurement & Petty Cash"
        subtitle="Five-stage approval workflow. Disbursement posts to the ledger, and a request only reaches Completed once the expense report is filed and the variance settled."
        actions={
          <>
            <button onClick={() => setNewRequest(true)} className="btn-ghost"><Plus size={15} /> {t('Create New Request')}</button>
            <button onClick={() => setTopUp(true)} className="btn-gold"><ArrowUpCircle size={15} /> {t('Top Up Petty Cash')}</button>
          </>
        }
      />

      <div className="grid lg:grid-cols-3 gap-4 mb-5">
        <Card className="lg:col-span-2">
          <div className="eyebrow mb-4">{t('Approval Workflow')}</div>
          <div className="flex flex-wrap items-center gap-2">
            {FLOW.map((f, i) => {
              const count = procurement.filter((r) => r.status === f).length
              return (
                <div key={f} className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-xs text-white/70">
                    {t(f)}
                    {count > 0 && (
                      <span className="grid h-4 min-w-4 place-items-center rounded-full bg-gold/25 px-1 text-[10px] text-gold-light">
                        {count}
                      </span>
                    )}
                  </span>
                  {i < FLOW.length - 1 && <span className="text-white/30">→</span>}
                </div>
              )
            })}
          </div>
          <div className="mt-3 text-[11px] text-white/40">
            {t('Disbursing posts a journal entry that reduces petty cash or the bank; filing the expense report settles any difference automatically.')}
          </div>
        </Card>

        <Card className="border-gold/25">
          <div className="flex items-center gap-2 mb-2">
            <Wallet size={16} className="text-gold-light" />
            <div className="eyebrow">{t('Operational Petty Cash')}</div>
          </div>
          <div className="font-display text-2xl text-white tabular-nums">{money2(balance)}</div>
          <div className="mt-2 space-y-1 text-[11px] text-white/40">
            <div className="flex justify-between"><span>{t('Opening float')}</span><span className="tabular-nums">{money(opening)}</span></div>
            <div className="flex justify-between"><span>{t('Top-ups')}</span><span className="tabular-nums text-emerald-300">+{money(topUps)}</span></div>
            <div className="flex justify-between"><span>{t('Disbursed')}</span><span className="tabular-nums text-rose-300">−{money(spent)}</span></div>
          </div>
          {pending > 0 && (
            <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-2.5 py-2 text-[11px] text-amber-200">
              {money(pending)} {t('awaiting approval')}
            </div>
          )}
        </Card>
      </div>

      <SectionTitle icon={UserRound}>{t('Recap by Requester')}</SectionTitle>
      <TableWrap>
        <thead>
          <tr>
            <th className="th">{t('Requester')}</th>
            <th className="th text-center">{t('Requests')}</th>
            <th className="th text-right">{t('Requested')}</th>
            <th className="th text-right">{t('Actual spend')}</th>
            <th className="th text-right">{t('Variance')}</th>
            <th className="th text-right">{t('Still open')}</th>
            <th className="th text-right"></th>
          </tr>
        </thead>
        <tbody>
          {byRequester.map((r) => (
            <tr key={r.by} className={requesterFilter === r.by ? 'bg-gold/[0.06]' : ''}>
              <td className="td text-white">{r.by}</td>
              <td className="td text-center tabular-nums text-white/60">{r.count}</td>
              <td className="td text-right tabular-nums">{money2(r.requested)}</td>
              <td className="td text-right tabular-nums text-white/60">
                {r.actual ? money2(r.actual) : <span className="text-white/20">—</span>}
              </td>
              <td className="td text-right tabular-nums">
                {r.variance === 0 ? <span className="text-white/20">—</span> : (
                  <span className={r.variance > 0 ? 'text-emerald-300' : 'text-amber-300'}>
                    {r.variance > 0 ? `${money(r.variance)} returned` : `${money(-r.variance)} claimed`}
                  </span>
                )}
              </td>
              <td className="td text-right tabular-nums text-amber-300/80">
                {r.open ? money2(r.open) : <span className="text-white/20">—</span>}
              </td>
              <td className="td text-right">
                <button
                  onClick={() => setRequesterFilter(requesterFilter === r.by ? 'all' : r.by)}
                  className="text-xs text-gold/70 hover:text-gold-light"
                >
                  {requesterFilter === r.by ? t('Clear') : t('Filter')}
                </button>
              </td>
            </tr>
          ))}
          {!byRequester.length && (
            <tr><td className="td text-white/30" colSpan={7}>{t('No requests recorded yet.')}</td></tr>
          )}
        </tbody>
      </TableWrap>

      <SectionTitle
        icon={CreditCard}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <FilterPill active={statusFilter === 'all'} onClick={() => setStatusFilter('all')}>{t('All')}</FilterPill>
            {FLOW.map((f) => (
              <FilterPill key={f} active={statusFilter === f} onClick={() => setStatusFilter(f)}>{t(f)}</FilterPill>
            ))}
            <Select className="w-auto py-1 text-xs" value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}>
              <option value="all">{t('All projects')}</option>
              {projectIds.map((id) => <option key={id} value={id}>{id}</option>)}
            </Select>
            <Select className="w-auto py-1 text-xs" value={requesterFilter} onChange={(e) => setRequesterFilter(e.target.value)}>
              <option value="all">{t('All requesters')}</option>
              {requesters.map((n) => <option key={n} value={n}>{n}</option>)}
            </Select>
            <TextInput
              type="date"
              className="w-auto py-1 text-xs"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
            />
          </div>
        }
      >
        {t('Requests')}
      </SectionTitle>

      <TableWrap>
        <thead>
          <tr>
            <th className="th">{t('Request')}</th>
            <th className="th">{t('Project ID')}</th>
            <th className="th">{t('Category')}</th>
            <th className="th text-right">{t('Amount')}</th>
            <th className="th text-right">{t('Actual')}</th>
            <th className="th">{t('Submitted by')}</th>
            <th className="th">{t('Status')}</th>
            <th className="th text-right">{t('Action')}</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((r) => (
            <tr key={r.id}>
              <td className="td font-medium text-white">{r.id}</td>
              <td className="td font-mono text-xs text-gold/80">{r.project}</td>
              <td className="td text-white/70">{r.category}</td>
              <td className="td text-right tabular-nums">{money2(r.amount)}</td>
              <td className="td text-right tabular-nums">
                {r.actual != null ? (
                  <span className={r.variance > 0 ? 'text-emerald-300' : r.variance < 0 ? 'text-amber-300' : 'text-white/70'}>
                    {money2(r.actual)}
                    {r.variance !== 0 && (
                      <div className="text-[10px] text-white/35">
                        {r.variance > 0 ? `${money(r.variance)} returned` : `${money(-r.variance)} claimed`}
                      </div>
                    )}
                  </span>
                ) : <span className="text-white/20">—</span>}
              </td>
              <td className="td text-white/60">{r.by}</td>
              <td className="td"><Badge>{r.status}</Badge></td>
              <td className="td text-right">
                {/* Contextual actions per status, as the deck specified. */}
                {r.status === 'Draft' && (
                  <button onClick={() => setProcurementStatus(r.id, 'Pending')} className="text-xs text-sky-300 hover:text-sky-200">
                    {t('Submit')}
                  </button>
                )}
                {r.status === 'Pending' && (
                  <div className="flex justify-end gap-2">
                    <button onClick={() => setProcurementStatus(r.id, 'Approved')} className="inline-flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300">
                      <Check size={13} /> {t('Approve')}
                    </button>
                    <button onClick={() => setProcurementStatus(r.id, 'Rejected')} className="inline-flex items-center gap-1 text-xs text-rose-400 hover:text-rose-300">
                      <X size={13} /> {t('Reject')}
                    </button>
                  </div>
                )}
                {r.status === 'Approved' && (
                  <button onClick={() => setProcurementStatus(r.id, 'Disbursed')} className="inline-flex items-center gap-1 text-xs text-sky-300 hover:text-sky-200">
                    <CreditCard size={13} /> {t('Pay / Process')}
                  </button>
                )}
                {(r.status === 'Disbursed' || r.status === 'Paid') && (
                  <button onClick={() => setReport(r)} className="inline-flex items-center gap-1 text-xs text-gold/80 hover:text-gold-light">
                    <Upload size={13} /> {t('Expense report')}
                  </button>
                )}
                {r.status === 'Completed' && (
                  <span
                    className="inline-flex items-center gap-1 text-xs text-emerald-300"
                    title={(r.receipts || []).length ? r.receipts.join(', ') : undefined}
                  >
                    <Receipt size={13} /> {t('Settled')}
                    {(r.receipts || []).length > 0 && (
                      <span className="inline-flex items-center gap-0.5 text-white/45">
                        <Paperclip size={10} />{r.receipts.length}
                      </span>
                    )}
                    <Check size={12} />
                    {/* A real receipt (signed in) opens; a demo one is only a name. */}
                    {(r.receiptIds || []).filter(Boolean).map((id, i) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => openReceipt(id, `${r.id}-receipt-${i + 1}`)}
                        className="ml-1 text-gold/80 underline-offset-2 hover:text-gold-light hover:underline"
                      >
                        {t('Open')} {r.receiptIds.length > 1 ? i + 1 : t('receipt')}
                      </button>
                    ))}
                  </span>
                )}
                {r.status === 'Rejected' && <span className="text-xs text-rose-300/70">{t('Closed')}</span>}
              </td>
            </tr>
          ))}
          {!visible.length && (
            <tr><td className="td text-white/30" colSpan={8}>{t('No requests match these filters.')}</td></tr>
          )}
        </tbody>
      </TableWrap>

      <div className="mt-3 text-[11px] text-white/30">
        {t('Showing requests as at')} {formatDate(todayFor(live))}.
      </div>

      {topUp && <TopUpModal onClose={() => setTopUp(false)} />}
      {newRequest && <NewRequestModal onClose={() => setNewRequest(false)} />}
      {report && <ExpenseReportModal request={report} onClose={() => setReport(null)} />}
    </div>
  )
}
