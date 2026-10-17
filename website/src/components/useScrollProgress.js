import { useEffect, useRef, useState } from 'react'

// How far the page has scrolled through an element, 0 to 1. This drives the
// About page's scroll-played scenes (the satin opening, the champagne glass,
// the satin wipes between values).
//
// Two ways of measuring:
// - 'pin': the element is a tall runway with a `sticky` child. 0 is when its
//   top meets the top of the viewport, 1 is when its bottom meets the bottom,
//   which is exactly the stretch during which the sticky child is held.
// - 'pass': an ordinary element crossing the screen. 0 is when its top enters
//   from below, 1 is when its bottom leaves at the top.
//
// Measured once per frame at most, off a passive listener, so a fast scroll
// costs one layout read per frame rather than one per event.
export default function useScrollProgress(mode = 'pin') {
  const ref = useRef(null)
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    let raf = 0

    const measure = () => {
      raf = 0
      const r = el.getBoundingClientRect()
      const vh = window.innerHeight
      let v
      if (mode === 'pass') {
        v = (vh - r.top) / (vh + r.height)
      } else {
        const travel = r.height - vh
        v = travel > 0 ? -r.top / travel : r.top < 0 ? 1 : 0
      }
      setProgress(clamp01(v))
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure)
    }

    measure()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [mode])

  return [ref, progress]
}

export const clamp01 = (v) => Math.min(1, Math.max(0, v))

// Where `p` sits inside the window [a, b], as 0 to 1 — how a scene carves one
// scroll progress into its separate beats.
export const span = (p, a, b) => clamp01((p - a) / (b - a))

export const easeOut = (t) => 1 - (1 - t) ** 3

export const easeInOut = (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2)
