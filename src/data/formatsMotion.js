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
// the first two cards. y = 540 is the film's bottom edge; the box runs from half a
// screen above it to 0.34 of a screen below. Median 1.5px off the traced reference.
export const THREAD_ONE = {
  d: 'M 8 35 C 84.5 224.8, 212.3 441, 330 540 C 411.2 628.6, 649.1 677.6, 870 685 C 1103.7 683.1, 1246.1 629.9, 1258 510 C 1260.2 409.3, 1197.8 361, 1100 362 C 993.7 361.3, 853 455.6, 845 540 C 783.2 635.9, 873.7 784.4, 950 863',
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

// From behind the "S" of "Experience Systems", down-left through its own later
// path, along the bottom of a teardrop loop, up round its left end, back along
// the top, out through the crossing and diagonally off the right edge — a little
// above "Client Testimonials". Median 1.4px off the traced reference.
//
// Its start follows the caption rather than the width of the screen: our
// caption sits anywhere from 83% to 98% across depending on the width, so Home
// measures where 70% along the words falls (where the reference's line comes out
// from behind "Systems") and moves the first point, and its handle with it, there.
// y = 40 is the middle of that caption line; Home places the box from it too.
const TWO_TAIL =
  ' 1500.9 174.2, 1430 196 C 1404.5 227.2, 1264.5 268.5, 1190 264 C 1069 259.1, 1078.6 172, 1180 149 C 1256.1 136.7, 1348 157.7, 1430 196 C 1515.3 231.3, 1604.8 284.5, 1920 541'
export const threadTwoPath = (dx = 0) =>
  `M ${(1594 + dx).toFixed(1)} 40 C ${(1545.6 + dx).toFixed(1)} 84.1,${TWO_TAIL}`

export const THREAD_TWO = {
  d: threadTwoPath(0),
  viewBox: '0 0 1920 583.2',
  startX: 1594,
  anchorY: 40,
  startAlong: 0.7,
  // The start can't go further left than this: past the first handle, the
  // opening sweep turns into a straight drop and a hook. It only binds at the
  // widest screens, where our caption sits left of the reference's, and there
  // it still leaves the line coming out from behind the end of "Systems".
  minShift: -40,
  // Starts once that caption has risen to 30% down the screen and finishes as it
  // leaves the top, so the loop is drawn with the cards still in view and the
  // tail runs out as the testimonials arrive.
  from: 0.261,
  to: -0.074,
  pacing: [
    [0, 0],
    [0.296, 0.309],
    [0.636, 0.512],
    [1, 1],
  ],
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
  // One column below 640px: a full-width card thrown from off-screen would cross
  // the whole phone, so it's a shorter, gentler toss that fades as it comes.
  small: { durationMs: 1300, travelVw: 35, riseVh: 6, tilt: 4, captionVw: 10, captionVh: 6 },
}
