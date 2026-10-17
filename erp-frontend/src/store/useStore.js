import { create } from 'zustand'
import { api } from '../lib/api.js'
import { adaptInteraction } from './adapters.js'
import {
  seedProjects, pendingDeal, seedInvoices, seedClients, seedVendors,
  seedProcurement, seedInventory, seedDeliveryOrders, seedCrew, seedSales,
  seedBudget, seedCronJobs, seedQuotations, seedJournal, seedTaxConfig,
  pettyCashStart, seedPurchaseOrders, vendorInventories, clientHistory, STAGES,
  seedTags, slugifyTag, seedMouTemplates, DEFAULT_TEMPLATE,
  seedVoucherSeries, seedVoucherCounters, seedFixedAssets,
} from './seed.js'
import {
  buildReversal, isProjectCostAccount, entryTotal, openItems,
} from '../lib/ledger.js'
import { SEED_ACCOUNTS, syncChart, validateAccountDraft, account, CASH_ACCOUNTS } from '../lib/accounts.js'
import { ROLES } from '../lib/roles.js'
import { flattenGroups, groupHits, MIN_QUERY, searchLocally } from '../lib/search.js'
import {
  counterKey,
  formatVoucher,
  pickSeries,
  seriesByKey,
  seriesDraftError,
} from '../lib/vouchers.js'
import { stagesFor, resolveSchedule, stageInvoiceType } from '../lib/billing.js'
import {
  duePeriods, periodEnd, validateAsset, accumulatedFor, addMonths,
} from '../lib/depreciation.js'
import { eventWindow, poDpAmount, poTotal } from '../lib/vendors.js'
import { appToday, money, setLiveClock, setNumberLocale } from '../lib/format.js'

// The language is remembered in this browser (so the sign-in screen and a signed-out visitor keep it)
// and, signed in, per person on the server: `useAuth` applies the server's value after sign-in.
const LANG_KEY = 'oscenia.lang'
function initialLang() {
  try {
    const stored = localStorage.getItem(LANG_KEY)
    const lang = stored === 'id' ? 'id' : 'en'
    setNumberLocale(lang)
    return lang
  } catch {
    return 'en' // storage blocked, or a server render
  }
}
function rememberLang(lang) {
  try { localStorage.setItem(LANG_KEY, lang) } catch { /* not remembered */ }
}
import {
  planDpConfirm, planReceivePayment, planPayBill, planPayPoDp, planSettlePo, validateEdited, cleanLines,
  vendorBillEntry, varianceEntry, vendorPaymentLines, postedWithholding,
} from '../lib/postings.js'
import { adjustBody, confirmDpBody, paymentBody, payDpBody, settleBody } from '../lib/apiPostings.js'
import {
  accountCreateBody, accountPatchBody, assetBody, assetPatchBody, deliveryBody, poBody, procurementBody, quotationBody, returnBody, vendorBody, vendorPatchBody, projectPatchBody, crewBody,
} from '../lib/apiWrites.js'

// The fields of an edited posting (round 4's pop-up) that feed a planner. `lines` is checked
// separately, against the plan these inputs produce.
const editedInputs = (edited = {}) => ({
  date: edited.date,
  documentDate: edited.documentDate ?? null,
  memo: edited.memo ?? null,
  cashAccount: edited.cashAccount,
  withhold: edited.withhold,
  taxAmount: edited.taxAmount ?? null,
})
// What an edited post adds to the movement's source: the date on the receipt.
const withDocumentDate = (source, posting) => (posting ? { ...source, documentDate: posting.documentDate } : source)

const qValue = (q) => q.lineItems.reduce((a, l) => a + l.amount, 0)
const qCost = (q) => q.lineItems.reduce((a, l) => a + (l.estCost || 0), 0)

let toastId = 0
// Sequence for client interaction note ids.
let interactionSeq = 1000
// Suffix counter for inventory rows split off by a check-in, so returning the
// same item twice cannot collide on id.
let splitSeq = 0

// The ERP store is not persisted, so a client added or edited in the offline demo would be gone
// after a refresh — and any event or project pointing at it would lose its name. Only the
// offline branches write here; hydration from the API replaces `clients` as before. Just the
// added and edited clients are saved, laid over the seed, so later seed changes still show.
const DEMO_CLIENTS_KEY = 'oscenia-demo-clients'
function loadDemoClients() {
  try {
    const saved = JSON.parse(localStorage.getItem(DEMO_CLIENTS_KEY))
    if (!Array.isArray(saved)) return seedClients
    const byId = new Map(saved.map((c) => [c.id, c]))
    return [...seedClients.map((c) => byId.get(c.id) || c), ...saved.filter((c) => !seedClients.some((x) => x.id === c.id))]
  } catch {
    return seedClients
  }
}
function saveDemoClients(clients) {
  const seedJson = new Map(seedClients.map((c) => [c.id, JSON.stringify(c)]))
  try {
    localStorage.setItem(DEMO_CLIENTS_KEY, JSON.stringify(clients.filter((c) => seedJson.get(c.id) !== JSON.stringify(c))))
  } catch {
    // Storage full or blocked: the change still holds for this session.
  }
}

// Vendors added in the offline demo, kept the same way and for the same reason as clients: a
// new vendor would otherwise vanish on refresh, along with its place on the vendor board. Only
// vendors the seed does not have are saved; edits to seeded vendors stay session-only as before.
const DEMO_VENDORS_KEY = 'oscenia-demo-vendors'
function loadDemoVendors() {
  try {
    const saved = JSON.parse(localStorage.getItem(DEMO_VENDORS_KEY))
    if (!Array.isArray(saved)) return seedVendors
    return [...seedVendors, ...saved.filter((v) => v?.id && !seedVendors.some((x) => x.id === v.id))]
  } catch {
    return seedVendors
  }
}
function saveDemoVendors(vendors) {
  try {
    localStorage.setItem(DEMO_VENDORS_KEY, JSON.stringify(vendors.filter((v) => !seedVendors.some((x) => x.id === v.id))))
  } catch {
    // Storage full or blocked: the vendor still holds for this session.
  }
}

