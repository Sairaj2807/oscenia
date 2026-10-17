#!/usr/bin/env bash
# Deploy one environment: pull, build, migrate, restart.
#
#   deploy/deploy.sh staging              # deploys origin/main
#   deploy/deploy.sh production v0.3.0    # deploys a tag, branch or commit
#
# Run from the environment's own checkout on the VPS (see deploy/README.md). Migrations run
# in the one-shot "migrate" service before the API is replaced; if they fail, the old API
# keeps serving and this script stops with a non-zero exit.
set -euo pipefail

# Everything is inside main(), called on the last line. This script checks out a new ref
# part-way through, which can replace this very file; bash reads a script as it runs, so
# without the function it could go on executing a mix of the old and new versions.
main() {
ENVIRONMENT="${1:-}"
REF="${2:-origin/main}"

case "$ENVIRONMENT" in
  production|staging) ;;
  *) echo "usage: $0 production|staging [git-ref]" >&2; exit 2 ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/deploy/.env.$ENVIRONMENT"
COMPOSE=(docker compose -p "oscenia-$ENVIRONMENT" --env-file "$ENV_FILE" -f "$ROOT/deploy/docker-compose.prod.yml")

[[ -f "$ENV_FILE" ]] || { echo "missing $ENV_FILE — copy deploy/.env.example and fill it in" >&2; exit 1; }

# Read one key from the env file without sourcing it (values may hold shell metacharacters).
env_value() { grep -E "^$1=" "$ENV_FILE" | tail -n1 | cut -d= -f2-; }

[[ "$(env_value DEPLOY_ENV)" == "$ENVIRONMENT" ]] \
  || { echo "DEPLOY_ENV in $ENV_FILE must be $ENVIRONMENT" >&2; exit 1; }
for key in POSTGRES_PASSWORD JWT_SECRET SIGNING_SECRET; do
  [[ -n "$(env_value "$key")" ]] || { echo "$key is empty in $ENV_FILE" >&2; exit 1; }
done

PROFILE=()
if [[ "$ENVIRONMENT" == production ]]; then
  # Caddy lives with production and serves both domains; an empty one would be a site
  # with no address.
  for key in SITE_DOMAIN STAGING_SITE_DOMAIN ACME_EMAIL; do
    [[ -n "$(env_value "$key")" ]] || { echo "$key is empty in $ENV_FILE" >&2; exit 1; }
  done
  PROFILE=(--profile edge)
fi

echo "==> $ENVIRONMENT: fetching $REF"
cd "$ROOT"
git fetch --tags --prune origin
git checkout --detach "$REF"
echo "    at $(git log -1 --format='%h %s')"

# A fixed subnet, so Caddy can have a fixed address that the APIs trust (see compose file).
docker network inspect oscenia-edge >/dev/null 2>&1 \
  || docker network create --subnet 172.30.42.0/24 oscenia-edge >/dev/null

echo "==> building"
# Production also builds the edge image (website + ERP bundles); staging has no edge.
BUILD=(api)
[[ "$ENVIRONMENT" == production ]] && BUILD+=(caddy)
"${COMPOSE[@]}" "${PROFILE[@]}" build "${BUILD[@]}"

echo "==> migrating"
"${COMPOSE[@]}" up -d db
"${COMPOSE[@]}" run --rm migrate

echo "==> restarting"
"${COMPOSE[@]}" "${PROFILE[@]}" up -d --remove-orphans

echo "==> waiting for /health"
for _ in $(seq 1 30); do
  status="$("${COMPOSE[@]}" ps --format '{{.Health}}' api 2>/dev/null || true)"
  if [[ "$status" == healthy ]]; then
    echo "    healthy"
    docker image prune -f >/dev/null
    exit 0
  fi
  sleep 2
done

# No automatic rollback: migrations have already run. Redeploy the previous ref with this
# script (the build is cached); migrations must therefore stay backward-compatible with the
# previous release, which keeps serving on the new schema until then.
echo "API did not become healthy. Recent logs:" >&2
"${COMPOSE[@]}" logs --tail 50 api >&2
exit 1
}

main "$@"
