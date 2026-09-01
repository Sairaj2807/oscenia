// Renders a real image when `src` is provided, otherwise an elegant labeled
// placeholder so the layout reads as finished before real photography arrives.
// To use a real image, drop the file in /public and pass its path, e.g.
//   <Media src="/portfolio/lamborghini.jpg" label="Lamborghini Car Launch" />
export default function Media({ src, label, className = '', imgClassName = '', children }) {
  // Only add `relative` when the caller hasn't set its own positioning,
  // otherwise a passed `absolute inset-0` (for full-bleed backgrounds) would
  // lose to the base `relative` in Tailwind's cascade.
  const hasPosition = /(?:^|\s)(?:absolute|fixed|relative|sticky)(?:\s|$)/.test(className)
  const base = `${hasPosition ? '' : 'relative'} overflow-hidden bg-navy-800`

  return (
    <div className={`${base} ${className}`}>
      {src ? (
        <img
          src={src}
          alt={label || ''}
          loading="lazy"
          className={`h-full w-full object-cover ${imgClassName}`}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center bg-[linear-gradient(135deg,#0d1b31_0%,#0a1424_60%,#060b16_100%)]">
          {/* subtle diagonal sheen */}
          <div className="pointer-events-none absolute inset-0 opacity-40 bg-[repeating-linear-gradient(135deg,transparent,transparent_22px,rgba(198,161,91,0.04)_22px,rgba(198,161,91,0.04)_23px)]" />
          {label && (
            <span className="relative px-4 text-center font-serif text-base italic text-white/25">
              {label}
            </span>
          )}
        </div>
      )}
      {children}
    </div>
  )
}
