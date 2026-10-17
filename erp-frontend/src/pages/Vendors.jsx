import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  Award, PackageSearch, Plus, ChevronRight, MessageCircle, Search, ClipboardList,
  Tags, X, Table2, Columns3, Workflow,
} from 'lucide-react'
import { useStore } from '../store/useStore'
import { useProto } from '../store/useProto'
import { useAuth } from '../store/useAuth'
import { CATALOG_CATEGORIES } from '../store/seed'
import {
  PageHeader, Card, TableWrap, Badge, money, money2, pct2, Rating, SectionTitle,
  Field, TextInput, FilterPill, ActionButton,
} from '../components/ui'
import Modal from '../components/Modal'
import { TagPicker, TagChip, TagManagerModal } from '../components/TagPicker'
import { availableQty, availabilityStatus, catalogueFor, poTotal, hasAllTags, vendorStageOf, vendorKey, quoteGroups, compareQuotes } from '../lib/vendors'
import VendorPipeline, { VendorStageBadge } from '../components/VendorPipeline'
import { useVendorStages } from '../store/vendorStages'
import PoPipeline from '../components/PoPipeline'
import { canSee } from '../lib/roles'
import { useT } from '../i18n'

function waLink(phone) {
  if (!phone) return null
  return `https://wa.me/${phone.replace(/[^0-9]/g, '')}`
}

function AddVendorModal({ onClose }) {
  const addVendor = useStore((s) => s.addVendor)
  const author = useAuth((s) => s.user?.name)
  const t = useT()
  const [form, setForm] = useState({
    name: '', category: '', baseline: 0, npwp: '', pph23Rate: 2,
    bankName: '', bankAccount: '', bankHolder: '',
    picName: '', picPhone: '', picEmail: '',
    dpPercent: 50, settlementDays: 14,
  })
  const [tags, setTags] = useState([])
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const toggleTag = (id) => setTags((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]))
  const valid = form.name.trim() && form.category.trim()

  return (
    <Modal
      title="Add Vendor"
      subtitle={t('Tax and bank details are what make a vendor payable from the system.')}
      size="xl"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="btn-ghost">{t('Cancel')}</button>
          <button
            onClick={async () => {
              const vendor = await addVendor({
                name: form.name.trim(),
                category: form.category.trim(),
                baseline: Number(form.baseline) || 0,
                npwp: form.npwp.trim(),
                pph23Rate: Number(form.pph23Rate) || 0,
                bank: { name: form.bankName, account: form.bankAccount, holder: form.bankHolder },
                pic: { name: form.picName, phone: form.picPhone, email: form.picEmail },
                terms: { dpPercent: Number(form.dpPercent) || 0, settlementDays: Number(form.settlementDays) || 0 },
                tags,
              })
              // Every new supplier starts on the vendor board as a Prospect (V2).
              if (vendor) useProto.getState().addVendorProspect(vendorKey(vendor), author)
              onClose()
            }}
            disabled={!valid}
            className="btn-gold"
          >
            <Plus size={14} /> {t('Add vendor')}
          </button>
        </>
      }
    >
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Vendor name">
          <TextInput value={form.name} onChange={set('name')} placeholder="e.g. Nusa Rigging" />
        </Field>
        <Field label="Category">
          <TextInput value={form.category} onChange={set('category')} placeholder="e.g. Staging / Truss" />
        </Field>
        <Field label="Baseline price (Rp)">
          <TextInput type="number" value={form.baseline} onChange={set('baseline')} />
        </Field>
        <Field label="NPWP">
          <TextInput value={form.npwp} onChange={set('npwp')} placeholder="00.000.000.0-000.000" />
        </Field>
      </div>

      <div className="text-[11px] uppercase tracking-wider text-white/35 pt-1">{t('Tax & Bank')}</div>
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="PPh 23 rate (%)">
          <TextInput type="number" step="0.5" value={form.pph23Rate} onChange={set('pph23Rate')} />
        </Field>
        <Field label="Bank">
          <TextInput value={form.bankName} onChange={set('bankName')} placeholder="e.g. Bank Mandiri" />
        </Field>
        <Field label="Account number">
          <TextInput value={form.bankAccount} onChange={set('bankAccount')} />
        </Field>
        <Field label="Account holder">
          <TextInput value={form.bankHolder} onChange={set('bankHolder')} />
        </Field>
      </div>

      <div className="text-[11px] uppercase tracking-wider text-white/35 pt-1">{t('Person in Charge')}</div>
      <div className="grid sm:grid-cols-3 gap-3">
        <Field label="PIC name">
          <TextInput value={form.picName} onChange={set('picName')} />
        </Field>
        <Field label="Phone">
          <TextInput value={form.picPhone} onChange={set('picPhone')} placeholder="+62 8xx-xxxx-xxxx" />
        </Field>
        <Field label="Email">
          <TextInput value={form.picEmail} onChange={set('picEmail')} />
        </Field>
      </div>

      <div className="text-[11px] uppercase tracking-wider text-white/35 pt-1">{t('Payment terms')}</div>
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="DP %">
          <TextInput type="number" value={form.dpPercent} onChange={set('dpPercent')} />
        </Field>
        <Field label="Settlement days">
          <TextInput type="number" value={form.settlementDays} onChange={set('settlementDays')} />
        </Field>
      </div>

      <Field label="Tags" hint={t('What this vendor can be used for. Type a new name to create one.')}>
        <TagPicker selected={tags} onToggle={toggleTag} />
      </Field>
    </Modal>
  )
}

