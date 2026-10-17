import { useEffect, useMemo, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import {
  ArrowLeft, Cake, Phone, Mail, Gem, CalendarHeart, History, CalendarCheck,
  Truck, Star, MessageCircle, Plus, Pencil, Trash2, Paperclip, Check, X,
} from 'lucide-react'
import { useStore } from '../store/useStore'
import { openStoredFile } from '../lib/files'
import { api } from '../lib/api'
import { historySummary, historyTimeline } from '../lib/clientHistory'
import { clientLTV, clientTimeline } from '../lib/crm'
import {
  Card, Badge, money, Rating, PageHeader, ActionButton, Field as FormField, Select,
} from '../components/ui'
import Modal from '../components/Modal'
import ClientRelations from '../components/crm/ClientRelations'
import { canDo } from '../lib/roles'
import { useT } from '../i18n'

const INTERACTION_TYPES = ['Note', 'Meeting', 'Call', 'Quote sent', 'Site visit', 'Complaint']

// The "Log interaction" button used to have no onClick at all. Interactions now
// live in the store rather than being read straight out of the seed file, so a
// note added here actually persists for the session.
function LogInteractionModal({ clientId, clientName, onClose }) {
  const logInteraction = useStore((s) => s.logInteraction)
  const t = useT()
  const [type, setType] = useState('Note')
  const [note, setNote] = useState('')

  return (
    <Modal
      title="Log Interaction"
      subtitle={clientName}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="btn-ghost">{t('Cancel')}</button>
          <button
            onClick={() => { logInteraction(clientId, { type, note: note.trim() }); onClose() }}
            disabled={!note.trim()}
            className="btn-gold"
          >
            <Plus size={14} /> {t('Save note')}
          </button>
        </>
      }
    >
      <FormField label="Type">
        <Select value={type} onChange={(e) => setType(e.target.value)}>
          {INTERACTION_TYPES.map((x) => <option key={x} value={x}>{x}</option>)}
        </Select>
      </FormField>
      <FormField label="Note">
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={4}
          placeholder={t('What was discussed, agreed or requested?')}
          className="w-full rounded-lg border border-white/10 bg-navy-900 p-2.5 text-sm text-white/85 focus:border-gold/50 outline-none resize-y"
        />
      </FormField>
    </Modal>
  )
}

const TYPE_STYLE = {
  Meeting: 'bg-sky-500/15 text-sky-300',
  Call: 'bg-violet-500/15 text-violet-300',
  'Quote sent': 'bg-gold/15 text-gold-light',
  'Event closed': 'bg-emerald-500/15 text-emerald-300',
  Anniversary: 'bg-pink-500/15 text-pink-300',
  Note: 'bg-white/10 text-white/70',
  'Site visit': 'bg-teal-500/15 text-teal-300',
  Complaint: 'bg-rose-500/15 text-rose-300',
}

function Field({ icon: Icon, label, value }) {
  return (
    <div className="flex items-start gap-2.5">
      <Icon size={15} className="text-gold/70 mt-0.5 shrink-0" />
      <div>
        <div className="text-[11px] uppercase tracking-wider text-white/35">{label}</div>
        <div className="text-sm text-white/85">{value}</div>
      </div>
    </div>
  )
}

