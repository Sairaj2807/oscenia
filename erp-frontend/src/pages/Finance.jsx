import { useState } from 'react'
import {
  Zap, FileText, CheckCircle2, ArrowRight, Download, Undo2, HandCoins, CalendarClock,
} from 'lucide-react'
import { useStore } from '../store/useStore'
import { PageHeader, Card, TableWrap, Badge, money, money2, ActionButton } from '../components/ui'
import ReceivePaymentModal, { outstandingOf } from '../components/ReceivePaymentModal'
import PostingModal, { CLIENT_DATES } from '../components/PostingModal'
import useConfirmPosting from '../components/useConfirmPosting'
import { planDpConfirm } from '../lib/postings'
import { CLIENT_MONEY, confirmDpBody } from '../lib/apiPostings'
import { daysUntil, formatDate } from '../lib/format'
import { invoicePDF } from '../lib/pdf'
import { useT } from '../i18n'

// One accepted quotation awaiting its down payment.
//
// Lifted out of Finance so each deal carries its OWN confirm button and its own busy state.
// While this was inline there could only be one of it, which is exactly what stopped the
// first of two accepted quotations from ever being approved.
function DealCard({ deal }) {
  const confirmDownPayment = useStore((s) => s.confirmDownPayment)
  const undoDownPayment = useStore((s) => s.undoDownPayment)
  const quotations = useStore((s) => s.quotations)
  const role = useStore((s) => s.role)
  const taxConfig = useStore((s) => s.taxConfig)
  const invoiceSeq = useStore((s) => s.invoiceSeq)
  const t = useT()
  const [busy, setBusy] = useState(false)
  // REQ-05, and this is the action that most needed it: confirming a down payment creates
  // the project, mints an invoice per billing stage, issues the first and records its
  // receipt -- three documents in one transaction, and until now the first sight of any of
  // them was in the General Ledger afterwards.
  const { state: posting, ask, close } = useConfirmPosting()

  // The endpoint is keyed by QUOTATION: a deal is a client-side idea, the quotation is the
  // thing both sides agree exists. Same resolution `confirmDownPayment` does.
  const quote = quotations.find((q) => `DEAL-${q.id}` === deal.id)

  // `edited` is the pop-up's version of the receipt (round 4). Offline path; the live one
  // posts from the pop-up and waits for the server (see the PostingModal below).
  const onConfirm = (edited) => {
    setBusy(true)
    // The id is passed explicitly. Letting it default would be ambiguous the moment a
    // second quotation is accepted, and guessing is the original bug.
    setTimeout(() => { confirmDownPayment(deal.id, edited ? { edited } : undefined); setBusy(false) }, 550)
  }
  // What confirming would post, worked out locally: the invoice it would mint is the next in
  // the sequence, exactly as the store numbers it.
  const planFor = (inputs) => planDpConfirm(
    { deal, taxConfig, invoiceId: `INV-${String(invoiceSeq).padStart(4, '0')}`, projectId: deal.projectIdOnConfirm },
    inputs,
  )

  return (
        <Card className="border-gold/30 bg-gradient-to-br from-gold/[0.07] to-transparent mb-5">
          <div className="flex flex-col lg:flex-row lg:items-center gap-5">
            <div className="grid h-12 w-12 place-items-center rounded-xl bg-gold/15 text-gold-light shrink-0">
              <Zap size={22} />
            </div>
            <div className="flex-1">
              <div className="eyebrow mb-1">State-Machine Trigger</div>
              <div className="text-lg text-white font-medium">Pending deal · {deal.name}</div>
              <div className="text-sm text-white/50 mt-1">
                {deal.client} · Contract {money(deal.contractValue)} · DP {money(deal.dpAmount)} ({deal.dpPercent ?? 30}%)
              </div>

              {/* The phased billing schedule the quotation agreed. Confirming the
                  DP drafts every later stage into Accounts Receivable at once. */}
              {deal.dpSchedule?.length > 1 && (
                <div className="mt-2.5 rounded-lg border border-white/10 bg-white/[0.02] p-2.5">
                  <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-white/35 mb-1.5">
                    <CalendarClock size={11} /> {t('Agreed payment schedule')}
                  </div>
                  <div className="space-y-1">
                    {deal.dpSchedule.map((st, i) => (
                      <div key={i} className="flex flex-wrap items-baseline justify-between gap-2 text-[11px]">
                        <span className={i === 0 ? 'text-gold-light' : 'text-white/60'}>{st.label}</span>
                        <span className="text-white/30">{formatDate(st.due)}</span>
                        <span className="tabular-nums text-white/40 w-12 text-right">{st.percent.toFixed(0)}%</span>
                        <span className="tabular-nums text-white/80 w-32 text-right">{money2(st.amount)}</span>
                      </div>
                    ))}
                  </div>
                  <div className="mt-1.5 text-[10px] text-white/30">
                    {t('Stage one settles on confirmation; the rest are drafted into AR as scheduled billing.')}
                  </div>
                </div>
              )}

              {deal.confirmed && (
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-white/60">
                  <span className="text-emerald-400 flex items-center gap-1"><CheckCircle2 size={14} /> DP confirmed</span>
                  <ArrowRight size={14} className="text-white/30" />
                  <span className="font-mono text-gold/80">{deal.projectIdOnConfirm}</span>
                  <span>created</span>
                  <ArrowRight size={14} className="text-white/30" />
                  <span>pipeline started</span>
                  <ArrowRight size={14} className="text-white/30" />
                  <span>ledger updated</span>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2 self-start lg:self-auto">
              <button
                onClick={() => ask(`/quotations/${quote?.uuid}/confirm-down-payment`, {}, { editable: true })}
                disabled={deal.confirmed || busy}
                className="btn-gold whitespace-nowrap"
              >
                {busy ? t('Processing…') : deal.confirmed ? t('Project Created ✓') : t('Confirm Down Payment')}
              </button>
              {/* Financial rollback (slide 3). Refuses once the project has
                  activity of its own — see undoDownPayment in the store. */}
              {deal.confirmed && (
                <ActionButton
                  action="confirm_dp"
                  role={role}
                  onClick={() => undoDownPayment(deal.id)}
                  className="btn-ghost whitespace-nowrap border-rose-500/40 text-rose-300 disabled:opacity-30"
                  title={t('Reverse the receipt and remove the project it created')}
                >
                  <Undo2 size={15} /> {t('Undo')}
                </ActionButton>
              )}
            </div>
          </div>
          {!deal.confirmed && (
            <div className="mt-4 text-[11px] text-white/40 border-t border-white/10 pt-3">
              When finance confirms the DP, the system auto-generates a Project ID, creates the project card on the
              board at <span className="text-gold/70">“DP Paid”</span>, logs the DP invoice, and reconciles AR — no
              manual hand-off between teams.
            </div>
          )}

          {posting && (
            <PostingModal
              title={t('Confirm the down payment?')}
              subtitle={`${deal.name} · ${t('check or edit the receipt before it posts')}`}
              server={posting.local || posting.live ? null : posting}
              // Live: the receipt is the server's dry-run, editable; only it ever changes.
              live={posting.live && quote?.uuid ? {
                path: `/quotations/${quote.uuid}/confirm-down-payment`, body: confirmDpBody, flow: CLIENT_MONEY,
              } : null}
              planFor={planFor}
              dateLabels={CLIENT_DATES}
              confirmLabel="Confirm down payment"
              onConfirm={(edited) => {
                // Live: stay open until the server answers, so a refusal shows in the pop-up.
                if (posting.live) {
                  return Promise.resolve(confirmDownPayment(deal.id, { edited })).then((res) => {
                    if (res?.ok) close()
                    return res
                  })
                }
                close()
                onConfirm(edited)
                return undefined
              }}
              onClose={close}
            />
          )}
        </Card>

  )
}

export default function Finance() {
  const invoices = useStore((s) => s.invoices)
  const projects = useStore((s) => s.projects)
  // A LIST. There used to be one `pendingDeal` and one `dpConfirmed` flag, so accepting a
  // second quotation replaced the first deal outright and Finance could only ever offer the
  // newest one — the client's "second quotation blocks DP approval on the first".
  const deals = useStore((s) => s.deals)
  const role = useStore((s) => s.role)
  const t = useT()
  const [paying, setPaying] = useState(null)

  // Projects created by a confirmed deal, for highlighting their invoices below.
  const confirmedProjectIds = new Set(
    deals.filter((d) => d.confirmed).map((d) => d.projectIdOnConfirm)
  )

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Finance & Invoicing"
        title="Finance & Accounting"
        subtitle="Installment invoicing, accounts receivable, and the down-payment trigger that boots the whole production pipeline."
      />

      {deals.map((deal) => <DealCard key={deal.id} deal={deal} />)}

      {/* Previously this screen dereferenced `deal.name` with no guard, so declining the
          one accepted quotation set `pendingDeal` to null and /finance threw on load. With
          a list the empty case is just an empty list, and it says so. */}
      {!deals.length && (
        <Card className="mb-5">
          <div className="flex items-center gap-3 text-sm text-white/45">
            <Zap size={18} className="text-white/25 shrink-0" />
            <span>
              {t('No accepted quotations are waiting on a down payment. Accept one from Quotations and it will appear here.')}
            </span>
          </div>
        </Card>
      )}

      <div className="flex items-center gap-2 mb-3">
        <FileText size={16} className="text-gold/70" />
        <h2 className="text-sm uppercase tracking-wider text-white/50">{t('Installment Invoices')}</h2>
      </div>

      <TableWrap>
        <thead>
          <tr>
            <th className="th">{t('Invoice')}</th>
            <th className="th">{t('Project ID')}</th>
            <th className="th">{t('Type')}</th>
            <th className="th text-right">{t('Amount')}</th>
            <th className="th text-right">{t('Outstanding')}</th>
            <th className="th">{t('Status')}</th>
            <th className="th">{t('Due')}</th>
            <th className="th">{t('Countdown')}</th>
            <th className="th text-right">{t('Action')}</th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((i) => {
            const proj = projects.find((p) => p.id === i.project)
            return (
              <tr
                key={i.id}
                className={confirmedProjectIds.has(i.project) ? 'bg-gold/[0.06]' : ''}
              >
                <td className="td font-medium text-white">{i.id}</td>
                <td className="td font-mono text-xs text-gold/80">{i.project}</td>
                <td className="td">{i.type}</td>
                <td className="td text-right tabular-nums">{money2(i.amount)}</td>
                <td className="td text-right tabular-nums text-white/70">
                  {outstandingOf(i) > 0 ? money2(outstandingOf(i)) : <span className="text-white/20">—</span>}
                </td>
                <td className="td"><Badge>{i.status}</Badge></td>
                <td className="td text-white/50">{formatDate(i.due)}</td>
                <td className="td">
                  {/* Payment-deadline tracking. Paid invoices need no countdown. */}
                  {i.status === 'Paid' ? (
                    <span className="text-emerald-400/70 text-xs">{'\u2713'} {t('settled')}</span>
                  ) : (() => {
                    const d = daysUntil(i.due)
                    if (d == null) return <span className="text-white/20 text-xs">—</span>
                    const overdue = d < 0
                    return (
                      <span className={`text-xs tabular-nums ${
                        overdue ? 'text-rose-300' : d <= 7 ? 'text-amber-300' : 'text-white/50'
                      }`}>
                        {overdue ? `${Math.abs(d)}d ${t('overdue')}` : `${t('in')} ${d}d`}
                      </span>
                    )
                  })()}
                </td>
                <td className="td text-right">
                  <div className="flex items-center justify-end gap-2">
                    <button
                      onClick={() => invoicePDF(i, proj?.name, proj?.client)}
                      className="inline-flex items-center gap-1 text-xs text-white/40 hover:text-gold-light"
                    >
                      <Download size={13} /> PDF
                    </button>
                    {/* The settlement action that used to be missing entirely,
                        which is why receivable balances never moved. */}
                    {i.status !== 'Scheduled' && outstandingOf(i) > 0 && (
                      <ActionButton
                        action="confirm_dp"
                        role={role}
                        onClick={() => setPaying(i)}
                        className="inline-flex items-center gap-1 text-xs text-emerald-300 hover:text-emerald-200 disabled:opacity-30"
                      >
                        <HandCoins size={13} /> {t('Receive')}
                      </ActionButton>
                    )}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </TableWrap>

      {paying && <ReceivePaymentModal invoice={paying} onClose={() => setPaying(null)} />}
    </div>
  )
}