function AddCatalogueItemModal({ onClose }) {
  const vendors = useStore((s) => s.vendors)
  const catalogue = useStore((s) => s.vendorCatalogue)
  const addCatalogueItem = useStore((s) => s.addCatalogueItem)
  const t = useT()
  const [form, setForm] = useState({ vendorId: vendors[0]?.id || '', item: '', category: '', subcategory: '', unitPrice: '', stock: '', unit: '' })
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))
  // Suggest what is already in use so the same category is spelled the same way (the estimator
  // groups by it).
  const categories = [...new Set([...CATALOG_CATEGORIES.map((c) => c.key), ...catalogue.map((i) => i.category).filter(Boolean)])]
  const valid = form.vendorId && form.item.trim() && Number(form.unitPrice) >= 0 && form.unitPrice !== ''

  return (
    <Modal
      title={t('Add catalogue item')}
      subtitle={t('What a vendor offers, so it can go on a purchase order and into the cost comparison.')}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="btn-ghost">{t('Cancel')}</button>
          <button
            onClick={async () => { if (await addCatalogueItem(form)) onClose() }}
            disabled={!valid}
            className="btn-gold"
          >
            <Plus size={14} /> {t('Add item')}
          </button>
        </>
      }
    >
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Vendor">
          <select value={form.vendorId} onChange={set('vendorId')} className="w-full rounded-lg border border-white/10 bg-navy-900 px-3 py-2 text-sm text-white">
            {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </Field>
        <Field label="Item">
          <TextInput value={form.item} onChange={set('item')} placeholder="e.g. LED Video Wall (per m²)" />
        </Field>
        <Field label="Category">
          <TextInput list="catalogue-categories" value={form.category} onChange={set('category')} placeholder="e.g. visual" />
          <datalist id="catalogue-categories">{categories.map((c) => <option key={c} value={c} />)}</datalist>
        </Field>
        <Field label="Subcategory">
          <TextInput value={form.subcategory} onChange={set('subcategory')} placeholder="e.g. LED Wall" />
        </Field>
        <Field label="Unit price (Rp)">
          <TextInput type="number" min="0" value={form.unitPrice} onChange={set('unitPrice')} />
        </Field>
        <Field label="Stock">
          <TextInput type="number" min="0" value={form.stock} onChange={set('stock')} />
        </Field>
        <Field label="Unit">
          <TextInput value={form.unit} onChange={set('unit')} placeholder="e.g. m², unit" />
        </Field>
      </div>
    </Modal>
  )
}

