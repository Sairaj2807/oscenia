# Finance Backend — Documentation Index

**Status:** specification. No backend code exists yet.
**Owner:** Oscenia IT Development Division
**Created:** 2026-09-04
**Applies to:** the Finance portion of the Oscenia ERP — accounting core, AR, AP, cash &
treasury, petty cash & procurement, budgeting, fixed assets & depreciation, payroll
incentives, project P&L, quotations & phased DP.

---

## Why these documents exist

`erp-prototype/` is a complete, client-reviewed ERP **with no backend of any kind**. Every
number on every screen is derived at render time from one in-memory Zustand store
(`src/store/useStore.js`, 2,638 lines) seeded from `src/store/seed.js`. A page refresh
resets the company's books.

The project's own review notes have flagged this twice:

> "everything is in-memory Zustand. No API, no database, no persistence… **That remains one
> decision, and it is the next one.**"
> — `docs/ERP-Feedback-Analysis-and-Fix-Plan.md:401`

These documents make that decision and specify it fully — architecture, schema, posting
rules, API contract, build phases, test criteria — **before any Python is written**. The
prototype is an unusually good specification, and the cost of transcribing it carefully now
is far lower than the cost of discovering halfway through the build that the Balance Sheet
no longer balances.

---

## Reading order

| # | Document | Read it when you need to know… |
|---|---|---|
| 01 | [Architecture](./01-architecture.md) | what we chose, why, and what we deliberately did not build |
| 02 | [Data model](./02-data-model.md) | the tables, columns, constraints and database-enforced invariants |
| 03 | [Accounting rules](./03-accounting-rules.md) | **the posting rulebook** — exact Dr/Cr for every transaction |
| 04 | [API contract](./04-api-contract.md) | which endpoint backs which screen |
| 05 | [Build plan](./05-build-plan.md) | what gets built in which phase, and what "done" means |
| 06 | [Test spec](./06-test-spec.md) | the acceptance criteria, ported from the prototype's own suites |
| 07 | [Open questions](./07-open-questions.md) | what still needs a decision from the client |
| — | [STATUS](./STATUS.md) | where the build actually is right now |

**If you read only one, read 03.** Architecture can be revisited; a wrong posting rule
produces a plausible-looking number that nobody catches for a quarter.

---

## How to rehydrate a fresh session

This repo follows a context-discipline rule: state lives in markdown, not in chat history.
To pick this work up cold:

1. Read `STATUS.md` — it names the current phase and the next action.
2. Read `03-accounting-rules.md` and `02-data-model.md`.
3. Read the phase you are on in `05-build-plan.md`.
4. Skim `07-open-questions.md` so you do not silently re-decide something that is parked.

That is enough. You do **not** need to re-read the prototype; these documents already
transcribe it. If a document and the prototype disagree, the prototype is right and the
document is a bug — fix the document.

---

## Source material these documents were derived from

| Source | What it contributed |
|---|---|
| `erp-prototype/src/lib/ledger.js` (527 lines) | The report algebra — `openItems`, `generalLedger`, `incomeStatementFrom`, `balanceSheetFrom`, `trialBalance`, `projectCosts`. Becomes SQL. |
| `erp-prototype/src/lib/accounts.js` | The 27-account seed chart, account types, nesting and lock rules |
| `erp-prototype/src/lib/vouchers.js` | Voucher series, format tokens, reset cadences, `pickSeries` auto-classification |
| `erp-prototype/src/lib/billing.js` | Phased-DP presets and `resolveSchedule` |
| `erp-prototype/src/lib/depreciation.js` | Straight-line and declining schedules |
| `erp-prototype/src/lib/roles.js` | The 5-role × 20-action RBAC matrix |
| `erp-prototype/src/store/seed.js` (982 lines) | The de-facto data model — every entity's real field names |
| `erp-prototype/src/store/useStore.js` (2,638 lines) | The de-facto API surface — ~70 mutations |
| `erp-prototype/scripts/verify-ledger.mjs` · `verify-flows.mjs` | **The acceptance criteria.** 12 invariants + 65 flow sections |
| `docs/PRD-ERP-Oscenia.md` | Original scope from the client's 14-slide deck |
| `docs/ERP-Feedback-Analysis-and-Fix-Plan.md` | Two rounds of client feedback and the rulings taken |
| `oscenia_erp_upgrade_roadmap_presentation.html` | Client feedback round 1 (10 slides) |
| `Oscenia ERP_ Financial & Operational System Development Proposal.html` | Client feedback round 2 (the finance team's asks) |

---

## The one-paragraph summary

A FastAPI + PostgreSQL service becomes the system of record for Oscenia's books. The ledger
is the single source of truth: cash, AR, AP, the Income Statement, the Balance Sheet and
Project P&L are all **derived** from journal entries, exposed as report endpoints rather than
stored as tables. Journals are append-only and enforced so by database triggers, not by
application politeness. Corrections are reverse-and-repost. PPh 23 withholding runs in both
directions and is never netted. The backend is built and proven standalone against the
prototype's own verification suites; the React app is rewired afterwards, against a contract
that has already been tested.
