import { useEffect, useRef, useState } from 'react'

const prefersReduced = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

// Where the element travels in from.
//
// Directions mirror "HOME - ABOUT US.pptx", which uses PowerPoint Morph
// throughout: objects are parked outside the slide edge and slide in, so each
// element has a meaningful direction rather than everything fading upward. The
// four "What we Direct" panels, for instance, come in from the four corners.
// Horizontal offsets are halved on small screens: a 4rem travel across a
// 390px-wide element is a much bigger gesture proportionally, and it pushed
// content far enough past the edge to be noticeable even with body clipping.
const ENTER_FROM = {
  up: 'translate-y-8 sm:translate-y-12',
  down: '-translate-y-8 sm:-translate-y-12',
  left: '-translate-x-8 sm:-translate-x-16',
  right: 'translate-x-8 sm:translate-x-16',
  scale: 'scale-95',
  'top-left': '-translate-x-8 -translate-y-8 sm:-translate-x-16 sm:-translate-y-12',
  'top-right': 'translate-x-8 -translate-y-8 sm:translate-x-16 sm:-translate-y-12',
  'bottom-left': '-translate-x-8 translate-y-8 sm:-translate-x-16 sm:translate-y-12',
  'bottom-right': 'translate-x-8 translate-y-8 sm:translate-x-16 sm:translate-y-12',
}

// The deck's morphs run at 2000ms, speed "slow". That's a long way from a
// typical web reveal, so this sits deliberately slow without being sluggish —
// raise it to 2000 to match the slides exactly.
const MORPH_MS = 1400

// PowerPoint's morph eases out of the move rather than snapping to a stop.
const MORPH_EASE = 'cubic-bezier(0.33, 0, 0.15, 1)'

// Slides children into view on scroll, travelling in from `from`. Respects
// reduced-motion by rendering the final state immediately with no transition.
export default function Reveal({
  children,
  className = '',
  delay = 0,
  from = 'up',
  duration = MORPH_MS,
  // Entrances replay every time a section is scrolled back to, so moving
  // between sections always shows the transition rather than it firing once on
  // the first pass and never again. Pass `once` where a single play is wanted.
  once = false,
  as: Tag = 'div',
}) {
  const ref = useRef(null)
  const [reduced] = useState(prefersReduced)
  const [shown, setShown] = useState(false)

  useEffect(() => {
    if (reduced) return undefined
    const el = ref.current
    if (!el) return undefined
    // Two thresholds give hysteresis: it plays once 15% is visible, but only
    // resets once it is completely gone. A single threshold would let a slow
    // scroll sitting on the boundary flicker it on and off.
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.intersectionRatio >= 0.15) {
          setShown(true)
          if (once) io.disconnect()
        } else if (!once && entry.intersectionRatio === 0) {
          setShown(false)
        }
      },
      { threshold: [0, 0.15] },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [reduced, once])

  if (reduced) {
    return (
      <Tag ref={ref} className={className}>
        {children}
      </Tag>
    )
  }

  return (
    <Tag
      ref={ref}
      style={{
        transitionDelay: `${delay}ms`,
        transitionDuration: `${duration}ms`,
        transitionTimingFunction: MORPH_EASE,
      }}
      className={`transition-all ${
        shown
          ? 'translate-x-0 translate-y-0 scale-100 opacity-100'
          : `opacity-0 ${ENTER_FROM[from] || ENTER_FROM.up}`
      } ${className}`}
    >
      {children}
    </Tag>
  )
}
