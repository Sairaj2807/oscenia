// Verifies the API client against a *running* backend.
//
//   cd erp-backend && uvicorn app.main:app --port 8000
//   cd erp-prototype && npx vite-node scripts/verify-api.mjs
//
// Sibling to verify-ledger.mjs and verify-flows.mjs: same shape, same reason. The client is
// the seam between two systems that are each tested on their own, so the bugs that live here
// are exactly the ones neither suite can see — a field name that does not survive the
// conversion, a token that is not sent, an error whose status is swallowed.

// `localStorage` is a browser API and this runs in Node. The client wraps every access in
// try/catch and degrades to "the session does not survive a refresh", which in Node would
// mean no request is ever authenticated — so the shim is what makes the test meaningful
// rather than a test of the fallback path.
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map()
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  }
}

const { api, request, login, logout, me, tokens, toCamel, toSnake, ApiError } = await import(
  '../src/lib/api.js'
)

let passed = 0
const failures = []

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(name) {
  console.log(`\n\x1b[2m${name}\x1b[0m`)
}

const PASSWORD = 'oscenia-demo-2026'

// ---------------------------------------------------------------------------
section('1. Case conversion is total and leaves values alone')
// ---------------------------------------------------------------------------

check('snake keys become camel', toCamel({ posted_through: '2026-07' }).postedThrough === '2026-07')
check(
  'nested objects convert',
  toCamel({ last_run: { job_key: 'x', run_for: '2026-07' } }).lastRun.jobKey === 'x'
)
check('arrays convert', toCamel([{ unit_value: '1' }])[0].unitValue === '1')
check('camel keys become snake', toSnake({ projectId: 'p' }).project_id === 'p')
check('round trip is stable', toCamel(toSnake({ someKey: 1 })).someKey === 1)

// Money must survive as a string. `Number('640000000.00')` is exact today and will not be
// for every figure this system will hold; a silent one-rupiah drift in a balance sheet is
// precisely what the backend spent eight phases making impossible.
const money = toCamel({ net_book_value: '640000000.00' })
check('money stays a string', typeof money.netBookValue === 'string', typeof money.netBookValue)
check('money keeps its cents', money.netBookValue === '640000000.00', money.netBookValue)

// Values are not touched — an account code is not a key.
check('values are untouched', toSnake({ account: 'someValue' }).account === 'someValue')
check('null survives', toCamel({ due_date: null }).dueDate === null)
check('date instances are not walked into', (() => {
  const d = new Date('2026-07-26')
  return toSnake({ eventDate: d }).event_date instanceof Date
})())

// ---------------------------------------------------------------------------
section('2. An unauthenticated call is refused')
// ---------------------------------------------------------------------------

tokens.clear()
try {
  await api.get('/accounts')
  check('anonymous read is refused', false, 'it succeeded')
} catch (err) {
  check('anonymous read is refused', err instanceof ApiError && err.status === 401, `status ${err.status}`)
}

// ---------------------------------------------------------------------------
section('3. Sign-in, and what /auth/me answers')
// ---------------------------------------------------------------------------

try {
  await login('nobody@oscenia.co.id', 'wrong')
  check('a bad password is refused', false, 'it succeeded')
} catch (err) {
  check('a bad password is refused', err.status === 401 || err.status === 429, `status ${err.status}`)
  check('and the message does not say why', !/unknown|no such|not found/i.test(err.message), err.message)
}

await login('lina@oscenia.co.id', PASSWORD)
check('tokens are stored', Boolean(tokens.access) && Boolean(tokens.refresh))

const user = await me()
check('full_name survived conversion', user.fullName === 'Lina W.', user.fullName)
check('role_label survived conversion', typeof user.roleLabel === 'string', user.roleLabel)
check('role is finance', user.role === 'finance', user.role)
check('the server resolves the action list', Array.isArray(user.actions) && user.actions.length > 0)
check('finance may post a journal', user.actions.includes('post_journal'))
check('finance may not manage stock', !user.actions.includes('manage_stock'))

// ---------------------------------------------------------------------------
section('4. Authenticated reads, and money on the wire')
// ---------------------------------------------------------------------------

const accounts = await api.get('/accounts')
check('the chart of accounts loads', Array.isArray(accounts) && accounts.length > 20, `${accounts?.length} accounts`)
const cash = accounts.find((a) => a.code === '1101')
check('an account keeps its camel fields', cash && 'isCash' in cash, Object.keys(cash || {}).join(','))
check('1101 is marked as cash', cash?.isCash === true)

