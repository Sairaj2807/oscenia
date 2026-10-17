// Do the browser's numbers and the server's reports agree? (W4, step R0)
//
//   npm run verify:reports
//
// Starts a real backend on a scratch database seeded with the finance demo, loads the whole thing
// exactly as the app does (store/hydrate.js `loadAll`), then computes each figure two ways: with
// `lib/ledger.js` over the loaded journal, and with the server's report endpoint. Every difference
// is printed. Nothing is changed in the app: this is the list of discrepancies to resolve BEFORE any
// page is switched to the server's reports.
//
// Starts and stops its own stack: scratch database oscenia_rep_e2e, uvicorn :8772 (no browser).
// Run through vite-node (the store and ledger are ES modules that import the API client).

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Vite reads VITE_API_URL when it starts, so a script that picks its own port has to start it
// with the variable already set: run again as a child with it, and report that run's result.
if (!process.env.VITE_API_URL) {
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  const again = spawnSync(npx, ['vite-node', 'scripts/verify-reports.mjs'], {
    stdio: 'inherit', shell: true, env: { ...process.env, VITE_API_URL: 'http://127.0.0.1:8772/api/v1' },
  })
  process.exit(again.status ?? 1)
}

if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map()
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
    clear: () => mem.clear(),
  }
}

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BACKEND = `${ROOT}erp-backend`
const PY = `${BACKEND}/.venv/Scripts/python.exe`
const ALEMBIC = `${BACKEND}/.venv/Scripts/alembic.exe`
const DB = 'oscenia_rep_e2e'
const PORT = 8772
const PASSWORD = 'oscenia-demo-2026'
const DATABASE_URL = `postgresql+asyncpg://oscenia:oscenia@localhost:5433/${DB}`
// Far enough ahead to include every seeded posting, so the two sides see the same journal.
const AS_OF = '2099-12-31'

const psql = (sql) => execFileSync('docker', ['exec', 'oscenia-erp-db', 'psql', '-U', 'oscenia', '-d', 'postgres', '-c', sql], { stdio: 'ignore' })

let server = null
const stop = () => { try { server?.kill() } catch { /* already gone */ } }
process.on('exit', stop)

psql(`DROP DATABASE IF EXISTS ${DB}`)
psql(`CREATE DATABASE ${DB}`)
const env = { ...process.env, DATABASE_URL, ENV: 'development', LOG_LEVEL: 'WARNING' }
execFileSync(ALEMBIC, ['upgrade', 'head'], { cwd: BACKEND, env, stdio: 'ignore' })
execFileSync(PY, ['-m', 'app.seed.demo'], { cwd: BACKEND, env, stdio: 'ignore' })
server = spawn(PY, ['-m', 'uvicorn', 'app.main:app', '--port', String(PORT), '--log-level', 'warning'], { cwd: BACKEND, env, stdio: 'ignore' })
for (let i = 0; i < 120; i += 1) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).status < 500) break } catch { /* not yet */ }
  await new Promise((r) => setTimeout(r, 500))
}

const { api, login } = await import('../src/lib/api.js')
const { loadAll } = await import('../src/store/hydrate.js')
const L = await import('../src/lib/ledger.js')
const { syncChart } = await import('../src/lib/accounts.js')

await login('rahmat@oscenia.co.id', PASSWORD)

