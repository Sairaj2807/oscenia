// The guest page's interactive pieces (Invitations v2, phase 4): background music, the cover
// gate's Open button, Add to calendar, the photo lightbox, copy buttons and the wish form.
// They are drawn inside InviteRenderer's CSS variables, so they take the template's colours.
//
// Audio, the clipboard, downloads and key listeners only start in effects and click handlers:
// the smoke test renders these pages on the server.
import { useEffect, useRef, useState } from 'react'
import { Music, Pause, CalendarPlus, Copy, Check, X, ChevronLeft, ChevronRight } from 'lucide-react'
import { createMusic } from '../../lib/music'
import { icsFile, icsName, WISH_LIMITS } from '../../lib/invites'
import { download } from '../../lib/exports'
import { personalLink } from '../../lib/events'
import { useProto, demoNow } from '../../store/useProto'
import { usePublicInvite } from '../../store/usePublicInvite'
import { useMediaUrl, Img } from './media'
import { ArtTile } from './sections'

const accentBtn = { background: 'var(--inv-accent)', color: 'var(--inv-bg)' }
const outlineBtn = { borderColor: 'var(--inv-accent)', color: 'var(--inv-accent)' }

// --- music ---------------------------------------------------------------------

/**
 * Plays the invitation's music (`{kind, trackId, file}`, or null for none). An uploaded song
 * is looked up ahead of time, so `play()` can start it inside the tap that asked for it.
 * `available` is false while the song is loading, or when this browser does not have it —
 * then there is simply no music, rather than a different track.
 */
export function useMusic(music) {
  const file = music?.kind === 'upload' ? music.file : null
  const { url } = useMediaUrl(file)
  const source = !music ? null
    : music.kind === 'upload' ? (url ? { kind: 'upload', url } : null)
      : { kind: 'builtin', trackId: music.trackId }
  const sourceKey = source ? `${source.kind}:${source.url || source.trackId}` : ''
  const player = useRef(null)
  const [playing, setPlaying] = useState(false)

  // A new track (the editor's picker) or leaving the page stops the old one.
  useEffect(() => () => {
    player.current?.destroy()
    player.current = null
    setPlaying(false)
  }, [sourceKey])

  // A phone locked mid-song should not keep playing in the pocket.
  useEffect(() => {
    const onHide = () => {
      if (document.hidden && player.current) {
        player.current.pause()
        setPlaying(false)
      }
    }
    document.addEventListener('visibilitychange', onHide)
    return () => document.removeEventListener('visibilitychange', onHide)
  }, [])

  const play = () => {
    if (!source) return
    player.current ||= createMusic(source)
    setPlaying(true)
    player.current.play().then((ok) => { if (!ok) setPlaying(false) })
  }
  const pause = () => {
    player.current?.pause()
    setPlaying(false)
  }
  return { available: Boolean(source), playing, play, pause, toggle: () => (playing ? pause() : play()) }
}

/** The floating play/pause button over the whole invitation. */
export function MusicButton({ music }) {
  return (
    <button type="button" onClick={music.toggle} aria-label={music.playing ? 'Pause music' : 'Play music'} aria-pressed={music.playing}
      style={accentBtn} className="fixed bottom-5 right-5 z-30 flex h-12 w-12 items-center justify-center rounded-full shadow-lg ring-4 ring-black/10">
      {music.playing ? <Pause size={18} /> : <Music size={18} className="animate-pulse" />}
    </button>
  )
}

// --- the cover gate --------------------------------------------------------------

/**
 * The cover, full screen, until the guest taps Open (Invitato's "Buka undangan"). The tap is
 * what lets the music start. The page beneath is inert and does not scroll meanwhile.
 */
export function OpenButton({ onOpen }) {
  useEffect(() => {
    const el = document.documentElement
    const was = el.style.overflow
    el.style.overflow = 'hidden'
    return () => { el.style.overflow = was }
  }, [])
  return (
    <button type="button" onClick={onOpen} style={accentBtn}
      className="mt-8 inline-flex items-center gap-2 rounded-full px-7 py-3 text-xs font-medium uppercase tracking-[0.25em] shadow-lg transition-transform hover:scale-[1.03]">
      Open invitation
    </button>
  )
}

// --- Add to calendar -----------------------------------------------------------------

export function AddToCalendar({ event, invite, guest }) {
  const save = () => {
    // The guest's own invitation — also from the editor's preview, which lives at an ERP URL.
    const link = event?.id ? personalLink(`${window.location.origin}${import.meta.env.BASE_URL}invite/${event.id}`, guest) : ''
    download(icsName(invite.content.cover.title || event?.name), icsFile(event, invite, { link, now: demoNow() }), 'text/calendar;charset=utf-8')
  }
  return (
    <div className="mt-6 text-center">
      <button type="button" onClick={save} style={outlineBtn} className="inline-flex items-center gap-2 rounded-full border px-5 py-2 text-xs uppercase tracking-[0.2em]">
        <CalendarPlus size={14} />Add to calendar
      </button>
    </div>
  )
}

// --- copy --------------------------------------------------------------------------

/** Copies `text` (an account number: spaces and dashes dropped, as banking apps want). */
export function CopyButton({ text, label = 'Copy', digits = true }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef(null)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = async () => {
    const value = digits ? String(text).replace(/[\s-]/g, '') : String(text)
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      // No clipboard (an old browser, or not https): the number is on screen to copy by hand.
      setCopied(false)
    }
  }
  return (
    <button type="button" onClick={copy} style={outlineBtn} aria-label={copied ? 'Copied' : `${label} ${text}`}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] uppercase tracking-[0.15em]">
      {copied ? <Check size={13} /> : <Copy size={13} />}{copied ? 'Copied' : label}
    </button>
  )
}

