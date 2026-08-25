#!/usr/bin/env bash
# Manual offline-map update — run ONLY when you decide to refresh.
# Nothing in the system updates the map automatically; this script is the
# single supported entry point so the manual fixes can never be forgotten.
#
# Steps:
#   1. rebuild   — fresh OSM data into data/skopje-pois.db
#                  (atomic: a failed pull leaves the old DB untouched)
#   2. overrides — re-apply every manual fix from data/address-overrides.json
#   3. audit     — coverage report over all feed properties
#
# Usage:  bash scripts/update_map.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== [1/3] Rebuilding map from OSM (atomic) ==="
npx tsx scripts/rebuild_map.ts

echo ""
echo "=== [2/3] Re-applying manual overrides ==="
npx tsx scripts/apply_overrides.ts

echo ""
echo "=== [3/3] Auditing feed address coverage ==="
npx tsx scripts/audit_addresses.ts

echo ""
echo "DONE. Remember to copy data/skopje-pois.db to production and restart the TUI."
