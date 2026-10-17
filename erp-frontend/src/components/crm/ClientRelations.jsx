// The relationship side of Client 360 (BRD §5.2): everyone we work with at the company,
// the events they run every year and when to nudge them, and the greetings that go out
// automatically on birthdays and the company anniversary (WhatsApp and email — decision 11).
import { useState } from 'react'
import { Users, CalendarClock, Gift, Plus, Pencil, Trash2, Check, X } from 'lucide-react'
import { Card, Badge } from '../ui'
import { useProto } from '../../store/useProto'
import { useStore } from '../../store/useStore'
import { useRelations } from '../../store/useRelations'
import { nextNudge, nextOccurrence, monthName, isMonthDay } from '../../lib/crm'
import { parseMonths } from '../../lib/relationsApi'
import { appToday } from '../../lib/format'
import { useClientRelations } from './useClientRelations'
import { shortDate, stamp } from '../workspace/parts'
import { greetingText } from './RelationshipCalendar'
import { useT } from '../../i18n'

const CHANNELS = { whatsapp: 'WhatsApp', email: 'Email', both: 'WhatsApp + email' }
const INPUT = 'w-full rounded-md border border-white/10 bg-navy-950 px-2 py-1.5 text-sm text-white/85 outline-none focus:border-gold/50'

export default function ClientRelations({ client }) {
  // The proto store in the offline demo, the server when signed in: one shape either way.
  const rel = useClientRelations(client)
  return (
    <div className="grid gap-4 lg:grid-cols-3 mt-4">
      <Pics client={client} rel={rel} />
      <Cycles client={client} rel={rel} />
      <Greetings client={client} rel={rel} />
    </div>
  )
}

function Pics({ client, rel }) {
  const t = useT()
  const r = rel.r
  const today = appToday()
  const pushToast = useStore((s) => s.pushToast)
  const { savePic, removePic } = useProto.getState()
  const [editing, setEditing] = useState(null) // pic object being edited, or {} for new

  const save = async () => {
    const valid = editing.name?.trim() && (!editing.birthday || isMonthDay(editing.birthday))
    if (!valid) {
      pushToast({ title: t('Check the details'), body: t('A name is needed, and a birthday as MM-DD (e.g. 07-28).'), kind: 'redflag' })
      return
    }
    if (rel.live) {
      const result = await useRelations.getState().saveContact(client.uuid, editing)
      if (result?.ok) setEditing(null)
    } else if (savePic(client.id, editing)) setEditing(null)
  }
  const remove = (p) => (rel.live
    ? useRelations.getState().removeContact(client.uuid, p.id, p.name)
    : removePic(client.id, p.id))

  return (
    <Card>
      <div className="mb-3 flex items-center gap-2">
        <Users size={16} className="text-gold/70" />
        <div className="eyebrow">{t('People we work with')}</div>
        <button onClick={() => setEditing({})} className="ml-auto text-gold/80 hover:text-gold-light" aria-label={t('Add PIC')}><Plus size={16} /></button>
      </div>
      <div className="space-y-2">
        {r.pics.map((p) => editing?.id === p.id ? null : (
          <div key={p.id} className="rounded-lg border border-white/5 p-2.5">
            <div className="flex items-center gap-2">
              <span className="text-sm text-white/90">{p.name}</span>
              <span className="ml-auto flex gap-1">
                <button onClick={() => setEditing(p)} className="p-1 text-white/35 hover:text-white" aria-label={t('Edit')}><Pencil size={13} /></button>
                <button onClick={() => remove(p)} className="p-1 text-white/35 hover:text-rose-300" aria-label={t('Remove')}><Trash2 size={13} /></button>
              </span>
            </div>
            <div className="text-[11px] text-white/45">{p.role}</div>
            <div className="text-[11px] text-white/45">{[p.phone, p.email].filter(Boolean).join(' · ')}</div>
            {p.birthday && (
              <div className="mt-1 text-[11px] text-white/55">
                🎂 {shortDate(nextOccurrence(p.birthday, today))} · {p.greet ? `${t('auto greeting by')} ${t(CHANNELS[p.channel])}` : t('no automatic greeting')}
              </div>
            )}
          </div>
        ))}
        {editing && <PicForm pic={editing} onChange={setEditing} onSave={save} onCancel={() => setEditing(null)} />}
        {r.pics.length === 0 && !editing && <div className="text-sm text-white/35">{t('No contacts yet.')}</div>}
      </div>
    </Card>
  )
}

