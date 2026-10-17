// Send invitations (Invitations v2, D9/D11), shared by Oscenia staff (Event → Send invitations)
// and the client's link (clientMode). Two ways to send, both only once the invitation is live:
//   - Oscenia sends from the platform, by WhatsApp and/or email, with a custom message (staff
//     only). Simulated in the prototype, like the reminders.
//   - The client sends each guest their own link from their own WhatsApp (a wa.me link with
//     the message typed in), or copies it; each one sent is marked "Sent by client".
// Both work from the guest list staff imported (D10). The clipboard and the page's origin are
// only touched in effects and click handlers: the smoke test renders this on the server.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Send, CalendarClock, MessageCircle, Mail, RotateCw, Copy, Check, X, ChevronDown, ChevronUp, Info } from 'lucide-react'
import { Card, StatCard, FilterPill, TableWrap, DEMO_TODAY } from '../ui'
import { useProto, demoNow } from '../../store/chatProto'
import { useStore } from '../../store/useStore'
import { ROLES } from '../../lib/roles'
import { personalLink, guestCategory, GUEST_CATEGORIES, normPhone } from '../../lib/events'
import {
  broadcastAudience, broadcastProblem, statusCounts, inviteMessage, waLink, audienceLabel,
  BROADCAST_CHANNELS, BROADCAST_LIMITS, PLACEHOLDERS, DEFAULT_INVITE_MESSAGE, DEFAULT_INVITE_SUBJECT,
} from '../../lib/broadcasts'
import { stamp } from '../workspace/parts'
import { useT } from '../../i18n'

const STATUS_TONE = {
  queued: 'border-white/20 bg-white/10 text-white/60',
  sent: 'border-sky-500/30 bg-sky-500/15 text-sky-300',
  delivered: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  read: 'border-emerald-400/40 bg-emerald-400/20 text-emerald-200',
  failed: 'border-rose-500/30 bg-rose-500/15 text-rose-300',
  scheduled: 'border-amber-500/30 bg-amber-500/15 text-amber-300',
  cancelled: 'border-white/20 bg-white/5 text-white/45',
}
const STATUS_LABEL = { queued: 'Queued', sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Failed', scheduled: 'Scheduled', cancelled: 'Cancelled' }

function Pill({ status, children }) {
  const t = useT()
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] ${STATUS_TONE[status] || STATUS_TONE.queued}`}>
      {t(STATUS_LABEL[status] || status)}{children}
    </span>
  )
}

// Narrower cell padding on a phone, so the guest table fits the screen.
const TIGHT = 'max-sm:px-2'

const toast = (title, body, kind = 'project') => useStore.getState().pushToast({ title, body, kind })

async function copyText(text, title, body, t) {
  try {
    await navigator.clipboard.writeText(text)
    toast(title, body)
  } catch {
    toast(t('Copy failed'), text, 'redflag')
  }
}

// The day after the demo's today at 09:00: a sensible first choice for a scheduled batch.
const tomorrowAt9 = () => {
  const d = new Date(`${DEMO_TODAY}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return `${d.toISOString().slice(0, 10)}T09:00`
}

export default function SendInvitations({ event, clientMode = false }) {
  const t = useT()
  // Select the stored array and filter outside the selector (see RemindersTab).
  const all = useProto((s) => s.guests)
  const guests = useMemo(() => all.filter((g) => g.eventId === event.id), [all, event.id])
  // Each guest's link goes into a message, so it is a full URL; the origin only exists in the browser.
  const path = `${import.meta.env.BASE_URL}invite/${event.id}`
  const [link, setLink] = useState(path)
  useEffect(() => { setLink(`${window.location.origin}${path}`) }, [path])

  if (event.status !== 'Published') {
    return (
      <Card className="text-sm text-white/60">
        {t(clientMode
          ? 'Once Oscenia publishes your invitation, you can send each guest their own link from here.'
          : 'Publish the invitation first — until then guests cannot open their links.')}
      </Card>
    )
  }

  const listed = broadcastAudience(guests, 'all')
  const invited = listed.filter((g) => g.invitedAt)
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard label="On the guest list" value={listed.length} />
        <StatCard label="Invited" value={`${invited.length} / ${listed.length}`} />
        <StatCard label="Sent by Oscenia" value={invited.filter((g) => g.invitedVia === 'platform').length} />
        <StatCard label="Sent by client" value={invited.filter((g) => g.invitedVia === 'client').length} />
        <StatCard label="Not invited yet" value={listed.length - invited.length} />
      </div>
      {!clientMode && <PlatformSend event={event} guests={guests} link={link} />}
      <GuestLinks event={event} guests={listed} link={link} clientMode={clientMode} />
    </div>
  )
}

