import { useEffect } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import Nav from './Nav'
import Footer from './Footer'
import QuickContact from './QuickContact'
import Ripple from './Ripple'

// Scrolls to top on route change — or, when the link carries a #hash, to that
// element (a case page's Back lands on the Services grid, not the curtains).
// Child effects run before this one, so the target is already rendered.
function ScrollToTop() {
  const { pathname, hash } = useLocation()
  useEffect(() => {
    const target = hash && document.getElementById(hash.slice(1))
    if (target) {
      target.scrollIntoView({ behavior: 'instant', block: 'start' })
      return
    }
    // `'instant' in window` is always false — there is no such window property —
    // so this used to fall back to 'auto', which means "use the CSS value", and
    // index.css sets scroll-behavior: smooth on html. The result was that every
    // route change animated the scroll to the top instead of snapping. 'instant'
    // is the correct ScrollBehavior value and ignores the stylesheet.
    window.scrollTo({ top: 0, behavior: 'instant' })
  }, [pathname, hash])
  return null
}

export default function Layout() {
  const { pathname } = useLocation()
  // The home page's footer is laid over its closing film, so Home renders it
  // itself (see pages/Home.jsx). Every other route gets it here, on a panel.
  const isHome = pathname === '/'

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
      {!isHome && <Footer />}
    </div>
  )
}
