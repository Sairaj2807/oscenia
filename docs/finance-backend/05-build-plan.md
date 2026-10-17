# 05 — Build Plan

Eight phases. Each is independently testable, ends with its slice of the ported verification
suite green, and updates [STATUS.md](./STATUS.md).

**Rule for every phase:** it is not done until its tests pass. Not "written", not "mostly" —
green. The reason is in [01](./01-architecture.md): a bad posting is a wrong number on a
screen, not a crash, and the only thing standing between us and a plausible-looking wrong
Balance Sheet is the assertion suite.

---

## Phase 0 — Scaffold

**Goal:** `pytest` runs, against a real Postgres, and finds nothing to test.

```
erp-backend/
  pyproject.toml            fastapi, sqlalchemy[asyncio], asyncpg, alembic,
                            pydantic-settings, argon2-cffi, pyjwt, apscheduler
                            [dev] pytest, pytest-asyncio, httpx, ruff, mypy
  docker-compose.yml        postgres:16, volume, healthcheck
  .env.example
  alembic.ini + alembic/env.py     (async, reads the app's metadata)
  app/main.py               app factory, /health, exception handlers
  app/core/config.py        pydantic-settings
  app/core/clock.py         now() dependency
  app/core/money.py         Decimal helpers, MATERIALITY, rounding
  app/core/errors.py        domain exceptions -> RFC 7807
  app/db/base.py            DeclarativeBase + naming convention
  app/db/session.py         async engine, sessionmaker
  tests/conftest.py         per-test transaction rollback
```

`tests/conftest.py` is worth care. Each test opens a transaction, runs, and rolls back — so
tests share one migrated database and stay fast. But the balance trigger is `INITIALLY
DEFERRED` and fires at COMMIT, which a rolled-back test never reaches. So the harness needs a
`SAVEPOINT` per test **and** an explicit `SET CONSTRAINTS ALL IMMEDIATE` helper for the tests
that deliberately assert an unbalanced entry is rejected.

**Done when:** `docker compose up -d db && alembic upgrade head && pytest -q` succeeds and
`GET /health` returns a database round-trip.

---

## Phase 1 — Ledger core

**The phase that matters.** If posting, numbering and immutability are right, most of phases
4–7 are translation.

| Area | Files | Contents |
|---|---|---|
| Chart | `domain/accounts/{models,schemas,service,router}.py` | account table, tree, nesting and lock rules, `next_code` |
| Ledger | `domain/ledger/models.py` | entries, lines, applications, periods |
| | `domain/ledger/numbering.py` | `document_sequences`, `voucher_counters`, `SELECT … FOR UPDATE`, format tokens, `pick_series` |
| | `domain/ledger/posting.py` | **the single entry point every module posts through** |
| | `domain/ledger/service.py` | reverse, adjust, applications, period close |
| | `domain/ledger/router.py` | journal endpoints, voucher series, periods |
| Reports | `domain/reports/queries.py` | `trial_balance`, `general_ledger`, `account_balance`, `open_items` |
| Migrations | `alembic/versions/` | tables **and the four triggers** |
| Seed | `app/seed/chart.py` | 27 accounts, 7 voucher series, tax config |

### `posting.py` is the whole phase in one function

```python
async def post_entry(
    session, *, date, memo, lines, source, project_id=None,
    series=None, applied_to=(), user,
) -> JournalEntry
```

It must, in one transaction: validate lines; refuse a posting to a header or inactive
account; refuse a closed period; allocate `entry_no`; resolve the series (explicit wins, else
`pick_series`); allocate `voucher_no` under a row lock; insert entry, lines and application
rows. The deferred trigger checks balance at COMMIT.

Nothing else in the codebase writes to `journal_entries`. That is the invariant that makes
every later phase cheap.

**Tests:** `test_ledger_invariants.py` §1, 2, 5, 11 · `test_flows_coa.py` (§42) ·
`test_flows_vouchers.py` (§43) · `test_flows_gl.py` (§45) · plus trigger tests that a raw
`UPDATE`/`DELETE` on a posted entry is rejected at the database level.

**Done when:** an entry cannot be posted out of balance, cannot be edited or deleted, cannot
land on a header account or in a closed period; every entry carries a unique voucher number;
a reversal gets its own; the general ledger's `opening + movement = closing` holds.

---

