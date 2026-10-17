# Deploying Oscenia (website + ERP + API) to the VPS

One VPS runs everything. The **website** (`/`), the **ERP** (`/erp/`) and the **API**
(`/api/*`) answer on the **same domain**, so the browser never makes a cross-origin call.

It runs two copies of the stack — **production** and **staging** — each a separate Docker
Compose project with its own Postgres and uploads volume. Production's Compose project also
runs **Caddy**, which terminates HTTPS for both domains, serves the built website and ERP
(baked into the `oscenia-edge` image) and is the only thing listening on the internet.

```
             internet :80/:443
                    │
               ┌────┴────────────────────────────┐
               │ caddy  /  → website (static)    │  (oscenia-production, profile "edge")
               │        /erp/ → ERP (static)     │
               │        /api/*, /health → API    │
               └────┬────────────────────────────┘
        oscenia-edge│network
          ┌─────────┴──────────┐
   api-production:8000   api-staging:8000
          │                    │
   db (pgdata) + uploads   db (pgdata) + uploads
   oscenia-production      oscenia-staging
```

The domain is **not decided yet**. Everything is parameterised by `SITE_DOMAIN` /
`STAGING_SITE_DOMAIN` in the env file; nothing else needs to change when it is chosen.

| File | What it is |
|---|---|
| `docker-compose.prod.yml` | `db`, one-shot `migrate`, `api`, and `caddy` (edge profile) |
| `Dockerfile.edge` | Builds the website and the ERP from source and bakes them into a Caddy image. Nothing built is ever committed |
| `Caddyfile` | HTTPS, static files for `/` and `/erp/`, reverse proxy for `/api/*` and `/health` |
| `.env.example` | Template for `.env.production` / `.env.staging` (never committed) |
| `deploy.sh` | Pull, build, migrate, restart, wait for `/health` |
| `backup.sh` | `pg_dump` + uploads archive, copied off the VPS with rclone |
| `restore.sh` | Restore a backup into an environment (routinely: production → staging) |

Still to decide (the files are parameterised for them): the VPS plan and region, and the
domain. KVM 2 or larger (the edge image builds two Vite apps), Asia location.

## 1. One-time VPS setup

On a fresh Ubuntu 24.04 VPS, as root:

```bash
adduser --disabled-password deploy && usermod -aG sudo deploy
mkdir -p /home/deploy/.ssh && cp ~/.ssh/authorized_keys /home/deploy/.ssh/ \
  && chown -R deploy:deploy /home/deploy/.ssh
# SSH keys only: PasswordAuthentication no, PermitRootLogin no in /etc/ssh/sshd_config
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp && ufw enable
curl -fsSL https://get.docker.com | sh && usermod -aG docker deploy
apt-get install -y rclone unattended-upgrades
```

Docker publishes ports through its own iptables rules, which bypass ufw. Only Caddy
publishes any, so that is fine — keep it that way: never add `ports:` to `api` or `db`.

**DNS:** A records for `SITE_DOMAIN` and `STAGING_SITE_DOMAIN` → the VPS IP, before the first
production deploy (Caddy requests certificates on start).

## 2. Two checkouts, one per environment

As `deploy`:

```bash
sudo mkdir -p /srv/oscenia && sudo chown deploy: /srv/oscenia
git clone https://github.com/Sairaj2807/oscenia.git /srv/oscenia/production
git clone https://github.com/Sairaj2807/oscenia.git /srv/oscenia/staging
```

The repo is private: use a read-only **deploy key** (GitHub → repo → Settings → Deploy
keys) rather than a personal token.

Each checkout gets its own env file, filled from `.env.example` with **freshly generated**
secrets — never the development `JWT_SECRET`, and different values per environment:

```bash
cp deploy/.env.example deploy/.env.production   # in /srv/oscenia/production
cp deploy/.env.example deploy/.env.staging      # in /srv/oscenia/staging, DEPLOY_ENV=staging
chmod 600 deploy/.env.*
```

Staging usually runs with `SCHEDULER_ENABLED=false`, so a restored copy of production does
not run month-end jobs.

## 3. Deploy

```bash
/srv/oscenia/staging/deploy/deploy.sh staging              # origin/main
/srv/oscenia/production/deploy/deploy.sh production <ref>  # a tag or commit already proven on staging
```

The script fetches and checks out the ref, builds the image, runs `alembic upgrade head`
in the one-shot `migrate` container, restarts, and waits for the API's health check. If
the migration fails the old API keeps running. Deploy staging first so Caddy's staging
upstream exists — production deploys work without it (staging answers 502).

