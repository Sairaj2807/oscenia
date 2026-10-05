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
// depth. Apple's iOS 26 glass bends hard right at the rim and is perfectly
// clear in the middle, so the bevel is deep and the pull strong, with the
// falloff shaped by the glass profile below rather than a plain curve.
const BEVEL = 0.42
const PULL = 1.05

// Colour dispersion: red is bent this much less, and blue this much more, than
// green, which gives the faint spectral fringe a real lens shows at its edge.
const DISPERSION = 0.07

// The glass's edge profile: a squircle, h(x) = (1 - (1 - x)^4)^(1/4), where x
// runs 0 at the rim to 1 at the inner edge of the bevel. Light bends with the
// surface's slope, so the displacement is the slope, normalised: steep (and
// strongly refracting) at the rim, flattening to nothing where the bevel meets
// the clear centre. Tabulated once.
const PROFILE = (() => {
  const n = 256
  const h = (x) => (1 - (1 - x) ** 4) ** 0.25
  const slopes = []
  for (let i = 0; i <= n; i += 1) {
    const x = Math.min(1, Math.max(1e-3, i / n))
    const e = 1 / n
    slopes.push((h(Math.min(1, x + e)) - h(Math.max(0, x - e))) / (2 * e))
  }
  // The slope runs off to infinity at the very rim; cap it so the edge pixels
  // don't dominate, then scale so the strongest bend is 1.
  const cap = slopes[Math.round(n * 0.04)]
  return slopes.map((v) => Math.min(v, cap) / cap)
})()
const profileAt = (x) => PROFILE[Math.round(Math.min(1, Math.max(0, x)) * (PROFILE.length - 1))]

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
// a thick lens behaves. The strength follows the glass profile above, so the
// bend is sharp at the rim and gone before the middle, which stays clear.
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
      const m = d > 0 && d < bevel ? profileAt(d / bevel) : 0
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

  // Three bends, one per colour channel, each a touch stronger than the last,
  // then recombined: the spectral fringe at the rim.
  const channel = (name, matrix) => {
    const bend = document.createElementNS(SVG_NS, 'feDisplacementMap')
    bend.setAttribute('in', 'SourceGraphic')
    bend.setAttribute('in2', 'map')
    bend.setAttribute('xChannelSelector', 'R')
    bend.setAttribute('yChannelSelector', 'G')
    bend.setAttribute('result', `${name}-bent`)
    const keep = document.createElementNS(SVG_NS, 'feColorMatrix')
    keep.setAttribute('in', `${name}-bent`)
    keep.setAttribute('type', 'matrix')
    keep.setAttribute('values', matrix)
    keep.setAttribute('result', name)
    filter.append(bend, keep)
    return bend
  }
  const add = (a, b, result) => {
    const sum = document.createElementNS(SVG_NS, 'feComposite')
    sum.setAttribute('in', a)
    sum.setAttribute('in2', b)
    sum.setAttribute('operator', 'arithmetic')
    sum.setAttribute('k2', '1')
    sum.setAttribute('k3', '1')
    sum.setAttribute('result', result)
    filter.append(sum)
  }

  filter.append(map)
  const bends = [
    [channel('r', '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0'), 1 - DISPERSION],
    [channel('g', '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0'), 1],
    [channel('b', '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0'), 1 + DISPERSION],
  ]
  add('r', 'g', 'rg')
  add('rg', 'b', 'rgb')
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
    bends.forEach(([bend, k]) => bend.setAttribute('scale', String(2 * PULL * bevel * k)))
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
    // The rim's light comes from the pointer: its direction from the centre,
    // as a conic-gradient angle (0 = top, clockwise).
    const dx = e.clientX - (r.left + r.width / 2)
    const dy = e.clientY - (r.top + r.height / 2)
    el.style.setProperty('--lg-angle', `${(Math.atan2(dx, -dy) * 180) / Math.PI}deg`)
  }
  // Dropping the inline values lets the highlight and the rim light drift back
  // to the light source they rest at, rather than sticking where the pointer
  // left.
  const release = () => {
    el.style.removeProperty('--lg-x')
    el.style.removeProperty('--lg-y')
    el.style.removeProperty('--lg-angle')
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
    } else {
      // No lens here (Safari, Firefox): the CSS frosts the glass a little more
      // instead, so it still reads as a body of glass rather than an outline.
      el.classList.add('liquid-glass--flat')
      cleanups.push(() => el.classList.remove('liquid-glass--flat'))
    }
    return () => cleanups.forEach((fn) => fn())
  }, [])
}
