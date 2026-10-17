// A real two-browser test of live team chat: a real backend on a scratch database (migrated and
// seeded with the prototype's chat demo), the real frontend, and two signed-in people — Rina
// (Field staff) and Dinda (Field leader) — driving the UI in headless Chromium.
//
//   node scripts/chat-live-e2e.mjs
//
// It starts and stops everything itself: a scratch Postgres database, uvicorn on :8770, Vite on
// :5281 (live) and :5282 (a build that cannot reach any server, for the demo-mode check).
//
// What it checks is what the in-process tests cannot: that a message one person sends appears in
// the other's open browser without a reload, that "is typing" and presence and unread badges
// follow, that a file attached in one browser opens in the other, that a locked channel opens by
// itself when the request is approved, and — the one most likely to hide a bug — that a browser
// whose connection drops while messages are sent catches up on its own when it reconnects.

import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BACKEND = `${ROOT}erp-backend`
const FRONTEND = `${ROOT}erp-prototype`
const PY = `${BACKEND}/.venv/Scripts/python.exe`
const ALEMBIC = `${BACKEND}/.venv/Scripts/alembic.exe`
const DB = 'oscenia_fe_e2e'
const API = 'http://127.0.0.1:8770'
const LIVE = 'http://127.0.0.1:5281'
const DEMO = 'http://127.0.0.1:5282'
const PASSWORD = 'oscenia-demo-2026'
const DATABASE_URL = `postgresql+asyncpg://oscenia:oscenia@localhost:5433/${DB}`

const results = []
const procs = []
const T = 15_000 // how long a live update may take to show up

