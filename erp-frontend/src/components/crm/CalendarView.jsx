// The CRM calendar tab (C2): the relationship list as before, or a month view that puts the
// CRM's dates — event-cycle nudges, PIC birthdays, company anniversaries, events — beside the
// sales team's Google Calendar. The month view and the Google card are also the page of their
// own under CRM & Clients (pages/GoogleCalendar.jsx, client round 3).
//
// Prototype: the Google connection is simulated. Nothing leaves the browser; the backend will
// use Google sign-in (OAuth) to read and, if allowed, write the calendar.
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronLeft, ChevronRight, CalendarDays, List, Link2, Unlink, ArrowRight } from 'lucide-react'
import { Card, FilterPill, Field, TextInput, DEMO_TODAY } from '../ui'
import Modal from '../Modal'
import { useProto } from '../../store/useProto'
import { useStore } from '../../store/useStore'
import { useGoogle } from '../../store/useGoogle'
import { relationshipCalendar, calendarMonth, isEmail, monthName } from '../../lib/crm'
import { canSee } from '../../lib/roles'
import { shortDate, stamp } from '../workspace/parts'
import RelationshipCalendar from './RelationshipCalendar'
import { useT } from '../../i18n'

// One colour per source, used for chips, dots and the legend.
const KINDS = {
  'Event nudge': 'bg-gold/20 text-gold-light border-gold/30',
  Birthday: 'bg-rose-500/15 text-rose-200 border-rose-500/30',
  'Company anniversary': 'bg-sky-500/15 text-sky-200 border-sky-500/30',
  Event: 'bg-emerald-500/15 text-emerald-200 border-emerald-500/30',
  Google: 'bg-blue-500/20 text-blue-200 border-blue-400/40',
}
const DOT = {
  'Event nudge': 'bg-gold', Birthday: 'bg-rose-400', 'Company anniversary': 'bg-sky-400', Event: 'bg-emerald-400', Google: 'bg-blue-400',
}
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export default function CalendarTab() {
  const t = useT()
  const role = useStore((s) => s.role)
  const [view, setView] = useState('list')
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <FilterPill active={view === 'list'} onClick={() => setView('list')}><List size={12} className="inline -mt-0.5 mr-1" />{t('List')}</FilterPill>
        <FilterPill active={view === 'month'} onClick={() => setView('month')}><CalendarDays size={12} className="inline -mt-0.5 mr-1" />{t('Month')}</FilterPill>
        {canSee(role, 'gcal') && (
          <Link to="/google-calendar" className="ml-auto inline-flex items-center gap-1 text-xs text-gold/80 hover:text-gold-light">
            {t('Open Google Calendar')}<ArrowRight size={12} />
          </Link>
        )}
      </div>
      {view === 'list' ? <RelationshipCalendar /> : <MonthView />}
    </div>
  )
}

/**
 * Everything the month view shows for one month, as { date, kind, title, sub, to }. Birthdays,
 * anniversaries and nudges are worked out from the 1st of that month — so a month earlier
 * this year or several years ahead is as full as the next one. `upcoming` counts the CRM dates
 * from today on, for the "add to Google" option.
 */
function useCalendarItems(year, month) {
  const clients = useStore((s) => s.clients)
  const relations = useProto((s) => s.relations)
  const events = useProto((s) => s.events)
  const live = useStore((s) => s.hydrated)
  const demoGoogle = useProto((s) => s.googleCalendar)
  const demoEvents = useProto((s) => s.googleEvents)
  const liveStatus = useGoogle((s) => s.status)
  const liveEvents = useGoogle((s) => s.events)
  const liveFor = useGoogle((s) => s.eventsFor)
  // Signed in: the person's own events from the server (only once they are for this month).
  const google = live ? liveStatus : demoGoogle
  const googleEvents = live ? (liveFor === `${year}-${String(month).padStart(2, '0')}` ? liveEvents : []) : demoEvents
  return useMemo(() => {
    const from = `${year}-${String(month).padStart(2, '0')}-01`
    const crm = relationshipCalendar(clients, relations, from, 31).map((i) => ({
      date: i.date, kind: i.kind, title: i.kind === 'Birthday' ? `${i.title} 🎂` : i.title, sub: i.client, to: `/crm/${i.clientId}`,
    }))
    const evs = events.filter((e) => e.date).map((e) => ({ date: e.date, kind: 'Event', title: e.name, sub: e.time, to: `/events/${e.id}` }))
    const g = google?.connected && google.showGoogle
      ? (googleEvents || []).map((e) => ({ date: e.date, kind: 'Google', title: e.title, sub: e.time }))
      : []
    const upcoming = relationshipCalendar(clients, relations, DEMO_TODAY, 365).length + events.filter((e) => e.date >= DEMO_TODAY).length
    return { all: [...crm, ...evs, ...g], upcoming }
  }, [year, month, clients, relations, events, google, googleEvents])
}

