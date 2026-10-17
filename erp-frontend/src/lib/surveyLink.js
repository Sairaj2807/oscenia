// The client's rating link. Staff mint it on the server (`GET /projects/{id}/survey-link`); the client
// opens `/rate/<project number>` with the signed token after the `#`, so the token is never sent in a
// request line or kept in an access log, and the page sends it in a header.

import { api } from './api.js'

/** The address to send the client. The token goes after `#`, never in the path or the query. */
export const surveyUrl = (origin, projectNo, token) =>
  `${String(origin).replace(/\/+$/, '')}/rate/${encodeURIComponent(projectNo)}#${token}`

/** Whether a project can be rated yet (and still): after the event, and not cancelled. */
export const canSendSurvey = (project) =>
  Boolean(project) && !project.cancelled && (project.stage === 'Post-Event Feedback' || project.stage === 'Finished')

/** The days left on a link, rounded up, for "works for N more days". */
export function daysLeft(expiresAt, now = Date.now()) {
  const ms = new Date(expiresAt).getTime() - now
  return Number.isFinite(ms) ? Math.max(0, Math.ceil(ms / 86_400_000)) : 0
}

export const surveyLinkApi = {
  get: (projectUuid) => api.get(`/projects/${projectUuid}/survey-link`),
  regenerate: (projectUuid) => api.post(`/projects/${projectUuid}/survey-link/regenerate`, {}),
}
