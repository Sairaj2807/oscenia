import { useState } from 'react'
import {
  EXPLORE_MORE_MIN_PROJECTS,
  EXPLORE_MORE_TO,
  FEATURED_GALLERY,
  PORTFOLIO,
} from '../data/site'
import { useI18n } from '../i18n/LanguageContext'
import CaseStudy from '../components/CaseStudy'
import Media from '../components/Media'
import Reveal from '../components/Reveal'
import CTA from '../components/CTA'
import Icon from '../components/Icon'

export default function Services() {
  return (
    <>
      <Header />
      <Gallery />
      <Featured />
    </>
  )
}

function Header() {
  const { t } = useI18n()
  return (
    <section className="mx-auto max-w-content px-6 pb-8 pt-40">
      <Reveal>
        <p className="eyebrow mb-4">{t.services.eyebrow}</p>
        <h1 className="max-w-3xl font-serif text-5xl text-gold-light sm:text-6xl">{t.services.heading}</h1>
      </Reveal>
    </section>
  )
}

function Gallery() {
  const { t } = useI18n()
  const [openIndex, setOpenIndex] = useState(null)

  // Hidden until there are genuinely more projects than the grid shows and a
  // real destination exists — it used to point at Contact Us, which the client
  // flagged.
  const showExploreMore = EXPLORE_MORE_TO && PORTFOLIO.length >= EXPLORE_MORE_MIN_PROJECTS

  return (
    <section className="mx-auto max-w-content px-6 pb-8">
      <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3">
        {PORTFOLIO.map((p, i) => {
          const title = t.services.portfolio[i]
          return (
            <Reveal key={title} delay={(i % 3) * 80}>
              {/* Desaturated until hover, when it colourises and the title
                  arrives beneath — the interaction pattern from sg.gpj.com.
                  Client mark sits bottom-right on the image, as there.
                  A touch device has no hover, so every `group-hover:` state is
                  mirrored under `[@media(hover:none)]:` — otherwise these tiles
                  would sit grey and untitled forever on a phone. */}
              <button
                type="button"
                onClick={() => setOpenIndex(i)}
                className="group block w-full text-left focus:outline-none"
              >
                <figure className="relative aspect-[4/3] overflow-hidden rounded-md border border-white/10 transition-colors duration-500 group-hover:border-gold/40 group-focus-visible:border-gold [@media(hover:none)]:border-gold/30">
                  <Media
                    src={p.img}
                    label={p.client || title}
                    className="absolute inset-0 h-full w-full grayscale transition-all duration-700 ease-out group-hover:scale-[1.04] group-hover:grayscale-0 group-focus-visible:grayscale-0 [@media(hover:none)]:grayscale-0"
                  />
                  {/* Lifts on hover so the colour reads at full strength. */}
                  <div className="absolute inset-0 bg-navy-950/45 transition-opacity duration-700 group-hover:opacity-0 [@media(hover:none)]:opacity-0" />

                  <div className="absolute bottom-4 right-4">
                    {p.logo ? (
                      <img
                        src={p.logo}
                        alt={p.client}
                        // Shadowed because the imagery is bright — a white mark
                        // would otherwise disappear once the veil lifts.
                        className="h-6 w-auto opacity-85 transition-opacity duration-500 group-hover:opacity-100 sm:h-7 [@media(hover:none)]:opacity-100 [filter:drop-shadow(0_1px_4px_rgba(0,0,0,0.65))]"
                      />
                    ) : (
                      <span className="font-display text-[10px] tracking-[0.22em] text-white/75 drop-shadow transition-colors duration-500 group-hover:text-white sm:text-[11px] [@media(hover:none)]:text-white">
                        {p.client}
                      </span>
                    )}
                  </div>
                </figure>

                {/* Space is reserved so revealing the title doesn't reflow the
                    grid. Taller on mobile, where the title always shows and
                    wraps to more lines in a narrower column. */}
                <div className="mt-3 min-h-[4.5rem] sm:mt-4 sm:min-h-[3.5rem]">
                  <h3 className="translate-y-1 font-serif text-base leading-snug text-white opacity-0 transition-all duration-500 ease-out group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100 sm:text-lg [@media(hover:none)]:translate-y-0 [@media(hover:none)]:opacity-100">
                    {title}
                  </h3>
                  <p className="mt-1 translate-y-1 text-[10px] uppercase tracking-[0.18em] text-gold-light/80 opacity-0 transition-all delay-75 duration-500 ease-out group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100 [@media(hover:none)]:translate-y-0 [@media(hover:none)]:opacity-100">
                    {t.contact.eventTypes[p.type]}
                  </p>
                </div>
              </button>
            </Reveal>
          )
        })}
      </div>

      {showExploreMore && (
        <div className="mt-10 flex justify-end">
          <CTA variant="solid" to={EXPLORE_MORE_TO}>
            {t.common.exploreMore} <Icon name="arrow" className="ml-2 h-4 w-4" />
          </CTA>
        </div>
      )}

      {openIndex !== null && (
        <CaseStudy
          project={PORTFOLIO[openIndex]}
          title={t.services.portfolio[openIndex]}
          onClose={() => setOpenIndex(null)}
        />
      )}
    </section>
  )
}

function Featured() {
  const { t } = useI18n()
  const f = t.services.featured
  return (
    <section className="mx-auto max-w-content px-6 py-20">
      <Reveal>
        <figure className="relative h-[60vh] min-h-[420px] overflow-hidden rounded-lg border border-white/10">
          <Media src="" label="" className="absolute inset-0 h-full w-full" />
          <div className="absolute inset-0 bg-gradient-to-t from-navy-950 via-navy-950/30 to-transparent" />
          <figcaption className="absolute inset-x-0 bottom-0 p-8 sm:p-12">
            <h2 className="font-serif text-4xl text-white sm:text-6xl">{f.title}</h2>
          </figcaption>
        </figure>
      </Reveal>

      <Reveal delay={100}>
        <p className="mx-auto mt-10 max-w-2xl text-center font-serif text-lg italic leading-relaxed text-white/70">
          {f.desc}
        </p>
      </Reveal>

      <div className="mt-12 grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3">
        {FEATURED_GALLERY.map((g, i) => (
          <Reveal key={i} delay={(i % 3) * 80}>
            <Media src={g} label="" className="aspect-[4/3] rounded-md border border-white/10" />
          </Reveal>
        ))}
      </div>

      <div className="mt-14 text-center">
        <CTA variant="pill" />
      </div>
    </section>
  )
}
