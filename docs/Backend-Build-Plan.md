# Backend build plan: where to start and how

## Context
The prototype has been signed off over four client rounds and is being handed to a full-stack developer (`docs/Developer-Handover.md`). The question: if I were starting the real backend, how and where would I start?

Exploration found:
- **A solid finance backend already exists.** It's in `erp-backend/`: FastAPI, async SQLAlchemy and Postgres 16, with 573 pytest tests, ruff and mypy clean, 133 operations, JWT auth with rotating refresh tokens, RBAC (`app/core/rbac.py`), RFC 7807 errors, money as decimal strings, append-only ledger triggers, and a `?dry_run` preview pattern.
  - It's **never been deployed.** There's no Dockerfile and no CI, and the scheduler and login throttle run in-process, so it needs a single worker.
- **The prototype only partly saves to it.** Sign-in and reads use the API, but most finance writes and every other module stay in the browser (`useProto`, about 107 actions; media in IndexedDB).
- **The modules with no backend:**
  - **Events & invitations:** about 48 actions, the largest, with public pages.
  - **Workspace:** 12 actions.
  - **Chat, calls and meetings:** 21 actions; needs real-time.
  - **CRM relationship layer:** 9 actions.
  - **Vendor lifecycle and PO delivery:** 4 actions.
  - **Notifications and search:** derived, built last.
- **There are two identity systems:** 5 ERP roles (real logins) and 10 workspace "Viewing as" personas. They conflict in the seed; for example, Dinda is ERP *sales* but a Field Division *lead*.

Decisions from the user:
- **Deploy on Hostinger.** That means a Hostinger **VPS**, since shared/web hosting can't run a Python ASGI server or Postgres.
- **Events & invitations is the first module** after the shared foundation.

Approach:
- **Extend `erp-backend/` rather than start again.** Copy its domain pattern: `app/domain/<name>/{models,schemas,service,router}.py`, with `accounts/` as the simple CRUD template and `ap/` as the workflow template.
- **Build phase by phase.** Each phase includes migrations, endpoints, tests and frontend wiring, then a fresh-context review and a demo before the next.

---

## Phase 0: foundation (start here)
1. **Get the codebase to a clean starting point.**
   - Merge `feature/pm-events-prototype` into `main`. It's a fast-forward, 96 commits ahead and 0 behind.
   - New work then branches off `main` with pull requests.
   - Update the git remote to `rahuls18-damco/Oscenia-website-and-ERP`.
   - Run the full suite (`pytest`, `npm run verify`) to confirm a green baseline.
2. **Add CI** with GitHub Actions on every pull request:
   - backend: ruff, mypy, and pytest against a Postgres 16 service container
   - frontend: `npm run verify`, `verify:render`, `vite build`
3. **Make it deployable on a Hostinger VPS** (Ubuntu, KVM 2 or larger; choose the Asia/Indonesia location if offered):
   - **`erp-backend/Dockerfile`:** a slim Python 3.12 image running uvicorn with one worker, a health check on `/health`, and a non-root user.
   - **`deploy/docker-compose.prod.yml` with three services:**
     - `api`
     - `db` (Postgres 16 with C collation, on a named volume)
     - `caddy` (reverse proxy with automatic HTTPS, e.g. `api.oscenia.com`)
   - Migrations run on deploy: `alembic upgrade head` before the API starts.
   - Secrets go in a server-side `.env`, never in git. That means a new `JWT_SECRET` and real users, and **no demo password**.
   - **Nightly `pg_dump` plus the uploads folder are backed up off the VPS.** This could be Hostinger's backup add-on, or object storage such as Cloudflare R2 or Backblaze.
   - A deploy script, `deploy/deploy.sh`: pull, build, migrate, restart.
   - `CORS_ORIGINS` points at the Vercel frontend. The frontend sets `VITE_API_URL` to the API domain. It could move to the same VPS later if wanted.
   - **One VPS is a single point of failure, so add three things:**
     - uptime monitoring on `/health` (e.g. UptimeRobot), with alerts
     - a **staging** copy: a second Compose project on the same VPS (`staging-api.…`, its own database), or a small second VPS
     - a tested restore from backup before go-live
