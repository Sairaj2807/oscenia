// The invitation's sections (lib/templates.js SECTIONS), written once and themed by the CSS
// variables InviteRenderer sets: --inv-bg, --inv-surface, --inv-accent, --inv-text,
// --inv-heading, --inv-body, --inv-script. Each section gets `{ c, ctx }`: the invitation's
// content and the render context (template, guest, mode, compact, slots).
import { useEffect, useState } from 'react'
import { CalendarDays, Clock, MapPin, Shirt, Instagram, Gift, Video as VideoIcon } from 'lucide-react'
import { Ornament, Corners, GRID_BG } from './ornaments'
import { longDate, countdownTo, videoEmbed, visibleWishes } from '../../lib/invites'
import { safeLink } from '../../lib/events'
import { useMediaUrl, Img } from './media'
import { demoNow } from '../../store/useProto'

const accent = { color: 'var(--inv-accent)' }
const heading = { fontFamily: 'var(--inv-heading)' }
const script = { fontFamily: 'var(--inv-script)' }
const surface = { background: 'var(--inv-surface)' }
const line = { borderColor: 'color-mix(in srgb, var(--inv-text) 15%, transparent)' }

/** A section's frame: title in the template's heading font with its ornament beneath. */
function Frame({ ctx, title, children, id }) {
  return (
    <section id={id} className={`mx-auto max-w-2xl ${ctx.compact ? 'px-6 py-12' : 'px-6 py-14 sm:px-10 sm:py-16'}`}>
      {title && (
        <div className="mb-8 flex flex-col items-center text-center">
          <h2 style={heading} className={`${ctx.compact ? 'text-2xl' : 'text-2xl sm:text-3xl'} tracking-wide`}>{title}</h2>
          <TplOrnament tpl={ctx.tpl} className="mt-3" />
        </div>
      )}
      {children}
    </section>
  )
}

/** The template's ornament: the design team's uploaded artwork if it has one, else the SVG. */
function TplOrnament({ tpl, className }) {
  const svg = <Ornament kind={tpl.ornament} className={className} />
  if (!tpl.art?.ornament) return svg
  return <Img src={tpl.art.ornament} className={`h-8 w-auto max-w-[12rem] object-contain ${className}`} fallback={svg} />
}

/** A studio template's frame artwork (a transparent PNG) laid over the whole cover. */
function FrameArt({ tpl }) {
  if (!tpl.art?.frame) return null
  return <Img src={tpl.art.frame} className="pointer-events-none absolute inset-0 h-full w-full object-fill" />
}

/** A stand-in photo for the gallery's sample previews: a soft gradient in the template's colours. */
export function ArtTile({ i = 0, className = '' }) {
  const angle = (i * 47) % 360
  return (
    <div className={className} aria-hidden
      style={{ background: `linear-gradient(${angle}deg, color-mix(in srgb, var(--inv-accent) 55%, var(--inv-bg)), color-mix(in srgb, var(--inv-accent) 12%, var(--inv-surface)))` }} />
  )
}

// --- cover -------------------------------------------------------------------

