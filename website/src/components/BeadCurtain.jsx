import { useEffect, useRef } from 'react'

// The Services stage's centrepiece: a bead curtain. Each column is a hanging
// chain of beads (logo, big, small, big, repeating), pinned at the top and
// pulled by gravity; the pointer (or a finger) pushes through it and the
// strands swing and settle, each bead turning with its strand.
//
// Verlet points joined by distance constraints, ported from the prototype
// that replaced the old letter curtain. Sprites live in public/services.

const SPRITES = {
  logo: { src: '/services/bead-logo.png', w: 66, h: 45 },
  big: { src: '/services/bead-big.png', w: 32, h: 32 },
  small: { src: '/services/bead-small.png', w: 18, h: 18 },
}
const PATTERN = ['logo', 'big', 'small', 'big']
const GAP = { logo: 41, big: 44, small: 31 }
const GAP_AFTER_SMALL = 28
const TYPE_SCALE = { logo: 0.64, big: 0.58, small: 0.52 }
const COL_SPACING = 49
const GRAVITY = 0.55
const DAMPING = 0.965
const ITERATIONS = 4
const MAX_SPEED = 28
const MOUSE_RADIUS = 70
const MOUSE_FORCE = 2.2
const WIDTH_SHARE = 0.8
const HEIGHT_SHARE = 0.76

const prefersReduced = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

export default function BeadCurtain({ className = '' }) {
  const canvasRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    const ctx = canvas.getContext('2d')
    const reduced = prefersReduced()

    let width = 0
    let height = 0
    let dpr = 1
    let columns = []
    const images = {}
    const mouse = { x: -9999, y: -9999, active: false }
    let raf = 0
    let visible = false
    let alive = true

    const gapFor = (type, prev) => (prev === 'small' ? GAP_AFTER_SMALL : GAP[type])

    const build = () => {
      const r = canvas.getBoundingClientRect()
      width = r.width
      height = r.height
      if (!width || !height) return
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      const blockW = width * WIDTH_SHARE
      const blockH = height * HEIGHT_SHARE
      const offsetX = (width - blockW) / 2
      const offsetY = (height - blockH) / 2
      const cols = Math.max(1, Math.floor(blockW / COL_SPACING) + 1)
      const startX = offsetX + (blockW - (cols - 1) * COL_SPACING) / 2
      columns = []
      for (let c = 0; c < cols; c += 1) {
        const x = startX + c * COL_SPACING
        let y = offsetY + SPRITES.logo.h * TYPE_SCALE.logo * 0.5
        const points = []
        let prev = null
        for (let i = 0; ; i += 1) {
          const type = PATTERN[i % PATTERN.length]
          const rest = i === 0 ? 0 : gapFor(type, prev)
          if (i > 0) y += rest
          if (y > offsetY + blockH) break
          points.push({ x, y, ox: x, oy: y, fixed: i === 0, type, rest })
          prev = type
        }
        columns.push(points)
      }
    }

    const step = () => {
      const r2 = MOUSE_RADIUS * MOUSE_RADIUS
      for (const points of columns) {
        for (let i = 1; i < points.length; i += 1) {
          const p = points[i]
          const vx = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, (p.x - p.ox) * DAMPING))
          const vy = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, (p.y - p.oy) * DAMPING))
          p.ox = p.x
          p.oy = p.y
          p.x += vx
          p.y += vy + GRAVITY
          if (mouse.active) {
            const dx = p.x - mouse.x
            const dy = p.y - mouse.y
            const d2 = dx * dx + dy * dy
            if (d2 < r2 && d2 > 0.001) {
              const d = Math.sqrt(d2)
              const f = ((MOUSE_RADIUS - d) / MOUSE_RADIUS) * MOUSE_FORCE
              p.x += (dx / d) * f
              p.y += (dy / d) * f
            }
          }
        }
      }
      for (let k = 0; k < ITERATIONS; k += 1) {
        for (const points of columns) {
          for (let i = 0; i < points.length - 1; i += 1) {
            const a = points[i]
            const b = points[i + 1]
            const dx = b.x - a.x
            const dy = b.y - a.y
            const dist = Math.sqrt(dx * dx + dy * dy) || 0.0001
            const diff = (dist - b.rest) / dist
            const ox = dx * 0.5 * diff
            const oy = dy * 0.5 * diff
            if (!a.fixed) {
              a.x += ox
              a.y += oy
            }
            if (!b.fixed) {
              b.x -= ox
              b.y -= oy
            } else {
              a.x += ox
              a.y += oy
            }
          }
        }
      }
    }

    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      for (const points of columns) {
        for (let i = 0; i < points.length; i += 1) {
          const p = points[i]
          const s = SPRITES[p.type]
          const sc = TYPE_SCALE[p.type]
          const w = s.w * sc
          const h = s.h * sc
          const angle = i > 0 ? -Math.atan2(p.x - points[i - 1].x, p.y - points[i - 1].y) : 0
          const cos = Math.cos(angle)
          const sin = Math.sin(angle)
          ctx.setTransform(dpr * cos, dpr * sin, -dpr * sin, dpr * cos, p.x * dpr, p.y * dpr)
          ctx.drawImage(images[p.type], -w / 2, -h / 2, w, h)
        }
      }
    }

    const loop = () => {
      raf = 0
      if (!alive || !visible) return
      step()
      draw()
      raf = requestAnimationFrame(loop)
    }
    const start = () => {
      if (!raf && visible && !reduced) raf = requestAnimationFrame(loop)
    }

    const setPointer = (clientX, clientY) => {
      const r = canvas.getBoundingClientRect()
      mouse.x = clientX - r.left
      mouse.y = clientY - r.top
      mouse.active = true
    }
    const onMouse = (e) => setPointer(e.clientX, e.clientY)
    const onTouch = (e) => {
      if (e.touches[0]) setPointer(e.touches[0].clientX, e.touches[0].clientY)
    }
    const off = () => {
      mouse.active = false
    }

    const ro = new ResizeObserver(() => {
      build()
      draw()
    })
    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting
      start()
    })

    const keys = Object.keys(SPRITES)
    let loaded = 0
    keys.forEach((k) => {
      const img = new Image()
      img.onload = () => {
        loaded += 1
        if (!alive || loaded !== keys.length) return
        build()
        draw()
        ro.observe(canvas)
        io.observe(canvas)
        if (!reduced) {
          window.addEventListener('mousemove', onMouse, { passive: true })
          window.addEventListener('touchmove', onTouch, { passive: true })
          document.addEventListener('mouseleave', off)
          window.addEventListener('touchend', off)
          window.addEventListener('touchcancel', off)
        }
      }
      img.src = SPRITES[k].src
      images[k] = img
    })

    return () => {
      alive = false
      if (raf) cancelAnimationFrame(raf)
      ro.disconnect()
      io.disconnect()
      window.removeEventListener('mousemove', onMouse)
      window.removeEventListener('touchmove', onTouch)
      document.removeEventListener('mouseleave', off)
      window.removeEventListener('touchend', off)
      window.removeEventListener('touchcancel', off)
    }
  }, [])

  return <canvas ref={canvasRef} aria-hidden="true" className={`block ${className}`} />
}
