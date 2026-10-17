// Events with a guest invitation: RSVP progress at a glance, and a starting point for new ones.
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Plus, CalendarDays, MapPin, Palette } from 'lucide-react'
import { PageHeader, Badge, Card, Field, TextInput, Select, appToday, daysUntil } from '../../components/ui'
import Modal from '../../components/Modal'
import { useProto } from '../../store/chatProto'
import { useStore } from '../../store/useStore'
import { eventStats } from '../../lib/events'
import { themeOf, templateById } from '../../lib/templates'
import { shortDate } from '../../components/workspace/parts'
import { canDo } from '../../lib/roles'
import { useT } from '../../i18n'

export default function Events() {
  const t = useT()
  const events = useProto((s) => s.events)
  const guests = useProto((s) => s.guests)
  const eventsStatus = useProto((s) => s.eventsStatus)
  const clients = useStore((s) => s.clients)
  const role = useStore((s) => s.role)
  const [creating, setCreating] = useState(false)
  const sorted = [...events].sort((a, b) => b.date.localeCompare(a.date))

  return (
    <div>
      <PageHeader
        eyebrow="Guest Experience"
        title="Events & Invitations"
        subtitle="Invitation websites, RSVPs, reminders and QR check-in for each event."
        actions={<>
          {/* The sidebar group starts folded, so the Template Studio is reachable from here too. */}
          {canDo(role, 'manage_templates') && <Link to="/events/templates" className="btn-ghost"><Palette size={15} />{t('Templates')}</Link>}
          <button className="btn-gold" onClick={() => setCreating(true)}><Plus size={15} />{t('New event')}</button>
        </>}
      />

      {!sorted.length && (
        <Card><div className="text-sm text-white/50">
          {eventsStatus === 'loading' || eventsStatus === 'idle' ? t('Loading events…') : eventsStatus === 'error' ? t('Events could not be loaded. Try again in a moment.') : t('No events yet. Create the first one.')}
        </div></Card>
      )}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {sorted.map((ev) => {
          // Signed in, the numbers come with the event (the guest lists load when one is opened).
          const st = ev.stats || eventStats(guests.filter((g) => g.eventId === ev.id))
          const { palette: pal } = themeOf(ev.invite)
          const tpl = templateById(ev.invite.templateId)
          const days = daysUntil(ev.date)
          const replied = st.attending + st.declined
          return (
            <Link key={ev.id} to={`/events/${ev.id}`} className="card overflow-hidden block hover:border-gold/40 transition-colors">
              <div style={{ background: pal.bg, color: pal.text }} className="px-5 py-4">
                <div style={{ color: pal.accent }} className="text-[10px] uppercase tracking-[0.3em]">{tpl ? `${t(tpl.name)} · ${ev.invite.content.cover.eyebrow || t('Invitation')}` : t('No template yet')}</div>
                <div className="mt-1 font-display text-lg leading-snug">{ev.invite.content.cover.title || ev.name}</div>
              </div>
              <div className="p-5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-white truncate">{ev.name}</div>
                    <div className="text-xs text-white/45">{clients.find((c) => c.id === ev.clientId)?.name || '—'}</div>
                  </div>
                  <Badge>{ev.status}</Badge>
                </div>
                <div className="mt-3 space-y-1 text-xs text-white/50">
                  <div className="flex items-center gap-1.5"><CalendarDays size={13} /> {shortDate(ev.date)} {ev.date.slice(0, 4)} · {days > 0 ? `D-${days}` : days === 0 ? t('today') : t('held')}</div>
                  <div className="flex items-center gap-1.5 truncate"><MapPin size={13} /> <span className="truncate">{ev.venue || '—'}</span></div>
                </div>
                <div className="mt-4 flex h-2 overflow-hidden rounded-full bg-white/5">
                  <div className="bg-emerald-400/70" style={{ width: `${st.invited ? (st.attending / Math.max(st.invited, replied)) * 100 : 0}%` }} />
                  <div className="bg-rose-400/60" style={{ width: `${st.invited ? (st.declined / Math.max(st.invited, replied)) * 100 : 0}%` }} />
                </div>
                <div className="mt-2 grid grid-cols-4 text-center text-[11px] text-white/45">
                  <div><div className="text-white tabular-nums">{st.invited}</div>{t('invited')}</div>
                  <div><div className="text-emerald-300 tabular-nums">{st.attending}</div>{t('attending')}</div>
                  <div><div className="text-rose-300 tabular-nums">{st.declined}</div>{t('declined')}</div>
                  <div><div className="text-white/70 tabular-nums">{st.noResponse}</div>{t('no reply')}</div>
                </div>
              </div>
            </Link>
          )
        })}
      </div>

      {creating && <NewEventModal clients={clients} onClose={() => setCreating(false)} />}
    </div>
  )
}

