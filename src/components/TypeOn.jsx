import { useEffect, useRef, useState } from 'react'

const prefersReduced = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

const STAGGER_MS = { word: 70, char: 38 }

// Text that writes itself in, the way the About reference sets its copy: body
// paragraphs arrive a word at a time, the value titles a letter at a time.
//
// Plays when it scrolls into view and resets once it has fully left, like
// Reveal. Pass `active` to drive it from a scene instead (the About hero starts
// its paragraph partway through its own scroll).
//
// The sentence is in the DOM once, whole, for screen readers; the animated
// copy is aria-hidden. Reduced motion gets plain text.
export default function TypeOn({
  text,
  as: Tag = 'p',
  by = 'word',
  className = '',
  delay = 0,
  stagger = STAGGER_MS[by],
  active,
}) {
  const ref = useRef(null)
  const [reduced] = useState(prefersReduced)
  const [seen, setSeen] = useState(false)
  const controlled = active !== undefined

  useEffect(() => {
    if (reduced || controlled) return undefined
    const el = ref.current
    if (!el) return undefined
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.intersectionRatio >= 0.3) setSeen(true)
        else if (entry.intersectionRatio === 0) setSeen(false)
      },
      { threshold: [0, 0.3] },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [reduced, controlled])

  if (reduced) return <Tag className={className}>{text}</Tag>

  const on = controlled ? active : seen
  const words = text.split(' ')
  let n = 0

  const piece = (content, key, extra = '') => {
    const i = n
    n += 1
    return (
      <span
        key={key}
        className={`inline-block transition-[opacity,transform] duration-500 ease-out ${extra} ${
          on ? 'translate-y-0 opacity-100' : `opacity-0 ${by === 'word' ? 'translate-y-[0.3em]' : ''}`
        }`}
        style={{ transitionDelay: on ? `${delay + i * stagger}ms` : '0ms' }}
      >
        {content}
      </span>
    )
  }

  return (
    <Tag ref={ref} className={className}>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {words.map((word, w) => (
          <span key={w}>
            {by === 'word' ? (
              piece(word, w)
            ) : (
              // A word's letters stay on one line together, so the title only
              // ever breaks between words.
              <span className="inline-block whitespace-nowrap">
                {[...word].map((ch, c) => piece(ch, c))}
              </span>
            )}
            {w < words.length - 1 && ' '}
          </span>
        ))}
      </span>
    </Tag>
  )
}
