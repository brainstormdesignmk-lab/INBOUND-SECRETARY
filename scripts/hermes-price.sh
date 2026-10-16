#!/usr/bin/env bash
# Hermes owner sync (cron wrapper) — owner corrections reach the app ASAP.
#
# REQUIRED, NOT OPTIONAL (2026-10-14). This is the ONE scheduled job that must
# stay installed, and it drains TWO queues of owner-dictated facts:
#   price_changes    — Lina asks the owner the CURRENT price; a different one is
#                      pushed so the public price follows the owner's word.
#   address_changes  — Lina confirms the ADDRESS with the owner before a visit;
#                      when the owner gives a different street, the owner owns
#                      the building and the listing learns the real one.
# It is NOT map work. A no-cron sweep deleted this line once and every published
# price silently froze while corrected addresses piled up locally.
# `npm run cron:check -- --require-sync` now fails if it is missing.
#
# Lina records every owner price correction in data/lina.db (price_changes,
# status='pending'); this pushes them through the T60 Hub (HERMES_WRITE_URL),
# which is the ONLY writer to the app. A failed push leaves the row pending, so
# a Hub/T60 outage delays a correction instead of losing it.
#
# Runs the COMPILED script (node dist/scripts/hermes.js): tsx is a dev-only
# dependency and is NOT installed on the atoms (2026-10-07 fix — `npm run
# hermes` dies with `sh: 1: tsx: not found`).
#
# Usage:
#   scripts/hermes-price.sh            # the cron entry (and safe to run by hand)
#   scripts/hermes-price.sh --dry-run  # report only, nothing sent, nothing resolved
#
# Cron line (every 5 min — a correction must not wait for a nightly):
#   */5 * * * * /home/atom/Documents/PROJECTS/LINA/scripts/hermes-price.sh
#
# Log: data/logs/hermes-price.log, rotated at ~2 MB (keeps 2 old copies).
set -u

# cron gives a user crontab only /usr/bin:/bin, and node lives in
# /usr/local/bin on the atoms (a symlink to /opt/node-*). Without this the
# wrapper dies with `node: not found` and the sync silently never runs.
export PATH="/usr/local/bin:/usr/bin:/bin:${PATH:-}"

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$PROJECT_DIR/data/logs"
LOG_FILE="$LOG_DIR/hermes-price.log"
LOCK_FILE="$LOG_DIR/hermes-price.lock"
MAX_BYTES=$((2 * 1024 * 1024))

mkdir -p "$LOG_DIR"

# Overlap guard: a slow run must not stack up behind the next cron tick.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] previous run still going — skipped" >> "$LOG_FILE"
  exit 0
fi

# Rotate when over ~2 MB: drop .2, shift .1 -> .2, log -> .1.
if [ -f "$LOG_FILE" ] && [ "$(stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)" -gt "$MAX_BYTES" ]; then
  rm -f "$LOG_FILE.2"
  mv -f "$LOG_FILE.1" "$LOG_FILE.2" 2>/dev/null || true
  mv -f "$LOG_FILE" "$LOG_FILE.1" 2>/dev/null || true
fi

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"; }

log "=== hermes:price run ==="

cd "$PROJECT_DIR" || { log "ERROR: cannot cd $PROJECT_DIR"; exit 1; }

# --dry-run passthrough for testing (report only).
ARGS=()
if [ "${1:-}" = "--dry-run" ]; then
  ARGS=(--dry-run)
  log "(dry-run — nothing sent, nothing resolved)"
fi

if ! node dist/scripts/hermes.js "${ARGS[@]}" >> "$LOG_FILE" 2>&1; then
  log "ERROR: price sync failed (see above) — check HERMES_WRITE_URL/HERMES_TOKEN and the T60 Hub."
  exit 1
fi

exit 0
