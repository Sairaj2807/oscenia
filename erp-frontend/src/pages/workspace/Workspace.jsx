// Project workspace — one place to see, across every project, who the PIC is, what is
// pending, what is blocked and why (BRD §2). What each tab shows depends on the persona
// being viewed as: PM, Division Leader, Staff or Intern.
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { CalendarDays, AlertTriangle, Clock, CheckCircle2, Users, RotateCcw } from 'lucide-react'
import { PageHeader, Card, Tabs, Badge, SectionTitle, DEMO_TODAY, todayFor, daysUntil } from '../../components/ui'
import { PersonaSwitcher, TaskRow, Avatar, useOpenTask, shortDate, stamp } from '../../components/workspace/parts'
import TaskDrawer from '../../components/workspace/TaskDrawer'
import { useProto, selectPersona, useWorkspaceProjects } from '../../store/chatProto'
import { ChatGate } from '../../components/chat/LiveParts'
import {
  visibleProjects, visibleTasks, approvalStage, isOverdue, OPEN_STATUSES, WORKSPACE_ROLES,
} from '../../lib/workspaceAccess'
import { DIVISIONS } from '../../store/protoSeed'
import { useT } from '../../i18n'

/** Signed in, the workspace has to load (who you are, your projects, your tasks) before there is
 *  anything to show; until then, or when it cannot, a plain page stands in. */
export default function Workspace() {
  const live = useProto((s) => s.live)
  const status = useProto((s) => s.chatStatus)
  const error = useProto((s) => s.chatError)
  const tasksStatus = useProto((s) => s.tasksStatus)
  if (live && status !== 'ready') return <ChatGate status={status} error={error} area="Workspace" />
  if (live && (tasksStatus === 'idle' || tasksStatus === 'loading')) return <ChatGate status="loading" area="Workspace" />
  return <WorkspaceScreen />
}

function WorkspaceScreen() {
  const t = useT()
  const live = useProto((s) => s.live)
  const persona = useProto(selectPersona)
  const tasks = useProto((s) => s.tasks)
  const members = useProto((s) => s.members)
  const projectDivisions = useProto((s) => s.projectDivisions)
  const projects = useWorkspaceProjects()
  const { openTask } = useOpenTask()
  const [tab, setTab] = useState('projects')

  const myProjects = visibleProjects(persona, projects, projectDivisions)
  const myTasks = useMemo(() => visibleTasks(persona, tasks, projectDivisions), [persona, tasks, projectDivisions])

  const assignedToMe = myTasks.filter((x) => x.assigneeId === persona.id && OPEN_STATUSES.includes(x.status))
  const toApprove = myTasks.filter((x) => approvalStage(persona, x, members))
  const iAssigned = myTasks.filter((x) => x.assignedById === persona.id && x.assigneeId !== persona.id && OPEN_STATUSES.includes(x.status))
  const stuck = myTasks.filter((x) => x.status === 'Blocked' || isOverdue(x, todayFor(live)))

  const isPM = persona.workspaceRole === 'pm'
  const tabs = [
    { key: 'projects', label: 'Projects', count: myProjects.length },
    { key: 'mine', label: 'My tasks', count: assignedToMe.length + toApprove.length },
    { key: 'stuck', label: 'Blocked & overdue', count: stuck.length },
    ...(isPM ? [{ key: 'team', label: 'Team & access' }] : []),
  ]
  const active = tabs.some((x) => x.key === tab) ? tab : 'projects'

  return (
    <div>
      <PageHeader
        eyebrow="Project Workspace"
        title="Workspace"
        subtitle="Who is the PIC, what is pending, what is blocked and why — across every project."
        actions={
          <>
            <PersonaSwitcher />
            {!live && <button
              className="btn-ghost"
              title={t('Restore the demo data in every open tab')}
              aria-label={t('Reset demo data')}
              onClick={() => { if (window.confirm(t('Reset the workspace, chat and events demo data?'))) useProto.getState().resetDemo() }}
            >
              <RotateCcw size={15} />
            </button>}
          </>
        }
      />

      <PersonaNote persona={persona} projectCount={myProjects.length} taskCount={myTasks.length} />

      <Tabs tabs={tabs} active={active} onChange={setTab} />

      {active === 'projects' && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {myProjects.map((p) => (
            <ProjectCard key={p.id} project={p} tasks={myTasks.filter((x) => x.projectId === p.id)} divisions={projectDivisions[p.id] || []} />
          ))}
          {myProjects.length === 0 && <Empty text="No projects for this persona yet." />}
        </div>
      )}

      {active === 'mine' && (
        <div className="space-y-2">
          <SectionTitle icon={CheckCircle2}>{t('Waiting for my approval')}</SectionTitle>
          {toApprove.map((x) => (
            <TaskRow key={x.id} task={x} onOpen={openTask} note={approvalStage(persona, x, members) === 'leader' ? t('Stage 1 · Division Leader') : t('Stage 2 · PM final')} />
          ))}
          {toApprove.length === 0 && <Empty text="Nothing is waiting for your approval." />}

          <SectionTitle icon={Clock}>{t('Assigned to me')}</SectionTitle>
          {[...assignedToMe].sort((a, b) => a.deadline.localeCompare(b.deadline)).map((x) => <TaskRow key={x.id} task={x} onOpen={openTask} />)}
          {assignedToMe.length === 0 && <Empty text="No open tasks assigned to you." />}

          {iAssigned.length > 0 && (
            <>
              <SectionTitle icon={Users}>{t('Assigned by me')}</SectionTitle>
              {iAssigned.map((x) => <TaskRow key={x.id} task={x} onOpen={openTask} />)}
            </>
          )}
        </div>
      )}

      {active === 'stuck' && <StuckBoard tasks={stuck} projects={myProjects} onOpen={openTask} />}

      {active === 'team' && isPM && <TeamAccess projects={projects} />}

      <TaskDrawer />
    </div>
  )
}