4. **Roles for events (only what events needs now):**
   - Add `publish_invitation` (ceo, pm) and `manage_templates` (ceo, pm) to `app/core/rbac.py`, matching the prototype's 22 actions.
   - Add an `active` flag on `users` (`app/domain/masters/models.py:47`).
   - Events only use the 5 ERP roles, so **the full identity merge is not on the critical path for events.**
   - The full merge (Handover §8.2.1) **moves to just before the Workspace phase**:
     - `workspace_role` and `division` on `users`, plus `project_members` / `project_divisions`
     - the `workspaceAccess.js` rules ported server-side
     - the client settles whether the CEO counts as a workspace PM, and the Dinda-style split where one person holds two roles
5. **Shared building blocks:**
   - **An audit log table plus helper,** answering open question Q13: who, what, when, before and after.
   - **Generalise `StorageBackend`** (`app/domain/cash/storage.py`) for invitation media: photos ≤15 MB, video ≤200 MB, music ≤20 MB, template artwork.
     - Use the VPS disk at first, served through short-lived signed URLs from the API, behind the same interface so S3/R2 can be swapped in.
     - Validate MIME type and extension, allow no SVG, and resize images on upload.
   - **Secure tokens:** revocable, with an expiry where it makes sense. **Decided 5 Oct 2026:** HMAC-signed links plus a version number on the row (`app/core/links.py`), not hashed random tokens — staff re-copy guest and client links, which a hash-only token cannot support. Revoke by bumping the version.
   - **Signed QR payloads:** HMAC over event and guest, replacing the guessable `OSCENIA:EV:G`.
   - **Move the login throttle and rate limits** from in-process memory to a Postgres table, so more than one worker becomes possible later.

## Phase 1: events core (staff side)
New package `app/domain/events/`. It mirrors `useProto.js` lines ~797–1468, and `lib/events.js`, `invites.js` and `templates.js` hold the rules to port:
- **Tables:**
  - `events`: linked to `clients` / `projects` by UUID, with `status`, `rsvp_deadline`, `max_pax`, `rsvp_fields`, `feedback_url`
  - `event_invites`: draft plus published JSONB content, `template_id`, accent, section toggles, and a **snapshot of the template at publish**
  - `event_reviews`, `event_questions`, `event_checkpoints`, `event_tables`
  - `guests`: token hash, category, RSVP, pax, allergies, answers JSONB, consent and timestamp, free-text table ≤30, notes, invited_at/via
  - `scans`, `wishes`
  - `invitation_templates`: custom templates; the 6 built-ins as seed data
- **Endpoints:**
  - event CRUD
  - template choose and change
  - section and content edit (port `cleanSection`/`safeLink`)
  - submit, return, publish, unpublish (require `publish_invitation`), plus regenerate the client link
  - questions
  - guests: add, CSV import (port `parseGuestCsv`), table, category, note, email
  - checkpoints
  - check-in scan and undo, and walk-ins
  - wish moderation
  - Template Studio (require `manage_templates`)
  - an attendance report
- **The permission gaps the prototype leaves open are enforced here.** Publish, guest and question edits currently check no role in the store.
- **Links to clients and projects:**
  - `client_id` and `project_id` are nullable foreign keys to the existing `clients` / `projects` UUIDs. The prototype allows an event without a project (`createEvent`, `useProto.js:797`).
  - **Demo seed:** extend `app/seed/demo.py` to load EV-01/02/03 with their guests, wishes and broadcasts. Map the prototype's client codes (`CL-04`) and project numbers to backend UUIDs through `client_no` / `project_no`.
- **Tests:** port the business rules from `scripts/verify-proto.mjs` into pytest. That covers the RSVP deadline, the pax clamp, guest matching (token → phone → email), the question limit of 10, wish limits, the checkpoint delete guard, and template gating.

