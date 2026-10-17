# Frontend-only / partly-connected features

> Audit of 2026-10-11 (A updated after `56b8a07`), **refreshed 2026-10-14** after the gaps plan P0 to P9 closed most of sections C and D.
> The first audit was built from three read-only code audits and was not run to confirm it; "No frontend caller" lists came
> from literal-string searches, so a dynamically built path could be missing. The 14 Oct refresh checked the code for places that
> still refuse to save signed in (`_notSaved`) or say they are simulated, and re-ran the gates (section F); it did **not** click through
> every screen, and section B was not re-checked. Sizes: S small, M medium, L large.

## A. Blocking or likely to mislead on a live system
Items 1-5 fixed in `a3da9be` (item 2 completed in `21ebda7`, item 4 in `56b8a07`) (checks run: `npm run verify`, `verify:render`, vite build; **not** a person's click-through).

| # | Item | Status |
|---|---|---|
| 1 | No catalogue item could be created, so no PO could be raised on a fresh database. | **Fixed:** "Add Catalogue Item" on Vendors (`addCatalogueItem`, `POST /vendor-catalogue`) |
| 2 | Frozen clock `DEMO_TODAY` (`lib/format.js`, 26 July), about 149 uses. | **Fixed for the live finance and workspace pages in `21ebda7`:** one clock, `appToday()`, real date when signed in, frozen demo date otherwise (finance click-through 30/30). **Left on the frozen date on purpose:** events, invitations, CRM relations, broadcasts (browser-only seed, no server yet). Edge: state set once on first render (e.g. Accounting's default custom range) keeps the date at that moment |
| 3 | Procurement opening float hardcoded at 40,000,000. | **Fixed:** the server's `pettyCash.opening` when signed in |
| 4 | Project Detail printed "PM undefined". | **Fixed in `56b8a07`:** `ProjectOut` returns `pm_user_id` and `pm_name`; `PUT /projects/{id}/pm` (`manage_workspace`, CEO and PM) names or clears the PM; Project Detail has a PM picker for those roles. Not done: a person's click-through of the picker; projects still have no `PATCH` for name, date or division (section C) |
| 5 | Survey said "Thank you" even when the server rejected the rating. | **Fixed:** waits for the result; a real login rates only a finished, non-cancelled event |
| 6 | Published demo is stale: the bundle points at `localhost:8000`, last published 5 October. Backend not deployed; it must run as one worker (`erp-backend/Dockerfile`). `deploy/.env.example` lacks AI and Google vars. | **Open: deployment decision** |

## B. Backend built, no frontend (wiring only)
*Not re-checked on 14 Oct: some of these may have been wired since (for example the users and password endpoints now have screens, P1).*
- ~~**Events domain**~~ **Staff side wired in E0-E2 (`6d8115e`, `d4745b6`, `4c7263f`, E3 relabelling after):** signed in as CEO, PM or Sales the events list, event settings, the invitation editor, review/publish, the client link, Template Studio, guests, questions, tables, checkpoints, check-in and undo, wishes moderation and the report read and write the server (`events-live-e2e.mjs` 25/25). **Update 2026-10-12:** the public guest routes (invitation, RSVP, wishes, client edit link, walk-in) and invitation media / template artwork upload are now wired (STATUS.md). **Still open in this area:** sending/reminders/broadcasts/campaigns (Phase 4), staff walk-in registration from the UI, event/guest delete, consent withdrawal and erasure, a person's click-through on a real phone.
- Accounting periods: `GET /periods`, close, reopen. **M**
- Edit vendor bank / PIC / terms / NPWP (`PATCH /vendors/{id}` supports it). S
- Open petty-cash receipts (`GET /attachments/{id}`). S
- Dashboard budget ceiling and `/alerts/budget-breaches` (reads seed `budget`). S
- Voucher-number preview (`/voucher-series/{key}/preview`). S
- Fixed-asset `/schedule`, `/register`, `/depreciation/backlog`; `/billing/presets`, `/billing/resolve-schedule`; `/accounts/next-code`, `/accounts/stats`; `/procurement-requests/by-requester`; `GET /bills`, `/open-items` (the frontend duplicates this logic in `lib/ledger.js`, `lib/billing.js`). S-M
- `POST /auth/logout-everywhere`; `PATCH /chat/users/{id}/workspace`; the audit log has no read endpoint. S

## C. Frontend only, no backend model
**All closed by the gaps plan (14 Oct 2026), except the three rows marked open.** `P` numbers are the phases in `docs/SESSION-HANDOFF.md`.

| Feature | Status |
|---|---|
| Vendor lifecycle board (stages, checklist, history) | **Done, P4** (server stage rules, checklist, history; optional PO enforcement setting) |
| PO delivery status | **Done, P3** (`PUT /purchase-orders/{id}/delivery`) |
| CRM relationship layer: contact persons, event cycles, "Time to reach out" nudges, greetings | **Done, P9 part 1** (`/clients/{id}/relations`, `/crm/calendar`; the daily scan raises reminders) |
| CRM guest contacts and campaigns | **Done, P9 part 2** (`/crm/contacts`, `/crm/campaigns`; nothing is sent) |
| Client past events / lifetime value, preferred event types, vendors used, satisfaction | **Done, P3** (`GET /clients/{id}/history`) |
| Crew edit or remove | **Done, P2** (edit, deactivate, delete only if never disbursed) |
| Project edit: name, event date, division | **Done, P2** (`PATCH /projects/{id}`, with the event-date cascade) |
| Vendor attachments | **Done, P3** (vendor files, Agreement counts towards the checklist) |
| Stock edit and delete; delivery-order signature | **Done, P8** (edit/archive/delete; drawn PNG signature; dispatch needs it unless `allow_unsigned_dispatch`, now a toggle on the Warehouse page) |
| Dashboard trend deltas and monthly chart (hardcoded) | **Done, P5** (`GET /reports/monthly-trend`; the two non-ledger deltas were dropped) |
| Payroll tracks only the latest rated project, so it misreports others | **Open, not re-checked on 14 Oct** (`adapters.js`) |
| Vendor category pills are hardcoded (`CATALOG_CATEGORIES`); server categories can match none | **Open, not re-checked** (`Vendors.jsx`, `seed.js`) |
| Project Detail "Mention a crew member…" box is a static div | **Open** (confirmed still a plain div, `ProjectDetail.jsx`) |

## D. Not built at all
| Feature | Status |
|---|---|
| **Sending anything.** Invitations, reminders, greetings and campaigns; no WhatsApp, email or SMS provider, no send-log tables. Quotation "Send" only changes status. | **Open (L).** Greetings and campaigns are now *prepared* (links, CSV) and marked sent by hand, but nothing is sent. |
| Live calls (LiveKit). Meetings have no creation route, so tasks from action items cannot be reached on real data. | **Open (L)** |
| User and role admin, profile, change and forgot password | **Done, P1** except self-service forgot-password by email (needs a sending provider); the CEO issues one-time reset links instead |
| ~~Public guest routes~~ the tokenised survey | **Done, P6** (`/rate/:projectNo#token`, 30 days, one rating until the pool is paid) |
| ~~Invitation media upload~~ a store-wide clean-up of orphaned bytes | **Done, P5** (weekly job, dry-run by default until a setting is flipped) |
| Saved language per user | **Done, P1** |
| Search over chat, tasks, events, files | **Done, P7** (role-gated; guests deliberately not searchable) |
| Server PDF and Excel | **Open (M each)**; PDFs are built in the browser, and tax-invoice PDFs wait on REQ-02 |
| Notification read state per account | **Open (S)**; kept in each browser's local storage |
| Marketing contact form is `mailto:` only | **Open (S)** |
| AI minutes: two parallel paths (Vercel function vs backend); no live AI call ever made | **Open (S)** |
| Event broadcasts and reminder rules saved on the server | **Open, deliberately deferred (M)**; nothing would fire them without a sending provider and a scheduler |

## E. Waiting on the client
Google credentials (the Google Calendar screens are built on both sides but have never connected) and Handover C2 decision; REQ-07 (delivery orders, partial checkout); REQ-02 (tax mode on PDFs, depends on PKP); W5 branch decision (parked, see `w5-retire-demo-decision` memory).

## F. Still simulated, or built on one side only (checked 14 Oct 2026)
Found by searching the frontend for places that refuse to save when signed in or say they are simulated, then reading each. Not a click-through.

**Needs an outside provider or a decision**
1. **Sending.** `components/invite/SendInvitations.jsx` and `components/events/RemindersTab.jsx` are simulated offline and show "Not connected yet" when signed in. `lib/broadcasts.js` works out a fake delivery outcome per guest. Greetings (`RelationshipCalendar.jsx`) and campaigns (`GuestContacts.jsx`) are real records with `wa.me` / `mailto:` links and a "mark sent" step; the offline demo still simulates both.
2. **Live calls.** `components/chat/CallOverlay.jsx` and `MeetingPanel.jsx` are simulated (no microphone, camera or screen), so the transcript is too; the AI summary falls back to a "demo" source when no key is set.
3. **Google Calendar.** Frontend (`pages/GoogleCalendar.jsx`, `crm/CalendarView.jsx` via `useGoogle`) and backend (`domain/gcal`) are built; a real connection needs the client's Google credentials and has never been made.
4. **Door check-in camera.** `components/events/CheckInTab.jsx`: tap a guest's QR or paste a code. The server check-in it calls is real.

**Small**
5. Notification read state is browser-only (`store/useNotifications.js`).
6. Quotation "Send" only changes the status; PDFs are made in the browser with jsPDF.
7. `addUnplannedCost` and `runCron` in `store/useStore.js` refuse to run when signed in. They are leftovers of the demo; the live budgeting and jobs screens replace them.
8. Rows marked open in section C (payroll latest rated project, vendor category pills, the static mention box).

**Gates at the time of this refresh** (`8216c9d`): backend 2,129 tests passed in 11 batches; `ruff` and `mypy app` clean; one Alembic head; `npm run verify` (293 adapter, 40 event, 47 public-layer checks), `build` and `verify:render` green; finance click-through 55 of 55. Never done: a real phone, a hosted server, real sending.

## Suggested order
Hosting (A6), then merge to `main`, then sending (a provider, then persisting broadcasts and reminder rules, which would also let greetings and campaigns send), then live calls, then the small items in F by client priority.
