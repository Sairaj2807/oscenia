import { useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
  Cake, Gift, ChevronRight, Search, Plus, Pencil, Check, X,
  StickyNote, CalendarDays,
} from 'lucide-react'
import { useStore } from '../store/useStore'
import {
  PageHeader, Card, TableWrap, money, Rating, SectionTitle,
  Field, TextInput, ActionButton, Tabs,
} from '../components/ui'
import GuestContacts from '../components/crm/GuestContacts'
import RelationshipCalendar from '../components/crm/RelationshipCalendar'
import CalendarTab from '../components/crm/CalendarView'
import Modal from '../components/Modal'
import { clientLTV, clientTimeline } from '../lib/crm'
import { canSee } from '../lib/roles'
import { useT } from '../i18n'

function AddClientModal({ onClose }) {
  const addClient = useStore((s) => s.addClient)
  const t = useT()
  const [form, setForm] = useState({ name: '', contact: '', email: '', phone: '', birthday: '' })
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  return (
    <Modal
      title="Add Client"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="btn-ghost">{t('Cancel')}</button>
          <button
            onClick={() => { addClient({ ...form, name: form.name.trim() }); onClose() }}
            disabled={!form.name.trim()}
            className="btn-gold"
          >
            <Plus size={14} /> {t('Add client')}
          </button>
        </>
      }
    >
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Client / Company">
          <TextInput value={form.name} onChange={set('name')} placeholder="e.g. Nimbus Retail" />
        </Field>
        <Field label="Contact person">
          <TextInput value={form.contact} onChange={set('contact')} placeholder="e.g. Ibu Sari" />
        </Field>
        <Field label="Email">
          <TextInput value={form.email} onChange={set('email')} />
        </Field>
        <Field label="Phone">
          <TextInput value={form.phone} onChange={set('phone')} placeholder="+62 8xx-xxxx-xxxx" />
        </Field>
        <Field label="Birthday" hint={t('e.g. 14 Mar')}>
          <TextInput value={form.birthday} onChange={set('birthday')} />
        </Field>
      </div>
    </Modal>
  )
}

// The free-text Note column.
//
// Full note history already existed on Client 360, but the client asked for the
// column to be visible where they actually work — the client list — so a
// discussion can be recorded without opening a record first. The note carries
// its author and timestamp automatically, which is the "integrated interaction
// chronology" half of the request.
function NoteCell({ client }) {
  const notes = useStore((s) => s.interactions[client.id]) || []
  const logInteraction = useStore((s) => s.logInteraction)
  const role = useStore((s) => s.role)
  const t = useT()
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')

  const latest = notes[0]

  const save = () => {
    const text = draft.trim()
    if (!text) return
    logInteraction(client.id, { type: 'Note', note: text })
    setDraft('')
    setAdding(false)
  }

  if (adding) {
    return (
      <div className="flex items-start gap-1.5" onClick={(e) => e.stopPropagation()}>
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { setAdding(false); setDraft('') }
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save() }
          }}
          rows={2}
          placeholder={t('What was discussed, agreed or requested?')}
          className="min-w-0 flex-1 rounded-lg border border-gold/40 bg-navy-900 p-2 text-[11px] text-white/85 outline-none resize-y"
        />
        <button onClick={save} disabled={!draft.trim()} className="mt-1 text-emerald-400 hover:text-emerald-300 disabled:opacity-30">
          <Check size={13} />
        </button>
        <button onClick={() => { setAdding(false); setDraft('') }} className="mt-1 text-white/30 hover:text-white">
          <X size={13} />
        </button>
      </div>
    )
  }

  return (
    <div className="min-w-[180px] max-w-[280px]">
      {latest ? (
        <>
          <div className="line-clamp-2 text-[11px] text-white/70">{latest.note}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-white/30">
            <span>{latest.by}</span>
            <span>·</span>
            <span>{latest.date}</span>
            {notes.length > 1 && (
              <span className="rounded-full bg-white/5 px-1.5 text-white/40">+{notes.length - 1}</span>
            )}
            <span className="text-emerald-400/50">{'\u2713'} {t('auto-saved')}</span>
          </div>
        </>
      ) : (
        <span className="text-[11px] text-white/20">{t('No notes yet')}</span>
      )}
      <ActionButton
        action="edit_client"
        role={role}
        onClick={(e) => { e.stopPropagation(); setAdding(true) }}
        className="mt-0.5 inline-flex items-center gap-1 text-[10px] text-gold/60 hover:text-gold-light disabled:opacity-0"
      >
        <Plus size={10} /> {t('Add note')}
      </ActionButton>
    </div>
  )
}

