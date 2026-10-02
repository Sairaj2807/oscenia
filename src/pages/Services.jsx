import { useState } from 'react'
import { Link } from 'react-router-dom'
import { EVENT_RADIUS, PORTFOLIO } from '../data/site'
import { useI18n } from '../i18n/LanguageContext'
import useScrollProgress, { easeInOut, easeOut, span } from '../components/useScrollProgress'
import useViewTransitionNavigate from '../components/useViewTransitionNavigate'
import Curtains from '../components/Curtains'
import GlassCTA from '../components/GlassCTA'
import BeadCurtain from '../components/BeadCurtain'
import Reveal from '../components/Reveal'

// The Services page follows the reference recording (video_refrence.mp4,
// 2:36-3:36) and is built from the designer's Services material
// (brand-assets/3. Services Page): the photographed curtains part on a curtain
// made of the name that the pointer swings through, then draw back onto navy
// velvet for the heading, and the six events fly in from a scattered collage
// to settle as a grid. Each tile opens its own case page (pages/ServiceCase.jsx).


const prefersReduced = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

const useReduced = () => useState(prefersReduced)[0]

export default function Services() {
  return (
    <>
      <Velvet />
      <Stage />
      <Portfolio />
    </>
  )
}

// The navy velvet the whole page sits on, held still behind everything. Fixed
// rather than per-section so the stage and the grid share one continuous
// ground — the reference never shows a seam between them. It sits under the
// Layout's pointer ripple (-z-10), so the water still plays over the velvet.
function Velvet() {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-20">
      <img src="/services/velvet.webp" alt="" className="h-full w-full object-cover" />
      <div className="absolute inset-0 bg-navy-950/25" />
    </div>
  )
}

// 2:42. The stage, pinned while the page scrolls: the curtains part on
// arrival, then as the page moves on the letters rise away and the curtains
// draw fully off, leaving the velvet for the heading.
function Stage() {
  const reduced = useReduced()
  const [ref, p] = useScrollProgress()
  // Both start almost at once: a stretch at the top where scrolling moved
  // nothing read as the page being stuck.
  const lift = reduced ? 0 : easeInOut(span(p, 0.05, 0.75))
  const open = reduced ? 0 : easeInOut(span(p, 0.08, 0.8))

  return (
    <section ref={ref} className={reduced ? '' : 'h-[200vh]'}>
      <div className={`${reduced ? 'relative' : 'sticky top-0'} h-svh overflow-hidden`}>
        <div
          className="absolute inset-0"
          style={{ transform: `translateY(${-lift * 110}%)`, opacity: 1 - span(p, 0.55, 0.75) }}
        >
          <BeadCurtain className="h-full w-full" />
        </div>
        <Curtains open={open} />
      </div>
    </section>
  )
}

// Where each tile starts in the collage, as an offset from its grid slot
// (vw, vh), a tilt and a scale. They converge on the grid as it scrolls in,
// and scatter again if it scrolls back out.
const SCATTER = [
  { x: -14, y: -34, r: -6, s: 0.8 },
  { x: 20, y: -48, r: 5, s: 0.72 },
  { x: 30, y: 6, r: 7, s: 0.86 },
  { x: -30, y: 22, r: -8, s: 0.9 },
  { x: 8, y: 44, r: 3, s: 0.78 },
  { x: 24, y: 58, r: -4, s: 0.74 },
]

