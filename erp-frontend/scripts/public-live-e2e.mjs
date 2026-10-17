// A real run of the PUBLIC pages, signed out, as a guest's phone would see them: a real backend on a
// scratch database, the real frontend, and several separate browser contexts with no login.
// Staff set the event up through the API; the guest, the stranger, the walk-in desk and the client
// then use only the links they were handed, and the script asks the server what actually happened.
//
//   node scripts/public-live-e2e.mjs
//
// Starts and stops everything itself: scratch database oscenia_pub_e2e, uvicorn :8773, Vite :5285.

import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BACKEND = `${ROOT}erp-backend`
const FRONTEND = `${ROOT}erp-prototype`
const PY = `${BACKEND}/.venv/Scripts/python.exe`
const ALEMBIC = `${BACKEND}/.venv/Scripts/alembic.exe`
const DB = 'oscenia_pub_e2e'
const API = 'http://127.0.0.1:8773'
const LIVE = 'http://127.0.0.1:5285'
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

  start(PY, ['-m', 'uvicorn', 'app.main:app', '--port', '8773', '--log-level', 'warning'], { cwd: BACKEND, env })
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  start(npx, ['vite', '--port', '5285', '--host', '127.0.0.1', '--strictPort'], { cwd: FRONTEND, env: { ...process.env, VITE_API_URL: `${API}/api/v1` }, shell: true })
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

  // ---- staff set-up through the API ------------------------------------------------------------
  const jakartaDay = (offsetDays) => {
    const d = new Date(Date.now() + offsetDays * 86400000)
    return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' })
  }
  const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body ?? {}) })
  const put = (path, body) => api(path, { method: 'PUT', body: JSON.stringify(body ?? {}) })

  async function publishedEvent(name, day) {
    const ev = (await post('/events', { name, date: day, venue: 'Grand Ballroom' })).body
    await put(`/events/${ev.id}/invite/template`, { template_id: 'gala' })
    const q = (await post(`/events/${ev.id}/questions`, { type: 'dropdown' })).body
    await api(`/events/${ev.id}/questions/${q.key}`, { method: 'PATCH', body: JSON.stringify({ label: 'Meal', options: ['Beef', 'Fish'], required: true }) })
    await post(`/events/${ev.id}/guests`, {
      guests: [
        { name: 'Dewi Wijaya', phone: '0812 1100 2200', email: 'dewi@example.id', category: 'VIP', table: 'VIP 1' },
        { name: 'Budi Santoso', phone: '0812 1100 3300' },
      ],
    })
    const pub = await post(`/events/${ev.id}/publish`, {})
    if (pub.status !== 200) throw new Error(`could not publish ${name}: ${pub.status}`)
    const guests = (await api(`/events/${ev.id}/guests`)).body
    return { ...ev, question: q.key, guests }
  }

  console.log('\nstaff publish an event')
  await api('/auth/login', { method: 'POST', body: JSON.stringify({ email: 'rahmat@oscenia.co.id', password: PASSWORD }) }).then((r) => { token = r.body.access_token })
  const gala = await publishedEvent('E2E Public Gala', jakartaDay(30))
  const dewi = gala.guests.find((g) => g.name === 'Dewi Wijaya')
  const budi = gala.guests.find((g) => g.name === 'Budi Santoso')
  const guestGuests = async () => (await api(`/events/${gala.id}/guests`)).body
  check('the event is published and the guests have personal links', Boolean(dewi?.link_token && budi?.link_token))

  const invite = (query = '') => `${LIVE}/invite/${gala.event_no}${query}`

  // The page is locked while the cover fades (about half a second): wait it out, as a person would.
  const openInvitation = async (page) => {
    await page.getByRole('button', { name: /Open invitation/ }).click()
    await page.getByRole('dialog', { name: 'Invitation cover' }).waitFor({ state: 'detached', timeout: T })
  }


  // ---- a guest, on their phone, signed out -------------------------------------------------------
  console.log('\na guest on their personal link')
  const guestPage = await newPage('guest')
  await step('the invitation opens signed out and shows nothing about other guests', async () => {
    await visit(guestPage, invite(`?g=${encodeURIComponent(dewi.link_token)}`))
    await guestPage.getByRole('button', { name: /Open invitation/ }).waitFor({ timeout: T })
    const text = await guestPage.locator('body').innerText()
    for (const secret of ['Budi', '0812 1100 3300', 'VIP 1']) if (text.includes(secret)) throw new Error(`${secret} is on the page`)
    await openInvitation(guestPage)
  })

  await step('the form is filled in for Dewi, who replies, and the server has it', async () => {
    const form = guestPage.locator('form').filter({ hasText: 'RSVP' }).first()
    await form.waitFor({ timeout: T })
    if ((await form.getByPlaceholder('Full name').inputValue()) !== 'Dewi Wijaya') throw new Error('the personal link did not fill the form in')
    await form.getByRole('button', { name: 'Joyfully accept' }).click()
    await form.locator('select').last().selectOption('Fish')
    await form.getByRole('button', { name: /Send RSVP/ }).click()
    await guestPage.getByText('You’re on the list').waitFor({ timeout: T })
    const row = await until('Dewi replied', guestGuests, (gs) => gs.find((g) => g.id === dewi.id && g.rsvp === 'Attending' && g.answers?.[gala.question] === 'Fish'))
    if (row.table !== 'VIP 1') throw new Error('the reply overwrote the table staff set')
  })

  await step('a wish is sent and shown on the invitation', async () => {
    await guestPage.getByPlaceholder('Write your wish…').fill('Congratulations from Dewi!')
    await guestPage.getByRole('button', { name: 'Send wish' }).click()
    await guestPage.getByText('Your wish is on the invitation').waitFor({ timeout: T })
    const wishes = (await api(`/events/${gala.id}/wishes`)).body
    if (!wishes.some((w) => w.text === 'Congratulations from Dewi!' && w.name === 'Dewi Wijaya')) throw new Error('the wish is not on the server, signed with the listed name')
  })

  await step('reopening on this device remembers the reply without the link', async () => {
    await visit(guestPage, invite())
    await guestPage.getByRole('button', { name: /Open invitation/ }).click()
    await guestPage.getByText('You’re on the list').waitFor({ timeout: T })
  })

  console.log('\na stranger on the shared link')
  const stranger = await newPage('stranger')
  await step('a stranger replies and becomes an off-list guest', async () => {
    await visit(stranger, invite())
    await openInvitation(stranger)
    const form = stranger.locator('form').filter({ hasText: 'RSVP' }).first()
    await form.getByPlaceholder('Full name').fill('Siti Rahma')
    await form.getByPlaceholder('Phone number (WhatsApp)').fill('0811 5555 0001')
    await form.getByRole('button', { name: 'Joyfully accept' }).click()
    await form.locator('select').last().selectOption('Beef')
    await form.getByRole('button', { name: /Send RSVP/ }).click()
    await stranger.getByText('You’re on the list').waitFor({ timeout: T })
    await until('Siti is off the list', guestGuests, (gs) => gs.find((g) => g.name === 'Siti Rahma' && g.on_master_list === false))
  })

  await step('the guest stops news and offers from their own page, and keeps their reply', async () => {
    await stranger.getByRole('button', { name: 'Stop news and offers' }).click()
    await stranger.getByText('We will not keep your details for news and offers').waitFor({ timeout: T })
    const siti = (await guestGuests()).find((g) => g.name === 'Siti Rahma')
    if (!siti || siti.consent !== false || siti.rsvp !== 'Attending') throw new Error('the reply or the consent is wrong on the server')
  })

  await step('the guest deletes their data: the server anonymises the row and the old link stops working', async () => {
    await stranger.getByRole('button', { name: 'Delete my data' }).click()
    await stranger.getByRole('button', { name: 'Yes, delete my data' }).click()
    await stranger.getByText('Your data was deleted').waitFor({ timeout: T })
    const before = (await guestGuests())
    const gone = before.find((g) => g.erased_at)
    if (!gone || gone.name !== 'Erased guest' || gone.phone !== '' || gone.rsvp !== 'Attending') throw new Error(`the row is ${JSON.stringify(gone)}`)
    if (before.some((g) => g.name === 'Siti Rahma')) throw new Error('Siti is still on the list')
    await visit(stranger, invite())
    const stored = await stranger.evaluate((no) => localStorage.getItem(`oscenia.guest.${no}`), gala.event_no)
    if (stored) throw new Error('this browser still remembers the personal link')
  })

  await step('typing a replied guest\'s phone without their link is refused and changes nothing', async () => {
    const other = await newPage('other')
    await visit(other, invite())
    await openInvitation(other)
    const form = other.locator('form').filter({ hasText: 'RSVP' }).first()
    await form.getByPlaceholder('Full name').fill('Mallory')
    await form.getByPlaceholder('Phone number (WhatsApp)').fill('0812 1100 2200')
    await form.getByRole('button', { name: 'Regretfully decline' }).click()
    await form.getByRole('button', { name: /Send RSVP/ }).click()
    await other.getByText(/already replied/i).waitFor({ timeout: T })
    const row = (await guestGuests()).find((g) => g.id === dewi.id)
    if (row.rsvp !== 'Attending' || row.name !== 'Dewi Wijaya') throw new Error('Dewi\'s reply was overwritten')
  })

  await step('an unpublished or unknown event says "not available"', async () => {
    const page = await newPage('missing')
    await visit(page, `${LIVE}/invite/EV-9999`)
    await page.getByText('This invitation is not available').waitFor({ timeout: T })
  })

  // ---- the walk-in desk --------------------------------------------------------------------------
  console.log('\nthe walk-in desk')
  const tonight = await publishedEvent('E2E Tonight', jakartaDay(0))
  const desk = (await api(`/events/${tonight.id}/walkin-link`)).body.token
  const walk = (query) => `${LIVE}/walkin/${tonight.event_no}${query}`

  await step('without the venue\'s link the walk-in form is not available', async () => {
    const page = await newPage('desk-no-link')
    await visit(page, walk(''))
    await page.getByText('This registration link is not available').waitFor({ timeout: T })
  })

  await step('with the desk link a walk-in registers and is checked in', async () => {
    const page = await newPage('desk')
    await visit(page, walk(`?w=${encodeURIComponent(desk)}`))
    await page.getByPlaceholder('Full name').fill('Walker Wibowo')
    await page.getByPlaceholder('Phone number').fill('0813 4444 5555')
    await page.getByRole('button', { name: 'Check me in' }).click()
    await page.getByText('You’re checked in').waitFor({ timeout: T })
    const walker = await until('the walk-in', async () => (await api(`/events/${tonight.id}/guests`)).body, (gs) => gs.find((g) => g.name === 'Walker Wibowo' && g.walk_in && g.checked_in_at))
    if (!walker) throw new Error('not recorded')
  })

  await step('a listed guest at the desk is checked in, not added twice', async () => {
    const page = await newPage('desk-listed')
    await visit(page, walk(`?w=${encodeURIComponent(desk)}`))
    await page.getByPlaceholder('Full name').fill('Dewi')
    await page.getByPlaceholder('Phone number').fill('0812 1100 2200')
    await page.getByRole('button', { name: 'Check me in' }).click()
    await page.getByText(/found you on the guest list/i).waitFor({ timeout: T })
    const guests = (await api(`/events/${tonight.id}/guests`)).body
    if (guests.filter((g) => g.name.startsWith('Dewi')).length !== 1) throw new Error('Dewi was added a second time')
  })

  // ---- the client's edit link --------------------------------------------------------------------
  console.log('\nthe client\'s edit link')
  const clientKey = (await api(`/events/${gala.id}/client-link`)).body.token
  const edit = (key) => `${LIVE}/invite/${gala.event_no}/edit?key=${encodeURIComponent(key)}`
  const clientPage = await newPage('client')

  await step('a wrong key is refused', async () => {
    const page = await newPage('client-bad')
    await visit(page, edit('garbage'))
    await page.getByText('This link is not valid').waitFor({ timeout: T })
  })

  await step('the client opens the editor, types, and the server draft changes', async () => {
    await visit(clientPage, edit(clientKey))
    await clientPage.getByText('Changes save as you type').first().waitFor({ timeout: T })
    await clientPage.getByText('Title', { exact: true }).first().locator('xpath=following::input[1]').fill('Client Cover Title')
    await until('the draft', async () => (await api(`/events/${gala.id}`)).body, (d) => d.invite.content.cover.title === 'Client Cover Title' && d)
  })

  await step('the client submits for review and staff see it came from the client', async () => {
    await clientPage.getByRole('button', { name: /Submit for review|Send again for review/ }).click()
    const detail = await until('submitted', async () => (await api(`/events/${gala.id}`)).body, (d) => d.review.state === 'submitted' && d)
    if (detail.review.submitted_by !== 'client') throw new Error(`submitted by ${detail.review.submitted_by}`)
    if (detail.status !== 'Published') throw new Error('the client cannot unpublish')
  })

  await step('after the staff regenerate the client link the old key stops working', async () => {
    await post(`/events/${gala.id}/client-link/regenerate`)
    const page = await newPage('client-old')
    await visit(page, edit(clientKey))
    await page.getByText('This link is not valid').waitFor({ timeout: T })
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