// --- books worth comparing -------------------------------------------------------------------
// The demo seed has a chart and people but almost no postings, and two empty ledgers always agree.
// So build a year's activity through the real API: two won deals, a billed stage, a purchase order
// paid and settled with PPh 23 withheld, petty cash and a procurement request, a fixed asset and its
// depreciation, a client rating and the incentive payout, a cost posted and reversed, a warehouse
// write-off, and a project cancelled with a refund. Each step is tried on its own: a step the
// backend refuses is reported and skipped, so one wrong body cannot hide every comparison.
const built = []
const attempt = async (what, fn) => {
  try { const out = await fn(); built.push(what); return out } catch (err) {
    console.log(`  (scenario step skipped: ${what} — ${err.message})`)
    return null
  }
}
const won = async (name) => {
  const c = await api.post('/clients', { name })
  const q = await api.post('/quotations', {
    clientId: c.id, eventType: 'Parity event', eventDate: '2026-11-18', preset: '50',
    lines: [{ label: 'Staging', amount: '480000000', estCost: '336000000' }],
  })
  await api.post(`/quotations/${q.id}/send`)
  await api.post(`/quotations/${q.id}/accept`)
  return api.post(`/quotations/${q.id}/confirm-down-payment`, {})
}
const p1 = await attempt('a won deal with its down payment', () => won('Parity A'))
const p2 = await attempt('a second won deal', () => won('Parity B'))
if (p1) {
  await attempt('the second billing stage issued', async () => {
    const inv = await api.get('/invoices', { projectId: p1.id })
    await api.post(`/invoices/${inv[1].id}/issue`, {})
  })
  const vendor = await attempt('a vendor with a withholding rate', () =>
    api.post('/vendors', { name: 'Parity Rigging', category: 'Staging', pph23Rate: '2', termsDpPercent: '50', termsSettlementDays: 14 }))
  if (vendor) {
    await attempt('a purchase order approved, down payment paid and settled', async () => {
      const po = await api.post('/purchase-orders', {
        vendorId: vendor.id, projectId: p1.id, orderDate: '2026-06-12',
        lines: [{ itemLabel: 'LED wall', qty: '10', unitPrice: '2400000' }],
      })
      await api.post(`/purchase-orders/${po.id}/approve`, {})
      await api.post(`/purchase-orders/${po.id}/pay-dp`, {})
      await api.post(`/purchase-orders/${po.id}/settle`, {})
    })
    if (p2) {
      await attempt('a second order raised on the deal that gets cancelled', async () => {
        const po = await api.post('/purchase-orders', {
          vendorId: vendor.id, projectId: p2.id, orderDate: '2026-06-13',
          lines: [{ itemLabel: 'Truss', qty: '4', unitPrice: '1500000' }],
        })
        await api.post(`/purchase-orders/${po.id}/approve`, {})
        await api.post(`/purchase-orders/${po.id}/pay-dp`, {})
      })
    }
  }
  await attempt('petty cash topped up', () => api.post('/petty-cash/top-up', { amount: '2500000' }))
  await attempt('a procurement request approved and disbursed', async () => {
    const r = await api.post('/procurement-requests', { category: 'Petty cash', amount: '750000', projectId: p1.id })
    await api.post(`/procurement-requests/${r.id}/transition`, { status: 'Pending' })
    await api.post(`/procurement-requests/${r.id}/transition`, { status: 'Approved' })
    await api.post(`/procurement-requests/${r.id}/transition`, { status: 'Disbursed' })
  })
  await attempt('a cost posted to the project and then reversed', async () => {
    const e = await api.post('/journal-entries', {
      entryDate: '2026-06-20', memo: 'Parity cost', projectId: p1.id,
      lines: [{ account: '5101', debit: '1000000' }, { account: '2102', credit: '1000000' }],
      source: { kind: 'po', ref: 'PARITY-1' },
    })
    await api.post(`/journal-entries/${e.id}/reverse`, {})
  })
  await attempt('an overhead cost posted without a project', () =>
    api.post('/journal-entries', {
      entryDate: '2026-06-21', memo: 'Parity overhead',
      lines: [{ account: '6101', debit: '250000' }, { account: '2102', credit: '250000' }],
      source: { kind: 'po', ref: 'PARITY-2' },
    }))
  await attempt('stock written off against the project', async () => {
    const item = await api.post('/inventory', { item: 'Parity truss', type: 'Fixed Asset', qty: '4', unit: 'pcs', unitValue: '8000000' })
    await api.post(`/inventory/${item.id}/return`, { condition: 'good', lostQty: '1', projectId: p1.id })
  })
  await attempt('the client rating and the incentive payout', async () => {
    await api.put(`/projects/${p1.id}/feedback`, { score: '9.1' })
    await api.post('/incentives/disburse', { projectId: p1.id })
  })
}
await attempt('a fixed asset and its depreciation', async () => {
  await api.post('/fixed-assets', { name: 'Parity LED wall', acquiredOn: '2026-01-05', cost: '120000000', salvage: '0', usefulLifeMonths: 36, method: 'straight-line', post: true })
  await api.post('/depreciation/run', {})
})
if (p2) await attempt('the second deal cancelled with a refund', () => api.post(`/projects/${p2.id}/cancel`, { reason: 'parity', refundDp: true }))
console.log(`\nbooks built: ${built.length} steps (${built.join('; ')})`)