const jobs = await api.get('/jobs')
check('all six jobs are listed (the five from the prototype and the file sweep)', jobs.length === 6, `${jobs.length}`)
check('a never-run job reports null rather than a fake time', jobs.every((j) => j.lastRun === null || typeof j.lastRun === 'object'))

// Query parameters are converted too, and arrays repeat the key.
const gl = await api.get('/reports/general-ledger', { codes: ['1101'], period: 'all' })
check('a report with array params works', gl && 'closing' in gl, Object.keys(gl || {}).slice(0, 4).join(','))
check('a balance arrives as a string', typeof gl.closing === 'string', typeof gl.closing)

// ---------------------------------------------------------------------------
section('4b. The global search (REQ-10)')
// ---------------------------------------------------------------------------

// The endpoint the top bar now calls. What matters at this seam is that the grouped shape
// survives the case conversion and that money is still a string on arrival -- a search that
// returned floats would put a different number in the result row than the record's own page.
const hunt = await api.get('/search', { q: 'a', limit: 5 })
check('a one-character query is answered, not refused', Array.isArray(hunt.groups), typeof hunt.groups)
check('and it finds nothing', hunt.total === 0, String(hunt.total))

const found = await api.get('/search', { q: 'INV', limit: 5 })
check('a document prefix returns groups', Array.isArray(found.groups))
if (found.groups.length) {
  const group = found.groups[0]
  check('a group names its kind and label', Boolean(group.kind && group.label), `${group.kind}/${group.label}`)
  const hit = group.hits[0]
  check('a hit carries the business number as id', typeof hit.id === 'string', String(hit.id))
  check('and the key as uuid', typeof hit.uuid === 'string' && hit.uuid.includes('-'), String(hit.uuid))
  check('subtitle survives the conversion as camel', 'subtitle' in hit, Object.keys(hit).join(','))
  check('an amount is still a string on the wire',
    hit.amount === null || typeof hit.amount === 'string', typeof hit.amount)
  check('the score comes back, so the client can order groups', typeof hit.score === 'number')
}

const narrowed = await api.get('/search', { q: 'INV', kinds: 'invoice' })
check('kinds narrows the search', narrowed.groups.every((g) => g.kind === 'invoice'),
  narrowed.groups.map((g) => g.kind).join(','))

// ---------------------------------------------------------------------------
section('4c. Confirm before posting (REQ-05)')
// ---------------------------------------------------------------------------

// `?dry_run=true` runs the real operation and rolls it back, so this section can build the
// thing it previews and leave nothing behind but the quotation it started from. Confirming a
// down payment is the action worth checking here: it posts SEVERAL documents in one
// transaction, which is the case a single-entry preview shape would quietly get wrong.
// As the CEO: creating a client is Sales' or the CEO's, confirming a down payment is
// Finance's, and this section needs both. Signed back in as Finance at the end so the
// sections after this one see the user they expect.
await login('rahmat@oscenia.co.id', PASSWORD)

const dpClient = await api.post('/clients', { name: `Preview Co ${Date.now()}` })
const dpQuote = await api.post('/quotations', {
  clientId: dpClient.id,
  eventType: 'Investor Summit',
  eventDate: '2026-11-18',
  preset: 'staged',
  lines: [{ label: 'Venue & Staging', amount: '480000000', estCost: '336000000' }],
})
await api.post(`/quotations/${dpQuote.id}/send`)
await api.post(`/quotations/${dpQuote.id}/accept`)

const before = (await api.get('/journal-entries', { limit: 1 })).total
const previewed = await api.post(
  `/quotations/${dpQuote.id}/confirm-down-payment`, {}, { dryRun: true }
)

check('a dry run answers with a preview', previewed.dryRun === true, String(previewed.dryRun))
check('several documents come back, not one', (previewed.entries || []).length > 1,
  `${(previewed.entries || []).length} entries`)
check('the preview is balanced', previewed.balanced === true)
check('and its totals are strings on the wire', typeof previewed.totalDebit === 'string',
  typeof previewed.totalDebit)

const previewLine = previewed.entries[0].lines[0]
check('a line names its account as well as its code', Boolean(previewLine.accountName),
  String(previewLine.accountName))
check('a previewed amount is still a string', typeof previewLine.debit === 'string',
  typeof previewLine.debit)