function PersonaNote({ persona, projectCount, taskCount }) {
  const t = useT()
  const what = {
    pm: 'sees every project and task, assigns anyone, and gives the final approval.',
    leader: `sees projects the ${persona.division} division works on, assigns within the division, and gives the first approval.`,
    staff: 'sees their projects and every task in them, and can assign to peers and interns there.',
    intern: 'sees only their own tasks on their projects, and cannot assign or approve.',
  }[persona.workspaceRole]
  return (
    <div className="mb-5 flex flex-wrap items-center gap-3 rounded-lg border border-white/10 bg-white/[0.02] px-4 py-3 text-sm">
      <Avatar member={persona} />
      <div className="text-white/60">
        <span className="text-white">{persona.name}</span> · {t(WORKSPACE_ROLES[persona.workspaceRole])} — {t(what)}
      </div>
      <div className="ml-auto text-xs text-white/40">
        {projectCount} {t('projects')} · {taskCount} {t('tasks visible')}
      </div>
    </div>
  )
}

function ProjectCard({ project, tasks, divisions }) {
  const t = useT()
  const members = useProto((s) => s.members)
  const live = useProto((s) => s.live)
  const open = tasks.filter((x) => OPEN_STATUSES.includes(x.status))
  const blocked = tasks.filter((x) => x.status === 'Blocked')
  const overdue = tasks.filter((x) => isOverdue(x, todayFor(live)))
  const waiting = tasks.filter((x) => ['Submitted', 'Leader approved'].includes(x.status))
  const done = tasks.length - open.length
  const next = [...open].sort((a, b) => a.deadline.localeCompare(b.deadline))[0]
  const days = daysUntil(project.eventDate)
  const leaders = members.filter((m) => m.workspaceRole === 'leader' && divisions.includes(m.division))

  return (
    <Link to={`/workspace/${project.id}`} className="card p-5 block hover:border-gold/40 transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-mono text-[10px] text-white/30">{project.id}</div>
          <div className="mt-1 text-white font-medium truncate">{project.name}</div>
          <div className="text-xs text-white/45">{project.client}</div>
        </div>
        <span className="inline-flex items-center gap-1 text-xs text-white/50 shrink-0">
          <CalendarDays size={13} /> {shortDate(project.eventDate)}
          <span className="text-white/30">· {days >= 0 ? `D-${days}` : t('done')}</span>
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-white/50">
        <span>{t('PIC')}: <span className="text-white/80">{project.pm}</span></span>
        <span className="text-white/20">|</span>
        {divisions.map((d) => <span key={d} className="rounded-full bg-white/5 px-2 py-0.5">{t(d)}</span>)}
        <span className="ml-auto flex -space-x-1.5">{leaders.map((m) => <Avatar key={m.id} member={m} size="sm" />)}</span>
      </div>

      <div className="mt-4 grid grid-cols-4 gap-2 text-center">
        <Stat n={open.length} label="Open" />
        <Stat n={waiting.length} label="Approval" tone="text-amber-300" />
        <Stat n={blocked.length} label="Blocked" tone={blocked.length ? 'text-rose-300' : ''} />
        <Stat n={overdue.length} label="Overdue" tone={overdue.length ? 'text-rose-300' : ''} />
      </div>

      <div className="mt-4 h-1.5 rounded-full bg-white/5 overflow-hidden">
        <div className="h-full bg-gold/70" style={{ width: `${tasks.length ? (done / tasks.length) * 100 : 0}%` }} />
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-white/35">
        <span>{done}/{tasks.length} {t('done')}</span>
        {next && <span className="truncate ml-2">{t('Next')}: {next.title} · {shortDate(next.deadline)}</span>}
      </div>
    </Link>
  )
}