// 3:03. Pulled up by a full screen so the heading scrolls in over the stage's
// last pinned frame — empty velvet — instead of after it.
function Portfolio() {
  const { t } = useI18n()
  const s = t.services
  const reduced = useReduced()
  const [gridRef, p] = useScrollProgress('pass')
  const gather = reduced ? 1 : easeOut(span(p, 0.04, 0.42))

  return (
    <section
      className={`relative z-10 px-6 pb-28 ${reduced ? 'pt-24' : '-mt-[100svh] pt-[32svh]'}`}
    >
      <Reveal className="text-center" duration={1600}>
        <p className="eyebrow mb-5">{s.eyebrow}</p>
        <h1 className="mx-auto max-w-3xl font-serif text-3xl leading-snug text-white sm:text-5xl">
          {s.heading[0]}{' '}
          <span className="align-[-0.08em] font-display text-5xl italic text-gold sm:text-7xl">&amp;</span>{' '}
          {s.heading[1]}
        </h1>
      </Reveal>

      {/* The anchor a case page's Back returns to: scrolled so the grid sits
          just under the header, where it has already gathered. */}
      <div
        id="portfolio"
        ref={gridRef}
        className="mx-auto mt-16 grid scroll-mt-28 max-w-content grid-cols-2 gap-3 sm:mt-24 sm:gap-5 md:grid-cols-3">
        {PORTFOLIO.map((project, i) => {
          const from = SCATTER[i % SCATTER.length]
          const k = 1 - gather
          return (
            <div
              key={project.slug}
              style={{
                transform: `translate(${from.x * k}vw, ${from.y * k}vh) rotate(${from.r * k}deg) scale(${
                  from.s + (1 - from.s) * gather
                })`,
                opacity: 0.35 + 0.65 * gather,
              }}
            >
              <Tile project={project} />
            </div>
          )
        })}
      </div>

      {/* The page's one call to action, in the same glass as Home and About,
          once the work has been seen. */}
      <Reveal from="up" className="mt-16 text-center sm:mt-24">
        <GlassCTA />
      </Reveal>
    </section>
  )
}

// Grey until hovered, then colour, with the brand, the event type and the gold
// logo badge over the image. A touch screen has no hover, so every hover state
// is mirrored under [@media(hover:none)] — otherwise tiles would sit grey and
// unlabelled on a phone.
function Tile({ project }) {
  const { t } = useI18n()
  const go = useViewTransitionNavigate()
  const to = `/services/${project.slug}`
  const type = t.contact.eventTypes[project.type]

  return (
    <Link
      to={to}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
        e.preventDefault()
        go(to)
      }}
      className="group block rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-gold"
    >
      <figure
        className="relative aspect-[783/498] overflow-hidden shadow-[0_24px_50px_-28px_rgba(0,0,0,0.8)]"
        style={{ ...EVENT_RADIUS, viewTransitionName: `case-${project.slug}` }}
      >
        <img
          src={project.img}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover grayscale transition-all duration-700 ease-out group-hover:scale-[1.04] group-hover:grayscale-0 group-focus-visible:grayscale-0 [@media(hover:none)]:grayscale-0"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/10 to-transparent opacity-0 transition-opacity duration-500 group-hover:opacity-100 group-focus-visible:opacity-100 [@media(hover:none)]:opacity-100" />
        <figcaption className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 p-3 sm:p-4">
          <div className="translate-y-2 opacity-0 transition-all duration-500 group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100 [@media(hover:none)]:translate-y-0 [@media(hover:none)]:opacity-100">
            <p className="text-base font-medium leading-tight text-white sm:text-xl">{project.client}</p>
            <p className="mt-0.5 text-[10px] text-white/75 sm:text-xs">{type}</p>
          </div>
          <LogoBadge project={project} className="h-8 w-8 text-[8px] sm:h-10 sm:w-10 sm:text-[10px]" />
        </figcaption>
      </figure>
    </Link>
  )
}

// The client's mark on a gold disc. Reads "Logo" until a file is supplied,
// exactly as the reference's placeholder does.
export function LogoBadge({ project, className = '' }) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-gold-light font-medium text-navy-950 shadow-[0_4px_14px_rgba(0,0,0,0.45)] ${className}`}
    >
      {project.logo ? (
        <img src={project.logo} alt={project.client} className="h-[62%] w-[62%] object-contain" />
      ) : (
        'Logo'
      )}
    </span>
  )
}
