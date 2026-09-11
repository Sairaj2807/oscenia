import { Link } from 'react-router-dom'
import { useI18n } from '../i18n/LanguageContext'
import useLiquidGlass from './useLiquidGlass'

// "Start your event" — the home page's single repeated action, at the foot of
// the hero and again over the closing film. The material is .liquid-glass, the
// shape and type are .btn-glass, and the hook adds the pointer highlight and
// the lensing.
export default function GlassCTA({ className = '', to = '/contact' }) {
  const { t } = useI18n()
  const glass = useLiquidGlass()
  return (
    <Link ref={glass} to={to} className={`liquid-glass btn-glass ${className}`}>
      {t.common.startEvent}
    </Link>
  )
}
