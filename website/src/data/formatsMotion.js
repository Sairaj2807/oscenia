// Motion for the "What we direct" section, measured off "Video Project 2.mp4" in
// the repo root — a screen recording of the reference build at 1920×1080. None
// of it is chosen by eye: the paths are least-squares Bézier fits to the traced
// hairline, and the timings are fitted to frame-by-frame measurements of the
// cards. See animation.md §5 and §13 for how each number was taken.

// ---- The hairline --------------------------------------------------------------
//
// Both threads are drawn in 1920-wide coordinates and stretched to the viewport
// (preserveAspectRatio="none"), so x follows the width and y the height. That is
// what keeps the first thread's end in the gutter between the first two cards
// at every width from 640 up: it lands 49.5% across, and our grid's gutter always
// straddles the centre.
//
// `from`/`to` are where the thread's box has its top edge, as a fraction of the
// viewport height, when drawing starts and when it's finished. `pacing` maps that
// scroll progress to the fraction of the line drawn, as [progress, drawn] pairs
// read off the recording (±5%), joined by a monotone curve.

// Out of the champagne film at the far left, a near-straight diagonal through
// "What we direct", a wide shallow U in the gap, a vertical right arm back into
// the film, a loop over the top, and down through "end." into the gutter between
// the first two cards, where the link (below) carries it on. y = 540 is the
// film's bottom edge; the box runs from half a screen above it to 0.34 of a
// screen below. Median 1.5px off the traced reference.
export const THREAD_ONE = {
  // Every join is G1: at each on-curve point the two handles are collinear
  // (turned onto the bisector of the fitted headings, lengths kept), so the
  // line never kinks where one segment hands over to the next. The fit had
  // left a 27° corner where the loop's descent crosses the film's edge.
  d: 'M 8 35 C 84.5 224.8, 219 433.6, 330 540 C 416.8 623.2, 649 682.2, 870 685 C 1103.7 688, 1250.7 630.3, 1258 510 C 1264.1 409.5, 1197.8 361.8, 1100 362 C 993.7 362.2, 872.8 459.9, 845 540 C 807.7 647.8, 873.7 784.4, 950 863',
  viewBox: '0 0 1920 907.2',
  // Drawing starts as the film's bottom edge reaches 97.6% of the screen and is
  // done by 16.3% — 0.81 of a screen of scrolling.
  from: 0.476,
  to: -0.337,
  // Front-loaded: the diagonal, the U and the right arm (63% of the line) write
  // themselves in the first 27% of that scroll; the loop and the descent onto the
  // cards take the rest, which is what lets the ending be read rather than
  // flicked past.
  pacing: [
    [0, 0],
    [0.27, 0.634],
    [0.43, 0.731],
    [0.756, 0.859],
    [1, 1],
  ],
}
// Thread one's end and the direction it leaves in, in its own box's units.
const ONE_END = [950, 863]
const ONE_EXIT = [950 - 873.7, 863 - 784.4]

// From behind "Systems" in "Experience Systems", one convex sweep down-left
// into the belly of a teardrop loop, round its left end, back along the top,
// out through the crossing and diagonally off the right edge — a little above
// "Client Testimonials". Fitted to "VID-20260830-WA0000.mp4" in the repo root:
// 18 frames registered by scroll into one trace, then a G1-smooth cubic chain
// fitted to it (median 2.3px off, most of that the recording's own blur). The
// sweep and the loop's lower arc are one continuous curve — no knee where they
// meet.
//
// Its start follows the caption rather than the width of the screen: our
// caption sits anywhere from 83% to 98% across depending on the width, so Home
// measures where 70% along the words falls (where the reference's line comes out
// from behind "Systems") and moves the first point, and its handle with it, there.
// y = 40 is the middle of that caption line; Home places the box from it too.
// The first handle points straight down, so however tall our caption's line is,
// nothing of the start shows beside the words.
const TWO_TAIL =
  ' 1533 140.1, 1437.9 203.9 C 1330.8 275.7, 1202.5 273.1, 1174.9 271.4 C 1113.1 267.6, 1059.7 210.7, 1151.2 167.6 C 1231.4 129.8, 1366.6 173.2, 1428.8 201.7 C 1544.1 254.5, 1560 267.8, 1920 541'
export const threadTwoPath = (dx = 0) =>
  `M ${(1565 + dx).toFixed(1)} 40 C ${(1565 + dx).toFixed(1)} 100.6,${TWO_TAIL}`