/**
 * The month grid, the picked day's list and the Google card. `googleFirst` (the Google Calendar
 * page) puts the card above the grid on narrow screens, so "Connect" is the first thing seen.
 */
export function MonthView({ googleFirst = false }) {
  const t = useT()
  const [ym, setYm] = useState(() => [Number(DEMO_TODAY.slice(0, 4)), Number(DEMO_TODAY.slice(5, 7))])
  const [picked, setPicked] = useState(DEMO_TODAY)
  const { all, upcoming } = useCalendarItems(ym[0], ym[1])
  const live = useStore((s) => s.hydrated)
  const loadStatus = useGoogle((s) => s.loadStatus)
  const loadEvents = useGoogle((s) => s.loadEvents)
  const liveStatus = useGoogle((s) => s.status)
  useEffect(() => { if (live) loadStatus() }, [live, loadStatus])
  useEffect(() => {
    if (live && liveStatus) loadEvents(ym[0], ym[1])
  }, [live, ym, liveStatus?.connected, liveStatus?.showGoogle, loadEvents])
  const weeks = calendarMonth(ym[0], ym[1], all)
  const step = (n) => setYm(([y, m]) => {
    const d = new Date(Date.UTC(y, m - 1 + n, 1))
    return [d.getUTCFullYear(), d.getUTCMonth() + 1]
  })
  const dayItems = all.filter((i) => i.date === picked)

  return (
    <div className="grid gap-5 xl:grid-cols-[1fr_300px]">
      <div className="min-w-0 space-y-4">
        <Card className="!p-3 sm:!p-4">
          <div className="mb-3 flex items-center gap-2">
            <button className="btn-ghost !p-1.5" onClick={() => step(-1)} aria-label={t('Previous month')}><ChevronLeft size={16} /></button>
            <div className="min-w-0 flex-1 text-center font-display text-lg text-white">{t(monthName(ym[1]))} {ym[0]}</div>
            <button className="btn-ghost !p-1.5" onClick={() => step(1)} aria-label={t('Next month')}><ChevronRight size={16} /></button>
          </div>
          <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-white/10 bg-white/10 text-xs">
            {WEEKDAYS.map((d) => <div key={d} className="bg-navy-900 px-1 py-1.5 text-center text-[10px] uppercase tracking-wider text-white/40">{t(d)}</div>)}
            {weeks.flat().map((c) => (
              <button
                key={c.date}
                onClick={() => c.inMonth && setPicked(c.date)}
                disabled={!c.inMonth}
                aria-label={`${c.date}${c.items.length ? ` · ${c.items.length}` : ''}`}
                className={`min-h-[52px] bg-navy-950 p-1 text-left align-top sm:min-h-[92px] ${c.inMonth ? 'hover:bg-white/[0.04]' : 'opacity-30'} ${picked === c.date ? 'ring-1 ring-inset ring-gold/60' : ''}`}
              >
                <div className={`mb-1 text-[11px] ${c.date === DEMO_TODAY ? 'inline-grid h-5 w-5 place-items-center rounded-full bg-gold font-medium text-navy-950' : 'text-white/55'}`}>{c.day}</div>
                {/* Phones: dots; wider screens: up to three chips. */}
                <div className="flex flex-wrap gap-0.5 sm:hidden">{c.items.slice(0, 4).map((i, k) => <span key={k} className={`h-1.5 w-1.5 rounded-full ${DOT[i.kind]}`} />)}</div>
                <div className="hidden space-y-0.5 sm:block">
                  {c.items.slice(0, 3).map((i, k) => (
                    <div key={k} className={`truncate rounded border px-1 py-px text-[10px] ${KINDS[i.kind]}`} title={`${i.title}${i.sub ? ` · ${i.sub}` : ''}`}>{i.title}</div>
                  ))}
                  {c.items.length > 3 && <div className="text-[10px] text-white/40">+{c.items.length - 3} {t('more')}</div>}
                </div>
              </button>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-white/50">
            {Object.keys(DOT).map((k) => <span key={k} className="inline-flex items-center gap-1"><span className={`h-2 w-2 rounded-full ${DOT[k]}`} />{t(k === 'Google' ? 'Google Calendar' : k)}</span>)}
          </div>
        </Card>

        <Card>
          <div className="eyebrow mb-2">{shortDate(picked)} {picked.slice(0, 4)}</div>
          <div className="space-y-1.5">
            {dayItems.map((i, k) => {
              const body = (
                <div className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 text-sm ${KINDS[i.kind]}`}>
                  <span className="min-w-0 flex-1 truncate">{i.title}</span>
                  <span className="shrink-0 text-[11px] opacity-70">{i.kind === 'Google' ? 'Google' : t(i.kind)}{i.sub ? ` · ${i.sub}` : ''}</span>
                </div>
              )
              return i.to ? <Link key={k} to={i.to} className="block hover:brightness-125">{body}</Link> : <div key={k}>{body}</div>
            })}
            {dayItems.length === 0 && <div className="text-sm text-white/35">{t('Nothing on this day.')}</div>}
          </div>
        </Card>
      </div>

      <GoogleCard crmCount={upcoming} className={googleFirst ? 'order-first xl:order-none' : ''} />
    </div>
  )
}

export function GoogleCard(props) {
  const live = useStore((s) => s.hydrated)
  return live ? <LiveGoogleCard {...props} /> : <DemoGoogleCard {...props} />
}

/** Signed in: the real connection, kept on the server. Connecting leaves for Google and comes back. */
function LiveGoogleCard({ crmCount, className = '' }) {
  const t = useT()
  const { status: g, error, syncResult, busy, connect, disconnect, setOption, sync } = useGoogle()
  const [wantWrite, setWantWrite] = useState(false)
  return (
    <Card className={`h-fit ${className}`}>
      <div className="eyebrow mb-2">{t('Google Calendar')}</div>
      {!g ? (
        <div className="text-xs text-white/50">{t('Loading…')}</div>
      ) : !g.configured ? (
        <p className="text-xs text-amber-200/90" data-gcal-state="not-configured">
          {t('Google Calendar is not set up on this server yet. An administrator needs to add the Google client id and secret, the redirect address and a token key.')}
        </p>
      ) : g.connected ? (
        <div className="space-y-3 text-sm" data-gcal-state="connected">
          <div className="flex items-center gap-2 text-emerald-300"><Link2 size={15} />{t('Connected')}</div>
          <div className="text-xs text-white/60">{g.account}</div>
          <label className="flex items-start gap-2 text-white/75">
            <input type="checkbox" className="mt-0.5 accent-[#c6a15b]" checked={g.showGoogle} onChange={(e) => setOption({ showGoogle: e.target.checked })} />
            {t('Show my Google events here')}
          </label>
          {g.canWrite ? (
            <>
              <label className="flex items-start gap-2 text-white/75">
                <input type="checkbox" className="mt-0.5 accent-[#c6a15b]" checked={g.addCrmDates} onChange={(e) => setOption({ addCrmDates: e.target.checked })} />
                <span>{t('Add CRM dates to my Google Calendar')} <span className="text-white/40">({crmCount} {t('upcoming')})</span></span>
              </label>
              {g.addCrmDates && (
                <button className="btn-ghost !py-1.5 text-xs" disabled={busy} onClick={sync}>{t('Add the next 60 days now')}</button>
              )}
            </>
          ) : (
            <button className="btn-ghost !py-1.5 text-xs" disabled={busy} onClick={() => connect(true)}>
              {t('Allow adding CRM dates to my calendar')}
            </button>
          )}
          {syncResult && (
            <p className="text-[11px] text-emerald-300/80" data-gcal-sync>
              {syncResult.added} {t('added')}, {syncResult.alreadyThere} {t('already there')}{syncResult.error ? ` — ${syncResult.error}` : ''}
            </p>
          )}
          <button className="btn-ghost !py-1.5 text-xs" disabled={busy} onClick={disconnect}><Unlink size={13} />{t('Disconnect')}</button>
        </div>
      ) : (
        <div className="space-y-3 text-sm" data-gcal-state="not-connected">
          <p className="text-xs text-white/55">{t('See your meetings beside client birthdays, anniversaries and event nudges — and, if you like, add the CRM dates to your own calendar.')}</p>
          <label className="flex items-start gap-2 text-xs text-white/70">
            <input type="checkbox" className="mt-0.5 accent-[#c6a15b]" checked={wantWrite} onChange={(e) => setWantWrite(e.target.checked)} />
            {t('Also let Oscenia add CRM dates to my calendar (asks for the wider permission)')}
          </label>
          <button className="btn-gold w-full justify-center" disabled={busy} onClick={() => connect(wantWrite)}><CalendarDays size={15} />{t('Connect Google Calendar')}</button>
        </div>
      )}
      {error && <p className="mt-3 text-[11px] text-rose-300" data-gcal-error>{error}</p>}
    </Card>
  )
}

function DemoGoogleCard({ crmCount, className = '' }) {
  const t = useT()
  const g = useProto((s) => s.googleCalendar)
  const { disconnectGoogle, setGoogleOption } = useProto.getState()
  const [connecting, setConnecting] = useState(false)
  return (
    <Card className={`h-fit ${className}`}>
      <div className="eyebrow mb-2">{t('Google Calendar')}</div>
      {g?.connected ? (
        <div className="space-y-3 text-sm">
          <div className="flex items-center gap-2 text-emerald-300"><Link2 size={15} />{t('Connected')}</div>
          <div className="text-xs text-white/60">{g.account} · {t('since')} {stamp(g.connectedAt)}</div>
          <label className="flex items-start gap-2 text-white/75">
            <input type="checkbox" className="mt-0.5 accent-[#c6a15b]" checked={g.showGoogle} onChange={(e) => setGoogleOption({ showGoogle: e.target.checked })} />
            {t('Show my Google events here')}
          </label>
          <label className="flex items-start gap-2 text-white/75">
            <input type="checkbox" className="mt-0.5 accent-[#c6a15b]" checked={g.addCrmDates} onChange={(e) => setGoogleOption({ addCrmDates: e.target.checked })} />
            <span>{t('Add CRM dates to my Google Calendar')} <span className="text-white/40">({crmCount} {t('upcoming')})</span></span>
          </label>
          {g.addCrmDates && <p className="text-[11px] text-emerald-300/80">{t('Simulated: nudges, birthdays, anniversaries and events would appear in Google Calendar and stay in sync.')}</p>}
          <button className="btn-ghost !py-1.5 text-xs" onClick={disconnectGoogle}><Unlink size={13} />{t('Disconnect')}</button>
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          <p className="text-xs text-white/55">{t('See your meetings beside client birthdays, anniversaries and event nudges — and, if you like, add the CRM dates to your own calendar.')}</p>
          <button className="btn-gold w-full justify-center" onClick={() => setConnecting(true)}><CalendarDays size={15} />{t('Connect Google Calendar')}</button>
        </div>
      )}
      <p className="mt-4 text-[11px] text-white/35">{t('Prototype: simulated. The real connection signs in with Google on the backend; nothing leaves this browser.')}</p>
      {connecting && <ConnectModal onClose={() => setConnecting(false)} />}
    </Card>
  )
}

/** A stand-in for Google's sign-in and permission screen. */
function ConnectModal({ onClose }) {
  const t = useT()
  const pushToast = useStore((s) => s.pushToast)
  const [account, setAccount] = useState('')
  const allow = () => {
    if (!useProto.getState().connectGoogle(account)) return
    pushToast({ title: t('Google Calendar connected (simulated)'), body: account.trim(), kind: 'project' })
    onClose()
  }
  return (
    <Modal
      title="Connect Google Calendar"
      subtitle={t('Prototype: this stands in for Google’s own sign-in screen.')}
      onClose={onClose}
      footer={<><button className="btn-ghost" onClick={onClose}>{t('Cancel')}</button><button className="btn-gold" disabled={!isEmail(account)} onClick={allow}>{t('Allow')}</button></>}
    >
      <Field label="Google account"><TextInput autoFocus type="email" value={account} onChange={(e) => setAccount(e.target.value)} placeholder="name@company.com" /></Field>
      <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3 text-sm text-white/70">
        <div className="mb-1 text-white/90">{t('Oscenia ERP wants to:')}</div>
        <ul className="list-disc space-y-0.5 pl-5 text-xs">
          <li>{t('See the events on your calendars')}</li>
          <li>{t('Add CRM dates to your calendar, only if you turn that on')}</li>
        </ul>
      </div>
    </Modal>
  )
}
