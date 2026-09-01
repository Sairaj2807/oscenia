import { useEffect, useRef, useState } from 'react'
import { AUTO_REVEAL_MS, AUTO_REVEAL_STAGGER_MS, MOTION } from '../data/deckMotion'
import { useI18n } from '../i18n/LanguageContext'
import Disclosure from '../components/Disclosure'
import Media from '../components/Media'
import Reveal from '../components/Reveal'
import CTA from '../components/CTA'

// Resting offset for an in-place reveal, keyed by the deck direction.
const REVEAL_OFFSET = { up: 'translate-y-4', down: '-translate-y-4' }

const prefersReduced = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

export default function About() {
  return (
    <>
      <Intro />
      <NameMeaning />
      <StandsFor />
      <Vision />
      <WhyOscenia />
      <OurValue />
    </>
  )
}

// Slide 5. "OSCENIA" arrives from the left; the intro paragraph is the deck's
// click-revealed body copy.
function Intro() {
  const { t } = useI18n()
  const m = MOTION.aboutIntro
  return (
    <section className="mx-auto max-w-content px-6 pb-16 pt-40">
      <Reveal from={m.heading.from}>
        <p className="eyebrow mb-4">{t.about.eyebrow}</p>
        <h1 className="mb-8 font-serif text-5xl text-gold-light sm:text-6xl">{t.about.title}</h1>
      </Reveal>
      {/* Arrives on its own — a "Read more" toggle in front of a single
          paragraph was a speed bump, not an interaction. */}
      <Reveal from="up" delay={320}>
        <p className="max-w-3xl font-serif text-xl leading-relaxed text-white/80">
          {t.about.intro}
        </p>
      </Reveal>
    </section>
  )
}

