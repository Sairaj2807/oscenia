// The RSVP section of the guest page (moved from pages/public/InvitePage.jsx for Invitations
// v2): the form, the event's own questions (R7), and the confirmation with the guest's QR
// access card. Drawn in the template's colours through InviteRenderer's CSS variables.
import { useEffect, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { useProto } from '../../store/useProto'
import { usePublicInvite } from '../../store/usePublicInvite'
import { rsvpOpen, qrPayload, personalLink, MAX_PAX_LIMIT, questionsFor, cleanAnswers, MAX_ANSWER_LENGTH } from '../../lib/events'
import { longDate } from '../../lib/invites'

// The template's colours, as CSS variables set by InviteRenderer.
const pal = { bg: 'var(--inv-bg)', surface: 'var(--inv-surface)', accent: 'var(--inv-accent)' }

/** What a refusal says to the guest: the server's code decides, its words fill the gaps. */
function refusal(r) {
  if (r.code === 'closed') return 'Sorry, RSVPs for this event are closed.'
  if (r.code === 'missing_answers') return `Please answer: ${(r.missing || []).join(', ')}.`
  return r.message || 'Sorry, we could not save your reply. Please try again.'
}

export function Panel({ children }) {
  return <div style={{ background: pal.surface }} className="rounded-xl p-5 sm:p-6">{children}</div>
}

export function RsvpForm({ event, from, onDone, onCancel }) {
  const f = event.rsvpFields
  const maxPax = Math.min(event.maxPax, MAX_PAX_LIMIT)
  const [form, setForm] = useState(() => ({
    name: from?.name || '', phone: from?.phone || '', email: from?.email || '',
    attending: from?.rsvp === 'Attending' ? true : from?.rsvp === 'Declined' ? false : null,
    pax: Math.min(Math.max(1, from?.pax || 1), maxPax), allergies: from?.allergies || '', consent: false,
    token: from?.token,
    answers: from?.answers || {},
    website: '', // a field no person fills in; a bot that fills every box trips it
  }))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (patch) => setForm((x) => ({ ...x, ...patch }))

  const input = 'w-full rounded-lg border bg-transparent px-3 py-2.5 text-sm outline-none'
  const line = { borderColor: 'color-mix(in srgb, currentColor 30%, transparent)' }

  const submit = async (e) => {
    e.preventDefault()
    if (busy) return
    if (!form.name.trim() || !form.phone.trim()) return setError('Please fill in your name and phone number.')
    if (form.phone.replace(/\D/g, '').length < 8) return setError('Please check the phone number — we use it for WhatsApp reminders.')
    if (form.email && !/^\S+@\S+\.\S+$/.test(form.email)) return setError('Please check the email address.')
    if (form.attending === null) return setError('Please let us know if you can attend.')
    const { missing } = cleanAnswers(event, form.attending, form.answers)
    if (missing.length) return setError(`Please answer: ${missing.join(', ')}.`)
    setBusy(true)
    let result
    if (event.server) {
      result = await usePublicInvite.getState().submitRsvp(form)
    } else {
      const id = useProto.getState().submitRsvp(event.id, form)
      result = id ? { ok: true, id } : { ok: false, code: 'closed' }
    }
    setBusy(false)
    if (!result.ok) return setError(refusal(result))
    setError('')
    onDone(result.id ?? result.guest?.id ?? null)
  }

  return (
    <Panel>
      <form onSubmit={submit} className="space-y-3">
        <div className="text-sm uppercase tracking-[0.2em]" style={{ color: pal.accent }}>RSVP</div>
        <p className="text-xs opacity-65">Kindly reply by {longDate(event.rsvpDeadline)}.</p>
        <input style={line} className={input} placeholder="Full name" value={form.name} onChange={(e) => set({ name: e.target.value })} autoComplete="name" />
        <input name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" value={form.website} onChange={(e) => set({ website: e.target.value })}
          style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, opacity: 0 }} />
        <input style={line} className={input} placeholder="Phone number (WhatsApp)" value={form.phone} onChange={(e) => set({ phone: e.target.value })} inputMode="tel" autoComplete="tel" />
        {f.email && <input style={line} className={input} placeholder="Email" type="email" value={form.email} onChange={(e) => set({ email: e.target.value })} autoComplete="email" />}

        <div className="grid grid-cols-2 gap-2 pt-1">
          {[[true, 'Joyfully accept'], [false, 'Regretfully decline']].map(([value, label]) => (
            <button
              type="button"
              key={label}
              onClick={() => set({ attending: value })}
              style={form.attending === value ? { background: pal.accent, color: pal.bg, borderColor: pal.accent } : line}
              className="rounded-lg border px-3 py-2.5 text-sm"
            >
              {label}
            </button>
          ))}
        </div>

        {form.attending && f.pax && maxPax > 1 && (
          <label className="flex items-center justify-between gap-3 text-sm">
            <span className="opacity-80">Number of people, including you</span>
            {maxPax <= 10 ? (
              <select style={line} className="rounded-lg border bg-transparent px-2 py-1.5" value={form.pax} onChange={(e) => set({ pax: Number(e.target.value) })}>
                {Array.from({ length: maxPax }, (_, i) => i + 1).map((n) => <option key={n} value={n} style={{ color: '#111' }}>{n}</option>)}
              </select>
            ) : (
              // Past ten a dropdown gets long: a number with − / + instead (R6).
              <span className="flex items-center gap-1">
                <button type="button" style={line} className="h-8 w-8 rounded-lg border" aria-label="One fewer" onClick={() => set({ pax: Math.max(1, form.pax - 1) })}>−</button>
                <input style={line} className="w-14 rounded-lg border bg-transparent px-2 py-1.5 text-center" type="number" inputMode="numeric" min={1} max={maxPax}
                  aria-label="Number of people" value={form.pax}
                  onChange={(e) => set({ pax: Math.min(maxPax, Math.max(1, Number(e.target.value) || 1)) })} />
                <button type="button" style={line} className="h-8 w-8 rounded-lg border" aria-label="One more" onClick={() => set({ pax: Math.min(maxPax, form.pax + 1) })}>+</button>
                <span className="text-xs opacity-60">max {maxPax}</span>
              </span>
            )}
          </label>
        )}
        {form.attending && f.allergies && (
          <input style={line} className={input} placeholder="Food allergies or dietary needs (optional)" value={form.allergies} onChange={(e) => set({ allergies: e.target.value })} />
        )}

        {/* The event's own questions (R7), once the guest has said whether they are coming. */}
        {form.attending !== null && questionsFor(event, form.attending).map((q) => (
          <Question key={q.id} q={q} value={form.answers[q.id]} line={line} input={input}
            onChange={(v) => set({ answers: { ...form.answers, [q.id]: v } })} />
        ))}

        <label className="flex items-start gap-2 pt-1 text-xs opacity-80">
          <input type="checkbox" className="mt-0.5" checked={form.consent} onChange={(e) => set({ consent: e.target.checked })} />
          <span>I agree that Oscenia Events may keep my contact details to send me news and offers. I can unsubscribe at any time. (Optional — your RSVP does not depend on it.)</span>
        </label>

        {error && <div role="alert" className="rounded-lg bg-rose-500/15 px-3 py-2 text-sm text-rose-600">{error}</div>}

        <button type="submit" disabled={busy} style={{ background: pal.accent, color: pal.bg }} className="w-full rounded-lg px-4 py-3 text-sm font-medium tracking-wide disabled:opacity-60">
          {from?.rsvp ? 'Update my RSVP' : 'Send RSVP'}
        </button>
        {onCancel && <button type="button" onClick={onCancel} className="w-full text-xs underline underline-offset-2 opacity-70">Keep my current reply</button>}
      </form>
    </Panel>
  )
}