export function Cover({ c, ctx }) {
  const { tpl, guest, compact } = ctx
  const { url: img } = useMediaUrl(c.cover.image)
  // Behind the cover: the client's photo, else the design team's cover artwork, else the gradient.
  const { url: art } = useMediaUrl(tpl.art?.coverBg)
  const plain = art ? `url("${art}") center/cover` : tpl.coverBg
  const bg = img ? `url("${img}") center/cover` : plain
  const title = c.cover.title || ctx.eventName
  const greet = guest && (
    <div className="mb-6 text-sm opacity-80">
      <div className="text-[10px] uppercase tracking-[0.3em] opacity-70">Dear</div>
      <div style={heading} className="mt-1 text-lg">{guest.name}</div>
    </div>
  )
  // The guest page's gate (slots.open) shows the cover alone, filling the screen.
  const open = ctx.slots?.open || null
  const tall = open ? 'min-h-[100dvh]' : compact ? 'min-h-[560px]' : 'min-h-[600px] sm:min-h-[680px]'
  const eyebrow = c.cover.eyebrow && <div style={accent} className="text-[11px] uppercase tracking-[0.35em]">{c.cover.eyebrow}</div>
  const subtitle = c.cover.subtitle && <div className="mt-3 text-lg opacity-80">{c.cover.subtitle}</div>

  if (tpl.cover === 'fullbleed') {
    return (
      <header style={{ background: bg }} className={`relative flex ${tall} items-end`}>
        <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg, transparent 30%, rgba(0,0,0,.55))' }} />
        <FrameArt tpl={tpl} />
        <div className={`relative w-full ${compact ? 'p-6' : 'p-6 sm:p-12'} text-white`}>
          {greet}
          <div className="text-[11px] uppercase tracking-[0.35em] opacity-90">{c.cover.eyebrow}</div>
          <h1 style={heading} className={`mt-3 font-bold uppercase leading-[0.95] ${compact ? 'text-4xl' : 'text-5xl sm:text-7xl'}`}>{title}</h1>
          {c.cover.subtitle && <div className="mt-4 text-lg opacity-90">{c.cover.subtitle}</div>}
          {open}
        </div>
      </header>
    )
  }

  if (tpl.cover === 'split') {
    return (
      <header className={`relative grid ${compact ? '' : 'sm:grid-cols-2'} ${tall}`}>
        <FrameArt tpl={tpl} />
        <div style={{ background: bg }} className={compact ? 'h-72' : 'h-72 sm:h-auto sm:order-2'} />
        <div className={`relative flex flex-col justify-center ${compact ? 'p-8' : 'p-8 sm:p-14'}`} style={tpl.ornament === 'grid' ? { background: GRID_BG } : undefined}>
          {greet}
          {eyebrow}
          <h1 style={heading} className={`mt-4 leading-tight ${compact ? 'text-4xl' : 'text-4xl sm:text-5xl'}`}>{title}</h1>
          {subtitle}
          <div style={{ background: 'var(--inv-accent)' }} className="mt-6 h-1 w-14" />
          {open && <div>{open}</div>}
        </div>
      </header>
    )
  }

  if (tpl.cover === 'framed') {
    return (
      <header style={{ background: bg }} className={`relative flex ${tall} items-center justify-center p-5`}>
        {img && <div className="absolute inset-0" style={{ background: 'color-mix(in srgb, var(--inv-bg) 55%, transparent)' }} />}
        <FrameArt tpl={tpl} />
        <div className="relative flex w-full max-w-xl flex-col items-center border px-6 py-14 text-center" style={{ borderColor: 'var(--inv-accent)', outline: '1px solid color-mix(in srgb, var(--inv-accent) 45%, transparent)', outlineOffset: '6px' }}>
          {greet}
          {eyebrow}
          <h1 style={heading} className={`mt-5 leading-tight ${compact ? 'text-3xl' : 'text-4xl sm:text-5xl'}`}>{title}</h1>
          {subtitle}
          <TplOrnament tpl={tpl} className="mt-7" />
          {open}
        </div>
      </header>
    )
  }

  // centered (Royal, Garden): an arched photo and the names in script.
  return (
    <header style={{ background: plain }} className={`relative flex ${tall} flex-col items-center justify-center overflow-hidden px-6 py-14 text-center`}>
      <Corners kind={tpl.ornament} />
      <FrameArt tpl={tpl} />
      {greet}
      {eyebrow}
      <div className="relative mt-6 h-56 w-44 overflow-hidden rounded-t-full border-4" style={{ borderColor: 'var(--inv-surface)' }}>
        {img ? <img src={img} alt="" className="h-full w-full object-cover" /> : <ArtTile i={3} className="h-full w-full" />}
      </div>
      <h1 style={script} className={`mt-6 leading-tight ${compact ? 'text-5xl' : 'text-5xl sm:text-6xl'}`}>{title}</h1>
      {subtitle}
      <TplOrnament tpl={tpl} className="mt-5" />
      {open}
    </header>
  )
}

// --- words -------------------------------------------------------------------

export function Message({ c, ctx }) {
  return (
    <Frame ctx={ctx}>
      <p className="whitespace-pre-line text-center text-lg leading-relaxed opacity-85">{c.message.body}</p>
    </Frame>
  )
}