// --- the message editor -----------------------------------------------------------------

function MessageEditor({ value, onChange, label }) {
  const t = useT()
  const ref = useRef(null)
  // A chip goes in where the cursor is (or at the end), and the cursor follows it.
  const insert = (ph) => {
    const el = ref.current
    const at = el ? el.selectionStart : value.length
    const end = el ? el.selectionEnd : value.length
    const next = (value.slice(0, at) + ph + value.slice(end)).slice(0, BROADCAST_LIMITS.message)
    onChange(next)
    requestAnimationFrame(() => { if (el) { el.focus(); el.setSelectionRange(at + ph.length, at + ph.length) } })
  }
  return (
    <div>
      <label className="text-[11px] uppercase tracking-wider text-white/35" htmlFor="invite-message">{t(label)}</label>
      <textarea id="invite-message" ref={ref} value={value} onChange={(e) => onChange(e.target.value)} rows={4} maxLength={BROADCAST_LIMITS.message}
        className="mt-1 w-full rounded-lg border border-white/10 bg-navy-950 p-2.5 text-sm text-white/85 outline-none focus:border-gold/50" />
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-white/35">{t('Insert')}:</span>
        {PLACEHOLDERS.map((ph) => (
          <button key={ph} type="button" onClick={() => insert(ph)} className="rounded-md border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[11px] text-gold-light hover:border-gold/40">{ph}</button>
        ))}
        <span className="ml-auto text-[11px] tabular-nums text-white/35">{value.length} / {BROADCAST_LIMITS.message}</span>
      </div>
    </div>
  )
}

// --- Oscenia sends (staff only) ---------------------------------------------------------------

