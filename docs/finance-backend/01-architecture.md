# 01 — Architecture

## The shape of the problem

The prototype's architecture is already the right one, and the backend's job is to preserve
it rather than replace it:

> **The ledger is the single source of truth.** Total Cash, Accounts Receivable, Accounts
> Payable, the Income Statement, the Balance Sheet and Project P&L are *not stored anywhere*.
> They are derived from the journal at render time.

That is a good design and it survives the move to a database. It has one consequence that
shapes everything below: **there is very little CRUD here and a great deal of derivation.**
The interesting work is a correct posting engine and a set of report queries, not tables of
invoices.

The second consequence is that errors are silent. A bad posting is a wrong number on an
executive's screen, not a stack trace. That is why several decisions below buy correctness
at the cost of convenience.

---

## Stack

| Layer | Choice | Reasoning |
|---|---|---|
| API framework | **FastAPI** + **Pydantic v2** | Requested. Pydantic validates at the boundary and generates the OpenAPI document that the React rewire will code against — so the frontend phase starts from a real contract rather than a conversation. |
| Database | **PostgreSQL 16** via docker-compose | Requested. Docker 28.3.2 is already on the build machine; no local `psql` client is needed. Postgres specifically because we lean on `NUMERIC`, deferrable constraint triggers, and `SELECT … FOR UPDATE` — all load-bearing, not incidental. |
| ORM | **SQLAlchemy 2.0** (async) + **asyncpg** | Typed `Mapped[]` models, and an async driver so FastAPI is not running database calls in a thread pool. SQLAlchemy Core is available for the report queries, which are aggregate SQL and should not go through the ORM. |
| Migrations | **Alembic** | From the first commit. The schema moves across eight phases; hand-edited DDL would drift from the models within a week. |
| Money | **`NUMERIC(18,2)`** + Python **`Decimal`** | Never floats. See *Money* below — the single most important technical decision in this document. |
| Auth | **argon2** password hashing + **JWT** access/refresh | The RBAC matrix already exists in `roles.js`; it only ever lacked a real identity behind it. |
| Background jobs | **APScheduler**, in-process | Five low-volume jobs (`seedCronJobs`): month-end depreciation, AR overdue sweep, client-birthday scan, in-transit asset check, weekly LTV recompute. A Celery + Redis deployment is not earned by that workload. A `job_runs` table gives idempotency and an audit trail, and the interface is small enough to swap for Celery later if volume justifies it. |
| Testing | **pytest** + **pytest-asyncio** + **httpx** | Against real HTTP and a real Postgres, not SQLite — because the invariants we care about are enforced by Postgres triggers that SQLite does not have. |
| Packaging | `pyproject.toml`, `pip install -e ".[dev]"` | `uv` is not installed on the build machine; plain pip keeps setup to one command. Nothing prevents `uv` later. |

### Money

`NUMERIC(18,2)` with Python `Decimal` throughout. Never `float`, never `REAL`, never
`DOUBLE PRECISION`.

The prototype stores whole rupiah as JavaScript numbers and compares balances with
`EPSILON = 1` (one rupiah) tolerance. Two things follow:

1. **Balance checks become exact.** `Decimal` arithmetic is exact, so a journal entry must
   balance to precisely `0.00`. The epsilon is not needed for this and is not carried over.
2. **The epsilon is not *only* a float guard, and that half must be carried over.** In
   `src/lib/ledger.js` it is used in nine places, including `openItems` (a document with
   under Rp 1 outstanding counts as settled — lines 274 and 295) and the statement row
   filters (lines 337, 410, 443 — a line worth under Rp 1 is not printed). That is a
   deliberate **materiality threshold**. Dropping it along with the float guard would leave
   the AR list showing rounding dust as open receivables.

