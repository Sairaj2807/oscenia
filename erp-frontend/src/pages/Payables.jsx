import { useMemo, useState } from 'react'
import {
  Wallet, AlertTriangle, Clock, Check, Banknote, Truck, Link2,
} from 'lucide-react'
import { useStore } from '../store/useStore'
import {
  PageHeader, Card, TableWrap, money, money2, SectionTitle, FilterPill, Badge,
  Field, NumberInput, ActionButton,
} from '../components/ui'
import Modal from '../components/Modal'
import { PostingEditor, usePostingDraft, BalanceBadge, VENDOR_DATES, settlePost } from '../components/PostingModal'
import { VENDOR_MONEY, paymentBody } from '../lib/apiPostings'
import { accountBalance, openItems } from '../lib/ledger'
import { planPayBill } from '../lib/postings'
import { daysUntil, formatDate, appToday } from '../lib/format'
import { useReport, useCrossCheck } from '../store/useReport'
import { adaptAgeing } from '../store/reportAdapters'
import { useT } from '../i18n'

// Same buckets as Accounts Receivable, measured the same way. Money owed and
// money due behave identically; only the direction changes.
const BUCKETS = [
  { key: 'current', label: 'Current', hint: 'Not yet due', min: -Infinity, max: 0, tone: 'text-emerald-300' },
  { key: '1-30', label: '1–30 days', hint: 'Recently overdue', min: 1, max: 30, tone: 'text-amber-300' },
  { key: '31-60', label: '31–60 days', hint: 'Chase required', min: 31, max: 60, tone: 'text-orange-300' },
  { key: '60+', label: '60+ days', hint: 'Escalate', min: 61, max: Infinity, tone: 'text-rose-300' },
]

function bucketFor(overdueDays) {
  return BUCKETS.find((b) => overdueDays >= b.min && overdueDays <= b.max) || BUCKETS[0]
}

