// A real click-through of the events screens: a real backend on a scratch database (migrated and
// seeded with the demo, which includes the demo events), the real frontend, and signed-in people
// driving the UI in headless Chromium.
//
//   node scripts/events-live-e2e.mjs
//
// For each action it clicks the screen, asks the SERVER whether the change is there, then reloads
// the page and checks the screen still shows it: a screen that reads the server, and a button that
// saves.
//
// Starts and stops everything itself: scratch database oscenia_ev_e2e, uvicorn :8772, Vite :5284.

import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BACKEND = `${ROOT}erp-backend`
const FRONTEND = `${ROOT}erp-frontend`
const PY = `${BACKEND}/.venv/Scripts/python.exe`
const ALEMBIC = `${BACKEND}/.venv/Scripts/alembic.exe`
const DB = 'oscenia_ev_e2e'
const API = 'http://127.0.0.1:8772'
const LIVE = 'http://127.0.0.1:5284'
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

  start(PY, ['-m', 'uvicorn', 'app.main:app', '--port', '8772', '--log-level', 'warning'], { cwd: BACKEND, env })
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  start(npx, ['vite', '--port', '5284', '--host', '127.0.0.1', '--strictPort'], { cwd: FRONTEND, env: { ...process.env, VITE_API_URL: `${API}/api/v1` }, shell: true })
  await waitFor(`${API}/health`, 'the API')
  await waitFor(`${LIVE}/`, 'the frontend')

  token = (await api('/auth/login', { method: 'POST', body: JSON.stringify({ email: 'rahmat@oscenia.co.id', password: PASSWORD }) })).body.access_token

  const browser = await chromium.launch()
  const errors = []
  const failedCalls = []
  const eventCalls = []
  const newPage = async (label) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    // Toasts disappear after a few seconds, long before a step gives up: keep every one that shows.
    await ctx.addInitScript(() => {
      window.__toasts = []
      new MutationObserver(() => {
        document.querySelectorAll('div.card.animate-pop').forEach((el) => {
          const text = el.innerText.replace(/\s+/g, ' ').trim()
          if (text && !window.__toasts.includes(text)) window.__toasts.push(text)
        })
      }).observe(document, { childList: true, subtree: true })
    })
    const page = await ctx.newPage()
    globalThis.__page = page
    page.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.message}`))
    page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(`${label} console: ${m.text()}`) })
    page.on('response', (r) => {
      const u = r.url()
      if (u.includes('/api/v1/events') || u.includes('/api/v1/invitation-templates')) eventCalls.push({ label, status: r.status(), url: u.split('/api/v1')[1] })
      if (u.includes('/api/v1') && r.request().method() !== 'GET') sentCalls.push(`${r.status()} ${r.request().method()} ${u.split('/api/v1')[1]}`)
      if (u.includes('/api/v1') && r.status() >= 400 && r.request().method() !== 'GET') failedCalls.push(`${r.status()} ${r.request().method()} ${u.split('/api/v1')[1]}`)
    })
    return page
  }

  const events = async () => (await api('/events')).body
  const guestsOf = async (id) => (await api(`/events/${id}/guests`)).body

  // =====================================================================================
  console.log('\nthe CEO reads the server events')
  const ceo = await newPage('ceo')
  await step('the CEO signs in against the real backend', async () => {
    await signIn(ceo, 'rahmat@oscenia.co.id')
  })
  let list = await events()
  check('the backend has the demo events to show', list.length >= 1, `${list.length} events`)

  await step('the events list is the server list: every event, and the numbers on each card', async () => {
    await open(ceo, '/events', list[0].name)
    for (const ev of list) await ceo.getByText(ev.name, { exact: true }).first().waitFor({ timeout: T })
    const first = list[0]
    const grid = ceo.locator(`a[href$="/events/${first.event_no}"]`).locator('div.grid.grid-cols-4').first()
    await grid.waitFor({ timeout: T })
    const shown = (await grid.locator('div.tabular-nums').allInnerTexts()).map((t) => Number(t.trim()))
    const want = [first.stats.invited, first.stats.attending, first.stats.declined, first.stats.no_response]
    if (JSON.stringify(shown) !== JSON.stringify(want)) throw new Error(`card shows ${shown} but the server says ${want}`)
  })

  await step('an event made elsewhere shows up (nothing here is a browser-only copy)', async () => {
    const made = await api('/events', { method: 'POST', body: JSON.stringify({ name: 'E2E Live Event', date: '2026-12-10', venue: 'Somewhere' }) })
    if (made.status !== 201) throw new Error(`could not create: ${made.status}`)
    await open(ceo, '/events', 'E2E Live Event')
    await visit(ceo, `${LIVE}/events`)
    await ceo.getByText('E2E Live Event', { exact: true }).first().waitFor({ timeout: T })
  })

  await step('opening an event shows its server guests', async () => {
    list = await events()
    let target = null
    let guests = []
    for (const ev of list) {
      guests = await guestsOf(ev.id)
      if (guests.length) { target = ev; break }
    }
    if (!target) throw new Error('no event with guests to open')
    await open(ceo, `/events/${target.event_no}?tab=guests`, target.name)
    for (const g of guests.slice(0, 4)) await ceo.getByText(g.name, { exact: true }).first().waitFor({ timeout: T })
  })

  await step('the invitation tab opens for a published event', async () => {
    const published = list.find((e) => e.status === 'Published')
    if (!published) throw new Error('no published event')
    await open(ceo, `/events/${published.event_no}?tab=invitation`, published.name)
    const detail = (await api(`/events/${published.id}`)).body
    if (!detail.invite.template_id) throw new Error('published event with no template')
    await ceo.getByText(/Live preview|Published|Unpublish/).first().waitFor({ timeout: T })
  })

  await step('the report tab opens without error for an event with guests', async () => {
    const withGuests = list.find((e) => e.stats.invited > 0)
    if (!withGuests) throw new Error('no event with an invited guest')
    await open(ceo, `/events/${withGuests.event_no}?tab=report`, withGuests.name)
    await ceo.waitForTimeout(800)
  })


  // =====================================================================================
  console.log('\nthe CEO edits: event, invitation, review, publish')
  await api('/clients', { method: 'POST', body: JSON.stringify({ name: 'E2E Client' }) })
  let made = null
  await step('a new event is made from the form, saved on the server, and still there after a reload', async () => {
    await open(ceo, '/events', 'Events')
    await ceo.getByRole('button', { name: /New event/ }).click()
    await mfield(ceo, 'Event name').fill('E2E Form Event')
    await mfield(ceo, 'Date').fill('2026-12-20')
    await mfield(ceo, 'Venue').fill('Hall A')
    await modal(ceo).getByRole('button', { name: /Create & design/ }).click()
    made = await until('the event', events, (es) => es.find((e) => e.name === 'E2E Form Event'))
    if (made.venue !== 'Hall A' || made.date !== '2026-12-20') throw new Error(`saved as ${made.date} at ${made.venue}`)
    await ceo.waitForURL(`**/events/${made.event_no}`, { timeout: T })
    await visit(ceo, `${LIVE}/events/${made.event_no}?tab=invitation`)
    await ceo.getByText('E2E Form Event').first().waitFor({ timeout: T })
  })

  await step('choosing a template is saved on the server', async () => {
    await open(ceo, `/events/${made.event_no}?tab=invitation`, 'Use this template')
    await ceo.getByRole('button', { name: 'Use this template' }).first().click()
    await until('a template', async () => (await api(`/events/${made.id}`)).body, (d) => d.invite.template_id)
  })

  await step('typing in the invitation is saved a moment later, and survives a reload', async () => {
    await open(ceo, `/events/${made.event_no}?tab=invitation`, 'Live preview')
    // The Cover section is open when the editor opens.
    await ceo.getByText('Title', { exact: true }).first().locator('xpath=following::input[1]').fill('E2E Cover Title')
    await until('the cover title', async () => (await api(`/events/${made.id}`)).body, (d) => d.invite.content.cover.title === 'E2E Cover Title' && d)
    await visit(ceo, `${LIVE}/events/${made.event_no}?tab=invitation`)
    await ceo.getByText('E2E Cover Title').first().waitFor({ timeout: T })
  })

  await step('content keys reach the server as written (mapUrl, not map_url)', async () => {
    await open(ceo, `/events/${made.event_no}?tab=invitation`, 'Live preview')
    await ceo.getByText('Date & venue', { exact: true }).first().click()
    await ceo.getByText('Map link', { exact: true }).first().locator('xpath=following::input[1]').fill('https://maps.example/e2e')
    const d = await until('the map link', async () => (await api(`/events/${made.id}`)).body, (x) => x.invite.content.details.mapUrl === 'https://maps.example/e2e' && x)
    if ('map_url' in d.invite.content.details) throw new Error('the server stored map_url as well')
  })

  await step('Review & publish publishes on the server, and the screen says so', async () => {
    await open(ceo, `/events/${made.event_no}?tab=invitation`, 'Live preview')
    await ceo.getByRole('button', { name: /Review & publish/ }).first().click()
    await modal(ceo).getByRole('button', { name: /^Publish/ }).click()
    await until('published', async () => (await api(`/events/${made.id}`)).body, (d) => d.status === 'Published' && d.invite.published && d)
    await ceo.getByRole('button', { name: /Unpublish/ }).first().waitFor({ timeout: T })
  })

  await step('Unpublish takes it back to a draft on the server', async () => {
    ceo.once('dialog', (dlg) => dlg.accept())
    await ceo.getByRole('button', { name: /Unpublish/ }).first().click()
    await until('a draft again', async () => (await api(`/events/${made.id}`)).body, (d) => d.status === 'Draft')
  })

  await step('Revoke makes a new client link on the server', async () => {
    const before = (await api(`/events/${made.id}/client-link`)).body.token
    await open(ceo, `/events/${made.event_no}`, 'Revoke')
    ceo.once('dialog', (dlg) => dlg.accept())
    await ceo.getByRole('button', { name: /Revoke/ }).first().click()
    await until('a new link', async () => (await api(`/events/${made.id}/client-link`)).body, (l) => l.token !== before)
  })

  console.log('\nTemplate Studio')
  await step('a built-in is duplicated into a studio template and added to the gallery, on the server', async () => {
    const before = ((await api('/invitation-templates')).body).filter((t) => !t.builtin).length
    await open(ceo, '/events/templates', 'Built-in templates')
    await ceo.getByRole('button', { name: /^Duplicate/ }).first().click()
    await until('a studio template', async () => (await api('/invitation-templates')).body, (ts) => ts.filter((t) => !t.builtin).length === before + 1)
    await ceo.getByRole('button', { name: 'Add to gallery' }).first().click()
    await until('published', async () => (await api('/invitation-templates')).body, (ts) => ts.some((t) => !t.builtin && t.status === 'published'))
  })


  // =====================================================================================
  console.log('\nthe CEO runs the guest list and the door')
  const guestRow = (page, name) => page.locator('tr').filter({ hasText: name }).first()
  const serverGuest = async (name) => (await guestsOf(made.id)).find((g) => g.name === name)

  await step('a guest added from the form is saved on the server and is there after a reload', async () => {
    await open(ceo, `/events/${made.event_no}?tab=guests`, 'Add guest')
    await ceo.getByRole('button', { name: /Add guest/ }).click()
    await ceo.getByPlaceholder('Full name', { exact: true }).fill('E2E Guest')
    await ceo.getByPlaceholder('Phone', { exact: true }).fill('0812 9999 0001')
    await ceo.getByRole('button', { name: 'Add', exact: true }).click()
    await until('the guest', async () => guestsOf(made.id), (gs) => gs.find((g) => g.name === 'E2E Guest'))
    await visit(ceo, `${LIVE}/events/${made.event_no}?tab=guests`)
    await ceo.getByText('E2E Guest').first().waitFor({ timeout: T })
  })

  await step('the category and the table are saved on the server', async () => {
    await open(ceo, `/events/${made.event_no}?tab=guests`, 'E2E Guest')
    await guestRow(ceo, 'E2E Guest').locator('select[aria-label="Category"]').selectOption('VIP')
    await until('VIP', async () => guestsOf(made.id), (gs) => gs.find((g) => g.name === 'E2E Guest' && g.category === 'VIP'))
    const table = guestRow(ceo, 'E2E Guest').locator('input[aria-label^="Table"]')
    await table.fill('T9')
    await table.press('Enter')
    await until('table T9', async () => guestsOf(made.id), (gs) => gs.find((g) => g.name === 'E2E Guest' && g.table === 'T9'))
  })

  await step('a guest is checked in at the desk and the check-in can be undone, on the server', async () => {
    await open(ceo, `/events/${made.event_no}?tab=checkin`, 'Check-in')
    await ceo.getByPlaceholder('Or search by name or phone').fill('E2E Guest')
    await ceo.getByRole('button', { name: /E2E Guest/ }).first().click()
    await ceo.getByRole('button', { name: /^Check in at/ }).click()
    await until('arrived', async () => guestsOf(made.id), (gs) => gs.find((g) => g.name === 'E2E Guest' && g.checked_in_at))
    await ceo.getByRole('button', { name: /Undo last scan/ }).click()
    await until('not arrived', async () => guestsOf(made.id), (gs) => gs.find((g) => g.name === 'E2E Guest' && !g.checked_in_at))
  })

  await step('the desk registers a walk-in from the screen: the server adds them as a walk-in and checks them in', async () => {
    // The desk form only works for a published event.
    const pub = await api(`/events/${made.id}/publish`, { method: 'POST', body: JSON.stringify({}) })
    if (pub.status !== 200) throw new Error(`could not publish for the desk: ${pub.status}`)
    await open(ceo, `/events/${made.event_no}?tab=checkin`, 'Check-in')
    await ceo.getByRole('button', { name: /Register a walk-in here/ }).click()
    await modal(ceo).getByLabel('Full name').fill('E2E Walker')
    await modal(ceo).getByLabel('Phone number (WhatsApp)').fill('0813 7777 0002')
    await modal(ceo).getByRole('button', { name: /Register and check in/ }).click()
    const w = await until('the walk-in', async () => guestsOf(made.id), (gs) => gs.find((g) => g.name === 'E2E Walker' && g.walk_in && g.checked_in_at))
    if (w.consent !== false) throw new Error('consent was recorded without the box being ticked')
    await ceo.getByText('E2E Walker').first().waitFor({ timeout: T })
  })

  await step('staff erase a guest on their request: the row is anonymised on the server and the numbers stay', async () => {
    const before = await serverGuest('E2E Guest')
    const stats = (await api(`/events/${made.id}/report`)).body.stats
    await open(ceo, `/events/${made.event_no}?tab=guests`, 'E2E Guest')
    ceo.once('dialog', (dlg) => dlg.accept())
    await ceo.getByRole('button', { name: 'Erase personal data — E2E Guest' }).click()
    const gone = await until('the erased guest', async () => guestsOf(made.id), (gs) => gs.find((g) => g.id === before.id && g.erased_at))
    if (gone.name !== 'Erased guest' || gone.phone !== '') throw new Error(`not anonymised: ${gone.name} / ${gone.phone}`)
    const after = (await api(`/events/${made.id}/report`)).body.stats
    if (after.invited !== stats.invited) throw new Error('the invited count moved')
    await ceo.getByText('Personal data erased').first().waitFor({ timeout: T })
  })

  await step('a checkpoint added at the desk is saved on the server', async () => {
    await open(ceo, `/events/${made.event_no}?tab=checkin`, 'Check-in')
    await ceo.getByRole('button', { name: 'Checkpoints', exact: true }).click()
    await ceo.getByPlaceholder('e.g. Goodie Bag').fill('E2E Goodie Bag')
    await ceo.getByRole('button', { name: /Add checkpoint/ }).click()
    await until('the checkpoint', async () => (await api(`/events/${made.id}`)).body, (d) => d.checkpoints.some((c) => c.name === 'E2E Goodie Bag') && d)
  })

  await step('a question is added and typed, and the label is saved a moment later', async () => {
    await open(ceo, `/events/${made.event_no}?tab=invitation`, 'Live preview')
    await ceo.getByText('RSVP settings', { exact: true }).first().click()
    await ceo.getByRole('button', { name: /Add question/ }).click()
    const q = await until('a question', async () => (await api(`/events/${made.id}`)).body, (d) => d.questions.length >= 1 && d)
    await ceo.getByLabel('Question', { exact: true }).first().fill('E2E meal?')
    await until('the label', async () => (await api(`/events/${made.id}`)).body, (d) => d.questions.some((x) => x.label === 'E2E meal?') && d)
    if (!q.questions[0].key.startsWith('Q-')) throw new Error(`unexpected question key ${q.questions[0].key}`)
  })

  await step('a wish is hidden on the server (an event that has wishes)', async () => {
    const all = await events()
    let target = null
    for (const ev of all) {
      const ws = (await api(`/events/${ev.id}/wishes`)).body
      if (ws.length) { target = { ev, wish: ws[0] }; break }
    }
    if (!target) throw new Error('no event with wishes')
    await open(ceo, `/events/${target.ev.event_no}?tab=invitation`, 'Live preview')
    await ceo.getByText('Wishes', { exact: true }).first().click()
    await ceo.getByRole('button', { name: 'Hide', exact: true }).first().click()
    await until('a hidden wish', async () => (await api(`/events/${target.ev.id}/wishes`)).body, (ws) => ws.some((w) => w.hidden) && ws)
  })

  // =====================================================================================
  console.log('\nother roles')
  await step('Sales sees the same events', async () => {
    const sales = await newPage('sales')
    await signIn(sales, 'dinda@oscenia.co.id')
    const all = await events()
    await open(sales, '/events', all[0].name)
    for (const ev of all) await sales.getByText(ev.name, { exact: true }).first().waitFor({ timeout: T })
  })
  await step('Finance never asks for events (it would only be refused)', async () => {
    const fin = await newPage('finance')
    await signIn(fin, 'lina@oscenia.co.id')
    await fin.waitForTimeout(3000)
    const asked = eventCalls.filter((c) => c.label === 'finance')
    if (asked.length) throw new Error(`finance made ${asked.length} events request(s): ${asked.map((c) => `${c.status} ${c.url}`).slice(0, 3).join(', ')}`)
  })

  // =====================================================================================
  console.log('\nthe whole run')
  const refused = eventCalls.filter((c) => c.status >= 400).map((c) => `${c.status} ${c.url}`)
  check('no request the app made was refused by the server', failedCalls.length === 0 && refused.length === 0, failedCalls.concat(refused).slice(0, 6).join(' | '))
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
