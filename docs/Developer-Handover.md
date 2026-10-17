# Oscenia ERP — Developer Handover

> **Update, 17 Oct 2026.** This repository is now one monorepo deployed on one VPS (`https://osceniaevents.com`). Read [GO-LIVE-STATUS](./GO-LIVE-STATUS.md) first, then [deploy/vps/README](../deploy/vps/README.md). Path changes: `erp-frontend/` is now `erp-frontend/`, `oscenia-web/` is now `website/`. Deploys are no longer by Vercel CLI. Production has real login only (demo mode is dev and tests only), pages are role-guarded and the API gates reads by module. Where this document disagrees with that, the newer docs win.


For the full-stack developer who will turn the clickable prototype into the real product (backend + production frontend).

Written 5 Oct 2026 from the code on branch `feature/pm-events-prototype` (commit `72faa63`), updated the same day for client feedback round 4 (journal pop-up, two dates, free-text guest tables; commits `360fc8e` … `43169ff`). Paths are relative to the repo root. Where something was not verified it says **check**.

---

## 1. Purpose and status

**What the product is.** An operating system for **Oscenia Events**, an event-management company in Jakarta, Bali and Singapore. It has four areas:

| Area | What it covers |
|---|---|
| **ERP (finance and operations)** | Quotations and MoU, projects and stages, invoicing, AR/AP, cash, double-entry accounting, chart of accounts, fixed assets, budgeting, vendors, purchase orders, procurement and petty cash, warehouse, crew incentives, sales report |
| **Project workspace and team chat** | Tasks with two-stage approval, blocked/overdue boards, Discord-style chat per project, DMs, simulated calls, meeting minutes with AI |
| **Events and invitations** | Invitation templates and editor, client edit link with review/publish, guest page with RSVP and QR, sending by WhatsApp/email, reminders, check-in desk, attendance report |
| **CRM** | Clients, Client 360, guest contacts with marketing consent, relationship calendar, Google Calendar, campaigns |

Everything hangs off one **Project ID** (for example `EVT-2026-GALA-01`). A quotation becomes a deal, the down payment creates the project, and invoices, POs, journal entries, warehouse moves, tasks, chat channels and events all point at that ID.

**Status.** This is a **front-end prototype**. The client has reviewed it over four feedback rounds (plus two earlier rounds on the finance screens). Each round's asks are built; round 4's status and known limits are in `docs/Client-Feedback-Round-4.md`.

- Live demo: https://oscenia-web.vercel.app/erp (sign in with a demo account, see §2).
- Feature walkthrough for the client: `docs/Prototype-Demo-Guide.md` (also `docs/Oscenia-Prototype-Demo-Guide.pdf`). **This is the best map of features.** Read it with the app open.

**Important: a finance backend already exists.** It is not just a prototype:

| Part | State |
|---|---|
| `erp-backend/` | FastAPI + PostgreSQL 16 backend for the **finance** scope. 8 phases complete. **573 pytest tests passing** (round 4, 5 Oct 2026), ruff and mypy (strict) clean, and about 109 paths / 133 operations, all authenticated. Not deployed anywhere. |
| `docs/finance-backend/` | Full spec: architecture, data model, accounting rules, API contract, build plan, test spec, open questions, wiring plan, STATUS. |
| Wiring (prototype ↔ API) | W1 (auth) and W2 (reads) done. W3 (writes) **partly** done. See §5.3 and §8.2. |
| Workspace, chat, events, CRM relationship layer, vendor lifecycle, PO delivery status, Template Studio | **No backend at all.** Front end only, saved in the browser. |

---

## 2. Quick start

### 2.1 Prerequisites

- Node 20+ and npm (the prototype uses Vite 8, React 19).
- For the backend: Docker Desktop (Postgres 16 on host port **5433**), Python 3.12+. See `TESTING.md` §1 and §7.

### 2.2 Run the prototype (no backend: offline demo mode)

```bash
cd erp-frontend
npm install
npm run dev        # http://localhost:5273  (vite.config.js: port 5273)
```

> `TESTING.md` says 5173 for the prototype. That is wrong; `vite.config.js` sets **5273**. The marketing site (`oscenia-web`) uses 5173.

With no backend running, sign-in fails to reach the API and falls back to **offline demo mode** (`src/store/useAuth.js`). That is what the live Vercel demo does.

### 2.3 Run with the finance backend

```bash
cd erp-backend
docker compose up -d db
python -m venv .venv && source .venv/Scripts/activate   # Git Bash on Windows
pip install -e ".[dev]"
cp .env.example .env
alembic upgrade head
python -m app.seed.demo --as-of 2026-07-26
uvicorn app.main:app --reload                           # http://localhost:8000, docs at /docs

cd ../erp-prototype
# create .env with VITE_API_URL=http://localhost:8000/api/v1
# (erp-frontend/.env.example exists locally but is NOT tracked: root .gitignore excludes .env.*)
npm run dev
```

Health check: `curl localhost:8000/health` should return `"database":"ok"`.

### 2.4 Sign-in, roles and "Viewing as"

Two separate identity layers exist. The backend will need to unify them (§8.2).

**ERP sign-in (5 roles).** Password for all: `oscenia-demo-2026`. Clicking a name under *Demo accounts* fills it in.

| Email | Person | Role |
|---|---|---|
| `rahmat@oscenia.co.id` | R. Hartono | CEO (everything) |
| `lina@oscenia.co.id` | Lina W. | Finance |
| `agus@oscenia.co.id` | Agus P. | Project Manager |
| `dinda@oscenia.co.id` | Dinda A. | Sales & Marketing |
| `bagus@oscenia.co.id` | Bagus S. | Warehouse & Ops |

The Topbar role switcher signs in as that role's demo user (`useAuth.switchRole`).

**Workspace/chat personas ("Viewing as").** A gold box on Workspace and Chat. Personas come from `src/store/protoSeed.js` `seedMembers` (M-01 Agus P. PM, M-02 Dinda A. Field leader, M-03 Maya S. Design leader, M-04 Hendra T. Production leader, staff Rina/Putri/Yoga/Sela, interns Kevin/Nadia). The persona is **per tab**, so two tabs can be two people. It is not tied to the ERP login.

### 2.5 Reset demo data

Workspace & Tasks → the ↺ button next to *Viewing as* (`useProto.resetDemo`). It restores workspace, chat, meetings, events, CRM, PO delivery, vendor stages and studio templates, clears IndexedDB media, and clears added clients and vendors, in every open tab. ERP finance data in offline mode is in memory and resets on refresh anyway.

### 2.6 Deploy today

Pushing to GitHub **does not deploy**. Deploys are manual from the CLI:

```bash
cd erp-frontend && npm run verify && npm run build
rm -rf ../oscenia-web/public/erp/assets
cp -r dist/assets ../oscenia-web/public/erp/assets
cp dist/index.html ../oscenia-web/public/erp/index.html
# commit the rebuilt files, then:
cd ../oscenia-web && npx vercel --prod --yes      # production
# or: npx vercel --yes                             # preview (sits behind Vercel login; share via a dashboard Share link)
```

- The production build uses `base: '/erp/'` (`erp-frontend/vite.config.js`). `oscenia-web/vercel.json` rewrites `/erp/(.*)` to `/erp/index.html`.
- Asset names are content-hashed, so delete the old `assets/` folder or stale files pile up in git.
- Editing `oscenia-web/src` does nothing for the ERP. The ERP source is `erp-frontend/src`.
- The only server code on Vercel is `oscenia-web/api/meeting-summary.js` (AI minutes, §6.13).

---

## 3. GitHub and source control

### 3.1 Which branch to use

- **Work from `feature/pm-events-prototype`.** It holds all prototype work, including invitations v2, the finance-backend rounds and the round-3 fixes. It is what is deployed at https://oscenia-web.vercel.app/erp.
- **`main` is behind and does not have this work.** Verified with `git rev-list --left-right --count main...feature/pm-events-prototype` → `0 85` when first written; after round 4 it is **95 commits ahead** of `main` and **0 behind**. It has **not** been merged into `main`. `main` has no `erp-backend/`, no `TESTING.md`, and an older prototype.
- **`feature/invitations-v2` is already merged** into `feature/pm-events-prototype` (merge commit `0ee75c9`). It is not needed.
- **Recommended before starting:** merge `feature/pm-events-prototype` into `main` (a fast-forward is possible, since `main` has nothing it lacks). That is the owner's decision and is **still pending** after round 4: it has **not** been done. Then branch new work off `main` and open PRs back into it. **Until that merge happens, branch off `feature/pm-events-prototype`.**

### 3.2 Repository

| | |
|---|---|
| Canonical URL | **https://github.com/rahuls18-damco/Oscenia-website-and-ERP** (private, default branch `main`) |
| Local `origin` | `https://github.com/RahulSinghal/Oscenia-website-and-ERP.git`. `gh repo view` on that name resolves to the `rahuls18-damco` repo, so the old URL is a GitHub redirect after a move or rename. Update it with `git remote set-url origin https://github.com/rahuls18-damco/Oscenia-website-and-ERP.git`. |
| Access | Private. The owner must add the new developer as a collaborator. |