// One entry in the interaction timeline. Editing happens in place rather than in
// a modal: a note is two fields, and bouncing to a dialog to fix a typo is worse
// than the typo.
function InteractionRow({ clientId, note, canEdit }) {
  const updateInteraction = useStore((s) => s.updateInteraction)
  const deleteInteraction = useStore((s) => s.deleteInteraction)
  const attachToInteraction = useStore((s) => s.attachToInteraction)
  const detachFromInteraction = useStore((s) => s.detachFromInteraction)
  const live = useStore((s) => s.hydrated)
  const t = useT()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(note.note)
  const [attaching, setAttaching] = useState(false)
  const [filename, setFilename] = useState('')

  const save = () => {
    if (draft.trim()) updateInteraction(clientId, note.id, { note: draft.trim() })
    setEditing(false)
  }

  return (
    <div className="relative">
      <span className="absolute -left-4 top-1.5 h-2.5 w-2.5 rounded-full bg-gold ring-4 ring-navy-800" />
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-white/40 tabular-nums">{note.date}</span>
        <span className={`rounded-full px-2 py-0.5 text-[10px] ${TYPE_STYLE[note.type] || 'bg-white/10 text-white/60'}`}>
          {note.type}
        </span>
        <span className="text-[11px] text-white/30">· {note.by}</span>
        {note.editedAt && <span className="text-[10px] text-white/25">({t('edited')} {note.editedAt})</span>}
        {canEdit && !editing && (
          <span className="ml-auto flex items-center gap-1.5">
            <button onClick={() => { setDraft(note.note); setEditing(true) }} className="text-white/25 hover:text-gold-light" title={t('Edit note')}>
              <Pencil size={12} />
            </button>
            <button onClick={() => setAttaching((a) => !a)} className="text-white/25 hover:text-gold-light" title={t('Attach a file')}>
              <Paperclip size={12} />
            </button>
            <button onClick={() => deleteInteraction(clientId, note.id)} className="text-white/25 hover:text-rose-300" title={t('Delete note')}>
              <Trash2 size={12} />
            </button>
          </span>
        )}
      </div>

      {editing ? (
        <div className="mt-1 flex items-start gap-1.5">
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEditing(false)
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save()
            }}
            rows={2}
            className="min-w-0 flex-1 rounded-lg border border-gold/40 bg-navy-900 p-2 text-sm text-white/85 outline-none resize-y"
          />
          <button onClick={save} className="mt-1 text-emerald-400 hover:text-emerald-300"><Check size={14} /></button>
          <button onClick={() => setEditing(false)} className="mt-1 text-white/30 hover:text-white"><X size={14} /></button>
        </div>
      ) : (
        <div className="text-sm text-white/80 mt-1">{note.note}</div>
      )}

      {/* Signed in these are stored files (click to open); the demo keeps typed names only. */}
      {(note.attachments || []).length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {note.attachments.map((f) => {
            const stored = typeof f !== 'string'
            return (
              <span key={stored ? f.id : f} className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-white/55">
                <Paperclip size={9} />
                {stored ? (
                  <button onClick={() => openStoredFile(f.id, f.name).catch(() => {})} className="hover:text-gold-light" title={t('Open')}>{f.name}</button>
                ) : f}
                {canEdit && (
                  <button onClick={() => detachFromInteraction(clientId, note.id, stored ? f.id : f)} className="text-white/30 hover:text-rose-300" aria-label={`${t('Remove')} ${stored ? f.name : f}`}>
                    <X size={9} />
                  </button>
                )}
              </span>
            )
          })}
        </div>
      )}

      {attaching && live && (
        <div className="mt-1.5 flex items-center gap-1.5">
          <input
            type="file"
            accept="image/*,application/pdf"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) { attachToInteraction(clientId, note.id, file); setAttaching(false) }
              e.target.value = ''
            }}
            className="min-w-0 flex-1 text-[11px] text-white/70 file:mr-2 file:rounded file:border file:border-white/15 file:bg-white/5 file:px-2 file:py-1 file:text-white/80"
          />
          <button onClick={() => setAttaching(false)} className="text-white/30 hover:text-white"><X size={13} /></button>
        </div>
      )}

      {attaching && !live && (
        <div className="mt-1.5 flex items-center gap-1.5">
          <input
            autoFocus
            value={filename}
            onChange={(e) => setFilename(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { setAttaching(false); setFilename('') }
              if (e.key === 'Enter' && filename.trim()) {
                attachToInteraction(clientId, note.id, filename)
                setFilename(''); setAttaching(false)
              }
            }}
            placeholder={t('File name, e.g. site-photos.pdf')}
            className="min-w-0 flex-1 rounded border border-gold/40 bg-navy-900 px-2 py-1 text-[11px] text-white/85 outline-none"
          />
          <button
            onClick={() => { attachToInteraction(clientId, note.id, filename); setFilename(''); setAttaching(false) }}
            disabled={!filename.trim()}
            className="text-emerald-400 hover:text-emerald-300 disabled:opacity-30"
          >
            <Check size={13} />
          </button>
          <button onClick={() => { setAttaching(false); setFilename('') }} className="text-white/30 hover:text-white">
            <X size={13} />
          </button>
        </div>
      )}
    </div>
  )
}

