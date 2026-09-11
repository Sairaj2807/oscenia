import { useLayoutEffect, useRef } from 'react'
import { TOSS } from '../data/formatsMotion'

// Throws a card onto the table as its slot arrives: the photo from just off its
// own side of the screen, above its slot and tilted; the caption separately,
// from lower down and dimmed. Numbers and curves are in data/formatsMotion.js.
//
// Returns four refs. `slot` is the untransformed grid cell — that's what's
// watched, because the photo itself starts off-screen and would never be seen
// to intersect anything. `photo`, `slide` and `rise` are the moving layers;
// the caption is split in two so its sideways and upward moves can keep their
// own timing, which is how the recording has them.
//
// Styles are written directly rather than through React state, so a flight
// never waits on a render, and so the parked position can be measured and
// applied in the same frame the flight starts from it.
const matches = (query) =>
  typeof window !== 'undefined' && window.matchMedia?.(query).matches

const set = (el, props) => Object.assign(el.style, props)

export default function useCardToss(side) {
  const slot = useRef(null)
  const photo = useRef(null)
  const slide = useRef(null)
  const rise = useRef(null)

  useLayoutEffect(() => {
    if (matches('(prefers-reduced-motion: reduce)')) return undefined
    const cell = slot.current
    const pic = photo.current
    const cap = slide.current
    const lift = rise.current
    if (!cell || !pic || !cap || !lift) return undefined

    const dir = side === 'left' ? -1 : 1
    let landed = false

    const plan = () => {
      const vw = window.innerWidth
      const vh = window.innerHeight
      const small = vw < 640
      const tilt = small ? -dir * TOSS.small.tilt : TOSS.tilt[side]
      let tx
      if (small) {
        tx = (dir * TOSS.small.travelVw * vw) / 100
      } else {
        // Just clear of the screen edge, including the corners the tilt swings
        // outward. Layout sizes, so a card caught mid-flight measures the same.
        const box = cell.getBoundingClientRect()
        const w = pic.offsetWidth
        const h = pic.offsetHeight
        const th = (Math.abs(tilt) * Math.PI) / 180
        const reach = (w / 2) * Math.cos(th) + (h / 2) * Math.sin(th) + 16
        const cx = box.left + w / 2
        tx = dir < 0 ? -(cx + reach) : vw - cx + reach
      }
      return {
        small,
        tilt,
        tx,
        ty: -(small ? TOSS.small.riseVh / 100 : TOSS.rise) * vh,
        cx: (dir * (small ? TOSS.small.captionVw : TOSS.captionSlide.offsetVw) * vw) / 100,
        cy: ((small ? TOSS.small.captionVh : TOSS.captionRise.offsetVh) * vh) / 100,
      }
    }

    const park = () => {
      const p = plan()
      set(pic, {
        transition: 'none',
        translate: `${p.tx}px ${p.ty}px`,
        rotate: `${p.tilt}deg`,
        opacity: p.small ? '0' : '',
      })
      set(cap, { transition: 'none', translate: `${p.cx}px 0px` })
      set(lift, { transition: 'none', translate: `0px ${p.cy}px`, opacity: String(TOSS.captionRise.fromOpacity) })
      return p
    }

    const launch = () => {
      const p = park()
      // Commit the parked position before handing over to the transitions, so
      // the flight starts from it rather than from wherever the card last was.
      void pic.offsetWidth
      const k = p.small ? TOSS.small.durationMs / TOSS.durationMs : 1
      const d = TOSS.durationMs * k
      const s = TOSS.captionSlide
      const r = TOSS.captionRise
      set(pic, {
        transition: [
          `translate ${d}ms ${TOSS.moveEase}`,
          `rotate ${d}ms ${TOSS.tiltEase}`,
          p.small ? `opacity ${Math.round(d * 0.45)}ms ease-out` : '',
        ]
          .filter(Boolean)
          .join(', '),
        translate: '0px 0px',
        rotate: '0deg',
        opacity: '1',
      })
      set(cap, {
        transition: `translate ${s.durationMs * k}ms ${s.ease} ${s.delayMs * k}ms`,
        translate: '0px 0px',
      })
      set(lift, {
        transition: `translate ${r.durationMs * k}ms ${r.ease} ${r.delayMs * k}ms, opacity ${r.durationMs * k}ms ease-out ${r.delayMs * k}ms`,
        translate: '0px 0px',
        opacity: '1',
      })
      landed = true
    }

    // Parked before first paint, so a card below the fold never shows in place.
    park()

    const enter = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting && !landed) launch()
      },
      { rootMargin: `0px 0px -${TOSS.enterInset[side]}px 0px`, threshold: 0 },
    )
    // Only reset once the slot is entirely off screen, so scrolling back to the
    // section replays the toss without ever yanking a visible card away.
    const leave = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting && landed) {
          landed = false
          park()
        }
      },
      { threshold: 0 },
    )
    enter.observe(cell)
    leave.observe(cell)

    // A resize can move a parked card's slot enough for it to peek on screen.
    const onResize = () => {
      if (!landed) park()
    }
    window.addEventListener('resize', onResize)

    return () => {
      enter.disconnect()
      leave.disconnect()
      window.removeEventListener('resize', onResize)
      for (const el of [pic, cap, lift]) {
        set(el, { transition: '', translate: '', rotate: '', opacity: '' })
      }
    }
  }, [side])

  return { slot, photo, slide, rise }
}
