#!/usr/bin/env bash
# enrich-bank.sh — midnight cron job for response bank enrichment.
#
# Usage (crontab):
#   0 0 * * * /path/to/scripts/enrich-bank.sh >> /path/to/data/enrich-cron.log 2>&1
#
# Behavior:
#   - Runs at 24:00 (midnight)
#   - If the machine was off or cron missed, it catches up tomorrow
#     — the queue accumulates across days
#   - Processes all pending records from the enrichment_queue table
#   - No electricity / no internet needed to READ — the queue lives in SQLite
#
# The enriched bank file (src/data/responses.ts) is the single source of truth.
# The cron job appends new variants and the bank grows automatically.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_FILE="${PROJECT_DIR}/data/enrich-cron.log"

# Ensure log directory exists
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
