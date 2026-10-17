# Oscenia ERP — Finance Backend

FastAPI + PostgreSQL. The system of record for Oscenia's books: a double-entry ledger with
AR, AP, cash, fixed assets and project P&L derived from it.

**Specification lives in [`../docs/finance-backend/`](../docs/finance-backend/).** Read
[STATUS](../docs/finance-backend/STATUS.md) first to see where the build is, then
[03 — Accounting rules](../docs/finance-backend/03-accounting-rules.md), which is the
posting rulebook and the document that matters most.

## Requirements

- Python 3.12+
- Docker (for Postgres 16)

## Setup

```bash
cd erp-backend

python -m venv .venv
source .venv/Scripts/activate        # Git Bash on Windows
# .venv\Scripts\activate             # PowerShell
# source .venv/bin/activate          # macOS / Linux

pip install -e ".[dev]"
cp .env.example .env

docker compose up -d db
alembic upgrade head
```

Postgres publishes on **host port 5433**, not 5432. A native `postgresql-x64-17` Windows
service already owns 5432 on the build machine, and Docker only won the IPv6 half of it —
so `localhost:5432` silently resolved to the other server and failed authentication against
a perfectly healthy container. If you move the port, check what already listens there:

```bash
# Windows
netstat -ano | grep 5432
```

## Run

```bash
uvicorn app.main:app --reload        # http://localhost:8000
```

- `http://localhost:8000/docs` — interactive OpenAPI
- `http://localhost:8000/health` — liveness plus a real database round-trip

## Test

```bash
pytest -q                    # everything
pytest -m phase1             # one phase
pytest -m "not slow"         # skip the full-life depreciation runs
```

The suite creates and migrates `oscenia_erp_test` on first run — the development database
is never touched. Every test runs in a transaction that is rolled back at teardown.

Tests go through real HTTP against real Postgres, deliberately. The invariants that matter
here are enforced by database triggers, so SQLite would prove nothing.

## Signing in

The seeder creates one demo user per role, all with the password `oscenia-demo-2026`:

| Email | Name | Role |
|---|---|---|
| `rahmat@oscenia.co.id` | R. Hartono | CEO — every permission |
| `lina@oscenia.co.id` | Lina W. | Finance — ledger, cash, approvals |
| `agus@oscenia.co.id` | Agus P. | Project Manager — **requests only** |
| `dinda@oscenia.co.id` | Dinda A. | Sales & Marketing |
| `bagus@oscenia.co.id` | Bagus S. | Warehouse & Ops |

```bash
curl -X POST localhost:8000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"lina@oscenia.co.id","password":"oscenia-demo-2026"}'
```

Then send `Authorization: Bearer <access_token>`. `GET /api/v1/auth/me` returns the caller's
resolved actions and visible modules, so the frontend gates its UI from the server's answer
rather than reimplementing the policy and drifting from it.

That password is safe to publish because it is useless anywhere real: `Settings` refuses to
start with the development JWT secret when `ENV=production`, and a production deployment
seeds its own users.

## Demo data

```bash
python -m app.seed.demo --as-of 2026-07-26
```

Loads the prototype's FY2026 **opening position** — the opening balances entry, clients,
vendors, crew, warehouse stock and the fixed-asset register — as real rows. It is idempotent
and *converging*: running it against a partly-seeded database fills in what is missing rather
than noticing one row and returning early.

It does not replay the prototype's transaction history. That is the demo's history, not its
opening position, and each of those flows is reachable through the API.

The run ends with a reconciliation of the warehouse against the ledger. **1302 ties exactly;
1301 does not** — the prototype's opening balance for consumables is 28,200,000 against stock
worth 22,068,000. That 6,132,000 gap is in the client's own seed data, and the seed reports
it rather than silently changing a reviewed figure. Parked as Q16.

### Team chat demo

```bash
python -m app.seed.demo        # the clients the chat projects hang off
python -m app.seed.chat        # ten people, four projects, 17 channels, 23 messages
```

Idempotent, and refused with `ENV=production` (it creates accounts with the published demo
password). Agus and Dinda are updated, not duplicated; the other eight are `team` logins
(`rina@oscenia.co.id`, `maya@…`, `hendra@…` and so on, same demo password). Real people are added
with `python -m app.seed.users add EMAIL "Name" team --workspace-role staff --division Field`.

## Background jobs

Five jobs, from the prototype's Cron Jobs screen. They are **off by default**:

```bash
SCHEDULER_ENABLED=true uvicorn app.main:app
```

| Key | When | What |
|---|---|---|
| `depreciation.month_end` | last day · 23:00 | posts the whole depreciation backlog, oldest first |
| `ar.overdue_sweep` | daily · 08:00 | raises a reminder per overdue invoice. Posts nothing |
| `crm.milestone_scan` | daily · 07:00 | client birthdays and anniversaries |
| `warehouse.in_transit_check` | daily · 20:00 | kit still out past its event date |
| `crm.ltv_recompute` | Mondays · 06:00 | **no-op by design** — see below |

