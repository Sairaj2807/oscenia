// One project's tasks: a board by status (or a list), filtered by division, assignee and
// status, limited to what the persona may see.
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Plus, LayoutGrid, List, Lock, CalendarDays, MessagesSquare, Paperclip } from 'lucide-react'
import { Card, FilterPill, Select, Badge, appToday } from '../../components/ui'
import { PersonaSwitcher, TaskRow, Avatar, useOpenTask, shortDate, deadlineWords } from '../../components/workspace/parts'
import TaskDrawer from '../../components/workspace/TaskDrawer'
import NewTaskModal from '../../components/workspace/NewTaskModal'
import { useProto, selectPersona, useWorkspaceProjects } from '../../store/chatProto'
import { useProto as useChatProto } from '../../store/chatProto'
import { ChatGate } from '../../components/chat/LiveParts'
import {
  memberProjectIds, visibleTasks, canAssign, isOverdue, homeChannel, TASK_STATUSES, WORKSPACE_ROLES,
} from '../../lib/workspaceAccess'
import { useT } from '../../i18n'

/** Signed in, the workspace has to load (who you are, your projects, your tasks) before there is
 *  anything to show; until then, or when it cannot, a plain page stands in. */
export default function WorkspaceProject() {
  const live = useProto((s) => s.live)
  const status = useProto((s) => s.chatStatus)
  const error = useProto((s) => s.chatError)
  const tasksStatus = useProto((s) => s.tasksStatus)
  if (live && status !== 'ready') return <ChatGate status={status} error={error} area="Workspace" />
  if (live && (tasksStatus === 'idle' || tasksStatus === 'loading')) return <ChatGate status="loading" area="Workspace" />
  return <WorkspaceProjectScreen />
}

