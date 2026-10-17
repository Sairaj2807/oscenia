#!/usr/bin/env bash
# Build the website and the ERP on THIS machine and ship the static files to the VPS.
#
#   VPS_HOST=deploy@194.164.148.203 deploy/vps/ship-static.sh
#
# Why not build on the server: it has one core, ~2.5 GB free, no swap, and runs trading services.
# Each run lands in /var/www/oscenia/releases/<timestamp>/ and /var/www/oscenia/site is a symlink to
# it, so the switch is atomic and rollback is one `ln -sfn` (see deploy/vps/README.md).
set -euo pipefail

HOST="${VPS_HOST:?set VPS_HOST, e.g. deploy@194.164.148.203}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

echo "==> building the website"
( cd "$ROOT/website" && npm ci --no-audit --no-fund && npx vite build )

echo "==> building the ERP (same-origin API at /api/v1)"
# MSYS_NO_PATHCONV: in Git Bash on Windows, a value like /api/v1 is silently rewritten to
# "C:/Program Files/Git/api/v1", which broke every request. The check below refuses such a build.
( cd "$ROOT/erp-frontend" && npm ci --no-audit --no-fund && MSYS_NO_PATHCONV=1 VITE_API_URL=/api/v1 npx vite build )
if grep -rlE 'Program Files|C:/Users' "$ROOT/erp-frontend/dist" >/dev/null 2>&1    || ! grep -rlF '`/api/v1`' "$ROOT/erp-frontend/dist/assets" >/dev/null 2>&1; then
  echo "refusing to ship: the ERP bundle does not have the relative API base /api/v1" >&2
  exit 1
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -r "$ROOT/website/dist/." "$STAGE/"
mkdir -p "$STAGE/erp" && cp -r "$ROOT/erp-frontend/dist/." "$STAGE/erp/"

echo "==> shipping"
tar -C "$STAGE" -czf - . | ssh "$HOST" '
  set -e
  D=/var/www/oscenia
  R="$D/releases/$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$R"
  tar -xzf - -C "$R"
  ln -sfn "$R" "$D/site.new" && mv -Tf "$D/site.new" "$D/site"
  ls -1dt "$D"/releases/* | tail -n +4 | xargs -r rm -rf   # keep the last three
  echo "live: $R"
'
