import { useEffect, useRef, useState } from 'react'
import releaseVideo from './releaseVideo'

// A full-bleed film behind a section.
//
// Two things it does that a bare <video> does not:
//
// 1. It does not fetch until the section is close. Three autoplaying backdrops
//    declared inline all start downloading on load, which is ~5 MB spent before
//    the visitor has scrolled — and two of them are four and five screens down.
//    The poster stands in until then, so nothing is ever blank.
// 2. Under reduced motion it stays a poster. An autoplaying, looping backdrop is
//    exactly the moving content that setting asks to be spared, and every one of
//    these has a poster that reads as the same frame.
//
// `eager` is for the intro splash, which is the first thing on screen and cannot
// wait for an observer to fire.
const ROOT_MARGIN = '150% 0px'

const prefersReduced = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

export default function BackdropVideo({ src, poster, className = '', eager = false }) {
  const ref = useRef(null)
  const [reduced] = useState(prefersReduced)
  const [load, setLoad] = useState(eager)

  useEffect(() => {
    if (load || reduced) return undefined
    const el = ref.current
    if (!el) return undefined
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setLoad(true)
          io.disconnect()
        }
      },
      { rootMargin: ROOT_MARGIN },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [load, reduced])

  // Leaving the page cancels the film's download rather than letting it
  // stream on behind the next page.
  useEffect(() => {
    const el = ref.current
    return () => releaseVideo(el)
  }, [load])

  // The poster is the element until the film is wanted, so the section is
  // never a black rectangle and the swap has nothing to fade.
  if (reduced || !load) {
    return (
      <img
        ref={ref}
        src={poster}
        alt=""
        aria-hidden="true"
        className={className}
        // Eager backdrops are above the fold; the rest can wait their turn.
        loading={eager ? 'eager' : 'lazy'}
      />
    )
  }

  return (
    <video
      ref={ref}
      className={className}
      src={src}
      poster={poster}
      autoPlay
      muted
      loop
      playsInline
      preload="auto"
      aria-hidden="true"
    />
  )
}
