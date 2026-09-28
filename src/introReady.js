import { useEffect, useState } from 'react'

// The intro overlay (components/Intro.jsx) finishes once, ever, per session,
// and announces it by dispatching 'oscenia:intro-done' on window. Anything
// whose entrance animation should only play once the overlay is actually
// gone — the hero headline, its CTA — reads that through this hook instead
// of assuming its own mount time is when the page became visible: the
// headline mounts immediately at page load, while the intro is still
// covering the screen, so an animation timed from mount finishes invisibly
// behind it long before a visitor ever sees the hero.
//
// The `done` flag lives at module scope (not in a component) because the
// event only fires once. On a later mount — navigating back to "/" after
// visiting another route — the intro is long gone and there is nothing left
// to wait for, so the hook must resolve to `true` immediately rather than
// waiting for an event that will never come again.
let done = false
const listeners = new Set()

if (typeof window !== 'undefined') {
  window.addEventListener(
    'oscenia:intro-done',
    () => {
      done = true
      listeners.forEach((fn) => fn())
      listeners.clear()
    },
    { once: true },
  )
}

export function useIntroReady() {
  const [ready, setReady] = useState(done)
  useEffect(() => {
    // `done` may have flipped true between this render and this effect
    // committing — catch up rather than registering a listener that will
    // never fire again.
    if (done) {
      if (!ready) setReady(true)
      return undefined
    }
    const onDone = () => setReady(true)
    listeners.add(onDone)
    return () => listeners.delete(onDone)
  }, [ready])
  return ready
}
