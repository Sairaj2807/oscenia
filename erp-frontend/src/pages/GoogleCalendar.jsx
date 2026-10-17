// Google Calendar, a page of its own under CRM & Clients (client round 3). Before this it was
// only reachable through CRM → Relationship calendar → Month, where the client did not find it.
// It is the same month view and connect card (components/crm/CalendarView.jsx), so connecting here
// or on the CRM tab is one connection.
//
// Signed in, the connection is real: the server signs the person in at Google, keeps the refresh
// token (encrypted) and reads their events; the screen only ever sees status and events
// (store/useGoogle.js). Signed out (the demo), it stays simulated and nothing leaves the browser.
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Users } from 'lucide-react'
import { useProto } from '../store/useProto'
import { useStore } from '../store/useStore'
import { useGoogle, readReturn } from '../store/useGoogle'
import { PageHeader } from '../components/ui'
import { MonthView } from '../components/crm/CalendarView'
import { useT } from '../i18n'

const RETURN_TEXT = {
  connected: 'Google Calendar connected.',
  declined: 'Google sign-in was cancelled; nothing was connected.',
  failed: 'Google sign-in did not complete.',
}

export default function GoogleCalendar() {
  const t = useT()
  const live = useStore((s) => s.hydrated)
  const demoConnected = useProto((s) => s.googleCalendar?.connected)
  const liveStatus = useGoogle((s) => s.status)
  const connected = live ? liveStatus?.connected : demoConnected
  // Read once, on the way back from Google; the address is cleaned so a refresh does not repeat it.
  const [returned] = useState(readReturn)
  const loadStatus = useGoogle((s) => s.loadStatus)
  useEffect(() => { if (returned && live) loadStatus() }, [returned, live, loadStatus])
  const banner = live
    ? connected ? t('Connected to Google') : t('Not connected to Google')
    : connected ? t('Connected — simulated sync') : t('Not connected — simulated sync, nothing leaves this browser')
  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="CRM & Clients"
        title="Google Calendar"
        subtitle="Your Google meetings (blue) beside client birthdays, company anniversaries, event nudges and events, in one month view. Connect once to see them; you can also add the CRM dates to your own calendar."
        actions={
          <Link to="/crm?tab=calendar" className="btn-ghost">
            <Users size={15} /> {t('Relationship calendar')}
          </Link>
        }
      />
      {returned && RETURN_TEXT[returned.outcome] && (
        <div className={`mb-3 rounded-lg border px-3 py-2 text-xs ${returned.outcome === 'connected' ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-100' : 'border-amber-400/30 bg-amber-500/10 text-amber-100'}`} data-gcal-returned={returned.outcome}>
          {t(RETURN_TEXT[returned.outcome])}{returned.reason ? ` ${returned.reason}` : ''}
        </div>
      )}
      <div className="mb-4 inline-flex flex-wrap items-center gap-2 rounded-lg border border-blue-400/30 bg-blue-500/10 px-3 py-1.5 text-xs text-blue-100" data-gcal-status={connected ? 'connected' : 'off'}>
        <span className={`h-2 w-2 rounded-full ${connected ? 'bg-blue-400' : 'bg-white/30'}`} />
        {banner}
      </div>
      <MonthView googleFirst />
    </div>
  )
}
