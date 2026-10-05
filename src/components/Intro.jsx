import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { MARK_EMBLEM, MARK_GOLD, MARK_TEXT, MARK_VIEWBOX } from '../data/markGeometry'
import { useI18n } from '../i18n/LanguageContext'
import BackdropVideo from './BackdropVideo'
import BrandMark from './BrandMark'
import releaseVideo from './releaseVideo'

// The opening sequence: a held logo on navy velvet that the visitor starts
// themselves, then Oscenia's own company film, playing in full, then the site.
//
// The handover between the two is a camera push *through* the mark, matching
// "Video Project.mp4" in the repo root — that recording is a screen capture of
// the intended prototype, so every number below is measured off it rather than
// chosen. Click lands at 3.00s in that clip; times here are relative to the
// click.
//
//   0-80ms      nothing moves
//   80-260ms    the ink brightens gold -> cream -> white. Measured samples:
//               (197,186,153) -> (211,199,171) -> (249,241,228) -> white.
//               It only ever brightens; it never darkens or passes through grey.
//   80-400ms    still no movement. The reference holds dead still here, and the
//               pause is most of what makes the push afterwards feel deliberate.
//   400-1300ms  the mark scales away from the viewer on an exponential curve,
//               until one of its strokes covers the viewport outright.
//   1300-1450ms it keeps accelerating past that point rather than easing to a
//               stop, which is the difference between a push and an object
//               inflating.
//
// After that the screen is a flat cream field, and so is the first ~1.8s of
// showreel.mp4 — so the swap from the wipe to the film has nothing to hide.
const SPLASH_EXIT_MS = 1450
const COLOR_FROM_MS = 80
const PUSH_FROM_MS = 400
const COVER_MS = 1300

// Past this the wordmark is well outside the frame, so it stops being drawn and
// the expensive high-zoom frames repaint one path instead of fourteen.
const TEXT_DROP_SCALE = 4.5

// A little past bare coverage, since the solver samples a grid rather than
// every pixel.
const COVER_MARGIN = 1.06

// Ink colour over time. The last stop is showreel.mp4's own opening frame
// (sampled: 241,239,236) rather than white, so that when the splash unmounts
// and the film is what's left, there is no step in the colour at all.
const INK_STOPS = [
  { at: COLOR_FROM_MS, value: [201, 167, 99] },
  { at: 200, value: [249, 241, 228] },
  { at: 260, value: [255, 255, 255] },
  { at: COVER_MS, value: [241, 239, 236] },
]

// -2 splash, -1 splash leaving, 0 video playing, 1 done.
const STAGE = { SPLASH: -2, SPLASH_LEAVING: -1, VIDEO: 0, DONE: 1 }

// Plays the showreel with its soundtrack. If the browser still refuses sound
// (no gesture it recognises), it falls back to playing muted rather than
// leaving the intro frozen on a still frame.
function playWithSound(video) {
  if (!video) return
  video.muted = false
  video.play()?.catch((err) => {
    if (err?.name !== 'NotAllowedError') return
    video.muted = true
    video.play()?.catch(() => {})
  })
}

const prefersReduced = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

function mixStops(stops, t) {
  if (t <= stops[0].at) return stops[0].value
  const last = stops[stops.length - 1]
  if (t >= last.at) return last.value
  for (let i = 0; i < stops.length - 1; i++) {
    const from = stops[i]
    const to = stops[i + 1]
    if (t >= from.at && t <= to.at) {
      const k = (t - from.at) / (to.at - from.at)
      return from.value.map((v, c) => v + (to.value[c] - v) * k)
    }
  }
  return last.value
}

const rgb = ([r, g, b]) => `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`

// Draws the mark into an offscreen canvas so its ink can be measured. Same
// origin, so the pixels can be read back.
//
// The height comes from the viewBox rather than from naturalWidth/Height: the
// file carries a viewBox and no width/height, and what an <img> reports as its
// intrinsic size in that case is not consistent between browsers. drawImage is
// given an explicit box, so the raster is the same everywhere.
function rasteriseMark(src, w = 420) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const h = Math.max(1, Math.round((MARK_VIEWBOX.h / MARK_VIEWBOX.w) * w))
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return resolve(null)
      ctx.drawImage(img, 0, 0, w, h)
      try {
        const { data } = ctx.getImageData(0, 0, w, h)
        const ink = new Uint8Array(w * h)
        for (let i = 0; i < ink.length; i++) ink[i] = data[i * 4 + 3] > 128 ? 1 : 0
        resolve({ ink, w, h })
      } catch {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = src
  })
}

