// One event: its invitation (designed here or by the client through their edit link), sending
// it, and — in the tabs that follow — guests, reminders, check-in and the report.
import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Link2, ExternalLink, KeyRound, Globe, EyeOff, RefreshCw } from 'lucide-react'
import { Badge, Card, Tabs, ActionButton, DEMO_TODAY } from '../../components/ui'
import ReviewPanel from '../../components/invite/ReviewPanel'
import { hasUnpublishedChanges } from '../../lib/invites'
import InviteStudio from '../../components/invite/InviteStudio'
import SendInvitations from '../../components/invite/SendInvitations'
import GuestsTab from '../../components/events/GuestsTab'
import RemindersTab from '../../components/events/RemindersTab'
import CheckInTab from '../../components/events/CheckInTab'
import ReportTab from '../../components/events/ReportTab'
import { useProto } from '../../store/chatProto'
import { useStore } from '../../store/useStore'
import { shortDate } from '../../components/workspace/parts'
import { useT } from '../../i18n'

// Paths for links on the page; full URLs (with the origin) only when copying to share.
export const guestPath = (event) => `${import.meta.env.BASE_URL}invite/${event.id}`
export const editPath = (event) => `${import.meta.env.BASE_URL}invite/${event.id}/edit?key=${event.editToken}`
export const absolute = (path) => `${window.location.origin}${path}`

