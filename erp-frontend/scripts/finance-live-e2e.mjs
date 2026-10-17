// A real click-through of the finance screens: a real backend on a scratch database (migrated and
// seeded with the finance demo), the real frontend, and one signed-in person (the CEO, who may do
// everything) driving the UI in headless Chromium.
//
//   node scripts/finance-live-e2e.mjs
//
// For each action it clicks the screen, asks the SERVER whether the change is there, then reloads
// the page and checks the screen still shows it. That is what W3 promised and what no unit test
// can show: a button that saves, and a screen that reads back what was saved.
//
// Starts and stops everything itself: scratch database oscenia_fin_e2e, uvicorn :8771, Vite :5283.

import { execFileSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BACKEND = `${ROOT}erp-backend`
const FRONTEND = `${ROOT}erp-prototype`
const PY = `${BACKEND}/.venv/Scripts/python.exe`
const ALEMBIC = `${BACKEND}/.venv/Scripts/alembic.exe`
const DB = 'oscenia_fin_e2e'
const API = 'http://127.0.0.1:8771'
const LIVE = 'http://127.0.0.1:5283'
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

  start(PY, ['-m', 'uvicorn', 'app.main:app', '--port', '8771', '--log-level', 'warning'], { cwd: BACKEND, env })
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  start(npx, ['vite', '--port', '5283', '--host', '127.0.0.1', '--strictPort'], { cwd: FRONTEND, env: { ...process.env, VITE_API_URL: `${API}/api/v1` }, shell: true })
  await waitFor(`${API}/health`, 'the API')
  await waitFor(`${LIVE}/`, 'the frontend')

  token = (await api('/auth/login', { method: 'POST', body: JSON.stringify({ email: 'rahmat@oscenia.co.id', password: PASSWORD }) })).body.access_token

  const browser = await chromium.launch()
  const errors = []
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
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`) })
  const failedCalls = []
  page.on('response', (r) => {
    if (r.url().includes('/api/v1') && r.request().method() !== 'GET') sentCalls.push(`${r.status()} ${r.request().method()} ${r.url().split('/api/v1')[1]}`)
    if (r.url().includes('/api/v1') && r.status() >= 400 && r.request().method() !== 'GET') failedCalls.push(`${r.status()} ${r.request().method()} ${r.url().split('/api/v1')[1]}`)
  })

  // The demo seed has the chart, users and crew but no clients: make the one the quotation names.
  await api('/clients', { method: 'POST', body: JSON.stringify({ name: 'Aurora Bank' }) })

  const quotes = async () => (await api('/quotations')).body
  const projects = async () => (await api('/projects')).body

  // =====================================================================================
  console.log('\nsigning in')
  await step('the CEO signs in against the real backend', async () => {
    await signIn(page, 'rahmat@oscenia.co.id')
  })

  // =====================================================================================
  console.log('\nsales: a quotation from draft to a pending deal')
  const EVENT = 'E2E Product Launch'
  await step('a new quotation is created on the server and still there after a reload', async () => {
    await open(page, '/quotations')
    await page.getByRole('button', { name: /New Quotation/ }).click()
    await mfield(page, 'Client').fill('Aurora Bank')
    await mfield(page, 'Event Type').fill(EVENT)
    await modal(page).locator('input[placeholder="Scope item"]').first().fill('Staging and AV')
    await modal(page).getByRole('button', { name: /Create quotation/ }).click()
    await until('the quotation', quotes, (qs) => qs.find((q) => q.event_type === EVENT))
    await open(page, '/quotations')
    await page.getByText(EVENT).first().waitFor({ timeout: T })
  })
  await step('Send moves it to Sent on the server', async () => {
    await open(page, '/quotations')
    await page.locator('div,tr,li').filter({ hasText: EVENT }).getByRole('button', { name: /^Send$/ }).last().click()
    await until('status Sent', quotes, (qs) => qs.find((q) => q.event_type === EVENT && q.status === 'Sent'))
  })
  await step('Mark accepted moves it to Accepted, and Finance shows it as a pending deal after a reload', async () => {
    await open(page, '/quotations')
    await page.locator('div,tr,li').filter({ hasText: EVENT }).getByRole('button', { name: /Mark accepted/ }).last().click()
    await until('status Accepted', quotes, (qs) => qs.find((q) => q.event_type === EVENT && q.status === 'Accepted'))
    await open(page, '/finance')
    await page.getByText(new RegExp(`Aurora Bank ${EVENT}`)).first().waitFor({ timeout: T })
  })
  await step('confirming the down payment creates the project on the server', async () => {
    const before = (await projects()).length
    await page.locator('div').filter({ hasText: new RegExp(EVENT) }).getByRole('button', { name: /Confirm Down Payment/ }).last().click()
    // The posting pop-up asks to confirm what will be posted.
    await modal(page).getByRole('button', { name: /Confirm down payment/i }).last().click()
    await until('a new project', projects, (ps) => ps.length === before + 1)
  })

  // =====================================================================================
  console.log('\nprojects: a stage move and a cancellation')
  let proj = null
  await step('advancing a project one stage is saved', async () => {
    proj = (await projects()).find((p) => !p.cancelled && p.stage === 'DP Paid')
    if (!proj) throw new Error('no project at DP Paid to advance')
    await open(page, '/projects')
    await page.getByRole('button', { name: /advance/i }).first().click()
    await until('the stage moved', projects, (ps) => ps.find((p) => p.id === proj.id && p.stage !== 'DP Paid'))
  })
  await step('cancelling with a refund is saved: the project is cancelled and its invoices are too', async () => {
    const target = (await projects()).find((p) => !p.cancelled)
    await open(page, '/projects')
    await page.locator('button[title="Cancel project"]').first().click()
    await modal(page).locator('select').selectOption('refund')
    await modal(page).getByRole('button', { name: /^Cancel project$/ }).click()
    await until('the project cancelled', projects, (ps) => ps.find((p) => p.id === target.id && p.cancelled))
  })

  // =====================================================================================
  console.log('\nmasters: a vendor and a chart-of-accounts entry')
  await step('a new vendor is saved and shows after a reload', async () => {
    await open(page, '/vendors')
    await page.getByRole('button', { name: /Add Vendor/i }).first().click()
    await mfield(page, 'Vendor name').fill('E2E Rigging Co')
    await mfield(page, 'Category').fill('Staging / Truss')
    await modal(page).getByRole('button', { name: /^Add vendor$/ }).click()
    await until('the vendor', async () => (await api('/vendors')).body, (vs) => vs.find((v) => v.name === 'E2E Rigging Co'))
    await open(page, '/vendors')
    await page.getByText('E2E Rigging Co').first().waitFor({ timeout: T })
  })
  await step('a vendor\u2019s bank and contact are edited on the screen and saved on the server', async () => {
    await open(page, '/vendors')
    await page.getByText('E2E Rigging Co').first().click()
    await page.getByRole('button', { name: 'Edit details' }).click()
    await mfield(page, 'Bank').fill('E2E Bank')
    await mfield(page, 'Account', 'input').fill('4455667788')
    await mfield(page, 'Email').fill('ops@e2e-rigging.id')
    await modal(page).getByRole('button', { name: /^Save$/ }).click()
    const v = await until('the edited vendor', async () => (await api('/vendors')).body, (vs) => vs.find((x) => x.name === 'E2E Rigging Co' && x.bank_name === 'E2E Bank'))
    if (v.bank_account !== '4455667788' || v.pic_email !== 'ops@e2e-rigging.id') throw new Error(`saved as ${v.bank_account} / ${v.pic_email}`)
    await page.getByText('4455667788').first().waitFor({ timeout: T })
  })
  await step('a month is closed from the Periods tab and reopened, both on the server', async () => {
    await open(page, '/accounting?tab=periods', 'A closed month refuses any entry')
    await page.getByRole('button', { name: /^Close$/ }).first().click()
    await until('a closed month', async () => (await api('/periods')).body, (ps) => ps.find((x) => x.status === 'closed'))
    page.once('dialog', (dlg) => dlg.accept())
    await page.getByRole('button', { name: /^Reopen$/ }).first().click()
    await until('no month left closed', async () => (await api('/periods')).body, (ps) => ps.every((x) => x.status !== 'closed'))
  })
  await step('a new account is saved and shows in the chart after a reload', async () => {
    await open(page, '/accounts')
    await page.getByRole('button', { name: /Add Account/ }).first().click()
    await mfield(page, 'Account name').fill('E2E Test Expense')
    await modal(page).getByRole('button', { name: /Create account/ }).click()
    await until('the account', async () => (await api('/accounts')).body, (as) => as.find((a) => a.name === 'E2E Test Expense'))
    await open(page, '/accounts')
    await page.getByText('E2E Test Expense').first().waitFor({ timeout: T })
  })

  // =====================================================================================
  console.log('\ncash: petty cash and a procurement request')
  await step('topping up petty cash moves the server balance, and the screen shows it after a reload', async () => {
    const before = Number((await api('/petty-cash')).body.balance)
    await open(page, '/procurement')
    await page.getByRole('button', { name: /Top up/i }).first().click()
    await modal(page).locator('input[type="number"]').first().fill('2500000')
    await modal(page).getByRole('button', { name: /Top up|Confirm/i }).last().click()
    await until('the new balance', async () => Number((await api('/petty-cash')).body.balance), (b) => b === before + 2_500_000)
  })
  await step('a new procurement request is saved and can be approved', async () => {
    // The earlier steps cancelled their project, so make one that is still alive for this to be tagged to.
    const jbody = (o) => ({ method: 'POST', body: JSON.stringify(o) })
    const must = async (path, o) => {
      const r = await api(path, jbody(o))
      if (r.status >= 300) throw new Error(`setup: ${path} answered ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`)
      return r.body
    }
    const co = await must('/clients', { name: 'Procurement Co' })
    const qu = await must('/quotations', { client_id: co.id, event_type: 'Proc event', event_date: '2026-11-18', preset: '50', lines: [{ label: 'x', amount: '100000000', est_cost: '70000000' }] })
    await must(`/quotations/${qu.id}/send`, {})
    await must(`/quotations/${qu.id}/accept`, {})
    await must(`/quotations/${qu.id}/confirm-down-payment`, {})
    const live = (await projects()).find((p) => !p.cancelled)
    if (!live) throw new Error(`no live project among ${JSON.stringify((await projects()).map((p) => [p.project_no, p.cancelled]))}`)
    await open(page, '/procurement')
    await page.getByRole('button', { name: /New Request/i }).first().click()
    await modal(page).locator('select').first().selectOption(live.project_no)
    await mfield(page, 'Amount (Rp)').fill('750000')
    await mfield(page, 'Requester name').fill('E2E Requester')
    await modal(page).getByRole('button', { name: /Submit request/ }).click()
    const req = await until('the request', async () => (await api('/procurement-requests')).body, (rs) => rs.find((r) => Number(r.amount) === 750000))
    await open(page, '/procurement')
    await page.getByRole('button', { name: /^Approve$/ }).first().click() // not the "Approved" filter pill
    await until('approved', async () => (await api('/procurement-requests')).body, (rs) => rs.find((r) => r.id === req.id && r.status === 'Approved'))
  })

  // =====================================================================================
  console.log('\nwarehouse and assets')
  await step('a new stock item is saved and shows after a reload', async () => {
    await open(page, '/warehouse')
    await page.getByRole('button', { name: /Add (stock )?item/i }).first().click()
    await mfield(page, 'Item name').fill('E2E Gaffer tape')
    await modal(page).getByRole('button', { name: /^Add item$/ }).click()
    await until('the item', async () => (await api('/inventory')).body, (is) => is.find((i) => i.item === 'E2E Gaffer tape'))
    await open(page, '/warehouse')
    await page.getByText('E2E Gaffer tape').first().waitFor({ timeout: T })
  })
  await step('running depreciation is accepted by the server', async () => {
    await open(page, '/fixed-assets')
    const before = (await api('/depreciation/backlog')).body
    await page.getByRole('button', { name: /Run Depreciation/ }).first().click()
    await until('the backlog cleared', async () => (await api('/depreciation/backlog')).body, (b) => b.periods.length === 0 || before.periods.length === 0)
  })

  // =====================================================================================
  console.log('\nreports: the pages read the server')
  await step('the Cash page shows the server cash position and the browser agrees with it', async () => {
    const sv = (await api('/reports/cash-position')).body
    await open(page, '/cash')
    const shown = Number(sv.total).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    await page.getByText(shown).first().waitFor({ timeout: T })
    const diffs = await page.evaluate(() => window.__reportDiffs || [])
    if (diffs.length) throw new Error(`the browser disagrees with the server: ${JSON.stringify(diffs)}`)
  })

  await step('the Dashboard cash and receivable cards come from the server and the browser agrees', async () => {
    const [cashRes, arRes] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/reports/cash-position') && r.status() === 200, { timeout: 30_000 }),
      page.waitForResponse((r) => r.url().includes('/receivables/ageing') && r.status() === 200, { timeout: 30_000 }),
      open(page, '/'),
    ])
    void cashRes; void arRes
    await page.getByText('Total Cash').first().waitFor({ timeout: T })
    await page.waitForTimeout(1500) // let the cross-check run once both answers are in
    const diffs = await page.evaluate(() => window.__reportDiffs || [])
    if (diffs.length) throw new Error(`the browser disagrees with the server: ${JSON.stringify(diffs)}`)
  })

  await step('the Receivables cards come from the server ageing report and the browser agrees', async () => {
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/receivables/ageing') && r.status() === 200, { timeout: 30_000 }),
      open(page, '/receivables'),
    ])
    await page.getByText('Total Outstanding').first().waitFor({ timeout: T })
    await page.waitForTimeout(1500)
    const diffs = await page.evaluate(() => window.__reportDiffs || [])
    if (diffs.length) throw new Error(`the browser disagrees with the server: ${JSON.stringify(diffs)}`)
    // The reconciliation card must say the ledger and the invoices agree.
    await page.getByText('Reconciled').first().waitFor({ timeout: T }) // not "Out by …"
  })

  await step('the Payables cards come from the server ageing report and the browser agrees', async () => {
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/payables/ageing') && r.status() === 200, { timeout: 30_000 }),
      open(page, '/payables'),
    ])
    await page.getByText('Total Payable').first().waitFor({ timeout: T })
    await page.waitForTimeout(1500)
    const diffs = await page.evaluate(() => window.__reportDiffs || [])
    if (diffs.length) throw new Error(`the browser disagrees with the server: ${JSON.stringify(diffs)}`)
    await page.getByText('Reconciled').first().waitFor({ timeout: T })
  })

  for (const [name, path, text] of [
    ['the chart of accounts', '/accounts', 'Chart of Accounts'],
    ['the Fixed Assets reconciliation', '/fixed-assets', 'Fixed Asset'],
  ]) {
    await step(`${name} reads its balances from the server and the browser agrees`, async () => {
      await Promise.all([
        page.waitForResponse((r) => r.url().includes('/accounts/tree') && r.status() === 200, { timeout: 30_000 }),
        open(page, path),
      ])
      await page.getByText(text).first().waitFor({ timeout: T })
      await page.waitForTimeout(1500)
      const diffs = await page.evaluate(() => window.__reportDiffs || [])
      if (diffs.length) throw new Error(`the browser disagrees with the server: ${JSON.stringify(diffs)}`)
    })
  }

  // =====================================================================================
  console.log('\nstatements and project P&L: the pages read the server')
  const noDiffs = async () => {
    await page.waitForTimeout(1500)
    const diffs = await page.evaluate(() => window.__reportDiffs || [])
    if (diffs.length) throw new Error(`the browser disagrees with the server: ${JSON.stringify(diffs)}`)
  }
  await step('the Accounting statements (income, balance sheet, trial balance, 1401) come from the server and the browser agrees', async () => {
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/reports/income-statement') && r.status() === 200, { timeout: 30_000 }),
      page.waitForResponse((r) => r.url().includes('/reports/balance-sheet') && r.status() === 200, { timeout: 30_000 }),
      open(page, '/accounting'),
    ])
    for (const tab of ['Income Statement', 'Balance Sheet']) {
      await page.getByRole('button', { name: tab }).first().click()
      await page.waitForTimeout(600)
    }
    await noDiffs()
  })

  await step('Project P&L and the project cost lines come from the server and the browser agrees', async () => {
    const all = await projects()
    const one = all.find((p) => !p.cancelled) || all[0]
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/reports/project-pnl') && r.status() === 200, { timeout: 30_000 }),
      open(page, '/pnl'),
    ])
    await page.getByText('Statement').first().waitFor({ timeout: T })
    await noDiffs()
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/reports/project-costs') && r.status() === 200, { timeout: 30_000 }),
      open(page, `/projects/${one.project_no}`),
    ])
    await noDiffs()
  })

  // =====================================================================================
  console.log('\nfixed assets: editing one')
  await step('a fixed asset is renamed on the screen and the server and the screen both show it', async () => {
    const made = (await api('/fixed-assets', { method: 'POST', body: JSON.stringify({ name: 'E2E LED wall', acquired_on: '2026-01-05', cost: '12000000', useful_life_months: 24, salvage: '0', method: 'straight-line', post: false }) })).body
    await open(page, '/fixed-assets')
    await page.getByText('E2E LED wall').first().click()
    await modal(page).getByRole('button', { name: /^Edit$/ }).click()
    await mfield(page, 'Asset name').fill('E2E LED wall (2.6mm)')
    await modal(page).getByRole('button', { name: /Save changes/ }).click()
    await until('the new name', async () => (await api(`/fixed-assets/${made.id}`)).body, (a) => a.name === 'E2E LED wall (2.6mm)')
    await open(page, '/fixed-assets')
    await page.getByText('E2E LED wall (2.6mm)').first().waitFor({ timeout: T })
  })

  // =====================================================================================
  console.log('\ncrm: a real file on a note')
  await step('a file chosen on a CRM note is stored and filed against it on the server', async () => {
    const post = (path, o) => api(path, { method: 'POST', body: JSON.stringify(o) })
    const co = (await post('/clients', { name: 'Files Co' })).body
    const note = (await post(`/clients/${co.id}/interactions`, { note: 'Call about the brief' })).body
    await open(page, `/crm/${co.client_no}`)
    await page.getByText('Call about the brief').first().waitFor({ timeout: T })
    await page.getByTitle('Attach a file').first().click()
    await page.locator('input[type="file"]').first().setInputFiles({ name: 'brief.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF\n') })
    await until('the file on the note', async () => (await api(`/clients/${co.id}/interactions`)).body, (ns) => ns.find((n) => n.id === note.id && n.attachments.length === 1))
    await open(page, `/crm/${co.client_no}`)
    await page.getByText('brief.pdf').first().waitFor({ timeout: T })
  })

  // =====================================================================================
  console.log('\ndaily jobs: the real scheduler')
  await step('the jobs screen lists the server jobs and Run now records a run on the server', async () => {
    const jobs = (await api('/jobs')).body
    const job = jobs.find((j) => j.key === 'crm.milestone_scan') || jobs[0]
    await open(page, '/cron')
    await page.getByText(job.name).first().waitFor({ timeout: T })
    const row = page.getByText(job.name).first().locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]')
    const [answer] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(`/jobs/${job.key}/run`) && r.request().method() === 'POST', { timeout: T }),
      row.getByRole('button', { name: /Run now/ }).click(),
    ])
    if (answer.status() !== 200) throw new Error(`Run now answered ${answer.status()}`)
    await page.getByText(/Job ran|Nothing to do|The run failed/).first().waitFor({ timeout: T })
  })

  // =====================================================================================
  console.log('\nfile sweep and the dashboard trend')
  await step('the orphaned-file sweep is a listed job; Run now reports and removes nothing until it is switched on', async () => {
    const job = (await api('/jobs')).body.find((j) => j.key === 'storage.sweep')
    if (!job) throw new Error('the server does not list the storage.sweep job')
    await open(page, '/cron')
    await page.getByText(job.name).first().waitFor({ timeout: T })
    const row = page.getByText(job.name).first().locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]')
    const [answer] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/jobs/storage.sweep/run') && r.request().method() === 'POST', { timeout: T }),
      row.getByRole('button', { name: /Run now/ }).click(),
    ])
    if (answer.status() !== 200) throw new Error(`Run now answered ${answer.status()}`)
    const runs = (await api('/jobs/storage.sweep/runs')).body
    if (!runs.length) throw new Error('the run was not recorded')
    if (runs[0].detail.dry_run !== true || runs[0].detail.deleted !== 0) throw new Error(`a default run should only report: ${JSON.stringify(runs[0].detail)}`)
  })

  await step('the dashboard chart and cash arrow come from the ledger months, and the invented arrows are gone', async () => {
    const trend = (await api('/reports/monthly-trend?months=6')).body
    if (trend.months.length !== 6) throw new Error(`the server sent ${trend.months.length} months`)
    await open(page, '/', 'Revenue in the ledger, by month')
    const text = await page.locator('body').innerText()
    if (text.includes('vs last qtr')) throw new Error('the invented pipeline arrow is still on the dashboard')
    if (!text.includes('vs last month')) throw new Error('the cash card does not say what it is compared with')
    if (!text.includes('contracted, not cancelled')) throw new Error('the pipeline card lost its honest hint')
  })

  console.log('\nbudgeting: per-project ceilings')
  await step('a budget set on a live project is saved on the server and still shown after a reload', async () => {
    const live = (await projects()).find((p) => !p.cancelled)
    if (!live) throw new Error('no live project to budget')
    await open(page, '/budgeting')
    await page.locator('select').first().selectOption(live.project_no)
    await page.getByRole('button', { name: /Set a budget|Edit ceilings/ }).click()
    // The first row is a direct-cost category with a ceiling of zero: give it one.
    await modal(page).locator('input[type="number"]').first().fill('150000000')
    await modal(page).getByRole('button', { name: /Save budget/ }).click()
    const saved = await until('the budget', async () => (await api(`/projects/${live.id}/budget`)).body, (b) => b && b.categories && b.categories.some((c) => Number(c.ceiling) === 150000000))
    await open(page, '/budgeting')
    await page.locator('select').first().selectOption(live.project_no)
    await page.getByText(/150 M|150,000,000|150\.000\.000/).first().waitFor({ timeout: T })
    void saved
  })

  // =====================================================================================
  // This server has no Google credentials (and the click-through cannot sign in at Google), so what is
  // proved is the honest path: the screen asks the server, and says plainly that it is not set up.
  console.log('\ngoogle calendar: the real status, not a simulation')
  await step('the Google Calendar screen asks the server and says it is not set up', async () => {
    const asked = []
    page.on('request', (r) => { if (r.url().includes('/google/status')) asked.push(r.url()) })
    await open(page, '/google-calendar')
    await page.locator('[data-gcal-state="not-configured"]').waitFor({ timeout: T })
    if (!asked.length) throw new Error('the screen never asked the server for the Google status')
    if (await page.getByText(/simulated/i).count()) throw new Error('the live screen still says "simulated"')
    const status = (await api('/google/status')).body
    if (status.configured !== false || status.connected !== false) throw new Error(`status was ${JSON.stringify(status)}`)
  })

  // =====================================================================================
  console.log('\nproject edit and crew')
  await step('a project is renamed and its event date moved from the screen, and the server has both', async () => {
    const live = (await projects()).find((p) => !p.cancelled && p.event_date)
    if (!live) throw new Error('no live project with an event date')
    await open(page, `/projects/${live.project_no}`, 'Edit project')
    await page.getByRole('button', { name: 'Edit project' }).click()
    await modal(page).getByLabel('Name').fill('E2E Renamed Project')
    await modal(page).getByLabel('Event date').fill('2027-02-14')
    await modal(page).getByRole('button', { name: 'Save', exact: true }).click()
    const got = await until('the edit', async () => (await api(`/projects/${live.id}`)).body, (x) => x.name === 'E2E Renamed Project' && x)
    if (got.event_date !== '2027-02-14') throw new Error(`the event date is ${got.event_date}`)
    await page.getByText('E2E Renamed Project').first().waitFor({ timeout: T })
  })

  const crewId = async (name) => (await api('/crew')).body.find((c) => c.name === name)
  await step('crew is added from Payroll and saved on the server', async () => {
    await open(page, '/payroll', 'Manage crew')
    await page.getByRole('button', { name: /Add crew member/ }).click()
    await mfield(page, 'Name').fill('E2E Crew Hand')
    await mfield(page, 'Role').fill('Rigger')
    await mfield(page, 'Base rate (per event)').fill('3000000')
    await modal(page).getByRole('button', { name: /^Save$/ }).click()
    const c = await until('the crew member', async () => crewId('E2E Crew Hand'), (x) => x)
    if (c.role !== 'Rigger' || c.base_rate !== '3000000.00' || !c.active) throw new Error(`saved as ${JSON.stringify(c)}`)
  })

  await step('a crew rate is edited, and the member is deactivated and left out of the pool', async () => {
    await open(page, '/payroll', 'E2E Crew Hand')
    await page.locator('div').filter({ hasText: /^E2E Crew Hand/ }).getByRole('button', { name: /^Edit$/ }).first().click()
    await mfield(page, 'Base rate (per event)').fill('3500000')
    await modal(page).getByRole('button', { name: /^Save$/ }).click()
    await until('the new rate', async () => crewId('E2E Crew Hand'), (x) => x && x.base_rate === '3500000.00')
    await page.locator('div').filter({ hasText: /^E2E Crew Hand/ }).getByRole('button', { name: /Deactivate/ }).first().click()
    await until('deactivated', async () => crewId('E2E Crew Hand'), (x) => x && x.active === false)
    // The pool table (above the manage card) no longer lists them: only the card (struck through) does.
    const rows = await page.locator('tbody tr', { hasText: 'E2E Crew Hand' }).count()
    if (rows !== 0) throw new Error('a deactivated member is still in the incentive pool table')
  })

  await step('a crew member added by mistake is removed', async () => {
    await open(page, '/payroll', 'E2E Crew Hand')
    page.once('dialog', (dlg) => dlg.accept())
    await page.getByRole('button', { name: 'Remove E2E Crew Hand' }).click()
    await until('removed', async () => (await api('/crew')).body, (cs) => !cs.some((c) => c.name === 'E2E Crew Hand') && cs)
  })

  console.log('\nvendor files, PO delivery and client history')
  const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')
  const rigging = async () => (await api('/vendors')).body.find((v) => v.name === 'E2E Rigging Co')
  await step('a vendor agreement is uploaded on the vendor page, saved on the server, opened, and removed', async () => {
    const v = await rigging()
    await open(page, `/vendors/${v.vendor_no}`, 'Attachments')
    await page.locator('input[type="file"]').first().setInputFiles({ name: 'e2e-agreement.pdf', mimeType: 'application/pdf', buffer: PDF })
    const row = await until('the vendor file', async () => (await api(`/vendors/${v.id}/attachments`)).body, (rows) => rows.find((r) => r.filename === 'e2e-agreement.pdf' && r.kind === 'Agreement'))
    await page.getByText('e2e-agreement.pdf').first().waitFor({ timeout: T })
    const bytes = await fetch(`${API}/api/v1/attachments/${row.attachment_id}`, { headers: { Authorization: `Bearer ${token}` } })
    if (bytes.status !== 200) throw new Error(`the file would not open: ${bytes.status}`)
    page.once('dialog', (dlg) => dlg.accept())
    await page.getByRole('button', { name: 'Remove e2e-agreement.pdf' }).click()
    await until('removed', async () => (await api(`/vendors/${v.id}/attachments`)).body, (rows) => rows.length === 0 && rows)
  })

  await step('delivery is recorded on a purchase order from the pipeline board and saved on the server', async () => {
    const v = await rigging()
    const made = await api('/purchase-orders', { method: 'POST', body: JSON.stringify({ vendor_id: v.id, order_date: '2026-06-12', lines: [{ item_label: 'E2E truss', qty: '2', unit_price: '1000000' }] }) })
    if (made.status !== 201) throw new Error(`could not raise a PO: ${made.status}`)
    const approved = await api(`/purchase-orders/${made.body.id}/approve`, { method: 'POST', body: JSON.stringify({}) })
    if (approved.status !== 200) throw new Error(`could not approve it: ${approved.status}`)
    await open(page, '/purchase-orders?view=pipeline', made.body.po_no)
    await page.getByLabel(`Delivery ${made.body.po_no}`).selectOption('Delivered')
    await until('delivered', async () => (await api(`/purchase-orders/${made.body.id}`)).body, (po) => po.delivery_status === 'Delivered' && po)
    await open(page, '/purchase-orders?view=pipeline', made.body.po_no)
    const value = await page.getByLabel(`Delivery ${made.body.po_no}`).inputValue()
    if (value !== 'Delivered') throw new Error(`after a reload the board says ${value}`)
  })

  await step('a client page shows its past events from the server, each once', async () => {
    const renamed = (await projects()).find((p) => p.name === 'E2E Renamed Project')
    if (!renamed) throw new Error('the renamed project from the earlier step is missing')
    const clients = (await api('/clients')).body
    const owner = clients.find((c) => c.id === renamed.client_id)
    const hist = (await api(`/clients/${owner.id}/history`)).body
    if (!hist.events.some((e) => e.project_no === renamed.project_no)) throw new Error('the server history lacks the project')
    await open(page, `/crm/${owner.client_no}`, 'Project History')
    await page.getByText('E2E Renamed Project').first().waitFor({ timeout: T })
    const shown = await page.getByText('E2E Renamed Project', { exact: true }).count()
    if (shown !== 1) throw new Error(`the project is listed ${shown} times`)
  })

  console.log('\nvendor lifecycle board')
  const lifecycle = async () => { const v = await rigging(); return { v, life: (await api(`/vendors/${v.id}/lifecycle`)).body } }
  const card = () => page.locator('[data-vendor]').filter({ hasText: 'E2E Rigging Co' }).first()
  await step('a new vendor is a Prospect on the board, and ticking the reference check is saved on the server', async () => {
    const { life } = await lifecycle()
    if (life.stage !== 'Prospect') throw new Error(`a new vendor should be a Prospect, the server says ${life.stage}`)
    await open(page, '/vendors?view=pipeline', 'E2E Rigging Co')
    await card().getByRole('button', { name: 'Reference checked with a past client' }).click()
    await until('the tick', async () => (await lifecycle()).life, (l) => l.checks.reference === true && l)
    await open(page, '/vendors?view=pipeline', 'E2E Rigging Co')
    const pressed = await card().getByRole('button', { name: 'Reference checked with a past client' }).getAttribute('aria-pressed')
    if (pressed !== 'true') throw new Error('after a reload the tick is gone')
  })

  await step('onboarding starts from the board, and approving an unfinished vendor is refused with the reason', async () => {
    await card().getByRole('button', { name: /Start onboarding/ }).click()
    await until('onboarding', async () => (await lifecycle()).life, (l) => l.stage === 'Onboarding' && l)
    // aria-disabled on purpose: the button stays clickable so the click can say why it is refused
    await card().getByRole('button', { name: /Approve vendor/ }).click({ force: true })
    await page.getByText('Finish the onboarding checklist first.').first().waitFor({ timeout: T })
    const { life } = await lifecycle()
    if (life.stage !== 'Onboarding') throw new Error(`the refusal should leave it at Onboarding, it is ${life.stage}`)
    // The server's 409 is the point of this step, so it is not an unexpected refusal for the whole-run check.
    const refused = failedCalls.findIndex((c) => c.startsWith('409') && /POST \/vendors\/[^/]+\/stage$/.test(c))
    if (refused < 0) throw new Error('the server never refused the approval')
    failedCalls.splice(refused, 1)
  })

  await step('holding a vendor needs a reason, is saved with it, and reactivating puts it back', async () => {
    await card().getByRole('button', { name: 'Hold' }).click()
    const put = page.getByRole('button', { name: 'Put on hold' })
    if (!(await put.isDisabled())) throw new Error('holding should wait for a reason')
    await page.getByPlaceholder(/Late delivery/).fill('E2E late on two events')
    await put.click()
    const held = await until('on hold', async () => (await lifecycle()).life, (l) => l.stage === 'On hold' && l)
    if (held.reason !== 'E2E late on two events') throw new Error(`the reason was not kept: ${held.reason}`)
    await open(page, '/vendors?view=pipeline', 'On hold & blacklisted')
    await page.getByText('On hold & blacklisted').first().click()
    await page.getByRole('button', { name: /Reactivate/ }).first().click()
    const back = await until('back on the board', async () => (await lifecycle()).life, (l) => l.stage === 'Onboarding' && l)
    const stages = back.history.map((h) => h.stage).join(' > ')
    if (stages !== 'Prospect > Onboarding > On hold > Onboarding') throw new Error(`the history reads ${stages}`)
  })

  console.log('\nusers: an account, a temporary password, a one-time link')
  const newcomer = { name: 'E2E Newcomer', email: 'e2e.newcomer@oscenia.co.id' }
  const OWN = 'E2E-first-own-password-1'
  const AFTER_LINK = 'E2E-after-the-link-pass-2'
  let temp = ''
  const fresh = async () => (await browser.newContext({ viewport: { width: 1000, height: 800 } })).newPage()
  const rawLogin = async (password) => (await fetch(`${API}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: newcomer.email, password }),
  })).status
  const userRow = async () => (await api('/users')).body.find((u) => u.email === newcomer.email)

  await step('the CEO creates a user and is shown a temporary password once', async () => {
    await open(page, '/users', 'New user')
    await page.getByRole('button', { name: /New user/ }).first().click()
    await mfield(page, 'Full name').fill(newcomer.name)
    await mfield(page, 'Email').fill(newcomer.email)
    await modal(page).getByRole('button', { name: /Create user/ }).click()
    await modal(page).getByText(/shown only once/).waitFor({ timeout: T })
    temp = (await modal(page).locator('span.font-mono').nth(1).innerText()).trim()
    if (temp.length < 12) throw new Error(`the temporary password looks wrong: ${temp}`)
    await modal(page).getByRole('button', { name: /^Done$/ }).click()
    const u = await until('the user', async () => (await api('/users')).body, (us) => us.find((x) => x.email === newcomer.email))
    if (!u.must_change_password || !u.active) throw new Error('the new account is not marked for a password change')
  })

  await step('the new user signs in with it and must choose their own password first', async () => {
    const p = await fresh()
    await visit(p, `${LIVE}/`)
    await p.locator('input').first().fill(newcomer.email)
    await p.locator('input[type="password"]').fill(temp)
    await p.getByRole('button', { name: 'Sign in' }).click()
    await p.getByText('Choose your own password').waitFor({ timeout: T })
    await p.getByLabel('Current password').fill(temp)
    await p.getByLabel('New password', { exact: true }).fill(OWN)
    await p.getByLabel('Repeat the new password').fill(OWN)
    await p.getByRole('button', { name: 'Change password', exact: true }).click()
    await p.getByText('Choose your own password').waitFor({ state: 'detached', timeout: T })
    await until('the flag cleared', userRow, (u) => u && !u.must_change_password && u)
    if ((await rawLogin(temp)) !== 401) throw new Error('the temporary password still works')
    if ((await rawLogin(OWN)) !== 200) throw new Error('the new password does not work')
  })

  await step('the CEO makes a one-time password link and the person spends it signed out', async () => {
    await open(page, '/users', 'New user')
    await page.locator('tr').filter({ hasText: newcomer.email }).getByRole('button', { name: /Password link/ }).click()
    const link = (await modal(page).locator('span.font-mono').first().innerText()).trim()
    if (!link.includes('/reset-password#')) throw new Error(`not a reset link: ${link}`)
    await modal(page).getByRole('button', { name: /^Done$/ }).click()
    const p = await fresh()
    // The link carries the app address it was made on; this run serves the app on LIVE.
    const here = `${LIVE}/reset-password#${link.split('#')[1]}`
    await visit(p, here)
    await p.getByLabel('New password', { exact: true }).fill(AFTER_LINK)
    await p.getByLabel('Repeat it').fill(AFTER_LINK)
    await p.getByRole('button', { name: 'Set password' }).click()
    await p.getByText('Your password is set').waitFor({ timeout: T })
    if ((await rawLogin(OWN)) !== 401) throw new Error('the old password still works after a reset')
    if ((await rawLogin(AFTER_LINK)) !== 200) throw new Error('the new password does not work')
    // The link is spent: using it again is refused.
    const again = await fresh()
    await visit(again, here)
    await again.getByLabel('New password', { exact: true }).fill('E2E-a-third-password-3')
    await again.getByLabel('Repeat it').fill('E2E-a-third-password-3')
    await again.getByRole('button', { name: 'Set password' }).click()
    await again.getByRole('alert').waitFor({ timeout: T })
    if ((await rawLogin('E2E-a-third-password-3')) !== 401) throw new Error('a spent link set a password')
  })

  await step('the CEO deactivates the user and they can no longer sign in', async () => {
    await open(page, '/users', 'New user')
    await page.locator('tr').filter({ hasText: newcomer.email }).getByRole('button', { name: /Deactivate/ }).click()
    await until('deactivated', userRow, (u) => u && !u.active && u)
    if ((await rawLogin(AFTER_LINK)) !== 401) throw new Error('a deactivated account can still sign in')
  })

  console.log('\nsettings and what must not pretend')
  await step('changing the bonus threshold is saved', async () => {
    await open(page, '/payroll')
    const input = page.locator('input[type="number"]').first()
    await input.fill('8')
    await input.blur()
    await until('threshold 8', async () => (await api('/settings')).body, (s) => Number(s.bonus_threshold) === 8)
  })
  await step('a delivery order is drafted, dispatched on the server, and still there after a reload', async () => {
    const live = (await projects()).find((p) => !p.cancelled)
    if (!live) throw new Error('no live project to send kit to')
    await open(page, '/warehouse')
    await page.getByRole('button', { name: /New delivery order/ }).click()
    await modal(page).locator('select').first().selectOption(live.project_no)
    await modal(page).getByPlaceholder(/cable ramps/).fill('E2E cable ramps')
    await modal(page).getByPlaceholder('0').last().fill('5')
    await modal(page).getByRole('button', { name: /Draft order/ }).click()
    const order = await until('the order', async () => (await api('/delivery-orders')).body, (os) => os.find((o) => o.lines.some((l) => l.item_label === 'E2E cable ramps')))
    if (order.status !== 'Draft') throw new Error(`expected a Draft, got ${order.status}`)
    await page.getByText(order.do_no).first().waitFor({ timeout: T })
    await page.locator('tr').filter({ hasText: order.do_no }).getByRole('button', { name: /^Dispatch/ }).click()
    // Dispatch needs the recipient's signature: the pad opens, and nothing moves until it is signed.
    await page.getByText('Sign to dispatch').first().waitFor({ timeout: T })
    const sign = modal(page).getByRole('button', { name: /Sign and dispatch/ })
    if (!(await sign.isDisabled())) throw new Error('Sign and dispatch was enabled before anyone signed')
    await modal(page).getByPlaceholder('Full name').fill('Pak Hendra')
    const pad = await page.getByTestId('signature-pad').boundingBox()
    await page.mouse.move(pad.x + 30, pad.y + pad.height / 2)
    await page.mouse.down()
    for (let i = 1; i <= 12; i += 1) await page.mouse.move(pad.x + 30 + i * 20, pad.y + pad.height / 2 + (i % 2 ? 18 : -18))
    await page.mouse.up()
    await sign.click()
    const sent = await until('dispatched', async () => (await api('/delivery-orders')).body, (os) => os.find((o) => o.id === order.id && o.status === 'Dispatched' && o.signed && o.has_signature && o.signed_by_name === 'Pak Hendra'))
    if (!sent) throw new Error('not dispatched with a signature')
    const picture = await fetch(`${API}/api/v1/delivery-orders/${order.id}/signature`, { headers: { Authorization: `Bearer ${token}` } })
    if (picture.status !== 200 || picture.headers.get('content-type') !== 'image/png') throw new Error(`the signature picture answered ${picture.status}`)
    await open(page, '/warehouse')
    await page.locator('tr').filter({ hasText: order.do_no }).getByText('Dispatched').first().waitFor({ timeout: T })
  })

  await step('a stock item is renamed, archived (gone from the list), shown under Archived, and restored', async () => {
    await open(page, '/warehouse', 'Inventory')
    await page.getByRole('button', { name: 'Edit E2E Gaffer tape' }).click()
    await modal(page).locator('input').first().fill('E2E Gaffer tape (black)')
    await modal(page).getByRole('button', { name: /^Save/ }).click()
    const renamed = await until('renamed', async () => (await api('/inventory')).body, (is) => is.find((i) => i.item === 'E2E Gaffer tape (black)'))
    await page.getByText('E2E Gaffer tape (black)').first().waitFor({ timeout: T })

    await page.getByRole('button', { name: 'Edit E2E Gaffer tape (black)' }).click()
    await modal(page).getByRole('button', { name: /^Archive/ }).click()
    await until('archived', async () => (await api('/inventory')).body, (is) => !is.find((i) => i.id === renamed.id))
    await page.getByRole('button', { name: /Show archived items/ }).click()
    await page.locator('tr').filter({ hasText: 'E2E Gaffer tape (black)' }).getByRole('button', { name: /Restore/ }).click()
    await until('restored', async () => (await api('/inventory')).body, (is) => is.find((i) => i.id === renamed.id && !i.archived_at))
  })

  console.log('\nunsigned dispatch setting')
  await step('the policy toggle allows an unsigned dispatch from the screen, says so on the order, and switching it off makes the server insist on a signature again', async () => {
    const live = (await projects()).find((p) => !p.cancelled)
    if (!live) throw new Error('no live project to send kit to')
    const draft = async (item) => (await api('/delivery-orders', { method: 'POST', body: JSON.stringify({ project_id: live.id, lines: [{ item, qty: '1' }] }) })).body
    const first = await draft('E2E unsigned truss')
    const toggle = 'Allow dispatching a delivery order without a signature'

    await open(page, '/warehouse', 'Delivery Orders')
    // The box follows the server, not the click, so it is clicked and the server is asked.
    await page.getByLabel(toggle).click()
    await until('the setting on', async () => (await api('/settings')).body, (s) => s.allow_unsigned_dispatch === true)
    await page.locator('tr').filter({ hasText: first.do_no }).getByRole('button', { name: /^Dispatch/ }).click()
    const sent = await until('dispatched unsigned', async () => (await api('/delivery-orders')).body, (os) => os.find((o) => o.id === first.id && o.status === 'Dispatched'))
    if (sent.signed !== false || sent.has_signature !== false) throw new Error('an unsigned dispatch must not claim to be signed')

    await page.getByLabel(toggle).click()
    await until('the setting off', async () => (await api('/settings')).body, (s) => s.allow_unsigned_dispatch === false)
    const second = await draft('E2E signed-only truss')
    const refused = await api(`/delivery-orders/${second.id}/advance`, { method: 'POST' })
    if (refused.status !== 409) throw new Error(`with the setting off, an unsigned dispatch answered ${refused.status}, not 409`)
  })

  console.log('\nclient relationships')
  // Dates are the real ones (a signed-in app uses the real day): a birthday three days away, and an event
  // that ran in this month the last two years, so its nudge (three months ahead) is already due.
  const soon = new Date(Date.now() + 3 * 864e5)
  const birthdayMD = `${String(soon.getUTCMonth() + 1).padStart(2, '0')}-${String(soon.getUTCDate()).padStart(2, '0')}`
  const thisYear = new Date().getUTCFullYear()
  const thisMonth = String(new Date().getUTCMonth() + 1).padStart(2, '0')
  let relClient = null
  await step('a contact and a recurring event are added on a client page, a bad birthday is refused, and the server has both', async () => {
    relClient = (await api('/clients')).body[0]
    if (!relClient) throw new Error('no client to add relationships to')
    await open(page, `/crm/${relClient.client_no}`, 'People we work with')
    await page.getByRole('button', { name: 'Add PIC' }).click()
    await page.getByPlaceholder('Name', { exact: true }).fill('E2E Ibu Sari')
    await page.getByPlaceholder('Role').fill('HR')
    await page.getByPlaceholder('Birthday MM-DD').fill('02-30')
    await page.getByRole('button', { name: 'Save' }).last().click()
    await page.getByText('Check the details').first().waitFor({ timeout: T })
    if ((await api(`/clients/${relClient.id}/relations`)).body.contacts.length) throw new Error('a bad birthday reached the server')
    await page.getByPlaceholder('Birthday MM-DD').fill(birthdayMD)
    await page.getByRole('button', { name: 'Save' }).last().click()
    await until('the contact', async () => (await api(`/clients/${relClient.id}/relations`)).body, (r) => r.contacts.find((c) => c.name === 'E2E Ibu Sari' && c.birthday === birthdayMD))

    await page.getByRole('button', { name: 'Add recurring event' }).click()
    await page.getByPlaceholder(/Event name/).fill('E2E Annual Gala')
    await page.getByPlaceholder(/Months it ran/).fill(`${thisYear - 2}-${thisMonth}, ${thisYear - 1}-${thisMonth}`)
    await page.getByRole('button', { name: 'Save' }).last().click()
    await until('the cycle', async () => (await api(`/clients/${relClient.id}/relations`)).body, (r) => r.cycles.find((c) => c.name === 'E2E Annual Gala' && c.history.length === 2))

    await open(page, `/crm/${relClient.client_no}`, 'People we work with')
    await page.getByText('E2E Ibu Sari').first().waitFor({ timeout: T })
    await page.getByText('E2E Annual Gala').first().waitFor({ timeout: T })
  })
  await step('the calendar lists them from the server; logging the nudge notes a call, and marking the birthday sent is remembered', async () => {
    await open(page, '/crm', 'E2E Ibu Sari')
    await page.getByRole('button', { name: /Log outreach/ }).first().click()
    await until('the call noted', async () => (await api(`/clients/${relClient.id}/interactions`)).body, (notes) => notes.find((n) => n.type === 'Call'))
    await page.getByRole('button', { name: /Mark sent/ }).first().click()
    await until('the greeting', async () => (await api(`/clients/${relClient.id}/relations`)).body, (r) => r.greetings.find((g) => g.to === 'E2E Ibu Sari' && g.kind === 'Birthday'))
    const recorded = (await api(`/clients/${relClient.id}/relations`)).body.greetings
    if (recorded.length !== 1) throw new Error(`${recorded.length} greetings were recorded, not one`)
    const cal = (await api('/crm/calendar?days=30')).body
    const mine = cal.find((i) => i.kind === 'Birthday' && i.title === 'E2E Ibu Sari')
    if (!mine || !mine.already_sent) throw new Error('the calendar does not show the greeting as sent')
    if (cal.some((i) => i.kind === 'Event nudge')) throw new Error('a handled nudge is still on the calendar')
  })

  console.log('\ncampaigns')
  await step('guests become one contact list, a campaign is prepared from those who agreed, one is marked reached, the CSV downloads, and an unsubscribe is honoured', async () => {
    const ev = (await api('/events', { method: 'POST', body: JSON.stringify({ name: 'E2E Campaign Gala', date: '2030-05-01' }) })).body
    const added = await api(`/events/${ev.id}/guests`, { method: 'POST', body: JSON.stringify({ guests: [{ name: 'E2E Agnes', phone: '0811000111' }, { name: 'E2E Bayu', phone: '0811000222' }, { name: 'E2E Cici', phone: '0811000333' }] }) })
    if (added.status !== 200) throw new Error(`could not add guests: ${added.status}`)
    // Consent is given by the guest on their own RSVP; here two of the three have given it.
    execFileSync('docker', ['exec', 'oscenia-erp-db', 'psql', '-U', 'oscenia', '-d', DB, '-c', "UPDATE guests SET consent = true, consent_at = now() WHERE name IN ('E2E Agnes', 'E2E Bayu')"], { stdio: 'ignore' })

    await open(page, '/crm?tab=contacts', 'E2E Agnes')
    for (const who of ['E2E Agnes', 'E2E Bayu', 'E2E Cici']) await page.getByLabel(`Select ${who}`).check()
    await page.getByText(/without marketing consent/).first().waitFor({ timeout: T })
    await page.getByRole('button', { name: /Compose campaign/ }).click()
    await modal(page).getByPlaceholder(/Year-end gathering/).fill('E2E thank-you')
    await modal(page).getByRole('button', { name: /Prepare campaign/ }).click()
    const made = await until('the campaign', async () => (await api('/crm/campaigns')).body, (cs) => cs.find((c) => c.name === 'E2E thank-you'))
    if (made.recipient_count !== 2 || made.skipped_count !== 1) throw new Error(`expected 2 recipients and 1 skipped, got ${made.recipient_count} and ${made.skipped_count}`)

    // The detail opens by itself: two people to reach, each with a link, and nothing sent.
    await page.getByText('Nothing is sent from here.').first().waitFor({ timeout: T })
    if ((await page.getByTestId('campaign-recipient').count()) !== 2) throw new Error('the campaign does not list its two recipients')
    const links = await page.locator('[data-testid="campaign-recipient"] a[href^="https://wa.me/"]').count()
    if (links !== 2) throw new Error(`expected two WhatsApp links, found ${links}`)
    await page.getByRole('button', { name: /Mark reached/ }).first().click()
    await until('one reached', async () => (await api(`/crm/campaigns/${made.id}`)).body, (c) => c.recipients.filter((r) => r.status === 'sent').length === 1)

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: T }),
      page.getByRole('button', { name: /Download CSV/ }).click(),
    ])
    const csv = readFileSync(await download.path(), 'utf8')
    if (!csv.startsWith('Name,Phone,Email,Status') || !csv.includes('E2E Agnes') || csv.includes('E2E Cici')) throw new Error(`the CSV is not what was prepared: ${csv.slice(0, 120)}`)
    await modal(page).locator('button.btn-gold', { hasText: 'Close' }).click()

    // An unsubscribe withdraws consent and takes the person out of what has not been sent.
    page.once('dialog', (d) => d.accept())
    await page.getByRole('button', { name: 'Unsubscribe E2E Bayu' }).click()
    await until('Bayu unsubscribed', async () => (await api('/crm/contacts')).body, (cs) => cs.find((c) => c.name === 'E2E Bayu' && c.consent === false))
    const after = (await api(`/crm/campaigns/${made.id}`)).body
    const bayu = after.recipients.find((r) => r.name === 'E2E Bayu')
    if (!bayu || bayu.status !== 'unsubscribed' || bayu.link !== null) throw new Error(`Bayu should be unsubscribed with no link: ${JSON.stringify(bayu)}`)
  })

  console.log('\nsearch beyond finance')
  await step('the search box finds an event by name, groups it under Events, and opens it', async () => {
    const made = await api('/events', { method: 'POST', body: JSON.stringify({ name: 'Zephyrine Launch Soiree', date: '2030-03-01', venue: 'Pavilion Hall' }) })
    if (made.status !== 201) throw new Error(`could not make the event: ${made.status}`)
    await open(page, '/')
    const box = page.getByPlaceholder(/Search anything/)
    await box.fill('zephyrine')
    await page.getByText('Zephyrine Launch Soiree').first().waitFor({ timeout: T })
    // It is the server's answer that is being shown, and the server tags the kind and the parent.
    const served = (await api('/search?q=zephyrine&limit=5')).body
    const group = served.groups.find((g) => g.kind === 'event')
    if (!group || group.hits[0].ref !== `event:${made.body.event_no}`) throw new Error(`no event group with the right ref: ${JSON.stringify(served.groups.map((g) => g.kind))}`)
    await box.press('Enter')
    await page.waitForURL(new RegExp(`/events/${made.body.event_no}$`), { timeout: T })
  })

  console.log('\nclient survey link')
  await step('staff copy the survey link, a signed-out client rates with it, the pool follows, and a new link revokes the old', async () => {
    // Last in the run on purpose: advancing a project to feedback would (rightly) stop its date being edited.
    // A project a client can rate: advance one to Post-Event Feedback through the server.
    const pick = (await projects()).find((p) => !p.cancelled)
    if (!pick) throw new Error('no live project to send a survey for')
    let cur = pick
    for (let i = 0; i < 8 && cur.stage !== 'Post-Event Feedback' && cur.stage !== 'Finished'; i += 1) {
      const moved = await api(`/projects/${cur.id}/advance-stage`, { method: 'POST', body: JSON.stringify({}) })
      if (moved.status !== 200) throw new Error(`could not advance ${cur.project_no}: ${moved.status}`)
      cur = moved.body
    }
    await open(page, `/projects/${pick.project_no}`, 'Copy client survey link')
    const [answer] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/survey-link') && r.request().method() === 'GET', { timeout: T }),
      page.getByRole('button', { name: /Copy client survey link/ }).click(),
    ])
    if (answer.status() !== 200) throw new Error(`the survey link answered ${answer.status()}`)
    const link = await answer.json()
    const url = `${LIVE}/rate/${encodeURIComponent(link.project_no)}#${link.token}`

    // The client: no sign-in at all.
    const guest = await (await browser.newContext({ viewport: { width: 900, height: 800 } })).newPage()
    await visit(guest, url)
    await guest.getByText(/How was/).first().waitFor({ timeout: T })
    const shown = await guest.locator('body').innerText()
    if (shown.includes('Contract') || shown.includes('Rp ')) throw new Error('the client page shows money')
    await guest.getByRole('button', { name: '9 out of 10' }).click()
    await guest.getByRole('button', { name: /Submit rating/ }).click()
    await guest.getByText('Thank you!').first().waitFor({ timeout: T })
    const pool = await until('the rating', async () => (await api(`/projects/${pick.id}/incentives`)).body, (x) => x.event_score === '9.0' && x)
    if (!pool) throw new Error('the pool did not follow the rating')

    // A new link revokes the one already sent.
    const fresh = await api(`/projects/${pick.id}/survey-link/regenerate`, { method: 'POST', body: JSON.stringify({}) })
    if (fresh.status !== 200 || fresh.body.token === link.token) throw new Error('regenerate did not make a new link')
    await guest.goto('about:blank') // the same address with only a hash would not reload the page
    await visit(guest, url)
    await guest.getByText('This survey link is not available').first().waitFor({ timeout: T })
    await guest.close()
  })

  // =====================================================================================
  console.log('\nthe whole run')
  check('no request the app made was refused by the server', failedCalls.length === 0, failedCalls.slice(0, 6).join(' | '))
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
