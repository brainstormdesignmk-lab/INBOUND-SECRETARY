#!/usr/bin/env bash
# verify-feed.sh — READ-ONLY acceptance check of the LIVE public-properties feed.
# Nothing is deployed, nothing is written: it fetches the function Lina reads and
# asserts the payload actually carries what Lina needs.
#
# WHY THIS EXISTS (2026-10-08): LINA answered "КАЈ СЕ НАОЃА 76?" with
# "Тоа се наоѓа во населбата Центар." while the row already held
# lat 41.996 / lon 21.4172, geo_source google_cached and 4 resolved landmarks.
# The feed function had stopped emitting lat/lon/geo_source/geocoded_at and had
# NEVER emitted `landmarks`. A deploy can therefore exit 0 and still publish a
# function that silently degrades every "каде е X?" answer.
#
# It also catches the OTHER silent failure: a deploy into the wrong Supabase
# project. This checkout was `supabase link`ed to METROPOLIS 2 FREEBUFF (empty,
# 0 properties) while Lina reads QKGIO — publishing there is invisible. Comparing
# the served `version` against the source's own DEPLOY_VERSION makes that
# detectable: you get the OLD version back, or 0 rows.
#
# Usage:
#   npm run verify:feed
#   FEED_URL=http://localhost:54321/functions/v1/public-properties?format=json \
#     bash scripts/verify-feed.sh
#
# Exit code: 0 = the live feed is what Lina needs; 1 = it is not.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

FN_SRC="supabase/functions/public-properties/index.ts"
URL="${FEED_URL:-https://qkgioqotxjxffiaufgwd.supabase.co/functions/v1/public-properties?format=json}"

# The expected version is read from the SOURCE, so this check can never go stale
# by hand-editing two places.
EXPECTED="${EXPECTED_FEED_VERSION:-$(sed -n 's/.*DEPLOY_VERSION[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$FN_SRC" | head -1)}"
[ -n "$EXPECTED" ] || { echo "✗ cannot read DEPLOY_VERSION from $FN_SRC"; exit 1; }

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

echo "verify-feed: $URL"
echo "  expecting version $EXPECTED (from $FN_SRC)"

HTTP="$(curl -sS -o "$TMP" -w '%{http_code}' --max-time 25 "$URL")" || {
  echo "  ✗ feed unreachable"; exit 1;
}
if [ "$HTTP" != "200" ]; then
  echo "  ✗ HTTP $HTTP"
  head -c 300 "$TMP"; echo
  exit 1
fi

# JSON parsing via node — no jq dependency (this runs on the hub too).
node - "$TMP" "$EXPECTED" <<'NODE'
const fs = require('fs');
const [file, expected] = process.argv.slice(2);

let body;
try {
  body = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (e) {
  console.log(`  ✗ response is not JSON (${e.message})`);
  process.exit(1);
}

const bad = [];
const props = Array.isArray(body.properties) ? body.properties : [];

const withGeo = props.filter(p => typeof p.lat === 'number' && typeof p.lon === 'number');
const withLandmarks = props.filter(p => p.landmarks != null);
const bySource = {};
for (const p of props) {
  const k = p.geo_source == null ? '(null)' : String(p.geo_source);
  bySource[k] = (bySource[k] ?? 0) + 1;
}

console.log(`  served version   : ${body.version ?? '— (missing)'}`);
console.log(`  properties       : ${props.length}`);
console.log(`  with lat/lon     : ${withGeo.length}`);
console.log(`  with landmarks   : ${withLandmarks.length}`);
console.log(`  geo_source       : ${JSON.stringify(bySource)}`);

if (!body.version) bad.push('payload carries no `version` field');
else if (expected && body.version !== expected) {
  bad.push(`served version ${body.version} != source ${expected} — the deploy did not land HERE (wrong project, or a stale function)`);
}
if (props.length === 0) bad.push('0 properties returned — wrong project, or the feed is down');
if (props.length > 0 && withGeo.length === 0) {
  bad.push('no property carries lat/lon — Lina falls back to the bare neighborhood line');
}
if (props.length > 0 && withLandmarks.length === 0) {
  bad.push('no property carries `landmarks` — LandmarkService layer 0 never fires');
}

if (bad.length) {
  for (const b of bad) console.log(`  ✗ ${b}`);
  process.exit(1);
}
console.log('  ✓ every property carries the geo columns and the landmarks Lina reads');
NODE
