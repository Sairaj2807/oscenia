import { Link } from 'react-router-dom'
import { CONTACT, NAV, FOLLOW } from '../data/site'
import { useI18n } from '../i18n/LanguageContext'
import BrandMark from './BrandMark'

const seeMore = NAV.filter((n) => n.to !== '/contact')

// `overlay` is the home page's footer: it sits on the closing film rather than
// on a panel of its own, so it drops the background and the rule and leans on
// the gradient the film already carries. Every other route gets the panel.
export default function Footer({ overlay = false }) {
  const { t } = useI18n()
  return (
    <footer className={overlay ? 'relative' : 'border-t border-white/5 bg-navy-950'}>
      <div
        className={`mx-auto max-w-[100rem] px-6 sm:px-10 lg:px-14 ${
          overlay ? 'pb-12 pt-3 sm:pb-16' : 'py-16'
        }`}
      >
        <div className="grid gap-10 md:grid-cols-[1.2fr_1fr_1.05fr_1.25fr]">
          <BrandMark className="h-7 self-start sm:h-9" />

          <FooterCol title={t.footer.seeMore}>
            {seeMore.map((l) => (
              <li key={l.key}>
                <Link to={l.to} className="text-white/85 transition-colors hover:text-gold-light">
                  {t.nav[l.key]}
                </Link>
              </li>
            ))}
          </FooterCol>

          <FooterCol title={t.footer.followAlong}>
            {FOLLOW.map((l) => (
              <li key={l.label}>
                <a
                  href={l.href}
                  target="_blank"
                  rel="noreferrer"
                  className="text-white/85 transition-colors hover:text-gold-light"
                >
                  {l.label}
                </a>
              </li>
            ))}
          </FooterCol>

          <FooterCol title={t.footer.contactUs}>
            <li className="text-white/85">
              {t.footer.whatsapp} {CONTACT.phone}
            </li>
            <li>
              <a
                href={`mailto:${CONTACT.email}`}
                className="text-white/85 transition-colors hover:text-gold-light"
              >
                {t.footer.email} {CONTACT.email}
              </a>
            </li>
          </FooterCol>
        </div>

        <div
          className={`mt-12 flex flex-col items-center justify-between gap-3 pt-6 text-xs text-white/40 sm:flex-row ${
            overlay ? 'border-t border-white/10' : 'border-t border-white/5'
          }`}
        >
          <span>{t.footer.copyright}</span>
          <span className="tracking-[0.15em]">{CONTACT.locations}</span>
        </div>
      </div>
    </footer>
  )
}

function FooterCol({ title, children }) {
  return (
    <div>
      <h3 className="mb-2 font-serif text-[clamp(1.1rem,1.7vw,1.75rem)] text-gold-light">{title}</h3>
      <ul className="space-y-1 font-serif text-[clamp(1rem,1.35vw,1.4rem)]">{children}</ul>
    </div>
  )
}
