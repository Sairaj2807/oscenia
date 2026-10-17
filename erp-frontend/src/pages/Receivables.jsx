import { useMemo, useState } from 'react'
import {
  Receipt, AlertTriangle, Clock, Download, Check, HandCoins, CalendarClock,
  Send, Link2,
} from 'lucide-react'
import { useStore } from '../store/useStore'
import {
  PageHeader, Card, TableWrap, money, money2, SectionTitle, FilterPill, Badge,
  ActionButton, Field, TextInput,
} from '../components/ui'
import Modal from '../components/Modal'
import PostingModal from '../components/PostingModal'
import useConfirmPosting from '../components/useConfirmPosting'
import { planIssueInvoice } from '../lib/postings'
import ReceivePaymentModal, { outstandingOf } from '../components/ReceivePaymentModal'
import { accountBalance } from '../lib/ledger'
import { useReport, useCrossCheck } from '../store/useReport'
import { adaptAgeing } from '../store/reportAdapters'
import { daysUntil, formatDate, appToday } from '../lib/format'
import { invoicePDF } from '../lib/pdf'
import { useT } from '../i18n'

// Ageing buckets measured against DEMO_TODAY. `max` is days overdue.
const BUCKETS = [
  { key: 'current', label: 'Current', hint: 'Not yet due', min: -Infinity, max: 0, tone: 'text-emerald-300' },
  { key: '1-30', label: '1–30 days', hint: 'Recently overdue', min: 1, max: 30, tone: 'text-amber-300' },
  { key: '31-60', label: '31–60 days', hint: 'Chase required', min: 31, max: 60, tone: 'text-orange-300' },
  { key: '60+', label: '60+ days', hint: 'Escalate', min: 61, max: Infinity, tone: 'text-rose-300' },
]

function bucketFor(overdueDays) {
  return BUCKETS.find((b) => overdueDays >= b.min && overdueDays <= b.max) || BUCKETS[0]
}

