import { useEffect, useId, useRef, useState } from 'react'
import { AUTO_REVEAL_MS } from '../data/deckMotion'

const prefersReduced = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

// Body copy that reveals itself.
//
// The deck fades this copy in ON CLICK, because a presenter is advancing the
// slides. A page has no presenter, so waiting for a click made every block a
// speed bump. Instead it opens on its own a beat after the section is reached,
// and the toggle stays available for anyone who wants to collapse it again.
//
// The 0fr -> 1fr grid trick animates height without a measured pixel value, and
// collapses cleanly at any content length.
export default function Disclosure({
  summary,
  children,
  className = '',
  summaryClassName = '',
  panelClassName = '',
  from = 'up',
  align = 'start',
  autoOpenAfter = AUTO_REVEAL_MS,
}) {
  // Reduced motion gets the copy immediately and never animates it: content
  // that opens itself on a timer is exactly what that setting asks us not to do.
  const [reduced] = useState(prefersReduced)
  const [open, setOpen] = useState(reduced)
  // Once someone has taken control, stop opening things behind their back.
  const [touched, setTouched] = useState(false)
  const ref = useRef(null)
  const id = useId()

  // Opens a beat after the section is reached, and closes again once it leaves,
  // so returning to the section replays the reveal rather than finding it
  // already open. Stops entirely once the visitor has used the toggle.
  useEffect(() => {
    if (reduced || touched || autoOpenAfter == null) return undefined
    const el = ref.current
    if (!el) return undefined
    let timer = 0
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          timer = setTimeout(() => setOpen(true), autoOpenAfter)
        } else {
          if (timer) clearTimeout(timer)
          timer = 0
          setOpen(false)
        }
      },
      { threshold: 0.3 },
    )
    io.observe(el)
    return () => {
      io.disconnect()
      if (timer) clearTimeout(timer)
    }
  }, [reduced, touched, autoOpenAfter])

  const hidden =
    from === 'up' ? 'translate-y-3' : from === 'down' ? '-translate-y-3' : 'translate-y-0'

  return (
    <div ref={ref} className={className}>
      <button
        type="button"
        onClick={() => {
          setTouched(true)
          setOpen((v) => !v)
        }}
        aria-expanded={open}
        aria-controls={id}
        className={`group flex w-full items-center gap-3 text-left transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-gold ${
          align === 'center' ? 'justify-center' : ''
        } ${summaryClassName}`}
      >
        {summary}
        <span
          aria-hidden="true"
          className={`shrink-0 text-xl font-light leading-none text-gold transition-transform duration-500 ${
            open ? 'rotate-45' : 'group-hover:scale-125'
          }`}
        >
          +
        </span>
      </button>

      <div
        id={id}
        className={`grid transition-all duration-700 ease-out motion-reduce:transition-none ${
          open ? 'grid-rows-[1fr] opacity-100' : `grid-rows-[0fr] opacity-0 ${hidden}`
        }`}
      >
        <div className={`overflow-hidden ${panelClassName}`}>{children}</div>
      </div>
    </div>
  )
}