// Slide 6. The name paragraph exits upward, so it enters from above.
function NameMeaning() {
  const { t } = useI18n()
  const n = t.about.name
  const m = MOTION.nameMeaning
  return (
    <section className="mx-auto max-w-content px-6 py-16">
      <div className="grid items-center gap-12 md:grid-cols-2">
        <Reveal from={m.heading.from}>
          <div className="hairline mb-8 max-w-xs" />
          <h2 className="font-serif text-5xl italic tracking-wide text-white sm:text-6xl">{n.stylized}</h2>
        </Reveal>
        <div className="space-y-5 border-l border-gold/30 pl-6">
          {n.body.map((p, i) => (
            <Reveal key={i} from={m.body.from} delay={200 + i * 180}>
              <p className="text-lg leading-relaxed text-white/75">{p}</p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}

// The three circles open themselves in turn once the section is reached, and
// close again when it leaves, so returning replays the reveal. Clicking still
// toggles any of them. Copy is a step up in size — the previous text-sm was
// called out as too small to read.
function StandsFor() {
  const { t } = useI18n()
  const s = t.about.standsFor
  // A set, not an index: the three open themselves in turn once the section is
  // reached, so more than one is open at a time. Clicking still toggles any of
  // them individually.
  // Reduced motion gets all three open from the start, with no timers.
  const [reduced] = useState(prefersReduced)
  const [open, setOpen] = useState(() =>
    reduced ? new Set(t.about.standsFor.pillars.map((_, i) => i)) : new Set(),
  )
  const [touched, setTouched] = useState(false)
  const sectionEl = useRef(null)
  const count = s.pillars.length

  useEffect(() => {
    if (reduced || touched) return undefined
    const el = sectionEl.current
    if (!el) return undefined
    let timers = []
    const clear = () => {
      timers.forEach(clearTimeout)
      timers = []
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          for (let i = 0; i < count; i += 1) {
            timers.push(
              setTimeout(
                () => setOpen((prev) => new Set(prev).add(i)),
                AUTO_REVEAL_MS + i * AUTO_REVEAL_STAGGER_MS,
              ),
            )
          }
        } else {
          // Reset so the three open again next time the section is reached.
          clear()
          setOpen(new Set())
        }
      },
      { threshold: 0.35 },
    )
    io.observe(el)
    return () => {
      io.disconnect()
      clear()
    }
  }, [reduced, touched, count])

  const toggle = (i) => {
    setTouched(true)
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  return (
    <section ref={sectionEl} className="mx-auto max-w-content px-6 py-20">
      <Reveal from={MOTION.standsFor.heading.from} className="text-center">
        <h2 className="font-serif text-4xl text-gold-light sm:text-5xl">
          {s.pre}
          <span className="italic">{s.brand}</span>
          {s.post}
        </h2>
        <p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-white/70">{s.intro}</p>
      </Reveal>

      <div className="mt-16 grid gap-12 sm:grid-cols-3">
        {s.pillars.map((p, i) => {
          const isOpen = open.has(i)
          return (
            <Reveal key={p.title} delay={i * 120} className="text-center">
              {/* The explanation lives inside the circle. Two layers crossfade
                  in place so nothing reflows, and the circles are sized so the
                  text fits the inscribed square (diameter / root-2) rather than
                  spilling past the curve. */}
              <button
                type="button"
                onClick={() => toggle(i)}
                aria-expanded={isOpen}
                className={`relative mx-auto flex h-72 w-72 items-center justify-center rounded-full border transition-all duration-500 focus:outline-none focus-visible:ring-1 focus-visible:ring-gold sm:h-80 sm:w-80 ${
                  isOpen
                    ? 'border-gold/70 bg-[radial-gradient(circle_at_30%_30%,#1f3760,#0a1424)] shadow-[0_0_80px_-16px_rgba(198,161,91,0.65)]'
                    : 'border-gold/30 bg-[radial-gradient(circle_at_30%_30%,#16294a,#060b16)] shadow-[0_0_60px_-20px_rgba(198,161,91,0.4)] hover:scale-[1.03] hover:border-gold/60'
                }`}
              >
                {/* Resting: the word, plus a cue that it opens. */}
                <span
                  className={`absolute inset-0 flex flex-col items-center justify-center gap-3 transition-opacity duration-500 ${
                    isOpen ? 'pointer-events-none opacity-0' : 'opacity-100'
                  }`}
                >
                  <span className="font-serif text-3xl text-white sm:text-5xl">{p.title}</span>
                  <span aria-hidden="true" className="text-2xl font-light leading-none text-gold">
                    +
                  </span>
                </span>

                {/* Open: the explanation, in the circle. Slides 7->8 bring this
                    description up from below (and 8->9 send it back down), so it
                    rises rather than simply cross-fading. Direction comes from
                    the deck table. */}
                <span
                  className={`absolute inset-0 flex flex-col items-center justify-center gap-2 px-8 text-center transition-all duration-500 sm:gap-3 sm:px-12 ${
                    isOpen
                      ? 'translate-y-0 opacity-100'
                      : `pointer-events-none opacity-0 ${REVEAL_OFFSET[MOTION.standsFor.revealFrom]}`
                  }`}
                >
                  <span className="font-serif text-xl text-gold-light sm:text-2xl">{p.title}</span>
                  <span className="text-sm leading-relaxed text-white/90 sm:text-lg">{p.desc}</span>
                </span>
              </button>
            </Reveal>
          )
        })}
      </div>
    </section>
  )
}

// Centred and given a gold frame — the client asked for this one to sit in the
// middle and be highlighted rather than tucked into the bottom-left corner.
function Vision() {
  const { t } = useI18n()
  return (
    <section className="relative my-16 flex h-[70vh] min-h-[420px] items-center overflow-hidden">
      <Media src="" label="" className="absolute inset-0 h-full w-full" />
      <div className="absolute inset-0 bg-navy-950/75" />
      {/* Arrives a piece at a time: label, rule, statement, rule. */}
      <div className="relative z-10 mx-auto w-full max-w-3xl px-6 text-center">
        <Reveal from={MOTION.vision.eyebrow.from}>
          <p className="eyebrow mb-6">{t.about.vision.eyebrow}</p>
        </Reveal>
        <Reveal from={MOTION.vision.rule.from} delay={MOTION.vision.rule.delay}>
          <div className="hairline mx-auto mb-8 max-w-xs" />
        </Reveal>
        <Reveal from={MOTION.vision.statement.from} delay={MOTION.vision.statement.delay} duration={MOTION.vision.statement.duration}>
          <p className="font-serif text-3xl italic leading-snug text-gold-light sm:text-4xl">
            {t.about.vision.text}
          </p>
        </Reveal>
        <Reveal from="scale" delay={700}>
          <div className="hairline mx-auto mt-8 max-w-xs" />
        </Reveal>
      </div>
    </section>
  )
}

// Slide 11. Both heading and body are new objects there, so Morph fades them —
// and the body is the one effect in the deck marked explicitly ON CLICK.
function WhyOscenia() {
  const { t } = useI18n()
  const w = t.about.why
  const m = MOTION.why
  return (
    <section className="mx-auto max-w-content px-6 py-24">
      <div className="grid items-center gap-12 md:grid-cols-2">
        <Reveal from={m.heading.from} duration={m.heading.duration}>
          <h2 className="font-serif text-4xl text-white sm:text-6xl md:text-7xl">
            <span className="italic text-white/60">{w.pre}</span> <br className="hidden sm:block" />
            <span className="text-gold-light">{w.brand}</span>
          </h2>
        </Reveal>
        {/* Paragraphs arrive one after another rather than behind a toggle. */}
        <div className="space-y-6">
          {w.body.map((p, i) => (
            <Reveal key={i} from="scale" delay={280 + i * 220}>
              <p className="text-lg leading-relaxed text-white/80">{p}</p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}

function OurValue() {
  const { t } = useI18n()
  return (
    <section className="bg-navy-950 py-24">
      <div className="mx-auto max-w-content px-6">
        <Reveal from={MOTION.value.heading.from} duration={MOTION.value.heading.duration}>
          <h2 className="mb-16 font-serif text-5xl italic text-white sm:text-6xl">{t.about.value.heading}</h2>
        </Reveal>

        {/* Slides 12-15: one label slides in from the left per slide, and its
            explanation fades in on click. Each row is its own disclosure so the
            page reads as three headlines until something is asked for. */}
        <div className="space-y-14">
          {t.about.value.items.map((v, i) => (
            <Reveal
              key={v.title}
              from={MOTION.value.label.from}
              delay={i * MOTION.value.rowStagger}
            >
              <div className="border-t border-white/10 pt-8">
                <Disclosure
                  summary={<h3 className="font-serif text-2xl italic text-gold-light">{v.title}</h3>}
                  panelClassName="pt-6"
                  // Opens itself, each row a beat behind the one above.
                  autoOpenAfter={AUTO_REVEAL_MS + i * AUTO_REVEAL_STAGGER_MS}
                >
                  <div className="text-white/75 md:pl-1">
                  {v.body && (
                    <div className="space-y-4">
                      {v.body.map((b, k) => (
                        <p key={k} className="leading-relaxed">
                          <span className="text-white/45">{b.label}: </span>
                          <span className="font-serif text-xl text-white">{b.text}</span>
                        </p>
                      ))}
                    </div>
                  )}
                  {v.list && (
                    <>
                      {v.lead && <p className="mb-4">{v.lead}</p>}
                      <ul className="grid gap-2 sm:grid-cols-2">
                        {v.list.map((li) => (
                          <li key={li} className="flex items-center gap-3">
                            <span className="h-1.5 w-1.5 rounded-full bg-gold" />
                            {li}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  {v.formula && (
                    <>
                      {v.lead && <p className="mb-3">{v.lead}</p>}
                      <p className="font-serif text-2xl text-white">{v.formula}</p>
                      {v.note && <p className="mt-4 text-sm italic text-white/50">{v.note}</p>}
                    </>
                  )}
                  </div>
                </Disclosure>
              </div>
            </Reveal>
          ))}
        </div>

        <div className="mt-16 text-center">
          <CTA variant="pill" />
        </div>
      </div>
    </section>
  )
}
