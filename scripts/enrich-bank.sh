#!/usr/bin/env bash
# enrich-bank.sh — LEGACY duplicate of enrich-cron.sh. MANUAL RUN. NOT SCHEDULED.
#
# NO CRONS (2026-10-14): the `0 0 * * *` line is gone, and this file was never
# the supported entry point anyway — enrich-cron.sh is (it covers BOTH DBs:
# data/lina.db and data/tui.db, which the two-DB split requires). Kept only so
# an old note does not turn into a mystery; prefer:
#
#   bash scripts/enrich-cron.sh              # both DBs, manual
#   bash scripts/enrich-cron.sh --gapfill    # + the weekly gapfill pass
#
# The enriched bank is the single source of truth for reply wording; nothing
# touches it on a timer.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_FILE="${PROJECT_DIR}/data/enrich-cron.log"

mkdir -p "$(dirname "$LOG_FILE")"

echo "=== enrich-bank: $(date -Iseconds) ==="

cd "$PROJECT_DIR"

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
  echo "[enrich] node_modules not found — running npm install"
  npm install --omit=dev
fi

# Run the enrichment script
npx tsx src/scripts/enrichBank.ts 2>&1 | tee -a "$LOG_FILE"

echo "=== enrich-bank: finished $(date -Iseconds) ==="
echo "" >> "$LOG_FILE"
