import { useEffect, useState } from 'react'

// Theatre curtains for the Services stage, from the designer's photographed
// drapes (brand-assets/3. Services Page/Photo Assets: curtain A, Curtain B and
// the swagged valance, Curtain C).
//
// They arrive closed and part on their own, like a show starting, to frame the
// letter curtain with a strip of drape either side. `open` (0 to 1, from the
// page's scroll) then draws them fully off and lifts the valance away.
//
// Each drape is at least half the screen wide so that closed means closed on
// a wide monitor too; the framed strip is --frame wide.

const prefersReduced = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

// How long the opening draw takes, and how long before it starts.
const PART_MS = 2200
const PART_DELAY_MS = 450

export default function Curtains({ open = 0 }) {
  const [reduced] = useState(prefersReduced)
  const [parted, setParted] = useState(reduced)
  // The transition only covers the opening draw; after that the drapes track
  // the scroll directly, and a transition would make them lag behind it.
  const [settling, setSettling] = useState(!reduced)

  useEffect(() => {
    if (reduced) return undefined
    const a = setTimeout(() => setParted(true), PART_DELAY_MS)
    const b = setTimeout(() => setSettling(false), PART_DELAY_MS + PART_MS + 100)
    return () => {
      clearTimeout(a)
      clearTimeout(b)
    }
  }, [reduced])

  // 0 = closed, framed = showing --frame of drape, then fully off.
  const shift = (dir) => {
    if (!parted) return '0 0'
    const framed = `(-100% + var(--frame))`
    return `calc(${dir} * (${framed} - var(--frame) * ${open} - ${open * 4}vw)) 0`
  }
  const motion = settling
    ? { transition: `translate ${PART_MS}ms cubic-bezier(0.65, 0, 0.25, 1)` }
    : undefined

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 [--frame:13vw] sm:[--frame:17vw]">
      <img
        src="/services/curtain-left.webp"
        alt=""
        className="absolute left-0 top-0 h-full w-[max(76svh,51vw)] max-w-none object-cover object-right"
        style={{ translate: shift(1), ...motion }}
      />
      <img
        src="/services/curtain-right.webp"
        alt=""
        className="absolute right-0 top-0 h-full w-[max(74svh,51vw)] max-w-none object-cover object-left"
        style={{ translate: shift(-1), ...motion }}
      />
      <img
        src="/services/valance.webp"
        alt=""
        className="absolute inset-x-0 top-0 h-[clamp(70px,22vw,32svh)] w-full object-cover object-bottom"
        style={{ translate: `0 ${-open * 110}%` }}
      />
    </div>
  )
}
