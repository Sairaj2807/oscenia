// The task drawer: everything about one task, and the actions the current persona may take.
// Opened by `?task=T-101` in the URL, so a link pasted in chat opens the same drawer.
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { X, Link2, Play, Ban, Send, CheckCircle2, Undo2, ShieldAlert, Lock, Paperclip } from 'lucide-react'
import { useProto, selectPersona, useWorkspaceProjects } from '../../store/chatProto'
import { useStore } from '../../store/useStore'
import { canSeeTask, approvalStage, canSubmit, canWorkOn, isOverdue, WORKSPACE_ROLES } from '../../lib/workspaceAccess'
import { Badge, appToday } from '../ui'
import { Avatar, useMember, useOpenTask, shortDate, stamp, deadlineWords } from './parts'
import AttachmentList from '../AttachmentList'
import { useT } from '../../i18n'

export function taskUrl(task) {
  return `${window.location.origin}${import.meta.env.BASE_URL}workspace/${task.projectId}?task=${task.id}`
}

export default function TaskDrawer() {
  const { openTaskId, closeTask } = useOpenTask()
  const task = useProto((s) => s.tasks.find((t) => t.id === openTaskId))
  const persona = useProto(selectPersona)
  const projectDivisions = useProto((s) => s.projectDivisions)

  // Escape closes, as it does for the ERP's modals.
  useEffect(() => {
    if (!openTaskId) return undefined
    const onKey = (e) => { if (e.key === 'Escape') closeTask() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openTaskId, closeTask])

  if (!openTaskId) return null

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={closeTask} />
      <aside className="relative z-10 h-full w-full max-w-lg overflow-y-auto border-l border-white/10 bg-navy-900 shadow-2xl animate-fade-up">
        {!task ? (
          <Denied onClose={closeTask} title="Task not found" body={`There is no task ${openTaskId}.`} />
        ) : !canSeeTask(persona, task, projectDivisions) ? (
          <Denied
            onClose={closeTask}
            title="No access to this task"
            body={`${persona.name} (${WORKSPACE_ROLES[persona.workspaceRole]}) cannot open ${task.id}. Interns see only their own tasks; staff see their projects; leaders see their division.`}
          />
        ) : (
          // Keyed by task: opening another task (e.g. from a chat link) must not carry over a
          // half-typed block reason or reject comment.
          <TaskBody key={task.id} task={task} persona={persona} onClose={closeTask} />
        )}
      </aside>
    </div>
  )
}

function Denied({ title, body, onClose }) {
  const t = useT()
  return (
    <div className="p-6">
      <div className="flex justify-end">
        <button onClick={onClose} className="text-white/50 hover:text-white" aria-label="Close"><X size={18} /></button>
      </div>
      <div className="mt-10 text-center">
        <Lock className="mx-auto text-gold/70" size={28} />
        <div className="mt-3 font-display text-lg text-white">{t(title)}</div>
        <p className="mt-2 text-sm text-white/50">{body}</p>
      </div>
    </div>
  )
}