```bash
git clone https://github.com/rahuls18-damco/Oscenia-website-and-ERP.git
cd Oscenia-website-and-ERP
git checkout feature/pm-events-prototype
```

### 3.3 Branches (verified with `git ls-remote --heads origin`)

| Branch | Tip | State |
|---|---|---|
| `main` | `1742c46` | Marketing-site work and an early prototype. Behind by 95 after round 4. |
| `feature/pm-events-prototype` | latest (round 4) | **Current.** Everything, including round 4 (`360fc8e` … the "Publish the round-4 prototype build to /erp" commit). Pushed to the remote and deployed to https://oscenia-web.vercel.app/erp on 5 Oct 2026. |
| `feature/invitations-v2` | `9b3f576` | Merged into pm-events. Also checked out as a second worktree at `E:/Master - slave/RR projects/Oscenia-invitations-v2`. |
| `erp-feedback-round-2` | `07f5faf` | Finance backend phases and W1/W2 wiring. Already contained in pm-events. |
| `erp-feedback-round-3` | `a8edec2` | Finance round 3 (posting preview, document dates, server search). Already contained in pm-events. Not in `main`. |

The old feature branches can be deleted after the merge to `main`.

### 3.4 Suggested flow for new work

1. Short-lived branches off `main` (after the merge), named `feature/<area>-<thing>` or `fix/<thing>`.
2. One PR per independently testable unit. CI does not exist yet (§3.7), so run the checks in §9 locally and say so in the PR.
3. Squash or rebase merge into `main`. Deploy from `main` only.

### 3.5 Commit conventions used so far

- Plain-English, imperative subject lines that describe the outcome, not the code. Examples: "Make chat Reply post in the main stream with a quote", "Publish the round-3 prototype build to /erp".
- Builds published to `/erp` get their own commit ("Publish … build to /erp" or "Rebuild /erp with …").
- Most commits are AI-assisted and end with a `Co-Authored-By: Claude … <noreply@anthropic.com>` trailer. All 120 commits are authored by `nitk.rahul.com`.

### 3.6 What is committed and what is ignored

- Root `.gitignore`: `**/node_modules`, `**/dist`, `*.log`, `*.local`, `.env`, `.env.*`, editor files, `.claude/settings.local.json`, two screen recordings.
- `erp-backend/.gitignore`: `.venv`, caches, `.env`, `var/` (uploaded files). `erp-backend/.env.example` is deliberately committed.
- `oscenia-web/.gitignore` ignores `.vercel` (the local project link).
- `erp-frontend/.gitignore` ignores `mobile-shots/`.
- **Built files are committed** under `oscenia-web/public/erp/` (that is how Vercel serves `/erp`). `erp-frontend/dist` is not committed.
- Several large binaries are committed at the root and in `docs/` (pptx, pdf, docx, one zip). They are client source material.
- **Do not commit** `Landing Page-20260828T033736Z-1-001.zip` at the repo root. It is untracked, about **309 MB**, over GitHub's 100 MB file limit.

### 3.7 CI and deploy hooks

- No `.github/` folder, so **no GitHub Actions**.
- `oscenia-web/vercel.json` and `erp-frontend/vercel.json` hold only rewrites and the function duration. No Git settings.
- `oscenia-web/.vercel/project.json` (ignored) links the folder to the Vercel project `oscenia-web`.
- Whether Vercel's Git integration is connected in the Vercel dashboard cannot be seen from the repo (**check**). In practice, pushes have not deployed; deploys are by CLI (§2.6).

### 3.8 Secrets and environment variables

- No `.env` file is tracked. Only `erp-backend/.env.example` is. A scan for common key patterns (OpenAI/DeepSeek `sk-`, AWS, GitHub tokens, private keys, Google API keys) found nothing in tracked source.
- The demo password `oscenia-demo-2026` and the backend's default `JWT_SECRET=dev-only-insecure-key-change-me-in-production` are in source on purpose. Both must change for production.
- `erp-backend/.env` exists locally (ignored).

| Variable | Read by | Where to set |
|---|---|---|
| `VITE_API_URL` | `erp-frontend/src/lib/api.js` (default `http://localhost:8000/api/v1`) | `erp-frontend/.env` at build time |
| `VITE_AI_SUMMARY` | `erp-frontend/src/lib/meetingAi.js` (`on` enables real AI) | build-time env for the prototype build |
| `BASE_URL` | Vite built-in, from `base` in `vite.config.js` | automatic |
| `AI_PROVIDER`, `AI_MODEL`, `DEEPSEEK_API_KEY`, `OPENAI_API_KEY` | `oscenia-web/api/meeting-summary.js` | Vercel project env vars |
| `PREVIEW_PORT` | `erp-frontend/scripts/preview-server.mjs` | shell, for the browser checks |
| `ENV`, `DEBUG`, `DATABASE_URL`, `TEST_DATABASE_URL`, `DB_ECHO`, `JWT_SECRET`, `ACCESS_TOKEN_MINUTES`, `REFRESH_TOKEN_DAYS`, `STORAGE_DIR`, `MAX_UPLOAD_BYTES`, `TIMEZONE`, plus `SCHEDULER_ENABLED`, `CORS_ORIGINS` and others in `erp-backend/app/core/config.py` | backend | `erp-backend/.env` |

---

## 4. Repo map

```
/
├─ README.md, TESTING.md          repo overview; manual test guide for backend + wired frontend
├─ docs/                          product, feedback and engineering docs (index in §11)
│  └─ finance-backend/            spec + STATUS for erp-backend
├─ erp-backend/                   FastAPI + Postgres finance API (app/, alembic/, tests/)
│  └─ app/
│     ├─ core/                    config, security (argon2 + JWT), rbac, money, clock, errors, throttle
│     ├─ domain/                  accounts, ap, ar, assets, auth, cash, ledger, masters, payroll, reports, search
│     ├─ jobs/                    APScheduler jobs, /jobs, /reminders
│     └─ seed/                    demo seed (python -m app.seed.demo)
├─ erp-frontend/                 the React prototype (the source of /erp)
│  ├─ DEMO-SCRIPT.md
│  ├─ scripts/                    verify suites and browser checks (§9)
│  └─ src/
│     ├─ main.jsx, App.jsx        BrowserRouter + every route
│     ├─ store/                   useStore (ERP), useProto (prototype modules), useAuth, seed, protoSeed, hydrate, adapters
│     ├─ lib/                     pure logic (ledger, accounts, billing, events, invites, ...) and API client
│     ├─ pages/                   one file per screen; events/, workspace/, public/ (guest pages)
│     ├─ components/              shared UI; chat/, crm/, events/, invite/, workspace/
│     └─ i18n/                    dict.js (EN → ID), index.js (useT)
└─ oscenia-web/                   marketing site (React + Vite)
   ├─ api/meeting-summary.js      Vercel function: AI minutes via DeepSeek/OpenAI
   └─ public/erp/                 COMMITTED build of erp-prototype
```

Key files to read first: `src/App.jsx`, `src/lib/roles.js`, `src/store/useStore.js` (about 3,470 lines), `src/store/useProto.js` (about 1,790 lines), `src/lib/ledger.js`, `src/store/hydrate.js`, `docs/finance-backend/03-accounting-rules.md`.

---

## 5. Architecture of the prototype

### 5.1 Two stores, and why

| Store | File | Holds | Persistence |
|---|---|---|---|
| `useStore` | `src/store/useStore.js` | ERP business data: projects, quotations, invoices, journal, accounts, vendors, POs, inventory, procurement, crew, assets, toasts, `lang`, `role` | **In memory.** Starts on `seed.js`. Replaced by `hydrate()` from the API when signed in online. Offline: lost on refresh, except added/edited clients (`oscenia-demo-clients`) and added vendors (`oscenia-demo-vendors`) in localStorage. |
| `useProto` | `src/store/useProto.js` | Workspace, chat, meetings, events, guests, scans, CRM relations, campaigns, Google Calendar, PO delivery, vendor stages, studio templates, notification read-state | **localStorage key `oscenia.proto`**, through zustand `persist`. |
| `useAuth` | `src/store/useAuth.js` | Who is signed in, token or offline session | tokens in localStorage (`oscenia.access`, `oscenia.refresh`); offline session in sessionStorage (`oscenia.offlineUser`) |

They are split because the ERP store is replaced wholesale by API data, while the prototype modules have no API and depend on two tabs agreeing (a guest RSVPs in one tab, staff see it in another). The split also marks the seam: `useProto` actions are the list of endpoints still to build.

### 5.2 `useProto` persistence details

