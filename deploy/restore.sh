#!/usr/bin/env bash
# Restore a backup into an environment, replacing its database and uploads.
#
#   deploy/restore.sh staging deploy/backups/production/db-20261006T020000Z.dump \
#                             deploy/backups/production/uploads-20261006T020000Z.tar.gz
#
# The routine use is restoring last night's production backup into staging: it proves the
# backup works, and gives staging realistic data. Restoring into production asks first.
set -euo pipefail

ENVIRONMENT="${1:-}"
DB_FILE="${2:-}"
UPLOADS_FILE="${3:-}"

case "$ENVIRONMENT" in
  production|staging) ;;
  *) echo "usage: $0 production|staging <db.dump> [uploads.tar.gz]" >&2; exit 2 ;;
esac
[[ -f "$DB_FILE" ]] || { echo "no such dump: $DB_FILE" >&2; exit 2; }
[[ -z "$UPLOADS_FILE" || -f "$UPLOADS_FILE" ]] || { echo "no such archive: $UPLOADS_FILE" >&2; exit 2; }

if [[ "$ENVIRONMENT" == production ]]; then
  read -r -p "This REPLACES the production database and uploads. Type 'production' to go on: " answer
  [[ "$answer" == production ]] || { echo "stopped"; exit 1; }
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/deploy/.env.$ENVIRONMENT"
PROJECT="oscenia-$ENVIRONMENT"
COMPOSE=(docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$ROOT/deploy/docker-compose.prod.yml")

# Check both files before anything is stopped or deleted: a corrupt dump or archive must
# leave the environment exactly as it was.
echo "==> checking the backup files"
"${COMPOSE[@]}" up -d db
"${COMPOSE[@]}" exec -T db pg_restore --list < "$DB_FILE" > /dev/null \
  || { echo "the dump is not readable: $DB_FILE" >&2; exit 1; }
if [[ -n "$UPLOADS_FILE" ]]; then
  tar -tzf "$UPLOADS_FILE" > /dev/null \
    || { echo "the archive is not readable: $UPLOADS_FILE" >&2; exit 1; }
  docker volume inspect "${PROJECT}_uploads" > /dev/null \
    || { echo "no volume ${PROJECT}_uploads — has $ENVIRONMENT been deployed?" >&2; exit 1; }
fi

echo "==> stopping the API"
"${COMPOSE[@]}" stop api

echo "==> restoring the database"
"${COMPOSE[@]}" exec -T db sh -c \
  'dropdb -U oscenia --if-exists oscenia_erp_restore && createdb -U oscenia oscenia_erp_restore'
"${COMPOSE[@]}" exec -T db pg_restore -U oscenia -d oscenia_erp_restore --no-owner --exit-on-error \
  < "$DB_FILE"
# Swap only once the restore has fully succeeded, so a bad dump leaves the old data intact.
"${COMPOSE[@]}" exec -T db psql -U oscenia -d postgres -v ON_ERROR_STOP=1 \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'oscenia_erp' AND pid <> pg_backend_pid();" \
  -c "DROP DATABASE oscenia_erp;" \
  -c "ALTER DATABASE oscenia_erp_restore RENAME TO oscenia_erp;"

if [[ -n "$UPLOADS_FILE" ]]; then
  echo "==> restoring uploads"
  # Extract beside the live files first; only a complete extraction replaces them. The
  # archive name travels as an environment variable, never spliced into the script.
  docker run --rm -e ARCHIVE="$(basename "$UPLOADS_FILE")" \
    -v "${PROJECT}_uploads:/data" \
    -v "$(cd "$(dirname "$UPLOADS_FILE")" && pwd):/backup:ro" \
    alpine sh -euc '
      rm -rf /data/.incoming && mkdir /data/.incoming
      tar -xzf "/backup/$ARCHIVE" -C /data/.incoming
      find /data -mindepth 1 -maxdepth 1 ! -name .incoming -exec rm -rf {} +
      find /data/.incoming -mindepth 1 -maxdepth 1 -exec mv {} /data/ \;
      rmdir /data/.incoming
    '
fi

echo "==> migrating and starting the API"
"${COMPOSE[@]}" run --rm migrate
"${COMPOSE[@]}" up -d api
echo "    done — check /health"
