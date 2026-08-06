#!/usr/bin/env bash
#
# Restores a HelaEngine backup into a database.
#
#   ops/backup/restore.sh backups/helaengine-20260806T101500Z.dump
#   TARGET_URL=postgres://hela@localhost:5432/helaengine_restored ops/backup/restore.sh <file>
#
# **Refuses to overwrite a database that has data in it unless FORCE=1.** Restoring onto a live
# database is how a partial outage becomes a total one, and the moment somebody is running this
# they are stressed and typing fast. The guard is the point.

set -euo pipefail

ARCHIVE="${1:-}"
TARGET_URL="${TARGET_URL:-${DATABASE_URL:-}}"

if [[ -z "$ARCHIVE" || -z "$TARGET_URL" ]]; then
  echo "usage: TARGET_URL=postgres://… $0 <archive.dump>" >&2
  exit 2
fi

if [[ ! -f "$ARCHIVE" ]]; then
  echo "No such archive: $ARCHIVE" >&2
  exit 2
fi

# Read the archive before touching the target. A corrupt file discovered halfway through a restore
# has already dropped the schema it was going to replace.
if ! pg_restore --list "$ARCHIVE" > /dev/null; then
  echo "FAILED: $ARCHIVE is not a readable archive. Refusing to restore from it." >&2
  exit 1
fi

existing="$(psql "$TARGET_URL" -Atc "select count(*) from information_schema.tables where table_schema = 'public'" 2>/dev/null || echo 0)"

if [[ "$existing" != "0" && "${FORCE:-}" != "1" ]]; then
  echo "The target already has $existing tables. Set FORCE=1 to restore over them." >&2
  exit 1
fi

echo "Restoring $ARCHIVE into $TARGET_URL"

# `--clean --if-exists` so a forced restore replaces rather than collides, and `--exit-on-error` so
# a failure stops rather than leaving a half-restored database that looks like it worked.
pg_restore --dbname="$TARGET_URL" --no-owner --no-privileges --clean --if-exists \
  --exit-on-error --jobs="${JOBS:-2}" "$ARCHIVE"

rows="$(psql "$TARGET_URL" -Atc "select count(*) from projects" 2>/dev/null || echo '?')"
echo "OK. projects table has $rows rows."
