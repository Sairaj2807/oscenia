# Oscenia: where things stand (go-live status)

**Written 17 Oct 2026.** If you are picking this up cold, read this first, then
[`deploy/vps/README.md`](../deploy/vps/README.md) (how production runs) and
[`finance-backend/STATUS.md`](./finance-backend/STATUS.md) (the backend's history).

## In one paragraph

The marketing website, the ERP and its API are **live on one domain, `https://osceniaevents.com`**, on a
shared VPS. `/` is the website, `/erp/` is the ERP, `/api/*` is the API. Sign-in is real: there are no demo
accounts and no offline mode in the deployed build. One user exists (the CEO, Sairaj Bangar). **There are
no backups yet**, the AI minutes key is not set, and the branch is committed but **not pushed or merged**.

## What is live

| URL | What | Served by |
|---|---|---|
| `https://osceniaevents.com/` | marketing website | Nginx, static, `/var/www/oscenia/site` |
| `https://osceniaevents.com/erp/` | ERP single-page app | Nginx, static, `/var/www/oscenia/site/erp` |
| `https://osceniaevents.com/api/*`, `/health` | ERP API (FastAPI) | Nginx → `127.0.0.1:8010` → `oscenia-api.service` |
| (private) | PostgreSQL 16, database `oscenia_erp` | `127.0.0.1:5432`, localhost only |

The server also runs unrelated production services (trading, Telegram, a CRM, OpenVPN, OpenLiteSpeed). None
of them was stopped or restarted. See [`deploy/vps/README.md`](../deploy/vps/README.md) for the wiring,
limits (700 MB cap, lowest kill priority), swap, paths and rollback.

## What was done (all dated 17 Oct 2026)

**Repository**
- This folder is now the repo root. The site moved to `website/` (history kept as renames); the ERP came in as
  `erp-frontend/` (React) and `erp-backend/` (FastAPI), with `deploy/`, `docs/` and CI.
- The committed ERP build (`public/erp`) and the Vercel files are gone: bundles are built from source.
- Branch `feature/erp-integration`, a series of commits on top of `origin/main` (a fast-forward). **Not pushed.**

**Real login only**
- Demo mode (offline sign-in, demo accounts, the role switcher, the "Prototype" badge) exists only under
  `vite dev` and the test suites. `import.meta.env.PROD` removes it from every built bundle.
- Pages are guarded by role. A failed data load shows an error with a retry, never stand-in figures.
- First user: the CEO, created on the server. Everyone else is added from the **Users** screen.

**Access control on the server** (the main security fix)
- About 70 read routes and 14 writes used to answer any signed-in user. They now check the caller's modules
  against one table, `erp-backend/app/core/access.py`. `tests/test_access_policy.py` (423 cases) fails if a route
  is left open, so the next endpoint cannot slip through.
- Not row-level scoping: a role that holds a module sees that module's data company-wide (see decisions below).
- A refused collection loads as empty instead of failing the whole first load. This also fixed Sales and
  Warehouse logins, which never loaded any data before.

**Production setup** (native, no Docker; the box is shared and keeps Nginx on 80/443)
- PostgreSQL 16 (apt, tuned small), the API as a sandboxed systemd service, a 2 GB swapfile with
  `swappiness=10`, a new Nginx site config with the Certbot lines unchanged, static builds shipped as releases
  with an atomic symlink switch. Details and rollback: `deploy/vps/README.md`.
- The Docker + Caddy stack in `deploy/` was built and run locally and works; it is for local rehearsal or a
  future dedicated server. It cannot run on this VPS.

**Bugs found only by testing the real setup, and fixed**
1. The ERP bundle shipped with its API address rewritten to `C:/Program Files/Git/api/v1` by Git Bash. The
   shipping script now disables that rewrite and refuses such a bundle.
2. The Project P&L and Profit Simulator crashed on an empty database (a new install has no projects). Both now
   show "No projects yet"; the render check has a fourth pass on an empty database.
3. `/about/` and `/services/` answered 403 (real folders share the pages' names). The old production config did
   too. Fixed in the new one.
4. A relative API base (`/api/v1`) threw "Invalid URL" in the browser; the Node tests could not see it.
5. The e2e scripts and one backend test pointed at the old `erp-prototype/` folder; fixed.

## How it was verified

| Check | Result |
|---|---|
| Backend `pytest` (full suite, Python 3.14) | 2,125 passed, 4 failed; the 4 were my policy contradicting earlier decisions or a shared-client test bug, all fixed and rerun |
| New access-policy tests | 423 passed |
| `ruff check`, `mypy app` (strict) | clean |
| Frontend `npm run verify` (1,147 checks) + `verify:role-load` | pass |
| `npm run verify:render` (every route, 4 passes incl. empty database, Bahasa) | pass |
| Finance click-through `finance-live-e2e.mjs` | 55 of 55 |
| Production-build browser check on the Docker stack (`stack-e2e.cjs`) | 18 of 18 |
| Browser check on the **live domain** as the CEO | sign-in works, demo login refused, all 27 ERP screens render on the empty database, no script errors |
| Public routes over HTTPS | `/`, `/about/`, `/services/`, `/erp/`, deep links, `/health`, `/api` (401 without a token), WebSocket handshake |

**Not run:** the other click-throughs (`chat`, `events`, `media`, `public-live-e2e.mjs`; their paths were fixed
but they were not executed); Let's Encrypt renewal was not re-tested; no load testing; the backend suite was not
rerun after the last frontend-only fixes (they did not touch the backend).

## What is NOT done

| | |
|---|---|
| **Backups** | **None.** Nightly `pg_dump` plus `/srv/oscenia/uploads`, copied off the box, with a restore rehearsal. Do this before real data goes in |
| **AI meeting minutes** | Off until `AI_API_KEY` is set in `/srv/oscenia/api.env` (owner will provide it later) |
| **Push / merge** | Branch is local only. After pushing, merge to `main`. The old server checkout `/var/www/oscenia-web` must not be pulled once `main` has the new layout |
| **SSH access** | By root password, which was shared in chat. SSH keys with a non-root deploy user, and a rotated password, are still advised (the owner chose to defer) |
| **CEO in the workspace/chat** | The CEO has no workspace role, so Team Chat answers 403 ("not in the workspace yet"). Add one if the CEO should use chat and tasks |
| **Users** | Only the CEO exists. Create the team from the Users screen |
| **Sending** | WhatsApp, email and push are not built. Invitations, reminders, greetings and campaigns record intent and send nothing |
| **Reminders and broadcasts** | 8 of 48 event actions are not on the server (add/update/remove/send reminder, send/cancel/retry broadcast) |
| **Other unwired** | Logging an unplanned cost (budgets have no screen), some MoU template editing actions, Google Calendar sign-in, live calls (audio/video/screen share) |
| **Monitoring** | Only `/health`. No uptime alerts, log shipping or error tracking |
| **Docs** | The dated client-feedback records still use the old paths on purpose; each has a note at the top |

## Decisions still open

1. **Warehouse (and every business role) can still read the whole journal**, projects and vendors. The dashboard
   and project figures are computed in the browser from the full ledger. Tightening it needs role-scoped
   server summaries. Product decision.
2. **A PM may read the financial statements.** An existing test says so ("a PM oversees the budget"); kept.
3. **A 403 on a collection now means "empty for this role"**, not an error.
4. **Accounting questions for the client** (from `docs/finance-backend/07-open-questions.md`): is Oscenia a PKP
   (VAT on)? defer down-payment revenue? one legal entity or three? SGD for Singapore? migrate existing books?
   Per-document tax mode on the PDFs, and partial warehouse checkout, are still waiting.

## Risks to keep in mind

- **Shared server, one core, 3.8 GB RAM.** The API is capped (700 MB), runs at low priority and is the first
  thing the kernel will kill; swap is 2 GB. Still, a runaway process there can hurt neighbours, and vice versa.
- **No backups** (above). The database is the only copy of the data.
- **Secrets** live only in `/srv/oscenia/api.env` (mode 600) and as password hashes in the database. Nothing
  sensitive is in git. The CEO's password was chosen by the owner; it is long enough but guessable, so change it
  after the first login (top-right menu → Change password).
- **Windows build trap:** building from Git Bash rewrites values like `/api/v1`. Use `deploy/vps/ship-static.sh`,
  which guards against it.

## For a new session (or a new person)

1. Run `bash deploy/vps/smoke-test.sh`: ten public checks, no credentials, tells you in seconds whether production is up.
2. Read this file, then `deploy/vps/README.md`.
3. Server access is `deploy/vps/ssh-run.py` with the root password in the `VPS_PW` environment variable. The password is
   not stored anywhere; ask the owner. Read-only probes are fine; ask before any change (the server is shared).
4. When you finish, update this file, the runbook if production changed, and the Claude memory notes.

## How to update production

- **Website / ERP:** `VPS_HOST=… deploy/vps/ship-static.sh` (builds on your machine, ships a release, atomic switch).
- **Backend:** `VPS_HOST=… deploy/vps/update-api.sh` (ships the committed code, runs migrations on restart).
- **Rollback:** repoint the `site` symlink, restore the Nginx backup in `/root/nginx-backup/`, or swap
  `erp-backend.prev` back. Exact commands are in `deploy/vps/README.md`.

## How to test locally

See the root [`README.md`](../README.md): website `npm run dev`, ERP `npm run dev` (demo mode), ERP against a
local backend, and the Docker stack. Checks: `npm run verify` / `verify:render` in `erp-frontend/`, `pytest` in
`erp-backend/`, and `node scripts/stack-e2e.cjs` / `finance-live-e2e.mjs` for browser runs.
