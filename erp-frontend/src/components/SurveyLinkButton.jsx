// "Copy client survey link": signed in, for someone who manages the workspace, on a project a client can
// rate. The link is made by the server (it expires, and a new one revokes every copy already sent).
import { useState } from 'react'
import { Link2 } from 'lucide-react'
import { useStore } from '../store/useStore'
import { canDo } from '../lib/roles'
import { surveyUrl, canSendSurvey, daysLeft, surveyLinkApi } from '../lib/surveyLink'

export default function SurveyLinkButton({ project, className = '' }) {
  const live = useStore((s) => s.hydrated)
  const role = useStore((s) => s.role)
  const pushToast = useStore((s) => s.pushToast)
  const [busy, setBusy] = useState(false)
  if (!live || !project?.uuid || !canDo(role, 'manage_workspace') || !canSendSurvey(project)) return null

  const copy = async (fresh) => {
    if (fresh && !window.confirm('Make a new link? Every link already sent to the client stops working.')) return
    setBusy(true)
    try {
      const link = await (fresh ? surveyLinkApi.regenerate(project.uuid) : surveyLinkApi.get(project.uuid))
      const url = surveyUrl(window.location.origin, link.projectNo, link.token)
      try {
        await navigator.clipboard.writeText(url)
        pushToast({ title: fresh ? 'New survey link copied' : 'Survey link copied', body: `${project.name} · works for ${daysLeft(link.expiresAt)} more days`, kind: 'project' })
      } catch {
        // No clipboard (an insecure page): show it so it can still be copied by hand.
        window.prompt('Copy this link and send it to the client:', url)
      }
    } catch (err) {
      pushToast({ title: 'Could not make the survey link', body: err?.message || 'Try again.', kind: 'redflag' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <button
        type="button"
        disabled={busy}
        onClick={() => copy(false)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs text-white/70 hover:text-white disabled:opacity-50"
      >
        <Link2 size={12} />Copy client survey link
      </button>
      <button type="button" disabled={busy} onClick={() => copy(true)} className="text-[11px] text-white/40 hover:text-white/80 disabled:opacity-50" aria-label="Make a new survey link">
        New link
      </button>
    </span>
  )
}
