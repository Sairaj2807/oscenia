import { useEffect } from 'react'

/**
 * Closes a popover when the pointer goes down anywhere outside `ref`, or on Escape.
 *
 * Replaces the "invisible full-screen backdrop" pattern, which fails inside the top bar: the
 * bar's `backdrop-blur` makes it the containing block for `position: fixed` children, so the
 * "full-screen" backdrop only covered the 64px bar and clicks on the page went straight
 * through, leaving the panel open.
 */
export function useDismiss(ref, open, onClose) {
  useEffect(() => {
    if (!open) return undefined
    const onPointer = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose() }
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [ref, open, onClose])
}
