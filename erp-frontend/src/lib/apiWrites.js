// Request bodies for the store actions that save through the API (W3).
//
// Pure functions, so `verify-writes.mjs` can pin each wire shape without a server. Keys are
// camelCase; `lib/api.js` turns them into the backend's snake_case on the way out. The store's
// drafts are shaped for the pages (nested `bank`, `pic`, `terms`; business ids), the API's are
// flat and keyed by UUID — these are the one place that translates.

const money = (n) => String(Math.round((Number(n) || 0) * 100) / 100)
const text = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim())

/**
 * The vendor edit form's changes → `PATCH /vendors/{id}`: only the fields that were given, because the
 * server treats an absent key as "leave it" and a present one as the new value (an empty text clears it).
 * `patch` is shaped like the vendor itself: `{ npwp, bank: { name, account, holder }, pic: { name, phone,
 * email }, terms: { dpPercent, settlementDays } }`, each part optional.
 */
export function vendorPatchBody(patch) {
  const out = {}
  const take = (key, value, clean = (v) => String(v ?? '').trim()) => {
    if (value !== undefined) out[key] = clean(value)
  }
  take('npwp', patch.npwp)
  take('bankName', patch.bank?.name)
  take('bankAccount', patch.bank?.account)
  take('bankHolder', patch.bank?.holder)
  take('picName', patch.pic?.name)
  take('picPhone', patch.pic?.phone)
  take('picEmail', patch.pic?.email)
  take('termsDpPercent', patch.terms?.dpPercent, (v) => Math.min(100, Math.max(0, Number(v) || 0)))
  take('termsSettlementDays', patch.terms?.settlementDays, (v) => Math.max(0, Math.round(Number(v) || 0)))
  return out
}

/** The project edit form's changes → `PATCH /projects/{id}`: only name, division and event date, and only the ones given. */
export function projectPatchBody(patch) {
  const out = {}
  if (patch.name !== undefined) out.name = String(patch.name).trim()
  if (patch.division !== undefined) out.division = String(patch.division).trim()
  if (patch.eventDate !== undefined) out.eventDate = patch.eventDate
  return out
}

/** The crew form's changes → `PATCH /crew/{id}` (or the body of `POST /crew`); only the fields given. */
export function crewBody(patch) {
  const out = {}
  if (patch.name !== undefined) out.name = String(patch.name).trim()
  if (patch.role !== undefined) out.role = String(patch.role).trim()
  if (patch.baseRate !== undefined) out.baseRate = String(Math.round((Number(patch.baseRate) || 0) * 100) / 100)
  if (patch.lastRating !== undefined) out.lastRating = String(Math.min(10, Math.max(0, Number(patch.lastRating) || 0)))
  return out
}

/** `addVendor`'s draft → `POST /vendors`. */
export function vendorBody(draft) {
  return {
    name: String(draft.name || '').trim(),
    category: text(draft.category),
    baselinePrice: money(draft.baseline),
    npwp: text(draft.npwp),
    pph23Rate: draft.pph23Rate == null ? null : Number(draft.pph23Rate) || 0,
    bankName: text(draft.bank?.name),
    bankAccount: text(draft.bank?.account),
    bankHolder: text(draft.bank?.holder),
    picName: text(draft.pic?.name),
    picPhone: text(draft.pic?.phone),
    picEmail: text(draft.pic?.email),
    termsDpPercent: Number(draft.terms?.dpPercent ?? 50),
    termsSettlementDays: Number(draft.terms?.settlementDays ?? 14),
    tags: [...(draft.tags || [])],
  }
}

/**
 * `createPurchaseOrder`'s draft → `POST /purchase-orders`.
 *
 * `vendor` and `project` are the store rows the draft's business ids point at; `catalogue` is the
 * vendor catalogue, to turn each line's catalogue number into the server's key. Returns
 * `{ error }` instead when something has no server key (a row that only exists in this browser).
 */
export function poBody(draft, { vendor, project, catalogue }) {
  if (!vendor?.uuid) return { error: `${draft.vendorId} has no server key, so an order cannot be raised with it.` }
  if (!project?.uuid) return { error: `${draft.project} has no server key, so an order cannot be tagged to it.` }
  const lines = (draft.lines || []).map((l) => ({
    catalogueItemId: catalogue.find((c) => c.id === l.itemId)?.uuid ?? null,
    itemLabel: String(l.item || '').trim(),
    qty: String(Number(l.qty) || 0),
    unitPrice: money(l.unitPrice),
  }))
  return {
    body: {
      vendorId: vendor.uuid,
      projectId: project.uuid,
      eventDate: draft.eventDate || null,
      lines,
      termsDpPercent: draft.terms?.dpPercent ?? null,
      termsSettlementDays: draft.terms?.settlementDays ?? null,
    },
  }
}

/** `addAccount`'s draft → `POST /accounts`. `parent`/`cash`/`group` are the page's names. */
export function accountCreateBody(draft) {
  return {
    code: String(draft.code || '').trim(),
    name: String(draft.name || '').trim(),
    type: draft.type,
    groupLabel: text(draft.group),
    parentCode: draft.parent || null,
    isCash: draft.cash == null ? null : Boolean(draft.cash),
    taxKey: draft.tax || null,
  }
}

