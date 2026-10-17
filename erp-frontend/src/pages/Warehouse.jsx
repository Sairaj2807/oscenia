import { useEffect, useMemo, useState } from 'react'
import {
  PackageCheck, Truck, Download, LogIn, LogOut, Plus, AlertTriangle, ArrowRight,
  PackageMinus, Wrench, Ban, Pencil, Archive, ArchiveRestore,
} from 'lucide-react'
import { useStore } from '../store/useStore'
import { INVENTORY_STATUS, RETURN_CONDITIONS } from '../store/seed'
import {
  PageHeader, Card, TableWrap, Badge, money, money2, SectionTitle,
  Field, TextInput, NumberInput, Select, FilterPill,
} from '../components/ui'
import Modal from '../components/Modal'
import { deliveryOrderPDF } from '../lib/pdf'
import { fetchSignatureDataUrl } from '../lib/deliverySignature'
import { api } from '../lib/api'
import { adaptInventoryItem } from '../store/adapters'
import { EditStockModal, SignDispatchModal } from '../components/StockAndSignatureModals'
import { dayCounter } from '../lib/format'
import { canDo } from '../lib/roles'
import { useT } from '../i18n'

const TONE = {
  ok: 'text-emerald-300',
  warn: 'text-amber-300',
  bad: 'text-rose-300',
}

