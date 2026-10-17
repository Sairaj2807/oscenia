// The purchase-order pipeline (client round 1, V1; shared since round 3): the board, its cards
// and the actions that move an order along. Purchase Orders shows it beside its table, and
// Vendor Management shows it as its "PO pipeline" view, so both read and act the same way.
// The rules live in lib/vendors.js; money still moves only through the store's PO actions.

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Check, CreditCard, ArrowRight, Download } from 'lucide-react'
import { useStore } from '../store/useStore'
import { useProto } from '../store/useProto'
import { useAuth } from '../store/useAuth'
import { Badge, money, money2, Field, NumberInput, TextInput, FilterPill, ActionButton } from './ui'
import Modal from './Modal'
import PostingModal, { VENDOR_DATES } from './PostingModal'
import useConfirmPosting from './useConfirmPosting'
import { planPayPoDp, planSettlePo } from '../lib/postings'
import { VENDOR_MONEY, payDpBody, settleBody } from '../lib/apiPostings'
import {
  poTotal, poDpAmount, poOutstanding, poActionLabel, DELIVERY_STATUSES, PIPELINE, pipelineStage, pipelineSteps,
  canOrderFrom, vendorStageOf, vendorKey,
} from '../lib/vendors'
import { purchaseOrderPDF } from '../lib/pdf'
import { formatDate, appToday } from '../lib/format'
import { useT } from '../i18n'

