import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  ClipboardList, Plus, Check, X, CreditCard, Trash2, ArrowRight, Download, AlertTriangle, Table2, Columns3,
} from 'lucide-react'
import { useStore } from '../store/useStore'
import { useProto } from '../store/useProto'
import { PO_STATUSES } from '../store/seed'
import {
  PageHeader, Card, TableWrap, Badge, money, money2, pct2, SectionTitle,
  Field, NumberInput, Select, FilterPill, ActionButton,
} from '../components/ui'
import Modal from '../components/Modal'
import { PipelineBoard, usePoAdvance } from '../components/PoPipeline'
import {
  poTotal, poDpAmount, poBalance, poPaid, poOutstanding, poActionLabel, poVariance,
  availableQty, eventWindow, pipelineStage, canOrderFrom, vendorStageOf, vendorKey,
} from '../lib/vendors'
import { purchaseOrderPDF } from '../lib/pdf'
import { formatDate, dayCounter } from '../lib/format'
import { useT } from '../i18n'

// ---------------------------------------------------------------------------
// Create a PO by selecting catalogue lines from one vendor. Availability is
// checked against the event window, so the form will not let you commit kit
// that is already promised elsewhere on those dates.
// ---------------------------------------------------------------------------
function NewPoModal({ onClose, presetVendorId }) {
  const vendors = useStore((s) => s.vendors)
  const catalogue = useStore((s) => s.vendorCatalogue)
  const projects = useStore((s) => s.projects)
  const createPurchaseOrder = useStore((s) => s.createPurchaseOrder)
  const vendorStages = useVendorStages()
  const t = useT()

  // Only a vetted supplier can be given an order (V2): prospects, vendors still onboarding, on
  // hold or blacklisted are listed but cannot be picked.
  const orderable = (v) => canOrderFrom(vendorStageOf(vendorStages, vendorKey(v)))
  const active = projects.filter((p) => p.stage !== 'Finished' && !p.cancelled)
  const preset = vendors.find((v) => v.id === presetVendorId && orderable(v))
  const [vendorId, setVendorId] = useState(preset?.id || vendors.find(orderable)?.id || '')
  const [project, setProject] = useState(active[0]?.id || '')
  const [qty, setQty] = useState({})

  const vendor = vendors.find((v) => v.id === vendorId)
  const proj = projects.find((p) => p.id === project)
  const window = eventWindow(proj?.eventDate)
  const items = catalogue.filter((i) => i.vendorId === vendorId)

  const [dpPercent, setDpPercent] = useState(vendor?.terms?.dpPercent ?? 50)

  const lines = items
    .map((i) => ({ item: i, qty: Number(qty[i.id]) || 0 }))
    .filter((l) => l.qty > 0)
    .map((l) => ({ itemId: l.item.id, item: l.item.item, qty: l.qty, unitPrice: l.item.unitPrice }))

  const total = lines.reduce((a, l) => a + l.qty * l.unitPrice, 0)
  const dp = Math.round(total * ((Number(dpPercent) || 0) / 100))

  // Any line asking for more than is free in the window blocks submission.
  const overbooked = items.filter((i) => {
    const want = Number(qty[i.id]) || 0
    if (!want) return false
    return want > availableQty(i, window.from, window.to, { excludeProject: project })
  })

  const valid = lines.length > 0 && project && overbooked.length === 0 && Boolean(vendor && orderable(vendor))

  return (
    <Modal
      title="Create Purchase Order"
      subtitle={t('Select catalogue lines. Availability is checked against the event window.')}
      size="2xl"
      onClose={onClose}
      footer={
        <>
          <div className="mr-auto text-xs">
            <span className="text-white/45">{t('PO total')} </span>
            <span className="font-display text-lg text-gold-light tabular-nums">{money2(total)}</span>
            <span className="text-white/40"> · {t('DP')} {money(dp)}</span>
          </div>
          <button onClick={onClose} className="btn-ghost">{t('Cancel')}</button>
          <button
            onClick={() => {
              createPurchaseOrder({
                vendorId, project, lines,
                eventDate: proj?.eventDate,
                terms: { dpPercent: Number(dpPercent) || 0, settlementDays: vendor?.terms?.settlementDays ?? 14 },
              })
              onClose()
            }}
            disabled={!valid}
            className="btn-gold"
          >
            <Plus size={14} /> {t('Create PO')}
          </button>
        </>
      }
    >
      <div className="grid sm:grid-cols-3 gap-3">
        <Field label="Vendor">
          <Select value={vendorId} onChange={(e) => { setVendorId(e.target.value); setQty({}) }}>
            {vendors.map((v) => (
              <option key={v.id} value={v.id} disabled={!orderable(v)}>
                {v.name}{orderable(v) ? '' : ` — ${t(vendorStageOf(vendorStages, vendorKey(v)))}${['Prospect', 'Onboarding'].includes(vendorStageOf(vendorStages, vendorKey(v))) ? `, ${t('not approved yet')}` : ''}`}
              </option>
            ))}
          </Select>
          {!vendors.some(orderable) && (
            <div className="mt-1 text-[11px] text-amber-300/80">{t('Only approved or active vendors can be given a new purchase order.')}</div>
          )}
        </Field>
        <Field label="Project ID">
          <Select value={project} onChange={(e) => setProject(e.target.value)}>
            {active.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}
          </Select>
        </Field>
        <Field label="DP %" hint={`${t('Settlement')} +${vendor?.terms?.settlementDays ?? 14}d`}>
          <NumberInput value={dpPercent} onChange={(e) => setDpPercent(e.target.value)} min={0} max={100} step={5} />
        </Field>
      </div>

      {window.from && (
        <div className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-[11px] text-white/50">
          {t('Availability window')}: <span className="text-white/80">{formatDate(window.from)} → {formatDate(window.to)}</span>
          <span className="text-white/30"> · {t('event')} {proj?.eventDate} ({dayCounter(proj?.eventDate)})</span>
        </div>
      )}

      <div className="text-[11px] uppercase tracking-wider text-white/35 pt-1">{t('Catalogue')}</div>
      <div className="space-y-2">
        {items.map((i) => {
          const free = availableQty(i, window.from, window.to, { excludeProject: project })
          const want = Number(qty[i.id]) || 0
          const over = want > free
          return (
            <div
              key={i.id}
              className={`flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2.5 ${
                over ? 'border-rose-500/50 bg-rose-500/[0.06]' : 'border-white/10 bg-white/[0.02]'
              }`}
            >
              <div className="flex-1 min-w-[170px]">
                <div className="text-sm text-white">{i.item}</div>
                <div className="text-[10px] text-white/40">
                  {money(i.unitPrice)} / {i.unit} · {i.subcategory}
                </div>
              </div>
              <div className="text-right">
                <div className={`text-xs tabular-nums ${free <= 0 ? 'text-rose-300' : free < i.stock * 0.25 ? 'text-amber-300' : 'text-emerald-300'}`}>
                  {free} {t('free')}
                </div>
                <div className="text-[10px] text-white/30 tabular-nums">{t('of')} {i.stock}</div>
              </div>
              <NumberInput
                className="w-24"
                min={0}
                max={free}
                value={qty[i.id] ?? ''}
                onChange={(e) => setQty((q) => ({ ...q, [i.id]: e.target.value }))}
                placeholder="0"
              />
              <div className="w-28 text-right text-xs tabular-nums text-white/70">
                {want > 0 ? money(want * i.unitPrice) : '—'}
              </div>
            </div>
          )
        })}
        {!items.length && <div className="text-sm text-white/30">{t('This vendor has no catalogue items.')}</div>}
      </div>

      {overbooked.length > 0 && (
        <div className="rounded-lg border border-rose-500/40 bg-rose-500/[0.07] p-3 text-xs text-rose-200 flex items-start gap-2.5">
          <AlertTriangle size={15} className="shrink-0 mt-0.5" />
          <span>
            {t('Not enough stock in this window for')}: {overbooked.map((i) => i.item).join(', ')}.
            {' '}{t('Reduce the quantity or pick another date.')}
          </span>
        </div>
      )}
    </Modal>
  )
}

