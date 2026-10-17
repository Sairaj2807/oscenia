// The event client's private link (D6/D14: no login, one link). It opens the template gallery
// until a template is chosen, then the same editor Oscenia staff use — without the ERP and
// without the RSVP settings. The client submits the draft for review; Oscenia publishes (D7).
// Once the invitation is live a second tab, Send invitations, lets the client send each guest
// their own link from their WhatsApp (D9/D11). `&tab=send` opens it directly.
//
// The key is checked by the server before anything is shown or saved (a signed, expiring, revocable
// token). While the page is open the editor reads and writes the client store (`usePublicClient`)
// through the same `useProto` door the staff editor uses. If the server cannot be reached at all
// (the static demo) the page falls back to the demo store, key compared in the browser, as before.
import { useEffect, useState } from 'react'
import { useSearchParams, useParams } from 'react-router-dom'
import { ExternalLink, Send, Clock, MessageSquareWarning, CheckCircle2 } from 'lucide-react'
import InviteStudio from '../../components/invite/InviteStudio'
import SendInvitations from '../../components/invite/SendInvitations'
import { Tabs } from '../../components/ui'
import { useProto } from '../../store/useProto'
import { usePublicClient } from '../../store/usePublicClient'
import { hasUnpublishedChanges } from '../../lib/invites'
import { useT } from '../../i18n'

function NotValid() {
  const t = useT()
  return (
    <div className="py-24 text-center">
      <div className="font-display text-2xl text-white">{t('This link is not valid')}</div>
      <p className="mt-2 text-sm text-white/50">{t('It may have been replaced. Ask your Oscenia coordinator for the current link.')}</p>
    </div>
  )
}

/** The page around the editor. `event` is null when the link is not valid. */
function EditShell({ event, onSubmit, tabParam }) {
  const t = useT()
  const [tab, setTab] = useState(() => (tabParam === 'send' ? 'send' : 'design'))
  const valid = Boolean(event)
  const live = valid && event.status === 'Published'
  const sending = live && tab === 'send'

  return (
    <div className="min-h-screen bg-oscenia pb-24">
      <header className="flex flex-wrap items-center gap-3 border-b border-white/10 bg-navy-950/80 px-4 sm:px-6 py-3">
        <div>
          <div className="brand-mark text-sm leading-none">OSCENIA</div>
          <div className="text-[9px] tracking-[0.3em] text-white/40 mt-1">INVITATION STUDIO</div>
        </div>
        {valid && (
          <>
            <div className="ml-4 min-w-0">
              <div className="truncate text-sm text-white">{event.name}</div>
              <div className="text-[11px] text-white/40">{t('Changes save as you type')}</div>
            </div>
            {event.status === 'Published' && (
              <a href={`${import.meta.env.BASE_URL}invite/${event.id}`} target="_blank" rel="noreferrer" className="btn-ghost ml-auto !py-1.5 text-xs">
                <ExternalLink size={14} /> {t('View as a guest')}
              </a>
            )}
          </>
        )}
      </header>
      <main className="px-4 sm:px-6 py-6 max-w-[1400px] mx-auto">
        {valid ? (
          <>
            {live && (
              <Tabs tabs={[{ key: 'design', label: 'Design' }, { key: 'send', label: 'Send invitations' }]} active={tab} onChange={setTab} />
            )}
            {sending ? <SendInvitations event={event} clientMode /> : <InviteStudio event={event} clientMode />}
          </>
        ) : (
          <NotValid />
        )}
      </main>
      {valid && event.invite.templateId && !sending && <ReviewBar event={event} onSubmit={onSubmit} />}
    </div>
  )
}

/** Signed-out client, real server. */
function ServerEdit({ tabParam }) {
  const status = usePublicClient((s) => s.status)
  const event = usePublicClient((s) => s.event)
  if (status === 'error') {
    return <EditShell event={null} tabParam={tabParam} />
  }
  return <EditShell event={status === 'ready' ? event : null} tabParam={tabParam} onSubmit={() => usePublicClient.getState().submitForReview()} />
}

/** No server to ask (the static demo): the demo store, key compared in the browser. */
function DemoEdit({ eventId, keyParam, tabParam }) {
  const event = useProto((s) => s.events.find((e) => e.id === eventId))
  const valid = event && keyParam === event.editToken
  return <EditShell event={valid ? event : null} tabParam={tabParam} onSubmit={() => useProto.getState().submitForReview(event.id, 'client')} />
}

export default function InviteEditPage() {
  const { eventId } = useParams()
  const [params] = useSearchParams()
  const key = params.get('key') || ''
  const status = usePublicClient((s) => s.status)
  const eventNo = usePublicClient((s) => s.eventNo)

  // Ask the server about this key; leaving the page hands the editor back to its usual store.
  useEffect(() => {
    usePublicClient.getState().load(eventId, key)
    return () => usePublicClient.getState().leave()
  }, [eventId, key])

  if (status === 'offline') return <DemoEdit eventId={eventId} keyParam={key} tabParam={params.get('tab')} />
  if (eventNo !== eventId || status === 'idle' || status === 'loading') return <div className="min-h-screen bg-oscenia" />
  return <ServerEdit tabParam={params.get('tab')} />
}

/** Where the client's draft stands, and the one thing they can do about it. */
function ReviewBar({ event, onSubmit }) {
  const t = useT()
  const { state, note } = event.review
  const live = event.status === 'Published'
  const changed = !event.published || hasUnpublishedChanges(event)

  let icon = Send
  let text = live ? 'Your invitation is live. Changes you make here reach guests once Oscenia publishes them.' : 'When your invitation is ready, send it to Oscenia to check and publish.'
  let tone = 'text-white/70'
  if (state === 'submitted') { icon = Clock; text = 'Oscenia is reviewing your invitation. You can keep editing — they see your latest version.'; tone = 'text-amber-200' }
  if (state === 'returned') { icon = MessageSquareWarning; text = `${t('Oscenia asked for changes')}: “${note}”`; tone = 'text-rose-200' }
  if (state === 'editing' && live && !changed) { icon = CheckCircle2; text = 'Guests see your latest version.'; tone = 'text-emerald-200' }
  const Icon = icon

  return (
    <div className="fixed inset-x-0 bottom-0 z-30 border-t border-white/10 bg-navy-950/95 px-4 py-3 backdrop-blur sm:px-6">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-3">
        <Icon size={18} className={`shrink-0 ${tone}`} />
        <p className={`min-w-0 flex-1 text-sm ${tone}`}>{state === 'returned' ? text : t(text)}</p>
        {state !== 'submitted' && changed && (
          <button className="btn-gold" onClick={onSubmit}>
            <Send size={15} />{t(state === 'returned' ? 'Send again for review' : 'Submit for review')}
          </button>
        )}
      </div>
    </div>
  )
}
