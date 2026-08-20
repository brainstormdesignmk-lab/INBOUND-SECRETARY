#!/usr/bin/env bash
# Nightly Hermes landmark resolver (cron wrapper).
#
# Resolves the NEAREST public landmark for every property address that still
# has only the coarse table fallback, using Hermes' own reasoning LLM (NVIDIA
# NIM) — see src/scripts/hermesLandmarks.ts. Output goes to
# data/logs/hermes-landmarks.log, rotated at ~2 MB (keeps 2 old copies).
#
# Usage:
#   scripts/hermes-nightly.sh            # the cron entry
#   scripts/hermes-nightly.sh --dry-run  # report-only (no LLM calls, no writes)
#
# Cron line (nightly 03:17 — off-peak, after the day's chat traffic settles):
#   17 3 * * * /abs/path/to/scripts/hermes-nightly.sh
#
# NOTE (two machines): this runs where Hermes lives. Today that is the same box
# as Lina (reads data/lina.db directly). When Hermes moves to its own machine,
# this script moves with it and talks to Lina via the /hermes/v1 API instead —
# only the command inside changes, the logging/rotation stays.
set -u

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$PROJECT_DIR/data/logs"
LOG_FILE="$LOG_DIR/hermes-landmarks.log"
MAX_BYTES=$((2 * 1024 * 1024))

mkdir -p "$LOG_DIR"

# Rotate when over ~2 MB: drop .2, shift .1 -> .2, log -> .1.
if [ -f "$LOG_FILE" ] && [ "$(stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)" -gt "$MAX_BYTES" ]; then
  rm -f "$LOG_FILE.2"
  mv -f "$LOG_FILE.1" "$LOG_FILE.2" 2>/dev/null || true
  mv -f "$LOG_FILE" "$LOG_FILE.1" 2>/dev/null || true
fi

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"; }

log "=== hermes:landmarks nightly run ==="

cd "$PROJECT_DIR" || { log "ERROR: cannot cd $PROJECT_DIR"; exit 1; }

# --dry-run passthrough for testing (report only).
ARGS=()
if [ "${1:-}" = "--dry-run" ]; then
  ARGS=(-- --dry-run)
  log "(dry-run — nothing written, no LLM calls)"
fi

if ! npm run hermes:landmarks "${ARGS[@]}" >> "$LOG_FILE" 2>&1; then
  log "ERROR: hermes:landmarks failed (see above) — check ~/.lina/lina.env keys and the feed."
  exit 1
fi

log "=== done ==="
exit 0
