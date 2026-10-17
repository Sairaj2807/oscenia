# Oscenia ERP — Client Feedback Analysis & Fix Plan

> **Historical record.** Written before the 17 Oct 2026 restructure. Paths and deploy steps below are as they were (`erp-prototype/` is now `erp-frontend/`, `oscenia-web/` is now `website/`, and Vercel is no longer used). Current state: [GO-LIVE-STATUS](./GO-LIVE-STATUS.md).


**Source of feedback:** `oscenia_erp_upgrade_roadmap_presentation.html` (10-slide deck, "System Evaluation & Upgrade Roadmap")
**System under review:** https://oscenia-web.vercel.app/erp
**Code that changes:** `erp-prototype/src/` — this is the real source. The live `/erp` route is a **built copy** in `oscenia-web/public/erp/`. Editing `oscenia-web/src` does nothing for the ERP.
**Analysed:** 24 Aug 2026 · **All phases (0–6) implemented:** 24 Aug 2026

---

## Status at a glance

| Phase | Scope | Status |
|---|---|---|
| **0 — Foundations & credibility fixes** | 2-decimal money, real quotation margin, margin metric, working search, day counters, honest NPAT label | ✅ **Done** (all 6) |
| **1 — Accounting core** | Multi-line double entry, manual/adjusting entries, drill-down, filters, tax engine, auto-posting | ✅ **Done** |
| **2 — Dashboard, cash & AR** | Total Cash module, AR ageing, executive summary, petty cash top-up | ✅ **Done** |
| **3 — Warehouse** | Condition check-in, auto write-off posting, add item + price, real project links, DO lifecycle | ✅ **Done** |
| **4 — Vendor & Purchase Orders** | Vendor NPWP/bank/PIC/attachments, Purchase Orders, catalogue hierarchy, date-aware availability | ✅ **Done** |
| **5 — Project cost control & roles** | Committed budget, over-budget tolerance, PM + Finance roles, action-level permissions, Back/Cancel | ✅ **Done** |
| **6 — Reporting, templates & CRM** | P&L PDF/Excel/CSV export, period comparison, MoU templates, CRM search/add/edit/notes | ✅ **Done** |

**Every item in the plan is now implemented.**

