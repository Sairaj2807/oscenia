// Small pieces shared by the workspace screens (and, later, chat): avatars, the persona
// switcher, a task row, and date formatting for "YYYY-MM-DDTHH:mm" stamps.
import { useSearchParams } from 'react-router-dom'
import { Eye, Paperclip } from 'lucide-react'
import { useProto, selectPersona, useWorkspaceProjects } from '../../store/chatProto'
import { useStore } from '../../store/useStore'
import { WORKSPACE_ROLES, isOverdue } from '../../lib/workspaceAccess'
import { Badge, appToday, daysUntil } from '../ui'
import { useT } from '../../i18n'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "2026-07-24" → "24 Jul" */
export function shortDate(iso) {
  if (!iso) return '—'
  return `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`
}

/** "2026-07-24T16:20" → "24 Jul, 16:20" */
export function stamp(at) {
  if (!at) return '—'
  return `${shortDate(at.slice(0, 10))}, ${at.slice(11, 16)}`
}

/** "in 3 days" / "today" / "2 days overdue", relative to the demo day. */
export function deadlineWords(deadline) {
  const d = daysUntil(deadline)
  if (d === 0) return 'due today'
  if (d > 0) return `in ${d} day${d === 1 ? '' : 's'}`
  return `${-d} day${d === -1 ? '' : 's'} overdue`
}

const DIVISION_TONE = {
  Field: 'bg-emerald-500/20 text-emerald-200',
  Design: 'bg-violet-500/20 text-violet-200',
  Production: 'bg-sky-500/20 text-sky-200',
  Management: 'bg-gold/25 text-gold-light',
}

export function initials(name = '') {
  return name.split(/[\s.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase()
}

export function Avatar({ member, size = 'md' }) {
  if (!member) return null
  const dims = size === 'sm' ? 'h-6 w-6 text-[9px]' : size === 'lg' ? 'h-10 w-10 text-xs' : 'h-8 w-8 text-[10px]'
  return (
    <span
      title={`${member.name} · ${WORKSPACE_ROLES[member.workspaceRole]}`}
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold ${dims} ${DIVISION_TONE[member.division] || 'bg-white/10 text-white/70'}`}
    >
      {initials(member.name)}
    </span>
  )
}

export function useMember(id) {
  return useProto((s) => s.members.find((m) => m.id === id))
}

/**
 * "Viewing as" — the demo's way to show each role's access without signing in as each
 * person. Grouped by role so the client can walk PM → Leader → Staff → Intern.
 */
export function PersonaSwitcher() {
  const t = useT()
  const members = useProto((s) => s.members)
  const persona = useProto(selectPersona)
  const setPersona = useProto((s) => s.setPersona)
  const live = useProto((s) => s.live)
  // Signed in you are who you signed in as; "viewing as" is the demo's.
  if (live) {
    return <div className="truncate text-xs text-white/45">{t('Signed in as')} <span className="text-white/75">{persona?.name}</span></div>
  }
  return (
    // Shrinks to the screen on phones: the label hides behind the eye icon and the dropdown
    // truncates, instead of pushing the page wider than the phone.
    <label className="flex w-full min-w-0 items-center gap-2 rounded-lg border border-gold/30 bg-gold/5 pl-3 pr-1 py-1 text-sm sm:w-auto">
      <Eye size={15} className="text-gold/80 shrink-0" />
      <span className="hidden text-white/50 whitespace-nowrap sm:inline">{t('Viewing as')}</span>
      <select
        value={persona.id}
        onChange={(e) => setPersona(e.target.value)}
        aria-label={t('Viewing as')}
        className="min-w-0 flex-1 truncate rounded-md bg-navy-900 border border-white/10 px-2 py-1 text-white/90 outline-none focus:border-gold/50 sm:flex-none"
      >
        {Object.entries(WORKSPACE_ROLES).map(([role, label]) => (
          <optgroup key={role} label={t(label)}>
            {members.filter((m) => m.workspaceRole === role).map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} — {m.workspaceRole === 'pm' ? t(label) : `${t(m.division)} ${t(label)}`}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  )
}

/** Opens the task drawer by putting `?task=` in the URL, so a task link can be shared. */
export function useOpenTask() {
  const [params, setParams] = useSearchParams()
  return {
    openTaskId: params.get('task'),
    openTask: (id) => {
      const next = new URLSearchParams(params)
      next.set('task', id)
      setParams(next)
    },
    closeTask: () => {
      const next = new URLSearchParams(params)
      next.delete('task')
      setParams(next)
    },
  }
}

export function ProjectTag({ projectId }) {
  const project = useWorkspaceProjects().find((p) => p.id === projectId)
  return <span className="text-[11px] text-white/40 truncate">{project?.name || projectId}</span>
}

/** One task on a list: status, title, project, assignee, deadline. Click opens the drawer. */
export function TaskRow({ task, onOpen, showProject = true, note }) {
  const t = useT()
  const assignee = useMember(task.assigneeId)
  const overdue = isOverdue(task, appToday())
  return (
    <button
      onClick={() => onOpen(task.id)}
      className="w-full flex items-center gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2.5 text-left hover:border-gold/30 hover:bg-white/[0.04] transition-colors"
    >
      <Avatar member={assignee} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] text-white/30">{task.id}</span>
          <span className="truncate text-sm text-white/85">{task.title}</span>
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          {showProject && <ProjectTag projectId={task.projectId} />}
          {note && <span className="text-[11px] text-white/45 truncate">{note}</span>}
          {task.attachments?.length > 0 && (
            <span className="inline-flex shrink-0 items-center gap-0.5 text-[11px] text-white/45" title={t('Attachments')}>
              <Paperclip size={11} />{task.attachments.length}
            </span>
          )}
        </div>
      </div>
      <div className="hidden sm:flex flex-col items-end gap-1 shrink-0">
        <Badge>{task.status}</Badge>
        <span className={`text-[11px] ${overdue ? 'text-rose-300' : 'text-white/40'}`}>
          {task.completedAt
            ? `${t('Done')} ${shortDate(task.completedAt.slice(0, 10))}`
            : `${shortDate(task.deadline)} · ${deadlineWords(task.deadline)}`}
        </span>
      </div>
    </button>
  )
}
