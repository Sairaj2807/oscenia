// The guest-facing invitation (no sign-in): the published template (Invitations v2), with the
// RSVP form in its RSVP section. After replying "attending", the guest gets a personal QR code
// to show at the registration desk. Guests only ever see the published copy — a draft the
// client or staff are still editing stays out of sight until it is approved (D7).
//
// Coming back (R3): this device remembers who replied, so reopening the link shows the QR
// straight away; and every guest has a personal link (?g=<token>) that brings their reply back
// on any device — or, before they reply, opens the form already filled in.
//
// Phase 4: the page opens on its cover, full screen, greeting a personal-link guest by name.
// "Open invitation" reveals the rest and starts the background music (a tap is what lets a
// browser play sound); a floating button pauses it.
//
// Where the data comes from: the server (the public API), and the personal-link token is the only
// thing identifying the guest. If the server cannot be reached at all (the static demo has no
// backend) the page falls back to the demo store, as it always did.
import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import InviteRenderer, { themeVars } from '../../components/invite/InviteRenderer'
import { Panel, RsvpForm, Confirmation } from '../../components/invite/Rsvp'
import { OpenButton, MusicButton, WishForm, useMusic } from '../../components/invite/guest'
import { useProto } from '../../store/useProto'
import { usePublicInvite, rememberToken, rememberedToken } from '../../store/usePublicInvite'
import { rsvpOpen } from '../../lib/events'
import { liveInvite, longDate } from '../../lib/invites'
import { musicOn } from '../../lib/templates'
import { DEMO_TODAY } from '../../lib/format'

// How long the cover takes to fade away once opened (matches duration-500 below).
const GATE_FADE_MS = 500

// Demo only: per event, the guest who last replied on this device. Storage can be blocked
// (private windows): then the page simply forgets, as before.
const memoryKey = (eventId) => `oscenia.rsvp.${eventId}`
function remembered(eventId) {
  try { return localStorage.getItem(memoryKey(eventId)) } catch { return null }
}
function remember(eventId, guestId) {
  try {
    if (guestId) localStorage.setItem(memoryKey(eventId), guestId)
    else localStorage.removeItem(memoryKey(eventId))
  } catch { /* not remembered */ }
}

function NotAvailable({ retry = false }) {
  return (
    <div className="min-h-screen bg-navy-950 flex items-center justify-center px-6 text-center">
      <div>
        <div className="eyebrow mb-3">Oscenia Events</div>
        <div className="font-display text-2xl text-white">This invitation is not available</div>
        <p className="mt-2 text-sm text-white/50">
          {retry ? 'Something went wrong on our side. Please try again in a moment.' : 'The link may be mistyped, or the invitation has not been published yet.'}
        </p>
      </div>
    </div>
  )
}

/** The cover gate, the music and the renderer: the same for the server page and the demo page. */
function InviteShell({ event, linked, rsvp, wishForm }) {
  const invite = liveInvite(event)
  // closed → leaving (fading out) → open
  const [gate, setGate] = useState('closed')
  const music = useMusic(invite && musicOn(invite) ? invite.content.music : null)
  const open = () => {
    music.play()
    setGate('leaving')
    setTimeout(() => setGate('open'), GATE_FADE_MS)
  }
  if (!invite) return <NotAvailable />

  return (
    <div className="min-h-screen" style={themeVars(invite)}>
      <div className="mx-auto max-w-3xl" inert={gate !== 'open'}>
        <InviteRenderer event={event} invite={invite} guest={linked || null} slots={{ rsvp, wishForm }} />
      </div>
      {gate !== 'open' && (
        <div className={`fixed inset-0 z-40 overflow-y-auto transition-opacity duration-500 ${gate === 'leaving' ? 'pointer-events-none opacity-0' : ''}`}
          style={themeVars(invite)} role="dialog" aria-label="Invitation cover">
          <div className="mx-auto max-w-3xl">
            <InviteRenderer event={event} invite={invite} guest={linked || null} only={['cover']} slots={{ open: <OpenButton onOpen={open} /> }} />
          </div>
        </div>
      )}
      {gate === 'open' && music.available && <MusicButton music={music} />}
    </div>
  )
}

