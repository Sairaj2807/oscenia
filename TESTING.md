# Manual testing guide — Oscenia ERP

> **Update, 17 Oct 2026.** This repository is now one monorepo deployed on one VPS (`https://osceniaevents.com`). Read [GO-LIVE-STATUS](docs/GO-LIVE-STATUS.md) first, then [deploy/vps/README](deploy/vps/README.md). Path changes: `erp-frontend/` is now `erp-frontend/`, `oscenia-web/` is now `website/`. Deploys are no longer by Vercel CLI. Production has real login only (demo mode is dev and tests only), pages are role-guarded and the API gates reads by module. Where this document disagrees with that, the newer docs win.


For a tester picking this up cold. It tells you what to run, what to click, what number should
appear, and — just as importantly — **what is not wired up yet**, so you do not spend an
afternoon writing up a bug that is a known gap.

Read [§0 What is real today](#0-what-is-real-today) before anything else. It will save you time.

---

## 0. What is real today

The build has two halves at different stages. Testing the wrong half against the wrong
expectation is the main way to waste effort here.

| Area | State | What that means for you |
|---|---|---|
| **Backend API** | **Complete.** 8 phases, 106 endpoints, 494 automated tests | Fully testable. This is where the business logic lives and where real bugs will be |
| **Frontend — sign-in & permissions** | **Real** | Genuinely enforced by the server. Test it properly |
| **Frontend — reading data** | **Wired, lightly tested** | Screens load from the API. Verify the numbers match the API |
| **Frontend — saving data** | **Wired** (see below for the few exceptions) | Buttons save through the API and the screen re-reads |
| **Deployment** | Local only | The backend is not hosted anywhere. Vercel still serves the old in-memory demo |

### ⚠️ What still does not save

Signed in against the backend, every action that has a server endpoint now saves and survives a
refresh. A few things have no server side yet; they show a red **"Not saved"** message and change
nothing, rather than appearing to work: MoU template editing, renaming a tag, item tags, editing a
fixed asset, delivery orders, attaching a file to a CRM note, the Daily Jobs screen, and Budgeting's
"Log unplanned cost". **Do not raise bugs for those.** Signed out (the demo), nothing saves, as before.

Sign-in is the exception — that is fully real, end to end.

---

## 1. Setup

### Prerequisites

- **Docker Desktop** — for PostgreSQL 16
- **Python 3.12+**
- **Node 20+**
- **~2.5 GB of free RAM.** Not a formality. See [§7](#7-troubleshooting) — this has stopped
  the build on the dev machine more than once

### First run

```bash
# 1. Database
cd erp-backend
docker compose up -d db          # publishes on port 5433, not 5432 — see §7

# 2. Backend
python -m venv .venv
source .venv/Scripts/activate    # Git Bash on Windows
# .venv\Scripts\activate         # PowerShell
# source .venv/bin/activate      # macOS / Linux
pip install -e ".[dev]"
cp .env.example .env
alembic upgrade head

# 3. Demo data
python -m app.seed.demo --as-of 2026-07-26

# 4. Start it
uvicorn app.main:app --reload    # http://localhost:8000
```

In a second terminal:

```bash
cd erp-frontend
npm install
cp .env.example .env             # points at http://localhost:8000/api/v1
npm run dev                      # http://localhost:5273  (the website is 5173)
```

### Confirm it is alive

```bash
curl localhost:8000/health
```

Expect `{"status":"ok","database":"ok","today":"2026-...","env":"dev"}`.

**`"database":"ok"` matters.** The health check does a real query on purpose — a health check
that skips the database stays green while every request fails.

### The seed output tells you something

The seed prints a reconciliation. It should end like this:

```
  1302 Fixed Assets  ledger   640,000,000.00   stock   640,000,000.00   ties
  1301 Consumables   ledger    28,200,000.00   stock    22,068,000.00   GAP 6,132,000.00
```

**The 6,132,000 gap is expected and is not a bug in this system.** It is a discrepancy in the
client's own original demo data: the opening balance for consumables does not match the stock
list it is supposed to represent. It is reported rather than silently corrected, because
changing a figure the client signed off is their call. It is logged as Q16 in
`docs/finance-backend/07-open-questions.md`.

If the fixed-asset line says anything other than **ties**, that *is* a bug — raise it.

---

## 2. Signing in

Five demo accounts, one per role. Password for all of them: **`oscenia-demo-2026`**

| Email | Person | Role | Can do |
|---|---|---|---|
| `rahmat@oscenia.co.id` | R. Hartono | CEO | everything |
| `lina@oscenia.co.id` | Lina W. | Finance | ledger, cash, approvals, payments |
| `agus@oscenia.co.id` | Agus P. | Project Manager | **request only — never approve or pay** |
| `dinda@oscenia.co.id` | Dinda A. | Sales | quotations, clients |
| `bagus@oscenia.co.id` | Bagus S. | Warehouse | stock in and out |

To get a token for API testing:

```bash
curl -s -X POST localhost:8000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"lina@oscenia.co.id","password":"oscenia-demo-2026"}'
```

Copy `access_token` and send it as `Authorization: Bearer <token>` on every other call.

**Easier option:** open **http://localhost:8000/docs**. Click **Authorize**, paste the token,
and every endpoint becomes clickable with a form. For most of §3 this beats curl.

> Access tokens expire after 30 minutes. If calls start returning 401, log in again.

---

## 3. Backend test scenarios

This is the substantial part. Each scenario states what to do and what should happen.

### 3.1 Sign-in and lockout

| # | Do this | Expect |
|---|---|---|
| 1.1 | Log in with a correct password | `200`, an access and refresh token |
| 1.2 | Log in with a **wrong** password | `401` |
| 1.3 | Log in with an **email that does not exist** | `401` — **identical message to 1.2** |
| 1.4 | Get 1.3 wrong ~10 times in a row | `429`, with a `Retry-After` header |
| 1.5 | After 1.4, try the *correct* password | Still `429` — the lockout is on the account and your IP |

**1.3 is the one to check carefully.** If the message differs from 1.2 in any way, that is a
security bug: it tells an attacker which email addresses have accounts here.

### 3.2 Permissions are enforced by the server

Log in as **Agus (PM)** and try:

| # | Call | Expect |
|---|---|---|
| 2.1 | `POST /purchase-orders` (raise one) | `201` — a PM may request |
| 2.2 | `POST /purchase-orders/{order_id}/approve` | `403` |
| 2.3 | `POST /depreciation/run` | `403` |
| 2.4 | `POST /incentives/disburse` | `403` |

Check the body of any `403`. It should name the action and **which roles would be allowed** —
the difference between "no" and "no, ask Finance". If it just says "forbidden", raise it.

### 3.3 The ledger will not accept a broken entry

`POST /journal-entries` with:

| # | Send | Expect |
|---|---|---|
| 3.1 | debits ≠ credits | `409`, "does not balance" |
| 3.2 | debits = credits | `201`, with an `entry_no` and a `voucher_no` |
| 3.3 | a line with **both** a debit and a credit | `422` |
| 3.4 | only one line | `422` — an entry needs at least two |
| 3.5 | a blank `memo` | `422` |
| 3.6 | an account code that does not exist | `409` |

```json
{
  "entry_date": "2026-07-20",
  "memo": "Manual test entry",
  "lines": [
    { "account": "1101", "debit": "1000000" },
    { "account": "3102", "credit": "1000000" }
  ],
  "source": { "kind": "manual" }
}
```

**There is no tolerance.** `1000000` against `999999.99` must be refused. If a one-rupiah
difference is accepted, that is a serious bug.

### 3.4 Journals cannot be edited or deleted

| # | Do this | Expect |
|---|---|---|
| 4.1 | Look for `PUT` / `PATCH` / `DELETE` on `/journal-entries/{id}` in `/docs` | **They do not exist** |
| 4.2 | `POST /journal-entries/{id}/reverse` | `201` — a *new* entry that mirrors the original |
| 4.3 | Fetch the original again | Unchanged, now with `reversed_by_id` set |

This is a client requirement, not a preference: corrections are reverse-and-repost, never
edits. The database rejects an edit even from raw SQL.

### 3.5 Withholding tax runs in **both** directions

The most important accounting rule in the system, and it was backwards in an earlier review
round. Test both halves.

**Money coming in** — the client withholds tax from what they pay us:

1. Create a client, then a quotation, send it, accept it, confirm the down payment
2. `POST /invoices/{id}/payments` with `withhold: true`

Then check `GET /reports/trial-balance`:

| Account | Should have moved |
|---|---|
| `1101` Cash | up by the **net** received |
| `1401` Prepaid Tax (an **asset**) | up by the tax withheld |
| `1201` Receivables | down by the **gross** |

**Money going out** — we withhold tax from a vendor:

1. `POST /purchase-orders` → `/{order_id}/approve` → `/{order_id}/pay-dp`

| Account | Should have moved |
|---|---|
| `2102` Payables | down by the **gross** |
| `2105` PPh 23 Payable (a **liability**) | up by the tax withheld |
| `1101` Cash | down by the **net** paid |

**What must never happen:** the two amounts netted off against each other, or the incoming
tax landing in a liability account. Money we have prepaid to the tax office is an **asset**;
money we have withheld and owe them is a **liability**. They are different things.

### 3.6 A purchase order is a commitment, not a debt

| # | Do this | Expect |
|---|---|---|
| 6.1 | `POST /purchase-orders`, then note the trial balance | — |
| 6.2 | `POST /purchase-orders/{order_id}/approve`, check the trial balance again | **Completely unchanged** |
| 6.3 | `POST /purchase-orders/{order_id}/pay-dp` | *Now* `2102` and `5101` move |

Approval must post nothing. An order placed is not money owed — the bill is raised at first
payment. If approval moves any account, raise it.

### 3.7 A billing plan is not a receivable

1. Accept a quotation with a phased payment schedule (try `"preset": "50"`)
2. `GET /invoices` — several will have status **`Scheduled`**
3. `GET /receivables/ageing`

Scheduled stages must **not** appear in the ageing. Only the issued invoice does. A plan to
bill somebody later is not money they owe you today.

Also check `GET /open-items` reconciles against account `1201`.

### 3.8 Depreciation

| # | Do this | Expect |
|---|---|---|
| 8.1 | `POST /fixed-assets` with cost 120,000,000, life 36 months | `201` |
| 8.2 | `GET /fixed-assets/{id}/schedule` | 36 rows |
| 8.3 | Check the **final row** | `accumulated` = cost − salvage, **exactly** |
| 8.4 | `POST /depreciation/run` with `{}` | Posts the backlog, oldest month first |
| 8.5 | **Run it again** | `posted: 0` — nothing posted twice |
| 8.6 | `GET /fixed-assets/register` | `reconciled: true` |
| 8.7 | `PATCH` the asset to a 60-month life | `200` |
| 8.8 | Check `posted_accumulated` | **Unchanged** — history is never restated |
| 8.9 | `PATCH` the asset trying to change `cost` | `422` |

**8.3 and 8.5 are the ones that matter.** A schedule that ends a few rupiah short of the
residual value means somebody writes off the difference by hand every month — the exact manual
work this feature exists to remove. And running twice must never double-post.

Try 8.3 with awkward numbers — a cost of 7 with a salvage of 1 over 37 months. It should
still land exactly.

### 3.9 Crew incentives need a project

| # | Do this | Expect |
|---|---|---|
| 9.1 | `POST /incentives/disburse` **without** `project_id` | `422`, and **nothing posted** |
| 9.2 | With a `project_id` that does not exist | `404`, nothing posted |
| 9.3 | With a valid one | `201` |
| 9.4 | The same one again | `409` |

After 9.1, check account `5102` has not moved. An untagged bonus lands on no project's P&L at
all, which is why it is refused rather than allowed through.

### 3.10 Petty cash cannot be issued anonymously

| # | Do this | Expect |
|---|---|---|
| 10.1 | `POST /procurement-requests` with `"requested_by": ""` | `422` |
| 10.2 | Top up petty cash, then check `GET /reports/cash-position` | **Total cash unchanged** |
| 10.3 | Settle an advance with **no receipt attached** | Refused |

10.2 catches a classic error: a top-up moves money from the bank to the float. It is a
transfer, not income. If total cash went up, money was invented.

### 3.11 The statements must balance

`GET /reports/balance-sheet` — **Assets = Liabilities + Equity**, exactly.

Two rows are computed live and never posted; both must be present:

- **Provision for Income Tax**, under liabilities
- **Current Period Earnings (NPAT)**, under equity

Now `PATCH /tax-config/corporate` and change the rate. Re-fetch the balance sheet: **both rows
should move immediately, and it must still balance.** If it stops balancing, that is the most
serious class of bug in this system — raise it straight away with the request you sent.

Also check `GET /reports/trial-balance` — total debits = total credits.

### 3.12 Scheduled jobs

| # | Do this | Expect |
|---|---|---|
| 12.1 | `GET /jobs` | **Five** jobs listed |
| 12.2 | `POST /jobs/crm.ltv_recompute/run` | `skipped`, with a reason |
| 12.3 | `POST /jobs/depreciation.month_end/run` | `succeeded` or `skipped` |
| 12.4 | Run 12.3 again | Same run returned; nothing posted twice |
| 12.5 | `GET /reminders` | Whatever the daily jobs raised |

**12.2 is correct behaviour, not a bug.** Lifetime value is calculated fresh every time it is
read, so a weekly job to recalculate it has nothing to do. It stays listed so the screen still
shows five jobs and the reason is visible.

---

## 4. Frontend test scenarios

Remember [§0](#0-what-is-real-today): reading and saving are wired, apart from the list of exceptions there.

### 4.1 Sign-in

| # | Do this | Expect |
|---|---|---|
| F1.1 | Open http://localhost:5273 | The sign-in screen, not the dashboard |
| F1.2 | Click a demo account, then **Sign in** | The dashboard |
| F1.3 | **Refresh the page** | Still signed in |
| F1.4 | Wrong password | An error, and you stay put |
| F1.5 | Avatar menu → **Sign out**, then refresh | Back to sign-in |

### 4.2 Switching role actually signs you in as that person

| # | Do this | Expect |
|---|---|---|
| F2.1 | Avatar menu → pick **Project Manager** | Brief pause, then the app reloads as Agus P. |
| F2.2 | Check the sidebar | Fewer sections than the CEO sees |
| F2.3 | Open **Purchase Orders** as the PM | No approve button |

This used to be cosmetic — it flipped a label and hid buttons. It now genuinely signs in as
that person, so the server refuses what they may not do regardless of what the screen shows.

### 4.3 Data is live

| # | Do this | Expect |
|---|---|---|
| F3.1 | Sign in and watch the bottom-right | "Loading live data…" briefly, then nothing |
| F3.2 | Open **Accounting** | Journal entries from the database |
| F3.3 | Compare against `GET /journal-entries` in `/docs` | Same entries |
| F3.4 | **Stop the backend** (Ctrl-C), then reload the app | An **amber banner**: "Showing demo data — the API is not reachable" |
| F3.5 | Restart the backend, click **Try again** | Banner clears, live data returns |

**F3.4 is deliberate and worth checking properly.** When the API cannot be reached the app
falls back to demo data rather than showing a blank screen — but it must *say so*. A plausible
balance sheet with no warning is worse than an error, because nobody has any reason to doubt
it. If the banner does not appear, raise it.

### 4.4 The numbers agree with the API

Pick any screen with a total and check it against the API. The frontend currently computes
some figures itself, so this comparison is exactly where a mismatch would hide.

| Screen | Compare against |
|---|---|
| Finance / Dashboard cash | `GET /reports/cash-position` |
| Receivables total | `GET /receivables/ageing` |
| Payables total | `GET /payables/ageing` |
| Project P&L | `GET /reports/project-pnl?project_id=…` |
| Fixed Assets register | `GET /fixed-assets/register` |

**Any disagreement is a real finding — please report it** with both numbers and the screen.
Aligning these is the next phase of work, so you may well find something.

---

## 5. What is deliberately not built

Not bugs. Do not raise them.

- **Multi-currency.** IDR only
- **Multi-company.** One entity. Whether Jakarta / Bali / Singapore are separate books is an
  open question with the client
- **VAT (PPN).** In the chart of accounts, not switched on — awaiting confirmation of the
  company's tax status
- **PPh 21 / full payroll.** Only crew incentives are in scope
- **Email, WhatsApp, notifications.** Reminders are rows in the database, not messages
- **File uploads on the frontend.** The API stores real files; the UI does not send them yet
- **Deployment.** Local only, by design for now

Full list with reasoning: `docs/finance-backend/07-open-questions.md`.

---

## 6. Raising a bug

Please include:

1. **What you did** — the exact request, or the click path
2. **What you expected**, and why
3. **What happened** — the full response body, not just the status code
4. **Which half** — API or frontend
5. **Who you were signed in as** — most surprises are permissions
6. The `X-Request-ID` response header if there is one; it ties your call to the server log

Two things worth escalating immediately rather than filing normally:

- **The balance sheet does not balance**
- **A journal entry was accepted that does not balance**

Both mean the books can hold a wrong number, which is the one thing this system exists to
prevent.

---

## 7. Troubleshooting

**Docker will not start / "WSL update required"**

Usually memory, not WSL. Docker needs ~2 GB and this has repeatedly been the blocker on the
development machine.

```bash
wsl --shutdown
# then restart Docker Desktop
```

If it persists, close browser windows and other applications, and cap WSL by creating
`C:\Users\<you>\.wslconfig`:

```ini
[wsl2]
memory=2GB
processors=2
autoMemoryReclaim=gradual
```

**Tests or requests time out**

Almost always the database being unreachable rather than a code fault. Check
`docker compose ps` and `curl localhost:8000/health` first.

**"Connection refused" on port 5432**

The database is on **5433**, deliberately. A native PostgreSQL service commonly already owns
5432, and Docker only wins half of it — so `localhost:5432` silently reaches the wrong server
and fails to authenticate against a perfectly healthy container.

**The frontend shows demo data with an amber banner**

The backend is not running, or `VITE_API_URL` is wrong. Check `erp-frontend/.env`.

**Everything returns 401**

Your access token expired — they last 30 minutes. Log in again.

**Everything returns 429**

You tripped the sign-in lockout. Wait 15 minutes, or restart the backend (the counter is held
in memory).

---

## 8. Running the automated suites

Worth doing before a manual pass — if these fail, manual testing will only rediscover it.

```bash
cd erp-backend
pytest -q                        # 494 tests, ~3–9 minutes
pytest -m phase7                 # one phase
pytest -m "not slow"             # skip the long depreciation runs
```

```bash
cd erp-frontend
npm run verify                   # ledger + flow + adapter checks, no backend needed
npm run verify:api               # needs the backend running
```

The backend suite runs against real PostgreSQL — the rules that matter are enforced by
database triggers, so an in-memory database would prove nothing.