// Inline phone edit. The deck asked specifically for "rapid client lookup,
// phone number updates, and database additions" — a phone number is the field
// that goes stale most often, so it is editable in place rather than behind a
// form.
function PhoneCell({ client }) {
  const updateClient = useStore((s) => s.updateClient)
  const role = useStore((s) => s.role)
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(client.phone)

  if (!editing) {
    return (
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] text-white/40">{client.phone || '—'}</span>
        <ActionButton
          action="edit_client"
          role={role}
          onClick={(e) => { e.stopPropagation(); setValue(client.phone); setEditing(true) }}
          className="text-white/25 hover:text-gold-light disabled:opacity-0"
          title="Edit phone"
        >
          <Pencil size={11} />
        </ActionButton>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { updateClient(client.id, { phone: value }); setEditing(false) }
          if (e.key === 'Escape') setEditing(false)
        }}
        className="w-36 rounded border border-gold/40 bg-navy-900 px-1.5 py-0.5 text-[11px] text-white/85 outline-none"
      />
      <button onClick={() => { updateClient(client.id, { phone: value }); setEditing(false) }} className="text-emerald-400 hover:text-emerald-300">
        <Check size={12} />
      </button>
      <button onClick={() => setEditing(false)} className="text-white/30 hover:text-white">
        <X size={12} />
      </button>
    </div>
  )
}

