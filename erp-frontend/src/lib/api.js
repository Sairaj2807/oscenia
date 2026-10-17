// The API client.
//
// Everything the app sends to or reads from the backend goes through `request`. That is the
// same bet the backend makes with its posting engine: one door, so the token handling, the
// refresh dance, the error shape and the field-name conversion are written once instead of
// twenty-five times.
//
// ---------------------------------------------------------------------------
// Why field names are converted here
// ---------------------------------------------------------------------------
// The API is snake_case; the pages expect camelCase (`unitValue`, `postedThrough`,
// `voucherNo`). Converting at this boundary means neither side bends to the other and no
// page changes. Renaming fields across 25 pages would be a large diff that buys nothing.
//
// ---------------------------------------------------------------------------
// Why money is left alone
// ---------------------------------------------------------------------------
// The backend serialises NUMERIC(18,2) as a *string*, deliberately, so an amount never
// passes through a float on the way here. The converter must not helpfully parse it back.
// `Number('640000000.00')` happens to be exact; it will not be for every figure this system
// will eventually hold, and a silent one-rupiah drift in a balance sheet is the exact class
// of bug the backend spent eight phases making impossible.

const RAW_BASE = (import.meta.env?.VITE_API_URL || 'http://localhost:8000/api/v1').replace(/\/$/, '')
// Served from the same domain as the site, the API address is a path ('/api/v1'). `new URL` below needs
// an absolute one, so a relative base is resolved against the page it is running on.
const BASE = /^https?:\/\//i.test(RAW_BASE)
  ? RAW_BASE
  : (typeof window !== 'undefined' ? window.location.origin : 'http://localhost') + RAW_BASE

const ACCESS_KEY = 'oscenia.access'
const REFRESH_KEY = 'oscenia.refresh'

// ---------------------------------------------------------------------------
// Token storage
// ---------------------------------------------------------------------------
//
// localStorage rather than memory so a page refresh does not sign you out, and rather than a
// cookie because the API is on a different origin and this is a local-first deployment. The
// access token is short-lived (30 minutes) and the refresh token is single-use and revocable
// server-side, which is what limits the damage if this store is read.

export const tokens = {
  get access() {
    try { return localStorage.getItem(ACCESS_KEY) } catch { return null }
  },
  get refresh() {
    try { return localStorage.getItem(REFRESH_KEY) } catch { return null }
  },
  set({ accessToken, refreshToken }) {
    try {
      localStorage.setItem(ACCESS_KEY, accessToken)
      localStorage.setItem(REFRESH_KEY, refreshToken)
    } catch { /* private mode: the session simply does not survive a refresh */ }
  },
  clear() {
    try {
      localStorage.removeItem(ACCESS_KEY)
      localStorage.removeItem(REFRESH_KEY)
    } catch { /* nothing to clear */ }
  },
}

// ---------------------------------------------------------------------------
// Case conversion
// ---------------------------------------------------------------------------

const snakeToCamel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase())
const camelToSnake = (s) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)

function convertKeys(value, convert) {
  if (Array.isArray(value)) return value.map((v) => convertKeys(v, convert))
  // Date, File and friends are values, not maps. Recursing into them would produce `{}`.
  if (value === null || typeof value !== 'object' || value.constructor !== Object) return value
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [convert(k), convertKeys(v, convert)])
  )
}

export const toCamel = (value) => convertKeys(value, snakeToCamel)
export const toSnake = (value) => convertKeys(value, camelToSnake)

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

// The backend speaks RFC 7807 problem+json: `{ type, title, status, detail, ... }`. Carrying
// the status and the extras through means a caller can tell a 409 "the books refuse this"
// from a 422 "you sent something malformed" without parsing prose.
export class ApiError extends Error {
  constructor(status, problem) {
    // A schema refusal (FastAPI's own 422) carries `detail` as a list of {loc, msg}; a domain
    // refusal carries one sentence. Either way the message is something a person can read.
    const detail = Array.isArray(problem?.detail)
      ? problem.detail.map((d) => d?.msg || String(d)).join('; ')
      : problem?.detail
    super(detail || problem?.title || `Request failed with ${status}`)
    this.name = 'ApiError'
    this.status = status
    this.problem = problem || {}
    this.title = problem?.title
    // 403s name the roles that *would* be allowed, which is the difference between "no" and
    // "no, ask Finance".
    this.permitted = problem?.permitted || []
    this.action = problem?.action
    this.retryAfter = problem?.retry_after
  }
}

