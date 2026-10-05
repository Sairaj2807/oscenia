import { useEffect } from 'react'
import { useIntroReady } from '../introReady'

// Warms the browser cache with what a page needs to paint its opening, so
// following a link doesn't wait on downloads that only start once the page has
// rendered (arriving on About used to show a black screen until its satin
// poster arrived).
//
// Two moments:
// - Once the intro has lifted and the browser is idle, each page's opening
//   images are fetched in the background, one at a time and in priority order
//   (About's poster first), so on a slow connection they never crowd out each
//   other or the page in front of the visitor.
// - When a link to a page is pointed at or focused, that page's images jump
//   the queue, and — on a decent connection, once its poster is cached — the
//   beginning of its opening film starts loading, so the moment between hover
//   and click covers the film's start-up.

// What each page needs on arrival, most important first. `images` are fetched
// whole; `video` only for its first VIDEO_HEAD bytes.
export const ROUTE_ASSETS = {
  '/about': {
    images: ['/about/fabric-blue-poster.webp'],
    video: '/about/fabric-blue.mp4',
  },
  '/services': {
    images: [
      '/services/velvet.webp',
      '/services/curtain-left.webp',
      '/services/curtain-right.webp',
      '/services/valance.webp',
      '/services/bead-big.png',
      '/services/bead-small.png',
      '/services/bead-logo.png',
    ],
  },
}

// Enough of a film to begin: its header and first seconds.
const VIDEO_HEAD = 2_000_000

// url -> 'queued' | 'loading' | 'done'
const state = new Map()
const queue = []
let busy = false

function pump() {
  if (busy) return
  const url = queue.shift()
  if (!url) return
  busy = true
  state.set(url, 'loading')
  const img = new Image()
  img.decoding = 'async'
  const next = () => {
    state.set(url, 'done')
    busy = false
    pump()
  }
  img.onload = next
  img.onerror = next
  img.src = url
}

// Queues images; `urgent` puts them at the front (a link is being pointed at).
function warmImages(urls, urgent = false) {
  const fresh = urls.filter((u) => !state.has(u) || (urgent && state.get(u) === 'queued'))
  fresh.forEach((u) => {
    const i = queue.indexOf(u)
    if (i >= 0) queue.splice(i, 1)
    state.set(u, 'queued')
  })
  if (urgent) queue.unshift(...fresh)
  else queue.push(...fresh)
  pump()
}

function warmVideo(url) {
  if (state.has(url)) return
  state.set(url, 'loading')
  // A ranged request lands in the browser's media cache, which the page's own
  // <video> reads from when it asks for the same bytes.
  fetch(url, { headers: { Range: `bytes=0-${VIDEO_HEAD - 1}` } })
    .then(() => state.set(url, 'done'))
    .catch(() => state.delete(url))
}

const connection = () => (typeof navigator !== 'undefined' ? navigator.connection : null)

// Data-saving visitors and very slow connections get nothing warmed.
const shouldSave = () => {
  const c = connection()
  return !!c && (c.saveData || /(^|-)2g$/.test(c.effectiveType || ''))
}

// Films are only warmed on a connection that can afford it; where the browser
// doesn't say, assume it can.
const roomForFilm = () => {
  const c = connection()
  return !c || ((c.downlink ?? 10) >= 5 && c.effectiveType !== '3g')
}

const idle = (fn) =>
  typeof window.requestIdleCallback === 'function'
    ? window.requestIdleCallback(fn, { timeout: 3000 })
    : window.setTimeout(fn, 1200)

const cancelIdle = (id) =>
  typeof window.cancelIdleCallback === 'function' ? window.cancelIdleCallback(id) : window.clearTimeout(id)

export default function usePrefetch() {
  const introDone = useIntroReady()

  // Background: every page's opening images, once the intro is out of the way.
  useEffect(() => {
    if (!introDone || shouldSave()) return undefined
    const id = idle(() => {
      Object.values(ROUTE_ASSETS).forEach((a) => a.images && warmImages(a.images))
    })
    return () => cancelIdle(id)
  }, [introDone])

  // On intent: pointing at or focusing a link moves that page to the front.
  useEffect(() => {
    if (shouldSave()) return undefined
    const onIntent = (e) => {
      const link = e.target.closest?.('a[href]')
      if (!link || link.origin !== window.location.origin) return
      const assets = ROUTE_ASSETS[link.pathname]
      if (!assets) return
      if (assets.images) warmImages(assets.images, true)
      const postersReady = (assets.images || []).every((u) => state.get(u) === 'done')
      if (assets.video && postersReady && roomForFilm()) warmVideo(assets.video)
    }
    document.addEventListener('pointerover', onIntent, { passive: true })
    document.addEventListener('focusin', onIntent)
    document.addEventListener('touchstart', onIntent, { passive: true })
    return () => {
      document.removeEventListener('pointerover', onIntent)
      document.removeEventListener('focusin', onIntent)
      document.removeEventListener('touchstart', onIntent)
    }
  }, [])
}