// ---------------------------------------------------------------------------
// Pay a vendor bill. The mirror of Receive Payment on the AR side: the payable
// clears at gross, cash leaves net, and the withheld PPh 23 becomes a liability
// Oscenia owes the tax office rather than a credit it holds.
// ---------------------------------------------------------------------------
function PayBillModal({ item, onClose }) {
  const payVendorBill = useStore((s) => s.payVendorBill)
  const taxConfig = useStore((s) => s.taxConfig)
  const vendors = useStore((s) => s.vendors)
  const hydrated = useStore((s) => s.hydrated)
  const t = useT()
  const [busy, setBusy] = useState(false)

  const outstanding = item.outstanding
  const [amount, setAmount] = useState(outstanding)

  // A vendor's own withholding classification beats the company default.
  const vendorName = item.entry.source?.vendor
  const vendor = vendors.find((v) => v.name === vendorName)
  const rate = vendor?.pph23Rate ?? taxConfig?.pph23?.rate ?? 0

  const gross = Math.min(Math.round(Number(amount) || 0), outstanding)
  const partial = gross > 0 && gross < outstanding
  // Round 4: the payment's journal entry, editable before it posts (dates, account, tax, lines).
  const draft = usePostingDraft(
    (inputs) => planPayBill({ bill: item.entry, outstanding, vendor, taxConfig }, { ...inputs, amount: gross }),
    { withhold: taxConfig?.pph23?.active !== false },
    // Live: the server's dry-run of this payment, keyed by the bill entry's uuid.
    hydrated && item.entry.uuid
      ? { path: `/bills/${item.entry.uuid}/payments`, body: (ask) => paymentBody(gross, ask), flow: VENDOR_MONEY }
      : null,
  )
  const valid = gross > 0 && draft.check.ok && !busy
  const submit = () => {
    const out = payVendorBill(item.entry.id, { amount: gross, edited: draft.edited })
    if (hydrated) {
      settlePost(out, draft, setBusy).then((res) => { if (res?.ok) onClose() })
      return
    }
    onClose()
  }

  return (
    <Modal
      title={`Pay ${item.entry.source?.ref || item.entry.id}`}
      subtitle={`${vendorName || t('Vendor')} · ${t('outstanding')} ${money2(outstanding)} · ${vendor?.pph23Rate != null ? t('vendor rate') : t('company rate')} ${rate}%`}
      size="2xl"
      onClose={onClose}
      footer={
        <>
          <BalanceBadge draft={draft} />
          <button onClick={onClose} className="btn-ghost">{t('Cancel')}</button>
          <button
            onClick={submit}
            disabled={!valid}
            className="btn-gold"
            data-post
          >
            <Banknote size={14} /> {partial ? t('Record part payment') : t('Settle bill')}
          </button>
        </>
      }
    >
      <Field label="Amount (gross)" hint={`${t('Maximum')} ${money2(outstanding)}`}>
        <NumberInput value={amount} onChange={(e) => setAmount(e.target.value)} min={0} max={outstanding} step={1_000_000} />
      </Field>

      <PostingEditor draft={draft} dateLabels={VENDOR_DATES} />

      <div className="text-[10px] text-white/40">
        {t('Tax withheld from a vendor is money Oscenia owes the tax office, not a credit it holds — the opposite of PPh 23 withheld by a client.')}
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
export default function Payables() {
  const journal = useStore((s) => s.journal)
  const projects = useStore((s) => s.projects)
  const purchaseOrders = useStore((s) => s.purchaseOrders)
  const role = useStore((s) => s.role)
  const live = useStore((s) => s.hydrated)
  const t = useT()

  const [bucketFilter, setBucketFilter] = useState('all')
  const [paying, setPaying] = useState(null)

  // Open bills come from the same open-items query the receivables side uses,
  // pointed at the payables control account and read in the other direction.
  const rows = useMemo(() => {
    return openItems(journal, { control: '2102', side: 'credit' })
      .map((item) => {
        const src = item.entry.source || {}
        const po = purchaseOrders.find((p) => p.id === src.ref)
        const due = src.due || item.entry.date
        // The vendor's own invoice date, from the bill entry where the server stored it, or
        // from the order once it has been settled against a dated invoice.
        const documentDate = src.documentDate || po?.invoiceDate || null
        const days = daysUntil(due)
        const overdue = days == null ? 0 : -days
        return {
          ...item,
          po,
          due,
          documentDate,
          overdue,
          bucket: bucketFor(overdue),
          vendor: src.vendor || po?.vendorId || '—',
          reference: src.ref || item.entry.id,
          project: item.entry.project,
          projectName: projects.find((p) => p.id === item.entry.project)?.name,
        }
      })
      .sort((a, b) => b.overdue - a.overdue)
  }, [journal, purchaseOrders, projects])

  const clientTotals = useMemo(() => {
    const map = Object.fromEntries(BUCKETS.map((b) => [b.key, 0]))
    rows.forEach((r) => { map[r.bucket.key] += r.outstanding })
    return map
  }, [rows])

  const clientAP = rows.reduce((a, r) => a + r.outstanding, 0)
  const clientOverdue = rows.filter((r) => r.overdue > 0).reduce((a, r) => a + r.outstanding, 0)
  const clientLedger = accountBalance(journal, '2102')
  // Withholding collected but not yet remitted to the tax office.
  const clientWithheld = accountBalance(journal, '2105')

  // Signed in, the totals, the buckets, the withholding owed and the ledger reconciliation come from
  // the server's ageing report (as at the date the rows are aged against, so a card and the table
  // under it agree); the bill rows stay the open items the browser lists. The browser's own figures
  // are the demo's source and the cross-check.
  const report = useReport('/payables/ageing', { asOf: appToday() }, adaptAgeing, { enabled: live })
  const server = live ? report.data : null
  const totals = server ? Object.fromEntries(server.buckets.map((b) => [b.key, b.amount])) : clientTotals
  const totalAP = server ? server.total : clientAP
  const overdueAP = server ? server.overdue : clientOverdue
  const ledgerAP = server ? server.ledgerBalance : clientLedger
  const reconciled = server ? server.reconciled : Math.abs(ledgerAP - totalAP) < 1
  const withheld = server && server.withholdingOwed != null ? server.withholdingOwed : clientWithheld
  useCrossCheck('payables: open bills vs server total', server ? server.total : null, clientAP)
  useCrossCheck('payables: PPh 23 owed (2105)', server && server.withholdingOwed != null ? server.withholdingOwed : null, clientWithheld)

  const visible = bucketFilter === 'all' ? rows : rows.filter((r) => r.bucket.key === bucketFilter)

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Working Capital"
        title="Accounts Payable"
        subtitle="What Oscenia owes its vendors, and how late. Approving a purchase order raises the debt; paying it clears the payable and withholds PPh 23 at source. The total is reconciled against account 2102."
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
        <Card>
          <div className="text-xs text-white/40">{t('Total Payable')}</div>
          <div className="mt-1 font-display text-xl text-white tabular-nums">{money2(totalAP)}</div>
          <div className="text-[10px] text-white/30 mt-0.5">{rows.length} {t('open bills')}</div>
        </Card>
        <Card>
          <div className="text-xs text-white/40">{t('Overdue')}</div>
          <div className="mt-1 font-display text-xl text-rose-300 tabular-nums">{money2(overdueAP)}</div>
          <div className="text-[10px] text-white/30 mt-0.5">
            {totalAP ? ((overdueAP / totalAP) * 100).toFixed(1) : '0.0'}% {t('of book')}
          </div>
        </Card>
        <Card>
          <div className="text-xs text-white/40">{t('PPh 23 owed to the tax office')}</div>
          <div className="mt-1 font-display text-xl text-amber-300 tabular-nums">{money2(withheld)}</div>
          <div className="text-[10px] text-white/30 mt-0.5">{t('withheld from vendors · account')} 2105</div>
        </Card>
        <Card className={reconciled ? '' : 'border-rose-500/50'}>
          <div className="text-xs text-white/40">{t('Ledger 2102')}</div>
          <div className="mt-1 font-display text-lg text-white tabular-nums">{money(ledgerAP)}</div>
          <div className={`mt-0.5 inline-flex items-center gap-1 text-[10px] ${reconciled ? 'text-emerald-300' : 'text-rose-300'}`}>
            {reconciled ? <><Check size={11} /> {t('Reconciled')}</> : <><AlertTriangle size={11} /> {t('Out by')} {money(ledgerAP - totalAP)}</>}
          </div>
        </Card>
      </div>

      <SectionTitle icon={Clock}>{t('Ageing')}</SectionTitle>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {BUCKETS.map((b) => {
          const value = totals[b.key]
          const share = totalAP ? (value / totalAP) * 100 : 0
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
        icon={Wallet}
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
        {t('Open Vendor Bills')}
      </SectionTitle>

      <TableWrap>
        <thead>
          <tr>
            <th className="th">{t('Reference')}</th>
            <th className="th">{t('Vendor')}</th>
            <th className="th">{t('Project ID')}</th>
            <th className="th text-right">{t('Billed')}</th>
            <th className="th text-right">{t('Outstanding')}</th>
            <th className="th">{t('Invoice date')}</th>
            <th className="th">{t('Due')}</th>
            <th className="th">{t('Ageing')}</th>
            <th className="th text-right">{t('Action')}</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((r) => (
            <tr key={r.entry.id} className={r.overdue > 30 ? 'bg-rose-500/[0.05]' : ''}>
              <td className="td font-medium text-white">
                <span className="inline-flex items-center gap-1.5">
                  {r.reference}
                  {r.applied > 0 && r.outstanding > 0 && <Badge>Partially Paid</Badge>}
                </span>
                <div className="font-mono text-[10px] text-white/25">{r.entry.voucherNo}</div>
              </td>
              <td className="td text-white/70">
                <span className="inline-flex items-center gap-1.5"><Truck size={12} className="text-white/30" /> {r.vendor}</span>
              </td>
              <td className="td font-mono text-xs text-gold/80">{r.project || '—'}</td>
              <td className="td text-right tabular-nums text-white/50">
                {money2(r.raised)}
                {r.applied > 0 && <div className="text-[10px] text-emerald-300/70">{money(r.applied)} {t('paid')}</div>}
              </td>
              <td className="td text-right tabular-nums text-white">{money2(r.outstanding)}</td>
              <td className="td text-white/50">
                {r.documentDate ? formatDate(r.documentDate) : <span className="text-white/25">—</span>}
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
                <ActionButton
                  action="pay_po"
                  role={role}
                  onClick={() => setPaying(r)}
                  className="inline-flex items-center gap-1 text-xs text-emerald-300 hover:text-emerald-200 disabled:opacity-30"
                >
                  <Banknote size={13} /> {t('Pay')}
                </ActionButton>
              </td>
            </tr>
          ))}
          {!visible.length && (
            <tr><td className="td text-white/30" colSpan={9}>{t('Nothing outstanding in this bucket.')}</td></tr>
          )}
        </tbody>
      </TableWrap>

      <div className="mt-3 flex items-start gap-2 text-[11px] text-white/30">
        <Link2 size={13} className="shrink-0 mt-0.5 text-sky-300/50" />
        <span>
          {t('Every bill here is a posted journal entry, and every payment is linked back to the bill it settles — so a purchase order, its debt and its disbursement stay one chain in the ledger.')}
        </span>
      </div>

      {paying && <PayBillModal item={paying} onClose={() => setPaying(null)} />}
    </div>
  )
}