let refreshing = null

async function refreshAccessToken() {
  // One in-flight refresh, shared. Without this, five parallel requests all 401 at once and
  // all five try to spend the same single-use refresh token — four of them fail, and the
  // backend's reuse detection reads that as a stolen token and revokes every session.
  if (refreshing) return refreshing

  const refreshToken = tokens.refresh
  if (!refreshToken) return null

  refreshing = (async () => {
    try {
      const response = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
      })
      if (!response.ok) {
        tokens.clear()
        return null
      }
      const pair = await response.json()
      tokens.set({ accessToken: pair.access_token, refreshToken: pair.refresh_token })
      return pair.access_token
    } catch {
      return null
    } finally {
      refreshing = null
    }
  })()

  return refreshing
}

/**
 * Make one API call.
 *
 * @param {string} path      e.g. '/journal-entries'
 * @param {object} options
 * @param {string} [options.method]
 * @param {object} [options.body]    plain object; keys are converted to snake_case
 * @param {object} [options.params]  query string values; nullish entries are dropped
 * @param {boolean} [options.auth]   send the bearer token (default true)
 * @param {boolean} [options.raw]    return the Response untouched, for downloads
 */
export async function request(path, options = {}) {
  const { method = 'GET', body, params, auth = true, raw = false, retry = true, rawKeys = false, headers: extra = {} } = options

  const url = new URL(`${BASE}${path}`)
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue
    // Repeated keys for arrays — FastAPI reads `?codes=1101&codes=1102` as a list.
    if (Array.isArray(value)) value.forEach((v) => url.searchParams.append(camelToSnake(key), v))
    else url.searchParams.append(camelToSnake(key), value)
  }

  // A file upload is multipart: the browser must write the Content-Type itself (it carries the
  // boundary) and the body goes through untouched — never JSON-stringified.
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData
  // `extra` carries a public caller's token (X-Guest-Token, X-Client-Key): never the session.
  const headers = { ...extra }
  if (body !== undefined && !isForm) headers['Content-Type'] = 'application/json'
  const token = auth ? tokens.access : null
  if (token) headers.Authorization = `Bearer ${token}`

  const response = await fetch(url, {
    method,
    headers,
    // `rawKeys` sends the body's keys exactly as written: for the one place the keys are data, not
    // field names (an invitation's content: `mapUrl`, `trackId`), which snake-casing would corrupt.
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(rawKeys ? body : toSnake(body)),
  })

  // A 401 means the access token expired. Refresh once and replay — but only once, or an
  // endpoint that legitimately rejects this user would loop forever.
  if (response.status === 401 && auth && retry) {
    const fresh = await refreshAccessToken()
    if (fresh) return request(path, { ...options, retry: false })
  }

  if (raw) {
    if (!response.ok) throw new ApiError(response.status, await safeProblem(response))
    return response
  }

  if (response.status === 204) return null

  if (!response.ok) throw new ApiError(response.status, await safeProblem(response))

  const text = await response.text()
  return text ? toCamel(JSON.parse(text)) : null
}

async function safeProblem(response) {
  // An error body is not guaranteed to be JSON — a proxy or a crash can return HTML, and
  // failing to parse it must not replace the real status with a parse error.
  try {
    return await response.json()
  } catch {
    return { title: response.statusText, status: response.status }
  }
}

/**
 * POST a file with progress and cancel (`fetch` has neither for an upload). Resolves with the
 * camel-cased JSON reply; rejects with an `ApiError` for a refusal, a `TypeError` when the server
 * could not be reached (as `fetch` does, so callers tell "offline" the same way), and an
 * `AbortError` when `signal` cancels it.
 *
 * @param {string} path
 * @param {FormData} form
 * @param {object} [options]
 * @param {object} [options.params]      query string values
 * @param {object} [options.headers]     e.g. `X-Client-Key` for a public caller
 * @param {boolean} [options.auth]       send the bearer token (default true)
 * @param {(fraction: number) => void} [options.onProgress]  0..1 as the body goes out
 * @param {AbortSignal} [options.signal]
 */
