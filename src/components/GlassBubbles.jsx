import { useEffect, useRef, useState } from 'react'

// The three pillars as photographed champagne bubbles, ported from the
// designer's prototype (brand-assets/2. About Us Page/oscenia-liquid-glass-v6.html).
// Each bubble wanders about a home position with a slow buoyant bob, drifts
// away from the pointer, and bumps the others edge to edge with a springy
// "jelly" squash rather than a hard bounce. Drag one to play with it; click
// (or Enter) to open its card.
//
// The simulation writes transforms straight to the DOM every frame — React
// only renders the bubbles and the card's content. It runs only while
// `running` and on screen. Reduced motion gets the bubbles parked at home.

// By dictionary index: Scale, Flow, Memory. Positions, sizes and label scale
// are the prototype's; the minimum sizes also give way on a narrow screen,
// where the prototype's 230-290px floors would fill a phone.
const DEFS = [
  { img: '/about/bubble-2.webp', x: 44, y: 66, width: 24, min: 240, minShare: 0.42, max: 460, font: 0.15, minFont: 22, maxFont: 52 },
  { img: '/about/bubble-1.webp', x: 30, y: 40, width: 23.5, min: 230, minShare: 0.42, max: 440, font: 0.15, minFont: 22, maxFont: 52 },
  { img: '/about/bubble-3.webp', x: 58, y: 42, width: 30.5, min: 290, minShare: 0.52, max: 580, font: 0.115, minFont: 24, maxFont: 58 },
]

const REPEL_RADIUS = 150
const REPEL_STRENGTH = 0.55
const WANDER_FORCE = 0.01
const DAMPING = 0.972
const MAX_SPEED = 2.1
const CLICK_MOVE = 6
const COLLIDE_STRENGTH = 2.6
const COLLIDE_OVERLAP = 0.94
const BOB_AMP = 16

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const rand = (a, b) => a + Math.random() * (b - a)

const prefersReduced = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

const sizeFor = (d, W) => clamp((d.width / 100) * W, Math.min(d.min, W * d.minShare), d.max)

