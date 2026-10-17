#!/usr/bin/env bash
# Ship the committed backend to the VPS, install it and restart the API.
#
#   VPS_HOST=deploy@194.164.148.203 deploy/vps/update-api.sh
#
# Restarting runs `alembic upgrade head` first (ExecStartPre in oscenia-api.service); if a migration
# fails the service does not come up, and the previous code is still in erp-backend.prev. Migrations
# must stay backward compatible with the release before, because rolling back does not undo them.
set -euo pipefail

HOST="${VPS_HOST:?set VPS_HOST, e.g. root@194.164.148.203}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

echo "==> packing the committed backend ($(git -C "$ROOT" rev-parse --short HEAD))"
git -C "$ROOT" archive --format=tar.gz HEAD erp-backend | ssh "$HOST" 'cat > /root/erp-backend.tgz'

ssh "$HOST" 'bash -s' <<'REMOTE'
set -euo pipefail
cd /srv/oscenia
rm -rf erp-backend.new && mkdir erp-backend.new
tar -xzf /root/erp-backend.tgz -C erp-backend.new --strip-components=1
rm -rf erp-backend.prev; mv erp-backend erp-backend.prev; mv erp-backend.new erp-backend
chown -R oscenia:oscenia /srv/oscenia
runuser -u oscenia -- nice -n 10 /srv/oscenia/venv/bin/pip install --quiet --disable-pip-version-check /srv/oscenia/erp-backend
systemctl restart oscenia-api.service
for _ in $(seq 1 30); do
  curl -fsS -m 3 http://127.0.0.1:8010/health && { echo; echo "healthy"; exit 0; }
  sleep 2
done
echo "API did not become healthy:" >&2
journalctl -u oscenia-api.service --no-pager -n 30 >&2
exit 1
REMOTE