## Phase 2: public token API (guest, client and walk-in pages)
- **Read-only published invitation:** `GET /public/invites/{event_id}?g=<token>`. It returns **only** published content and that guest's own data. Today these pages load the whole store, including every guest and the edit token.
- **Guest actions:** `POST /public/invites/{id}/rsvp`, which ports `submitRsvp` and `cleanAnswers`, and `POST /public/invites/{id}/wishes`.
- **Client link:** `/public/client/{event_id}` with a signed, expiring edit token revoked by `events.edit_link_version`. It allows only the client-mode actions: design edits, submit for review, wish moderation, and self-send marks.
- **Walk-in:** a public walk-in endpoint. Staff check-in endpoints verify the signed QR code.
- Rate limits on every public route, and CAPTCHA/honeypot on RSVP if needed.

## Phase 3: invitation media
- Upload and download endpoints on the generalised storage. Video is capped at 200 MB, using a chunked or resumable upload.
- Content holds `{key, name, size, type}`, the same shape as the prototype's `mediaStore`, so the renderer barely changes.

## Phase 4: messaging and scheduling
- **Provider interfaces with a fake provider for dev and tests:**
  - **WhatsApp:** a Business API provider. **Start the choice and the Meta business verification now — approval takes weeks.**
  - **Email:** a transactional provider, for example Amazon SES, Postmark or Brevo, for broadcasts and reminders, where deliverability matters.
    - Hostinger's own email hosting (SMTP) is fine for low-volume staff notifications, but not for bulk guest sends.
- **Broadcasts and reminders:**
  - broadcasts port `broadcastProblem`; reminders and the send log
  - per-recipient status driven by **delivery webhooks**
  - retry failed sends
  - scheduled sends run through the existing APScheduler and `job_runs` pattern, idempotent so nothing goes out twice
- **Calendar files:** `.ics` with a **per-event timezone**, adding `events.timezone`.

## Phase 5: connect the prototype's events to the backend
- **Adapters for the events slice:** like `src/store/adapters.js`, with writes through `mutate`.
- **Public pages fetch from the token API** instead of the persisted store.
- `scripts/verify-api.mjs` gets cases for the events endpoints.
- The invitation browser walk-through (`scripts/invite-e2e.mjs`) runs against the live backend.
- The `useProto` events code is removed once it's live.

## After events (outline only)
1. Finish the finance writes: wiring phases W3–W5.
2. Vendor lifecycle and PO delivery: small, and enforces `canOrderFrom` on the server.
3. Workspace & tasks. **Built** on `feature/workspace`: tasks with two-stage approval, files, live updates, bell items and tasks-from-minutes, server-enforced and replayed against the prototype's own answers (see `finance-backend/STATUS.md`). Not built: edit/reassign/reopen/delete, comments.
4. CRM relationship layer: reconcile with `clients.birthday`/`anniversary` and `crm.milestone_scan`.
5. Team Chat. **Backend built** on `feature/chat` (phases C0–C5: identity, channels and DMs, messages with reactions, mentions, read state and sync, an in-process WebSocket hub with presence, attachments, notifications, demo seed — see `docs/finance-backend/STATUS.md`). Screens wired (F1–F3). Meetings and AI minutes are now server-side with a per-person daily spend cap. **Still to do:** live calls through LiveKit (chosen). Bell items for events and CRM are served by `GET /notifications`; tasks wait for a tasks backend. Single worker only.
6. Server-side notifications and wider search.

## Decisions and inputs needed early
- **Hostinger VPS plan and region, plus a domain** for the API (e.g. `api.oscenia.com`).
- **A WhatsApp provider and Meta business verification:** the longest lead time.
- **An email provider and a sending domain** (SPF/DKIM).
- **Identity:** the CEO-as-workspace-PM question and the persona merge.
- **Finance questions still open** (Handover §10.2), which don't block events: Q1, Q4 (PPN/PKP), Q7, Q8, Q9.

## Verification (every phase)
- `pytest` in full (it already takes about 11 minutes), plus ruff and mypy. Rules are ported from the prototype verify scripts so the behaviour matches.
- **CI green on the pull request,** then a fresh-context review before merging.
- **Deploy to the Hostinger VPS staging environment:** run migrations, check `/health`, and run `npm run verify:api` against it.
- A browser walk-through of the phase's flows against the deployed API (for example `scripts/invite-e2e.mjs`).
- Each phase ends with a demo and a sign-off before the next starts.
