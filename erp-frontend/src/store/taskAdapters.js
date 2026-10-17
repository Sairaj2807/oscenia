// Server tasks → the prototype's tasks, and the small pure helpers the task store is built from.
// Pure functions over plain data (no store, no network), so `scripts/verify-chat-adapters.mjs`
// can check them in Node.
//
// The prototype's task is the shape every workspace screen reads, so the server's task is bent to
// it rather than the other way round: `id` is the task number (`T-101`, what people say and what
// chat links to), `projectId` is the project's business number (`EVT-…`, what the workspace
// routes use), people are member numbers (`M-05`), times are Jakarta wall clock.

import { wall } from './chatAdapters.js'

/** A server task (already camelCased by the api client) → the prototype's task. `ctx` is the chat
 *  context, which knows who each UUID is. */
export function adaptTask(t, ctx) {
  const who = (uuid, no) => no || ctx.noOf(uuid)
  const approvals = {}
  for (const [stage, a] of Object.entries(t.approvals || {})) {
    approvals[stage] = { by: who(a.byId, a.byNo), at: wall(a.at) }
  }
  return {
    id: t.taskNo,
    uuid: t.id,
    projectId: t.projectNo,
    projectUuid: t.projectId,
    division: t.division,
    title: t.title,
    description: t.description || '',
    assigneeId: who(t.assigneeId, t.assigneeNo),
    assignedById: who(t.assignedById, t.assignedByNo),
    assignedAt: wall(t.assignedAt),
    deadline: t.deadline,
    priority: t.priority,
    status: t.status,
    blockerReason: t.blockerReason || '',
    approvals,
    completedAt: t.completedAt ? wall(t.completedAt) : null,
    activity: (t.activity || []).map((a) => ({ at: wall(a.at), by: who(a.byId, a.byNo), text: a.text, kind: a.kind })),
    attachments: (t.attachments || []).map((f) => ({
      id: f.id, name: f.filename, kind: f.kind, size: f.sizeBytes, by: who(f.uploaderId, f.uploaderNo), at: wall(f.createdAt),
      // The server holds the bytes (a seeded demo record has only its details).
      stored: f.stored !== false,
    })),
    // What the server knows that the prototype's task did not:
    rev: t.rev ?? 0,
    overdue: Boolean(t.overdue),
    myStage: t.myStage || null,
  }
}

/** Oldest assigned first, ties by number — the order the server lists them in. */
export const sortTasks = (list) =>
  [...list].sort((a, b) => a.assignedAt.localeCompare(b.assignedAt) || (Number(a.id.slice(2)) || 0) - (Number(b.id.slice(2)) || 0))

/** Put a task into the list. An older version of one already held (a late or repeated live event)
 *  does not replace the newer; a task not seen before is added. */
export function upsertTask(list, task) {
  const i = list.findIndex((t) => t.id === task.id)
  if (i < 0) return sortTasks([...list, task])
  if ((task.rev ?? 0) < (list[i].rev ?? 0)) return list
  return list.map((t, j) => (j === i ? task : t))
}

export const removeTask = (list, id) => list.filter((t) => t.id !== id)

/** The message to show for a refused action: the server's own sentence, else a plain one. */
export function whyRefused(err) {
  if (err?.status === 404) return 'That task is no longer available to you.'
  return err?.message || 'The server did not accept that.'
}