- `VERSION = 6`. A saved copy from another version is dropped (`migrate: () => seedState()`), so a bump wipes every viewer's demo. Rounds 2–3 avoided bumps by adding new keys with defaults.
- `merge` keeps this tab's persona, defaults `customTemplates`, and patches in voice channels, the company `#general` and meeting links for older v5/v6 saves.
- `partialize` saves everything except functions and `personaId`.
- **Cross-tab sync:** a `storage` event on `oscenia.proto` calls `useProto.persist.rehydrate()`.
- **Quota:** writes go through `guardedLocalStorage`. When storage is full the change stays in this tab and a toast warns once.
- Other browser keys: `oscenia.sidebar.groups`, `oscenia.chat.collapsed`, `oscenia.checkpoint.<eventId>` (the device's check-in point), `oscenia.rsvp.<eventId>` (the guest who last replied on this device).

### 5.3 Data from the API (finance only)

- `src/lib/api.js`: one `request()` door. It adds the bearer token, converts snake_case ↔ camelCase, does a single shared refresh on 401, and throws `ApiError` from RFC 7807 problem JSON (403s include `permitted` roles). **Money stays a string**; never parse it to a float.
- `src/store/hydrate.js`: `loadAll()` loads 16 collections plus the paged journal, in dependency order. `loadSome(keys)` re-reads only what a write touched.
- `src/store/adapters.js`: API shape → the shape pages already expect. Rows carry both `id` (business number, e.g. `PO-3001`) and `uuid` (API key).
- `useStore.mutate()`: the one write door. It refuses when not hydrated ("Not connected to the API"), serialises writes, re-reads affected collections and toasts errors.
- `AuthGate` (`src/components/AuthGate.jsx`) hydrates after sign-in, copies the role into `useStore.role`, and shows an amber "Showing demo data — the API is not reachable" banner if hydration fails.
- **Round-4 money endpoints.** Confirm DP (`POST /quotations/{id}/confirm-down-payment`), receive payment (`POST /invoices/{id}/payments`, `?dry_run`), pay bill (`POST /bills/{entry_id}/payments`), pay vendor DP (`POST /purchase-orders/{id}/pay-dp`, `?dry_run`) and settle (`POST /purchase-orders/{id}/settle`) take optional `document_date` (stored as the payment's `source_document_date`; settle uses `invoice_date`), `tax_amount` (≥ 0, wins over `withhold`, refused above the gross) and `lines` (`[{account, debit, credit, note}]`, at least two). `lines` replaces the payment/receipt entry only, never a companion. The guard is `erp-backend/app/domain/ledger/overrides.py` (`apply_line_override`): the control account (1201 / 2102) moves by exactly the computed gross and only on its locked side; no line on the other control account or a sub-account of either; accounts exist, are active and are not headers; one side per line, non-negative, balanced. Refusals are 422. Details: `docs/finance-backend/STATUS.md` (Log, round 4).
- **Offline demo mode:** if `fetch` throws a `TypeError` (no server), a demo email and the demo password create a local session with the client-side permission matrix. A server answering "wrong password" is still a refusal.

### 5.4 Media and files

- `src/lib/mediaStore.js`: invitation and template media in **IndexedDB** `oscenia.media` (store `files`). Content keeps `{ key, name, size, type }`. Limits: photo JPG/PNG/WebP ≤ 15 MB (shrunk on upload by `lib/images.js`), video MP4/MOV/WebM ≤ 200 MB, music MP3/M4A ≤ 20 MB, checked by extension **and** MIME type. Missing files show a placeholder.
- `src/lib/attachments.js`: task and meeting files. PDF/JPG/PNG/DOCX, ≤ 10 MB, ≤ 10 per task. Files are kept whole only under 250 KB, inside a 1.5 MB total budget in localStorage; bigger ones keep only name and size.
- Vendor attachments and project design files are mock records (strings, or static seed in `seed.js` `seedAssets`).

### 5.5 The demo clock

- `DEMO_TODAY = '2026-07-26'` in `src/lib/format.js`. All ages, overdue labels, countdowns, RSVP windows and reminders use it, not the real date.
- `useProto` stamps actions with `demoNow()` (DEMO_TODAY plus wall-clock time) and never stamps earlier than its saved `clock`.
- Production: replace with the real clock, and per-event timezones (§8.2).

### 5.6 i18n

- `src/i18n/index.js` `useT()` returns `t(english)`. English strings are the keys. `src/i18n/dict.js` (about 1,830 lines) maps them to Bahasa Indonesia, falling back to English. The language is `useStore.lang`, toggled in the Topbar.
- Not translated on purpose: seed content, the guest invitation page (English only), template names, messages that go to guests.
- Production: move to message IDs (for example i18next or FormatJS). English-as-key breaks whenever copy changes.

### 5.7 Routing

`react-router-dom` v7 `BrowserRouter`, with `basename` from `BASE_URL` (`/erp` in production). All routes are in `src/App.jsx`:

- **Public (no sign-in, no layout):** `/invite/:eventId` (guest page, `?g=<token>` for a personal link), `/invite/:eventId/edit?key=<editToken>` (client link, `&tab=send`), `/walkin/:eventId`.
- **Staff (inside `AuthGate` + `Layout`):** `/`, `/projects`, `/projects/:id`, `/finance`, `/cash`, `/receivables`, `/payables`, `/pnl`, `/accounting`, `/accounts`, `/fixed-assets`, `/budgeting`, `/simulator`, `/cron`, `/survey`, `/crm`, `/crm/:id`, `/google-calendar`, `/vendors` (`?view=pipeline|po`), `/vendors/:id`, `/purchase-orders` (`?view=pipeline`), `/procurement`, `/warehouse`, `/payroll`, `/quotations`, `/sales`, `/workspace`, `/workspace/:projectId` (`?task=`), `/chat`, `/chat/:channelId` (`?meeting=`), `/events`, `/events/templates`, `/events/:id` (`?tab=`).
- Because `BrowserRouter` is used (not a data router), `useBlocker` is unavailable. Unsaved-change guards only cover tab close and some buttons.

### 5.8 Roles and permissions

`src/lib/roles.js` has two layers:

1. **Module visibility:** `ROLE_MODULES` + `canSee(role, module)`. Used only by the sidebar (`src/components/Sidebar.jsx`).
2. **Action permissions:** `ACTIONS` (22 actions) + `ROLE_ACTIONS` + `canDo(role, action)` + `denialReason()`. Gated buttons use `ActionButton` (`components/ui.jsx`), which disables itself and explains why.

| Role | Can see | Key actions |
|---|---|---|
| ceo | all | all |
| finance | finance group, quotations, projects, CRM, vendors, POs, procurement, payroll, sales, chat | post journal, CoA, assets, tax, approve cash/PO, pay PO, incentives, confirm DP |
| pm | dashboard, projects, P&L, budgeting, vendors, POs, procurement, warehouse, workspace, chat, events, templates | request PO/advance, expenses, stages, stock, **publish invitation**, **manage templates**. Never approves or pays. |
| sales | dashboard, quotations, projects, CRM, gcal, cron, sales, finance, P&L, receivables, events, chat | cancel quotation, advance stage, edit client, request PO |
| warehouse | dashboard, projects, warehouse, procurement, chat | stock, add stock, delivery orders, advances, expenses |

**Workspace and chat** use a different model: persona `workspaceRole` (pm / leader / staff / intern) and project/division membership, in `src/lib/workspaceAccess.js`. Every `useProto` action re-checks these rules.

**Warning: routes are not guarded.** Only the sidebar hides items. Typing a URL opens any staff page. Some pages (Template Studio) show a "not permitted" panel and store actions refuse, but this is courtesy. In the finance backend, RBAC is enforced server-side (`erp-backend/app/core/rbac.py`). Everything else needs server-side enforcement (§8.2).

### 5.9 Pure libraries vs UI

`src/lib/*.js` is plain JavaScript with explicit `.js` import extensions, so the verify scripts run under plain Node. Business rules live there and in store actions, not in components. Port the libs to the backend (or share them) as the rule book. Key ones: `ledger`, `accounts`, `postings` (round-4 planners and posting guard), `journalView`, `billing`, `depreciation`, `vouchers`, `vendors`, `workspaceAccess`, `chat`, `meetings`, `events`, `invites`, `templates`, `broadcasts`, `crm`, `notifications`.

### 5.10 Render-safety rule

`npm run verify:render` renders every route to a string on the server (`scripts/smoke.jsx`). So `window`, `localStorage`, `indexedDB`, `AudioContext` and timers must be touched only inside effects or event handlers, never during render. `scripts/smoke-session.js` plants an offline CEO session first. (`docs/finance-backend/STATUS.md` says this check was broken after W1; that note is out of date. `smoke-session.js` fixed it, and the check passes: it ran clean on the final round-3 code on 5 Oct 2026.)

---

## 6. Feature inventory

Format for each: what it does · screens · key files · store actions · rules · **simulated**. "API" means the action calls the finance backend when hydrated; otherwise it runs locally.

### 6.1 Dashboard
- KPIs (pipeline, weighted margin, receivables, cash, active projects), revenue/margin charts (recharts), executive summary. `pages/Dashboard.jsx`.
- Margin uses cost-at-completion (`projectMargin` in `lib/format.js`), not realised cost.
- Derived client-side from the store. Backend has `/reports/*` and `/ops/summary`.

### 6.2 Quotations & MoU
- Draft quotation with line items (sell + estimated cost → live margin), DP %, MoU template. Send, accept, decline. PDF quotation/MoU. MoU template manager (clauses). `pages/Quotations.jsx`, `components/TemplateManager.jsx`, `lib/pdf.js` (`quotationPDF`).
- Actions: `addQuotation`, `updateQuotation`, `sendQuotation`, `acceptQuotation`, `cancelQuotation`, `addMouTemplate` and the other template-clause actions.
- Rule: accepting creates the pending deal for Finance. Phased DP presets (50/75/100/custom) from `lib/billing.js`.
- Backend: `/quotations`, `/quotations/{id}/send|accept|decline|confirm-down-payment`, `/mou-templates`, `/billing/*`. Only DP confirmation is wired (others: **check**).

### 6.3 Projects & stages
- Pipeline board over 7 stages (`STAGES` in `seed.js`: DP Paid → Design Uploaded → Client Approval → Vendor Dispatch → Execution Event → Post-Event Feedback → Finished), timeline/Gantt, advance/revert/cancel. `pages/Projects.jsx`, `pages/ProjectDetail.jsx`.
- Actions: `advanceStage`, `moveProjectToStage`, `revertStage`, `cancelProject` (refundable vs non-refundable DP), `undoDownPayment` (API).
- **Simulated:** design-file versions and the project discussion thread on Project Detail are static seed (`seedAssets`, `seedThreads`). No upload.

### 6.4 Finance & Invoicing (group)

| Screen | Route / file | What it does | Main actions |
|---|---|---|---|
| Finance | `/finance`, `Finance.jsx` | Pending deal → **Confirm down payment** (creates the project, invoice and journal entry); installment invoices; invoice PDF | `confirmDownPayment` (API), `issueInvoice` (API), `receivePayment` |
| Total Cash | `/cash`, `Cash.jsx` | Cash by account, petty-cash top-up | `topUpPettyCash` |
| Accounts Receivable | `/receivables`, `Receivables.jsx` | Ageing, settle with PPh 23 withheld (`ReceivePaymentModal`) | `receivePayment` |
| Accounts Payable | `/payables`, `Payables.jsx` | Vendor bills, payment, ageing | `payVendorBill` |
| Project P&L | `/pnl`, `ProjectPnL.jsx` | Per-project revenue, cost and margin from postings; period compare; PDF/Excel/CSV | — |
| Accounting | `/accounting`, `Accounting.jsx` (largest page) | Journal, General Ledger (multi-filter), Income Statement, Balance Sheet, trial balance, tax settings, voucher-numbering editor, manual/adjust/reverse, journal voucher PDF | `postManualEntry`, `reverseEntryDocument`, `adjustEntryDocument` (API), `setTaxRate`, `toggleTax`, voucher-series actions (API) |
| Chart of Accounts | `/accounts`, `ChartOfAccounts.jsx` | Tree, sub-accounts, activate/deactivate | `addAccount`, `updateAccount`, `setAccountActive`, `deleteAccount` |
| Fixed Assets | `/fixed-assets`, `FixedAssets.jsx` | Register, schedule (straight-line/declining), month-end run, dispose | `capitaliseAsset`, `updateAsset`, `runDepreciation`, `disposeAsset` |
| Budgeting | `/budgeting`, `Budgeting.jsx` | Category ceilings vs actual, over-budget tolerance (default 10%) | `setBudgetTolerance`, `addUnplannedCost` (demo button) |
| Profit Simulator | `/simulator`, `Simulator.jsx` | What-if sliders, margin and break-even | none (pure UI) |

Rules (full list in `docs/finance-backend/03-accounting-rules.md`):
- Statements are **derived** from the journal (`lib/ledger.js`). Nothing derivable is stored.
- Journals are append-only. Correct by reverse-and-repost.
- A PO approval is a commitment. It posts nothing. The bill is raised at first payment.
- Scheduled billing stages are not receivables.
- PPh 23 runs both ways: withheld *from* us → asset 1401; withheld *by* us → liability 2105. Never netted.
- Revising an asset's life is prospective.
- Corporate tax (22%) drives a computed provision and NPAT.
- **Posting pop-up (round 4).** Confirm DP, receive payment, pay bill, pay vendor DP and settle PO open `components/PostingModal.jsx` (with `useConfirmPosting.js`) before anything posts. It shows the companion accruals read-only (DP invoice, vendor bill, PO variance) and the receipt/payment entry editable: both dates, memo, cash account, PPh 23 on/off and amount, and the lines. Lines follow the tax/amount/account fields until edited by hand; "Reset to calculated" rebuilds them. Invoice issue uses the same component, read-only.
  - `src/lib/postings.js`: pure planners (`planDpConfirm`, `planReceivePayment`, `planPayBill`, `planPayPoDp`, `planSettlePo`, `planIssueInvoice`) return what would post. The store actions post from the same planners, so pop-up and ledger cannot drift. `validateEdited` is the guard (run in the pop-up and again in the store): at least two lines; existing, active, non-header accounts; amounts judged as they will post (to the cent; a line that rounds to zero is refused); one side per line; balanced; the locked control line (Cr 1201 for client money, Dr 2102 for vendor money) keeps its account, side and amount; **no other line on 1201 or 2102 or a sub-account of either**; valid dates (receipt after received is a warning only). `postedWithholding` reads the PPh 23 that posted for the toasts.
  - **Two-date model:** the received date is the posting date (`entry.date`, backend `entry_date`) and every report, period filter and balance uses it. The date on the receipt / vendor invoice is `source.documentDate` (backend `source_document_date`) and changes no figure. The journal list shows the receipt date under the received date when they differ; the drawer shows both. Manual entry and Adjust take a receipt date too.
  - `src/lib/apiPostings.js`: request bodies for the live backend and the dry-run → plan mapping. Online the pop-up seeds from `?dry_run` (re-asked as dates/account/tax/amount change) and sends `lines` only when a line was edited and `tax_amount` only when a figure was typed. The memo is not sent (no money endpoint takes one), so live it is read-only.
  - `src/lib/journalView.js`: the Journal tab's type chips, search and "Hide reversed pairs" (on by default; only a plain pair hides, a reversal chain stays visible). List only; statements read every entry.
- Chart of accounts: 1201 and 2102 cannot take sub-accounts (prototype `validateAccountDraft` and backend `accounts/service.create`), because a sub-account would make the control account a header and break every receipt and payment.

**Simulated / not real:** offline, every posting is in memory. VAT (PPN) and PPh 21 are defined but off. IDR only, one entity. Excel export is an HTML `.xls`, not `.xlsx`.

### 6.5 Vendors
- Three views: **Vendors** table (tags, PPh 23 rate, NPWP, bank, PIC, 3-vendor comparison, catalogue with date-aware availability), **Vendor lifecycle** board, **PO pipeline** board. Vendor 360 at `/vendors/:id` (scorecards, attachments, POs, stage history). `pages/Vendors.jsx`, `pages/VendorDetail.jsx`, `components/VendorPipeline.jsx`, `components/PoPipeline.jsx`, `components/TagPicker.jsx`, `lib/vendors.js`.
- Lifecycle: Prospect → Onboarding → Approved → Active, plus On hold and Blacklisted. Five-item checklist: NPWP, bank + holder, PIC (read from the record), signed MoU and reference check (ticked by hand).
  - Approving needs the checklist complete and `approve_po`. Active comes with the first live PO. Hold and blacklist need a reason.
  - Only Approved/Active vendors can get a new PO or have a draft approved (`canOrderFrom`).
- Actions: `addVendor`, `setVendorTags` / `toggleVendorTag` (API), `updateVendorRate` (API), `addTag`, `renameTag`, `deleteTag`, `toggleCatalogueTag`. Lifecycle (in `useProto`): `setVendorStage`, `addVendorProspect`, `toggleVendorCheck`.
- **Simulated:** lifecycle stages are browser-only (`useProto.vendorStages`). Attachments are mock. There is no backend field for the stage.

### 6.6 Purchase Orders
- Table and pipeline (PO Issued → DP Paid → In Progress → Delivered/Completed → Fully Paid, with a five-step strip). Drafts and cancelled sit below. PO PDF. `pages/PurchaseOrders.jsx`, `components/PoPipeline.jsx`.
- Accounting statuses: `Draft`, `Approved`, `DP Paid`, `Settled`, `Cancelled`. A separate delivery status (Not started / In progress / Delivered) drives the board (`pipelineStage`).
- Actions: `createPurchaseOrder`, `approvePurchaseOrder`, `payPoDownPayment`, `settlePurchaseOrder` (variance posts first), `cancelPurchaseOrder` (reverses payments, releases catalogue bookings). The last four are **API when live**. `setPoDelivery` lives in `useProto`.
- Rules: DP withholds at the vendor's PPh 23 rate. Approval reserves catalogue stock (bookings carry `poId`).
- **Simulated:** delivery status is browser-only. It needs a PO column.
- `createPurchaseOrder` is not wired to `POST /purchase-orders` (**check**).

### 6.7 Procurement & petty cash
- Requests: Draft → Pending → Approved → Disbursed → Completed. Mandatory requester, proof of payment, settlement with actual vs variance, petty-cash float. `pages/Procurement.jsx`.
- Actions: `addProcurementRequest`, `setProcurementStatus`, `settleAdvance`, `topUpPettyCash` (a transfer, not income).
- **Simulated:** proof is a flag, not a file. Backend has `/procurement-requests/*` and `/attachments`, not wired.

### 6.8 Warehouse
- Dual logic: consumables (released to cost) and fixed assets (check out to a project → in transit → check in as Good / Damaged / Lost). Lost posts Asset Loss Expense at `unitValue × qty` and updates the asset register. Maintenance resolve. Delivery orders Draft → Dispatched → Received with signed PDF. `pages/Warehouse.jsx`.
- Actions: `checkOutAsset`, `checkInAsset`, `releaseConsumable`, `resolveMaintenance`, `addInventoryItem`, `advanceDeliveryOrder`.
- Backend: `/inventory/*` exists. **There is no delivery-order domain server-side.** Round-3 REQ-07 (partial checkout/dispatch) is waiting on the client.

### 6.9 Crew & Incentives, Survey
- Bonus = base rate × (client rating / 10), paid only above a threshold (default 7.0, editable). Disburse posts to the project. `pages/Payroll.jsx`, `pages/Survey.jsx` (reached from Payroll; not in the sidebar).
- Actions: `setBonusThreshold`, `submitSurvey`, `disburseIncentives`.
- **Simulated:** the survey is filled in by staff. A real client-facing survey link is needed. A hardcoded `_feedbackScores` map exists in the store.
- Backend: `/crew`, `/projects/{id}/feedback`, `/projects/{id}/incentives`, `/incentives/disburse`.

### 6.10 Sales report
- Leaderboard and commission from `seedSales`. `pages/Sales.jsx`.
- **Static seed.** No backend endpoint. Derive it from accepted quotations.

### 6.11 Automated Cron
- Lists jobs. "Run daily jobs now" produces birthday/anniversary reminders with editable WhatsApp/email drafts. `pages/Cron.jsx`, action `runCron`.
- **Simulated:** the matches are hardcoded in `runCron`. Backend has APScheduler with 5 jobs (`/jobs`, `/reminders`), off by default (`SCHEDULER_ENABLED`).

### 6.12 Workspace & Tasks
- Projects overview (open / approval / blocked / overdue), Blocked & overdue board with reasons, My tasks, Team & access (PM only). Task drawer: start, block (reason), submit, approve stage 1 (leader) and stage 2 (PM), reject (comment), activity trail, copy link, attachments. `pages/workspace/*`, `components/workspace/*`, `lib/workspaceAccess.js`.
- Actions: `createTask`, `startTask`, `blockTask`, `unblockTask`, `submitTask`, `approveTask`, `rejectTask`, `addAttachment`, `removeAttachment`, `toggleProjectDivision`, `toggleMemberProject`, `setPersona`.
- Rules:
  - Only the assignee submits. Nobody approves their own work (a leader's own task goes straight to the PM).
  - A leader can assign anyone in their division, which adds them to the project. Staff assign to peers and interns on their projects. Interns see only their own tasks and cannot assign.
  - Deep links are access-checked ("No access to this task").
- **Simulated:** all browser-only. Personas are not real users.

### 6.13 Team Chat
- Discord-style layout. Server rail (Oscenia + one per project), text channels (`#general` + one per division), voice channels (Meeting room per project, Lounge), DMs, presence, user status, grouping (7 min), mentions `@`, task links `#T-…` as cards, reactions, one **Reply** that posts at the bottom with a quote (threads removed in round 3; old `parentId` renders as a quote), edit/delete (15 min; PM deletes any), create task from message. `pages/Chat.jsx`, `components/chat/*`, `lib/chat.js`.
- Channel access: `access` = project / divisions / invite, allow list, block list, `listed` (hidden vs shown locked). Join requests decided by the PM or project division leaders. Actions: `createChannel`, `updateChannel`, `requestToJoin`, `decideJoinRequest`.
- Calls and meetings: `startCall`, `joinCall`, `toggleShare`, `leaveCall`, `addCallNote`, `addCallFile`. Each ended call becomes a meeting record (transcript, notes, files, Summary & MOM, access). Actions: `setMeetingAccess`, `saveMeetingSummary`, `createTasksFromMeeting` (never twice), `postMeetingSummary` (only when access = channel, never for DMs).
- Privacy: the PM reads minutes of channel calls, never DM calls. Not even the PM can open someone else's DM.
- Other actions: `postMessage`, `editMessage`, `deleteMessage`, `toggleReaction`, `openDm`, `setStatus`, `markRead`.
- **Backend status (feature/chat):** channels, DMs, join requests, messages (edit/delete window, reactions, quotes, mentions), read state, presence, attachments and real-time delivery now exist server-side (`erp-backend/app/domain/chat/`, endpoints under `/api/v1/chat`, WebSocket at `/api/v1/chat/ws`). The screens call it when signed in (the offline demo still runs on browser memory). Meetings and AI minutes are server-side too (see `finance-backend/STATUS.md`); **still simulated and without a server:** live calls (audio, video, screen share). Workspace tasks are built server-side (`/api/v1/tasks`, branch `feature/workspace`; a `<#T-…>` link in a message resolves to a task the reader may see).
- **Simulated:** no real-time sync between devices, no audio/video/screen share, presence of others is fake, transcript is simulated.
- **AI minutes:** `lib/meetingAi.js` calls `/api/meeting-summary` (Vercel function → DeepSeek `deepseek-chat`, or OpenAI `gpt-4o-mini` with `AI_PROVIDER=openai`) only when built with `VITE_AI_SUMMARY=on` and the key is set. Otherwise it shows the labelled demo summary (`demoMinutes` in `lib/meetings.js`). Signed in, minutes are written by the backend instead (`POST /chat/meetings/{id}/summary`): the key is `AI_API_KEY` in the backend environment, there is a per-person daily cap (`AI_MINUTES_PER_DAY`), and the Vercel function is only used by the offline demo build.

### 6.14 Notifications bell
- Derived, not stored (`lib/notifications.js` `notificationsFor`). Only read-state is kept (`useProto.notifRead`).
- Items: needs your approval (pinned), invitation to review (pinned), assigned, mentioned, blocked, sent back, approved, join requests and answers, new RSVP / declined, CRM nudges / birthdays / anniversaries.
- Workspace/chat items follow the persona; event/CRM items follow the ERP role. `components/NotificationBell.jsx`. Actions: `markNotificationRead`, `markAllNotificationsRead`.
- **Backend status:** `GET /api/v1/chat/notifications` derives the chat items (mentions, join requests and their answers) and `notification.new` delivers them live. Tasks, events and CRM items join when those modules have backends. A mention's read state is the channel's read marker (`chat_reads`); the other kinds keep client-side read state, as above.
- **Simulated:** in-app only. No push, email or WhatsApp.

### 6.15 Global search
- Topbar search. Online it calls `GET /search` (server-ranked, `searchEverything`). Offline it uses `searchLocally` (`lib/search.js`).
- It covers ERP data only, not workspace/chat/events (**check** before relying on it).

### 6.16 Events & Invitations
Screens: `/events` (list, New event with inline "+ New client"), `/events/:id` with tabs Invitation · Send invitations · Guests & RSVP · Reminders · Check-in · Attendance report. Plus `/events/templates` (Template Studio) and the public pages. Files: `pages/events/*`, `pages/public/*`, `components/events/*`, `components/invite/*`, `lib/events.js`, `lib/invites.js`, `lib/templates.js`, `lib/broadcasts.js`, `lib/music.js`. Product decisions D1–D14: `docs/Invitations-v2-Product.md`.

**Templates and editor**
- 6 built-in templates in `lib/templates.js` (Corporate: Gala, Launch, Summit; Private: Royal, Minimal, Garden). A template = shared sections + a skin (palette, fonts, cover layout, ornament).
- Sections live in `components/invite/sections.jsx` and are rendered by `InviteRenderer` (the same component for gallery, editor and guest page).
- The editor (`InviteEditor`, `SectionForms`) toggles and fills sections, uploads media and sets the accent colour.
- Actions: `chooseTemplate` (content kept on switch), `setSection`, `updateContent` (sanitised by `cleanSection`; links via `safeLink`, http/https only), `setAccent`.

**Template Studio (round 3)**
- `components/invite/TemplateStudio.jsx`: duplicate a built-in or start blank; colours, fonts, cover, ornament, artwork (cover background, page texture, frame PNG, ornament image), section order and defaults; live preview.
- Add to gallery, take out, archive and restore (no hard delete).
- Actions: `createTemplate`, `updateTemplate`, `setTemplateArt`, `publishTemplate`, `unpublishTemplate`, `archiveTemplate`. Gated by `manage_templates`. Validated by `validateTemplate`.
- Unknown template ids render as Gala.

**Client link and review**
- `/invite/:eventId/edit?key=` opens the same studio in client mode. The key is compared **in the browser** against `event.editToken`.
- Actions: `submitForReview`, `returnToClient` (note), `publishInvite` (copies draft → `published` and details → event fields; offers to clamp the RSVP deadline), `unpublish`, `regenerateEditToken` (revoke).
- `inviteChanges` drives `ReviewPanel`. It lists changes and which reminders move if the date changed. Publishing needs `publish_invitation` (CEO, PM).
- Edits to a live invitation stay a draft until republished.

**Guest page** (`pages/public/InvitePage.jsx`, `components/invite/guest.jsx`, `Rsvp.jsx`)
- Cover gate with the guest's name (`?g=token`). Music: built-in Web Audio loops or an upload. Countdown + `.ics` (`icsFile`, fixed TZID Asia/Jakarta, 3-hour entries). Gallery lightbox, video (YouTube/Vimeo or upload), gifts with copy buttons.
- RSVP: name and phone always; email, allergies, pax ≤ 50 (`MAX_PAX_LIMIT`); up to 10 custom questions (text / choice / dropdown, required, attending-only). Marketing consent is unticked by default.
- After replying: a QR access card. "Change my reply" works until the deadline. The device remembers the guest.
- Wishes, with an optional hold for approval. Limits in `WISH_LIMITS` (3 per guest, 500 characters, 500 per event).
- Actions: `submitRsvp` (matched by phone, or by email only if one unreplied guest has it, `matchGuest`), `addWish`, `setHoldWishes`, `setWishHidden`, `approveWish`.

**Send invitations** (`components/invite/SendInvitations.jsx`)
- Platform send (staff): WhatsApp / email / both. Placeholders `{name} {link} {event} {date} {venue}` (`{link}` required). Audience: all / not invited yet / category. Send now or schedule. Per-recipient status. Retry failed. Add email inline.
- Rules: `broadcastProblem` refuses unpublished or past events, empty or too-long messages, missing `{link}`, missing subject, empty audience, bad schedule time.
- Client self-send: a `wa.me` link per guest with their personal link; copy message / copy all links; "Sent by client".
- Actions: `sendBroadcast`, `sendScheduledNow`, `cancelBroadcast`, `retryFailed`, `setGuestEmail`, `markSentByClient`.

**Guests, reminders, check-in, report**
- Guests & RSVP (`GuestsTab`): filters, categories (VIP/Media/Regular/Vendor), tables, answers tally, personal link copy, CSV import (`parseGuestCsv`, dedupe by phone) and export. Actions: `addGuests`, `setGuestTable`, `setGuestCategory`, `setGuestNote`, `addTable`.
- Questions: `addQuestion`, `updateQuestion`, `moveQuestion`, `removeQuestion` (hidden, answers kept).
- Reminders (`RemindersTab`): D-n before (attending / not replied) and D+n after (came / did not come), channel, template with `{feedback}`, send log. Actions: `addReminder`, `updateReminder`, `removeReminder`, `sendReminderNow`.
- Check-in (`CheckInTab`): device checkpoint ("Scanning at"), checkpoint categories, repeat-scan and category warnings (staff can override), scan log + CSV, walk-in QR → `/walkin/:eventId` (`registerWalkIn`, added to CRM with consent). Actions: `scanGuest`, `checkIn`, `undoCheckIn`, `addCheckpoint`, `updateCheckpoint`, `removeCheckpoint`.
- QR payload is `OSCENIA:<eventId>:<guestId>` (`qrPayload` / `parseQr`).
- Attendance report (`ReportTab`): a 4-cell reconciliation (`reconcile`), internal notes on no-shows, export.
- Other event actions: `createEvent`, `updateEvent`.

**Simulated:** no message is sent (statuses come from a hash in `deliveryOf`). Scheduled batches and reminders never fire on their own. The QR camera is a tap-to-pick list. Media and studio templates exist only in this browser. Built-in music tracks are synthesised placeholders. A guest on another device does not reach staff.

### 6.17 CRM
- **Clients** (`pages/CRM.jsx`): search, add, inline edit, "Coming up" card.
- **Client 360** (`pages/ClientDetail.jsx`, `components/crm/ClientRelations.jsx`): computed LTV (`clientLTV`), event history, interaction log (CRUD, API when live), PICs with birthdays (`MM-DD`) and greeting settings, event cycles with nudges, company anniversary greetings.
- **Guest contacts** (`components/crm/GuestContacts.jsx`): every event's guests merged by phone, consent with date and source, tick boxes, campaigns sent only to consented contacts (`campaignAudience`).
- **Relationship calendar** (`RelationshipCalendar.jsx`, `CalendarView.jsx`): list (30/60/90 days) and month view, log outreach, send greeting (once per person, occasion and year).
- **Google Calendar** (`/google-calendar`, `pages/GoogleCalendar.jsx`): connect card + month view with Google events in blue.
- Actions: `addClient`, `updateClient`, `logInteraction`, `updateInteraction`, `deleteInteraction` (API when live), `attachToInteraction`; `updateRelation`, `savePic`, `removePic`, `handleNudge`, `sendGreeting`, `createCampaign`, `connectGoogle`, `disconnectGoogle`, `setGoogleOption` (in `useProto`).
- **Simulated:** Google sign-in and events (`seedGoogleEvents`), greetings, campaigns. The relationship layer has no backend.

### 6.18 Exports and PDF
- `lib/exports.js`: CSV and `.xls` (an HTML table).
- `lib/pdf.js` (jsPDF): journal voucher, invoice, quotation/MoU, delivery order, purchase order, attachment, P&L.
- Production: generate PDFs server-side for consistent, archivable documents (§8.2).

---

## 7. Data model

The **Project ID** (business number, e.g. `EVT-2026-GALA-01`) is the spine. In the backend, every row also has a UUID; pages keep the business number as `id` and the UUID as `uuid`.

### 7.1 ERP entities (`src/store/seed.js`; the backend schema is in `docs/finance-backend/02-data-model.md`)

| Entity | Key fields | Links |
|---|---|---|
| Client | id `CL-nn`, name, contact, email, phone, birthday, anniversary, personalBrand, prefEvents, favVendor, satisfaction | projects, quotations, events, relations, interactions |
| Quotation | id `QT-nnnn`, template, client, eventType, eventDate, status (Draft/Sent/Accepted/Declined), dpPercent, lineItems[{label, amount, estCost}], projectId | client → deal → project |
| Deal | id, client, contractValue, dpAmount, projectIdOnConfirm | becomes the project on DP |
| Project | id, name, client, stage, division, contractValue, estimatedCost, realizedCost (derived in the backend), eventDate, pm, stageSince | everything |
| Invoice | id `INV-nnnn`, project, type (Down Payment/Progress/Final), amount, paid (derived in the backend), status (incl. Scheduled), due, document date | project, journal |
| Journal entry | id/entryNo, voucherNo, date, project, memo, lines[{account, debit, credit, note}], source {kind, ref}, reversal links | accounts, project, source document |
| Account | code (e.g. 1101), name, type, parent, active, header | journal lines |
| Tax config | pph23 / pph21 / ppn / corporate: rate, active, account | postings |
| Voucher series | key, prefix, format tokens, reset cadence; counters | journal |
| Fixed asset | id `FA-nnn`, inventoryId, acquiredOn, cost, salvage, usefulLifeMonths, method, status, postedThrough | inventory item, account 1302/1303 |
| Vendor | id `V-nn`, category, tags, npwp, pph23Rate, bank, pic, terms {dpPercent, settlementDays}, attachments, score, delays | catalogue, POs; stage in `useProto` |
| Catalogue item | id `VI-nn`, vendorId, category, unitPrice, stock, bookings[{from, to, projectId, qty, poId}] | vendor, PO |
| Purchase order | id `PO-nnnn`, vendorId, project, status, terms, lines[{itemId, qty, unitPrice}], dpPaidAt, settledAt | vendor, project, bills; delivery in `useProto` |
| Procurement request | id `PR-nnn`, project, category, amount, status, by (requester), proof, date, actual, variance | project, petty cash |
| Inventory item | id `IT-nn`, type (Consumable/Fixed Asset), qty, unitValue, status (in_stock/in_transit/maintenance/written_off), projectId, eventDate | delivery orders, asset |
| Delivery order | id `DO-nnnn`, project, status (Draft/Dispatched/Received), signed, lines | inventory (no backend table) |
| Crew | id `CR-nn`, role, baseRate, lastRating | incentives |
| Budget | project, categories[{key, ceiling, realized}], tolerance % | project |
| MoU template | id, heading, validity, clauses[], signatory | quotations |
| Tag | id, label | vendors, catalogue |

### 7.2 Prototype-module entities (`src/store/protoSeed.js`, `useProto`; no backend yet)

| Entity | Key fields | Links |
|---|---|---|
| Member | id `M-nn`, name, workspaceRole (pm/leader/staff/intern), division, title | tasks, channels |
| Project divisions / membership | `projectDivisions[projectId]`, member project lists | access rules |
| Task | id `T-nnn`, projectId, division, title, description, assigneeId, assignedById, deadline, priority, status (To do / In progress / Blocked / Submitted / Leader approved / PM approved), blockerReason, approvals, activity[{at, by, text, kind}], attachments[] | project, member |
| Channel | id, name, projectId \| null, kind text/voice, access, divisions, memberIds, blocked, listed, requests[], textChannelId (voice), dm | project, messages |
| Message | id, channelId, authorId, at, text (with `<@M-xx>` / `<#T-xxx>` tokens), quoteId (legacy parentId), reactions, kind (call), meetingId, edited/deleted | channel, task, meeting |
| Meeting | id `MTG-n`, channelId, logChannelId, dm, video, startedAt, endedAt, hostId, participantIds, transcript[], notes[], files[], access {mode, extraIds}, filesViewOnly, summary | channel |
| Event | id `EV-nn`, name, clientId, projectId, date, time, venue, rsvpDeadline, status (Draft/Published), editToken, invite (draft), published, review {state, note…}, holdWishes, wishes[], broadcasts[], rsvpFields, maxPax, tables, feedbackUrl, customFields[], checkpoints[], reminders[], sendLog[] | client, project |
| Invite (draft/published) | templateId, accent, on{section: bool}, content{cover, message, details{…sessions}, gallery, video, music, hosts, agenda, speakers, dresscode, couple, story, gift} — media as `{key, name, size, type}` | template, media |
| Guest | id `G-nnn`, eventId, token, name, phone, email, category, onMasterList, rsvp, pax, allergies, answers{}, consent, consentAt, respondedAt, table, checkedInAt, walkIn, note/noteBy/noteAt, invitedAt, invitedVia | event; merged into CRM contacts by phone |
| Scan | id `SC-nnn`, eventId, guestId, checkpointId, at | event, guest |
| Broadcast | id `BC-n`, channel, subject, message (template), audience, scheduledAt, status, recipients[{guestId, channel, status, reason, at}] | event |
| Reminder rule | id, when (before/after), daysBefore, audience, channel, template, active | event |
| Custom template | as `validateTemplate`: id, family, name, palette, fonts, cover, ornament, sections, art{coverBg, pageBg, frame, ornament}, status (draft/published/archived), by, at | events |
| Relation (CRM) | per client: pics[], anniversary, greet settings, nudgeLeadMonths, cycles[{name, history}], handledNudges, outreach | client |
| Greeting log, campaigns, Google connection/events | as named | client, contacts |
| PO delivery / vendor stage | keyed by PO id / vendor id | belong on the PO and vendor rows |

---

## 8. Backend work needed (prioritised)

### 8.1 Decide the target architecture first
The finance backend (FastAPI + Postgres, `erp-backend/`) is built, tested and documented. The cheapest path is to **extend it** with the new domains rather than start again. `docs/finance-backend/08-wiring-plan.md` explains the "replace what is behind the store" approach, which keeps the 25+ pages working.

### 8.2 Priority list

1. **Users, auth and roles enforced server-side.**
   - Merge the two identity systems (ERP roles and workspace personas) into one user table: role + division + workspace role + project memberships. Remove "Viewing as" and offline mode from production.
   - Guard routes in the frontend, and enforce every rule in the API: `roles.js` actions, `workspaceAccess.js`, channel and meeting access, DM privacy, publish/template permissions.
   - Auth already exists: argon2id, JWT 30 min + rotating revocable refresh, login throttling (in-process, single worker only).
2. **Finish W3 (finance writes).** Wired today: journal post/reverse/adjust, confirm DP, undo DP, issue invoice, **receive payment (`POST /invoices/{id}/payments`) and pay bill (`POST /bills/{entry_id}/payments`), both since round 4**, PO approve/pay-dp/settle/cancel, voucher series CRUD, vendor tags and PPh 23 rate, client create/edit, interactions CRUD, search, posting preview. **Not wired** (endpoints mostly exist): quotations create/send/accept/decline ("Mark accepted" is browser-only), the rest of vendor bills (`/bills/*` beyond payment), create PO, petty cash and procurement, budget, fixed assets and depreciation, CoA, tax config, inventory, crew/feedback/incentives, settings, MoU templates. Then **W4** (move the 10 pages that derive statements client-side onto `/reports/*`, using the client math as an oracle) and **W5** (retire `seed.js`).
3. **New domains with persistence** (everything in `useProto` today). Propose endpoints from the store actions:
   - Workspace: `GET/POST /tasks`, `POST /tasks/{id}/start|block|unblock|submit|approve|reject`, `POST/DELETE /tasks/{id}/attachments`, `PUT /projects/{id}/divisions`, `PUT /projects/{id}/members`.
   - Chat: `GET/POST /channels`, `PATCH /channels/{id}`, `POST /channels/{id}/join-requests`, `POST /join-requests/{id}/decide`, `GET/POST /channels/{id}/messages`, `PATCH/DELETE /messages/{id}`, `POST /messages/{id}/reactions`, `POST /dms`, `POST /channels/{id}/read`, presence. Needs **real time** (WebSocket/SSE, or a hosted service such as Pusher/Ably/Supabase Realtime).
   - Calls and meetings: a calling service (e.g. LiveKit, Daily, Twilio) for audio/video/screen share and recording/transcription; `GET /meetings/{id}`, `PATCH /meetings/{id}/access`, `POST /meetings/{id}/notes|files|summary|tasks|post-summary`.
   - Events: `GET/POST /events`, `PATCH /events/{id}`, `PUT /events/{id}/invite/template|sections/{s}|content/{s}|accent`, `POST /events/{id}/submit|return|publish|unpublish|rotate-edit-token`, questions CRUD, guests (`POST /events/{id}/guests` incl. CSV import, `PATCH /guests/{id}`), reminders CRUD + send, broadcasts (`POST /events/{id}/broadcasts`, `/send-now`, `/cancel`, `/retry`), `POST /guests/{id}/sent-by-client`, checkpoints CRUD, `POST /events/{id}/scans`, `POST /guests/{id}/check-in`, `DELETE …/check-in`, wishes (`POST`, `PATCH hide/approve`, hold setting).
   - Public (token-scoped, no login): `GET /public/invites/{eventId}?g=`, `POST /public/invites/{eventId}/rsvp`, `POST …/wishes`, `GET/PUT /public/invites/{eventId}/edit` (edit token), `POST /public/walkin/{eventId}`.
   - Templates: `GET/POST /invite-templates`, `PATCH /invite-templates/{id}`, `POST …/publish|unpublish|archive|restore`, `PUT …/art/{slot}`.
   - CRM relationship layer: `PUT /clients/{id}/relation`, PICs CRUD, nudge handling, greetings, contacts (`GET /contacts`, derived), campaigns; vendor lifecycle stage and checklist; PO delivery status.
   - Notifications: keep them derived, but compute server-side and store read-state per user. Add push, email and WhatsApp delivery.
4. **File and media storage** replacing IndexedDB and localStorage: object storage (S3, R2, Vercel Blob) with signed upload URLs. Cover photos, video ≤ 200 MB (consider transcoding/streaming), music ≤ 20 MB, task and meeting attachments ≤ 10 MB, template artwork, vendor documents, proof of payment. The backend already has a `StorageBackend` and `/attachments` for finance (local disk, `MAX_UPLOAD_BYTES` 10 MB).
5. **Real integrations replacing simulations:**
   - **WhatsApp Business API** provider (Meta Cloud API or a BSP) for invitations, reminders, greetings and campaigns. Templates must be pre-approved, delivery/read webhooks update recipient status, and consent rules apply.
   - **Email** provider (Postmark, SES, Resend), with bounce webhooks.
   - **Google Calendar** OAuth + sync. The client has not decided what it should do (§10).
   - **AI minutes:** move from the Vercel function to the backend, using real transcripts.
   - **QR scanning:** camera scanning (e.g. a BarcodeDetector polyfill or zxing) at the desk, against signed tokens.
   - **Scheduled jobs:** reminders, scheduled broadcasts, greetings, cron. Extend the existing APScheduler (single process) or move to a queue if volume grows. Make jobs idempotent (`job_runs` pattern).
   - **PDF generation** server-side.
   - Licensed music tracks.
6. **Multi-device sync.** Today each browser has its own data. A guest's RSVP on their phone never reaches staff. This is the main reason the prototype cannot be used live.
7. **Snapshot templates at publish.** Today editing a template changes live invitations at once. Store the resolved template (or a version id) with `published`.
8. **Timezone per event.** `.ics` assumes Asia/Jakarta. Oscenia also works in Bali (UTC+8) and Singapore. Store a timezone on each event and use it for reminders, RSVP closing and check-in day. The backend's `TIMEZONE` setting is company-wide.
9. **Audit trails.** Finance is append-only by design. Add who/when history for task status, publish/unpublish, guest edits, check-in overrides, permission changes and channel access changes. The prototype keeps some (task activity, vendor stage history, note author).
10. **Security notes:**
    - Client edit links: today the key is compared in the browser and stored on the event. Make it a server-issued, random, revocable token scoped to one event (rotate on revoke, expire, rate limit).
    - Guest personal links: today the token comes from `Math.random` (seed tokens are deterministic). Use random server tokens.
    - QR codes: `OSCENIA:EV-01:G-001` is guessable. Sign it, or carry the guest token.
    - Public pages must receive only the published invite and that guest's own data. Today the whole store, including all guests and `editToken`, is in the browser.
    - Validate uploads server-side (type sniffing, size, image re-encoding). Keep **no SVG** uploads.
    - Sanitise user content: keep `safeLink` (http/https only) and length caps from `cleanSection`.
    - Rate-limit RSVP, wishes, walk-ins and the AI endpoint. Login throttling must move out of process before running more than one worker.
    - Marketing consent must be recorded with source and time (already modelled) and honoured by campaigns.
11. **Production frontend.**
    - Code-split (the bundle is about 1.3 MB per the feedback doc).
    - Move i18n to message IDs.
    - Use a data router for navigation blocking.
    - Server state: the wiring plan keeps zustand; React Query is worth considering for the new domains.
    - Replace `DEMO_TODAY` with the real clock.

---

## 9. Testing

All in `erp-frontend/` unless noted.

| Command | What it checks | Needs |
|---|---|---|
| `npm run verify` | Runs ledger + flows + adapters + proto + ai-fn | Node only |
| `npm run verify:ledger` | `scripts/verify-ledger.mjs`: seed journal invariants (entries balance, A = L + E, cash/AR/inventory tie to accounts, margins, balance sheet at several tax rates) | Node |
| `npm run verify:flows` | `scripts/verify-flows.mjs` (about 2,500 lines, 755 checks): drives the real store actions (DP, PO lifecycle, write-offs, incentives, petty cash, adjustments, cancellations, permission matrix, the round-4 posting pop-up guard and journal filters) and re-asserts balanced books after each | Node |
| `npm run verify:adapters` | `scripts/verify-adapters.mjs`: API → page shape conversion against fixtures from the OpenAPI schema; money stays a string; tax-config list → map | vite-node |
| `npm run verify:proto` | `scripts/verify-proto.mjs` (about 1,700 lines): prototype seed integrity, persona access matrix, chat/meeting privacy, events/RSVP/broadcast/wish rules, templates and studio, vendor stages, PO pipeline, a scan for looping zustand selectors | Node |
| `npm run verify:ai-fn` | `scripts/verify-ai-fn.mjs`: the meeting-summary function with a fake `fetch` (limits, providers, errors) | Node |
| `npm run verify:render` | `scripts/smoke.jsx`: every route rendered to string against seed, after mutations, and in Bahasa (uses `smoke.config.js`, `zustand-live.js`, `smoke-session.js`). Modal bodies are not covered. | vite-node |
| `npm run verify:api` | `scripts/verify-api.mjs`: API client against a **running** backend | backend on :8000 |
| `npm run verify:mobile` | `vite build`, then `scripts/mobile-check.mjs` (390 × 844 screenshots, overflow, JS errors) and `scripts/popover-check.mjs` (Playwright). `PREVIEW_PORT` moves the port. | Playwright browsers |
| `node scripts/invite-e2e.mjs <dir>` | Browser walk-through of gallery, editor, uploads, reload, template change, client link, Template Studio | `npx vite --port 5291` running |
| `cd erp-backend && pytest -q` | Backend suite against real Postgres, 573 tests (`-m "not slow"` to skip long runs). Round-4 posting guard: `tests/test_posting_overrides.py` | Docker Postgres on 5433 |

Recommendations:
- Port the pure-lib checks (`verify-*.mjs` use hand-rolled asserts) into a real runner (Vitest suits the Vite setup), with CI on every PR. Add GitHub Actions for `npm run verify`, `verify:render`, `vite build` and backend `pytest`.
- Add component and E2E tests for the modals (not machine-verified today) and the critical flows: DP → project, PO lifecycle, invite → RSVP → check-in, task approval.
- Re-run the backend suite on any change that touches backend code. `STATUS.md` records the suite going red for two commits after a frontend commit changed one backend line.

---

## 10. Known limitations and open client questions

### 10.1 Known limitations (prototype)
- Data lives per browser. Tabs in one browser sync; devices do not.
- Finance in offline mode is in memory. Save actions online need the backend ("Not connected to the API" otherwise).
- All sending, calls, transcripts, Google sync, QR camera, greetings, campaigns and cron matches are simulated.
- Studio templates and media exist only in the creating browser. Elsewhere, invitations on studio templates render as Gala, and uploaded video/music is missing.
- No template snapshot at publish.
- A new cover layout or section type needs a developer.
- Guest page is English only.
- Routes are not role-guarded.
- Posting pop-up (round 4): on a live backend the memo is read-only; the live journal period buttons count from the demo date 2026-07-26; pay bill and settle PO were not exercised live end-to-end in a browser (covered by `verify:adapters` and pytest).
- Tax treatment follows the client's mockup in places. DP revenue is not deferred. VAT and PPh 21 are off.
- Modals are not covered by automation.
- `TESTING.md` port note is wrong (5173 vs 5273).
- `docs/finance-backend/00-INDEX.md` still says "No backend code exists yet". `STATUS.md` is the current truth.

### 10.2 Open questions for the client
From `docs/Prototype-Demo-Guide.md`, `docs/Client-Feedback-Round-1.md` and `docs/finance-backend/07-open-questions.md`:

| # | Question | Default built |
|---|---|---|
| C1 | Send campaigns to ticked contacts without marketing consent? | No: skipped, with a warning |
| C2 | What should Google Calendar do (show Google events beside CRM dates, push CRM dates to Google, both)? | Simulated, both options |
| CH2 | Are direct messages wanted? | Yes; not even the PM can read them |
| R6 | Is 50 people per invitation enough? | 50 |
| W2 | Is 10 MB per task file right? | 10 MB |
| CH4 | Are the minutes laid out right? Is "people on the call" the right default access? | Yes / participants only |
| CH5 | Should anyone besides the PM and project division leaders decide channel settings and join requests? | PM + leaders |
| INV | Only CEO/PM can publish, but anyone who can open an event can send. Limit sending? | Not limited |
| REQ-07 | Partial warehouse checkout and dispatch scope (needs a delivery-order domain) | Waiting |
| REQ-02 | Per-document tax mode and a tax block on PDFs (depends on PKP) | Waiting |
| Q1 | Defer DP revenue through 2101 Unearned Revenue? | No (high priority) |
| Q4 | Is Oscenia a PKP (switch on PPN 11%)? | Off (high) |
| Q7 | One legal entity or three (Jakarta / Bali / Singapore)? | One (high) |
| Q8 | Does Singapore trade in SGD? | IDR only (high) |
| Q9 | Migrate existing accounting data, or start from opening balances? | Open (high) |
| Q2, Q3, … | Period-close behaviour; accounting standard (PSAK / ETAP / IFRS); more in `07-open-questions.md` | — |
| — | Backend hosting choice (the backend is not deployed) | Open |
| Q16 | Consumables opening balance does not match the stock list (6,132,000 gap in the seed) | Reported, not fixed |

---

## 11. Docs index

| File | What it is |
|---|---|
| `README.md` | Repo overview and quick starts |
| `TESTING.md` | Manual testing guide for the backend and the wired frontend: what is real, scenarios, troubleshooting |
| `erp-frontend/DEMO-SCRIPT.md` | Short demo script for the prototype (**check** contents) |
| `docs/Prototype-Demo-Guide.md` (+ `.pdf`) | Client-facing, step-by-step walkthrough of every feature, with what's new in rounds 1–4 and open questions |
| `docs/Oscenia-ERP-Prototype-Walkthrough.md` | The first client walkthrough of the original ERP screens (Dashboard → Sales report) |
| `docs/PRD-ERP-Oscenia.md` | Original ERP PRD from the client's concept deck: roles, modules, data model, automation triggers |
| `docs/BRD-PM-Events-CRM-v0.2.pdf` | BRD for the workspace, chat, events/RSVP and CRM modules |
| `docs/ERP-Feedback-Analysis-and-Fix-Plan.md` | Finance feedback rounds 1–2: analysis, decisions, what was built, verification, deploy notes |
| `docs/Client-Feedback-Round-1.md` | Prototype review round 1 (and round 2) triage, decisions, parked questions, handover notes |
| `docs/Client-Feedback-Round-3.md` | Round-3 asks (verbatim), status and known limits |
| `docs/Client-Feedback-Round-3-Plan.md` | Implementation plan for round 3 (PO pipeline tab, Google Calendar page, Reply, Template Studio) |
| `docs/Client-Feedback-Round-4.md` | Round-4 asks (verbatim), status by commit and known limits |
| `docs/Client-Feedback-Round-4-Plan.md` | Implementation plan for round 4 (free-text table, journal pop-up, two dates, journal declutter) |
| `docs/Invitations-v2-Product.md` | Invitations v2 product decisions D1–D14, features, flows |
| `docs/Invitations-v2-Plan.md` | Invitations v2 technical plan, data model, actions and build log |
| `docs/Deck-Transitions-Reference.md` | Marketing-site reference: how the brand deck's slide transitions map to the website |
| `docs/finance-backend/00-INDEX.md` | Index and reading order for the finance backend spec |
| `docs/finance-backend/01-architecture.md` | Stack and architecture decisions, non-goals |
| `docs/finance-backend/02-data-model.md` | Tables, constraints, database-enforced invariants |
| `docs/finance-backend/03-accounting-rules.md` | Posting rulebook (Dr/Cr for every transaction). Read this first. |
| `docs/finance-backend/04-api-contract.md` | Endpoints by domain and which screen each backs |
| `docs/finance-backend/05-build-plan.md` | Backend phases 0–8 and definitions of done |
| `docs/finance-backend/06-test-spec.md` | Acceptance criteria ported from the prototype suites |
| `docs/finance-backend/07-open-questions.md` | Client decisions still needed, with recommendations |
| `docs/finance-backend/08-wiring-plan.md` | Plan for wiring the React app to the API (W1–W5) |
| `docs/finance-backend/STATUS.md` | Current state of the backend and wiring. The source of truth. |
| Root files (`ERP Oscenia.pptx`, `Oscenia_ERP_Upgrade.pdf`, `oscenia_erp_upgrade_roadmap_presentation.html`, `Oscenia ERP_ Financial & Operational System Development Proposal.html`, site PDFs/docx) | Client source material: concept deck, feedback decks, website direction |
