// API shapes in, prototype shapes out.
//
// This file is the whole reason 25 pages did not have to change. The backend models the
// business properly — UUID keys, foreign keys, money as exact decimal strings — and the
// pages were written against a seed file that modelled it loosely: business codes as ids,
// client names inlined, amounts as JavaScript numbers. Rather than bend either side, the
// translation lives here, once.
//
// ---------------------------------------------------------------------------
// Two conversions worth understanding before you change anything
// ---------------------------------------------------------------------------
//
// **`id` is the business number, `uuid` is the key.** Pages do `project.id` and expect
// 'EVT-0001'; routes are `/projects/:id`. The API's `id` is a UUID and its `project_no` is
// the business number. So the adapter maps `id ← project_no` and carries the real key as
// `uuid`, which is what every mutation must send back. Getting this backwards produces a URL
// full of UUIDs and a page that cannot find its own record.
//
// **Money becomes a Number here, and only here.** `lib/api.js` deliberately leaves
// NUMERIC(18,2) as the string the server sent, so nothing rounds in transit. But the pages
// do arithmetic — `a + b`, `money(x)` — and rewriting all of that to decimal arithmetic is a
// far larger change than this phase is for. So the conversion happens at this boundary,
// named and deliberate rather than accidental.
//
// It is safe within a bound worth stating: IEEE-754 doubles are exact for integers below
// 2^53, which at two decimal places is about 90 trillion rupiah. Oscenia's books are six
// orders of magnitude below that. W4 removes the need entirely by taking every total from
// the server, which computes them in exact decimal.

/** Money string → number, at the one place where that is allowed. */
export const amount = (value) => (value == null ? 0 : Number(value))

/** Build an id→value index. */
const index = (rows, key = 'id') => new Map((rows || []).map((r) => [r[key], r]))

// ---------------------------------------------------------------------------
// Masters
// ---------------------------------------------------------------------------

export function adaptClient(row) {
  return {
    ...row,
    id: row.clientNo,
    uuid: row.id,
    // The server records no preferred event types; the screens list them, so an empty list, not undefined.
    prefEvents: row.prefEvents ?? [],
    satisfaction: Number(row.satisfaction ?? 0),
    // The prototype renders '—' for a date nobody recorded; the backend stores null, which
    // is the honest version of the same thing. Converted back for display.
    birthday: row.birthday || '—',
    anniversary: row.anniversary || '—',
  }
}

export function adaptVendor(row) {
  return {
    ...row,
    id: row.vendorNo,
    uuid: row.id,
    baseline: amount(row.baselinePrice),
    score: Number(row.score ?? 0),
    pph23Rate: row.pph23Rate == null ? null : Number(row.pph23Rate),
    bank: { name: row.bankName, account: row.bankAccount, holder: row.bankHolder },
    pic: { name: row.picName, phone: row.picPhone, email: row.picEmail },
    terms: {
      dpPercent: Number(row.termsDpPercent ?? 50),
      settlementDays: Number(row.termsSettlementDays ?? 14),
    },
  }
}

/**
 * A vendor's lifecycle from the server, in the shape the demo keeps (`useProto.vendorStages`), so the board
 * draws either. History is oldest first. `checklist` and `resumeTo` are the server's own answers.
 */
export function adaptVendorLifecycle(row) {
  const history = (row.history || []).map((h) => ({ stage: h.stage, at: h.at, by: h.by, ...(h.reason ? { reason: h.reason } : {}) }))
  const last = history[history.length - 1]
  return {
    stage: row.stage,
    at: row.since || last?.at || null,
    by: last?.by || null,
    ...(row.reason ? { reason: row.reason } : {}),
    checks: row.checks || {},
    history,
    checklist: row.checklist || null,
    checklistComplete: Boolean(row.checklistComplete),
    hasAgreementFile: Boolean(row.hasAgreementFile),
    hasLivePo: Boolean(row.hasLivePo),
    resumeTo: row.resumeTo || null,
  }
}

/** The rows as a map keyed by the vendor's uuid, which is what `vendorKey` gives a live vendor. */
export const adaptVendorLifecycles = (rows) => Object.fromEntries((rows || []).map((r) => [r.vendorId, adaptVendorLifecycle(r)]))

export function adaptCrew(row) {
  return {
    ...row,
    id: row.crewNo,
    uuid: row.id,
    baseRate: amount(row.baseRate),
    lastRating: Number(row.lastRating ?? 0),
    active: row.active !== false,
  }
}

