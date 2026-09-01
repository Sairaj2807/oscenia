// Typography for the hero sentence — see components/KineticHeadline.jsx.
//
// The reference sets that one sentence as ten fragments across three lines,
// each with its own size, slope and baseline, arriving one after the other. It
// is composed type rather than a heading with a decorative span or two, so the
// composition is a table indexed by position and the words themselves stay in
// the dictionary.
//
// The vw figures are not chosen by eye. Each fragment's rendered width was
// measured off the reference frame at t=24.5 and divided by the width the same
// fragment rendered at here, then the size was scaled by that ratio — which is
// why the sizes are not a tidy ramp: "memorable human" was already right,
// "objectives" was 30% under, the ampersand 38%. Reference widths, in px at a
// 1600-wide viewport: 242 / 58 / 293 / 335 / 119 / 241 / 248 / 48 / 376 / 142.
//
// A translation with a different number of fragments still works: anything past
// the end of a table falls back, and the reveal order is unchanged.
export const WORD_STYLES = [
  'text-[clamp(1.05rem,2.47vw,2.6rem)] italic', // Strategic events
  'text-[clamp(2.1rem,5.94vw,6.2rem)] italic text-gold-light', // &
  'text-[clamp(1.95rem,4.53vw,4.75rem)] italic', // immersive
  'text-[clamp(1.45rem,3.14vw,3.3rem)]', // experiences that
  'text-[clamp(0.9rem,1.8vw,1.9rem)]', // transform
  'text-[clamp(1.85rem,4.27vw,4.5rem)]', // business
  'text-[clamp(1.55rem,4.11vw,4.3rem)] italic', // objectives
  'text-[clamp(0.9rem,1.84vw,1.95rem)]', // into
  'text-[clamp(1.45rem,2.99vw,3.15rem)]', // memorable human
  'text-[clamp(1.1rem,2.39vw,2.5rem)] italic', // moments.
]

export const WORD_STYLE_FALLBACK = 'text-[clamp(1.45rem,2.99vw,3.15rem)]'

// Baseline nudges, in em, measured off the reference. The small words ride up
// against the cap height of the large ones rather than sitting on their line.
export const WORD_NUDGE = [0, 0.02, 0, 0, -0.38, 0.06, -0.08, -0.5, 0.06, 0.04]

// Each line hangs off the block centre by its own amount; they are not a stack
// of centred rows. Measured as line-ink-centre minus block-ink-centre on the
// reference (−4.48%, +3.74%, −0.24% of the viewport), expressed here against
// the 68rem headline box those percentages sit inside.
export const LINE_SHIFT = ['-7.84%', '4.26%', '-1.59%']

// The reference packs the three lines at roughly 0.75 of the largest word on
// each line — tight enough that the ampersand's swash runs past its own line
// box, which is the point.
export const LINE_LEADING = '0.75'

// ~20px between fragments at a 1600-wide viewport, measured off the reference
// (its gaps run 16–34px). It has to scale with the type, so it is vw-based with
// a floor for phones.
export const WORD_GAP = 'clamp(0.35rem,1.3vw,1.6rem)'

export const WORD_STAGGER_MS = 380
export const WORD_DURATION_MS = 1100

// How long the whole headline takes to land — the hero's button waits for it.
export const headlineDurationMs = (lines) =>
  lines.reduce((n, l) => n + l.length, 0) * WORD_STAGGER_MS + WORD_DURATION_MS
