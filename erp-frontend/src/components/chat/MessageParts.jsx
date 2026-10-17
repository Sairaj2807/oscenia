// How a stored chat message renders: mentions as chips (highlighted when they are you), task
// tokens as inline references plus a card under the message that opens the task drawer.
import { Lock } from 'lucide-react'
import { useProto, selectPersona } from '../../store/chatProto'
import { canSeeTask, isOverdue } from '../../lib/workspaceAccess'
import { parseTokens } from '../../lib/chat'
import { Badge, appToday } from '../ui'
import { Avatar, shortDate, ProjectTag } from '../workspace/parts'
import { useT } from '../../i18n'

export function MessageText({ text, onOpenTask }) {
  const members = useProto((s) => s.members)
  const personaId = useProto((s) => s.personaId)
  return (
    <span className="whitespace-pre-wrap break-words">
      {parseTokens(text).map((part, i) => {
        if (part.type === 'text') return <span key={i}>{part.value}</span>
        if (part.type === 'mention') {
          const m = members.find((x) => x.id === part.value)
          const me = part.value === personaId
          return (
            <span key={i} className={`rounded px-1 font-medium ${me ? 'bg-gold/25 text-gold-light' : 'bg-sky-500/15 text-sky-200'}`}>
              @{m?.name || part.value}
            </span>
          )
        }
        return (
          <button key={i} onClick={() => onOpenTask(part.value)} className="rounded px-1 font-mono text-[12px] bg-white/10 text-white/80 hover:bg-gold/20">
            #{part.value}
          </button>
        )
      })}
    </span>
  )
}

/** A task link, rendered as a card. Access is checked against the persona reading it. */
export function TaskLinkCard({ taskId, onOpenTask }) {
  const t = useT()
  const task = useProto((s) => s.tasks.find((x) => x.id === taskId))
  const persona = useProto(selectPersona)
  const projectDivisions = useProto((s) => s.projectDivisions)
  const assignee = useProto((s) => s.members.find((m) => m.id === task?.assigneeId))

  if (!task) return null
  if (!canSeeTask(persona, task, projectDivisions)) {
    return (
      <div className="mt-2 inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-xs text-white/40">
        <Lock size={13} /> {task.id} — {t('you do not have access to this task')}
      </div>
    )
  }
  const overdue = isOverdue(task, appToday())
  return (
    <button
      onClick={() => onOpenTask(task.id)}
      className="mt-2 block w-full max-w-md rounded-lg border-l-2 border-gold/60 bg-white/[0.04] px-3 py-2.5 text-left hover:bg-white/[0.07] transition-colors"
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] text-white/35">{task.id}</span>
        <ProjectTag projectId={task.projectId} />
      </div>
      <div className="mt-0.5 text-sm text-white/90">{task.title}</div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-white/50">
        <Badge>{task.status}</Badge>
        <span className="inline-flex items-center gap-1"><Avatar member={assignee} size="sm" /> {assignee?.name}</span>
        <span className={overdue ? 'text-rose-300' : ''}>{t('due')} {shortDate(task.deadline)}</span>
      </div>
    </button>
  )
}