function PlatformSend({ event, guests, link }) {
  const t = useT()
  const role = useStore((s) => s.role)
  const live = useProto((s) => s.live)
  const batches = event.broadcasts || []
  const last = batches.at(-1)
  const [channel, setChannel] = useState('both')
  const [subject, setSubject] = useState(() => last?.subject || DEFAULT_INVITE_SUBJECT)
  const [message, setMessage] = useState(() => last?.message || DEFAULT_INVITE_MESSAGE)
  const [audience, setAudience] = useState(() => (broadcastAudience(guests, 'not_invited').length ? 'not_invited' : 'all'))
  const [when, setWhen] = useState('now')
  const [scheduledAt, setScheduledAt] = useState(tomorrowAt9)
  const [previewId, setPreviewId] = useState('')

  const form = { channel, subject, message, audience, scheduledAt: when === 'later' ? scheduledAt : null }
  const problem = broadcastProblem(event, guests, form)
  const reach = broadcastAudience(guests, audience)
  const options = [['all', 'All guests'], ['not_invited', 'Not invited yet'], ...GUEST_CATEGORIES.map((c) => [c, c])]
  const sample = reach.find((g) => g.id === previewId) || reach[0] || broadcastAudience(guests, 'all')[0]
  const text = sample ? inviteMessage(message, event, sample, personalLink(link, sample)) : ''
  const email = channel !== 'whatsapp'

  const send = () => {
    const p = useProto.getState()
    const id = p.sendBroadcast(event.id, { ...form, by: ROLES[role]?.name || 'Oscenia staff' })
    if (!id) {
      toast(t('Not sent'), t(broadcastProblem(event, guests, form, demoNow()) || 'Check the message and try again.'), 'redflag')
      return
    }
    const b = useProto.getState().events.find((e) => e.id === event.id).broadcasts.find((x) => x.id === id)
    if (b.status === 'scheduled') {
      toast(t('Scheduled'), `${t('For')} ${stamp(b.scheduledAt)} · ${t('with the backend, it sends automatically')}`, 'cron')
    } else {
      const c = statusCounts(b.recipients)
      const n = new Set(b.recipients.map((r) => r.guestId)).size
      toast(`${t('Sent (simulated)')} · ${n} ${t(n === 1 ? 'guest' : 'guests')}`, `${c.read + c.delivered + c.sent} ${t('messages went out')}, ${c.failed} ${t('failed')}`, 'cron')
    }
  }

  return (
    <>
      <div className="flex items-start gap-2 rounded-lg border border-sky-400/20 bg-sky-400/5 p-3 text-xs text-sky-100/80">
        <Info size={14} className="mt-0.5 shrink-0" />
        <span>{live
          ? t('Not connected yet: sending needs a WhatsApp Business API provider and an email service, so nothing can be sent from here and the send buttons will say so. Guest links work once the guest page is connected to the server.')
          : t('Simulated — nothing is actually sent. Real WhatsApp sending needs a WhatsApp Business API provider and real email an email service; both come with the backend.')}</span>
      </div>
      <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
        <Card className="space-y-4">
          <div className="eyebrow">{t('Send from Oscenia')}</div>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('Channel')}>
            {Object.entries(BROADCAST_CHANNELS).map(([k, v]) => (
              <FilterPill key={k} active={channel === k} onClick={() => setChannel(k)}>{t(v)}</FilterPill>
            ))}
          </div>
          {email && (
            <div>
              <label className="text-[11px] uppercase tracking-wider text-white/35" htmlFor="invite-subject">{t('Email subject')}</label>
              <input id="invite-subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={BROADCAST_LIMITS.subject}
                className="mt-1 w-full rounded-lg border border-white/10 bg-navy-950 p-2.5 text-sm text-white/85 outline-none focus:border-gold/50" />
            </div>
          )}
          <MessageEditor value={message} onChange={setMessage} label="Message" />
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <label className="text-[11px] uppercase tracking-wider text-white/35" htmlFor="invite-audience">{t('Send to')}</label>
              <select id="invite-audience" value={audience} onChange={(e) => setAudience(e.target.value)}
                className="mt-1 block rounded-lg border border-white/10 bg-navy-950 px-2.5 py-2 text-sm text-white/85">
                {options.map(([k, label]) => <option key={k} value={k}>{t(label)} ({broadcastAudience(guests, k).length})</option>)}
              </select>
            </div>
            <div className="flex items-center gap-3 text-sm text-white/70">
              <label className="flex items-center gap-1.5"><input type="radio" name="invite-when" className="accent-[#c6a15b]" checked={when === 'now'} onChange={() => setWhen('now')} />{t('Send now')}</label>
              <label className="flex items-center gap-1.5"><input type="radio" name="invite-when" className="accent-[#c6a15b]" checked={when === 'later'} onChange={() => setWhen('later')} />{t('Schedule')}</label>
              {when === 'later' && (
                <input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} aria-label={t('Send at')}
                  className="rounded-lg border border-white/10 bg-navy-950 px-2 py-1.5 text-sm text-white/85" />
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3 border-t border-white/5 pt-3">
            <span className={`text-xs ${problem ? 'text-amber-300' : 'text-white/50'}`}>
              {problem ? t(problem) : `${reach.length} ${t('guests')} · ${reach.length * (channel === 'both' ? 2 : 1)} ${t('messages')}`}
            </span>
            <button className="btn-gold ml-auto" disabled={Boolean(problem)} onClick={send}>
              {when === 'later' ? <><CalendarClock size={15} />{t('Schedule')}</> : <><Send size={15} />{t('Send now')}</>}
            </button>
          </div>
        </Card>

        <Card>
          <div className="mb-2 flex items-center gap-2">
            <div className="eyebrow">{t('Preview')}</div>
            {reach.length > 0 && (
              <select value={sample?.id || ''} onChange={(e) => setPreviewId(e.target.value)} aria-label={t('Preview for')}
                className="ml-auto max-w-[200px] rounded-md border border-white/10 bg-navy-950 px-2 py-1 text-xs text-white/80">
                {reach.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            )}
          </div>
          {!sample && <div className="text-sm text-white/35">{t('No guests on the list yet — import them under Guests & RSVP.')}</div>}
          {sample && channel !== 'email' && (
            <div className="mb-3">
              <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-emerald-300/70"><MessageCircle size={11} /> WhatsApp · {sample.phone}</div>
              <div data-testid="preview-wa" className="whitespace-pre-wrap break-words rounded-lg rounded-tl-none border border-emerald-500/15 bg-emerald-500/10 p-3 text-xs text-white/80">{text}</div>
            </div>
          )}
          {sample && email && (
            <div>
              <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-sky-300/70"><Mail size={11} /> {t('Email')} · {sample.email || t('no email address')}</div>
              <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3 text-xs text-white/80">
                <div className="mb-2 border-b border-white/5 pb-2 font-medium text-white/90">{inviteMessage(subject, event, sample, '')}</div>
                <div className="whitespace-pre-wrap break-words">{text}</div>
              </div>
            </div>
          )}
        </Card>
      </div>

      <div>
        <div className="eyebrow mb-2">{t('Sent and scheduled')}</div>
        <div className="space-y-3">
          {[...batches].reverse().map((b) => <Batch key={b.id} event={event} batch={b} guests={guests} />)}
          {batches.length === 0 && <Card className="text-sm text-white/35">{t('Nothing sent from Oscenia yet.')}</Card>}
        </div>
      </div>
    </>
  )
}

/** One batch in the history: its outcome, its recipients, and what can still be done with it. */
function Batch({ event, batch: b, guests }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const c = statusCounts(b.recipients)
  const byId = new Map(guests.map((g) => [g.id, g]))
  // Failed first: they are the ones to act on.
  const rows = [...b.recipients].sort((x, y) => (y.status === 'failed') - (x.status === 'failed'))
  const p = useProto.getState()

  const retry = () => {
    const n = p.retryFailed(event.id, b.id)
    if (n) toast(`${t('Sent again (simulated)')} · ${n}`, t('Those still failing need their details fixed first.'), 'cron')
    else toast(t('Still failing'), t('Fix the guest’s phone or email first, then retry.'), 'redflag')
  }
  const sendNow = () => {
    const n = p.sendScheduledNow(event.id, b.id)
    if (n) toast(`${t('Sent (simulated)')} · ${n} ${t(n === 1 ? 'guest' : 'guests')}`, `${t('Invitation')} · ${t(audienceLabel(b.audience))}`, 'cron')
    else toast(t('Not sent'), t('Nobody to send to in this group.'), 'redflag')
  }

  return (
    <Card className={b.status === 'cancelled' ? 'opacity-60' : ''}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-white/90">{t('Invitation')} · {t(BROADCAST_CHANNELS[b.channel])} · {t(audienceLabel(b.audience))}</span>
        <Pill status={b.status} />
        <span className="text-[11px] text-white/40">
          {b.status === 'sent' ? `${stamp(b.sentAt)} · ${b.by}` : b.status === 'scheduled' ? `${t('For')} ${stamp(b.scheduledAt)} · ${b.by}` : `${t('Was for')} ${stamp(b.scheduledAt)}`}
        </span>
        <div className="ml-auto flex flex-wrap gap-2">
          {b.status === 'scheduled' && (
            <>
              <button className="btn-gold !py-1.5 text-xs" onClick={sendNow}><Send size={13} />{t('Send now')}</button>
              <button className="btn-ghost !py-1.5 text-xs" onClick={() => p.cancelBroadcast(event.id, b.id)}><X size={13} />{t('Cancel')}</button>
            </>
          )}
          {b.status === 'sent' && c.failed > 0 && (
            <button className="btn-ghost !py-1.5 text-xs" onClick={retry}><RotateCw size={13} />{t('Retry failed')} ({c.failed})</button>
          )}
        </div>
      </div>
      {b.status === 'scheduled' && <p className="mt-1 text-[11px] text-white/35">{t('Prototype: the demo stays on one day, so press Send now. With the backend, it sends automatically at this time.')}</p>}
      <p className="mt-2 line-clamp-2 text-xs text-white/50">{b.message}</p>
      {b.status === 'sent' && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {['read', 'delivered', 'sent', 'failed'].filter((s) => c[s]).map((s) => <Pill key={s} status={s}><span className="ml-1 tabular-nums">{c[s]}</span></Pill>)}
          <button className="ml-auto inline-flex items-center gap-1 text-xs text-white/50 hover:text-gold-light" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}{t(open ? 'Hide recipients' : 'Show recipients')} ({b.recipients.length})
          </button>
        </div>
      )}
      {open && (
        <div className="mt-3 max-h-[420px] overflow-y-auto">
          <TableWrap>
            <thead>
              <tr>
                <th className="th text-left">{t('Guest')}</th>
                <th className="th text-left">{t('Channel')}</th>
                <th className="th text-left">{t('Status')}</th>
                <th className="th text-left">{t('Detail')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const g = byId.get(r.guestId)
                return (
                  <tr key={`${r.guestId}:${r.channel}`} className="border-t border-white/5">
                    <td className="td text-sm text-white/85">{g?.name || r.guestId}</td>
                    <td className="td text-xs text-white/60">{r.channel === 'email' ? t('Email') : 'WhatsApp'}</td>
                    <td className="td"><Pill status={r.status} /></td>
                    <td className="td text-xs text-white/50">
                      {r.status === 'failed' ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-rose-300/90">{t(r.reason)}</span>
                          {r.channel === 'email' && g && <FixEmail guest={g} />}
                        </div>
                      ) : stamp(r.at)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </TableWrap>
        </div>
      )}
    </Card>
  )
}

/** Adds the email a failed message was missing, so Retry can reach the guest. */
function FixEmail({ guest }) {
  const t = useT()
  const [value, setValue] = useState(guest.email || '')
  const save = async () => {
    if (await useProto.getState().setGuestEmail(guest.id, value)) toast(t('Email saved'), `${guest.name} — ${t('now press Retry failed')}`)
    else toast(t('Not saved'), t('That does not look like an email address.'), 'redflag')
  }
  return (
    <span className="inline-flex items-center gap-1">
      <input value={value} onChange={(e) => setValue(e.target.value)} placeholder={t('Add email')} aria-label={`${t('Email for')} ${guest.name}`}
        className="w-44 rounded-md border border-white/10 bg-navy-950 px-2 py-1 text-xs text-white/85 outline-none focus:border-gold/50" />
      <button className="btn-ghost !px-2 !py-1 text-xs" onClick={save} disabled={!value.trim() || value.trim() === guest.email}>{t('Save')}</button>
    </span>
  )
}

// --- each guest's own link (the client sends; staff see who has it) ----------------------------

function GuestLinks({ event, guests, link, clientMode }) {
  const t = useT()
  const [message, setMessage] = useState(DEFAULT_INVITE_MESSAGE)
  const [filter, setFilter] = useState('all')
  const shown = filter === 'all' ? guests : guests.filter((g) => !g.invitedAt)
  const mark = (g) => useProto.getState().markSentByClient(event.id, g.id)
  const status = (g) => {
    if (!g.invitedAt) return <span className="text-xs text-white/35">{t('Not sent yet')}</span>
    const who = g.invitedVia === 'client' ? (clientMode ? 'Sent by you' : 'Sent by client') : 'Sent by Oscenia'
    return (
      <span className={`inline-flex flex-wrap items-center gap-1 text-xs ${g.invitedVia === 'client' ? 'text-gold-light' : 'text-emerald-300'}`}>
        <Check size={12} className="shrink-0" />{t(who)} <span className="text-white/35 max-sm:w-full">· {stamp(g.invitedAt)}</span>
      </span>
    )
  }
  const copyAll = () => copyText(shown.map((g) => `${g.name}: ${personalLink(link, g)}`).join('\n'), t('All links copied'), `${shown.length} ${t('guests, one per line')}`, t)

  return (
    <div className="space-y-3">
      {clientMode ? (
        <Card className="space-y-3">
          <div className="eyebrow">{t('Send from your WhatsApp')}</div>
          <p className="text-sm text-white/60">
            {t('Each guest gets their own link: it opens the invitation with their name on it, their RSVP and their QR code. WhatsApp opens with the message typed in — press send there.')}
          </p>
          <MessageEditor value={message} onChange={setMessage} label="Your message" />
          {!message.includes('{link}') && <p className="text-xs text-amber-300">{t('Put {link} in the message — it becomes each guest’s own invitation link.')}</p>}
        </Card>
      ) : (
        <div className="eyebrow">{t('Each guest’s own link')}</div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <FilterPill active={filter === 'all'} onClick={() => setFilter('all')}>{t('All')} · {guests.length}</FilterPill>
        <FilterPill active={filter === 'pending'} onClick={() => setFilter('pending')}>{t('Not invited yet')} · {guests.filter((g) => !g.invitedAt).length}</FilterPill>
        <span className="ml-auto text-xs text-white/50">{guests.filter((g) => g.invitedAt).length} {t('of')} {guests.length} {t('guests invited')}</span>
        <button className="btn-ghost !py-1.5 text-xs" disabled={!shown.length} onClick={copyAll}><Copy size={13} />{t('Copy all links')}</button>
      </div>
      {/* Not TableWrap: on a phone this table fits the screen instead of scrolling sideways, so
          the WhatsApp button is in reach. Category and the link column wait for a wider screen;
          the client's message (Copy) carries the link, and staff get a copy-link button. */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full sm:min-w-[560px]">
            <thead>
              <tr>
                <th className={`th text-left ${TIGHT}`}>{t('Guest')}</th>
                <th className="th hidden text-left sm:table-cell">{t('Category')}</th>
                <th className={`th text-left ${TIGHT}`}>{t('Invitation')}</th>
                <th className="th hidden text-left sm:table-cell">{t('Personal link')}</th>
                <th className={`th ${TIGHT}`}><span className="sr-only">{t('Send')}</span></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((g) => {
                const url = personalLink(link, g)
                const text = inviteMessage(message, event, g, url)
                const phoneOk = normPhone(g.phone || '').length >= 8
                return (
                  <tr key={g.id} className="border-t border-white/5" data-guest={g.id}>
                    <td className={`td ${TIGHT}`}>
                      <div className="text-sm text-white/85">{g.name}</div>
                      <div className="text-[11px] text-white/40">{g.phone}</div>
                    </td>
                    <td className="td hidden text-xs text-white/60 sm:table-cell">{t(guestCategory(g))}</td>
                    <td className={`td ${TIGHT}`}>{status(g)}</td>
                    <td className="td hidden max-w-[220px] sm:table-cell">
                      <button className="flex max-w-full items-center gap-1 text-left text-[11px] text-white/50 hover:text-gold-light" title={t('Copy personal link')}
                        onClick={() => copyText(url, t('Personal link copied'), g.name, t)}>
                        <Copy size={12} className="shrink-0" /><span className="truncate font-mono">{url.replace(/^https?:\/\//, '')}</span>
                      </button>
                    </td>
                    <td className={`td whitespace-nowrap text-right ${TIGHT}`}>
                      {!clientMode && (
                        <button className="btn-ghost !px-2 !py-1 text-xs sm:hidden" aria-label={`${t('Copy personal link')} — ${g.name}`}
                          onClick={() => copyText(url, t('Personal link copied'), g.name, t)}><Copy size={13} /></button>
                      )}
                      {clientMode && (
                        <div className="flex justify-end gap-1.5">
                          {phoneOk ? (
                            <a className="btn-gold !px-2.5 !py-1 text-xs" href={waLink(g.phone, text)} target="_blank" rel="noreferrer" onClick={() => mark(g)}
                              aria-label={`WhatsApp ${g.name}`}>
                              <MessageCircle size={13} /><span className="max-sm:hidden">WhatsApp</span>
                            </a>
                          ) : (
                            <button className="btn-gold !px-2.5 !py-1 text-xs" disabled title={t('No phone number')} aria-label={`WhatsApp — ${t('No phone number')}`}><MessageCircle size={13} /><span className="max-sm:hidden">WhatsApp</span></button>
                          )}
                          <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => copyText(text, t('Message copied'), `${g.name} — ${t('paste it into any chat')}`, t)}
                            aria-label={`${t('Copy message')} — ${g.name}`} title={t('Copy message')}><Copy size={13} /></button>
                          {g.invitedVia !== 'client' && (
                            <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => mark(g)} aria-label={`${t('Mark as sent')} — ${g.name}`} title={t('Mark as sent')}><Check size={13} /></button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
              {shown.length === 0 && <tr><td colSpan={5} className="td text-center text-sm text-white/35">{t(guests.length ? 'Everyone has their invitation.' : 'No guests on the list yet. Send your list to Oscenia and they will add it.')}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {clientMode && <p className="text-[11px] text-white/35">{t('“Sent by you” is ticked when you open WhatsApp for a guest; tick it yourself for links you sent another way. Oscenia can also send the invitations for you.')}</p>}
    </div>
  )
}