**Verification:** three suites, all passing — `npm run verify` (ledger + flows) and `npm run verify:render`. Details in [Verification](#verification) below.

---

## 0. What the feedback actually is

The deck is **not a bug list**. It is a **feature-expansion brief**. The client clicked through the prototype, accepted the concept, and asked for the *operational depth* a real finance team needs.

Three structural themes ran through all 10 slides, and all three are now addressed:

| Theme | What it meant | Where it landed |
|---|---|---|
| **T1 — Everything must post to the ledger** | The journal was static seed data. DP, vendor payments, petty cash, warehouse write-offs and crew bonuses had to *generate* entries. | `src/lib/ledger.js` + `postEntry()` in the store. The Income Statement, Balance Sheet, Total Cash and AR are now **derived** from the journal. |
| **T2 — Numbers need real precision** | `money()` printed `Rp 192 M`. The deck asked for 2 decimals (`,00`) on margins, bonuses and journal amounts. | `money2()` / `pct2()` in `src/lib/format.js`, adopted across accounting, P&L, payroll and the simulator. |
| **T3 — Every list needs filter + action + reverse** | Filter by Project ID / date / amount, a row action, and a way to undo. | Filters on Accounting, Procurement, Warehouse and AR; row actions throughout; journal reversal. **Stage-level Back/Cancel remains Phase 5.** |

---

## Decisions taken on the open client questions

Rather than block, the defensible default was implemented and flagged. **These are still open to client challenge.**

| Q | Decision | Reasoning |
|---|---|---|
| **#1 Quotation margin** | Sales enters an **estimated cost per line item** alongside the sell price. | A live margin is arithmetically impossible without a cost. Each line now shows its own margin %, and the quotation total shows sell / cost / gross profit / DP. |
| **#2 Journal editing** | **Reverse-and-repost**, not overwrite. The original stays visible marked `Reversed`. | Overwriting a posted entry destroys the audit trail. The client still gets their "click entry code to adjust" button — it posts a reversal plus a correction. |
| **#3 Tax scope** | Configurable engine: **PPh 23 @ 2% active** (as drawn in their mockup), PPh 21 and PPN 11% defined and toggleable, corporate tax @ 22% driving NPAT. | Covers all three without guessing. Rates are editable in the UI, per "fully customizable… manual override". |
| **#4 Finance role** | **A Finance role was added** alongside the PM. | The deck restricts approvals to Finance, and no such role existed — the CEO stood in for it, which left the PM restriction with nothing to restrict against. |
| **#5 Prototype vs backend** | **Stayed in-memory (Zustand).** | Nothing in the deck asks for persistence. **This is the one to revisit** — see [What this still is not](#what-this-still-is-not). |
| **#6 Bonus threshold** | Assumed **7.0 / 10**, shown on screen as a labelled policy value. | Visible rather than buried, so the client can correct the number in one place. |
| **#7 Over-budget tolerance** | **A configurable percentage over the locked budget (default 10%), checked on every cost posting. It warns rather than hard-blocks.** | Refusing to record a cost that has already been incurred would just push the truth out of the system. The threshold is editable on the Budgeting screen. |

---

## Correction to the original analysis

The first version of this document said *"re-base seed cost data so margins are ~30%"*. **That diagnosis was wrong.**

The seed `estimatedCost` figures already yield 30.00% / 32.08% / 29.86% / 31.28% per project. The 60% figure came from the **metric**: the dashboard computed `(pipeline − realizedCost) / pipeline`, mixing early-stage projects (little cost realized yet) with finished ones. A project at "Client Approval" showed a 77% margin simply because it had not spent anything — the formula was measuring *how little have we spent so far*, not profitability.

Fixed the metric, not the data. `projectMargin()` in `src/lib/format.js` uses cost-at-completion (estimate while in flight, actual once `Finished`). **Company weighted margin is now 30.51%.** No seed figures were fudged.

---

## Slide-by-slide

Status key: ✅ done · ⬜ deferred to a later phase

### Slide 1 — Title & Executive Overview

Cover slide. The one real signal was the mini dashboard quoting our own 60% margin back at us — they read it as real. ✅ Fixed via the metric correction above.

### Slide 2 — Module 1 & 2: Dashboard & Proposal / MoU

| Ask | Status | What was done |
|---|---|---|
| Add Total Cash menu | ✅ | New `/cash` route + sidebar entry. Balances of accounts 1101/1102/1103 derived from the ledger, with a running-balance movement log. Dashboard gained a Total Cash stat card and a quick-link. |
| Add AR menu | ✅ | New `/receivables` route with ageing buckets (Current / 1–30 / 31–60 / 60+), reconciled against ledger account 1201 and flagged if it ever diverges. |
| Quick executive summary | ✅ | Per-project health strip on the dashboard with a **budget consumption bar** — realized spend solid, committed-but-unpaid shaded, against the locked ceiling — plus DP received, over-budget, AR overdue, days to event, days in stage and forecast margin. The bar is the "graphical" part the deck asked for. |
| Dynamic proposal/MoU templates | ✅ | Three templates (Corporate / Wedding / Government) each with their own heading, clause set, validity period and signature wording. Selected per quotation and rendered into the generated PDF. |
| Custom DP (auto + manual override) | ✅ | `dpPercent` per quotation, editable in the New Quotation modal, defaulting to 30%. Replaced the hardcoded `* 0.3` in `Quotations.jsx`, `acceptQuotation()` **and** `lib/pdf.js`. |
| Cancellation workflow (refundable vs non-refundable DP) | ✅ | Quotations can be declined outright. Cancelling a *project* asks the refundable question: refunding reverses the client receipts (cash back out, revenue unwound), non-refundable keeps both. Costs already incurred are never reversed either way — they were really spent. |
| **Live calculation margin, 2 decimals** | ✅ | Was `const margin = total ? 30 : 0` — a constant labelled "illustrative target". Now computed from sell minus cost, per line and in total, to 2 decimals. |

### Slide 3 — Module 3 & 4: Project Management & Finance

| Ask | Status | What was done |
|---|---|---|
| Project cost breakdown (Est. vs Realized) | ✅ | Project detail shows budget, realized and variance. Per-vendor cost is now visible through Purchase Orders — each PO carries its vendor, lines, DP and balance, and its payments post against the Project ID. |
| Back / Cancel system | ✅ | A back arrow on every board card steps the project to the previous stage, and reverting out of Post-Event Feedback withdraws the client rating **and** clears the crew incentive pool it produced — leaving the pool standing would let a bonus survive the event that justified it. Project cancellation is a separate dialog (see slide 2). |
| Real-time milestone interaction | ✅ | Already worked; still forward-only. |
| Duration tracking / project day counter | ✅ | `D-42` / `D-day` / `D+10` on board cards, project detail, quotations and warehouse rows, plus "N days in stage" from a new `stageSince` field. |
| Advanced search by Project ID and Amount | ✅ | Topbar search was a decorative `<span>` with no input. Now a real search over projects, clients, invoices, quotations and journal entries, with amount matching (typing `192000000` finds a Rp 192,000,000 invoice within tolerance). Enter opens the top hit. |
| DP payment deadline countdown | ✅ | Finance invoice table gained a countdown column with overdue treatment. |

### Slide 4 — Project P&L & Accounting Core

| Ask | Status | What was done |
|---|---|---|
| Flexible cost composition (project / monthly / custom range) | ✅ | Three modes on the P&L screen. |
| Multi-format export (PDF / Excel / CSV) | ⬜ | Phase 6. |
| High-precision P&L per event | ✅ | Cost lines now come from **real postings** to that Project ID. The old version synthesised them from fixed ratios (`realizedCost * 0.42`), so the statement could never disagree with itself — or be right. Projects with no postings yet show a clearly-labelled indicative split. |
| Filter by Project ID | ✅ | Dropdown driving all three Accounting tabs. |
| Custom date picker (Month / Quarter / YTD / Custom) | ✅ | Period presets plus a custom range. |
| Clickable entry → source document pop-up | ✅ | Journal rows open a drill-down showing metadata, all lines, and the linked invoice / request / delivery order. |
| Edit journal code | ✅ | As reverse-and-repost (decision #2). |

### Slide 5 — Accounting: Journal, P&L, Balance Sheet & Tax

The heaviest slide — it included a mockup of the exact journal screen expected.

| Ask | Status | What was done |
|---|---|---|
| Stacked double-entry form | ✅ | **Structural change.** The journal was one-debit-one-credit-per-row and physically could not represent their 3-line entry. Now `{ id, date, memo, project, source, lines[], reversalOf, reversedBy }`. The DP posting reproduces their mockup exactly: bank debit, PPh 23 credit, revenue credit — with the BALANCED badge. |
| Manual / adjusting journal entry | ✅ | "+ Add Journal Entry" with a live balance check that blocks an unbalanced submit. |
| Period comparison (MoM / YoY) | ⬜ | Phase 6. |
| Profitability simulation upgrade | ✅ | 2-decimal margin and a typed contract-value input alongside the sliders. |
| Customizable tax section | ✅ | Editable rates for PPh 23 / PPh 21 / PPN / corporate, each toggleable. Withholding posts to 2105. |
| Net profit as NPAT | ✅ | The old screen computed a **pre-tax** figure and labelled it "Net Profit". Now Gross Profit → Profit Before Tax → Tax Expense → **NPAT**. Corporate tax is computed live so editing the rate moves NPAT immediately. |

### Slide 6 — CRM & Vendor Management

| Ask | Status | What was done |
|---|---|---|
| CRM search / edit / add client | ✅ | Search across name, contact, phone and email; "+ Add Client"; phone editable **in place** in the table, since that is the field that goes stale most often. |
| Client notes & remarks | ✅ | The "Log interaction" button had no `onClick` at all. Interactions moved out of the seed file into the store, so a note added now persists for the session and appears in the timeline. |
| Event date filter | ✅ | Date-range filter that keeps clients with an event inside the window. |
| Vendor tax / bank / NPWP | ✅ | New Vendor 360 screen (`/vendors/:id`): NPWP, bank name / account / holder, and a **per-vendor PPh 23 rate that overrides the company default** — Bloom & Co is on 1.5%, not 2%. |
| Vendor PO & payment terms | ✅ | Purchase Orders with DP % and settlement days per vendor. See slide 10 notes below. |
| PIC & WhatsApp link | ✅ | PIC name, phone and email, with a `wa.me` deep link on both the vendor index and the detail screen. |
| Vendor attachments | ✅ | Pricelists, catalogues, agreements and certificates listed per vendor (mock links — the prototype has no file storage). |
| Catalog drill-down & hierarchy | ✅ | Two-level hierarchy (5 categories → subcategories) plus an event-type filter, so kit can be matched to the event category as the deck asked. |
| Date & event-based availability | ✅ | **The real one.** `available` used to be a static number, so the same 200 truss segments could be promised to two events on the same weekend. Stock is now a total, bookings carry date ranges, and availability is computed *for a window* — including a load-in/strike buffer around the event date. |

### Slide 7 — Procurement & Petty Cash

Landed early — cheap once the ledger existed.

| Ask | Status | What was done |
|---|---|---|
| DRAFT → PENDING → APPROVED → **DISBURSED** → **COMPLETED** | ✅ | The client explicitly redefined the workflow; ours had 4 stages ending at "Paid". Now 5, with counts per stage. |
| Upload receipt / actual expense report | ✅ | Real expense-report modal capturing actual spend. The old Upload button only flipped a boolean. |
| Auto remaining/shortage adjustment | ✅ | Advance − actual settles automatically: excess returns to the float, shortfall is reimbursed, each posting to the ledger. This is what makes "Completed" mean something. |
| "+ Create New Request" | ✅ | |
| "+ Top Up Petty Cash" | ✅ | Posts petty cash debit / main bank credit. The float previously only ever decreased. |
| Contextual action columns | ✅ | Pending → Approve/Reject; Approved → Pay/Process; Disbursed → Expense report. |
| Multi-filter (Project / Status / Date) | ✅ | Required adding a `date` field to procurement records. |

### Slide 8 — Cost Input Mechanism & PM Access

| Ask | Status | What was done |
|---|---|---|
| Double-check input scheme (locked vendor budget vs realized) | ✅ | Approving a PO **locks its value as committed budget** and posts nothing — commitment and payment are now separate events. Realized cost accrues separately as the DP and balance are actually paid. |
| Automated variance | ✅ | Project detail shows budget vs realized vs variance; the dashboard bar shows realized *and* committed-but-unpaid against the ceiling. Spend that is contractually owed but not yet paid is still gone, so a health read that ignores it is optimistic. |
| Over-budget prevention with tolerance | ✅ | A configurable tolerance (default 10%) checked on **every** cost posting, replacing the demo-only "log unplanned cost" button. Fires once per project rather than on every subsequent posting. |
| PM role | ✅ | Added, plus a **Finance** role the deck implied but never named. PM sees Projects, P&L, Budgeting, Vendors, POs, Procurement and Warehouse — but no company ledger. |
| PM cannot approve cash/journal disbursements | ✅ | **This needed a second permission layer.** `canSee` gates menus, which cannot express the requirement: a PM must *see* Procurement to raise a request while being unable to approve one. `canDo(role, action)` now gates 18 named actions, and blocked buttons render disabled with a tooltip naming the role that can do it — more useful than hiding the control. |

### Slide 9 — Dual-Logic Warehouse Management

| Ask | Status | What was done |
|---|---|---|
| Condition on check-in → Main Stock / Maintenance / Write-off | ✅ | Check-in modal splits the returning quantity by condition and refuses to submit until every unit is accounted for. The old `checkInAsset` returned everything to HQ unconditionally. |
| Lost / total damage auto-posts Asset Loss Expense | ✅ | Posts `6901 Asset Loss Expense` at `unitValue × qty`, credited against inventory. The modal states the amount **before** you commit. |
| "+ Add Item & Price" | ✅ | Plus a new `unitValue` field — needed for write-offs to be real. |
| Event date & Project ID integration | ✅ | Killed the `/in-transit/i` regex against `'In-Transit → Aurora Gala'`. Explicit `status` (`in_stock` / `in_transit` / `maintenance` / `written_off`) with real `projectId` and `eventDate`. |
| Per-row Check-Out / Check-In | ✅ | Check-out requires a real project and carries its event date. |
| DO flow | ✅ | Delivery orders carry line items and move Draft → Dispatched → Received. The PDF manifest now prints real lines instead of a hardcoded sample list. |

### Slide 10 — Crew Incentives & TOP PRIORITY Roadmap

| Ask | Status | What was done |
|---|---|---|
| 2 decimals in BONUS column | ✅ | |
| Minimum threshold | ✅ | 7.0/10 assumed, shown as a labelled policy value, with a count of who missed out. |
| [Approve & Disburse Incentive] | ✅ | |
| Integration with Payroll & General Ledger | ✅ | Disbursement posts 5102 Event COGS — Crew / 1101 Main Bank Cash. |
| Mandatory Project ID tag | ✅ | Bonus cost is allocated to the feedback project, so it lands on the right P&L. Per-crew project assignment remains Phase 6. |

**Their stated priority order was 1. Finance & Accounting → 2. Warehouse → 3. Vendor.** All three are complete.

For priority 3 specifically: date and event-based availability, catalogue hierarchy, tax and direct links, PO and payment terms, and project cost integration — every sub-item on their list.

---

## What was built

### New files

| File | Purpose |
|---|---|
| `src/lib/accounts.js` | Chart of accounts. Codes follow the deck's slide-5 mockup (1101, 2105, 4101…) so the demo matches what they drew. `type` is what lets the statements be derived. |
| `src/lib/ledger.js` | The engine: balance checks, reversal, period filtering, account balances, trial balance, derived Income Statement and Balance Sheet, withholding and corporate tax. |
| `src/lib/format.js` | `money` / `money2` / `pct2`, the fixed `DEMO_TODAY` reference date, day counters, and `projectMargin`. |
| `src/components/Modal.jsx` | Shared modal shell, extracted from the one hand-rolled inside `Quotations.jsx`. Six modals now use it. |
| `src/pages/Cash.jsx` | Total Cash. |
| `src/pages/Receivables.jsx` | AR ageing. |
| `src/lib/vendors.js` | Date-aware availability, event windows, catalogue filtering and PO arithmetic. |
| `src/lib/exports.js` | CSV and Excel export. Hand-rolled — CSV is a handful of escaping rules, and "Excel" is an `.xls` HTML table that Excel and Sheets both open natively. A true `.xlsx` needs a zip writer, which is a library decision to make deliberately. |
| `src/pages/PurchaseOrders.jsx` | PO lifecycle with availability-checked creation. |
| `src/pages/VendorDetail.jsx` | Vendor 360: tax, bank, PIC, attachments, catalogue, POs. |
| `scripts/verify-ledger.mjs` | Asserts the seed ledger's invariants. |
| `scripts/verify-flows.mjs` | Asserts the store actions keep the books balanced. |
| `scripts/smoke.jsx` | Renders every route, three times over. |

### Notable rewrites

`Accounting.jsx` (derived statements, filters, manual entry, drill-down, tax settings), `Warehouse.jsx` (conditions, check-out, DO lifecycle), `Procurement.jsx` (5-stage flow, settlement), `Dashboard.jsx` (metric fix, cash, executive summary), `ProjectPnL.jsx` (real postings, period modes, exports, comparison), `Payroll.jsx` (threshold, disbursement), `Topbar.jsx` (working search), `Vendors.jsx` (catalogue hierarchy, availability), `CRM.jsx` (search, add, inline edit), `ClientDetail.jsx` (working interaction log), `Projects.jsx` (back / cancel), `Quotations.jsx` (live margin, templates, decline), `roles.js` (two-layer RBAC), plus the store, seed, `i18n/dict.js` and `pdf.js`.

### The seed ledger

The old Income Statement and Balance Sheet were hand-authored constants. They are now computed, which makes the seed data load-bearing — so it was designed to reconcile and then verified:

```
Total Assets              1,258,640,000.00
Total Liabilities            45,131,400.00
Total Equity              1,213,508,600.00
Assets − (L + E)                      0.00   ✓

Revenue                   1,010,370,000.00
COGS                        739,000,000.00
Gross Profit                271,370,000.00  (26.86%)
Profit Before Tax           109,370,000.00
Tax Expense (22%)            24,061,400.00
NPAT                         85,308,600.00  (8.44%)
```

Per-project posted costs tie exactly to each project's `realizedCost`; fixed-asset stock (`qty × unitValue`) ties to account 1302; unpaid invoices tie to account 1201.

---

## Verification

```bash
cd erp-prototype
npm run verify          # ledger invariants + store action flows
npm run verify:render   # renders all 20 routes x 3 passes
npm run build
```

**`verify:ledger`** — 40 checks: every entry balances individually, debits = credits, Assets = L + E, cash and petty cash reconcile, AR ties to unpaid invoices, inventory ties to 1302, per-project costs tie to `realizedCost`, margins land at 30.51%, and the balance sheet still balances at 0% / 22% / 40% tax.

**`verify:flows`** — 100+ checks driving the real store actions: accepting a quotation carries its own DP percentage (40%, not the old hardcoded 30%); confirming a DP produces the 3-line entry with PPh 23 withheld and revenue net of tax; a write-off posts Asset Loss Expense at `unitValue × qty`; a top-up moves money without changing total cash; approve → disburse → settle returns the unused advance; incentives post against the project; an adjustment leaves the original flagged and nets only the difference. **The books are re-asserted as balanced after every single action.**

Phases 4–6 added: a PO approval commits without posting and reserves catalogue stock; the DP withholds at the **vendor's** rate rather than the company default; cancelling a PO reverses its payments and releases the reservation; a stage revert cannot run past the first stage; a non-refundable cancellation keeps the revenue while a refundable one reverses it; the over-budget tolerance fires once; and the permission matrix is asserted directly — a PM may request a PO but not approve, pay, post a journal entry or approve cash.

**`verify:render`** — all 22 routes rendered against seed data, again after 30+ mutating actions, again in Bahasa Indonesia, plus all five roles.

### One real bug this caught

`projectCosts()` counted `6901 Asset Loss Expense` as a project cost while the store's `realizedCost` cache counted only COGS accounts. A warehouse write-off silently pushed the two out of step by the loss amount — the P&L and the project board would have disagreed by Rp 10,400,000 with nothing on screen to indicate why. Root cause was duplicated knowledge in two places; fixed with a single shared `isProjectCostAccount()` predicate rather than by patching the second copy.

### Not covered by automation

**Modal bodies only mount on a click, so they were not machine-verified.** These need a browser pass:

- New Quotation — line costs, live margin, DP override
- Add / Adjust Journal Entry — the BALANCED badge and the unbalanced-submit block
- Journal drill-down — source document and Reverse / Adjust
- Warehouse check-out and check-in condition split
- Add Stock Item, Top Up Petty Cash, New Request, Expense Report

Also unverified by machine: visual layout, chart rendering, and mobile widths.

---

## Known gaps

Stated plainly rather than left to be discovered.

1. **Modals are unverified in a browser** (above).
2. **The tax treatment follows the client's mockup, not strict Indonesian practice.** Their slide credits `2105 PPh 23 Payable` on a *receipt*, which is the payer-side treatment; from Oscenia's side, tax withheld by a client is really a prepaid-tax asset. Their mockup was followed deliberately so the demo matches the slide, but it is worth raising.
3. **Revenue recognition is simplified.** DP receipts credit revenue (`4101`) immediately, per their mockup, rather than deferring through Unearned Revenue. Fine for a prototype, wrong for statutory reporting.
4. **`realizedCost` is a denormalised cache.** It is kept in step inside `postEntry`, and the flow tests assert it, but it is still a second copy of a derivable number.
5. **Bundle size is ~1.3 MB.** Fine for a prototype; would want code-splitting for production.
6. **Excel export is an `.xls` HTML table**, not a true `.xlsx`. Opens correctly in Excel and Sheets, but a real xlsx needs a zip writer.
7. **Vendor attachments are mock links.** There is no file storage in the prototype.

## What this still is not

**This remains a click-through prototype with in-memory state.** Refreshing the page resets everything.

The accounting subsystem is now real in structure — real double entry, real derived statements, real tax — but it is real *in Zustand*. **Open question #5 is now the most important one on the list.** Phases 4–6 add breadth (vendors, PO, roles, exports); they do not change that. If this is heading for production, the move to a database and API should happen before more depth is built on seed data, or a good deal of this becomes throwaway.

---

## What is left

Nothing from the feedback deck. Every item across all seven phases is implemented.

What remains is not feature work:

1. **A browser pass over the modals** — they only mount on a click, so no automated check reaches them. Listed above.
2. **The backend decision** (open question #5). This is the substantive one — see below.
3. **Client answers to the seven parked questions.** Seven defaults were chosen and are documented above; any of them may be wrong.

---

## Notes for whoever picks this up

- **Edit `erp-prototype/src/`, then rebuild into `oscenia-web/public/erp/`.** There is no automated copy step:
  ```bash
  cd erp-prototype && npm run verify && npm run build
  rm -rf ../oscenia-web/public/erp/assets
  cp -r dist/assets ../oscenia-web/public/erp/assets
  cp dist/index.html ../oscenia-web/public/erp/index.html
  ```
  The asset filenames are content-hashed, so stale ones must be deleted or they accumulate in git.
- **Run `npm run verify` before committing.** The statements are derived now — a bad posting shows up as a wrong number, not a crash.
- `DEMO_TODAY` in `src/lib/format.js` is a fixed date (2026-07-26), deliberately not `new Date()`. The seed narrative assumes late July 2026 and a live clock would drift the countdowns negative. **Move it forward when the seed data is refreshed.**
- Files in `src/lib/` and `src/store/` use explicit `.js` import extensions so the verify scripts run under plain node. Vite accepts both; keep the extensions.
- Demo-only shortcuts still in place: the hardcoded `_feedbackScores` map, the `addUnplannedCost` demo button, and the P&L ratio fallback for projects with no postings.
- RBAC is two layers now: `canSee(role, module)` for menus and `canDo(role, action)` for actions. When adding a gated control, use `ActionButton` from `components/ui.jsx` — it disables itself and explains why rather than disappearing.
- Catalogue bookings carry a `poId` when they came from a purchase order. Cancelling a PO releases only its own reservations; production holds placed ahead of a PO have no `poId` and survive deliberately.

---
---

# Round 2 — Financial & Operational System Development Proposal

**Source of feedback:** `Oscenia ERP_ Financial & Operational System Development Proposal.html`
**Analysed & implemented:** 3 Sep 2026 · **All four phases complete**
**Verification:** 644 assertions passing (`npm run verify`), full render suite, clean production build.

## What this round was

Round 1 came from the CEO's chair and made the ledger real. Round 2 comes from the
**finance team's** chair: master data, document control, and tax accuracy — the things
that have to be right before an accountant will trust the system with a month-end.

Twelve asks. Two were already satisfied, one was a **genuine accounting error we shipped
in round 1**, and the rest were new modules.

| # | Ask | Outcome |
|---|---|---|
| 1 | COA master with sub-accounts | Built — `/accounts` |
| 2A | Journal code standardisation (KK/KM/RM/FA) | Built — `lib/vouchers.js` |
| 2B | Fixed-asset depreciation automation | Built — `/fixed-assets` |
| 2C | Inter-document linking, no deletion | Built; deletion was already impossible, now stated in the UI |
| 3 | Multi-dimensional GL filter | Built — General Ledger tab |
| 4 | Executive summarisation + drill-down | Built — Summarised ↔ Detailed toggle |
| 5 | Journal evidence printing | Built — `journalVoucherPDF` |
| 6 | Phased DP 50/75/100/custom | Built — `lib/billing.js` |
| 7 | PPh 23 on receipts | **Fixed — we had it backwards** |
| 8 | AR settlement bug | Built — the action did not exist at all |
| 9 | AP settlement bug | Fixed + full payable cycle |
| 10 | CRM free-text note column | Mostly existed; column added, author un-hardcoded |
| 11 | Petty cash requester | Built — mandatory field + recap |

## The correction that mattered — ask #7

Round 1 posted a **client receipt** as `Dr Cash (gross) / Cr 2105 PPh 23 Payable / Cr Revenue (net)`.
That is the treatment for money Oscenia *pays out* while withholding on a vendor's behalf.
For money coming *in*, the client withholds: Oscenia receives **net** cash and holds a
creditable **asset**, and revenue is **gross**. Recognising revenue net understated it by
the tax.

```
Recognition   Dr 1201 AR (gross)        Cr 4101 Revenue (gross)
Receipt       Dr 1101 Cash (net)
              Dr 1401 Prepaid PPh 23    Cr 1201 AR (gross)
```

Both directions now coexist: `1401` (an asset, withheld *from* us) and `2105`
(a liability, withheld *by* us). **This moved the reported revenue, margin and NPAT** —
worth saying to the client rather than letting them discover it in a demo.

## Decisions taken

| Decision | Reasoning |
|---|---|
| **Depreciation schedules are not draft journal entries** | The proposal asks for "draft journal generation". Writing 60 unposted entries into the journal would mean every balance function, both statements and every verify suite had to learn to exclude them — one missed filter and the books report depreciation that has not happened. The schedule is a projection; only the run posts. |
| **A purchase order is a commitment, not a debt** | The first attempt raised the payable at PO *approval*. That recognised vendor cost a month or more before the revenue it was incurred to earn, and pushed the seeded company into a **loss**. The bill is now raised when the vendor invoices (first payment or settlement). |
| **The chart of accounts is a module singleton** | `export let` + live ES bindings, so ~15 call sites and the plain-node verify scripts needed no change. The alternative — threading a `chart` argument through every ledger function — was a large refactor of working code. |
| **Revising a useful life is prospective** | Posted periods keep the charges they were posted at; the schedule rebases to the first unposted period. Recomputing from acquisition would restate history the ledger already recorded. |
| **Scheduled billing stages are excluded from AR** | A stage on a billing plan is not a debt. Counting it would put Accounts Receivable permanently out of step with account 1201. |

## Bugs found by the verification suites

None of these were found by reading the code. All eleven were caught by assertions.

| # | Bug | Consequence if shipped |
|---|---|---|
| 1 | `[SEQ_001]` token never expanded | Every voucher number printed the literal token |
| 2 | Opening a sub-account under a bank account dropped the parent from `CASH_ACCOUNTS` | Total Cash silently lost the parent's balance |
| 3 | `normalSide` imported from the wrong module | Production build failed; SSR never hit the code path |
| 4 | `cancelProject({refundDp:true})` reversed only the invoice half of the new pair | Client's cash stayed in the bank; AR went negative |
| 5 | `INV-0045` hardcoded | A second DP confirmation minted a duplicate id, and the undo **deleted another project's invoice** |
| 6 | `undoDownPayment` recognised only half the entry pair | Would have blocked its own undo |
| 7 | `accumulatedFor` re-derived past charges | Revising a useful life restated posted depreciation; register drifted from account 1303 |
| 8 | Warehouse write-offs bypassed the fixed-asset register | Register claimed equipment the ledger had removed; full cost expensed as loss on a part-depreciated asset |
| 9 | `openItems` counted adjustments as their own open items | AR and AP totals drifted above their control accounts |
| 10 | `_billFor` could return a variance adjustment instead of the bill | Settlement reasoned about the wrong document |
| 11 | A Cyrillic character in a source comment | Cosmetic |

## What this still is not

Unchanged from round 1: **everything is in-memory Zustand.** No API, no database, no
persistence — a refresh resets to seed data. Uploads are filename records, not files.
That remains one decision, and it is the next one.

## Deploy

```
cd erp-prototype && npm run verify && npm run verify:render && npm run build
rm -rf ../oscenia-web/public/erp/assets
cp -r dist/assets ../oscenia-web/public/erp/assets
cp dist/index.html ../oscenia-web/public/erp/index.html
cd ../oscenia-web && npx vercel --prod --yes
```

`npm run build` is part of the check, not an afterthought — bug #3 was invisible to both
the node-based suites and the SSR render pass, and only the bundler caught it.
