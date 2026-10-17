import { useEffect, useMemo, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import {
  ArrowLeft, Landmark, FileText, Phone, Mail, Download, MessageCircle,
  Plus, PackageSearch, Percent, Clock, Pencil,
} from 'lucide-react'
import { useStore } from '../store/useStore'
import { CATALOG_CATEGORIES } from '../store/seed'
import {
  PageHeader, Card, TableWrap, Badge, money, money2, pct2, Rating, SectionTitle,
  Field, TextInput, NumberInput, FilterPill,
} from '../components/ui'
import { TagPicker, TagChip } from '../components/TagPicker'
import Modal from '../components/Modal'
import { VendorStageBadge, VendorChecklist, VendorStageActions, VendorStageHistory } from '../components/VendorPipeline'
import { useProto } from '../store/useProto'
import { availableQty, availabilityStatus, poTotal, poPaid, catalogueFor, vendorStageOf, checklistFor, vendorKey } from '../lib/vendors'
import { useVendorEntry } from '../store/vendorStages'
import { api } from '../lib/api'
import { openStoredFile } from '../lib/files'
import { checkFile, humanSize } from '../lib/attachments'
import { formatDate } from '../lib/format'
import { attachmentPDF } from '../lib/pdf'
import { useT } from '../i18n'

function Detail({ icon: Icon, label, value, mono }) {
  return (
    <div className="flex items-start gap-2.5">
      <Icon size={15} className="text-gold/70 mt-0.5 shrink-0" />
      <div className="min-w-0">
        <div className="text-[11px] uppercase tracking-wider text-white/35">{label}</div>
        <div className={`text-sm text-white/85 ${mono ? 'font-mono text-xs' : ''} break-words`}>{value || '—'}</div>
      </div>    </div>
  )
}

// WhatsApp deep link. The deck asked for the PIC's name "equipped with a direct
// WhatsApp action icon linking to vendor's number" — wa.me needs the number
// stripped of spaces, dashes and the leading +.
function waLink(phone, text) {
  if (!phone) return null
  const digits = phone.replace(/[^0-9]/g, '')
  return `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ''}`
}

export default function VendorDetail() {
  const { id } = useParams()
  const vendor = useStore((s) => s.vendors.find((v) => v.id === id))
  const catalogue = useStore((s) => s.vendorCatalogue)
  const purchaseOrders = useStore((s) => s.purchaseOrders)
  const role = useStore((s) => s.role)
  const updateVendorRate = useStore((s) => s.updateVendorRate)
  const updateVendor = useStore((s) => s.updateVendor)
  const pushToast = useStore((s) => s.pushToast)
  const hydrated = useStore((s) => s.hydrated)
  const [editingVendor, setEditingVendor] = useState(false)
  const toggleVendorTag = useStore((s) => s.toggleVendorTag)
  const toggleCatalogueTag = useStore((s) => s.toggleCatalogueTag)
  const [taggingItem, setTaggingItem] = useState(null) // the catalogue line whose tags are being edited
  const allTags = useStore((s) => s.tags)
  const stageEntry = useVendorEntry(vendor)
  const t = useT()
  const tagLabel = (id) => allTags.find((x) => x.id === id)?.label || id

  const [category, setCategory] = useState('')
  const [tagFilter, setTagFilter] = useState([])
  const [editingTags, setEditingTags] = useState(false)
  const [range, setRange] = useState({ from: '', to: '' })

  const items = useMemo(
    () => catalogueFor(catalogue, { vendorId: id, category: category || undefined, tags: tagFilter }),
    [catalogue, id, category, tagFilter]
  )

  // ---------------------------------------------------------------------------
  // Date-aware availability comes from the server
  // ---------------------------------------------------------------------------
  //
  // `lib/vendors.js` can answer this client-side by folding `item.bookings`, but the API
  // never exposes the raw booking rows — it answers availability as a question about a
  // window (`GET /vendor-catalogue/availability`), applying the same load-in/strike padding.
  //
  // That matters more than it looks: on live data `bookings` is empty, so the client-side
  // fold would report **everything as free for every window**, which is worse than showing
  // nothing — it is the number someone would double-book a LED wall on. So an unqualified
  // view still shows total stock (which `availableQty` already treats as the honest answer
  // to an unqualified question), and a date-filtered view asks the server.
  const [avail, setAvail] = useState(null)
  const [availError, setAvailError] = useState(null)
  const windowed = Boolean(range.from && range.to)

  useEffect(() => {
    if (!windowed || !vendor?.uuid) {
      setAvail(null)
      setAvailError(null)
      return
    }
    let live = true
    setAvailError(null)
    api
      .get('/vendor-catalogue/availability', {
        window_from: range.from,
        window_to: range.to,
        vendor_id: vendor.uuid,
      })
      .then((rows) => {
        if (!live) return
        setAvail(new Map((rows || []).map((r) => [r.itemId, r])))
      })
      .catch((err) => {
        // Surfaced rather than swallowed: a silent failure here would fall back to total
        // stock and look like "everything is available", which is the exact wrong answer.
        if (live) {
          setAvail(null)
          setAvailError(err?.message || 'Could not read availability')
        }
      })
    return () => {
      live = false
    }
  }, [windowed, range.from, range.to, vendor?.uuid])

  // One place that decides what a row shows, so the table cannot drift from the rule above.
  const freeFor = (item) => {
    if (!windowed) return { qty: availableQty(item, '', ''), status: availabilityStatus(item, '', ''), known: true }
    const row = avail?.get(item.uuid)
    if (!row) return { qty: null, status: '—', known: false }
    return { qty: Number(row.available ?? 0), status: row.status, known: true }
  }

  const pos = purchaseOrders.filter((po) => po.vendorId === id)
  const committed = pos.filter((po) => po.status !== 'Cancelled').reduce((a, po) => a + poTotal(po), 0)
  const paid = pos.filter((po) => po.status !== 'Cancelled').reduce((a, po) => a + poPaid(po), 0)

  if (!vendor) {
    return (
      <div className="animate-fade-up">
        <Link to="/vendors" className="inline-flex items-center gap-1.5 text-sm text-white/50 hover:text-white mb-4">
          <ArrowLeft size={16} /> {t('Vendors')}
        </Link>
        <Card>{t('Vendor not found in this prototype’s seed data.')}</Card>
      </div>
    )
  }

  const wa = waLink(vendor.pic?.phone, `Selamat pagi ${vendor.pic?.name ?? ''}, dari Oscenia Events.`)
  const checklist = checklistFor(vendor, stageEntry)

  return (
    <div className="animate-fade-up">
      <Link to="/vendors" className="inline-flex items-center gap-1.5 text-sm text-white/50 hover:text-white mb-4">
        <ArrowLeft size={16} /> {t('Vendor index')}
      </Link>

      <PageHeader
        eyebrow="Vendor 360"
        title={vendor.name}
        subtitle={`${vendor.category} · ${t('baseline')} ${money(vendor.baseline)}`}
        translate={false}
        actions={
          <>
            {wa && (
              <a href={wa} target="_blank" rel="noreferrer" className="btn-ghost">
                <MessageCircle size={15} /> WhatsApp
              </a>
            )}
            <Link to="/purchase-orders" className="btn-gold">
              <Plus size={15} /> {t('Raise a PO')}
            </Link>
          </>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
        <Card>
          <div className="text-xs text-white/40">{t('Scorecard')}</div>
          <div className="mt-1"><Rating value={vendor.score} /></div>
        </Card>
        <Card>
          <div className="text-xs text-white/40">{t('Late deliveries')}</div>
          <div className={`mt-1 font-display text-xl tabular-nums ${
            vendor.delays === 0 ? 'text-emerald-400' : vendor.delays > 2 ? 'text-rose-400' : 'text-amber-400'
          }`}>{vendor.delays}</div>
        </Card>
        <Card>
          <div className="text-xs text-white/40">{t('Committed')}</div>
          <div className="mt-1 font-display text-xl text-white tabular-nums">{money(committed)}</div>
        </Card>
        <Card>
          <div className="text-xs text-white/40">{t('Paid to date')}</div>
          <div className="mt-1 font-display text-xl text-emerald-300 tabular-nums">{money(paid)}</div>
        </Card>
      </div>

      {/* Where this supplier stands (V2): stage, the onboarding checklist that gates approval,
          and every change with who made it and why. */}
      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <div className="eyebrow">{t('Vendor stage')}</div>
          <VendorStageBadge stage={stageEntry?.stage || vendorStageOf(null, vendor.id)} />
          {stageEntry?.reason && <span className="text-xs text-white/50">— {stageEntry.reason}</span>}
          <div className="ml-auto"><VendorStageActions vendor={vendor} size="md" /></div>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <div className="mb-1.5 text-[10px] uppercase tracking-wider text-white/35">
              {t('Onboarding checklist')} · {checklist.done}/{checklist.total}
            </div>
            <VendorChecklist vendor={vendor} />
          </div>
          <div>
            <div className="mb-1.5 text-[10px] uppercase tracking-wider text-white/35">{t('Stage history')}</div>
            <VendorStageHistory vendorId={vendorKey(vendor)} />
          </div>
        </div>
      </Card>

      {/* Tags: what this vendor can be used for. Editable in place, and the
          vocabulary is shared with the catalogue and the vendor index. */}
      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <div className="eyebrow">{t('Tags')}</div>
          <button
            onClick={() => setEditingTags((e) => !e)}
            className="ml-auto text-xs text-gold/80 hover:text-gold-light"
          >
            {editingTags ? t('Done') : t('Edit tags')}
          </button>
        </div>
        {editingTags ? (
          <TagPicker
            selected={vendor.tags || []}
            onToggle={(tagId) => toggleVendorTag(vendor.id, tagId)}
          />
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {(vendor.tags || []).map((tid) => (
              <TagChip key={tid} label={tagLabel(tid)} active size="md" />
            ))}
            {!(vendor.tags || []).length && (
              <span className="text-sm text-white/30">{t('No tags yet — add some so this vendor can be found by capability.')}</span>
            )}
          </div>
        )}
      </Card>

      <div className="grid lg:grid-cols-3 gap-4">
        {/* Tax, bank and NPWP — none of this existed before, so a vendor could
            not actually be paid from the system. */}
        <Card>
          <div className="mb-4 flex items-center gap-2">
            <div className="eyebrow">{t('Tax & Bank')}</div>
            {(role === 'ceo' || role === 'finance') && (
              <button onClick={() => setEditingVendor(true)} className="ml-auto text-xs text-gold/80 hover:text-gold-light">{t('Edit details')}</button>
            )}
          </div>
          <div className="space-y-3.5">
            <Detail icon={FileText} label="NPWP" value={vendor.npwp} mono />
            <div className="flex items-start gap-2.5">
              <Percent size={15} className="text-gold/70 mt-0.5 shrink-0" />
              <div className="flex-1">
                <div className="text-[11px] uppercase tracking-wider text-white/35">{t('PPh 23 rate')}</div>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    type="number"
                    step="0.5"
                    min="0"
                    value={vendor.pph23Rate}
                    onChange={(e) => updateVendorRate(vendor.id, e.target.value)}
                    disabled={role !== 'ceo' && role !== 'finance'}
                    className="w-20 rounded-md border border-white/10 bg-navy-900 px-2 py-1 text-right text-sm tabular-nums text-white/85 focus:border-gold/50 outline-none disabled:opacity-40"
                  />
                  <span className="text-xs text-white/40">%</span>
                  <span className="text-[10px] text-white/30">{t('overrides company default')}</span>
                </div>
              </div>
            </div>
            <Detail icon={Landmark} label={t('Bank')} value={vendor.bank?.name} />
            <Detail icon={Landmark} label={t('Account')} value={vendor.bank?.account} mono />
            <Detail icon={FileText} label={t('Account holder')} value={vendor.bank?.holder} />
          </div>
        </Card>

        {/* PIC with a direct WhatsApp action */}
        <Card>
          <div className="eyebrow mb-4">{t('Person in Charge')}</div>
          <div className="space-y-3.5">
            <div className="flex items-start gap-2.5">
              <Phone size={15} className="text-gold/70 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-[11px] uppercase tracking-wider text-white/35">{t('PIC')}</div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-white/85">{vendor.pic?.name}</span>
                  {wa && (
                    <a
                      href={wa}
                      target="_blank"
                      rel="noreferrer"
                      title={`WhatsApp ${vendor.pic?.phone}`}
                      className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-300 hover:bg-emerald-500/20"
                    >
                      <MessageCircle size={11} /> WA
                    </a>
                  )}
                </div>
              </div>
            </div>
            <Detail icon={Phone} label={t('Phone')} value={vendor.pic?.phone} />
            <Detail icon={Mail} label={t('Email')} value={vendor.pic?.email} />
            <Detail
              icon={Clock}
              label={t('Payment terms')}
              value={`${vendor.terms?.dpPercent}% DP · ${t('balance')} +${vendor.terms?.settlementDays}d`}
            />
          </div>
        </Card>

        {/* Attachments: real files signed in, the labelled placeholders in the demo */}
        <Card>
          <div className="eyebrow mb-4">{t('Attachments')}</div>
          {hydrated && vendor.uuid ? (
            <LiveVendorFiles vendor={vendor} canAttach={role === 'ceo' || role === 'finance' || role === 'pm' || role === 'sales'} canRemoveAgreement={role === 'ceo' || role === 'pm' || role === 'finance'} />
          ) : (
          <div className="space-y-2">
            {(vendor.attachments || []).map((a) => (
              <button
                key={a.name}
                onClick={() => attachmentPDF(a, vendor)}
                className="flex w-full items-center gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 text-left hover:border-gold/30 transition-colors"
                title={t('Downloads a labelled placeholder — the prototype holds no files')}
              >
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded bg-white/5 text-gold/70">
                  <FileText size={14} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-white/85">{a.name}</span>
                  <span className="block text-[10px] text-white/35">{a.kind} · {a.size}</span>
                </span>
                <Download size={14} className="text-white/30 shrink-0" />
              </button>
            ))}
            {!(vendor.attachments || []).length && (
              <div className="text-sm text-white/30">{t('No attachments on file.')}</div>
            )}
            {(vendor.attachments || []).length > 0 && (
              <div className="pt-1 text-[10px] text-white/30">
                {t('Downloads are generated placeholders — real uploads need a storage backend.')}
              </div>
            )}
          </div>
          )}
        </Card>
      </div>

      {/* Catalogue drill-down with date-aware availability */}
      <SectionTitle
        icon={PackageSearch}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <FilterPill active={!category} onClick={() => setCategory('')}>{t('All')}</FilterPill>
            {CATALOG_CATEGORIES.filter((c) => catalogue.some((i) => i.vendorId === id && i.category === c.key)).map((c) => (
              <FilterPill key={c.key} active={category === c.key} onClick={() => setCategory(c.key)}>
                {t(c.label)}
              </FilterPill>
            ))}
            {allTags
              .filter((tag) => catalogue.some((i) => i.vendorId === id && (i.tags || []).includes(tag.id)))
              .map((tag) => (
                <TagChip
                  key={tag.id}
                  label={tag.label}
                  active={tagFilter.includes(tag.id)}
                  onClick={() => setTagFilter((f) => (f.includes(tag.id) ? f.filter((x) => x !== tag.id) : [...f, tag.id]))}
                />
              ))}
          </div>
        }
      >
        {t('Catalogue')}
      </SectionTitle>

      <Card className="mb-3">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Available from" hint={t('Leave blank to see total stock')}>
            <TextInput type="date" value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} />
          </Field>
          <Field label="Available to">
            <TextInput type="date" value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} />
          </Field>
          {(range.from || range.to) && (
            <button onClick={() => setRange({ from: '', to: '' })} className="btn-ghost text-xs py-1.5">
              {t('Clear dates')}
            </button>
          )}
          {windowed && !avail && !availError && (
            <span className="text-xs text-white/40">{t('Checking availability…')}</span>
          )}
          {availError && (
            <span className="text-xs text-rose-400">
              {t('Availability unavailable')} — {availError}
            </span>
          )}
        </div>
        {range.from && !range.to && (
          <div className="mt-2 text-xs text-white/40">
            {t('Enter both dates to see availability for the window.')}
          </div>
        )}
      </Card>

      <TableWrap>
        <thead>
          <tr>
            <th className="th">{t('Equipment')}</th>
            <th className="th">{t('Category')}</th>
            <th className="th">{t('Suits')}</th>
            <th className="th text-right">{t('Rental Price')}</th>
            <th className="th text-right">{t('Stock')}</th>
            <th className="th text-right">{t('Available')}</th>
            <th className="th">{t('Status')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => {
            const { qty: free, status, known } = freeFor(it)
            return (
              <tr key={it.id}>
                <td className="td font-medium text-white">{it.item}</td>
                <td className="td text-white/60 text-xs">{it.subcategory}</td>
                <td className="td">
                  <div className="flex flex-wrap gap-1">
                    {(it.tags || []).slice(0, 2).map((tid) => (
                      <TagChip key={tid} label={tagLabel(tid)} active={tagFilter.includes(tid)} />
                    ))}
                    {(it.tags || []).length > 2 && (
                      <span className="text-[10px] text-white/30">+{it.tags.length - 2}</span>
                    )}
                    <button
                      onClick={() => setTaggingItem(it.id)}
                      className="text-white/30 hover:text-gold-light"
                      title={t('Edit tags')}
                      aria-label={`${t('Edit tags')}: ${it.item}`}
                    >
                      <Pencil size={11} />
                    </button>
                  </div>
                </td>
                <td className="td text-right tabular-nums">
                  {money(it.unitPrice)}<span className="text-white/30 text-xs"> / {it.unit}</span>
                </td>
                <td className="td text-right tabular-nums text-white/50">{it.stock}</td>
                <td className="td text-right tabular-nums">
                  {known ? (
                    <span className={free <= 0 ? 'text-rose-400' : free < it.stock * 0.25 ? 'text-amber-400' : 'text-white/85'}>
                      {free}
                    </span>
                  ) : (
                    <span className="text-white/30">—</span>
                  )}
                </td>
                <td className="td"><Badge>{status}</Badge></td>
              </tr>
            )
          })}
          {!items.length && (
            <tr><td className="td text-white/30" colSpan={7}>{t('Nothing in the catalogue matches these filters.')}</td></tr>
          )}
        </tbody>
      </TableWrap>

      {/* Purchase orders raised against this vendor */}
      <SectionTitle icon={FileText}>{t('Purchase Orders')}</SectionTitle>
      <TableWrap>
        <thead>
          <tr>
            <th className="th">PO</th>
            <th className="th">{t('Project ID')}</th>
            <th className="th">{t('Date')}</th>
            <th className="th text-right">{t('Total')}</th>
            <th className="th text-right">{t('Paid')}</th>
            <th className="th">{t('Status')}</th>
          </tr>
        </thead>
        <tbody>
          {pos.map((po) => (
            <tr key={po.id}>
              <td className="td font-medium text-white">
                <Link to="/purchase-orders" className="hover:text-gold-light">{po.id}</Link>
              </td>
              <td className="td font-mono text-xs text-gold/80">{po.project}</td>
              <td className="td text-white/50">{formatDate(po.date)}</td>
              <td className="td text-right tabular-nums">{money2(poTotal(po))}</td>
              <td className="td text-right tabular-nums text-emerald-300">{money(poPaid(po))}</td>
              <td className="td"><Badge>{po.status}</Badge></td>
            </tr>
          ))}
          {!pos.length && (
            <tr><td className="td text-white/30" colSpan={6}>{t('No purchase orders raised with this vendor yet.')}</td></tr>
          )}
        </tbody>
      </TableWrap>

      <div className="mt-3 text-[11px] text-white/30">
        {t('Projects using this vendor')}: {[...new Set(pos.map((po) => po.project))].join(', ') || '—'}
        {' · '}{t('scorecard')} {pct2((vendor.score / 5) * 100)}
      </div>
      {taggingItem && (() => {
        const line = catalogue.find((i) => i.id === taggingItem)
        if (!line) return null
        return (
          <Modal
            title="Item tags"
            subtitle={line.item}
            onClose={() => setTaggingItem(null)}
            footer={<button onClick={() => setTaggingItem(null)} className="btn-gold">{t('Done')}</button>}
          >
            <TagPicker
              selected={(line.tags || []).map((x) => (typeof x === 'string' ? x : x.id))}
              onToggle={(tagId) => toggleCatalogueTag(line.id, tagId)}
            />
          </Modal>
        )
      })()}
      {editingVendor && <VendorEditModal vendor={vendor} onSave={updateVendor} onClose={() => setEditingVendor(false)} />}
    </div>
  )
}

