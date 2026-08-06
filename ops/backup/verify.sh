#!/usr/bin/env bash
#
# Proves a backup can be restored and that the data comes back.
#
#   ops/backup/verify.sh
#
# This is the point of the whole directory. Sprint 40's definition of done says "confirm
# backup/restore procedures for Postgres are **tested (not just configured)**", and the distance
# between those two words is where most data-loss incidents live: the dump has been running nightly
# for a year, and nobody has ever read one back.
#
# So: take a real backup of a database with known rows, restore it into a *different* empty
# database, and compare row counts and a sample of actual content. Anything less proves the file
# exists, not that it is a backup.

set -euo pipefail

SOURCE_URL="${SOURCE_URL:-${DATABASE_URL:-}}"
SCRATCH_DB="${SCRATCH_DB:-helaengine_restore_check}"

if [[ -z "$SOURCE_URL" ]]; then
  echo "Set SOURCE_URL (or DATABASE_URL) to the database to verify." >&2
  exit 2
fi

# The admin connection is the source URL with the database swapped for `postgres`, so creating and
# dropping the scratch database needs no second credential.
ADMIN_URL="${ADMIN_URL:-$(echo "$SOURCE_URL" | sed 's![^/]*$!postgres!')}"
TARGET_URL="$(echo "$SOURCE_URL" | sed "s![^/]*\$!$SCRATCH_DB!")"

work="$(mktemp -d)"
cleanup() {
  rm -rf "$work"
  psql "$ADMIN_URL" -Atc "drop database if exists $SCRATCH_DB" > /dev/null 2>&1 || true
}
trap cleanup EXIT

echo "1. Counting what is in the source"
before_projects="$(psql "$SOURCE_URL" -Atc 'select count(*) from projects')"
before_users="$(psql "$SOURCE_URL" -Atc 'select count(*) from users')"
before_versions="$(psql "$SOURCE_URL" -Atc 'select count(*) from scene_versions')"
# A sample of real content, not just a count. A restore that produces the right number of empty
# rows is a restore that has lost everything anybody cared about.
before_digest="$(psql "$SOURCE_URL" -Atc "select coalesce(md5(string_agg(name, '|' order by id)), 'none') from projects")"
echo "   projects=$before_projects users=$before_users versions=$before_versions"

echo "2. Backing up"
BACKUP_DIR="$work" DATABASE_URL="$SOURCE_URL" "$(dirname "$0")/backup.sh" > /dev/null
archive="$(find "$work" -name '*.dump' | head -1)"
[[ -n "$archive" ]] || { echo "backup.sh produced no archive" >&2; exit 1; }

echo "3. Restoring into a fresh $SCRATCH_DB"
psql "$ADMIN_URL" -Atc "drop database if exists $SCRATCH_DB" > /dev/null
psql "$ADMIN_URL" -Atc "create database $SCRATCH_DB" > /dev/null
TARGET_URL="$TARGET_URL" "$(dirname "$0")/restore.sh" "$archive" > /dev/null

echo "4. Comparing"
after_projects="$(psql "$TARGET_URL" -Atc 'select count(*) from projects')"
after_users="$(psql "$TARGET_URL" -Atc 'select count(*) from users')"
after_versions="$(psql "$TARGET_URL" -Atc 'select count(*) from scene_versions')"
after_digest="$(psql "$TARGET_URL" -Atc "select coalesce(md5(string_agg(name, '|' order by id)), 'none') from projects")"

fail=0
compare() {
  if [[ "$2" != "$3" ]]; then
    echo "   MISMATCH $1: source=$2 restored=$3" >&2
    fail=1
  else
    echo "   ok $1: $2"
  fi
}

compare projects "$before_projects" "$after_projects"
compare users "$before_users" "$after_users"
compare scene_versions "$before_versions" "$after_versions"
compare content-digest "$before_digest" "$after_digest"

# The schema has to come back too, not only the rows — a restore that loses a constraint restores
# data into a database that will accept the corruption the constraint existed to prevent.
before_constraints="$(psql "$SOURCE_URL" -Atc "select count(*) from information_schema.table_constraints where constraint_schema = 'public'")"
after_constraints="$(psql "$TARGET_URL" -Atc "select count(*) from information_schema.table_constraints where constraint_schema = 'public'")"
compare constraints "$before_constraints" "$after_constraints"

if [[ "$fail" != "0" ]]; then
  echo
  echo "RESTORE VERIFICATION FAILED — the backup does not reproduce the source." >&2
  exit 1
fi

echo
echo "Restore verified: the backup reproduces the source."