function PicForm({ pic, onChange, onSave, onCancel }) {
  const t = useT()
  const set = (patch) => onChange({ ...pic, ...patch })
  return (
    <div className="space-y-2 rounded-lg border border-gold/30 p-2.5">
      <input className={INPUT} placeholder={t('Name')} value={pic.name || ''} onChange={(e) => set({ name: e.target.value })} autoFocus />
      <input className={INPUT} placeholder={t('Role')} value={pic.role || ''} onChange={(e) => set({ role: e.target.value })} />
      <div className="grid grid-cols-2 gap-2">
        <input className={INPUT} placeholder={t('Phone')} value={pic.phone || ''} onChange={(e) => set({ phone: e.target.value })} />
        <input className={INPUT} placeholder={t('Email')} value={pic.email || ''} onChange={(e) => set({ email: e.target.value })} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <input className={INPUT} placeholder={t('Birthday MM-DD')} value={pic.birthday || ''} onChange={(e) => set({ birthday: e.target.value.trim() })} />
        <select className={INPUT} value={pic.channel || 'whatsapp'} onChange={(e) => set({ channel: e.target.value })}>
          {Object.entries(CHANNELS).map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}
        </select>
      </div>
      <label className="flex items-center gap-2 text-xs text-white/65">
        <input type="checkbox" className="accent-[#c6a15b]" checked={pic.greet !== false} onChange={(e) => set({ greet: e.target.checked })} />
        {t('Send an automatic birthday greeting')}
      </label>
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="p-1 text-white/50 hover:text-white" aria-label={t('Cancel')}><X size={16} /></button>
        <button onClick={onSave} className="p-1 text-gold-light" aria-label={t('Save')}><Check size={16} /></button>
      </div>
    </div>
  )
}

function CycleForm({ cycle, onChange, onSave, onCancel }) {
  const t = useT()
  return (
    <div className="space-y-2 rounded-lg border border-gold/30 p-2.5">
      <input className={INPUT} placeholder={t('Event name, e.g. Annual Gala')} value={cycle.name || ''} onChange={(e) => onChange({ ...cycle, name: e.target.value })} autoFocus />
      <input className={INPUT} placeholder={t('Months it ran: 2024-07, 2025-07')} value={cycle.monthsText ?? (cycle.history || []).join(', ')} onChange={(e) => onChange({ ...cycle, monthsText: e.target.value })} />
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="p-1 text-white/50 hover:text-white" aria-label={t('Cancel')}><X size={16} /></button>
        <button onClick={onSave} className="p-1 text-gold-light" aria-label={t('Save')}><Check size={16} /></button>
      </div>
    </div>
  )
}

