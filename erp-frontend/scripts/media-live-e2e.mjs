// A real run of MEDIA UPLOAD: staff and the client upload a photo and a video through the real editor,
// and a guest, signed out in another browser, sees them. Real backend on a scratch database, real
// frontend; the script asks the server what was stored and fetches the files the way a phone would.
//
//   node scripts/media-live-e2e.mjs
//
// Starts and stops everything itself: scratch database oscenia_media_e2e, uvicorn :8774, Vite :5286.

import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BACKEND = `${ROOT}erp-backend`
const FRONTEND = `${ROOT}erp-frontend`
const PY = `${BACKEND}/.venv/Scripts/python.exe`
const ALEMBIC = `${BACKEND}/.venv/Scripts/alembic.exe`
const DB = 'oscenia_media_e2e'
const API = 'http://127.0.0.1:8774'
const LIVE = 'http://127.0.0.1:5286'
const PASSWORD = 'oscenia-demo-2026'
const DATABASE_URL = `postgresql+asyncpg://oscenia:oscenia@localhost:5433/${DB}`

const results = []
const sentCalls = []
const procs = []
const T = 15_000

const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `   [${detail}]` : ''}`)
}
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY, 'i') : null
const SHOTS = process.env.SHOTS || ''
const step = async (name, fn) => {
  if (ONLY && !ONLY.test(name)) return
  try {
    await fn()
    check(name, true)
  } catch (err) {
    let onScreen = ''
    try {
      const toasts = await globalThis.__page.evaluate(() => window.__toasts || [])
      onScreen = toasts.slice(-3).join(' / ')
    } catch { /* page gone */ }
    if (onScreen) err.message += ` | on screen: ${onScreen}`
    if (SHOTS && globalThis.__page) await globalThis.__page.screenshot({ path: `${SHOTS}/${name.replace(/\W+/g, '_').slice(0, 60)}.png` }).catch(() => {})
    check(name, false, `${String(err.message)}${sentCalls.length ? ` | last requests: ${sentCalls.slice(-3).join('; ')}` : ''}`.split('\n').slice(0, 4).map((l) => l.trim()).join(' | ').slice(0, 700))
  }
}

const psql = (sql) =>
  execFileSync('docker', ['exec', 'oscenia-erp-db', 'psql', '-U', 'oscenia', '-d', 'postgres', '-c', sql], { stdio: 'ignore' })

function start(cmd, args, opts) {
  const p = spawn(cmd, args, { shell: false, ...opts, stdio: ['ignore', 'pipe', 'pipe'] })
  p.stderr.on('data', () => {})
  p.stdout.on('data', () => {})
  procs.push(p)
  return p
}

async function waitFor(url, label) {
  for (let i = 0; i < 120; i += 1) {
    try {
      if ((await fetch(url)).status < 500) return
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`${label} never came up`)
}

let token = null
async function api(path, init = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) },
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

/** Ask the server until `pick` finds something (a click's request may still be in flight). */
async function until(what, load, pick, tries = 30) {
  let last
  for (let i = 0; i < tries; i += 1) {
    last = await load()
    const found = pick(last)
    if (found) return found
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`the server never showed: ${what}`)
}

async function visit(page, url) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await page.goto(url, { timeout: 60_000 })
      return
    } catch (err) {
      if (attempt >= 4) throw err
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
}

async function signIn(page, email) {
  await visit(page, `${LIVE}/`)
  await page.locator('input').first().fill(email)
  await page.locator('input[type="password"]').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.locator('input[type="password"]').waitFor({ state: 'detached', timeout: 30_000 })
}

/** The input that follows a form label. */
const field = (page, label, kind = 'input') =>
  page.getByText(label, { exact: true }).first().locator(`xpath=following::${kind}[1]`)

/** The open pop-up (rendered into <body>, over the page). */
const modal = (page) => page.locator('div.fixed.inset-0.z-50 > div.relative').last()
const mfield = (page, label, kind = 'input') =>
  modal(page).getByText(label, { exact: true }).first().locator(`xpath=following::${kind}[1]`)

/** Land on a screen and wait until the app has loaded the server's data (not the seed). */
async function open(page, path, waitText) {
  await visit(page, `${LIVE}${path}`)
  if (waitText) await page.getByText(waitText).first().waitFor({ timeout: T })
}

async function main() {
  console.log('setting up…')
  psql(`DROP DATABASE IF EXISTS ${DB}`)
  psql(`CREATE DATABASE ${DB}`)
  const env = { ...process.env, DATABASE_URL, ENV: 'development', LOG_LEVEL: 'WARNING', CORS_ORIGINS: JSON.stringify([LIVE]) }
  execFileSync(ALEMBIC, ['upgrade', 'head'], { cwd: BACKEND, env, stdio: 'ignore' })
  execFileSync(PY, ['-m', 'app.seed.demo'], { cwd: BACKEND, env, stdio: 'ignore' })

  start(PY, ['-m', 'uvicorn', 'app.main:app', '--port', '8774', '--log-level', 'warning'], { cwd: BACKEND, env })
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  start(npx, ['vite', '--port', '5286', '--host', '127.0.0.1', '--strictPort'], { cwd: FRONTEND, env: { ...process.env, VITE_API_URL: `${API}/api/v1` }, shell: true })
  await waitFor(`${API}/health`, 'the API')
  await waitFor(`${LIVE}/`, 'the frontend')

  token = (await api('/auth/login', { method: 'POST', body: JSON.stringify({ email: 'rahmat@oscenia.co.id', password: PASSWORD }) })).body.access_token

  const browser = await chromium.launch()
  const errors = []
  const failedCalls = []
  const newPage = async (label) => {
    const ctx = await browser.newContext({ viewport: { width: 430, height: 900 } })
    const page = await ctx.newPage()
    globalThis.__page = page
    page.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.message}`))
    page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(`${label} console: ${m.text()}`) })
    page.on('response', (r) => {
      const u = r.url()
      if (u.includes('/api/v1') && r.status() >= 500) failedCalls.push(`${r.status()} ${r.request().method()} ${u.split('/api/v1')[1]}`)
    })
    return page
  }


  const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body ?? {}) })
  const put = (path, body) => api(path, { method: 'PUT', body: JSON.stringify(body ?? {}) })
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  // An ISO base-media header and filler: the server checks the signature, not that it plays.
  const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(8), Buffer.alloc(4096, 7)])

  const ev = (await post('/events', { name: 'E2E Media Gala', date: '2026-12-20', venue: 'Hall A' })).body
  await put(`/events/${ev.id}/invite/template`, { template_id: 'gala' })
  const detail = async () => (await api(`/events/${ev.id}`)).body
  const mediaUrlOf = (ref) => `${API}/api/v1/public/media/${ref.key}`

  console.log('\nstaff upload in the editor, signed in')
  const staff = await newPage('staff')
  await signIn(staff, 'rahmat@oscenia.co.id')

  await step('a gallery photo is uploaded, saved in the invitation and shown from the server', async () => {
    await open(staff, `/events/${ev.event_no}?tab=invitation`, 'Live preview')
    await staff.getByRole('button', { name: /^Gallery/ }).click()
    await staff.locator('input[type=file][multiple]').last().setInputFiles({ name: 'dot.png', mimeType: 'image/png', buffer: PNG })
    const d = await until('the photo in the draft', detail, (x) => x.invite.content.gallery.photos?.length === 1 && x, 12).catch(async (err) => {
      const alert = await staff.getByRole('alert').allInnerTexts().catch(() => [])
      throw new Error(`${err.message}; on screen: ${alert.join(' / ') || 'no alert'}`)
    })
    const ref = d.invite.content.gallery.photos[0]
    if (!/^[0-9a-f-]{36}$/.test(ref.key)) throw new Error(`the key is not an upload id: ${ref.key}`)
    await staff.waitForFunction(() => [...document.images].some((i) => i.src.includes('/public/media/') && i.naturalWidth > 0), null, { timeout: T })
  })

  await step('a video is uploaded and listed by name', async () => {
    await staff.getByRole('button', { name: /^Video/ }).click()
    const uploadVideo = staff.getByRole('button', { name: 'Upload a video' })
    if (await uploadVideo.count()) await uploadVideo.click()
    await staff.locator('input[type=file][accept^="video"]').setInputFiles({ name: 'clip.mp4', mimeType: 'video/mp4', buffer: MP4 })
    const d = await until('the video in the draft', detail, (x) => x.invite.content.video?.file?.name === 'clip.mp4' && x)
    if (d.invite.content.video.kind !== 'upload') throw new Error('the video is not marked as an upload')
    await staff.getByText('clip.mp4').first().waitFor({ timeout: T })
  })

  await step('a file the server refuses shows its reason and saves nothing', async () => {
    const before = (await detail()).invite.content.gallery.photos.length
    await staff.getByRole('button', { name: /^Gallery/ }).click()
    // Looks like a PNG to the browser (name and type), is not one to the server.
    await staff.locator('input[type=file][multiple]').last().setInputFiles({ name: 'fake.png', mimeType: 'image/png', buffer: Buffer.from('this is not an image at all') })
    await staff.getByRole('alert').first().waitFor({ timeout: T })
    await new Promise((r) => setTimeout(r, 800))
    if ((await detail()).invite.content.gallery.photos.length !== before) throw new Error('a bad file was added to the gallery')
  })

  console.log('\nthe client uploads through the edit link, signed out')
  const clientKey = (await api(`/events/${ev.id}/client-link`)).body.token
  const client = await newPage('client')
  await step('the client adds a photo and the server holds it', async () => {
    await visit(client, `${LIVE}/invite/${ev.event_no}/edit?key=${encodeURIComponent(clientKey)}`)
    await client.getByText('Changes save as you type').first().waitFor({ timeout: T })
    await client.getByRole('button', { name: /^Gallery/ }).click()
    await client.locator('input[type=file][multiple]').last().setInputFiles({ name: 'client.png', mimeType: 'image/png', buffer: PNG })
    const d = await until('the client photo', detail, (x) => x.invite.content.gallery.photos?.length === 2 && x)
    if (new Set(d.invite.content.gallery.photos.map((p) => p.key)).size !== 2) throw new Error('both photos share one id')
    await client.waitForFunction(() => [...document.images].some((i) => i.src.includes('/public/media/') && i.naturalWidth > 0), null, { timeout: T })
  })

  console.log('\na guest on another device, signed out')
  const published = await post(`/events/${ev.id}/publish`, {})
  check('staff publish the invitation', published.status === 200)
  const content = (await detail()).invite.content
  const photo = content.gallery.photos[0]
  const video = content.video.file

  const guest = await newPage('guest')
  await step('the guest sees the uploaded photos and needs no staff session', async () => {
    await visit(guest, `${LIVE}/invite/${ev.event_no}`)
    await guest.getByRole('button', { name: /Open invitation/ }).click()
    await guest.getByRole('dialog', { name: 'Invitation cover' }).waitFor({ state: 'detached', timeout: T })
    await guest.waitForFunction(() => [...document.images].filter((i) => i.src.includes('/public/media/') && i.naturalWidth > 0).length >= 2, null, { timeout: T })
  })

  await step('the guest page points the video at the server, not at this browser', async () => {
    await guest.waitForFunction(() => Boolean(document.querySelector('video[src*="/public/media/"]')) || /can.t be played/.test(document.body.innerText), null, { timeout: T })
    const src = await guest.locator('video').first().getAttribute('src').catch(() => null)
    if (src && src.startsWith('blob:')) throw new Error('the video is read from this browser')
  })

  await step('the file is served without a login, cached, and the video can be seeked', async () => {
    const res = await guest.request.get(mediaUrlOf(photo))
    if (res.status() !== 200 || !String(res.headers()['content-type']).startsWith('image/')) throw new Error(`photo ${res.status()}`)
    if (!/public/.test(res.headers()['cache-control'] || '')) throw new Error('not publicly cacheable')
    const part = await guest.request.get(mediaUrlOf(video), { headers: { Range: 'bytes=0-99' } })
    if (part.status() !== 206 || (await part.body()).length !== 100) throw new Error(`range gave ${part.status()}`)
  })

  await step('a made-up id is the same 404 as one that never existed', async () => {
    const a = await guest.request.get(`${API}/api/v1/public/media/00000000-0000-4000-8000-000000000000`)
    const b = await guest.request.get(`${API}/api/v1/public/media/not-an-id`)
    if (a.status() !== 404 || b.status() !== 404) throw new Error(`${a.status()} / ${b.status()}`)
  })

  await step('content cannot name a file that is not this event’s', async () => {
    const other = (await post('/events', { name: 'Someone else', date: '2026-12-21' })).body
    const form = new FormData()
    form.append('file', new Blob([PNG], { type: 'image/png' }), 'x.png')
    const up = await fetch(`${API}/api/v1/events/${other.id}/media?kind=photo`, { method: 'POST', body: form, headers: { Authorization: `Bearer ${token}` } })
    const foreign = await up.json()
    await put(`/events/${ev.id}/invite/content/gallery`, { value: { title: '', photos: [foreign, { key: 'm-local', name: 'x', size: 1, type: 'image/png' }] } })
    const d = await detail()
    if (d.invite.content.gallery.photos.length !== 0) throw new Error('a foreign or browser-local file was kept')
  })

  // =====================================================================================
  console.log('\nthe whole run')
  check('no server error (5xx) in any request', failedCalls.length === 0, failedCalls.slice(0, 5).join(' | '))
  check('no script errors in the browser', errors.length === 0, errors.slice(0, 3).join(' | ').slice(0, 500))

  await browser.close()
  for (const p of procs) { try { p.kill() } catch { /* already gone */ } }
  const passed = results.filter((r) => r.ok).length
  console.log(`\n${passed}/${results.length} checks passed`)
  process.exit(passed === results.length ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  for (const p of procs) { try { p.kill() } catch { /* already gone */ } }
  process.exit(2)
})