check('the voucher it WOULD take comes back', Boolean(previewed.entries[0].voucherPreview))

const after = (await api.get('/journal-entries', { limit: 1 })).total
check('and NOTHING was posted', after === before, `${before} -> ${after}`)

// No project either, which a ledger count alone would not catch.
const projects = await api.get('/projects')
check('no project was created', !projects.some((p) => p.quotationId === dpQuote.id))

// A preview of something the books refuse must refuse too, or the dialog offers a button
// that cannot work.
await api.post(`/quotations/${dpQuote.id}/confirm-down-payment`, {})
try {
  await api.post(`/quotations/${dpQuote.id}/confirm-down-payment`, {}, { dryRun: true })
  // Confirming twice is idempotent by design (projects.quotation_id is unique), so this
  // returns rather than throwing — and what matters is that it did not post a second time.
  const settled = await api.get('/projects')
  check('confirming twice does not mint a second project',
    settled.filter((p) => p.quotationId === dpQuote.id).length === 1)
} catch (err) {
  check('a refused preview refuses rather than inventing a posting', err.status === 409,
    `status ${err.status}`)
}

// ---------------------------------------------------------------------------
section('4d. Round 4: two dates, a tax figure and edited lines on the money endpoints')
// ---------------------------------------------------------------------------

// Still the CEO. These go through the same helpers the pop-up uses (lib/apiPostings.js), so a
// field name that does not survive the trip fails here rather than as a silently ignored key.
const { adaptPreview } = await import('../src/store/adapters.js')
const {
  planFromPreview, confirmDpBody, paymentBody, payDpBody, CLIENT_MONEY, VENDOR_MONEY,
} = await import('../src/lib/apiPostings.js')

const iso = (d) => d.toISOString().slice(0, 10)
// UTC today is never after Jakarta's today, so this is never a future date to the server.
const TODAY = iso(new Date())
const DOC = iso(new Date(Date.now() - 3 * 86400000))
const journalTotal = async () => (await api.get('/journal-entries', { limit: 1 })).total

async function acceptedQuote(name) {
  const c = await api.post('/clients', { name })
  const q = await api.post('/quotations', {
    clientId: c.id,
    eventType: 'Investor Summit',
    eventDate: '2026-12-02',
    preset: 'staged',
    lines: [{ label: 'Venue & Staging', amount: '480000000', estCost: '336000000' }],
  })
  await api.post(`/quotations/${q.id}/send`)
  await api.post(`/quotations/${q.id}/accept`)
  return q
}

// --- confirm DP: dry run seeds the pop-up, both dates come back -------------------------
const r4Quote = await acceptedQuote(`Round Four Co ${Date.now()}`)
const r4Path = `/quotations/${r4Quote.id}/confirm-down-payment`
const asked = { date: TODAY, documentDate: DOC, cashAccount: '1101', withhold: true, taxEdited: false, linesEdited: false }
const r4Before = await journalTotal()
const dpPreview = adaptPreview(await api.post(r4Path, confirmDpBody(asked), { dryRun: true }))
const dpPlan = planFromPreview(dpPreview, CLIENT_MONEY)
check('confirm-DP dry run: the receipt is found as the editable entry', Boolean(dpPlan.editable),
  dpPreview.entries.map((e) => e.memo).join(' | '))
check('and the DP invoice is a read-only companion', dpPlan.companions.length >= 1)
check('the receipt carries the receipt date', dpPlan.editable?.documentDate === DOC, String(dpPlan.editable?.documentDate))
check('and the received date as its entry date', dpPlan.editable?.date === TODAY, String(dpPlan.editable?.date))
check('the 1201 control line is the gross', dpPlan.editable?.locked.amount > 0, String(dpPlan.editable?.locked.amount))
check('the dry run posted nothing', (await journalTotal()) === r4Before)