// ---------------------------------------------------------------------------
// Check-out: send an asset to a job. Requires a real Project ID and event date
// rather than a free-text location.
// ---------------------------------------------------------------------------
function CheckOutModal({ item, onClose }) {
  const projects = useStore((s) => s.projects)
  const checkOutAsset = useStore((s) => s.checkOutAsset)
  const t = useT()
  const active = projects.filter((p) => p.stage !== 'Finished')
  const [projectId, setProjectId] = useState(active[0]?.id || '')

  const project = projects.find((p) => p.id === projectId)

  return (
    <Modal
      title="Check Out / Ship"
      subtitle={`${item.item} · ${item.qty} ${item.unit}`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="btn-ghost">{t('Cancel')}</button>
          <button
            onClick={() => { checkOutAsset(item.id, projectId, project?.eventDate); onClose() }}
            disabled={!projectId}
            className="btn-gold"
          >
            <LogOut size={14} /> {t('Check out')}
          </button>
        </>
      }
    >
      <Field label="Project ID" hint={t('The item stays on the balance sheet while in transit.')}>
        <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          {active.map((p) => <option key={p.id} value={p.id}>{p.id} — {p.name}</option>)}
        </Select>
      </Field>
      {project && (
        <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3 text-xs space-y-1.5">
          <div className="flex justify-between"><span className="text-white/40">{t('Client')}</span><span className="text-white/85">{project.client}</span></div>
          <div className="flex justify-between"><span className="text-white/40">{t('Event date')}</span><span className="text-white/85">{project.eventDate} · {dayCounter(project.eventDate)}</span></div>
          <div className="flex justify-between"><span className="text-white/40">{t('Stage')}</span><span className="text-white/85">{t(project.stage)}</span></div>
        </div>
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Check-in: the condition dialog. This is the deck's headline warehouse ask —
// the old code returned everything to stock unconditionally.
// ---------------------------------------------------------------------------
function CheckInModal({ item, onClose }) {
  const checkInAsset = useStore((s) => s.checkInAsset)
  const t = useT()
  const [qty, setQty] = useState({ good: item.qty, damaged: 0, lost: 0 })

  const set = (key) => (e) => {
    const raw = Math.max(0, Number(e.target.value) || 0)
    setQty((q) => {
      const next = { ...q, [key]: raw }
      const others = Object.keys(next).filter((k) => k !== key).reduce((a, k) => a + next[k], 0)
      // Never let the split exceed what actually went out.
      if (raw + others > item.qty) next[key] = Math.max(0, item.qty - others)
      return next
    })
  }

  const allocated = qty.good + qty.damaged + qty.lost
  const remaining = item.qty - allocated
  const lossValue = qty.lost * (item.unitValue || 0)

  return (
    <Modal
      title="Check In / Receive"
      subtitle={`${item.item} · ${item.qty} ${item.unit} returning from ${item.projectId || 'site'}`}
      size="xl"
      onClose={onClose}
      footer={
        <>
          <span className={`mr-auto text-xs ${remaining === 0 ? 'text-emerald-300' : 'text-amber-300'}`}>
            {remaining === 0
              ? `${t('All')} ${item.qty} ${item.unit} ${t('accounted for')}`
              : `${remaining} ${item.unit} ${t('unallocated')}`}
          </span>
          <button onClick={onClose} className="btn-ghost">{t('Cancel')}</button>
          <button
            onClick={() => { checkInAsset(item.id, qty); onClose() }}
            disabled={allocated === 0 || remaining !== 0}
            className="btn-gold"
          >
            <LogIn size={14} /> {t('Confirm return')}
          </button>
        </>
      }
    >
      <div className="text-xs text-white/45">
        {t('Split the returning quantity by condition. Each condition routes the stock to a different place.')}
      </div>

      <div className="space-y-2">
        {RETURN_CONDITIONS.map((c) => (
          <div key={c.key} className="flex flex-wrap items-center gap-3 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2.5">
            <div className="flex-1 min-w-[160px]">
              <div className={`text-sm ${TONE[c.tone]}`}>{t(c.label)}</div>
              <div className="text-[10px] text-white/35 flex items-center gap-1">
                <ArrowRight size={10} /> {t(c.hint)}
              </div>
            </div>
            <NumberInput
              className="w-24"
              min={0}
              max={item.qty}
              value={qty[c.key]}
              onChange={set(c.key)}
            />
            <span className="text-xs text-white/30 w-10">{item.unit}</span>
          </div>
        ))}
      </div>

      {/* The accounting consequence, stated before the user commits. */}
      {qty.lost > 0 && (
        <div className="rounded-lg border border-rose-500/40 bg-rose-500/[0.07] p-3">
          <div className="flex items-start gap-2.5">
            <AlertTriangle size={16} className="text-rose-300 shrink-0 mt-0.5" />
            <div className="text-xs">
              <div className="text-rose-200 font-medium">{t('This will post an Asset Loss Expense')}</div>
              <div className="text-white/60 mt-1">
                {qty.lost} × {money2(item.unitValue || 0)} = <strong className="text-rose-200">{money2(lossValue)}</strong>
                {' '}{t('debited to 6901 Asset Loss Expense, credited to inventory.')}
              </div>
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}

// Consumables do not come back, so releasing them reduces stock and expenses
// the value in one step — no in-transit state, no return leg.
function ReleaseModal({ item, onClose }) {
  const projects = useStore((s) => s.projects)
  const releaseConsumable = useStore((s) => s.releaseConsumable)
  const t = useT()
  const active = projects.filter((p) => p.stage !== 'Finished' && !p.cancelled)
  const [projectId, setProjectId] = useState(active[0]?.id || '')
  const [qty, setQty] = useState(1)

  const amount = Math.max(0, Math.floor(Number(qty) || 0))
  const valid = amount > 0 && amount <= item.qty && projectId
  const value = amount * (item.unitValue || 0)

  return (
    <Modal
      title="Release Consumables"
      subtitle={`${item.item} · ${item.qty} ${item.unit} ${t('on hand')}`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="btn-ghost">{t('Cancel')}</button>
          <button
            onClick={() => { releaseConsumable(item.id, amount, projectId); onClose() }}
            disabled={!valid}
            className="btn-gold"
          >
            <PackageMinus size={14} /> {t('Release')}
          </button>
        </>
      }
    >
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Project ID">
          <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {active.map((p) => <option key={p.id} value={p.id}>{p.id} — {p.name}</option>)}
          </Select>
        </Field>
        <Field label={`Quantity (max ${item.qty})`}>
          <NumberInput value={qty} onChange={(e) => setQty(e.target.value)} min={1} max={item.qty} />
        </Field>
      </div>

      <div className="rounded-lg border border-sky-500/30 bg-sky-500/[0.06] p-3 text-xs text-sky-100">
        <div className="font-medium">{t('This reduces stock permanently.')}</div>
        <div className="mt-1 text-white/60">
          {amount} × {money2(item.unitValue || 0)} = <strong className="text-sky-200">{money2(value)}</strong>
          {' '}{t('debited to 5104 Event COGS — Consumables, credited to inventory.')}
        </div>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Draft a delivery order: which project's event, and what is going. A document: it does not move
// stock (check-out and check-in do that).
function NewDeliveryModal({ onClose }) {
  const projects = useStore((s) => s.projects)
  const inventory = useStore((s) => s.inventory)
  const createDeliveryOrder = useStore((s) => s.createDeliveryOrder)
  const t = useT()
  const open = projects.filter((p) => !p.cancelled && p.stage !== 'Finished')
  const [project, setProject] = useState(open[0]?.id || '')
  const [eventDate, setEventDate] = useState(open[0]?.eventDate || '')
  const [qty, setQty] = useState({})
  const [other, setOther] = useState({ item: '', qty: '' })
  const kit = inventory.filter((i) => i.type === 'Fixed Asset' && i.status !== 'written_off')

  const lines = [
    ...kit.filter((i) => Number(qty[i.id]) > 0).map((i) => ({ itemId: i.id, item: i.item, qty: Number(qty[i.id]) })),
    ...(other.item.trim() && Number(other.qty) > 0 ? [{ itemId: null, item: other.item.trim(), qty: Number(other.qty) }] : []),
  ]

  return (
    <Modal
      title="New Delivery Order"
      subtitle={t('The paperwork that goes with kit to an event. It does not check stock in or out.')}
      size="xl"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="btn-ghost">{t('Cancel')}</button>
          <button
            onClick={async () => { await createDeliveryOrder({ project, eventDate, lines }); onClose() }}
            disabled={!project || !lines.length}
            className="btn-gold"
          >
            <Plus size={14} /> {t('Draft order')}
          </button>
        </>
      }
    >
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Project ID">
          <Select value={project} onChange={(e) => { setProject(e.target.value); setEventDate(open.find((p) => p.id === e.target.value)?.eventDate || '') }}>
            {open.map((p) => <option key={p.id} value={p.id}>{p.id} — {p.name}</option>)}
          </Select>
        </Field>
        <Field label="Event date">
          <TextInput type="date" value={eventDate || ''} onChange={(e) => setEventDate(e.target.value)} />
        </Field>
      </div>
      <div className="text-[11px] uppercase tracking-wider text-white/35 pt-1">{t('Kit going')}</div>
      <div className="space-y-1.5 max-h-56 overflow-y-auto">
        {kit.map((i) => (
          <div key={i.id} className="grid grid-cols-12 gap-2 items-center">
            <span className="col-span-8 text-sm text-white/80">{i.item} <span className="text-white/30 text-xs">({i.qty} {i.unit})</span></span>
            <div className="col-span-4"><NumberInput value={qty[i.id] ?? ''} onChange={(e) => setQty((q) => ({ ...q, [i.id]: e.target.value }))} min={0} placeholder="0" /></div>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-12 gap-2 items-center pt-1">
        <div className="col-span-8"><TextInput value={other.item} onChange={(e) => setOther((o) => ({ ...o, item: e.target.value }))} placeholder={t('Something else, e.g. cable ramps')} /></div>
        <div className="col-span-4"><NumberInput value={other.qty} onChange={(e) => setOther((o) => ({ ...o, qty: e.target.value }))} min={0} placeholder="0" /></div>
      </div>
    </Modal>
  )
}

function AddItemModal({ onClose }) {
  const addInventoryItem = useStore((s) => s.addInventoryItem)
  const t = useT()
  const [form, setForm] = useState({ item: '', type: 'Fixed Asset', qty: 1, unit: 'unit', unitValue: 0 })
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const valid = form.item.trim() && Number(form.qty) > 0 && Number(form.unitValue) >= 0

  return (
    <Modal
      title="Add Stock Item"
      subtitle={t('Unit value is used to price write-offs, so it needs to be real.')}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="btn-ghost">{t('Cancel')}</button>
          <button
            onClick={() => {
              addInventoryItem({
                item: form.item.trim(),
                type: form.type,
                qty: Number(form.qty),
                unit: form.unit,
                unitValue: Number(form.unitValue),
              })
              onClose()
            }}
            disabled={!valid}
            className="btn-gold"
          >
            <Plus size={14} /> {t('Add item')}
          </button>
        </>
      }
    >
      <Field label="Item name">
        <TextInput value={form.item} onChange={set('item')} placeholder="e.g. LED Panel 500x500" />
      </Field>
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Type">
          <Select value={form.type} onChange={set('type')}>
            <option value="Fixed Asset">Fixed Asset</option>
            <option value="Consumable">Consumable</option>
          </Select>
        </Field>
        <Field label="Unit">
          <TextInput value={form.unit} onChange={set('unit')} placeholder="unit / pcs / pack" />
        </Field>
        <Field label="Quantity">
          <NumberInput value={form.qty} onChange={set('qty')} min={1} />
        </Field>
        <Field label="Unit value (Rp)">
          <NumberInput value={form.unitValue} onChange={set('unitValue')} min={0} />
        </Field>
      </div>
      <div className="flex items-center justify-between border-t border-white/10 pt-3 text-sm">
        <span className="text-white/50">{t('Total stock value')}</span>
        <span className="font-display text-lg text-gold-light tabular-nums">
          {money2((Number(form.qty) || 0) * (Number(form.unitValue) || 0))}
        </span>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
export default function Warehouse() {
  const inventory = useStore((s) => s.inventory)
  const deliveryOrders = useStore((s) => s.deliveryOrders)
  const projects = useStore((s) => s.projects)
  const advanceDeliveryOrder = useStore((s) => s.advanceDeliveryOrder)
  const restoreInventoryItem = useStore((s) => s.restoreInventoryItem)
  const allowUnsigned = useStore((s) => s.allowUnsignedDispatch)
  const setAllowUnsigned = useStore((s) => s.setAllowUnsignedDispatch)
  const role = useStore((s) => s.role)
  // Signed in: the server is the source, so editing, archiving and the signature pad are offered.
  const live = useStore((s) => s.hydrated)
  const resolveMaintenance = useStore((s) => s.resolveMaintenance)
  const t = useT()

  const [statusFilter, setStatusFilter] = useState('all')
  const [projectFilter, setProjectFilter] = useState('all')
  const [checkOut, setCheckOut] = useState(null)
  const [checkIn, setCheckIn] = useState(null)
  const [addItem, setAddItem] = useState(false)
  const [newDo, setNewDo] = useState(false)
  const [releasing, setReleasing] = useState(null)
  const [editItem, setEditItem] = useState(null)
  const [signOrder, setSignOrder] = useState(null)
  const [showArchived, setShowArchived] = useState(false)
  const [archived, setArchived] = useState([])

  // Archived items are not in the store (the list leaves them out), so they are read when asked for,
  // and again whenever the live list changes (an archive or a restore).
  useEffect(() => {
    if (!live || !showArchived) return undefined
    let cancelled = false
    api.get('/inventory', { includeArchived: true })
      .then((rows) => {
        if (!cancelled) setArchived(rows.filter((r) => r.archivedAt).map((r) => adaptInventoryItem(r, { projects: new Map() })))
      })
      .catch(() => { if (!cancelled) setArchived([]) })
    return () => { cancelled = true }
  }, [live, showArchived, inventory])

  const downloadPdf = async (order, projectName) => {
    const picture = live && order.hasSignature && order.uuid ? await fetchSignatureDataUrl(order.uuid) : null
    deliveryOrderPDF(order, projectName, picture ? { dataUrl: picture, name: order.signedByName } : null)
  }

  const visible = useMemo(() => inventory.filter((it) => {
    if (statusFilter !== 'all' && it.status !== statusFilter) return false
    if (projectFilter !== 'all' && it.projectId !== projectFilter) return false
    return true
  }), [inventory, statusFilter, projectFilter])

  const stockValue = inventory
    .filter((it) => it.status !== 'written_off')
    .reduce((a, it) => a + it.qty * (it.unitValue || 0), 0)
  const inTransitValue = inventory
    .filter((it) => it.status === 'in_transit')
    .reduce((a, it) => a + it.qty * (it.unitValue || 0), 0)
  const writtenOffValue = inventory
    .filter((it) => it.status === 'written_off')
    .reduce((a, it) => a + it.qty * (it.unitValue || 0), 0)

  const projectIds = [...new Set(inventory.map((i) => i.projectId).filter(Boolean))]

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Logistics"
        title="Dual-Logic Warehouse"
        subtitle="Consumables reduce stock permanently; fixed assets move to an in-transit virtual warehouse and are checked back in by condition. Lost items post an Asset Loss Expense to the ledger automatically."
        actions={<button onClick={() => setAddItem(true)} className="btn-gold"><Plus size={15} /> {t('Add Item & Price')}</button>}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
        <Card>
          <div className="text-xs text-white/40">{t('Stock Value')}</div>
          <div className="mt-1 font-display text-xl text-white tabular-nums">{money(stockValue)}</div>
        </Card>
        <Card>
          <div className="text-xs text-white/40">{t('Out on Jobs')}</div>
          <div className="mt-1 font-display text-xl text-amber-300 tabular-nums">{money(inTransitValue)}</div>
        </Card>
        <Card>
          <div className="text-xs text-white/40">{t('Written Off')}</div>
          <div className="mt-1 font-display text-xl text-rose-300 tabular-nums">{money(writtenOffValue)}</div>
        </Card>
        <Card>
          <div className="text-xs text-white/40">{t('Line Items')}</div>
          <div className="mt-1 font-display text-xl text-white tabular-nums">{inventory.length}</div>
        </Card>
      </div>

      <div className="grid sm:grid-cols-2 gap-4 mb-5">
        <Card className="border-sky-500/20">
          <div className="text-xs uppercase tracking-wider text-sky-300 mb-1">{t('Consumables')}</div>
          <div className="text-sm text-white/60">{t('Stock permanently reduced on release → debited to the Income Statement. Use Release on a consumable row.')}</div>
        </Card>
        <Card className="border-gold/25">
          <div className="text-xs uppercase tracking-wider text-gold-light mb-1">{t('Fixed Assets')}</div>
          <div className="text-sm text-white/60">{t('Move to In-Transit; remain on the balance sheet. Checked back in by condition.')}</div>
        </Card>
      </div>

      <SectionTitle
        icon={PackageCheck}
        actions={
          <div className="flex flex-wrap gap-2">
            <FilterPill active={statusFilter === 'all'} onClick={() => setStatusFilter('all')}>{t('All')}</FilterPill>
            {Object.entries(INVENTORY_STATUS).map(([key, s]) => (
              <FilterPill key={key} active={statusFilter === key} onClick={() => setStatusFilter(key)}>
                {t(s.label)}
              </FilterPill>
            ))}
            {projectIds.length > 0 && (
              <Select
                className="w-auto py-1 text-xs"
                value={projectFilter}
                onChange={(e) => setProjectFilter(e.target.value)}
              >
                <option value="all">{t('All projects')}</option>
                {projectIds.map((id) => <option key={id} value={id}>{id}</option>)}
              </Select>
            )}
          </div>
        }
      >
        {t('Inventory')}
      </SectionTitle>

      <TableWrap>
        <thead>
          <tr>
            <th className="th">{t('Item')}</th>
            <th className="th">{t('Type')}</th>
            <th className="th text-right">{t('Qty')}</th>
            <th className="th text-right">{t('Unit Value')}</th>
            <th className="th text-right">{t('Total Value')}</th>
            <th className="th">{t('Status')}</th>
            <th className="th">{t('Project ID')}</th>
            <th className="th text-right">{t('Action')}</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((it) => {
            const meta = INVENTORY_STATUS[it.status] || INVENTORY_STATUS.in_stock
            const isFixed = it.type === 'Fixed Asset'
            return (
              <tr key={it.id} className={it.status === 'written_off' ? 'opacity-60' : ''}>
                <td className="td font-medium text-white">{it.item}</td>
                <td className="td"><Badge>{it.type}</Badge></td>
                <td className="td text-right tabular-nums">
                  {it.qty} <span className="text-white/30 text-xs">{it.unit}</span>
                </td>
                <td className="td text-right tabular-nums text-white/60">{money(it.unitValue || 0)}</td>
                <td className="td text-right tabular-nums">{money(it.qty * (it.unitValue || 0))}</td>
                <td className="td"><Badge>{meta.label}</Badge></td>
                <td className="td">
                  {it.projectId
                    ? <span className="font-mono text-xs text-gold/80">{it.projectId}</span>
                    : <span className="text-white/20 text-xs">—</span>}
                  {it.eventDate && <div className="text-[10px] text-white/35">{dayCounter(it.eventDate)}</div>}
                </td>
                <td className="td text-right">
                  <div className="flex items-center justify-end gap-3">
                  {live && (
                    <button
                      onClick={() => setEditItem(it)}
                      title={t('Edit or archive this item')}
                      aria-label={`${t('Edit')} ${it.item}`}
                      className="text-white/40 hover:text-white"
                    >
                      <Pencil size={13} />
                    </button>
                  )}
                  {it.status === 'in_transit' ? (
                    <button
                      onClick={() => setCheckIn(it)}
                      title={t('Load-out: returning from the venue')}
                      className="inline-flex items-center gap-1 text-xs text-gold/80 hover:text-gold-light"
                    >
                      <LogIn size={13} /> {t('Check-In / Receive')}
                    </button>
                  ) : it.status === 'in_stock' && isFixed ? (
                    <button
                      onClick={() => setCheckOut(it)}
                      title={t('Load-in: onto the truck')}
                      className="inline-flex items-center gap-1 text-xs text-sky-300 hover:text-sky-200"
                    >
                      <LogOut size={13} /> {t('Check-Out / Ship')}
                    </button>
                  ) : it.status === 'in_stock' ? (
                    // Consumables have no return leg: releasing them is the
                    // whole transaction.
                    <button
                      onClick={() => setReleasing(it)}
                      className="inline-flex items-center gap-1 text-xs text-sky-300 hover:text-sky-200"
                    >
                      <PackageMinus size={13} /> {t('Release')}
                    </button>
                  ) : it.status === 'maintenance' ? (
                    // Repaired kit goes back to stock; kit beyond economic
                    // repair is condemned and written off.
                    <div className="flex flex-wrap justify-end gap-2">
                      <button
                        onClick={() => resolveMaintenance(it.id, 'repaired')}
                        className="inline-flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300"
                      >
                        <Wrench size={12} /> {t('Repaired')}
                      </button>
                      <button
                        onClick={() => resolveMaintenance(it.id, 'condemned')}
                        title={t('Posts an Asset Loss Expense')}
                        className="inline-flex items-center gap-1 text-xs text-rose-400 hover:text-rose-300"
                      >
                        <Ban size={12} /> {t('Condemn')}
                      </button>
                    </div>
                  ) : it.status === 'written_off' ? (
                    <span className="text-rose-300/70 text-xs">{t('Written off')}</span>
                  ) : (
                    <span className="text-white/20 text-xs">—</span>
                  )}
                  </div>
                </td>
              </tr>
            )
          })}
          {!visible.length && (
            <tr><td className="td text-white/30" colSpan={8}>{t('No stock matches these filters.')}</td></tr>
          )}
        </tbody>
      </TableWrap>

      {live && (
        <div className="mt-2 mb-6">
          <button
            onClick={() => setShowArchived((v) => !v)}
            className="inline-flex items-center gap-1 text-xs text-white/50 hover:text-white"
          >
            <Archive size={12} /> {showArchived ? t('Hide archived items') : t('Show archived items')}
          </button>
          {showArchived && (
            <TableWrap>
              <thead>
                <tr>
                  <th className="th">{t('Item')}</th>
                  <th className="th">{t('Type')}</th>
                  <th className="th text-right">{t('Qty')}</th>
                  <th className="th text-right">{t('Action')}</th>
                </tr>
              </thead>
              <tbody>
                {archived.map((it) => (
                  <tr key={it.uuid} className="opacity-70">
                    <td className="td text-white">{it.item} <span className="font-mono text-[10px] text-white/30">{it.id}</span></td>
                    <td className="td"><Badge>{it.type}</Badge></td>
                    <td className="td text-right tabular-nums">{it.qty} <span className="text-white/30 text-xs">{it.unit}</span></td>
                    <td className="td text-right">
                      <button
                        onClick={() => restoreInventoryItem(it.uuid, it.item)}
                        className="inline-flex items-center gap-1 text-xs text-gold/80 hover:text-gold-light"
                      >
                        <ArchiveRestore size={13} /> {t('Restore')}
                      </button>
                    </td>
                  </tr>
                ))}
                {!archived.length && (
                  <tr><td className="td text-white/30" colSpan={4}>{t('Nothing is archived.')}</td></tr>
                )}
              </tbody>
            </TableWrap>
          )}
        </div>
      )}

      <SectionTitle
        icon={Truck}
        actions={<button onClick={() => setNewDo(true)} className="btn-ghost text-xs py-1.5"><Plus size={13} /> {t('New delivery order')}</button>}
      >
        {t('Delivery Orders')}
      </SectionTitle>
      {/* Company policy, so only the people who may change settings see it. Off by default: dispatch needs the
          recipient's signature. */}
      {live && canDo(role, 'edit_tax') && (
        <label className="mb-3 flex items-center gap-2 text-xs text-white/55">
          <input
            type="checkbox"
            checked={Boolean(allowUnsigned)}
            onChange={(e) => setAllowUnsigned(e.target.checked)}
            aria-label={t('Allow dispatching a delivery order without a signature')}
          />
          {t('Allow dispatching a delivery order without a signature')}
        </label>
      )}
      <TableWrap>
        <thead>
          <tr>
            <th className="th">{t('DO Number')}</th>
            <th className="th">{t('Project ID')}</th>
            <th className="th">{t('Items')}</th>
            <th className="th">{t('Event')}</th>
            <th className="th">{t('Status')}</th>
            <th className="th text-right">{t('Action')}</th>
            <th className="th text-right">{t('Signed PDF')}</th>
          </tr>
        </thead>
        <tbody>
          {deliveryOrders.map((d) => {
            const proj = projects.find((p) => p.id === d.project)
            const nextLabel = d.status === 'Draft' ? t('Dispatch') : d.status === 'Dispatched' ? t('Receive') : null
            return (
              <tr key={d.id}>
                <td className="td font-medium text-white">{d.id}</td>
                <td className="td font-mono text-xs text-gold/80">{d.project}</td>
                <td className="td text-white/70">
                  {(d.lines || []).map((l) => (
                    <div key={l.itemId} className="text-xs">
                      {l.qty} × {l.item}
                    </div>
                  ))}
                </td>
                <td className="td text-white/50 text-xs">
                  {d.eventDate || '—'}
                  {d.eventDate && <div className="text-[10px] text-white/35">{dayCounter(d.eventDate)}</div>}
                </td>
                <td className="td"><Badge>{d.status}</Badge></td>
                <td className="td text-right">
                  {nextLabel ? (
                    <div className="flex items-center justify-end gap-3">
                      {live && allowUnsigned && d.status === 'Draft' && !d.hasSignature && (
                        <button
                          onClick={() => setSignOrder(d)}
                          className="inline-flex items-center gap-1 text-xs text-white/50 hover:text-white"
                        >
                          {t('Sign')}
                        </button>
                      )}
                      <button
                        onClick={() => (live && d.status === 'Draft' && !d.hasSignature && !allowUnsigned ? setSignOrder(d) : advanceDeliveryOrder(d.id))}
                        className="inline-flex items-center gap-1 text-xs text-gold/80 hover:text-gold-light">
                        {nextLabel} <ArrowRight size={13} />
                      </button>
                    </div>
                  ) : (
                    <span className="text-emerald-400 text-xs">✓ {t('Received')}</span>
                  )}
                </td>
                <td className="td text-right">
                  <button
                    onClick={() => downloadPdf(d, proj?.name)}
                    className="inline-flex items-center gap-1 text-xs text-gold/80 hover:text-gold-light"
                  >
                    <Download size={13} /> {d.signed ? t('Signed PDF') : 'PDF'}
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </TableWrap>

      {checkOut && <CheckOutModal item={checkOut} onClose={() => setCheckOut(null)} />}
      {checkIn && <CheckInModal item={checkIn} onClose={() => setCheckIn(null)} />}
      {addItem && <AddItemModal onClose={() => setAddItem(false)} />}
      {newDo && <NewDeliveryModal onClose={() => setNewDo(false)} />}
      {releasing && <ReleaseModal item={releasing} onClose={() => setReleasing(null)} />}
      {editItem && <EditStockModal item={editItem} onClose={() => setEditItem(null)} />}
      {signOrder && <SignDispatchModal order={signOrder} onClose={() => setSignOrder(null)} />}
    </div>
  )
}
