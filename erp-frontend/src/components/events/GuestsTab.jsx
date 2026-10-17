// Guests & RSVP: the client's list against who has replied (BRD §4.3). Staff assign tables and
// categories here before the event (decision 7, R2); the desk can still change them on the day.
import { useEffect, useMemo, useState } from 'react'
import { Upload, Download, Plus, Search, Link2, StickyNote, Trash2 } from 'lucide-react'
import { StatCard, Badge, FilterPill, TableWrap } from '../ui'
import { useProto } from '../../store/chatProto'
import { useStore } from '../../store/useStore'
import {
  eventStats, guestStatus, parseGuestCsv, guestCategory, personalLink, GUEST_CATEGORIES, answerText, answerCounts, tableSuggestions, MAX_TABLE_LENGTH,
} from '../../lib/events'
import TableInput, { TableSuggestions } from './TableInput'
import { exportCSV } from '../../lib/exports'
import { stamp } from '../workspace/parts'
import { useT } from '../../i18n'

const FILTERS = [
  ['all', 'All'],
  ['Attending', 'Attending'],
  ['Declined', 'Declined'],
  ['No response', 'No response'],
  ['off', 'Not on the list'],
]

export default function GuestsTab({ event }) {
  const t = useT()
  const all = useProto((s) => s.guests)
  const guests = useMemo(() => all.filter((g) => g.eventId === event.id), [all, event.id])
  const pushToast = useStore((s) => s.pushToast)
  const { setGuestTable, setGuestCategory, addGuests } = useProto.getState()
  const role = useStore((s) => s.role)
  // Erasing is for the people who publish invitations (CEO, PM); the server refuses anyone else.
  const canErase = role === 'ceo' || role === 'pm'
  const erase = async (g) => {
    if (!window.confirm(t('Erase this guest’s personal data? Their name, phone, email, answers and wishes are removed and their link stops working. The headcount stays. This cannot be undone.'))) return
    if (await useProto.getState().eraseGuest(g.id)) pushToast({ title: 'Guest erased', body: 'Their personal data was removed.', kind: 'project' })
  }
  const [filter, setFilter] = useState('all')
  const [category, setCategory] = useState('all')
  // A personal link is a full URL sent to the guest; the origin only exists in the browser.
  const path = `${import.meta.env.BASE_URL}invite/${event.id}`
  const [eventLink, setEventLink] = useState(path)
  useEffect(() => { setEventLink(`${window.location.origin}${path}`) }, [path])
  const [q, setQ] = useState('')
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState({ name: '', phone: '', email: '', table: '', category: 'Regular' })

  const st = eventStats(guests)
  const tables = useMemo(() => tableSuggestions(event, guests), [event, guests])
  const tablesId = `tables-${event.id}`
  // The event's own questions (R7) that have been written; a removed one's answers are not shown.
  const questions = (event.customFields || []).filter((q) => q.label?.trim())
  const tallied = questions.filter((q) => q.type !== 'text' && q.options.length >= 2)
  const shown = guests.filter((g) => {
    const f = filter === 'all' || (filter === 'off' ? !g.onMasterList : guestStatus(g) === filter)
    const c = category === 'all' || guestCategory(g) === category
    const needle = q.trim().toLowerCase()
    return f && c && (!needle || g.name.toLowerCase().includes(needle) || g.phone.includes(needle)
      || g.email.toLowerCase().includes(needle) || guestCategory(g).toLowerCase().includes(needle))
  })

  const onCsv = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const rows = parseGuestCsv(await file.text())
    if (rows.length === 0) {
      pushToast({ title: t('No guests found in that file'), body: t('Check it has name and phone columns, separated by commas or semicolons.'), kind: 'redflag' })
      return
    }
    const added = await addGuests(event.id, rows)
    pushToast({
      title: `${added} ${t('guests added')}`,
      body: rows.length - added ? `${rows.length - added} ${t('skipped — already on the list or missing a phone number')}` : t('From the client’s CSV'),
      kind: 'project',
    })
  }

  const saveGuest = async () => {
    const added = await addGuests(event.id, [draft])
    if (added) {
      setDraft({ name: '', phone: '', email: '', table: '', category: 'Regular' })
      setAdding(false)
    } else {
      pushToast({ title: t('Not added'), body: t('Name and a valid phone number are needed, and the phone must not already be on the list.'), kind: 'redflag' })
    }
  }

  const copyLink = async (g) => {
    const url = personalLink(eventLink, g)
    try {
      await navigator.clipboard.writeText(url)
      pushToast({ title: t('Personal link copied'), body: `${g.name} — ${t('opens their own reply and QR code')}`, kind: 'project' })
    } catch {
      pushToast({ title: t('Copy failed'), body: url, kind: 'redflag' })
    }
  }

  const exportList = () => exportCSV(`${event.id}-guests`, [
    { key: 'name', label: 'Name' }, { key: 'category', label: 'Category' }, { key: 'phone', label: 'Phone' }, { key: 'email', label: 'Email' },
    { key: 'status', label: 'RSVP' }, { key: 'pax', label: 'Pax' }, { key: 'allergies', label: 'Allergies' },
    { key: 'table', label: 'Table' }, { key: 'list', label: 'On client list' }, { key: 'consent', label: 'Marketing consent' },
    ...questions.map((q) => ({ key: `q:${q.id}`, label: q.label.trim() })),
    { key: 'link', label: 'Personal link' },
  ], guests.map((g) => ({
    ...g, category: guestCategory(g), status: guestStatus(g), list: g.onMasterList ? 'Yes' : 'No', consent: g.consent ? 'Yes' : 'No', link: personalLink(eventLink, g),
    ...Object.fromEntries(questions.map((q) => [`q:${q.id}`, answerText(g.answers?.[q.id])])),
  })), { title: event.name })

  return (
    <div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6 mb-5">
        <StatCard label="Invited" value={st.invited} />
        <StatCard label="Attending" value={st.attending} />
        <StatCard label="Declined" value={st.declined} />
        <StatCard label="No response" value={st.noResponse} />
        <StatCard label="Total pax" value={st.pax} />
        <StatCard label="With allergies" value={st.allergies} />
      </div>

      {tallied.length > 0 && (
        <div className="mb-5 rounded-xl border border-white/10 bg-white/[0.02] p-4">
          <div className="eyebrow mb-2">{t('Answers from guests attending')}</div>
          <div className="space-y-1.5 text-sm">
            {tallied.map((q) => {
              const { counts, none } = answerCounts(q, guests)
              return (
                <div key={q.id} className="flex flex-wrap gap-x-3 gap-y-0.5">
                  <span className="text-white/55">{q.label}</span>
                  {Object.entries(counts).map(([o, n]) => <span key={o} className="text-white/85">{o} <span className="tabular-nums text-gold-light">{n}</span></span>)}
                  {none > 0 && <span className="text-white/40">{t('No answer')} <span className="tabular-nums">{none}</span></span>}
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {FILTERS.map(([key, label]) => (
          <FilterPill key={key} active={filter === key} onClick={() => setFilter(key)}>{t(label)}</FilterPill>
        ))}
        <div className="relative ml-auto">
          <Search size={14} className="absolute left-2.5 top-2.5 text-white/30" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Name, phone or email')}
            className="rounded-lg border border-white/10 bg-navy-900 py-1.5 pl-8 pr-3 text-sm text-white/85 outline-none focus:border-gold/50" />
        </div>
        <button className="btn-ghost !py-1.5" onClick={() => setAdding((v) => !v)}><Plus size={14} />{t('Add guest')}</button>
        <label className="btn-ghost !py-1.5 cursor-pointer">
          <Upload size={14} />{t('Import CSV')}
          <input type="file" accept=".csv,text/csv" onChange={onCsv} className="hidden" />
        </label>
        <button className="btn-ghost !py-1.5" onClick={exportList}><Download size={14} />{t('Export')}</button>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-[11px] uppercase tracking-wider text-white/35">{t('Category')}</span>
        {['all', ...GUEST_CATEGORIES].map((c) => (
          <FilterPill key={c} active={category === c} onClick={() => setCategory(c)}>
            {c === 'all' ? t('All') : `${t(c)} · ${guests.filter((g) => guestCategory(g) === c).length}`}
          </FilterPill>
        ))}
      </div>
      <p className="mb-3 text-[11px] text-white/35">{t('CSV columns: name, phone, email, table, category (header row optional). Phones already on the list are skipped.')}</p>

      {adding && (
        <div className="mb-3 grid gap-2 rounded-lg border border-white/10 p-3 sm:grid-cols-[1fr_1fr_1fr_120px_120px_auto]">
          {[['name', 'Full name'], ['phone', 'Phone'], ['email', 'Email']].map(([k, label]) => (
            <input key={k} value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} placeholder={t(label)}
              className="rounded-lg border border-white/10 bg-navy-950 px-2.5 py-2 text-sm text-white/85 outline-none focus:border-gold/50" />
          ))}
          <input value={draft.table} onChange={(e) => setDraft({ ...draft, table: e.target.value })} placeholder={t('Table')}
            list={tablesId} maxLength={MAX_TABLE_LENGTH} aria-label={t('Table')}
            className="rounded-lg border border-white/10 bg-navy-950 px-2.5 py-2 text-sm text-white/85 outline-none focus:border-gold/50" />
          <select value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} aria-label={t('Category')}
            className="rounded-lg border border-white/10 bg-navy-950 px-2 py-2 text-sm text-white/85">
            {GUEST_CATEGORIES.map((c) => <option key={c} value={c}>{t(c)}</option>)}
          </select>
          <button className="btn-gold" onClick={saveGuest}>{t('Add')}</button>
        </div>
      )}

      <TableSuggestions id={tablesId} tables={tables} />
      <TableWrap>
        <thead>
          <tr>
            <th className="th text-left">{t('Guest')}</th>
            <th className="th text-left">{t('Category')}</th>
            <th className="th text-left">{t('RSVP')}</th>
            <th className="th">{t('Pax')}</th>
            <th className="th text-left">{t('Allergies')}</th>
            {questions.map((q) => <th key={q.id} className="th text-left max-w-[160px] truncate" title={q.label}>{q.label}</th>)}
            <th className="th text-left">{t('Table')}</th>
            <th className="th">{t('Consent')}</th>
            <th className="th text-left">{t('Replied')}</th>
            <th className="th"><span className="sr-only">{t('Personal link')}</span></th>
          </tr>
        </thead>
        <tbody>
          {shown.map((g) => (
            <tr key={g.id} className="border-t border-white/5">
              <td className="td">
                <div className="text-white/85">{g.name}</div>
                <div className="text-[11px] text-white/40">{g.phone}{g.email ? ` · ${g.email}` : ''}</div>
                {g.erasedAt && <div className="text-[10px] text-white/40">{t('Personal data erased')}</div>}
                {!g.onMasterList && !g.walkIn && !g.erasedAt && <div className="text-[10px] text-amber-300/80">{t('Not on the client’s list')}</div>}
                {g.note && (
                  <div className="mt-0.5 flex items-start gap-1 text-[10px] text-sky-200/70" title={t('Internal note — guests never see it')}>
                    <StickyNote size={10} className="mt-px shrink-0" />{g.note}
                  </div>
                )}
              </td>
              <td className="td">
                <select value={guestCategory(g)} onChange={(e) => setGuestCategory(g.id, e.target.value)} aria-label={t('Category')}
                  className={`rounded-md border px-2 py-1 text-xs ${guestCategory(g) === 'VIP' ? 'border-gold/40 bg-gold/10 text-gold-light' : 'border-white/10 bg-navy-900 text-white/80'}`}>
                  {GUEST_CATEGORIES.map((c) => <option key={c} value={c}>{t(c)}</option>)}
                </select>
              </td>
              <td className="td"><Badge>{guestStatus(g)}</Badge></td>
              <td className="td text-center tabular-nums">{g.rsvp === 'Attending' ? g.pax : '—'}</td>
              <td className="td text-xs text-white/60">{g.allergies || '—'}</td>
              {questions.map((q) => {
                const a = answerText(g.answers?.[q.id])
                return <td key={q.id} className="td max-w-[160px] truncate text-xs text-white/60" title={a}>{a || '—'}</td>
              })}
              <td className="td">
                <TableInput value={g.table} onSave={(v) => setGuestTable(g.id, v)} listId={tablesId} aria-label={`${t('Table')} — ${g.name}`}
                  className="w-24 rounded-md border border-white/10 bg-navy-900 px-2 py-1 text-xs text-white/80 outline-none focus:border-gold/50" />
              </td>
              <td className="td text-center">{g.consent ? <span className="text-emerald-300">✓</span> : <span className="text-white/25">—</span>}</td>
              <td className="td text-[11px] text-white/45">{g.respondedAt ? stamp(g.respondedAt) : '—'}</td>
              <td className="td text-center">
                {!g.erasedAt && <button onClick={() => copyLink(g)} className="text-white/40 hover:text-gold-light" title={t('Copy personal link')} aria-label={`${t('Copy personal link')} — ${g.name}`}><Link2 size={14} /></button>}
                {canErase && !g.erasedAt && (
                  <button onClick={() => erase(g)} className="ml-2 text-white/30 hover:text-rose-300" title={t('Erase personal data')} aria-label={`${t('Erase personal data')} — ${g.name}`}><Trash2 size={14} /></button>
                )}
              </td>
            </tr>
          ))}
          {shown.length === 0 && (
            <tr><td colSpan={9 + questions.length} className="td text-center text-sm text-white/35">{t('No guests match.')}</td></tr>
          )}
        </tbody>
      </TableWrap>
    </div>
  )
}
