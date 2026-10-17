# 07 — Open Questions

Everything here is **parked for client confirmation**. Each carries a recommendation, so
review is a yes/no rather than fresh design. Nothing here blocks the build: each item names
what we do in the meantime.

Numbering is stable — do not renumber when items close. Mark them `RESOLVED` with the date
and the decision.

---

## Accounting policy

### Q1 — Revenue recognition: should a down payment defer through 2101 Unearned Revenue?

**Status:** open · **Blocks:** nothing (phase 4 builds it either way) · **Priority:** high

Today a client down payment credits `4101 Event Revenue DP` immediately, on the day the cash
arrives — months before the event happens. Account `2101 Unearned Revenue` exists in the
chart and is never used.

This is already documented as a known gap: *fine for a prototype, wrong for statutory
reporting.* Under any accrual standard, cash received before performance is a **liability**,
not revenue. Recognising it early overstates revenue and NPAT in the period the DP lands and
understates them in the period the event runs.

The counter-argument is real: the client's own finance team reviewed and approved the current
treatment across two rounds, and the numbers in their deck assume it. Changing it moves every
headline figure they have seen.

> **Recommendation:** build the posting rule as configurable
> (`company_settings.defer_dp_revenue`, default **off** to match today), and put the question
> to the client's accountant with a side-by-side of both treatments on the same seed data.
> Turning it on later is a settings change plus a one-off reclassification entry, not a
> migration.
>
> **Meanwhile:** we post exactly as the prototype does.

### Q2 — What does closing a period actually do?

**Status:** open · **Blocks:** nothing · **Priority:** medium

The prototype has no period concept. The backend introduces one because month-end
depreciation and a real audit trail need it — but "closed" currently means only *no entry may
be dated inside it*.

It does **not** post a closing entry rolling income into retained earnings. That is
deliberate: the Balance Sheet balances by picking up NPAT as a *derived* equity row, which
only works while income accounts still carry their balances. Introducing a real close changes
the statement logic too.

The questions are: does Oscenia want a hard month-end close, a soft one (warn but allow), or
year-end only? And who may close and reopen?

> **Recommendation:** hard close, Finance and CEO only, reopening permitted but logged. Defer
> the year-end closing entry until Q1 is settled, since revenue deferral changes what gets
> rolled.
>
> **Meanwhile:** periods exist, close blocks postings, no closing entry.

### Q3 — Which accounting standard applies?

**Status:** open · **Blocks:** nothing · **Priority:** medium

The original PRD flagged this and it was never answered: PSAK, PSAK-ETAP, or IFRS? It
governs Q1, depreciation method acceptability, and whether the statements need a specific
presentation format for the external accountant.

> **Recommendation:** ask the client's accountant directly. The likely answer for a private
> Indonesian company of this size is **PSAK-ETAP**, which is permissive about most of what we
> do here.

---

## Tax

### Q4 — Is Oscenia a PKP? Should PPN (11%) be activated?

**Status:** open · **Blocks:** nothing · **Priority:** high

`PPN — Value Added Tax` is configured at 11% and **inactive**. Account `2106 PPN Payable`
exists and is never posted to. If Oscenia is a registered taxable enterprise (Pengusaha Kena
Pajak), output VAT on client invoices and input VAT on vendor bills are both mandatory, and
that changes invoice totals, not just a report.

This is the largest single gap between the system and Indonesian practice.

> **Recommendation:** confirm PKP status before go-live. If registered, PPN is a phase of its
> own — output VAT on AR, input VAT on AP, and a periodic VAT return position — and should be
> scoped separately rather than squeezed into phase 4.
>
> **Meanwhile:** the config stays inactive, exactly as today.

### Q5 — Does PPh 21 and real payroll belong in this system?

**Status:** open · **Blocks:** nothing · **Priority:** low

There is no employee payroll. `Payroll.jsx` handles **crew event incentives** only — a bonus
computed from a client satisfaction rating. Accounts `2103 Crew Payables` and `2107 PPh 21
Payable` are in the chart and never posted to.

