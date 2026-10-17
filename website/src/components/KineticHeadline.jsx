import {
  LINE_LEADING,
  LINE_SHIFT,
  WORD_DURATION_MS,
  WORD_GAP,
  WORD_NUDGE,
  WORD_STAGGER_MS,
  WORD_STYLES,
  WORD_STYLE_FALLBACK,
} from '../data/headline'
import { useIntroReady } from '../introReady'

// The hero sentence, set the way the reference sets it: fragments of different
// sizes and slopes across three lines, arriving one after the other. The
// composition tables live in data/headline.js; this only lays them out.
//
// The words don't start animating on mount: this component renders while the
// intro overlay is still covering the screen (it mounts immediately at page
// load, same as the rest of Home), so a clock started here would run out and
// land on its final frame behind the overlay, minutes before anyone could
// ever see it move. useIntroReady holds the words at their pre-animation
// rest state until the overlay actually clears, so the delays below count
// from the moment a visitor can actually see the hero.
export default function KineticHeadline({ lines, className = '', plain }) {
  const ready = useIntroReady()
  // Where each line starts in the flat word order, so a word can look up its
  // own size and delay without a counter that outlives the render.
  const lineStart = []
  lines.reduce((n, words, row) => {
    lineStart[row] = n
    return n + words.length
  }, 0)

  return (
    <h1 className={`font-serif text-white ${className}`}>
      {/* The sentence, once, for anything that reads rather than looks. */}
      <span className="sr-only">{plain}</span>
      <span aria-hidden="true" className="block">
        {lines.map((words, row) => (
          <span
            key={row}
            className="headline-line flex flex-wrap items-baseline justify-center"
            style={{
              '--line-shift': LINE_SHIFT[row] ?? '0%',
              columnGap: WORD_GAP,
              lineHeight: LINE_LEADING,
            }}
          >
            {words.map((word, col) => {
              const i = lineStart[row] + col
              return (
                <span
                  key={`${row}-${word}`}
                  className={`inline-block whitespace-nowrap ${ready ? 'word-in' : ''} ${
                    WORD_STYLES[i] ?? WORD_STYLE_FALLBACK
                  }`}
                  style={
                    ready
                      ? {
                          animationDelay: `${i * WORD_STAGGER_MS}ms`,
                          animationDuration: `${WORD_DURATION_MS}ms`,
                          transform: `translateY(${WORD_NUDGE[i] ?? 0}em)`,
                        }
                      : {
                          // The animation's own 0% keyframe, held statically:
                          // present but invisible, not yet running.
                          opacity: 0,
                          transform: `translateY(${(WORD_NUDGE[i] ?? 0) + 0.45}em)`,
                        }
                  }
                >
                  {word}
                </span>
              )
            })}
          </span>
        ))}
      </span>
    </h1>
  )
}