## Phase 2 — Auth & RBAC

| Files | Contents |
|---|---|
| `domain/masters/users.py` | user model |
| `core/security.py` | argon2, JWT encode/decode, refresh rotation |
| `core/rbac.py` | `ROLES`, `ACTIONS` (20), `ROLE_MODULES`, `ROLE_ACTIONS` — ported verbatim |
| `core/deps.py` | `current_user`, `require_action("post_journal")` |
| `seed/chart.py` | five demo users, one per role |

`require_action` is a dependency, not a decorator, so the permitted-roles list reaches the
error body — a denial names who *can* do it, matching `denialReason()`.

Retrofit `require_action` onto every Phase 1 endpoint, and set `posted_by_user_id` from the
token rather than a parameter.

**Tests:** `test_flows_permissions.py` (§17, §37) — a PM may request but not approve, pay or
post; Finance may; the CEO may everything; a PM cannot reach the company ledger at all.

---

## Phase 3 — Statements & reports

| Files | Contents |
|---|---|
| `domain/reports/statements.py` | income statement, balance sheet, executive roll-up |
| `domain/reports/pnl.py` | project P&L, slice totals, the four comparison modes |
| `domain/reports/cash.py` | cash position, cash movements |
| `domain/masters/tax.py` | tax config CRUD |
| `domain/reports/export.py` | CSV first; XLSX and PDF later |

The two **derived rows** are the whole risk here — Provision for Income Tax under liabilities,
Current Period Earnings under equity. Omit either and the sheet is out by exactly the tax
amount. Corporate tax is computed from config, never read from a posted entry.

Named periods (`today|month|quarter|ytd|all`) resolve **server-side** against the clock. The
quarter boundary in particular must be derived, not hardcoded — that was a real bug in the
prototype.

**Tests:** invariants §3, 4, 10, 12 · `test_flows_tax.py` (§8) ·
`test_flows_project_costs.py` (§30) · `test_flows_periods.py` (§33, including February and
leap years) · `test_flows_rollup.py` (§46).

**Done when:** Assets = Liabilities + Equity at a 0% tax rate, at 22% and at 40%; turning
corporate tax off makes NPAT equal PBT; rolled-up figures equal the detailed ones and stay
drillable.

---

## Phase 4 — Accounts Receivable

| Files | Contents |
|---|---|
| `domain/ar/clients.py` | clients, interactions with real authorship |
| `domain/ar/quotations.py` | quotations, lines, DP stages, MoU templates |
| `domain/ar/billing.py` | presets, `resolve_schedule`, `validate_schedule` |
| `domain/ar/invoices.py` | issue, receive payment with PPh 23 |
| `domain/ar/deals.py` | confirm / undo down payment |
| `domain/projects/` | projects, stages, cancellation |

Two things to get exactly right:

- **`resolve_schedule` must bill to the rupiah.** The final stage absorbs the rounding
  remainder. §47 asserts this for every preset and for awkward contract values.
- **`confirm_down_payment` is one transaction** producing a project, N invoices and two
  linked journal entries. Idempotent via the unique constraint on `projects.quotation_id`.

**Tests:** invariants §6 · `test_flows_quotation.py` (§1) · `test_flows_dp.py` (§2, 2b, 31) ·
`test_flows_billing.py` (§47, 48) · `test_flows_ar.py` (§49–52) ·
`test_flows_project_lifecycle.py` (§14, 15).

**Done when:** revenue is recognised gross, cash arrives net, 1401 carries the withholding,
nothing is credited to 2105 on a client receipt, and outstanding invoices equal ledger 1201
with scheduled stages excluded.

---

## Phase 5 — Accounts Payable

| Files | Contents |
|---|---|
| `domain/ap/vendors.py` | vendors, per-vendor PPh 23 rate, bank, NPWP, terms |
| `domain/ap/catalogue.py` | items, bookings, date-aware availability |
| `domain/ap/purchase_orders.py` | the five-status lifecycle |
| `domain/ap/bills.py` | lazy bill raising, payment, variance, refund |
| `domain/masters/tags.py` | tags with AND-semantics filtering |

Order of operations in `cancel_purchase_order` is load-bearing: **reverse payments, then the
bill.** Filtering only on `source_kind = 'po'` and missing the payments was a real bug (§63).

