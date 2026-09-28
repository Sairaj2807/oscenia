import { useEffect, useRef, useState } from 'react'

// The wake the pointer leaves across the background.
//
// The brand's own image for itself is "the sense of the ocean: scale, flow,
// depth" (see the hero film), so the second half of the lusion.co pointer treatment
// is water rather than their smoke: a height field that the cursor displaces
// and that then propagates and decays on its own. Nothing is drawn directly —
// the cursor only pushes energy in, and the wave equation does the rest, which
// is why the trail keeps moving after you stop.
//
// It runs on a coarse grid (one cell per 10 CSS pixels) and the browser
// upscales it, because a ripple is low-frequency by nature and a full-
// resolution simulation would cost a hundred times more for a result that is
// blurrier, not sharper.

const CELL = 10

// Per-step energy retained. Higher lingers longer; above ~0.98 the surface
// never calms and the page reads as noisy. At 0.95 a wake settles within about
// a second and a half of the pointer stopping: still water rather than a trail
// that switches off, but quiet enough to sit behind the page.
const DAMP = 0.95

// Radius of the disturbance the pointer pushes in, in cells, and how deep each
// one dents the surface.
//
// Amplitude stays modest because the pointer injects on every move event,
// ~60-120 times a second, so it accumulates fast. These numbers were measured
// against the shading below rather than guessed: at 0.14 both a slow hover and
// a drag peak around 204/255 alpha with ~10% of the wake clipping flat. It's
// now set lower, for a subtler wake: with 0.1, a 3-cell poke and OPACITY 0.65
// the same sweep peaks around 75/255 and lights a fifth of the area, with
// nothing clipping. (0.08 / 0.55 dropped it to ~50/255 — too faint to read.) Going further --
// 0.22 and up -- clips half the wake, and a ripple that is 50% flat white is no
// longer a ripple, it is a glow.
const POKE = 3
const AMPLITUDE = 0.1

// Converts height and slope into visible light. Slope carries most of it — a
// wave is visible because it tilts, not because it is tall.
const GAIN = 1.3
const OPACITY = 0.65

// Crest and trough colours: gold-light and navy-500 from tailwind.config.js.
const CREST = [224, 199, 137]
const TROUGH = [31, 55, 96]

// Below this the surface is flat enough that nobody can see it, so the loop
// stops rather than animating an invisible canvas forever.
const QUIET = 0.004
const QUIET_AFTER_MS = 400

const prefersReduced = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

