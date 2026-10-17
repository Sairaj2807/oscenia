// Loading the business data from the API.
//
// The order matters and is not incidental: projects need clients to resolve a name, the
// journal needs projects to resolve a project code, and realised cost needs the journal.
// Everything that can go in parallel does; everything that cannot is sequenced explicitly
// rather than by luck of timing.

import { api } from '../lib/api.js'
import { isProjectCostAccount } from '../lib/ledger.js'
import {
  adaptAccount,
  adaptCatalogueItem,
  adaptClient,
  adaptCrew,
  adaptEntry,
  adaptFixedAsset,
  adaptInventoryItem,
  adaptInvoice,
  adaptProcurement,
  adaptProject,
  adaptPurchaseOrder,
  adaptDeal,
  adaptDeliveryOrder,
  adaptMouTemplate,
  adaptLatestFeedback,
  adaptPettyCash,
  adaptQuotation,
  resolveApplications,
  adaptTaxConfig,
  adaptVendor,
  adaptVendorLifecycles,
  adaptVoucherSeries,
  index,
  withRealizedCost,
} from './adapters.js'

// A role that may not see a module is answered 403 for that module's collections. That is not a
// failed load: for that role the collection is simply empty, and its screens are not in the sidebar
// (nor reachable: see Guard in App.jsx). Only 403 is forgiven; a 500 or a dropped connection still
// fails the load. Without this one refusal aborted the whole load, so a Sales or Warehouse login,
// who may not see vendors, never got any data at all.
const optional = (request) =>
  request.catch((err) => {
    if (err?.status === 403) return []
    throw err
  })

// The journal is paged. The prototype's ledger math wants all of it — every balance is a
// fold over every entry — so this walks the pages rather than showing the first hundred
// entries and quietly reporting a wrong trial balance.
async function allEntries() {
  const items = []
  let offset = 0
  for (;;) {
    const page = await api.get('/journal-entries', { limit: 500, offset })
    items.push(...page.items)
    offset += page.items.length
    if (items.length >= page.total || page.items.length === 0) break
  }
  return items
}

// ---------------------------------------------------------------------------
// What each collection needs before it can be adapted
// ---------------------------------------------------------------------------
//
// Used by `loadSome` to expand a request. Two of these are worth explaining:
//
// `projects: ['journal']` looks wrong and is not. A project's `realizedCost` is *derived*
// from the journal rather than stored — the backend refuses to store it, because a
// denormalised cache of ledger activity is exactly what drifts. So a project cannot be
// adapted correctly without the entries to fold.
//
// `journal: ['projects']` is the other half: an entry renders `entry.project` as the project
// *business number*, which means the project rows have to be in hand to resolve it. The two
// are mutually dependent, which is why the expansion below carries a visited set.
const DEPENDS = {
  projects: ['clients', 'journal'],
  incentives: ['projects'],
  deliveryOrders: ['projects'],
  journal: ['projects'],
  invoices: ['projects'],
  purchaseOrders: ['projects', 'vendors'],
  inventory: ['projects'],
  quotations: ['clients', 'projects'],
  procurement: ['projects'],
  vendorCatalogue: ['vendors'],
}

/** The endpoint behind each collection. `journal` is special-cased — it is paged. */
const ENDPOINT = {
  accounts: '/accounts',
  clients: '/clients',
  vendors: '/vendors',
  crew: '/crew',
  projects: '/projects',
  invoices: '/invoices',
  purchaseOrders: '/purchase-orders',
  inventory: '/inventory',
  fixedAssets: '/fixed-assets',
  quotations: '/quotations',
  procurement: '/procurement-requests',
  vendorCatalogue: '/vendor-catalogue',
  vendorLifecycle: '/vendor-lifecycle',
  tags: '/tags',
  taxConfig: '/tax-config',
  settings: '/settings',
  pettyCash: '/petty-cash',
  mouTemplates: '/mou-templates',
  deliveryOrders: '/delivery-orders',
  voucherSeries: '/voucher-series',
}