export function uploadFile(path, form, options = {}) {
  const { params, headers = {}, auth = true, onProgress, signal, retry = true } = options
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Upload cancelled', 'AbortError'))
    const url = new URL(`${BASE}${path}`)
    for (const [key, value] of Object.entries(params || {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.append(camelToSnake(key), value)
    }
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url.toString())
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value)
    if (auth && tokens.access) xhr.setRequestHeader('Authorization', `Bearer ${tokens.access}`)
    if (onProgress) xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total) }
    xhr.onerror = () => reject(new TypeError('Network request failed'))
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'))
    xhr.onload = async () => {
      // An expired access token: refresh once and send the file again (never twice).
      if (xhr.status === 401 && auth && retry) {
        const fresh = await refreshAccessToken()
        if (fresh) return resolve(uploadFile(path, form, { ...options, retry: false }))
      }
      let body = null
      try { body = xhr.responseText ? JSON.parse(xhr.responseText) : null } catch { /* an HTML error page */ }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(body ? toCamel(body) : null)
      return reject(new ApiError(xhr.status, body || { title: xhr.statusText, status: xhr.status }))
    }
    signal?.addEventListener('abort', () => xhr.abort(), { once: true })
    xhr.send(form)
  })
}

export const api = {
  get: (path, params) => request(path, { params }),
  post: (path, body, params) => request(path, { method: 'POST', body: body ?? {}, params }),
  put: (path, body) => request(path, { method: 'PUT', body: body ?? {} }),
  patch: (path, body) => request(path, { method: 'PATCH', body: body ?? {} }),
  delete: (path) => request(path, { method: 'DELETE' }),
  /** POST a `FormData` (a file). */
  upload: (path, form) => request(path, { method: 'POST', body: form }),
  /** PUT a `FormData` (a file with fields), for a record that is replaced rather than added. */
  uploadPut: (path, form) => request(path, { method: 'PUT', body: form }),
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export async function login(email, password) {
  const pair = await request('/auth/login', {
    method: 'POST',
    body: { email, password },
    auth: false,
  })
  tokens.set({ accessToken: pair.accessToken, refreshToken: pair.refreshToken })
  return pair
}

export async function me() {
  return request('/auth/me')
}

export async function logout() {
  const refreshToken = tokens.refresh
  try {
    // The refresh token is what gets revoked — the access token expires on its own in thirty
    // minutes whatever we do here. Signing out without naming it would leave a valid refresh
    // token alive for a fortnight.
    if (refreshToken) {
      await request('/auth/logout', { method: 'POST', body: { refreshToken } })
    }
  } catch {
    // Signing out locally must succeed even when the server cannot be reached. The refresh
    // token is discarded either way; the server-side revocation is best-effort.
  } finally {
    tokens.clear()
  }
}

/**
 * Sign out of every device: the server revokes all of this person's refresh tokens. Unlike `logout`,
 * a failure is thrown, not swallowed: "signed out everywhere" must not be said when the server did
 * not do it. The local tokens are cleared only once it has.
 */
export async function logoutEverywhere() {
  await request('/auth/logout-everywhere', { method: 'POST' })
  tokens.clear()
}

export const apiBase = BASE

/** Where a guest's browser fetches an uploaded file: the public media route, by the upload's id. */
export const mediaUrl = (id) => `${BASE}/public/media/${encodeURIComponent(id)}`

/**
 * A path the server returned for a file (`/api/v1/files/…?exp=…&sig=…`) as a full URL on the API's
 * own origin. The page may be served from somewhere else (another port in development, a CDN),
 * and a bare path would then be looked up on the wrong host.
 */
export function fileUrl(path) {
  if (!path || /^(https?:|blob:|data:)/i.test(path)) return path
  try {
    return new URL(BASE).origin + path
  } catch {
    return path
  }
}
