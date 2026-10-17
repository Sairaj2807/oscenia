import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useT } from '../i18n'

// Shared modal shell. Extracted from the hand-rolled overlay that lived inside
// Quotations' NewQuoteModal — the journal entry form, journal drill-down,
// check-in condition dialog and add-stock form all need the same frame.
export default function Modal({ title, subtitle, onClose, children, footer, size = 'lg' }) {
  const t = useT()

  // Escape closes. Cheap, and expected of anything modal.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const width = {
    sm: 'max-w-md',
    lg: 'max-w-lg',
    xl: 'max-w-2xl',
    '2xl': 'max-w-4xl',
  }[size] || 'max-w-lg'

  const modal = (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className={`relative z-10 w-full ${width} card p-0 animate-pop max-h-[90vh] flex flex-col`}>
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-white/10 shrink-0">
          <div>
            <div className="eyebrow">{t(title)}</div>
            {subtitle && <div className="text-xs text-white/45 mt-1">{subtitle}</div>}
          </div>
          <button onClick={onClose} className="text-white/50 hover:text-white shrink-0" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-3 overflow-y-auto">{children}</div>

        {footer && (
          <div className="flex flex-wrap justify-end gap-2 px-5 py-4 border-t border-white/10 shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  )

  // Rendered into <body>, not in place. A parent with a transform, filter or backdrop blur —
  // a page's fade-in animation, a .card — turns `position: fixed` into "fixed to that parent",
  // so the overlay covered only the parent and could open off-screen on a scrolled page.
  // (A server render has no document; it renders in place.)
  return typeof document === 'undefined' ? modal : createPortal(modal, document.body)
}