/**
 * Everything that must be fetched to adapt `keys` correctly.
 *
 * Exported for the sake of being tested: `projects` and `journal` depend on each other, so a
 * naive walk recurses forever, and the failure mode of getting this subtly wrong is a screen
 * showing '—' where a project name belongs — silent, and indistinguishable from missing data.
 */
export function expandCollections(keys) {
  const out = new Set()
  const walk = (key) => {
    if (out.has(key)) return
    out.add(key)
    for (const dep of DEPENDS[key] || []) walk(dep)
  }
  for (const key of keys) walk(key)
  return out
}

/**
 * Re-read just the collections a write touched, and return a patch for the store.
 *
 * Why re-read at all, rather than patching state from the mutation's response: almost every
 * number on these screens is derived — `outstanding`, `collected`, `realizedCost`, every
 * balance in `lib/ledger.js` — and a write to one row moves several of them. Applying the
 * response locally means reimplementing the server's derivations in the client and keeping
 * the two in step forever. Re-reading is one more round trip and cannot drift.
 *
 * Why not just call `loadAll`: it is sixteen collections plus the paged journal, on every
 * button click. This fetches what the write actually affected, plus what is needed to adapt
 * it correctly, and nothing else.
 *
 * @param {string[]} keys collection names, as they appear in the store
 */
export async function loadSome(keys) {
  const needed = expandCollections(keys)
  const unknown = [...needed].filter((k) => k !== 'journal' && k !== 'incentives' && !ENDPOINT[k])
  if (unknown.length) throw new Error(`loadSome: no endpoint for ${unknown.join(', ')}`)

  // Every fetch is independent at the HTTP level; only the *adapting* is ordered.
  const wanted = [...needed]
  const rows = {}
  await Promise.all(
    wanted.map(async (key) => {
      if (key === 'incentives') return // worked out below, once the projects are adapted
      rows[key] = key === 'journal' ? await allEntries() : await api.get(ENDPOINT[key])
    })
  )

  const ctx = {
    clients: index(rows.clients),
    vendors: index(rows.vendors),
    projects: index(rows.projects),
  }

  const patch = {}
  if (rows.accounts) patch.accounts = rows.accounts.map(adaptAccount)
  if (rows.clients) patch.clients = rows.clients.map(adaptClient)
  if (rows.vendors) patch.vendors = rows.vendors.map(adaptVendor)
  if (rows.crew) patch.crew = rows.crew.map(adaptCrew)
  if (rows.journal) patch.journal = resolveApplications(rows.journal.map((e) => adaptEntry(e, ctx)))
  if (rows.invoices) patch.invoices = rows.invoices.map((i) => adaptInvoice(i, ctx))
  if (rows.purchaseOrders) {
    patch.purchaseOrders = rows.purchaseOrders.map((p) => adaptPurchaseOrder(p, ctx))
  }
  if (rows.inventory) patch.inventory = rows.inventory.map((i) => adaptInventoryItem(i, ctx))
  if (rows.fixedAssets) patch.fixedAssets = rows.fixedAssets.map(adaptFixedAsset)
  if (rows.procurement) patch.procurement = rows.procurement.map((p) => adaptProcurement(p, ctx))
  if (rows.vendorCatalogue) {
    patch.vendorCatalogue = rows.vendorCatalogue.map((c) => adaptCatalogueItem(c, ctx))
  }
  if (rows.tags) patch.tags = rows.tags
  if (rows.vendorLifecycle) patch.vendorLifecycle = adaptVendorLifecycles(rows.vendorLifecycle)
  if (rows.voucherSeries) patch.voucherSeries = rows.voucherSeries.map(adaptVoucherSeries)
  if (rows.taxConfig) patch.taxConfig = adaptTaxConfig(rows.taxConfig)
  if (rows.settings) {
    patch.settings = rows.settings
    // The two the screens read under their own names (the tolerance and the bonus threshold).
    patch.budgetTolerancePct = Number(rows.settings.budgetTolerancePct)
    patch.bonusThreshold = Number(rows.settings.bonusThreshold)
    patch.commissionPct = Number(rows.settings.commissionPct)
    patch.enforceVendorStage = Boolean(rows.settings.enforceVendorStage)
    patch.allowUnsignedDispatch = Boolean(rows.settings.allowUnsignedDispatch)
  }
  if (rows.mouTemplates) patch.mouTemplates = rows.mouTemplates.map(adaptMouTemplate)
  if (rows.deliveryOrders) patch.deliveryOrders = rows.deliveryOrders.map((o) => adaptDeliveryOrder(o, ctx))
  if (rows.pettyCash) {
    patch.pettyCash = adaptPettyCash(rows.pettyCash)
    patch.pettyCashTopUps = patch.pettyCash.toppedUp
  }

  if (rows.quotations) {
    const projectByQuotation = new Map(
      (rows.projects || [])
        .filter((p) => p.quotationId)
        .map((p) => [p.quotationId, p.projectNo])
    )
    patch.quotations = rows.quotations.map((q) =>
      adaptQuotation(q, { clients: ctx.clients, projectByQuotation })
    )
    patch.deals = patch.quotations.filter((q) => q.status === 'Accepted').map(adaptDeal)
  }

  // Derived last, and only when both halves are present — which `DEPENDS` guarantees.
  if (rows.projects) {
    patch.projects = withRealizedCost(
      rows.projects.map((p) => adaptProject(p, ctx)),
      patch.journal,
      isProjectCostAccount
    )
  }

  if (needed.has('incentives') && patch.projects) {
    Object.assign(patch, adaptLatestFeedback(patch.projects, await readPools(patch.projects, rows.projects)))
  }

  return patch
}

