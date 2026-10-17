// The first load, for a role that may not see every module.
//
// The server now refuses a role the collections of modules it does not hold (a 403). Before the
// load tolerated that, one refusal aborted the whole first load, so a Sales or Warehouse login
// (neither sees vendors) never got any data. A refused collection must come back empty; a real
// failure (a 500, a dropped connection) must still fail the load. Both are pinned here.
//
// Run: npm run verify:role-load   (vite-node: hydrate.js imports the API client)

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
}

let refuse = new Set()
let broken = new Set()

const reply = (path) => {
  if (path.startsWith('/api/v1/journal-entries')) return { items: [], total: 0 }
  if (path === '/api/v1/petty-cash') return { balance: '0', opening: '0', toppedUp: '0', disbursed: '0', awaitingApproval: '0', awaitingCount: 0, asOf: '2026-01-01' }
  if (path === '/api/v1/settings') return { budgetTolerancePct: '10', bonusThreshold: '7', commissionPct: '2.5' }
  return []
}

globalThis.fetch = async (url) => {
  const path = new URL(url).pathname
  if (refuse.has(path)) {
    const body = JSON.stringify({ title: 'Forbidden', detail: 'The module is not available to this login.', action: 'module:vendors', permitted: ['CEO'] })
    return { ok: false, status: 403, text: async () => body, json: async () => JSON.parse(body) }
  }
  if (broken.has(path)) {
    const body = JSON.stringify({ title: 'Server error' })
    return { ok: false, status: 500, text: async () => body, json: async () => JSON.parse(body) }
  }
  const body = JSON.stringify(reply(path))
  return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) }
}

const { loadAll } = await import('../src/store/hydrate.js')

// The collections a Warehouse login cannot see, as the server gates them.
const GATED = [
  '/api/v1/vendor-lifecycle',
  '/api/v1/fixed-assets',
  '/api/v1/quotations',
  '/api/v1/procurement-requests',
  '/api/v1/delivery-orders',
  '/api/v1/mou-templates',
]

refuse = new Set(GATED)
let data
try {
  data = await loadAll()
  check('a 403 on collections the role may not see does not fail the load', true)
} catch (err) {
  check('a 403 on collections the role may not see does not fail the load', false, err.message)
}
if (data) {
  check('a refused collection is empty, not left on seed data', data.fixedAssets.length === 0 && data.quotations.length === 0 && data.procurement.length === 0 && data.deliveryOrders.length === 0 && data.mouTemplates.length === 0)
  check('the collections it can see are still loaded', Array.isArray(data.accounts) && Array.isArray(data.clients) && Array.isArray(data.projects))
}

refuse = new Set()
broken = new Set(['/api/v1/fixed-assets'])
try {
  await loadAll()
  check('a 500 still fails the load', false, 'it resolved')
} catch (err) {
  check('a 500 still fails the load', err.status === 500, `status ${err.status}`)
}

broken = new Set(['/api/v1/clients'])
try {
  await loadAll()
  check('a 403-free failure on a shared collection still fails the load', false, 'it resolved')
} catch (err) {
  check('a 403-free failure on a shared collection still fails the load', err.status === 500)
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL ROLE-LOAD CHECKS PASSED')
process.exit(failures ? 1 : 0)