/** One custom question, drawn in the invitation's own colours. */
function Question({ q, value, onChange, line, input }) {
  const label = <>{q.label}{q.required && <span style={{ color: pal.accent }}> *</span>}</>
  if (q.type === 'text') {
    return (
      <label className="block text-sm">
        <span className="opacity-80">{label}</span>
        <input style={line} className={`${input} mt-1`} maxLength={MAX_ANSWER_LENGTH} value={value || ''} onChange={(e) => onChange(e.target.value)} />
      </label>
    )
  }
  if (q.type === 'dropdown') {
    return (
      <label className="block text-sm">
        <span className="opacity-80">{label}</span>
        <select style={line} className={`${input} mt-1`} value={value || ''} onChange={(e) => onChange(e.target.value)}>
          <option value="" style={{ color: '#111' }}>Choose…</option>
          {q.options.map((o) => <option key={o} value={o} style={{ color: '#111' }}>{o}</option>)}
        </select>
      </label>
    )
  }
  const picked = Array.isArray(value) ? value : value ? [value] : []
  const toggle = (o) => onChange(q.multi ? (picked.includes(o) ? picked.filter((x) => x !== o) : [...picked, o]) : o)
  return (
    <fieldset className="text-sm">
      <legend className="opacity-80">{label}{q.multi && <span className="text-xs opacity-60"> (choose any)</span>}</legend>
      <div className="mt-1.5 flex flex-wrap gap-2">
        {q.options.map((o) => {
          const on = picked.includes(o)
          return (
            <button type="button" key={o} role={q.multi ? 'checkbox' : 'radio'} aria-checked={on} onClick={() => toggle(o)}
              style={on ? { background: pal.accent, color: pal.bg, borderColor: pal.accent } : line}
              className="rounded-lg border px-3 py-2">
              {o}
            </button>
          )
        })}
      </div>
    </fieldset>
  )
}