export default function ClientDetail() {
  const { id } = useParams()
  const client = useStore((s) => s.clients.find((c) => c.id === id))
  const projects = useStore((s) => s.projects)
  const role = useStore((s) => s.role)
  // Interactions come from the store now so newly logged notes appear here.
  const interactions = useStore((s) => s.interactions[id]) || []
  const [logging, setLogging] = useState(false)

  // Notes come from the API on demand -- the endpoint is scoped to one client.
  const loadInteractions = useStore((s) => s.loadInteractions)
  const hydrated = useStore((s) => s.hydrated)
  useEffect(() => {
    if (hydrated && id) loadInteractions(id)
  }, [hydrated, id, loadInteractions])

  // Signed in, the server derives the history (past events, vendors, rating, what was contracted and
  // collected) from the projects, invoices and purchase orders. Signed out it is the demo's seed.
  const history = useStore((s) => s.clientHistory)
  const [served, setServed] = useState(null)
  useEffect(() => {
    if (!hydrated || !client?.uuid) { setServed(null); return undefined }
    let off = false
    api.get(`/clients/${client.uuid}/history`).then((h) => { if (!off) setServed(h) }, () => { if (!off) setServed(null) })
    return () => { off = true }
  }, [hydrated, client?.uuid, projects])
  const timeline = useMemo(
    () => (served ? historyTimeline(served) : client ? clientTimeline(client, projects, history) : []),
    [client, projects, history, served]
  )
  const ltv = useMemo(
    () => (served ? historySummary(served).ltv : client ? clientLTV(client, projects, history) : 0),
    [client, projects, history, served]
  )

  const derived = useMemo(() => {
    if (served) {
      const s = historySummary(served)
      return { avgSat: s.avgSat, vendorsUsed: s.vendorsUsed, eventCount: s.eventCount }
    }
    const rated = timeline.filter((e) => e.satisfaction != null)
    const avgSat = rated.length ? rated.reduce((a, e) => a + e.satisfaction, 0) / rated.length : null
    const vendorCount = {}
    timeline.forEach((e) => e.vendors.forEach((v) => { vendorCount[v] = (vendorCount[v] || 0) + 1 }))
    const vendorsUsed = Object.entries(vendorCount).sort((a, b) => b[1] - a[1])
    return { avgSat, vendorsUsed, eventCount: timeline.length }
  }, [timeline, served])

  if (!client) {
    return (
      <div className="animate-fade-up">
        <Link to="/crm" className="inline-flex items-center gap-1.5 text-sm text-white/50 hover:text-white mb-4"><ArrowLeft size={16} /> CRM</Link>
        <Card>Client not found in this prototype’s seed data.</Card>
      </div>
    )
  }

  return (
    <div className="animate-fade-up">
      <Link to="/crm" className="inline-flex items-center gap-1.5 text-sm text-white/50 hover:text-white mb-4">
        <ArrowLeft size={16} /> Client database
      </Link>

      <PageHeader
        eyebrow="Client 360"
        title={client.name}
        subtitle={`${client.contact} · ${(client.prefEvents || []).join(', ')}`}
        actions={
          <ActionButton action="edit_client" role={role} onClick={() => setLogging(true)}>
            <MessageCircle size={15} /> Log interaction
          </ActionButton>
        }
      />

      {/* Personal / Company Profile (slide 4) */}
      <Card className="mb-4">
        <div className="eyebrow mb-4">Personal / Company Profile</div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-4">
          <Field icon={MessageCircle} label="Name" value={client.name} />
          <Field icon={Phone} label="Contact Person" value={client.contact} />
          <Field icon={Mail} label="Email" value={client.email} />
          <Field icon={Phone} label="Phone" value={client.phone} />
          <Field icon={Cake} label="Birthday" value={client.birthday} />
          <Field icon={CalendarHeart} label="Company Anniversary" value={client.anniversary} />
          <Field icon={Gem} label="Personal Brand" value={client.personalBrand} />
        </div>
      </Card>

      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
        <Card>
          <div className="text-xs text-white/40">Lifetime Value</div>
          <div className="mt-1 font-display text-xl text-gold-light tabular-nums">{money(ltv)}</div>
          <div className="text-[10px] text-white/30 mt-0.5">sum of all projects · live + past</div>
        </Card>
        <Card><div className="text-xs text-white/40">Projects (Live + Past)</div><div className="mt-1 font-display text-xl text-white tabular-nums">{derived.eventCount}</div></Card>
        <Card><div className="text-xs text-white/40">Avg Satisfaction</div><div className="mt-1 font-display text-xl text-white">{derived.avgSat ? <Rating value={derived.avgSat} /> : '—'}</div></Card>
        <Card><div className="text-xs text-white/40">Favorite Vendor</div><div className="mt-1 font-display text-lg text-white">{client.favVendor}</div></Card>
      </div>

      {/* PICs, event cycle and greetings — the relationship layer (prototype). */}
      <div className="mb-4"><ClientRelations client={client} /></div>

      <div className="grid lg:grid-cols-5 gap-4">
        {/* Interaction timeline */}
        <Card className="lg:col-span-3">
          <div className="flex items-center gap-2 mb-4">
            <History size={16} className="text-gold/70" />
            <div className="eyebrow">Interaction History</div>
          </div>
          <div className="relative pl-4">
            <div className="absolute left-[5px] top-1 bottom-1 w-px bg-white/10" />
            <div className="space-y-4">
              {interactions.map((it) => (
                <InteractionRow
                  key={it.id}
                  clientId={id}
                  note={it}
                  canEdit={canDo(role, 'edit_client')}
                />
              ))}
              {!interactions.length && <div className="text-sm text-white/30">No interactions logged yet.</div>}
            </div>
          </div>
        </Card>

        {/* Vendors used + preferences */}
        <div className="lg:col-span-2 space-y-4">
          <Card>
            <div className="flex items-center gap-2 mb-3">
              <Truck size={16} className="text-gold/70" />
              <div className="eyebrow">Vendors Used</div>
            </div>
            <div className="space-y-2">
              {derived.vendorsUsed.map(([v, n]) => (
                <div key={v} className="flex items-center justify-between rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2">
                  <span className="text-sm text-white/80">{v}</span>
                  <span className="text-[11px] text-white/40">{n} event{n > 1 ? 's' : ''}</span>
                </div>
              ))}
              {!derived.vendorsUsed.length && <div className="text-sm text-white/30">No vendor history yet.</div>}
            </div>
          </Card>
          <Card>
            <div className="eyebrow mb-3">Preferred Event Types</div>
            <div className="flex flex-wrap gap-2">
              {(client.prefEvents || []).map((e) => (
                <span key={e} className="rounded-full bg-gold/10 border border-gold/25 px-3 py-1 text-xs text-gold-light">{e}</span>
              ))}
            </div>
          </Card>
        </div>
      </div>

      {/* Project history with per-event satisfaction */}
      <Card className="mt-4">
        <div className="flex items-center gap-2 mb-4">
          <CalendarCheck size={16} className="text-gold/70" />
          <div className="eyebrow">Project History · Satisfaction Records</div>
        </div>
        <div className="space-y-2">
          {timeline.map((e) => (
            <div key={e.name + e.date} className="flex flex-wrap items-center gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-4 py-3">
              <span className="text-sm text-white font-medium min-w-[150px]">{e.name}</span>
              <span className="text-xs text-white/40 w-16">{e.date}</span>
              <span className="text-sm text-white/60 tabular-nums w-20">{money(e.value)}</span>
              <div className="flex flex-wrap gap-1 flex-1">
                {e.vendors.map((v) => (
                  <span key={v} className="rounded bg-white/5 border border-white/10 px-1.5 py-0.5 text-[10px] text-white/50">{v}</span>
                ))}
              </div>
              {e.live
                ? <Badge>{e.stage}</Badge>
                : e.satisfaction != null
                  ? <span className="inline-flex items-center gap-1 text-sm text-gold-light"><Star size={13} /> {e.satisfaction.toFixed(1)}</span>
                  : <Badge>Upcoming</Badge>}
            </div>
          ))}
          {!timeline.length && <div className="text-sm text-white/30">No projects on record yet.</div>}
        </div>
      </Card>

      {logging && (
        <LogInteractionModal clientId={id} clientName={client.name} onClose={() => setLogging(false)} />
      )}
    </div>
  )
}