// Issuing asks for BOTH of the client's dates, which is the whole of REQ-01 on this screen.
//
// The distinction is the part worth being careful about, because it decides which month the
// books move in:
//
//   Main date      when the receivable is RECORDED. This is the accounting date -- every
//                  report reads it, and the period-close trigger refuses a date inside a
//                  closed month. Defaults to today.
//   Invoice date   what the invoice itself is dated. Changes no figure anywhere; it is here
//                  so a document dated last month and recorded this month reconciles as both.
//
// Before this the screen sent neither: `issueInvoice(r.id)` took no dates and the endpoint
// accepted no body, so a late invoice could only ever be recorded as of today.
function IssueInvoiceModal({ invoice, onClose }) {
  const issueInvoice = useStore((s) => s.issueInvoice)
  const projects = useStore((s) => s.projects)
  const t = useT()
  const [issuedOn, setIssuedOn] = useState(appToday())
  const [documentDate, setDocumentDate] = useState('')
  // REQ-05: the posting is shown before it posts, not after. The lines come from the server
  // running the real operation and rolling it back, so what the dialog shows is what lands.
  const { state: posting, ask, close } = useConfirmPosting()

  const backdated = documentDate && documentDate < issuedOn

  return (
    <Modal
      title={`${t('Issue')} ${invoice.id}`}
      subtitle={`${invoice.client || invoice.project} · ${money2(invoice.amount)}`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="btn-ghost">{t('Cancel')}</button>
          <button
            onClick={() => ask(`/invoices/${invoice.uuid}/issue`, {
              issuedOn,
              documentDate: documentDate || null,
            })}
            disabled={!issuedOn}
            className="btn-gold"
          >
            <Send size={14} /> {t('Review posting')}
          </button>
        </>
      }
    >
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Main date (used in reports)" hint={t('The accounting date every report reads')}>
          <TextInput type="date" value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} />
        </Field>
        <Field label="Invoice date" hint={t('Optional — the date on the document itself')}>
          <TextInput type="date" value={documentDate} onChange={(e) => setDocumentDate(e.target.value)} />
        </Field>
      </div>

      {backdated && (
        <div className="rounded-lg border border-sky-500/25 bg-sky-500/[0.04] p-3 text-[11px] text-sky-200">
          {t('The invoice is dated earlier than the date it is recorded. That is recorded as-is and moves nothing: the receivable posts on')}
          {' '}{formatDate(issuedOn)}, {t('and the document keeps its own date for reconciliation.')}
        </div>
      )}

      {posting && (
        <PostingModal
          title={`${t('Post')} ${invoice.id}?`}
          subtitle={t('This is what issuing the invoice will write to the ledger.')}
          // An issued invoice is an accrual, not money received: its entry is shown
          // read-only, on the two dates chosen above (round 4 keeps this wording).
          server={posting.local ? null : posting}
          planFor={() => planIssueInvoice(
            { invoice, projectName: projects.find((p) => p.id === invoice.project)?.name },
            { issuedOn, documentDate: documentDate || null },
          )}
          dateLabels={null}
          confirmLabel="Issue invoice"
          onConfirm={() => {
            issueInvoice(invoice.id, { issuedOn, documentDate: documentDate || null })
            close()
            onClose()
          }}
          onClose={close}
        />
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Accounts Receivable ageing, plus the settlement actions that were missing.
// ---------------------------------------------------------------------------
export default function Receivables() {
  const invoices = useStore((s) => s.invoices)
  const projects = useStore((s) => s.projects)
  const journal = useStore((s) => s.journal)
  const role = useStore((s) => s.role)
  const live = useStore((s) => s.hydrated)
  const t = useT()
  const [bucketFilter, setBucketFilter] = useState('all')
  const [paying, setPaying] = useState(null)
  const [issuing, setIssuing] = useState(null)

  const decorate = (i) => {
    const project = projects.find((p) => p.id === i.project)
    // Ageing is measured on the due date, and falls back to the invoice's OWN date rather
    // than to today when there is none -- the same precedent Payables sets with
    // `src.due || item.entry.date`. Falling back to today would age every undated invoice
    // at zero days, which reads as "current" for something that may be months old.
    const days = daysUntil(i.due || i.documentDate)
    const overdue = days == null ? 0 : -days
    return {
      ...i,
      outstanding: outstandingOf(i),
      overdue,
      bucket: bucketFor(overdue),
      projectName: project?.name,
      client: project?.client,
    }
  }

  // Issued and still owed. These are the invoices that have actually posted a
  // receivable, so this is the set that reconciles against ledger 1201.
  const rows = useMemo(
    () => invoices
      .filter((i) => (i.status === 'Unpaid' || i.status === 'Partially Paid') && outstandingOf(i) > 0)
      .map(decorate)
      .sort((a, b) => b.overdue - a.overdue),
    [invoices, projects] // eslint-disable-line react-hooks/exhaustive-deps
  )

  // Drafted billing stages. Nothing is owed until they are issued, so they are
  // deliberately kept OUT of the outstanding total — counting a plan as a debt
  // would put AR permanently out of step with the ledger.
  const scheduled = useMemo(
    () => invoices.filter((i) => i.status === 'Scheduled').map(decorate)
      .sort((a, b) => (a.due < b.due ? -1 : 1)),
    [invoices, projects] // eslint-disable-line react-hooks/exhaustive-deps
  )

  const clientTotals = useMemo(() => {
    const map = Object.fromEntries(BUCKETS.map((b) => [b.key, 0]))
    rows.forEach((r) => { map[r.bucket.key] += r.outstanding })
    return map
  }, [rows])

  const clientAR = rows.reduce((a, r) => a + r.outstanding, 0)
  const clientOverdue = rows.filter((r) => r.overdue > 0).reduce((a, r) => a + r.outstanding, 0)
  const clientScheduled = scheduled.reduce((a, r) => a + r.amount, 0)
  const clientLedger = accountBalance(journal, '1201')

  // Signed in, the totals, the buckets, the scheduled amount and the ledger reconciliation come from
  // the server's ageing report; the rows below stay the invoices list (the server reports totals, not
  // invoices). The report is asked for as at the same date the rows are aged against (DEMO_TODAY is
  // the app's clock), so a card and the table under it cannot disagree about "overdue".
  const report = useReport('/receivables/ageing', { asOf: appToday() }, adaptAgeing, { enabled: live })
  const server = live ? report.data : null
  const totals = server ? Object.fromEntries(server.buckets.map((b) => [b.key, b.amount])) : clientTotals
  const totalAR = server ? server.total : clientAR
  const overdueAR = server ? server.overdue : clientOverdue
  const scheduledTotal = server ? server.scheduled : clientScheduled
  useCrossCheck('receivables: open invoices vs server total', server ? server.total : null, clientAR)

  // Cross-check against the ledger. If these ever diverge, a receipt was posted
  // without the invoice being marked paid (or vice versa) — worth surfacing
  // rather than hiding.
  const ledgerAR = server ? server.ledgerBalance : clientLedger
  const reconciled = server ? server.reconciled : Math.abs(ledgerAR - totalAR) < 1

  const visible = bucketFilter === 'all' ? rows : rows.filter((r) => r.bucket.key === bucketFilter)

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Working Capital"
        title="Accounts Receivable"
        subtitle="Who owes what, how late, and what is still to be billed. Recording a payment posts to the ledger and moves the ageing in the same action — the total is reconciled against account 1201 on every render."
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
        <Card>
          <div className="text-xs text-white/40">{t('Total Outstanding')}</div>
          <div className="mt-1 font-display text-xl text-white tabular-nums">{money2(totalAR)}</div>
          <div className="text-[10px] text-white/30 mt-0.5">{rows.length} {t('open invoices')}</div>
        </Card>
        <Card>
          <div className="text-xs text-white/40">{t('Overdue')}</div>
          <div className="mt-1 font-display text-xl text-rose-300 tabular-nums">{money2(overdueAR)}</div>
          <div className="text-[10px] text-white/30 mt-0.5">
            {totalAR ? ((overdueAR / totalAR) * 100).toFixed(1) : '0.0'}% {t('of book')}
          </div>
        </Card>
        <Card>
          <div className="text-xs text-white/40">{t('Scheduled to bill')}</div>
          <div className="mt-1 font-display text-xl text-sky-300 tabular-nums">{money2(scheduledTotal)}</div>
          <div className="text-[10px] text-white/30 mt-0.5">{scheduled.length} {t('stages not yet issued')}</div>
        </Card>
        <Card className={reconciled ? '' : 'border-rose-500/50'}>
          <div className="text-xs text-white/40">{t('Ledger 1201')}</div>
          <div className="mt-1 font-display text-lg text-white tabular-nums">{money(ledgerAR)}</div>
          <div className={`mt-0.5 inline-flex items-center gap-1 text-[10px] ${reconciled ? 'text-emerald-300' : 'text-rose-300'}`}>
            {reconciled ? <><Check size={11} /> {t('Reconciled')}</> : <><AlertTriangle size={11} /> {t('Out by')} {money(ledgerAR - totalAR)}</>}
          </div>
        </Card>
      </div>

      <SectionTitle icon={Clock}>{t('Ageing')}</SectionTitle>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {BUCKETS.map((b) => {
          const value = totals[b.key]
          const share = totalAR ? (value / totalAR) * 100 : 0
          return (
            <Card key={b.key} className={bucketFilter === b.key ? 'border-gold/40' : ''}>
              <button onClick={() => setBucketFilter(bucketFilter === b.key ? 'all' : b.key)} className="w-full text-left">
                <div className={`text-xs ${b.tone}`}>{t(b.label)}</div>
                <div className="mt-1 font-display text-lg text-white tabular-nums">{money2(value)}</div>
                <div className="mt-2 h-1.5 rounded-full bg-white/10 overflow-hidden">
                  <div className="h-full rounded-full bg-gold" style={{ width: `${share}%` }} />
                </div>
                <div className="mt-1 text-[10px] text-white/35">{b.hint} · {share.toFixed(0)}%</div>
              </button>
            </Card>
          )
        })}
      </div>

      <SectionTitle
        icon={Receipt}
        actions={
          <div className="flex flex-wrap gap-2">
            <FilterPill active={bucketFilter === 'all'} onClick={() => setBucketFilter('all')}>{t('All')}</FilterPill>
            {BUCKETS.map((b) => (
              <FilterPill key={b.key} active={bucketFilter === b.key} onClick={() => setBucketFilter(b.key)}>
                {t(b.label)}
              </FilterPill>
            ))}
          </div>
        }
      >
        {t('Open Invoices')}
      </SectionTitle>

      <TableWrap>
        <thead>
          <tr>
            <th className="th">{t('Invoice')}</th>
            <th className="th">{t('Project ID')}</th>
            <th className="th">{t('Client')}</th>
            <th className="th">{t('Type')}</th>
            <th className="th text-right">{t('Invoiced')}</th>
            <th className="th text-right">{t('Outstanding')}</th>
            <th className="th">{t('Invoice date')}</th>
            <th className="th">{t('Due')}</th>
            <th className="th">{t('Ageing')}</th>
            <th className="th text-right">{t('Action')}</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((r) => (
            <tr key={r.id} className={r.overdue > 30 ? 'bg-rose-500/[0.05]' : ''}>
              <td className="td font-medium text-white">
                <span className="inline-flex items-center gap-1.5">
                  {r.id}
                  {r.status === 'Partially Paid' && <Badge>Partially Paid</Badge>}
                </span>
              </td>
              <td className="td font-mono text-xs text-gold/80">{r.project}</td>
              <td className="td text-white/70">{r.client || '—'}</td>
              <td className="td text-white/60">{r.stage || r.type}</td>
              <td className="td text-right tabular-nums text-white/50">
                {money2(r.amount)}
                {r.paid > 0 && (
                  <div className="text-[10px] text-emerald-300/70">{money(r.paid)} {t('collected')}</div>
                )}
              </td>
              <td className="td text-right tabular-nums text-white">{money2(r.outstanding)}</td>
              <td className="td text-white/50">
                {r.documentDate ? formatDate(r.documentDate) : <span className="text-white/25">—</span>}
                {r.documentDate && r.issuedAt && r.documentDate !== r.issuedAt && (
                  <div className="text-[10px] text-white/30">
                    {t('recorded')} {formatDate(r.issuedAt)}
                  </div>
                )}
              </td>
              <td className="td text-white/50">{formatDate(r.due)}</td>
              <td className="td">
                <span className={`inline-flex items-center gap-1.5 text-xs ${r.bucket.tone}`}>
                  {r.overdue > 0 ? <AlertTriangle size={12} /> : <Clock size={12} />}
                  {r.overdue > 0
                    ? `${r.overdue} ${t('days overdue')}`
                    : `${t('due in')} ${Math.abs(r.overdue)} ${t('days')}`}
                </span>
              </td>
              <td className="td text-right">
                <div className="flex items-center justify-end gap-2">
                  <button
                    onClick={() => invoicePDF(r, r.projectName, r.client)}
                    className="inline-flex items-center gap-1 text-xs text-white/40 hover:text-gold-light"
                  >
                    <Download size={13} /> PDF
                  </button>
                  <ActionButton
                    action="confirm_dp"
                    role={role}
                    onClick={() => setPaying(r)}
                    className="inline-flex items-center gap-1 text-xs text-emerald-300 hover:text-emerald-200 disabled:opacity-30"
                  >
                    <HandCoins size={13} /> {t('Receive')}
                  </ActionButton>
                </div>
              </td>
            </tr>
          ))}
          {!visible.length && (
            <tr><td className="td text-white/30" colSpan={10}>{t('Nothing outstanding in this bucket.')}</td></tr>
          )}
        </tbody>
      </TableWrap>

      {/* Drafted billing stages — the automated schedule from the quotation. */}
      {scheduled.length > 0 && (
        <>
          <SectionTitle icon={CalendarClock}>{t('Scheduled Billing')}</SectionTitle>
          <div className="mb-3 flex items-start gap-2 text-[11px] text-white/40">
            <Link2 size={13} className="shrink-0 mt-0.5 text-sky-300/60" />
            <span>
              {t('Drafted from the quotation’s payment schedule. Nothing is owed and nothing posts to the ledger until a stage is issued — which is why these sit outside the outstanding total.')}
            </span>
          </div>
          <TableWrap>
            <thead>
              <tr>
                <th className="th">{t('Invoice')}</th>
                <th className="th">{t('Project ID')}</th>
                <th className="th">{t('Client')}</th>
                <th className="th">{t('Stage')}</th>
                <th className="th text-right">{t('Amount')}</th>
                <th className="th">{t('Due')}</th>
                <th className="th text-right">{t('Action')}</th>
              </tr>
            </thead>
            <tbody>
              {scheduled.map((r) => {
                const days = daysUntil(r.due)
                return (
                  <tr key={r.id}>
                    <td className="td font-medium text-white/70">{r.id}</td>
                    <td className="td font-mono text-xs text-gold/80">{r.project}</td>
                    <td className="td text-white/70">{r.client || '—'}</td>
                    <td className="td text-white/60">{r.stage || r.type}</td>
                    <td className="td text-right tabular-nums text-white/80">{money2(r.amount)}</td>
                    <td className="td text-white/50">
                      {formatDate(r.due)}
                      {days != null && (
                        <div className="text-[10px] text-white/30">
                          {days >= 0 ? `${t('in')} ${days}d` : `${Math.abs(days)}d ${t('ago')}`}
                        </div>
                      )}
                    </td>
                    <td className="td text-right">
                      <ActionButton
                        action="confirm_dp"
                        role={role}
                        onClick={() => setIssuing(r)}
                        className="inline-flex items-center gap-1 text-xs text-gold/80 hover:text-gold-light disabled:opacity-30"
                        title={t('Raise the receivable and post it to the ledger')}
                      >
                        <Send size={13} /> {t('Issue invoice')}
                      </ActionButton>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </TableWrap>
        </>
      )}

      <div className="mt-3 text-[11px] text-white/30">
        {t('Ageing measured against')} {formatDate(appToday())}.
      </div>

      {paying && <ReceivePaymentModal invoice={paying} onClose={() => setPaying(null)} />}
      {issuing && <IssueInvoiceModal invoice={issuing} onClose={() => setIssuing(null)} />}
    </div>
  )
}