/** Tax number, bank, person in charge and payment terms: what a vendor needs to be paid and reached.
 *  Only the fields that changed are sent. (The withholding rate stays on the card: it has its own control.) */
function VendorEditModal({ vendor, onSave, onClose }) {
  const t = useT()
  const [form, setForm] = useState(() => ({
    npwp: vendor.npwp || '',
    bankName: vendor.bank?.name || '', bankAccount: vendor.bank?.account || '', bankHolder: vendor.bank?.holder || '',
    picName: vendor.pic?.name || '', picPhone: vendor.pic?.phone || '', picEmail: vendor.pic?.email || '',
    dpPercent: vendor.terms?.dpPercent ?? 50, settlementDays: vendor.terms?.settlementDays ?? 14,
  }))
  const [busy, setBusy] = useState(false)
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const submit = async (e) => {
    e.preventDefault()
    // What changed, shaped like the vendor: the store turns it into the request.
    const patch = {}
    const diff = (path, now, was) => { if (String(now ?? '') !== String(was ?? '')) path(now) }
    diff((v) => { patch.npwp = v }, form.npwp, vendor.npwp)
    for (const [key, group, field] of [['bankName', 'bank', 'name'], ['bankAccount', 'bank', 'account'], ['bankHolder', 'bank', 'holder'],
      ['picName', 'pic', 'name'], ['picPhone', 'pic', 'phone'], ['picEmail', 'pic', 'email']]) {
      diff((v) => { patch[group] = { ...patch[group], [field]: v } }, form[key], vendor[group]?.[field])
    }
    diff((v) => { patch.terms = { ...patch.terms, dpPercent: v } }, form.dpPercent, vendor.terms?.dpPercent)
    diff((v) => { patch.terms = { ...patch.terms, settlementDays: v } }, form.settlementDays, vendor.terms?.settlementDays)
    if (!Object.keys(patch).length) return onClose()
    setBusy(true)
    const out = await onSave(vendor.id, patch)
    setBusy(false)
    // The store shows its own notice when the server refuses; stay open then so nothing typed is lost.
    if (out?.ok !== false) onClose()
  }
  return (
    <Modal title="Edit vendor details" subtitle={vendor.name} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="NPWP"><TextInput value={form.npwp} onChange={set('npwp')} /></Field>
        <div className="grid grid-cols-3 gap-2">
          <Field label="Bank"><TextInput value={form.bankName} onChange={set('bankName')} /></Field>
          <Field label="Account"><TextInput value={form.bankAccount} onChange={set('bankAccount')} /></Field>
          <Field label="Account holder"><TextInput value={form.bankHolder} onChange={set('bankHolder')} /></Field>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Field label="PIC"><TextInput value={form.picName} onChange={set('picName')} /></Field>
          <Field label="Phone"><TextInput value={form.picPhone} onChange={set('picPhone')} /></Field>
          <Field label="Email"><TextInput value={form.picEmail} onChange={set('picEmail')} /></Field>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Down payment %"><NumberInput min="0" max="100" value={form.dpPercent} onChange={set('dpPercent')} /></Field>
          <Field label="Balance due after (days)"><NumberInput min="0" value={form.settlementDays} onChange={set('settlementDays')} /></Field>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn-ghost text-xs" onClick={onClose}>{t('Cancel')}</button>
          <button type="submit" className="btn-gold text-xs" disabled={busy}>{t('Save')}</button>
        </div>
      </form>
    </Modal>
  )
}

