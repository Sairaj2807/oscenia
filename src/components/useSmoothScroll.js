import { useEffect } from 'react'
import Lenis from 'lenis'
import 'lenis/dist/lenis.css'

// Inertia scrolling for the whole site. A mouse wheel moves the page in
// notched jumps, and every scroll-played scene here (the curtains, the
// champagne glass, the collage, the satin windows) jumped with it. Lenis eases
// wheel and trackpad input into a glide instead.
//
// It still scrolls the real window — nothing is transformed — so position:
// sticky, IntersectionObserver and useScrollProgress all keep working as they
// did. Touch scrolling is left native (phones already glide), and so is
// everything under reduced motion, where no instance is made at all.
//
// One instance, kept at module scope so the router's scroll-to-top can jump it
// (see getLenis in Layout).

let lenis = null

export const getLenis = () => lenis

const prefersReduced = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

export default function useSmoothScroll() {
  useEffect(() => {
    if (prefersReduced()) return undefined

    lenis = new Lenis({
      // Share of the remaining distance covered each frame: lower is silkier
      // but lags the hand more. 0.09 settles in about half a second.
      lerp: 0.09,
      smoothWheel: true,
      syncTouch: false,
      anchors: true,
      autoRaf: true,
    })

    // Anything that locks the page (the mobile nav drawer sets body overflow
    // hidden) must lock the glide too, or the wheel would still move the page
    // behind it.
    const sync = () => {
      if (document.body.style.overflow === 'hidden') lenis.stop()
      else lenis.start()
    }
    const mo = new MutationObserver(sync)
    mo.observe(document.body, { attributes: true, attributeFilter: ['style'] })

    return () => {
      mo.disconnect()
      lenis.destroy()
      lenis = null
    }
  }, [])
}