> **Recommendation:** keep payroll out. Salaries appear in the ledger as periodic journal
> entries against 6102, which is adequate unless Oscenia wants payslips and PPh 21 filing
> from this system. If they do, it is a module, not a feature.

### Q6 — Should sales commission post to the ledger?

**Status:** open · **Blocks:** nothing · **Priority:** low

`seedSales` carries three salespeople with a commission percentage, and the figure is
computed in the view and **never posted**. The original PRD asked for "auto sales commission
on net contract value" — so this is arguably an unfinished requirement rather than a design
choice.

> **Recommendation:** if commission is a real cost, it must reach the ledger — probably
> accrued on quotation acceptance against a commission-payable account, and settled on
> payment. Needs the actual commission policy first: on contract value or on collected cash?
> On acceptance or on delivery? Clawed back if a project is cancelled?

---

## Scale and structure

### Q7 — One legal entity, or three?

**Status:** open · **Blocks:** nothing now; expensive later · **Priority:** high

The company presents as **Jakarta · Bali · Singapore**. The system has no concept of a
company, entity or branch anywhere — one chart of accounts, one set of books.

If those are three legal entities, they need separate books and consolidation. If they are
one entity with three locations, a cost-centre dimension is enough (and `division` already
exists on projects).

> **Recommendation:** confirm early. Retrofitting multi-entity after the ledger has real data
> is significantly more expensive than deciding now. If it is one entity with locations, add
> a `location` dimension to journal entries in phase 1 — cheap now, awkward later.
>
> **Meanwhile:** single entity, as today.

### Q8 — Is Singapore trading in SGD?

**Status:** open · **Blocks:** nothing now · **Priority:** high, if the answer is yes

There is no currency field anywhere. `Rp` is hardcoded in the formatter and `AMOUNT (IDR)` in
the PDF headers. A Singapore operation billing in SGD would need a currency and base-amount
pair on every money column, an FX rate table, and revaluation at period end.

> **Recommendation:** confirm alongside Q7. If SGD invoicing is coming, say so before phase 4
> — adding currency to `invoices` and `journal_lines` during the build is a day; adding it
> afterwards is a migration across every financial table.
>
> **Meanwhile:** IDR only.

---

## Data

### Q9 — Is there existing accounting data to migrate?

**Status:** open · **Blocks:** go-live planning · **Priority:** high

The seed data is invented for the demo. Real go-live needs a decision: start from an opening
balance journal on a chosen date, or import history from whatever Oscenia uses today
(spreadsheets? Accurate? Jurnal?).

> **Recommendation:** start with an opening trial balance on a clean cut-over date and keep
> history in the old system. Importing partial history into a double-entry ledger is where
> these projects usually lose a month.

### Q10 — Client birthdays and anniversaries are free text

**Status:** open · **Blocks:** nothing · **Priority:** low

Stored as display strings — `'28 Jul'`, `'01 Mar 2019'`, `'—'` — and the birthday reminder
job does a string match. Real date columns would make the reminder scheduler trivial and
correct.

> **Recommendation:** convert to nullable `date` columns during phase 8, with a small
> migration for the four seeded clients. Low cost, removes a whole class of scheduler bug.

### Q11 — File storage: limits and retention?

**Status:** open · **Blocks:** phase 6 sizing · **Priority:** medium

Attachments become real in phase 6 — procurement receipts, vendor pricelists and agreements.
Unanswered: maximum file size, permitted types, total retention, and whether receipts are
subject to a statutory retention period (in Indonesia, commonly ten years for tax records).

> **Recommendation:** default to 10 MB per file, `pdf/jpg/png/webp` only, local disk in
> development, and no automatic deletion ever. Confirm the retention rule with the
> accountant.

---

## Product

### Q12 — Who are the real users, and how many?

**Status:** open · **Blocks:** nothing · **Priority:** medium