export default function GlassBubbles({ pillars, closeLabel, running = true, className = '' }) {
  const fieldRef = useRef(null)
  const orbRefs = useRef([])
  const cardRef = useRef(null)
  const sim = useRef(null)
  const [reduced] = useState(prefersReduced)
  const [active, setActive] = useState(null)
  const activeRef = useRef(null)
  activeRef.current = active

  // Close the card when the scene moves on, so it isn't left hanging when the
  // bubbles float away.
  useEffect(() => {
    if (!running) setActive(null)
  }, [running])

  useEffect(() => {
    const field = fieldRef.current
    if (!field) return undefined
    let W = field.clientWidth
    let H = field.clientHeight

    const orbs = DEFS.map((d, i) => {
      const w = sizeFor(d, W)
      return {
        d,
        el: orbRefs.current[i],
        w,
        x: (d.x / 100) * W,
        y: (d.y / 100) * H,
        vx: 0,
        vy: 0,
        wanderX: (d.x / 100) * W,
        wanderY: (d.y / 100) * H,
        wanderTimer: rand(2, 4),
        breathePhase: rand(0, Math.PI * 2),
        breatheSpeed: rand(0.28, 0.42),
        bobPhase: rand(0, Math.PI * 2),
        bobSpeed: rand(0.1, 0.16),
        dragging: false,
        dragOffX: 0,
        dragOffY: 0,
        downX: 0,
        downY: 0,
        jellyMag: 0,
        jellyT: 0,
      }
    })
    const state = { orbs, mouse: { x: -9999, y: -9999 }, t: 0 }
    sim.current = state

    const applySize = (o) => {
      o.el.style.width = `${o.w}px`
      o.el.style.height = `${o.w}px`
      const label = o.el.querySelector('[data-label]')
      if (label) label.style.fontSize = `${clamp(o.w * o.d.font, o.d.minFont, o.d.maxFont)}px`
    }
    const place = (o, bobY = 0, sx = 1, sy = 1, tilt = 0) => {
      o.el.style.transform = `translate(${(o.x - o.w / 2).toFixed(1)}px, ${(o.y - o.w / 2 + bobY).toFixed(
        1,
      )}px) rotate(${tilt.toFixed(1)}deg) scale(${sx.toFixed(3)}, ${sy.toFixed(3)})`
    }
    const placeCard = () => {
      const i = activeRef.current
      const card = cardRef.current
      if (i === null || !card) return
      const o = orbs[i]
      const cw = card.offsetWidth
      const ch = card.offsetHeight
      const left = clamp(o.x - cw / 2, 16, W - cw - 16)
      let top = o.y + o.w / 2 + 22
      if (top + ch > H - 16) top = o.y - o.w / 2 - ch - 22
      card.style.left = `${left}px`
      card.style.top = `${Math.max(16, top)}px`
    }
    state.placeCard = placeCard

    orbs.forEach((o) => {
      applySize(o)
      place(o)
    })

    const ro = new ResizeObserver(() => {
      const nW = field.clientWidth
      const nH = field.clientHeight
      if (!nW || !nH) return
      const sx = nW / W
      const sy = nH / H
      W = nW
      H = nH
      orbs.forEach((o) => {
        o.x *= sx
        o.y *= sy
        o.wanderX *= sx
        o.wanderY *= sy
        o.w = sizeFor(o.d, W)
        applySize(o)
        place(o)
      })
      placeCard()
    })
    ro.observe(field)

    if (reduced) {
      return () => ro.disconnect()
    }

    const onMove = (e) => {
      const r = field.getBoundingClientRect()
      state.mouse.x = e.clientX - r.left
      state.mouse.y = e.clientY - r.top
    }
    const onLeave = () => {
      state.mouse.x = -9999
      state.mouse.y = -9999
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    document.addEventListener('pointerleave', onLeave)

    const collide = (dt) => {
      for (let i = 0; i < orbs.length; i += 1) {
        for (let j = i + 1; j < orbs.length; j += 1) {
          const a = orbs[i]
          const b = orbs[j]
          const dx = b.x - a.x
          const dy = b.y - a.y
          const dist = Math.hypot(dx, dy) || 0.0001
          const minDist = ((a.w + b.w) / 2) * COLLIDE_OVERLAP
          if (dist >= minDist) continue
          const overlap = (minDist - dist) / minDist
          const nx = dx / dist
          const ny = dy / dist
          // Separate right at the edges so they touch and bump, not fuse.
          const pushOut = (minDist - dist) * 0.5
          a.x -= nx * pushOut
          a.y -= ny * pushOut
          b.x += nx * pushOut
          b.y += ny * pushOut
          const push = overlap * COLLIDE_STRENGTH * dt
          a.vx -= nx * push
          a.vy -= ny * push
          b.vx += nx * push
          b.vy += ny * push
          const impact = clamp(overlap * 1.6, 0, 1)
          if (impact > a.jellyMag * 0.5) {
            a.jellyMag = impact
            a.jellyT = 0
          }
          if (impact > b.jellyMag * 0.5) {
            b.jellyMag = impact
            b.jellyT = 0
          }
        }
      }
    }

    let raf = 0
    let last = performance.now()
    let visible = false

    const tick = (now) => {
      raf = 0
      const dt = Math.min((now - last) / 16.67, 3)
      last = now
      state.t += 0.016 * dt
      const { x: mx, y: my } = state.mouse

      collide(dt)

      for (const o of orbs) {
        if (o.dragging) {
          const px = o.x
          const py = o.y
          o.x += (mx - o.dragOffX - o.x) * Math.min(0.35 * dt, 1)
          o.y += (my - o.dragOffY - o.y) * Math.min(0.35 * dt, 1)
          o.vx = o.x - px
          o.vy = o.y - py
        } else {
          o.wanderTimer -= 0.016 * dt
          if (o.wanderTimer <= 0) {
            const margin = o.w / 2 + 10
            const jx = clamp(W * 0.12, 50, 190)
            const jy = clamp(H * 0.1, 40, 150)
            o.wanderX = clamp((o.d.x / 100) * W + rand(-jx, jx), margin, W - margin)
            o.wanderY = clamp((o.d.y / 100) * H + rand(-jy, jy), margin, H - margin)
            o.wanderTimer = rand(4, 7)
          }
          const dxw = o.wanderX - o.x
          const dyw = o.wanderY - o.y
          const dw = Math.hypot(dxw, dyw) || 1
          o.vx += (dxw / dw) * WANDER_FORCE * dt
          o.vy += (dyw / dw) * WANDER_FORCE * dt

          const dx = o.x - mx
          const dy = o.y - my
          const dist = Math.hypot(dx, dy) || 1
          if (dist < REPEL_RADIUS) {
            const force = ((REPEL_RADIUS - dist) / REPEL_RADIUS) * REPEL_STRENGTH
            o.vx += (dx / dist) * force * dt
            o.vy += (dy / dist) * force * dt
          }

          o.vx *= DAMPING ** dt
          o.vy *= DAMPING ** dt
          const spd = Math.hypot(o.vx, o.vy)
          if (spd > MAX_SPEED) {
            o.vx = (o.vx / spd) * MAX_SPEED
            o.vy = (o.vy / spd) * MAX_SPEED
          }
          o.x += o.vx * dt
          o.y += o.vy * dt

          const m = o.w / 2 + 6
          if (o.x < m) {
            o.x = m
            o.vx = Math.abs(o.vx) * 0.5
          }
          if (o.x > W - m) {
            o.x = W - m
            o.vx = -Math.abs(o.vx) * 0.5
          }
          if (o.y < m) {
            o.y = m
            o.vy = Math.abs(o.vy) * 0.5
          }
          if (o.y > H - m) {
            o.y = H - m
            o.vy = -Math.abs(o.vy) * 0.5
          }
        }

        // Buoyant bob: a slow rise for most of the cycle, a quick soft reset.
        o.bobPhase += o.bobSpeed * 0.016 * dt
        const bt = (o.bobPhase % (Math.PI * 2)) / (Math.PI * 2)
        const bobY = -BOB_AMP * (bt < 0.8 ? bt / 0.8 : 1 - (bt - 0.8) / 0.2)

        // Jelly squash-and-stretch, decaying after a bump or a release.
        o.jellyT += 0.016 * dt
        const jelly = o.jellyMag * Math.exp(-o.jellyT * 5.5) * Math.sin(o.jellyT * 26)
        const breathe = Math.sin(state.t * o.breatheSpeed + o.breathePhase) * 0.018
        const stX = clamp(o.vx * 0.03, -0.1, 0.1)
        const stY = clamp(o.vy * 0.03, -0.1, 0.1)
        const boost = (activeRef.current === orbs.indexOf(o) ? 0.04 : 0) + (o.dragging ? 0.04 : 0)
        const sx = 1 + breathe + stX - stY * 0.4 + boost + jelly * 0.5
        const sy = 1 + breathe + stY - stX * 0.4 + boost - jelly * 0.35
        place(o, bobY, sx, sy, clamp(o.vx, -6, 6))
      }
      placeCard()
      if (visible) raf = requestAnimationFrame(tick)
    }

    state.start = () => {
      if (!raf && visible) {
        last = performance.now()
        raf = requestAnimationFrame(tick)
      }
    }
    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting
      state.start()
    })
    io.observe(field)

    return () => {
      if (raf) cancelAnimationFrame(raf)
      ro.disconnect()
      io.disconnect()
      window.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerleave', onLeave)
    }
  }, [reduced])

  // Position the card as soon as it opens, before the next frame does.
  useEffect(() => {
    sim.current?.placeCard?.()
  }, [active])

  useEffect(() => {
    if (active === null) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape') setActive(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])

  const onPointerDown = (i) => (e) => {
    const s = sim.current
    if (!s || reduced) return
    const o = s.orbs[i]
    const r = fieldRef.current.getBoundingClientRect()
    s.mouse.x = e.clientX - r.left
    s.mouse.y = e.clientY - r.top
    o.el.setPointerCapture?.(e.pointerId)
    o.dragging = true
    o.dragOffX = s.mouse.x - o.x
    o.dragOffY = s.mouse.y - o.y
    o.downX = e.clientX
    o.downY = e.clientY
  }
  const onPointerUp = (i) => (e) => {
    const o = sim.current?.orbs[i]
    if (!o?.dragging) return
    o.dragging = false
    o.jellyMag = clamp(Math.hypot(o.vx, o.vy) * 0.35, 0.2, 1)
    o.jellyT = 0
    o.moved = Math.hypot(e.clientX - o.downX, e.clientY - o.downY)
  }
  const onClick = (i) => () => {
    const o = sim.current?.orbs[i]
    // A drag that ends over the bubble still fires a click; only a press
    // that stayed put opens the card.
    if (o && o.moved > CLICK_MOVE) {
      o.moved = 0
      return
    }
    setActive((cur) => (cur === i ? null : i))
  }

  const current = active === null ? null : pillars[active]

  return (
    <div ref={fieldRef} className={`absolute inset-0 ${className}`}>
      {pillars.map((p, i) => (
        <button
          key={p.title}
          ref={(el) => {
            orbRefs.current[i] = el
          }}
          type="button"
          aria-expanded={active === i}
          aria-controls="pillar-card"
          onPointerDown={onPointerDown(i)}
          onPointerUp={onPointerUp(i)}
          onPointerCancel={onPointerUp(i)}
          onClick={onClick(i)}
          className={`glass-orb absolute left-0 top-0 touch-none select-none rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-light ${
            active === i ? 'glass-orb--active' : ''
          }`}
        >
          <img
            src={DEFS[i].img}
            alt=""
            draggable="false"
            className="pointer-events-none absolute inset-0 h-full w-full rounded-full object-contain [filter:brightness(1.18)_saturate(0.8)_contrast(0.93)_hue-rotate(-4deg)]"
          />
          <span
            data-label
            className="pointer-events-none absolute left-1/2 top-[52%] -translate-x-1/2 -translate-y-1/2 whitespace-nowrap font-serif italic tracking-[0.02em] text-[#1c2740] [text-shadow:0_1px_0_rgba(255,255,255,0.22),0_2px_10px_rgba(255,240,210,0.28)]"
          >
            {p.title}
          </span>
        </button>
      ))}

      <div
        ref={cardRef}
        id="pillar-card"
        role="dialog"
        aria-label={current?.title}
        aria-hidden={!current}
        className={`absolute z-20 w-[min(340px,78vw)] rounded-[22px] border border-[#fff8e6]/20 bg-[linear-gradient(160deg,rgba(46,28,10,0.55),rgba(22,13,5,0.68))] px-[26px] pb-6 pt-7 shadow-[0_24px_60px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.09)] backdrop-blur-[24px] backdrop-saturate-150 transition-[opacity,transform] duration-300 ${
          current ? 'translate-y-0 scale-100 opacity-100' : 'pointer-events-none translate-y-2.5 scale-[0.97] opacity-0'
        }`}
      >
        <button
          type="button"
          onClick={() => setActive(null)}
          aria-label={closeLabel}
          className="absolute right-4 top-3.5 flex h-[26px] w-[26px] items-center justify-center rounded-full border border-[#fff8e6]/30 text-[#fff9ea] transition-colors hover:bg-[#fff8e6]/10"
        >
          ×
        </button>
        <h3 className="mb-2.5 font-serif text-[1.7rem] italic text-[#fff9ea]">{current?.title}</h3>
        <p className="text-[0.98rem] font-light leading-[1.65] text-[#f3c583]">{current?.desc}</p>
      </div>
    </div>
  )
}