function Cycles({ client, rel }) {
  const t = useT()
  const r = rel.r
  const today = appToday()
  const { updateRelation } = useProto.getState()
  const [editing, setEditing] = useState(null) // a cycle being edited, or {} for a new one (signed in only)
  const setLead = (months) => (rel.live
    ? useRelations.getState().saveSettings(client.uuid, { nudgeLeadMonths: months })
    : updateRelation(client.id, { nudgeLeadMonths: months }))
  const saveCycle = async () => {
    const history = editing.monthsText !== undefined ? parseMonths(editing.monthsText) : editing.history || []
    const result = await useRelations.getState().saveCycle(client.uuid, { id: editing.id, name: (editing.name || '').trim(), history })
    if (result?.ok) setEditing(null)
  }
  return (
    <Card>
      <div className="mb-3 flex items-center gap-2">
        <CalendarClock size={16} className="text-gold/70" />
        <div className="eyebrow">{t('Event cycle')}</div>
        {rel.live && <button onClick={() => setEditing({})} className="ml-auto text-gold/80 hover:text-gold-light" aria-label={t('Add recurring event')}><Plus size={16} /></button>}
      </div>
      <label className="mb-3 flex items-center gap-2 text-xs text-white/60">
        {t('Nudge')}
        <select className="rounded-md border border-white/10 bg-navy-950 px-2 py-1 text-xs text-white/85" value={r.nudgeLeadMonths}
          onChange={(e) => setLead(Number(e.target.value))}>
          {[1, 2, 3, 4, 6].map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        {t('months before their usual month')}
      </label>
      <div className="space-y-2">
        {r.cycles.map((c) => {
          const n = nextNudge(c, r.nudgeLeadMonths, today)
          if (editing?.id && editing.id === c.id) return null
          if (!n) {
            // A cycle with no months yet has nothing to nudge about; signed in it can still be filled in.
            return rel.live ? (
              <div key={c.id || c.name} className="flex items-center gap-2 rounded-lg border border-white/5 p-2.5 text-sm text-white/60">
                {c.name} <span className="text-[11px] text-white/35">{t('no months yet')}</span>
                <span className="ml-auto flex gap-1">
                  <button onClick={() => setEditing(c)} className="p-1 text-white/35 hover:text-white" aria-label={t('Edit')}><Pencil size={13} /></button>
                  <button onClick={() => useRelations.getState().removeCycle(client.uuid, c.id, c.name)} className="p-1 text-white/35 hover:text-rose-300" aria-label={t('Remove')}><Trash2 size={13} /></button>
                </span>
              </div>
            ) : null
          }
          const key = `${c.name}:${n.edition}`
          const handled = (r.handledNudges || []).includes(key)
          const contact = (r.outreach || []).find((o) => o.key === key)
          const overdue = !handled && n.nudgeOn < today
          return (
            <div key={c.name} className="rounded-lg border border-white/5 p-2.5">
              <div className="flex items-center gap-2">
                <span className="text-sm text-white/90">{c.name}</span>
                <span className="ml-auto flex items-center gap-1">
                  {handled ? <Badge>Contacted</Badge> : overdue ? <Badge>Overdue</Badge> : <Badge>Scheduled</Badge>}
                  {rel.live && (
                    <>
                      <button onClick={() => setEditing(c)} className="p-1 text-white/35 hover:text-white" aria-label={t('Edit')}><Pencil size={13} /></button>
                      <button onClick={() => useRelations.getState().removeCycle(client.uuid, c.id, c.name)} className="p-1 text-white/35 hover:text-rose-300" aria-label={t('Remove')}><Trash2 size={13} /></button>
                    </>
                  )}
                </span>
              </div>
              <div className="text-[11px] text-white/45">
                {t('Held')} {c.history.map((h) => `${monthName(Number(h.slice(5)))} ${h.slice(0, 4)}`).join(', ')}
              </div>
              <div className="mt-1 text-[11px] text-white/60">
                {t('Usually')} {monthName(n.month)} → {t('next')} {monthName(n.month)} {n.edition.slice(0, 4)} · {t('nudge on')} <span className={overdue ? 'text-rose-300' : 'text-gold-light'}>{shortDate(n.nudgeOn)} {n.nudgeOn.slice(0, 4)}</span>
              </div>
              {contact && <div className="mt-1 text-[11px] text-emerald-300/80">{t('Contacted')} {stamp(contact.at)} — {contact.note}</div>}
            </div>
          )
        })}
        {editing && <CycleForm cycle={editing} onChange={setEditing} onSave={saveCycle} onCancel={() => setEditing(null)} />}
        {r.cycles.length === 0 && !editing && (
          <div className="text-sm text-white/35">
            {rel.live ? t('No recurring events yet — add one with the months it ran.') : t('No recurring events yet — they appear after a company’s second edition.')}
          </div>
        )}
      </div>
    </Card>
  )
}

function Greetings({ client, rel }) {
  const t = useT()
  const r = rel.r
  const today = appToday()
  const { updateRelation } = useProto.getState()
  const mine = rel.greetings
  // The same change in either place: the proto store offline, the server when signed in.
  const change = (patch) => (rel.live
    ? useRelations.getState().saveSettings(client.uuid, patch)
    : updateRelation(client.id, patch))
  const years = r.anniversary ? Number(nextOccurrence(r.anniversary, today).slice(0, 4)) - Number(r.anniversary.slice(0, 4)) : 0
  return (
    <Card>
      <div className="mb-3 flex items-center gap-2">
        <Gift size={16} className="text-gold/70" />
        <div className="eyebrow">{t('Greetings')}</div>
      </div>
      <label className="block text-xs text-white/60">
        {t('Company anniversary')}
        <input type="date" className={`${INPUT} mt-1`} value={r.anniversary || ''} onChange={(e) => change({ anniversary: e.target.value || null })} />
      </label>
      <div className="mt-2 flex items-center gap-2 text-xs text-white/65">
        <input type="checkbox" className="accent-[#c6a15b]" checked={r.greetAnniversary} onChange={(e) => change({ greetAnniversary: e.target.checked })} />
        {t('Send automatically by')}
        <select className="rounded-md border border-white/10 bg-navy-950 px-2 py-1 text-xs text-white/85" value={r.anniversaryChannel}
          onChange={(e) => change({ anniversaryChannel: e.target.value })}>
          {Object.entries(CHANNELS).map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}
        </select>
      </div>
      {r.anniversary && (
        <div className="mt-3 rounded-lg border border-emerald-500/15 bg-emerald-500/5 p-2.5 text-xs text-white/70">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-emerald-300/70">{t('Preview')} · {shortDate(nextOccurrence(r.anniversary, today))}</div>
          {greetingText({ kind: 'Company anniversary', client: client.name, title: `${years} years` })}
        </div>
      )}
      <div className="mt-4 text-[11px] uppercase tracking-wider text-white/35">{t('Sent')}</div>
      <div className="mt-1 space-y-1">
        {[...mine].reverse().map((l) => (
          <div key={l.id} className="flex justify-between text-xs"><span className="text-white/70">{t(l.kind)} · {l.to}</span><span className="text-white/40">{stamp(l.at)} · {t(CHANNELS[l.channel])}</span></div>
        ))}
        {mine.length === 0 && <div className="text-xs text-white/35">{t('Nothing sent yet.')}</div>}
      </div>
      <p className="mt-3 text-[10px] text-white/30">
        {rel.live
          ? t('Greetings are prepared, not sent: open the WhatsApp or email link from the calendar, send it yourself, then mark it sent.')
          : t('Prototype: greetings are simulated. With the backend they send on the day through WhatsApp Business and email.')}
      </p>
    </Card>
  )
}