export default function EventDetail() {
  const t = useT()
  const { id } = useParams()
  const event = useProto((s) => s.events.find((e) => e.id === id))
  const client = useStore((s) => s.clients.find((c) => c.id === event?.clientId))
  const pushToast = useStore((s) => s.pushToast)
  const role = useStore((s) => s.role)
  const [reviewing, setReviewing] = useState(false)
  // `?tab=` opens a tab directly; otherwise a past event opens on its report, an upcoming one
  // on its guest list.
  const [params] = useSearchParams()
  const [tab, setTab] = useState(() => params.get('tab') || (event && event.date < DEMO_TODAY ? 'report' : 'guests'))
  const loadedGuests = useProto((s) => s.guests.reduce((n, g) => n + (g.eventId === id ? 1 : 0), 0))
  // Signed in, the event on screen is re-read every 20 s (a check-in desk should not lag), and the
  // guest count is the server's until the guest list itself has arrived.
  const openEvent = useProto((s) => s.openEvent)
  const live = useProto((s) => s.live)
  const eventsStatus = useProto((s) => s.eventsStatus)
  useEffect(() => {
    openEvent?.(id)
    return () => openEvent?.(null)
  }, [id, openEvent])
  const guestCount = event?.stats ? event.stats.invited + event.stats.offList + event.stats.walkIns : loadedGuests

  if (!event && (eventsStatus === 'loading' || eventsStatus === 'idle')) {
    return <Card><div className="text-white/60">{t('Loading events…')}</div></Card>
  }
  if (!event) {
    return <Card><div className="text-white/60">{t('Event not found.')} <Link to="/events" className="text-gold">{t('Back to events')}</Link></div></Card>
  }

  const copy = async (text, title, body) => {
    try {
      await navigator.clipboard.writeText(text)
      pushToast({ title, body, kind: 'project' })
    } catch {
      pushToast({ title: 'Copy failed', body: text, kind: 'redflag' })
    }
  }
  const published = event.status === 'Published'
  const reviewLabel = event.review.state === 'submitted' ? 'Waiting for review'
    : event.review.state === 'returned' ? 'Sent back to the client'
      : hasUnpublishedChanges(event) ? 'Unpublished changes' : null
  const needsReview = !published || event.review.state === 'submitted' || hasUnpublishedChanges(event)

  return (
    <div>
      <Link to="/events" className="inline-flex items-center gap-1 text-xs text-white/50 hover:text-gold-light mb-3">
        <ArrowLeft size={14} /> {t('Events & Invitations')}
      </Link>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between mb-5">
        <div>
          <div className="eyebrow mb-2">{event.id}{client ? ` · ${client.name}` : ''}</div>
          <h1 className="font-display text-2xl sm:text-3xl text-white">{event.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-white/50">
            <span>{shortDate(event.date)} {event.date.slice(0, 4)}, {event.time}</span>
            <span className="truncate">{event.venue}</span>
            <Badge>{event.status}</Badge>
            {reviewLabel && <span className="rounded-full border border-amber-300/40 bg-amber-300/10 px-2 py-0.5 text-[11px] text-amber-200">{t(reviewLabel)}</span>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {/* Guests only ever see what staff publish (D7): review first, then publish. */}
          <ActionButton action="publish_invitation" role={role} className={needsReview ? 'btn-gold' : 'btn-ghost'}
            disabled={!event.invite.templateId} title={!event.invite.templateId ? t('Choose a template first') : undefined}
            onClick={() => setReviewing(true)}>
            <Globe size={15} />{t(published ? 'Review changes' : 'Review & publish')}
          </ActionButton>
          {published && (
            <ActionButton action="publish_invitation" role={role} className="btn-ghost" onClick={async () => {
              if (!window.confirm(t('Unpublish? Guests will no longer be able to open the invitation or RSVP.'))) return
              if ((await useProto.getState().unpublish(event.id)) === false) return
              pushToast({ title: 'Invitation unpublished', body: 'Guests can no longer open it.', kind: 'project' })
            }}>
              <EyeOff size={15} />{t('Unpublish')}
            </ActionButton>
          )}
          <button className="btn-ghost" disabled={!published} onClick={() => copy(absolute(guestPath(event)), 'Guest link copied', 'Share it with the guest list.')}>
            <Link2 size={15} />{t('Guest link')}
          </button>
          <button className="btn-ghost" disabled={!event.editToken} title={!event.editToken ? t('Only a manager can copy the client link') : undefined} onClick={() => copy(absolute(editPath(event)), 'Client link copied', 'Send it to the client — they choose a template, design and submit it. No login needed.')}>
            <KeyRound size={15} />{t('Client link')}
          </button>
          <ActionButton action="publish_invitation" role={role} className="btn-ghost" title={t('Revoke the client link and make a new one')} onClick={async () => {
            if (!window.confirm(t('Revoke the client link? The old link stops working at once; send the client the new one.'))) return
            if (!(await useProto.getState().regenerateEditToken(event.id))) return
            pushToast({ title: 'Client link revoked', body: 'A new link was made — copy it from “Client link”.', kind: 'project' })
          }}>
            <RefreshCw size={15} />{t('Revoke')}
          </ActionButton>
          {published && (
            <a className="btn-ghost" href={guestPath(event)} target="_blank" rel="noreferrer"><ExternalLink size={15} />{t('Open as guest')}</a>
          )}
        </div>
      </div>

      <p className="mb-4 text-[11px] text-white/35">
        {live
          ? t('Your guest list, check-in and invitation are saved on the server. The guest page itself (RSVP, wishes, the client link) is not connected to the server yet, so real guests cannot reply from their phones, and media upload and sending are not connected either.')
          : t('Prototype: RSVPs from the guest page appear here straight away when opened in this browser. Guests replying from their own phones needs the backend.')}
      </p>

      <Tabs
        tabs={[
          { key: 'invitation', label: 'Invitation' },
          { key: 'send', label: 'Send invitations' },
          { key: 'guests', label: 'Guests & RSVP', count: guestCount },
          { key: 'reminders', label: 'Reminders', count: event.reminders.filter((r) => r.active).length },
          { key: 'checkin', label: 'Check-in' },
          { key: 'report', label: 'Attendance report' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'invitation' && <InviteStudio event={event} />}
      {reviewing && <ReviewPanel event={event} onClose={() => setReviewing(false)} />}
      {tab === 'send' && <SendInvitations event={event} />}
      {tab === 'guests' && <GuestsTab event={event} />}
      {tab === 'reminders' && <RemindersTab event={event} />}
      {tab === 'checkin' && <CheckInTab event={event} />}
      {tab === 'report' && <ReportTab event={event} />}
    </div>
  )
}