// Where to push into: the centre of the largest circle that fits inside the
// ink, found with a two-pass chamfer distance transform. That is by
// construction the point with the most artwork around it, so it is the one
// place the camera can travel into without the frame breaking up into gaps.
//
// Fitting the same fixed point off the reference recording independently gives
// ~19%/16% of the mark's box, which is the sanity check on this.
const ANCHOR_FALLBACK = { x: 0.19, y: 0.16 }

function findAnchor(raster) {
  if (!raster) return ANCHOR_FALLBACK
  const { ink, w, h } = raster
  const D = 1.41421356
  const d = new Float32Array(w * h)
  for (let i = 0; i < d.length; i++) d[i] = ink[i] ? 1e9 : 0

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!ink[i]) continue
      let v = d[i]
      if (x > 0) v = Math.min(v, d[i - 1] + 1)
      if (y > 0) v = Math.min(v, d[i - w] + 1)
      if (x > 0 && y > 0) v = Math.min(v, d[i - w - 1] + D)
      if (x < w - 1 && y > 0) v = Math.min(v, d[i - w + 1] + D)
      d[i] = v
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x
      if (!ink[i]) continue
      let v = d[i]
      if (x < w - 1) v = Math.min(v, d[i + 1] + 1)
      if (y < h - 1) v = Math.min(v, d[i + w] + 1)
      if (x < w - 1 && y < h - 1) v = Math.min(v, d[i + w + 1] + D)
      if (x > 0 && y < h - 1) v = Math.min(v, d[i + w - 1] + D)
      d[i] = v
    }
  }

  let best = 0
  let at = -1
  for (let i = 0; i < d.length; i++) {
    if (d[i] > best) {
      best = d[i]
      at = i
    }
  }
  if (at < 0) return ANCHOR_FALLBACK
  return { x: (at % w) / w, y: Math.floor(at / w) / h }
}

// Maps a viewport point back into the mark's own coordinates at a given scale.
// `view` carries the viewBox the mark sits in at rest (see the click handler).
function toMarkSpace(view, s, px, py) {
  const { ax, ay, minX0, minY0, vw0, vh0, vpW, vpH } = view
  const minX = ax - (ax - minX0) / s
  const minY = ay - (ay - minY0) / s
  return [minX + (px / vpW) * (vw0 / s), minY + (py / vpH) * (vh0 / s)]
}

// How far the mark has to travel before its ink covers the viewport outright.
// Solved against the actual artwork rather than assumed: the mark is a set of
// ribbons, not a disc, so what eventually fills the screen is a stroke's length
// and curvature, and no closed-form radius predicts it. Binary search over a
// sampled grid, which is cheap enough to run on the click.
function solveCoverScale(raster, view) {
  if (!raster) return 80
  const { ink, w, h } = raster
  // Dense enough that a leftover sliver of velvet can't hide between samples;
  // still only ~20k lookups across the whole search.
  const COLS = 49
  const ROWS = 29

  const covers = (s) => {
    for (let r = 0; r < ROWS; r++) {
      const py = (r / (ROWS - 1)) * view.vpH
      for (let c = 0; c < COLS; c++) {
        const px = (c / (COLS - 1)) * view.vpW
        const [ux, uy] = toMarkSpace(view, s, px, py)
        const ix = Math.round((ux / MARK_VIEWBOX.w) * w)
        const iy = Math.round((uy / MARK_VIEWBOX.h) * h)
        if (ix < 0 || iy < 0 || ix >= w || iy >= h) return false
        if (!ink[iy * w + ix]) return false
      }
    }
    return true
  }

  let lo = 1
  let hi = 8
  while (hi < 4096 && !covers(hi)) {
    lo = hi
    hi *= 2
  }
  if (!covers(hi)) return hi
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2
    if (covers(mid)) hi = mid
    else lo = mid
  }
  return hi
}

