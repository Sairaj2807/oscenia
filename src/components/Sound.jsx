import { useEffect, useRef, useState } from 'react'

// Site sound: a quiet looping ambience and a pop on every click.
//
// Browsers refuse audio until the visitor has interacted, so nothing plays on
// load: the first press or key starts the ambience (on by default from then
// on). The speaker button, bottom left, mutes everything and the choice is
// remembered. The pop is one delegated listener, so no button needs wiring;
// add data-sound="off" to an element to keep it silent.

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
  const startedRef = useRef(false)

  const fadeTo = (target) => {
    const audio = audioRef.current
    if (!audio) return
    cancelAnimationFrame(fadeRef.current)
    const from = audio.volume
    const t0 = performance.now()
    const tick = (now) => {
      const k = Math.min(1, (now - t0) / FADE_MS)
      audio.volume = from + (target - from) * k
      if (k < 1) fadeRef.current = requestAnimationFrame(tick)
      else if (target === 0) audio.pause()
    }
    fadeRef.current = requestAnimationFrame(tick)
  }

  const playAmbience = () => {
    const audio = audioRef.current
    if (!audio || mutedRef.current) return
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
    audio.preload = 'auto'
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

    const onFirst = () => {
      if (startedRef.current) return
      startedRef.current = true
      ctxRef.current?.resume()
      playAmbience()
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
      else if (startedRef.current) playAmbience()
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

  const toggle = () => {
    const next = !muted
    mutedRef.current = next
    setMuted(next)
    try {
      localStorage.setItem(KEY, next ? '1' : '0')
    } catch {
      /* private mode: the choice just lasts this visit */
    }
    startedRef.current = true
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
