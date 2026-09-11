import { useCallback } from 'react'

// The live half of the .liquid-glass material in index.css: the light that
// follows the pointer, and — where the browser can do it — the lensing that
// makes it Liquid Glass rather than frosted glass.
//
// Lensing is the part CSS can't express. Content behind the rim has to bend,
// which takes an SVG displacement filter fed to backdrop-filter, and the
// displacement map has to match the element's exact size and corner radius. So
// the map is drawn here, per element, and redrawn whenever the element resizes.
//
// Returned as a callback ref rather than an effect on a ref object: the quick
// contact bead unmounts on /contact and mounts again on the way out, and an
// effect keyed to the component would never see the new element.

const SVG_NS = 'http://www.w3.org/2000/svg'

// How deep the lensed rim runs, as a fraction of the element's short side, and
// how far content is pulled across it at the very edge, as a fraction of that
// depth. Set by rendering the hero button over hero-table.webp at 1600px,
// where a light arc in the photo crosses behind it: much below ~0.7 the arc
// barely jogs at the rim and the effect doesn't read as a lens; much above ~1
// the rim starts smearing the film into streaks.
const BEVEL = 0.3
const PULL = 0.85

const matches = (query) =>
  typeof window !== 'undefined' && window.matchMedia?.(query).matches

// Only Chromium applies an SVG filter referenced from backdrop-filter; other
// engines don't, and the glass keeps its blur and saturation there. That gap is
// the whole reason this lives in JS behind a test. navigator.userAgentData is
// itself Chromium-only, so it answers the question directly instead of
// guessing from a user-agent string — and correctly excludes Chrome on iOS,
// which is WebKit underneath.
const canRefract = () =>
  typeof navigator !== 'undefined' &&
  !!navigator.userAgentData?.brands?.some((b) => b.brand === 'Chromium')

let host = null
let seq = 0

// One hidden <svg> holds every glass element's filter. Zero-sized and out of
// flow rather than display:none, which can stop an engine resolving filters
// defined inside it.
function filterHost() {
  if (host?.isConnected) return host
  host = document.createElementNS(SVG_NS, 'svg')
  host.setAttribute('aria-hidden', 'true')
  host.setAttribute('focusable', 'false')
  Object.assign(host.style, {
    position: 'absolute',
    width: '0',
    height: '0',
    overflow: 'hidden',
    pointerEvents: 'none',
  })
  document.body.appendChild(host)
  return host
}

// A displacement map for a rounded rectangle with a bevelled rim. Red and green
// carry x and y displacement, 128 meaning none. Within `bevel` px of the edge,
// each pixel samples from further *in* along the edge's inward normal —
// stretching the content just inside out to the rim, which is how the edge of
// a thick lens behaves. Falloff is quadratic, so the bend is sharp at the rim
// and gone well before the middle, which stays clear.
//
// Sampling inward also keeps every read inside the element's own backdrop.
function displacementMap(w, h, radius, bevel) {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const img = ctx.createImageData(w, h)
  const data = img.data
  const hw = w / 2
  const hh = h / 2
  const r = Math.min(radius, hw, hh)

  for (let y = 0; y < h; y++) {
    const py = y + 0.5 - hh
    const qy = Math.abs(py) - (hh - r)
    for (let x = 0; x < w; x++) {
      const px = x + 0.5 - hw
      const qx = Math.abs(px) - (hw - r)
      // Distance in from the edge, and the edge's outward normal.
      let d
      let nx
      let ny
      if (qx > 0 && qy > 0) {
        const len = Math.hypot(qx, qy)
        d = r - len
        nx = (qx / len) * Math.sign(px)
        ny = (qy / len) * Math.sign(py)
      } else if (qx > qy) {
        d = r - qx
        nx = Math.sign(px)
        ny = 0
      } else {
        d = r - qy
        nx = 0
        ny = Math.sign(py)
      }
      const t = d > 0 && d < bevel ? 1 - d / bevel : 0
      const m = t * t
      const i = (y * w + x) * 4
      data[i] = 128 - nx * m * 127
      data[i + 1] = 128 - ny * m * 127
      data[i + 2] = 128
      data[i + 3] = 255
    }
  }

  ctx.putImageData(img, 0, 0)
  return canvas.toDataURL('image/png')
}

