// Template ornaments (lib/templates.js `ornament`): small inline SVGs in the accent colour,
// drawn under section titles and around the cover. No image files, so they scale and theme.

const stroke = { stroke: 'var(--inv-accent)', fill: 'none', strokeWidth: 1.2, strokeLinecap: 'round' }

function GoldRule({ className = '' }) {
  return (
    <svg viewBox="0 0 160 12" className={`h-3 w-40 ${className}`} aria-hidden>
      <line x1="0" y1="6" x2="68" y2="6" {...stroke} />
      <path d="M74 6 L80 1 L86 6 L80 11 Z" style={{ fill: 'var(--inv-accent)' }} />
      <line x1="92" y1="6" x2="160" y2="6" {...stroke} />
    </svg>
  )
}

function Floral({ className = '' }) {
  return (
    <svg viewBox="0 0 200 28" className={`h-7 w-48 ${className}`} aria-hidden>
      <path d="M100 14 C88 2, 70 2, 62 12 C56 20, 44 20, 38 12 M100 14 C112 2, 130 2, 138 12 C144 20, 156 20, 162 12" {...stroke} />
      <path d="M38 12 C30 6, 18 8, 10 14 M162 12 C170 6, 182 8, 190 14" {...stroke} />
      <circle cx="100" cy="14" r="3" style={{ fill: 'var(--inv-accent)' }} />
      <circle cx="62" cy="12" r="1.6" style={{ fill: 'var(--inv-accent)' }} />
      <circle cx="138" cy="12" r="1.6" style={{ fill: 'var(--inv-accent)' }} />
    </svg>
  )
}

function Leaf({ className = '' }) {
  return (
    <svg viewBox="0 0 120 28" className={`h-7 w-32 ${className}`} aria-hidden>
      <path d="M10 22 C40 18, 80 18, 110 6" {...stroke} />
      {[28, 50, 72, 92].map((x, i) => (
        <path key={x} d={`M${x} ${19 - i * 2.5} q 6 -10 14 -8 q -4 9 -14 8 Z`} style={{ fill: 'var(--inv-accent)', opacity: 0.55 }} />
      ))}
    </svg>
  )
}

function Line({ className = '' }) {
  return <div className={`h-px w-16 ${className}`} style={{ background: 'var(--inv-accent)' }} aria-hidden />
}

const ORNAMENTS = { 'gold-rule': GoldRule, floral: Floral, leaf: Leaf, grid: Line, none: Line }

export function Ornament({ kind, className = '' }) {
  const C = ORNAMENTS[kind] || Line
  return <C className={className} />
}

/** Corner flourishes for the Royal / Garden covers. */
export function Corners({ kind }) {
  if (kind !== 'floral' && kind !== 'leaf') return null
  const C = kind === 'floral' ? Floral : Leaf
  return (
    <>
      <C className="pointer-events-none absolute left-3 top-4 -rotate-12 opacity-70" />
      <C className="pointer-events-none absolute bottom-4 right-3 rotate-[168deg] opacity-70" />
    </>
  )
}

/** Summit's dotted grid, behind the cover text. */
export const GRID_BG = 'radial-gradient(color-mix(in srgb, var(--inv-accent) 22%, transparent) 1px, transparent 1.2px) 0 0 / 18px 18px'