/**
 * The incentive pool of every project that has reached Post-Event Feedback (the only ones that can
 * have a rating), keyed by the project's business number. One request per such project, which is
 * a handful, not one per project.
 */
async function readPools(projects, rows) {
  const uuidOf = new Map((rows || []).map((r) => [r.projectNo, r.id]))
  const late = projects.filter((p) => !p.cancelled && ['Post-Event Feedback', 'Finished'].includes(p.stage))
  const pools = {}
  await Promise.all(
    late.map(async (p) => {
      pools[p.id] = await api.get(`/projects/${uuidOf.get(p.id) ?? p.uuid}/incentives`)
    })
  )
  return pools
}

/**
 * Fetch everything and return a patch for the store.
 *
 * Returns plain data rather than calling `set` itself, so it can be tested without a store
 * and so a partial failure cannot leave the app half-updated.
 */
export async function loadAll() {
  // Independent of everything, so all at once.
  //
  // Nothing here is wrapped in a `.catch`. It used to be, for `/tax-config`, `/settings`,
  // `/quotations` and `/procurement-requests`, and the effect was that a failing endpoint
  // rendered an *empty screen* rather than an error — which is indistinguishable from "the
  // feature was removed" and was the likeliest source of exactly that report from the client.
  // A failed load should fail.
  const [
    accounts,
    clientRows,
    vendorRows,
    crewRows,
    taxConfigRows,
    settings,
    tags,
    seriesRows,
  ] = await Promise.all([
      api.get('/accounts'),
      api.get('/clients'),
      api.get('/vendors'),
      api.get('/crew'),
      api.get('/tax-config'),
      api.get('/settings'),
      api.get('/tags'),
      api.get('/voucher-series'),
    ])

  const pettyCash = adaptPettyCash(await api.get('/petty-cash'))
  const mouTemplates = (await optional(api.get('/mou-templates'))).map(adaptMouTemplate)
  const clients = (clientRows || []).map(adaptClient)
  const vendors = (vendorRows || []).map(adaptVendor)
  const clientsByUuid = index(clientRows)
  const vendorsByUuid = index(vendorRows)

  // Projects need clients; everything after needs projects.
  const projectRows = await api.get('/projects')
  const projectsByUuid = index(projectRows)
  const ctx = { clients: clientsByUuid, vendors: vendorsByUuid, projects: projectsByUuid }
  let projects = (projectRows || []).map((p) => adaptProject(p, ctx))

  // A quotation does not know its project; the project points back at the quotation, and the
  // constraint is unique, so this inverts cleanly. Drafts simply have no entry.
  const projectByQuotation = new Map(
    (projectRows || [])
      .filter((p) => p.quotationId)
      .map((p) => [p.quotationId, p.projectNo])
  )

  const [
    entryRows,
    invoiceRows,
    poRows,
    inventoryRows,
    assetRows,
    quotationRows,
    procurementRows,
    catalogueRows,
    lifecycleRows,
  ] = await Promise.all([
    allEntries(),
    api.get('/invoices'),
    api.get('/purchase-orders'),
    api.get('/inventory'),
    optional(api.get('/fixed-assets')),
    optional(api.get('/quotations')),
    optional(api.get('/procurement-requests')),
    api.get('/vendor-catalogue'),
    optional(api.get('/vendor-lifecycle')),
  ])

  const journal = resolveApplications((entryRows || []).map((e) => adaptEntry(e, ctx)))

  // Realised cost is derived, never stored — see the note in adapters.js.
  projects = withRealizedCost(projects, journal, isProjectCostAccount)

  const deliveryOrders = (await optional(api.get('/delivery-orders'))).map((o) => adaptDeliveryOrder(o, ctx))
  const pools = await readPools(projects, projectRows)
  const quotations = (quotationRows || []).map((q) =>
    adaptQuotation(q, { clients: clientsByUuid, projectByQuotation })
  )

  return {
    accounts: (accounts || []).map(adaptAccount),
    clients,
    vendors,
    crew: (crewRows || []).map(adaptCrew),
    projects,
    journal,
    invoices: (invoiceRows || []).map((i) => adaptInvoice(i, ctx)),
    purchaseOrders: (poRows || []).map((p) => adaptPurchaseOrder(p, ctx)),
    inventory: (inventoryRows || []).map((i) => adaptInventoryItem(i, ctx)),
    fixedAssets: (assetRows || []).map(adaptFixedAsset),
    quotations,
    // Pending deals are accepted quotations (see `adaptDeal`); the seeded one is demo fiction.
    deals: quotations.filter((q) => q.status === 'Accepted').map(adaptDeal),
    procurement: (procurementRows || []).map((p) => adaptProcurement(p, ctx)),
    // The catalogue exists in the app and on the server, and was the one collection the
    // vendor screen reads that hydration never loaded — so it rendered "nothing matches
    // these filters" on live data regardless of the filters.
    vendorCatalogue: (catalogueRows || []).map((c) => adaptCatalogueItem(c, ctx)),
    // Each vendor's stage, checklist and history, keyed by the vendor's uuid.
    vendorLifecycle: adaptVendorLifecycles(lifecycleRows),
    // `{id, label}` on both sides, so there is nothing to translate.
    tags: tags || [],
    // The numbering scheme is administrator-configurable on both sides, and it was seed-only
    // here - so the editor showed the seeded seven while the server numbered vouchers from
    // its own, and a series added on one side was invisible on the other.
    voucherSeries: (seriesRows || []).map(adaptVoucherSeries),
    // Blanked on purpose. A client's past events are demo fiction -- there is no endpoint
    // for them -- and leaving the seeded ones in place on live data would inflate every
    // client's lifetime value with events that are not in the database. Showing less is
    // better than showing something untrue.
    clientHistory: {},
    // Loaded per client by `loadInteractions`, not here: the endpoint is client-scoped, so
    // fetching them all up front is one request per client for data one screen shows.
    interactions: {},
    taxConfig: adaptTaxConfig(taxConfigRows),
    settings: settings || undefined,
    budgetTolerancePct: settings ? Number(settings.budgetTolerancePct) : undefined,
    bonusThreshold: settings ? Number(settings.bonusThreshold) : undefined,
    commissionPct: settings ? Number(settings.commissionPct) : undefined,
    enforceVendorStage: settings ? Boolean(settings.enforceVendorStage) : undefined,
    pettyCash,
    pettyCashTopUps: pettyCash.toppedUp,
    mouTemplates,
    deliveryOrders,
    ...adaptLatestFeedback(projects, pools),
  }
}