// --- lightbox ------------------------------------------------------------------------

/**
 * A photo full screen, with arrows, the keyboard (← → Esc) and a swipe on phones. `photos`
 * are stored references — or numbers, the gallery's stand-in tiles in sample previews.
 */
export function Lightbox({ photos, index, onIndex, onClose }) {
  const n = photos.length
  const go = (d) => onIndex((index + d + n) % n)
  const touch = useRef(null)
  const closeRef = useRef(null)
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight') onIndex((index + 1) % n)
      else if (e.key === 'ArrowLeft') onIndex((index - 1 + n) % n)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, n, onIndex, onClose])
  useEffect(() => {
    closeRef.current?.focus()
    const el = document.documentElement
    const was = el.style.overflow
    el.style.overflow = 'hidden'
    return () => { el.style.overflow = was }
  }, [])
  const p = photos[index]
  const arrow = 'absolute top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2.5 text-white hover:bg-white/20'
  return (
    <div role="dialog" aria-modal="true" aria-label={`Photo ${index + 1} of ${n}`} className="fixed inset-0 z-50 flex items-center justify-center bg-black"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onTouchStart={(e) => { touch.current = e.touches[0].clientX }}
      onTouchEnd={(e) => {
        const dx = e.changedTouches[0].clientX - (touch.current ?? e.changedTouches[0].clientX)
        touch.current = null
        if (Math.abs(dx) > 40 && n > 1) go(dx < 0 ? 1 : -1)
      }}>
      {typeof p === 'number'
        ? <ArtTile i={p} className="aspect-[4/3] w-[min(90vw,48rem)] rounded-lg" />
        : <Img src={p} className="max-h-[85vh] max-w-[92vw] select-none rounded-lg object-contain" fallback={<div className="text-sm text-white/60">Loading…</div>} />}
      <button ref={closeRef} type="button" onClick={onClose} aria-label="Close" className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"><X size={20} /></button>
      {n > 1 && (
        <>
          <button type="button" onClick={() => go(-1)} aria-label="Previous photo" className={`${arrow} left-3`}><ChevronLeft size={22} /></button>
          <button type="button" onClick={() => go(1)} aria-label="Next photo" className={`${arrow} right-3`}><ChevronRight size={22} /></button>
        </>
      )}
      <div className="absolute bottom-5 left-1/2 -translate-x-1/2 text-xs tracking-[0.2em] text-white/70">{index + 1} / {n}</div>
    </div>
  )
}

// --- wishes ----------------------------------------------------------------------------

const WISH_REFUSED = {
  duplicate: 'Thank you — you have already left a wish like this one.',
  limit: 'Thank you — you have left all the wishes we can take.',
  not_enabled: 'This invitation is not taking wishes.',
}

/** The guest's wish form. A guest known from their link or reply signs with their name. */
export function WishForm({ event, guest }) {
  const [website, setWebsite] = useState('') // a field no person fills in
  const [name, setName] = useState('')
  const [text, setText] = useState('')
  const [sent, setSent] = useState(null) // 'shown' | 'waiting'
  const [error, setError] = useState('')
  const line = { borderColor: 'color-mix(in srgb, currentColor 30%, transparent)' }
  const input = 'w-full rounded-lg border bg-transparent px-3 py-2.5 text-sm outline-none'

  const submit = async (e) => {
    e.preventDefault()
    if (!guest && !name.trim()) return setError('Please add your name.')
    if (!text.trim()) return setError('Please write your wish.')
    if (event.server) {
      const r = await usePublicInvite.getState().addWish({ name, text, website })
      if (!r.ok) return setError(WISH_REFUSED[r.code] || r.message || 'Sorry, we could not save your wish. Please try again.')
      setSent(r.state)
    } else {
      const id = useProto.getState().addWish(event.id, { guestId: guest?.id || null, name, text })
      if (!id) return setError(WISH_REFUSED.duplicate)
      const wish = useProto.getState().events.find((x) => x.id === event.id)?.wishes.find((w) => w.id === id)
      setSent(wish?.approved ? 'shown' : 'waiting')
    }
    setText('')
    setError('')
  }

  return (
    <form onSubmit={submit} style={{ background: 'var(--inv-surface)' }} className="space-y-3 rounded-xl p-5">
      {guest
        ? <p className="text-sm opacity-75">Writing as <span style={{ color: 'var(--inv-accent)' }}>{guest.name}</span></p>
        : <input style={line} className={input} placeholder="Your name" value={name} maxLength={WISH_LIMITS.name} onChange={(e) => setName(e.target.value)} autoComplete="name" />}
      <input name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" value={website} onChange={(e) => setWebsite(e.target.value)}
        style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, opacity: 0 }} />
      <textarea style={line} className={input} rows={3} placeholder="Write your wish…" value={text} maxLength={WISH_LIMITS.text}
        onChange={(e) => { setText(e.target.value); setSent(null) }} aria-label="Your wish" />
      <div className="flex items-center gap-3">
        <span className="text-[11px] opacity-50 tabular-nums">{text.length} / {WISH_LIMITS.text}</span>
        <button type="submit" style={accentBtn} className="ml-auto rounded-lg px-5 py-2 text-sm">Send wish</button>
      </div>
      {error && <p role="alert" className="text-xs text-rose-400">{error}</p>}
      {sent && (
        <p role="status" className="text-xs opacity-80">
          {sent === 'waiting' ? 'Thank you! Your wish will appear once the hosts have seen it.' : 'Thank you! Your wish is on the invitation.'}
        </p>
      )}
    </form>
  )
}
