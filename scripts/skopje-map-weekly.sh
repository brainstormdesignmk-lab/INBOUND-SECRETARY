#!/usr/bin/env bash
# Offline-map pull — MANUAL RUN. NOT SCHEDULED.
#
# NO CRONS (2026-10-14), and this one mattered most: it REBUILDS
# data/skopje-pois.db from OSM. The map is a FIXED ARTIFACT — finished and
# deployed by a human, unchanged until that human runs the SerpApi pass. A
# weekly timer that rebuilds it behind everyone's back is exactly the drift the
# no-cron policy exists to stop, so the Sunday line is gone.
#
# ⚠ THIS IS A SECOND MAP PRODUCER. Only ONE machine may build this map. If the
# Lenovo authors it and ships it here (deploy_map.sh), do NOT run this on this
# box — you would overwrite the authored map with a local OSM build. Kept only
# for the case where this machine IS the map author, on purpose, by hand.
#
# Refreshes data/skopje-pois.db: Skopje's NAMED POIs + address rows from OSM
# (Overpass). Atomic build — if the pull fails, the previous map keeps serving.
# Output goes to data/logs/skopje-map.log, rotated at ~2 MB (2 old copies).
#
# Usage:
#   scripts/skopje-map-weekly.sh   # a manual run, when YOU decide
set -u

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$PROJECT_DIR/data/logs"
LOG_FILE="$LOG_DIR/skopje-map.log"
MAX_BYTES=$((2 * 1024 * 1024))

mkdir -p "$LOG_DIR"

# Rotate when over ~2 MB: drop .2, shift .1 -> .2, log -> .1.
if [ -f "$LOG_FILE" ] && [ "$(stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)" -gt "$MAX_BYTES" ]; then
  rm -f "$LOG_FILE.2"
  mv -f "$LOG_FILE.1" "$LOG_FILE.2" 2>/dev/null || true
  mv -f "$LOG_FILE" "$LOG_FILE.1" 2>/dev/null || true
fi

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"; }

log "=== skopje-map weekly pull ==="

cd "$PROJECT_DIR" || { log "ERROR: cannot cd $PROJECT_DIR"; exit 1; }

if ! npm run map:pull >> "$LOG_FILE" 2>&1; then
  log "ERROR: map:pull failed — the PREVIOUS map is still serving (atomic build)."
  exit 1
fi

log "=== done ==="
exit 0
