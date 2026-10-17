import { useEffect, useRef } from 'react'

// The Services stage's centrepiece: a curtain made of the name. Each column of
// letters is a hanging chain spelling O-s-c-e-n-i-a downward, pinned at the
// top and pulled by gravity; the pointer (or a finger) pushes through it and
// the strands swing and settle like a bead curtain, each letter turning with
// its strand.
//
// A port of the designer's prototype, brand-assets/3. Services Page/
// oscenia_curtain.html (Verlet points joined by distance constraints), with
// its tuning kept. Set in the brand gold here rather than the prototype's
// black-on-white working colours, so it reads on the stage's navy velvet.
// The block's share of the stage matches the layout board, Photo Assets/
// Artboard 2.png.

const WORD = 'Oscenia'
const GRAVITY = 0.55
const DAMPING = 0.965
const ITERATIONS = 3
const MAX_SPEED = 28
const WIDTH_SHARE = 0.66
const HEIGHT_SHARE = 0.62
const COLOUR = 'rgba(224, 199, 137, 0.92)'

const prefersReduced = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

export default function LetterCurtain({ className = '' }) {
  const canvasRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    const ctx = canvas.getContext('2d')
    const reduced = prefersReduced()

    let width = 0
    let height = 0
    let dpr = 1
    let size = 30
    let rowGap = 32
    let columns = []
    const mouse = { x: -9999, y: -9999, active: false, radius: 95, force: 2.6 }
    let raf = 0
    let visible = false
    let alive = true

    const build = () => {
      const r = canvas.getBoundingClientRect()
      width = r.width
      height = r.height
      if (!width || !height) return
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      // The prototype is drawn at 30px on a 1366-wide screen; this keeps that
      // proportion, within limits a phone and a large monitor can both read.
      size = Math.max(16, Math.min(32, width / 45))
      rowGap = size * 1.08
      const colGap = size * 0.72
      mouse.radius = size * 3.2
      const blockW = width * WIDTH_SHARE
      const blockH = height * HEIGHT_SHARE
      const top = (height - blockH) / 2
      const cols = Math.max(1, Math.floor(blockW / colGap))
      const rows = Math.max(1, Math.floor(blockH / rowGap))
      const startX = (width - (cols - 1) * colGap) / 2
      columns = []
      for (let c = 0; c < cols; c += 1) {
        const x = startX + c * colGap
        const points = []
        for (let row = 0; row < rows; row += 1) {
          const y = top + row * rowGap + size * 0.5
          points.push({ x, y, ox: x, oy: y, fixed: row === 0, letter: WORD[row % WORD.length] })
        }
        columns.push(points)
      }
    }

    const step = () => {
      const r2 = mouse.radius * mouse.radius
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
              const f = ((mouse.radius - d) / mouse.radius) * mouse.force
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
            const diff = (dist - rowGap) / dist
            const ox = dx * 0.5 * diff
            const oy = dy * 0.5 * diff
            if (!a.fixed) {
              a.x += ox
              a.y += oy
            }
            if (!b.fixed) {
              b.x -= ox
              b.y -= oy
            }
          }
        }
      }
    }

    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)
      ctx.fillStyle = COLOUR
      ctx.font = `italic 300 ${size}px Fraunces, Georgia, serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      for (const points of columns) {
        for (let i = 0; i < points.length; i += 1) {
          const p = points[i]
          // Each letter turns to follow its strand.
          const angle = i > 0 ? Math.atan2(p.x - points[i - 1].x, p.y - points[i - 1].y) : 0
          const cos = Math.cos(angle)
          const sin = Math.sin(angle)
          ctx.setTransform(dpr * cos, dpr * sin, -dpr * sin, dpr * cos, p.x * dpr, p.y * dpr)
          ctx.fillText(p.letter, 0, 0)
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

    // Lay the letters out in the brand face, not whatever stood in for it.
    const ready = document.fonts?.load(`italic 300 ${size}px Fraunces`) ?? Promise.resolve()
    ready
      .catch(() => {})
      .then(() => {
        if (!alive) return
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
