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

// The hero sentence, set the way the reference sets it: fragments of different
// sizes and slopes across three lines, arriving one after the other. The
// composition tables live in data/headline.js; this only lays them out.
export default function KineticHeadline({ lines, className = '', plain }) {
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
                  className={`word-in inline-block whitespace-nowrap ${
                    WORD_STYLES[i] ?? WORD_STYLE_FALLBACK
                  }`}
                  style={{
                    animationDelay: `${i * WORD_STAGGER_MS}ms`,
                    animationDuration: `${WORD_DURATION_MS}ms`,
                    transform: `translateY(${WORD_NUDGE[i] ?? 0}em)`,
                  }}
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
