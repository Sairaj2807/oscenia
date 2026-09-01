import { useEffect, useState } from 'react'
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
          className="word-in mt-10 sm:mt-[4.5rem]"
          style={{ animationDelay: `${ctaDelay}ms`, animationDuration: '900ms' }}
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

// The gold hairline that leaves the champagne film, loops through the gap and
// comes down onto the first card.
const THREAD =
  'M 40 -70 C 120 90, 40 250, 300 300 C 610 358, 740 250, 690 130 C 650 34, 500 62, 500 190 C 500 286, 486 332, 470 372'

function Formats() {
  const { t } = useI18n()
  return (
    <section className="relative bg-black">
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

      <div className="relative mx-auto max-w-[82rem] px-6 pb-28 pt-24 md:px-8 xl:px-0 sm:pb-40 sm:pt-[20vh]">
        <GoldThread
          d={THREAD}
          viewBox="0 0 900 520"
          className="left-0 top-[-22vh] hidden h-[62vh] w-full sm:block"
        />
        <ul className="relative grid gap-x-12 gap-y-16 sm:grid-cols-2 sm:gap-y-6">
          {t.direct.items.map((item, i) => (
            <FormatCard key={item.title} item={item} src={FORMAT_IMAGES[i]} index={i} />
          ))}
        </ul>
      </div>
    </section>
  )
}

// Cards alternate: the left one rides high and titles from the left, the right
// one hangs lower and titles from its centre — the offset pairing the reference
// scrolls through.
function FormatCard({ item, src, index }) {
  const low = index % 2 === 1
  return (
    <li className={low ? 'sm:mt-7' : ''}>
      <Reveal from={low ? 'bottom-right' : 'bottom-left'} duration={1100} delay={low ? 140 : 0}>
        <figure className="group">
          <div className="overflow-hidden rounded-[1.25rem] shadow-[0_0_110px_-34px_rgba(198,161,91,0.85)] transition-shadow duration-700 group-hover:shadow-[0_0_130px_-24px_rgba(198,161,91,0.95)]">
            <img
              src={src}
              alt={item.title}
              loading="lazy"
              className="aspect-[3/2] w-full object-cover transition-transform duration-[1200ms] ease-out group-hover:scale-[1.05]"
            />
          </div>
          <figcaption
            className={`mt-1 font-serif text-[clamp(1.5rem,3.4vw,3.4rem)] text-white/95 ${
              low ? 'pe-5 sm:text-right' : 'ps-5'
            }`}
          >
            {item.title}
            <span className="mt-2 block max-w-md font-sans text-sm leading-relaxed text-white/45 opacity-0 transition-opacity duration-500 group-hover:opacity-100 sm:ms-auto">
              {item.desc}
            </span>
          </figcaption>
        </figure>
      </Reveal>
    </li>
  )
}

const SLIDE_MS = 6000

const prefersReduced = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

const TESTIMONIAL_THREAD = 'M 318 -70 C 318 -70, 208 96, 24 296'

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
    <section className="bg-abyss relative flex min-h-[112svh] items-center overflow-hidden pt-24 pb-[calc(12svh+6rem)]">
      <GoldThread
        d={TESTIMONIAL_THREAD}
        viewBox="0 0 320 260"
        className="right-0 top-0 hidden h-[30vh] w-[30vw] sm:block"
      />

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
