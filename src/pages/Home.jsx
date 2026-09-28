import { useEffect, useRef, useState } from 'react'
import { THREAD_ONE, THREAD_TWO, buildLink, threadTwoPath } from '../data/formatsMotion'
import { headlineDurationMs } from '../data/headline'
import { FORMAT_IMAGES } from '../data/site'
import { useI18n } from '../i18n/LanguageContext'
import BackdropVideo from '../components/BackdropVideo'
import Footer from '../components/Footer'
import GlassCTA from '../components/GlassCTA'
import GoldThread from '../components/GoldThread'
import KineticHeadline from '../components/KineticHeadline'
import LogoMarquee from '../components/LogoMarquee'
import Reveal from '../components/Reveal'
import useCardToss from '../components/useCardToss'
import { useIntroReady } from '../introReady'

export default function Home() {
  return (
    <>
      <HeroFilm />
      <Formats />
      <Testimonials />
      <Closing />
    </>
  )
}

// Hero and client strip are one section because they are one picture: the film
// of the laid table runs behind both, and the paper band is laid across it.
// Splitting them would put a seam where the reference has none.
function HeroFilm() {
  const { t } = useI18n()
  const lines = t.hero.headline
  const ctaDelay = headlineDurationMs(lines) - 500
  // Same reasoning as KineticHeadline's own gate: this section mounts while
  // the intro overlay is still covering the screen, so the CTA's word-in
  // delay must count from when the overlay actually clears, not from mount.
  const ready = useIntroReady()

  return (
    // No overflow-hidden on the section: it would become the scrollport for
    // the sticky film inside and pin it to the top of the section rather than
    // to the viewport. The film clips itself instead.
    <section className="relative isolate bg-navy-950">
      {/* The film is stuck to the viewport for the length of the section, so
          the hero and the client strip are lit by one frame rather than by a
          slice of an image stretched over two screens' worth of page. */}
      <div className="absolute inset-0 -z-10">
        <div className="sticky top-0 h-[100svh] w-full overflow-hidden">
          <img
            src="/media/hero-table.webp"
            alt=""
            // The reel frame is graded a stop darker than the reference sets
            // its hero at; the lift brings the navy back to the blue it reads as
            // there without touching the scrim over it.
            className="animate-ken-burns h-full w-full object-cover brightness-[1.18] saturate-[1.08]"
            fetchPriority="high"
          />
          {/* Two scrims, not one: an even veil so the type carries anywhere on
              the frame, and a foot that closes into the black the next section
              opens on. */}
          <div className="absolute inset-0 bg-navy-950/22" />
          <div className="absolute inset-x-0 bottom-0 h-[30vh] bg-gradient-to-b from-transparent to-navy-950/80" />
        </div>
      </div>

      <div className="flex min-h-[100svh] flex-col items-center justify-center px-5 pb-12 pt-32 sm:px-8 sm:pt-[13.5rem]">
        <KineticHeadline
          lines={lines}
          plain={t.hero.tagline}
          className="mx-auto w-full max-w-[68rem]"
        />
        <div
          className={`mt-10 sm:mt-[4.5rem] ${ready ? 'word-in' : 'opacity-0'}`}
          style={ready ? { animationDelay: `${ctaDelay}ms`, animationDuration: '900ms' } : undefined}
        >
          <GlassCTA />
        </div>
      </div>

      <div className="flex flex-col items-center pb-0">
        <p className="pb-14 font-serif text-[0.95rem] italic tracking-[0.04em] text-white/80 sm:pb-20 sm:text-base">
          {t.hero.subline}
        </p>
        <LogoMarquee />
      </div>
      {/* Breathing room under the strip before the page turns black, matching
          the reference's long fade out of the hero film. */}
      <div className="h-[45vh]" />
    </section>
  )
}

// Where an element's top-left corner sits inside `root`, from layout offsets
// only. The cards' captions are mid-flight half the time, and offsetTop ignores
// transforms where getBoundingClientRect wouldn't.
function offsetWithin(el, root) {
  let x = 0
  let y = 0
  let n = el
  while (n && n !== root) {
    x += n.offsetLeft
    y += n.offsetTop
    n = n.offsetParent
  }
  return n === root ? { x, y } : null
}