export default function Vendors() {
  const vendors = useStore((s) => s.vendors)
  const catalogue = useStore((s) => s.vendorCatalogue)
  const purchaseOrders = useStore((s) => s.purchaseOrders)
  const role = useStore((s) => s.role)
  const t = useT()

  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [subcategory, setSubcategory] = useState('')
  // Tag filter is shared by the catalogue and the vendor index below, so
  // picking "Wedding" narrows both at once.
  const [tagFilter, setTagFilter] = useState([])
  const [range, setRange] = useState({ from: '', to: '' })
  const [adding, setAdding] = useState(false)
  const [addingItem, setAddingItem] = useState(false)
  const [managing, setManaging] = useState(false)
  // The vendor index has three views: the table, the vendor lifecycle (`?view=pipeline`, V2) and
  // the purchase-order pipeline (`?view=po`, round 3). The PO board is offered only to a role
  // that may see purchase orders. Each view can be linked to.
  const [params, setParams] = useSearchParams()
  const canSeePos = canSee(role, 'purchaseorders')
  const asked = params.get('view')
  const view = asked === 'pipeline' || (asked === 'po' && canSeePos) ? asked : 'table'
  const setView = (next) => setParams((p) => { const q = new URLSearchParams(p); if (next === 'table') q.delete('view'); else q.set('view', next); return q }, { replace: true })
  // The views sit below the catalogue, so arriving on a link to one scrolls it into sight.
  const viewsRef = useRef(null)
  useEffect(() => {
    if (asked) viewsRef.current?.scrollIntoView({ block: 'start' })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- on arrival only
  const vendorStages = useVendorStages()

  const allTags = useStore((s) => s.tags)
  const toggleTagFilter = (id) =>
    setTagFilter((f) => (f.includes(id) ? f.filter((x) => x !== id) : [...f, id]))

  // Cost estimator: the same kind of item across vendors, from the catalogue as hydrated.
  const groups = useMemo(() => quoteGroups(catalogue), [catalogue])
  const [pickedGroup, setPickedGroup] = useState('')
  const groupKey = groups.some((g) => g.key === pickedGroup) ? pickedGroup : groups[0]?.key
  const comparison = useMemo(
    () => (groupKey ? compareQuotes(catalogue, vendors, groupKey) : { quotes: [], lowest: null }),
    [catalogue, vendors, groupKey]
  )

  const items = useMemo(
    () => catalogueFor(catalogue, {
      category: category || undefined,
      subcategory: subcategory || undefined,
      tags: tagFilter,
      query,
    }),
    [catalogue, category, subcategory, tagFilter, query]
  )

  // Vendor index respects the same tag filter — this is the "search vendors by
  // tag" the whole feature exists for.
  const visibleVendors = useMemo(
    () => vendors.filter((v) => hasAllTags(v, tagFilter)),
    [vendors, tagFilter]
  )
  const tagLabel = (id) => allTags.find((x) => x.id === id)?.label || id

  const activeCategory = CATALOG_CATEGORIES.find((c) => c.key === category)

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Third-Party Supply"
        title="Vendor Management"
        subtitle="Approved supplier index with tax, bank and PIC details, a catalogue organised by category and event type, and availability that respects what is already booked."
        actions={
          <>
            <Link to="/purchase-orders" className="btn-ghost">
              <ClipboardList size={15} /> {t('Purchase Orders')}
            </Link>
            <button onClick={() => setManaging(true)} className="btn-ghost">
              <Tags size={15} /> {t('Manage Tags')}
            </button>
            <ActionButton action="request_po" role={role} onClick={() => setAddingItem(true)} disabled={!vendors.length}>
              <Plus size={15} /> {t('Add Catalogue Item')}
            </ActionButton>
            <ActionButton action="request_po" role={role} onClick={() => setAdding(true)}>
              <Plus size={15} /> {t('Add Vendor')}
            </ActionButton>
          </>
        }
      />

      {/* Cost estimator matrix */}
      <Card className="mb-5">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
          <div className="eyebrow">{t('Cost Estimator · Vendor Comparison')}</div>
          {groups.length > 0 && (
            <select value={groupKey} onChange={(e) => setPickedGroup(e.target.value)}
              className="rounded-lg border border-white/10 bg-navy-900 px-2 py-1 text-xs text-white">
              {groups.map((g) => <option key={g.key} value={g.key}>{g.label} ({g.vendors})</option>)}
            </select>
          )}
        </div>
        {comparison.quotes.length ? (
          <>
            <div className="text-sm text-white/60 mb-4">{t('Cheapest catalogue item per vendor in this category.')}</div>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {comparison.quotes.slice(0, 6).map((q) => {
                const isLowest = q.unitPrice === comparison.lowest
                return (
                  <div key={q.vendorId} className={`rounded-xl border p-4 ${isLowest ? 'border-gold/50 bg-gold/[0.07]' : 'border-white/10 bg-white/[0.02]'}`}>
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-white">{q.vendor}</span>
                      {isLowest && <span className="text-[10px] uppercase tracking-wider text-gold-light border border-gold/40 rounded px-1.5 py-0.5">{t('Lowest')}</span>}
                    </div>
                    <div className="mt-2 font-display text-xl text-white tabular-nums">
                      {money(q.unitPrice)}{q.unit && <span className="text-xs text-white/40"> / {q.unit}</span>}
                    </div>
                    <div className="mt-1 text-xs text-white/55 truncate">{q.item}</div>
                    <div className="mt-1 text-xs text-white/40">{t('In stock')} · {q.stock}</div>
                    <div className="mt-2 text-[11px] text-white/50">
                      {q.score != null && <>{t('Rating')} {q.score} · </>}{q.delays} {t('delays')}
                      {q.dpPercent != null && <> · {q.dpPercent}% DP, {q.settlementDays}d</>}
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        ) : (
          <div className="text-sm text-white/40">{t('Needs at least two vendors offering the same kind of item. Add catalogue items to compare.')}</div>
        )}
      </Card>

      {/* Catalogue with hierarchy + date-aware availability */}
      <SectionTitle icon={PackageSearch}>{t('Catalogue · Availability Lookup')}</SectionTitle>

      <Card className="mb-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[200px]">
            <Field label="Search">
              <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-navy-900 px-3 py-2 focus-within:border-gold/50">
                <Search size={14} className="text-white/40 shrink-0" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('Equipment or vendor')}
                  className="w-full bg-transparent text-sm text-white/85 placeholder:text-white/30 outline-none"
                />
              </div>
            </Field>
          </div>
          <Field label="Needed from">
            <TextInput type="date" value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} />
          </Field>
          <Field label="Needed to">
            <TextInput type="date" value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} />
          </Field>
        </div>

        {/* Tag filter — applies to the catalogue AND the vendor index */}
        <div className="mt-4 border-t border-white/5 pt-3">
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <span className="text-[10px] uppercase tracking-wider text-white/30">{t('Tags')}</span>
            {tagFilter.length > 0 && (
              <button
                onClick={() => setTagFilter([])}
                className="inline-flex items-center gap-1 text-[10px] text-white/40 hover:text-white"
              >
                <X size={10} /> {t('Clear tags')}
              </button>
            )}
            <span className="ml-auto text-[10px] text-white/30">
              {tagFilter.length > 1 ? t('matches must carry every selected tag') : t('click to filter')}
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {allTags.map((tag) => (
              <TagChip
                key={tag.id}
                label={tag.label}
                active={tagFilter.includes(tag.id)}
                onClick={() => toggleTagFilter(tag.id)}
                size="md"
              />
            ))}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <FilterPill active={!category} onClick={() => { setCategory(''); setSubcategory('') }}>{t('All categories')}</FilterPill>
          {CATALOG_CATEGORIES.map((c) => (
            <FilterPill
              key={c.key}
              active={category === c.key}
              onClick={() => { setCategory(category === c.key ? '' : c.key); setSubcategory('') }}
            >
              {t(c.label)}
            </FilterPill>
          ))}
        </div>

        {/* Second level of the hierarchy, only once a category is picked */}
        {activeCategory && (
          <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-white/5 pt-3">
            <span className="text-[10px] uppercase tracking-wider text-white/30">{t('Subcategory')}</span>
            <FilterPill active={!subcategory} onClick={() => setSubcategory('')}>{t('All')}</FilterPill>
            {activeCategory.subcategories.map((sc) => (
              <FilterPill key={sc} active={subcategory === sc} onClick={() => setSubcategory(subcategory === sc ? '' : sc)}>
                {sc}
              </FilterPill>
            ))}
          </div>
        )}

        {(range.from || range.to) && (
          <div className="mt-3 text-[11px] text-white/40">
            {t('Availability shown for')} {range.from || '…'} → {range.to || '…'} · {t('existing bookings deducted')}
          </div>
        )}
      </Card>

      <TableWrap>
        <thead>
          <tr>
            <th className="th">{t('Equipment')}</th>
            <th className="th">{t('Partner')}</th>
            <th className="th">{t('Category')}</th>
            <th className="th text-right">{t('Rental Price')}</th>
            <th className="th text-right">{t('Available')}</th>
            <th className="th">{t('Status')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => {
            const free = availableQty(it, range.from, range.to)
            const status = availabilityStatus(it, range.from, range.to)
            return (
              <tr key={it.id}>
                <td className="td font-medium text-white">
                  {it.item}
                  <div className="flex flex-wrap gap-1 mt-1">
                    {(it.tags || []).slice(0, 3).map((id) => (
                      <TagChip key={id} label={tagLabel(id)} active={tagFilter.includes(id)} />
                    ))}
                    {(it.tags || []).length > 3 && (
                      <span className="text-[9px] text-white/30">+{it.tags.length - 3}</span>
                    )}
                  </div>
                </td>
                <td className="td">
                  <Link to={`/vendors/${it.vendorId}`} className="text-white/70 hover:text-gold-light inline-flex items-center gap-1">
                    {it.vendor} <ChevronRight size={12} className="opacity-50" />
                  </Link>
                </td>
                <td className="td text-white/50 text-xs">{it.subcategory}</td>
                <td className="td text-right tabular-nums">
                  {money(it.unitPrice)}<span className="text-white/30 text-xs"> / {it.unit}</span>
                </td>
                <td className="td text-right tabular-nums">
                  <span className={free === 0 ? 'text-rose-400' : free < it.stock * 0.25 ? 'text-amber-400' : 'text-white/80'}>
                    {free}
                  </span>
                  <span className="text-white/30 text-xs"> / {it.stock} {it.unit}</span>
                </td>
                <td className="td"><Badge>{status}</Badge></td>
              </tr>
            )
          })}
          {!items.length && (
            <tr><td className="td text-white/30" colSpan={6}>{t('Nothing in the catalogue matches these filters.')}</td></tr>
          )}
        </tbody>
      </TableWrap>

      {/* Vendor index: a table, the lifecycle board (V2) or the PO pipeline (round 3) */}
      <div ref={viewsRef} className="scroll-mt-20" />
      <SectionTitle
        icon={Award}
        actions={
          <>
            <FilterPill active={view === 'table'} onClick={() => setView('table')}><Table2 size={12} className="inline -mt-0.5 mr-1" />{t('Vendors')}</FilterPill>
            <FilterPill active={view === 'pipeline'} onClick={() => setView('pipeline')}><Columns3 size={12} className="inline -mt-0.5 mr-1" />{t('Vendor lifecycle')}</FilterPill>
            {canSeePos && (
              <FilterPill active={view === 'po'} onClick={() => setView('po')}><Workflow size={12} className="inline -mt-0.5 mr-1" />{t('PO pipeline')}</FilterPill>
            )}
          </>
        }
      >
        {view === 'pipeline' ? t('Vendor lifecycle') : view === 'po' ? t('PO pipeline') : t('Vendors & Scorecards')}
      </SectionTitle>
      {view === 'po' ? (
        <>
          <p className="-mt-1 mb-3 text-xs text-white/45">
            {t('Each purchase order by stage. The strip on a card shows its five steps; a hatched step was skipped.')}
            {' '}<Link to="/purchase-orders" className="text-gold/80 hover:text-gold-light">{t('Open Purchase Orders')}</Link>
          </p>
          <PoPipeline pos={purchaseOrders.filter((po) => visibleVendors.some((v) => v.id === po.vendorId))} />
        </>
      ) : view === 'pipeline' ? <VendorPipeline vendors={visibleVendors} /> : (
      <TableWrap>
        <thead>
          <tr>
            <th className="th">{t('Vendor')}</th>
            <th className="th">{t('Stage')}</th>
            <th className="th">{t('Tags')}</th>
            <th className="th">{t('PIC')}</th>
            <th className="th">NPWP</th>
            <th className="th text-right">{t('PPh 23')}</th>
            <th className="th text-right">{t('Terms')}</th>
            <th className="th text-right">{t('Committed')}</th>
            <th className="th text-center">{t('Delays')}</th>
            <th className="th">{t('Scorecard')}</th>
          </tr>
        </thead>
        <tbody>
          {visibleVendors.map((v) => {
            const wa = waLink(v.pic?.phone)
            const committed = purchaseOrders
              .filter((po) => po.vendorId === v.id && po.status !== 'Cancelled')
              .reduce((a, po) => a + poTotal(po), 0)
            return (
              <tr key={v.id} className="group">
                <td className="td">
                  <Link to={`/vendors/${v.id}`} className="font-medium text-white group-hover:text-gold-light inline-flex items-center gap-1">
                    {v.name}
                    <ChevronRight size={13} className="opacity-0 group-hover:opacity-60 transition-opacity" />
                  </Link>
                </td>
                <td className="td"><VendorStageBadge stage={vendorStageOf(vendorStages, vendorKey(v))} /></td>
                <td className="td">
                  <div className="flex flex-wrap gap-1 max-w-[220px]">
                    {(v.tags || []).map((id) => (
                      <TagChip
                        key={id}
                        label={tagLabel(id)}
                        active={tagFilter.includes(id)}
                        onClick={() => toggleTagFilter(id)}
                      />
                    ))}
                    {!(v.tags || []).length && <span className="text-white/20 text-xs">—</span>}
                  </div>
                  <div className="text-[10px] text-white/30 mt-1">{v.category}</div>
                </td>
                <td className="td">
                  <div className="flex items-center gap-1.5">
                    <span className="text-white/70 text-xs">{v.pic?.name || '—'}</span>
                    {wa && (
                      <a
                        href={wa}
                        target="_blank"
                        rel="noreferrer"
                        title={`WhatsApp ${v.pic.phone}`}
                        className="text-emerald-400 hover:text-emerald-300"
                      >
                        <MessageCircle size={13} />
                      </a>
                    )}
                  </div>
                </td>
                <td className="td font-mono text-[10px] text-white/50">{v.npwp || '—'}</td>
                <td className="td text-right tabular-nums text-white/70">{pct2(v.pph23Rate ?? 0)}</td>
                <td className="td text-right text-xs text-white/60">
                  {v.terms?.dpPercent}% / +{v.terms?.settlementDays}d
                </td>
                <td className="td text-right tabular-nums">{committed ? money(committed) : '—'}</td>
                <td className="td text-center">
                  <span className={v.delays === 0 ? 'text-emerald-400' : v.delays > 2 ? 'text-rose-400' : 'text-amber-400'}>{v.delays}</span>
                </td>
                <td className="td"><Rating value={v.score} /></td>
              </tr>
            )
          })}
          {!visibleVendors.length && (
            <tr><td className="td text-white/30" colSpan={10}>{t('No vendors carry all the selected tags.')}</td></tr>
          )}
        </tbody>
      </TableWrap>
      )}

      <div className="mt-3 text-[11px] text-white/30">
        {tagFilter.length > 0 && (
          <>
            {t('Filtered by')} {tagFilter.map(tagLabel).join(' + ')} — {visibleVendors.length} {t('of')} {vendors.length} {t('vendors')}
            {' · '}
          </>
        )}
        {t('Total committed to vendors')}: {money2(
          purchaseOrders.filter((po) => po.status !== 'Cancelled').reduce((a, po) => a + poTotal(po), 0)
        )}
      </div>

      {adding && <AddVendorModal onClose={() => setAdding(false)} />}
      {addingItem && <AddCatalogueItemModal onClose={() => setAddingItem(false)} />}
      {managing && <TagManagerModal onClose={() => setManaging(false)} />}
    </div>
  )
}
