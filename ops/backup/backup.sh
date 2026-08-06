#!/usr/bin/env bash
#
# Takes a backup of the HelaEngine database.
#
#   ops/backup/backup.sh                      # to ./backups, from $DATABASE_URL
#   BACKUP_DIR=/mnt/backups ops/backup/backup.sh
#
# Custom format (`-Fc`) rather than plain SQL, for three reasons that matter during an incident:
# it is compressed, it can be restored selectively (one table, when only one is broken), and
# `pg_restore` can run it in parallel. A 2 GB plain-text dump restored serially is the difference
# between a ten-minute outage and an hour one.
#
# `--no-owner` and `--no-privileges` so a restore works against a database whose roles differ from
# production's. A backup that only restores onto an identically-provisioned server is a backup that
# fails on the day you are restoring onto whatever you could get hold of.

set -euo pipefail

DATABASE_URL="${DATABASE_URL:-postgres://hela@localhost:5432/helaengine}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETAIN_DAYS="${RETAIN_DAYS:-14}"

mkdir -p "$BACKUP_DIR"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$BACKUP_DIR/helaengine-$stamp.dump"

echo "Backing up to $target"
pg_dump --dbname="$DATABASE_URL" --format=custom --no-owner --no-privileges --file="$target"

# A backup nobody has verified is a hope. `pg_restore --list` reads the archive's table of contents
# and fails on a truncated or corrupt file, which is the failure mode that otherwise stays invisible
# until the day it matters.
if ! pg_restore --list "$target" > /dev/null; then
  echo "FAILED: $target is not a readable archive. Not keeping it." >&2
  rm -f "$target"
  exit 1
fi

bytes="$(stat -c %s "$target" 2>/dev/null || stat -f %z "$target")"
tables="$(pg_restore --list "$target" | grep -c 'TABLE DATA' || true)"
echo "OK: $((bytes / 1024)) KiB, $tables tables with data"

# Old backups are removed *after* a new one has been verified, never before. The alternative is a
# window in which the old backup is gone and the new one turned out to be unreadable.
find "$BACKUP_DIR" -name 'helaengine-*.dump' -type f -mtime "+$RETAIN_DAYS" -print -delete