export function Couple({ c, ctx }) {
  const person = (p, k) => p.name?.trim() && (
    <div key={k} className="flex flex-col items-center text-center">
      <div className="h-36 w-36 overflow-hidden rounded-full border-4" style={{ borderColor: 'var(--inv-accent)' }}>
        <Img src={p.photo} className="h-full w-full object-cover" fallback={<ArtTile i={k === 'a' ? 1 : 5} className="h-full w-full" />} />
      </div>
      <div style={script} className="mt-4 text-3xl">{p.name}</div>
      {p.parents && <div className="mt-2 max-w-[16rem] text-sm opacity-75">{p.parents}</div>}
      {p.ig && <div className="mt-2 flex items-center gap-1 text-xs opacity-75" style={accent}><Instagram size={13} />@{p.ig.replace(/^@/, '')}</div>}
    </div>
  )
  return (
    <Frame ctx={ctx} title="The couple">
      <div className={`grid gap-10 ${ctx.compact ? '' : 'sm:grid-cols-2'}`}>
        {person(c.couple.a, 'a')}
        {person(c.couple.b, 'b')}
      </div>
    </Frame>
  )
}

export function Hosts({ c, ctx }) {
  const logos = c.hosts.logos || []
  return (
    <Frame ctx={ctx}>
      {logos.length > 0 && (
        <div className="mb-5 flex flex-wrap items-center justify-center gap-6">
          {logos.map((l, i) => <Img key={l.key || i} src={l} className="h-12 max-w-[9rem] object-contain" />)}
        </div>
      )}
      {c.hosts.names && <p className="text-center text-sm uppercase tracking-[0.2em] opacity-75">{c.hosts.names}</p>}
    </Frame>
  )
}

// --- when & where --------------------------------------------------------------

export function Countdown({ c, ctx }) {
  const { date, time } = c.details
  const [now, setNow] = useState(() => demoNow())
  useEffect(() => {
    const t = setInterval(() => setNow(demoNow()), 30_000)
    return () => clearInterval(t)
  }, [])
  const left = countdownTo(date, time, now)
  // Once the event has begun there is nothing to count down to: the section steps aside.
  if (!left) return null
  return (
    <Frame ctx={ctx} title="Counting down">
      <div className="grid grid-cols-3 gap-3 text-center">
          {[['Days', left.days], ['Hours', left.hours], ['Minutes', left.minutes]].map(([k, v]) => (
            <div key={k} style={surface} className="rounded-xl py-5">
              <div style={{ ...heading, ...accent }} className="text-4xl tabular-nums">{v}</div>
              <div className="mt-1 text-[10px] uppercase tracking-[0.25em] opacity-60">{k}</div>
            </div>
          ))}
      </div>
      {ctx.slots?.calendar}
    </Frame>
  )
}

function Session({ s, label }) {
  const map = safeLink(s.mapUrl || '')
  return (
    <div style={surface} className="rounded-xl p-6 text-center">
      {label && <div style={{ ...heading, ...accent }} className="mb-3 text-lg tracking-wide">{label}</div>}
      <div className="space-y-2 text-sm">
        {s.date && <div className="flex items-center justify-center gap-2"><CalendarDays size={15} style={accent} />{longDate(s.date)}</div>}
        {s.time && <div className="flex items-center justify-center gap-2"><Clock size={15} style={accent} />{s.time}</div>}
        {s.venue && <div className="flex items-start justify-center gap-2"><MapPin size={15} style={accent} className="mt-0.5 shrink-0" /><span>{s.venue}</span></div>}
      </div>
      {map && (
        <a href={map} target="_blank" rel="noreferrer" className="mt-4 inline-block rounded-full border px-4 py-1.5 text-xs uppercase tracking-[0.2em]" style={{ borderColor: 'var(--inv-accent)', color: 'var(--inv-accent)' }}>
          See location
        </a>
      )}
    </div>
  )
}

export function Details({ c, ctx }) {
  const d = c.details
  const sessions = (d.sessions || []).filter((s) => s.name?.trim() || s.venue?.trim())
  return (
    <Frame ctx={ctx} title={sessions.length ? 'The events' : 'Date & venue'}>
      <div className={`grid gap-4 ${sessions.length && !ctx.compact ? 'sm:grid-cols-2' : ''}`}>
        <Session s={d} label={sessions.length ? d.name || 'The event' : ''} />
        {sessions.map((s) => <Session key={s.id} s={s} label={s.name} />)}
      </div>
    </Frame>
  )
}

