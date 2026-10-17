import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Eraser } from 'lucide-react'
import { useT } from '../i18n'

// A drawing surface for a signature. Pointer events, so a finger, a pen and a mouse all work, and
// `touch-action: none` so drawing does not scroll the page. The picture it hands back is a PNG with a
// transparent background and dark ink, which is what the delivery-order PDF and the server expect.
//
//   const pad = useRef()
//   <SignaturePad ref={pad} onChange={(hasInk) => ...} />
//   const blob = await pad.current.toBlob()   // null when nothing has been drawn

const WIDTH = 480
const HEIGHT = 180
const INK = '#14213d'

const SignaturePad = forwardRef(function SignaturePad({ onChange }, ref) {
  const canvas = useRef(null)
  const drawing = useRef(false)
  const last = useRef(null)
  const [hasInk, setHasInk] = useState(false)
  const t = useT()

  useEffect(() => {
    const ctx = canvas.current.getContext('2d')
    ctx.lineWidth = 2.4
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = INK
  }, [])

  const point = (e) => {
    const rect = canvas.current.getBoundingClientRect()
    return {
      x: ((e.clientX - rect.left) / rect.width) * WIDTH,
      y: ((e.clientY - rect.top) / rect.height) * HEIGHT,
    }
  }

  const setInk = (value) => {
    setHasInk(value)
    onChange?.(value)
  }

  const down = (e) => {
    e.preventDefault()
    canvas.current.setPointerCapture?.(e.pointerId)
    drawing.current = true
    last.current = point(e)
    // A tap leaves a dot rather than nothing.
    const ctx = canvas.current.getContext('2d')
    ctx.beginPath()
    ctx.arc(last.current.x, last.current.y, 1.2, 0, Math.PI * 2)
    ctx.fillStyle = INK
    ctx.fill()
    setInk(true)
  }

  const move = (e) => {
    if (!drawing.current) return
    e.preventDefault()
    const ctx = canvas.current.getContext('2d')
    const p = point(e)
    ctx.beginPath()
    ctx.moveTo(last.current.x, last.current.y)
    ctx.lineTo(p.x, p.y)
    ctx.stroke()
    last.current = p
  }

  const up = () => {
    drawing.current = false
    last.current = null
  }

  const clear = () => {
    canvas.current.getContext('2d').clearRect(0, 0, WIDTH, HEIGHT)
    setInk(false)
  }

  useImperativeHandle(ref, () => ({
    clear,
    toBlob: () => new Promise((resolve) => {
      if (!hasInk) return resolve(null)
      canvas.current.toBlob((blob) => resolve(blob), 'image/png')
    }),
  }))

  return (
    <div>
      <div className="relative rounded-lg border border-white/15 bg-white overflow-hidden">
        <canvas
          ref={canvas}
          width={WIDTH}
          height={HEIGHT}
          aria-label={t('Signature pad')}
          data-testid="signature-pad"
          className="block w-full touch-none cursor-crosshair"
          style={{ touchAction: 'none', aspectRatio: `${WIDTH} / ${HEIGHT}` }}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerLeave={up}
          onPointerCancel={up}
        />
        {!hasInk && (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-slate-400">
            {t('Sign here')}
          </span>
        )}
      </div>
      <button type="button" onClick={clear} disabled={!hasInk} className="mt-2 inline-flex items-center gap-1 text-xs text-white/50 hover:text-white disabled:opacity-30">
        <Eraser size={12} /> {t('Clear')}
      </button>
    </div>
  )
})

export default SignaturePad