function Formats() {
  const { t } = useI18n()
  const gridBox = useRef(null)
  const lastTitle = useRef(null)
  const photos = useRef([])
  const [threadTwo, setThreadTwo] = useState(null)
  const [link, setLink] = useState(null)

  // The second thread starts behind "Experience Systems", so its box is placed
  // from that caption's position, and again whenever the grid reflows — fonts
  // arriving, a resize, or a language switch changing the copy. The link
  // between the two threads is placed from the same measurement, since its far
  // end is thread two's start.
  useEffect(() => {
    const box = gridBox.current
    const title = lastTitle.current
    if (!box || !title) return undefined
    const place = () => {
      const at = offsetWithin(title, box)
      if (!at) return
      const vw = window.innerWidth
      const vh = window.innerHeight
      // The words' own width. A range's rect moves with the flight, but the
      // caption only ever slides, so its width is the same mid-air.
      const range = document.createRange()
      range.selectNodeContents(title)
      const words = range.getBoundingClientRect().width
      const align = getComputedStyle(title).textAlign
      const left = at.x + (align === 'right' || align === 'end' ? title.offsetWidth - words : 0)
      const x = left + words * THREAD_TWO.startAlong
      // Into the thread's own 1920-wide units: its box is the full screen width,
      // centred on this column.
      const boxX = ((x - (box.clientWidth - vw) / 2) * 1920) / vw
      const dx = Math.max(boxX - THREAD_TWO.startX, THREAD_TWO.minShift)
      const top = Math.round(at.y + title.offsetHeight / 2 - (THREAD_TWO.anchorY / 1080) * vh)
      setThreadTwo({ top, d: threadTwoPath(dx) })
      // The link runs on under the second photo, out below its caption, and in
      // under the last photo, so it needs where those actually are. Layout
      // offsets, not rects, so a card mid-toss doesn't skew them.
      const second = photos.current[1]
      const last = photos.current[3]
      const figure = second?.closest('figure')
      const f = figure && offsetWithin(figure, box)
      const c = last && offsetWithin(last, box)
      // One column (below 640px) has no threads.
      setLink(
        f && c && vw >= 640
          ? buildLink({
              vw,
              vh,
              emergeY: f.y + figure.offsetHeight,
              photoTop: c.y,
              photoHeight: last.offsetHeight,
              twoX: THREAD_TWO.startX + dx,
              twoTop: top,
            })
          : null,
      )
    }
    place()
    const ro = new ResizeObserver(place)
    ro.observe(box)
    window.addEventListener('resize', place)
    document.fonts?.ready.then(place)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', place)
    }
  }, [])

  return (
    // z-10 so the second thread's tail, which runs on past this section's foot,
    // draws over the testimonials rather than under their background.
    // overflow-x-clip because a card waiting for its toss is parked off the side
    // of the screen, and on a phone that otherwise widens the page — iOS Safari
    // doesn't take body's overflow-x as a reason not to pan. Clip rather than
    // hidden, so nothing becomes a scroll box and the tail can still run on
    // below the section.
    <section className="relative z-10 overflow-x-clip bg-black">
      <div className="relative h-[62svh] overflow-hidden sm:h-[78svh]">
        <BackdropVideo
          className="absolute inset-0 h-full w-full object-cover"
          src="/media/champagne.mp4"
          poster="/media/champagne-poster.jpg"
        />
        <div className="absolute inset-0 bg-black/25" />
        <div className="absolute inset-x-0 bottom-0 px-6 pb-10 sm:px-12 sm:pb-11 lg:px-20">
          <Reveal from="up" duration={900}>
            <p className="font-serif text-[clamp(1rem,1.65vw,1.75rem)] tracking-[0.12em] text-gold-light/90 sm:ps-[4.5%]">
              {t.direct.eyebrow}
            </p>
            <h2 className="mt-1 font-serif text-[clamp(1.9rem,4.2vw,3.6rem)] leading-tight text-white">
              {t.direct.heading}
            </h2>
          </Reveal>
        </div>
      </div>

      {/* This box's top edge is the film's bottom edge — both threads measure
          from it. They span the full width of the screen, not this column: the
          first starts at the left edge of the film, the second leaves by the
          right edge of the page. */}
      <div
        ref={gridBox}
        className="relative mx-auto max-w-[82rem] px-6 pb-28 pt-24 md:px-8 xl:px-0 sm:pb-40 sm:pt-[20vh]"
      >
        <GoldThread
          {...THREAD_ONE}
          className="left-1/2 top-[-50vh] hidden h-[84vh] w-screen -translate-x-1/2 sm:block"
        />
        {/* One thread in three pieces: thread one, the link on under the
            second photo and the last, and thread two out from behind its
            caption. All sit before the grid so the cards paint over them. */}
        {link && (
          <GoldThread
            d={link.d}
            viewBox={link.viewBox}
            from={link.from}
            to={link.to}
            pacing={link.pacing}
            className="left-1/2 hidden w-screen -translate-x-1/2 sm:block"
            style={{ top: link.top, height: link.height }}
          />
        )}
        {threadTwo && (
          <GoldThread
            {...THREAD_TWO}
            d={threadTwo.d}
            className="left-1/2 hidden h-[54vh] w-screen -translate-x-1/2 sm:block"
            style={{ top: threadTwo.top }}
          />
        )}
        <ul className="relative grid gap-x-12 gap-y-16 sm:grid-cols-2 sm:gap-y-6">
          {t.direct.items.map((item, i) => (
            <FormatCard
              key={item.title}
              item={item}
              src={FORMAT_IMAGES[i]}
              index={i}
              titleRef={i === t.direct.items.length - 1 ? lastTitle : undefined}
              photoRef={(el) => (photos.current[i] = el)}
            />
          ))}
        </ul>
      </div>
    </section>
  )
}

