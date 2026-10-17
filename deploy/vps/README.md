# Oscenia on the shared VPS (osceniaevents.com)

**This is how production actually runs.** The Docker + Caddy files one level up are for local
rehearsal and for a future dedicated server; they cannot run on this machine (Nginx owns 80/443).

## The server

`194.164.148.203`, Ubuntu 24.04, **1 CPU core, 3.8 GB RAM, no swap**. It also runs trading and other
production services (`fyers_v2`, `forexpython_v2`, `crm`, `abhi-tele`, `telegram_scheduler`, `sessions`,
`delete`, `supervisor`, OpenVPN Access Server, OpenLiteSpeed) and a second Nginx site (`fastapi` →
`127.0.0.1:8000`). **None of those may be stopped, restarted or have their Nginx site touched.** No
Docker. Certbot manages the certificates.

```
 browser ──https──▶ nginx :443  (site: osceniaevents)          existing, Certbot
                      │  /        → /var/www/oscenia/site      static website   (website/dist)
                      │  /erp/    → /var/www/oscenia/site/erp  static ERP app   (erp-frontend/dist)
                      │  /api/*   → 127.0.0.1:8010             oscenia-api.service   ┐ added
                      │  /health  → 127.0.0.1:8010/health                              │ 2026-10-17
                      ▼                                                                 │
              PostgreSQL 16 on 127.0.0.1:5432  (db oscenia_erp, role oscenia)          ┘
```

Nothing but Nginx can reach the API (`127.0.0.1`), and Postgres listens on localhost only. UFW is
unchanged (22, 80, 443, 8000 open; 8010 and 5432 are not).

## What was installed (2026-10-17)

| What | Where |
|---|---|
| PostgreSQL 16 (apt) | cluster `16/main`, `127.0.0.1:5432`; tuned small in `/etc/postgresql/16/main/conf.d/oscenia.conf` (30 connections, 128 MB buffers); database `oscenia_erp`, collation `C` |
| System user `oscenia` | no login shell, owns `/srv/oscenia` |
| Backend code | `/srv/oscenia/erp-backend` (previous copy in `erp-backend.prev`) |
| Virtualenv | `/srv/oscenia/venv` (Python 3.12) |
| Secrets | `/srv/oscenia/api.env`, mode 600, owner `oscenia`, **never in git**; generated on the server |
| Uploads / backups | `/srv/oscenia/uploads`, `/srv/oscenia/backups` |
| Service | `/etc/systemd/system/oscenia-api.service` (copy in this folder) |

The service runs as `oscenia`, one worker, `Nice=10`, `MemoryMax=700M`, `OOMScoreAdjust=500` (the kernel
sacrifices it before the trading services), sandboxed (`ProtectSystem=strict`, only `uploads/` writable),
and runs `alembic upgrade head` before each start. About 120 MB RSS idle.

## State right now

| | |
|---|---|
| API | **running**, `curl http://127.0.0.1:8010/health` → `{"status":"ok","database":"ok",...}` |
| Reference data | seeded (`app.seed.chart`): chart of accounts, tax config, voucher series. Production creates **no demo users** |
| Nginx | **not changed yet.** `osceniaevents` still serves the old site from `/var/www/oscenia-web/dist` |
| Static files | **shipped and tested, not live.** `/var/www/oscenia/site` → `releases/20261017-172415` (website + ERP). Tested through a throwaway Nginx on a private port and a real browser (CEO sign-in, all 27 ERP screens on the empty database). The live site still serves the old `/var/www/oscenia-web/dist` |
| First CEO | **created 2026-10-17**: Sairaj Bangar (`sdbangar2808@gmail.com`, role `ceo`); signing in against the API on the server returns 200 |
| Swap | **2 GB `/swapfile` added 2026-10-17** (in `/etc/fstab`), `vm.swappiness=10` in `/etc/sysctl.d/99-oscenia-swap.conf`, so swap is an emergency reserve and does not push the neighbours' idle memory out |
| AI minutes | off until `AI_API_KEY` is set in `/srv/oscenia/api.env` |
| Backups | none yet |

## Remaining go-live steps

1. ~~Create the first CEO~~ done. Day to day, the CEO adds people from the **Users** screen in the ERP.
   To add or reset a user from the server (asks for the password twice, 12+ characters):
   ```bash
   systemd-run --wait --pty -p User=oscenia -p EnvironmentFile=/srv/oscenia/api.env \
     -p WorkingDirectory=/srv/oscenia/erp-backend -p Environment=PYTHONDONTWRITEBYTECODE=1 \
     /srv/oscenia/venv/bin/python -m app.seed.users add someone@example.com "Name" finance
   ```
2. ~~Ship the static files~~ done for now. Repeat after any frontend change: `VPS_HOST=… deploy/vps/ship-static.sh`
   (builds here, not on the server). On Windows Git Bash the script sets `MSYS_NO_PATHCONV=1` and
   refuses a bundle whose API base was rewritten to `C:/Program Files/Git/api/v1`.
3. **Switch Nginx** to `nginx-osceniaevents.conf` (keep the Certbot-managed lines), then
   `nginx -t && systemctl reload nginx`. Reload, never restart. Keep the old file for rollback.
4. **AI key:** set `AI_API_KEY=` in `/srv/oscenia/api.env`, then `systemctl restart oscenia-api`.
5. **Backups:** nightly `pg_dump -Fc oscenia_erp` plus `/srv/oscenia/uploads`, copied off the box, and a
   tested restore. (Not done.)
6. ~~Swap~~ done (see above).

## Updating

- **Backend:** `VPS_HOST=root@… deploy/vps/update-api.sh` (migrations run on restart).
- **Website / ERP:** `VPS_HOST=… deploy/vps/ship-static.sh`.
- The old `/var/www/oscenia-web` git checkout is **not used by the new layout** and its
  `git pull && npm ci` will fail once `main` has the monorepo layout (no `package.json` at the root).
  Leave it alone until Nginx no longer points at it.

## Rollback

- **Static:** `ln -sfn /var/www/oscenia/releases/<earlier> /var/www/oscenia/site` (instant).
- **Nginx:** restore the previous site file, `nginx -t && systemctl reload nginx`.
- **Backend code:** `mv erp-backend erp-backend.bad && mv erp-backend.prev erp-backend && systemctl restart oscenia-api`.
  Migrations are not undone, so each one must be backward compatible with the release before it.

## Checks

```bash
systemctl status oscenia-api --no-pager
journalctl -u oscenia-api -n 50 --no-pager
curl -s http://127.0.0.1:8010/health
ss -lntp | grep -E ':(8010|5432)\b'          # both must show 127.0.0.1 only
systemctl is-active fyers_v2 nginx           # the neighbours, unchanged
```

## Credentials

Access today is by root password, which was shared in chat. The owner has decided to keep it as it is
for now; moving to SSH keys with a non-root deploy user, and rotating the password, is still advised.
The CEO's password is recorded nowhere in the repo or on the server except as a hash in the database.