const FILE_KINDS_FOR_VENDOR = ['Agreement', 'NPWP', 'Bank letter', 'Price list', 'Other']

/** A vendor's real files: agreements, tax and bank documents, price lists. Upload, open (fetched with
 *  the signed-in session), remove. An Agreement is what the vendor checklist counts as the signed agreement. */
function LiveVendorFiles({ vendor, canAttach, canRemoveAgreement }) {
  const t = useT()
  const pushToast = useStore((s) => s.pushToast)
  const [files, setFiles] = useState(null)
  const [kind, setKind] = useState('Agreement')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const base = `/vendors/${vendor.uuid}/attachments`

  useEffect(() => {
    let off = false
    api.get(base).then((rows) => { if (!off) setFiles(rows) }, () => { if (!off) setFiles([]) })
    return () => { off = true }
  }, [base])

  const upload = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const problem = checkFile({ name: file.name, type: file.type, size: file.size })
    if (problem) return setError(problem)
    setBusy(true)
    setError('')
    try {
      const form = new FormData()
      form.append('file', file, file.name)
      const stored = await api.upload('/attachments', form)
      setFiles(await api.post(base, { attachmentId: stored.id, kind }))
      useStore.getState().reloadVendorLifecycle()
    } catch (err) {
      setError(err.message || t('The file could not be saved.'))
    } finally {
      setBusy(false)
    }
  }
  const open = (f) => openStoredFile(f.attachmentId, f.filename).catch(() =>
    pushToast({ title: 'Could not open the file', body: 'It could not be fetched from the server. Try again.', kind: 'redflag' }))
  const remove = async (f) => {
    if (!window.confirm(t('Take this file off the vendor? The file itself is kept.'))) return
    try {
      await api.delete(`${base}/${f.id}`)
      setFiles((rows) => rows.filter((r) => r.id !== f.id))
      useStore.getState().reloadVendorLifecycle()
    } catch (err) {
      pushToast({ title: 'Could not remove the file', body: err.message, kind: 'redflag' })
    }
  }

  return (
    <div className="space-y-2">
      {(files || []).map((f) => (
        <div key={f.id} className="flex items-center gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2">
          <button type="button" onClick={() => open(f)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded bg-white/5 text-gold/70"><FileText size={14} /></span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-white/85">{f.filename}</span>
              <span className="block text-[10px] text-white/35">{f.kind} · {humanSize(f.byteSize)} · {f.uploadedBy}{f.note ? ` · ${f.note}` : ''}</span>
            </span>
            <Download size={14} className="shrink-0 text-white/30" />
          </button>
          {canAttach && (f.kind !== 'Agreement' || canRemoveAgreement) && (
            <button type="button" onClick={() => remove(f)} className="text-[11px] text-white/35 hover:text-rose-300" aria-label={`${t('Remove')} ${f.filename}`}>{t('Remove')}</button>
          )}
        </div>
      ))}
      {files && !files.length && <div className="text-sm text-white/30">{t('No attachments on file.')}</div>}
      {canAttach && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label={t('Kind of file')}
            className="rounded-md border border-white/10 bg-navy-900 px-2 py-1 text-xs text-white/80">
            {FILE_KINDS_FOR_VENDOR.map((k) => <option key={k} value={k}>{t(k)}</option>)}
          </select>
          <label className={`btn-ghost !py-1.5 text-xs ${busy ? 'pointer-events-none opacity-40' : 'cursor-pointer'}`}>
            {t(busy ? 'Uploading…' : 'Upload a file')}
            <input type="file" accept=".pdf,.jpg,.jpeg,.png" onChange={upload} className="hidden" disabled={busy} />
          </label>
        </div>
      )}
      {error && <p role="alert" className="text-[11px] text-rose-300">{error}</p>}
    </div>
  )
}