export function adaptAccount(row) {
  // Accounts are keyed by code in both models, so this one is nearly a pass-through — the
  // chart of accounts was the part of the prototype that was already modelled properly.
  return {
    ...row,
    // The page's names for what the API calls `group_label`, `parent_code` and `tax_key`:
    // left under the API's names the chart showed no groups and flattened every sub-account.
    group: row.groupLabel,
    parent: row.parentCode ?? undefined,
    tax: row.taxKey ?? undefined,
    cash: Boolean(row.isCash),
    contra: Boolean(row.isContra),
  }
}

/**
 * Tax configuration: a list from the API, a keyed object for the app.
 *
 * `GET /tax-config` returns `[{key, label, rate, active, accountCode}, …]`. Every consumer in
 * the prototype indexes it by name — `taxConfig.pph23`, `taxConfig.corporate` — and
 * `lib/ledger.js` reads `.rate` and `.active` off the result.
 *
 * Assigning the raw list is silently destructive rather than loud: `withholding()` looks up
 * `taxConfig['pph23']` on an array, gets `undefined`, and returns zero withholding; likewise
 * `corporateTax()` returns no provision, so NPAT collapses onto profit before tax. Nothing
 * throws, and the numbers are simply wrong. Hence this adapter.
 */
export function adaptTaxConfig(rows) {
  if (!Array.isArray(rows)) return undefined
  const out = {}
  for (const row of rows) {
    out[row.key] = {
      label: row.label,
      rate: Number(row.rate ?? 0),
      active: Boolean(row.active),
      // The prototype's field name, which `TaxSettings` and the posting code read.
      account: row.accountCode ?? null,
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export function adaptProject(row, { clients }) {
  return {
    ...row,
    id: row.projectNo,
    uuid: row.id,
    // Pages show a client *name*; the API stores a foreign key. Resolved here so no page has
    // to learn how to join.
    client: clients.get(row.clientId)?.name ?? '—',
    clientUuid: row.clientId,
    // The PM's name, from the server (empty until someone is named; the seed's `pm` is the demo's).
    pm: row.pmName || undefined,
    contractValue: amount(row.contractValue),
    estimatedCost: amount(row.estimatedCost),
    // `realizedCost` is deliberately NOT stored by the backend — the fix plan flagged it as a
    // denormalised cache that drifts. It is derived from the journal in `withRealizedCost`
    // below, once, after the entries are in.
    realizedCost: 0,
  }
}

// ---------------------------------------------------------------------------
// The journal
// ---------------------------------------------------------------------------

export function adaptEntry(row, { projects }) {
  return {
    id: row.entryNo,
    uuid: row.id,
    voucherNo: row.voucherNo,
    series: row.series,
    // The document this entry is filed under. Null unless it joined a group - an entry that
    // anchors one is named BY its own voucher number rather than stamped with it, because
    // the server cannot update a posted row. See lib/vouchers.js.
    groupRef: row.groupRef ?? null,
    date: row.entryDate,
    memo: row.memo,
    // Pages compare `entry.project === project.id`, and project.id is the business number.
    project: row.projectId ? (projects.get(row.projectId)?.projectNo ?? null) : null,
    projectUuid: row.projectId,
    lines: (row.lines || []).map((line) => ({
      account: line.accountCode,
      debit: amount(line.debit),
      credit: amount(line.credit),
      note: line.note,
    })),
    source: {
      kind: row.sourceKind,
      ref: row.sourceRef,
      due: row.sourceDue,
      // What the VENDOR dated their invoice, where that differs from the posting date. A
      // payable is a journal entry rather than a row in a bills table, so this is the only
      // place it can live -- and it was being dropped here, which made the column the
      // client asked for unrenderable on live data.
      documentDate: row.sourceDocumentDate ?? null,
      vendorId: row.sourceVendorId,
      settlement: row.sourceSettlement,
    },
    // The server's keys (UUIDs) for the documents this entry settles. `openItems` matches them
    // against `entry.id`, which is the entry NUMBER, so they are translated once the whole journal
    // is in (`resolveApplications`, below). Left as UUIDs a payment never matched its bill and a
    // paid bill showed as unpaid in the browser's payables.
    appliedTo: row.appliedTo || [],
    reversalOf: row.reversalOfId,
    reversedBy: row.reversedById,
  }
}

// ---------------------------------------------------------------------------
// AR / AP
// ---------------------------------------------------------------------------

export function adaptInvoice(row, { projects }) {
  return {
    ...row,
    id: row.invoiceNo,
    uuid: row.id,
    project: projects.get(row.projectId)?.projectNo ?? null,
    projectUuid: row.projectId,
    amount: amount(row.amount),
    // The prototype calls it `paid`; the API calls it `collected`, which is the better name
    // because it is gross — PPh 23 withheld by the client still settles the receivable.
    paid: amount(row.collected),
    outstanding: amount(row.outstanding),
    due: row.dueDate,
  }
}

export function adaptPurchaseOrder(row, { projects, vendors }) {
  const vendor = vendors.get(row.vendorId)
  return {
    ...row,
    id: row.poNo,
    uuid: row.id,
    project: projects.get(row.projectId)?.projectNo ?? null,
    projectUuid: row.projectId,
    vendor: vendor?.name ?? '—',
    // `vendorId` must be the vendor's BUSINESS number, because that is what every reader
    // treats it as: `/vendors/:id` routes on it, the PO list looks the vendor up with
    // `vendors.find(v => v.id === po.vendorId)`, and the vendor page lists its own orders
    // with `po.vendorId === id`. Left as the spread-through UUID it was, none of those
    // matched: the PO list showed no vendor names, its links pointed at a route that does
    // not resolve, the Settle dialog lost its vendor, and the vendor page reported "no
    // purchase orders raised with this vendor yet" — which is the second empty panel in the
    // client's screenshot, next to the empty catalogue.
    vendorId: vendor?.vendorNo ?? null,
    vendorUuid: row.vendorId,
    total: amount(row.total),
    lines: (row.lines || []).map((l) => ({ ...l, amount: amount(l.amount) })),
  }
}

/**
 * A CRM note.
 *
 * `author_name` is resolved server-side for the same reason as on a quotation: the timeline
 * shows who wrote each note and there is no users endpoint to resolve an id against. A note
 * attributed to a UUID is not attributed at all.
 */
export function adaptInteraction(row) {
  return {
    ...row,
    id: row.id,
    date: row.interactionDate,
    by: row.authorName ?? '—',
    note: row.note,
    type: row.type,
    edited: Boolean(row.editedAt),
    // Real files filed against the note: an id (to open it), its name and size. (The demo keeps
    // plain names, which the screen also understands.)
    attachments: (row.attachments || []).map((f) => ({ id: f.id, name: f.filename, size: f.byteSize })),
  }
}

// ---------------------------------------------------------------------------
// Quotations
// ---------------------------------------------------------------------------

/**
 * A quotation, in the shape the quotation screens and the PDF writer expect.
 *
 * This is the widest gap in the whole file, and it is worth being explicit about why: the API
 * returns `lines`, `schedule`, a `client_id` and a `contract_value` string; the pages were
 * written against `lineItems`, `dpSchedule`, a client *name* and plain numbers. Before this
 * adapter existed, `loadAll` passed quotations through untouched, so every quotation screen
 * received `quotationNo`/`clientId`/`lines` and rendered blank.
 *
 * @param ctx.clients            index of raw client rows, for the name
 * @param ctx.projectByQuotation quotation uuid -> project business number, for accepted quotes
 */
export function adaptQuotation(row, { clients, projectByQuotation }) {
  // `ResolvedStageOut` already carries everything `lib/billing.js` wants; the only work is
  // making the numbers numbers. The extra server-computed fields (`amount`, `due`, `percent`)
  // are kept — they are strictly more than the prototype's own schedule had.
  const dpSchedule = (row.schedule || []).map((st) => ({
    stageNo: st.stageNo,
    label: st.label,
    basis: st.basis,
    value: Number(st.value ?? 0),
    anchor: st.anchor,
    offsetDays: Number(st.offsetDays ?? 0),
    amount: amount(st.amount),
    due: st.due,
    percent: Number(st.percent ?? 0),
    invoiceType: st.invoiceType,
  }))

  return {
    ...row,
    id: row.quotationNo,
    uuid: row.id,
    // The prototype's `template` is the MoU template key, and both sides key it by the same
    // short string ('corporate', 'wedding', …), so this is a rename rather than a lookup.
    template: row.mouTemplateId,
    client: clients.get(row.clientId)?.name ?? '—',
    clientUuid: row.clientId,
    // Resolved server-side into `created_by_name`: there is no users endpoint, and this value
    // is printed as "Prepared by" on a PDF that goes to the client.
    createdBy: row.createdByName ?? '—',
    // Only an *accepted* quotation has a project, and the number is assigned by the server on
    // confirmation. Null for a draft is the honest answer, not a placeholder.
    projectId: projectByQuotation.get(row.id) ?? null,
    contractValue: amount(row.contractValue),
    estimatedCost: amount(row.estimatedCost),
    margin: Number(row.margin ?? 0),
    lineItems: (row.lines || []).map((l) => ({
      label: l.label,
      amount: amount(l.amount),
      estCost: amount(l.estCost),
    })),
    dpSchedule,
    // `stagesFor` prefers `dpSchedule` and falls back to this; `lib/pdf.js` reads it directly,
    // so it is derived from the first stage rather than left undefined.
    dpPercent: dpSchedule.length ? Number(dpSchedule[0].percent ?? 0) : 30,
  }
}

// ---------------------------------------------------------------------------
// Procurement
// ---------------------------------------------------------------------------

export function adaptProcurement(row, { projects }) {
  return {
    ...row,
    id: row.requestNo,
    uuid: row.id,
    project: row.projectId ? (projects.get(row.projectId)?.projectNo ?? null) : null,
    projectUuid: row.projectId,
    amount: amount(row.amount),
    // `requested_by` is a stored string, not a foreign key — petty cash cannot be issued
    // anonymously, so the name travels with the request.
    by: row.requestedBy,
    // The prototype asks "is there a receipt?"; the API answers with the attachments.
    proof: (row.receipts || []).length > 0,
    // The API keeps attachment ids, not names; the table prints a list of them.
    receipts: (row.receipts || []).map((_, i) => `receipt-${i + 1}`),
    // The same receipts' attachment ids, in the same order: what opens the file (`GET /attachments/{id}`).
    receiptIds: (row.receipts || []).map((r) => r.attachmentId),
    date: row.requestDate,
    actual: row.actual == null ? null : amount(row.actual),
    variance: row.variance == null ? null : amount(row.variance),
  }
}

// ---------------------------------------------------------------------------
// Warehouse and assets
// ---------------------------------------------------------------------------

/**
 * A vendor catalogue item.
 *
 * Note what is *not* here: `bookings`. The API never exposes the raw booking rows — it answers
 * availability as a question about a window (`GET /vendor-catalogue/availability`), which is
 * the same D−2/D+1 logic `lib/vendors.js` reimplements client-side. So an unqualified read
 * gives total stock, which `availableQty` already treats as the honest answer, and any
 * date-filtered view must ask the server rather than fold an empty bookings array and report
 * everything as free.
 */
export function adaptCatalogueItem(row, { vendors }) {
  const vendor = vendors.get(row.vendorId)
  return {
    ...row,
    id: row.itemNo,
    uuid: row.id,
    vendor: vendor?.name ?? '—',
    // Pages route and filter on the vendor's business number (`V-01`), not its key.
    vendorId: vendor?.vendorNo ?? null,
    vendorUuid: row.vendorId,
    unitPrice: amount(row.unitPrice),
    stock: Number(row.stock ?? 0),
    // The API returns tag objects; every page treats `tags` as a list of ids and looks the
    // label up itself. Left as objects, `TagChip` renders "[object Object]".
    tags: (row.tags || []).map((t) => (typeof t === 'string' ? t : t.id)),
    bookings: [],
  }
}

export function adaptInventoryItem(row, { projects }) {
  return {
    ...row,
    id: row.itemNo,
    uuid: row.id,
    qty: Number(row.qty ?? 0),
    unitValue: amount(row.unitValue),
    projectId: row.projectId ? (projects.get(row.projectId)?.projectNo ?? null) : null,
    projectUuid: row.projectId,
    archivedAt: row.archivedAt ?? null,
  }
}

export function adaptFixedAsset(row) {
  return {
    ...row,
    id: row.assetNo,
    uuid: row.id,
    cost: amount(row.cost),
    salvage: amount(row.salvage),
    postedAccumulated: amount(row.postedAccumulated),
    openingAccumulated: amount(row.openingAccumulated),
    // The prototype's field names, which lib/depreciation.js reads.
    usefulLifeMonths: row.usefulLifeMonths,
    acquiredOn: row.acquiredOn,
    inventoryId: row.inventoryItemId,
  }
}

// ---------------------------------------------------------------------------
// Derived, after everything is loaded
// ---------------------------------------------------------------------------

/**
 * Fill in each project's realised cost from the journal.
 *
 * The backend refuses to store this — [02] calls it out as a denormalised cache, and the
 * prototype's copy drifted from the ledger exactly as predicted. Deriving it here keeps the
 * pages' `project.realizedCost` working while remaining a function of the entries rather
 * than a number anybody can update independently.
 *
 * @param projects adapted projects
 * @param journal  adapted entries
 * @param isCostAccount from lib/ledger — which account codes count as project cost
 */
export function withRealizedCost(projects, journal, isCostAccount) {
  const spent = new Map()
  for (const entry of journal) {
    if (!entry.project) continue
    for (const line of entry.lines) {
      if (!isCostAccount(line.account)) continue
      // Debits add cost, credits (a reversal, a downward variance) take it away.
      spent.set(entry.project, (spent.get(entry.project) || 0) + line.debit - line.credit)
    }
  }
  return projects.map((p) => ({ ...p, realizedCost: spent.get(p.id) || 0 }))
}

export { index }


/**
 * A voucher series, as the numbering editor reads it.
 *
 * The shapes already agree field for field - `reset` even uses the same four words on both
 * sides - so this exists for one thing the client cannot compute: `nextPreview`. The
 * prototype derives its preview from `voucherCounters`, which is seed state; on live data
 * the only authority on the next number is the server that allocates it.
 */
export function adaptVoucherSeries(row) {
  return {
    key: row.key,
    prefix: row.prefix,
    label: row.label,
    hint: row.hint ?? '',
    format: row.format,
    reset: row.reset,
    nextPreview: row.nextPreview ?? null,
  }
}


/**
 * A posting preview (`?dry_run=true`), in the shape the confirmation dialog renders.
 *
 * Money arrives as a string from every endpoint and becomes a Number here, once -- the same
 * rule the rest of this file follows. The totals come from the server rather than being
 * re-added in the browser: if the two ever disagreed, the dialog would be the last place
 * anybody would look, and the point of it is to be trustworthy.
 */
export function adaptPreview(payload) {
  return {
    dryRun: payload?.dryRun ?? true,
    entries: (payload?.entries || []).map((entry) => ({
      entryDate: entry.entryDate,
      memo: entry.memo,
      series: entry.series,
      voucherPreview: entry.voucherPreview,
      // The date on the receipt / vendor invoice (round 4); `entryDate` is the received date.
      sourceDocumentDate: entry.sourceDocumentDate ?? null,
      lines: (entry.lines || []).map((line) => ({
        account: line.account,
        accountName: line.accountName,
        debit: amount(line.debit),
        credit: amount(line.credit),
        note: line.note,
      })),
      totalDebit: amount(entry.totalDebit),
      totalCredit: amount(entry.totalCredit),
      balanced: entry.balanced,
    })),
    totalDebit: amount(payload?.totalDebit),
    totalCredit: amount(payload?.totalCredit),
    balanced: Boolean(payload?.balanced),
  }
}

/**
 * The sales leaderboard, derived rather than stored: accepted quotations grouped by the person who
 * wrote them (the quotation is the only place the salesperson is recorded), leaving out any whose
 * project was cancelled. The commission rate is the company's one setting, not a per-person figure.
 * Takes *adapted* quotations and projects.
 */
export function deriveSales(quotations, projects, commissionPct) {
  const cancelled = new Set((projects || []).filter((p) => p.cancelled).map((p) => p.id))
  const by = new Map()
  for (const q of quotations || []) {
    if (q.status !== 'Accepted' || (q.projectId && cancelled.has(q.projectId))) continue
    const row = by.get(q.createdBy) || { id: q.createdBy, name: q.createdBy, closedWon: 0, contractTotal: 0, commissionPct }
    row.closedWon += 1
    row.contractTotal += Number(q.contractValue) || 0
    by.set(q.createdBy, row)
  }
  return [...by.values()]
}

/**
 * The deal Finance sees for an accepted quotation.
 *
 * A "deal" is a client-side idea: the server has quotations, and an accepted one with no project
 * yet is what the prototype calls a pending deal. Deriving it on every load (rather than keeping a
 * list the browser builds when you click Accept) means the pending deals survive a refresh and
 * appear for Finance when Sales accepts on another machine. Takes an *adapted* quotation.
 */
export function adaptDeal(q) {
  const first = q.dpSchedule?.[0]
  return {
    id: `DEAL-${q.id}`,
    client: q.client,
    name: `${q.client} ${q.eventType}`,
    contractValue: q.contractValue,
    dpPercent: first ? Math.round(first.percent * 100) / 100 : 0,
    dpAmount: first ? first.amount : 0,
    dpSchedule: q.dpSchedule,
    // The number is minted by the server when the down payment is confirmed.
    projectIdOnConfirm: q.projectId ?? 'assigned on confirmation',
    eventDate: q.eventDate,
    estimatedCost: q.estimatedCost,
    confirmed: q.projectId != null,
  }
}

/** `GET /petty-cash` → numbers. `toppedUp` is what the Procurement screen calls `pettyCashTopUps`. */
export function adaptPettyCash(row) {
  return {
    balance: amount(row.balance),
    opening: amount(row.opening),
    toppedUp: amount(row.toppedUp),
    disbursed: amount(row.disbursed),
    awaitingApproval: amount(row.awaitingApproval),
    awaitingCount: Number(row.awaitingCount ?? 0),
    asOf: row.asOf,
  }
}

/**
 * What the Payroll and Survey screens call `latestFeedback` and `incentivesPaid`, worked out from
 * the server's per-project pools. The server keeps one rating per project; the screens show one
 * "latest" rating, so this picks the project that entered feedback most recently among those that
 * have a rating. `pools` maps a project's business number to the `GET /projects/{id}/incentives`
 * body; `projects` are the adapted rows.
 */
export function adaptLatestFeedback(projects, pools) {
  const rated = projects
    .filter((p) => pools[p.id]?.eventScore != null)
    .sort((a, b) => String(a.stageSince || '').localeCompare(String(b.stageSince || '')))
  const p = rated[rated.length - 1]
  if (!p) return { latestFeedback: null, incentivesPaid: false }
  const pool = pools[p.id]
  return {
    latestFeedback: {
      projectId: p.id,
      name: p.name,
      client: p.client,
      score: Number(pool.eventScore),
      pool: Number(pool.pool),
    },
    incentivesPaid: Boolean(pool.disbursed),
  }
}

/**
 * Make each entry's `appliedTo` speak the same language as `entry.id`.
 *
 * The API links a settlement to what it settles by UUID; the app identifies entries by their
 * number. `openItems` asks "is anything pointed at THIS entry?" by comparing against `entry.id`,
 * so the links have to be numbers too, and that needs the whole journal to look them up in.
 * An id that is not in the list (an entry outside this load) is left as it was.
 */
export function resolveApplications(entries) {
  const numberOf = new Map(entries.map((e) => [e.uuid, e.id]))
  return entries.map((e) =>
    e.appliedTo?.length ? { ...e, appliedTo: e.appliedTo.map((u) => numberOf.get(u) ?? u) } : e
  )
}

/** `GET /mou-templates` → the shape the quotation form and the template manager read (clauses as plain text, in order). */
export function adaptMouTemplate(row) {
  return {
    id: row.id,
    label: row.label,
    heading: row.heading,
    validity: row.validity ?? '',
    signatory: row.signatory ?? '',
    isDefault: Boolean(row.isDefault),
    clauses: [...(row.clauses || [])].sort((a, b) => a.clauseNo - b.clauseNo).map((c) => c.text),
  }
}

/** `GET /delivery-orders` → what the Warehouse table reads (lines as `{ itemId, item, qty }`). */
export function adaptDeliveryOrder(row, { projects }) {
  return {
    id: row.doNo,
    uuid: row.id,
    project: projects.get(row.projectId)?.projectNo ?? null,
    status: row.status,
    signed: Boolean(row.signed),
    // A drawn signature is on file; the picture itself is fetched on demand, never carried here.
    hasSignature: Boolean(row.hasSignature),
    signedByName: row.signedByName ?? null,
    signedAt: row.signedAt ?? null,
    date: row.dispatchedOn ?? row.receivedOn ?? '',
    eventDate: row.eventDate ?? null,
    lines: (row.lines || []).map((l) => ({
      // A free-text line has no stock item; give it a key the table can use.
      itemId: l.inventoryItemId ?? `line-${l.lineNo}`,
      stockUuid: l.inventoryItemId ?? null,
      item: l.itemLabel,
      qty: Number(l.qty),
    })),
  }
}