// Cards alternate: the left one rides high and titles from the left, the right
// one hangs lower and titles from its centre — the offset pairing the reference
// scrolls through. Each is tossed in from its own side (components/useCardToss).
//
// Four layers, each owning one motion so none of them fight: the photo layer is
// the toss; inside it, .format-card-lift is the hover swell and float; inside
// that, the frame keeps its halo and its slow zoom of the photo. The caption is
// split the same way — sideways on the figcaption, upward on the block within.
function FormatCard({ item, src, index, titleRef, photoRef }) {
  const low = index % 2 === 1
  const toss = useCardToss(low ? 'right' : 'left')
  return (
    <li ref={toss.slot} className={low ? 'sm:mt-7' : ''}>
      <figure className="group">
        <div ref={toss.photo}>
          <div className="format-card-lift">
            <div
              ref={photoRef}
              // The gold halo only shows while the card is hovered, and only on
              // devices that truly hover (a tap on a phone would leave it stuck
              // on). At rest it's the same shadow at zero opacity, so it blooms
              // in and out smoothly rather than popping.
              className="overflow-hidden rounded-[1.25rem] shadow-[0_0_110px_-34px_rgba(198,161,91,0)] transition-shadow duration-700 [@media(hover:hover)]:group-hover:shadow-[0_0_130px_-24px_rgba(198,161,91,0.95)]"
            >
              <img
                src={src}
                alt={item.title}
                loading="lazy"
                className="aspect-[3/2] w-full object-cover transition-transform duration-[1200ms] ease-out group-hover:scale-[1.05]"
              />
            </div>
          </div>
        </div>
        <figcaption
          ref={toss.slide}
          className={`mt-1 font-serif text-[clamp(1.5rem,3.4vw,3.4rem)] text-white/95 ${
            low ? 'pe-5 sm:text-right' : 'ps-5'
          }`}
        >
          <div ref={toss.rise}>
            <span ref={titleRef} className="block">
              {item.title}
            </span>
            <span className="mt-2 block max-w-md font-sans text-sm leading-relaxed text-white/45 opacity-0 transition-opacity duration-500 group-hover:opacity-100 sm:ms-auto">
              {item.desc}
            </span>
          </div>
        </figcaption>
      </figure>
    </li>
  )
}

const SLIDE_MS = 4000

const prefersReduced = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

