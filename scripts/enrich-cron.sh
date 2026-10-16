#!/usr/bin/env bash
# enrich-cron.sh — the bank enrichment pass over EVERY Lina DB on this machine.
# MANUAL RUN. NOT SCHEDULED.
#
# NO CRONS (2026-10-14): the `30 0 * * *` line is gone. Enrichment spends Gemini
# keys and changes what Lina replies, so it happens when a human decides —
# after reviewing what was collected (atoms-status → bank:review → import).
#
# THE WEEKLY GAPFILL used to be a CLOCK CHECK inside this script (run on Sunday
# at 00:00, take the slow path). A manual tool cannot depend on what time it is:
# you would have to run it at midnight on a Sunday to get the gapfill. It is an
# argument now — `--gapfill` — so the slow pass happens when you ask for it.
#
# Usage:
#   bash scripts/enrich-cron.sh             # pending queue, both DBs
#   bash scripts/enrich-cron.sh --gapfill   # + the slower gap-filling pass
#
# Re-runnable and idempotent: the queue lives in SQLite, so a pass that is
# interrupted or skipped simply catches up on the next manual run.
set -u
cd "$(dirname "$0")/.."
mkdir -p logs

ARGS=()
[ "${1:-}" = "--gapfill" ] && ARGS=(--gapfill)

for dbpath in data/lina.db data/tui.db; do
  if [ -f "$dbpath" ]; then
    echo "[$(date '+%F %T')] enrich pass on $dbpath ${ARGS[*]:-}" >> logs/enrich-cron.log
    DB_PATH="$dbpath" /usr/bin/env npx tsx src/scripts/enrichBank.ts "${ARGS[@]}" >> logs/enrich-cron.log 2>&1
  fi
done