function NewEventModal({ clients, onClose }) {
  const t = useT()
  const navigate = useNavigate()
  const projects = useStore((s) => s.projects)
  const [form, setForm] = useState({ name: '', clientId: clients[0]?.id || '', projectId: '', date: '', time: '19:00', venue: '' })
  const set = (patch) => setForm((f) => ({ ...f, ...patch }))
  // "+ New client" opens an inline mini-form instead of sending the user off to CRM.
  const [newClient, setNewClient] = useState(null) // null | { name, contact, phone }
  const [addingClient, setAddingClient] = useState(false)
  const valid = form.name.trim() && form.clientId && !newClient && form.date && form.date >= appToday()
  const clientName = clients.find((c) => c.id === form.clientId)?.name

  const addClient = async () => {
    const draft = { name: newClient.name.trim(), contact: newClient.contact.trim(), phone: newClient.phone.trim(), email: '', birthday: '' }
    setAddingClient(true)
    const result = await useStore.getState().addClient(draft)
    setAddingClient(false)
    // Offline the new row comes straight back; online the list is re-fetched, so find it by name.
    const created = result?.id ? result : result?.ok && [...useStore.getState().clients].reverse().find((c) => c.name === draft.name)
    if (!created) return
    set({ clientId: created.id, projectId: '' })
    setNewClient(null)
  }

  // Signed in the server makes the event (and may refuse), so wait for it before leaving the form.
  const save = async () => {
    const id = await useProto.getState().createEvent(form)
    if (!id) return
    onClose()
    navigate(`/events/${id}`)
  }

  return (
    <Modal
      title="New event"
      subtitle={t('Starts as a draft invitation you can design, then publish.')}
      onClose={onClose}
      footer={<><button className="btn-ghost" onClick={onClose}>{t('Cancel')}</button><button className="btn-gold" disabled={!valid} onClick={save}>{t('Create & design')}</button></>}
    >
      <Field label="Event name"><TextInput autoFocus value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder={t('e.g. TechNusa Year-end Gathering')} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Client">
          <Select
            value={newClient ? '__new' : form.clientId}
            onChange={(e) => {
              if (e.target.value === '__new') setNewClient({ name: '', contact: '', phone: '' })
              else { setNewClient(null); set({ clientId: e.target.value, projectId: '' }) }
            }}
          >
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            <option value="__new">{t('+ New client')}</option>
          </Select>
        </Field>
        <Field label="Project (optional)">
          <Select value={form.projectId} onChange={(e) => set({ projectId: e.target.value })}>
            <option value="">—</option>
            {projects.filter((p) => p.client === clientName).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>
      </div>
      {newClient && (
        <div className="rounded-lg border border-gold/25 bg-gold/[0.04] p-3 space-y-3">
          <Field label="New client name">
            <TextInput autoFocus value={newClient.name} onChange={(e) => setNewClient({ ...newClient, name: e.target.value })} placeholder={t('e.g. Nimbus Retail')} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Contact person"><TextInput value={newClient.contact} onChange={(e) => setNewClient({ ...newClient, contact: e.target.value })} /></Field>
            <Field label="Phone"><TextInput value={newClient.phone} onChange={(e) => setNewClient({ ...newClient, phone: e.target.value })} placeholder="+62 8xx-xxxx-xxxx" /></Field>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => setNewClient(null)}>{t('Cancel')}</button>
            <button type="button" className="btn-gold" disabled={!newClient.name.trim() || addingClient} onClick={addClient}><Plus size={14} />{t('Add client')}</button>
          </div>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Date"><TextInput type="date" min={appToday()} value={form.date} onChange={(e) => set({ date: e.target.value })} /></Field>
        <Field label="Time"><TextInput type="time" value={form.time} onChange={(e) => set({ time: e.target.value })} /></Field>
      </div>
      <Field label="Venue"><TextInput value={form.venue} onChange={(e) => set({ venue: e.target.value })} /></Field>
    </Modal>
  )
}
