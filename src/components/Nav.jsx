import { useEffect, useState } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { CONTACT, NAV } from '../data/site'
import { LANGS } from '../i18n/dict'
import { useI18n } from '../i18n/LanguageContext'
import BrandMark from './BrandMark'
import Icon from './Icon'

// Header links, in the order the reference sets them. Contact is not one of
// them: it is the "Let's Talk Further" pill on the right.
const LINKS = NAV.filter((item) => item.to !== '/contact')

// The dictionary carries both "Service" (header) and "Services" (footer),
// because the reference genuinely labels them differently.
const labelKey = (item) => (item.key === 'services' ? 'service' : item.key)

function LangToggle({ className = '' }) {
  const { lang, setLang } = useI18n()
  return (
    <div className={`inline-flex items-center rounded-full bg-black/70 p-1 ${className}`}>
      {LANGS.map((l) => (
        <button
          key={l.code}
          type="button"
          onClick={() => setLang(l.code)}
          aria-pressed={lang === l.code}
          // A squircle rather than a full pill: the reference's active chip is
          // noticeably softer-cornered than the track it sits in.
          className={`rounded-[0.7rem] px-4 py-1.5 font-serif text-[11px] tracking-[0.08em] transition-colors duration-300 ${
            lang === l.code
              ? 'bg-gold-light text-navy-950'
              : 'text-white/55 hover:text-white/90'
          }`}
        >
          {l.short}
        </button>
      ))}
    </div>
  )
}

export default function Nav() {
  const { t } = useI18n()
  const { pathname } = useLocation()
  // The drawer is stored as the route it was opened on rather than a boolean,
  // which is what closes it on navigation: once the path changes it no longer
  // matches, so a back button never leaves it hanging over the new page and no
  // effect is needed to tidy up after the router.
  const [openOn, setOpenOn] = useState(null)
  const open = openOn === pathname

  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : ''
    return () => {
      document.body.style.overflow = ''
    }
  }, [open])

  // Deliberately no scrolled state: the header is transparent over every
  // section of the reference, including the near-black ones, and a bar
  // appearing under it on scroll is the single change that would read as a
  // different site.
  return (
    <header className="pointer-events-none fixed inset-x-0 top-0 z-50">
      <nav className="pointer-events-auto relative flex h-[4.5rem] items-center justify-between px-5 sm:h-[6.5rem] sm:px-8 lg:h-[7rem] lg:px-9">
        <BrandMark className="h-8 sm:h-10 lg:h-11" onClick={() => setOpenOn(null)} />

        {/* Centred on the viewport, not on the space between logo and actions —
            the reference keeps the three links symmetrical about the page. */}
        <div className="absolute left-1/2 hidden -translate-x-1/2 items-center gap-4 lg:flex lg:gap-10 xl:gap-[5.75rem]">
          {LINKS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `rounded-full px-5 py-2 text-[0.95rem] transition-colors duration-300 hover:bg-gold-light hover:text-navy-950 focus:outline-none focus-visible:ring-1 focus-visible:ring-gold-light ${
                  isActive ? 'text-white' : 'text-white/80'
                }`
              }
            >
              {t.nav[labelKey(item)]}
            </NavLink>
          ))}
        </div>

        <div className="flex items-center gap-2 sm:gap-3 lg:gap-7">
          <Link
            to="/contact"
            className="hidden items-center gap-2.5 rounded-full bg-black/70 px-5 py-2.5 font-serif text-[11px] tracking-[0.06em] text-paper/85 transition-colors duration-300 hover:bg-black hover:text-gold-light md:inline-flex"
          >
            {t.common.talkFurther}
            <span aria-hidden="true" className="text-[9px] tracking-[0.2em] text-paper/50">
              •••
            </span>
          </Link>

          <LangToggle />

          <button
            type="button"
            onClick={() => setOpenOn(open ? null : pathname)}
            className="flex h-10 w-10 items-center justify-center rounded-full border border-white/20 bg-black/40 text-white lg:hidden"
            aria-label="Toggle menu"
            aria-expanded={open}
            aria-controls="site-menu"
          >
            <span className="relative block h-3 w-5">
              <span className={`absolute left-0 top-0 h-px w-5 bg-white transition-transform ${open ? 'translate-y-1.5 rotate-45' : ''}`} />
              <span className={`absolute left-0 top-1.5 h-px w-5 bg-white transition-opacity ${open ? 'opacity-0' : ''}`} />
              <span className={`absolute left-0 top-3 h-px w-5 bg-white transition-transform ${open ? '-translate-y-1.5 -rotate-45' : ''}`} />
            </span>
          </button>
        </div>
      </nav>

      {/* Mobile drawer. Full-height and opaque, because it sits over playing
          video — a translucent sheet is unreadable there. */}
      <div
        className={`pointer-events-auto fixed inset-0 top-[4.5rem] bg-navy-950/97 backdrop-blur-lg transition-opacity duration-300 lg:hidden ${
          open ? 'opacity-100' : 'invisible pointer-events-none opacity-0'
        }`}
        id="site-menu"
      >
        <div className="flex flex-col px-6 pt-6">
          {LINKS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              onClick={() => setOpenOn(null)}
              className={({ isActive }) =>
                `border-b border-white/5 py-5 font-serif text-2xl ${isActive ? 'text-gold-light' : 'text-white/80'}`
              }
            >
              {t.nav[labelKey(item)]}
            </NavLink>
          ))}

          <Link to="/contact" onClick={() => setOpenOn(null)} className="btn-gold mt-8 py-3.5">
            {t.nav.contact}
          </Link>
          <a
            href={CONTACT.whatsapp}
            target="_blank"
            rel="noreferrer"
            onClick={() => setOpenOn(null)}
            className="btn-pill mt-3 gap-2.5 px-6 py-3.5 tracking-[0.18em]"
          >
            <Icon name="whatsapp" className="h-5 w-5" />
            {t.common.chatWithUs}
          </a>
        </div>
      </div>
    </header>
  )
}
