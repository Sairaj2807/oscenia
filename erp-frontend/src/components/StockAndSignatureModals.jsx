import { useRef, useState } from 'react'
import { Archive, PenLine, Save, Trash2 } from 'lucide-react'
import { useStore } from '../store/useStore'
import { Field, TextInput, NumberInput, Select, money2 } from './ui'
import Modal from './Modal'
import SignaturePad from './SignaturePad'
import { useT } from '../i18n'

// Editing a stock item, and signing a delivery order for dispatch. Both only make sense against the
// server (the rules about what may change, and the signature, live there), so the Warehouse offers
// them when signed in and not in the offline demo.

/**
 * Name and unit can always change. The unit value and the type are locked by the server once the item
 * has taken part in anything (a release, a write-off, a fixed-asset record, a delivery order); the
 * server's reason is shown when it refuses, so nothing here guesses at it. Quantity is not here: it
 * moves only through a movement that posts.
 */
export function EditStockModal({ item, onClose }) {
  const updateInventoryItem = useStore((s) => s.updateInventoryItem)
  const archiveInventoryItem = useStore((s) => s.archiveInventoryItem)
  const deleteInventoryItem = useStore((s) => s.deleteInventoryItem)
  const t = useT()
  const [form, setForm] = useState({ item: item.item, unit: item.unit || '', unitValue: item.unitValue || 0, type: item.type })
  const [confirmDelete, setConfirmDelete] = useState(false)
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const valid = form.item.trim() && Number(form.unitValue) >= 0

  const save = async () => {
    const changes = {}
    if (form.item.trim() !== item.item) changes.item = form.item
    if ((form.unit || '') !== (item.unit || '')) changes.unit = form.unit
    if (Number(form.unitValue) !== Number(item.unitValue || 0)) changes.unitValue = form.unitValue
    if (form.type !== item.type) changes.type = form.type
    if (!Object.keys(changes).length) return onClose()
    const result = await updateInventoryItem(item.id, changes)
    if (result?.ok) onClose()
  }
  const archive = async () => {
    const result = await archiveInventoryItem(item.id)
    if (result?.ok) onClose()
  }
  const remove = async () => {
    const result = await deleteInventoryItem(item.id)
    if (result?.ok) onClose()
  }

  return (
    <Modal
      title="Edit stock item"
      subtitle={`${item.id} · ${item.qty} ${item.unit || ''}`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="btn-ghost">{t('Cancel')}</button>
          <button onClick={save} disabled={!valid} className="btn-gold"><Save size={14} /> {t('Save')}</button>
        </>
      }
    >
      <Field label="Item name">
        <TextInput value={form.item} onChange={set('item')} />
      </Field>
      <div className="grid sm:grid-cols-3 gap-3">
        <Field label="Unit">
          <TextInput value={form.unit} onChange={set('unit')} placeholder="roll" />
        </Field>
        <Field label="Unit value (Rp)">
          <NumberInput value={form.unitValue} onChange={set('unitValue')} min={0} />
        </Field>
        <Field label="Type">
          <Select value={form.type} onChange={set('type')}>
            <option value="Fixed Asset">Fixed Asset</option>
            <option value="Consumable">Consumable</option>
          </Select>
        </Field>
      </div>
      <p className="text-xs text-white/40">
        {t('Unit value and type are locked once the item has been released, written off, put on the asset register or on a delivery order. Quantity changes only through a movement.')}
      </p>
      <div className="flex items-center justify-between border-t border-white/10 pt-3 text-sm">
        <span className="text-white/50">{t('Total stock value')}</span>
        <span className="font-display text-gold-light tabular-nums">{money2((Number(item.qty) || 0) * (Number(form.unitValue) || 0))}</span>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-white/10 pt-3">
        <button onClick={archive} className="inline-flex items-center gap-1 text-xs text-white/60 hover:text-white">
          <Archive size={13} /> {t('Archive')}
        </button>
        {confirmDelete ? (
          <span className="inline-flex items-center gap-2 text-xs text-rose-300">
            {t('Delete for good?')}
            <button onClick={remove} className="underline hover:text-rose-200">{t('Yes, delete')}</button>
            <button onClick={() => setConfirmDelete(false)} className="text-white/50 hover:text-white">{t('No')}</button>
          </span>
        ) : (
          <button onClick={() => setConfirmDelete(true)} className="inline-flex items-center gap-1 text-xs text-rose-400 hover:text-rose-300">
            <Trash2 size={13} /> {t('Delete')}
          </button>
        )}
        <span className="text-[11px] text-white/30">{t('Only an item that was never used can be deleted; archive the rest.')}</span>
      </div>
    </Modal>
  )
}

/** The recipient signs on the pad; the order is then dispatched with the picture on file. */
export function SignDispatchModal({ order, onClose }) {
  const dispatchDeliveryOrder = useStore((s) => s.dispatchDeliveryOrder)
  const t = useT()
  const pad = useRef(null)
  const [name, setName] = useState('')
  const [inked, setInked] = useState(false)
  const [busy, setBusy] = useState(false)
  const ready = name.trim().length > 0 && inked && !busy

  const submit = async () => {
    setBusy(true)
    try {
      const blob = await pad.current.toBlob()
      if (!blob) return
      const result = await dispatchDeliveryOrder(order.id, { blob, name: name.trim() })
      if (result?.ok) onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Sign to dispatch"
      subtitle={`${order.id} · ${order.project}`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="btn-ghost">{t('Cancel')}</button>
          <button onClick={submit} disabled={!ready} className="btn-gold"><PenLine size={14} /> {t('Sign and dispatch')}</button>
        </>
      }
    >
      <p className="text-sm text-white/60">{t('The person receiving the kit signs below. The signature is kept with the order and printed on its PDF.')}</p>
      <Field label="Received by">
        <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" />
      </Field>
      <SignaturePad ref={pad} onChange={setInked} />
    </Modal>
  )
}
