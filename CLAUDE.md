# Oscenia — workspace rules

Read this before any git, build or deploy action.

## What this repo is

One repo holds everything Oscenia ships: the marketing website, the ERP (frontend and
backend) and the VPS deployment. The repo root is this folder (`Oscenia-website-main/`).

- **GitHub:** https://github.com/Sairaj2807/oscenia, branch `main`.
- **Deploy target:** one VPS, one domain. The website is served at `/`, the ERP at `/erp/`
  and the API at `/api/*`, all by Caddy (see `deploy/README.md`). There is no Vercel.
- **Login is real.** A production build has no demo accounts, no offline mode and no role
  switcher. Users are created on the server (`deploy/README.md`, "First deploy only").

## Layout

| Path | What it is | In git? |
|---|---|---|
| `website/` | Marketing site: React 19 + Vite + Tailwind 3. Pages in `src/pages`, components in `src/components`, copy in `src/i18n/dict.js` (EN/ID), data in `src/data/site.js`, served assets in `public/` | Yes |
| `website/brand-assets/` | Delivered brand pack and designer files. Source material, not served. `brand-assets/README.md` maps every file in `public/` back to its source | No (ignored) |
| `erp-frontend/` | ERP single-page app: React 19 + Vite + zustand. Built with `base: '/erp/'` | Yes |
| `erp-backend/` | ERP API: FastAPI, async SQLAlchemy, Alembic, PostgreSQL 16 | Yes |
| `deploy/` | Docker Compose, Caddyfile, edge image, deploy / backup / restore scripts | Yes |
| `docs/` | ERP product and engineering docs. `docs/finance-backend/STATUS.md` is the backend's source of truth | Yes |
| `.github/workflows/ci.yml` | Backend, frontend, website and edge-image checks | Yes |
| Client documents, decks, videos, zips at this level | Source material kept on disk, never committed (see `.gitignore`) | No |
| `_stale-root-git-backup/`, `_stale-erp-prototype-backup/` | Backups of what the restructure replaced. Safe to delete once nobody needs them | No |

Nothing built is committed. The edge image (`deploy/Dockerfile.edge`) builds the website and
the ERP from source on every deploy.

## Git

- Work on a branch, open a PR into `main`. Never force-push.
- Before every push: `git fetch origin` and check `git log HEAD..origin/main`; if GitHub has
  commits that aren't local, integrate them.
- Run the checks for what you touched (below) and say which ones you ran.
- Group changes into logical commits with plain, descriptive messages.
- Before committing, check `git status` for changes made outside the current session. Tell the
  user what they are and commit them under their own message.
- Things that never go to GitHub: `website/brand-assets/`, client documents, `.env` files,
  anything under `deploy/` named `.env.production` / `.env.staging`.

## Working on the website

- Commands, from `website/`: `npm run dev`, `npx vite build`, `npx oxlint src`,
  `npx vite preview --port 4317 --strictPort`.
- Every fresh page load plays the intro and then redirects to `/`. To test another page, open
  `/`, press Escape, then click the nav link.
- Videos are encoded for quality: H.264 CRF 18, full source resolution and length. Exception:
  `public/about/fabric-blue.mp4` uses a keyframe every 10 frames so the About hero can scrub it
  backward. Re-encoding is documented in `brand-assets/README.md`.
- Client names and logos are placeholders ("Brand A–F", blank client strip) until the client
  confirms them. Don't add real brand names.
- Respect `prefers-reduced-motion` in every animation, as the existing code does.

## Working on the ERP

- Frontend, from `erp-frontend/`: `npm run dev` (port 5273, demo mode on), `npm run verify`,
  `npm run verify:render`, `npx vite build`.
- Demo mode (offline sign-in, demo accounts, role switcher) exists only under `vite dev` and the
  verify suites. `import.meta.env.PROD` turns it off in every built bundle; `VITE_DEMO_MODE=on`
  opts a deliberate demo build back in. Never set it for the VPS.
- Backend, from `erp-backend/`: needs Docker Postgres on port 5433
  (`docker compose up -d db`). `ruff check .`, `mypy app`, `pytest -q`. Never `ruff format`
  repo-wide. One Alembic head (`alembic heads`).
- Money is a string end to end. Never parse it to a float.
- Start with `docs/Developer-Handover.md` and `docs/SESSION-HANDOFF.md`.