**Tests:** `test_flows_po.py` (§11, 13, 36) · `test_flows_availability.py` (§12) ·
`test_flows_ap.py` (§59–61) · `test_flows_withholding.py` (§62) ·
`test_flows_po_cancel.py` (§63).

**Done when:** approval raises no payable and recognises no cost; open vendor bills equal
ledger 2102; withholding on a vendor payment is credited to 2105 and not debited to 1401;
settling at an actual below committed leaves no payable behind; a zero-DP order is settleable
without ever reaching `DP Paid`.

---

## Phase 6 — Cash operations

| Files | Contents |
|---|---|
| `domain/cash/petty_cash.py` | float, top-up, balance reconciled against 1103 |
| `domain/cash/procurement.py` | the five-status workflow, mandatory requester, advance settlement |
| `domain/cash/budgets.py` | ceilings, derived actuals, tolerance alerts |
| `domain/cash/attachments.py` | `StorageBackend` + local disk |

`attachments` is the first genuinely **new** capability rather than a port — the prototype
stores filenames as strings and the vendor screen says outright that real uploads need a
storage backend. Procurement receipts and vendor documents become real files here.

Budget actuals are **derived from postings**, which incidentally fixes the prototype's
single hardcoded budget object covering one project.

**Tests:** invariants §5 · `test_flows_petty_cash.py` (§4) ·
`test_flows_procurement.py` (§5, 64, 65) · `test_flows_budget.py` (§16).

**Done when:** a top-up leaves total cash unchanged; the petty-cash balance agrees with
ledger 1103; a blank requester is refused; an advance cannot settle without a receipt; an
over-budget project is flagged exactly once.

---

## Phase 7 — Fixed assets & payroll

| Files | Contents |
|---|---|
| `domain/assets/schedule.py` | straight-line and declining, prospective rebasing |
| `domain/assets/service.py` | capitalise, run depreciation, dispose, write-down |
| `domain/assets/router.py` | register, schedule, backlog, run |
| `domain/payroll/` | crew, incentive pool, disbursement |
| `domain/cash/warehouse.py` | the three postings that reach the ledger |

The depreciation run is the most idempotency-sensitive operation in the system: **one entry
per period with a line per asset**, keyed on the period, and a second call must post nothing.

**Tests:** invariants §7 · `test_flows_incentives.py` (§6, 40, 41) ·
`test_flows_depreciation.py` (§53–58) · `test_flows_warehouse.py` (§3).

**Done when:** every asset runs its full life and lands exactly on `cost − salvage`, never
below; the register ties to 1302 and 1303; running the backlog twice posts nothing the second
time; revising a life leaves posted charges untouched and still finishes on salvage;
disbursing incentives without a project tag is refused with nothing posted.

---

## Phase 8 — Scheduler & hardening

| Files | Contents |
|---|---|
| `jobs/scheduler.py` | APScheduler wiring, `job_runs` guard |
| `jobs/depreciation.py` | month-end run, last day 23:00 |
| `jobs/ar_sweep.py` | overdue invoice sweep |
| `jobs/reminders.py` | client birthday / anniversary scan, in-transit asset check |
| `seed/demo.py` | the prototype's seed data as real rows, `--as-of` anchored |
| `README.md` | run, seed, test, troubleshoot |

Every job writes a `job_runs` row keyed `(job_key, run_for)`, so a retry after a crash is
safe and an operator can see what ran.

Also here: structured logging with a request id, OpenAPI tags and descriptions tidy enough
for the frontend team to work from, and a pass over error messages so a 409 explains itself.

**Done when:** `python -m app.seed.demo` reproduces the prototype's opening position and the
full suite passes against it.

---

## Sequencing notes

- **Phases 4 and 5 could run in parallel** once phase 3 lands — AR and AP share only the
  posting engine. Worth doing only with two people; alone, AR first is better because the DP
  flow exercises applications hardest.
- **Phase 2 could move earlier**, but putting it after phase 1 keeps the ledger tests free of
  auth fixtures while the posting engine is still moving.
- **Phase 6's file storage is the only external dependency** in the whole build. If it slips,
  nothing else waits on it.

## Git

One branch per phase off the current `erp-feedback-round-2`:
`feat/backend-p1-ledger-core`, `feat/backend-p2-auth`, and so on. Commit at the end of each
phase with its tests green, never mid-phase with a red suite.
