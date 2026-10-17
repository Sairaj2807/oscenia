# STATUS — Finance Backend

> Single source of truth for where this build actually is. Update at the end of every phase.
> If you are picking this up cold, read this file first, then
> [00-INDEX](./00-INDEX.md#how-to-rehydrate-a-fresh-session).

**Last updated:** 2026-10-11 (team chat: wiring, live bell, meetings and AI minutes — see the first Log entry; the older finance notes below are from round 4, 2026-10-05)
**Branch:** `erp-feedback-round-3`  
**Workspace:** tasks, approvals, files, live updates and the task bell items are built and wired on
`feature/workspace` (see the first Log entry). **Chat:** built and wired on `feature/chat` — backend C0–C5, screens F1–F3 (signed-in users get
live chat; the offline demo is unchanged). **Meetings and minutes (phase M):** the server stores what a
call leaves behind (people, transcript, notes, files, minutes) and writes the minutes itself —
`app/domain/chat/{meetings,meeting_rules,minutes,meeting_router}.py`, migration `e5b82a7c4d19`. An AI
service writes them when `AI_PROVIDER`/`AI_API_KEY` are set and the person is under `AI_MINUTES_PER_DAY`;
otherwise rules do, labelled as such. Meetings are created by the call service (not built) or the demo
seed, never over HTTP. **Still demo-only: live calls** (audio/video/screen share, LiveKit chosen) and
"create tasks from action items" (no tasks backend).
**Bell:** chat items come from the server; events and CRM items
(invitations to review, RSVPs, birthdays, anniversaries) now have `GET /notifications` and load for
every signed-in login, polled once a minute — read state is kept by the browser. Task items stay
demo-only (no tasks backend); "Time to reach out" has no server source (no nudge cycles).
**Current phase:** Backend: all eight phases complete and green. Wiring: **W1 (auth) and W2 (reads)
are done** — this file previously said wiring was "next up", which was out of date by two commits.
**W3, the write path, is done for every action that has an endpoint** (see the first Log entry); the
rest say "Not saved" rather than changing browser memory. Now proceeding per client feedback
round 3 (`Oscenia_ERP_Upgrade.pdf`, 10 items), wiring each touched screen's writes as we go.

---

## Where we are

| | |
|---|---|
| **Done** | The nine specification documents. **Phase 0 scaffold** in `erp-backend/`: pyproject, docker-compose Postgres 16, FastAPI app factory with `/health`, config, injectable clock, money policy, RFC 7807 errors, async SQLAlchemy, Alembic (async env, no migrations yet), and the pytest harness. |
| **Verified** | **`pytest` — 573 passed** (round 4 review fixes, 2026-10-05; was 543 before round 4) against real Postgres 16, most over real HTTP. **`ruff check` — clean.** **`mypy app` (strict) — clean, 84 files.** 133 operations across 109 paths, every one authenticated. Balance sheet verified balanced on a live server with both derived rows present. Migration round-trips down and back up. |
| **Wired so far** | **W1** — real sign-in, JWT + refresh, the role switcher re-authenticates. **W2** — reads: `lib/api.js`, `store/adapters.js`, `store/hydrate.js`. Round 3 added the four adapters W2 was missing (`adaptQuotation`, `adaptProcurement`, `adaptCatalogueItem`, `adaptTaxConfig`) and hydration for `tags`, `vendorCatalogue` and `voucherSeries`. **W3, in part** — writes, per feedback item rather than as one pass: the purchase-order actions, client and interaction CRUD, vendor rate and tags, the voucher-numbering editor, and the journal screen's own three (post, reverse, adjust). Everything else still loses its writes on refresh, and `TESTING.md` still says so. |
| **Next** | **Round 3, two items left, both waiting on the client:** REQ-07 (partial warehouse checkout — the checkout half is contained, but *dispatch* needs a delivery-order domain that does not exist server-side, so the scope question has to be answered first) and REQ-02 (per-document tax mode and a tax block on the PDFs, gated on whether Oscenia is PKP). The contract to wire against is [04](./04-api-contract.md); the phasing is [08](./08-wiring-plan.md). |
| **🔴 The suite had been red for two commits, and nobody knew** | `pytest` was **111 failed / 383 passed**, not 494. Root cause: `e94c7a4` added one line to `_to_out` — `"applied_to": [a.settled_entry_id for a in entry.applications]`. `applications` is the codebase's only `viewonly=True` relationship: `lazy="selectin"` loads it when an entry is *queried*, but `_to_out` is also called on entries just *created*, where nothing was queried and `viewonly` means `post_entry` cannot append to it. Touching an absent collection is a lazy load, and under asyncio that raises `MissingGreenlet` instead of loading — so **every posting endpoint 500'd**. Proven by neutralising that single line: 24 failed → 37 passed. Fixed by making `_to_out` async and awaiting `entry.awaitable_attrs`, which also makes the bug uncallable in future. **The lesson is process, not code: `e94c7a4` was a frontend commit that touched one backend line, and the backend suite was not re-run.** |
| **Correctness fix worth knowing about** | `GET /tax-config` returns a **list**; every consumer in the prototype indexes it by name (`taxConfig.pph23`). Hydration was assigning the raw list, so `withholding()` and `corporateTax()` both silently returned **zero** — the wired app withheld no PPh 23 and booked no tax provision, which quietly undid round 2's NPAT work. Nothing threw. Fixed by `adaptTaxConfig`; `verify:adapters` now asserts both the fix and the old failure mode. |
| **Known broken, pre-existing** | `npm run verify:render` fails all 75 checks, on this branch and on `main`. `renderToString` never runs `useEffect`, so `AuthGate` never calls `restore()`, `status` stays `unknown`, and every route renders the 140-byte "Checking your session…" div. It broke when W1 added the sign-in door; `scripts/smoke.jsx` never authenticates. Not caused by round 3 — verified by stashing and re-running on a clean tree. |
| **Blocked on** | Nothing. Every open question in [07](./07-open-questions.md) names what we do in the meantime. |
| **Needs a decision before go-live** | [Q1 (defer DP revenue through 2101)](./07-open-questions.md#q1--should-a-down-payment-defer-revenue), [Q4 (PKP / PPN)](./07-open-questions.md#q4--is-oscenia-a-pkp), [Q7 (one entity or three)](./07-open-questions.md#q7--one-legal-entity-or-three), [Q8 (SGD?)](./07-open-questions.md#q8--is-singapore-trading-in-sgd). None block the build; all four are posting-rule or schema changes that get more expensive the more data exists. |

---

## Phase progress

| # | Phase | State | Tests green |
|---|---|---|---|
| 0 | Scaffold | **done** | 26 |
| 1 | Ledger core | **done** | 117 |
| 2 | Auth & RBAC | **done** | **162 passed** |
| 3 | Statements & reports | **done** | 199 |
| 4 | Accounts Receivable | **done** | 257 |
| 5 | Accounts Payable | **done** | 286 |
| 6 | Cash operations | **done** | 319 |
| 7 | Fixed assets & payroll | **done** | **451 passed** |
| 8 | Scheduler & hardening | **done** | **494 passed** |

Test coverage target, from [06](./06-test-spec.md): **12** ledger invariants + **67** flow
sections + **19** database-invariant tests.

---

## Decisions taken

| Date | Decision | Rationale |
|---|---|---|
| 2026-09-04 | Scope is **everything the prototype's finance pages show** | Client instruction |
| 2026-09-04 | **Backend first**, React rewire as a later phase | Verify the API against the ported assertion suites before any UI depends on it |
| 2026-09-04 | **FastAPI + PostgreSQL 16**, SQLAlchemy 2 async, Alembic | Requested stack; Postgres specifically for `NUMERIC`, deferrable constraint triggers and row-locked sequences |
| 2026-09-04 | Money is `NUMERIC(18,2)` + `Decimal`; **entries balance to exactly `0.00`** | Exact arithmetic removes the need for the prototype's 1-rupiah float tolerance |
| 2026-09-04 | **Materiality is kept as a separate named constant** (`Decimal("1.00")`) | The prototype's `EPSILON` was doing two jobs; only the float-guard half is obsolete |
| 2026-09-04 | The four core invariants are **enforced by database triggers**, not application code | The books must survive a client that bypasses the service layer |
| 2026-09-04 | Reports are **endpoints, not tables**; nothing derivable is stored | Preserves the prototype's "ledger is the single source of truth" architecture. Drops `projects.realizedCost` and `invoices.paid` |
| 2026-09-04 | Count-based ids replaced by **row-locked sequences** | `PO-${3001 + list.length}` collides after a delete and races under concurrency |
| 2026-09-04 | The four in-memory idempotency flags become **unique constraints** | A stateless API cannot rely on `dpConfirmed`, `postedThrough`, `incentivesPaid`, `_billFor` |
| 2026-09-04 | **APScheduler in-process**, not Celery | Five low-volume jobs; a broker is not earned. `job_runs` gives idempotency and audit |
| 2026-09-04 | Single tenant, IDR only, local docker only | Stated non-goals — see [01](./01-architecture.md#what-we-are-deliberately-not-building) |
| 2026-09-04 | **New:** accounting periods with a hard close | The prototype has none; month-end depreciation and audit both need one |
| 2026-09-04 | **New:** real users, JWT auth, server-side RBAC | The prototype has no auth at all; `role` is a store field |
| 2026-09-04 | **New:** real file storage behind a `StorageBackend` | Attachments are filename strings today |
| 2026-09-05 | **"Today" is `Asia/Jakarta`, not UTC** | Oscenia is UTC+7; the business day turns over at Jakarta midnight. Ageing buckets, DP countdowns and depreciation due dates all key off `today()`, so UTC would shift them by a day for seven hours of every day |
| 2026-09-05 | Postgres publishes on host port **5433** | A native `postgresql-x64-17` service already owns 5432 on the build machine |
| 2026-09-06 | **argon2id** for passwords, **JWT** access + rotating refresh | Memory-hard hashing; rotation limits a stolen refresh token to a single use |
| 2026-09-06 | Refresh tokens are **recorded and revocable** | A signed JWT is valid until it expires whatever happens after; a `jti` table is what makes signing out actually sign you out |
| 2026-09-06 | Every login failure returns the **same** message | Distinguishing unknown-account from wrong-password is a free user-enumeration oracle |
| 2026-09-06 | The depreciation schedule is a **projection**, not draft journal entries | Sixty unposted entries would mean every balance query, both statements and the trial balance had to learn to exclude them; one missed filter reports depreciation that has not happened |
| 2026-09-06 | A depreciation run is **one entry per period, one line per asset** | Thirty-six entries for six assets over six months buries every other transaction in the journal |
| 2026-09-06 | A total loss marks the asset **disposed with its cost intact** | The prototype zeroes `cost`, which the `cost > 0` constraint refuses. Disposed assets are excluded from the register, so the totals match either way — and the acquisition history survives |
| 2026-09-06 | A disposal posts under `FA-nnn-DISPOSAL` | The partial unique index on `('depreciation', ref)` already holds `FA-nnn` from the capitalisation |
| 2026-09-06 | Sealed columns are **declared in order to be refused**, not omitted | Omitting them makes Pydantic drop them silently and return 200 — the caller believes the edit took |
| 2026-09-06 | A failed job is a **result, not an exception** | Re-raising rolls back the caller's transaction and destroys the `job_runs` row that records the failure |
| 2026-09-06 | `job_runs.run_for` is the period **covered**, not the start time | A retried month-end must land on the same row rather than mint a second |
| 2026-09-06 | The scheduler is **off by default** (`SCHEDULER_ENABLED`) | Otherwise it posts month-end depreciation to whatever database a developer is pointing at, and fires inside the test suite |
| 2026-09-06 | Login throttling is **in-process**, and documented as such | Right for one uvicorn worker, wrong for two — stated rather than discovered |
| 2026-09-06 | The demo seed **reports** the 1301 discrepancy rather than fixing it | Changing a client-reviewed opening balance is the client's call |

The five inherited accounting rulings — reverse-don't-edit, a PO is a commitment,
scheduled stages are not AR, life revision is prospective, PPh 23 both directions — were
**not** re-decided. They carry over from the client's two feedback rounds. See
[03](./03-accounting-rules.md#the-five-inherited-rulings).

---

## Facts verified in the prototype source

Checked directly rather than assumed, because the documents depend on them:

| Fact | Location |
|---|---|
| No backend exists anywhere in the repo | zero hits for `.py`, `requirements.txt`, `pyproject.toml`, `docker-compose`, `api/`, `fetch(`, `axios`, `localStorage` |
| 20 gated RBAC actions across 5 roles | `src/lib/roles.js` |
| Header accounts keep their own balance, deliberately | `src/lib/accounts.js:122-129` |
| `EPSILON = 1` is used in 9 places, including open items and statement filters | `src/lib/ledger.js:27, 274, 295, 337, 410, 443` |
| `verify-flows.mjs` has 67 sections (0–65 plus 2b) | section 7's title contains an `=`, which hides it from a naive grep |
| `SettleModal` throws on click | `src/pages/PurchaseOrders.jsx:175-193` — see [Q14](./07-open-questions.md#q14--settlemodal-is-broken-in-the-live-prototype) |

---

## Open questions summary

Full detail and recommendations in [07](./07-open-questions.md).

| # | Question | Priority |
|---|---|---|
| Q1 | Defer DP revenue through 2101 Unearned Revenue? | high |
| Q4 | Is Oscenia a PKP — activate PPN 11%? | high |
| Q7 | One legal entity or three (Jakarta / Bali / Singapore)? | high |
| Q8 | Is Singapore trading in SGD? | high |
| Q9 | Migrate existing accounting data, or start from an opening balance? | high |
| Q2 | What does closing a period do? | medium |
| Q3 | Which accounting standard — PSAK, PSAK-ETAP, IFRS? | medium |
| Q11 | File storage limits and retention? | medium |
| Q12 | Who are the real users? | medium |
| Q13 | Audit log beyond the journal? | medium |
| Q14 | Fix the `SettleModal` bug in the prototype now? | medium |
| Q5 | PPh 21 and real payroll in scope? | low |
| Q6 | Should sales commission post to the ledger? | low |
| Q10 | Client birthdays as real dates? | low |
| Q15 | Dashboard revenue trend is fabricated | low |
| Q16 | Opening consumables — 28,200,000 or 22,068,000? | medium |

---

## Log

**2026-10-17 (latest) - Read access is role-gated; the repo is now one monorepo (branch `feature/erp-integration`).**
**Start here if you are a fresh session.**

* **The hole that was closed.** About 70 endpoints (`GET /journal-entries`, `/clients`, `/reports/*`, `/vendors`, `/projects`…) and
  14 writes (`POST/PATCH /quotations`, `.../accept`, `.../send`, `PUT /projects/{id}/feedback`…) answered *any* valid login, so a
  chat-only team login could read the whole ledger by calling the API. Only writes with a named action were gated.
* **How it is closed.** `app/core/access.py` holds one table: `"METHOD /route-template"` → the modules, any one of which lets a
  role call it. `enforce_access` runs as a router dependency (`app/main.py`, `guarded`) and uses the same `can_see` matrix as the
  sidebar and `/auth/me`. A route with no entry keeps its own gate (`require_action`, `require_module`, `chat_member`…), is public, or
  is about the caller's own account.
* **It cannot rot.** `tests/test_access_policy.py` fails if any route is none of those (so the next endpoint is not quietly open),
  if a policy entry names a route that does not exist or is not enforced, and, for every role × every policy route, that the answer
  is 403 exactly when the role sees none of the modules (423 cases).
* **What it is not.** Not row-level scoping: a role that holds a module sees that module's data company-wide (a PM's dashboard shows
  company cash; the shared reference data is open to every business role). Narrowing that is a product decision.
* **Frontend.** `hydrate.js` `optional()` turns a 403 on a collection into an empty one (a 500 still fails the load). Before, one
  refusal aborted the whole first load, which already broke Sales and Warehouse logins (neither sees `/vendor-lifecycle`).
  Pinned by `npm run verify:role-load`.
* **Layout.** The prototype's `erp-prototype/` folder is now `erp-frontend/`; the site is `website/`. Older entries below still
  say `erp-prototype/` in prose, and describe the Vercel deploy and the offline demo; they are history.
* **Production (live since 17 Oct 2026).** The API runs on the shared VPS behind `https://osceniaevents.com` (`/api/*`), as a
  sandboxed systemd service on `127.0.0.1:8010` with a local PostgreSQL 16 (no Docker: the box is shared and Nginx owns 80/443).
  So "not deployed anywhere" in the older entries is no longer true. Runbook: `deploy/vps/README.md`. Current state, tests,
  open decisions and risks (**no backups yet**): `docs/GO-LIVE-STATUS.md`.
* **Verified:** full backend suite 2,125 passed plus the 4 tests fixed afterwards, 423 new access-policy tests, `ruff` and
  `mypy` (strict) clean; browser check on the live domain as the CEO (sign-in, 27 screens on an empty database).


**2026-10-12 - Public guest pages and invitation media (branch `feature/finance-gaps`; public routes pushed as `ac2e9b9`..`f49a886`, media after).**
**Start here if you are a fresh session.**

* **Public pages, signed out, against the server:** the published invitation, RSVP, wishes, the walk-in desk and the client's edit link
  (`events/public.py`, `/api/v1/public/*`). Token = identity (`X-Guest-Token`, `X-Walkin-Token`, `X-Client-Key` headers, never the path);
  a phone may only claim an unreplied listed guest; honeypot + per-IP and per-person throttles; 256 KB body cap; uniform 404/403; audit rows
  with labels; table number and other guests never leave. Frontend: `lib/publicApi.js`, `store/usePublicInvite.js`, `usePublicClient.js`,
  the three public pages. Click-through `public-live-e2e.mjs` 17/17.
* **Invitation media (backend Phase 3):** photos, video and music for an event and artwork for a studio template are uploaded to the server.
  `event_media` table (migration `k7f1b4c9d286`); the **row id** is the `key` in content, never the storage key (storage is content-addressed and
  shared with receipts, chat and tasks, so a storage key in content would let an invitation expose another record's file). Content may only name
  its own event's uploads (`media.scrub` in `update_content`, `set_art`); a kept reference takes its name, size and type from the stored row.
  Routes: `POST /events/{id}/media?kind=photo|video|music`, `POST /invitation-templates/{id}/art-upload`, client `POST /public/client/{no}/media`
  (outside the 256 KB cap, own throttle, size and type checked while streaming), guest `GET /public/media/{id}` (Range, `public, immutable`, one 404).
  Caps per event 100 files / 1 GB (template 30 / 200 MB); 4 uploads processed at once, then 429. Never-used uploads are swept (rows only, 7 days,
  opportunistically on upload; **not** a scheduled job, so the Daily Jobs screen is unchanged).
* **Frontend:** `uploadFile` in `lib/api.js` (XHR: progress, cancel, 401 refresh); `uploadMedia` action through the facade (demo = IndexedDB, signed in =
  `useEvents`, client link = `usePublicClient`); `UploadButton` shows percent and Cancel for video and music; `getMediaUrl`/`useMediaUrl` give a server
  file its URL from the id alone (`m-` keys stay the demo's browser files); the E3 "not connected" blocks are gone.
* **Bug the live run caught:** a photo is shrunk to JPEG in the browser but kept its picked name, so `dot.png` went up as a JPEG and the server refused the
  mismatch. Shrunk photos are now named `.jpg`.
* **Decisions to know:** `/public/media/{id}` serves any live upload by its unguessable id, drafts included (the editor preview and the client page use plain
  `<img>`/`<video>` tags that cannot send a key), so a draft's photo is fetchable by anyone holding its id. File bytes are never deleted by the sweep:
  they may be shared with another record.
* **Not done / not run:** a person on a real phone; hosting (the published demo is stale, the backend is unhosted); the proxy's body limit for a 200 MB
  video (a deploy setting); a store-wide clean-up of orphaned bytes; WhatsApp/email sending; consent withdrawal and erasure.
* **Run:** `media-live-e2e.mjs` 12/12 (scratch DB `oscenia_media_e2e`, :8774/:5286); `verify:media` 21 checks; `tests/test_events_media.py` 16.

**2026-10-11 - Events: the staff side reads and writes the server (branch `feature/finance-gaps`, commits `6d8115e` E0, `d4745b6` E1, `4c7263f` E2, E3 relabelling).**
**Start here if you are a fresh session.**

* **What works signed in (CEO, PM, Sales; Finance and Warehouse never ask):** events list with each card's guest numbers
  (server `stats`, the report's own counting), event settings, the invitation editor (template, sections, content, accent),
  submit/return/publish/unpublish, the client link and revoke, Template Studio (duplicate, edit, add to gallery, take out,
  archive), guests (form, CSV, category, table, note, email), RSVP questions, tables, checkpoints, check-in/scan/undo with the
  server's signed QR, wishes (hold, hide, approve), the attendance report. Signed-out demo unchanged.
* **How:** `lib/eventsApi.js`, `store/eventAdapters.js`, non-persisted `store/useEvents.js` (list + each event's detail, guests/scans/wishes
  when one opens; polled 60 s, 20 s for the open event); `store/chatProto.js` serves it live and refuses unbuilt writes; 14 staff files
  point at that facade. Typing-driven edits show at once and save after a 500 ms pause (one write per thing; reloads leave a dirty event alone).
  `lib/api.js` `rawKeys` keeps invitation content keys (`mapUrl`) intact. Backend: `EventOut.stats`.
* **Run:** `events-live-e2e.mjs` **25/25** (real backend, scratch DB `oscenia_ev_e2e`, :8772/:5284); finance click-through 30/30 at E1;
  `npm run verify` (226 + 40 event-adapter assertions); `verify:render`; vite build; backend events tests 50 pass (incl. the stats test).
  The click-through caught one real bug (adding a guest sent null optional fields: 422).
* **Not connected, signed in (labelled in the UI):** media and template artwork upload (backend Phase 3); sending, reminders, broadcasts,
  campaigns, CRM relations (Phase 4); **the public guest pages cannot serve real guests** (RSVP, wishes, client link, walk-in: Phase 2).
* **Not run:** a person's click-through; `invite-e2e.mjs` (offline demo walk-through); the full backend suite after the events stats change
  (events tests only); finance click-through on E2/E3 commits.
* **Next:** backend Phase 2 public token routes; then media; hosting decision for the published demo.

**2026-10-11 (later) - W4 R4 finished and all eight backlog items built (branch `feature/finance-gaps`).**
**Start here if you are a fresh session.**

* **W4 R4 done: every deriving page reads the server when signed in.** Cash, Dashboard, Receivables, Payables,
  Chart of Accounts, Fixed Assets (earlier), and now Accounting (income statement, balance sheet, trial balance,
  1401 prepaid withholding), Project P&L (one slice, the server's own comparison for month/previous/year, another
  project as a second slice; **a live project with no postings shows an empty statement, never the invented split**)
  and Project Detail (cost lines from `/reports/project-costs`). The demo keeps `lib/ledger.js`; in a dev build each
  page cross-checks the two and records any difference on `window.__reportDiffs` (R5), which the click-through fails on.
  Accounting asks for detailed rows with explicit dates (the page rolls them up itself); the GL and journal tabs
  stay client-side. 1401 is read from `/reports/general-ledger?codes=1401` (closing minus opening).
* **Backlog items 3-8:** fixed-asset edit; delivery orders (a *document*, not a stock movement; REQ-07 still open);
  CRM note files; Daily Jobs on the real scheduler; Budgeting per project; **Google Calendar** (`app/domain/gcal`,
  migration `i5d9f2a7e064`). Google: per-user connection, refresh token Fernet-encrypted (`GOOGLE_TOKEN_KEY`), read-only
  scope by default and the write scope only when asked, signed 10-minute sign-in state, idempotent CRM-date write-back,
  revoke on disconnect, injectable `GoogleApi` so no test reaches Google. **To switch it on the client must supply:** a
  Google Cloud project with the Calendar API, an OAuth client of type web, the redirect address
  (`GOOGLE_REDIRECT_URI`), and the Handover C2 decision (show Google events / push CRM dates / both). Until then the
  screen says plainly that the server is not set up.
* **Run:** finance click-through **30/30** (scratch DB, real backend + frontend); `npm run verify` 1147 prototype
  checks pass; `verify:render` passes; `verify:reports` **88 figures agree, 0 differ**; new gcal tests 22 pass, plus
  RBAC parity; `alembic check` clean. **Not run:** a real Google sign-in; a person's hand click-through.
* **Parked for client:** who may edit contract wording (`manage_mou_templates`); budget over-limit semantics; allowed CRM
  file types/sizes; Daily Jobs lookahead vs same-day scan and message sending; delivery-order scope; Google scope and credentials.
* **Next:** W5 (retire seed/demo code) still needs the product decision above; stacked PRs not yet opened.

**2026-10-11 — W4 started, the finance click-through, and a bug that made saves look stale
(branches `feature/finance-w4`, then `feature/finance-gaps`).** **Start here if you are a fresh session.**

* **A server bug found by the click-through test, fixed.** FastAPI 0.141 runs a `yield` dependency's exit
  code *after* the response is sent, and the request session commits in that exit code. So the server
  answered a write before committing it, and a client that read straight after (every screen re-reads
  after every save) was sometimes handed the old data. Measured against a real uvicorn: **57 stale reads
  in 150**. Fix: `SessionDep` is `Depends(get_session, scope="function")` (`app/db/session.py`); the same
  probe now gives **0 in 150**; `tests/test_session_scope.py` pins the setting (the in-process test client
  overrides the session, so it cannot show the race itself).
* **A front-end bug found by the same test, fixed.** `AuthGate` rendered the app (with seed data) while
  "Loading live data…" was still showing, so a fast click ran the *demo* branch of an action, which changed
  browser memory only and looked as if it worked. The app now shows a loading screen until the first load
  finishes or fails (a failed load still opens the app: a chat-only login has no finance data to load).
* **Finance click-through** (`erp-frontend/scripts/finance-live-e2e.mjs`, `node scripts/finance-live-e2e.mjs`):
  a scratch DB, a real backend and frontend, the CEO driving the screens; each step clicks, asks the *server*,
  then reloads and checks the screen. Reached 16/17 (quotation → send → accept → down payment → advance →
  cancel with refund, vendor, account, petty cash, procurement request, stock item, depreciation, bonus
  threshold, the "Not saved" message). The last step found a mismatch: the new-request form promises
  "submitted straight to Pending" but the server opens a Draft, so the live save now also submits it. See the
  commit messages for the final run's result.
* **W4 (pages read the server's reports) — R0-R3 done, R4 not started.** `scripts/verify-reports.mjs`
  (`npm run verify:reports`) builds a year's activity through the real API, loads it as the app does and compares
  the browser's `lib/ledger.js` against the server's reports. First run on real books found two bugs, both fixed:
  (1) a paid bill showed as unpaid in the browser's payables (a payment's link to its bill is a UUID but
  `openItems` matches the entry number: `adapters.resolveApplications`); (2) tax rounding (whole rupiah in the
  browser, the cent on the server: `ledger.roundCents`). After both: **86 figures agree, 0 differ**.
  `GET /reports/project-costs` (the itemised cost lines) is new; `store/reportAdapters.js` turns each report
  into the shape its page already reads (not wired to a page yet). Next: R4 (Cash → Dashboard → ageing → CoA/
  FixedAssets balances → Accounting statements → ProjectPnL → ProjectDetail), then R5 (a dev warning when the two
  numbers differ + docs).
* **Backlog items (from the "Not saved" list), in progress.** Done on the server and the client: tag rename and
  item (catalogue) tags (`PATCH /tags/{id}`, `PATCH /vendor-catalogue/{id}`; a pencil on each catalogue row opens a
  tag editor); MoU templates (`PATCH /mou-templates/{id}`, a draft-then-Save manager, templates now load from the
  server). **A permission gap closed on the way:** `POST`/`DELETE /mou-templates` were open to any signed-in user;
  all three writes now need the new `manage_mou_templates` action (CEO and Sales; **parked for client: who may edit
  contract wording**; `roles.js` carries the same action, as a test requires). Still to do, in order: fixed-asset edit
  (after W4's FixedAssets switch), the Daily Jobs screen, Budgeting, CRM note files; delivery orders and Google
  Calendar wait on the client (REQ-07 scope; OAuth credentials and the Handover C2 decision).
* **W5 is a split, not a delete.** Live screens still read seed values for things with no server side
  (threads, assets, cron, sales, delivery orders), `DEMO_TODAY` (a frozen clock) is used in ~40 places, the offline
  sign-in is also what makes the Vercel static demo work, and `verify-flows` (2,500 lines) exercises the demo
  branches. **Needs a product decision first: does the client still need a signed-out demo?**
* **Not run / honest gaps:** the browser click-through covers the finance screens only at the level above (no
  hand click-through by a person); `verify:render` has been broken since W1; see each commit for what was run.

**2026-10-11 — W3: the finance screens save for real (branch `feature/finance-w3`, off `feature/workspace`).**
Every finance action that has a server endpoint now goes through the store's single write door
(`mutate`) and re-reads what it touched; signed out, the demo behaves exactly as before. **Start here if
you are a fresh session.**

* **Wired this round (phases A-D).** Vendors, tags, tax rates and switches, chart of accounts (add,
  rename, deactivate/reactivate, delete), purchase-order drafts, quotations (create, edit, send, accept,
  decline), project stage moves and cancellation, procurement requests (create, approve/reject/disburse,
  settle with real receipt files), petty-cash top-up, the two company settings (budget tolerance, bonus
  threshold), fixed assets (capitalise, depreciation run, dispose), warehouse (check out, check in with a
  good/damaged/lost split, release, repair, condemn, add item), the client survey, incentive disbursement.
  With the earlier work (purchase-order actions, clients and notes, vendor rate and tags, voucher series,
  journal post/reverse/adjust, down payments, invoices, payments) this is every action that has an
  endpoint. Bodies are built in `lib/apiWrites.js` (pure) and checked by `scripts/verify-writes.mjs`
  (`npm run verify:writes`, 200+ checks: fake fetch, path + body + re-read keys; the demo sends nothing).
* **Reads that were missing.** Pending deals are now derived from accepted quotations (`adaptDeal`),
  petty cash and the two settings come from the server, the incentive pool and "latest rating" are worked
  out from `GET /projects/{id}/incentives` (`adaptLatestFeedback`), and `adaptAccount` now maps
  `group`/`parent`/`tax` (the live chart had lost its groups and flattened sub-accounts).
* **Server rules added because the prototype had them and the server did not.** Cancelling a project
  cancels its live purchase orders, refunds on request even when orders or costs exist (the first cut
  reused undo-down-payment, which refuses), and cancels open invoices (`ar/cancellation.py`). Stepping a
  project back out of Post-Event Feedback withdraws the client rating unless the pool was paid. An
  accepted quotation with no project yet can be declined. A venue return can be mixed (good / damaged /
  lost): the damaged part becomes its own maintenance row, a fully lost row becomes written off.
* **Not wired, and says "Not saved" instead of changing browser memory:** MoU templates (add, edit,
  duplicate, delete, clauses; no edit endpoint), renaming a tag, item tags, editing an asset, delivery
  orders (no domain), attaching a file to a CRM note (the screen records a name), the daily-jobs screen
  (its content is demo fiction), and Budgeting's "log unplanned cost" (it posts a made-up entry; the
  server's budgets are per project and have no screen). All parked for the client / a later round.
* **Verified.** `npm run verify` all pass (ledger, flows, adapters, chat, writes, proto, ai-fn); browser
  e2e (`scripts/chat-live-e2e.mjs`) 40/40 at the end of phase B; backend `test_project_cancel.py`,
  `test_inventory_return_split.py`, `test_ar.py`, `test_ap.py`, `test_incentives.py` pass; ruff and mypy
  clean; `vite build` clean. **Not run:** the full backend suite; the browser e2e after phases C-D (it does
  not cover the finance screens); a hand click-through of the finance screens against a live backend.
* **Next:** W4 (the ten pages that still compute statements in the browser move to report endpoints) and
  W5 (retire `seed.js`); then the parked list above.

**2026-10-11 — Workspace & tasks (branch `feature/workspace`, off `feature/chat`).**
The real server behind the prototype's Workspace: tasks, two-stage approval, blocked/overdue,
files, live updates and the task items in the bell. Code is in `erp-backend/app/domain/workspace/`
(`models`, `task_rules`, `tasks`, `files`, `events`, `notifications`, `router`, `schemas`) plus
`app/domain/chat/meeting_tasks.py` (tasks from minutes), `app/seed/tasks.py`, migration
`f2a6c9d4b731`. **Start here if you are a fresh session.**

* **What is live.** `GET/POST /api/v1/tasks`, `/tasks/{id|T-101}/start|block|unblock|submit|approve|reject`,
  `/attachments` (add, remove, short-lived link), `POST /chat/meetings/{id}/tasks`. Every move is made under the
  task's row lock and writes its history (texts kept as the prototype wrote them — the bell reads them) and an audit
  row. A task you may not see is **404, never 403**; not yours to do is 403, wrong state 409, incomplete 422.
  Connected people who can see a task get `task.created` / `task.updated` (each with their own `my_stage`) and
  `notifications.refresh`; a refused change tells nobody. The bell's task items are worked out from the data
  (`workspace/notifications.py`), through the chat notifications list.
* **Rules are the prototype's, replayed.** `task_rules.py` is a port of `workspaceAccess.js` + the store's task
  guards; `scripts/export-task-fixtures.mjs` drives the *real* `useProto` store (10 people × 171 tasks, 8 scripted
  flows) into `tests/fixtures/task_matrix.json`; pytest replays it twice — through the pure functions and through the
  real service over HTTP (`tests/test_workspace_tasks.py`). Re-run the exporter after changing the prototype's rules.
* **Frontend.** `store/useTasks.js` (non-persisted), `taskAdapters.js`, `lib/taskApi.js`, the facade (`chatProto.js`)
  now serves `tasks` and the task actions, the workspace pages have a loading/"not in the workspace" gate, project cards
  come from the chat bootstrap (a team login has no finance data), and the PM's Team & access toggles use the existing
  admin routes. **Every workspace/chat component must import `useProto` from `store/chatProto`**, never `store/useProto`.
  Project ids are carried under both the UUID and the business number (`EVT-…`) in `projectDivisions` and each member's
  `projectIds`, so the prototype's rules work unchanged on either.
* **POLICY to confirm with the client.** (1) The `workspace` module is open to **every ERP role** (backend `rbac.py`
  and frontend `roles.js`), like chat: a Sales login (Dinda) can be a Field leader there, and the persona — not the
  role — decides what is seen. (2) A **past deadline is refused by the server** (the prototype only checked it in the
  modal). (3) The CEO has no persona by default, so sees no tasks until an admin gives them one (parked since the
  identity question). (4) Priority is only High/Medium/Low in code; the W2 file cap (10 MB, 10 files) is a default.
* **Not built (not in the prototype either):** edit/reassign/reopen/delete a task, comments, subtasks, task↔task links.
  Concurrent approvals rely on `SELECT … FOR UPDATE` and are **not** tested concurrently.
* **Verification, honestly.** See the commits on the branch. All workspace/bell/meeting-task backend tests pass
  (`tests/test_workspace_*.py`, `test_chat_meeting_tasks.py`, `test_chat_notifications.py`); deliberate-breakage checks
  were run on the rules, the service, files, events/bell and tasks-from-minutes, and the survivors were closed with
  tests or are noted as equivalent (a second layer catches them: zip structure behind byte sniffing, SVG behind the
  type list). The **full backend suite was not run**. The two-browser e2e (`scripts/chat-live-e2e.mjs`) now has a
  workspace section (assign → start → attach → submit → approve → sign-off, bell at each step); see the final commit
  message for its last result.
* **Gotchas.** Never run two mutation scripts at once (they rewrite source files); never `ruff format app` repo-wide;
  on Windows run `python` scripts from files (a long heredoc with quotes breaks the shell tool); a sequence
  (`task_no_seq`) is not rolled back between tests, so assert `>= 405`, not `== 405`; chat tests' `world` fixture is
  the quickest way to get a PM, two leaders, staff and an intern on two projects.

**2026-10-10/11 — Team Chat: wiring, live bell, meetings and AI minutes (branch `feature/chat`, pushed).**
Picks up after C0–C5. Commits: F1–F3 `fc2c62e` (screens use the server when signed in), bell
`815f9f8`, meetings and minutes `a45c1ea`. **Start here if you are a fresh session.**

* **What is live now.** Signed-in users get real chat (REST + WebSocket, presence, typing, unread,
  attachments, join requests, DMs). The offline demo (no server) is unchanged — the facade
  `store/chatProto.js` returns the server's data when `isLiveUser`, the demo store otherwise. Any
  chat component must import `useProto` from `store/chatProto`, **not** `store/useProto` (that bug
  hid the minutes panel until the browser test caught it).
* **Bell.** Chat items: `GET /chat/notifications` (needs a workspace persona). Events and CRM items:
  `GET /notifications` (`app/domain/notifications/`; invitations to review, RSVPs, birthdays and
  anniversaries; module-gated; no persona needed), polled every 60 s by `store/useNotifications.js`;
  read state is per browser. **Not live:** task items, "Time to reach out" (no nudge cycles), and the
  links for events open demo data until the Events screens use the server.
* **Meetings and AI minutes.** `app/domain/chat/{meetings,meeting_rules,minutes,meeting_router}.py`,
  migration `e5b82a7c4d19`. Rules are replayed against the prototype's own answers
  (`tests/fixtures/chat_meeting_matrix.json`, from `scripts/export-meeting-fixtures.mjs`). Minutes are
  written server-side from the stored transcript; AI only with `AI_PROVIDER` + `AI_API_KEY` set and
  under `AI_MINUTES_PER_DAY`, otherwise rules (labelled, with the reason). Meetings are created only
  by the call service (not built) or the demo seed — never over HTTP.
* **Verification, honestly.** Chat + notification backend tests: **488 passed** (not the whole
  backend suite — a full run was stopped at ~90% with no failures earlier; run it before relying on
  it). Frontend: `verify:chat` 127, `verify:proto` 1147, render checks pass. Two-browser e2e
  (`scripts/chat-live-e2e.mjs`): **31/32** — the one failure, "a file attached by Rina opens in
  Dinda's browser", is a test-timing/selector problem (the feature works; debug runs showed the chip
  in both browsers). No live AI call has ever been made (tests use a fake service). Mutation checks
  killed all meeting/bell mutants after fixes; the first meetings run had 4 survivors (1 dead code
  removed, 3 got tests) — the commit message undercounts this.
* **Gotchas learned.** Never run two mutation scripts at once (they rewrite source files). Never run
  `ruff format app` repo-wide (reformats ~30 unrelated files). Windows `python` inside bash cannot
  read `/tmp`; use the scratchpad. Use `ENV=test alembic …` to autogenerate against the test DB.
* **Still open.** (1) **Live calls** — LiveKit chosen; needs a LiveKit account/server and an STT
  vendor decision; plan is in `~/.claude/plans/melodic-humming-book.md`. (2) **Tasks / Workspace**
  has no backend at all (`useProto.tasks`, `pages/workspace/*`) — it blocks task bell items,
  "create tasks from action items" and the `<#T-…>` links. (3) Recording/transcription consent and
  retention are unspecified — park for client.

**2026-10-10 — Team Chat backend, phases C0–C5, branch `feature/chat` (off `feature/events-core`).**
The real server behind the prototype's Team Chat. Everything the prototype's chat does is here
except **calls, meetings and AI minutes** (no server behind them yet); the screens still do not
call any of it. Commits: C0 `20ef6dc`, C1 `a590230`, C2 `923e7fd`, C3 `92db7ae`, C4 `520cf4a`, C5
(this one). Code is in `app/domain/chat/` (`access`, `rules`, `service`, `messages`, `attachments`,
`notifications`, `events`, `hub`, `ws`, `views`, `router`) and `app/seed/chat.py`.

* **Verification, honestly.** The last *full* suite was at C3: **984 passed**. C4 and C5 were
  checked with the chat, RBAC and seed suites (278 and 24 tests) and mutation checks, not a full
  run — run the whole suite before relying on it. Rule mutants killed: C1 7/7, C2 14/15 (the
  survivor is redundant by design), C3 15/15, C4 18/18. A live uvicorn + real WebSocket client run
  passed 14/14 checks (C3).
* **Identity.** One account is both the ERP login and the chat persona: `users` gained
  `member_no` (`M-05`, the id inside message text, never reused), `division`, `workspace_role`,
  `title`, `chat_status`. New ERP role **`team`** (chat/workspace only, no actions) for staff and
  interns — a client-policy change, mirrored in `roles.js`. `manage_workspace` (CEO, PM) sets
  people's place. `ChatMember` gates every route on module *and* persona.
* **Access rules** are a port of `workspaceAccess.js` (`access.py`), replayed against the
  prototype's own answers (`tests/fixtures/chat_access_matrix.json`, written by
  `scripts/export-access-fixtures.mjs`). A channel you cannot see is **404, never 403**; a DM is
  closed to everyone but its two people, the PM included.
* **Ordering.** Every change to a channel takes the next number from `chat_channels.rev` under
  its row lock, so numbers commit in the order handed out and "everything after rev N" cannot
  skip a row. A message's `seq` is that number at posting time: unique and ordered, **not
  contiguous** (edits and reactions use numbers too). `POST /chat/sync` resumes by `rev`.
* **Real time.** `hub.py` is in-process: WebSocket at `/api/v1/chat/ws`, auth is the *first
  frame* (not the URL), `Origin` is checked, tokens are renewed by a `reauth` frame, and the
  account is looked up again every minute. The socket only delivers; every write is REST, commits
  first and is announced after (`events.py`). **Single worker only**: a Postgres advisory lock
  makes a second worker refuse upgrades (close 1013); `Bus`-style delivery through
  `send()`/`broadcast()` is the seam for LISTEN/NOTIFY later.
* **Files and the bell.** `CHAT_FILE` storage kind re-encodes images (EXIF/GPS dropped); chat
  owns attachment *rows*, never the shared bytes; links are signed and last 5 minutes.
  `GET /chat/notifications` is derived on every read (mentions, join requests, answers), with
  access re-checked, and arrives live as `notification.new`.
* **Demo data.** `python -m app.seed.demo` then `python -m app.seed.chat` — ten people (Agus and
  Dinda updated, not duplicated), the four prototype projects, 17 channels, 23 messages. It is a
  separate step on purpose: folding it into `seed_demo` made an existing finance test fail (the
  projects reference the clients that test deletes).
* **Found by running things, not reading.** (1) Two sockets arriving together raced for the hub
  lock and the second was refused as if another worker held it — only a live server shows it, the
  tests switch the guard off; fixed and regression-tested. (2) Editing a migration that a database
  has already applied strands that database: the shared test database lacked a new column and 40
  tests failed with a `ProgrammingError`; drop `oscenia_erp_test` and let the harness rebuild it.
  (3) Mutation checks found two assertions that did not bite (an ordering test that passed on
  clock skew, an unread test that passed because posting moves your own marker); both rewritten.
* **Not done.** Calls, meetings, AI minutes. **Frontend wiring** (`chatApi.js`, adapters,
  `useChat`, the socket client, hiding the persona switcher in live mode). Tasks, events and CRM
  items in the bell. `focus` and message-search over the socket. Garbage collection of orphaned
  stored bytes (rows are purged after a day; the shared bytes are never deleted). A route guard
  by role in the prototype (a `team` login can still type `/finance`; the API refuses the data).
  More than one worker.
* **Known edges.** A signed attachment link keeps working until it expires (5 minutes) after
  access is removed. Editing a channel's settings drops members who are no longer in the
  workspace. The `team` demo login works offline in the prototype but has no live account until
  `python -m app.seed.chat` has run.

**2026-10-05 — Backend build Phase 1 (events core, staff side), branch `feature/events-core`
(off `main`). 759 tests green (was 665).** Per [Backend-Build-Plan](../Backend-Build-Plan.md). New
package `app/domain/events/`; one migration (`5d6a2f57d1b5`) with the six built-in templates
as frozen data. Fresh-context review: no critical findings; three should-fix fixed in
`a574ea4` with regression tests.

* **Steps** (one commit each): schema + rules ported from `events.js` / `invites.js` /
  `templates.js` (`rules.py`, `templates.py`); events, the invitation editor, submit / return /
  publish / unpublish, the client edit link, Template Studio (`service.py`, `studio.py`);
  guests, CSV import, questions, tables, checkpoints (`guests.py`); scans, check-in / undo,
  walk-ins, wish moderation, the report (`attendance.py`); demo seed EV-01/02/03.
* **Permissions closed:** every events endpoint needs the `events` module (CEO / PM / Sales);
  return, publish, unpublish and the client link need `publish_invitation`; studio writes
  need `manage_templates`. The prototype checked only publish, and only in the UI.
* **Decisions:** UUID keys plus `event_no` (`EV-01`, sequence `event`); questions and
  checkpoints keep per-event keys (`Q-n`, `CP-n`) that are never reused. `published` snapshots
  the draft and `published_template` the template at publish. PATCH refuses `date`, `time`,
  `venue` and `status` by name — they follow the invitation's details (D8) and Publish. The
  server stores file references only (no inline `data:` images) and bounds section size and
  depth. Guest links and QR codes are signed + versioned (`links.py`); a revoked guest's old
  QR no longer checks in. Client edit links expire after `CLIENT_LINK_DAYS` (90).
* **Demo seed:** exported from the prototype by `erp-frontend/scripts/export-events-seed.mjs`
  into `app/seed/events_seed.json` (re-run it after changing `protoSeed.js`), loaded by
  `app.seed.demo`. EV-02's 16 / 4 / 5 / 6 grid holds. Clients match by name; the backend demo
  has no projects, so seeded events have none.
* **Waiting for later phases:** `submit_rsvp` and `add_wish` are tested services — their
  public routes are Phase 2. Broadcasts, reminders and the send log (and their seed rows) are
  Phase 4. **Phase 3 must** accept only storage keys the event or template uploaded: today a
  file reference takes any key, which signed URLs would then serve (review advisory 4).
* **Open (Phase 2):** which template copy the public page renders. `add_wish` follows the
  prototype — the live template — and `published_template` keeps the copy as published.

**2026-10-05 — Backend build Phase 0 (foundation), branch `feature/backend-foundation`. 665
tests green.** Fresh-context review: no critical findings; five should-fix and the cheap advisories fixed (see the five commits after `abb0374`), 665 tests green. Per [Backend-Build-Plan](../Backend-Build-Plan.md). `main` fast-forwarded to
the prototype branch locally (not yet pushed); `origin` now points at `rahuls18-damco`.

* **CI** — `.github/workflows/ci.yml`: ruff, mypy, pytest on Postgres 16; `npm run verify`,
  `verify:render`, `vite build`. ruff and mypy are pinned; `ruff format` is not gated.
* **Deploy** — `erp-backend/Dockerfile` and `deploy/` (Compose: db, migrate, api, Caddy;
  deploy/backup/restore scripts; runbook in `deploy/README.md`). Exercised locally end to end,
  including a backup restored into staging. No demo users or demo data in production;
  real users via `python -m app.seed.users`.
* **RBAC** — `publish_invitation`, `manage_templates` (CEO, PM); `events`/`templates`
  modules. Tests now check parity with `roles.js` directly. `users.active` already existed.
* **Audit log** — `audit_log` table (append-only trigger) and `record_audit()`. Answers Q13.
* **Throttle** — login lockout moved to the `rate_limits` table; generic `Throttle` for
  Phase 2's public-route limits. The scheduler is still in-process, so still one worker.
* **Storage** — `app/core/storage.py` replaces `cash/storage.py`: per-kind limits (photo 15,
  video 200, music 20 MB, artwork), type/extension/byte sniffing, no SVG, image re-encode
  (EXIF stripped), served via signed `/files/{key}` URLs with Range support.
* **Links and QR** — `app/core/links.py`: HMAC-signed, versioned, scoped, optionally expiring
  tokens; `OSC1:` signed QR payloads. **Decision:** signed + version rather than hashed random
  tokens, because staff re-copy guest and client links. Version columns come with Phase 1.
* **New secret** — `SIGNING_SECRET`, refused at its dev default in production, like `JWT_SECRET`.
* **Not yet exercised:** a real VPS, DNS and Let's Encrypt, rclone upload. The rate-limit purge
  is a function, not yet a scheduled job (wire it when public routes land).

**2026-10-05 — Round 4 review fixes. 573 tests green.** Two holes the fresh-context review
found in the round-4 guard, closed in `app/domain/ledger/overrides.py` and the chart service:

* **Other-control-account rule.** Edited lines may not touch the *other* control account —
  2102 inside a client receipt, 1201 inside a vendor payment — nor a sub-account of either.
  A balanced "Dr 1201 / Cr 1101" added to a vendor payment passed the old guard (2102 still
  moved by exactly the gross) and moved the receivable with no invoice behind it, so AR open
  items stopped reconciling with 1201. Also refused: a contra line on the locked control
  account that nets back to the right figure. Both 422. The prototype's `validateEdited`
  (`erp-frontend/src/lib/postings.js`) applies the same rules.
* **Sub-account rule.** `POST /accounts` refuses a sub-account under 1201 or 2102 (409): it
  would turn the control account into a header, which accepts no postings, and every receipt
  and payment would then fail. The prototype's chart editor refuses it too.

**2026-10-05 — Round 4, Unit 3 (frontend wiring). 568 tests green.** The five money pop-ups
now post to these endpoints on a live backend: the editor is seeded from the server's
`?dry_run` (re-asked as dates, account, withholding, tax or amount change) and sends
`lines` only when a line was edited and `tax_amount` only when a figure was typed
(`erp-frontend/src/lib/apiPostings.js`). Receive payment and pay bill reach the API for the
first time. A 422 `detail` shows in the pop-up, which stays open. One backend addition:
`POST /journal-entries/{id}/adjust` takes `document_date` for the replacement entry (it had
no way to carry the corrected receipt's date). The memo is not sent — none of the money
endpoints takes one, so live the pop-up shows the server's memo read-only.

**2026-10-05 — Round 4, Unit 3: REQ-05 v2 (editable lines at posting) and REQ-01 extended to every money endpoint. 567 tests green.**

**REQ-05 v2 reverses a decision this file recorded in round 3.** Round 3 kept posting lines
read-only and pointed at **Adjust** for corrections, and said that if the client meant a
free-form editor at the moment of posting, that was a different feature and needed saying.
Round 4 said it (`docs/Client-Feedback-Round-4.md`): the operator edits the lines in the
confirmation pop-up before posting. What may change is deliberately narrow, enforced once in
`app/domain/ledger/overrides.py`:

* **Only the payment/receipt entry.** Companion accruals an operation also posts — the DP
  recognition invoice, the vendor bill, a settlement variance — are never replaced.
* **The control account moves by exactly the computed gross** (net Cr 1201 for client money,
  net Dr 2102 for vendor money). That movement is what settles the open item — `applied_to`
  links the entry, open-item ageing measures the movement — so the linkage stays correct
  whatever else the lines do. Change the amount paid, not the control line.
* Every account exists, is active and is not a header; each line is one side and ≥ 0; the
  lines balance. **All refusals are 422** with a message naming the problem. The posting
  engine's period check and the deferred balance trigger still apply independently.
* When lines are edited, the response's `tax` is what was actually posted to 1401 (AR) or
  2105 (AP), and `net = gross - tax`.

**REQ-01 extended.** `document_date` (the date on the receipt / vendor invoice) is now taken
by confirm-DP, receive-payment, pay-bill and pay-DP and stored as the payment's
`source_document_date`; PO settle maps its existing `invoice_date` onto the payment as well as
the bill. **No new column, no migration:** `entry_date` is the received date (reports already
use it) and `source_document_date` the receipt date. Preview entries now return
`source_document_date` too.

**A bug on the way:** `POST /journal-entries` accepted `source.document_date` and dropped it —
the router built `PostSource` without it. Fixed and tested.

**`?dry_run`** added to `POST /invoices/{id}/payments` and `POST /purchase-orders/{id}/pay-dp`
(same savepoint pattern; pay-DP previews two entries, the bill and the payment).

New request fields (all optional):

| Endpoint | Body | New fields |
|---|---|---|
| `POST /quotations/{id}/confirm-down-payment` | `ConfirmDpRequest` | `tax_amount`, `document_date`, `lines` — all apply to the DP **receipt** only |
| `POST /invoices/{id}/payments` (+ `?dry_run`) | `PaymentRequest` | `document_date`, `lines` (`tax_amount` already existed) |
| `POST /bills/{entry_id}/payments` | `PayRequest` | `tax_amount`, `document_date`, `lines` |
| `POST /purchase-orders/{id}/pay-dp` (+ `?dry_run`) | `PayRequest` | `tax_amount`, `document_date`, `lines` (payment only, never the bill) |
| `POST /purchase-orders/{id}/settle` | `PoSettleRequest` | `tax_amount`, `lines` (final payment only; `invoice_date` is its document date; `lines` refused when nothing is left to pay) |

`tax_amount` is a decimal ≥ 0, wins over `withhold` (and the vendor's rate), refused above the
gross. `lines` is `[{account, debit, credit, note}]`, at least two.

One harness note for whoever writes the next refusal test: the test client shares one session,
so a refused **real** call leaves earlier writes of that request visible (e.g. the bill pay-DP
raised lazily). Production rolls the whole request back (`get_session`). Assert on the dry-run
path for "nothing at all was written".

**2026-09-22 — Round 3: REQ-01's screens and REQ-05 (confirm before posting). 543 tests green.**

**REQ-01 had shipped without a way to reach it.** The columns, the endpoints and the tests
landed in `67851c6`; what did not was any screen that sent the dates. `issueInvoice(r.id)`
took none, the Settle modal asked only for an amount, and neither table showed a document
date. A feature that exists and cannot be reached is worse than one that does not, because
it reads as done. Issuing now asks for both dates in a modal that labels which is which,
the AR table shows the invoice's own date (with "recorded <date>" underneath when they
differ), settling takes the vendor's invoice date, and Payables shows it. Ageing falls back
to the document date when there is no due date — falling back to today would age an undated
invoice at zero days, which reads as "current" for something months old. One silent bug on
the way: `adaptEntry` dropped `sourceDocumentDate`, so the new AP column would have rendered
blank on live data while working perfectly on the seed.

**REQ-05 — "a pop-up must appear first".** `?dry_run=true` on the four endpoints behind the
three modules the client named: issue an invoice, confirm a down payment, settle a purchase
order, pay a vendor bill.

The preview **runs the real operation and undoes it** rather than recomputing the same lines
somewhere else. A parallel implementation would agree on the day it was written and drift
silently after, and a confirmation dialog showing something other than what will happen is
worse than no dialog. Undoing is a SAVEPOINT rollback, not a session rollback, and that
distinction is load-bearing twice: in production a session rollback would discard whatever
else the request had done, and under test it would throw away the fixtures the test itself
created — a failure that would have read as broken fixtures rather than as a preview
reaching too far.

Three properties are worth more than the feature itself, and each has a test:

* **Nothing is written.** The entry count is unchanged and the invoice is still `Scheduled`.
* **No voucher number is burnt.** The counter increment rolls back too, so opening a dialog
  and closing it cannot leave a gap in the numbering — and the number the preview showed is
  the number the confirmed call takes.
* **A refused posting refuses in preview too.** A dialog that swallowed the 409 would show a
  posting and then fail on confirmation, which is worse than refusing up front.

`confirm-down-payment` previews **three documents** — the receivable, the receipt and the
project — and returns 200 rather than that route's 201, because nothing was created.

One interpretation stated rather than assumed: the client also wrote *"adjust accounts or
consolidate lines on the fly"*. These operations compute their own lines; letting them be
rewritten at the point of posting would make an invoice entry something other than an
invoice entry. The dialog therefore shows the accounts and points at the path that does
allow it — post, then **Adjust**, where the correction is its own filed document and, since
REQ-06, both carry one journal code. If the client meant a free-form editor at the moment of
posting, that is a different feature and needs saying.

The dialog is one component (`ConfirmPostingModal`) behind one hook (`useConfirmPosting`), so
the three modules confirm identically rather than three ways. In the seeded demo there is no
server to ask, so it says so plainly instead of rendering an empty posting — an empty
confirmation would be a lie about an action that posts three documents.

**2026-09-22 — Round 3: REQ-06 (journal codes) and REQ-10 (global search). 531 tests green.**

**REQ-06 read literally asks for the wrong change.** "Prevent the proliferation of journal
numbers" sounds like an instruction to stop reversals taking their own voucher number — and
this codebase already argues against that in a comment: *"the auditor needs to see the
correction as its own filed document"*. Each document keeps its own immutable `voucher_no`.
What was missing was any record of **which document they all belong to**, which is a
different question, so it is a new column rather than a numbering change.

`journal_entries.group_ref` holds the **anchor entry's voucher number**, so a group is named
after the original. The anchor itself is left unstamped, and that is forced rather than
chosen: the append-only trigger rejects every UPDATE, so the original cannot be marked when a
correction joins it later. `list_entries` therefore matches `group_ref` **OR** `voucher_no`,
which is what makes one code return the whole document — original plus every correction. A
reversal joins its original's group; an adjustment's reversal and repost both join it, so
three filed documents carry one code and each keeps its own number. A manual entry can name
a code to file under, and an unknown one is **refused (422)** rather than stored: entries are
immutable, so a mistyped code could never be repaired and the row would sit alone in a group
forever.

The second half of the item — administrators defining their own series — needed `POST` and
`DELETE /voucher-series`. Creation validates the format the way an edit already did (a format
with no `[SEQ_nnn]` token issues the same number forever). Deletion is refused for a series
anything was numbered from, because a voucher number has to stay resolvable for as long as
its entry does; for a series nothing was numbered from, its counter rows are cleared first,
since `voucher_counters.series_key` is a foreign key and a leftover row would turn a
legitimate delete into a 500.

**REQ-10 was structural, not a missing filter.** The search box read the six collections the
browser happened to be holding, out of eleven, so a purchase order, a stock item, a crew
member, a fixed asset and a petty-cash request could not be found **at all** — and nothing
could be found before it had been loaded. A cap of eight results hid whatever was left. State
in the browser is a subset of the database by definition, so no amount of filtering fixed it.

`GET /search` searches all eleven kinds in the database and ranks in SQL: an exact document
number (100) outranks a prefix (80), a name prefix (70), a name fragment (55), a mention in
some other field (40) and finally an amount inside the band (35). Ranking before the LIMIT is
the point — scoring afterwards would let the exact match be cut before it was ever ranked.
Scores come back in the payload, so the ordering can be explained and tuned rather than
argued about, and the group holding the best hit leads the list. Two behaviours were kept
from the client-side version because they were right: a number searches amounts as well as
identifiers, and amounts match within 1% or Rp 1,000,000, whichever is wider. Three digits is
a quantity or a year, so it is not read as a figure.

Two details worth recording. Ties are broken by document number in SQL: scores come in bands,
so a prefix search ties for most of its results, and without a second key *which* five of
twenty came back varied between identical requests. And the correlated totals (a quotation's,
a purchase order's, a journal entry's value all live on their lines) are correlated
**explicitly** — left to guess, SQLAlchemy strips the subquery's own FROM when the outer query
mentions the same table, which the purchase-order search does, and the statement then has no
FROM at all.

On the prototype side the top bar is debounced (200 ms), grouped, and says so when a search
request fails rather than rendering an empty list — the two are otherwise indistinguishable
from "that record does not exist". A stale answer is discarded: at one request per keystroke
the answer to "AUR" can arrive after the answer to "AURORA". The in-memory search survives in
`lib/search.js` for the seeded demo, which has no server, with the same hit shape and the same
ranking bands. `verify:api` covers the new endpoint against a live backend.

**2026-09-06 — Phase 8 complete. Scheduler and hardening, 494 tests green. All eight phases done.**
The five cron jobs made real, `job_runs` behind them, reminders as their output, login rate
limiting, request-id logging, the demo seed, and a pass over the OpenAPI schema names.

**The five jobs existed only as seed rows** — `{ id: 'CJ-2', lastRun: 'Today 08:00' }` with
nothing behind them — so each had to be given an actual definition. Four raise reminders.
The fifth, *Weekly LTV recompute*, **has no work to do and says so**: lifetime value is derived
from the ledger on read and never cached, so there is nothing to refresh. It reports `skipped`
every week by design, and stays registered so the screen still shows five rows with the reason
visible rather than a row quietly disappearing.

*A bug found by reading the code, which the tests could not see.* `run_job` recorded a
failure and then **re-raised**. That propagates into whichever transaction the caller opened —
the scheduler's, or the request session, which rolls back on any exception — and takes the
FAILED row down with it. The table whose entire purpose is answering *"did month-end run, and
what happened?"* would have been empty for precisely the runs worth asking about. The tests
passed because they inspected the row inside the same transaction that was about to discard
it. A failed job is now a **result, not an exception**: the row is written, the traceback
logged, and a manual trigger returns `200` with `status: "failed"` rather than a 500 that
would roll back the evidence.

*The gap phase 2 flagged by name is closed.* argon2id makes each guess expensive, but expensive
is not bounded and nothing counted them. `app/core/throttle.py` counts failures per account
**and** per client IP — per-account alone lets a spray across a thousand accounts pass, per-IP
alone lets a botnet grind one account down — and a correct password clears both, so two
fat-fingered attempts do not leave a user one mistake from a lockout. It is a dict behind a
lock, which is right for one uvicorn process and **wrong for two**; that is stated in the
module and the README rather than left to be discovered.

*The demo seed found a discrepancy in the client's own data.* Opening `1301 Consumables` is
28,200,000; the consumable stock the prototype ships is worth 22,068,000 — a **6,132,000** gap.
1302 ties to the rupiah, and the prototype's own comment only ever claimed the tie for fixed
assets. The seed loads both numbers as given and **reports the gap**, because silently
correcting a client-reviewed opening balance and silently shipping a broken reconciliation are
both the wrong call. Parked as [Q16](./07-open-questions.md).

*OpenAPI had fourteen colliding schema names* — `app__jobs__router__RunRequest` and friends,
which is what FastAPI falls back to when two modules define a class with the same name. The
frontend team would have had to consume those. All fourteen renamed to something meaningful
(`QuotationLineIn`, `JournalLineIn`, `StatementLineOut`, `PayablesAgeingOut`…); zero mangled
names remain.

Also: the seed now creates fixed assets **through** `assets.capitalise(post=False)` rather than
constructing rows, so it obeys the same validation and numbering as the API instead of
maintaining a second copy that only it gets wrong. And phase 7 shipped an
`in_transit` status nothing could ever set — the in-transit return check had nothing to look
at — so `POST /inventory/{id}/check-out` was added to complete the pair.

**2026-09-06 — Phase 7 complete. Fixed assets and payroll, 451 tests green.**
The asset register with straight-line and declining schedules, idempotent depreciation runs,
disposal, prospective life revision, crew incentives, and the three warehouse movements that
reach the ledger.

**The schedule is a projection, not draft journal entries.** The client's proposal asks for
"automated draft journal generation for upcoming periods until the end of the asset's useful
life". The obvious reading is sixty unposted entries in the journal — and then every balance
query, both statements, the trial balance and every invariant test has to learn to exclude
them, and one missed filter reports depreciation that has not happened. So `schedule.py` is
pure functions over an asset row, and only the run posts.

**A run is one entry per period with a line per asset**, not one entry per asset: thirty-six
entries for six assets over six months would bury every other transaction in the journal.

*Three things the arithmetic had to get exactly right, each checked by property test across
8 lives × 2 methods × 4 cost/salvage pairs — 64 combinations:* every schedule lands **exactly**
on `cost − salvage`, no charge is ever negative, and no asset ever falls below its salvage
value. The final period absorbs the rounding remainder; without it an asset ends its life a
few rupiah from its own residual value and somebody writes that off by hand every month,
which is the manual work the feature exists to remove.

*One deliberate divergence from the prototype.* On a total loss `_writeDownRegisteredAsset`
sets `cost: 0`, which the `cost > 0` check constraint refuses. The asset is marked **disposed**
with its cost intact instead — the register excludes disposed assets, so the totals match,
and the acquisition history survives rather than being zeroed.

*And one numbering collision avoided.* A disposal cannot reuse the acquisition's
`source_ref`: the partial unique index on `('depreciation', ref)` already holds `FA-007` from
the capitalisation. Disposal posts under `FA-007-DISPOSAL`.

**Mutation testing found two assertions that did not bite**, out of eighteen mutants:

*The register's reconciliation badge could never read `False`.* Hardcoding `reconciled=True`
passed every test — the numeric equalities still held, and the flag assertion was trivially
satisfied. A badge that can only ever read True is decoration, not a check. Now there is a
test that forces the drift the way it would really happen (an asset registered as "already
carried in 1302" when nothing was posted there) and asserts the badge reads `False`.

*The sealed-column guard was unreachable over HTTP.* `AssetRevise` has no `cost` field, so
Pydantic drops it before the service is called — the HTTP test passed whether or not the
guard existed. Every other caller does reach it (the seeder, a data fix, a future admin
endpoint), so it is now exercised at the service directly.

*And one place the code was quietly breaking its own contract.* [04](./04-api-contract.md)
promises **422** when a revision tries to change `cost` or the posted figures. Because those
fields were simply absent from `AssetRevise`, Pydantic dropped them and the endpoint returned
**200** — a caller who asked to change the cost walked away believing it had. The sealed
columns are now *declared in order to be refused*, by name and with a reason.

One mutant survived for a good reason and was left alone: removing the unknown-project guard
in `disburse` still returns 404, because `pool_for` looks the project up too. The behaviour
is right; the guard stays for the better message.

*A process note worth keeping.* The first mutation script crashed mid-run and left
`if False:` in `payroll/service.py` — every subsequent run then carried a phantom failure,
and the one mutant whose count was fully explained by it looked "caught" when it had in fact
never been applied. That is how the unreachable sealed-column guard was found. **Restore in a
`finally`.**

**2026-09-06 — Phase 6 complete. Cash operations, 319 tests green.**
Petty cash as a float, the five-status procurement workflow with its mandatory requester,
budgets with derived actuals and a warn-once tolerance, and **real file storage** — the one
genuinely new capability rather than a port.

Files are content-addressed: the stored name is a SHA-256 of the content, never the
uploaded filename, which is attacker-controlled. Size is measured while streaming rather
than read from `Content-Length`, which a client can lie about. Accepted types are narrow on
purpose — this is an accounting evidence store, not a general file share.

Petty cash now has **one** source of truth. The prototype computes the float twice, from the
ledger and from the request list, and asserts the two agree; here it is derived from the
ledger alone. A reconciliation you have to run is a bug waiting to happen.

Five problems this phase, and two of them were mine rather than the code's.

*A design error I created.* I documented "two records, one blob" for content-addressed
storage and then put `unique=True` on `storage_key`, forbidding exactly that. Two
attachments legitimately share a blob — the same receipt filed against two requests. The
test caught the contradiction between the prose and the schema.

*A repeat of a mistake already made.* `MissingGreenlet` on `receipts` and `categories` is
the same unloaded-collection trap as `entry.lines` in phase 1. The pattern worth
remembering: **a collection on a freshly-created object must be assigned through the
relationship**, not populated with `session.add`, or it stays unloaded and fails the moment
a serialiser touches it.

Also: mypy caught a query helper annotated `-> object`; a test of mine asserted 18.5M where
the arithmetic gives 16.5M; and Alembic's autogenerated `downgrade()` drops tables but
leaves the enum types it created, so a downgrade-then-upgrade failed with "type already
exists". The migration now drops them explicitly and round-trips.

**Worth remembering once this leaves one machine:** deleting an already-applied migration
strands any database stamped at it. The dev database could be downgraded first; the test
database was left pointing at a revision that no longer existed and had to be dropped.
Harmless here, an incident on a shared database.

**2026-09-06 — Phase 5 complete. Accounts Payable, 286 tests green.**
Vendors with per-vendor PPh 23 rates, catalogue with date-aware availability, tags, the
five-status purchase-order lifecycle, lazy bill raising, vendor payments, variance
settlement and refunds, and AP ageing reconciled against 2102.

Both withholding directions now sit on the books at once and are asserted to: 1401 as an
asset (tax withheld *from* us) and 2105 as a liability (tax withheld *by* us), on opposite
sides of the balance sheet, never netted.

**All 29 tests passed first time, which for a module this size is not evidence of
anything** — so the two load-bearing claims were mutation-tested. Making approval raise the
payable (the round-1 bug that showed a false loss) fails `test_approval_posts_nothing`.
Reversing the bill before its payments on cancellation (the §63 bug) fails
`test_cancelling_reverses_the_payment_and_the_bill`. The assertions are real.

One bug, and a trap worth remembering: I named the purchase-order line constraint
`line_order`, which `quotation_lines` already claimed in phase 4. An explicit
`UniqueConstraint(name=...)` is used **verbatim**, and Postgres constraint names are
schema-wide — so the migration failed outright. The naming convention in `db/base.py`
protects auto-named constraints but is bypassed by explicit ones. Renamed to
`po_line_order`.

Also closed the second phase 1 IOU: `journal_entries.source_vendor_id` is now a real
foreign key to `vendors`.

**2026-09-06 — Phase 4 complete. Accounts Receivable, 257 tests green.**
Clients and CRM notes, MoU templates, quotations with per-line estimated cost, phased DP
schedules, projects with stage history, invoices, receipts with PPh 23, and AR ageing with
a live 1201 reconciliation.

Three columns are deliberately **absent**, each for the same reason: `invoices.paid`,
`invoices.outstanding` and `projects.realized_cost` are all derived from the ledger. Storing
them invites exactly the drift the Receivables reconciliation badge exists to detect — and
because collection is summed from applications, reversing a receipt reopens the invoice with
no extra code.

Also closed a deferred item from phase 1: `journal_entries.project_id` was a bare UUID
because `projects` did not exist yet. It is now a real foreign key.

Two bugs, and the second changed a design decision.

*The ordinal collision.* Replacing a quotation's lines violated
`UNIQUE (quotation_id, line_no)` — SQLAlchemy emits the new INSERTs before the orphan
DELETEs in one flush, so line 1 collided with the line 1 being removed. Fixed with
clear-then-flush-then-replace; the stages path had the same latent bug.

*Undo cannot delete the project, and should not.* Undoing posts reversal entries, those
entries carry `project_id`, and journal entries are immutable — so the reference cannot be
nulled, and the new foreign key will not allow the row to go. **The prototype deletes the
project because it has neither constraint.** Undo now voids instead: the ledger keeps the
reversal pair, invoices go to Cancelled, and the project remains as a shell explaining why
those entries exist. It also releases `quotation_id` so a voided attempt cannot permanently
block a correct retry. Worth raising with the client — "undo" now leaves a visible trace
rather than pretending nothing happened, which is what an auditor would want.

**2026-09-06 — Phase 3 complete. Statements and project P&L, 199 tests green.**
Income statement through to NPAT, balance sheet, executive roll-up, project P&L with four
comparison modes, and tax configuration.

The whole risk in this phase is the **two derived rows** — Provision for Income Tax under
liabilities, Current Period Earnings under equity. There is no closing entry, so the sheet
only balances because both are present. Rather than trust that the tests covered it, I
mutation-tested it: deleting the provision row fails four tests, and correctly still passes
at a 0% rate where there is no provision to delete. The assertions are real.

Corporate tax is computed from the configured rate and never posted, which is what makes
the client's "manual override prior to displaying Tax Expense & Net Profit" work — changing
the rate moves NPAT and the balance sheet together, so it stays balanced at 0%, 22% and 40%.

Two judgement calls worth recording. **No tax is charged on a loss**: a negative charge
would be a loss carry-forward, which is a real feature and a real decision, not something
to imply by accident. And **the balance sheet takes no `project_id`** — a balance sheet for
one project is not a meaningful document, since cash, receivables and equity are
company-wide, so it is not offered rather than offered and quietly wrong.

Deferred: **comparison against a budget** needs budgets, which arrive in phase 6. The other
three modes (month-on-month, previous period, year-on-year) and project-on-project are in.

Review caught one duplication before it could drift: `month_end` was defined in both
`periods.py` and `pnl.py`. Duplicated date arithmetic is exactly the kind that diverges
quietly.

**2026-09-06 — Phase 2 complete. Auth and RBAC, 158 tests green.**
The 5x20 matrix is ported verbatim from `roles.js` and enforced **server-side** as a FastAPI
dependency. `require_action` is a dependency rather than a decorator for one reason: it has
to reach the permitted-role list into the error body, so a denial reads *"Post or adjust
journal entries — restricted to CEO / Finance"* rather than a bare 403.

argon2id for passwords, JWT access tokens (30 min) and rotating refresh tokens (14 days)
recorded in a `refresh_tokens` table so they can actually be revoked. Rotation means a
stolen refresh token is usable at most once.

Three things running it caught:

*The seeder was idempotent by existence, not by convergence.* Adding password hashes did
nothing to an already-seeded database — the users existed, so they were skipped and kept a
NULL hash, and nobody could log in. It now backfills a password when the column is NULL,
which can never clobber a real one.

*The default JWT secret was 23 bytes.* PyJWT warned on every single token: HMAC-SHA256
wants at least 32 (RFC 7518 §3.2). The default is now 45 bytes and `Settings` refuses to
start at all below 32, or with the dev key when `ENV=production`.

*`EmailStr` needs `email-validator`*, which was not a declared dependency — the entire suite
failed to import until it was added.

And reviewing the finished code found a real vulnerability. `authenticate` short-circuited
on `user is None`, so a nonexistent account skipped argon2 entirely and answered in
microseconds while a real one took tens of milliseconds. Reintroducing the bug to check
measured a missing account answering **25.8x faster** — a trivially exploitable
user-enumeration oracle, leaking exactly what the identical error message exists to hide.
Both paths now hash against a dummy, and the test is mutation-checked so it cannot pass
vacuously. A second review catch: the `security.py` docstring claimed role changes take
effect at the next refresh, when `current_user` reads the role from the database and they
are immediate. Wrong security documentation is worse than none.

Also added refresh-token **reuse detection**: replaying a spent token revokes every session
for that user, because a client bug and a theft are indistinguishable from the server and
only one of them is safe to assume.

**Known gap:** no rate limiting on `/auth/login`. argon2 makes online guessing slow, but
slow is not bounded. Belongs with phase 8 hardening.

**2026-09-06 — Phase 1 complete. 22 endpoints, 117 tests green.**
The HTTP boundary is in: chart of accounts (list, tree, detail, create, patch,
activate/deactivate, delete, next-code, stats), journal (list, detail with the linked
chain, post, reverse, adjust), open items, voucher series with live preview, period
close/reopen, and the trial balance, general ledger and cash position reports.

Two deliberate absences. There is **no PUT, PATCH or DELETE on a journal entry** — a test
asserts all three return 405, because the absence is the feature. And `code` and `type` are
not in `AccountUpdate`: renumbering or retyping an account with history moves it onto a
different financial statement, so it is not offered at all rather than offered and refused.

Money crosses the wire as a **decimal string**, never a JSON number — a JSON number is an
IEEE 754 double by the time a client parses it, which would undo the entire point of using
`NUMERIC` underneath.

`app/core/deps.py` carries a `CurrentUser` placeholder that resolves the seeded system user,
so entries stamp `posted_by_user_id` truthfully rather than trusting the request body.
Phase 2 replaces the body of that one function.

**2026-09-06 — Phase 1 ledger core. 75 tests green.**
The posting engine, numbering, the chart of accounts, periods and the report queries
(trial balance, general ledger, open items, cash) are in and verified against real
Postgres. Six triggers now enforce the invariants in the database: balanced entries
(deferred to COMMIT), append-only journals and lines, locked accounts, one-level nesting,
and closed periods.

Five bugs found by reviewing before running, and three more only by running:

*Reviewing caught* — enums persisting their **names** rather than values (`'ASSET'` where
every fixture says `'asset'`), a check-then-create race on the first voucher of a period,
`reverse_entry` patching `reversal_of_id` **after** insert (which the append-only trigger
would have rejected), `User` sitting in the ledger module, and a partial index built from a
`MappedColumn` rather than SQL text.

*Running caught* — `unique=True, index=True` on `accounts.code` emits a separate unique
index **after** the table, so the self-referencing `parent_code` FK had nothing to point at
and `CREATE TABLE` failed; a nested aggregate in the open-items query
(`sum(-(sum(...)))`), which Postgres refuses outright — the opposite direction is the
mirrored movement computed once, not the original negated; and `entry.lines` raising
`MissingGreenlet` because lines were added via `session.add` instead of through the
relationship, leaving the collection unloaded.

None of the three would have been caught by reading. The first two are the kind that look
right on the page.

**2026-09-05 — Phase 0 complete. 26 tests green against real Postgres.**
Three real defects surfaced only by running things, none of which a read-through had caught.

*A timezone bug in the clock.* `SystemClock.today()` returned UTC. Oscenia is UTC+7, so for
seven hours of every day the backend's "today" was yesterday — which would have quietly
shifted every ageing bucket, DP countdown and depreciation due date. Caught because a live
`/health` read `2026-09-04` while the machine's clock said the 5th. `today()` now reads
`Asia/Jakarta` (configurable via `TIMEZONE`); `now()` stays UTC, since only the calendar
date is local. **This one mattered: it would have been invisible in tests using the frozen
demo clock and wrong in production for a third of each day.**

*A port collision.* A native `postgresql-x64-17` Windows service already holds `0.0.0.0:5432`
on this machine. Docker only won the IPv6 half, so `localhost:5432` resolved to the other
server and failed authentication against a perfectly healthy container. The compose file now
publishes **5433**, with a comment so nobody moves it back.

*Docker could not start at all* until WSL2 was capped. This machine has 7.69 GB RAM and was
at 96% use; WSL2's default claim left no room for the engine, which sat in `starting`
indefinitely while returning `500` on every API call. A `~/.wslconfig` capping the VM at 2 GB
fixed it — Docker then came up in 12 seconds.

**2026-09-04 — Phase 0 built.**
`erp-backend/` scaffolded. 20 of 24 tests pass; `ruff` and `mypy --strict` are clean.
Running the tools caught four things a read-through had not: `mypy` rejected string
defaults on the two `PostgresDsn` settings fields, and `ruff` found three import-ordering
issues plus a `SIM300` that rewrote an assertion *into* a Yoda condition — that rule is now
disabled for `tests/`, because the ported suite is thousands of `assert actual == expected`.

The 4 database tests remain unrun. Docker Desktop on this machine sits in `starting`
indefinitely: its `docker-desktop` WSL distro boots on demand (`wsl -d docker-desktop`
returns fine) but `dockerd` never serves, so every engine call returns
`500 Internal Server Error` on `/v1.51/...`. A full Docker Desktop restart or a reboot is
the usual fix. Nothing about the failure implicates the backend code.

**2026-09-04 — Specification written.**
Explored the prototype end to end: 18 finance screens, ~70 store mutations, the seed data,
the report algebra, both verification suites, and both client feedback decks. Confirmed there
is no backend of any kind. Wrote the nine documents in `docs/finance-backend/`. No code yet
by design — the prototype is a good enough specification that transcribing it carefully costs
far less than discovering mid-build that the Balance Sheet no longer balances.