function Testimonials() {
  const { t } = useI18n()
  const items = t.testimonials.items
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const [reduced] = useState(prefersReduced)

  // Switching language can change the list length — don't leave the track
  // parked past the end.
  useEffect(() => {
    setIndex((i) => (i < items.length ? i : 0))
  }, [items.length])

  // Auto-advancing content is hostile under reduced-motion, so it stays put.
  useEffect(() => {
    if (paused || reduced || items.length < 2) return undefined
    const id = setInterval(() => setIndex((i) => (i + 1) % items.length), SLIDE_MS)
    return () => clearInterval(id)
  }, [paused, reduced, items.length])

  const step = (delta) => setIndex((i) => (i + delta + items.length) % items.length)
  const item = items[index]

  return (
    // No thread of its own: the one that runs across the top of this section
    // is the tail of the second thread, drawn from the formats above.
    <section className="bg-abyss relative flex min-h-[112svh] items-center overflow-hidden pt-24 pb-[calc(12svh+6rem)]">

      <div className="relative mx-auto max-w-content px-6">
        <Reveal>
          <h2 className="text-center font-serif text-[clamp(1.4rem,2.05vw,2.1rem)] text-white">
            {t.testimonials.heading}
          </h2>
        </Reveal>

        <div
          className="mt-14 flex items-center justify-center gap-4 sm:mt-16 sm:gap-10"
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
          onFocusCapture={() => setPaused(true)}
          onBlurCapture={() => setPaused(false)}
          aria-roledescription="carousel"
          aria-label={t.testimonials.heading}
        >
          <CarouselDot onClick={() => step(-1)} label={`${t.testimonials.heading} — previous`} />

          {/* Near-black glass with a slow gold light crossing it. The radius is
              large enough that the card reads as a lozenge, as in the
              reference, rather than a rounded rectangle. */}
          <figure className="relative w-full max-w-[41rem] overflow-hidden rounded-[2rem] bg-[#050505] px-6 py-10 text-center ring-1 ring-white/[0.06] sm:rounded-[3.25rem] sm:px-14 sm:py-12">
            {/* Warm light crossing the card. Wide and blurred rather than a
                narrow band: at half the card's width with hard gradient stops it
                read as a lit rectangle, where the reference is a diffuse glow
                with no edge you can point at. */}
            <span
              aria-hidden="true"
              className="animate-sheen pointer-events-none absolute -inset-y-1/2 -left-1/4 w-[70%] bg-[linear-gradient(90deg,transparent,rgba(198,161,91,0.10),rgba(224,199,137,0.44),rgba(198,161,91,0.14),transparent)] blur-xl"
            />
            <blockquote
              key={index}
              className="animate-fade-in relative text-sm leading-relaxed text-white/95 sm:text-[1.05rem]"
            >
              {item.quote}
            </blockquote>
            <figcaption className="relative mt-6 text-xs uppercase tracking-[0.12em] text-white/90 sm:text-[1.05rem]">
              — {item.author}
            </figcaption>
          </figure>

          <CarouselDot onClick={() => step(1)} label={`${t.testimonials.heading} — next`} />
        </div>
      </div>
    </section>
  )
}

// The two marks flanking the quote are the controls. The dot itself stays 10px;
// the button around it is large enough to hit.
function CarouselDot({ onClick, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="group flex h-11 w-11 shrink-0 items-center justify-center rounded-full focus:outline-none focus-visible:ring-1 focus-visible:ring-gold-light"
    >
      <span className="block h-2.5 w-2.5 rounded-full bg-white/85 transition-all duration-300 group-hover:scale-125 group-hover:bg-gold-light group-focus-visible:scale-125 group-focus-visible:bg-gold-light" />
    </button>
  )
}

// The closing film carries both the last call to action and the footer, which
// sits on it rather than under it.
function Closing() {
  return (
    <section className="relative isolate bg-black">
      <div className="absolute inset-0 -z-10">
        <div className="sticky top-0 h-[100svh] w-full overflow-hidden">
          <BackdropVideo
            className="h-full w-full object-cover"
            src="/media/celebration.mp4"
            poster="/media/celebration-poster.jpg"
          />
          <div className="absolute inset-0 bg-black/25" />
          <div className="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-b from-transparent via-black/35 to-black/80" />
        </div>
      </div>

      <div className="flex min-h-[85svh] items-center justify-center px-6 pb-14 pt-28">
        <Reveal from="scale" duration={1100}>
          <GlassCTA />
        </Reveal>
      </div>
      <Footer overlay />
    </section>
  )
}