function attachRefraction(el) {
  const id = `liquid-glass-${++seq}`
  const filter = document.createElementNS(SVG_NS, 'filter')
  filter.setAttribute('id', id)
  filter.setAttribute('x', '0')
  filter.setAttribute('y', '0')
  filter.setAttribute('width', '1')
  filter.setAttribute('height', '1')
  // Without this the map's channels are read in linear light, 128 stops
  // meaning "no displacement", and the whole backdrop shifts sideways.
  filter.setAttribute('color-interpolation-filters', 'sRGB')

  const map = document.createElementNS(SVG_NS, 'feImage')
  map.setAttribute('x', '0')
  map.setAttribute('y', '0')
  map.setAttribute('preserveAspectRatio', 'none')
  map.setAttribute('result', 'map')

  const bend = document.createElementNS(SVG_NS, 'feDisplacementMap')
  bend.setAttribute('in', 'SourceGraphic')
  bend.setAttribute('in2', 'map')
  bend.setAttribute('xChannelSelector', 'R')
  bend.setAttribute('yChannelSelector', 'G')

  filter.append(map, bend)
  filterHost().appendChild(filter)

  // Layout size, not getBoundingClientRect: the press swell scales the element,
  // and the map lives in its untransformed coordinates.
  let lastW = 0
  let lastH = 0
  const redraw = () => {
    const w = Math.round(el.offsetWidth)
    const h = Math.round(el.offsetHeight)
    if (!w || !h || (w === lastW && h === lastH)) return
    lastW = w
    lastH = h
    const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0
    const bevel = Math.min(w, h) * BEVEL
    const href = displacementMap(w, h, radius, bevel)
    if (!href) return
    map.setAttribute('href', href)
    map.setAttribute('width', String(w))
    map.setAttribute('height', String(h))
    // feDisplacementMap moves a pixel by scale × (channel − 0.5), so the
    // furthest pull, at a channel of ~0, is half the scale.
    bend.setAttribute('scale', String(2 * PULL * bevel))
  }

  const ro = new ResizeObserver(redraw)
  ro.observe(el)
  redraw()
  el.style.setProperty('--lg-refract', `url(#${id})`)

  return () => {
    ro.disconnect()
    filter.remove()
    el.style.removeProperty('--lg-refract')
  }
}

function attachHighlight(el) {
  const track = (e) => {
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) return
    el.style.setProperty('--lg-x', `${((e.clientX - r.left) / r.width) * 100}%`)
    el.style.setProperty('--lg-y', `${((e.clientY - r.top) / r.height) * 100}%`)
  }
  // Dropping the inline values lets the highlight drift back up to the light
  // source it rests at, rather than sticking wherever the pointer left.
  const release = () => {
    el.style.removeProperty('--lg-x')
    el.style.removeProperty('--lg-y')
  }
  el.addEventListener('pointermove', track, { passive: true })
  // Touch has no hover, so a press is the first the element hears of the
  // finger — which is also where the light should bloom from.
  el.addEventListener('pointerdown', track, { passive: true })
  el.addEventListener('pointerleave', release)
  return () => {
    el.removeEventListener('pointermove', track)
    el.removeEventListener('pointerdown', track)
    el.removeEventListener('pointerleave', release)
    release()
  }
}

export default function useLiquidGlass() {
  return useCallback((el) => {
    if (!el) return undefined
    const cleanups = []
    // A highlight chasing the pointer is motion; under reduced motion it
    // stays put at the light source.
    if (!matches('(prefers-reduced-motion: reduce)')) cleanups.push(attachHighlight(el))
    // Reduced transparency turns the backdrop off entirely in CSS, so there is
    // nothing for a lens to bend.
    if (canRefract() && !matches('(prefers-reduced-transparency: reduce)')) {
      cleanups.push(attachRefraction(el))
    }
    return () => cleanups.forEach((fn) => fn())
  }, [])
}
