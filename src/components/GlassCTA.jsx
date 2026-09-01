import { Link } from 'react-router-dom'
import { useI18n } from '../i18n/LanguageContext'

// "Start your event" — the home page's single repeated action, at the foot of
// the hero and again over the closing film. Styling lives in .btn-glass.
export default function GlassCTA({ className = '', to = '/contact' }) {
  const { t } = useI18n()
  return (
    <Link to={to} className={`btn-glass ${className}`}>
      {t.common.startEvent}
    </Link>
  )
}
