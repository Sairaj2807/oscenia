# Oscenia

**Oscenia Events** (Jakarta · Bali · Singapore): the marketing website and the ERP, in one
repository, deployed together on one VPS.

| Path | What it is |
|---|---|
| [`website/`](./website) | Marketing website: React 19 + Vite + Tailwind. Served at `/`. |
| [`erp-frontend/`](./erp-frontend) | ERP single-page app: React 19 + Vite + zustand. Served at `/erp/`. |
| [`erp-backend/`](./erp-backend) | ERP API: FastAPI + PostgreSQL 16. Served at `/api/*`. |
| [`deploy/`](./deploy) | Docker Compose, Caddy, deploy / backup / restore scripts. **Start here to ship.** |
| [`docs/`](./docs) | Product and engineering docs. [`docs/finance-backend/STATUS.md`](./docs/finance-backend/STATUS.md) is the backend's source of truth. |

Everything is served from one domain by Caddy, so the browser never makes a cross-origin call.
Sign-in is real: a deployed build has no demo accounts. See [`deploy/README.md`](./deploy/README.md).

## Run it locally

Website:

```bash
cd website && npm install && npm run dev        # http://localhost:5173
```

ERP, offline demo mode (no backend; demo accounts are on the sign-in page, dev only):

```bash
cd erp-frontend && npm install && npm run dev   # http://localhost:5273
```

ERP against a local backend (Docker Desktop for Postgres on port 5433, Python 3.12+):

```bash
cd erp-backend
docker compose up -d db
python -m venv .venv && source .venv/Scripts/activate      # Git Bash on Windows
pip install -e ".[dev]"
cp .env.example .env
alembic upgrade head
python -m app.seed.demo --as-of 2026-07-26                 # demo data + demo users (dev only)
uvicorn app.main:app --reload                              # http://localhost:8000, docs at /docs

cd ../erp-frontend
echo "VITE_API_URL=http://localhost:8000/api/v1" > .env.local
npm run dev
```

## Checks

| Where | Command |
|---|---|
| `website/` | `npx oxlint src` · `npx vite build` |
| `erp-frontend/` | `npm run verify` · `npm run verify:render` · `npx vite build` |
| `erp-backend/` | `ruff check .` · `mypy app` · `pytest -q` (needs Postgres on 5433) |

CI (`.github/workflows/ci.yml`) runs all of them, plus a build of the edge image.

More: [`TESTING.md`](./TESTING.md) (manual test guide), [`docs/Developer-Handover.md`](./docs/Developer-Handover.md),
[`CLAUDE.md`](./CLAUDE.md) (working rules).
