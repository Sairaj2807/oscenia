import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { CONTACT } from '../data/site'
import { useI18n } from '../i18n/LanguageContext'
import Icon from './Icon'

// Floating quick-contact button, per the client's note: it stands in for the
// "Start Your Event" buttons removed from mid-page, so someone can reach out
// "right away" without hunting for the form.
//
// A round bead of dark glass with a gold rim and a gold glyph, sitting well up
// the right-hand edge rather than in the corner — that is where the reference
// parks it, high enough that it never lands on the footer links it would
// otherwise duplicate.
//
// It appears once the hero has scrolled past, and never on Contact, where it
// would point at the page you are already on.

// How far the hero must scroll before it appears.
const APPEAR_AFTER = 0.45
// Distance from the document end where the closing CTA takes over.
const END_ZONE_PX = 420

export default function QuickContact() {
  const { t } = useI18n()
  const { pathname } = useLocation()
  const [show, setShow] = useState(false)

  useEffect(() => {
    const update = () => {
      const y = window.scrollY
      const pastHero = y > window.innerHeight * APPEAR_AFTER
      const nearEnd =
        y + window.innerHeight > document.documentElement.scrollHeight - END_ZONE_PX
      setShow(pastHero && !nearEnd)
    }
    update()
    window.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [pathname])

  if (pathname === '/contact') return null

  return (
    <a
      href={CONTACT.whatsapp}
      target="_blank"
      rel="noreferrer"
      aria-label={t.common.chatWithUs}
      aria-hidden={!show}
      tabIndex={show ? 0 : -1}
      className={`fixed bottom-8 right-5 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-black/75 ring-1 ring-white/45 backdrop-blur-sm transition-all duration-500 hover:bg-black hover:ring-gold-light active:scale-95 sm:bottom-[22%] sm:right-10 sm:h-16 sm:w-16 ${
        show ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-4 opacity-0'
      }`}
      style={{ boxShadow: '0 0 34px -6px rgba(224,199,137,0.55)' }}
    >
      <Icon name="whatsapp" className="h-7 w-7 text-gold-light sm:h-8 sm:w-8" />
    </a>
  )
}