Phase 2 introduces real accounts. The five roles come from the prototype, and two of them
(Finance, PM) were **invented during round 1** — the client's original deck named only CEO,
Sales & Marketing, and Warehouse & Ops, while restricting approvals to "Finance", a role it
never defined.

> **Recommendation:** confirm the actual list of people and which role each holds before
> phase 2 seeds users. Also confirm whether one person can hold two roles — the current model
> says no, one role per user.

### Q13 — Should there be an audit log beyond the journal?

**Status:** open · **Blocks:** nothing · **Priority:** medium

Journal entries are append-only and stamped with who posted them, so financial history is
fully auditable. **Non-financial** changes are not: editing a vendor's PPh 23 rate, changing
a budget ceiling, renaming an account, closing a period.

> **Recommendation:** add a generic `audit_log` table in phase 8 capturing actor, table, row,
> before and after. Cheap when done once centrally, tedious to retrofit per table.

---

## Defects found while specifying

### Q14 — `SettleModal` is broken in the live prototype

**Status:** open · **Blocks:** nothing in the backend · **Priority:** medium

`erp-frontend/src/pages/PurchaseOrders.jsx:175-193` — the component takes
`{po, vendor, onClose}` and has **no** `useStore` selector, yet line 193 calls
`settlePurchaseOrder(po.id, value)`. Clicking **Settle** throws a `ReferenceError` in the
browser, breaking the final step of the purchase-order lifecycle.

The store action itself is correct, and both verification scripts call it directly — which is
exactly why no suite catches this. It sits squarely in the documented gap: *"modal bodies
only mount on a click, so they were not machine-verified."*

> **Recommendation:** a one-line fix
> (`const settlePurchaseOrder = useStore((s) => s.settlePurchaseOrder)`), worth shipping to
> the prototype now rather than waiting for the rewire — the PO lifecycle is part of the
> client demo. **Say the word and I will fix it separately from this work.**

### Q15 — `revenueTrend` on the Dashboard is fabricated

**Status:** open · **Blocks:** nothing · **Priority:** low

The Dashboard's "Revenue by month" area chart reads a hardcoded array. It is the only
non-derived figure on an otherwise fully-derived screen.

> **Recommendation:** `GET /reports/revenue-trend` is already in the API contract and makes
> it real in phase 3. No decision needed — noted so nobody is surprised when the shape of the
> chart changes.

---

## Resolved

*(Move items here with the date and the decision as they close.)*

| # | Question | Decision | Date |
|---|---|---|---|
| — | Backend scope | Everything the prototype's finance pages show | 2026-09-04 |
| — | Build sequencing | Backend standalone first; wire the React app afterwards | 2026-09-04 |
| — | Stack | FastAPI + PostgreSQL | 2026-09-04 |

## Q16 — Opening consumables: 28,200,000 or 22,068,000?

**Priority: medium.** Surfaced by phase 8 while building the demo seed.

The prototype's opening balance for `1301 Inventory — Consumables` is **28,200,000**. The
consumable stock it ships is worth **22,068,000**:

| Item | Qty | Unit value | Value |
|---|---:|---:|---:|
| Duct Tape (roll) | 240 | 35,000 | 8,400,000 |
| Cable Ties (pack) | 180 | 45,000 | 8,100,000 |
| Microphone Batteries | 96 | 58,000 | 5,568,000 |
| | | | **22,068,000** |

A gap of **6,132,000**. This is in the client's own seed data, not something introduced by the
backend. The prototype's comment claims the tie for fixed assets only — *"Fixed-asset value
totals 640,000,000 = ledger account 1302"* — and 1302 does tie exactly, to the rupiah.

**Recommendation.** Ask which figure is right, and correct the other. Do not guess: the two
plausible fixes point in opposite directions — either the opening balance is overstated by
6,132,000 (and retained earnings with it), or there is stock on hand nobody listed.

Until it is answered, `python -m app.seed.demo` loads both numbers as given and **reports the
gap** at the end of the run. Neither silently correcting a reviewed opening balance nor
silently shipping a broken reconciliation is ours to choose.

---