export default function CRM() {
  const clients = useStore((s) => s.clients)
  const projects = useStore((s) => s.projects)
  const role = useStore((s) => s.role)
  const navigate = useNavigate()
  const t = useT()

  // Demo-only past events; empty once live, so a client's lifetime value never includes
  // events that are not in the database. See the note in hydrate.js.
  const history = useStore((s) => s.clientHistory)
  const [query, setQuery] = useState('')
  const [range, setRange] = useState({ from: '', to: '' })
  const [adding, setAdding] = useState(false)
  const [params] = useSearchParams()
  const [tab, setTab] = useState(() => params.get('tab') || 'clients')

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return clients.filter((c) => {
      if (q) {
        const hay = [c.name, c.contact, c.phone, c.email, ...(c.prefEvents || [])].join(' ').toLowerCase()
        if (!hay.includes(q)) return false
      }
      // Event date filter: keep clients with an event inside the window, which
      // is how Sales checks "who has something running in this period".
      if (range.from || range.to) {
        const events = clientTimeline(c, projects, history)
        const inWindow = events.some((e) => {
          const d = e.date && e.date.length === 7 ? `${e.date}-15` : e.date
          if (!d) return false
          if (range.from && d < range.from) return false
          if (range.to && d > range.to) return false
          return true
        })
        if (!inWindow) return false
      }
      return true
    })
  }, [clients, projects, query, range])

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Client Relationships"
        title="CRM & Client Database"
        subtitle="Lifetime value, preferences, and automated milestone reminders. Search the database, update contact details in place, and open any row for the client's full 360° history."
        actions={
          <>
            {/* The sidebar group starts folded, so the Google Calendar page is linked here too. */}
            {canSee(role, 'gcal') && (
              <Link to="/google-calendar" className="btn-ghost">
                <CalendarDays size={15} /> {t('Google Calendar')}
              </Link>
            )}
            <ActionButton action="edit_client" role={role} onClick={() => setAdding(true)}>
              <Plus size={15} /> {t('Add Client')}
            </ActionButton>
          </>
        }
      />

      <Tabs
        tabs={[
          { key: 'clients', label: 'Clients', count: clients.length },
          { key: 'contacts', label: 'Guest contacts' },
          { key: 'calendar', label: 'Relationship calendar' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'contacts' && <GuestContacts />}
      {tab === 'calendar' && <CalendarTab />}

      {tab === 'clients' && (<>
      {/* Coming up: the live relationship calendar, soonest first. It replaces a hardcoded
          birthday banner that always said "in 2 days". */}
      <Card className="border-gold/25 bg-gradient-to-br from-gold/[0.06] to-transparent mb-5">
        <div className="mb-3 flex items-center gap-2">
          <Gift size={16} className="text-gold-light" />
          <div className="eyebrow">{t('Coming up · nudges, birthdays, anniversaries')}</div>
          <button onClick={() => navigate('/cron')} className="ml-auto text-xs text-white/50 hover:text-gold-light">{t('Automated Cron')} →</button>
          <button onClick={() => setTab('calendar')} className="text-xs text-gold/80 hover:text-gold-light">{t('Full calendar')} →</button>
        </div>
        <RelationshipCalendar limit={3} compact />
      </Card>

      <Card className="mb-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[220px]">
            <Field label="Search">
              <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-navy-900 px-3 py-2 focus-within:border-gold/50">
                <Search size={14} className="text-white/40 shrink-0" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('Name, contact, phone or email')}
                  className="w-full bg-transparent text-sm text-white/85 placeholder:text-white/30 outline-none"
                />
                {query && (
                  <button onClick={() => setQuery('')} className="text-white/30 hover:text-white"><X size={13} /></button>
                )}
              </div>
            </Field>
          </div>
          <Field label="Event from" hint={t('Filters clients by event history')}>
            <TextInput type="date" value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} />
          </Field>
          <Field label="Event to">
            <TextInput type="date" value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} />
          </Field>
          {(range.from || range.to || query) && (
            <button onClick={() => { setRange({ from: '', to: '' }); setQuery('') }} className="btn-ghost text-xs py-1.5">
              {t('Clear')}
            </button>
          )}
        </div>
      </Card>

      <SectionTitle>
        {t('Clients')} ({rows.length}{rows.length !== clients.length ? ` ${t('of')} ${clients.length}` : ''})
      </SectionTitle>

      <TableWrap>
        <thead>
          <tr>
            <th className="th">{t('Client')}</th>
            <th className="th">{t('Contact')}</th>
            <th className="th"><span className="inline-flex items-center gap-1"><Cake size={12} /> {t('Birthday')}</span></th>
            <th className="th text-right">LTV</th>
            <th className="th">{t('Preferred Events')}</th>
            <th className="th">
              <span className="inline-flex items-center gap-1"><StickyNote size={12} /> {t('Note')}</span>
            </th>
            <th className="th">{t('Fav. Vendor')}</th>
            <th className="th">{t('Satisfaction')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr
              key={c.id}
              onClick={() => navigate(`/crm/${c.id}`)}
              className="group cursor-pointer hover:bg-white/[0.03] transition-colors"
            >
              <td className="td">
                <span className="inline-flex items-center gap-1 font-medium text-white group-hover:text-gold-light">
                  {c.name}
                  <ChevronRight size={14} className="opacity-0 group-hover:opacity-60 transition-opacity" />
                </span>
              </td>
              <td className="td">
                <div>{c.contact || '—'}</div>
                <PhoneCell client={c} />
              </td>
              <td className="td text-white/60">{c.birthday || '—'}</td>
              <td className="td text-right tabular-nums text-gold-light">{money(clientLTV(c, projects, history))}</td>
              <td className="td">
                <div className="flex flex-wrap gap-1">
                  {(c.prefEvents || []).map((e) => (
                    <span key={e} className="rounded-full bg-white/5 border border-white/10 px-2 py-0.5 text-[10px] text-white/60">{e}</span>
                  ))}
                  {!(c.prefEvents || []).length && <span className="text-white/20 text-xs">—</span>}
                </div>
              </td>
              <td className="td"><NoteCell client={c} /></td>
              <td className="td text-white/60">{c.favVendor}</td>
              <td className="td">{c.satisfaction ? <Rating value={c.satisfaction} /> : <span className="text-white/20 text-xs">—</span>}</td>
            </tr>
          ))}
          {!rows.length && (
            <tr><td className="td text-white/30" colSpan={8}>{t('No clients match this search.')}</td></tr>
          )}
        </tbody>
      </TableWrap>
      </>)}

      {adding && <AddClientModal onClose={() => setAdding(false)} />}
    </div>
  )
}
