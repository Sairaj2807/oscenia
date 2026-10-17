# Oscenia website and ERP: what is built, on which branch, and what is left

> Written 2026-10-12 from `git` (all local and remote branches), `docs/finance-backend/STATUS.md` and `FE-BE-GAP-LIST.md`.
> **Updated 2026-10-14** after the gaps plan (phases P0 to P9) was built on `feature/finance-gaps`: sections 2, 3 and 4 and the
> gap list now match the code at `8216c9d`. The exact state, the gates and the working rules are in `docs/SESSION-HANDOFF.md`.
> Branch contents come from commit history and those documents; I did not re-run every older branch.
>
> **Merged 2026-10-15.** The whole stack went into `main` in one pull request (#3, a merge commit, `d82480c`; #2 closed with it).
> `main` now holds everything in sections 2 and 3. The branch tables and section 7 below describe the state *before* the merge and are
> kept as history. On the merged `main` the backend suite passed: **2,129 tests in 11 batches, every batch exit 0**, the same counts as
> on the branch. Not re-run on `main`: `ruff`, `mypy`, `npm run verify`, `build`, and the click-throughs. Nothing is deployed.
> The merged branches and the `Oscenia-invitations-v2` worktree have not been deleted yet.

## 1. The one thing to understand about the branches (as of 14 Oct, before the merge)

The work is **one stack of branches, each built on the one before**, and almost none of it is on `main`:

```
main (5 Oct)  <- Backend Phase 0 (squash of feature/backend-foundation, PR #1)
  └ feature/events-core      backend Phase 1: events domain
      └ feature/chat         team chat, bell, meetings and AI minutes
          └ feature/workspace   tasks, approvals, files
              └ feature/finance-w3   finance writes saved for real
                  └ feature/finance-w4   finance reports read from the server
                      └ feature/finance-gaps   (current) backlog, events wiring, public pages, media
```

* `feature/finance-gaps` contains every other feature branch, **73 commits ahead of `main`** (as of 14 Oct; `main` has nothing the stack lacks). Merging it brings in everything below.
* Nothing after Phase 0 has been merged to `main`, and no pull request is open for it. The live site is built from `main` plus manual Vercel deploys
  (see section 5).
* `git branch --merged` shows `feature/backend-foundation` as *not* merged only because PR #1 was a squash merge; its content is in `main`.

## 2. Branch by branch

| Branch | Tip date | Ahead of `main` | What it holds | State |
|---|---|---|---|---|
| `main` | 5 Oct | n/a | Marketing site, ERP prototype (rounds 1-4), invitation prototype, docs, **backend Phase 0** (CI, VPS deploy files, roles, signed links, audit log, file storage, login throttle). | The only branch customers' deploys come from. |
| `erp-feedback-round-2`, `erp-feedback-round-3` | 7 Sep, 22 Sep | 0 | Client feedback rounds 2 and 3 on the **browser-only prototype** (posting preview, Template Studio, etc.). | Already inside `main`. Safe to delete. |
| `feature/pm-events-prototype` | 5 Oct | 0 | PM/events/CRM prototype and the backend build plan (Hostinger VPS, events first). | Already inside `main`. |
| `feature/invitations-v2` | 2 Oct | 0 | Invitations v2 prototype: cover with music, calendar, lightbox, wishes, send from platform or the client's WhatsApp, Indonesian translation. Also checked out in a second worktree `E:/Master - slave/RR projects/Oscenia-invitations-v2`. | Already inside `main`; deployed 2 Oct. |
| `feature/backend-foundation` | 5 Oct | 16 (squashed) | Backend Phase 0: Docker Compose on a Hostinger VPS, audit log, Postgres-backed login throttle, signed guest/client/QR links, generalised file storage for invitation media, CEO/PM publishing roles. | In `main` via PR #1. |
| `feature/events-core` | 5 Oct | 8 | **Backend Phase 1:** events, invitation editor, review and publish, Template Studio, guests, questions, tables, checkpoints, check-in, walk-ins, wishes, RSVP, report, demo seed. | Pushed. PR never opened. |
| `feature/chat` | 10 Oct | 17 | **Team chat:** channels, DMs, blocks, join requests, messages, reactions, mentions, read state, WebSocket delivery and presence, attachments, notifications; screens wired to the server (F1-F3); live bell for events and CRM; **meetings and AI minutes** (server-side minutes, AI when keys are set, rules otherwise). | Pushed. Live calls (audio/video) are not built. |
| `feature/workspace` | 11 Oct | 23 | **Workspace:** tasks (rules, service, routes), task files, approvals, live updates, tasks from meeting minutes, task bell items, project cards, module gate. | Pushed. |
| `feature/finance-w3` | 11 Oct | 26 | **W3, the write path:** master data, quotations, stages, procurement, petty cash, settings, assets, warehouse, payroll and survey now save to the server; project cancel and rating rules enforced server-side. | Pushed. |
| `feature/finance-w4` | 11 Oct | 30 | **W4, reports read from the server:** Cash, Dashboard cards, Receivables, Payables, chart of accounts, fixed assets, Accounting statements, Project P&L and Project Detail; parity check between the browser's ledger maths and the server's; the finance click-through (30/30). | Pushed. |
| `feature/finance-gaps` | 14 Oct | 73 | Everything above plus: the eight "not saved" backlog items (MoU templates, tags, asset edit, delivery orders, CRM note files, Daily Jobs, Budgeting, Google Calendar); the blocking gaps (catalogue items, real clock, opening float, project PM, survey); sales report and vendor cost estimator on real data; **events staff side wired (E0-E3)**; **public guest pages (P0-P4)**; **invitation media upload**; and then the **gaps plan P0 to P9** (14 Oct): role-gated search and rating stage check, user admin and passwords, project and crew edit, vendor files / PO delivery / client history, vendor lifecycle board, orphaned-file sweep and dashboard trend, the client's own rating link, search over chat / tasks / events / files, stock edit-archive and delivery-order signatures, CRM relations and campaigns. | Current branch, fully pushed (`8216c9d`). |

## 3. What is built, by area

Legend: **Server** = backend built and tested; **Wired** = the screens read and write it when signed in; **Demo** = browser-only prototype data.

| Area | Server | Wired | Branch it arrived on | Notes |
|---|---|---|---|---|
| Sign-in, roles, refresh tokens | yes | yes (W1) | `main` / W-series | Roles: CEO, PM, Sales, Finance, Warehouse. |
| Ledger, journal, reversals, statements | yes | yes | `main`, w3, w4 | 12 ledger invariants, tested against real Postgres. |
| Receivables, payables, cash and petty cash | yes | yes | w3, w4 | |
| Fixed assets and depreciation, payroll, incentives | yes | yes | w3, w4, gaps | Crew edit, deactivate and delete done (P2); a paid pool is frozen in a snapshot. |
| Quotations, projects, clients, vendors, catalogue, purchase orders, procurement | yes | yes | w3, gaps | Project edit (P2), vendor files and PO delivery status and client history (P3), vendor lifecycle board (P4) all done. |
| Warehouse and delivery orders | yes | yes | w3, gaps | Stock edit, archive and delete (P8); a drawn signature is needed to dispatch unless a company setting allows otherwise (P8). Partial checkout waits on the client (REQ-07). |
| Daily Jobs (scheduler), Budgeting, Google Calendar | yes | yes | gaps | Google needs the client's credentials. |
| Team chat, meetings, minutes, bell | yes | yes | chat | No live audio/video. |
| Workspace tasks and approvals | yes | yes | workspace | |
| Events: staff side (editor, publish, guests, door, wishes, report) | yes | yes | events-core, gaps | 25/25 click-through. |
| Events: public guest pages (invitation, RSVP, wishes, walk-in desk, client edit link) | yes | yes | gaps | Token in a header, throttled, audited; 17/17 click-through. |
| Invitation media (photos, video, music, template artwork) | yes | yes | gaps | New `event_media` table; guest route `/public/media/{id}`; 12/12 click-through. |
| User admin, passwords, saved language | yes | yes | gaps (P1) | CEO creates users, temporary passwords, one-time reset links, change password. Self-service email "forgot password" waits for a sending provider. |
| Search | yes | yes | gaps (P0, P7) | Role-gated; covers records, chat messages, tasks, events and file names (guests are deliberately not searchable). |
| Client rating link, orphaned-file sweep, dashboard monthly trend | yes | yes | gaps (P5, P6) | The sweep is dry-run by default. |
| CRM relations: contacts, event cycles, greetings, nudges, calendar | yes | yes | gaps (P9) | Greetings are prepared (`wa.me` / `mailto:` links) and marked sent by hand; nothing is sent. |
| CRM campaigns: contact list across events, campaigns, CSV, mark reached, unsubscribe | yes | yes | gaps (P9) | A fixed audience snapshot; erasure and unsubscribe are honoured. Nothing is sent. |
| Marketing website (`oscenia-web`) | n/a | n/a | `main` | Home, About, Services, Contact. Contact form is `mailto:` only. |
| Offline demo (signed out) | n/a | yes | all | Still works; the client has asked for a live product (W5 parked). |

Verification on `feature/finance-gaps` before media: backend suite **1,495 passed** (9 batches), `ruff` clean, `verify:*` and `verify:render` green,
four click-throughs green (events 25, finance 30, public 17, offline demo). Media added 16 backend tests, `verify:media` (21 checks) and `media-live-e2e.mjs` (12).

**At `8216c9d` (14 Oct, after P0 to P9):** backend suite **2,129 passed** (11 batches of 7 files), `ruff` and `mypy app` clean, one Alembic head (`u8d2f4b6c718`), `npm run verify` (293 adapter, 40 event, 47 public-layer checks), `build` and `verify:render` green, and the finance click-through **55 of 55**. Still never done by a person: a real phone, a hosted server, real sending.

## 4. What is left

**Needs a decision or outside input first**
* **Hosting.** The published ERP is stale (a 5 Oct bundle pointing at `localhost:8000`) and the backend runs nowhere. Without it, nobody outside this machine can use any of the server work. The backend must run as one worker (`erp-backend/Dockerfile`); `deploy/.env.example` lacks the AI and Google variables.
* **Merging to `main`.** Decide whether to open one PR for the whole stack or split it (events, chat, workspace, finance).
* **W5, retire the demo.** The client wants a live product with no signed-out demo; parked until the hosting decision.
* **Client-blocked:** Google credentials; REQ-07 (delivery orders, partial checkout); REQ-02 (tax mode on PDFs, depends on whether Oscenia is PKP); open accounting questions Q1, Q4, Q7, Q8 in `07-open-questions.md`.

**Built on the server, no screen yet (wiring only; not re-checked on 14 Oct, so some of this may have changed)**
Accounting periods (list, close, reopen); vendor bank/PIC/terms edit; open petty-cash receipts; budget-breach alerts; voucher-number preview; fixed-asset schedule/register; billing presets; log out everywhere; audit log has no read screen.

**Screens built that are still simulated, or backend work not done** (checked in the code on 14 Oct; the full list with the reasons is in `docs/finance-backend/FE-BE-GAP-LIST.md`, section F)
* **Sending.** No WhatsApp, email or SMS provider. Invitation sending and event reminders are simulated offline and say "Not connected yet" when signed in; greetings and campaigns are prepared as links and marked sent by hand. **Event broadcasts and reminder rules have no server persistence** (a deliberate deferral).
* **Live calls** (voice, video, screen share) and the call transcript are simulated; the AI meeting summary uses a "demo" source when no AI key is set, and two AI-minutes paths exist.
* **Google Calendar** is built on both sides but has never connected: it needs the client's Google credentials.
* **Door check-in camera** is simulated (tap a guest's QR or paste a code); the server check-in works.
* **Small loose ends:** per-account notification read state lives in the browser; quotation "Send" only changes the status; PDFs are built in the browser (no server PDF or Excel, and tax-invoice PDFs wait on REQ-02); the marketing contact form is `mailto:`; self-service email "forgot password" is not built; a few items in the old gap list (hardcoded vendor category pills, a static "Mention a crew member" box, payroll showing only the latest rated project) were not re-checked.

**Never verified**
No person has clicked through any of this on a real phone or against a hosted server. Every green result above is a scripted browser on this machine against a scratch database.

## 5. Where things are deployed

* **Marketing site** (`oscenia-web`): Vercel. Pushing to `main` ships nothing; deploy with `npx vercel --prod --yes` from `oscenia-web/`.
* **ERP prototype:** published under `/erp` on that site; last published 5 Oct, so it does **not** contain any server wiring.
* **Backend:** not deployed anywhere. Deploy files for a Hostinger VPS (Docker Compose, Caddy) are in `deploy/` and came in with Phase 0.
* Vercel previews sit behind a Vercel login; give clients a dashboard **Share** link.

## 6. Where to read more

`docs/finance-backend/STATUS.md` (first Log entry first) · `FE-BE-GAP-LIST.md` (the list in section 4, with evidence) · `Backend-Build-Plan.md`
· `07-open-questions.md` · `Developer-Handover.md` · `Invitations-v2-Plan.md`.

## 7. If you want all the code in one branch: the order (done on 15 Oct as option A, PR #3)

`main` is already inside `feature/finance-gaps` (0 commits on `main` that the stack lacks), and a trial merge of the stack into `main`
(`git merge-tree`) reports **no conflicts**. So there are two sound ways.

**Option A: one merge (fastest).** Open one pull request, `feature/finance-gaps` into `main`, and merge it with a **merge commit** (not squash).
Everything arrives together: events, chat, workspace, finance writes and reports, public pages, media. Review is one 54-commit diff, so lean on the
test results in section 3 and review by area (the commit subjects are grouped by phase).

**Option B: staged merges (easier to review, one PR per layer).** Merge in this order, each into `main` after the one before it passes CI:

| Step | Branch | Brings in | Depends on |
|---|---|---|---|
| 1 | `feature/events-core` | Backend Phase 1 (events domain, migration `5d6a2f57d1b5`) | `main` (Phase 0) |
| 2 | `feature/chat` | Chat, bell, meetings and minutes | step 1 |
| 3 | `feature/workspace` | Tasks, approvals, files | step 2 |
| 4 | `feature/finance-w3` | Finance writes | step 3 |
| 5 | `feature/finance-w4` | Finance reports from the server | step 4 |
| 6 | `feature/finance-gaps` | Backlog items, events wiring, public pages, media | step 5 |

Do **not** merge them in any other order: each branch contains the previous ones, so the first one merged would bring in everything below it anyway.
The branches `erp-feedback-round-2`, `erp-feedback-round-3`, `feature/pm-events-prototype`, `feature/invitations-v2` and `feature/backend-foundation` need no merge; they are already in `main`.

**Rules for either option**
* **Use merge commits, not squash.** The branches are stacked. A squash of step 1 rewrites its commits, so step 2 then shows the same changes again and
  conflicts (this is what happened with `feature/backend-foundation`, which `git` still lists as unmerged). If a squash has already happened, rebase the next
  branch first: `git rebase --onto main <old tip of the squashed branch> <next branch>`.
* **One database migration head.** Migrations are a single chain ending at `k7f1b4c9d286` (`event media`, after `j6e0a3b8c175`). After the final merge run
  `alembic heads` (expect one) and `alembic upgrade head` on a copy of the database.
* **After merging, run:** the backend suite in batches (about 25 minutes; it is too heavy for one process on this machine), `ruff check`, `npm run verify`,
  `npm run verify:render`, `vite build`, and the click-throughs (`events-live-e2e.mjs`, `finance-live-e2e.mjs`, `public-live-e2e.mjs`, `media-live-e2e.mjs`, `invite-e2e.mjs`).
* **Merging does not deploy.** Pushing to `main` ships nothing; the site is deployed by hand (section 5), and the backend still has no host.
* Delete the five already-merged branches only after the merge, and keep the second worktree (`Oscenia-invitations-v2`) until you no longer need it (`git worktree remove`).