export default function Intro() {
  const { t } = useI18n()
  const [reduced] = useState(prefersReduced)
  const [stage, setStage] = useState(STAGE.SPLASH)
  const [progress, setProgress] = useState(0)
  const startRef = useRef(null)
  const markRef = useRef(null)
  const skipRef = useRef(null)
  const videoRef = useRef(null)
  const letterboxRef = useRef(null)
  // The zooming mark, its ink group, and the wordmark that gets dropped once it
  // is off screen.
  const wipeRef = useRef(null)
  const inkRef = useRef(null)
  const textRef = useRef(null)
  const rasterRef = useRef(null)
  const viewRef = useRef(null)
  const rafRef = useRef(0)
  const leaveTimerRef = useRef(0)

  // The intro always hands over to the home page, whichever address it was
  // loaded on (a refresh on /about, a shared /services link). Done as the
  // overlay appears rather than when it ends, so Home is what warms up
  // underneath and is ready the moment the film lifts. `replace`, so Back
  // doesn't return to the page the intro covered.
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [startPath] = useState(pathname)
  useEffect(() => {
    if (startPath !== '/') navigate('/', { replace: true })
  }, [startPath, navigate])

  const finish = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    clearTimeout(leaveTimerRef.current)
    // Stop the film downloading too: skipped early, it would otherwise keep
    // streaming in the background and slow the page the visitor goes to next.
    releaseVideo(videoRef.current)
    setStage(STAGE.DONE)
  }, [])

  // Measured once, up front, while the splash is just sitting there waiting to
  // be clicked — the work is off the critical path and the result is reused.
  useEffect(() => {
    if (reduced) return undefined
    let cancelled = false
    rasteriseMark('/brand/mark-stacked-gold.svg').then((raster) => {
      if (!cancelled) rasterRef.current = raster
    })
    return () => {
      cancelled = true
    }
  }, [reduced])

  const start = useCallback(() => {
    if (stage !== STAGE.SPLASH) return

    if (reduced) {
      setStage(STAGE.DONE)
      return
    }

    // The film plays with its sound, which browsers only allow from a user
    // gesture. The real start is 400ms later, from the animation loop, and
    // Safari doesn't count that as part of the click — so the element is
    // unlocked here, inside the click: started and paused at once, before a
    // single sample can be heard.
    const video = videoRef.current
    if (video) {
      video.muted = false
      video.play()?.catch(() => {})
      video.pause()
    }

    const rect = markRef.current?.getBoundingClientRect()
    const vpW = window.innerWidth
    const vpH = window.innerHeight
    if (!rect || !rect.width) {
      setStage(STAGE.VIDEO)
      playWithSound(videoRef.current)
      return
    }

    const raster = rasterRef.current
    const anchor = findAnchor(raster)
    const ax = anchor.x * MARK_VIEWBOX.w
    const ay = anchor.y * MARK_VIEWBOX.h

    // The wipe is a viewport-sized <svg>, so its viewBox at rest is whatever
    // region of the mark's coordinate space the viewport corresponds to when
    // the mark is drawn exactly where the splash logo sits. k is the px-per-unit
    // scale that puts it there.
    const k = rect.width / MARK_VIEWBOX.w
    const view = {
      ax,
      ay,
      minX0: -rect.left / k,
      minY0: -rect.top / k,
      vw0: vpW / k,
      vh0: vpH / k,
      vpW,
      vpH,
    }
    view.coverScale = solveCoverScale(raster, view) * COVER_MARGIN
    viewRef.current = view

    setStage(STAGE.SPLASH_LEAVING)

    // Exponential: a constant multiplicative rate, which is what a camera
    // travelling at a steady speed toward an object actually produces. The
    // reference measures ×1.46 per 100ms; the rate here falls out of the
    // distance this particular viewport has to cover in the same time, because
    // holding the sequence's rhythm matters more than matching its px/s.
    const rate = Math.log(view.coverScale) / (COVER_MS - PUSH_FROM_MS)
    let played = false
    let textDropped = false

    const startTime = performance.now()
    const tick = () => {
      const ms = performance.now() - startTime
      const s = ms <= PUSH_FROM_MS ? 1 : Math.exp(rate * (ms - PUSH_FROM_MS))

      const svg = wipeRef.current
      if (svg) {
        const minX = ax - (ax - view.minX0) / s
        const minY = ay - (ay - view.minY0) / s
        svg.setAttribute('viewBox', `${minX} ${minY} ${view.vw0 / s} ${view.vh0 / s}`)
      }
      inkRef.current?.setAttribute('fill', rgb(mixStops(INK_STOPS, ms)))

      if (!textDropped && s > TEXT_DROP_SCALE && textRef.current) {
        textRef.current.style.display = 'none'
        textDropped = true
      }

      // Started with the push rather than on the click, so the film's own
      // cream opening still has most of its length left when the wipe lands on
      // top of it.
      if (!played && ms >= PUSH_FROM_MS) {
        played = true
        playWithSound(videoRef.current)
      }

      rafRef.current = ms < SPLASH_EXIT_MS ? requestAnimationFrame(tick) : 0
    }
    rafRef.current = requestAnimationFrame(tick)

    leaveTimerRef.current = setTimeout(() => setStage(STAGE.VIDEO), SPLASH_EXIT_MS)
  }, [reduced, stage])

  useEffect(
    () => () => {
      cancelAnimationFrame(rafRef.current)
      clearTimeout(leaveTimerRef.current)
    },
    [],
  )

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

  // On a portrait screen the film is letterboxed (it's kinetic type — cropping
  // it to fill cuts every sentence), and the bars above and below it are
  // painted, frame by frame, in the colours of the film's own top and bottom
  // edges. Every scene sits on a flat cream, navy or black ground, so the film
  // reads as filling the phone rather than floating in black. The frame is read
  // at 16×9, which costs next to nothing. The colour goes on a layer behind the
  // video (not the video's own background) because the film's edges are faded
  // out with a mask (.showreel-letterbox in index.css), which would hide it.
  useEffect(() => {
    const video = videoRef.current
    const box = letterboxRef.current
    if (reduced || !video || !box) return undefined
    const portrait = window.matchMedia('(orientation: portrait)')
    const canvas = document.createElement('canvas')
    canvas.width = 16
    canvas.height = 9
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    const rowColour = (data, row) => {
      let r = 0
      let g = 0
      let b = 0
      for (let x = 0; x < 16; x++) {
        const i = (row * 16 + x) * 4
        r += data[i]
        g += data[i + 1]
        b += data[i + 2]
      }
      return `rgb(${Math.round(r / 16)},${Math.round(g / 16)},${Math.round(b / 16)})`
    }
    let raf = 0
    const sample = () => {
      raf = 0
      if (video.paused || video.ended) return
      if (portrait.matches && video.readyState >= 2) {
        ctx.drawImage(video, 0, 0, 16, 9)
        const { data } = ctx.getImageData(0, 0, 16, 9)
        box.style.background = `linear-gradient(${rowColour(data, 0)} 50%, ${rowColour(data, 8)} 50%)`
      } else {
        box.style.background = ''
      }
      raf = requestAnimationFrame(sample)
    }
    const onPlay = () => {
      if (!raf) raf = requestAnimationFrame(sample)
    }
    video.addEventListener('play', onPlay)
    return () => {
      video.removeEventListener('play', onPlay)
      cancelAnimationFrame(raf)
    }
  }, [reduced])

  if (stage === STAGE.DONE) return null

  const splash = stage <= STAGE.SPLASH_LEAVING
  const leaving = stage === STAGE.SPLASH_LEAVING
  const view = viewRef.current

  return (
    <div
      className="fixed inset-0 z-[100] overflow-hidden bg-black"
      role="dialog"
      aria-label={t.intro.showreelLabel}
      aria-modal="true"
    >
      {/* Underneath everything, and covered by the splash until the wipe has
          taken the screen. Reduced motion never shows the film at all. */}
      {!reduced && <div ref={letterboxRef} aria-hidden="true" className="absolute inset-0" />}
      {!reduced && (
        <video
          ref={videoRef}
          // Fills the screen in landscape; letterboxed in portrait so no
          // sentence of the film is cut off (bars painted by the effect above).
          className="showreel-letterbox absolute inset-0 h-full w-full object-cover"
          src="/media/showreel.mp4"
          poster="/media/showreel-poster.jpg"
          playsInline
          preload="auto"
          onEnded={finish}
        />
      )}

      {splash && (
        <div className="absolute inset-0">
          {/* The brand's own navy velvet, from the vector pack's video assets.
              It stays visible behind the mark for the whole push — the mark's
              own ink is what covers it, nothing masks it out. */}
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
              // Handing over to the drawn mark below, which covers exactly the
              // same pixels in exactly the same gold, so the swap has nothing
              // to show.
              className={`group focus:outline-none ${
                leaving ? 'opacity-0 transition-opacity duration-150' : ''
              }`}
            >
              {/* The hover nudge sits on this wrapper rather than on the mark
                  itself so that measuring it picks the transform up: a click
                  almost always lands while hovering, and the drawn mark has to
                  start from where the logo actually is on screen, not from
                  where it would be unhovered. */}
              <span
                ref={markRef}
                className="inline-block transition-transform duration-700 group-hover:scale-[1.04]"
              >
                <BrandMark as="plain" variant="stacked" className="h-40 sm:h-52" />
              </span>
            </button>

            <span
              className={`mt-24 font-serif text-sm tracking-[0.06em] text-white/70 transition-opacity duration-300 ${
                leaving ? 'opacity-0' : 'animate-pulse-soft'
              }`}
            >
              {t.intro.clickLogo}
            </span>
          </div>
        </div>
      )}

      {/* The mark again, this time as real geometry rather than an <img>: the
          push takes it tens of times past its own size, and only vector paths
          re-render sharp at that scale. Zoomed by rewriting the viewBox, which
          is what forces that re-render — a CSS transform would scale the
          rasterised texture instead and go to mush. */}
      {leaving && view && (
        <svg
          ref={wipeRef}
          className="pointer-events-none absolute inset-0 h-full w-full"
          viewBox={`${view.minX0} ${view.minY0} ${view.vw0} ${view.vh0}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <g ref={inkRef} fill={MARK_GOLD}>
            <path d={MARK_EMBLEM} />
            <g ref={textRef}>
              {MARK_TEXT.map((d, i) => (
                <path key={i} d={d} />
              ))}
            </g>
          </g>
        </svg>
      )}

      {stage === STAGE.VIDEO && (
        <>
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