export const THREAD_TWO = {
  d: threadTwoPath(0),
  viewBox: '0 0 1920 583.2',
  startX: 1565,
  anchorY: 40,
  startAlong: 0.7,
  // The start can't go further left than this: past the first handle, the
  // opening sweep turns into a straight drop and a hook. It only binds at the
  // widest screens, where our caption sits left of the reference's, and there
  // it still leaves the line coming out from behind the end of "Systems".
  minShift: -40,
  // Measured frame by frame against the caption's position: the pen sets off
  // as the caption's box top rises through 28.7% of the screen, writes the
  // sweep and most of the loop at a steady pace, slows over the top of the loop
  // as the caption reaches the top edge, then whips the tail off the right
  // edge in the last tenth — done as the caption leaves the screen.
  from: 0.287,
  to: -0.07,
  pacing: [
    [0, 0],
    [0.35, 0.345],
    [0.504, 0.434],
    [0.681, 0.517],
    [0.784, 0.59],
    [0.891, 0.795],
    [1, 1],
  ],
}

// ---- The link -------------------------------------------------------------------
//
// Thread one and thread two are one thread in the reference: the line that
// runs down through "end." never stops. It carries straight on along its own
// 45° diagonal in under the "Brand Experiences" photo, comes out from under
// that photo's bottom edge, crosses behind "Experiences" and on across the gap
// between the rows (visible at 1:02.7–1:02.9 in "VID-20260830-WA0000.mp4":
// x≈1380 at the photo's edge, same heading as thread one's exit), then goes in
// under the "Experience Systems" photo, where it bends round to come out below
// it heading straight down — which is where thread two picks up.
//
// So the link is a straight run on thread one's heading, then one cubic under
// the second photo that turns it onto thread two's heading. Both joins are
// tangent-continuous. It's built at runtime because the photos move with the
// layout; its geometry is in isotropic units (1920 across the screen, the same
// per px down) so the headings carry over exactly.
//
// Timing, as measured: the pen is behind the scroll under the first photo, so
// it only comes out below "Brand Experiences" once that caption has risen to
// ~11% down the screen; it writes the diagonal across the gap as the caption
// leaves the top, then finishes the hidden bend quickly, arriving at thread
// two's start on the frame thread two begins. It starts on the frame thread
// one finishes, so the pen never lifts.
//
// Inputs are px relative to the grid box, except `twoX` (1920-wide units):
// `emergeY` is the bottom of the first photo's caption, `photoTop` and
// `photoHeight` locate the "Experience Systems" photo, `twoTop` is thread two's
// box top.
const EMERGE_AT = 0.11

export function buildLink({ vw, vh, emergeY, photoTop, photoHeight, twoX, twoTop }) {
  const k = 1920 / vw
  const y1 = -0.5 * vh + ONE_END[1] * (vh / 1080)
  const y2 = twoTop + THREAD_TWO.anchorY * (vh / 1080)
  const height = y2 - y1
  const H = height * k
  const qPx = photoTop + photoHeight * 0.2
  if (!(emergeY > y1) || !(photoTop > emergeY) || !(y2 - qPx > 20)) return null

  // Thread one's exit heading, through its box's anisotropic stretch.
  const ex = ONE_EXIT[0]
  const ey = ONE_EXIT[1] * (vh / 1080) * k
  const along = (yPx) => [ONE_END[0] + ((yPx - y1) * k * ex) / ey, (yPx - y1) * k]

  const p1 = [ONE_END[0], 0]
  const q = along(qPx)
  const p3 = [twoX, H]
  // The bend under the photo: leaves q on the diagonal, arrives straight down.
  const reach = Math.hypot(p3[0] - q[0], p3[1] - q[1]) * 0.45
  const en = Math.hypot(ex, ey)
  const b1 = [q[0] + (ex / en) * reach, q[1] + (ey / en) * reach]
  const b2 = [p3[0], H - (H - q[1]) * 0.5]

  const f = (n) => n.toFixed(1)
  const d =
    `M ${f(p1[0])} 0 L ${f(q[0])} ${f(q[1])} ` +
    `C ${f(b1[0])} ${f(b1[1])}, ${f(b2[0])} ${f(b2[1])}, ${f(p3[0])} ${f(p3[1])}`

  // Length: the straight run, then the bend sampled.
  const run = Math.hypot(q[0] - p1[0], q[1])
  let bend = 0
  let prev = q
  for (let i = 1; i <= 80; i++) {
    const t = i / 80
    const u = 1 - t
    const pt = [
      u * u * u * q[0] + 3 * u * u * t * b1[0] + 3 * u * t * t * b2[0] + t * t * t * p3[0],
      u * u * u * q[1] + 3 * u * u * t * b1[1] + 3 * u * t * t * b2[1] + t * t * t * p3[1],
    ]
    bend += Math.hypot(pt[0] - prev[0], pt[1] - prev[1])
    prev = pt
  }
  const L = run + bend
  const drawnAt = (yPx) => Math.hypot(...along(yPx).map((v, i) => v - p1[i])) / L

  // Thread one finishes when the grid's top is at (to + 0.5)·vh; thread two
  // starts when it's at from·vh − twoTop. Expressed as this box's top.
  const from = THREAD_ONE.to + 0.5 + y1 / vh
  const to = THREAD_TWO.from + (y1 - twoTop) / vh
  // Progress at which a point y px down the grid sits s of the way down the
  // screen.
  const at = (yPx, sv) => (from * vh - (sv * vh - yPx + y1)) / ((from - to) * vh)
  const pE = at(emergeY, EMERGE_AT)
  const pG = at(emergeY, 0)
  if (!(pE > 0.02 && pG > pE && pG < 0.98)) return null
  const pacing = [
    [0, 0],
    [pE, drawnAt(emergeY)],
    [pG, drawnAt(qPx)],
    [1, 1],
  ]

  return { d, viewBox: `0 0 1920 ${f(H)}`, top: y1, height, from, to, pacing }
}