function WorkspaceProjectScreen() {
  const t = useT()
  const { projectId } = useParams()
  const project = useWorkspaceProjects().find((p) => p.id === projectId)
  const persona = useProto(selectPersona)
  const tasks = useProto((s) => s.tasks)
  const members = useProto((s) => s.members)
  const projectDivisions = useProto((s) => s.projectDivisions)
  // The project's main chat channel. Live, chat channels carry the project's business number
  // (`projectNo`), which is what this page's `id` is; the id string keeps the selection stable.
  const generalChannel = useChatProto((s) => (s.live
    ? homeChannel(s.channels.filter((c) => c.projectNo === projectId).map((c) => ({ ...c, projectId })), projectId)?.id
    : homeChannel(s.channels, projectId)?.id))
  const { openTask } = useOpenTask()

  const [view, setView] = useState('board')
  const [division, setDivision] = useState('all')
  const [assignee, setAssignee] = useState('all')
  const [status, setStatus] = useState('all')
  const [creating, setCreating] = useState(false)

  if (!project) {
    return <Card><div className="text-white/60">{t('Project not found.')} <Link to="/workspace" className="text-gold">{t('Back to workspace')}</Link></div></Card>
  }

  const divisions = projectDivisions[projectId] || []
  const onProject = memberProjectIds(persona, projectDivisions).includes(projectId)
  const mayAssign = canAssign(persona, projectId, members, projectDivisions)

  const all = visibleTasks(persona, tasks, projectDivisions).filter((x) => x.projectId === projectId)
  const shown = all.filter((x) =>
    (division === 'all' || x.division === division) &&
    (assignee === 'all' || x.assigneeId === assignee) &&
    (status === 'all' || x.status === status)
  )
  const people = members.filter((m) => all.some((x) => x.assigneeId === m.id))

  return (
    <div>
      <Link to="/workspace" className="inline-flex items-center gap-1 text-xs text-white/50 hover:text-gold-light mb-3">
        <ArrowLeft size={14} /> {t('Workspace')}
      </Link>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between mb-5">
        <div>
          <div className="eyebrow mb-2">{project.id}</div>
          <h1 className="font-display text-2xl sm:text-3xl text-white">{project.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-white/50">
            <span>{project.client}</span>
            <span className="inline-flex items-center gap-1"><CalendarDays size={13} /> {shortDate(project.eventDate)}</span>
            <span>{t('PIC')}: <span className="text-white/80">{project.pm}</span></span>
            <span>{divisions.map((d) => t(d)).join(' · ')}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <PersonaSwitcher />
          {generalChannel && (
            <Link to={`/chat/${generalChannel}`} className="btn-ghost"><MessagesSquare size={15} />{t('Project chat')}</Link>
          )}
          {mayAssign && (
            <button className="btn-gold" onClick={() => setCreating(true)}><Plus size={15} />{t('New task')}</button>
          )}
        </div>
      </div>

      {!onProject ? (
        <Card className="text-center py-12">
          <Lock className="mx-auto text-gold/70" size={28} />
          <div className="mt-3 font-display text-lg text-white">{t('Not on this project')}</div>
          <p className="mt-2 text-sm text-white/50">
            {persona.name} ({t(WORKSPACE_ROLES[persona.workspaceRole])}) {t('is not a member of this project, so its tasks are hidden.')}
          </p>
        </Card>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <FilterPill active={division === 'all'} onClick={() => setDivision('all')}>{t('All divisions')}</FilterPill>
            {divisions.map((d) => <FilterPill key={d} active={division === d} onClick={() => setDivision(d)}>{t(d)}</FilterPill>)}
            <div className="flex gap-2 ml-auto">
              <Select value={assignee} onChange={(e) => setAssignee(e.target.value)} className="!w-auto !py-1.5">
                <option value="all">{t('Everyone')}</option>
                {people.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </Select>
              <Select value={status} onChange={(e) => setStatus(e.target.value)} className="!w-auto !py-1.5">
                <option value="all">{t('Any status')}</option>
                {TASK_STATUSES.map((s) => <option key={s} value={s}>{t(s)}</option>)}
              </Select>
              <div className="flex rounded-lg border border-white/10 p-0.5">
                <button onClick={() => setView('board')} className={`rounded-md p-1.5 ${view === 'board' ? 'bg-gold/20 text-gold-light' : 'text-white/50'}`} aria-label={t('Board')}><LayoutGrid size={15} /></button>
                <button onClick={() => setView('list')} className={`rounded-md p-1.5 ${view === 'list' ? 'bg-gold/20 text-gold-light' : 'text-white/50'}`} aria-label={t('List')}><List size={15} /></button>
              </div>
            </div>
          </div>

          {persona.workspaceRole === 'intern' && (
            <p className="mb-3 text-xs text-white/40">{t('Interns see only the tasks assigned to them.')}</p>
          )}

          {view === 'board' ? (
            <div className="flex gap-3 overflow-x-auto pb-3">
              {TASK_STATUSES.filter((s) => status === 'all' || s === status).map((s) => {
                const col = shown.filter((x) => x.status === s)
                return (
                  <div key={s} className="w-64 shrink-0 rounded-xl border border-white/5 bg-white/[0.02] p-2">
                    <div className="flex items-center justify-between px-1 pb-2">
                      <Badge>{s}</Badge>
                      <span className="text-xs text-white/35 tabular-nums">{col.length}</span>
                    </div>
                    <div className="space-y-2">
                      {col.map((x) => <BoardCard key={x.id} task={x} onOpen={openTask} />)}
                      {col.length === 0 && <div className="px-1 py-4 text-center text-[11px] text-white/25">—</div>}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="space-y-2">
              {[...shown].sort((a, b) => a.deadline.localeCompare(b.deadline)).map((x) => <TaskRow key={x.id} task={x} onOpen={openTask} showProject={false} />)}
              {shown.length === 0 && <div className="text-sm text-white/40">{t('No tasks match these filters.')}</div>}
            </div>
          )}
        </>
      )}

      {creating && <NewTaskModal projectId={projectId} onClose={() => setCreating(false)} onCreated={openTask} />}
      <TaskDrawer />
    </div>
  )
}

function BoardCard({ task, onOpen }) {
  const t = useT()
  const assignee = useProto((s) => s.members.find((m) => m.id === task.assigneeId))
  const overdue = isOverdue(task, appToday())
  return (
    <button onClick={() => onOpen(task.id)} className="w-full text-left rounded-lg border border-white/10 bg-navy-900/80 p-3 hover:border-gold/40 transition-colors">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] text-white/30">{task.id}</span>
        <span className="flex items-center gap-2">
          {task.attachments?.length > 0 && (
            <span className="inline-flex items-center gap-0.5 text-[10px] text-white/45" title={t('Attachments')}><Paperclip size={10} />{task.attachments.length}</span>
          )}
          <span className={`text-[10px] ${task.priority === 'High' ? 'text-rose-300' : 'text-white/35'}`}>{t(task.priority)}</span>
        </span>
      </div>
      <div className="mt-1 text-sm text-white/85 leading-snug">{task.title}</div>
      {task.status === 'Blocked' && <div className="mt-1.5 text-[11px] text-rose-200/80 line-clamp-2">{task.blockerReason}</div>}
      <div className="mt-2 flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5 text-[11px] text-white/50"><Avatar member={assignee} size="sm" />{assignee?.name}</span>
        <span className={`text-[11px] ${overdue ? 'text-rose-300' : 'text-white/35'}`}>
          {task.completedAt ? `✓ ${shortDate(task.completedAt.slice(0, 10))}` : shortDate(task.deadline)}
        </span>
      </div>
      {overdue && <div className="mt-1 text-[10px] text-rose-300/80">{deadlineWords(task.deadline)}</div>}
    </button>
  )
}
