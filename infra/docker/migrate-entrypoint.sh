#!/bin/sh
#
# Waits for the database, then applies pending migrations and exits.
#
# `prisma migrate deploy` is the only migration command that belongs in
# production: it applies committed migration files and never generates,
# resets, or prompts. `migrate dev` and `db push` are development-only and are
# deliberately not reachable from this image.
set -eu

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is not set." >&2
  exit 1
fi

WAIT_SECONDS="${MIGRATE_WAIT_SECONDS:-90}"
ELAPSED=0

echo "Waiting for the database to accept connections (up to ${WAIT_SECONDS}s)..."
# pg_isready parses the connection string itself, so no credentials are echoed.
until pg_isready -d "$DATABASE_URL" -q 2>/dev/null; do
  if [ "$ELAPSED" -ge "$WAIT_SECONDS" ]; then
    echo "ERROR: database was not reachable after ${WAIT_SECONDS}s." >&2
    exit 1
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
done
echo "Database is accepting connections."

echo "Current migration status:"
# `migrate status` exits non-zero when migrations are pending, which is the
# normal case here, so its exit code is not treated as a failure.
node_modules/.bin/prisma migrate status || true

echo "Applying pending migrations..."
node_modules/.bin/prisma migrate deploy

echo "Migrations applied successfully."
