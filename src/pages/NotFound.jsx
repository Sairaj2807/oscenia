import { Link } from 'react-router-dom'
import { useI18n } from '../i18n/LanguageContext'

export default function NotFound() {
  const { t } = useI18n()
  return (
    <section className="flex min-h-[70vh] flex-col items-center justify-center px-6 text-center">
      <p className="eyebrow mb-4">{t.notFound.code}</p>
      <h1 className="font-serif text-5xl text-gold-light sm:text-6xl">{t.notFound.title}</h1>
      <p className="mt-4 max-w-sm text-white/60">{t.notFound.body}</p>
      <Link to="/" className="btn-pill mt-8">
        {t.notFound.back}
      </Link>
    </section>
  )
}
