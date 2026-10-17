// Writes what the prototype's task rules and store actions answer, for the backend to replay:
// erp-backend/tests/fixtures/task_matrix.json.
//
//  1. A MATRIX: every seed person against every seed task and a grid of made-up ones (each status,
//     two assignees, two divisions, three assigners, a deadline either side of "today"): who can
//     see it, work on it, submit it, which approval they hold, who may be assigned on each project.
//  2. FLOWS: scripted sequences of actions driven through the real `useProto` store, with what it
//     answered (done or refused) and what the task looked like after each step.
//
// The backend ports these rules (app/domain/workspace/task_rules.py) and its service has to give
// the same answers. A hand-written expectation would agree on the day it was written and drift
// after; replaying the prototype's own answers is what keeps the two rule books one.
//
// Re-run after changing lib/workspaceAccess.js, the store's task actions or the seed:
//   node scripts/export-task-fixtures.mjs
//
// Left out on purpose: a deadline in the past. The store never checked it (only the modal did),
// so its answer is "fine"; the server refuses it, and says so in its own tests.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEMO_TODAY } from '../src/lib/format.js'
import {
  approvalStage, assignableMembers, canSeeTask, canSubmit, canWorkOn, isOverdue, TASK_STATUSES,
} from '../src/lib/workspaceAccess.js'
import { seedMembers, seedProjectDivisions, seedTasks } from '../src/store/protoSeed.js'

const projects = Object.keys(seedProjectDivisions)
const GALA = 'EVT-2026-GALA-01'
const WED = 'EVT-2026-WED-02'
const D = '2026-08-30'

// --- 1. the matrix ------------------------------------------------------------------------

const members = seedMembers.map((m) => ({
  id: m.id, workspace_role: m.workspaceRole, division: m.division || null, project_ids: m.projectIds || [],
}))

const synthetic = []
for (const status of TASK_STATUSES) {
  for (const assignee of ['M-02', 'M-05']) {
    for (const division of ['Field', 'Design']) {
      for (const by of ['M-01', 'M-02', 'M-05']) {
        for (const deadline of ['2026-07-25', '2026-07-26']) {
          synthetic.push({
            id: `S-${String(synthetic.length).padStart(3, '0')}`, projectId: GALA, division, assigneeId: assignee,
            assignedById: by, status, deadline,
          })
        }
      }
    }
  }
}
const tasks = [...seedTasks, ...synthetic]
const taskOut = tasks.map((t) => ({
  id: t.id, project_id: t.projectId, division: t.division, assignee_id: t.assigneeId,
  assigned_by_id: t.assignedById, status: t.status, deadline: t.deadline,
}))

const see = {}
const work = {}
const submit = {}
const stage = {}
const assignable = {}
for (const m of seedMembers) {
  see[m.id] = tasks.filter((t) => canSeeTask(m, t, seedProjectDivisions)).map((t) => t.id)
  work[m.id] = tasks.filter((t) => canWorkOn(m, t)).map((t) => t.id)
  submit[m.id] = tasks.filter((t) => canSubmit(m, t)).map((t) => t.id)
  stage[m.id] = Object.fromEntries(
    tasks.map((t) => [t.id, approvalStage(m, t, seedMembers)]).filter(([, s]) => s),
  )
  assignable[m.id] = Object.fromEntries(
    projects.map((p) => [p, assignableMembers(m, p, seedMembers, seedProjectDivisions).map((x) => x.id)]),
  )
}
const overdue = tasks.filter((t) => isOverdue(t, DEMO_TODAY)).map((t) => t.id)

// --- 2. the flows, through the real store --------------------------------------------------

const mem = new Map()
globalThis.localStorage = {
  getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k),
}
const { useProto } = await import('../src/store/useProto.js')
const S = () => useProto.getState()

const create = (as, assignee, extra = {}, alias = 'a', project = GALA) => ({
  as, do: 'create', alias,
  args: { project_id: project, title: 'Check the rigging', description: 'Before load-in', assignee_id: assignee, deadline: D, priority: 'High', ...extra },
})
const act = (as, action, task = 'a', args = {}) => ({ as, do: action, task, args })