export default function PurchaseOrders() {
  const purchaseOrders = useStore((s) => s.purchaseOrders)
  const vendors = useStore((s) => s.vendors)
  const projects = useStore((s) => s.projects)
  const role = useStore((s) => s.role)
  const cancelPurchaseOrder = useStore((s) => s.cancelPurchaseOrder)
  const t = useT()

  const [statusFilter, setStatusFilter] = useState('all')
  const [projectFilter, setProjectFilter] = useState('all')
  const [creating, setCreating] = useState(false)
  // `?view=pipeline` opens the board directly, so it can be linked to.
  const [params, setParams] = useSearchParams()
  const view = params.get('view') === 'pipeline' ? 'pipeline' : 'table'
  const setView = (next) => setParams((p) => { const q = new URLSearchParams(p); if (next === 'pipeline') q.set('view', 'pipeline'); else q.delete('view'); return q }, { replace: true })
  // Delivery (V1) sits beside the accounting status, never in it.
  const poDelivery = useProto((s) => s.poDelivery)
  const liveOrders = useStore((s) => s.hydrated)
  const deliveryOf = (po) => (liveOrders ? po.deliveryStatus : poDelivery?.[po.id]?.status) || 'Not started'

  const visible = useMemo(() => purchaseOrders.filter((po) => {
    if (statusFilter !== 'all' && po.status !== statusFilter) return false
    if (projectFilter !== 'all' && po.project !== projectFilter) return false
    return true
  }), [purchaseOrders, statusFilter, projectFilter])

  const live = purchaseOrders.filter((po) => po.status !== 'Cancelled')
  const committed = live.reduce((a, po) => a + poTotal(po), 0)
  const paid = live.reduce((a, po) => a + poPaid(po), 0)
  const outstanding = live.reduce((a, po) => a + poOutstanding(po), 0)
  const projectIds = [...new Set(purchaseOrders.map((po) => po.project))]

  // Approve / pay DP / settle, shared with the board (components/PoPipeline).
  const { advance, actionFor, settleModal } = usePoAdvance()

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Vendor Commitments"
        title="Purchase Orders"
        subtitle="Approving a PO locks its value as committed budget and reserves the kit for the event window. Paying the DP and settling the balance each post to the ledger, withholding PPh 23 at the vendor's own rate."
        actions={
          <ActionButton action="request_po" role={role} onClick={() => setCreating(true)}>
            <Plus size={15} /> {t('Select & Create PO')}
          </ActionButton>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
        <Card>
          <div className="text-xs text-white/40">{t('Committed')}</div>
          <div className="mt-1 font-display text-xl text-white tabular-nums">{money(committed)}</div>
        </Card>
        <Card>
          <div className="text-xs text-white/40">{t('Paid to date')}</div>
          <div className="mt-1 font-display text-xl text-emerald-300 tabular-nums">{money(paid)}</div>
        </Card>
        <Card>
          <div className="text-xs text-white/40">{t('Outstanding')}</div>
          <div className="mt-1 font-display text-xl text-amber-300 tabular-nums">{money(outstanding)}</div>
        </Card>
        <Card>
          <div className="text-xs text-white/40">{t('Live POs')}</div>
          <div className="mt-1 font-display text-xl text-white tabular-nums">{live.length}</div>
          <div className="text-[10px] text-white/30 mt-0.5">{purchaseOrders.length} {t('total')}</div>
        </Card>
      </div>

      <SectionTitle
        icon={ClipboardList}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {/* Status filters belong to the table; the board has its own columns. */}
            {view === 'table' && (
              <>
                <FilterPill active={statusFilter === 'all'} onClick={() => setStatusFilter('all')}>{t('All')}</FilterPill>
                {PO_STATUSES.map((st) => (
                  <FilterPill key={st} active={statusFilter === st} onClick={() => setStatusFilter(st)}>{t(st)}</FilterPill>
                ))}
              </>
            )}
            <Select className="w-auto py-1 text-xs" value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}>
              <option value="all">{t('All projects')}</option>
              {projectIds.map((id) => <option key={id} value={id}>{id}</option>)}
            </Select>
            <span className="mx-1 h-4 w-px bg-white/10" />
            <FilterPill active={view === 'table'} onClick={() => setView('table')}><Table2 size={12} className="inline -mt-0.5 mr-1" />{t('Table view')}</FilterPill>
            <FilterPill active={view === 'pipeline'} onClick={() => setView('pipeline')}><Columns3 size={12} className="inline -mt-0.5 mr-1" />{t('Pipeline')}</FilterPill>
          </div>
        }
      >
        {t('Purchase Orders')}
      </SectionTitle>

      {view === 'pipeline' ? (
        <PipelineBoard
          pos={purchaseOrders.filter((po) => projectFilter === 'all' || po.project === projectFilter)}
          vendors={vendors} projects={projects} role={role} deliveryOf={deliveryOf}
          advance={advance} actionFor={actionFor}
        />
      ) : (
      <TableWrap>
        <thead>
          <tr>
            <th className="th">PO</th>
            <th className="th">{t('Vendor')}</th>
            <th className="th">{t('Project ID')}</th>
            <th className="th">{t('Lines')}</th>
            <th className="th text-right">{t('Total')}</th>
            <th className="th text-right">{t('DP')}</th>
            <th className="th text-right">{t('Balance')}</th>
            <th className="th text-right">{t('Variance')}</th>
            <th className="th">{t('Status')}</th>
            <th className="th">{t('Delivery')}</th>
            <th className="th text-right">{t('Action')}</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((po) => {
            const vendor = vendors.find((v) => v.id === po.vendorId)
            const proj = projects.find((p) => p.id === po.project)
            const label = poActionLabel(po)
            return (
              <tr key={po.id} className={po.status === 'Cancelled' ? 'opacity-50' : ''}>
                <td className="td font-medium text-white">
                  {po.id}
                  <div className="text-[10px] text-white/35">{formatDate(po.date)}</div>
                </td>
                <td className="td">
                  <Link to={`/vendors/${po.vendorId}`} className="text-white/80 hover:text-gold-light">
                    {vendor?.name ?? po.vendorId}
                  </Link>
                  <div className="text-[10px] text-white/35">
                    PPh 23 {pct2(vendor?.pph23Rate ?? 0)}
                  </div>
                </td>
                <td className="td font-mono text-xs text-gold/80">{po.project}</td>
                <td className="td text-white/70">
                  {(po.lines || []).map((l) => (
                    <div key={l.itemId} className="text-xs">{l.qty} × {l.item}</div>
                  ))}
                </td>
                <td className="td text-right tabular-nums">{money2(poTotal(po))}</td>
                <td className="td text-right tabular-nums text-white/60">
                  {money(poDpAmount(po))}
                  <div className="text-[10px] text-white/35">{po.terms?.dpPercent}%</div>
                </td>
                <td className="td text-right tabular-nums">
                  <span className={poOutstanding(po) > 0 ? 'text-amber-300' : 'text-emerald-300'}>
                    {money(poOutstanding(po) > 0 ? poOutstanding(po) : poBalance(po))}
                  </span>
                </td>
                <td className="td text-right tabular-nums">
                  {/* Gain / loss against the committed budget. Only meaningful
                      once settled — before that the actual is unknown. */}
                  {(() => {
                    const v = poVariance(po)
                    if (v === null) return <span className="text-white/20">—</span>
                    if (v === 0) return <span className="text-white/45">{t('at budget')}</span>
                    return (
                      <span className={v > 0 ? 'text-emerald-300' : 'text-rose-300'}>
                        {v > 0 ? `+${money(v)}` : `(${money(-v)})`}
                        <div className="text-[10px] text-white/35">
                          {v > 0 ? t('gain') : t('loss')}
                        </div>
                      </span>
                    )
                  })()}
                </td>
                <td className="td">
                  <Badge>{po.status}</Badge>
                  {proj?.cancelled && <div className="text-[10px] text-rose-300 mt-0.5">{t('project cancelled')}</div>}
                </td>
                <td className="td text-xs text-white/60">{pipelineStage(po) ? t(deliveryOf(po)) : '—'}</td>
                <td className="td text-right">
                  <div className="flex flex-wrap justify-end gap-2">
                    <button
                      onClick={() => purchaseOrderPDF(po, vendor, proj?.name)}
                      className="inline-flex items-center gap-1 text-xs text-white/50 hover:text-white"
                    >
                      <Download size={13} /> PDF
                    </button>
                    {label && (
                      <ActionButton
                        action={actionFor(po)}
                        role={role}
                        onClick={() => advance(po)}
                        className="inline-flex items-center gap-1 text-xs text-gold/80 hover:text-gold-light disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        {po.status === 'Draft' ? <Check size={13} /> : <CreditCard size={13} />}
                        {t(label)}
                        <ArrowRight size={12} />
                      </ActionButton>
                    )}
                    {po.status !== 'Settled' && po.status !== 'Cancelled' && (
                      <ActionButton
                        action="approve_po"
                        role={role}
                        onClick={() => cancelPurchaseOrder(po.id)}
                        className="inline-flex items-center gap-1 text-xs text-rose-400 hover:text-rose-300 disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <Trash2 size={13} /> {t('Cancel')}
                      </ActionButton>
                    )}
                    {po.status === 'Settled' && (
                      <span className="inline-flex items-center gap-1 text-xs text-emerald-300">
                        <Check size={12} /> {t('Settled')}
                      </span>
                    )}
                    {po.status === 'Cancelled' && (
                      <span className="inline-flex items-center gap-1 text-xs text-rose-300/70">
                        <X size={12} /> {t('Cancelled')}
                      </span>
                    )}
                  </div>
                </td>
              </tr>
            )
          })}
          {!visible.length && (
            <tr><td className="td text-white/30" colSpan={11}>{t('No purchase orders match these filters.')}</td></tr>
          )}
        </tbody>
      </TableWrap>
      )}

      {creating && <NewPoModal onClose={() => setCreating(false)} />}
      {settleModal}
    </div>
  )
}