**Rolling back** is `deploy.sh <env> <previous ref>` (the build is cached). Migrations are
not undone, so **every migration must be backward-compatible with the release before it**:
add columns and tables freely; rename or drop only in a later release, once nothing reads
the old shape.

### First deploy only: reference data and real users

```bash
C="docker compose -p oscenia-production --env-file deploy/.env.production -f deploy/docker-compose.prod.yml"
$C exec api python -m app.seed.chart        # accounts, series, tax config; NO demo users in production
$C exec api python -m app.seed.users add sdbangar2808@gmail.com "Sairaj Bangar" ceo   # prompts for a password
$C exec api python -m app.seed.users list
```

The first CEO is Sairaj Bangar. The command asks for the password twice (12+ characters), so it
never sits in a file or in shell history. The CEO then creates everyone else from the **Users**
screen in the ERP (temporary passwords, one-time reset links). If the CEO should also appear in
the workspace and chat, add `--workspace-role pm --division <Division> --title "<Title>"`.

### AI meeting minutes

On when `AI_PROVIDER` and `AI_API_KEY` are set in the env file (`deepseek` or `openai`). The key
lives only in `deploy/.env.<environment>` on the server; it never reaches a browser and is never
logged. `AI_MINUTES_PER_DAY` caps the spend per person; over it, free rule-based minutes are
written and say so. After editing the file, `deploy.sh <env>` recreates the API with the new
values.

`app.seed.demo` refuses to run with `ENV=production`, and `app.seed.chart` creates no demo
account there, so the published demo password signs nobody in. `users deactivate <email>`
ends a leaver's access on their next request.

### How the frontends reach the API

Nothing to configure. `Dockerfile.edge` builds the ERP with `VITE_API_URL=/api/v1`, a relative
path, and Caddy serves the app and proxies `/api/*` on the same origin. Keep the site's own
origin in `CORS_ORIGINS` anyway.

**Guest, walk-in and client pages call the API from that same origin, signed out.** They send no
cookie or Authorization header, only a token header (`X-Guest-Token`, `X-Walkin-Token`,
`X-Client-Key`). The public routes (`/api/v1/public/*`) are rate limited per caller IP and per person, capped at
256 KB, and audited; the caller's address is only trusted behind the proxy (`FORWARDED_ALLOW_IPS`).

## 4. Backups

```bash
rclone config      # once: an "r2" (Cloudflare R2) or "b2" remote; set BACKUP_REMOTE=r2:bucket/production
crontab -e
0 2 * * * /srv/oscenia/production/deploy/backup.sh production >> /home/deploy/backup.log 2>&1
```

Each run writes `db-<UTC stamp>.dump` (pg_dump custom format) and
`uploads-<stamp>.tar.gz` under `deploy/backups/production/`, copies both to
`BACKUP_REMOTE`, and keeps `BACKUP_KEEP_DAYS` locally. Set a lifecycle rule on the bucket
for off-site retention (e.g. 30 daily). Hostinger's own VPS snapshots are a useful extra,
not a replacement: they live with the same provider.

**Before go-live, prove a restore** — restore last night's production backup into staging
and sign in there:

```bash
/srv/oscenia/staging/deploy/restore.sh staging \
  /srv/oscenia/production/deploy/backups/production/db-<stamp>.dump \
  /srv/oscenia/production/deploy/backups/production/uploads-<stamp>.tar.gz
```

The restore loads into a scratch database first and swaps only when that succeeds, so a
bad dump leaves the existing data alone. Restoring into production asks for confirmation.

## 5. Monitoring

One VPS is a single point of failure, so watch it from outside:

- **UptimeRobot** (or similar): HTTP monitor on `https://<SITE_DOMAIN>/health` every 5
  minutes, alerting by e-mail/WhatsApp. `/health` does a real database round-trip.
- Same for the staging domain, at a lower priority.
- `docker compose ... logs -f api` on the box; `LOG_JSON=true` makes them shippable later.

## Checked locally (5 Oct 2026, Docker Desktop)

Image builds; the stack comes up with `migrate` running every migration before `api`
starts; `https://localhost/health` answers through Caddy with `env: production`; the API
runs as uid 999; staging's domain answers 502 until staging is up. In production mode the
demo password is refused, `seed.users add` creates a working login and `seed.demo`
refuses. `backup.sh` → `restore.sh` into staging carried the users and an uploaded file
across. After the Phase 0 review: a forged `X-Forwarded-For` is ignored both through Caddy
and when sent straight to the API from the staging container (the API trusts only Caddy's
fixed address, 172.30.42.10); `restore.sh` refuses a corrupt dump or archive before
stopping anything. Not yet exercised: a real VPS, real DNS and Let's Encrypt, and rclone
upload.