// Settling asks what the vendor ACTUALLY charged. Defaulting it to the committed
// amount keeps the common case one click, while making the variance possible at
// all — the previous version simply paid the balance, so budget and actual could
// never diverge.
export function SettleModal({ po, vendor, onClose }) {
  const t = useT()
  const settlePurchaseOrder = useStore((s) => s.settlePurchaseOrder)
  const taxConfig = useStore((s) => s.taxConfig)
  // Subscribed so the plan follows the ledger (the bill, what is still owed on it).
  useStore((s) => s.journal)
  // Worth confirming precisely because of the variance: settling above or below the
  // committed amount corrects the cost BEFORE the payment, and that correction is the
  // figure somebody is really agreeing to.
  const { state: posting, ask, close } = useConfirmPosting()
  const committed = poTotal(po)
  const paid = poDpAmount(po)
  const [actual, setActual] = useState(committed)
  // The date the VENDOR dated their invoice. It does not move the settlement: a bill that
  // arrives in October for September work still posts in October, and the period-close
  // trigger would refuse September anyway. It is recorded so month end can reconcile the
  // two -- the AP half of the client's dual-date ask.
  const [invoiceDate, setInvoiceDate] = useState('')

  const value = Math.max(0, Number(actual) || 0)
  const variance = committed - value
  const remaining = value - paid
  // What settling would post, worked out the way the store will post it (round 4): the bill
  // and the variance read-only, the final payment editable.
  const planFor = (inputs) => {
    const st = useStore.getState()
    return planSettlePo(
      { po, vendor, taxConfig, bill: st._billFor(po.id), billOutstanding: st.poOutstanding(po.id) },
      { ...inputs, actualTotal: value },
    )
  }

  return (
    <Modal
      title={`Settle ${po.id}`}
      subtitle={`${vendor?.name ?? po.vendorId} · ${t('enter the vendor\u2019s final invoice value')}`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="btn-ghost">{t('Cancel')}</button>
          <button
            onClick={() => ask(`/purchase-orders/${po.uuid}/settle`, {
              actualTotal: String(Math.round(value)),
              invoiceDate: invoiceDate || null,
            }, { editable: true })}
            className="btn-gold"
          >
            <Check size={14} /> {t('Review posting')}
          </button>
        </>
      }
    >
      <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3 space-y-1.5 text-xs">
        <div className="flex justify-between">
          <span className="text-white/40">{t('Committed (locked budget)')}</span>
          <span className="tabular-nums text-white/85">{money2(committed)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-white/40">{t('DP already paid')}</span>
          <span className="tabular-nums text-white/85">{money2(paid)}</span>
        </div>
      </div>

      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Actual final invoice (Rp)" hint={t('Defaults to the committed amount')}>
          <NumberInput value={actual} onChange={(e) => setActual(e.target.value)} min={0} />
        </Field>
        <Field label="Date on vendor receipt/invoice" hint={t('Optional — the pop-up asks for the date received')}>
          <TextInput type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
        </Field>
      </div>

      <div className={`rounded-lg border p-3 text-xs ${
        variance === 0
          ? 'border-white/10 bg-white/[0.02] text-white/60'
          : variance > 0
            ? 'border-emerald-500/40 bg-emerald-500/[0.06] text-emerald-200'
            : 'border-rose-500/40 bg-rose-500/[0.06] text-rose-200'
      }`}>
        {variance === 0
          ? t('Settles exactly at budget — no variance.')
          : variance > 0
            ? <>{t('Gain')}: <strong>{money2(variance)}</strong> {t('under the committed budget.')}</>
            : <>{t('Loss')}: <strong>{money2(-variance)}</strong> {t('over the committed budget.')}</>}
        <div className="mt-1.5 text-white/50">
          {remaining > 0
            ? <>{t('Pays')} {money2(remaining)} {t('now.')}</>
            : remaining < 0
              ? <>{t('Vendor refunds')} {money2(-remaining)} {t('of the advance.')}</>
              : t('Nothing further to pay.')}
        </div>
      </div>
      {posting && (
        <PostingModal
          title={`${t('Settle')} ${po.id}?`}
          subtitle={t('This is what settling against the vendor\u2019s final invoice will write to the ledger.')}
          server={posting.local || posting.live ? null : posting}
          // Live: the server's dry-run of the settlement; only the final payment is editable.
          live={posting.live && po.uuid ? {
            path: `/purchase-orders/${po.uuid}/settle`,
            body: (ask) => settleBody(value, { invoiceDate: invoiceDate || null, edited: ask }),
            flow: VENDOR_MONEY,
          } : null}
          planFor={planFor}
          // Live, an empty receipt date is seeded from the server (its today), not the demo's.
          initial={{ documentDate: invoiceDate || (posting.live ? null : appToday()) }}
          dateLabels={VENDOR_DATES}
          confirmLabel="Settle"
          onConfirm={(edited) => {
            if (posting.live) {
              return Promise.resolve(settlePurchaseOrder(po.id, value, { invoiceDate: invoiceDate || null, edited }))
                .then((res) => {
                  if (res?.ok) { close(); onClose() }
                  return res
                })
            }
            settlePurchaseOrder(po.id, value, { invoiceDate: invoiceDate || null, ...(edited ? { edited } : {}) })
            close()
            onClose()
            return undefined
          }}
          onClose={close}
        />
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Moving an order one step on: approve a draft, pay its DP, or open the settle dialog. Shared
// by the table and the board. Returns the settle dialog to render (or null) alongside.
// ---------------------------------------------------------------------------
export function usePoAdvance() {
  const vendors = useStore((s) => s.vendors)
  const pushToast = useStore((s) => s.pushToast)
  const approvePurchaseOrder = useStore((s) => s.approvePurchaseOrder)
  const payPoDownPayment = useStore((s) => s.payPoDownPayment)
  const hydrated = useStore((s) => s.hydrated)
  const taxConfig = useStore((s) => s.taxConfig)
  const t = useT()
  const [settling, setSettling] = useState(null)
  // The vendor DP pop-up (round 4): the payment is shown and editable before it posts -- on a
  // live backend too, seeded from the server's dry-run of pay-dp.
  const [payingDp, setPayingDp] = useState(null)

  const advance = (po) => {
    if (po.status === 'Draft') {
      // Approving a draft is when the order is really placed, so the vendor must be vetted (V2).
      const stage = vendorStageOf(useProto.getState().vendorStages, vendorKey(vendors.find((v) => v.id === po.vendorId)) || po.vendorId)
      if (!canOrderFrom(stage)) {
        pushToast({ title: t('Not approved'), body: `${t('This vendor is')} ${t(stage)}. ${t('Only approved or active vendors can be given a new purchase order.')}`, kind: 'redflag' })
        return
      }
      approvePurchaseOrder(po.id)
    } else if (po.status === 'Approved') {
      // An order with no down payment has nothing to pay and cannot reach 'DP Paid', so it
      // goes straight to settlement. `settlePurchaseOrder` already accepted 'Approved' for
      // exactly this reason; this route is what was missing, so the store-side fix had
      // never been reachable from the screen.
      if (poDpAmount(po) <= 0) setSettling(po)
      else setPayingDp(po)
    } else if (po.status === 'DP Paid') {
      // Settling needs the actual invoice value, so it opens a dialog.
      setSettling(po)
    }
  }

  // Draft -> Approved is an approval; the two payment steps are cash.
  const actionFor = (po) => (po.status === 'Draft' ? 'approve_po' : 'pay_po')

  const dpVendor = payingDp && vendors.find((v) => v.id === payingDp.vendorId)
  const settleModal = (settling && (
    <SettleModal po={settling} vendor={vendors.find((v) => v.id === settling.vendorId)} onClose={() => setSettling(null)} />
  )) || (payingDp && (
    <PostingModal
      title={`${t('Pay down payment')} — ${payingDp.id}`}
      subtitle={`${dpVendor?.name ?? payingDp.vendorId} · ${payingDp.terms?.dpPercent ?? 0}% · ${money2(poDpAmount(payingDp))}`}
      planFor={(inputs) => planPayPoDp(
        { po: payingDp, vendor: dpVendor, taxConfig, bill: useStore.getState()._billFor(payingDp.id) },
        inputs,
      )}
      live={hydrated && payingDp.uuid
        ? { path: `/purchase-orders/${payingDp.uuid}/pay-dp`, body: payDpBody, flow: VENDOR_MONEY }
        : null}
      dateLabels={VENDOR_DATES}
      confirmLabel="Pay down payment"
      onConfirm={(edited) => {
        if (hydrated) {
          return Promise.resolve(payPoDownPayment(payingDp.id, { edited })).then((res) => {
            if (res?.ok) setPayingDp(null)
            return res
          })
        }
        payPoDownPayment(payingDp.id, { edited })
        setPayingDp(null)
        return undefined
      }}
      onClose={() => setPayingDp(null)}
    />
  ))
  return { advance, actionFor, settleModal }
}

// ---------------------------------------------------------------------------
// The pipeline board (client round 1, V1): PO Issued → DP Paid → In Progress → Delivered →
// Fully Paid. Money moves by the same actions as the table (approve, pay DP, settle — each
// posting to the ledger as before); delivery is set on the card and changes nothing in the
// books. Drafts and cancelled orders are not live commitments, so they sit off the board.
// ---------------------------------------------------------------------------
export function PipelineBoard({ pos, vendors, projects, role, deliveryOf, advance, actionFor }) {
  const t = useT()
  const [showOff, setShowOff] = useState(false)
  const off = pos.filter((po) => !pipelineStage(po, deliveryOf(po)))
  const columns = PIPELINE.map((stage) => ({ stage, items: pos.filter((po) => pipelineStage(po, deliveryOf(po)) === stage) }))

  return (
    <div>
      {/* Columns scroll sideways inside this box on small screens — never the page itself. */}
      <div className="-mx-1 overflow-x-auto pb-2">
        <div className="grid min-w-[1100px] grid-cols-5 gap-3 px-1">
          {columns.map(({ stage, items }) => (
            <div key={stage} className="flex flex-col rounded-xl border border-white/10 bg-white/[0.02]" data-stage={stage}>
              <div className="border-b border-white/10 px-3 py-2">
                <div className="flex items-center justify-between text-xs uppercase tracking-wider text-white/55">
                  <span>{t(stage)}</span><span className="rounded-full bg-white/10 px-2 text-[10px] text-white/70">{items.length}</span>
                </div>
                <div className="mt-0.5 text-[11px] tabular-nums text-white/35">{money(items.reduce((a, po) => a + poTotal(po), 0))}</div>
              </div>
              <div className="flex-1 space-y-2 p-2">
                {items.map((po) => (
                  <PoCard key={po.id} po={po} vendor={vendors.find((v) => v.id === po.vendorId)} project={projects.find((p) => p.id === po.project)}
                    role={role} delivery={deliveryOf(po)} advance={advance} actionFor={actionFor} />
                ))}
                {items.length === 0 && <div className="px-1 py-4 text-center text-[11px] text-white/25">{t('Nothing here')}</div>}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-3">
        <FilterPill active={showOff} onClick={() => setShowOff((v) => !v)}>{t('Drafts & cancelled')} · {off.length}</FilterPill>
        {showOff && (
          <div className="mt-2 space-y-1.5">
            {off.map((po) => (
              <div key={po.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-sm">
                <span className="font-medium text-white">{po.id}</span>
                <span className="text-white/60">{vendors.find((v) => v.id === po.vendorId)?.name ?? po.vendorId}</span>
                <span className="font-mono text-xs text-gold/70">{po.project}</span>
                <span className="tabular-nums text-white/70">{money(poTotal(po))}</span>
                <span className="ml-auto"><Badge>{po.status}</Badge></span>
                {po.status === 'Draft' && (
                  <ActionButton action="approve_po" role={role} onClick={() => advance(po)}
                    className="inline-flex items-center gap-1 text-xs text-gold/80 hover:text-gold-light disabled:opacity-30 disabled:cursor-not-allowed">
                    <Check size={13} />{t('Approve')}
                  </ActionButton>
                )}
              </div>
            ))}
            {off.length === 0 && <div className="text-xs text-white/35">{t('No drafts or cancelled orders.')}</div>}
          </div>
        )}
      </div>
    </div>
  )
}

function PoCard({ po, vendor, project, role, delivery, advance, actionFor }) {
  const t = useT()
  const author = useAuth((s) => s.user?.name)
  const rec = useProto((s) => s.poDelivery?.[po.id])
  const pushToast = useStore((s) => s.pushToast)
  const live = useStore((s) => s.hydrated)
  const label = poActionLabel(po)
  const setDelivery = (status) => {
    // Signed in the server records it (and says why if it refuses); signed out the demo keeps its own copy.
    if (live) { useStore.getState().setPoDelivery(po.id, status); return }
    if (!useProto.getState().setPoDelivery(po, status, author)) {
      pushToast({ title: t('Not changed'), body: t('Delivery can only be tracked on a live order.'), kind: 'redflag' })
    }
  }
  return (
    <div className="rounded-lg border border-white/10 bg-navy-900 p-2.5 text-sm" data-po={po.id}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium text-white">{po.id}</span>
        <span className="font-mono text-[10px] text-gold/70">{po.project}</span>
      </div>
      <Link to={`/vendors/${po.vendorId}`} className="block truncate text-xs text-white/70 hover:text-gold-light">{vendor?.name ?? po.vendorId}</Link>
      {project?.name && <div className="truncate text-[10px] text-white/35">{project.name}</div>}
      <ProgressStrip po={po} delivery={delivery} />
      <div className="mt-1.5 flex justify-between text-xs tabular-nums">
        <span className="text-white/80">{money(poTotal(po))}</span>
        {poOutstanding(po) > 0 && <span className="text-amber-300" title={t('Outstanding')}>{money(poOutstanding(po))}</span>}
      </div>
      <label className="mt-2 flex items-center gap-1.5 text-[11px] text-white/45">
        {t('Delivery')}
        <select value={delivery} onChange={(e) => setDelivery(e.target.value)} aria-label={`${t('Delivery')} ${po.id}`}
          className={`min-w-0 flex-1 rounded-md border px-1.5 py-0.5 text-[11px] ${delivery === 'Delivered' ? 'border-emerald-500/30 text-emerald-200' : delivery === 'In progress' ? 'border-sky-500/30 text-sky-200' : 'border-white/10 text-white/70'} bg-navy-950`}>
          {DELIVERY_STATUSES.map((d) => <option key={d} value={d}>{t(d)}</option>)}
        </select>
      </label>
      {!live && rec?.at && <div className="mt-0.5 text-[10px] text-white/30">{rec.by} · {formatDate(rec.at.slice(0, 10))}, {rec.at.slice(11, 16)}</div>}
      {live && po.deliveryUpdatedAt && <div className="mt-0.5 text-[10px] text-white/30">{formatDate(String(po.deliveryUpdatedAt).slice(0, 10))}</div>}
      <div className="mt-2 flex items-center justify-between gap-2">
        <button onClick={() => purchaseOrderPDF(po, vendor, project?.name)} className="inline-flex items-center gap-1 text-[11px] text-white/45 hover:text-white">
          <Download size={12} /> PDF
        </button>
        {label && (
          <ActionButton action={actionFor(po)} role={role} onClick={() => advance(po)}
            className="inline-flex items-center gap-1 text-[11px] text-gold/80 hover:text-gold-light disabled:opacity-30 disabled:cursor-not-allowed">
            <CreditCard size={12} />{t(label)}<ArrowRight size={11} />
          </ActionButton>
        )}
      </div>
    </div>
  )
}

// Five steps, PO Issued → Fully Paid, so each order's progression reads at a glance (round 3).
// Done steps are gold, the current column's step is ringed, and a skipped DP is hatched.
function ProgressStrip({ po, delivery }) {
  const t = useT()
  const steps = pipelineSteps(po, delivery)
  const said = (s) => `${t(s.stage)}: ${s.state === 'done' ? t('done') : s.state === 'skipped' ? t('skipped — no down payment') : t('not yet')}`
  return (
    <div className="mt-2 flex gap-1" role="img" aria-label={steps.map(said).join(', ')} data-steps={po.id}>
      {steps.map((s) => (
        <span key={s.stage} title={said(s)} data-step={s.stage} data-state={s.state}
          className={`h-1.5 flex-1 rounded-full ${
            s.state === 'done' ? 'bg-gold/80'
              : s.state === 'skipped' ? 'bg-[repeating-linear-gradient(135deg,rgba(255,255,255,0.18)_0_2px,transparent_2px_4px)]'
                : 'bg-white/10'
          } ${s.current ? 'ring-1 ring-gold-light ring-offset-1 ring-offset-navy-900' : ''}`} />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The board with everything it needs, for pages that only show it (Vendor Management's
// "PO pipeline" view). Purchase Orders composes the parts itself, as its table shares them.
// ---------------------------------------------------------------------------
export default function PoPipeline({ pos }) {
  const vendors = useStore((s) => s.vendors)
  const projects = useStore((s) => s.projects)
  const role = useStore((s) => s.role)
  const poDelivery = useProto((s) => s.poDelivery)
  const live = useStore((s) => s.hydrated)
  const deliveryOf = (po) => (live ? po.deliveryStatus : poDelivery?.[po.id]?.status) || 'Not started'
  const { advance, actionFor, settleModal } = usePoAdvance()
  return (
    <>
      <PipelineBoard pos={pos} vendors={vendors} projects={projects} role={role} deliveryOf={deliveryOf} advance={advance} actionFor={actionFor} />
      {settleModal}
    </>
  )
}