function Stat({ n, label, tone = '' }) {
  const t = useT()
  return (
    <div className="rounded-lg bg-white/[0.03] py-2">
      <div className={`font-display text-lg tabular-nums ${tone || 'text-white'}`}>{n}</div>
      <div className="text-[10px] uppercase tracking-wider text-white/35">{t(label)}</div>
    </div>
  )
}

/** Where work is stuck, grouped by project, with the recorded reason. */
function StuckBoard({ tasks, projects, onOpen }) {
  const t = useT()
  const live = useProto((s) => s.live)
  const members = useProto((s) => s.members)
  if (tasks.length === 0) return <Empty text="Nothing blocked or overdue." />
  return (
    <div className="space-y-5">
      {projects.filter((p) => tasks.some((x) => x.projectId === p.id)).map((p) => (
        <Card key={p.id}>
          <div className="flex items-center justify-between mb-3">
            <div className="text-white font-medium">{p.name}</div>
            <span className="text-xs text-white/40">{t('PIC')}: {p.pm}</span>
          </div>
          <div className="space-y-2">
            {tasks.filter((x) => x.projectId === p.id).map((x) => {
              const blockedAt = [...x.activity].reverse().find((a) => a.kind === 'block')?.at
              const assignee = members.find((m) => m.id === x.assigneeId)
              return (
                <button key={x.id} onClick={() => onOpen(x.id)} className="w-full text-left rounded-lg border border-white/5 p-3 hover:border-gold/30">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[10px] text-white/30">{x.id}</span>
                    <span className="text-sm text-white/85">{x.title}</span>
                    <span className="ml-auto flex gap-1.5">
                      {x.status === 'Blocked' && <Badge>Blocked</Badge>}
                      {isOverdue(x, todayFor(live)) && <Badge>Overdue</Badge>}
                    </span>
                  </div>
                  {x.status === 'Blocked' && (
                    <div className="mt-2 flex gap-2 text-sm text-rose-200/90">
                      <AlertTriangle size={14} className="shrink-0 mt-0.5" /> {x.blockerReason}
                    </div>
                  )}
                  <div className="mt-2 text-[11px] text-white/40">
                    {assignee?.name} · {t('due')} {shortDate(x.deadline)}
                    {blockedAt && <> · {t('blocked since')} {stamp(blockedAt)}</>}
                  </div>
                </button>
              )
            })}
          </div>
        </Card>
      ))}
    </div>
  )
}

/** PM only: which divisions work on each project, and which staff/interns are on it. */
function TeamAccess({ projects }) {
  const t = useT()
  const members = useProto((s) => s.members)
  const projectDivisions = useProto((s) => s.projectDivisions)
  const { toggleProjectDivision, toggleMemberProject } = useProto.getState()
  const assignable = members.filter((m) => ['staff', 'intern'].includes(m.workspaceRole))

  return (
    <div className="space-y-6">
      <div>
        <SectionTitle icon={Users}>{t('Divisions on each project')}</SectionTitle>
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead><tr><th className="th text-left">{t('Project')}</th>{DIVISIONS.map((d) => <th key={d} className="th">{t(d)}</th>)}</tr></thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id} className="border-t border-white/5">
                  <td className="td">{p.name}</td>
                  {DIVISIONS.map((d) => (
                    <td key={d} className="td text-center">
                      <input type="checkbox" className="accent-[#c6a15b]" checked={(projectDivisions[p.id] || []).includes(d)} onChange={() => toggleProjectDivision(p.id, d)} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-white/35">{t('A division leader sees every project their division is ticked on.')}</p>
      </div>

      <div>
        <SectionTitle icon={Users}>{t('Staff and interns on each project')}</SectionTitle>
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr>
                <th className="th text-left">{t('Member')}</th>
                {projects.map((p) => <th key={p.id} className="th text-xs">{p.name}</th>)}
              </tr>
            </thead>
            <tbody>
              {assignable.map((m) => (
                <tr key={m.id} className="border-t border-white/5">
                  <td className="td">
                    <span className="inline-flex items-center gap-2">
                      <Avatar member={m} size="sm" />
                      <span>{m.name}</span>
                      <span className="text-xs text-white/40">{t(m.division)} · {t(WORKSPACE_ROLES[m.workspaceRole])}</span>
                    </span>
                  </td>
                  {projects.map((p) => (
                    <td key={p.id} className="td text-center">
                      <input type="checkbox" className="accent-[#c6a15b]" checked={(m.projectIds || []).includes(p.id)} onChange={() => toggleMemberProject(m.id, p.id)} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-white/35">{t('Switch the persona to an intern to see the effect: they only see projects ticked here, and only their own tasks.')}</p>
      </div>
    </div>
  )
}

function Empty({ text }) {
  const t = useT()
  return <div className="rounded-lg border border-dashed border-white/10 p-6 text-center text-sm text-white/40">{t(text)}</div>
}
