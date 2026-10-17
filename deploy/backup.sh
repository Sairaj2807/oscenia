#!/usr/bin/env bash
# Nightly backup of one environment: a pg_dump of the database plus the uploads volume,
# copied off the VPS with rclone when BACKUP_REMOTE is set.
#
#   deploy/backup.sh production
#
# Cron (as the deploy user), 02:00 server time:
#   0 2 * * * /srv/oscenia/production/deploy/backup.sh production >> /var/log/oscenia-backup.log 2>&1
#
# A backup that has never been restored is a hope, not a backup: see restore.sh.
set -euo pipefail
# Dumps hold password hashes and guests' personal data: readable by this user only.
umask 077

ENVIRONMENT="${1:-}"
case "$ENVIRONMENT" in
  production|staging) ;;
  *) echo "usage: $0 production|staging" >&2; exit 2 ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/deploy/.env.$ENVIRONMENT"
PROJECT="oscenia-$ENVIRONMENT"
COMPOSE=(docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$ROOT/deploy/docker-compose.prod.yml")

env_value() { grep -E "^$1=" "$ENV_FILE" | tail -n1 | cut -d= -f2-; }
REMOTE="$(env_value BACKUP_REMOTE || true)"
KEEP_DAYS="$(env_value BACKUP_KEEP_DAYS || true)"
KEEP_DAYS="${KEEP_DAYS:-14}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DIR="${BACKUP_DIR:-$ROOT/deploy/backups/$ENVIRONMENT}"
mkdir -p "$DIR"

DB_FILE="$DIR/db-$STAMP.dump"
UPLOADS_FILE="$DIR/uploads-$STAMP.tar.gz"
# A failed run leaves nothing half-written that could later be mistaken for a backup.
trap 'rm -f "$DB_FILE.partial" "$UPLOADS_FILE.partial"' EXIT

echo "==> $(date -u +%FT%TZ) $ENVIRONMENT backup"

# Custom format: compressed, and pg_restore can restore it selectively.
"${COMPOSE[@]}" exec -T db pg_dump -U oscenia -d oscenia_erp --format=custom --no-owner \
  > "$DB_FILE.partial"
mv "$DB_FILE.partial" "$DB_FILE"

# The uploads volume, read through a throwaway container so nothing needs root on the host.
# Checked first: `docker run -v` would silently create an empty volume and back up nothing.
docker volume inspect "${PROJECT}_uploads" > /dev/null \
  || { echo "no volume ${PROJECT}_uploads — is $ENVIRONMENT deployed?" >&2; exit 1; }
docker run --rm -v "${PROJECT}_uploads:/data:ro" -v "$DIR:/backup" alpine \
  tar -czf "/backup/$(basename "$UPLOADS_FILE").partial" -C /data .
mv "$UPLOADS_FILE.partial" "$UPLOADS_FILE"

echo "    $(du -h "$DB_FILE" | cut -f1) database, $(du -h "$UPLOADS_FILE" | cut -f1) uploads"

if [[ -n "$REMOTE" ]]; then
  rclone copy "$DB_FILE" "$REMOTE/"
  rclone copy "$UPLOADS_FILE" "$REMOTE/"
  echo "    copied to $REMOTE"
else
  echo "    WARNING: BACKUP_REMOTE is empty — this backup exists only on the VPS" >&2
fi

# Local retention only. Off-site retention is a lifecycle rule on the bucket.
find "$DIR" -type f \( -name 'db-*.dump' -o -name 'uploads-*.tar.gz' \) -mtime "+$KEEP_DAYS" -delete
echo "    done"