function TaskBody({ task, persona, onClose }) {
  const t = useT()
  const project = useWorkspaceProjects().find((p) => p.id === task.projectId)
  const members = useProto((s) => s.members)
  const live = useProto((s) => s.live)
  // Actions never change, so read them without subscribing to the whole store.
  const actions = useProto.getState()
  const pushToast = useStore((s) => s.pushToast)
  const assignee = useMember(task.assigneeId)
  const assigner = useMember(task.assignedById)
  const [mode, setMode] = useState(null) // 'block' | 'reject'
  const [text, setText] = useState('')

  const stage = approvalStage(persona, task, members)
  const mine = canWorkOn(persona, task)
  const overdue = isOverdue(task, appToday())
  const byId = (id) => members.find((m) => m.id === id)

  // Live actions answer later (the server decides) and say why themselves when they refuse; the
  // demo's answer at once and the drawer says "Not allowed".
  const run = async (result, title) => {
    const ok = await result
    if (ok) pushToast({ title, body: `${task.id} · ${task.title}`, kind: 'project' })
    else if (!live) pushToast({ title: 'Not allowed', body: 'This persona cannot do that on this task.', kind: 'redflag' })
    setMode(null)
    setText('')
  }

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(taskUrl(task))
      pushToast({ title: 'Task link copied', body: 'Paste it in chat or send it to a teammate.', kind: 'project' })
    } catch {
      pushToast({ title: 'Copy failed', body: taskUrl(task), kind: 'redflag' })
    }
  }

  return (
    <div className="p-5 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-white/40">{task.id}</span>
            <Badge>{task.status}</Badge>
            {overdue && <Badge>Overdue</Badge>}
          </div>
          <h2 className="mt-2 font-display text-xl text-white leading-snug">{task.title}</h2>
          <Link to={`/workspace/${task.projectId}`} className="text-xs text-gold/80 hover:text-gold-light">
            {project?.name || task.projectId} · {t(task.division)}
          </Link>
        </div>
        <button onClick={onClose} className="text-white/50 hover:text-white shrink-0" aria-label="Close"><X size={18} /></button>
      </div>

      {task.description && <p className="mt-4 text-sm text-white/65 leading-relaxed">{task.description}</p>}

      {task.status === 'Blocked' && (
        <div className="mt-4 flex gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">
          <ShieldAlert size={16} className="shrink-0 mt-0.5" />
          <div><span className="font-medium">{t('Blocked')}: </span>{task.blockerReason}</div>
        </div>
      )}

      <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        <Fact label="PIC / assignee"><Person m={assignee} /></Fact>
        <Fact label="Assigned by"><Person m={assigner} /></Fact>
        <Fact label="Assigned on">{stamp(task.assignedAt)}</Fact>
        <Fact label="Deadline">
          <span className={overdue ? 'text-rose-300' : ''}>
            {shortDate(task.deadline)}{!task.completedAt && <span className="text-white/40"> · {deadlineWords(task.deadline)}</span>}
          </span>
        </Fact>
        <Fact label="Priority">{t(task.priority)}</Fact>
        <Fact label="Completed">{task.completedAt ? stamp(task.completedAt) : '—'}</Fact>
      </dl>

      {/* Two-stage approval, as decided with the client: Division Leader, then PM. */}
      <div className="mt-5 rounded-lg border border-white/10 p-3">
        <div className="text-[11px] uppercase tracking-wider text-white/35 mb-2">{t('Approval')}</div>
        <ApprovalStep n={1} label="Division Leader" stampData={task.approvals.leader} person={byId(task.approvals.leader?.by)} />
        <ApprovalStep n={2} label="Project Manager" stampData={task.approvals.pm} person={byId(task.approvals.pm?.by)} />
      </div>

      {/* Actions for this persona */}
      <div className="mt-5 flex flex-wrap gap-2">
        {mine && task.status === 'To do' && (
          <button className="btn-gold" onClick={() => run(actions.startTask(task.id), 'Task started')}><Play size={15} />{t('Start')}</button>
        )}
        {canSubmit(persona, task) && task.status === 'In progress' && (
          <button className="btn-gold" onClick={() => run(actions.submitTask(task.id), 'Submitted for approval')}><Send size={15} />{t('Submit for approval')}</button>
        )}
        {mine && ['To do', 'In progress'].includes(task.status) && (
          <button className="btn-ghost" onClick={() => setMode('block')}><Ban size={15} />{t('Mark blocked')}</button>
        )}
        {mine && task.status === 'Blocked' && (
          <button className="btn-gold" onClick={() => run(actions.unblockTask(task.id), 'Task unblocked')}><Undo2 size={15} />{t('Unblock')}</button>
        )}
        {stage && (
          <>
            <button className="btn-gold" onClick={() => run(actions.approveTask(task.id), stage === 'leader' ? 'Approved — sent to PM' : 'Approved — task done')}>
              <CheckCircle2 size={15} />{t(stage === 'leader' ? 'Approve (stage 1)' : 'Final approve (stage 2)')}
            </button>
            <button className="btn-ghost" onClick={() => setMode('reject')}><Undo2 size={15} />{t('Reject')}</button>
          </>
        )}
        <button className="btn-ghost" onClick={copyLink}><Link2 size={15} />{t('Copy task link')}</button>
      </div>

      {mine && !canSubmit(persona, task) && task.status === 'In progress' && (
        <p className="mt-3 text-xs text-white/35">
          {t('Only the assignee can submit this task for approval.')}
        </p>
      )}

      {!mine && !stage && task.status !== 'PM approved' && (
        <p className="mt-3 text-xs text-white/35">
          {t('Only the assignee, the person who assigned it, or the PM can move this task. Approvals go to the Division Leader, then the PM.')}
        </p>
      )}

      {mode && (
        <div className="mt-4 rounded-lg border border-white/10 bg-white/[0.02] p-3">
          <div className="text-xs text-white/60 mb-2">
            {mode === 'block' ? t('Why is it blocked? The reason shows on the Blocked board.') : t('Why is it rejected? The assignee sees this.')}
          </div>
          <textarea
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            className="w-full rounded-lg border border-white/10 bg-navy-950 p-2.5 text-sm text-white/85 outline-none focus:border-gold/50"
          />
          <div className="mt-2 flex justify-end gap-2">
            <button className="btn-ghost" onClick={() => { setMode(null); setText('') }}>{t('Cancel')}</button>
            <button
              className="btn-gold"
              disabled={!text.trim()}
              onClick={() => mode === 'block'
                ? run(actions.blockTask(task.id, text), 'Marked blocked')
                : run(actions.rejectTask(task.id, text), 'Sent back to the assignee')}
            >
              {t(mode === 'block' ? 'Mark blocked' : 'Reject')}
            </button>
          </div>
        </div>
      )}

      <Attachments task={task} persona={persona} />

      <div className="mt-6">
        <div className="text-[11px] uppercase tracking-wider text-white/35 mb-3">{t('Activity')}</div>
        <ol className="space-y-3 border-l border-white/10 pl-4">
          {[...task.activity].reverse().map((a, i) => (
            <li key={i} className="relative text-sm">
              <span className={`absolute -left-[21px] top-1.5 h-2 w-2 rounded-full ${DOT[a.kind] || 'bg-white/30'}`} />
              <span className="text-white/85">{byId(a.by)?.name || a.by}</span>{' '}
              <span className="text-white/55">{a.text}</span>
              <div className="text-[11px] text-white/30">{stamp(a.at)}</div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}

const DOT = {
  attach: 'bg-violet-400',
  assign: 'bg-gold',
  status: 'bg-sky-400',
  block: 'bg-rose-400',
  reject: 'bg-rose-400',
  approve: 'bg-emerald-400',
}

/** Files on a task (W2) — the shared list (components/AttachmentList.jsx); closed once done. */
function Attachments({ task, persona }) {
  const t = useT()
  const list = task.attachments || []
  const open = task.status !== 'PM approved'
  return (
    <div className="mt-6">
      <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-wider text-white/35">
        <Paperclip size={12} />{t('Attachments')}{list.length > 0 && ` · ${list.length}`}
      </div>
      <AttachmentList list={list} canAdd={open}
        onAdd={(file) => useProto.getState().addAttachment(task.id, file)}
        onOpen={(a) => useProto.getState().openAttachment?.(task.id, a)}
        mayRemove={(a) => open && (a.by === persona.id || persona.workspaceRole === 'pm')}
        onRemove={(a) => useProto.getState().removeAttachment(task.id, a.id)} />
    </div>
  )
}

function Fact({ label, children }) {
  const t = useT()
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wider text-white/35">{t(label)}</dt>
      <dd className="mt-1 text-white/85">{children}</dd>
    </div>
  )
}

function Person({ m }) {
  if (!m) return '—'
  return (
    <span className="inline-flex items-center gap-2">
      <Avatar member={m} size="sm" />
      <span>{m.name}</span>
    </span>
  )
}

function ApprovalStep({ n, label, stampData, person }) {
  const t = useT()
  return (
    <div className="flex items-center gap-2 py-1 text-sm">
      <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] ${stampData ? 'bg-emerald-500/20 text-emerald-300' : 'bg-white/10 text-white/40'}`}>
        {stampData ? '✓' : n}
      </span>
      <span className="text-white/70">{t(label)}</span>
      <span className="ml-auto text-xs text-white/40">
        {stampData ? `${person?.name || stampData.by} · ${stamp(stampData.at)}` : t('Pending')}
      </span>
    </div>
  )
}
