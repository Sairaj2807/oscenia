import { useState } from 'react'
import { CONTACT, SOCIALS } from '../data/site'
import { useI18n } from '../i18n/LanguageContext'
import Reveal from '../components/Reveal'
import Icon from '../components/Icon'

export default function Contact() {
  return (
    <>
      <Inquiry />
      <Office />
    </>
  )
}

function Inquiry() {
  const { t } = useI18n()
  const c = t.contact
  const [sent, setSent] = useState(false)

  const handleSubmit = (e) => {
    e.preventDefault()
    // No backend yet — hands off to email. Wire to an API/form service later.
    const data = new FormData(e.currentTarget)
    const f = c.mailFields
    const body = [
      `${f.name}: ${data.get('name') || ''}`,
      `${f.company}: ${data.get('company') || ''}`,
      `${f.phone}: ${data.get('phone') || ''}`,
      `${f.eventType}: ${data.get('eventType') || ''}`,
      `${f.guests}: ${data.get('guests') || ''}`,
      `${f.date}: ${data.get('date') || ''}`,
      '',
      `${data.get('details') || ''}`,
    ].join('\n')
    window.location.href = `mailto:${CONTACT.email}?subject=${encodeURIComponent(c.mailSubject)}&body=${encodeURIComponent(body)}`
    setSent(true)
  }

  return (
    <section className="mx-auto max-w-content px-6 pb-16 pt-40">
      <Reveal>
        <h1 className="font-serif text-5xl text-gold-light sm:text-7xl">{c.heading}</h1>
      </Reveal>

      <div className="mt-14 grid gap-14 md:grid-cols-[1fr_1.4fr]">
        <Reveal>
          <p className="max-w-sm leading-relaxed text-white/70">{c.intro}</p>
          <div className="mt-10 flex gap-4">
            {SOCIALS.map((s) => (
              <a
                key={s.name}
                href={s.href}
                target="_blank"
                rel="noreferrer"
                aria-label={s.name}
                className="flex h-12 w-12 items-center justify-center rounded-full border border-white/15 text-white/80 transition-all hover:border-gold hover:text-gold-light"
              >
                <Icon name={s.icon} />
              </a>
            ))}
          </div>
          <div className="mt-10 space-y-2 text-sm text-white/60">
            <p>
              {t.footer.whatsapp} {CONTACT.phone}
            </p>
            <p>
              <a href={`mailto:${CONTACT.email}`} className="hover:text-gold-light">
                {CONTACT.email}
              </a>
            </p>
          </div>
        </Reveal>

        <Reveal delay={120}>
          <form onSubmit={handleSubmit} className="space-y-8">
            <div className="grid gap-8 sm:grid-cols-2">
              <Field name="name" label={c.labels.name} />
              <Field name="company" label={c.labels.company} />
            </div>

            {/* The one thing the client wanted added to this page. */}
            <div className="grid gap-8 sm:grid-cols-2">
              <Field name="phone" label={c.labels.phone} type="tel" />
            </div>

            <div>
              <Label>{c.labels.eventType}</Label>
              <select
                name="eventType"
                defaultValue=""
                className="w-full rounded-md border border-white/15 bg-navy-800/60 px-4 py-3 text-white outline-none transition-colors focus:border-gold"
              >
                <option value="" disabled>
                  {c.labels.selectPlaceholder}
                </option>
                {c.eventTypes.map((tp) => (
                  <option key={tp} value={tp} className="bg-navy-800">
                    {tp}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid gap-8 sm:grid-cols-2">
              <Field name="guests" label={c.labels.guests} type="number" />
              <Field name="date" label={c.labels.date} type="date" />
            </div>

            <div>
              <Label>{c.labels.more}</Label>
              <textarea
                name="details"
                rows={4}
                className="w-full resize-none border-b border-white/20 bg-transparent py-2 text-white outline-none transition-colors focus:border-gold"
              />
            </div>

            <button type="submit" className="btn-solid">
              {sent ? t.common.sendingInquiry : t.common.sendInquiry}
            </button>
          </form>
        </Reveal>
      </div>
    </section>
  )
}

function Label({ children }) {
  return <label className="mb-2 block text-xs uppercase tracking-[0.18em] text-white/60">{children}</label>
}

function Field({ name, label, type = 'text' }) {
  return (
    <div>
      <Label>{label}</Label>
      <input
        type={type}
        name={name}
        className="w-full border-b border-white/20 bg-transparent py-2 text-white outline-none transition-colors focus:border-gold"
      />
    </div>
  )
}

// The client asked for the map itself here, with the location beneath it,
// rather than a bare "Location" button that jumps out to Google Maps.
function Office() {
  const { t } = useI18n()
  return (
    <section className="mx-auto max-w-content px-6 py-24">
      <div className="border-t border-white/10 pt-16">
        <Reveal>
          <h2 className="font-serif text-5xl text-gold-light sm:text-6xl">{t.contact.office.heading}</h2>
        </Reveal>

        <Reveal delay={80}>
          <div className="mt-10 overflow-hidden rounded-lg border border-white/10">
            <iframe
              src={CONTACT.mapEmbedUrl}
              title={t.contact.office.heading}
              className="block h-[380px] w-full border-0 grayscale-[0.35] invert-[0.92] hue-rotate-180"
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
              allowFullScreen
            />
          </div>
        </Reveal>

        <Reveal delay={140}>
          <div className="mt-8 flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="eyebrow mb-3">{t.common.location}</p>
              <p className="max-w-md text-lg leading-relaxed text-white/75">{CONTACT.address}</p>
            </div>
            <a
              href={CONTACT.mapUrl}
              target="_blank"
              rel="noreferrer"
              className="btn-solid shrink-0 whitespace-nowrap"
            >
              {t.common.location}
            </a>
          </div>
        </Reveal>
      </div>
    </section>
  )
}
