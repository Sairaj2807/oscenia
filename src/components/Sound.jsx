import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useIntroReady } from '../introReady'

// Site sound: a quiet looping ambience and a pop on every click.
//
// The ambience waits for the visitor to land on the home page: it fades in
// once the intro has finished and the route is "/", never during the intro
// (whose film has its own soundtrack). Starting the intro is itself the
// interaction browsers require, so it can usually begin straight away; if a
// browser still refuses, the next press on the page starts it. Once started it
// carries on across pages. The speaker button, bottom left, mutes everything
// and the choice is remembered. The pop is one delegated listener, so no
// button needs wiring; add data-sound="off" to an element to keep it silent.

const AMBIENCE_SRC = '/sound/ambience.mp3'
const POP_SRC = '/sound/pop.wav'
const AMBIENCE_VOLUME = 0.2
const POP_VOLUME = 0.5
const FADE_MS = 1500
const KEY = 'oscenia-sound-muted'
const INTERACTIVE = 'button, a[href], [role="button"], [data-sound]'

const readMuted = () => {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export default function Sound() {
  const [muted, setMuted] = useState(readMuted)
  const mutedRef = useRef(muted)
  const audioRef = useRef(null)
  const ctxRef = useRef(null)
  const popRef = useRef(null)
  const fadeRef = useRef(0)
  // True once the visitor has landed on the home page after the intro: the
  // only point from which the ambience may play.
  const arrivedRef = useRef(false)
  const introDone = useIntroReady()
  const { pathname } = useLocation()

  const fadeTo = (target) => {
    const audio = audioRef.current
    if (!audio) return
    cancelAnimationFrame(fadeRef.current)
    const from = audio.volume
    const t0 = performance.now()
    const tick = (now) => {
      const k = Math.min(1, (now - t0) / FADE_MS)
      // Clamped: rounding at the end of a fade can land a hair below 0,
      // which the browser rejects with an error.
      audio.volume = Math.min(1, Math.max(0, from + (target - from) * k))
      if (k < 1) fadeRef.current = requestAnimationFrame(tick)
      else if (target === 0) audio.pause()
    }
    fadeRef.current = requestAnimationFrame(tick)
  }

  const playAmbience = () => {
    const audio = audioRef.current
    if (!audio || mutedRef.current || !arrivedRef.current) return
    audio.play().then(() => fadeTo(AMBIENCE_VOLUME)).catch(() => {})
  }

  const pop = () => {
    const ctx = ctxRef.current
    const buffer = popRef.current
    if (!ctx || !buffer || mutedRef.current) return
    if (ctx.state === 'suspended') ctx.resume()
    const src = ctx.createBufferSource()
    const gain = ctx.createGain()
    src.buffer = buffer
    src.playbackRate.value = 0.94 + Math.random() * 0.12
    gain.gain.value = POP_VOLUME
    src.connect(gain).connect(ctx.destination)
    src.start()
  }

  useEffect(() => {
    const audio = new Audio(AMBIENCE_SRC)
    audio.loop = true
    audio.volume = 0
    // Not fetched until it first plays, on the home page: downloading 3 MB of
    // ambience during the intro only slowed everything else.
    audio.preload = 'none'
    audioRef.current = audio

    const AC = window.AudioContext || window.webkitAudioContext
    if (AC) {
      const ctx = new AC()
      ctxRef.current = ctx
      fetch(POP_SRC)
        .then((r) => r.arrayBuffer())
        .then((b) => ctx.decodeAudioData(b))
        .then((buf) => {
          popRef.current = buf
        })
        .catch(() => {})
    }

    // A press unlocks audio; it only starts the ambience once the visitor has
    // arrived (and covers a browser that refused to start it on arrival).
    const onFirst = () => {
      ctxRef.current?.resume()
      if (audio.paused) playAmbience()
    }
    const onDown = (e) => {
      onFirst()
      const el = e.target.closest?.(INTERACTIVE)
      if (!el || el.closest('[data-sound="off"]') || el.hasAttribute('data-sound-toggle')) return
      pop()
    }
    const onKey = () => onFirst()
    const onVisibility = () => {
      if (document.hidden) audio.pause()
      else playAmbience()
    }

    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('visibilitychange', onVisibility)
      cancelAnimationFrame(fadeRef.current)
      audio.pause()
      ctxRef.current?.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Landing on the home page once the intro has lifted starts the ambience.
  useEffect(() => {
    if (arrivedRef.current || !introDone || pathname !== '/') return
    arrivedRef.current = true
    ctxRef.current?.resume()
    playAmbience()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [introDone, pathname])

  const toggle = () => {
    const next = !muted
    mutedRef.current = next
    setMuted(next)
    try {
      localStorage.setItem(KEY, next ? '1' : '0')
    } catch {
      /* private mode: the choice just lasts this visit */
    }
    if (next) {
      fadeTo(0)
    } else {
      ctxRef.current?.resume()
      playAmbience()
      pop()
    }
  }

  return (
    <button
      type="button"
      data-sound-toggle
      onClick={toggle}
      aria-pressed={!muted}
      aria-label={muted ? 'Turn sound on' : 'Turn sound off'}
      className="liquid-glass fixed bottom-6 left-5 z-40 flex h-11 w-11 items-center justify-center rounded-full text-gold sm:bottom-8 sm:left-8"
    >
      <svg
        viewBox="0 0 24 24"
        className="h-5 w-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4z" />
        {muted ? (
          <path d="M16 9.5l5 5M21 9.5l-5 5" />
        ) : (
          <>
            <path d="M15.5 9a4 4 0 0 1 0 6" />
            <path d="M18 6.5a7.5 7.5 0 0 1 0 11" />
          </>
        )}
      </svg>
    </button>
  )
}
