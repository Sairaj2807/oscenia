import { useEffect } from 'react'
import { useI18n } from '../i18n/LanguageContext'
import CTA from './CTA'
import Media from './Media'

// Opened by clicking a portfolio tile — the client's note on the Services grid
// was simply "Minus : Not interactive", with a mockup of what a tile should
// reveal: the event, a short read on what it achieved, the gallery, and a way to
// start a conversation.
//
// A dialog rather than its own route: there are nine of these and no real
// write-ups yet, so committing to shareable URLs would bake in placeholder
// content. Straightforward to promote to /services/:slug once copy lands.
export default function CaseStudy({ project, title, onClose }) {
  const { t } = useI18n()
  const cs = t.services.caseStudy

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  const eventType = t.contact.eventTypes[project.type]

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 overflow-y-auto bg-navy-950/95 backdrop-blur-sm animate-fade-in"
    >
      {/* Clicking the backdrop closes; the panel below stops propagation. */}
      <button
        type="button"
        aria-label={t.common.close}
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default"
      />

      <div className="relative mx-auto max-w-4xl px-6 py-16">
        <div className="mb-6 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="text-[11px] uppercase tracking-[0.25em] text-white/60 transition-colors hover:text-gold-light"
          >
            {t.common.close}
          </button>
        </div>

        <figure className="relative h-[46vh] min-h-[280px] overflow-hidden rounded-lg border border-white/10">
          <Media src={project.img} label={project.client || title} className="absolute inset-0 h-full w-full" />
          <div className="absolute inset-0 bg-gradient-to-t from-navy-950 via-navy-950/30 to-transparent" />
          <figcaption className="absolute inset-x-0 bottom-0 p-8">
            <h2 className="font-serif text-3xl text-white sm:text-5xl">{title}</h2>
          </figcaption>
        </figure>

        <div className="mt-8 flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="text-[11px] uppercase tracking-[0.25em] text-white/45">{cs.eventTypeLabel}</span>
          <span className="rounded-full border border-gold/40 px-4 py-1.5 text-xs tracking-[0.12em] text-gold-light">
            {eventType}
          </span>
        </div>

        <p className="mt-8 max-w-2xl text-lg leading-relaxed text-white/75">{cs.desc}</p>

        <p className="eyebrow mt-14 mb-6">{cs.galleryLabel}</p>
        <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3">
          {project.gallery.map((g, i) => (
            <Media key={i} src={g} label="" className="aspect-[4/3] rounded-md border border-white/10" />
          ))}
        </div>

        <div className="mt-14 text-center">
          <CTA variant="pill" />
        </div>
      </div>
    </div>
  )
}