export function Confirmation({ event, guest, onChange, onNotMe, onWithdraw }) {
  const first = guest.name.split(' ')[0]
  const open = rsvpOpen(event)
  // The link to keep: a full URL, and the origin only exists in the browser.
  const path = `${import.meta.env.BASE_URL}invite/${event.id}`
  const [link, setLink] = useState(path)
  useEffect(() => { setLink(personalLink(`${window.location.origin}${path}`, guest)) }, [path, guest])
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try { await navigator.clipboard.writeText(link); setCopied(true) } catch { setCopied(false) }
  }
  return (
    <Panel>
      <div className="text-center">
        {guest.rsvp === 'Attending' ? (
          <>
            <div className="text-sm uppercase tracking-[0.2em]" style={{ color: pal.accent }}>You’re on the list</div>
            <p className="mt-2 text-sm opacity-80">
              Thank you, {first}. We look forward to seeing you{guest.pax > 1 ? ` and your guest${guest.pax > 2 ? 's' : ''}` : ''} on {longDate(event.date)}.
            </p>
            <div className="mx-auto mt-5 inline-block rounded-xl bg-white p-4">
              <QRCodeSVG value={qrPayload(guest)} size={180} level="M" />
            </div>
            {/^G-/.test(guest.id) && <div className="mt-2 font-mono text-xs opacity-60">{guest.id}</div>}
            <p className="mt-3 text-xs opacity-70">
              Show this QR code at the registration desk. Take a screenshot to keep it — we will also send it to your WhatsApp{guest.email ? ' and email' : ''}.
            </p>
          </>
        ) : (
          <>
            <div className="text-sm uppercase tracking-[0.2em]" style={{ color: pal.accent }}>Thank you for letting us know</div>
            <p className="mt-2 text-sm opacity-80">
              We’re sorry you can’t make it, {first}.{open ? ` You can change your reply until ${longDate(event.rsvpDeadline)}.` : ''}
            </p>
          </>
        )}
        {guest.token && (
          <div className="mt-5 rounded-lg p-3 text-left text-xs" style={{ border: '1px solid color-mix(in srgb, currentColor 20%, transparent)' }}>
            <div className="opacity-80">Your personal link — open it on any phone to see your reply{guest.rsvp === 'Attending' ? ' and QR code' : ''} again:</div>
            <div className="mt-1 flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono opacity-60">{link}</span>
              <button type="button" onClick={copy} className="shrink-0 underline underline-offset-2">{copied ? 'Copied' : 'Copy'}</button>
            </div>
          </div>
        )}
        <div className="mt-4 flex flex-wrap justify-center gap-4 text-xs opacity-70">
          {open && <button onClick={onChange} className="underline underline-offset-2">Change my reply</button>}
          {onNotMe && <button onClick={onNotMe} className="underline underline-offset-2">Not {first}? Reply for someone else</button>}
        </div>
        {onWithdraw && <YourData onWithdraw={onWithdraw} />}
      </div>
    </Panel>
  )
}

/** What the guest gave, taken back with their own link: stop news and offers, or erase their data. */
function YourData({ onWithdraw }) {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const run = async (scope) => {
    setBusy(true)
    setNote('')
    const out = await onWithdraw(scope)
    setBusy(false)
    if (out?.ok) setNote(scope === 'marketing' ? 'Done. We will not keep your details for news and offers.' : '')
    else setNote(out?.message || 'That did not go through. Please try again.')
    setAsking(false)
  }
  return (
    <div className="mt-5 border-t pt-3 text-xs" style={{ borderColor: 'color-mix(in srgb, currentColor 15%, transparent)' }}>
      <div className="opacity-60">Your data</div>
      {asking ? (
        <div className="mt-2 space-y-2">
          <p className="opacity-80">This removes your name, phone, email and answers from this event and cancels your QR code and link. We keep only that someone was counted. It cannot be undone.</p>
          <div className="flex justify-center gap-4">
            <button type="button" disabled={busy} onClick={() => run('all')} className="underline underline-offset-2 disabled:opacity-50">Yes, delete my data</button>
            <button type="button" disabled={busy} onClick={() => setAsking(false)} className="underline underline-offset-2 opacity-70">Keep it</button>
          </div>
        </div>
      ) : (
        <div className="mt-1 flex flex-wrap justify-center gap-4 opacity-70">
          <button type="button" disabled={busy} onClick={() => run('marketing')} className="underline underline-offset-2 disabled:opacity-50">Stop news and offers</button>
          <button type="button" disabled={busy} onClick={() => setAsking(true)} className="underline underline-offset-2">Delete my data</button>
        </div>
      )}
      {note && <p role="status" className="mt-2 opacity-80">{note}</p>}
    </div>
  )
}