const scenarios = [
  {
    name: 'who may create a task, for whom',
    steps: [
      create('M-09', 'M-09', {}, 'x1'),                       // an intern cannot assign
      create('M-05', 'M-10', {}, 'x2'),                       // staff to an intern on their project
      create('M-05', 'M-02', {}, 'x3'),                       // not upward to a leader
      create('M-05', 'M-08', {}, 'x4', WED),                  // not on that project
      create('M-02', 'M-05', {}, 'x5'),                       // a leader to their own division
      create('M-02', 'M-03', {}, 'x6'),                       // not to another division's leader
      create('M-04', 'M-06', {}, 'x7', WED),                  // Production is not on the Wedding
      create('M-01', 'M-05', {}, 'x8'),                       // the PM to anyone doing the work
      create('M-01', 'M-01', {}, 'x9'),                       // never to a PM
      create('M-01', 'M-05', { title: '   ' }, 'x10'),        // a title is needed
      create('M-01', 'M-05', { deadline: '' }, 'x11'),        // and a deadline
      create('M-01', 'M-05', {}, 'x12', 'EVT-NOPE'),          // and a real project
    ],
  },
  {
    name: 'W1: a leader assigns in their division and the assignee joins the project',
    steps: [create('M-02', 'M-05', {}, 'a', WED)],
  },
  {
    name: 'the assignee works the task: start, block, unblock, submit',
    steps: [
      create('M-01', 'M-05'),
      act('M-06', 'start'),                                   // not related to it
      act('M-05', 'start'),
      act('M-05', 'start'),                                   // already started
      act('M-05', 'block', 'a', { reason: '  ' }),            // a reason is needed
      act('M-05', 'block', 'a', { reason: 'waiting for the venue' }),
      act('M-05', 'block', 'a', { reason: 'again' }),         // already blocked
      act('M-05', 'start'),                                   // a blocked task is unblocked, not started
      act('M-05', 'submit'),                                  // not while blocked
      act('M-05', 'unblock'),
      act('M-01', 'submit'),                                  // the PM cannot submit for them
      act('M-05', 'submit'),
      act('M-05', 'block', 'a', { reason: 'too late' }),      // not once submitted
    ],
  },
  {
    name: 'W3: whoever assigned it may start it but never submit it',
    steps: [
      create('M-02', 'M-05'),
      act('M-02', 'start'),
      act('M-02', 'submit'),
      act('M-05', 'submit'),
      act('M-05', 'submit'),
    ],
  },
  {
    name: 'two approvals in order, and nobody approves their own work',
    steps: [
      create('M-01', 'M-05'),                                 // a Field task: Dinda (M-02) is its leader
      act('M-05', 'start'),
      act('M-05', 'submit'),
      act('M-05', 'approve'),                                 // not their own
      act('M-04', 'approve'),                                 // another division's leader
      act('M-01', 'approve'),                                 // the PM cannot skip stage 1
      act('M-02', 'approve'),
      act('M-02', 'approve'),                                 // stage 1 cannot be given twice
      act('M-01', 'approve'),
      act('M-05', 'block', 'a', { reason: 'done already' }),  // nothing moves a finished task
      act('M-01', 'approve'),
    ],
  },
  {
    name: 'a rejection needs a comment, restarts both approvals, and only a stage holder may',
    steps: [
      create('M-01', 'M-05'),
      act('M-05', 'start'),
      act('M-05', 'submit'),
      act('M-03', 'reject', 'a', { comment: 'not mine to judge' }),   // Design leader, wrong division
      act('M-02', 'reject', 'a', { comment: '' }),                    // a comment is needed
      act('M-02', 'approve'),
      act('M-01', 'reject', 'a', { comment: 'needs the stage plan' }),
      act('M-05', 'submit'),
      act('M-02', 'approve'),
      act('M-01', 'approve'),
    ],
  },
  {
    name: 'a leader doing their own task skips stage 1: the PM approves it straight away',
    steps: [
      create('M-01', 'M-02'),
      act('M-02', 'start'),
      act('M-02', 'submit'),
      act('M-02', 'approve'),
      act('M-04', 'approve'),
      act('M-01', 'approve'),
    ],
  },
  {
    name: 'staff assigning an intern: the intern starts it, the assigner can too',
    steps: [
      create('M-05', 'M-10'),
      act('M-10', 'start'),
      act('M-05', 'block', 'a', { reason: 'no access card' }),
      act('M-10', 'unblock'),
      act('M-08', 'start'),
    ],
  },
]

// Run each scenario from the seed, recording what the store said and what the task became.
const snapshot = (id) => {
  const t = S().tasks.find((x) => x.id === id)
  if (!t) return null
  const last = t.activity.at(-1)
  return {
    status: t.status, blocker_reason: t.blockerReason, division: t.division, assigned_by: t.assignedById,
    assignee: t.assigneeId, approvals: Object.keys(t.approvals).sort(), completed: Boolean(t.completedAt),
    activity: last ? { kind: last.kind, text: last.text, by: last.by } : null, activity_count: t.activity.length,
  }
}
for (const sc of scenarios) {
  S().resetDemo()
  const ids = {}
  for (const step of sc.steps) {
    S().setPersona(step.as)
    let ok
    if (step.do === 'create') {
      const a = step.args
      const id = S().createTask({
        projectId: a.project_id, title: a.title, description: a.description, assigneeId: a.assignee_id,
        deadline: a.deadline, priority: a.priority,
      })
      ok = id !== null
      if (ok) ids[step.alias] = id
      step.result = ok ? snapshot(id) : null
      if (ok) step.assignee_projects = S().members.find((m) => m.id === a.assignee_id).projectIds || []
    } else {
      const id = ids[step.task]
      const a = step.args
      const fn = {
        start: () => S().startTask(id), unblock: () => S().unblockTask(id), submit: () => S().submitTask(id),
        approve: () => S().approveTask(id), block: () => S().blockTask(id, a.reason),
        reject: () => S().rejectTask(id, a.comment),
      }[step.do]
      ok = Boolean(fn())
      step.result = snapshot(id)
    }
    step.ok = ok
  }
}

const out = fileURLToPath(new URL('../../erp-backend/tests/fixtures/task_matrix.json', import.meta.url))
mkdirSync(dirname(out), { recursive: true })
writeFileSync(
  out,
  `${JSON.stringify({
    today: DEMO_TODAY, project_divisions: seedProjectDivisions, members, tasks: taskOut,
    see, work, submit, stage, assignable, overdue, scenarios,
  })}\n`,
)
console.log(`wrote ${out}: ${members.length} members x ${tasks.length} tasks, ${scenarios.length} flows`)
