// Writes the prototype's demo tasks — 27 of them across the four projects, with the activity trail
// each one has accumulated, the approvals already given, and the two seeded file records — to
// erp-backend/app/seed/task_seed.json, which `python -m app.seed.tasks` loads.
//
// Exported rather than re-typed, like the chat seed: the access rules the prototype's own checks
// assert (who sees which task, who holds an approval) only hold if the data is identical. Re-run
// after changing src/store/protoSeed.js:   node scripts/export-task-seed.mjs
//
// Also carries who is in charge of each project (the prototype names a person on each card; only
// those who are workspace members can be matched to an account, the rest stay blank).

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { seedMembers, seedTasks } from '../src/store/protoSeed.js'
import { seedProjects } from '../src/store/seed.js'

const tasks = seedTasks.map((t) => ({
  task_no: t.id,
  project: t.projectId,
  division: t.division,
  title: t.title,
  description: t.description || '',
  assignee: t.assigneeId,
  assigned_by: t.assignedById,
  assigned_at: t.assignedAt,
  deadline: t.deadline,
  priority: t.priority,
  status: t.status,
  blocker_reason: t.blockerReason || '',
  approvals: Object.fromEntries(Object.entries(t.approvals).map(([stage, a]) => [stage, { by: a.by, at: a.at }])),
  completed_at: t.completedAt || null,
  activity: t.activity.map((a) => ({ at: a.at, by: a.by, text: a.text, kind: a.kind })),
  attachments: (t.attachments || []).map((a) => ({ name: a.name, kind: a.kind, size: a.size, by: a.by, at: a.at })),
}))

// Who is "PIC" on a project card: the member whose name the prototype prints, if there is one.
const byName = Object.fromEntries(seedMembers.map((m) => [m.name, m.id]))
const project_pm = Object.fromEntries(
  seedProjects.map((p) => [p.id, byName[p.pm] || null]),
)

const out = fileURLToPath(new URL('../../erp-backend/app/seed/task_seed.json', import.meta.url))
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, `${JSON.stringify({ tasks, project_pm }, null, 2)}\n`)
console.log(`wrote ${out}: ${tasks.length} tasks, ${tasks.reduce((n, t) => n + t.activity.length, 0)} activity entries`)
