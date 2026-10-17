import { flushSync } from 'react-dom'
import { useNavigate } from 'react-router-dom'

const prefersReduced = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

// Navigates inside a browser view transition, so an element carrying the same
// `view-transition-name` on both pages (a portfolio tile and its case page's
// hero) morphs from one to the other instead of cutting.
//
// React Router's own `viewTransition` option only works with a data router and
// this app uses <BrowserRouter>, hence doing it by hand: flushSync makes the
// new route render inside the transition's update callback. Browsers without
// the API, and reduced motion, just navigate.
export default function useViewTransitionNavigate() {
  const navigate = useNavigate()
  return (to) => {
    if (!document.startViewTransition || prefersReduced()) {
      navigate(to)
      return
    }
    document.startViewTransition(() => {
      flushSync(() => navigate(to))
    })
  }
}
