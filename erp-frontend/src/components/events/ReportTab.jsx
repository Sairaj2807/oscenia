// After the event (BRD §4.5): who RSVP'd and came, who RSVP'd and did not, who came without
// an RSVP, and who neither replied nor came. Each cell opens its list; all export to CSV.
// Staff can keep an internal note on any guest (R5), e.g. why someone who said yes did not come.
import { useEffect, useMemo, useState } from 'react'
import { Download } from 'lucide-react'
import { Badge, TableWrap, DEMO_TODAY } from '../ui'
import { useProto } from '../../store/chatProto'
import { useAuth } from '../../store/useAuth'
import { reconcile, guestStatus, guestCategory, eventCheckpoints } from '../../lib/events'
import { exportCSV } from '../../lib/exports'
import { stamp } from '../workspace/parts'
import { useT } from '../../i18n'

const CELLS = [
  { key: 'rsvpCame', title: 'RSVP’d and came', tone: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200' },
  { key: 'rsvpNoShow', title: 'RSVP’d, did not come', tone: 'border-rose-500/30 bg-rose-500/10 text-rose-200' },
  { key: 'noRsvpCame', title: 'Came without an RSVP', tone: 'border-sky-500/30 bg-sky-500/10 text-sky-200' },
  { key: 'noRsvpNoShow', title: 'No RSVP, did not come', tone: 'border-white/15 bg-white/[0.03] text-white/70' },
]

export default function ReportTab({ event }) {
  const t = useT()
  const all = useProto((s) => s.guests)
  const guests = useMemo(() => all.filter((g) => g.eventId === event.id), [all, event.id])
  const allScans = useProto((s) => s.scans)
  const grid = reconcile(guests)
  const cpName = Object.fromEntries(eventCheckpoints(event).map((c) => [c.id, c.name]))
  const visited = (g) => [...new Set(allScans.filter((x) => x.guestId === g.id).map((x) => cpName[x.checkpointId] || x.checkpointId))].join(', ')
  const [open, setOpen] = useState('rsvpNoShow')
  const cell = CELLS.find((c) => c.key === open)
  const rows = grid[open]

  const exportAll = () => exportCSV(`${event.id}-attendance`, [
    { key: 'name', label: 'Name' }, { key: 'phone', label: 'Phone' }, { key: 'email', label: 'Email' },
    { key: 'rsvp', label: 'RSVP' }, { key: 'came', label: 'Attended' }, { key: 'bucket', label: 'Group' },
    { key: 'checkedIn', label: 'Checked in at' }, { key: 'visited', label: 'Checkpoints visited' }, { key: 'table', label: 'Table' },
    { key: 'category', label: 'Category' }, { key: 'note', label: 'Internal note' },
  ], CELLS.flatMap((c) => grid[c.key].map((g) => ({
    ...g, rsvp: guestStatus(g), came: g.checkedInAt ? 'Yes' : 'No', bucket: c.title.replace('’', "'"), checkedIn: g.checkedInAt || '',
    visited: visited(g), category: guestCategory(g), note: g.note || '',
  }))), { title: `${event.name} — attendance` })

  const came = grid.rsvpCame.length + grid.noRsvpCame.length
  const yes = grid.rsvpCame.length + grid.rsvpNoShow.length

  return (
    <div>
      {event.date > DEMO_TODAY && (
        <p className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          {t('This event has not happened yet, so nobody has arrived — the “did not come” boxes fill up until check-in on the day. The Meridian launch shows a finished event.')}
        </p>
      )}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <p className="text-sm text-white/60">
          {came} {t('attended')} · {yes ? Math.round((grid.rsvpCame.length / yes) * 100) : 0}% {t('of those who RSVP’d came')}
        </p>
        <button className="btn-ghost ml-auto !py-1.5" onClick={exportAll}><Download size={14} />{t('Export all')}</button>
      </div>

      <div className="grid gap-3 sm:grid-cols-[auto_1fr_1fr] items-stretch mb-6">
        <div />
        <div className="text-center text-[11px] uppercase tracking-wider text-white/40">{t('Came')}</div>
        <div className="text-center text-[11px] uppercase tracking-wider text-white/40">{t('Did not come')}</div>
        {[['RSVP’d yes', 'rsvpCame', 'rsvpNoShow'], ['No RSVP / declined', 'noRsvpCame', 'noRsvpNoShow']].map(([label, a, b]) => (
          <div key={label} className="contents">
            <div className="flex items-center text-[11px] uppercase tracking-wider text-white/40 sm:pr-2">{t(label)}</div>
            {[a, b].map((k) => {
              const c = CELLS.find((x) => x.key === k)
              return (
                <button key={k} onClick={() => setOpen(k)}
                  className={`rounded-xl border p-5 text-left transition ${c.tone} ${open === k ? 'ring-2 ring-gold/60' : 'hover:brightness-125'}`}>
                  <div className="font-display text-4xl tabular-nums">{grid[k].length}</div>
                  <div className="mt-1 text-sm">{t(c.title)}</div>
                </button>
              )
            })}
          </div>
        ))}
      </div>

      <div className="eyebrow mb-2">{t(cell.title)} · {rows.length}</div>
      {open === 'rsvpNoShow' && rows.length > 0 && (
        <p className="mb-2 text-xs text-white/45">{t('Note why each guest did not come — a call, a reason, a follow-up. Notes are internal; guests never see them.')}</p>
      )}
      <TableWrap>
        <thead>
          <tr>
            <th className="th text-left">{t('Guest')}</th>
            <th className="th text-left">{t('RSVP')}</th>
            <th className="th text-left">{t('Checked in')}</th>
            <th className="th text-left">{t('Table')}</th>
            <th className="th text-left min-w-[220px]">{t('Internal note')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((g) => (
            <tr key={g.id} className="border-t border-white/5">
              <td className="td">
                <div className="text-white/85">{g.name}{guestCategory(g) !== 'Regular' && <span className="ml-2"><Badge>{guestCategory(g)}</Badge></span>}</div>
                <div className="text-[11px] text-white/40">{g.phone}</div>
              </td>
              <td className="td"><Badge>{guestStatus(g)}</Badge></td>
              <td className="td text-xs text-white/55">{g.checkedInAt ? stamp(g.checkedInAt) : '—'}</td>
              <td className="td text-xs text-white/55">{g.table || '—'}</td>
              <td className="td"><NoteCell guest={g} /></td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={5} className="td text-center text-sm text-white/35">{t('Nobody in this group.')}</td></tr>}
        </tbody>
      </TableWrap>
    </div>
  )
}

/** Saves when the field loses focus; shows who wrote the note and when. */
function NoteCell({ guest }) {
  const t = useT()
  const author = useAuth((s) => s.user?.name)
  const [text, setText] = useState(guest.note || '')
  // Another tab (or a reset) may change the note underneath.
  useEffect(() => { setText(guest.note || '') }, [guest.note])
  return (
    <div>
      <textarea
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => useProto.getState().setGuestNote(guest.id, text, author)}
        placeholder={t('Add a note…')}
        aria-label={`${t('Internal note')} — ${guest.name}`}
        className="w-full resize-y rounded-md border border-white/10 bg-navy-950 px-2 py-1 text-xs text-white/80 outline-none focus:border-gold/50"
      />
      {guest.note && guest.noteAt && <div className="mt-0.5 text-[10px] text-white/35">{guest.noteBy} · {stamp(guest.noteAt)}</div>}
    </div>
  )
}