export function Agenda({ c, ctx }) {
  const rows = c.agenda.rows.filter((r) => r.label?.trim())
  return (
    <Frame ctx={ctx} title="Programme">
      <ol className="space-y-0">
        {rows.map((r, i) => (
          <li key={i} className="flex gap-5 border-b py-3 last:border-b-0" style={line}>
            <span style={accent} className="w-14 shrink-0 tabular-nums">{r.time}</span>
            <span className="opacity-85">{r.label}</span>
          </li>
        ))}
      </ol>
    </Frame>
  )
}

export function Speakers({ c, ctx }) {
  const people = c.speakers.people.filter((p) => p.name?.trim())
  return (
    <Frame ctx={ctx} title="Speakers">
      <div className={`grid gap-6 ${ctx.compact ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-3'}`}>
        {people.map((p, i) => (
          <div key={i} className="text-center">
            <div className="mx-auto h-24 w-24 overflow-hidden rounded-full">
              <Img src={p.photo} className="h-full w-full object-cover" fallback={(
                <div style={{ background: 'var(--inv-surface)', ...accent, ...heading }} className="flex h-full w-full items-center justify-center text-2xl">
                  {p.name.split(' ').map((w) => w[0]).slice(0, 2).join('')}
                </div>
              )} />
            </div>
            <div className="mt-3 font-medium">{p.name}</div>
            {p.role && <div className="text-xs opacity-65">{p.role}</div>}
          </div>
        ))}
      </div>
    </Frame>
  )
}

export function Story({ c, ctx }) {
  const items = c.story.items.filter((s) => s.title?.trim() || s.text?.trim())
  return (
    <Frame ctx={ctx} title="Our story">
      <ol className="relative ml-3 border-l pl-6" style={{ borderColor: 'var(--inv-accent)' }}>
        {items.map((s, i) => (
          <li key={i} className="relative pb-8 last:pb-0">
            <span className="absolute -left-[31px] top-1 h-3 w-3 rounded-full" style={{ background: 'var(--inv-accent)' }} />
            {s.date && <div style={accent} className="text-xs uppercase tracking-[0.2em]">{s.date}</div>}
            {s.title && <div style={heading} className="mt-1 text-xl">{s.title}</div>}
            {s.text && <p className="mt-1 text-sm leading-relaxed opacity-80">{s.text}</p>}
          </li>
        ))}
      </ol>
    </Frame>
  )
}

export function DressCode({ c, ctx }) {
  return (
    <Frame ctx={ctx}>
      <div className="flex flex-col items-center gap-2 text-center">
        <Shirt size={20} style={accent} />
        <div className="text-[10px] uppercase tracking-[0.3em] opacity-60">Dress code</div>
        <div style={heading} className="text-xl">{c.dresscode.text}</div>
      </div>
    </Frame>
  )
}

// --- media -------------------------------------------------------------------

export function Gallery({ c, ctx }) {
  const photos = ctx.mode === 'sample' ? [0, 1, 2, 3, 4, 5] : c.gallery.photos
  return (
    <Frame ctx={ctx} title="Gallery">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {photos.map((p, i) => (
          <button key={i} type="button" onClick={() => ctx.slots?.openPhoto?.(i)} className={`overflow-hidden rounded-lg ${i % 5 === 0 ? 'row-span-2' : ''}`} aria-label={`Photo ${i + 1}`}>
            {typeof p === 'number' ? <ArtTile i={p} className="h-full min-h-[8rem] w-full" />
              : <Img src={p} className="h-full min-h-[8rem] w-full object-cover" fallback={<ArtTile i={i} className="h-full min-h-[8rem] w-full opacity-40" />} />}
          </button>
        ))}
      </div>
    </Frame>
  )
}

export function Video({ c, ctx }) {
  const v = c.video
  const embed = v.kind === 'link' ? videoEmbed(v.url) : ''
  const { url: uploaded, missing, onError } = useMediaUrl(v.kind === 'upload' ? v.file : null)
  return (
    <Frame ctx={ctx} title="Watch">
      <div className="aspect-video overflow-hidden rounded-xl" style={surface}>
        {embed ? (
          <iframe src={embed} title="Video" className="h-full w-full" allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen loading="lazy" />
        ) : uploaded ? (
          <video src={uploaded} controls playsInline preload="metadata" onError={onError} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm opacity-70">
            <VideoIcon size={22} style={accent} />
            {v.kind === 'link' ? 'This video link can’t be played here. Use a YouTube or Vimeo link.'
              : missing ? 'This video can’t be played right now. Please try again later.' : 'Loading the video…'}
          </div>
        )}
      </div>
    </Frame>
  )
}

