// The workspace's tasks, from the server (`/tasks`): loaded when chat's workspace is ready, kept
// fresh by `task.*` frames, changed through the actions below. Not persisted: the server is the
// copy, and a signed-out browser must not keep another person's tasks.
//
// The actions keep the prototype's names and arguments (`createTask`, `startTask`, …) so the
// screens call them the way they always did — but they return a promise, and when the server says
// no they show *its* reason (not yours / not in that state / incomplete) instead of "not allowed".
//
// Like chat's store, this one only holds what the server sent. The rules that decide who may do
// what are enforced there; the screens still hide what you cannot do, as a courtesy.

import { create } from 'zustand'
import { taskApi } from '../lib/taskApi.js'
import { fileUrl } from '../lib/api.js'
import { useChat } from './useChat.js'
import { useStore } from './useStore.js'
import { adaptTask, removeTask, upsertTask, whyRefused } from './taskAdapters.js'

const toast = (title, body, kind = 'redflag') => {
  try {
    useStore.getState().pushToast({ title, body, kind })
  } catch {
    /* no toast host */
  }
}

export const useTasks = create((set, get) => ({
  tasks: [],
  status: 'idle', // idle | loading | ready | error

  /** Everything the caller may see. Safe to call again (after a reconnect, say). */
  load: async () => {
    const chat = useChat.getState()
    if (!chat.ctx) return
    set((s) => ({ status: s.status === 'ready' ? 'ready' : 'loading' }))
    try {
      const list = await taskApi.list()
      const ctx = useChat.getState().ctx
      if (!ctx) return // signed out while it loaded
      set({ tasks: list.map((t) => adaptTask(t, ctx)), status: 'ready' })
    } catch (err) {
      set((s) => ({ status: s.status === 'ready' ? 'ready' : 'error' }))
      toast('Could not load tasks', whyRefused(err))
    }
  },

  reset: () => set({ tasks: [], status: 'idle' }),

  /** A `task.created` / `task.updated` / `task.removed` frame. */
  receive: (frame) => {
    const ctx = useChat.getState().ctx
    if (!ctx) return
    if (frame.type === 'task.removed') {
      set((s) => ({ tasks: removeTask(s.tasks, frame.taskNo) }))
      return
    }
    if (frame.task) set((s) => ({ tasks: upsertTask(s.tasks, adaptTask(frame.task, ctx)) }))
  },

  // ===========================================================================
  // Actions
  // ===========================================================================

  /** Give someone a task. Returns the new task's number, or `null` (the reason is shown). */
  createTask: async ({ projectId, title, description = '', assigneeId, deadline, priority = 'Medium' }) => {
    const chat = useChat.getState()
    const project = chat.chatProjects.find((p) => p.projectNo === projectId || p.id === projectId)
    const assignee = chat.members.find((m) => m.id === assigneeId)
    if (!project || !assignee) {
      toast('Not allowed', 'That project or person is not available to you.')
      return null
    }
    try {
      const res = await taskApi.create({
        projectId: project.id, title, description, assigneeId: assignee.uuid, deadline, priority,
      })
      const task = adaptTask(res, chat.ctx)
      set((s) => ({ tasks: upsertTask(s.tasks, task) }))
      // Giving staff or an intern a task on a project makes them a member of it: read the workspace
      // again so the rules on this screen see the new membership.
      const joined = ['staff', 'intern'].includes(assignee.workspaceRole) && !(assignee.projectIds || []).includes(project.id)
      if (joined) chat.load()
      return task.id
    } catch (err) {
      toast('Could not assign the task', whyRefused(err))
      return null
    }
  },

  /**
   * Attach a file the screen picked (`{ file }` is the browser's File; the rest is what the demo's
   * store reads from it). `{ id }` or `{ error }`, like the prototype's — the screen shows the error.
   */
  addAttachment: async (taskNo, picked) => {
    const file = picked?.file
    if (!file) return { error: 'Choose a file to attach.' }
    try {
      const res = await taskApi.upload(taskNo, file)
      const ctx = useChat.getState().ctx
      const task = adaptTask(res, ctx)
      set((s) => ({ tasks: upsertTask(s.tasks, task) }))
      return { id: task.attachments.find((a) => a.name === picked.name)?.id }
    } catch (err) {
      return { error: whyRefused(err) }
    }
  },

  removeAttachment: async (taskNo, attachmentId) => {
    try {
      const res = await taskApi.removeFile(taskNo, attachmentId)
      set((s) => ({ tasks: upsertTask(s.tasks, adaptTask(res, useChat.getState().ctx)) }))
      return true
    } catch (err) {
      toast('Could not remove the file', whyRefused(err))
      return false
    }
  },

  /** Open a file in a new tab by a fresh link (they last a few minutes and are minted after the
   *  server has checked you may see the task). */
  openAttachment: async (taskNo, attachment) => {
    try {
      const { url } = await taskApi.fileUrl(taskNo, attachment.id)
      window.open(fileUrl(url), '_blank', 'noopener,noreferrer')
    } catch (err) {
      toast('Could not open the file', whyRefused(err))
    }
  },

  startTask: (id) => move(set, () => taskApi.start(id), 'Could not start the task'),
  unblockTask: (id) => move(set, () => taskApi.unblock(id), 'Could not unblock the task'),
  submitTask: (id) => move(set, () => taskApi.submit(id), 'Could not submit the task'),
  approveTask: (id) => move(set, () => taskApi.approve(id), 'Could not approve the task'),
  blockTask: (id, reason) => move(set, () => taskApi.block(id, reason), 'Could not block the task'),
  rejectTask: (id, comment) => move(set, () => taskApi.reject(id, comment), 'Could not send the task back'),
}))

/** Run one change; on success the server's whole task replaces ours. True when it was accepted. */
async function move(set, call, failTitle) {
  try {
    const res = await call()
    const ctx = useChat.getState().ctx
    set((s) => ({ tasks: upsertTask(s.tasks, adaptTask(res, ctx)) }))
    return true
  } catch (err) {
    toast(failTitle, whyRefused(err))
    return false
  }
}