// ---- The card toss -------------------------------------------------------------
//
// The cards are thrown onto the table: each photo starts just off its own side
// of the screen and above its slot, tilted, and lands flat. It's a timed
// entrance triggered as the slot arrives, not a scroll scrub — the recording
// scrolls row 2 3.2× faster than row 1, and both flights take about as long.
export const TOSS = {
  // Set by sampling the live flight in Chrome and matching it against the
  // left card's measured position over time: 2270ms lands within 0.6% of the
  // recording's track (1800ms, the eyeballed "until it looks settled" figure,
  // was 11% off — the brake at the end takes longer than it looks).
  durationMs: 2270,
  // Constant speed, then a hard brake in the last ~10%. Fitted to the left
  // card's measured position (rms 0.005 of the travel).
  moveEase: 'cubic-bezier(0.92, 1, 0.7, 1)',
  // The tilt unwinds early and is flat by ~80% of the flight, with no overshoot.
  // Fitted to the measured angle (rms 0.038).
  tiltEase: 'cubic-bezier(0.18, 0, 0, 0.92)',
  // Degrees at the screen edge; positive is clockwise. The left card leans into
  // the room at 13°, the right one back the other way at 8°.
  tilt: { left: 13, right: -8 },
  // How far above its slot the photo starts, as a fraction of the viewport height.
  rise: 0.28,
  // The caption is its own layer: it comes in from the same side on a lower
  // line, dimmed, reaches its column first, then rises into place under the photo.
  captionSlide: { delayMs: 290, durationMs: 1350, ease: 'cubic-bezier(0, 0.44, 0, 1)', offsetVw: 24 },
  captionRise: {
    delayMs: 330,
    durationMs: 1370,
    ease: 'cubic-bezier(1, 0.47, 0.77, 1)',
    offsetVh: 21,
    fromOpacity: 0.4,
  },
  // Px the slot has to be inside the viewport before its toss starts. The right
  // card also sits 28px lower (sm:mt-7), so it leaves about 70px of scrolling
  // after the left one: a stagger by position, which is what the recording
  // shows (1.1s at its slow scroll, 0.25s at its fast one).
  enterInset: { left: 20, right: 60 },
  // Scrolling back up throws the card back out: the same flight played in
  // reverse. It starts once the slot's top drops below this fraction of the
  // screen height, while the card is still mostly in view (waiting for the
  // bottom line above would play it off screen, unseen). Scrolling down past
  // it again throws the card back in.
  exitLine: 0.6,
  // One column below 640px: a full-width card thrown from off-screen would cross
  // the whole phone, so it's a shorter, gentler toss that fades as it comes.
  small: { durationMs: 1300, travelVw: 35, riseVh: 6, tilt: 4, captionVw: 10, captionVh: 6 },
}
