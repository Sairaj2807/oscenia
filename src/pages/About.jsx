import { Fragment, useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n/LanguageContext'
import useScrollProgress, { easeInOut, easeOut, span } from '../components/useScrollProgress'
import BackdropVideo from '../components/BackdropVideo'
import GlassBubbles from '../components/GlassBubbles'
import GlassCTA from '../components/GlassCTA'
import Reveal from '../components/Reveal'
import TypeOn from '../components/TypeOn'

// The About page follows the reference recording (video_refrence.mp4, 1:30-2:36)
// and is built from the designer's About material (brand-assets/2. About Us
// Page): one continuous, scroll-played film. Blue satin opens it, the name is
// spelled phonetically, the three pillars float as photographed champagne
// bubbles over the looping flute, the vision is a card drawn out of a blue
// envelope, and the values are separated by the two-colour satin.
//
// Web encodes of that material live in public/about (see brand-assets/README.md).
// Every film is its source, full length, at full resolution, with light
// compression (H.264 CRF 18): picture quality first, file size second. See
// brand-assets/README.md.
const MEDIA = {
  blue: { src: '/about/fabric-blue.mp4', poster: '/about/fabric-blue-poster.jpg' },
  champagne: { src: '/about/champagne.mp4', poster: '/about/champagne-poster.jpg' },
  twoTone: { src: '/about/fabric-two.mp4', poster: '/about/fabric-two-poster.jpg' },
  envelope: '/about/envelope.webp',
  card: '/about/card.webp',
}

// The flute film's own backdrop, top to foot, so a wide screen can show it as
// a column without a visible frame around it.
const CHAMPAGNE_GROUND = 'bg-[linear-gradient(180deg,#04070f_0%,#031734_55%,#03204a_100%)]'

const CREAM = 'text-[#efe3c4]'

const prefersReduced = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

// Read once: every scene below renders its finished, unpinned state instead
// when the visitor has asked for less motion.
const useReduced = () => useState(prefersReduced)[0]

export default function About() {
  return (
    <div className="bg-black">
      <Hero />
      <NameMeaning />
      <StandsFor />
      <WhyOscenia />
      <OurValue />
    </div>
  )
}

// How many seconds of the satin film one pass through the hero scrubs across.
const SCRUB_SECONDS = 4

// The hero's satin film. While the page rests at the top it simply plays.
// Once the section is being scrolled it follows the scroll instead — forward
// going down, backward coming up — and back at the top it returns to the frame
// it left from and plays on. Scrubbing needs a keyframe every few frames, which
// is how public/about/fabric-blue.mp4 is encoded (see brand-assets/README.md).
function ScrubVideo({ src, poster, progress, className = '' }) {
  const ref = useRef(null)
  // The film's time when scrolling began; the scroll is measured from there.
  const anchor = useRef(null)
  const reduced = useReduced()

  useEffect(() => {
    const v = ref.current
    if (!v || reduced) return
    if (progress <= 0.002) {
      if (anchor.current !== null) {
        v.currentTime = anchor.current
        anchor.current = null
      }
      if (v.paused) v.play()?.catch(() => {})
      return
    }
    if (anchor.current === null) {
      anchor.current = v.currentTime
      v.pause()
    }
    const duration = v.duration || 14.68
    const t = (anchor.current + progress * SCRUB_SECONDS) % duration
    if (Math.abs(v.currentTime - t) > 0.02) v.currentTime = t
  }, [progress, reduced])

  if (reduced) return <img src={poster} alt="" aria-hidden="true" className={className} />
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

// 1:33. Blue satin fills the screen with "About Us" over it. Scrolling folds the
// satin up into a band across the top, carrying the title with it, and the
// intro writes itself in on the black that opens up beneath. All of it is tied
// to the scroll, so scrolling back up plays it in reverse: the words un-write
// last first, the satin unfolds, and the film runs backward.
function Hero() {
  const { t } = useI18n()
  const a = t.about
  const reduced = useReduced()
  const [ref, p] = useScrollProgress()
  // Across the whole pinned stretch, so there is never a scroll that moves
  // nothing: the section releases just as the fold lands.
  const fold = reduced ? 1 : easeInOut(span(p, 0, 0.95))
  // Share of the screen the satin still covers.
  const band = 100 - fold * 58

  // 2.4 screens: the opening is meant to unfold slowly, and everything in it
  // moves across the whole run, so a longer run is slower, not stuck.
  return (
    <section ref={ref} className={reduced ? '' : 'h-[240vh]'}>
      <div className={`${reduced ? 'relative' : 'sticky top-0'} h-svh overflow-hidden bg-black`}>
        <div className="absolute inset-x-0 top-0 overflow-hidden" style={{ height: `${band}%` }}>
          <ScrubVideo
            src={MEDIA.blue.src}
            poster={MEDIA.blue.poster}
            progress={p}
            className="absolute inset-0 h-full w-full object-cover"
          />
          {/* Blends the band's lower edge into the black as it folds up. */}
          <div
            className="absolute inset-0 bg-gradient-to-b from-navy-950/10 via-navy-800/20 to-black"
            style={{ opacity: 0.35 + fold * 0.65 }}
          />
          <div className="absolute inset-0 flex items-center justify-center px-6 pt-16">
            <h1
              className="text-center font-serif text-6xl text-white sm:text-8xl"
              style={{ transform: `scale(${1 - fold * 0.18})` }}
            >
              {/* The entrance lives on an inner span: an animation's filled
                  transform would otherwise override the scroll-driven scale. */}
              <span className="word-in inline-block">
                {a.heroTitle[0]}
                <span className="italic">{a.heroTitle[1]}</span>
              </span>
            </h1>
          </div>
        </div>

        <div
          className="absolute inset-x-0 bottom-0 flex items-center justify-center px-6"
          style={{ top: `${band}%` }}
        >
          <TypeOn
            text={a.intro}
            progress={reduced ? 1 : span(p, 0.25, 0.9)}
            className="max-w-2xl text-center text-sm leading-relaxed text-white/80 sm:text-base"
          />
        </div>
      </div>
    </section>
  )
}

// 1:39. The name, spelled phonetically, over a navy panel; the two paragraphs
// beneath write themselves in, left column then right.
function NameMeaning() {
  const { t } = useI18n()
  const n = t.about.name
  return (
    <section className="bg-[linear-gradient(180deg,#0a1220_0%,#1b2c48_100%)] px-6 py-28 sm:py-40">
      <Bloom
        lang="en-fonipa"
        className="font-phonetic text-center text-[2.75rem] italic leading-tight text-white sm:text-7xl md:text-8xl"
      >
        {n.phonetic}
      </Bloom>
      <div className="mx-auto mt-14 grid max-w-3xl gap-8 text-sm leading-relaxed text-white/75 sm:text-base md:mt-20 md:grid-cols-2 md:gap-16">
        {n.body.map((b, i) => (
          // The second column waits for the first to finish writing.
          <TypeOn key={i} text={b} delay={500 + i * 1700} stagger={55} />
        ))}
      </div>
    </section>
  )
}

// The phonetic name blooms open from its centre, as at 1:39 in the reference:
// it arrives with the letters drawn in close and faint, then the spacing
// between them opens out evenly both ways to its full 0.3em while the line
// sharpens and brightens. The letters never grow — only the gaps do. Plays each
// time the line scrolls into view (see .bloom in index.css).
function Bloom({ children, className = '', ...rest }) {
  const ref = useRef(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    // Hysteresis, as in Reveal: opens once a third is visible, closes again
    // only once it has fully left, so it replays on the way back.
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.intersectionRatio >= 0.35) setOpen(true)
        else if (entry.intersectionRatio === 0) setOpen(false)
      },
      { threshold: [0, 0.35] },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  return (
    <p ref={ref} className={className} {...rest}>
      <span className="bloom" data-open={open}>
        {children}
      </span>
    </p>
  )
}

// 1:45. The heading, then the champagne flute, blown up so the bowl fills the
// screen, with the camera travelling down it as the page scrolls: the rim
// rises in under the heading, the three pillars float over the champagne as
// bubbles to play with, then drift off as the lower bowl arrives with the
// vision's envelope, and "Why Oscenia" lands over the stem. One pinned scene,
// so the glass never cuts away.
function StandsFor() {
  const { t } = useI18n()
  const s = t.about.standsFor
  const reduced = useReduced()

  return (
    <>
      <section className="bg-black px-6 pb-10 pt-28 sm:pt-36">
        <div className="mx-auto grid max-w-content items-end gap-8 md:grid-cols-[1.2fr_1fr] md:gap-16">
          <Reveal from="left">
            <h2 className="font-serif text-5xl italic leading-[1.05] text-gold-light sm:text-7xl">
              <span className="block">{s.heading[0]}</span>
              <span className="block">{s.heading[1]}</span>
            </h2>
          </Reveal>
          <Reveal from="right" delay={250}>
            <p className="max-w-sm text-sm leading-relaxed text-white/70 sm:text-base">{s.intro}</p>
          </Reveal>
        </div>
      </section>
      {reduced ? <StillGlass /> : <GlassScene />}
    </>
  )
}

// How tall the flute is drawn. The glass spans ~77% of the film's width at
// mid-bowl, so drawing the film at 1.25x the screen width (2.22x in height, it
// being 9:16) puts the bowl's walls at the screen's edges, as the reference
// frames it — about three and a half screens of glass on a laptop. A phone is
// too narrow for that to be tall enough to travel down, so there it is at
// least 1.5 screens high and the walls sit just past the edges.
//
// The film is 720 wide, so on a large monitor this is an enlargement of about
// 2.5x and reads soft; a higher-resolution export of the same loop is a
// straight file swap.
const FLUTE_H = 'max(222vw, 150svh)'

// The flute film, centred and scrolled up by `pan` (0 = rim at the top of the
// screen, 1 = foot of the stem at the bottom).
function Flute({ pan = 0 }) {
  return (
    <div
      className="absolute left-1/2 top-0"
      style={{
        height: FLUTE_H,
        aspectRatio: '9 / 16',
        transform: `translateX(-50%) translateY(calc((100svh - ${FLUTE_H}) * ${pan}))`,
      }}
    >
      <BackdropVideo
        src={MEDIA.champagne.src}
        poster={MEDIA.champagne.poster}
        className="h-full w-full object-cover"
      />
    </div>
  )
}

// Beats of the scene, as shares of its scroll. The camera travels down the
// glass across `pan`, reaching the stem as "Why Oscenia" arrives: the last
// screen of the runway (from about 0.69) is where that scrolls up over it, so
// the vision is carried away just before.
const BEAT = {
  pan: [0, 0.8],
  bubblesIn: [0, 0.1],
  bubblesOut: [0.42, 0.52],
  envelopeIn: [0.48, 0.57],
  cardOut: [0.55, 0.64],
  visionOut: [0.67, 0.75],
}

function GlassScene() {
  const { t } = useI18n()
  const s = t.about.standsFor
  const [ref, p] = useScrollProgress()
  const at = (b) => span(p, b[0], b[1])

  // Slow over the bowl while the bubbles and the envelope are in play, then
  // gathering pace down to the stem, as the reference paces it (the bowl
  // holds 1:46-2:07; the stem arrives 2:08-2:12).
  const pan = at(BEAT.pan) ** 1.8
  const bubblesY = (1 - easeOut(at(BEAT.bubblesIn))) * 70 - easeInOut(at(BEAT.bubblesOut)) * 115
  const playing = p < BEAT.bubblesOut[0] + 0.02
  const envelopeIn = easeOut(at(BEAT.envelopeIn))
  const cardOut = easeOut(at(BEAT.cardOut))
  const visionExit = easeInOut(at(BEAT.visionOut))

  return (
    <section ref={ref} className={`h-[420vh] ${CHAMPAGNE_GROUND}`}>
      <div className={`sticky top-0 h-svh overflow-hidden ${CHAMPAGNE_GROUND}`}>
        <Flute pan={pan} />

        <div className="absolute inset-0" style={{ transform: `translateY(${bubblesY}vh)` }}>
          <GlassBubbles pillars={s.pillars} closeLabel={t.common.close} running={playing} />
        </div>
        <p
          className="pointer-events-none absolute inset-x-0 bottom-24 px-6 text-center text-xs tracking-[0.2em] sm:bottom-8 text-white/55 transition-opacity duration-500"
          style={{ opacity: playing && p > 0.06 ? 1 : 0 }}
        >
          {s.hint}
        </p>

        {/* Centred on a phone; on a wide screen it lands over the left of the
            lower bowl. */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center md:justify-start md:pl-[7%]">
          <div
            className="w-[min(90vw,34rem)]"
            style={{ transform: `translate(${(1 - envelopeIn) * -115}vw, ${visionExit * -115}vh)` }}
          >
            <VisionCard cardOut={cardOut} />
          </div>
        </div>
      </div>
    </section>
  )
}

// The vision on the paper card, drawn up out of the blue envelope (the
// designer's two photographs), the words set on the card in the brand serif.
function VisionCard({ cardOut = 1 }) {
  const { t } = useI18n()
  const v = t.about.vision
  return (
    <div className="relative pt-[26%]">
      <img
        src={MEDIA.envelope}
        alt=""
        aria-hidden="true"
        className="absolute right-0 top-0 w-[80%] rotate-[8deg] drop-shadow-[0_24px_40px_rgba(0,0,0,0.55)]"
      />
      <div
        className="relative w-[90%]"
        style={{
          transform: `translate(${(1 - cardOut) * 16}%, ${(1 - cardOut) * -34}%) rotate(${-1 - cardOut * 3}deg)`,
          opacity: 0.25 + cardOut * 0.75,
        }}
      >
        <img
          src={MEDIA.card}
          alt=""
          aria-hidden="true"
          className="block w-full drop-shadow-[0_30px_50px_rgba(0,0,0,0.6)]"
        />
        <div className="absolute inset-0 flex flex-col justify-center px-[9%] text-navy-900">
          <p className="font-serif text-3xl leading-none sm:text-5xl">{v.eyebrow}</p>
          <p className="mt-3 font-serif text-base italic leading-snug text-navy-800/85 sm:mt-5 sm:text-xl">
            {v.text}
          </p>
        </div>
      </div>
    </div>
  )
}

// Reduced motion: the same material, laid out flat. The bubbles stay where
// they are but still open their cards; the vision card sits beneath.
function StillGlass() {
  const { t } = useI18n()
  const s = t.about.standsFor
  return (
    <>
      <section className={`relative h-svh min-h-[560px] overflow-hidden ${CHAMPAGNE_GROUND}`}>
        <Flute pan={0.15} />
        <GlassBubbles pillars={s.pillars} closeLabel={t.common.close} />
      </section>
      <section className={`px-6 py-24 ${CHAMPAGNE_GROUND}`}>
        <div className="mx-auto w-[min(90vw,34rem)]">
          <VisionCard />
        </div>
      </section>
    </>
  )
}

// 2:12. Over the stem: "Why" with "Oscenia" set in under it, in gold, and the
// two paragraphs as narrow columns beneath, the second a step lower — the
// settled frame at 2:13-2:15. The section is pulled up by a
// full screen so it scrolls in over the glass scene's last, pinned frame — the
// stem — rather than cutting away from it.
function WhyOscenia() {
  const { t } = useI18n()
  const w = t.about.why
  const reduced = useReduced()
  return (
    <section
      className={`relative z-10 bg-gradient-to-b from-transparent via-black/60 to-black px-6 pb-16 sm:pb-24 ${
        reduced ? 'pt-28 sm:pt-40' : '-mt-[100svh] min-h-svh pt-[38svh]'
      }`}
    >
      <div className="mx-auto max-w-3xl">
        <Reveal from="left" duration={1600}>
          <h2 className="font-serif text-6xl italic leading-[0.95] text-gold-light sm:text-7xl md:text-8xl">
            <span className="block">{w.pre}</span>
            <span className="block pl-[16%] sm:pl-[22%]">{w.brand}</span>
          </h2>
        </Reveal>
        <div className="mt-12 grid gap-8 sm:ml-[4%] sm:grid-cols-2 sm:gap-14">
          {w.body.map((para, i) => (
            <Reveal key={i} from="up" delay={300 + i * 250} className={i === 1 ? 'sm:mt-10' : ''}>
              <p className="max-w-[17rem] text-sm leading-relaxed text-white/80 sm:text-base">{para}</p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}

// 2:15. "Our Value", then a black panel per value: the title writes itself in
// a letter at a time on the left and its content arrives on the right.
//
// The satin is not a strip of its own. As the reference has it (2:17-2:27),
// it is one full-screen backdrop pinned behind the whole section — cream
// above, blue below, the fold between them moving — and the panels scroll
// over it, so each gap between them is a window onto it. A gap near the top of
// the screen shows cream, one near the foot shows blue, and one crossing the
// middle shows the blue sweeping up over the cream. Hard edges, no fades.
function OurValue() {
  const { t } = useI18n()
  const value = t.about.value
  return (
    <section className="relative">
      {/* The pinned layer lives inside a layer exactly the section's size, so
          it stops at the section's foot instead of hanging over the footer.
          The film is drawn taller than the screen and hung from the top, so
          the fold sits about two-thirds down: mostly cream, the blue coming in
          below, as in the reference. */}
      <div aria-hidden="true" className="absolute inset-0">
        <div className="sticky top-0 h-svh overflow-hidden">
          <BackdropVideo
            src={MEDIA.twoTone.src}
            poster={MEDIA.twoTone.poster}
            className="absolute inset-x-0 top-0 h-[135%] w-full object-cover object-top"
          />
        </div>
      </div>

      <div className="relative">
        <div className="bg-black px-6 pb-8 pt-28 text-center sm:pt-40">
          <Reveal from="scale" duration={1600}>
            <h2 className={`font-serif text-6xl italic sm:text-8xl ${CREAM}`}>{value.heading}</h2>
          </Reveal>
        </div>

        {value.items.map((v, i) => (
          <Fragment key={v.title}>
            {i > 0 && <div aria-hidden="true" className="h-[52svh] sm:h-[70svh]" />}
            <div className="bg-black">
              <ValueBand item={v} />
            </div>
          </Fragment>
        ))}

        <div className="bg-gradient-to-b from-black to-[#0b1424] px-6 pb-28 pt-12 text-center">
          <GlassCTA />
        </div>
      </div>
    </section>
  )
}

function ValueBand({ item: v }) {
  return (
    <div className="mx-auto grid max-w-content gap-10 px-6 py-20 sm:py-28 md:grid-cols-[minmax(0,1fr)_minmax(0,2.2fr)] md:gap-16">
      <TypeOn
        as="h3"
        by="char"
        text={v.title}
        className={`font-serif text-4xl leading-[1.15] sm:text-5xl md:max-w-[11ch] ${CREAM}`}
      />

      <div className="md:pt-3">
        {/* Strategic Experience Design: the two questions, side by side. */}
        {v.body && (
          <div className="grid gap-10 sm:grid-cols-2">
            {v.body.map((b, k) => (
              <Reveal key={k} from="right" delay={900 + k * 450}>
                <p className="text-xs text-white/55">{b.label}</p>
                <p className={`mt-2 font-serif text-2xl italic leading-snug sm:text-3xl ${CREAM}`}>
                  {b.text}
                </p>
              </Reveal>
            ))}
          </div>
        )}

        {/* Integrated Event Management: the list, in two columns. */}
        {v.list && (
          <>
            <Reveal from="up" delay={700}>
              <p className="mb-6 text-sm text-white/70">{v.lead}</p>
            </Reveal>
            <ul className="grid gap-x-12 gap-y-3 text-sm text-white/75 sm:grid-cols-2">
              {v.list.map((li, k) => (
                <Reveal as="li" key={li} from="up" delay={900 + k * 120}>
                  <span className="mr-2 text-gold">~</span>
                  {li}
                </Reveal>
              ))}
            </ul>
          </>
        )}

        {/* Narrative-Driven Approach: the formula writes itself in. */}
        {v.formula && (
          <>
            <Reveal from="up" delay={700}>
              <p className="text-sm text-white/70">{v.lead}</p>
            </Reveal>
            <TypeOn
              text={v.formula}
              delay={1000}
              stagger={160}
              className={`mt-4 font-serif text-2xl italic sm:text-3xl ${CREAM}`}
            />
            <Reveal from="up" delay={1800}>
              <p className="mt-5 max-w-md text-sm leading-relaxed text-white/55">{v.note}</p>
            </Reveal>
          </>
        )}
      </div>
    </div>
  )
}