Every run writes a `job_runs` row keyed on `(job_key, run_for)`, where `run_for` is the period
the run *covers* rather than when it started. That is what makes a run happen once, a crashed
run retryable, and "did month-end actually post?" a question with an answer.

`crm.ltv_recompute` reports `skipped` every week and that is correct: lifetime value is
derived from the ledger on read and never cached, so there is nothing to refresh. It stays
registered so the screen still shows five rows and the reason is visible.

Run one by hand — same code path, same guard:

```bash
curl -X POST localhost:8000/api/v1/jobs/depreciation.month_end/run   -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}'
```

**One process only.** In-process APScheduler under two uvicorn workers means two schedulers.
The `job_runs` claim catches it today, but that is a safety net rather than a design — running
multiple workers needs the scheduler moved behind a leader election or into its own process.

**Chat is single-worker too, and enforces it.** The chat hub (`app/domain/chat/hub.py`) holds
every WebSocket connection in this process, so a second worker would deliver only half the events.
The first WebSocket takes a Postgres advisory lock (`CHAT_HUB_LOCK_KEY`); any other worker logs an
error and refuses upgrades with close code 1013. Behind a proxy, give the WebSocket route a read
timeout above 60 seconds (the client pings every 25) and pass the `Upgrade` headers. Moving to
several workers means swapping the hub's delivery for Postgres `LISTEN/NOTIFY` — the seam is
`ChatHub.send()` / `broadcast()`.

## Lint and types

```bash
ruff check .
ruff format .
mypy app
```

`ruff`'s `DTZ` rules are on and are load-bearing: nothing outside `app/core/clock.py` may
ask the OS for the date. All time arrives through the injectable clock, so ageing
assertions stay deterministic.

## Migrations

```bash
alembic revision --autogenerate -m "create ledger core"
alembic upgrade head
alembic downgrade -1
```

Register new model modules in `alembic/env.py` or autogenerate will not see them.

## Layout

```
app/
  core/     config, clock, money, errors, security, rbac
  db/       declarative base, engine, session
  domain/   one package per domain: models, schemas, service, router
  jobs/     APScheduler jobs
  seed/     chart of accounts; demo data
tests/      ported from the prototype's verify-ledger and verify-flows suites
```

## Five things that will bite you if you skip them

**Money is `Decimal`, never `float`.** `NUMERIC(18,2)` throughout. Entries balance to
exactly `0.00` — there is no tolerance. The separate one-rupiah *materiality* threshold in
`app/core/money.py` is a business rule about what is worth printing or chasing, and is not
a rounding allowance.

**Journals are append-only.** There is no `PUT`, `PATCH` or `DELETE` on a posted entry, and
database triggers reject the attempt even from raw SQL. Corrections are reverse-and-repost.
This is a client requirement, not a preference.

**A Project Manager may request, never approve.** That is the client's policy, not a
default we chose, and it is enforced server-side in `app/core/rbac.py` — ported verbatim
from the prototype's `roles.js`. If a role needs a new permission, that is a decision to
take with the client, not a line to edit.

**"Today" is Jakarta, not UTC.** `SystemClock.today()` reads `Asia/Jakarta` (settable via
`TIMEZONE`), because Oscenia operates at UTC+7 and the business day turns over at Jakarta
midnight. Ageing buckets, DP countdowns and depreciation due dates all key off it, so a UTC
date would shift every one of them by a day for seven hours out of every twenty-four.
Timestamps (`now()`) stay UTC — only the calendar date is local.

**Sign-in is rate limited, in Postgres.** `app/core/throttle.py` counts failures per account
and per client IP in the `rate_limits` table; either tripping locks out for fifteen minutes,
and a correct password clears both. Every worker shares the count and a restart does not lift
a lockout. A failed login raises, and the request session rolls back on an exception, so the
login route commits the failure *before* re-raising — keep it that way. The scheduler is still
in-process, so the API still runs one worker (see Background jobs).

## Deploying

`Dockerfile` here and `../deploy/` (Compose, Caddy, deploy/backup/restore scripts) put the API
on a VPS; [`../deploy/README.md`](../deploy/README.md) is the runbook. In production the
reference seed creates **no** demo users and `app.seed.demo` refuses to run; add real people
with `python -m app.seed.users add <email> "<name>" <role>`.

## Low-memory machines

Docker Desktop wants roughly 2 GB for its WSL2 VM. On an 8 GB machine it may sit in
`starting` forever while returning `500` from every API call. Cap it with `~/.wslconfig`:

```ini
[wsl2]
memory=2GB
processors=2
autoMemoryReclaim=gradual
```

Then `wsl --shutdown` and start Docker Desktop again.