const data = await loadAll()
console.log(`journal entries: ${data.journal.length}, projects: ${data.projects.length}, invoices: ${data.invoices.length}`)
syncChart(data.accounts)
const { journal, taxConfig, projects } = data

let same = 0
const diffs = []
const num = (v) => Number(v)
/** Compare one figure; the tolerance is a cent, because both sides are exact to the cent. */
function cmp(what, client, server, tol = 0.005) {
  const c = num(client)
  const s = num(server)
  if (Math.abs(c - s) <= tol) { same += 1; return }
  diffs.push({ what, client: c, server: s, by: c - s })
}
const section = (t) => console.log(`\n${t}`)

section('trial balance')
{
  const tb = L.trialBalance(journal)
  const sv = await api.get('/reports/trial-balance', { period: 'all' })
  cmp('trial balance: total debit', tb.debit, sv.debit)
  cmp('trial balance: total credit', tb.credit, sv.credit)
  cmp('trial balance: balanced', tb.balanced ? 1 : 0, sv.balanced ? 1 : 0)
}

section('income statement (all time)')
{
  const is = L.incomeStatementFrom(journal, taxConfig)
  const sv = await api.get('/reports/income-statement', { period: 'all' })
  const pairs = [
    ['revenue', is.totalRevenue, sv.totalRevenue], ['cost of sales', is.totalCogs, sv.totalCogs],
    ['gross profit', is.grossProfit, sv.grossProfit], ['operating expense', is.totalOpex, sv.totalOpex],
    ['profit before tax', is.profitBeforeTax, sv.profitBeforeTax], ['posted tax', is.postedTax, sv.postedTax],
    ['tax provision', is.provision, sv.provision], ['total tax', is.totalTax, sv.totalTax], ['NPAT', is.npat, sv.npat],
    ['tax rate', is.taxRate, sv.taxRate], ['gross margin %', is.grossMargin, sv.grossMargin], ['net margin %', is.netMargin, sv.netMargin],
  ]
  for (const [w, c, s] of pairs) cmp(`income statement: ${w}`, c, s, w.includes('%') ? 0.01 : 0.005)
  cmp('income statement: prepaid PPh 23 (1401)', L.accountBalance(journal, '1401'), sv.prepaidWithholding)
  const lines = (rows) => Object.fromEntries(rows.filter((r) => !r.derived).map((r) => [r.code, num(r.amount)]))
  for (const part of ['revenue', 'cogs', 'opex', 'tax']) {
    const c = lines(is[part])
    const s = lines(sv[part])
    for (const code of new Set([...Object.keys(c), ...Object.keys(s)])) cmp(`income statement ${part} line ${code}`, c[code] ?? 0, s[code] ?? 0)
  }
}

section('balance sheet (all time)')
{
  const bs = L.balanceSheetFrom(journal, taxConfig)
  const sv = await api.get('/reports/balance-sheet', { period: 'all' })
  cmp('balance sheet: total assets', bs.totalAssets, sv.totalAssets)
  cmp('balance sheet: total liabilities', bs.totalLiabilities, sv.totalLiabilities)
  cmp('balance sheet: total equity', bs.totalEquity, sv.totalEquity)
  cmp('balance sheet: difference', bs.difference, sv.difference)
  const lines = (rows) => Object.fromEntries(rows.filter((r) => !r.derived).map((r) => [r.code, num(r.amount)]))
  for (const part of ['assets', 'liabilities', 'equity']) {
    const c = lines(bs[part])
    const s = lines(sv[part])
    for (const code of new Set([...Object.keys(c), ...Object.keys(s)])) cmp(`balance sheet ${part} line ${code}`, c[code] ?? 0, s[code] ?? 0)
  }
}