/** `updateAccount`'s patch → `PATCH /accounts/{code}`: only what the server lets change. */
export function accountPatchBody(patch) {
  const body = {}
  if ('name' in patch) body.name = String(patch.name || '').trim()
  if ('group' in patch) body.groupLabel = text(patch.group)
  if ('cash' in patch) body.isCash = Boolean(patch.cash)
  if ('tax' in patch) body.taxKey = patch.tax || null
  return body
}

/**
 * A quotation's draft → `POST /quotations` (and, with `partial`, `PATCH /quotations/{id}`).
 *
 * The page names the client by *name*; the API wants its key, so `clients` (the store's rows) does
 * the join. A schedule goes over only when the page sent one. Returns `{ error }` when the client
 * has no server key (a row that only exists in this browser).
 */
export function quotationBody(draft, { clients }, { partial = false } = {}) {
  const body = {}
  if (!partial) {  // the API cannot move a quotation to another client
    const client = clients.find((c) => c.name === draft.client)
    if (!client?.uuid) return { error: `${draft.client || 'That client'} has no server key, so a quotation cannot be raised for them.` }
    body.clientId = client.uuid
  }
  if (!partial || draft.eventType != null) body.eventType = String(draft.eventType || '').trim()
  if (!partial || 'eventDate' in draft) body.eventDate = draft.eventDate || null
  if (draft.lineItems) {
    body.lines = draft.lineItems.map((l) => ({
      label: String(l.label || '').trim(),
      amount: money(l.amount),
      estCost: money(l.estCost),
    }))
  }
  if (draft.dpSchedule?.length) {
    body.stages = draft.dpSchedule.map((s) => ({
      label: s.label,
      basis: s.basis,
      value: String(Number(s.value) || 0),
      anchor: s.anchor,
      offsetDays: Number(s.offsetDays) || 0,
    }))
  }
  if (draft.template) body.mouTemplateId = draft.template
  return { body }
}

/**
 * `addProcurementRequest`'s draft → `POST /procurement-requests`. `requester` is passed only when
 * the page named one (an explicit blank is refused before this); otherwise the server uses the
 * signed-in user. The project is the page's business number; the API wants its key.
 */
export function procurementBody(draft, { projects, requester }) {
  const project = draft.project ? projects.find((p) => p.id === draft.project) : null
  if (draft.project && !project?.uuid) return { error: `${draft.project} has no server key, so a request cannot be tagged to it.` }
  const body = {
    category: String(draft.category || '').trim(),
    amount: money(draft.amount),
    projectId: project?.uuid ?? null,
  }
  if (requester) body.requestedBy = requester
  return { body }
}

/** `capitaliseAsset`'s draft → `POST /fixed-assets`. `inventory` turns the page's stock number into the key. */
export function assetBody(draft, { post = true, payFrom = '1101' } = {}, { inventory = [] } = {}) {
  const stock = draft.inventoryId ? inventory.find((i) => i.id === draft.inventoryId) : null
  return {
    name: String(draft.name || '').trim(),
    acquiredOn: draft.acquiredOn,
    cost: money(draft.cost),
    salvage: money(draft.salvage),
    usefulLifeMonths: Math.round(Number(draft.usefulLifeMonths) || 0),
    method: draft.method || 'straight-line',
    category: text(draft.category),
    inventoryItemId: stock?.uuid ?? null,
    post,
    payFrom,
  }
}

/**
 * The warehouse's return form → `POST /inventory/{id}/return`. The form splits a quantity three
 * ways; the server takes the lost and damaged parts and treats the rest as good.
 */
export function returnBody(breakdown, projectUuid) {
  return {
    condition: 'good',
    lostQty: String(Math.max(0, Number(breakdown?.lost) || 0)),
    damagedQty: String(Math.max(0, Number(breakdown?.damaged) || 0)),
    projectId: projectUuid ?? null,
  }
}

/**
 * The new-delivery-order form → `POST /delivery-orders`. A line is a stock item (by its number, turned
 * into the server's key) or free text. Returns `{ error }` for what would be refused.
 */
export function deliveryBody(draft, { projects, inventory }) {
  const project = projects.find((p) => p.id === draft.project)
  if (!project?.uuid) return { error: `${draft.project || 'Pick a project'}: no server key, so an order cannot be drafted for it.` }
  const lines = []
  for (const l of draft.lines || []) {
    const qty = Number(l.qty)
    if (!(qty > 0)) continue
    const stock = l.itemId ? inventory.find((i) => i.id === l.itemId) : null
    if (l.itemId && !stock?.uuid) return { error: `${l.itemId} has no server key.` }
    const text = String(l.item || '').trim()
    if (!stock && !text) continue
    lines.push({ inventoryItemId: stock?.uuid ?? null, item: stock ? null : text, qty: String(qty) })
  }
  if (!lines.length) return { error: 'Add at least one line with a quantity.' }
  return { body: { projectId: project.uuid, eventDate: draft.eventDate || null, lines } }
}

/**
 * `updateAsset`'s patch → `PATCH /fixed-assets/{id}`: only what the server lets be revised (name,
 * category, salvage, useful life, method). Cost and the posted figures are sealed server-side, so
 * they are not sent even if the caller offers them.
 */
export function assetPatchBody(patch) {
  const body = {}
  if ('name' in patch) body.name = String(patch.name || '').trim()
  if ('category' in patch) body.category = text(patch.category)
  if ('salvage' in patch) body.salvage = money(patch.salvage)
  if ('usefulLifeMonths' in patch) body.usefulLifeMonths = Math.round(Number(patch.usefulLifeMonths) || 0)
  if ('method' in patch) body.method = patch.method
  return body
}
