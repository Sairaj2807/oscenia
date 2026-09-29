import { Link, useParams } from 'react-router-dom'
import { EVENT_RADIUS, PORTFOLIO } from '../data/site'
import { useI18n } from '../i18n/LanguageContext'
import useViewTransitionNavigate from '../components/useViewTransitionNavigate'
import Reveal from '../components/Reveal'
import NotFound from './NotFound'
import { LogoBadge } from './Services'

// A project's case page, /services/:slug — the reference recording at
// 3:18-3:30. The tile's photo grows into the hero (a view transition keyed on
// the slug, see useViewTransitionNavigate), with the brand, the event type and
// the logo badge over it; then the write-up, the event's photos running past
// as a strip, and the way back to the grid.
export default function ServiceCase() {
  const { slug } = useParams()
  const { t } = useI18n()
  const go = useViewTransitionNavigate()
  const project = PORTFOLIO.find((p) => p.slug === slug)
  if (!project) return <NotFound />

  const cs = t.services.caseStudy
  const copy = { ...cs, ...t.services.cases[slug] }
  const back = '/services#portfolio'
  // Twice over, so translating the track by half its width loops seamlessly.
  const strip = [...project.gallery, ...project.gallery]

  return (
    <article className="pb-24 pt-24 sm:pt-28">
      <div className="mx-auto max-w-content px-4 sm:px-6">
        <figure
          className="relative h-[62svh] min-h-[320px] overflow-hidden rounded-2xl border border-white/10 bg-navy-800"
          style={{ viewTransitionName: `case-${project.slug}` }}
        >
          <img src={project.img} alt="" className="h-full w-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent" />
          <figcaption className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-4 p-6 sm:p-10">
            <div>
              <h1 className="text-5xl font-medium leading-none text-white sm:text-7xl">{project.client}</h1>
              <p className="mt-2 text-sm text-white/85 sm:text-base">{t.contact.eventTypes[project.type]}</p>
            </div>
            <LogoBadge project={project} className="h-14 w-14 text-xs sm:h-20 sm:w-20 sm:text-sm" />
          </figcaption>
        </figure>
      </div>

      <Reveal className="mx-auto mt-16 max-w-3xl px-6 text-center sm:mt-20">
        <p className="text-sm text-white/80 sm:text-base">{copy.intro}</p>
        <p className="mt-6 text-sm leading-relaxed text-white/60">{copy.body}</p>
      </Reveal>

      {/* Pauses under the pointer so a photo can actually be looked at. With
          reduced motion the track stands still and scrolls sideways instead. */}
      <div
        className="group mt-16 overflow-hidden motion-reduce:overflow-x-auto sm:mt-20"
        role="region"
        aria-label={copy.galleryLabel}
      >
        <ul className="animate-marquee flex w-max gap-4 group-hover:[animation-play-state:paused] sm:gap-5">
          {strip.map((src, i) => (
            <li
              key={i}
              aria-hidden={i >= project.gallery.length}
              className="aspect-[783/498] w-[72vw] shrink-0 overflow-hidden sm:w-[24rem]"
              style={EVENT_RADIUS}
            >
              <img src={src} alt="" loading="lazy" className="h-full w-full object-cover" />
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-14 text-center">
        <Link
          to={back}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
            e.preventDefault()
            go(back)
          }}
          className="btn-gold gap-2 px-7 py-2.5 font-serif text-sm normal-case italic tracking-normal"
        >
          <span aria-hidden="true">«</span> {copy.back}
        </Link>
      </div>
    </article>
  )
}
