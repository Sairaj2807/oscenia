import { useLayoutEffect } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import Nav from './Nav'
import Footer from './Footer'
import QuickContact from './QuickContact'
import Ripple from './Ripple'
import Sound from './Sound'
import useSmoothScroll, { getLenis } from './useSmoothScroll'
import usePrefetch from './usePrefetch'

// Scrolls to top on route change — or, when the link carries a #hash, to that
// element (a case page's Back lands on the Services grid, not the curtains).
// Child effects run before this one, so the target is already rendered.
//
// A layout effect, so the jump lands before the new page is first painted.
//
// The smooth-scroll glide is stopped for the jump and restarted after it. A
// wheel glide still in flight from the previous page would otherwise carry on
// over the new one (and an immediate scrollTo does not cancel it). Restarting
// re-reads the real position and re-measures the new page's height.
function ScrollToTop() {
  const { pathname, hash } = useLocation()
  useLayoutEffect(() => {
    const lenis = getLenis()
    lenis?.stop()
    const settle = () => {
      if (!lenis) return
      lenis.start()
      lenis.resize()
    }
    const target = hash && document.getElementById(hash.slice(1))
    if (target) {
      const align = () => target.scrollIntoView({ behavior: 'instant', block: 'start' })
      align()
      settle()
      // Aligned again once the new page has finished its own first layout,
      // which can still move the target by a few dozen pixels.
      const raf = requestAnimationFrame(align)
      return () => cancelAnimationFrame(raf)
    }
    // 'instant', not 'auto': a route change should snap to the top, never
    // animate there.
    window.scrollTo({ top: 0, behavior: 'instant' })
    settle()
  }, [pathname, hash])
  return null
}

export default function Layout() {
  const { pathname } = useLocation()
  // The home page's footer is laid over its closing film, so Home renders it
  // itself (see pages/Home.jsx). Every other route gets it here, on a panel.
  const isHome = pathname === '/'
  useSmoothScroll()
  usePrefetch()

  return (
    // `isolate` is what lets the ripple sit behind the page without touching a
    // single other z-index. It makes this div a stacking context, so the
    // canvas's negative z-index puts it above this element's own background but
    // below everything in normal flow. Lifting the content instead — wrapping
    // main in a z-10 div — would scope any fixed overlay inside that wrapper
    // and leave the nav floating over it.
    <div className="bg-oscenia isolate min-h-screen">
      <ScrollToTop />
      <Ripple />
      <Nav />
      <main>
        <Outlet />
      </main>
      <QuickContact />
      <Sound />
      {!isHome && <Footer />}
    </div>
  )
}