// --- replies -------------------------------------------------------------------

export function Rsvp({ ctx }) {
  return <Frame ctx={ctx} id="rsvp">{ctx.slots?.rsvp || <RsvpMock event={ctx.event} />}</Frame>
}

/** What the RSVP form looks like, for previews: not a working form. */
function RsvpMock({ event }) {
  const box = { ...line, borderWidth: 1 }
  const f = event?.rsvpFields || { email: true, pax: true }
  const qs = (event?.customFields || []).filter((q) => q.label?.trim())
  return (
    <div style={surface} className="space-y-2 rounded-xl p-5" aria-hidden>
      <div style={accent} className="text-sm uppercase tracking-[0.2em]">RSVP</div>
      {['Full name', 'Phone (WhatsApp)', f.email && 'Email', 'Joyfully accept · Regretfully decline', f.pax && 'Number of people', ...qs.map((q) => q.label)]
        .filter(Boolean).map((label) => <div key={label} style={box} className="rounded-lg px-3 py-2 text-sm opacity-60">{label}</div>)}
      <div style={{ background: 'var(--inv-accent)', color: 'var(--inv-bg)' }} className="rounded-lg px-4 py-2.5 text-center text-sm">Send RSVP</div>
    </div>
  )
}

/** Wishes guests left (D13), newest first: lib/invites.js visibleWishes decides which show. */
export function Wishes({ ctx }) {
  const list = ctx.mode === 'sample'
    ? [{ id: 's1', name: 'Andi', text: 'Wishing you a wonderful day!' }, { id: 's2', name: 'Citra', text: 'Can’t wait to celebrate with you.' }]
    : visibleWishes(ctx.event)
  return (
    <Frame ctx={ctx} title="Wishes">
      {ctx.slots?.wishForm}
      <ul className="mt-4 max-h-96 space-y-3 overflow-y-auto pr-1">
        {[...list].reverse().map((w) => (
          <li key={w.id} style={surface} className="rounded-xl p-4">
            <div style={accent} className="text-sm font-medium">{w.name}</div>
            <p className="mt-1 whitespace-pre-line text-sm opacity-85">{w.text}</p>
          </li>
        ))}
        {list.length === 0 && <li className="text-center text-sm opacity-60">Be the first to leave a wish.</li>}
      </ul>
    </Frame>
  )
}

export function GiftSection({ c, ctx }) {
  const accounts = c.gift.accounts.filter((a) => a.number?.trim())
  return (
    <Frame ctx={ctx} title="Send a gift">
      <p className="mb-5 text-center text-sm opacity-75">Your presence is the greatest gift. If you wish to send something, you can use:</p>
      <div className="space-y-3">
        {accounts.map((a, i) => (
          <div key={i} style={surface} className="flex items-center gap-4 rounded-xl p-4">
            <Gift size={20} style={accent} className="shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-xs uppercase tracking-[0.2em] opacity-60">{a.bank}</div>
              <div className="font-mono text-lg tracking-wider">{a.number}</div>
              <div className="text-xs opacity-70">{a.holder}</div>
            </div>
            {ctx.slots?.copy?.(a.number)}
          </div>
        ))}
        {c.gift.address?.trim() && (
          <div style={surface} className="rounded-xl p-4 text-sm">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-xs uppercase tracking-[0.2em] opacity-60">Gift delivery address</div>
                <div className="mt-1 whitespace-pre-line">{c.gift.address}</div>
              </div>
              {ctx.slots?.copyText?.(c.gift.address)}
            </div>
          </div>
        )}
      </div>
    </Frame>
  )
}

/** Section id → component. verify-proto checks every id in lib/templates.js has one. */
export const SECTION_COMPONENTS = {
  cover: Cover, message: Message, couple: Couple, hosts: Hosts, countdown: Countdown, details: Details,
  agenda: Agenda, speakers: Speakers, story: Story, dresscode: DressCode, gallery: Gallery, video: Video,
  rsvp: Rsvp, wishes: Wishes, gift: GiftSection,
}
