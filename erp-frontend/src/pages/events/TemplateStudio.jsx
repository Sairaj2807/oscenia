// Invitation templates (client round 3): the Template Studio page under Events & Invitations.
// Routes are not role-guarded in this app (only the sidebar hides items), so the page itself
// says when the login may not design templates — and the store refuses too.
import { Link } from 'react-router-dom'
import { ArrowLeft, Lock } from 'lucide-react'
import { PageHeader } from '../../components/ui'
import TemplateStudio from '../../components/invite/TemplateStudio'
import { useStore } from '../../store/useStore'
import { canDo, denialReason } from '../../lib/roles'
import { useT } from '../../i18n'

export default function TemplateStudioPage() {
  const t = useT()
  const role = useStore((s) => s.role)
  const back = <Link to="/events" className="btn-ghost"><ArrowLeft size={15} />{t('Events')}</Link>
  return (
    <div>
      <PageHeader
        eyebrow="Guest Experience"
        title="Invitation templates"
        subtitle="Template Studio: the design team's own invitation designs, added to the gallery staff and clients choose from."
        actions={back}
      />
      {canDo(role, 'manage_templates') ? <TemplateStudio role={role} /> : (
        <div className="card mx-auto max-w-lg p-8 text-center">
          <Lock size={22} className="mx-auto text-white/40" />
          <div className="mt-3 text-white">{t('Not permitted')}</div>
          <p className="mt-1 text-sm text-white/50">{t(denialReason(role, 'manage_templates'))}</p>
          <p className="mt-3 text-xs text-white/35">{t('Studio templates that are in the gallery can still be picked on any event’s invitation.')}</p>
        </div>
      )}
    </div>
  )
}
