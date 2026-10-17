// The events endpoints, one function each. A thin layer over `api` (lib/api.js), which converts
// snake_case to camelCase both ways, so these return the server's shapes exactly and
// `store/eventAdapters.js` is where they become what the events screens expect.
//
// `id` here is the event's server id (`uuid`), not its number (`EV-01`): the store keeps both.

import { api, request, uploadFile } from './api.js'

const ref = (r) => encodeURIComponent(r)
const ev = (id) => `/events/${ref(id)}`

export const eventsApi = {
  // events
  list: () => api.get('/events'),
  get: (id) => api.get(ev(id)),
  create: (body) => api.post('/events', body),
  update: (id, body) => api.patch(ev(id), body),

  // the invitation draft
  setTemplate: (id, templateId) => api.put(`${ev(id)}/invite/template`, { templateId }),
  setSection: (id, section, on) => api.put(`${ev(id)}/invite/sections/${ref(section)}`, { on }),
  // The content's keys are data (`mapUrl`, `trackId`), so they must reach the server as written.
  setContent: (id, section, value) =>
    request(`${ev(id)}/invite/content/${ref(section)}`, { method: 'PUT', body: { value }, rawKeys: true }),
  setAccent: (id, accent) => api.put(`${ev(id)}/invite/accent`, { accent }),

  // review and publish
  submit: (id) => api.post(`${ev(id)}/submit`),
  returnToClient: (id, note) => api.post(`${ev(id)}/return`, { note }),
  publish: (id, clampDeadline = false) => api.post(`${ev(id)}/publish`, { clampDeadline }),
  unpublish: (id) => api.post(`${ev(id)}/unpublish`),
  clientLink: (id) => api.get(`${ev(id)}/client-link`),
  // The signed link the walk-in QR at the registration desk carries (expires the day after the event).
  walkinLink: (id) => api.get(`${ev(id)}/walkin-link`),
  // A photo, video or song for the invitation (the reply is the reference to put in the content).
  uploadMedia: (id, file, { name, kind, onProgress, signal } = {}) => {
    const form = new FormData()
    form.append('file', file, name || file.name || 'file')
    return uploadFile(`${ev(id)}/media`, form, { params: { kind }, onProgress, signal })
  },
  regenerateClientLink: (id) => api.post(`${ev(id)}/client-link/regenerate`),

  // guests
  guests: (id) => api.get(`${ev(id)}/guests`),
  addGuests: (id, guests) => api.post(`${ev(id)}/guests`, { guests }),
  importGuests: (id, csv) => api.post(`${ev(id)}/guests/import`, { csv }),
  setGuestTable: (id, gid, table) => api.put(`${ev(id)}/guests/${ref(gid)}/table`, { table }),
  setGuestCategory: (id, gid, category) => api.put(`${ev(id)}/guests/${ref(gid)}/category`, { category }),
  setGuestNote: (id, gid, note) => api.put(`${ev(id)}/guests/${ref(gid)}/note`, { note }),
  // Erase a guest's personal data on their request (the row stays, anonymised). CEO and PM.
  eraseGuest: (id, gid) => api.post(`${ev(id)}/guests/${ref(gid)}/erase`),
  setGuestEmail: (id, gid, email) => api.put(`${ev(id)}/guests/${ref(gid)}/email`, { email }),

  // questions, tables, checkpoints
  addQuestion: (id, type) => api.post(`${ev(id)}/questions`, { type }),
  updateQuestion: (id, key, patch) => api.patch(`${ev(id)}/questions/${ref(key)}`, patch),
  moveQuestion: (id, key, direction) => api.post(`${ev(id)}/questions/${ref(key)}/move`, { direction }),
  removeQuestion: (id, key) => api.delete(`${ev(id)}/questions/${ref(key)}`),
  addTable: (id, name) => api.post(`${ev(id)}/tables`, { name }),
  addCheckpoint: (id, name) => api.post(`${ev(id)}/checkpoints`, { name }),
  updateCheckpoint: (id, cid, patch) => api.patch(`${ev(id)}/checkpoints/${ref(cid)}`, patch),
  removeCheckpoint: (id, cid) => api.delete(`${ev(id)}/checkpoints/${ref(cid)}`),

  // the door
  scans: (id) => api.get(`${ev(id)}/scans`),
  scan: (id, body) => api.post(`${ev(id)}/scans`, body),
  checkIn: (id, gid) => api.post(`${ev(id)}/guests/${ref(gid)}/check-in`),
  undoCheckIn: (id, gid) => api.post(`${ev(id)}/guests/${ref(gid)}/check-in/undo`),
  walkIn: (id, body) => api.post(`${ev(id)}/walk-ins`, body),

  // wishes and the report
  wishes: (id) => api.get(`${ev(id)}/wishes`),
  setWishHidden: (id, wid, hidden) => api.put(`${ev(id)}/wishes/${ref(wid)}/hidden`, { hidden }),
  approveWish: (id, wid) => api.post(`${ev(id)}/wishes/${ref(wid)}/approve`),
  report: (id) => api.get(`${ev(id)}/report`),

  // Template Studio
  templates: () => api.get('/invitation-templates'),
  createTemplate: (body) => api.post('/invitation-templates', body),
  updateTemplate: (id, patch) => api.patch(`/invitation-templates/${ref(id)}`, patch),
  uploadArt: (id, file, { name, onProgress, signal } = {}) => {
    const form = new FormData()
    form.append('file', file, name || file.name || 'file')
    return uploadFile(`/invitation-templates/${ref(id)}/art-upload`, form, { onProgress, signal })
  },
  setTemplateArt: (id, slot, artRef) => api.put(`/invitation-templates/${ref(id)}/art/${ref(slot)}`, { ref: artRef }),
  publishTemplate: (id) => api.post(`/invitation-templates/${ref(id)}/publish`),
  unpublishTemplate: (id) => api.post(`/invitation-templates/${ref(id)}/unpublish`),
  archiveTemplate: (id) => api.post(`/invitation-templates/${ref(id)}/archive`),
}