function closedPanel(event) {
  const taken = typeof event.isPast === 'boolean' ? event.isPast : DEMO_TODAY > event.date
  return (
    <Panel>
      <div className="text-sm uppercase tracking-[0.2em] opacity-80">RSVP</div>
      <p className="mt-2 text-sm opacity-75">
        {taken ? 'This event has taken place. Thank you to everyone who joined us.' : `RSVPs closed on ${longDate(event.rsvpDeadline)}. Please contact the host directly.`}
      </p>
    </Panel>
  )
}

/** Signed-out guest, real server. */
function ServerInvite({ eventId }) {
  const { event, linked, me } = usePublicInvite()
  const [editing, setEditing] = useState(false)
  const notMe = () => {
    rememberToken(eventId, null)
    usePublicInvite.setState({ me: null })
    setEditing(false)
  }
  const replied = me?.rsvp ? me : null
  // After "Delete my data" the personal link names nobody: say so, rather than show an empty form.
  const [erased, setErased] = useState(false)
  const withdraw = async (scope) => {
    const out = await usePublicInvite.getState().withdraw(scope)
    if (out.ok && scope === 'all') setErased(true)
    return out
  }

  const rsvp = erased ? (
    <Panel>
      <div className="text-center">
        <div className="text-sm uppercase tracking-[0.2em]">Your data was deleted</div>
        <p className="mt-2 text-sm opacity-80">Your name, contact details and answers were removed from this event, and your link and QR code no longer work.</p>
      </div>
    </Panel>
  ) : replied && !editing ? (
    <Confirmation event={event} guest={replied} onChange={() => setEditing(true)} onNotMe={linked ? null : notMe} onWithdraw={withdraw} />
  ) : rsvpOpen(event) ? (
    // Changing a reply, or a personal link before any reply: start from what we know.
    <RsvpForm key={editing ? replied?.id : linked?.id || 'new'} event={event} from={editing ? replied : linked} onDone={() => setEditing(false)}
      onCancel={editing ? () => setEditing(false) : null} />
  ) : closedPanel(event)

  return <InviteShell event={event} linked={linked} rsvp={rsvp} wishForm={<WishForm event={event} guest={replied || linked || null} />} />
}

/** No server to ask (the static demo): the demo store, exactly as before. */
function DemoInvite({ eventId, token }) {
  const event = useProto((s) => s.events.find((e) => e.id === eventId))
  const linked = useProto((s) => (token ? s.guests.find((g) => g.eventId === eventId && g.token === token) : undefined))
  // A personal link wins over this device's memory: it names one guest outright.
  const [guestId, setGuestId] = useState(() => (linked ? (linked.rsvp ? linked.id : null) : remembered(eventId)))
  const [editing, setEditing] = useState(false)
  const guest = useProto((s) => s.guests.find((g) => g.id === guestId && g.eventId === eventId))

  const done = (id) => {
    remember(eventId, id)
    setGuestId(id)
    setEditing(false)
  }
  const notMe = () => {
    remember(eventId, null)
    setGuestId(null)
    setEditing(false)
  }
  if (!liveInvite(event)) return <NotAvailable />

  const rsvp = guest && !editing ? (
    <Confirmation event={event} guest={guest} onChange={() => setEditing(true)} onNotMe={linked ? null : notMe} />
  ) : rsvpOpen(event) ? (
    <RsvpForm key={editing ? guest?.id : linked?.id || 'new'} event={event} from={editing ? guest : linked} onDone={done}
      onCancel={editing ? () => setEditing(false) : null} />
  ) : closedPanel(event)

  return <InviteShell event={event} linked={linked} rsvp={rsvp} wishForm={<WishForm event={event} guest={guest || linked || null} />} />
}

export default function InvitePage() {
  const { eventId } = useParams()
  const [params] = useSearchParams()
  const token = params.get('g')
  const status = usePublicInvite((s) => s.status)
  const eventNo = usePublicInvite((s) => s.eventNo)

  // Ask the server; the link's token wins over the one this device remembers.
  useEffect(() => {
    usePublicInvite.getState().load(eventId, token || rememberedToken(eventId))
  }, [eventId, token])

  if (eventNo !== eventId || status === 'idle' || status === 'loading') return <div className="min-h-screen bg-navy-950" />
  if (status === 'offline') return <DemoInvite eventId={eventId} token={token} />
  if (status === 'missing') return <NotAvailable />
  if (status === 'error') return <NotAvailable retry />
  return <ServerInvite eventId={eventId} />
}