export default function Ripple() {
  const canvasEl = useRef(null)
  // The intro owns the screen and runs its own frame animation; competing with
  // it for the main thread is the one place this could actually be felt. Same
  // gate the home page uses — everywhere but the front door it is simply on.
  const [lit, setLit] = useState(() => {
    if (typeof window === 'undefined') return true
    return window.location.pathname !== '/'
  })

  useEffect(() => {
    const onDone = () => setLit(true)
    window.addEventListener('oscenia:intro-done', onDone)
    return () => window.removeEventListener('oscenia:intro-done', onDone)
  }, [])

  useEffect(() => {
    if (!lit || prefersReduced()) return undefined

    const canvas = canvasEl.current
    if (!canvas) return undefined
    const ctx = canvas.getContext('2d', { alpha: true })
    if (!ctx) return undefined

    let gw = 0
    let gh = 0
    let curr = null
    let prev = null
    let img = null
    let raf = 0
    let lastPokeAt = 0
    // Null until the pointer has been seen, so the first move doesn't draw a
    // line in from wherever the page thinks (0, 0) is.
    let from = null

    const resize = () => {
      gw = Math.max(24, Math.ceil(window.innerWidth / CELL))
      gh = Math.max(24, Math.ceil(window.innerHeight / CELL))
      canvas.width = gw
      canvas.height = gh
      curr = new Float32Array(gw * gh)
      prev = new Float32Array(gw * gh)
      img = ctx.createImageData(gw, gh)
      from = null
    }

    // Pushes a soft dent into the surface. The cosine falloff matters: a
    // hard-edged disc rings like a struck drum, a soft one reads as something
    // displacing water.
    const poke = (cx, cy, amount) => {
      for (let y = -POKE; y <= POKE; y++) {
        const py = cy + y
        if (py < 1 || py >= gh - 1) continue
        for (let x = -POKE; x <= POKE; x++) {
          const px = cx + x
          if (px < 1 || px >= gw - 1) continue
          const d = Math.sqrt(x * x + y * y)
          if (d > POKE) continue
          curr[py * gw + px] += amount * (Math.cos((d / POKE) * Math.PI) * 0.5 + 0.5)
        }
      }
    }

    const step = () => {
      for (let y = 1; y < gh - 1; y++) {
        const row = y * gw
        for (let x = 1; x < gw - 1; x++) {
          const i = row + x
          prev[i] =
            ((curr[i - 1] + curr[i + 1] + curr[i - gw] + curr[i + gw]) * 0.5 - prev[i]) * DAMP
        }
      }
      const swap = curr
      curr = prev
      prev = swap
    }

    // Returns the peak intensity on screen, which is what decides whether the
    // surface has gone quiet enough to stop.
    const draw = () => {
      const data = img.data
      let peak = 0
      for (let y = 0; y < gh; y++) {
        const row = y * gw
        const inner = y > 0 && y < gh - 1
        for (let x = 0; x < gw; x++) {
          const i = row + x
          let m = 0
          if (inner && x > 0 && x < gw - 1) {
            const h = curr[i]
            const gx = curr[i - 1] - curr[i + 1]
            const gy = curr[i - gw] - curr[i + gw]
            m = (Math.abs(h) * 0.7 + Math.abs(gx) + Math.abs(gy)) * GAIN
            if (m > 1) m = 1
            if (m > peak) peak = m
          }
          // Squared, so only the sharpest crests reach gold and the broad swell
          // stays a cool sheen.
          const t = m * m
          const p = i * 4
          data[p] = TROUGH[0] + (CREST[0] - TROUGH[0]) * t
          data[p + 1] = TROUGH[1] + (CREST[1] - TROUGH[1]) * t
          data[p + 2] = TROUGH[2] + (CREST[2] - TROUGH[2]) * t
          data[p + 3] = m * 255 * OPACITY
        }
      }
      ctx.putImageData(img, 0, 0)
      return peak
    }

    const tick = () => {
      step()
      const peak = draw()
      if (peak < QUIET && performance.now() - lastPokeAt > QUIET_AFTER_MS) {
        ctx.clearRect(0, 0, gw, gh)
        raf = 0
        return
      }
      raf = requestAnimationFrame(tick)
    }

    const wake = () => {
      if (raf || document.hidden) return
      raf = requestAnimationFrame(tick)
    }

    const onMove = (e) => {
      if (e.pointerType !== 'mouse' && e.pointerType !== 'pen') return

      const to = { x: e.clientX / CELL, y: e.clientY / CELL }
      const start = from ?? to
      const dx = to.x - start.x
      const dy = to.y - start.y
      const dist = Math.hypot(dx, dy)
      from = to
      lastPokeAt = performance.now()

      // A pointermove can jump a long way in one event on a fast drag or a low
      // report rate. Walking the segment leaves a continuous wake instead of a
      // dotted line, capped so a tab-switch teleport doesn't stripe the screen.
      //
      // Each point along the path gets the same dent and the count scales with
      // distance, so a fast drag lays down a longer, stronger wake. Splitting a
      // fixed budget across the steps instead would make a slow hover ripple
      // harder than a flick, which is backwards.
      const steps = Math.min(20, Math.max(1, Math.round(dist / 1.5)))
      for (let s = 1; s <= steps; s++) {
        const k = s / steps
        poke(Math.round(start.x + dx * k), Math.round(start.y + dy * k), AMPLITUDE)
      }

      wake()
    }

    // A hidden tab shouldn't hold a rAF, and coming back to a frozen surface
    // mid-ripple looks broken — so it is dropped and rebuilt on return.
    const onVisibility = () => {
      if (document.hidden && raf) {
        cancelAnimationFrame(raf)
        raf = 0
        curr.fill(0)
        prev.fill(0)
        ctx.clearRect(0, 0, gw, gh)
        from = null
      }
    }

    resize()
    window.addEventListener('resize', resize)
    window.addEventListener('pointermove', onMove, { passive: true })
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      if (raf) cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      window.removeEventListener('pointermove', onMove)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [lit])

  return (
    <canvas
      ref={canvasEl}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 -z-10 h-full w-full"
      style={{ mixBlendMode: 'screen' }}
    />
  )
}
