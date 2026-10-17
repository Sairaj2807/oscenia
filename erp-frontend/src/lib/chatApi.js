// The chat endpoints, one function each. A thin layer over `api` (lib/api.js), which already
// converts snake_case to camelCase both ways — so these return the server's shapes exactly and
// `store/chatAdapters.js` is where they become what the screens expect.
//
// Reading and writing are separate on purpose, as on the server: the WebSocket only delivers,
// every change goes through these calls.

import { api } from './api.js'

const enc = encodeURIComponent

export const chatApi = {
  // --- the workspace ------------------------------------------------------------------
  bootstrap: () => api.get('/chat/bootstrap'),
  setStatus: (status) => api.patch('/chat/me/status', { status }),
  notifications: (limit = 50) => api.get('/chat/notifications', { limit }),

  // --- channels -----------------------------------------------------------------------
  createChannel: (body) => api.post('/chat/channels', body),
  updateChannel: (id, patch) => api.patch(`/chat/channels/${id}`, patch),
  openDm: (userId) => api.post('/chat/dms', { userId }),

  // --- join requests ------------------------------------------------------------------
  joinRequests: (channelId, status = 'all') => api.get(`/chat/channels/${channelId}/join-requests`, { status }),
  requestJoin: (channelId, note) => api.post(`/chat/channels/${channelId}/join-requests`, { note }),
  decide: (requestId, approve) => api.post(`/chat/join-requests/${requestId}/decide`, { approve }),

  // --- messages -----------------------------------------------------------------------
  messages: (channelId, params) => api.get(`/chat/channels/${channelId}/messages`, params),
  send: (channelId, body) => api.post(`/chat/channels/${channelId}/messages`, body),
  edit: (messageId, text) => api.patch(`/chat/messages/${messageId}`, { text }),
  remove: (messageId) => api.delete(`/chat/messages/${messageId}`),
  react: (messageId, emoji) => api.put(`/chat/messages/${messageId}/reactions/${enc(emoji)}`),
  unreact: (messageId, emoji) => api.delete(`/chat/messages/${messageId}/reactions/${enc(emoji)}`),
  read: (channelId, seq) => api.post(`/chat/channels/${channelId}/read`, { seq }),
  sync: (cursors) => api.post('/chat/sync', { cursors }),

  // --- who works on a project (the PM's Team & access) ---------------------------------
  setProjectDivisions: (projectId, divisions) => api.put(`/chat/projects/${projectId}/divisions`, { divisions }),
  setProjectMembers: (projectId, userIds) => api.put(`/chat/projects/${projectId}/members`, { userIds }),

  // --- meetings -----------------------------------------------------------------------
  channelMeetings: (channelId) => api.get(`/chat/channels/${channelId}/meetings`),
  meeting: (id) => api.get(`/chat/meetings/${id}`),
  setMeetingAccess: (id, body) => api.patch(`/chat/meetings/${id}/access`, body),
  writeMinutes: (id, body) => api.post(`/chat/meetings/${id}/summary`, body),
  postMinutes: (id) => api.post(`/chat/meetings/${id}/post-summary`),
  meetingTasks: (id) => api.post(`/chat/meetings/${id}/tasks`),

  // --- files --------------------------------------------------------------------------
  upload: (channelId, file) => {
    const form = new FormData()
    form.append('file', file, file.name)
    return api.upload(`/chat/channels/${channelId}/attachments`, form)
  },
  attachmentUrl: (attachmentId) => api.get(`/chat/attachments/${attachmentId}/url`),
}