So: `MATERIALITY = Decimal("1.00")`, named and documented as a business rule in
`app/core/money.py`, entirely separate from balance validation. See
[03 — Accounting rules](./03-accounting-rules.md#money-and-materiality).

`18,2` gives 16 digits before the decimal point. Oscenia's pipeline is measured in billions
of rupiah; that leaves four orders of magnitude of headroom.

### Time

`DEMO_TODAY = '2026-07-26'` is hardcoded in `src/lib/format.js`, and every ageing bucket,
day counter and depreciation "due" calculation in the prototype measures against it.

It is replaced by `app/core/clock.py` exposing an injectable clock.

**"Today" is Jakarta, not UTC.** This is a business rule, not a display preference. Oscenia
operates at UTC+7, so the business day turns over at Jakarta midnight — and for seven hours
either side of it, UTC and local disagree about the date. Every ageing bucket, DP countdown
and depreciation due date keys off `today()`, so computing it in UTC would shift all of them
by a day for part of every day. `SystemClock.today()` therefore reads
`Asia/Jakarta` (configurable as `TIMEZONE`); `now()` stays UTC, because only the *calendar
date* is local — timestamps are stored as UTC as usual.

The clock has three modes:

- **production** — real `date.today()`
- **tests** — frozen, overridden per test, so ageing assertions are deterministic
- **seeding** — `python -m app.seed.demo --as-of YYYY-MM-DD` anchors the demo data relative
  to a chosen date, so ageing buckets and event countdowns still read sensibly whenever it
  is run

No module may call `date.today()` directly. This is worth a lint rule.

---

## Layout

```
erp-backend/
  pyproject.toml
  docker-compose.yml            # postgres:16 only; the app runs on the host during dev
  alembic.ini
  .env.example
  README.md
  alembic/
    env.py
    versions/
  app/
    main.py                     # app factory, router registration, exception handlers
    core/
      config.py                 # pydantic-settings, reads .env
      clock.py                  # now() dependency - no direct date.today() anywhere
      money.py                  # Decimal helpers, MATERIALITY, rounding policy
      security.py               # argon2, JWT encode/decode
      rbac.py                   # ROLES / ACTIONS / ROLE_ACTIONS, ported from roles.js
      deps.py                   # current_user, require_action(), db session
      errors.py                 # domain exceptions -> RFC7807 responses
    db/
      base.py                   # DeclarativeBase, naming convention
      session.py                # async engine + sessionmaker
    domain/
      accounts/                 # chart of accounts
      ledger/                   # entries, lines, applications, posting, numbering, periods
      reports/                  # GL, trial balance, IS, BS, project P&L, cash, ageing
      ar/                       # clients, quotations, MoU, invoices, receipts
      ap/                       # vendors, catalogue, purchase orders, bills, payments
      cash/                     # petty cash, procurement, budgets, attachments
      assets/                   # fixed asset register, schedules, depreciation
      payroll/                  # crew, incentives
      projects/                 # projects, stages
      masters/                  # tags, tax config, company settings
                                # each package: models.py schemas.py service.py router.py
    jobs/
      scheduler.py
      depreciation.py  ar_sweep.py  reminders.py
    seed/
      chart.py                  # 27 accounts, voucher series, tax config - always run
      demo.py                   # the prototype's seed data as real rows - optional
  tests/
    conftest.py                 # per-test transaction rollback against a real database
    test_ledger_invariants.py   # port of scripts/verify-ledger.mjs
    test_flows_*.py             # port of scripts/verify-flows.mjs
```

### Why a package per domain rather than layer-first

`models/`, `schemas/`, `services/`, `routers/` as top-level directories means every change to
one feature touches four distant folders, and it makes the boundary between AR and AP
invisible. Domain-first keeps a module's model, validation, business logic and HTTP surface
adjacent, so `ap/service.py` is where "what happens when a PO is settled" lives, in full.

The one deliberate exception is `reports/`, which is cross-cutting by nature — the Balance
Sheet reads every account type — and would be arbitrary to file under any single domain.

### The dependency rule

`domain/*` may import from `core/` and `db/`. `domain/ledger/posting.py` is imported by
almost every other domain, because almost every operation posts. Nothing imports a router.
Report queries do not go through the ORM identity map; they are Core `select()` statements
returning rows.

---

## What we are deliberately not building

Stated explicitly so nobody later assumes it was an oversight.

| Not building | Why | Cost to add later |
|---|---|---|
| **Multi-tenancy** | Oscenia is one company. No `tenant_id` anywhere. | Moderate — a column on ~20 tables plus row-level security. Worth doing only if the ERP is ever resold. |
| **Multi-currency** | IDR only, exactly as today. `Rp` is hardcoded in the prototype's formatter and `AMOUNT (IDR)` in its PDF headers. | High — every money column needs a currency and a base-amount pair, plus an FX rate table. A schema change, not a config change. Flagged in [07](./07-open-questions.md). |
| **Deployment** | Local `docker compose` only; hosting explicitly deferred. Vercel does not host long-running Postgres-backed Python services well in any case. | Low — a Dockerfile and a managed Postgres. |
| **Frontend rewiring** | Confirmed as a separate later phase. The React app stays on Zustand until the API is proven. | This is the intended next project, not a gap. |
| **A closing entry / retained-earnings roll** | The prototype has none; income accounts carry balances and equity picks up NPAT as a derived line. Reproducing this exactly is required for the Balance Sheet to keep balancing. | Real year-end close is design work, flagged in [07](./07-open-questions.md). |

---

## The five inherited rulings

Decided during two rounds of client feedback and recorded in
`docs/ERP-Feedback-Analysis-and-Fix-Plan.md`. The backend implements them; it does not
quietly revisit them. Full detail in [03 — Accounting rules](./03-accounting-rules.md).

1. **Journals are never edited or deleted.** Corrections are reverse-and-repost.
2. **A purchase order is a commitment, not a debt.** Approval posts nothing.
3. **Scheduled billing stages are excluded from AR.** A plan is not a receivable.
4. **Revising an asset's useful life is prospective**, never retrospective.
5. **PPh 23 withholding runs in both directions and is never netted.**

---

## Where correctness is enforced

A deliberate choice, and the main thing that distinguishes this from the prototype: **the
invariants live in the database, not in Python.**

The prototype could rely on application code because there was exactly one writer — the
store. A backend has many clients, some of which will eventually not be ours, and a service
that only enforces balance in a Pydantic validator will one day be bypassed by a migration
script, a fixture, or a well-meaning `psql` session.

So balanced entries, append-only journals, locked accounts and closed periods are all
enforced by Postgres constraints and triggers. The application enforces them too, to return
a decent error message — but the database is what makes them true. Detail in
[02 — Data model](./02-data-model.md#database-enforced-invariants).

---

## Concurrency

Nothing in the prototype is concurrent; a Zustand store has one writer per tab and no
durability. Two finance users posting at the same moment is an entirely new condition, and
it lands on the two places least tolerant of it:

- **Document numbering.** Every id in the prototype derives from a list length
  (`PO-${3001 + purchaseOrders.length}`), which collides after any delete and races under
  any concurrency. Replaced with counter tables read under `SELECT … FOR UPDATE`.
- **Idempotency.** Four operations are guarded today by in-memory booleans that a stateless
  API cannot rely on. Each gets a real unique constraint.

Both are specified in [02 — Data model](./02-data-model.md).
