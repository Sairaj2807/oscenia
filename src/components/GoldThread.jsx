import { useEffect, useRef, useState } from 'react'

// The hairline that runs through the lower half of the site: one gold stroke
// that is drawn rather than faded in. How much of it shows is tied to how far
// its box has scrolled, so it appears to be written as the page moves, and
// un-written if you scroll back.
//
// The path is authored in its own viewBox and stretched to the box
// (preserveAspectRatio="none"), with a non-scaling stroke so the line stays a
// hairline however far it's stretched. That combination has a trap: Chromium
// lays the dash out in screen pixels, while getTotalLength() measures in viewBox
// units. On a wide screen the two differ by a quarter or more, and a dash sized
// from getTotalLength() stops short — the end of the line simply never draws.
// So the length used here is measured on screen, and re-measured whenever the
// box changes size.
//
// Purely decorative, so it is aria-hidden and it renders complete when the
// visitor has asked for less motion.
const prefersReduced = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

// Monotone cubic (Fritsch–Carlson) through [x, y] points. Smooth, and it never
// overshoots between points, so the pen can't run backwards between two reads.
function monotone(points) {
  const n = points.length
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  const d = []
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]))
  const m = new Array(n)
  m[0] = d[0]
  m[n - 1] = d[n - 2]
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0
      m[i + 1] = 0
      continue
    }
    const a = m[i] / d[i]
    const b = m[i + 1] / d[i]
    const s = a * a + b * b
    if (s > 9) {
      const k = 3 / Math.sqrt(s)
      m[i] = k * a * d[i]
      m[i + 1] = k * b * d[i]
    }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0]
    if (x >= xs[n - 1]) return ys[n - 1]
    let i = 0
    while (x > xs[i + 1]) i++
    const h = xs[i + 1] - xs[i]
    const t = (x - xs[i]) / h
    const t2 = t * t
    const t3 = t2 * t
    return (
      (2 * t3 - 3 * t2 + 1) * ys[i] +
      (t3 - 2 * t2 + t) * h * m[i] +
      (-2 * t3 + 3 * t2) * ys[i + 1] +
      (t3 - t2) * h * m[i + 1]
    )
  }
}

const linear = (p) => p

// The path's length as it is actually drawn: walked in viewBox units, with each
// step scaled by the box's stretch on its own axis.
function screenLength(path, sx, sy) {
  const total = path.getTotalLength()
  const steps = 600
  let len = 0
  let a = path.getPointAtLength(0)
  for (let i = 1; i <= steps; i++) {
    const b = path.getPointAtLength((total * i) / steps)
    len += Math.hypot((b.x - a.x) * sx, (b.y - a.y) * sy)
    a = b
  }
  return len
}

export default function GoldThread({
  d,
  viewBox,
  // Where the box's top edge is, as a fraction of the viewport height, when the
  // line starts drawing and when it's complete.
  from = 0.95,
  to = 0.2,
  // [scroll progress, fraction drawn] pairs; linear when omitted.
  pacing,
  className = '',
  style,
  // Weight and colour measured off the reference recording: the line's
  // cross-section integrates to ~2.2px of this pale champagne, which is far
  // less orange than the brand gold (green ≈ 0.94 of red, blue ≈ 0.75).
  width = 2.2,
}) {
  const wrapRef = useRef(null)
  const pathRef = useRef(null)
  const [reduced] = useState(prefersReduced)
  const top = style?.top
  // The link's height arrives as a new inline style. ResizeObserver would
  // catch it, but a frame late; re-running on it keeps the first draw at the
  // new height in step with the state change.
  const height = style?.height

  useEffect(() => {
    const wrap = wrapRef.current
    const path = pathRef.current
    if (!wrap || !path) return undefined
    if (reduced) {
      path.style.opacity = '1'
      return undefined
    }

    const [, , vbW, vbH] = viewBox.split(/[\s,]+/).map(Number)
    const pace = pacing ? monotone(pacing) : linear
    let len = 0
    let raf = 0

    const measure = () => {
      const w = wrap.clientWidth
      const h = wrap.clientHeight
      // Hidden below the sm breakpoint: nothing to measure until it shows.
      len = w && h ? screenLength(path, w / vbW, h / vbH) : 0
    }
    const draw = () => {
      raf = 0
      if (!len) return
      const vh = window.innerHeight
      const at = wrap.getBoundingClientRect().top
      const progress = Math.min(1, Math.max(0, (vh * from - at) / (vh * (from - to))))
      const drawn = pace(progress)
      // A hair over the measured length, so a fully drawn line can't lose its
      // last pixel to rounding.
      const dash = len + 2
      path.style.strokeDasharray = `${dash} ${dash}`
      path.style.strokeDashoffset = String(dash * (1 - drawn))
      // At nothing drawn, a round cap can still leave a dot at the start.
      path.style.opacity = drawn > 0.0005 ? '1' : '0'
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(draw)
    }
    const resized = () => {
      measure()
      schedule()
    }

    measure()
    draw()
    const ro = new ResizeObserver(resized)
    ro.observe(wrap)
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', resized)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', resized)
    }
  }, [d, viewBox, from, to, pacing, reduced, top, height])

  return (
    <div
      ref={wrapRef}
      className={`pointer-events-none absolute ${className}`}
      style={style}
      aria-hidden="true"
    >
      <svg
        viewBox={viewBox}
        preserveAspectRatio="none"
        className="h-full w-full overflow-visible"
        fill="none"
      >
        <path
          ref={pathRef}
          d={d}
          stroke="rgba(238, 225, 188, 0.92)"
          strokeWidth={width}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          // Hidden until the first measured draw, so the whole line never
          // flashes up before its dash is set.
          style={{ opacity: reduced ? 1 : 0 }}
        />
      </svg>
    </div>
  )
}
