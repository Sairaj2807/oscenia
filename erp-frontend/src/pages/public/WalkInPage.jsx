// Walk-in registration (decision 10): a guest without an RSVP scans the QR at the desk and
// fills this in on their own phone. Someone already on the client's list is simply checked
// in; anyone else is recorded as a walk-in. Consent to marketing is asked, never assumed.
//
// The QR carries a signed desk link (?w=...): without it the server refuses, so the form only
// works for people who were handed the venue's QR. If the server cannot be reached at all (the
// static demo) the page falls back to the demo store, as it always did.
import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useProto } from '../../store/useProto'
import { usePublicWalkIn } from '../../store/usePublicInvite'
import { themeOf } from '../../lib/templates'
import { liveInvite } from '../../lib/invites'

function Unavailable() {
  return (
    <div className="min-h-screen bg-navy-950 flex items-center justify-center px-6 text-center">
      <div>
        <div className="eyebrow mb-3">Oscenia Events</div>
        <div className="font-display text-2xl text-white">This registration link is not available</div>
        <p className="mt-2 text-sm text-white/50">Please ask the registration desk for help.</p>
      </div>
    </div>
  )
}

/** The form, drawn in the invitation's colours. `register(form)` resolves to `{ok, walkIn}` or `{ok:false, message}`. */
function WalkInView({ name, invite, register }) {
  const [form, setForm] = useState({ name: '', phone: '', email: '', consent: false, website: '' })
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const { palette: pal, fonts } = themeOf(invite)
  const line = { borderColor: 'color-mix(in srgb, currentColor 30%, transparent)' }
  const input = 'w-full rounded-lg border bg-transparent px-3 py-3 text-base outline-none'

  const submit = async (e) => {
    e.preventDefault()
    if (busy) return
    if (!form.name.trim()) return setError('Please enter your name.')
    if (form.phone.replace(/\D/g, '').length < 8) return setError('Please enter a valid phone number.')
    if (form.email && !/^\S+@\S+\.\S+$/.test(form.email)) return setError('Please check the email address.')
    setBusy(true)
    const r = await register(form)
    setBusy(false)
    if (!r.ok) return setError(r.message || 'Sorry, we could not register you. Please ask the desk.')
    setError('')
    setResult(r)
  }

  return (
    <div className="min-h-screen px-5 py-10" style={{ background: pal.bg, color: pal.text, fontFamily: fonts.body }}>
      <div className="mx-auto max-w-md">
        <div style={{ color: pal.accent }} className="text-center text-[11px] uppercase tracking-[0.35em]">Welcome</div>
        <h1 style={{ fontFamily: fonts.heading }} className="mt-3 text-center text-3xl leading-tight">{invite.content.cover.title || name}</h1>
        <div style={{ background: pal.accent }} className="mx-auto mt-5 h-px w-12" />

        <div style={{ background: pal.surface }} className="mt-8 rounded-xl p-6">
          {result ? (
            <div className="text-center">
              <div style={{ color: pal.accent }} className="text-sm uppercase tracking-[0.2em]">You’re checked in</div>
              <p className="mt-3 text-sm opacity-80">
                Thank you, {form.name.trim().split(' ')[0]}. {result.walkIn ? 'Please let the desk know and they will show you to a seat.' : 'We found you on the guest list — enjoy the evening.'}
              </p>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-3">
              <p className="text-sm opacity-75">Not on the list, or didn’t RSVP? Register here and you’re checked in.</p>
              <input style={line} className={input} placeholder="Full name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoComplete="name" />
              <input style={line} className={input} placeholder="Phone number" inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} autoComplete="tel" />
              <input style={line} className={input} placeholder="Email (optional)" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoComplete="email" />
              {/* A field no person fills in; a bot that fills every box trips it. */}
              <input name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" value={form.website}
                onChange={(e) => setForm({ ...form, website: e.target.value })} style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, opacity: 0 }} />
              <label className="flex items-start gap-2 text-xs opacity-80">
                <input type="checkbox" className="mt-0.5" checked={form.consent} onChange={(e) => setForm({ ...form, consent: e.target.checked })} />
                <span>I agree that Oscenia Events may keep my contact details to send me news and offers. I can unsubscribe at any time. (Optional.)</span>
              </label>
              {error && <div role="alert" className="rounded-lg bg-rose-500/15 px-3 py-2 text-sm text-rose-600">{error}</div>}
              <button type="submit" disabled={busy} style={{ background: pal.accent, color: pal.bg }} className="w-full rounded-lg px-4 py-3 text-base font-medium disabled:opacity-60">Check me in</button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}

function ServerWalkIn() {
  const page = usePublicWalkIn((s) => s.page)
  return <WalkInView name={page.name} invite={page.invite} register={(form) => usePublicWalkIn.getState().register(form)} />
}

/** No server to ask (the static demo): the demo store, exactly as before. */
function DemoWalkIn({ eventId }) {
  const event = useProto((s) => s.events.find((e) => e.id === eventId))
  const invite = liveInvite(event)
  if (!invite) return <Unavailable />
  const register = async (form) => {
    const r = useProto.getState().registerWalkIn(event.id, form)
    return r ? { ok: true, walkIn: r.walkIn } : { ok: false, message: 'Sorry, we could not register you. Please ask the desk.' }
  }
  return <WalkInView name={event.name} invite={invite} register={register} />
}

export default function WalkInPage() {
  const { eventId } = useParams()
  const [params] = useSearchParams()
  const desk = params.get('w')
  const status = usePublicWalkIn((s) => s.status)
  const eventNo = usePublicWalkIn((s) => s.eventNo)

  useEffect(() => {
    usePublicWalkIn.getState().load(eventId, desk)
  }, [eventId, desk])

  if (eventNo !== eventId || status === 'idle' || status === 'loading') return <div className="min-h-screen bg-navy-950" />
  if (status === 'offline') return <DemoWalkIn eventId={eventId} />
  if (status !== 'ready') return <Unavailable />
  return <ServerWalkIn />
}