// --- edited lines are accepted: split the cash across two lines --------------------------
const cashAt = dpPlan.editable.lines.findIndex((l) => l.account === '1101' && l.debit > 0)
const cashLine = dpPlan.editable.lines[cashAt]
const half = Math.round(cashLine.debit / 2)
const splitLines = [
  ...dpPlan.editable.lines.slice(0, cashAt),
  { ...cashLine, debit: half, note: 'First transfer' },
  { ...cashLine, debit: cashLine.debit - half, note: 'Second transfer' },
  ...dpPlan.editable.lines.slice(cashAt + 1),
]
const r4Project = await api.post(r4Path, confirmDpBody({ ...asked, linesEdited: true, lines: splitLines }))
check('confirm-DP with edited lines is accepted', Boolean(r4Project?.id))
const r4Entries = (await api.get('/journal-entries', { projectId: r4Project.id, limit: 50 })).items || []
const r4Receipt = r4Entries.find((e) => e.lines.some((l) => l.accountCode === '1201' && Number(l.credit) > 0)
  && e.lines.some((l) => l.accountCode === '1101'))
check('the receipt posted the edited lines', r4Receipt?.lines.length === splitLines.length,
  `${r4Receipt?.lines.length} lines`)
check('with both cash lines and their notes',
  (r4Receipt?.lines || []).filter((l) => l.accountCode === '1101').length === 2
  && (r4Receipt?.lines || []).some((l) => l.note === 'Second transfer'))
check('document_date round-trips onto the receipt', r4Receipt?.sourceDocumentDate === DOC, String(r4Receipt?.sourceDocumentDate))
check('and the received date is its entry date', r4Receipt?.entryDate === TODAY, String(r4Receipt?.entryDate))
const r4Invoice = r4Entries.find((e) => e !== r4Receipt && e.lines.some((l) => l.accountCode === '1201' && Number(l.debit) > 0))
check('the DP invoice was not touched by the edit', r4Invoice?.lines.length === 2, `${r4Invoice?.lines.length} lines`)

// --- a tampered control line is refused with a readable 422 ------------------------------
const tamperQuote = await acceptedQuote(`Tamper Co ${Date.now()}`)
const tamperPath = `/quotations/${tamperQuote.id}/confirm-down-payment`
const tPlan = planFromPreview(adaptPreview(await api.post(tamperPath, confirmDpBody(asked), { dryRun: true })), CLIENT_MONEY)
const tampered = tPlan.editable.lines.map((l) => {
  if (l.account === '1201') return { ...l, credit: l.credit - 1000000 }
  if (l.account === '1101') return { ...l, debit: l.debit - 1000000 }
  return l
})
const tBefore = await journalTotal()
try {
  await api.post(tamperPath, confirmDpBody({ ...asked, linesEdited: true, lines: tampered }))
  check('a tampered 1201 line is refused', false, 'it posted')
} catch (err) {
  check('a tampered 1201 line is refused with 422', err.status === 422, `status ${err.status}`)
  check('and the message is the server detail, naming 1201', typeof err.message === 'string' && err.message.includes('1201'),
    err.message)
}
check('and nothing was posted', (await journalTotal()) === tBefore)
check('nor a project created', !(await api.get('/projects')).some((p) => p.quotationId === tamperQuote.id))

// --- receive payment: dry run, then a tax override and both dates -----------------------
const scheduled = (await api.get('/invoices')).find((i) => i.projectId === r4Project.id && i.status === 'Scheduled')
await api.post(`/invoices/${scheduled.id}/issue`, {})
const payPath = `/invoices/${scheduled.id}/payments`
const payAsk = { date: TODAY, documentDate: DOC, cashAccount: '1101', withhold: true, taxAmount: 0, taxEdited: true }
const rpBefore = await journalTotal()
const rpPreview = adaptPreview(await api.post(payPath, paymentBody(10000000, payAsk), { dryRun: true }))
const rpPlan = planFromPreview(rpPreview, CLIENT_MONEY)
check('receive-payment ?dry_run answers with a preview', rpPreview.entries.length === 1, `${rpPreview.entries.length}`)
check('and posted nothing', (await journalTotal()) === rpBefore)
check('the preview carries the receipt date', rpPreview.entries[0]?.sourceDocumentDate === DOC)
check('a zero tax override gives no 1401 line', rpPlan.editable?.taxAmount === 0, String(rpPlan.editable?.taxAmount))
const receipt = await api.post(payPath, paymentBody(10000000, { ...payAsk, taxAmount: 150000 }))
const rpEntry = await api.get(`/journal-entries/${receipt.entryId}`)
check('a typed tax figure posts to 1401',
  rpEntry.lines.some((l) => l.accountCode === '1401' && Number(l.debit) === 150000), JSON.stringify(rpEntry.lines.map((l) => [l.accountCode, l.debit])))
