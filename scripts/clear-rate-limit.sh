#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# clear-rate-limit.sh — clear the Rara Agent rate-limit table for one IP,
# one action, or everything. Useful when a legitimate user gets locked out
# during testing or after a Cloudflare-induced retry storm.
#
# Usage:
#   bash scripts/clear-rate-limit.sh                      # clear ALL rate limits
#   bash scripts/clear-rate-limit.sh login_attempt         # clear all login_attempt rows
#   bash scripts/clear-rate-limit.sh login_attempt 1.2.3.4 # clear login_attempt for IP 1.2.3.4
#
# Env:
#   DATABASE_URL  — Prisma SQLite path (default: file:./db/rara.db)
#   SQLITE_CLI    — path to sqlite3 binary (default: sqlite3)
#
# In Docker: copy this script into the container or run via docker exec:
#   docker exec rara sqlite3 /app/db/rara.db \
#     "DELETE FROM RateLimit WHERE action='login_attempt';"
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ACTION="${1:-}"
IP="${2:-}"
DB_PATH="${DATABASE_URL:-file:./db/rara.db}"
DB_PATH="${DB_PATH#file:}"   # strip 'file:' prefix
SQLITE="${SQLITE_CLI:-sqlite3}"

if [ ! -f "$DB_PATH" ]; then
  echo "ERROR: database file not found at $DB_PATH"
  echo "Hint: set DATABASE_URL or run this script from the rara-agent root."
  exit 1
fi

if ! command -v "$SQLITE" >/dev/null 2>&1; then
  echo "ERROR: $SQLITE not found. Install sqlite3 or set SQLITE_CLI to its path."
  exit 1
fi

# Build the WHERE clause
WHERE=""
if [ -n "$ACTION" ] && [ -n "$IP" ]; then
  WHERE="WHERE action='$ACTION' AND ipAddr='$IP'"
elif [ -n "$ACTION" ]; then
  WHERE="WHERE action='$ACTION'"
elif [ -n "$IP" ]; then
  WHERE="WHERE ipAddr='$IP'"
fi

QUERY="SELECT id, ipAddr, action, count, datetime(windowStart/1000,'unixepoch') as windowStart FROM RateLimit $WHERE ORDER BY windowStart DESC LIMIT 20;"

echo "=== Current RateLimit rows matching: ${WHERE:-(ALL)} ==="
"$SQLITE" -header -column "$DB_PATH" "$QUERY" 2>&1 || true

echo
echo "=== Deleting matching rows ==="
"$SQLITE" "$DB_PATH" "DELETE FROM RateLimit $WHERE;"
echo "✓ Cleared."

echo
echo "=== After clear: any rows left? ==="
"$SQLITE" -header -column "$DB_PATH" "SELECT COUNT(*) as remaining FROM RateLimit $WHERE;" 2>&1 || true
