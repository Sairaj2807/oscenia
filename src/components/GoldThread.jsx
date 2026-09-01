import { useEffect, useRef, useState } from 'react'

// The hairline that runs through the lower half of the site in the reference:
// one continuous gold stroke that leaves the film, loops through the empty
// space above the format cards, and points down into the first of them. It is
// drawn rather than faded in — the length of the visible stroke tracks how far
// its section has scrolled, so it appears to be written as the page moves.
//
// Purely decorative, so it is aria-hidden and it simply renders complete when
// the visitor has asked for less motion.
const prefersReduced = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

// The stroke is complete by the time its box has climbed to a fifth of the way
// up the viewport — soon enough that the finished curve, not the drawing of it,
// is what is on screen while the section is being read.
function useDrawProgress(ref, reduced) {
  const [progress, setProgress] = useState(reduced ? 1 : 0)

  useEffect(() => {
    if (reduced) return undefined
    let raf = 0
    const measure = () => {
      raf = 0
      const el = ref.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const span = window.innerHeight * 0.75
      const travelled = window.innerHeight * 0.95 - rect.top
      setProgress(Math.min(1, Math.max(0, travelled / span)))
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(measure)
    }
    measure()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [ref, reduced])

  return progress
}

export default function GoldThread({ d, viewBox, className = '', width = 1.4 }) {
  const wrapRef = useRef(null)
  const pathRef = useRef(null)
  const [reduced] = useState(prefersReduced)
  const [length, setLength] = useState(0)
  const progress = useDrawProgress(wrapRef, reduced)

  useEffect(() => {
    if (pathRef.current) setLength(pathRef.current.getTotalLength())
  }, [d])

  return (
    <div ref={wrapRef} className={`pointer-events-none absolute ${className}`} aria-hidden="true">
      <svg
        viewBox={viewBox}
        preserveAspectRatio="none"
        className="h-full w-full overflow-visible"
        fill="none"
      >
        <path
          ref={pathRef}
          d={d}
          stroke="rgba(214, 190, 138, 0.72)"
          strokeWidth={width}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          style={
            length
              ? {
                  strokeDasharray: length,
                  strokeDashoffset: length * (1 - progress),
                }
              : undefined
          }
        />
      </svg>
    </div>
  )
}