section('cash')
{
  const sv = await api.get('/reports/cash-position', { asOf: AS_OF })
  cmp('cash: total', L.cashBalance(journal), sv.total)
  const mine = Object.fromEntries(L.cashByAccount(journal).map((a) => [a.code, a.balance]))
  const theirs = Object.fromEntries(sv.accounts.map((a) => [a.code, num(a.balance)]))
  for (const code of new Set([...Object.keys(mine), ...Object.keys(theirs)])) cmp(`cash account ${code}`, mine[code] ?? 0, theirs[code] ?? 0)
}

section('balance of every account (the chart of accounts, fixed assets, reconciliations)')
{
  const tree = await api.get('/accounts/tree')
  const flat = []
  const walk = (n) => { flat.push(n); (n.children || []).forEach(walk) }
  tree.forEach((t) => t.groups.forEach((g) => g.accounts.forEach(walk)))
  for (const a of flat) cmp(`account ${a.code} balance`, L.accountBalance(journal, a.code), a.balance)
}

section('ageing and reconciliation')
{
  const ar = await api.get('/receivables/ageing', { asOf: AS_OF })
  cmp('receivables: ledger balance vs 1201', L.accountBalance(journal, '1201'), ar.ledgerBalance)
  const ap = await api.get('/payables/ageing', { asOf: AS_OF })
  cmp('payables: ledger balance vs 2102', L.accountBalance(journal, '2102'), ap.ledgerBalance)
  cmp('payables: withholding owed vs 2105', L.accountBalance(journal, '2105'), ap.withholdingOwed)
  // The browser builds AR from the invoices table; the server from journal open items.
  const open = data.invoices.filter((i) => i.status === 'Unpaid' || i.status === 'Partially Paid')
  const clientAr = open.reduce((a, i) => a + (num(i.amount) - num(i.paid || 0)), 0)
  cmp('receivables: open invoices (browser) vs server total', clientAr, ar.total)
  const items = await api.get('/open-items', { control: '2102', side: 'credit', asOf: AS_OF })
  const clientAp = L.openItems(journal, { control: '2102', side: 'credit' })
  cmp('payables: number of open bills', clientAp.length, items.length, 0)
  cmp('payables: open bills total', clientAp.reduce((a, r) => a + num(r.outstanding), 0), items.reduce((a, r) => a + num(r.outstanding), 0))
}

section('project profit and loss')
{
  for (const p of projects) {
    const c = L.sliceTotals(journal, { project: p.id })
    const sv = await api.get('/reports/project-pnl', { projectId: p.uuid, period: 'all' })
    cmp(`${p.id} revenue`, c.revenue, sv.revenue)
    cmp(`${p.id} cost`, c.cost, sv.cost)
    cmp(`${p.id} profit`, c.profit, sv.profit)
    const cl = Object.fromEntries(L.projectCosts(journal, p.id).map((r) => [r.code, r.amount]))
    const sl = Object.fromEntries((sv.costs || []).map((r) => [r.code, num(r.amount)]))
    for (const code of new Set([...Object.keys(cl), ...Object.keys(sl)])) cmp(`${p.id} cost line ${code}`, cl[code] ?? 0, sl[code] ?? 0)
    cmp(`${p.id} realised cost (the project card)`, p.realizedCost, sv.cost)
  }
}

console.log(`\n${same} figures agree, ${diffs.length} differ`)
for (const d of diffs) console.log(`  DIFF  ${d.what}: browser ${d.client}, server ${d.server} (browser is ${d.by > 0 ? '+' : ''}${d.by.toFixed(2)})`)
stop()
process.exit(diffs.length ? 1 : 0)