export const useStore = create((set, get) => ({
  // --- identity ---
  //
  // Written by AuthGate from /auth/me rather than chosen here. The setter stays because
  // nothing outside AuthGate should call it, and deleting it would break the one caller
  // that legitimately does.
  role: 'ceo',
  setRole: (role) => set({ role }),

  // --- server data ---
  //
  // The collections below still open on `seed.js`, which is what the app renders for the
  // instant before `hydrate()` returns and what the two verify suites run against. Once the
  // API answers they are replaced wholesale. Seeding the initial value rather than starting
  // empty means no page has to learn to render an empty ledger, and `verify-ledger.mjs` and
  // `verify-flows.mjs` keep passing unchanged against the same fixtures they always used.
  hydrated: false,
  hydrating: false,
  hydrateError: null,

  /** Load everything from the API and replace the seeded collections. */
  hydrate: async () => {
    if (get().hydrating) return
    set({ hydrating: true, hydrateError: null })
    try {
      const { loadAll } = await import('./hydrate.js')
      const patch = await loadAll()
      // `undefined` entries are dropped so an endpoint that is not reachable leaves its
      // seeded value in place rather than blanking the screen it backs.
      const clean = Object.fromEntries(
        Object.entries(patch).filter(([, v]) => v !== undefined)
      )
      if (clean.accounts) syncChart(clean.accounts)
      set({ ...clean, hydrated: true, hydrating: false })
    } catch (err) {
      // Left on the seed data deliberately. A visible error beside a working screen is more
      // useful than a blank one, and the banner says the figures are not live.
      set({ hydrating: false, hydrateError: err })
    }
  },

  // --- the write path -------------------------------------------------------
  //
  // One door for every mutation, for the same reason `lib/api.js` has one `request` and the
  // backend has one posting engine: the token handling, the error shape, the busy state and
  // the re-read get written once instead of seventy times.
  //
  // Three rules it enforces, each of which is a bug the prototype would otherwise reintroduce
  // in every action:
  //
  //   1. **Send the `uuid`, never the `id`.** Pages hold `project.id === 'EVT-0001'`; the API
  //      is keyed by UUID. `adapters.js` carries both. A mutation that sends the business
  //      number gets a 422 at best and touches the wrong row at worst.
  //   2. **Re-read; do not patch locally.** `outstanding`, `collected`, `realizedCost` and
  //      every balance in `lib/ledger.js` are derived, and one write moves several of them.
  //      Applying the response by hand means reimplementing the server's arithmetic in the
  //      client and keeping the two in step forever.
  //   3. **A failure must be visible.** Silence here is what "I clicked it and nothing
  //      happened" means, and it is what the client reported about Settle Balance.

  /** Label of the mutation in flight, so a button can show a spinner and refuse a second click. */
  mutating: null,
  mutateError: null,

  /**
   * Perform one write, then re-read what it changed.
   *
   * @param {object}   opts
   * @param {string}   opts.label    short identifier, e.g. 'po:settle' — also the busy key
   * @param {Function} opts.call     does the API call; may return anything
   * @param {string[]} [opts.refresh] store collections the write affected
   * @param {object}   [opts.toast]   `{title, body, kind}` shown on success
   * @returns {Promise<{ok: boolean, data?: any, error?: Error}>}
   */
  mutate: async ({ label, call, refresh = [], toast }) => {
    const { hydrated, pushToast } = get()

    // Refused rather than attempted: on seed data the rows have no `uuid`, so the request
    // would fail on a missing key and the message would blame the field instead of the
    // cause. This says the real thing.
    if (!hydrated) {
      pushToast({
        title: 'Not connected to the API',
        body: 'This screen is showing demo data, so nothing can be saved. Sign in against a running backend.',
        kind: 'redflag',
      })
      return { ok: false, error: new Error('not hydrated') }
    }

    // Writes are serialised. In an accounting app the cost of letting two posts race is a
    // duplicated journal entry, and the cost of serialising them is a moment's wait.
    const inFlight = get().mutating
    if (inFlight === label) {
      // The same button, twice. That is a double-click, and ignoring it *is* the correct
      // response — a toast here would be noise, and double-posting would not.
      return { ok: false, error: new Error('already in flight') }
    }
    if (inFlight) {
      // A different action, though. Saying nothing would look like a dead button, which is
      // precisely the complaint this helper exists to stop producing.
      pushToast({
        title: 'One thing at a time',
        body: 'Another change is still saving. Try again in a moment.',
        kind: 'redflag',
      })
      return { ok: false, error: new Error('a write is already in flight') }
    }

    set({ mutating: label, mutateError: null })
    try {
      const data = await call()

      if (refresh.length) {
        const { loadSome } = await import('./hydrate.js')
        const patch = await loadSome(refresh)
        if (patch.accounts) syncChart(patch.accounts)
        set({ ...patch, mutating: null })
      } else {
        set({ mutating: null })
      }

      if (toast) pushToast(toast)
      return { ok: true, data }
    } catch (err) {
      set({ mutating: null, mutateError: err })

      // A 403 from this backend names the roles that *would* be allowed. Saying so is the
      // difference between "no" and "no, ask Finance" — and it is the whole reason the PO
      // buttons looked broken rather than forbidden.
      const permitted = err?.permitted?.length ? ` Allowed: ${err.permitted.join(', ')}.` : ''
      pushToast({
        title: err?.status === 403 ? 'Not permitted' : err?.title || 'That did not save',
        body: `${err?.message || 'The request failed.'}${permitted}`,
        kind: 'redflag',
      })
      return { ok: false, error: err }
    }
  },

  /**
   * Search everything, grouped for display.
   *
   * On live data this is the SERVER's search: it reads the database and ranks in SQL. The
   * client-side version it replaces could only ever find what the browser had already
   * loaded -- six collections out of eleven -- which is why purchase orders, stock, crew,
   * fixed assets and petty-cash requests could not be found at all. State in the browser is
   * a subset of the database by definition, so no amount of filtering fixed that.
   *
   * The seeded demo has no server, so it keeps the in-memory search. Both produce the same
   * hit shape and the same ranking bands, so the box renders one thing either way.
   */
  searchEverything: async (query, { perKind = 5 } = {}) => {
    if (!get().hydrated) return groupHits(searchLocally(get(), query), { perKind })
    if (String(query || '').trim().length < MIN_QUERY) return []
    const payload = await api.get('/search', { q: String(query).trim(), limit: perKind })
    return groupHits(flattenGroups(payload), { perKind })
  },

  /**
   * Ask the server what an action would post, without posting it.
   *
   * Returns `{ preview }` on success and `{ error }` when the books refuse -- and a refusal
   * is the useful case: the dialog then says why instead of offering a button that cannot
   * work. `null` when there is no backend, which the dialog renders as a demo notice rather
   * than as an empty posting.
   *
   * Deliberately NOT routed through `mutate`: this changes nothing, so it must not take the
   * write lock, show a toast, or re-read any collection.
   */
  previewPosting: async (path, body = {}) => {
    if (!get().hydrated) return null
    try {
      // `params`, not a hand-built query string: the client camel-to-snakes query keys the
      // same way it does body keys, so `dryRun` arrives as `dry_run`.
      const payload = await api.post(path, body, { dryRun: true })
      const { adaptPreview } = await import('./adapters.js')
      return { preview: adaptPreview(payload) }
    } catch (err) {
      const permitted = err?.permitted?.length ? ` Allowed: ${err.permitted.join(', ')}.` : ''
      return { error: `${err?.message || 'The preview failed.'}${permitted}` }
    }
  },

  // --- language ---
  // Labels come from i18n/dict.js; seed content (client names, journal memos)
  // stays as authored. Numbers and dates follow the language too — see
  // lib/format.js. setNumberLocale runs here rather than in a subscriber so the
  // formatter is already correct by the time React re-renders.
  lang: initialLang(),
  setLang: (lang) => {
    setNumberLocale(lang)
    rememberLang(lang)
    set({ lang })
  },
  toggleLang: () => {
    const next = get().lang === 'en' ? 'id' : 'en'
    setNumberLocale(next)
    rememberLang(next)
    set({ lang: next })
    return next
  },

  // --- data ---
  projects: seedProjects,
  invoices: seedInvoices,
  clients: loadDemoClients(),
  vendors: loadDemoVendors(),
  procurement: seedProcurement,
  inventory: seedInventory,
  deliveryOrders: seedDeliveryOrders,
  crew: seedCrew,
  sales: seedSales,
  budget: seedBudget,
  cronJobs: seedCronJobs,
  quotations: seedQuotations,
  purchaseOrders: seedPurchaseOrders,
  // The catalogue lives in the store now because approving a PO reserves stock
  // against an event window, so it has to be mutable.
  vendorCatalogue: vendorInventories,
  // User-managed tag vocabulary, applied to vendors and catalogue items.
  tags: seedTags,
  // Proposal / MoU templates. In the store rather than the seed file so the
  // heading, clauses, validity and signature wording can all be edited — the
  // deck asked for "dynamic templates", and a fixed set of three switchable
  // presets is only half of that.
  mouTemplates: seedMouTemplates,
  // Client interaction log, moved out of the seed file so notes can be added.
  //
  // Each note is stamped with a stable id on load. Notes are prepended, so an
  // array index is not a handle you can edit against — after one insert, index
  // 0 refers to a different note than it did.
  // Past events, for lifetime value and the client timeline.
  //
  // There is NO endpoint for these -- they are demo fiction, and `lib/crm.js` used to
  // import them straight from the seed file. On live data that meant a client's LTV
  // included events that are not in the database, which is worse than showing less. So the
  // history is state, `loadAll` blanks it, and `lib/crm.js` takes it as an argument.
  clientHistory,

  interactions: Object.fromEntries(
    Object.entries(clientHistory).map(([id, h]) => [
      id,
      h.interactions.map((it, i) => ({ id: `IN-${id}-${i + 1}`, attachments: [], ...it })),
    ])
  ),

  // --- chart of accounts ---
  // The chart is store state now, not a frozen constant, because the client
  // asked that administrators add and adjust sub-accounts themselves. Every
  // mutation calls syncChart() so lib/ledger.js and the statement screens read
  // the live chart — see the header of lib/accounts.js for how that works.
  accounts: SEED_ACCOUNTS,

  // --- general ledger ---
  // The single source of truth for Total Cash, AR, the Income Statement and the
  // Balance Sheet. Operational actions post here; the statements are derived
  // (lib/ledger.js) rather than hand-authored.
  journal: seedJournal,
  taxConfig: seedTaxConfig,
  jeSeq: 2000,

  // --- voucher numbering ---
  // Series definitions (prefix, format, reset cadence) and the live sequence
  // counters, keyed by series + period. Seeded from the numbers already stamped
  // on the seed journal so a freshly posted entry continues the run.
  voucherSeries: seedVoucherSeries,
  voucherCounters: seedVoucherCounters,

  // Next invoice number. The DP invoice used to be hardcoded as 'INV-0045',
  // which meant a second down-payment confirmation minted a SECOND invoice with
  // the same id — and the undo, matching on that id, deleted both. Invoice
  // numbers have to be unique for the same reason voucher numbers do.
  invoiceSeq: 45,

  // --- fixed-asset register ---
  // Acquisition, useful life and method per asset. The depreciation SCHEDULE is
  // derived from these (lib/depreciation.js) rather than stored, so changing a
  // useful life re-plans the remaining periods instead of leaving a stale table
  // behind. Only `postedThrough` is state: what has actually hit the ledger.
  fixedAssets: seedFixedAssets,
  fixedAssetSeq: 6,
  pettyCashTopUps: 0,

  // Reminders surfaced by the cron scheduler (birthday nudges etc.)
  reminders: [],
  cronRan: false,
  // Budgeting red-flag automation state
  budgetFlagged: false,
  // Projects already warned about, so the alert fires once rather than on
  // every subsequent posting.
  budgetAlerted: [],
  // Crew incentive disbursement state
  incentivesPaid: false,
  // Minimum client rating that earns a bonus. The deck said "enforce minimum
  // threshold according to policy" — policy is something a business changes, so
  // it lives in the store alongside the tax rates and the budget tolerance
  // rather than as a constant compiled into a component.
  bonusThreshold: 7,
  setBonusThreshold: (v) =>
    get().hydrated
      ? get().mutate({
          label: 'settings:bonus',
          call: () => api.patch('/settings', { bonusThreshold: String(Math.min(10, Math.max(0, Number(v) || 0))) }),
          refresh: ['settings'],
          toast: { title: 'Bonus threshold updated', body: `${Math.min(10, Math.max(0, Number(v) || 0))} / 10`, kind: 'payroll' },
        })
      : set({ bonusThreshold: Math.min(10, Math.max(0, Number(v) || 0)) }),

  // The sales commission rate: one company setting (the sales leaderboard multiplies by it).
  commissionPct: 2.5,
  setCommissionPct: (v) => {
    const pct = Math.min(100, Math.max(0, Number(v) || 0))
    return get().hydrated
      ? get().mutate({
          label: 'settings:commission',
          call: () => api.patch('/settings', { commissionPct: String(pct) }),
          refresh: ['settings'],
          toast: { title: 'Commission rate updated', body: `${pct}%`, kind: 'finance' },
        })
      : set({ commissionPct: pct })
  },

  // Accepted quotations awaiting a down payment — a COLLECTION, not one slot.
  //
  // This was `pendingDeal` (a single object) plus `dpConfirmed` (a single boolean), and that
  // pair was the client's "a second quotation overwrites the first" bug. The quotation
  // records were never overwritten; the *approval workspace* was. Accepting a second quote
  // replaced the one object and reset the one flag, so the first quotation's deal stopped
  // existing anywhere in state and Finance could only ever offer the newest one.
  //
  // Each deal is already quote-scoped (`id: DEAL-<quoteId>`), so the fix is to stop
  // throwing the others away. `confirmed` rides on the deal rather than beside it, which is
  // what makes two accepted quotations independently approvable.
  deals: [{ ...pendingDeal, confirmed: false }],

  /**
   * Resolve which deal an action refers to.
   *
   * The id is optional so the demo and the flow suite can keep saying
   * `confirmDownPayment()` when there is only one thing it could mean. With more than one
   * unconfirmed deal it is genuinely ambiguous, and guessing is how the original bug felt
   * reasonable — so it refuses and says so instead.
   */
  _deal: (dealId) => {
    const { deals, pushToast } = get()
    if (dealId) return deals.find((d) => d.id === dealId) ?? null
    const open = deals.filter((d) => !d.confirmed)
    if (open.length === 1) return open[0]
    if (open.length === 0) return null
    pushToast({
      title: 'Which deal?',
      body: `${open.length} accepted quotations are awaiting a down payment — choose one.`,
      kind: 'redflag',
    })
    return null
  },

  // id of the most recently created project (for highlight animation on the board)
  justCreatedId: null,
  clearJustCreated: () => set({ justCreatedId: null }),

  // Second automation: the latest client rating captured at Post-Event Feedback.
  // Drives the crew incentive pool on the Payroll screen.
  latestFeedback: null,

  // --- toasts (trigger notifications) ---
  toasts: [],
  pushToast: (toast) => {
    const id = ++toastId
    set((s) => ({ toasts: [...s.toasts, { id, ...toast }] }))
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
    }, 5200)
    return id
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  // ============================================================
  // CHART OF ACCOUNTS
  // "Financial administrators can independently add, configure, and adjust
  // sub-accounts." Every mutation ends in syncChart() so the derived exports in
  // lib/accounts.js — and therefore the ledger, the statements and Total Cash —
  // see the new chart immediately.
  // ============================================================

  // How many journal lines reference an account. The guard rails below hang off
  // this: an account that has been posted to cannot be renamed out from under
  // its own history, retyped onto a different statement, or deleted.
  accountUsage: (code) => {
    const { journal } = get()
    return journal.reduce(
      (n, e) => n + (e.lines || []).filter((l) => l.account === code).length,
      0
    )
  },

  addAccount: (draft) => {
    const { accounts, pushToast } = get()
    const error = validateAccountDraft(draft, accounts)
    if (error) {
      pushToast({ title: 'Account not created', body: error, kind: 'redflag' })
      return null
    }
    if (get().hydrated) {
      return get().mutate({
        label: 'coa:add',
        call: () => api.post('/accounts', accountCreateBody(draft)),
        refresh: ['accounts'],
        toast: { title: draft.parent ? 'Sub-account added' : 'Account added', body: `${draft.code} · ${draft.name}`, kind: 'finance' },
      })
    }
    const parent = draft.parent ? accounts.find((a) => a.code === draft.parent) : null
    const record = {
      code: String(draft.code).trim(),
      name: String(draft.name).trim(),
      type: draft.type,
      group: String(draft.group || '').trim() || parent?.group || undefined,
      parent: draft.parent || undefined,
      active: true,
      // A sub-account of a bank account is still a bank account, and a
      // sub-account of a tax payable still settles the same tax. Inheriting
      // these means Total Cash and the tax engine pick the new account up
      // without the user having to know they are flags.
      ...((draft.cash ?? parent?.cash) ? { cash: true } : {}),
      ...(parent?.tax ? { tax: parent.tax } : {}),
    }
    const next = [...accounts, record].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
    syncChart(next)
    set({ accounts: next })
    pushToast({
      title: parent ? 'Sub-account added' : 'Account added',
      body: `${record.code} · ${record.name}`,
      kind: 'finance',
    })
    return record
  },

  updateAccount: (code, patch) => {
    const { accounts, pushToast, accountUsage } = get()
    const current = accounts.find((a) => a.code === code)
    if (!current) return null

    const used = accountUsage(code)
    if (used > 0) {
      // Renaming is always fine — it is a label. Renumbering or retyping is
      // not: journal lines reference the code, and the type decides which
      // statement the history lands on. Both would rewrite the past.
      if (patch.code && patch.code !== code) {
        pushToast({
          title: 'Code is locked',
          body: `${code} carries ${used} posted line(s). Deactivate it and open a new account instead.`,
          kind: 'redflag',
        })
        return null
      }
      if (patch.type && patch.type !== current.type) {
        pushToast({
          title: 'Type is locked',
          body: `${code} carries ${used} posted line(s) — retyping would move them to a different statement.`,
          kind: 'redflag',
        })
        return null
      }
    }

    const draft = { ...current, ...patch }
    const error = validateAccountDraft(draft, accounts, code)
    if (error) {
      pushToast({ title: 'Account not saved', body: error, kind: 'redflag' })
      return null
    }
    if (get().hydrated) {
      return get().mutate({
        label: `coa:${code}`,
        call: () => api.patch(`/accounts/${encodeURIComponent(code)}`, accountPatchBody(patch)),
        refresh: ['accounts'],
        toast: { title: 'Account updated', body: `${draft.code} · ${draft.name}`, kind: 'finance' },
      })
    }

    const next = accounts
      .map((a) => (a.code === code ? draft : a))
      // A code change has to follow through to anything parented on it.
      .map((a) => (a.parent === code && draft.code !== code ? { ...a, parent: draft.code } : a))
      .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))

    syncChart(next)
    set({ accounts: next })
    pushToast({ title: 'Account updated', body: `${draft.code} · ${draft.name}`, kind: 'finance' })
    return draft
  },

  setAccountActive: (code, active) => {
    const { accounts, pushToast } = get()
    const target = accounts.find((a) => a.code === code)
    if (!target) return false
    if (get().hydrated) {
      return get().mutate({
        label: `coa:${code}`,
        call: () => api.post(`/accounts/${encodeURIComponent(code)}/${active ? 'activate' : 'deactivate'}`),
        refresh: ['accounts'],
        toast: { title: active ? 'Account reactivated' : 'Account deactivated', body: `${code} · ${target.name}`, kind: 'finance' },
      })
    }
    const next = accounts.map((a) => (a.code === code ? { ...a, active } : a))
    syncChart(next)
    set({ accounts: next })
    pushToast({
      title: active ? 'Account reactivated' : 'Account deactivated',
      body: active
        ? `${code} is postable again`
        : `${code} keeps its balance and history, but no longer accepts postings`,
      kind: active ? 'finance' : 'redflag',
    })
    return true
  },

  // Deletion is only ever possible for an account that has never been used —
  // a typo, in other words. Anything with history is deactivated instead, so
  // the audit trail keeps its account names.
  deleteAccount: (code) => {
    const { accounts, pushToast, accountUsage } = get()
    const target = accounts.find((a) => a.code === code)
    if (!target) return false
    const used = accountUsage(code)
    if (used > 0) {
      pushToast({
        title: 'Cannot delete',
        body: `${code} carries ${used} posted line(s). Deactivate it instead — the history keeps its account name.`,
        kind: 'redflag',
      })
      return false
    }
    if (accounts.some((a) => a.parent === code)) {
      pushToast({
        title: 'Cannot delete',
        body: `${code} still has sub-accounts. Remove those first.`,
        kind: 'redflag',
      })
      return false
    }
    if (get().hydrated) {
      return get().mutate({
        label: `coa:${code}`,
        call: () => api.delete(`/accounts/${encodeURIComponent(code)}`),
        refresh: ['accounts'],
        toast: { title: 'Account deleted', body: `${code} · ${target.name}`, kind: 'redflag' },
      })
    }
    const next = accounts.filter((a) => a.code !== code)
    syncChart(next)
    set({ accounts: next })
    pushToast({ title: 'Account deleted', body: `${code} · ${target.name}`, kind: 'redflag' })
    return true
  },

  // ============================================================
  // LEDGER POSTING
  // Every operational action that moves money routes through here, which is
  // what the client's "auto-journaling & real-time integration" means: one
  // posting updates the journal, the statements, Total Cash and AR at once.
  // ============================================================
  postEntry: ({ date, memo, project = null, source, lines, series, appliedTo, groupRef = null }) => {
    const seq = get().jeSeq + 1
    const when = date || appToday()
    const src = source || { kind: 'manual', ref: null }
    // The voucher number is the auditable document number; the id stays the
    // immutable internal key. See lib/vouchers.js for why they are separate.
    const stamp = get()._stampVoucher({ date: when, source: src, lines, series })
    const entry = {
      id: `JE-${seq}`,
      date: when,
      memo,
      project,
      source: src,
      lines,
      series: stamp.series,
      voucherNo: stamp.voucherNo,
      // The document this entry is filed under, if it joined one. A correction files under
      // the original's code while keeping its own voucher number -- see lib/vouchers.js for
      // why the two are different questions.
      groupRef: groupRef || null,
      // Inter-document linking: the entries this one settles or applies against.
      appliedTo: appliedTo ? [...appliedTo] : [],
      reversalOf: null,
      reversedBy: null,
    }
    set((s) => ({ journal: [entry, ...s.journal], jeSeq: seq }))
    get()._syncRealizedCost(entry)
    return entry
  },

  // An edited movement from the posting pop-up (round 4), checked against the plan it was
  // edited from. Returns what to post -- the received date, the receipt date, memo and lines --
  // or null after saying why it was refused. Nothing has been changed when it refuses, so
  // every caller runs this before its first `set`.
  _editedPosting: (plan, edited) => {
    const check = validateEdited(plan, edited, get().accounts)
    if (!check.ok) {
      get().pushToast({ title: 'Not posted', body: check.errors[0].message, kind: 'redflag' })
      return null
    }
    const ed = plan.editable
    return {
      date: edited.date,
      documentDate: edited.documentDate || null,
      memo: ed ? (String(edited.memo || '').trim() || ed.defaultMemo) : null,
      lines: ed ? cleanLines(edited.lines) : null,
    }
  },

  // Allocate the next voucher number in the entry's series and advance that
  // series' counter. An explicit `series` wins; otherwise the class is inferred
  // from the source kind and the direction of the cash movement.
  _stampVoucher: ({ date, source, lines, series }) => {
    const { voucherSeries, voucherCounters } = get()
    const key = series || pickSeries({ source, lines }, { accountOf: account, cashAccounts: CASH_ACCOUNTS })
    const def = seriesByKey(voucherSeries, key) || seriesByKey(voucherSeries, 'jv')
    if (!def) return { series: key, voucherNo: null }
    const ck = counterKey(def, date)
    const next = (voucherCounters[ck] || 0) + 1
    set((s) => ({ voucherCounters: { ...s.voucherCounters, [ck]: next } }))
    return { series: def.key, voucherNo: formatVoucher(def, date, next) }
  },

  // How many entries were numbered from a series. The delete guard hangs off this, for
  // the same reason `accountUsage` guards an account: a voucher number names its series,
  // and it has to stay resolvable for as long as the entry does.
  seriesUsage: (key) => get().journal.filter((e) => e.series === key).length,

  // Add a series with the administrator's own prefix. The seven seeded classes were fixed,
  // and the client asked to define their own.
  addVoucherSeries: (draft) => {
    const { voucherSeries, pushToast } = get()
    const record = {
      key: String(draft.key || '').trim().toLowerCase(),
      prefix: String(draft.prefix || '').trim(),
      label: String(draft.label || '').trim(),
      hint: String(draft.hint || '').trim(),
      format: String(draft.format || '[PREFIX]-[MONTH]-[DATE]-[SEQ_001]').trim(),
      reset: draft.reset || 'monthly',
    }
    const error = seriesDraftError(record, voucherSeries)
    if (error) {
      pushToast({ title: 'Series not created', body: error, kind: 'redflag' })
      return null
    }

    if (get().hydrated) {
      return get().mutate({
        label: `series:add:${record.key}`,
        call: () => api.post('/voucher-series', record),
        refresh: ['voucherSeries'],
        toast: { title: 'Voucher series added', body: `${record.prefix} · ${record.label}`, kind: 'finance' },
      })
    }

    set((s) => ({ voucherSeries: [...s.voucherSeries, record] }))
    pushToast({
      title: 'Voucher series added',
      body: `${record.label} · ${formatVoucher(record, appToday(), 1)}`,
      kind: 'finance',
    })
    return record
  },

  // Deletion is only ever possible for a series nothing was numbered from -- a typo, in
  // other words. The server enforces the same rule; this one keeps the demo honest and
  // explains the refusal before a round trip rather than after it.
  deleteVoucherSeries: (key) => {
    const { voucherSeries, pushToast, seriesUsage } = get()
    const target = voucherSeries.find((x) => x.key === key)
    if (!target) return false
    const used = seriesUsage(key)
    if (used > 0) {
      pushToast({
        title: 'Cannot delete',
        body: `${used} entr${used === 1 ? 'y was' : 'ies were'} numbered from ${target.prefix}. Deleting it would leave their voucher numbers unexplained.`,
        kind: 'redflag',
      })
      return false
    }

    if (get().hydrated) {
      return get().mutate({
        label: `series:delete:${key}`,
        call: () => api.delete(`/voucher-series/${key}`),
        refresh: ['voucherSeries'],
        toast: { title: 'Voucher series deleted', body: `${target.prefix} · ${target.label}`, kind: 'redflag' },
      })
    }

    set((s) => ({ voucherSeries: s.voucherSeries.filter((x) => x.key !== key) }))
    pushToast({ title: 'Voucher series deleted', body: `${target.prefix} · ${target.label}`, kind: 'redflag' })
    return true
  },

  // Administrator control over the numbering scheme (prefix, format, reset).
  // Numbers already issued are never rewritten — a voucher that has been
  // printed and filed keeps the number it was filed under.
  updateVoucherSeries: (key, patch) => {
    const { voucherSeries, pushToast } = get()
    const current = voucherSeries.find((x) => x.key === key)
    if (!current) return null

    const draft = { ...current, ...patch }
    if (patch.format != null && !/\[SEQ_\d+\]/.test(draft.format)) {
      pushToast({
        title: 'Format rejected',
        body: 'A voucher format must contain a [SEQ_001] token, or every voucher in the period would share a number.',
        kind: 'redflag',
      })
      return null
    }
    if (patch.prefix != null && !String(draft.prefix).trim()) {
      pushToast({ title: 'Format rejected', body: 'A series needs a prefix.', kind: 'redflag' })
      return null
    }

    if (get().hydrated) {
      // Only what changed: the server validates the format the same way, and a PATCH of the
      // whole row would resend fields the editor never touched.
      return get().mutate({
        label: `series:update:${key}`,
        call: () => api.patch(`/voucher-series/${key}`, patch),
        refresh: ['voucherSeries'],
        toast: { title: 'Voucher series updated', body: `${draft.prefix} · ${draft.label}`, kind: 'finance' },
      })
    }

    set((s) => ({ voucherSeries: s.voucherSeries.map((x) => (x.key === key ? draft : x)) }))
    pushToast({
      title: 'Voucher series updated',
      body: `${draft.label} · ${formatVoucher(draft, appToday(), (get().voucherCounters[counterKey(draft, appToday())] || 0) + 1)}`,
      kind: 'finance',
    })
    return draft
  },

  // `realizedCost` on a project is a denormalised cache of its posted COGS.
  // Keeping it in step here means the board, P&L and budget screens agree with
  // the ledger without every one of them having to re-derive it.
  _syncRealizedCost: (entry) => {
    if (!entry.project) return
    // Uses the same account predicate as lib/ledger.js projectCosts(), so the
    // cache and the P&L can never disagree about what a project cost.
    const delta = (entry.lines || []).reduce((a, l) => {
      if (!isProjectCostAccount(l.account)) return a
      return a + (Number(l.debit) || 0) - (Number(l.credit) || 0)
    }, 0)
    if (!delta) return
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === entry.project ? { ...p, realizedCost: p.realizedCost + delta } : p
      ),
    }))
    if (delta > 0) get()._checkBudgetTolerance(entry.project)
  },

  // Over-budget prevention (slide 8). Checked on every cost posting rather than
  // via the demo-only "log unplanned cost" button, and it warns rather than
  // hard-blocks: refusing to record a cost that has already been incurred would
  // just push the truth out of the system.
  _checkBudgetTolerance: (projectId) => {
    const { projects, budgetTolerancePct, pushToast, budgetAlerted } = get()
    const p = projects.find((x) => x.id === projectId)
    if (!p || !p.estimatedCost) return
    const ceiling = Math.round(p.estimatedCost * (1 + budgetTolerancePct / 100))
    if (p.realizedCost <= ceiling) return
    if (budgetAlerted.includes(projectId)) return
    set((s) => ({ budgetAlerted: [...s.budgetAlerted, projectId] }))
    pushToast({
      title: '\u26a0 Over budget',
      body: `${projectId} \u00b7 ${money(p.realizedCost - ceiling)} beyond the ${budgetTolerancePct}% tolerance`,
      kind: 'redflag',
    })
  },

  // Reverse a posted entry. The original stays in the ledger flagged
  // `reversedBy` — hard-editing a posted entry would destroy the audit trail,
  // so "edit" is implemented as reverse-and-repost.
  reverseJournalEntry: (id, { silent = false } = {}) => {
    const { journal, jeSeq, pushToast } = get()
    const target = journal.find((e) => e.id === id)
    if (!target || target.reversedBy) return null
    const seq = jeSeq + 1
    const reversal = buildReversal(target, `JE-${seq}`, appToday())
    // A reversal is an adjustment voucher and gets its own document number —
    // the auditor needs to see the correction as its own filed document, not as
    // an unnumbered shadow of the entry it undoes.
    const stamp = get()._stampVoucher({
      date: reversal.date, source: reversal.source, lines: reversal.lines, series: 'jv',
    })
    reversal.series = stamp.series
    reversal.voucherNo = stamp.voucherNo
    // ...and is filed under the original's journal code. This is the other half of the
    // client's ask: one code to reconcile by, without two documents sharing a number. An
    // entry that was not already in a group becomes the anchor of its own, named by its
    // voucher number -- which is also exactly what the server does.
    reversal.groupRef = target.groupRef || target.voucherNo
    set((s) => ({
      journal: [reversal, ...s.journal.map((e) => (e.id === id ? { ...e, reversedBy: reversal.id } : e))],
      jeSeq: seq,
    }))
    get()._syncRealizedCost(reversal)
    if (!silent) {
      pushToast({ title: 'Entry reversed', body: `${reversal.id} reverses ${id}`, kind: 'finance' })
    }
    return reversal
  },

  // ------------------------------------------------------------------
  // The three the Accounting screen calls directly.
  //
  // `postEntry`, `reverseJournalEntry` and `adjustJournalEntry` below stay exactly as they
  // are: twenty operational actions post through them, and giving those a promise to await
  // would be a rewrite of the whole store. These three are the user-initiated ones -- the
  // New Journal Entry form, and Reverse and Adjust on an entry -- so they are the ones that
  // have to reach the server, and wiring them here leaves everything else alone.
  //
  // Each falls back to the local action when there is no backend, which is what keeps the
  // seeded demo working.
  // ------------------------------------------------------------------

  /** The journal entry the user typed. Returns the posted entry, or a mutate result. */
  postManualEntry: (draft) => {
    const { hydrated, postEntry, projects, journal } = get()
    if (!hydrated) return postEntry(draft)

    // `project` is the business number on screen; the API is keyed by uuid. And `appliedTo`
    // holds entry numbers here and uuids there -- the same distinction, one layer down.
    const projectUuid = draft.project
      ? (projects.find((p) => p.id === draft.project)?.uuid ?? null)
      : null
    const appliedTo = (draft.appliedTo || [])
      .map((entryId) => journal.find((e) => e.id === entryId)?.uuid)
      .filter(Boolean)

    return get().mutate({
      label: 'journal:post',
      call: () => api.post('/journal-entries', {
        entryDate: draft.date || appToday(),
        memo: draft.memo,
        projectId: projectUuid,
        groupRef: draft.groupRef || null,
        source: {
          kind: draft.source?.kind || 'manual',
          ref: draft.source?.ref ?? null,
          // The date on the receipt (round 4); the entry date stays the received date.
          ...((draft.source?.documentDate || draft.documentDate)
            ? { documentDate: draft.source?.documentDate || draft.documentDate }
            : {}),
        },
        // Money crosses as a string in both directions. See lib/api.js.
        lines: (draft.lines || []).map((l) => ({
          account: l.account,
          debit: String(Math.round(Number(l.debit) || 0)),
          credit: String(Math.round(Number(l.credit) || 0)),
          note: l.note || null,
        })),
        appliedTo,
      }),
      refresh: ['journal', 'projects'],
      toast: { title: 'Entry posted', body: draft.memo, kind: 'finance' },
    })
  },

  /** Reverse from the entry drawer. */
  reverseEntryDocument: (id) => {
    const { hydrated, journal, reverseJournalEntry, pushToast } = get()
    const target = journal.find((e) => e.id === id)
    if (!hydrated) return reverseJournalEntry(id)
    if (!target?.uuid) {
      pushToast({
        title: 'Cannot reverse that entry',
        body: `${id} has no server key, so it only exists in this browser session.`,
        kind: 'redflag',
      })
      return Promise.resolve({ ok: false })
    }
    return get().mutate({
      label: `journal:reverse:${id}`,
      call: () => api.post(`/journal-entries/${target.uuid}/reverse`),
      refresh: ['journal', 'projects'],
      toast: { title: 'Entry reversed', body: `${target.voucherNo || id} reversed`, kind: 'finance' },
    })
  },

  /** Adjust from the entry drawer: one call, because the server does both halves in one
   *  transaction and files them under one journal code. */
  adjustEntryDocument: (id, draft) => {
    const { hydrated, journal, adjustJournalEntry, pushToast } = get()
    const target = journal.find((e) => e.id === id)
    if (!hydrated) return adjustJournalEntry(id, draft)
    if (!target?.uuid) {
      pushToast({
        title: 'Cannot adjust that entry',
        body: `${id} has no server key, so it only exists in this browser session.`,
        kind: 'redflag',
      })
      return Promise.resolve({ ok: false })
    }
    return get().mutate({
      label: `journal:adjust:${id}`,
      // Carries the corrected receipt's date as `document_date` when one was given.
      call: () => api.post(`/journal-entries/${target.uuid}/adjust`, adjustBody(draft)),
      refresh: ['journal', 'projects'],
      toast: { title: 'Journal adjusted', body: `${target.voucherNo || id} corrected`, kind: 'finance' },
    })
  },

  // The deck's "click entry code to perform direct edits and adjustments" —
  // implemented audit-safely as a reversal followed by a corrected entry.
  adjustJournalEntry: (id, draft) => {
    const { reverseJournalEntry, postEntry, pushToast } = get()
    const reversal = reverseJournalEntry(id, { silent: true })
    if (!reversal) return null
    const replacement = postEntry({
      ...draft,
      memo: draft.memo || `Adjustment of ${id}`,
      // The receipt date (round 4) the correction carries, if one was given.
      source: { kind: 'adjustment', ref: id, ...(draft.documentDate ? { documentDate: draft.documentDate } : {}) },
      // Same code as the reversal it pairs with: three filed documents, one correction.
      groupRef: reversal.groupRef,
    })
    pushToast({
      title: 'Journal adjusted',
      body: `${id} reversed by ${reversal.id} · corrected as ${replacement.id}`,
      kind: 'finance',
    })
    return replacement
  },

  setTaxRate: (key, rate) =>
    get().hydrated
      ? get().mutate({
          label: `tax:${key}`,
          call: () => api.patch(`/tax-config/${key}`, { rate: Math.max(0, Number(rate) || 0) }),
          refresh: ['taxConfig'],
          toast: { title: 'Tax rate updated', body: get().taxConfig[key]?.label ?? key, kind: 'finance' },
        })
      : set((s) => ({
      taxConfig: { ...s.taxConfig, [key]: { ...s.taxConfig[key], rate: Number(rate) || 0 } },
    })),

  toggleTax: (key) =>
    get().hydrated
      ? get().mutate({
          label: `tax:${key}`,
          call: () => api.patch(`/tax-config/${key}`, { active: !get().taxConfig[key]?.active }),
          refresh: ['taxConfig'],
          toast: { title: 'Tax switched', body: get().taxConfig[key]?.label ?? key, kind: 'finance' },
        })
      : set((s) => ({
      taxConfig: { ...s.taxConfig, [key]: { ...s.taxConfig[key], active: !s.taxConfig[key].active } },
    })),

  // ============================================================
  // THE STATE MACHINE — the hero of the demo.
  // Finance confirms a Down Payment -> a Project ID is generated,
  // a project card is created at "DP Paid", a DP invoice is logged,
  // the ledger is posted, and every module that reads `projects`
  // or `journal` reacts automatically.
  // ============================================================
  //
  // `edited` is the posting pop-up's version of the receipt (round 4): both dates, memo, cash
  // account, withholding and lines. Without it the receipt posts exactly as computed.
  confirmDownPayment: (dealId, { edited = null } = {}) => {
    const { pushToast, taxConfig, postEntry } = get()
    const deal = get()._deal(dealId)
    if (!deal) return

    // On real data the server does the whole conversion in ONE transaction: it creates the
    // project, mints an invoice per billing stage, issues the first and records its
    // receipt. It is also idempotent, because `projects.quotation_id` is unique -- which is
    // the server-side equivalent of the `confirmed` flag, and a far better one than a
    // boolean this store could get out of step with.
    //
    // Note the endpoint is keyed by QUOTATION, not by our local deal id: a deal is a
    // client-side idea, and the quotation is the thing both sides agree exists.
    if (get().hydrated) {
      const quote = get().quotations.find((q) => `DEAL-${q.id}` === deal.id)
      if (!quote?.uuid) {
        pushToast({
          title: 'Cannot reach that quotation',
          body: `${deal.name} has no server key, so it only exists in this browser session.`,
          kind: 'redflag',
        })
        return Promise.resolve({ ok: false })
      }
      return get()
        .mutate({
          label: `dp:confirm:${deal.id}`,
          // The pop-up's receipt (round 4): both dates, cash account, withholding, and the tax
          // figure / lines only when the operator changed them. Applies to the receipt only.
          call: () => api.post(`/quotations/${quote.uuid}/confirm-down-payment`, edited ? confirmDpBody(edited) : {}),
          refresh: ['projects', 'invoices', 'journal', 'quotations'],
          toast: { title: 'Down payment confirmed', body: `${deal.name} is now a live project`, kind: 'project' },
        })
        .then((res) => {
          if (res.ok) {
            set((st) => ({
              deals: st.deals.map((d) => (d.id === deal.id ? { ...d, confirmed: true } : d)),
            }))
          }
          return res
        })
    }
    if (deal.confirmed) {
      pushToast({
        title: 'Already confirmed',
        body: `${deal.name} had its down payment confirmed already.`,
        kind: 'redflag',
      })
      return
    }

    const newProject = {
      id: deal.projectIdOnConfirm,
      name: deal.name,
      client: deal.client,
      stage: 'DP Paid',
      division: 'Sales',
      contractValue: deal.contractValue,
      realizedCost: 0,
      estimatedCost: Math.round(deal.contractValue * 0.7),
      eventDate: deal.eventDate,
      pm: 'Dinda A.',
      stageSince: appToday(),
      isNew: true,
    }

    // The whole billing schedule lands in AR at once: stage one is the DP just
    // confirmed, every later stage is a Scheduled draft. That is the client's
    // "automated billing scheduling ... draft billing schedules for DP
    // installments and final settlements in the AR module" — the finance team
    // can see what is still to be billed instead of remembering it.
    const schedule = deal.dpSchedule?.length
      ? deal.dpSchedule
      : [{ label: 'Down Payment', amount: deal.dpAmount, due: appToday() }]

    const firstInvoiceNo = get().invoiceSeq
    const scheduleInvoices = schedule.map((stage, i) => ({
      id: `INV-${String(firstInvoiceNo + i).padStart(4, '0')}`,
      project: deal.projectIdOnConfirm,
      type: stageInvoiceType(i, schedule.length),
      stage: stage.label,
      amount: stage.amount,
      paid: i === 0 ? stage.amount : 0,
      status: i === 0 ? 'Paid' : 'Scheduled',
      due: stage.due || appToday(),
    }))
    const newInvoice = scheduleInvoices[0]

    // Two linked entries, not one. See dpReceipt() in store/seed.js for why the
    // single-entry version was wrong: the client withholds PPh 23, so Oscenia
    // receives NET cash and holds a creditable asset, and revenue is recognised
    // GROSS. The receivable has to exist before it can be settled. The lines come
    // from lib/postings.js -- the same plan the pop-up showed -- and are worked out
    // before anything changes, so a refused edit leaves the deal untouched.
    const plan = planDpConfirm(
      { deal, taxConfig, invoiceId: newInvoice.id, projectId: newProject.id },
      edited ? editedInputs(edited) : {},
    )
    const posting = edited ? get()._editedPosting(plan, edited) : null
    if (edited && !posting) return
    if (!plan.editable) return

    set((s) => ({
      projects: [newProject, ...s.projects],
      invoices: [...scheduleInvoices, ...s.invoices],
      invoiceSeq: s.invoiceSeq + scheduleInvoices.length,
      // Only this deal. The whole point of the collection is that confirming one quotation
      // leaves the others exactly where they were.
      deals: s.deals.map((d) => (d.id === deal.id ? { ...d, confirmed: true } : d)),
      justCreatedId: newProject.id,
    }))

    const [invoiced] = plan.companions
    const recognition = postEntry({
      date: posting ? posting.date : invoiced.date,
      memo: invoiced.memo,
      project: invoiced.project,
      source: invoiced.source,
      lines: invoiced.lines,
    })

    const receipt = plan.editable
    const lines = posting ? posting.lines : receipt.lines
    const entry = postEntry({
      date: posting ? posting.date : receipt.date,
      memo: posting ? posting.memo : receipt.memo,
      project: receipt.project,
      source: withDocumentDate({ kind: 'payment', ref: recognition.id }, posting),
      appliedTo: [recognition.id],
      lines,
    })

    // Cascade of automated notifications across modules.
    pushToast({
      title: 'Project auto-created',
      body: `${deal.projectIdOnConfirm} — ${deal.name}`,
      kind: 'project',
    })
    setTimeout(() => pushToast({
      title: 'Milestone pipeline started',
      body: 'Stage set to "DP Paid" on the Projects board',
      kind: 'pipeline',
    }), 700)
    setTimeout(() => pushToast({
      title: 'Ledger updated',
      body: `${entry.voucherNo || entry.id} posted · ${lines.length} lines · AR reconciled`,
      kind: 'finance',
    }), 1400)
    if (scheduleInvoices.length > 1) {
      setTimeout(() => pushToast({
        title: 'Billing schedule drafted',
        body: `${scheduleInvoices.length - 1} further stage(s) queued in Accounts Receivable`,
        kind: 'finance',
      }), 2100)
    }
  },

  // Undo a down-payment confirmation.
  //
  // The deck's Finance card asks for "structured financial rollback". Confirming
  // a DP was one-way: it created a project, logged an invoice and posted to the
  // ledger, with no way back. Reversing just the journal entry from Accounting
  // was not enough either — the project, the invoice and the dpConfirmed flag
  // all survived, so the screens ended up disagreeing with the books.
  //
  // Only allowed while nothing else has been posted against the project. Once
  // vendor costs or crew payments have landed, undoing would orphan them, so it
  // refuses and points at project cancellation instead — which is the right
  // tool for a project that has started spending.
  undoDownPayment: (dealId) => {
    const { journal, purchaseOrders, pushToast, reverseJournalEntry } = get()
    // A confirmed deal is the only thing that can be undone, so resolution looks at the
    // confirmed ones rather than reusing `_deal`, which looks for an open one.
    const { deals } = get()
    const confirmed = deals.filter((d) => d.confirmed)
    const deal = dealId ? confirmed.find((d) => d.id === dealId) : confirmed.length === 1 ? confirmed[0] : null
    if (!deal) {
      if (confirmed.length > 1) {
        pushToast({
          title: 'Which deal?',
          body: `${confirmed.length} deals have been confirmed — choose which one to reverse.`,
          kind: 'redflag',
        })
      }
      return false
    }
    const pid = deal.projectIdOnConfirm

    // Keyed by PROJECT server-side, because the project is what the confirmation produced.
    //
    // One behavioural difference worth knowing: the server **voids** the project rather
    // than deleting it, since its reversal entries carry the project id and journal entries
    // are immutable -- deleting it would orphan the evidence that the undo happened. The
    // local path below deletes, which is fine for a demo and wrong for a ledger. The
    // re-read brings back the server's version.
    if (get().hydrated) {
      const project = get().projects.find((p) => p.id === pid)
      if (!project?.uuid) {
        pushToast({
          title: 'Cannot reach that project',
          body: `${pid} has no server key, so it only exists in this browser session.`,
          kind: 'redflag',
        })
        return false
      }
      get()
        .mutate({
          label: `dp:undo:${deal.id}`,
          call: () => api.post(`/projects/${project.uuid}/undo-down-payment`),
          refresh: ['projects', 'invoices', 'journal', 'quotations'],
          toast: { title: 'Down payment reversed', body: `${pid} voided, receipt reversed`, kind: 'redflag' },
        })
        .then((res) => {
          if (res.ok) {
            set((st) => ({
              deals: st.deals.map((d) => (d.id === deal.id ? { ...d, confirmed: false } : d)),
            }))
          }
        })
      // The local path returns a boolean the callers branch on; the API path is async, so
      // it reports through the toast instead. Returning true here would be a lie.
      return null
    }

    const own = journal.filter((e) => e.project === pid)
    // A down payment is two linked entries now: the invoice that raised the
    // receivable, and the receipt that cleared it. Both belong to the DP, so
    // both have to be recognised here or the receipt would look like unrelated
    // activity and block the undo it is part of.
    const ownInvoiceIds = get().invoices.filter((i) => i.project === pid).map((i) => i.id)
    const dpRecognition = own.filter(
      (e) => e.source?.kind === 'invoice' && ownInvoiceIds.includes(e.source?.ref)
    )
    const dpEntries = own.filter(
      (e) => dpRecognition.some((d) => d.id === e.id)
        || (e.appliedTo || []).some((ref) => dpRecognition.some((d) => d.id === ref))
    )
    // Anything that is neither the DP receipt nor a reversal of it counts as
    // real work done on the project.
    const otherWork = own.filter(
      (e) => !dpEntries.some((d) => d.id === e.id) && !dpEntries.some((d) => d.id === e.reversalOf)
    )
    const livePos = purchaseOrders.filter((po) => po.project === pid && po.status !== 'Cancelled')

    if (otherWork.length || livePos.length) {
      pushToast({
        title: 'Cannot undo — the project has activity',
        body: `${pid} has ${otherWork.length} posting(s) and ${livePos.length} live PO(s). Cancel the project instead.`,
        kind: 'redflag',
      })
      return false
    }

    // Reverse rather than delete: the ledger keeps the record that a DP was
    // confirmed in error and backed out. The operational effect is undone; the
    // history is not rewritten.
    dpEntries.filter((e) => !e.reversedBy && !e.reversalOf).forEach((e) => reverseJournalEntry(e.id, { silent: true }))

    set((s) => ({
      projects: s.projects.filter((p) => p.id !== pid),
      // Everything the confirmation created goes back, including the later
      // billing stages it scheduled — they were a consequence of the DP.
      invoices: s.invoices.filter((i) => i.project !== pid),
      // Back to awaiting confirmation — and only this deal, so a sibling that was already
      // confirmed is not quietly reopened along with it.
      deals: s.deals.map((d) => (d.id === deal.id ? { ...d, confirmed: false } : d)),
      justCreatedId: null,
    }))

    pushToast({ title: 'Down payment reversed', body: `${pid} removed \u00b7 receipt reversed in the ledger`, kind: 'redflag' })
    return true
  },

  // ============================================================
  // FIXED ASSETS & DEPRECIATION
  //
  // "Once a Fixed Asset acquisition is finalised, the system accurately
  // calculates and schedules the monthly or annual depreciation expense
  // allocation" — and then posts it, so nobody has to remember to.
  // ============================================================

  // Put an asset on the register.
  //
  // `post` decides whether this is a NEW acquisition (which moves money and so
  // posts Dr 1302 / Cr cash-or-payable) or the capitalisation of equipment the
  // books already carry — the seeded warehouse kit, for instance, which is
  // inside the opening 1302 balance and must not be counted twice.
  capitaliseAsset: (draft, { post = true, payFrom = '1101' } = {}) => {
    const { fixedAssets, fixedAssetSeq, pushToast, postEntry } = get()
    const error = validateAsset(draft)
    if (error) {
      pushToast({ title: 'Asset not added', body: error, kind: 'redflag' })
      return null
    }
    if (get().hydrated) {
      return get().mutate({
        label: 'asset:new',
        call: () => api.post('/fixed-assets', assetBody(draft, { post, payFrom }, { inventory: get().inventory })),
        refresh: ['fixedAssets', 'journal'],
        toast: {
          title: post ? 'Fixed asset capitalised' : 'Asset added to the register',
          body: `${String(draft.name).trim()} \u00b7 ${money(Math.round(Number(draft.cost) || 0))}`,
          kind: 'finance',
        },
      })
    }

    const seq = fixedAssetSeq + 1
    const asset = {
      id: `FA-${String(seq).padStart(3, '0')}`,
      name: String(draft.name).trim(),
      category: draft.category || 'Equipment',
      inventoryId: draft.inventoryId || null,
      acquiredOn: draft.acquiredOn,
      cost: Math.round(Number(draft.cost) || 0),
      salvage: Math.round(Number(draft.salvage) || 0),
      usefulLifeMonths: Math.round(Number(draft.usefulLifeMonths) || 0),
      method: draft.method || 'straight-line',
      status: 'active',
      postedThrough: null,
      postedAccumulated: 0,
    }

    set((s) => ({ fixedAssets: [...s.fixedAssets, asset], fixedAssetSeq: seq }))

    if (post) {
      const entry = postEntry({
        date: asset.acquiredOn,
        memo: `Fixed asset acquired — ${asset.name}`,
        source: { kind: 'depreciation', ref: asset.id },
        series: 'fa',
        lines: [
          { account: '1302', debit: asset.cost, credit: 0, note: `${asset.id} · ${asset.name}` },
          { account: payFrom, debit: 0, credit: asset.cost, note: 'Acquisition settled' },
        ],
      })
      pushToast({
        title: 'Fixed asset capitalised',
        body: `${asset.id} · ${money(asset.cost)} · ${entry.voucherNo}`,
        kind: 'finance',
      })
    } else {
      pushToast({
        title: 'Asset added to the register',
        body: `${asset.id} · already carried in account 1302, so nothing was posted`,
        kind: 'project',
      })
    }
    return asset
  },

  // Shrink a registered asset when some of its physical units are destroyed.
  // Returns the share of accumulated depreciation that goes with them, so the
  // caller can post it. Returns 0 when the stock is not on the register.
  _writeDownRegisteredAsset: (inventoryId, costRemoved) => {
    const { fixedAssets } = get()
    const asset = fixedAssets.find((a) => a.inventoryId === inventoryId && a.status !== 'disposed')
    if (!asset || !asset.cost) return 0

    const share = Math.min(1, costRemoved / asset.cost)
    const accumShare = Math.round((asset.postedAccumulated || 0) * share)
    const salvageShare = Math.round((asset.salvage || 0) * share)
    const remainingCost = Math.max(0, asset.cost - costRemoved)

    set((s) => ({
      fixedAssets: s.fixedAssets.map((a) => {
        if (a.id !== asset.id) return a
        // Nothing left means the asset is gone, not merely smaller.
        if (remainingCost <= 0) {
          return { ...a, status: 'disposed', disposedAt: appToday(), cost: 0, salvage: 0, postedAccumulated: 0 }
        }
        return {
          ...a,
          cost: remainingCost,
          salvage: Math.max(0, (a.salvage || 0) - salvageShare),
          postedAccumulated: Math.max(0, (a.postedAccumulated || 0) - accumShare),
          // Rebase so the smaller asset spreads what is left over the life that
          // remains, rather than keeping the old, larger monthly charge.
          scheduleFrom: a.postedThrough ? addMonths(a.postedThrough, 1) : a.scheduleFrom,
          openingAccumulated: Math.max(0, (a.postedAccumulated || 0) - accumShare),
        }
      }),
    }))

    return accumShare
  },

  updateAsset: (id, patch) => {
    const { fixedAssets, pushToast } = get()
    const asset = fixedAssets.find((a) => a.id === id)
    if (!asset) return null
    if (get().hydrated) {
      if (!asset.uuid) return get()._notSaved(`${id} (it only exists in this browser)`)
      // The register's own checks first (so the message is the register's), then the server's.
      const problem = validateAsset({ ...asset, ...patch, cost: asset.cost })
      if (problem) {
        pushToast({ title: 'Asset not saved', body: problem, kind: 'redflag' })
        return Promise.resolve({ ok: false })
      }
      const body = assetPatchBody(patch)
      if (!Object.keys(body).length) return Promise.resolve({ ok: true })
      return get().mutate({
        label: `asset:${id}`,
        call: () => api.patch(`/fixed-assets/${asset.uuid}`, body),
        refresh: ['fixedAssets'],
        toast: { title: 'Asset updated', body: `${id} \u00b7 ${patch.name ?? asset.name}`, kind: 'project' },
      })
    }
    // Cost is what was actually paid and is evidenced by the acquisition entry;
    // changing it here would put the register out of step with account 1302.
    // Useful life and method are estimates and may legitimately be revised —
    // the schedule simply re-plans the periods that have not been posted.
    const safe = { ...patch }
    delete safe.cost
    delete safe.postedThrough
    delete safe.postedAccumulated

    // Revising an estimate is PROSPECTIVE. Periods already posted keep the
    // charges they were posted at; the schedule is rebased to the first
    // unposted period, carrying the ledger figure forward, and what is left to
    // depreciate is spread over the life that remains. Without this, extending
    // a useful life would retroactively lower every past charge and the
    // register would stop agreeing with account 1303.
    const revising = (safe.usefulLifeMonths != null && Number(safe.usefulLifeMonths) !== asset.usefulLifeMonths)
      || (safe.method != null && safe.method !== asset.method)
    if (revising && asset.postedThrough) {
      safe.scheduleFrom = addMonths(asset.postedThrough, 1)
      safe.openingAccumulated = accumulatedFor(asset)
    }

    const next = { ...asset, ...safe }
    const error = validateAsset(next)
    if (error) {
      pushToast({ title: 'Asset not saved', body: error, kind: 'redflag' })
      return null
    }
    set((s) => ({ fixedAssets: s.fixedAssets.map((a) => (a.id === id ? next : a)) }))
    pushToast({ title: 'Asset updated', body: `${id} · ${next.name}`, kind: 'project' })
    return next
  },

  // Post the depreciation charge for one period across every asset that owes it.
  //
  // ONE entry per period, with a line per asset, because that is how a
  // depreciation run reads in a ledger — thirty-six separate entries for six
  // assets over six months would bury every other transaction in the journal.
  runDepreciationPeriod: (period) => {
    const { fixedAssets, pushToast, postEntry } = get()
    if (get().hydrated) {
      return get().mutate({
        label: 'depr:run',
        call: () => api.post('/depreciation/run', { period }),
        refresh: ['fixedAssets', 'journal'],
        toast: { title: `Depreciation posted \u2014 ${period}`, body: 'across every asset that owed it', kind: 'finance' },
      })
    }

    const charges = fixedAssets
      .filter((a) => a.status !== 'disposed')
      .map((a) => {
        const row = duePeriods(a).find((r) => r.period === period)
        return row ? { asset: a, row } : null
      })
      .filter(Boolean)
      .filter((c) => c.row.charge > 0)

    if (!charges.length) return null

    const total = charges.reduce((a, c) => a + c.row.charge, 0)
    const lines = charges.map((c) => ({
      account: '6103',
      debit: c.row.charge,
      credit: 0,
      note: `${c.asset.id} · ${c.asset.name}`,
    }))
    lines.push({
      account: '1303', debit: 0, credit: total,
      note: `Accumulated depreciation · ${charges.length} asset(s)`,
    })

    const entry = postEntry({
      date: periodEnd(period),
      memo: `Depreciation — ${period}`,
      source: { kind: 'depreciation', ref: period },
      series: 'fa',
      lines,
    })

    set((s) => ({
      fixedAssets: s.fixedAssets.map((a) => {
        const charge = charges.find((c) => c.asset.id === a.id)
        if (!charge) return a
        // `postedAccumulated` is the register's copy of what account 1303 now
        // holds for this asset. Storing it — rather than re-deriving it from
        // the schedule — is what stops a later change of useful life from
        // restating depreciation that has already been posted.
        return {
          ...a,
          postedThrough: period,
          postedAccumulated: (a.postedAccumulated || 0) + charge.row.charge,
        }
      }),
    }))

    pushToast({
      title: `Depreciation posted — ${period}`,
      body: `${entry.voucherNo} · ${money(total)} across ${charges.length} asset(s)`,
      kind: 'finance',
    })
    return entry
  },

  // Clear the backlog: post every period that has fallen due, oldest first.
  // This is the action that answers "eliminates the risk of missing monthly
  // fixed asset depreciation bookkeeping".
  runDepreciation: () => {
    const { fixedAssets, runDepreciationPeriod, pushToast } = get()
    if (get().hydrated) {
      // One request clears the whole backlog, oldest period first; running it twice posts nothing.
      return get().mutate({
        label: 'depr:run',
        call: () => api.post('/depreciation/run', {}),
        refresh: ['fixedAssets', 'journal'],
        toast: { title: 'Depreciation run', body: 'every period that had fallen due is posted', kind: 'finance' },
      })
    }

    // Every distinct period owed across the whole register, in order.
    const periods = [...new Set(
      fixedAssets
        .filter((a) => a.status !== 'disposed')
        .flatMap((a) => duePeriods(a).map((r) => r.period))
    )].sort()

    if (!periods.length) {
      pushToast({ title: 'Nothing due', body: 'Depreciation is up to date.', kind: 'finance' })
      return []
    }

    const posted = periods.map((p) => runDepreciationPeriod(p)).filter(Boolean)
    if (posted.length > 1) {
      setTimeout(() => pushToast({
        title: 'Backlog cleared',
        body: `${posted.length} period(s) caught up`,
        kind: 'finance',
      }), 600)
    }
    return posted
  },

  // Retire an asset: remove its remaining book value and stop the schedule.
  disposeAsset: (id, { proceeds = 0 } = {}) => {
    const { fixedAssets, pushToast, postEntry } = get()
    const asset = fixedAssets.find((a) => a.id === id)
    if (!asset || asset.status === 'disposed') return null
    if (get().hydrated) {
      if (!asset.uuid) return get()._notSaved(`${id} (it only exists in this browser)`)
      return get().mutate({
        label: `asset:${id}`,
        call: () => api.post(`/fixed-assets/${asset.uuid}/dispose`, { proceeds: String(Math.round(Number(proceeds) || 0)) }),
        refresh: ['fixedAssets', 'journal'],
        toast: { title: 'Asset disposed', body: `${asset.id} \u00b7 ${asset.name}`, kind: 'redflag' },
      })
    }

    const accumulated = accumulatedFor(asset)
    const nbv = asset.cost - accumulated
    const cash = Math.round(Number(proceeds) || 0)
    const loss = nbv - cash

    const lines = []
    if (cash > 0) lines.push({ account: '1101', debit: cash, credit: 0, note: 'Disposal proceeds' })
    if (accumulated > 0) {
      lines.push({ account: '1303', debit: accumulated, credit: 0, note: 'Accumulated depreciation removed' })
    }
    // A disposal above book value is a gain; below it, a loss. Both land in
    // Asset Loss Expense, signed — a separate gain account for a prototype
    // would be one more line on the statement for no extra clarity.
    if (loss !== 0) {
      lines.push({ account: '6901', debit: Math.max(0, loss), credit: Math.max(0, -loss), note: loss > 0 ? 'Loss on disposal' : 'Gain on disposal' })
    }
    lines.push({ account: '1302', debit: 0, credit: asset.cost, note: `${asset.id} removed at cost` })

    const entry = postEntry({
      memo: `Fixed asset disposed — ${asset.name}`,
      source: { kind: 'depreciation', ref: asset.id },
      series: 'fa',
      lines,
    })

    set((s) => ({
      fixedAssets: s.fixedAssets.map((a) =>
        a.id === id ? { ...a, status: 'disposed', disposedAt: appToday(), proceeds: cash } : a
      ),
    }))

    pushToast({
      title: 'Asset disposed',
      body: `${asset.id} · book value ${money(nbv)} · ${entry.voucherNo}`,
      kind: 'redflag',
    })
    return entry
  },

  // ============================================================
  // ACCOUNTS RECEIVABLE
  //
  // Client issue #1: "fixes the trigger for creating DP settlement entries in
  // the AR module so customer receivable balances are updated instantly."
  //
  // The root cause was not a broken trigger — there was no trigger at all. The
  // Receivables screen could list and print an invoice but had no way to record
  // that money had arrived, so ledger 1201 and the ageing buckets could never
  // move. These two actions are that missing half.
  // ============================================================

  // The journal entry that raised the receivable for an invoice, if there is
  // one. Payments are applied against this, which is what keeps the document
  // chain intact rather than just netting the control account to zero.
  _recognitionFor: (invoiceId) => {
    const { journal } = get()
    return journal.find(
      (e) => e.source?.kind === 'invoice'
        && e.source?.ref === invoiceId
        && !e.reversedBy
        && !e.reversalOf
        && (e.lines || []).some((l) => l.account === '1201' && (Number(l.debit) || 0) > 0)
    ) || null
  },

  // Raise the receivable for a scheduled billing stage. A stage sitting on the
  // billing schedule is a plan, not a debt — nothing is owed until it is
  // invoiced, so nothing posts until this is called.
  /**
   * Raise the receivable for a scheduled stage, on the two dates the client asked for.
   *
   * `issuedOn` is the accounting date -- the date the posting carries, and the one every
   * report and the period-close trigger reads. `documentDate` is the date on the invoice
   * itself, which moves no figure; it exists so a document dated last month and recorded
   * this month can be reconciled as both. Before this the endpoint took no body at all, so
   * a late invoice could only ever be recorded as of today.
   */
  issueInvoice: (invoiceId, { issuedOn = null, documentDate = null } = {}) => {
    const { invoices, pushToast, postEntry, projects } = get()
    const inv = invoices.find((i) => i.id === invoiceId)
    if (!inv) return null
    if (inv.status !== 'Scheduled') {
      pushToast({ title: 'Already issued', body: `${inv.id} is ${inv.status.toLowerCase()}`, kind: 'redflag' })
      return null
    }

    if (get().hydrated) {
      if (!inv.uuid) {
        pushToast({
          title: 'Cannot reach that invoice',
          body: `${inv.id} has no server key, so it only exists in this browser session.`,
          kind: 'redflag',
        })
        return Promise.resolve({ ok: false })
      }
      return get().mutate({
        label: `invoice:issue:${inv.id}`,
        call: () => api.post(`/invoices/${inv.uuid}/issue`, { issuedOn, documentDate }),
        // The posting moves the receivable and the project's realised revenue, so both
        // come back rather than being patched locally.
        refresh: ['invoices', 'journal', 'projects'],
        toast: { title: 'Invoice issued', body: `${inv.id} · ${money(inv.amount)}`, kind: 'finance' },
      })
    }
    const project = projects.find((p) => p.id === inv.project)
    // A down-payment stage is unearned at the point of billing; later stages
    // are revenue on delivery. Different accounts, same receivable.
    const revenueAccount = inv.type === 'Down Payment' ? '4101' : '4102'

    const posted = issuedOn || appToday()
    const entry = postEntry({
      date: posted,
      memo: `${inv.type} invoiced — ${project?.name || inv.project}`,
      project: inv.project,
      // `documentDate` rides on the source so the Payables-style readers can find it in one
      // place, the way `due` already does.
      source: { kind: 'invoice', ref: inv.id, documentDate },
      lines: [
        { account: '1201', debit: inv.amount, credit: 0, note: `Receivable raised on ${inv.id}` },
        { account: revenueAccount, debit: 0, credit: inv.amount, note: inv.type },
      ],
    })

    set((s) => ({
      invoices: s.invoices.map((i) => (
        i.id === invoiceId
          ? { ...i, status: 'Unpaid', issuedAt: posted, documentDate: documentDate || i.documentDate || null }
          : i
      )),
    }))
    pushToast({
      title: 'Invoice issued',
      body: `${inv.id} · ${money(inv.amount)} · ${entry.voucherNo}`,
      kind: 'finance',
    })
    return entry
  },

  // Record a client payment against an invoice.
  //
  // Partial payment is supported because it happens: a client pays half now and
  // half after the event, and an AR module that can only record settlement in
  // full would push that reality out of the system.
  //
  // `taxAmount` overrides the computed withholding — the client asked for
  // automated calculation "to prevent manual number input errors", but a real
  // remittance advice sometimes rounds differently and the books have to match
  // what the bank actually did.
  //
  // `edited` is the posting pop-up's version of the receipt (round 4); its dates, cash account
  // and withholding replace the arguments, and its lines post as long as they pass the guard.
  receivePayment: (invoiceId, {
    amount,
    date = appToday(),
    cashAccount = '1101',
    withhold = true,
    taxAmount = null,
    edited = null,
  } = {}) => {
    const { invoices, pushToast, postEntry, taxConfig, projects, _recognitionFor } = get()
    const inv = invoices.find((i) => i.id === invoiceId)
    if (!inv) return null

    // Live: the server records the receipt (it clamps to outstanding and refuses a scheduled
    // invoice itself), and the invoice, journal and project figures are re-read. Always a
    // promise, so the pop-up can wait for it and show a refusal.
    if (get().hydrated) {
      if (!inv.uuid) {
        const error = new Error(`${inv.id} has no server key, so it only exists in this browser session.`)
        pushToast({ title: 'Cannot reach that invoice', body: error.message, kind: 'redflag' })
        return Promise.resolve({ ok: false, error })
      }
      const gross = Math.round(Number(amount) || 0)
      return get().mutate({
        label: `ar:receive:${inv.id}`,
        call: () => api.post(
          `/invoices/${inv.uuid}/payments`,
          paymentBody(gross, edited, { date: null, cashAccount, withhold, taxAmount }),
        ),
        refresh: ['invoices', 'journal', 'projects'],
        toast: { title: 'Payment recorded', body: `${inv.id} · ${money(gross)}`, kind: 'finance' },
      })
    }

    if (inv.status === 'Scheduled') {
      pushToast({
        title: 'Not yet invoiced',
        body: `${inv.id} is still a scheduled billing stage. Issue it first, then record the payment.`,
        kind: 'redflag',
      })
      return null
    }

    const outstanding = inv.amount - (inv.paid || 0)
    if (outstanding <= 0) {
      pushToast({ title: 'Nothing outstanding', body: `${inv.id} is already settled in full`, kind: 'redflag' })
      return null
    }

    // Never accept more than is owed — an overpayment is a different
    // transaction (a credit note or a refund), not a bigger receipt.
    const gross = Math.min(Math.round(Number(amount) || 0), outstanding)
    if (gross <= 0) {
      pushToast({ title: 'Nothing to post', body: 'Enter an amount greater than zero.', kind: 'redflag' })
      return null
    }

    const recognition = _recognitionFor(invoiceId)
    const project = projects.find((p) => p.id === inv.project)
    const plan = planReceivePayment(
      { invoice: inv, taxConfig, projectName: project?.name, recognitionId: recognition?.id },
      edited ? { amount: gross, ...editedInputs(edited) } : { amount: gross, date, cashAccount, withhold, taxAmount },
    )
    if (plan.error === 'tax') {
      pushToast({ title: 'Tax exceeds the payment', body: 'Withholding cannot be larger than the amount received.', kind: 'redflag' })
      return null
    }
    if (!plan.editable) return null
    const posting = edited ? get()._editedPosting(plan, edited) : null
    if (edited && !posting) return null
    const mv = plan.editable
    const postedOn = posting ? posting.date : mv.date

    const entry = postEntry({
      date: postedOn,
      memo: posting ? posting.memo : mv.memo,
      project: inv.project,
      source: withDocumentDate(mv.source, posting),
      appliedTo: recognition ? [recognition.id] : [],
      lines: posting ? posting.lines : mv.lines,
    })

    // The toast reports what posted: after an edit the 1401 line may differ from the plan.
    const tax = postedWithholding(entry.lines, 'client')
    const net = gross - tax
    const paid = (inv.paid || 0) + gross
    const settled = paid >= inv.amount - 1
    set((s) => ({
      invoices: s.invoices.map((i) =>
        i.id === invoiceId
          ? { ...i, paid, status: settled ? 'Paid' : 'Partially Paid', lastPaidAt: postedOn }
          : i
      ),
    }))

    pushToast({
      title: settled ? 'Invoice settled' : 'Part payment recorded',
      body: `${inv.id} · ${money(gross)}${tax ? ` (${money(net)} cash, ${money(tax)} PPh 23)` : ''} · ${entry.voucherNo}`,
      kind: 'finance',
    })
    return entry
  },

  // What the server cannot do yet. In live mode the demo action would change browser memory and
  // vanish on refresh (or, worse, post a fake entry to a real ledger), so it says so instead.
  _notSaved: (what) => {
    get().pushToast({
      title: 'Not saved',
      body: `${what} is not connected to the server yet, so nothing was changed.`,
      kind: 'redflag',
    })
    return Promise.resolve({ ok: false })
  },

  // A stage move or a cancellation, through the API. The server owns the rules (a cancelled project
  // does not move; stepping back out of feedback withdraws the rating), so this only sends it and
  // re-reads. No demo survey cascade runs here: that rated the client with a made-up score.
  _project: (projectId, { label, path, body, toast, refresh }) => {
    const project = get().projects.find((p) => p.id === projectId)
    if (!project?.uuid) {
      get().pushToast({
        title: 'Cannot reach that project',
        body: `${projectId} has no server key, so it only exists in this browser session.`,
        kind: 'redflag',
      })
      return Promise.resolve({ ok: false })
    }
    return get().mutate({
      label,
      call: () => api.post(`/projects/${project.uuid}/${path}`, body),
      refresh: refresh ?? ['projects'],
      toast,
    })
  },

  // Record whether a purchase order's goods have arrived. Signed in this is the server's (it posts nothing and
  // is refused for a draft or cancelled order); signed out the demo keeps its own record (`useProto.poDelivery`).
  setPoDelivery: (poId, status) => {
    const po = get().purchaseOrders.find((p) => p.id === poId)
    if (!get().hydrated || !po?.uuid) return get()._notSaved('Recording delivery')
    return get().mutate({
      label: `po:delivery:${poId}`,
      call: () => api.put(`/purchase-orders/${po.uuid}/delivery`, { status }),
      refresh: ['purchaseOrders'],
      toast: { title: `Delivery: ${status}`, body: poId, kind: 'po' },
    })
  },

  // Fix a project's name, division or event date (CEO, PM). Live only: signed out, a project is seed data.
  // The server says what a new date moved (invoices not yet issued, draft delivery orders) and what staff
  // still have to update by hand (an invitation showing the old date); that is shown, not hidden.
  updateProject: async (projectId, patch) => {
    const project = get().projects.find((p) => p.id === projectId)
    if (!get().hydrated) return get()._notSaved('Editing a project')
    if (!project?.uuid) return get()._notSaved(`${projectId} (it only exists in this browser)`)
    const body = projectPatchBody(patch)
    if (!Object.keys(body).length) return { ok: true }
    let reply = null
    const out = await get().mutate({
      label: `project:edit:${projectId}`,
      call: async () => { reply = await api.patch(`/projects/${project.uuid}`, body) },
      refresh: ['projects', 'invoices'],
      toast: { title: 'Project updated', body: project.name, kind: 'project' },
    })
    if (reply) {
      const moved = []
      if (reply.invoicesRescheduled) moved.push(`${reply.invoicesRescheduled} invoice due date(s) moved`)
      if (reply.deliveryOrdersUpdated) moved.push(`${reply.deliveryOrdersUpdated} draft delivery order(s) updated`)
      if (reply.itemsUpdated) moved.push(`${reply.itemsUpdated} item(s) still out updated`)
      if (moved.length) get().pushToast({ title: 'Event date carried through', body: moved.join(' · '), kind: 'project' })
      if (reply.warnings?.length) get().pushToast({ title: 'Update by hand', body: reply.warnings.join(' '), kind: 'redflag' })
    }
    return out
  },

  // Crew (Payroll). Signed in these are the server's; signed out the crew list is seed data and says so.
  addCrew: (draft) => {
    if (!get().hydrated) return get()._notSaved('Adding crew')
    return get().mutate({
      label: 'crew:add',
      call: () => api.post('/crew', crewBody(draft)),
      refresh: ['crew'],
      toast: { title: 'Crew member added', body: draft.name, kind: 'payroll' },
    })
  },
  updateCrew: (crewId, patch) => {
    const member = get().crew.find((c) => c.id === crewId)
    if (!get().hydrated || !member?.uuid) return get()._notSaved('Editing crew')
    const body = crewBody(patch)
    if (!Object.keys(body).length) return Promise.resolve({ ok: true })
    return get().mutate({
      label: `crew:edit:${crewId}`,
      call: () => api.patch(`/crew/${member.uuid}`, body),
      refresh: ['crew'],
      toast: { title: 'Crew member updated', body: member.name, kind: 'payroll' },
    })
  },
  setCrewActive: (crewId, active) => {
    const member = get().crew.find((c) => c.id === crewId)
    if (!get().hydrated || !member?.uuid) return get()._notSaved('Changing a crew member')
    return get().mutate({
      label: `crew:active:${crewId}`,
      call: () => api.post(`/crew/${member.uuid}/${active ? 'reactivate' : 'deactivate'}`),
      refresh: ['crew'],
      toast: { title: active ? 'Crew member back in' : 'Crew member left out of new pools', body: member.name, kind: 'payroll' },
    })
  },
  deleteCrew: (crewId) => {
    const member = get().crew.find((c) => c.id === crewId)
    if (!get().hydrated || !member?.uuid) return get()._notSaved('Removing crew')
    return get().mutate({
      label: `crew:delete:${crewId}`,
      call: () => api.delete(`/crew/${member.uuid}`),
      refresh: ['crew'],
      toast: { title: 'Crew member removed', body: member.name, kind: 'payroll' },
    })
  },

  // Name the project's PM (a user's server id), or clear it with null. Live only: the demo's
  // projects carry a made-up `pm` string and no people to pick from.
  setProjectPm: (projectId, userUuid) => {
    const project = get().projects.find((p) => p.id === projectId)
    if (!get().hydrated) return get()._notSaved('Naming the project PM')
    if (!project?.uuid) return get()._notSaved(`${projectId} (it only exists in this browser)`)
    return get().mutate({
      label: `pm:${projectId}`,
      call: () => api.put(`/projects/${project.uuid}/pm`, { userId: userUuid || null }),
      refresh: ['projects'],
      toast: { title: 'Project PM updated', body: projectId, kind: 'project' },
    })
  },

  // Advance a project one stage along the pipeline (used on the board).
  advanceStage: (projectId) => {
    if (get().hydrated) {
      return get()._project(projectId, {
        label: `stage:${projectId}`,
        path: 'advance-stage',
        toast: { title: 'Stage advanced', body: projectId, kind: 'pipeline' },
      })
    }
    const STAGES = [
      'DP Paid', 'Design Uploaded', 'Client Approval', 'Vendor Dispatch',
      'Execution Event', 'Post-Event Feedback', 'Finished',
    ]
    let enteredFeedback = null
    set((s) => ({
      projects: s.projects.map((p) => {
        if (p.id !== projectId) return p
        const idx = STAGES.indexOf(p.stage)
        if (idx < 0 || idx >= STAGES.length - 1) return p
        const next = STAGES[idx + 1]
        if (next === 'Post-Event Feedback') enteredFeedback = p
        return { ...p, stage: next, stageSince: appToday() }
      }),
    }))
    // ============================================================
    // AUTOMATION #2 — reaching Post-Event Feedback auto-runs the
    // client survey -> records the score -> recalculates crew bonuses.
    // ============================================================
    if (enteredFeedback) get()._fireFeedback(enteredFeedback)
  },

  // Move a project to any stage. Used by drag-and-drop on the board, which can
  // cross several columns in one gesture.
  //
  // The stage-entry automations still have to fire correctly: landing on (or
  // jumping over) Post-Event Feedback runs the client survey, and dragging back
  // out of it withdraws the rating and the incentive pool it produced — the same
  // rule revertStage applies, because a bonus must not outlive the event that
  // earned it.
  moveProjectToStage: (projectId, stage) => {
    const { projects, pushToast, latestFeedback, incentivesPaid } = get()
    const project = projects.find((p) => p.id === projectId)
    if (!project || project.cancelled) return false
    const from = STAGES.indexOf(project.stage)
    const to = STAGES.indexOf(stage)
    if (to < 0 || from < 0 || to === from) return false
    if (get().hydrated) {
      return get()._project(projectId, {
        label: `stage:${projectId}`,
        path: 'move-to-stage',
        body: { stage },
        toast: { title: to > from ? 'Stage advanced' : 'Stage reverted', body: `${projectId} · ${project.stage} → ${stage}`, kind: 'pipeline' },
      })
    }

    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === projectId ? { ...p, stage, stageSince: appToday() } : p
      ),
    }))

    const feedbackIdx = STAGES.indexOf('Post-Event Feedback')
    const movingForward = to > from

    if (movingForward && from < feedbackIdx && to >= feedbackIdx) {
      // Crossed into or past feedback — run the survey cascade once.
      get()._fireFeedback(project)
    } else if (!movingForward && from >= feedbackIdx && to < feedbackIdx) {
      if (latestFeedback?.projectId === projectId && !incentivesPaid) {
        set({ latestFeedback: null })
        pushToast({ title: 'Client rating withdrawn', body: 'Crew incentive pool cleared', kind: 'payroll' })
      }
    }

    pushToast({
      title: movingForward ? 'Stage advanced' : 'Stage reverted',
      body: `${projectId} · ${project.stage} → ${stage}`,
      kind: 'pipeline',
    })
    return true
  },

  // Pre-set client scores so the demo is deterministic (no randomness).
  _feedbackScores: {
    'EVT-2026-GALA-01': 9.4,
    'EVT-2026-WED-02': 9.8,
    'EVT-2026-CONF-03': 8.9,
    'EVT-2026-GALA-02': 9.2,
  },

  _fireFeedback: (project) => {
    const { pushToast, _feedbackScores, crew } = get()
    const score = _feedbackScores[project.id] ?? 9.1

    // 1) survey dispatched
    pushToast({
      title: 'Client survey sent',
      body: `Rating form → ${project.client} (${project.name})`,
      kind: 'feedback',
    })

    // 2) client responds -> record score
    setTimeout(() => {
      const pool = crew.reduce((a, c) => a + Math.round(c.baseRate * (score / 10)), 0)
      set({ latestFeedback: { projectId: project.id, name: project.name, client: project.client, score, pool }, incentivesPaid: false })
      pushToast({
        title: `Client rated ${score.toFixed(1)} / 10`,
        body: `${project.name} · feedback recorded`,
        kind: 'feedback',
      })
    }, 900)

    // 3) crew incentive pool recalculated
    setTimeout(() => {
      pushToast({
        title: 'Crew incentives recalculated',
        body: 'Performance bonuses updated from client rating',
        kind: 'payroll',
      })
    }, 1800)
  },

  // Approve and disburse the crew incentive pool. Posts to the ledger so the
  // bonus lands on the right project's cost — the deck asked for incentives to
  // integrate with Payroll and the General Ledger, tagged to a Project ID.
  disburseIncentives: (amount, projectId) => {
    const { postEntry, pushToast, incentivesPaid, projects } = get()
    if (incentivesPaid || !amount) return false
    if (get().hydrated) {
      const proj = projects.find((p) => p.id === projectId)
      if (!proj?.uuid) {
        pushToast({ title: 'Pick a project', body: 'Incentives must be allocated to a Project ID.', kind: 'redflag' })
        return Promise.resolve({ ok: false })
      }
      // The server pays what its own pool says (rating x base rate, gated by the threshold), so the
      // amount is not sent: the screen's figure and the posting cannot disagree.
      return get().mutate({
        label: 'incentives:pay',
        call: () => api.post('/incentives/disburse', { projectId: proj.uuid }),
        refresh: ['incentives', 'journal'],
        toast: { title: 'Incentives disbursed', body: `allocated to ${proj.id}`, kind: 'payroll' },
      })
    }

    // The deck calls the Project ID tag mandatory, "for explicit cost
    // allocation". It was optional, and disbursing without one posted
    // project: null — so the bonus cost landed on no project at all and never
    // reached any P&L. Refusing is the whole point of the word "mandatory".
    const project = projects.find((p) => p.id === projectId)
    if (!project) {
      pushToast({
        title: 'Project tag required',
        body: 'Crew incentives must be allocated to a Project ID before disbursement',
        kind: 'redflag',
      })
      return false
    }

    set({ incentivesPaid: true })
    const entry = postEntry({
      memo: `Crew incentive disbursement — ${project.name}`,
      project: project.id,
      source: { kind: 'payroll', ref: `INC-${project.id}` },
      lines: [
        { account: '5102', debit: amount, credit: 0, note: 'Performance bonuses' },
        { account: '1101', debit: 0, credit: amount, note: 'Bank transfer to crew' },
      ],
    })
    pushToast({
      title: 'Incentives disbursed',
      body: `${entry.id} posted · allocated to ${project.id}`,
      kind: 'payroll',
    })
    return true
  },

  // ============================================================
  // QUOTATIONS / MoU. Sales drafts a quote, sends it, and on client
  // acceptance it generates an MoU and becomes the pending deal that
  // Finance confirms — the true front of the state machine.
  // ============================================================
  // A quotation, through the API when signed in. `_quotation` finds the server key for the number
  // the page holds (`QT-1001`) and re-reads afterwards.
  _quotation: (id, { label, path, body, method = 'post', toast }) => {
    const q = get().quotations.find((x) => x.id === id)
    if (!q?.uuid) {
      get().pushToast({
        title: 'Cannot reach that quotation',
        body: `${id} has no server key, so it only exists in this browser session.`,
        kind: 'redflag',
      })
      return Promise.resolve({ ok: false })
    }
    return get().mutate({
      label,
      call: () => api[method](`/quotations/${q.uuid}${path ? `/${path}` : ''}`, body),
      // An accepted quotation becomes a pending deal; `quotations` pulls the projects it reads.
      refresh: ['quotations'],
      toast,
    })
  },

  addQuotation: (draft) => {
    const { quotations, pushToast } = get()
    if (get().hydrated) {
      const { body, error } = quotationBody(draft, { clients: get().clients })
      if (error) {
        pushToast({ title: 'Cannot raise that quotation', body: error, kind: 'redflag' })
        return Promise.resolve({ ok: false })
      }
      return get().mutate({
        label: 'quote:new',
        call: () => api.post('/quotations', body),
        refresh: ['quotations'],
        toast: { title: 'Quotation created', body: draft.client, kind: 'project' },
      })
    }
    const n = 1000 + quotations.length + 1
    const quote = {
      id: `QT-${n}`,
      status: 'Draft',
      createdBy: 'Dinda A.',
      projectId: `EVT-2026-NEW-${quotations.length + 1}`,
      dpPercent: 30,
      ...draft,
    }
    set((s) => ({ quotations: [quote, ...s.quotations] }))
    pushToast({ title: 'Quotation created', body: `${quote.id} — ${quote.client}`, kind: 'project' })
    return quote
  },

  // Edit a quotation that has not been accepted yet. Line items, DP percentage
  // and template are all fair game up to acceptance; after that the numbers are
  // committed to a deal Finance is acting on, so editing is refused rather than
  // silently allowed to diverge from the MoU already sent.
  updateQuotation: (id, patch) => {
    const { quotations, pushToast } = get()
    const q = quotations.find((x) => x.id === id)
    if (!q) return null
    if (q.status === 'Accepted') {
      pushToast({
        title: 'Cannot edit an accepted quotation',
        body: `${q.id} is already a deal \u2014 decline it or raise a revision`,
        kind: 'redflag',
      })
      return null
    }
    if (get().hydrated) {
      const { body } = quotationBody(patch, { clients: get().clients }, { partial: true })
      return get()._quotation(id, {
        label: `quote:${id}`,
        method: 'patch',
        body,
        // The server drops a sent quotation back to Draft when its figures change.
        toast: { title: 'Quotation updated', body: q.status === 'Sent' ? `${q.id} \u00b7 back to Draft, re-send to the client` : `${q.id} updated`, kind: 'project' },
      })
    }
    set((s) => ({ quotations: s.quotations.map((x) => (x.id === id ? { ...x, ...patch } : x)) }))
    // Re-sending is the client's cue that the numbers moved, so an edited quote
    // drops back to Draft rather than pretending the sent version is current.
    const reverted = q.status === 'Sent'
    if (reverted) {
      set((s) => ({ quotations: s.quotations.map((x) => (x.id === id ? { ...x, status: 'Draft' } : x)) }))
    }
    pushToast({
      title: 'Quotation updated',
      body: reverted ? `${q.id} \u00b7 back to Draft, re-send to the client` : `${q.id} updated`,
      kind: 'project',
    })
    return get().quotations.find((x) => x.id === id)
  },

  sendQuotation: (id) => {
    const { pushToast, quotations } = get()
    const q = quotations.find((x) => x.id === id)
    if (get().hydrated) {
      return get()._quotation(id, {
        label: `quote:${id}`,
        path: 'send',
        toast: { title: 'Quotation sent', body: `${id} \u2192 ${q?.client} \u00b7 awaiting response`, kind: 'finance' },
      })
    }
    set((s) => ({ quotations: s.quotations.map((x) => (x.id === id ? { ...x, status: 'Sent' } : x)) }))
    if (q) pushToast({ title: 'Quotation sent', body: `${q.id} → ${q.client} · awaiting response`, kind: 'finance' })
  },

  acceptQuotation: (id) => {
    const { quotations, pushToast } = get()
    const q = quotations.find((x) => x.id === id)
    if (!q) return
    if (get().hydrated) {
      // The deal Finance sees is derived from the accepted quotation on every load (adaptDeal).
      return get()._quotation(id, {
        label: `quote:${id}`,
        path: 'accept',
        toast: { title: 'Deal sent to Finance', body: `${q.client} \u2014 ${q.eventType}: ready for down-payment confirmation`, kind: 'finance' },
      })
    }
    const contractValue = qValue(q)
    // The quotation now carries a phased schedule rather than a single DP
    // percentage. stagesFor() reads an older quote's `dpPercent` as a two-stage
    // schedule, so nothing needs migrating.
    const schedule = resolveSchedule(stagesFor(q), contractValue, {
      signingDate: appToday(),
      eventDate: q.eventDate,
    })
    const firstStage = schedule[0]
    const deal = {
      id: `DEAL-${q.id}`,
      client: q.client,
      name: `${q.client} ${q.eventType}`,
      contractValue,
      // Kept for every screen that still speaks in terms of "the DP": it is
      // simply the first stage of the schedule.
      dpPercent: firstStage ? Math.round(firstStage.percent * 100) / 100 : 0,
      dpAmount: firstStage ? firstStage.amount : 0,
      dpSchedule: schedule,
      projectIdOnConfirm: q.projectId,
      eventDate: q.eventDate,
      estimatedCost: qCost(q) || Math.round(contractValue * 0.7),
    }
    // Accepting makes this quote THE pending deal Finance will confirm.
    set((s) => ({
      quotations: s.quotations.map((x) => (x.id === id ? { ...x, status: 'Accepted' } : x)),
      // Appended, id-scoped. Replacing an existing entry for the same quotation keeps
      // re-accepting idempotent; every other deal is left alone, which is the fix.
      deals: [...s.deals.filter((d) => d.id !== deal.id), { ...deal, confirmed: false }],
    }))
    pushToast({ title: 'MoU / Contract generated', body: `${q.client} — ${q.eventType}`, kind: 'project' })
    setTimeout(() => pushToast({
      title: 'Deal sent to Finance',
      body: schedule.length > 1
        ? `${schedule.length}-stage billing schedule ready for down-payment confirmation`
        : 'Ready for down-payment confirmation',
      kind: 'finance',
    }), 800)
  },

  // ============================================================
  // WAREHOUSE — dual-logic stock control.
  // ============================================================

  // Send a fixed asset out to a job. Creates the in-transit state the deck's
  // [Check-Out / Ship] button describes, tagged to a real Project ID and event
  // date rather than a free-text location string.
  checkOutAsset: (id, projectId, eventDate) => {
    const { pushToast, inventory, projects } = get()
    const item = inventory.find((it) => it.id === id)
    if (!item || item.status !== 'in_stock') return
    if (get().hydrated) {
      const proj = projects.find((p) => p.id === projectId)
      if (!item.uuid || !proj?.uuid) return get()._notSaved(`${id} or ${projectId} (it only exists in this browser)`)
      return get().mutate({
        label: `stock:${id}`,
        call: () => api.post(`/inventory/${item.uuid}/check-out`, { projectId: proj.uuid, eventDate }),
        refresh: ['inventory'],
        toast: { title: 'Equipment checked out', body: `${item.item} \u2192 ${proj.name || projectId}`, kind: 'project' },
      })
    }
    set((s) => ({
      inventory: s.inventory.map((it) =>
        it.id === id ? { ...it, status: 'in_transit', projectId, eventDate, checkedIn: false } : it
      ),
    }))
    const proj = projects.find((p) => p.id === projectId)
    pushToast({
      title: 'Equipment checked out',
      body: `${item.item} → ${proj?.name || projectId}`,
      kind: 'project',
    })
  },

  // Return a fixed asset after the event, splitting the quantity by condition.
  //
  // `breakdown` is { good, damaged, lost } quantities. Good returns to main
  // stock, damaged is routed to maintenance, and lost / total damage is written
  // off AND posts an Asset Loss Expense entry at unitValue x qty — the
  // accounting integration the deck asked for by name (slide 9).
  checkInAsset: (id, breakdown) => {
    const { pushToast, inventory, postEntry } = get()
    const item = inventory.find((it) => it.id === id)
    if (!item) return

    const good = Math.max(0, Number(breakdown?.good) || 0)
    const damaged = Math.max(0, Number(breakdown?.damaged) || 0)
    const lost = Math.max(0, Number(breakdown?.lost) || 0)
    if (good + damaged + lost <= 0) return
    if (get().hydrated) {
      if (!item.uuid) return get()._notSaved(`${id} (it only exists in this browser)`)
      return get().mutate({
        label: `stock:${id}`,
        call: () => api.post(`/inventory/${item.uuid}/return`, returnBody(breakdown, item.projectUuid)),
        refresh: ['inventory', 'fixedAssets', 'journal'],
        toast: { title: 'Equipment checked in', body: `${item.item} \u00b7 ${good} good, ${damaged} to maintenance, ${lost} written off`, kind: 'project' },
      })
    }

    const projectId = item.projectId
    const nextId = (suffix) => `${item.id}-${suffix}${++splitSeq}`

    // The returning quantity is split into up to three rows so each condition
    // can carry its own status. The original row keeps whatever came back good.
    const rows = []
    if (good > 0) {
      rows.push({ ...item, qty: good, status: 'in_stock', projectId: null, eventDate: null, checkedIn: true })
    }
    if (damaged > 0) {
      rows.push({
        ...item, id: nextId('M'), qty: damaged, status: 'maintenance',
        projectId: null, eventDate: null, checkedIn: true,
      })
    }
    if (lost > 0) {
      rows.push({
        ...item, id: nextId('W'), qty: lost, status: 'written_off',
        projectId: null, eventDate: null, checkedIn: true,
      })
    }

    set((s) => ({
      inventory: s.inventory.flatMap((it) => (it.id === id ? rows : [it])),
    }))

    pushToast({
      title: 'Equipment checked in',
      body: `${item.item} · ${good} good, ${damaged} to maintenance, ${lost} written off`,
      kind: 'project',
    })

    if (lost > 0) {
      const lossValue = lost * (item.unitValue || 0)
      const assetAccount = item.type === 'Consumable' ? '1301' : '1302'
      if (lossValue > 0) {
        // If this stock is on the fixed-asset register, part of its cost has
        // already been depreciated — so the write-off has to remove that share
        // of accumulated depreciation as well, and only the REMAINING book
        // value is a loss. Before the register existed the full cost was
        // expensed, which overstated the loss on any asset part-way through its
        // life and left the register claiming equipment the ledger had removed.
        const accumShare = get()._writeDownRegisteredAsset(item.id, lossValue)
        const bookLoss = lossValue - accumShare

        const lines = []
        if (bookLoss > 0) {
          lines.push({ account: '6901', debit: bookLoss, credit: 0, note: 'Net book value lost on return' })
        }
        if (accumShare > 0) {
          lines.push({ account: '1303', debit: accumShare, credit: 0, note: 'Accumulated depreciation removed with the asset' })
        }
        lines.push({ account: assetAccount, debit: 0, credit: lossValue, note: 'Asset removed from stock at cost' })

        const entry = postEntry({
          memo: `Asset write-off — ${item.item} (${lost} ${item.unit})`,
          project: projectId,
          source: { kind: 'warehouse', ref: item.id },
          lines,
        })
        setTimeout(() => pushToast({
          title: '⚠ Asset Loss Expense posted',
          body: `${entry.id} · ${lost} × ${item.item} written off`,
          kind: 'redflag',
        }), 700)
      }
    }
  },

  // Release consumables to a project.
  //
  // The screen's own subtitle promised "consumables reduce stock permanently",
  // and the seed ledger contains such an entry, but there was no action to
  // perform one — only fixed assets had check-out/check-in. Half of a
  // "dual-logic warehouse" was therefore not operable.
  //
  // Consumables do not come back, so this reduces stock and expenses the value
  // in one step rather than routing through an in-transit state.
  releaseConsumable: (id, qty, projectId) => {
    const { inventory, pushToast, postEntry, projects } = get()
    const item = inventory.find((it) => it.id === id)
    if (!item || item.type !== 'Consumable') return false
    const amount = Math.max(0, Math.floor(Number(qty) || 0))
    if (amount <= 0 || amount > item.qty) return false
    if (get().hydrated) {
      const proj = projects.find((p) => p.id === projectId)
      return get().mutate({
        label: `stock:${id}`,
        call: () => api.post(`/inventory/${item.uuid}/release`, { qty: String(amount), projectId: proj?.uuid ?? null }),
        refresh: ['inventory', 'journal'],
        toast: { title: 'Consumables released', body: `${amount} ${item.unit} ${item.item} \u2192 ${proj?.name || projectId || 'site'}`, kind: 'project' },
      })
    }

    set((s) => ({
      inventory: s.inventory.map((it) =>
        it.id === id ? { ...it, qty: it.qty - amount } : it
      ),
    }))

    const value = amount * (item.unitValue || 0)
    if (value > 0) {
      postEntry({
        memo: `Consumables released — ${item.item} (${amount} ${item.unit})`,
        project: projectId || null,
        source: { kind: 'warehouse', ref: item.id },
        lines: [
          { account: '5104', debit: value, credit: 0, note: 'Consumables issued to site' },
          { account: '1301', debit: 0, credit: value, note: 'Stock permanently reduced' },
        ],
      })
    }

    const proj = projects.find((p) => p.id === projectId)
    pushToast({
      title: 'Consumables released',
      body: `${amount} ${item.unit} ${item.item} → ${proj?.name || projectId || 'site'}`,
      kind: 'project',
    })
    return true
  },

  // Resolve stock sitting in maintenance.
  //
  // The condition split on check-in could route items to maintenance but never
  // out again, so anything damaged was stranded there. Repaired kit returns to
  // stock; kit that cannot be repaired is condemned, which is a write-off and
  // posts the same Asset Loss Expense a lost item does.
  resolveMaintenance: (id, outcome) => {
    const { inventory, pushToast, postEntry } = get()
    const item = inventory.find((it) => it.id === id)
    if (!item || item.status !== 'maintenance') return false
    if (get().hydrated) {
      if (outcome !== 'repaired' && outcome !== 'condemned') return false
      return get().mutate({
        label: `stock:${id}`,
        call: () => api.post(`/inventory/${item.uuid}/${outcome === 'repaired' ? 'repair' : 'condemn'}`),
        refresh: ['inventory', 'fixedAssets', 'journal'],
        toast: outcome === 'repaired'
          ? { title: 'Repaired and back in stock', body: `${item.qty} ${item.unit} ${item.item}`, kind: 'project' }
          : { title: 'Condemned', body: `${item.item} written off`, kind: 'redflag' },
      })
    }

    if (outcome === 'repaired') {
      set((s) => ({
        inventory: s.inventory.map((it) =>
          it.id === id ? { ...it, status: 'in_stock', checkedIn: true } : it
        ),
      }))
      pushToast({
        title: 'Repaired and back in stock',
        body: `${item.qty} ${item.unit} ${item.item}`,
        kind: 'project',
      })
      return true
    }

    if (outcome === 'condemned') {
      set((s) => ({
        inventory: s.inventory.map((it) =>
          it.id === id ? { ...it, status: 'written_off' } : it
        ),
      }))
      const value = item.qty * (item.unitValue || 0)
      if (value > 0) {
        const assetAccount = item.type === 'Consumable' ? '1301' : '1302'
        const entry = postEntry({
          memo: `Condemned after repair attempt — ${item.item} (${item.qty} ${item.unit})`,
          project: null,
          source: { kind: 'warehouse', ref: item.id },
          lines: [
            { account: '6901', debit: value, credit: 0, note: 'Beyond economic repair' },
            { account: assetAccount, debit: 0, credit: value, note: 'Asset removed from stock' },
          ],
        })
        pushToast({
          title: '⚠ Condemned · Asset Loss Expense posted',
          body: `${entry.id} · ${item.item}`,
          kind: 'redflag',
        })
      } else {
        pushToast({ title: 'Condemned', body: item.item, kind: 'redflag' })
      }
      return true
    }

    return false
  },

  addInventoryItem: (draft) => {
    const { pushToast, inventory } = get()
    if (get().hydrated) {
      return get().mutate({
        label: 'stock:new',
        call: () => api.post('/inventory', {
          item: String(draft.item || '').trim(),
          type: draft.type,
          qty: String(Number(draft.qty) || 0),
          unit: draft.unit || null,
          unitValue: String(Number(draft.unitValue) || 0),
        }),
        refresh: ['inventory'],
        toast: { title: 'Stock item added', body: `${draft.item} \u00b7 ${draft.qty} ${draft.unit}`, kind: 'project' },
      })
    }
    const seq = inventory.length + 1
    const item = {
      id: `IT-${String(seq).padStart(2, '0')}`,
      status: 'in_stock',
      projectId: null,
      eventDate: null,
      ...draft,
    }
    set((s) => ({ inventory: [...s.inventory, item] }))
    pushToast({ title: 'Stock item added', body: `${item.item} · ${item.qty} ${item.unit}`, kind: 'project' })
    return item
  },

  // Edit a stock item. Name and unit always; value and type only while the item has no history (the
  // server says why when it does). Quantity is not editable: it moves only through a movement.
  updateInventoryItem: (id, changes) => {
    const item = get().inventory.find((it) => it.id === id)
    if (!get().hydrated || !item?.uuid) return get()._notSaved(`${item?.item || id}`)
    const body = {}
    if (changes.item !== undefined) body.item = String(changes.item).trim()
    if (changes.unit !== undefined) body.unit = changes.unit === '' ? null : changes.unit
    if (changes.unitValue !== undefined) body.unitValue = String(Number(changes.unitValue) || 0)
    if (changes.type !== undefined) body.type = changes.type
    return get().mutate({
      label: `stock:edit:${id}`,
      call: () => api.patch(`/inventory/${item.uuid}`, body),
      refresh: ['inventory'],
      toast: { title: 'Stock item updated', body: body.item || item.item, kind: 'project' },
    })
  },

  // Archive hides an item that has history; delete is only for one that was never used.
  archiveInventoryItem: (id) => {
    const item = get().inventory.find((it) => it.id === id)
    if (!get().hydrated || !item?.uuid) return get()._notSaved(`${item?.item || id}`)
    return get().mutate({
      label: `stock:archive:${id}`,
      call: () => api.post(`/inventory/${item.uuid}/archive`),
      refresh: ['inventory'],
      toast: { title: 'Stock item archived', body: item.item, kind: 'project' },
    })
  },
  restoreInventoryItem: (uuid, name) => get().mutate({
    label: `stock:restore:${uuid}`,
    call: () => api.post(`/inventory/${uuid}/unarchive`),
    refresh: ['inventory'],
    toast: { title: 'Stock item restored', body: name, kind: 'project' },
  }),
  deleteInventoryItem: (id) => {
    const item = get().inventory.find((it) => it.id === id)
    if (!get().hydrated || !item?.uuid) return get()._notSaved(`${item?.item || id}`)
    return get().mutate({
      label: `stock:delete:${id}`,
      call: () => api.delete(`/inventory/${item.uuid}`),
      refresh: ['inventory'],
      toast: { title: 'Stock item deleted', body: item.item, kind: 'project' },
    })
  },

  // Delivery Order lifecycle: Draft -> Dispatched -> Received.
  // Draft a delivery order (a document: it does not move stock). Signed in it is saved on the server.
  createDeliveryOrder: (draft) => {
    const { pushToast } = get()
    if (get().hydrated) {
      const { body, error } = deliveryBody(draft, { projects: get().projects, inventory: get().inventory })
      if (error) {
        pushToast({ title: 'Cannot draft that order', body: error, kind: 'redflag' })
        return Promise.resolve({ ok: false })
      }
      return get().mutate({
        label: 'do:new',
        call: () => api.post('/delivery-orders', body),
        refresh: ['deliveryOrders'],
        toast: { title: 'Delivery order drafted', body: draft.project, kind: 'pipeline' },
      })
    }
    const lines = (draft.lines || []).filter((l) => Number(l.qty) > 0 && (l.itemId || String(l.item || '').trim()))
    if (!lines.length) return null
    const n = 2203 + get().deliveryOrders.length
    const order = {
      id: `DO-${n}`, project: draft.project, status: 'Draft', signed: false, date: appToday(),
      eventDate: draft.eventDate || null,
      lines: lines.map((l, i) => ({ itemId: l.itemId || `line-${i + 1}`, item: l.item, qty: Number(l.qty) })),
    }
    set((st) => ({ deliveryOrders: [...st.deliveryOrders, order] }))
    pushToast({ title: 'Delivery order drafted', body: `${order.id} \u00b7 ${order.project}`, kind: 'pipeline' })
    return order
  },

  // Dispatch with the recipient's drawn signature: the PNG is stored first, then the order moves on.
  // One write from the person's side; if the picture is refused, nothing is dispatched.
  dispatchDeliveryOrder: (id, { blob, name }) => {
    const order = get().deliveryOrders.find((d) => d.id === id)
    if (!get().hydrated || !order?.uuid) return get()._notSaved(`${id} (it only exists in this browser)`)
    return get().mutate({
      label: `do:${id}`,
      call: async () => {
        const form = new FormData()
        form.append('signed_by_name', name)
        form.append('file', blob, 'signature.png')
        await api.uploadPut(`/delivery-orders/${order.uuid}/signature`, form)
        return api.post(`/delivery-orders/${order.uuid}/advance`)
      },
      refresh: ['deliveryOrders'],
      toast: { title: 'Delivery order dispatched', body: `${id} · ${order.project}`, kind: 'pipeline' },
    })
  },

  advanceDeliveryOrder: (id) => {
    const { deliveryOrders, pushToast } = get()
    if (get().hydrated) {
      const order = deliveryOrders.find((d) => d.id === id)
      if (!order?.uuid) return get()._notSaved(`${id} (it only exists in this browser)`)
      return get().mutate({
        label: `do:${id}`,
        call: () => api.post(`/delivery-orders/${order.uuid}/advance`),
        refresh: ['deliveryOrders'],
        toast: { title: order.status === 'Draft' ? 'Delivery order dispatched' : 'Delivery order received', body: `${id} \u00b7 ${order.project}`, kind: 'pipeline' },
      })
    }
    const order = deliveryOrders.find((d) => d.id === id)
    if (!order) return
    const next = order.status === 'Draft' ? 'Dispatched' : order.status === 'Dispatched' ? 'Received' : null
    if (!next) return
    set((s) => ({
      deliveryOrders: s.deliveryOrders.map((d) =>
        d.id === id ? { ...d, status: next, signed: next !== 'Draft' } : d
      ),
    }))
    pushToast({ title: `Delivery order ${next.toLowerCase()}`, body: `${id} · ${order.project}`, kind: 'pipeline' })
  },

  // ============================================================
  // PETTY CASH
  // ============================================================

  // Replenish the operational float from the main bank account. Previously the
  // float was a constant that could only ever decrease.
  topUpPettyCash: (amount) => {
    const { postEntry, pushToast } = get()
    const value = Number(amount) || 0
    if (value <= 0) return
    if (get().hydrated) {
      return get().mutate({
        label: 'petty:topup',
        call: () => api.post('/petty-cash/top-up', { amount: String(value) }),
        refresh: ['pettyCash', 'journal'],
        toast: { title: 'Petty cash topped up', body: 'float replenished', kind: 'finance' },
      })
    }
    set((s) => ({ pettyCashTopUps: s.pettyCashTopUps + value }))
    const entry = postEntry({
      memo: 'Petty cash top-up from main bank',
      source: { kind: 'pettycash', ref: 'TOPUP' },
      lines: [
        { account: '1103', debit: value, credit: 0, note: 'Float replenished' },
        { account: '1101', debit: 0, credit: value, note: 'Transferred from main bank' },
      ],
    })
    pushToast({ title: 'Petty cash topped up', body: `${entry.id} · float replenished`, kind: 'finance' })
  },

  // Approve / reject / pay a procurement request, posting on disbursement.
  setProcurementStatus: (id, status) => {
    const { procurement, pushToast, postEntry } = get()
    const req = procurement.find((r) => r.id === id)
    if (!req) return
    if (get().hydrated) {
      if (!req.uuid) return get()._notSaved(`${id} (it only exists in this browser)`)
      return get().mutate({
        label: `proc:${id}`,
        call: () => api.post(`/procurement-requests/${req.uuid}/transition`, { status }),
        refresh: ['procurement', 'pettyCash', 'journal'],
        toast: { title: `Request ${status.toLowerCase()}`, body: `${id} · ${req.category}`, kind: 'finance' },
      })
    }
    set((s) => ({ procurement: s.procurement.map((r) => (r.id === id ? { ...r, status } : r)) }))
    pushToast({ title: `Request ${status.toLowerCase()}`, body: `${id} · ${req.category}`, kind: 'finance' })

    if (status === 'Disbursed') {
      const fromPetty = /petty|cash advance/i.test(req.category)
      const entry = postEntry({
        memo: `${req.category} disbursed — ${req.id}`,
        project: req.project,
        source: { kind: 'pettycash', ref: req.id },
        lines: [
          { account: fromPetty ? '5103' : '5101', debit: req.amount, credit: 0, note: `${req.category} — requested by ${req.by}` },
          { account: fromPetty ? '1103' : '1101', debit: 0, credit: req.amount, note: fromPetty ? 'Paid from petty cash' : 'Bank transfer' },
        ],
      })
      setTimeout(() => pushToast({
        title: 'Ledger updated',
        body: `${entry.id} posted · ${fromPetty ? 'petty cash' : 'bank'} reduced`,
        kind: 'finance',
      }), 600)
    }
  },

  // Record what was actually spent against a cash advance and settle the
  // difference — return the excess or reimburse the shortfall.
  settleAdvance: (id, actual, receipts = []) => {
    const { procurement, pushToast, postEntry } = get()
    const req = procurement.find((r) => r.id === id)
    if (!req) return
    const spent = Number(actual) || 0
    const variance = req.amount - spent // positive = money to return
    if (get().hydrated) {
      if (!req.uuid) return get()._notSaved(`${id} (it only exists in this browser)`)
      // Receipts are real files now: the server wants at least one stored attachment.
      const files = (receipts || []).filter((f) => typeof f !== 'string')
      if (!files.length) {
        get().pushToast({
          title: 'Attach a receipt',
          body: 'Choose at least one receipt file; the server will not settle an advance on a name alone.',
          kind: 'redflag',
        })
        return Promise.resolve({ ok: false })
      }
      return get().mutate({
        label: `proc:${id}`,
        call: async () => {
          const ids = []
          for (const file of files) {
            const form = new FormData()
            form.append('file', file)
            ids.push((await api.upload('/attachments', form)).id)
          }
          return api.post(`/procurement-requests/${req.uuid}/settle`, { actual: String(spent), attachmentIds: ids })
        },
        refresh: ['procurement', 'pettyCash', 'journal'],
        toast: { title: 'Expense report filed', body: `${id} settled`, kind: 'finance' },
      })
    }

    set((s) => ({
      procurement: s.procurement.map((r) =>
        r.id === id
          ? {
            ...r,
            status: 'Completed',
            proof: true,
            // Filenames only — the prototype holds no bytes. Recording which
            // receipts were filed is still worth more than a bare boolean.
            receipts: (receipts || []).map((f) => String(f).trim()).filter(Boolean),
            actual: spent,
            variance,
            settledAt: appToday(),
          }
          : r
      ),
    }))

    if (Math.abs(variance) > 0) {
      const returning = variance > 0
      const value = Math.abs(variance)
      postEntry({
        memo: returning
          ? `Unused advance returned — ${req.id}`
          : `Advance shortfall reimbursed — ${req.id}`,
        project: req.project,
        // `settlement` routes this to the RM (Reimbursement) voucher series —
        // a cash-advance settlement is a reimbursement whichever way it moves.
        source: { kind: 'pettycash', ref: req.id, settlement: true },
        lines: returning
          ? [
            { account: '1103', debit: value, credit: 0, note: 'Excess cash returned to float' },
            { account: '5103', debit: 0, credit: value, note: 'Cost reduced to actual spend' },
          ]
          : [
            { account: '5103', debit: value, credit: 0, note: 'Additional spend claimed' },
            { account: '1103', debit: 0, credit: value, note: 'Reimbursed from float' },
          ],
      })
    }

    pushToast({
      title: 'Expense report filed',
      body: variance === 0
        ? `${req.id} settled exactly`
        : variance > 0
          ? `${req.id} · returning excess`
          : `${req.id} · reimbursing shortfall`,
      kind: 'finance',
    })
  },

  addProcurementRequest: (draft) => {
    const { procurement, pushToast, role } = get()

    // "Adding a mandatory Requester Name input attribute ... eliminates
    // anonymous transactions in petty cash recording." The field existed on the
    // row and was displayed, but it was hardcoded to one name and the form had
    // no input for it — so every request was attributed to the same person.
    // Naming someone and leaving it blank is not the same as not being asked:
    // an explicit empty value is a mistake and is refused, while an omitted one
    // falls back to whoever is signed in.
    const named = draft ? Object.prototype.hasOwnProperty.call(draft, 'by') : false
    const requester = named
      ? String(draft.by || '').trim()
      : (ROLES[role]?.name || '')
    if (!requester) {
      pushToast({
        title: 'Requester is required',
        body: 'Petty cash cannot be issued anonymously — name who is asking for it.',
        kind: 'redflag',
      })
      return null
    }

    if (get().hydrated) {
      const { body, error } = procurementBody(draft, { projects: get().projects, requester: named ? requester : null })
      if (error) {
        pushToast({ title: 'Cannot submit that request', body: error, kind: 'redflag' })
        return Promise.resolve({ ok: false })
      }
      return get().mutate({
        label: 'proc:new',
        // The form promises "submitted straight to Pending", but the server opens a request as a Draft:
        // submit it in the same action, or it sits in Draft with no Approve button until somebody notices.
        call: async () => {
          const made = await api.post('/procurement-requests', body)
          return api.post(`/procurement-requests/${made.id}/transition`, { status: 'Pending' })
        },
        refresh: ['procurement'],
        toast: { title: 'Request submitted', body: `${requester} · awaiting approval`, kind: 'finance' },
      })
    }
    const seq = 105 + procurement.length
    const req = {
      id: `PR-${seq}`,
      status: 'Pending',
      proof: false,
      date: appToday(),
      ...draft,
      by: requester,
    }
    set((s) => ({ procurement: [req, ...s.procurement] }))
    pushToast({ title: 'Request submitted', body: `${req.id} · ${requester} · awaiting approval`, kind: 'finance' })
    return req
  },

  // Client survey portal submits a rating -> reuses the feedback machinery.
  submitSurvey: (projectId, score) => {
    const { projects, crew, pushToast } = get()
    const project = projects.find((p) => p.id === projectId)
    if (!project) return
    if (get().hydrated) {
      if (!project.uuid) return get()._notSaved(`${projectId} (it only exists in this browser)`)
      return get().mutate({
        label: `survey:${projectId}`,
        call: () => api.put(`/projects/${project.uuid}/feedback`, { score: String(score) }),
        refresh: ['incentives'],
        toast: { title: `Survey submitted \u00b7 ${Number(score).toFixed(1)}/10`, body: `${project.name} \u00b7 crew incentives updated`, kind: 'feedback' },
      })
    }
    const pool = crew.reduce((a, c) => a + Math.round(c.baseRate * (score / 10)), 0)
    set({ latestFeedback: { projectId, name: project.name, client: project.client, score, pool }, incentivesPaid: false })
    pushToast({ title: `Survey submitted · ${score.toFixed(1)}/10`, body: `${project.name} · crew incentives updated`, kind: 'feedback' })
    setTimeout(() => pushToast({ title: 'Crew incentives recalculated', body: 'Performance bonuses updated from client rating', kind: 'payroll' }), 800)
  },

  // ============================================================
  // AUTOMATION #3 — Budgeting red-flag. Logging an unplanned cost
  // pushes a category over its ceiling and fires an over-budget alarm.
  // ============================================================
  addUnplannedCost: (amount = 22_000_000) => {
    const { pushToast, budgetFlagged, postEntry, budget } = get()
    if (get().hydrated) return get()._notSaved('Logging an unplanned cost (budgets are per project on the server and have no screen yet)')
    if (budgetFlagged) return
    set((s) => ({
      budget: {
        ...s.budget,
        categories: s.budget.categories.map((c) =>
          c.key === 'vendors' ? { ...c, realized: c.realized + amount } : c
        ),
      },
      budgetFlagged: true,
    }))
    postEntry({
      memo: 'Unplanned vendor cost',
      project: budget.project,
      source: { kind: 'po', ref: 'UNPLANNED' },
      lines: [
        { account: '5101', debit: amount, credit: 0, note: 'Unplanned vendor spend' },
        { account: '2102', debit: 0, credit: amount, note: 'Vendor payable raised' },
      ],
    })
    pushToast({ title: 'Unplanned cost logged', body: `Vendors +${(amount / 1_000_000).toFixed(0)} M`, kind: 'finance' })
    setTimeout(() => pushToast({
      title: '⚠ Budget red-flag',
      body: 'Vendors category exceeded its ceiling — CEO + PM notified',
      kind: 'redflag',
    }), 800)
  },

  // ============================================================
  // AUTOMATED CRON — daily scheduler. Scans clients for
  // birthdays/milestones and prepares reminders for the Sales team.
  // ============================================================
  runCron: () => {
    const { clients, pushToast, cronRan } = get()
    if (get().hydrated) return get()._notSaved('The daily-jobs screen (it shows demo reminders; the real jobs run on the server)')
    if (cronRan) return
    pushToast({ title: 'Cron running…', body: `Scanning ${clients.length} client records · next 7 days`, kind: 'cron' })

    setTimeout(() => {
      // The rule: notify Sales 7 days before a client milestone. These are the
      // records whose milestone falls exactly on the 7-day horizon.
      const matches = [
        {
          clientId: 'CL-01', client: 'Aurora Bank', contact: 'Ibu Ratna',
          event: 'Birthday', date: '28 Jul 2026', inDays: 2, channel: 'WhatsApp + Email',
          whatsapp: 'Selamat pagi Ibu Ratna 🌸 Dari seluruh keluarga besar Oscenia Events, kami ingin lebih dulu mengucapkan Selamat Ulang Tahun. Terima kasih atas kepercayaan Anda — semoga tahun ini penuh kesuksesan untuk Aurora Bank. Hangat, Tim Oscenia.',
          emailSubject: 'Warmest birthday wishes from Oscenia Events',
          emailBody: 'Dear Ibu Ratna,\n\nOn behalf of everyone at Oscenia Events, we wanted to be among the first to wish you a very happy birthday. It has been our privilege to partner with Aurora Bank on your flagship events.\n\nWishing you a wonderful celebration and a year of continued success.\n\nWarm regards,\nDinda A.\nOscenia Events',
        },
        {
          clientId: 'CL-02', client: 'TechNusa', contact: 'Pak Aditya',
          event: 'Birthday', date: '02 Aug 2026', inDays: 7, channel: 'WhatsApp + Email',
          whatsapp: 'Selamat pagi Pak Aditya! 🎉 Dari seluruh tim Oscenia Events, kami ingin lebih dulu mengucapkan Selamat Ulang Tahun. Terima kasih atas kerja sama yang luar biasa selama ini. Semoga sukses selalu untuk Anda dan TechNusa. Salam hangat, Oscenia.',
          emailSubject: 'Warmest birthday wishes from Oscenia Events',
          emailBody: 'Dear Pak Aditya,\n\nAhead of your birthday, all of us at Oscenia Events would like to wish you a wonderful day and a great year ahead.\n\nThank you for the trust you place in us to bring TechNusa’s conferences and launches to life.\n\nWarm regards,\nR. Hartono\nOscenia Events',
        },
      ]
      set({ reminders: matches, cronRan: true })
      pushToast({
        title: 'Cron: 2 milestones in the next 7 days',
        body: 'Reminder drafts prepared & queued for the Sales team',
        kind: 'cron',
      })
    }, 1000)
  },

  // ============================================================
  // PURCHASE ORDERS (phase 4)
  //
  // Lifecycle: Draft -> Approved -> DP Paid -> Settled, or Cancelled.
  // Approving is a commitment and posts nothing; it locks the value as budget
  // and reserves the kit in the vendor's catalogue for the event window.
  // Paying the DP and settling the balance each post to the ledger, withholding
  // PPh 23 at that vendor's own rate and tagging the cost to the Project ID.
  // ============================================================
  createPurchaseOrder: (draft) => {
    const { purchaseOrders, vendors, pushToast } = get()
    const vendor = vendors.find((v) => v.id === draft.vendorId)
    if (get().hydrated) {
      const { body, error } = poBody(draft, {
        vendor,
        project: get().projects.find((p) => p.id === draft.project),
        catalogue: get().vendorCatalogue,
      })
      if (error) {
        pushToast({ title: 'Cannot raise that order', body: error, kind: 'redflag' })
        return Promise.resolve({ ok: false })
      }
      return get().mutate({
        label: 'po:new',
        call: () => api.post('/purchase-orders', body),
        refresh: ['purchaseOrders'],
        toast: { title: 'Purchase order drafted', body: vendor?.name ?? draft.vendorId, kind: 'project' },
      })
    }
    const seq = 3001 + purchaseOrders.length
    const po = {
      id: `PO-${seq}`,
      status: 'Draft',
      date: appToday(),
      terms: draft.terms || vendor?.terms || { dpPercent: 50, settlementDays: 14 },
      dpPaidAt: null,
      settledAt: null,
      ...draft,
    }
    set((s) => ({ purchaseOrders: [po, ...s.purchaseOrders] }))
    pushToast({ title: 'Purchase order drafted', body: `${po.id} — ${vendor?.name ?? po.vendorId}`, kind: 'project' })
    return po
  },

  // --- purchase orders: API when live, local demo behaviour when not ----------
  //
  // Each action below opens with `if (get().hydrated) return get()._po(...)`. The branch is
  // deliberate and explicit rather than hidden: on real data the server owns the posting
  // rules — a commitment is not a debt, a variance posts before the settlement, payments
  // reverse before the bill — and reimplementing those in the client is how the two drift.
  // Off the API, the local path keeps the in-memory demo working and keeps
  // `verify-flows.mjs` testing something the app actually does.
  _po: (id, { label, path, body, toast, refresh }) => {
    const po = get().purchaseOrders.find((p) => p.id === id)
    if (!po?.uuid) {
      get().pushToast({
        title: 'Cannot reach that order',
        body: `${id} has no server key, so it only exists in this browser session.`,
        kind: 'redflag',
      })
      return Promise.resolve({ ok: false })
    }
    return get().mutate({
      label,
      call: () => api.post(`/purchase-orders/${po.uuid}/${path}`, body),
      // `journal` pulls projects (realised cost is derived from it) and clients, so a
      // posting action refreshes everything it actually moved.
      refresh: refresh ?? ['purchaseOrders', 'journal'],
      toast,
    })
  },

  approvePurchaseOrder: (id) => {
    if (get().hydrated) {
      return get()._po(id, {
        label: 'po:approve',
        path: 'approve',
        // Approving posts nothing, but it does reserve catalogue stock for the window.
        refresh: ['purchaseOrders', 'vendorCatalogue'],
        toast: { title: 'Purchase order approved', body: `${id} committed, kit reserved`, kind: 'finance' },
      })
    }
    const { purchaseOrders, vendors, pushToast, _reserveCatalogue } = get()
    const po = purchaseOrders.find((p) => p.id === id)
    if (!po || po.status !== 'Draft') return
    set((s) => ({
      purchaseOrders: s.purchaseOrders.map((p) => (p.id === id ? { ...p, status: 'Approved' } : p)),
    }))
    _reserveCatalogue(po)
    // Approving does NOT raise a payable. A purchase order is a commitment, not
    // a debt: nothing is owed until the vendor has delivered and invoiced, and
    // booking the cost here would recognise it a month or more before the
    // revenue it was incurred to earn. The commitment is still visible — the
    // budget screen tracks it through committedByProject — and the bill is
    // raised by _ensureBillRaised at the first payment or at settlement.
    const vendor = vendors.find((v) => v.id === po.vendorId)
    pushToast({
      title: 'Purchase order approved',
      body: `${po.id} — ${vendor?.name ?? ''} · ${money(poTotal(po))} committed, kit reserved`,
      kind: 'finance',
    })
  },

  // The journal entry that recognises a purchase order as a debt, raising it if
  // it does not exist yet.
  //
  // Idempotent on purpose: seed purchase orders predate the AP cycle and a
  // legacy order can reach settlement without ever having been billed. Rather
  // than leave those unsettleable, the bill is raised at whichever point the
  // order first needs a payable to clear.
  // The bill entry for a purchase order, if one has been raised.
  //
  // `appliedTo` is the discriminator: a variance adjustment also carries
  // source.kind 'po' and also credits 2102, so matching on those alone could
  // return the adjustment instead of the bill — and every caller would then be
  // reasoning about the wrong document.
  _billFor: (poId) => {
    const { journal } = get()
    return journal.find(
      (e) => e.source?.kind === 'po'
        && e.source?.ref === poId
        && !e.reversedBy
        && !e.reversalOf
        && !(e.appliedTo || []).length
        && (e.lines || []).some((l) => l.account === '2102' && (Number(l.credit) || 0) > 0)
    ) || null
  },

  // `date` is the received date of an edited payment that raises it (round 4); omitted, today.
  _ensureBillRaised: (po, { date = null } = {}) => {
    const { vendors, postEntry, _billFor } = get()
    const existing = _billFor(po.id)
    if (existing) return existing

    const vendor = vendors.find((v) => v.id === po.vendorId)
    if (poTotal(po) <= 0) return null

    const bill = vendorBillEntry(po, vendor)
    return postEntry({
      ...(date ? { date } : {}),
      memo: bill.memo,
      project: bill.project,
      source: bill.source,
      series: bill.series,
      lines: bill.lines,
    })
  },

  // Pay an open vendor bill from the Accounts Payable screen.
  //
  // Works for a purchase-order bill and for an overhead invoice that never had
  // a PO — both are just entries crediting 2102, so both settle the same way.
  // Where a purchase order IS behind the bill, its status follows the money:
  // that synchronisation is the "payment status updates synchronously" the
  // client asked for, and it previously did not exist because a purchase order
  // never created a payable to track.
  //
  // `taxAmount` overrides the computed withholding and `edited` is the posting pop-up's version
  // of the payment (round 4), exactly as on receivePayment.
  payVendorBill: (billEntryId, {
    amount, date = appToday(), cashAccount = '1101', withhold = true, taxAmount = null, edited = null,
  } = {}) => {
    const { journal, vendors, taxConfig, pushToast, postEntry, purchaseOrders } = get()
    const bill = journal.find((e) => e.id === billEntryId)
    if (!bill) return null

    // Live: POST /bills/{entry uuid}/payments. The server keeps the purchase order in step, so
    // orders are re-read with the journal.
    if (get().hydrated) {
      if (!bill.uuid) {
        const error = new Error(`${bill.id} has no server key, so it only exists in this browser session.`)
        pushToast({ title: 'Cannot reach that bill', body: error.message, kind: 'redflag' })
        return Promise.resolve({ ok: false, error })
      }
      const gross = Math.round(Number(amount) || 0)
      return get().mutate({
        label: `ap:pay:${bill.id}`,
        call: () => api.post(
          `/bills/${bill.uuid}/payments`,
          paymentBody(gross, edited, { date: null, cashAccount, withhold, taxAmount }),
        ),
        refresh: ['journal', 'purchaseOrders'],
        toast: { title: 'Vendor payment recorded', body: `${bill.source?.ref || bill.id} · ${money(gross)}`, kind: 'finance' },
      })
    }

    const item = openItems(journal, { control: '2102', side: 'credit' })
      .find((o) => o.entry.id === billEntryId)
    if (!item || item.outstanding <= 0) {
      pushToast({ title: 'Nothing outstanding', body: `${bill.source?.ref || bill.id} is already settled`, kind: 'redflag' })
      return null
    }

    const gross = Math.min(Math.round(Number(amount) || 0), item.outstanding)
    if (gross <= 0) {
      pushToast({ title: 'Nothing to post', body: 'Enter an amount greater than zero.', kind: 'redflag' })
      return null
    }

    const vendor = vendors.find((v) => v.name === bill.source?.vendor)
    const plan = planPayBill(
      { bill, outstanding: item.outstanding, vendor, taxConfig },
      edited ? { amount: gross, ...editedInputs(edited) } : { amount: gross, date, cashAccount, withhold, taxAmount },
    )
    if (!plan.editable) {
      pushToast({ title: 'Tax exceeds the payment', body: 'Withholding cannot be larger than the amount paid.', kind: 'redflag' })
      return null
    }
    const posting = edited ? get()._editedPosting(plan, edited) : null
    if (edited && !posting) return null
    const mv = plan.editable
    const postedOn = posting ? posting.date : mv.date

    const entry = postEntry({
      date: postedOn,
      memo: posting ? posting.memo : mv.memo,
      project: bill.project,
      source: withDocumentDate(mv.source, posting),
      appliedTo: [billEntryId],
      lines: posting ? posting.lines : mv.lines,
    })

    // What posted, not what was planned: an edit may have moved the 2105 line.
    const tax = postedWithholding(entry.lines, 'vendor')
    // Keep the purchase order in step with what has actually been paid.
    const settled = gross >= item.outstanding - 1
    const po = purchaseOrders.find((p) => p.id === bill.source?.ref)
    if (po && po.status !== 'Cancelled' && po.status !== 'Settled') {
      set((s) => ({
        purchaseOrders: s.purchaseOrders.map((p) => (p.id !== po.id ? p : {
          ...p,
          status: settled ? 'Settled' : 'DP Paid',
          dpPaidAt: p.dpPaidAt || postedOn,
          settledAt: settled ? postedOn : p.settledAt,
        })),
      }))
    }

    pushToast({
      title: settled ? 'Vendor bill settled' : 'Part payment recorded',
      body: `${bill.source?.ref || bill.id} · ${money(gross)}${tax ? ` (${money(gross - tax)} cash, ${money(tax)} PPh 23)` : ''} · ${entry.voucherNo}`,
      kind: 'finance',
    })
    return entry
  },

  // What is still owed on a purchase order, straight from the ledger.
  poOutstanding: (poId) => {
    const { journal, _billFor } = get()
    const bill = _billFor(poId)
    if (!bill) return 0
    const item = openItems(journal, { control: '2102', side: 'credit' })
      .find((o) => o.entry.id === bill.id)
    return item ? item.outstanding : 0
  },

  // Reserve each line against the event window so the same kit cannot be
  // promised to two projects on overlapping dates.
  _reserveCatalogue: (po) => {
    const window = eventWindow(po.eventDate)
    if (!window.from) return
    set((s) => ({
      vendorCatalogue: s.vendorCatalogue.map((item) => {
        const line = (po.lines || []).find((l) => l.itemId === item.id)
        if (!line) return item
        const already = (item.bookings || []).some((b) => b.poId === po.id)
        if (already) return item
        return {
          ...item,
          bookings: [
            ...(item.bookings || []),
            { from: window.from, to: window.to, projectId: po.project, qty: Number(line.qty) || 0, poId: po.id },
          ],
        }
      }),
    }))
  },

  _releaseCatalogue: (poId) => {
    set((s) => ({
      vendorCatalogue: s.vendorCatalogue.map((item) => ({
        ...item,
        bookings: (item.bookings || []).filter((b) => b.poId !== poId),
      })),
    }))
  },

  // Shared posting for both PO payments. `portion` is what is being paid now.
  //
  // The cost was already recognised when the bill was raised, so a payment
  // clears the PAYABLE — it does not expense anything a second time. Cash
  // leaves net of the withholding Oscenia deducts on the vendor's behalf, and
  // that tax stays as a liability owed to the tax office.
  //
  // `posting` is an edited payment from the pop-up (see _editedPosting): its received date,
  // receipt date, memo and lines replace the computed ones.
  _payVendor: (po, portion, memo, posting = null) => {
    const { vendors, postEntry, taxConfig, _ensureBillRaised } = get()
    const vendor = vendors.find((v) => v.id === po.vendorId)
    // Per-vendor rate overrides the company default — Bloom & Co is registered
    // under a different withholding classification, for instance.
    const rate = vendor?.pph23Rate ?? taxConfig.pph23?.rate ?? 0
    const active = taxConfig.pph23?.active !== false
    const tax = active ? Math.round(portion * (rate / 100)) : 0
    const bill = _ensureBillRaised(po, { date: posting?.date })

    const lines = posting?.lines
      || vendorPaymentLines({ gross: portion, tax, rate, cashAccount: '1101', settleNote: `Payable settled — ${po.id}` })

    return postEntry({
      ...(posting ? { date: posting.date } : {}),
      memo: posting?.memo || memo,
      project: po.project,
      source: withDocumentDate({ kind: 'payment', ref: bill?.id || po.id }, posting),
      appliedTo: bill ? [bill.id] : [],
      lines,
    })
  },

  // `edited` is the posting pop-up's version of the payment (round 4). Live, it goes to the
  // server as the pay-dp body (payment only -- the bill it raises is never edited).
  payPoDownPayment: (id, { edited = null } = {}) => {
    if (get().hydrated) {
      return get()._po(id, {
        label: 'po:pay-dp',
        path: 'pay-dp',
        body: edited ? payDpBody(edited) : undefined,
        toast: { title: 'Down payment paid', body: `${id} posted at the vendor's PPh 23 rate`, kind: 'finance' },
      })
    }
    const { purchaseOrders, pushToast, _payVendor, vendors, taxConfig, _billFor } = get()
    const po = purchaseOrders.find((p) => p.id === id)
    if (!po || po.status !== 'Approved') {
      // Both of these guards used to `return` in silence, which is indistinguishable from a
      // dead button — and is part of what the client reported. The screen now routes a
      // zero-DP order straight to settlement so the second case should be unreachable from
      // the UI, but it is reachable from anywhere else that calls this.
      pushToast({
        title: 'Nothing to pay',
        body: po
          ? `${po.id} is ${po.status}, and a down payment can only be made on an approved order.`
          : `Purchase order ${id} no longer exists.`,
        kind: 'redflag',
      })
      return
    }
    const dp = poDpAmount(po)
    if (dp <= 0) {
      pushToast({
        title: 'No down payment on this order',
        body: `${po.id} is on ${po.terms?.dpPercent ?? 0}% terms, so there is nothing to pay up front — settle the balance instead.`,
        kind: 'redflag',
      })
      return
    }
    let posting = null
    if (edited) {
      const plan = planPayPoDp(
        { po, vendor: vendors.find((v) => v.id === po.vendorId), taxConfig, bill: _billFor(po.id) },
        editedInputs(edited),
      )
      posting = get()._editedPosting(plan, edited)
      if (!posting) return
    }
    set((s) => ({
      purchaseOrders: s.purchaseOrders.map((p) =>
        p.id === id ? { ...p, status: 'DP Paid', dpPaidAt: posting?.date || appToday() } : p
      ),
    }))
    const entry = _payVendor(po, dp, `Vendor DP — ${po.id}`, posting)
    pushToast({
      title: `DP paid · ${po.terms.dpPercent}%`,
      body: `${entry.id} posted · ${po.id}`,
      kind: 'finance',
    })
  },

  // Settle a purchase order against the vendor's ACTUAL final amount.
  //
  // This used to pay exactly the remaining balance, which made the committed
  // total a self-fulfilling prophecy: actual could never differ from budget, so
  // there was never a variance to report. Slide 8 asks for exactly that
  // variance, so the actual has to be an input rather than an assumption.
  //
  // `actualTotal` is the whole PO's real value. Omit it to settle at the
  // committed amount, which is the common case.
  /**
   * Settle against the vendor's final invoice.
   *
   * `invoiceDate` is the date the VENDOR dated their invoice. It changes nothing about when
   * the settlement posts -- a bill that arrives in October for September work still posts in
   * October, and the period-close trigger would refuse September anyway. It is recorded so
   * month end can reconcile the two, which is the AP half of the client's dual-date ask.
   */
  //
  // `edited` is the posting pop-up's version (round 4): its received date posts every entry of
  // the settlement, its receipt date is the vendor's invoice date, and its lines replace the
  // final payment's. Live, the same goes to the server (`invoice_date` = the receipt date).
  settlePurchaseOrder: (id, actualTotal, { invoiceDate = null, edited = null } = {}) => {
    if (get().hydrated) {
      return get()._po(id, {
        label: 'po:settle',
        path: 'settle',
        // An omitted actual means "settle exactly at the committed amount", which is what
        // the server defaults to as well.
        body: settleBody(actualTotal, { invoiceDate, edited }),
        toast: { title: 'Purchase order settled', body: `${id} settled against the vendor's final invoice`, kind: 'finance' },
      })
    }
    const { purchaseOrders, pushToast, _payVendor, _refundVendor, _ensureBillRaised, postEntry, vendors, taxConfig } = get()
    const po = purchaseOrders.find((p) => p.id === id)
    // An order with no down payment never reaches 'DP Paid' — payPoDownPayment
    // has nothing to pay and returns early — so requiring that status left
    // every zero-DP order stuck on Approved with no route to settlement. That
    // was the reported AP bug.
    if (!po || (po.status !== 'DP Paid' && po.status !== 'Approved')) return false

    let posting = null
    if (edited) {
      const plan = planSettlePo(
        {
          po, vendor: vendors.find((v) => v.id === po.vendorId), taxConfig,
          bill: get()._billFor(po.id), billOutstanding: get().poOutstanding(po.id),
        },
        { ...editedInputs(edited), actualTotal },
      )
      posting = get()._editedPosting(plan, edited)
      if (!posting) return false
    }
    const on = posting ? { date: posting.date } : {}

    const bill = _ensureBillRaised(po, on)
    const committed = poTotal(po)
    const actual = actualTotal == null ? committed : Math.max(0, Number(actualTotal) || 0)
    const variance = committed - actual

    // The bill was raised at the committed amount. If the vendor's actual
    // invoice differs, both the cost and the debt have to move before the
    // balance is settled — otherwise the variance would be buried in the
    // payment and the project's cost would be wrong.
    if (variance !== 0 && bill) {
      const adj = varianceEntry(po, variance)
      postEntry({
        ...on,
        memo: adj.memo,
        project: adj.project,
        source: adj.source,
        series: adj.series,
        appliedTo: [bill.id],
        lines: adj.lines,
      })
    }

    // Whatever the payable still shows is what is left to pay.
    const remaining = get().poOutstanding(po.id)

    set((s) => ({
      purchaseOrders: s.purchaseOrders.map((p) =>
        p.id === id
          ? {
            ...p,
            status: 'Settled',
            settledAt: posting?.date || appToday(),
            actualTotal: actual,
            invoiceDate: (posting ? posting.documentDate : invoiceDate) || p.invoiceDate || null,
          }
          : p
      ),
    }))

    if (remaining > 0) {
      _payVendor(po, remaining, `Vendor final settlement — ${po.id}`, posting)
    } else if (remaining < 0) {
      // More was advanced than the vendor's actual invoice, so the money comes
      // back. Real, and previously impossible to express.
      _refundVendor(po, -remaining, `Vendor refund of overpaid DP — ${po.id}`)
    }

    pushToast({
      title: 'Purchase order settled',
      body: variance === 0
        ? `${po.id} · settled at the committed amount`
        : variance > 0
          ? `${po.id} · ${money(variance)} under budget`
          : `${po.id} · ${money(-variance)} over budget`,
      kind: variance < 0 ? 'redflag' : 'finance',
    })
    return true
  },

  // Money coming back from a vendor who was overpaid: cash in, the payable
  // restored to zero, withholding unwound. The COST is not touched here — the
  // variance adjustment in settlePurchaseOrder already moved it.
  _refundVendor: (po, amount, memo) => {
    const { vendors, postEntry, taxConfig } = get()
    const vendor = vendors.find((v) => v.id === po.vendorId)
    const rate = vendor?.pph23Rate ?? taxConfig.pph23?.rate ?? 0
    const active = taxConfig.pph23?.active !== false
    const tax = active ? Math.round(amount * (rate / 100)) : 0
    const bill = get()._billFor(po.id)
    const lines = [
      { account: '1101', debit: amount - tax, credit: 0, note: 'Refund received from vendor' },
    ]
    if (tax) lines.push({ account: '2105', debit: tax, credit: 0, note: `PPh 23 reversed @ ${rate}%` })
    lines.push({ account: '2102', debit: 0, credit: amount, note: 'Overpaid balance restored' })
    return postEntry({
      memo,
      project: po.project,
      source: { kind: 'payment', ref: bill?.id || po.id },
      appliedTo: bill ? [bill.id] : [],
      lines,
    })
  },

  // Cancelling releases the reservation and reverses anything already paid.
  cancelPurchaseOrder: (id) => {
    if (get().hydrated) {
      return get()._po(id, {
        label: 'po:cancel',
        path: 'cancel',
        refresh: ['purchaseOrders', 'journal', 'vendorCatalogue'],
        toast: { title: 'Purchase order cancelled', body: `${id} · payments reversed, kit released`, kind: 'redflag' },
      })
    }
    const { purchaseOrders, journal, pushToast, reverseJournalEntry, _releaseCatalogue } = get()
    const po = purchaseOrders.find((p) => p.id === id)
    if (!po || po.status === 'Cancelled' || po.status === 'Settled') return
    // Bills carry source.kind 'po'; the payments that settle them carry
    // 'payment' and point at the bill. Filtering on 'po' alone would reverse
    // the debt but leave the cash payment standing.
    const billIds = journal
      .filter((e) => e.source?.kind === 'po' && e.source.ref === po.id)
      .map((e) => e.id)
    journal
      .filter((e) => !e.reversedBy && !e.reversalOf)
      .filter((e) => billIds.includes(e.id) || (e.appliedTo || []).some((r) => billIds.includes(r)))
      // Payments first, so a bill is never left reversed with a live payment
      // still applied against it.
      .sort((a, b) => (billIds.includes(a.id) ? 1 : 0) - (billIds.includes(b.id) ? 1 : 0))
      .forEach((e) => reverseJournalEntry(e.id, { silent: true }))
    _releaseCatalogue(po.id)
    set((s) => ({
      purchaseOrders: s.purchaseOrders.map((p) => (p.id === id ? { ...p, status: 'Cancelled' } : p)),
    }))
    pushToast({ title: 'Purchase order cancelled', body: `${po.id} · payments reversed, kit released`, kind: 'redflag' })
  },

  // ============================================================
  // PROPOSAL / MoU TEMPLATES
  // ============================================================
  addMouTemplate: (draft) => {
    const { mouTemplates, pushToast } = get()
    const label = String(draft?.label || '').trim()
    if (!label) return null
    let id = slugifyTag(label)
    if (!id) return null
    // Distinct templates may reasonably share a label; suffix rather than
    // silently merging them the way tags do, because a template carries
    // contract text that must not be collapsed by accident.
    if (mouTemplates.some((t) => t.id === id)) {
      let n = 2
      while (mouTemplates.some((t) => t.id === `${id}-${n}`)) n += 1
      id = `${id}-${n}`
    }
    const tpl = {
      id,
      label,
      heading: draft.heading || 'MEMORANDUM OF UNDERSTANDING',
      validity: draft.validity || 'Quotation valid for 30 days from issue.',
      clauses: draft.clauses ? [...draft.clauses] : [],
      signatory: draft.signatory || 'Authorised Signatory',
    }
    if (get().hydrated) {
      // Resolves to the saved template (so the manager can select it), or null if it was refused.
      return get()
        .mutate({
          label: 'mou:new',
          call: () => api.post('/mou-templates', tpl),
          refresh: ['mouTemplates'],
          toast: { title: 'Template created', body: tpl.label, kind: 'project' },
        })
        .then((r) => (r.ok ? get().mouTemplates.find((t) => t.id === tpl.id) ?? null : null))
    }
    set((s) => ({ mouTemplates: [...s.mouTemplates, tpl] }))
    pushToast({ title: 'Template created', body: tpl.label, kind: 'project' })
    return tpl
  },

  // Live: the manager edits a draft and saves it whole (one PATCH, clauses replace-all), so a clause
  // being typed is never a request per keystroke.
  saveMouTemplate: (id, draft) =>
    get().mutate({
      label: `mou:${id}`,
      call: () => api.patch(`/mou-templates/${id}`, {
        label: draft.label,
        heading: draft.heading,
        validity: draft.validity || null,
        signatory: draft.signatory || null,
        clauses: draft.clauses,
      }),
      refresh: ['mouTemplates'],
      toast: { title: 'Template saved', body: draft.label, kind: 'project' },
    }),

  updateMouTemplate: (id, patch) =>
    get().hydrated
      ? get()._notSaved('Editing MoU templates (use Save)')
      : set((s) => ({
      mouTemplates: s.mouTemplates.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    })),

  duplicateMouTemplate: (id) => {
    const { mouTemplates, addMouTemplate } = get()
    const src = mouTemplates.find((t) => t.id === id)
    if (!src) return null
    return addMouTemplate({ ...src, label: `${src.label} (copy)` })
  },

  // Deleting a template has to deal with the quotations pointing at it.
  //
  // Draft and Sent quotations are reassigned to the default, which is a
  // recoverable inconvenience. An ACCEPTED quotation is refused: its MoU has
  // been issued and signed against those exact clauses, and quietly swapping
  // them would rewrite an executed agreement.
  deleteMouTemplate: (id) => {
    const { mouTemplates, quotations, pushToast } = get()
    const tpl = mouTemplates.find((t) => t.id === id)
    if (!tpl) return false
    if (get().hydrated) {
      // The server refuses a template an accepted quotation uses and the last one; Draft/Sent
      // quotations move to the default. Resolves true when it was deleted.
      return get()
        .mutate({
          label: `mou:${id}`,
          call: () => api.delete(`/mou-templates/${id}`),
          refresh: ['mouTemplates', 'quotations'],
          toast: { title: 'Template deleted', body: tpl.label, kind: 'redflag' },
        })
        .then((r) => r.ok)
    }
    if (mouTemplates.length <= 1) {
      pushToast({ title: 'Cannot delete the last template', body: 'At least one template must remain', kind: 'redflag' })
      return false
    }
    const accepted = quotations.filter((q) => q.template === id && q.status === 'Accepted')
    if (accepted.length) {
      pushToast({
        title: 'Template is in use on a signed MoU',
        body: `${accepted.map((q) => q.id).join(', ')} \u2014 delete refused`,
        kind: 'redflag',
      })
      return false
    }
    const fallback = mouTemplates.find((t) => t.id === DEFAULT_TEMPLATE && t.id !== id)
      || mouTemplates.find((t) => t.id !== id)
    const reassigned = quotations.filter((q) => q.template === id).length
    set((s) => ({
      mouTemplates: s.mouTemplates.filter((t) => t.id !== id),
      quotations: s.quotations.map((q) => (q.template === id ? { ...q, template: fallback.id } : q)),
    }))
    pushToast({
      title: 'Template deleted',
      body: reassigned
        ? `${reassigned} quotation(s) moved to ${fallback.label}`
        : tpl.label,
      kind: 'redflag',
    })
    return true
  },

  // Clause editing. Order matters in a contract, so moving is supported.
  setTemplateClause: (id, index, text) =>
    get().hydrated
      ? get()._notSaved('Editing MoU templates')
      : set((s) => ({
      mouTemplates: s.mouTemplates.map((t) =>
        t.id === id ? { ...t, clauses: t.clauses.map((c, i) => (i === index ? text : c)) } : t
      ),
    })),

  addTemplateClause: (id, text = '') =>
    get().hydrated
      ? get()._notSaved('Editing MoU templates')
      : set((s) => ({
      mouTemplates: s.mouTemplates.map((t) =>
        t.id === id ? { ...t, clauses: [...t.clauses, text] } : t
      ),
    })),

  removeTemplateClause: (id, index) =>
    get().hydrated
      ? get()._notSaved('Editing MoU templates')
      : set((s) => ({
      mouTemplates: s.mouTemplates.map((t) =>
        t.id === id ? { ...t, clauses: t.clauses.filter((_, i) => i !== index) } : t
      ),
    })),

  moveTemplateClause: (id, index, delta) =>
    get().hydrated
      ? get()._notSaved('Editing MoU templates')
      : set((s) => ({
      mouTemplates: s.mouTemplates.map((t) => {
        if (t.id !== id) return t
        const next = [...t.clauses]
        const to = index + delta
        if (to < 0 || to >= next.length) return t
        const [row] = next.splice(index, 1)
        next.splice(to, 0, row)
        return { ...t, clauses: next }
      }),
    })),

  // ============================================================
  // TAGS
  //
  // A single vocabulary the user owns, applied to vendors and catalogue items,
  // so vendors can be found by capability rather than only by the one category
  // string they used to carry.
  // ============================================================
  addTag: (label) => {
    const { tags, pushToast } = get()
    const id = slugifyTag(label)
    if (!id) return null
    const existing = tags.find((t) => t.id === id)
    // Typing an existing tag resolves to it rather than creating a duplicate
    // that merely looks different.
    if (existing) return existing
    const tag = { id, label: String(label).trim() }
    if (get().hydrated) {
      // Resolves to the tag once it is saved, so a caller that goes on to apply it (the vendor
      // form does) is never pointing at a tag the server has not heard of.
      return get()
        .mutate({
          label: 'tag:new',
          call: () => api.post('/tags', tag),
          refresh: ['tags'],
          toast: { title: 'Tag created', body: tag.label, kind: 'project' },
        })
        .then((r) => (r.ok ? tag : null))
    }
    set((s) => ({ tags: [...s.tags, tag] }))
    pushToast({ title: 'Tag created', body: tag.label, kind: 'project' })
    return tag
  },

  renameTag: (id, label) => {
    const trimmed = String(label || '').trim()
    if (!trimmed) return
    if (get().hydrated) {
      return get().mutate({
        label: `tag:${id}`,
        call: () => api.patch(`/tags/${id}`, { label: trimmed }),
        refresh: ['tags'],
        toast: { title: 'Tag renamed', body: trimmed, kind: 'project' },
      })
    }
    set((s) => ({ tags: s.tags.map((t) => (t.id === id ? { ...t, label: trimmed } : t)) }))
  },

  // Deleting a tag has to remove it everywhere it was applied, otherwise
  // vendors keep pointing at a tag that no longer exists.
  deleteTag: (id) => {
    const { tags, pushToast } = get()
    const tag = tags.find((t) => t.id === id)
    if (!tag) return
    if (get().hydrated) {
      return get().mutate({
        label: `tag:${id}`,
        call: () => api.delete(`/tags/${id}`),
        refresh: ['tags', 'vendors', 'vendorCatalogue'],
        toast: { title: 'Tag deleted', body: `${tag.label} removed everywhere it was applied`, kind: 'redflag' },
      })
    }
    set((s) => ({
      tags: s.tags.filter((t) => t.id !== id),
      vendors: s.vendors.map((v) => ({ ...v, tags: (v.tags || []).filter((t) => t !== id) })),
      vendorCatalogue: s.vendorCatalogue.map((i) => ({ ...i, tags: (i.tags || []).filter((t) => t !== id) })),
    }))
    pushToast({ title: 'Tag deleted', body: `${tag.label} removed everywhere it was applied`, kind: 'redflag' })
  },

  toggleVendorTag: (vendorId, tagId) => {
    const v = get().vendors.find((x) => x.id === vendorId)
    if (get().hydrated && v) {
      const own = (v.tags || []).map((t) => (typeof t === 'string' ? t : t.id))
      return get().setVendorTags(vendorId, own.includes(tagId) ? own.filter((t) => t !== tagId) : [...own, tagId])
    }
    return set((s) => ({
      vendors: s.vendors.map((v) => {
        if (v.id !== vendorId) return v
        const own = v.tags || []
        return { ...v, tags: own.includes(tagId) ? own.filter((t) => t !== tagId) : [...own, tagId] }
      }),
    }))
  },

  setVendorTags: (vendorId, tagIds) => {
    const vendor = get().vendors.find((v) => v.id === vendorId)
    if (get().hydrated && vendor?.uuid) {
      return get().mutate({
        label: `vendor:tags:${vendorId}`,
        call: () => api.patch(`/vendors/${vendor.uuid}`, { tags: [...tagIds] }),
        refresh: ['vendors'],
        toast: { title: 'Vendor tags updated', body: vendor.name, kind: 'project' },
      })
    }
    return set((s) => ({
      vendors: s.vendors.map((v) => (v.id === vendorId ? { ...v, tags: [...tagIds] } : v)),
    }))
  },

  // A new catalogue line for a vendor. Without this nothing could be put on a purchase order on a
  // real database, which starts with an empty catalogue.
  addCatalogueItem: (draft) => {
    const { vendors, vendorCatalogue, pushToast } = get()
    const vendor = vendors.find((v) => v.id === draft.vendorId)
    if (!vendor) return null
    const price = Math.max(0, Number(draft.unitPrice) || 0)
    const stock = Math.max(0, Number(draft.stock) || 0)
    if (get().hydrated) {
      if (!vendor.uuid) return get()._notSaved(`${vendor.id} (it only exists in this browser)`)
      return get()
        .mutate({
          label: 'catalogue:new',
          call: () => api.post('/vendor-catalogue', {
            vendorId: vendor.uuid,
            item: draft.item.trim(),
            category: draft.category?.trim() || null,
            subcategory: draft.subcategory?.trim() || null,
            unitPrice: String(price),
            stock: String(stock),
            unit: draft.unit?.trim() || null,
            tags: draft.tags || [],
          }),
          refresh: ['vendorCatalogue'],
          toast: { title: 'Catalogue item added', body: `${draft.item.trim()} · ${vendor.name}`, kind: 'project' },
        })
        .then((r) => r.ok)
    }
    const seq = Math.max(0, ...vendorCatalogue.map((i) => Number(String(i.id).match(/^VI-(\d+)$/)?.[1]) || 0)) + 1
    set((s) => ({
      vendorCatalogue: [...s.vendorCatalogue, {
        id: `VI-${String(seq).padStart(2, '0')}`, item: draft.item.trim(), vendor: vendor.name, vendorId: vendor.id,
        category: draft.category?.trim() || '', subcategory: draft.subcategory?.trim() || '',
        unitPrice: price, stock, unit: draft.unit?.trim() || '', tags: draft.tags || [], bookings: [],
      }],
    }))
    pushToast({ title: 'Catalogue item added', body: `${draft.item.trim()} · ${vendor.name}`, kind: 'project' })
    return true
  },

  toggleCatalogueTag: (itemId, tagId) => {
    const item = get().vendorCatalogue.find((i) => i.id === itemId)
    if (get().hydrated && item) {
      if (!item.uuid) return get()._notSaved(`${itemId} (it only exists in this browser)`)
      const own = (item.tags || []).map((t) => (typeof t === 'string' ? t : t.id))
      return get().mutate({
        label: `catalogue:${itemId}`,
        call: () => api.patch(`/vendor-catalogue/${item.uuid}`, { tags: own.includes(tagId) ? own.filter((t) => t !== tagId) : [...own, tagId] }),
        refresh: ['vendorCatalogue'],
        toast: { title: 'Item tags updated', body: item.item, kind: 'project' },
      })
    }
    return set((s) => ({
      vendorCatalogue: s.vendorCatalogue.map((i) => {
        if (i.id !== itemId) return i
        const own = i.tags || []
        return { ...i, tags: own.includes(tagId) ? own.filter((t) => t !== tagId) : [...own, tagId] }
      }),
    }))
  },

  // --- vendor lifecycle (signed in: the server enforces every rule and says which it broke) ---------------
  vendorLifecycle: {},
  enforceVendorStage: false,
  // When on, a delivery order may be dispatched without the recipient's drawn signature (off by default).
  allowUnsignedDispatch: false,

  /** Move a vendor along the board, hold it, blacklist it or bring it back. Resolves true when saved. */
  changeVendorStage: async (vendor, to, reason = '') => {
    if (!get().hydrated || !vendor?.uuid) { get()._notSaved('Changing a vendor stage'); return false }
    const res = await get().mutate({
      label: `vendor:stage:${vendor.id}`,
      call: () => api.post(`/vendors/${vendor.uuid}/stage`, { stage: to, reason: reason || null }),
      refresh: ['vendorLifecycle', 'vendors'],
      toast: { title: `${vendor.name} · ${to}`, body: reason || 'Vendor stage updated', kind: 'project' },
    })
    return Boolean(res?.ok)
  },

  /** Tick or untick the agreement or the reference check. */
  tickVendorCheck: async (vendor, key, done) => {
    if (!get().hydrated || !vendor?.uuid) { get()._notSaved('Ticking a checklist item'); return false }
    const res = await get().mutate({
      label: `vendor:check:${vendor.id}:${key}`,
      call: () => api.put(`/vendors/${vendor.uuid}/checks/${key}`, { done }),
      refresh: ['vendorLifecycle'],
    })
    return Boolean(res?.ok)
  },

  /** Re-read the lifecycle (a filed agreement ticks the checklist, so the files card calls this). */
  reloadVendorLifecycle: async () => {
    if (!get().hydrated) return
    const { loadSome } = await import('./hydrate.js')
    set(await loadSome(['vendorLifecycle']))
  },

  /** Make purchase orders refuse a vendor that is not Approved or Active (CEO and finance). */
  setEnforceVendorStage: (on) =>
    get().hydrated
      ? get().mutate({
          label: 'settings:enforce-vendor-stage',
          call: () => api.patch('/settings', { enforceVendorStage: Boolean(on) }),
          refresh: ['settings'],
          toast: { title: on ? 'Vendor stage is now enforced' : 'Vendor stage is no longer enforced', body: 'Purchase orders', kind: 'po' },
        })
      : get()._notSaved('Changing this setting'),

  /** Let a delivery order be dispatched without a signature (the people who may change company settings). */
  setAllowUnsignedDispatch: (on) =>
    get().hydrated
      ? get().mutate({
          label: 'settings:allow-unsigned-dispatch',
          call: () => api.patch('/settings', { allowUnsignedDispatch: Boolean(on) }),
          refresh: ['settings'],
          toast: {
            title: on ? 'Unsigned dispatch is now allowed' : 'Dispatch needs a signature again',
            body: 'Delivery orders',
            kind: 'pipeline',
          },
        })
      : get()._notSaved('Changing this setting'),

  // A vendor's PPh 23 rate overrides the company default — small suppliers are
  // registered under different withholding classifications.
  updateVendorRate: (id, rate) => {
    const vendor = get().vendors.find((v) => v.id === id)
    if (get().hydrated && vendor?.uuid) {
      // Gated on `pay_po` server-side deliberately: this rate decides what the company owes
      // the tax office, not merely what it pays the vendor.
      return get().mutate({
        label: `vendor:rate:${id}`,
        call: () => api.patch(`/vendors/${vendor.uuid}`, { pph23Rate: Math.max(0, Number(rate) || 0) }),
        refresh: ['vendors'],
        toast: { title: 'Withholding rate updated', body: `${vendor.name} · PPh 23`, kind: 'finance' },
      })
    }
    return set((st) => ({
      vendors: st.vendors.map((v) =>
        v.id === id ? { ...v, pph23Rate: Math.max(0, Number(rate) || 0) } : v
      ),
    }))
  },

  // Edit a vendor's tax number, bank, person in charge and payment terms. Signed in it is the server's
  // (`PATCH /vendors/{id}`, CEO and Finance: the bank account decides where money goes); signed out it
  // changes this browser's copy only, like every other demo edit.
  updateVendor: (id, patch) => {
    const vendor = get().vendors.find((v) => v.id === id)
    if (!vendor) return Promise.resolve({ ok: false })
    if (get().hydrated) {
      if (!vendor.uuid) return get()._notSaved('Editing this vendor')
      const body = vendorPatchBody(patch)
      if (!Object.keys(body).length) return Promise.resolve({ ok: true })
      return get().mutate({
        label: `vendor:edit:${id}`,
        call: () => api.patch(`/vendors/${vendor.uuid}`, body),
        refresh: ['vendors'],
        toast: { title: 'Vendor updated', body: vendor.name, kind: 'finance' },
      })
    }
    set((st) => ({
      vendors: st.vendors.map((v) => (v.id === id ? {
        ...v,
        npwp: patch.npwp ?? v.npwp,
        bank: { ...v.bank, ...(patch.bank || {}) },
        pic: { ...v.pic, ...(patch.pic || {}) },
        terms: { ...v.terms, ...(patch.terms || {}) },
      } : v)),
    }))
    return Promise.resolve({ ok: true })
  },

  addVendor: (draft) => {
    const { vendors, pushToast } = get()
    if (get().hydrated) {
      // Resolves to the saved vendor (with its server-issued number) so the caller can start it
      // on the vendor board; null when the save was refused.
      return get()
        .mutate({
          label: 'vendor:new',
          call: () => api.post('/vendors', vendorBody(draft)),
          refresh: ['vendors'],
          toast: { title: 'Vendor added', body: draft?.name, kind: 'project' },
        })
        .then((r) => (r.ok ? get().vendors.find((v) => v.uuid === r.data?.id) ?? null : null))
    }
    // One past the highest number in use, not the list length: a gap (or a vendor saved from an
    // earlier session) would otherwise hand out a number that is already taken.
    const seq = Math.max(0, ...vendors.map((v) => Number(String(v.id).match(/^V-(\d+)$/)?.[1]) || 0)) + 1
    const vendor = {
      id: `V-${String(seq).padStart(2, '0')}`,
      score: 0,
      delays: 0,
      pph23Rate: 2,
      attachments: [],
      tags: [],
      terms: { dpPercent: 50, settlementDays: 14 },
      ...draft,
    }
    set((st) => ({ vendors: [...st.vendors, vendor] }))
    pushToast({ title: 'Vendor added', body: vendor.name, kind: 'project' })
    return vendor
  },

  // ============================================================
  // BACK / CANCEL (phase 5)
  //
  // The deck asked for this three times across one slide, in Projects and in
  // Finance. It was deliberately left until the ledger existed: stepping a
  // project backwards has to undo whatever the forward step set off, and
  // cancelling one has to deal with money already taken.
  // ============================================================
  revertStage: (projectId) => {
    const { projects, pushToast } = get()
    const project = projects.find((p) => p.id === projectId)
    if (!project) return
    const idx = STAGES.indexOf(project.stage)
    if (idx <= 0) return
    const previous = STAGES[idx - 1]
    if (get().hydrated) {
      return get()._project(projectId, {
        label: `stage:${projectId}`,
        path: 'revert-stage',
        toast: { title: 'Stage reverted', body: `${projectId} → ${previous}`, kind: 'pipeline' },
      })
    }
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === projectId ? { ...p, stage: previous, stageSince: appToday() } : p
      ),
    }))
    // Stepping back out of Post-Event Feedback discards the client rating, so
    // the crew incentive pool it produced has to go with it. Leaving the pool
    // standing would let a bonus survive the event that justified it.
    const wasFeedback = project.stage === 'Post-Event Feedback' || project.stage === 'Finished'
    if (wasFeedback && get().latestFeedback?.projectId === projectId && !get().incentivesPaid) {
      set({ latestFeedback: null })
      pushToast({ title: 'Client rating withdrawn', body: 'Crew incentive pool cleared', kind: 'payroll' })
    }
    pushToast({ title: 'Stage reverted', body: `${projectId} → ${previous}`, kind: 'pipeline' })
  },

  // Cancel a project.
  //
  // `refundDp` is the refundable / non-refundable choice from slide 2. Refunding
  // reverses the client receipts, which hands the money back and unwinds the
  // revenue. Costs already incurred are NOT reversed either way — they were
  // really spent, and pretending otherwise would flatter the P&L.
  cancelProject: (projectId, { refundDp = false, reason = '' } = {}) => {
    const { projects, journal, purchaseOrders, pushToast, reverseJournalEntry, cancelPurchaseOrder } = get()
    const project = projects.find((p) => p.id === projectId)
    if (!project || project.cancelled) return
    if (get().hydrated) {
      // Live purchase orders go with it and a refund reverses the receipts: all server-side.
      return get()._project(projectId, {
        label: `cancel:${projectId}`,
        path: 'cancel',
        body: { reason, refundDp },
        refresh: ['projects', 'invoices', 'purchaseOrders', 'journal'],
        toast: {
          title: 'Project cancelled',
          body: `${projectId}${refundDp ? ' · down payment refunded' : ' · down payment retained'}`,
          kind: 'redflag',
        },
      })
    }

    let refunded = 0
    if (refundDp) {
      // Refunding a client means unwinding BOTH halves of every receipt: the
      // invoice that raised the receivable AND the payment that cleared it.
      //
      // This used to filter on `source.kind === 'invoice'` alone, which was
      // right when a down payment was a single entry that debited cash. Since
      // the PPh 23 correction it is a pair — the invoice-sourced entry only
      // raises the receivable, and the cash lives in a `payment`-sourced entry.
      // Reversing the invoice half on its own left the client's money in the
      // bank and drove Accounts Receivable negative by the amount refunded.
      const own = journal.filter((e) => e.project === projectId && !e.reversedBy && !e.reversalOf)
      const recognitions = own.filter((e) => e.source?.kind === 'invoice')
      const receipts = own.filter(
        (e) => (e.appliedTo || []).some((ref) => recognitions.some((r) => r.id === ref))
      )

      // Refunded value is what the client actually paid — the receipts. The
      // recognitions are reversed too, but counting both would double it.
      receipts.forEach((e) => { refunded += entryTotal(e) })
      ;[...receipts, ...recognitions].forEach((e) => reverseJournalEntry(e.id, { silent: true }))
    }

    // Live purchase orders on a dead project are cancelled with it.
    purchaseOrders
      .filter((po) => po.project === projectId && po.status !== 'Settled' && po.status !== 'Cancelled')
      .forEach((po) => cancelPurchaseOrder(po.id))

    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === projectId
          ? { ...p, cancelled: true, cancelledAt: appToday(), cancelReason: reason, dpRefunded: refundDp }
          : p
      ),
      invoices: s.invoices.map((i) => {
        if (i.project !== projectId) return i
        // A refunded invoice is no longer collected, so `paid` has to come back
        // to zero or the AR total would keep counting money that went back out.
        if (refundDp) return { ...i, status: 'Cancelled', paid: 0 }
        return i.status === 'Unpaid' || i.status === 'Scheduled' || i.status === 'Partially Paid'
          ? { ...i, status: 'Cancelled' }
          : i
      }),
    }))

    pushToast({ title: 'Project cancelled', body: `${projectId}${reason ? ` · ${reason}` : ''}`, kind: 'redflag' })
    setTimeout(() => pushToast({
      title: refundDp ? 'Down payment refunded' : 'Down payment retained',
      body: refundDp
        ? `${money(refunded)} reversed out of revenue`
        : 'Non-refundable per contract — revenue kept, costs stand',
      kind: 'finance',
    }), 700)
  },

  // Decline or withdraw a quotation before it ever becomes a project.
  cancelQuotation: (id) => {
    const { quotations, pushToast } = get()
    const q = quotations.find((x) => x.id === id)
    if (!q || q.status === 'Declined') return
    if (get().hydrated) {
      return get()._quotation(id, {
        label: `quote:${id}`,
        path: 'decline',
        toast: { title: 'Quotation declined', body: `${q.id} \u2014 ${q.client}`, kind: 'finance' },
      })
    }
    set((s) => ({
      quotations: s.quotations.map((x) => (x.id === id ? { ...x, status: 'Declined' } : x)),
      // If this quote was sitting in Finance awaiting a DP, clear it out.
      deals: s.deals.filter((d) => d.id !== `DEAL-${id}`),
    }))
    pushToast({ title: 'Quotation declined', body: `${q.id} — ${q.client}`, kind: 'finance' })
  },

  // ============================================================
  // BUDGET TOLERANCE (phase 5)
  // ============================================================
  // How far over the locked budget a project may run before the system objects.
  budgetTolerancePct: 10,
  setBudgetTolerance: (pct) =>
    get().hydrated
      ? get().mutate({
          label: 'settings:tolerance',
          call: () => api.patch('/settings', { budgetTolerancePct: String(Math.max(0, Number(pct) || 0)) }),
          refresh: ['settings'],
          toast: { title: 'Budget tolerance updated', body: `${Math.max(0, Number(pct) || 0)}%`, kind: 'finance' },
        })
      : set({ budgetTolerancePct: Math.max(0, Number(pct) || 0) }),

  // ============================================================
  // CRM (phase 6)
  // ============================================================
  addClient: (draft) => {
    const { clients, pushToast } = get()
    if (get().hydrated) {
      return get().mutate({
        label: 'crm:client:new',
        call: () => api.post('/clients', draft),
        refresh: ['clients'],
        toast: { title: 'Client added', body: draft?.name, kind: 'project' },
      })
    }
    // Highest number + 1, not the count: saved demo clients must not collide with a seed
    // client added later.
    const seq = Math.max(0, ...clients.map((c) => Number(String(c.id).slice(3)) || 0)) + 1
    const client = {
      id: `CL-${String(seq).padStart(2, '0')}`,
      prefEvents: [],
      favVendor: '—',
      satisfaction: 0,
      anniversary: '—',
      personalBrand: '—',
      ...draft,
    }
    set((s) => ({ clients: [...s.clients, client] }))
    saveDemoClients(get().clients)
    pushToast({ title: 'Client added', body: client.name, kind: 'project' })
    return client
  },

  /** Back to the seeded vendors (the workspace "Reset demo" also resets these). */
  resetDemoVendors: () => {
    try { localStorage.removeItem(DEMO_VENDORS_KEY) } catch { /* nothing saved */ }
    if (!get().hydrated) set({ vendors: seedVendors })
  },

  /** Back to the seeded clients (the workspace "Reset demo" also resets these). */
  resetDemoClients: () => {
    try { localStorage.removeItem(DEMO_CLIENTS_KEY) } catch { /* nothing saved */ }
    if (!get().hydrated) set({ clients: seedClients })
  },

  updateClient: (id, patch) => {
    const { pushToast, clients } = get()
    const client = clients.find((c) => c.id === id)
    if (get().hydrated && client?.uuid) {
      return get().mutate({
        label: `crm:client:${id}`,
        call: () => api.patch(`/clients/${client.uuid}`, patch),
        refresh: ['clients'],
        toast: { title: 'Client updated', body: client.name, kind: 'project' },
      })
    }
    set((s) => ({ clients: s.clients.map((c) => (c.id === id ? { ...c, ...patch } : c)) }))
    saveDemoClients(get().clients)
    if (client) pushToast({ title: 'Client updated', body: client.name, kind: 'project' })
  },

  /**
   * Fetch one client's notes.
   *
   * Per-client rather than part of `loadAll`: the endpoint is scoped to a client, so
   * hydrating every client's notes up front would be one request per client for data only
   * one screen shows.
   */
  loadInteractions: async (clientId) => {
    const client = get().clients.find((c) => c.id === clientId)
    if (!get().hydrated || !client?.uuid) return
    try {
      const rows = await api.get(`/clients/${client.uuid}/interactions`)
      set((s) => ({
        interactions: { ...s.interactions, [clientId]: (rows || []).map(adaptInteraction) },
      }))
    } catch (err) {
      get().pushToast({
        title: 'Could not load notes',
        body: err?.message || 'The interactions request failed.',
        kind: 'redflag',
      })
    }
  },

  // The "Log interaction" button on the Client 360 had no onClick handler at
  // all. Interactions now live in the store rather than being read straight
  // out of the seed file, so they can actually be added.
  logInteraction: (clientId, entry) => {
    const { pushToast, clients } = get()
    const client = clients.find((c) => c.id === clientId)
    if (get().hydrated && client?.uuid) {
      // The author is taken from the token server-side, never from this payload -- the
      // client asked for notes stamped with who wrote them, and a self-reported author is
      // not that.
      return get()
        .mutate({
          label: `crm:note:${clientId}`,
          call: () =>
            api.post(`/clients/${client.uuid}/interactions`, {
              note: entry?.note,
              type: entry?.type || 'Note',
            }),
          toast: { title: 'Interaction logged', body: `${client.name} · ${entry?.type || 'Note'}`, kind: 'project' },
        })
        .then((res) => {
          if (res.ok) get().loadInteractions(clientId)
          return res
        })
    }
    const record = {
      id: `IN-${clientId}-${++interactionSeq}`,
      date: appToday(),
      // Whoever is actually signed in. This was hardcoded to one salesperson,
      // so every note claimed the same author no matter who wrote it — which
      // defeats the point of recording "the identity of the account staff who
      // inputted it".
      by: ROLES[get().role]?.name || 'Unknown',
      type: 'Note',
      attachments: [],
      ...entry,
    }
    set((s) => ({
      interactions: {
        ...s.interactions,
        [clientId]: [record, ...(s.interactions[clientId] || [])],
      },
    }))
    pushToast({ title: 'Interaction logged', body: `${client?.name ?? clientId} · ${record.type}`, kind: 'project' })
    return record
  },

  // The deck asked for "create, edit, and attach" — create alone was not it.
  updateInteraction: (clientId, noteId, patch) => {
    if (get().hydrated) {
      return get()
        .mutate({
          label: `crm:note:edit:${noteId}`,
          call: () => api.patch(`/interactions/${noteId}`, { note: patch?.note, type: patch?.type }),
          toast: { title: 'Note updated', body: 'The edit is recorded on the note.', kind: 'project' },
        })
        .then((res) => {
          if (res.ok) get().loadInteractions(clientId)
          return res
        })
    }
    const { pushToast } = get()
    let found = false
    set((s) => ({
      interactions: {
        ...s.interactions,
        [clientId]: (s.interactions[clientId] || []).map((it) => {
          if (it.id !== noteId) return it
          found = true
          return { ...it, ...patch, editedAt: appToday() }
        }),
      },
    }))
    if (found) pushToast({ title: 'Note updated', body: clientId, kind: 'project' })
    return found
  },

  // Take a file off a note (the stored file stays: it may be filed against another note).
  detachFromInteraction: (clientId, noteId, fileId) => {
    if (get().hydrated) {
      return get()
        .mutate({
          label: `crm:note:file:${noteId}`,
          call: () => api.delete(`/interactions/${noteId}/attachments/${fileId}`),
          toast: { title: 'File removed from the note', body: 'The stored file is kept.', kind: 'project' },
        })
        .then((res) => {
          if (res.ok) get().loadInteractions(clientId)
          return res
        })
    }
    const own = (get().interactions[clientId] || []).find((it) => it.id === noteId)?.attachments || []
    return get().updateInteraction(clientId, noteId, { attachments: own.filter((f) => f !== fileId) })
  },

  deleteInteraction: (clientId, noteId) => {
    if (get().hydrated) {
      return get()
        .mutate({
          label: `crm:note:delete:${noteId}`,
          call: () => api.delete(`/interactions/${noteId}`),
          toast: { title: 'Note deleted', body: 'Removed from the client timeline.', kind: 'redflag' },
        })
        .then((res) => {
          if (res.ok) get().loadInteractions(clientId)
          return res
        })
    }
    const { pushToast, interactions } = get()
    const exists = (interactions[clientId] || []).some((it) => it.id === noteId)
    if (!exists) return false
    set((s) => ({
      interactions: {
        ...s.interactions,
        [clientId]: (s.interactions[clientId] || []).filter((it) => it.id !== noteId),
      },
    }))
    pushToast({ title: 'Note deleted', body: clientId, kind: 'redflag' })
    return true
  },

  // Attachment names only — the prototype has no file storage, so this records
  // what was attached without pretending to hold the bytes.
  // Signed in this takes a real File: it is uploaded, then filed against the note. In the demo it
  // takes a typed name, as it always did.
  attachToInteraction: (clientId, noteId, fileOrName) => {
    if (get().hydrated) {
      if (typeof File === 'undefined' || !(fileOrName instanceof File)) {
        get().pushToast({ title: 'Choose a file', body: 'Pick the file to attach; a typed name is not saved.', kind: 'redflag' })
        return Promise.resolve({ ok: false })
      }
      return get()
        .mutate({
          label: `crm:note:file:${noteId}`,
          call: async () => {
            const form = new FormData()
            form.append('file', fileOrName)
            const stored = await api.upload('/attachments', form)
            return api.post(`/interactions/${noteId}/attachments`, { attachmentId: stored.id })
          },
          toast: { title: 'File attached', body: fileOrName.name, kind: 'project' },
        })
        .then((res) => {
          if (res.ok) get().loadInteractions(clientId)
          return res
        })
    }
    const filename = fileOrName
    const name = String(filename || '').trim()
    if (!name) return false
    return get().updateInteraction(clientId, noteId, {
      attachments: [
        ...((get().interactions[clientId] || []).find((it) => it.id === noteId)?.attachments || []),
        name,
      ],
    })
  },

}))

// Petty-cash balance: opening float + top-ups − petty disbursements. Derived
// here so Procurement and the Cash screen cannot disagree.
export function pettyCashBalance(state) {
  if (state.hydrated && state.pettyCash) return state.pettyCash.balance
  const spent = state.procurement
    .filter((r) => (r.status === 'Paid' || r.status === 'Disbursed' || r.status === 'Completed') && /petty|cash/i.test(r.category))
    .reduce((a, r) => a + (r.actual != null ? r.actual : r.amount), 0)
  return pettyCashStart + state.pettyCashTopUps - spent
}

// Keep the demo's own vendors across a refresh — added ones, and any later edit to them (tags,
// PPh 23 rate). One subscription instead of a save in every vendor action, so a new action cannot
// forget it. Backend data is never written here.
useStore.subscribe((s, prev) => {
  if (!s.hydrated && s.vendors !== prev.vendors) saveDemoVendors(s.vendors)
})

// The app's "today" follows whether the server's data is loaded (see `appToday` in lib/format.js).
useStore.subscribe((s) => setLiveClock(s.hydrated))
