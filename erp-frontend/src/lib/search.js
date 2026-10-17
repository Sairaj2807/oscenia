// The global search box.
//
// The client's complaint was that it found only some things. That was true, and the reason
// was structural: it searched the collections the browser happened to be holding -- six of
// them -- so purchase orders, stock, crew, fixed assets and petty-cash requests could not
// be found at all, and nothing could be found before it had been loaded. A cap of eight
// results hid whatever was left.
//
// On live data the search is the server's (`GET /search`), which reads the database and
// ranks in SQL. What lives here is two things the server cannot do for us: the shape the
// result list renders, and the same search over SEED data, so the offline demo keeps
// working. Both produce the same hit shape, so the component renders one thing.

/** Where each kind of hit navigates to, and what it is called. */
export const SEARCH_KINDS = {
  project: { label: 'Projects', to: (h) => `/projects/${h.id}` },
  client: { label: 'Clients', to: (h) => `/crm/${h.id}` },
  quotation: { label: 'Quotations', to: () => '/quotations' },
  invoice: { label: 'Invoices', to: () => '/receivables' },
  purchase_order: { label: 'Purchase Orders', to: () => '/purchase-orders' },
  vendor: { label: 'Vendors', to: (h) => `/vendors/${h.id}` },
  journal: { label: 'Journal', to: () => '/accounting' },
  procurement: { label: 'Petty Cash', to: () => '/procurement' },
  inventory: { label: 'Stock', to: () => '/warehouse' },
  fixed_asset: { label: 'Fixed Assets', to: () => '/fixed-assets' },
  crew: { label: 'Crew', to: () => '/payroll' },
  // These four open through their parent (the channel, the project's workspace, the event): a
  // message, a task or a file has no page of its own, and a hit never carries a raw file URL.
  chat_message: { label: 'Chat', to: (h) => refRoute(h.ref) },
  task: { label: 'Tasks', to: (h) => refRoute(h.ref) },
  event: { label: 'Events', to: (h) => `/events/${h.id}` },
  file: { label: 'Files', to: (h) => refRoute(h.ref) },
}

/** `channel:<id>`, `project:<no>` -> the page that shows it. Anything else goes nowhere. */
export function refRoute(ref) {
  const at = String(ref || '').indexOf(':')
  if (at < 0) return '/'
  const [type, id] = [ref.slice(0, at), ref.slice(at + 1)]
  if (!id) return '/'
  if (type === 'channel') return `/chat/${id}`
  if (type === 'project') return `/workspace/${id}`
  if (type === 'event') return `/events/${id}`
  return '/'
}

// Amounts match within 1% or Rp 1,000,000, whichever is wider -- typing "192000000" should
// find a Rp 192,000,000 invoice without demanding the exact figure.
//
// The band is measured from what was TYPED, not from the row it is compared against, which
// is what the server does in SQL. Measuring it from the row would make a search match or
// miss depending on which record it happened to be testing.
export function amountMatches(typed, target) {
  if (!typed) return false
  const tolerance = Math.max(1_000_000, typed * 0.01)
  return Math.abs(target - typed) <= tolerance
}

// Rank bands, matching the server's so a demo and a live search order results the same way.
const EXACT = 100
const NUMBER_PREFIX = 80
const NAME_PREFIX = 70
const NAME_PART = 55
const OTHER_FIELD = 40
const AMOUNT = 35

// Three digits is a quantity or a year; four is a figure.
const MIN_AMOUNT_DIGITS = 4
export const MIN_QUERY = 2

/** Flatten the server's grouped response into render-ready hits. */
export function flattenGroups(payload) {
  return (payload?.groups || []).flatMap((group) =>
    (group.hits || []).map((hit) => ({
      kind: hit.kind,
      id: hit.id,
      uuid: hit.uuid ?? null,
      title: hit.title,
      meta: hit.subtitle ?? null,
      // Money arrives as a string, deliberately. This is the one place it becomes a number.
      value: hit.amount == null ? null : Number(hit.amount),
      score: hit.score ?? 0,
      ref: hit.ref ?? null,
    }))
  )
}

function parse(query) {
  const raw = String(query || '').trim()
  if (raw.length < MIN_QUERY) return null
  const digits = raw.replace(/[^0-9]/g, '')
  return {
    text: raw.toLowerCase(),
    amount: digits.length >= MIN_AMOUNT_DIGITS ? Number(digits) : null,
  }
}

function scoreOf(term, { number, name, others = [], money = null }) {
  const contains = (text) => text && String(text).toLowerCase().includes(term.text)
  const starts = (text) => text && String(text).toLowerCase().startsWith(term.text)

  if (number && String(number).toLowerCase() === term.text) return EXACT
  if (starts(number)) return NUMBER_PREFIX
  if (starts(name)) return NAME_PREFIX
  if (contains(name)) return NAME_PART
  if (others.some(contains)) return OTHER_FIELD
  if (term.amount !== null && money !== null && amountMatches(term.amount, money)) return AMOUNT
  return 0
}

/**
 * Search the seeded collections in memory.
 *
 * Used only when there is no backend. The store calls the API otherwise, because state in
 * the browser is a subset of the database by definition -- which was the original bug.
 */
