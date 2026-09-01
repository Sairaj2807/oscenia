import { Link } from 'react-router-dom'
import { useI18n } from '../i18n/LanguageContext'

// "Start your event" as a plain pill, used by the inner pages. The home page's
// glass version is components/GlassCTA.jsx.
export default function CTA({ variant = 'pill', className = '', to = '/contact' }) {
  const { t } = useI18n()
  return (
    <Link to={to} className={`${variant === 'solid' ? 'btn-solid' : 'btn-pill'} ${className}`}>
      {t.common.startEvent}
    </Link>
  )
}
