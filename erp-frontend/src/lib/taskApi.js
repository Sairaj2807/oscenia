// The task endpoints, one function each. A thin layer over `api` (lib/api.js), which already
// converts snake_case to camelCase both ways, so these return the server's shapes exactly and
// `store/taskAdapters.js` is where they become what the workspace screens expect.
//
// Reading and writing are separate on purpose, as on the server: the WebSocket only delivers
// (`task.*` frames); every change goes through these calls.

import { api } from './api.js'

const ref = (r) => encodeURIComponent(r)

export const taskApi = {
  list: (projectId) => api.get('/tasks', projectId ? { projectId } : undefined),
  get: (r) => api.get(`/tasks/${ref(r)}`),
  create: (body) => api.post('/tasks', body),
  start: (r) => api.post(`/tasks/${ref(r)}/start`),
  block: (r, reason) => api.post(`/tasks/${ref(r)}/block`, { reason }),
  unblock: (r) => api.post(`/tasks/${ref(r)}/unblock`),
  submit: (r) => api.post(`/tasks/${ref(r)}/submit`),
  approve: (r) => api.post(`/tasks/${ref(r)}/approve`),
  reject: (r, comment) => api.post(`/tasks/${ref(r)}/reject`, { comment }),
  // files (W2)
  upload: (r, file) => {
    const form = new FormData()
    form.append('file', file, file.name)
    return api.upload(`/tasks/${ref(r)}/attachments`, form)
  },
  removeFile: (r, id) => api.delete(`/tasks/${ref(r)}/attachments/${id}`),
  fileUrl: (r, id) => api.get(`/tasks/${ref(r)}/attachments/${id}/url`),
}