export function searchLocally(state, query) {
  const term = parse(query)
  if (!term) return []

  const { projects = [], clients = [], vendors = [], invoices = [], quotations = [] } = state
  const { journal = [], purchaseOrders = [], inventory = [], crew = [], fixedAssets = [] } = state
  const { procurement = [], tags = [] } = state
  const out = []
  const add = (hit, score) => {
    if (score > 0) out.push({ ...hit, score })
  }

  projects.forEach((p) =>
    add(
      { kind: 'project', id: p.id, title: p.name, meta: `${p.id} · ${p.client}`, value: p.contractValue },
      scoreOf(term, { number: p.id, name: p.name, others: [p.client, p.division], money: p.contractValue })
    )
  )
  clients.forEach((c) =>
    add(
      { kind: 'client', id: c.id, title: c.name, meta: [c.contact, c.phone].filter(Boolean).join(' · ') },
      scoreOf(term, { number: c.id, name: c.name, others: [c.contact, c.phone, c.email] })
    )
  )
  quotations.forEach((q) => {
    const total = (q.lineItems || []).reduce((a, l) => a + l.amount, 0)
    add(
      { kind: 'quotation', id: q.id, title: `${q.client} — ${q.eventType}`, meta: `${q.id} · ${q.status}`, value: total },
      scoreOf(term, { number: q.id, name: q.eventType, others: [q.client, q.projectId], money: total })
    )
  })
  invoices.forEach((i) =>
    add(
      { kind: 'invoice', id: i.id, title: `${i.id} — ${i.type}`, meta: `${i.project} · ${i.status}`, value: i.amount },
      scoreOf(term, { number: i.id, name: i.type, others: [i.project], money: i.amount })
    )
  )
  purchaseOrders.forEach((po) => {
    // Seed orders carry `vendorId` and no name; adapted ones carry both. Resolving here
    // covers each, and searching a purchase order by its vendor is the whole point.
    const vendorName = po.vendor || vendors.find((v) => v.id === po.vendorId)?.name || ''
    const total = (po.lines || []).reduce(
      (a, l) => a + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0),
      0
    ) || po.actualTotal || po.total || 0
    add(
      {
        kind: 'purchase_order',
        id: po.id,
        title: `${po.id} — ${vendorName || '—'}`,
        meta: `${po.status}${po.project ? ` · ${po.project}` : ''}`,
        value: total || null,
      },
      scoreOf(term, {
        number: po.id,
        name: vendorName,
        others: [po.project, ...(po.lines || []).map((l) => l.item || l.itemLabel)],
        money: total,
      })
    )
  })
  vendors.forEach((v) => {
    const tagLabels = (v.tags || []).map((id) => tags.find((x) => x.id === id)?.label || id)
    add(
      { kind: 'vendor', id: v.id, title: v.name, meta: tagLabels.length ? tagLabels.join(' · ') : v.category },
      scoreOf(term, { number: v.id, name: v.name, others: [v.category, v.pic?.name, v.npwp, ...tagLabels] })
    )
  })
  journal.forEach((e) => {
    const total = (e.lines || []).reduce((a, l) => a + (Number(l.debit) || 0), 0)
    add(
      { kind: 'journal', id: e.id, title: e.memo, meta: `${e.voucherNo || e.id} · ${e.source?.kind || ''}`.trim(), value: total },
      scoreOf(term, { number: e.voucherNo || e.id, name: e.memo, others: [e.id, e.groupRef, e.project], money: total })
    )
  })
  procurement.forEach((r) => {
    const requester = r.by || r.requestedBy || ''
    add(
      {
        kind: 'procurement',
        id: r.id,
        title: `${r.id} — ${r.category}`,
        meta: [requester, r.status].filter(Boolean).join(' · '),
        value: r.amount,
      },
      scoreOf(term, { number: r.id, name: r.category, others: [requester, r.project], money: r.amount })
    )
  })
  inventory.forEach((i) =>
    add(
      { kind: 'inventory', id: i.id, title: i.item, meta: `${i.qty} ${i.unit || ''} · ${i.status}`.trim(), value: i.unitValue },
      scoreOf(term, { number: i.id, name: i.item, others: [i.unit, i.type], money: i.unitValue })
    )
  )
  fixedAssets.forEach((a) =>
    add(
      { kind: 'fixed_asset', id: a.id, title: a.name, meta: `${a.category || '—'} · ${a.status || 'active'}`, value: a.cost },
      scoreOf(term, { number: a.id, name: a.name, others: [a.category], money: a.cost })
    )
  )
  crew.forEach((c) =>
    add(
      { kind: 'crew', id: c.id, title: c.name, meta: c.role, value: c.baseRate },
      scoreOf(term, { number: c.id, name: c.name, others: [c.role], money: c.baseRate })
    )
  )

  return out.sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)))
}

/**
 * Group hits for display, best group first.
 *
 * Same rule as the server's: the group holding the best single hit leads, so an exact
 * purchase order is not buried under three fuzzy project names.
 */
export function groupHits(hits, { perKind = 5 } = {}) {
  const byKind = new Map()
  for (const hit of hits) {
    const list = byKind.get(hit.kind) || []
    if (list.length < perKind) list.push(hit)
    byKind.set(hit.kind, list)
  }
  return [...byKind.entries()]
    .map(([kind, list]) => ({
      kind,
      label: SEARCH_KINDS[kind]?.label || kind,
      hits: list,
      best: Math.max(...list.map((h) => h.score || 0)),
    }))
    .sort((a, b) => b.best - a.best)
}
