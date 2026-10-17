// The public (no sign-in) endpoints, one function each: the guest's invitation, RSVP and wishes,
// the walk-in desk, and the client's edit link. A thin layer over `request` (lib/api.js), which
// converts snake_case to camelCase both ways.
//
// None of these send the staff session. A guest's or client's token goes in a header, never in the
// path or query, so it does not end up in the proxy's access log.

import { request, uploadFile } from './api.js'

const no = (eventNo) => encodeURIComponent(eventNo)
const withGuest = (token) => (token ? { 'X-Guest-Token': token } : {})

// `request` takes no custom headers today; the public routes need exactly one, so this builds the
// call itself on the same base (see lib/api.js `request`).
function call(path, { method = 'GET', body, headers = {}, rawKeys = false } = {}) {
  return request(path, { method, body, auth: false, headers, rawKeys })
}

export const publicApi = {
  // guest
  invite: (eventNo, token) => call(`/public/invites/${no(eventNo)}`, { headers: withGuest(token) }),
  // Answers are keyed by question key (`Q-1`): snake-casing the body would turn that into `_q-1`, and
  // every field of the form is already one lower-case word, so the body goes as written.
  rsvp: (eventNo, form, token) =>
    call(`/public/invites/${no(eventNo)}/rsvp`, { method: 'POST', body: form, headers: withGuest(token), rawKeys: true }),
  // Take back what the guest gave: scope 'marketing' (stop news and offers) or 'all' (erase my data).
  withdraw: (eventNo, scope, token) =>
    call(`/public/invites/${no(eventNo)}/withdraw`, { method: 'POST', body: { scope }, headers: withGuest(token) }),
  wishes: (eventNo) => call(`/public/invites/${no(eventNo)}/wishes`),
  wish: (eventNo, form, token) =>
    call(`/public/invites/${no(eventNo)}/wishes`, { method: 'POST', body: form, headers: withGuest(token) }),

  // walk-in desk (the signed desk token comes from the QR: `?w=`)
  walkInPage: (eventNo, desk) =>
    call(`/public/walkin/${no(eventNo)}`, { headers: { 'X-Walkin-Token': desk || '' } }),
  walkIn: (eventNo, form, desk) =>
    call(`/public/walkin/${no(eventNo)}`, { method: 'POST', body: form, headers: { 'X-Walkin-Token': desk || '' } }),

  // Spend an admin-issued password link (the token is a header, never in the path).
  passwordReset: (token, password) =>
    call('/public/password-reset', { method: 'POST', body: { password }, headers: { 'X-Reset-Token': token || '' } }),

  // The client's rating link: the signed token is a header, never in the path or the query.
  survey: (projectNo, token) =>
    call(`/public/survey/${no(projectNo)}`, { headers: { 'X-Survey-Token': token || '' } }),
  rateSurvey: (projectNo, token, score) =>
    call(`/public/survey/${no(projectNo)}`, { method: 'POST', body: { score }, headers: { 'X-Survey-Token': token || '' } }),

  // client edit link (`?key=`)
  client: (eventNo, key) => call(`/public/client/${no(eventNo)}`, { headers: { 'X-Client-Key': key } }),
  clientSetTemplate: (eventNo, key, templateId) =>
    call(`/public/client/${no(eventNo)}/template`, { method: 'PUT', body: { templateId }, headers: { 'X-Client-Key': key } }),
  clientSetSection: (eventNo, key, section, on) =>
    call(`/public/client/${no(eventNo)}/sections/${encodeURIComponent(section)}`, { method: 'PUT', body: { on }, headers: { 'X-Client-Key': key } }),
  // The content's keys are data (`mapUrl`, `trackId`), so they must reach the server as written.
  clientSetContent: (eventNo, key, section, value) =>
    call(`/public/client/${no(eventNo)}/content/${encodeURIComponent(section)}`, { method: 'PUT', body: { value }, headers: { 'X-Client-Key': key }, rawKeys: true }),
  // A photo, video or song from the client; progress and cancel because a video is large.
  clientUpload: (eventNo, key, file, { name, kind, onProgress, signal } = {}) => {
    const form = new FormData()
    form.append('file', file, name || file.name || 'file')
    return uploadFile(`/public/client/${no(eventNo)}/media`, form, {
      params: { kind }, headers: { 'X-Client-Key': key }, auth: false, onProgress, signal,
    })
  },
  clientSetAccent: (eventNo, key, accent) =>
    call(`/public/client/${no(eventNo)}/accent`, { method: 'PUT', body: { accent }, headers: { 'X-Client-Key': key } }),
  clientSubmit: (eventNo, key) =>
    call(`/public/client/${no(eventNo)}/submit`, { method: 'POST', headers: { 'X-Client-Key': key } }),
  clientHoldWishes: (eventNo, key, hold) =>
    call(`/public/client/${no(eventNo)}/hold-wishes`, { method: 'PUT', body: { hold }, headers: { 'X-Client-Key': key } }),
  clientWish: (eventNo, key, wishId, action) =>
    call(`/public/client/${no(eventNo)}/wishes/${encodeURIComponent(wishId)}/${action}`, { method: 'POST', headers: { 'X-Client-Key': key } }),
  clientMarkSent: (eventNo, key, guestId) =>
    call(`/public/client/${no(eventNo)}/guests/${encodeURIComponent(guestId)}/sent`, { method: 'POST', headers: { 'X-Client-Key': key } }),
}

/** What went wrong, for a guest: the server's code and message, or "offline" when it was not reached. */
export function whyPublic(err) {
  if (err instanceof TypeError) return { code: 'offline', message: 'Could not reach the server. Please try again.' }
  const p = err?.problem || {}
  if (err?.status === 429) return { code: 'slow_down', message: 'Too many tries. Please wait a moment and try again.', retryAfter: err.retryAfter }
  if (err?.status === 413) return { code: 'too_large', message: 'That is too large to send.' }
  return { code: p.code || (err?.status === 404 ? 'not_found' : 'invalid'), message: err?.message || 'Something went wrong.', missing: p.missing }
}
