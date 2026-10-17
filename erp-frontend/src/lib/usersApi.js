// Account administration, one function each: who has a login (CEO), your own password and language.
// A thin layer over `request` (lib/api.js), which converts snake_case to camelCase both ways.

import { api, request } from './api.js'

export const MIN_PASSWORD = 12

export const usersApi = {
  list: () => api.get('/users'),
  // The reply carries `temporaryPassword`, shown once: it cannot be fetched again.
  create: (body) => api.post('/users', body),
  update: (id, body) => api.patch(`/users/${encodeURIComponent(id)}`, body),
  deactivate: (id) => api.post(`/users/${encodeURIComponent(id)}/deactivate`),
  activate: (id) => api.post(`/users/${encodeURIComponent(id)}/activate`),
  // A one-time link to hand over (no email is sent); a new one replaces the old.
  resetLink: (id) => api.post(`/users/${encodeURIComponent(id)}/reset-password`),

  // yourself
  changePassword: (currentPassword, newPassword) =>
    request('/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } }),
  setLanguage: (language) => api.patch('/auth/me/preferences', { language }),
}

/** What is wrong with a new password, or null. The server checks the same minimum. */
export function passwordProblem(password, confirm) {
  if ((password || '').length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`
  if (password !== confirm) return 'The two passwords do not match.'
  return null
}
