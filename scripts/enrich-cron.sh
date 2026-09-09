#!/usr/bin/env bash
# Bank enrichment cron wrapper — the bank's digestive system, scheduled.
# Runs the enrichment pass against EVERY Lina DB present on this machine
# (lina.db = production server, tui.db = TUI process) so the two-DB split
# can never leave learned answers unprocessed. Re-runnable, idempotent,
# catches up automatically after downtime (queue lives in SQLite WAL).
set -u
cd "$(dirname "$0")/.."
mkdir -p logs

for dbpath in data/lina.db data/tui.db; do
  if [ -f "$dbpath" ]; then
    echo "[$(date '+%F %T')] enrich pass on $dbpath" >> logs/enrich-cron.log
    DB_PATH="$dbpath" /usr/bin/env npx tsx src/scripts/enrichBank.ts >> logs/enrich-cron.log 2>&1
  fi
done

# Weekly gapfill (Sunday 00:30 — after the daily pass, before business hours)
if [ "$(date +%u)" = "7" ] && [ "$(date +%H)" = "00" ]; then
  for dbpath in data/lina.db data/tui.db; do
    if [ -f "$dbpath" ]; then
      echo "[$(date '+%F %T')] gapfill pass on $dbpath" >> logs/enrich-cron.log
      DB_PATH="$dbpath" /usr/bin/env npx tsx src/scripts/enrichBank.ts --gapfill >> logs/enrich-cron.log 2>&1
    fi
  done
fi