const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `   [${detail}]` : ''}`)
}
const step = async (name, fn) => {
  try {
    await fn()
    check(name, true)
  } catch (err) {
    check(name, false, String(err.message).split('\n').slice(0, 4).map((l) => l.trim()).join(' | ').slice(0, 700))
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

async function api(path, token, init = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) },
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}
const tokenFor = async (email) =>
  (await api('/auth/login', null, { method: 'POST', body: JSON.stringify({ email, password: PASSWORD }) })).body.access_token

// Vite's dev server may reset the very first page load while it pre-bundles dependencies.
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

async function signIn(page, base, email) {
  await visit(page, `${base}/`)
  await page.locator('input').first().fill(email)
  await page.locator('input[type="password"]').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  // Signed in when the form is gone (the page shows "DEMO ACCOUNTS" in capitals, so text is not a test).
  await page.locator('input[type="password"]').waitFor({ state: 'detached', timeout: 30_000 })
}

const composer = (page) => page.locator('textarea[placeholder^="Message"]')
const say = async (page, text) => {
  await composer(page).fill(text)
  await composer(page).press('Enter')
}

async function main() {
  console.log('setting up…')
  psql(`DROP DATABASE IF EXISTS ${DB}`)
  psql(`CREATE DATABASE ${DB}`)
  const env = { ...process.env, DATABASE_URL, ENV: 'development', LOG_LEVEL: 'WARNING', CORS_ORIGINS: JSON.stringify([LIVE, DEMO]) }
  execFileSync(ALEMBIC, ['upgrade', 'head'], { cwd: BACKEND, env, stdio: 'ignore' })
  execFileSync(PY, ['-m', 'app.seed.demo'], { cwd: BACKEND, env, stdio: 'ignore' })
  execFileSync(PY, ['-m', 'app.seed.chat'], { cwd: BACKEND, env, stdio: 'ignore' })
  execFileSync(PY, ['-m', 'app.seed.tasks'], { cwd: BACKEND, env, stdio: 'ignore' })

  start(PY, ['-m', 'uvicorn', 'app.main:app', '--port', '8770', '--log-level', 'warning'], { cwd: BACKEND, env })
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  start(npx, ['vite', '--port', '5281', '--host', '127.0.0.1', '--strictPort'], { cwd: FRONTEND, env: { ...process.env, VITE_API_URL: `${API}/api/v1` }, shell: true })
  start(npx, ['vite', '--port', '5282', '--host', '127.0.0.1', '--strictPort'], { cwd: FRONTEND, env: { ...process.env, VITE_API_URL: 'http://127.0.0.1:1/api/v1' }, shell: true })
  await waitFor(`${API}/health`, 'the API')
  await waitFor(`${LIVE}/`, 'the live frontend')
  await waitFor(`${DEMO}/`, 'the demo frontend')

  const rinaToken = await tokenFor('rina@oscenia.co.id')
  const dindaToken = await tokenFor('dinda@oscenia.co.id')
  const channelIds = {}
  for (const c of (await api('/chat/bootstrap', rinaToken)).body.channels.concat((await api('/chat/bootstrap', rinaToken)).body.discoverable)) channelIds[c.key] = c.id
  const gala = channelIds['ch-gala-general']
  const production = channelIds['ch-gala-production']

  const browser = await chromium.launch()
  const errors = { rina: [], dinda: [] }
  const watch = (name, page) => {
    page.on('pageerror', (e) => errors[name].push(`pageerror: ${e.message}`))
    page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors[name].push(`console: ${m.text()}`) })
  }

  // Rina's browser goes through a WebSocket proxy so the test can cut her connection.
  const rinaCtx = await browser.newContext()
  const rina = await rinaCtx.newPage()
  watch('rina', rina)
  const wsState = { current: null, blocked: false, opens: 0 }
  await rina.routeWebSocket(/\/chat\/ws/, (ws) => {
    wsState.opens += 1
    if (wsState.blocked) { ws.close({ code: 1011 }); return }
    const server = ws.connectToServer()
    wsState.current = { ws, server }
    ws.onMessage((m) => server.send(m))
    server.onMessage((m) => ws.send(m))
    ws.onClose((code, reason) => server.close({ code, reason }))
    server.onClose((code, reason) => ws.close({ code, reason }))
  })
  const dindaCtx = await browser.newContext()
  const dinda = await dindaCtx.newPage()
  watch('dinda', dinda)
  const dindaNet = []
  dinda.on('response', (r) => { if (/\/meetings/.test(r.url())) dindaNet.push(`${r.status()} ${r.request().method()} ${r.url().split('/api/v1')[1]}`) })

  // =====================================================================================
  console.log('\nsigning in')
  await step('Rina (a team member) signs in and lands in chat, not on a dashboard she cannot use', async () => {
    await signIn(rina, LIVE, 'rina@oscenia.co.id')
    await rina.waitForURL(/\/chat/, { timeout: T })
    await rina.getByText('announcements').first().waitFor({ timeout: T })
  })
  await step('her channels and her two direct messages are there, with their unread counts', async () => {
    // The DM row (the member list has a "Message Agus P." button too, so be specific).
    const row = rina.locator('button', { hasText: 'Agus P.' }).filter({ has: rina.locator('span.bg-rose-500') })
    const badge = row.locator('span.bg-rose-500')
    await badge.waitFor({ timeout: T })
    if ((await badge.innerText()).trim() !== '1') throw new Error('expected 1 unread in the DM from Agus')
  })
  await step('Dinda (sales in the ledger, Field leader in chat) signs in', async () => {
    await signIn(dinda, LIVE, 'dinda@oscenia.co.id')
    await dinda.goto(`${LIVE}/chat/${gala}`)
    await dinda.getByText('Client confirmed the stage layout').waitFor({ timeout: T })
  })

  console.log('\nlive messages')
  await rina.goto(`${LIVE}/chat/${gala}`)
  await step('the seeded history shows in the channel, newest last', async () => {
    await rina.getByText('Client confirmed the stage layout').waitFor({ timeout: T })
    await rina.getByText('Seating plan submitted for approval').waitFor({ timeout: T })
  })
  await step('Rina sees Dinda online in the member list', async () => {
    await rina.getByText(/Online —/).waitFor({ timeout: T })
    await rina.getByText('Dinda A.').first().waitFor({ timeout: T })
  })
  await step('Dinda typing shows as "is typing…" in Rina\'s browser', async () => {
    await composer(dinda).click()
    await composer(dinda).pressSequentially('Hello Rina, quick que', { delay: 40 })
    await rina.getByText(/Dinda is typing/).waitFor({ timeout: T })
  })
  await step('Dinda\'s message appears in Rina\'s open browser without a reload', async () => {
    await composer(dinda).fill('Hello Rina, quick question about seating')
    await composer(dinda).press('Enter')
    await rina.getByText('Hello Rina, quick question about seating').waitFor({ timeout: T })
  })
  await step('the sender sees it once, not twice (the pending copy was replaced)', async () => {
    await dinda.waitForTimeout(800)
    const n = await dinda.getByText('Hello Rina, quick question about seating').count()
    if (n !== 1) throw new Error(`appears ${n} times`)
  })
  await step('a file attached by Rina opens in Dinda\'s browser', async () => {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n')
    await rina.locator('input[type="file"]').setInputFiles({ name: 'seating-plan.pdf', mimeType: 'application/pdf', buffer: pdf })
    await rina.getByText('seating-plan.pdf').waitFor({ timeout: T })
    await rina.getByRole('button', { name: 'Send' }).waitFor()
    await composer(rina).fill('Here is the plan')
    await rina.getByRole('button', { name: 'Send' }).click()
    let sent = []
    for (let i = 0; i < 20 && !sent.some((m) => m.text === 'Here is the plan'); i++) {
      await rina.waitForTimeout(500)
      sent = (await api(`/chat/channels/${gala}/messages?limit=5`, dindaToken)).body.messages
    }
    if (!sent.some((m) => m.text === 'Here is the plan')) throw new Error('the server never got it: ' + JSON.stringify(sent.map((m) => m.text)))
    await dinda.getByText('Here is the plan').waitFor({ timeout: T })
    await dinda.getByText('seating-plan.pdf').waitFor({ timeout: T })
  })

  console.log('\nedits, reactions and deletes reach the other browser')
  const history = (await api(`/chat/channels/${gala}/messages?limit=20`, dindaToken)).body.messages
  const hello = history.find((m) => m.text === 'Hello Rina, quick question about seating')
  await step('an edit shows as "(edited)" in the other browser', async () => {
    await api(`/chat/messages/${hello.id}`, dindaToken, { method: 'PATCH', body: JSON.stringify({ text: 'Hello Rina, a quick question about the seating' }) })
    await rina.getByText('Hello Rina, a quick question about the seating').waitFor({ timeout: T })
  })
  await step('a reaction shows with its count', async () => {
    await api(`/chat/messages/${hello.id}/reactions/${encodeURIComponent('👍')}`, dindaToken, { method: 'PUT' })
    await rina.getByRole('button', { name: /👍 1/ }).waitFor({ timeout: T })
  })
  await step('a delete leaves the "message deleted" placeholder', async () => {
    await api(`/chat/messages/${hello.id}`, dindaToken, { method: 'DELETE' })
    await rina.getByText('message deleted').first().waitFor({ timeout: T })
  })

  console.log('\na locked channel, a request, and an approval')
  await step('a channel Rina may only ask into shows as locked, with her request already pending', async () => {
    await rina.goto(`${LIVE}/chat/${production}`)
    await rina.getByText(/is locked/).waitFor({ timeout: T })
    await rina.getByText('Request sent').waitFor({ timeout: T })
  })
  await step('Dinda\'s bell shows the join request, as it arrived from the server', async () => {
    await dinda.getByRole('button', { name: /Notifications/ }).click()
    await dinda.getByText(/Rina M\. wants to join #production/).waitFor({ timeout: T })
    await dinda.keyboard.press('Escape')
  })
  await step('approving it opens the channel in Rina\'s browser by itself', async () => {
    const pending = (await api(`/chat/channels/${production}/join-requests`, dindaToken)).body[0]
    await api(`/chat/join-requests/${pending.id}/decide`, dindaToken, { method: 'POST', body: JSON.stringify({ approve: true }) })
    await composer(rina).waitFor({ timeout: T })
  })
  await step('and the answer is in her bell', async () => {
    await rina.getByRole('button', { name: /Notifications/ }).click()
    await rina.getByText(/You were added to #production/).waitFor({ timeout: T })
    await rina.keyboard.press('Escape')
  })

  console.log('\nunread badges and mentions while looking elsewhere')
  await rina.goto(`${LIVE}/chat/${gala}`)
  await dinda.goto(`${LIVE}/chat/${channelIds['ch-gala-field']}`)
  await step('a message in a channel Dinda is not looking at marks it unread', async () => {
    await say(rina, 'Anyone seen the run-of-show?')
    const row = dinda.getByRole('button', { name: /^general/ }).first()
    await row.locator('span.font-semibold').waitFor({ timeout: T })
  })
  // The demo's tasks put items in everyone's bell, so what is checked is the change: one more.
  let bellBefore = 0
  let withMention = 0
  const openBell = async (page) => {
    await page.keyboard.press('Escape') // a task drawer left open covers the header
    await page.getByRole('button', { name: /^Notifications/ }).dispatchEvent('click')
  }
  const bellReads = async (page, want, what) => {
    let seen = null
    for (let i = 0; i < 30; i++) {
      seen = await unreadCount(page)
      if (seen === want) return
      await page.waitForTimeout(500)
    }
    throw new Error(`${what}: the bell showed ${seen}, expected ${want}`)
  }
  const unreadCount = async (page) => {
    const label = await page.getByRole('button', { name: /^Notifications/ }).getAttribute('aria-label')
    const m = /\((\d+) unread\)/.exec(label || '')
    return m ? Number(m[1]) : 0
  }
  await step('a mention shows a count on the channel and rings Dinda\'s bell live', async () => {
    bellBefore = await unreadCount(dinda)
    await composer(rina).click()
    await composer(rina).pressSequentially('@Dinda', { delay: 30 })
    await rina.getByRole('button', { name: /Dinda A\./ }).first().click()
    await composer(rina).pressSequentially('can you look at this?', { delay: 10 })
    await composer(rina).press('Enter')
    const badge = dinda.getByRole('button', { name: /^general/ }).first().locator('span.bg-rose-500')
    await badge.waitFor({ timeout: T })
    await openBell(dinda)
    await dinda.getByText('Mentioned you').first().waitFor({ timeout: T })
    await dinda.keyboard.press('Escape')
    withMention = await unreadCount(dinda)
  })
  await step('opening the channel clears both', async () => {
    await dinda.goto(`${LIVE}/chat/${gala}`)
    await dinda.getByText('can you look at this?').waitFor({ timeout: T })
    await openBell(dinda)
    await dinda.keyboard.press('Escape') // a read mention stays listed; what changes is the count
    let now = withMention
    for (let i = 0; i < 20 && now >= withMention; i++) {
      await dinda.waitForTimeout(500)
      now = await unreadCount(dinda)
    }
    if (now >= withMention) throw new Error(`the bell still counts it: ${now} (was ${withMention})`)
  })

  console.log('\na dropped connection, and catching up')
  await step('Rina\'s connection is cut; messages sent meanwhile appear when she reconnects, no reload', async () => {
    const opensBefore = wsState.opens
    wsState.blocked = true
    wsState.current.ws.close({ code: 1011 })
    await rina.waitForTimeout(500)
    for (const text of ['sent while you were away 1', 'sent while you were away 2']) {
      await api(`/chat/channels/${gala}/messages`, dindaToken, { method: 'POST', body: JSON.stringify({ text }) })
    }
    await rina.getByText(/Reconnecting/).waitFor({ timeout: T })
    await rina.waitForTimeout(1500)
    if (await rina.getByText('sent while you were away 2').count()) throw new Error('arrived while she was cut off')
    wsState.blocked = false
    await rina.getByText('sent while you were away 1').waitFor({ timeout: 40_000 })
    await rina.getByText('sent while you were away 2').waitFor({ timeout: 10_000 })
    if (wsState.opens <= opensBefore) throw new Error('it never tried again')
  })
  await step('after catching up the "reconnecting" banner is gone and live delivery works again', async () => {
    await rina.getByText(/Reconnecting/).waitFor({ state: 'detached', timeout: 20_000 })
    await say(dinda, 'back to normal')
    await rina.getByText('back to normal').waitFor({ timeout: T })
  })

  console.log('\nworkspace: tasks, approvals, files and the bell')
  const TITLE = 'E2E rigging check'
  const BOARD = `${LIVE}/workspace/EVT-2026-GALA-01`
  const agusToken = await tokenFor('agus@oscenia.co.id')
  await step('a team login with no finance data still sees the project cards, with who is in charge', async () => {
    await rina.goto(`${LIVE}/workspace`)
    await rina.getByText('Aurora Bank Annual Gala').first().waitFor({ timeout: T })
    await rina.getByText('Dinda A.').first().waitFor({ timeout: T })
  })
  await step('Dinda assigns Rina a task; it appears on Rina’s open board without a reload', async () => {
    await rina.goto(BOARD)
    await rina.getByText('Aurora Bank Annual Gala').first().waitFor({ timeout: T })
    await dinda.goto(BOARD)
    await dinda.getByRole('button', { name: /New task/ }).click()
    await dinda.getByPlaceholder('e.g. Confirm AV rider with venue').fill(TITLE)
    const assign = dinda.getByText('Assign to', { exact: true }).locator('xpath=following::select[1]')
    await assign.selectOption(await assign.locator('option').filter({ hasText: 'Rina M.' }).first().getAttribute('value'))
    await dinda.locator('input[type="date"]').fill('2027-01-15')
    await dinda.getByRole('button', { name: /Assign task/ }).click()
    await rina.getByText(TITLE).first().waitFor({ timeout: T })
  })
  await step('Rina’s bell says it was given to her', async () => {
    await openBell(rina)
    await rina.getByText('Assigned to you').first().waitFor({ timeout: T })
    await rina.keyboard.press('Escape')
  })
  await step('Rina starts it and attaches a file; the status and the file are on the server', async () => {
    await rina.getByText(TITLE).first().click()
    await rina.getByRole('button', { name: /^Start$/ }).click()
    await rina.getByText('Task started').first().waitFor({ timeout: T })
    await rina.locator('input[type="file"]').first().setInputFiles({ name: 'plan.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF\n') })
    await rina.getByText('plan.pdf').first().waitFor({ timeout: T })
  })
  await step('Rina submits it; Dinda’s bell asks for stage 1 and Dinda sees the file', async () => {
    await rina.getByRole('button', { name: /Submit for approval/ }).click()
    await rina.getByText('Submitted for approval').first().waitFor({ timeout: T })
    await openBell(dinda)
    await dinda.getByText('Needs your approval').first().waitFor({ timeout: T })
    await dinda.keyboard.press('Escape')
    await dinda.getByText(TITLE).first().click()
    await dinda.getByText('plan.pdf').first().waitFor({ timeout: T })
  })
  await step('Dinda gives the first approval; the PM gives the last; Rina’s open drawer follows live', async () => {
    await dinda.getByRole('button', { name: /Approve \(stage 1\)/ }).click()
    await dinda.getByText('Approved — sent to PM').first().waitFor({ timeout: T })
    const mine = (await api('/tasks', agusToken)).body.find((t) => t.title === TITLE)
    const done = await api(`/tasks/${mine.id}/approve`, agusToken, { method: 'POST' })
    if (done.status !== 200) throw new Error(`the PM's approval answered ${done.status}`)
    await rina.getByText('PM approved').locator('visible=true').first().waitFor({ timeout: T })
  })
  await step('and Rina’s bell shows the sign-off', async () => {
    await openBell(rina)
    await rina.getByText('Approved').locator('visible=true').first().waitFor({ timeout: T })
    await rina.keyboard.press('Escape')
  })
  await step('a refused change is refused by the server, not just hidden: only the assignee submits', async () => {
    const t = (await api('/tasks', agusToken)).body.find((x) => x.title === TITLE)
    const refused = await api(`/tasks/${t.id}/submit`, agusToken, { method: 'POST' })
    if (refused.status !== 403 && refused.status !== 409) throw new Error(`expected a refusal, got ${refused.status}`)
  })

  console.log('\nmeetings: what a call left behind, and minutes written on the server')
  await step('the call in the channel has a Minutes button — for the host and for someone who was on it', async () => {
    await rina.goto(`${LIVE}/chat/${gala}`) // (the workspace section left her on a task board)
    await dinda.goto(`${LIVE}/chat/${gala}`)
    await dinda.getByRole('button', { name: /^Minutes$/ }).first().waitFor({ timeout: T })
    await rina.getByRole('button', { name: /^Minutes$/ }).first().waitFor({ timeout: T })
  })
  await step('opening it shows the minutes as the server stored them', async () => {
    await dinda.getByRole('button', { name: /^Minutes$/ }).first().click()
    try {
      await dinda.getByText(/The team met for 18 minutes/).waitFor({ timeout: T })
      await dinda.getByText('Summary prepared for the demo').waitFor({ timeout: T })
    } catch (err) {
      const panel = await dinda.locator('aside').last().innerText().catch(() => '(no panel)')
      throw new Error(`panel said: ${panel.replace(/\s+/g, ' ').slice(0, 120)} | net ${dindaNet.join(' ; ')}`)
    }
  })
  await step('the host rewrites them: with no AI connected, rules write them and say so', async () => {
    await dinda.getByRole('button', { name: /Regenerate/ }).click()
    await dinda.getByText('Written without AI').first().waitFor({ timeout: T })
    await dinda.getByText(/Rule-based summary/).waitFor({ timeout: T })
  })
  await step('the host opens the minutes to the channel and posts them; the other browser sees the post live', async () => {
    await dinda.getByRole('tab', { name: 'Access' }).click()
    await dinda.getByLabel('Everyone in the channel').check()
    await dinda.getByRole('button', { name: 'Save access' }).click()
    await dinda.getByText('Access saved').waitFor({ timeout: T })
    await dinda.getByRole('tab', { name: /Summary/ }).click()
    await dinda.getByRole('button', { name: /Post summary to channel/ }).click()
    await dinda.getByText('Summary posted').first().waitFor({ timeout: T })
    await rina.getByText(/Meeting summary \(2026-07-24\)/).first().waitFor({ timeout: T })
  })
  await step('and they cannot be posted twice', async () => {
    await dinda.getByRole('button', { name: /Summary posted/ }).waitFor({ timeout: T })
    if (!(await dinda.getByRole('button', { name: /Summary posted/ }).isDisabled())) throw new Error('still clickable')
  })

  console.log('\nno errors in either browser')
  check('no script errors in Rina\'s browser', errors.rina.length === 0, errors.rina.slice(0, 3).join(' | '))
  check('no script errors in Dinda\'s browser', errors.dinda.length === 0, errors.dinda.slice(0, 3).join(' | '))

  // =====================================================================================
  console.log('\ndemo mode (no server reachable) still works as before')
  const demoCtx = await browser.newContext()
  const demo = await demoCtx.newPage()
  const demoErrors = []
  demo.on('pageerror', (e) => demoErrors.push(e.message))
  await step('a demo sign-in works with no server, and chat shows the prototype\'s own data', async () => {
    await signIn(demo, DEMO, 'agus@oscenia.co.id')
    await demo.goto(`${DEMO}/chat/ch-gala-general`)
    await demo.getByText('Client confirmed the stage layout').waitFor({ timeout: T })
  })
  await step('the demo keeps its "Viewing as" switcher and its call buttons', async () => {
    await demo.getByLabel('Viewing as').waitFor({ timeout: T })
    await demo.getByRole('button', { name: 'Voice call' }).waitFor({ timeout: T })
  })
  await step('and a message sent in demo mode appears at once', async () => {
    await composer(demo).fill('demo message')
    await composer(demo).press('Enter')
    await demo.getByText('demo message').waitFor({ timeout: T })
  })
  check('no script errors in demo mode', demoErrors.length === 0, demoErrors.slice(0, 2).join(' | '))

  await browser.close()
}

let code = 0
try {
  await main()
} catch (err) {
  console.log(`\nABORTED: ${err.message}`)
  code = 1
} finally {
  for (const p of procs) { try { p.kill() } catch { /* gone */ } }
  if (process.platform === 'win32') {
    for (const port of [8770, 5281, 5282]) {
      try { execFileSync('powershell', ['-NoProfile', '-Command', `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`], { stdio: 'ignore' }) } catch { /* nothing listening */ }
    }
  }
  await new Promise((r) => setTimeout(r, 800))
  try { psql(`DROP DATABASE IF EXISTS ${DB}`) } catch { /* ignore */ }
}
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(code || (failed.length ? 1 : 0))
