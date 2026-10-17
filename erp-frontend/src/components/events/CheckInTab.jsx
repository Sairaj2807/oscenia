// The registration desk on the day (BRD §4.4): find a guest by QR or by name/phone, see their
// table, pax and allergies, mark them arrived. Walk-ins scan the desk's QR and register
// themselves (decision 10).
//
// Checkpoints (R1): an event can have several scanning points — Main Entrance, VIP Lounge,
// Goodie Bag… Each device picks the one it stands at; every scan is logged with where and
// when. The desk is warned about a repeat scan or a guest outside a checkpoint's categories,
// and decides — the scan is logged either way.
//
// Prototype: the "camera" is simulated — pick a guest's QR from the tray, or paste a code.
import { useEffect, useMemo, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { ScanLine, Search, UserCheck, Undo2, X, QrCode, MapPin, Download, Plus, Trash2, AlertTriangle, Settings2 } from 'lucide-react'
import { Card, Badge, StatCard, FilterPill, DEMO_TODAY } from '../ui'
import Modal from '../Modal'
import { useProto } from '../../store/chatProto'
import { eventsApi } from '../../lib/eventsApi'
import { useStore } from '../../store/useStore'
import {
  guestStatus, parseQr, qrPayload, normPhone, guestCategory, eventCheckpoints, checkpointAdmits, GUEST_CATEGORIES, answerText,
  tableSuggestions,
} from '../../lib/events'
import TableInput, { TableSuggestions } from './TableInput'
import { exportCSV } from '../../lib/exports'
import { stamp, shortDate } from '../workspace/parts'
import { useT } from '../../i18n'

// Which checkpoint this device scans at, per event: a desk tablet stays at its post.
const cpKey = (eventId) => `oscenia.checkpoint.${eventId}`
const loadCp = (eventId) => { try { return localStorage.getItem(cpKey(eventId)) } catch { return null } }
const saveCp = (eventId, id) => { try { localStorage.setItem(cpKey(eventId), id) } catch { /* not remembered */ } }

const byTime = (a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)

export default function CheckInTab({ event }) {
  const t = useT()
  const all = useProto((s) => s.guests)
  const guests = useMemo(() => all.filter((g) => g.eventId === event.id), [all, event.id])
  const allScans = useProto((s) => s.scans)
  const scans = useMemo(() => allScans.filter((x) => x.eventId === event.id).sort(byTime), [allScans, event.id])
  const pushToast = useStore((s) => s.pushToast)
  const { scanGuest, undoCheckIn, setGuestTable } = useProto.getState()
  const tables = useMemo(() => tableSuggestions(event, guests), [event, guests])
  const [q, setQ] = useState('')
  const [selectedId, setSelectedId] = useState(null)
  const [scanning, setScanning] = useState(false)
  const [managing, setManaging] = useState(false)
  const [walkingIn, setWalkingIn] = useState(null) // the walk-in form: null (closed) or its starting text
  const selected = guests.find((g) => g.id === selectedId)

  const checkpoints = eventCheckpoints(event)
  const [cpId, setCpId] = useState(() => loadCp(event.id))
  const cp = checkpoints.find((c) => c.id === cpId) || checkpoints[0]
  const pickCp = (id) => { setCpId(id); saveCp(event.id, id) }
  const cpName = (id) => checkpoints.find((c) => c.id === id)?.name || id

  // The walk-in QR carries a full URL; the origin only exists in the browser.
  // Signed in, the QR carries the venue's signed desk link (?w=): the server refuses the form without it.
  const [desk, setDesk] = useState('')
  const live = useProto((s) => s.live)
  useEffect(() => {
    if (!live || !event.uuid) return undefined
    let off = false
    eventsApi.walkinLink(event.uuid).then((l) => { if (!off) setDesk(l.token) }, () => { if (!off) setDesk('') })
    return () => { off = true }
  }, [live, event.uuid])
  const walkinPath = `${import.meta.env.BASE_URL}walkin/${event.id}${desk ? `?w=${encodeURIComponent(desk)}` : ''}`
  const [walkinUrl, setWalkinUrl] = useState(walkinPath)
  useEffect(() => { setWalkinUrl(`${window.location.origin}${walkinPath}`) }, [walkinPath])

  const expected = guests.filter((g) => g.rsvp === 'Attending')
  const arrived = guests.filter((g) => g.checkedInAt)
  const hereCount = new Set(scans.filter((x) => x.checkpointId === cp.id).map((x) => x.guestId)).size
  const needle = q.trim().toLowerCase()
  const digits = normPhone(q)
  const results = needle.length < 2 ? [] : guests.filter((g) =>
    g.name.toLowerCase().includes(needle) || (digits.length >= 4 && normPhone(g.phone).includes(digits))
  ).slice(0, 8)

  const onScan = (text) => {
    const byServerCode = guests.find((g) => g.qr && g.qr === text.trim())
    const code = byServerCode ? { eventId: event.id, guestId: byServerCode.id } : parseQr(text)
    const guest = code && code.eventId === event.id && guests.find((g) => g.id === code.guestId)
    setScanning(false)
    if (!guest) {
      pushToast({ title: t('QR not recognised'), body: code ? t('This code is for a different event.') : t('That is not an Oscenia guest code.'), kind: 'redflag' })
      return
    }
    setSelectedId(guest.id)
  }

  const logScan = async (g) => {
    const first = !g.checkedInAt
    if (!(await scanGuest(g.id, cp.id))) return
    pushToast({
      title: `${g.name} · ${cp.name}`,
      body: first ? `${t('Arrived')} · ${t('Table')} ${g.table || '—'} · ${g.pax || 1} pax` : t('Scan logged'),
      kind: 'project',
    })
  }

  // What the desk needs to know about the selected guest at this checkpoint.
  const mine = selected ? scans.filter((x) => x.guestId === selected.id) : []
  const hereBefore = [...mine].reverse().find((x) => x.checkpointId === cp.id)
  const admitted = selected ? checkpointAdmits(cp, selected) : true
  const canUndo = mine.length > (selected?.walkIn ? 1 : 0) || (selected?.checkedInAt && mine.length === 0 && !selected.walkIn)

  return (
    <div>
      {event.date !== DEMO_TODAY && (
        <p className="mb-4 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-xs text-white/50">
          {t('Event day is')} {shortDate(event.date)} {event.date.slice(0, 4)}. {t('The desk is open now so it can be demonstrated.')}
        </p>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-gold/30 bg-gold/5 px-3 py-2">
        <MapPin size={16} className="text-gold/80 shrink-0" />
        <span className="text-sm text-white/60">{t('Scanning at')}</span>
        <select value={cp.id} onChange={(e) => pickCp(e.target.value)} aria-label={t('Checkpoint')}
          className="min-w-0 rounded-md border border-white/10 bg-navy-900 px-2 py-1 text-sm text-white/90 outline-none focus:border-gold/50">
          {checkpoints.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {cp.categories?.length > 0 && <span className="text-xs text-gold-light/80">{cp.categories.map((c) => t(c)).join(', ')} {t('only')}</span>}
        <button className="btn-ghost ml-auto !py-1 text-xs" onClick={() => setManaging((v) => !v)}><Settings2 size={13} />{t('Checkpoints')}</button>
      </div>

      {managing && <CheckpointManager event={event} checkpoints={checkpoints} scans={scans} />}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5 mb-5">
        <StatCard label="Arrived" value={arrived.length} />
        <StatCard label="Expected (RSVP yes)" value={expected.length} />
        <StatCard label="People arrived" value={arrived.reduce((n, g) => n + (g.pax || 1), 0)} />
        <StatCard label="Walk-ins" value={guests.filter((g) => g.walkIn).length} />
        <StatCard label={`${t('Scanned at')} ${cp.name}`} value={hereCount} />
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4 min-w-0">
          <Card>
            <div className="flex flex-wrap gap-2">
              <button className="btn-gold" onClick={() => setScanning(true)}><ScanLine size={16} />{t('Scan QR')}</button>
              <div className="relative flex-1 min-w-[200px]">
                <Search size={15} className="absolute left-3 top-2.5 text-white/30" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Or search by name or phone')}
                  className="w-full rounded-lg border border-white/10 bg-navy-900 py-2 pl-9 pr-3 text-sm text-white/85 outline-none focus:border-gold/50" />
              </div>
            </div>
            {results.length > 0 && (
              <div className="mt-3 space-y-1">
                {results.map((g) => (
                  <button key={g.id} onClick={() => { setSelectedId(g.id); setQ('') }}
                    className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-3 py-2 text-left hover:bg-white/5">
                    <span className="text-sm text-white/85">{g.name}</span>
                    <span className="text-xs text-white/40">{g.phone}</span>
                    <span className="ml-auto flex gap-1.5">
                      {guestCategory(g) !== 'Regular' && <Badge>{guestCategory(g)}</Badge>}
                      {g.checkedInAt && <Badge>Checked in</Badge>}<Badge>{guestStatus(g)}</Badge>
                    </span>
                  </button>
                ))}
              </div>
            )}
            {needle.length >= 2 && results.length === 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-white/40">
                <span>{t('No guest found. A walk-in can register with the walk-in QR.')}</span>
                <button type="button" className="btn-ghost !py-1.5 text-xs" onClick={() => setWalkingIn(q)}><Plus size={14} />{t('Add as a walk-in')}</button>
              </div>
            )}
          </Card>

          {selected ? (
            <Card className={!admitted ? 'border-rose-500/40' : hereBefore ? 'border-amber-500/40' : selected.checkedInAt ? 'border-emerald-500/30' : 'border-gold/40'}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-display text-2xl text-white">{selected.name}</div>
                  <div className="mt-1 flex flex-wrap gap-2">
                    <Badge>{guestCategory(selected)}</Badge>
                    <Badge>{guestStatus(selected)}</Badge>
                    {!selected.onMasterList && !selected.walkIn && <Badge>Not on the list</Badge>}
                  </div>
                </div>
                <button onClick={() => setSelectedId(null)} className="text-white/40 hover:text-white" aria-label={t('Close')}><X size={18} /></button>
              </div>
              <div className="mt-4 grid grid-cols-3 gap-3 text-center">
                <Big label="Table">
                  <TableInput key={selected.id} value={selected.table} onSave={(v) => setGuestTable(selected.id, v)} listId={`checkin-tables-${event.id}`} aria-label={t('Table')}
                    className="w-full max-w-full rounded-md border border-white/10 bg-navy-900 px-2 py-1 text-center text-xl text-gold-light outline-none focus:border-gold/50" />
                  <TableSuggestions id={`checkin-tables-${event.id}`} tables={tables} />
                </Big>
                <Big label="People">{selected.rsvp === 'Attending' ? selected.pax : 1}</Big>
                <Big label="Allergies"><span className="text-sm">{selected.allergies || '—'}</span></Big>
              </div>
              {/* The event's own questions (R7) — e.g. the meal choice, useful at the desk. */}
              {(event.customFields || []).some((q) => q.label?.trim() && answerText(selected.answers?.[q.id])) && (
                <dl className="mt-3 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
                  {(event.customFields || []).filter((q) => q.label?.trim() && answerText(selected.answers?.[q.id])).map((q) => (
                    <div key={q.id} className="flex min-w-0 gap-1.5">
                      <dt className="shrink-0 text-white/40">{q.label}:</dt>
                      <dd className="min-w-0 truncate text-white/80" title={answerText(selected.answers[q.id])}>{answerText(selected.answers[q.id])}</dd>
                    </div>
                  ))}
                </dl>
              )}

              {!admitted && (
                <Warn tone="rose">{cp.name} {t('is for')} {cp.categories.map((c) => t(c)).join(', ')} {t('guests. This guest is')} {t(guestCategory(selected))}.</Warn>
              )}
              {hereBefore && (
                <Warn tone="amber">{t('Already scanned here at')} {stamp(hereBefore.at)}.</Warn>
              )}
              {selected.rsvp === 'Declined' && !selected.checkedInAt && (
                <Warn tone="amber">{t('This guest declined but has arrived — check them in and find a seat.')}</Warn>
              )}

              <div className="mt-5 flex flex-wrap items-center gap-3">
                <button className={`${hereBefore || !admitted ? 'btn-ghost' : 'btn-gold'} flex-1 justify-center !py-3 text-base`} onClick={() => logScan(selected)}>
                  <UserCheck size={18} />
                  {hereBefore ? `${t('Log again at')} ${cp.name}` : !admitted ? `${t('Let in anyway')} · ${cp.name}` : `${t('Check in at')} ${cp.name}`}
                </button>
                {canUndo && (
                  <button className="btn-ghost !py-1.5 text-xs" onClick={() => undoCheckIn(selected.id)}><Undo2 size={13} />{t('Undo last scan')}</button>
                )}
              </div>

              {selected.checkedInAt && (
                <div className="mt-4 border-t border-white/5 pt-3">
                  <div className="text-[10px] uppercase tracking-wider text-white/35 mb-1.5">{t('Scans')}</div>
                  <div className="space-y-1 text-xs">
                    {/* The first scan is the arrival; a record from before checkpoints has none. */}
                    {mine.length === 0 && <div className="flex gap-2 text-emerald-300"><UserCheck size={13} />{t('Arrived')} {stamp(selected.checkedInAt)}</div>}
                    {mine.map((x, i) => (
                      <div key={x.id} className={`flex gap-2 ${i === 0 ? 'text-emerald-300' : 'text-white/60'}`}>
                        <MapPin size={12} className="mt-px opacity-60" />{cpName(x.checkpointId)} · {stamp(x.at)}{i === 0 && ` · ${t('arrived')}`}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Card>
          ) : (
            <Card className="text-center text-sm text-white/35 py-10">{t('Scan a guest’s QR code or search to begin.')}</Card>
          )}

          <ScanLog event={event} guests={guests} scans={scans} checkpoints={checkpoints} onOpen={setSelectedId} />
        </div>

        <Card className="h-fit text-center">
          <div className="eyebrow mb-2">{t('Walk-in QR')}</div>
          <p className="text-xs text-white/50 mb-4">{t('Print or show this at the desk. Walk-ins scan it, fill a short form and are checked in — and added to the CRM if they agree.')}</p>
          <div className="mx-auto inline-block rounded-xl bg-white p-3"><QRCodeSVG value={walkinUrl} size={180} /></div>
          <a href={walkinPath} target="_blank" rel="noreferrer" className="mt-3 block text-xs text-gold/80 hover:text-gold-light">{t('Open the walk-in form')} →</a>
          <button type="button" className="btn-ghost mt-3 !py-1.5 text-xs" onClick={() => setWalkingIn('')}><Plus size={14} />{t('Register a walk-in here')}</button>
        </Card>
      </div>

      {scanning && <ScanModal guests={guests} scans={scans} checkpoint={cp} onScan={onScan} onClose={() => setScanning(false)} />}
      {walkingIn !== null && (
        <WalkInModal event={event} start={walkingIn} onClose={() => setWalkingIn(null)}
          onDone={(id) => { setWalkingIn(null); setQ(''); setSelectedId(id) }} />
      )}
    </div>
  )
}

/** The desk registers someone who arrived without an invitation. A person already on the list is
 *  found by phone and simply checked in; consent for news and offers is only ever ticked by them. */
function WalkInModal({ event, start, onClose, onDone }) {
  const t = useT()
  const register = useProto((s) => s.registerWalkIn)
  const pushToast = useStore((s) => s.pushToast)
  const digits = /^[+\d\s()-]+$/.test(start.trim())
  const [form, setForm] = useState({ name: digits ? '' : start.trim(), phone: digits ? start.trim() : '', email: '', consent: false })
  const [busy, setBusy] = useState(false)
  const set = (patch) => setForm((f) => ({ ...f, ...patch }))
  const ready = form.name.trim().length > 0 && normPhone(form.phone).length >= 8
  const submit = async (e) => {
    e.preventDefault()
    if (!ready || busy) return
    setBusy(true)
    const out = await register(event.id, form)
    setBusy(false)
    if (!out) {
      // The live store has already said why; the offline demo only says no.
      if (!useProto.getState().live) pushToast({ title: 'Could not register the walk-in', body: 'The event must be published, with a name and a phone number.', kind: 'redflag' })
      return
    }
    pushToast({ title: out.walkIn ? 'Walk-in registered' : 'Already on the list', body: out.walkIn ? `${form.name.trim()} is checked in.` : `${form.name.trim()} was found by phone and checked in.`, kind: 'project' })
    onDone(out.id)
  }
  return (
    <Modal title="Register a walk-in" subtitle="For someone at the desk who has no invitation" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <label className="block"><span className="text-[11px] text-white/45">{t('Full name')}</span>
          <input className="mt-1 w-full rounded-lg border border-white/10 bg-navy-950 px-2.5 py-2 text-sm text-white/85 outline-none focus:border-gold/50" value={form.name} onChange={(e) => set({ name: e.target.value })} autoFocus /></label>
        <label className="block"><span className="text-[11px] text-white/45">{t('Phone number (WhatsApp)')}</span>
          <input className="mt-1 w-full rounded-lg border border-white/10 bg-navy-950 px-2.5 py-2 text-sm text-white/85 outline-none focus:border-gold/50" value={form.phone} onChange={(e) => set({ phone: e.target.value })} inputMode="tel" /></label>
        <label className="block"><span className="text-[11px] text-white/45">{t('Email (optional)')}</span>
          <input className="mt-1 w-full rounded-lg border border-white/10 bg-navy-950 px-2.5 py-2 text-sm text-white/85 outline-none focus:border-gold/50" value={form.email} onChange={(e) => set({ email: e.target.value })} inputMode="email" /></label>
        <label className="flex items-start gap-2 text-xs text-white/60">
          <input type="checkbox" className="mt-0.5" checked={form.consent} onChange={(e) => set({ consent: e.target.checked })} />
          <span>{t('The guest agrees to keep their contact details for news and offers. Leave unticked if they did not say so.')}</span>
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn-ghost text-xs" onClick={onClose}>{t('Cancel')}</button>
          <button type="submit" className="btn-gold text-xs" disabled={!ready || busy}>{t('Register and check in')}</button>
        </div>
      </form>
    </Modal>
  )
}

function Warn({ tone, children }) {
  const cls = tone === 'rose' ? 'border-rose-500/30 bg-rose-500/10 text-rose-200' : 'border-amber-500/30 bg-amber-500/10 text-amber-200'
  return <div className={`mt-3 flex gap-2 rounded-lg border px-3 py-2 text-xs ${cls}`}><AlertTriangle size={14} className="shrink-0 mt-px" /><span>{children}</span></div>
}

function Big({ label, children }) {
  const t = useT()
  return (
    <div className="min-w-0 rounded-lg bg-white/[0.03] p-3">
      <div className="text-[10px] uppercase tracking-wider text-white/35">{t(label)}</div>
      <div className="mt-1 font-display text-2xl text-white">{children}</div>
    </div>
  )
}

/** Every scan at the event: where, when, who. Filter by checkpoint; export the lot. */
function ScanLog({ event, guests, scans, checkpoints, onOpen }) {
  const t = useT()
  const [only, setOnly] = useState('all')
  const guest = (id) => guests.find((g) => g.id === id)
  const cpName = (id) => checkpoints.find((c) => c.id === id)?.name || id
  const shown = [...scans].filter((x) => only === 'all' || x.checkpointId === only).reverse()
  const unique = (id) => new Set(scans.filter((x) => x.checkpointId === id).map((x) => x.guestId)).size

  const exportLog = () => exportCSV(`${event.id}-scans`, [
    { key: 'at', label: 'Time' }, { key: 'checkpoint', label: 'Checkpoint' }, { key: 'name', label: 'Guest' },
    { key: 'category', label: 'Category' }, { key: 'phone', label: 'Phone' }, { key: 'table', label: 'Table' },
  ], scans.map((x) => {
    const g = guest(x.guestId)
    return { at: x.at, checkpoint: cpName(x.checkpointId), name: g?.name || x.guestId, category: guestCategory(g), phone: g?.phone || '', table: g?.table || '' }
  }), { title: `${event.name} — scan log` })

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="eyebrow">{t('Scan log')}</div>
        <button className="btn-ghost ml-auto !py-1 text-xs" disabled={!scans.length} onClick={exportLog}><Download size={13} />{t('Export')}</button>
      </div>
      <div className="mb-3 flex flex-wrap gap-2">
        <FilterPill active={only === 'all'} onClick={() => setOnly('all')}>{t('All')} · {scans.length}</FilterPill>
        {checkpoints.map((c) => (
          <FilterPill key={c.id} active={only === c.id} onClick={() => setOnly(c.id)}>{c.name} · {unique(c.id)}</FilterPill>
        ))}
      </div>
      <div className="space-y-1">
        {shown.slice(0, 12).map((x) => {
          const g = guest(x.guestId)
          return (
            <button key={x.id} onClick={() => onOpen(x.guestId)} className="flex w-full flex-wrap items-center gap-x-3 gap-y-0.5 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-white/5">
              <span className="w-24 shrink-0 text-xs tabular-nums text-white/45">{stamp(x.at)}</span>
              <span className="text-white/80">{g?.name || x.guestId}</span>
              {guestCategory(g) !== 'Regular' && <Badge>{guestCategory(g)}</Badge>}
              {g?.walkIn && <Badge>Walk-in</Badge>}
              <span className="ml-auto text-xs text-white/45">{cpName(x.checkpointId)}</span>
            </button>
          )
        })}
        {shown.length > 12 && <div className="px-2 pt-1 text-[11px] text-white/35">{shown.length - 12} {t('more — export for the full log')}</div>}
        {shown.length === 0 && <div className="text-sm text-white/35">{t('No scans yet.')}</div>}
      </div>
    </Card>
  )
}

/** Add, rename and restrict checkpoints. One with scans stays (its log would lose its place). */
function CheckpointManager({ event, checkpoints, scans }) {
  const t = useT()
  const pushToast = useStore((s) => s.pushToast)
  const { addCheckpoint, updateCheckpoint, removeCheckpoint } = useProto.getState()
  const [name, setName] = useState('')
  const add = async () => {
    if (await addCheckpoint(event.id, name)) setName('')
    else pushToast({ title: t('Not added'), body: t('Give it a name that is not already used.'), kind: 'redflag' })
  }
  return (
    <Card className="mb-5">
      <div className="eyebrow mb-1">{t('Checkpoints')}</div>
      <p className="mb-3 text-[11px] text-white/40">{t('Each scanning point at the venue. Tick categories to restrict one (e.g. VIP Lounge → VIP); none ticked means everyone.')}</p>
      <div className="space-y-2">
        {checkpoints.map((c) => {
          const used = scans.some((x) => x.checkpointId === c.id)
          const toggle = (cat) => updateCheckpoint(event.id, c.id, {
            categories: c.categories?.includes(cat) ? c.categories.filter((x) => x !== cat) : [...(c.categories || []), cat],
          })
          return (
            <div key={c.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-white/10 p-2">
              <input defaultValue={c.name} key={c.name} aria-label={t('Checkpoint name')}
                onBlur={(e) => { if (e.target.value.trim() && e.target.value.trim() !== c.name) updateCheckpoint(event.id, c.id, { name: e.target.value }) }}
                className="min-w-0 flex-1 rounded-md border border-white/10 bg-navy-950 px-2 py-1 text-sm text-white/85 outline-none focus:border-gold/50" />
              <div className="flex flex-wrap gap-1">
                {GUEST_CATEGORIES.map((cat) => (
                  <FilterPill key={cat} active={c.categories?.includes(cat)} onClick={() => toggle(cat)}>{t(cat)}</FilterPill>
                ))}
              </div>
              <button
                className="text-white/35 hover:text-rose-300 disabled:opacity-30 disabled:hover:text-white/35"
                disabled={used || checkpoints.length <= 1}
                title={used ? t('Has scans — rename it instead') : checkpoints.length <= 1 ? t('An event needs one checkpoint') : t('Remove')}
                aria-label={`${t('Remove')} ${c.name}`}
                onClick={() => removeCheckpoint(event.id, c.id)}
              ><Trash2 size={15} /></button>
            </div>
          )
        })}
      </div>
      <div className="mt-3 flex gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder={t('e.g. Goodie Bag')}
          className="min-w-0 flex-1 rounded-md border border-white/10 bg-navy-950 px-2 py-1.5 text-sm text-white/85 outline-none focus:border-gold/50" />
        <button className="btn-ghost !py-1.5 text-xs" disabled={!name.trim()} onClick={add}><Plus size={13} />{t('Add checkpoint')}</button>
      </div>
    </Card>
  )
}

/** Simulated camera: tap a guest's QR from the tray, or paste the text a scanner read. */
function ScanModal({ guests, scans, checkpoint, onScan, onClose }) {
  const t = useT()
  const [text, setText] = useState('')
  // Whoever is likely to walk up next: attending guests not yet scanned at this checkpoint.
  const done = new Set(scans.filter((x) => x.checkpointId === checkpoint.id).map((x) => x.guestId))
  const tray = guests.filter((g) => g.rsvp === 'Attending' && !done.has(g.id)).slice(0, 6)
  return (
    <Modal title="Scan QR" subtitle={`${checkpoint.name} · ${t('Prototype: the camera is simulated. Tap a guest’s code as if they held it up.')}`} onClose={onClose} size="xl">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {tray.map((g) => (
          <button key={g.id} onClick={() => onScan(qrPayload(g))} className="rounded-lg border border-white/10 p-3 hover:border-gold/50">
            <div className="mx-auto inline-block rounded bg-white p-1.5"><QRCodeSVG value={qrPayload(g)} size={84} /></div>
            <div className="mt-2 truncate text-xs text-white/70">{g.name}</div>
          </button>
        ))}
        {tray.length === 0 && <div className="col-span-full text-sm text-white/40">{t('Everyone who RSVP’d has been scanned here.')}</div>}
      </div>
      <div className="flex gap-2 pt-2">
        <div className="relative flex-1">
          <QrCode size={15} className="absolute left-3 top-2.5 text-white/30" />
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="OSCENIA:EV-01:G-003"
            className="w-full rounded-lg border border-white/10 bg-navy-900 py-2 pl-9 pr-3 font-mono text-sm text-white/85 outline-none focus:border-gold/50" />
        </div>
        <button className="btn-ghost" disabled={!text.trim()} onClick={() => onScan(text)}>{t('Use code')}</button>
      </div>
    </Modal>
  )
}
