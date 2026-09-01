import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n/LanguageContext'
import BackdropVideo from './BackdropVideo'
import BrandMark from './BrandMark'

// The opening sequence: a held logo on navy velvet that the visitor starts
// themselves, then Oscenia's own company film, playing in full, then the site.
//
// Earlier drafts re-staged the film as a set of short animated text chapters
// (see git history / components/IntroOrbit.jsx if that is ever wanted back).
// This plays the real footage instead — public/media/showreel.mp4 — so what
// the visitor sees during the intro is the actual company profile film rather
// than a paraphrase of it.
const SPLASH_EXIT_MS = 1100

// -2 splash, -1 splash leaving, 0 video playing, 1 done.
const STAGE = { SPLASH: -2, SPLASH_LEAVING: -1, VIDEO: 0, DONE: 1 }

const prefersReduced = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

export default function Intro() {
  const { t } = useI18n()
  const [reduced] = useState(prefersReduced)
  const [stage, setStage] = useState(STAGE.SPLASH)
  const [progress, setProgress] = useState(0)
  const startRef = useRef(null)
  const skipRef = useRef(null)
  const videoRef = useRef(null)

  const finish = useCallback(() => setStage(STAGE.DONE), [])

  const start = useCallback(() => {
    setStage(STAGE.SPLASH_LEAVING)
    setTimeout(
      () => setStage(reduced ? STAGE.DONE : STAGE.VIDEO),
      reduced ? 0 : SPLASH_EXIT_MS,
    )
  }, [reduced])

  // Announced once, however the intro ended — the film finishing on its own,
  // Skip, or Escape.
  useEffect(() => {
    if (stage === STAGE.DONE) window.dispatchEvent(new Event('oscenia:intro-done'))
  }, [stage])

  // The splash's one control, then Skip, each take focus as they appear —
  // otherwise Tab walks straight into the page underneath the overlay.
  useEffect(() => {
    if (stage === STAGE.SPLASH) startRef.current?.focus()
    else if (stage === STAGE.VIDEO) skipRef.current?.focus()
  }, [stage])

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') finish()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [finish])

  // The progress hairline tracks actual playback, not a fixed timer.
  useEffect(() => {
    const el = videoRef.current
    if (stage !== STAGE.VIDEO || !el) return undefined
    const onTime = () => {
      if (el.duration) setProgress(el.currentTime / el.duration)
    }
    el.addEventListener('timeupdate', onTime)
    return () => el.removeEventListener('timeupdate', onTime)
  }, [stage])

  if (stage === STAGE.DONE) return null

  const splash = stage <= STAGE.SPLASH_LEAVING
  const leaving = stage === STAGE.SPLASH_LEAVING

  return (
    <div
      className="fixed inset-0 z-[100] overflow-hidden bg-black"
      role="dialog"
      aria-label={t.intro.showreelLabel}
      aria-modal="true"
    >
      {splash ? (
        <div className="absolute inset-0">
          {/* The brand's own navy velvet, from the vector pack's video assets. */}
          <BackdropVideo
            eager
            className="absolute inset-0 h-full w-full object-cover"
            src="/media/velvet.mp4"
            poster="/media/velvet-poster.jpg"
          />
          <div className="absolute inset-0 bg-navy-950/45" />

          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <button
              ref={startRef}
              type="button"
              onClick={start}
              aria-label={t.intro.clickLogo}
              className="group focus:outline-none"
              style={{
                // Taking the mark to white and pushing it past the frame is the
                // handover: the last thing the splash does is stop being gold.
                transform: leaving ? 'scale(2.7)' : 'scale(1)',
                filter: leaving ? 'brightness(0) invert(1)' : 'none',
                opacity: leaving ? 0.92 : 1,
                transitionProperty: 'transform, filter, opacity',
                transitionDuration: `${SPLASH_EXIT_MS}ms`,
                transitionTimingFunction: 'cubic-bezier(0.7, 0, 0.2, 1)',
              }}
            >
              <BrandMark
                as="plain"
                variant="stacked"
                className="h-40 transition-transform duration-700 group-hover:scale-[1.04] sm:h-52"
              />
            </button>

            <span
              className={`mt-24 font-serif text-sm tracking-[0.06em] text-white/70 transition-opacity duration-500 ${
                leaving ? 'opacity-0' : 'animate-pulse-soft'
              }`}
            >
              {t.intro.clickLogo}
            </span>
          </div>
        </div>
      ) : (
        <>
          <video
            ref={videoRef}
            className="absolute inset-0 h-full w-full object-cover"
            src="/media/showreel.mp4"
            poster="/media/showreel-poster.jpg"
            autoPlay
            muted
            playsInline
            onEnded={finish}
          />

          <button
            ref={skipRef}
            type="button"
            onClick={finish}
            className="absolute bottom-8 right-6 z-10 rounded-full bg-black px-8 py-2.5 font-serif text-sm italic text-white transition-colors duration-300 hover:bg-gold-light hover:text-navy-950 focus:outline-none sm:right-10"
          >
            {t.intro.skip}
          </button>
          <div className="absolute inset-x-0 bottom-0 z-10 h-[3px] bg-white/5">
            <div className="h-full bg-gold/90" style={{ width: `${progress * 100}%` }} />
          </div>
        </>
      )}
    </div>
  )
}