check('document_date round-trips on a receipt', rpEntry.sourceDocumentDate === DOC, String(rpEntry.sourceDocumentDate))
check('payment_date is the entry date', rpEntry.entryDate === TODAY, String(rpEntry.entryDate))

// --- pay vendor DP: dry run shows the bill and the payment, then posts with both dates ---
const vendor = await api.post('/vendors', { name: `Round Four Audio ${Date.now()}`, category: 'Audio', termsDpPercent: '50' })
const order = await api.post('/purchase-orders', {
  vendorId: vendor.id, orderDate: TODAY, termsDpPercent: '50',
  lines: [{ itemLabel: 'Line array', qty: '2', unitPrice: '4500000' }],
})
await api.post(`/purchase-orders/${order.id}/approve`)
const dpBefore = await journalTotal()
const pdPreview = adaptPreview(await api.post(`/purchase-orders/${order.id}/pay-dp`,
  payDpBody({ date: TODAY, documentDate: DOC, cashAccount: '1101', withhold: true }), { dryRun: true }))
const pdPlan = planFromPreview(pdPreview, VENDOR_MONEY)
check('pay-DP ?dry_run previews the bill and the payment', pdPreview.entries.length === 2, `${pdPreview.entries.length}`)
check('the payment is the editable entry, at the DP', pdPlan.editable?.locked.amount === 4500000, String(pdPlan.editable?.locked.amount))
check('the bill is the companion', pdPlan.companions.length === 1)
check('the payment carries the receipt date', pdPlan.editable?.documentDate === DOC)
check('and the dry run posted nothing', (await journalTotal()) === dpBefore)
check('nor moved the order', (await api.get(`/purchase-orders/${order.id}`)).status === 'Approved')
const paidDp = await api.post(`/purchase-orders/${order.id}/pay-dp`,
  payDpBody({ date: TODAY, documentDate: DOC, cashAccount: '1101', withhold: true }))
const pdEntry = await api.get(`/journal-entries/${paidDp.entryId}`)
check('pay-DP document_date round-trips', pdEntry.sourceDocumentDate === DOC, String(pdEntry.sourceDocumentDate))

await login('lina@oscenia.co.id', PASSWORD)

// ---------------------------------------------------------------------------
section('5. Permission denials carry who may')
// ---------------------------------------------------------------------------

await logout()
await login('agus@oscenia.co.id', PASSWORD)   // Project Manager: may request, never approve

try {
  await api.post('/depreciation/run', {})
  check('a PM cannot run depreciation', false, 'it succeeded')
} catch (err) {
  check('a PM cannot run depreciation', err.status === 403, `status ${err.status}`)
  check('and the refusal names who may', err.permitted.length > 0, JSON.stringify(err.permitted))
  check('and names the action', err.action === 'manage_assets', err.action)
}

// ---------------------------------------------------------------------------
section('6. The refresh dance')
// ---------------------------------------------------------------------------

// Corrupt the access token but keep the refresh token. The next call must 401, refresh
// silently and replay — the user should never see it.
const goodRefresh = tokens.refresh
localStorage.setItem('oscenia.access', 'not-a-token')
const afterRefresh = await me()
check('an expired access token is refreshed and the call replayed', afterRefresh.role === 'pm', afterRefresh.role)
check('and a new access token was stored', tokens.access !== 'not-a-token')

// A refresh token is single-use: replaying the old one must fail.
try {
  await request('/auth/refresh', { method: 'POST', body: { refreshToken: goodRefresh }, auth: false })
  check('a spent refresh token is refused', false, 'it succeeded')
} catch (err) {
  check('a spent refresh token is refused', err.status === 401, `status ${err.status}`)
}

// ---------------------------------------------------------------------------
section('7. Signing out')
// ---------------------------------------------------------------------------

await login('lina@oscenia.co.id', PASSWORD)
await logout()
check('tokens are discarded', !tokens.access && !tokens.refresh)
try {
  await me()
  check('and the session is over', false, 'it succeeded')
} catch (err) {
  check('and the session is over', err.status === 401, `status ${err.status}`)
}

// ---------------------------------------------------------------------------

console.log('')
if (failures.length) {
  console.log(`\x1b[31m${failures.length} failed\x1b[0m, ${passed} passed`)
  failures.forEach((f) => console.log(`  \x1b[31m✗\x1b[0m ${f}`))
  process.exit(1)
}
console.log(`\x1b[32m✓ ${passed} assertions passed\x1b[0m against a live backend`)
