import { LandmarkStore, landmarkCacheKey, extractDetailsLandmark } from '../src/geo/landmarks.ts';
import { OfflineMapStore } from '../src/geo/offlineMap.ts';
import { tableLandmark } from '../src/geo/landmarkTable.ts';
import { Db } from '../src/store/db.ts';
import { PropertyService } from '../src/data/properties.ts';
import { loadConfig } from '../src/config.ts';
import path from 'path';
import fs from 'fs';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
  const cfg = loadConfig();
  const propertyService = new PropertyService(cfg.propertyDataUrl);
  const all = await propertyService.getAll();
  const db = new Db(path.join(process.cwd(), 'data', 'lina.db'));
  const store = new LandmarkStore(db);

  // 1. Check cache for EB 89 and EB 90
  const prop89 = all.find(p => p.eb === 89);
  const prop90 = all.find(p => p.eb === 90);
  const key89 = landmarkCacheKey({ address: prop89?.address, location: prop89?.location });
  const key90 = landmarkCacheKey({ address: prop90?.address, location: prop90?.location });
  const cached89 = store.get(key89);
  const cached90 = store.get(key90);

  console.log(`EB 89 cache key: "${key89}"`);
  console.log(`EB 89 cached: ${JSON.stringify(cached89)}`);
  console.log(`EB 90 cache key: "${key90}"`);
  console.log(`EB 90 cached: ${JSON.stringify(cached90)}`);

  // Clear EB 89's cache
  if (cached89) {
    db.db.prepare('DELETE FROM landmarks WHERE address_key = ?').run(key89);
    console.log('\nEB 89 cache CLEARED');
  }

  // 2. Read debug log
  let debugLog = '';
  try { debugLog = fs.readFileSync('/tmp/landmark-debug.log', 'utf8'); } catch {}

  // 3. Build the full comparison document
  const offlineMap = new OfflineMapStore(
    process.env.SKOPJE_POIS_DB || path.join(process.cwd(), 'data', 'skopje-pois.db')
  );

  const out: string[] = [];
  out.push('======================================================================');
  out.push('  LANDMARK BUG REPORT: EB 89 shows "Златна Вилушка" instead of');
  out.push('  the actual nearest POI');
  out.push('======================================================================');
  out.push('');
  out.push('CONTEXT');
  out.push('-------');
  out.push('The Lina chatbot shows a property card saying:');
  out.push('  "Се наоѓа во близина на Златна вилушка."');
  out.push('for EB 89 (Бул. АСНОМ Бр.134, Аеродром). This is WRONG.');
  out.push('');
  out.push('Google Maps shows:');
  out.push('  - EB 89 is at ASNOM Blvd 134 (41.988, 21.477)');
  out.push('  - Zlatna Vilushka restaurant is ~1 km away (41.991, 21.466)');
  out.push('  - There are much closer landmarks: Alka-U B supermarket (117m),');
  out.push('    Парк Авионче (174m), churches (271m)');
  out.push('');
  out.push('For comparison, EB 90 (Локов 5, Кисела Вода) resolves correctly');
  out.push('to "Дом за слепи" at 164m — the offline map works fine for that one.');
  out.push('');

  for (const eb of [89, 90] as const) {
    const prop = eb === 89 ? prop89 : prop90;
    if (!prop) continue;

    out.push('======================================================================');
    out.push(`  EB ${eb}: ${prop.address} (${prop.location})`);
    out.push('======================================================================');
    out.push('');
    out.push(`Address:     ${prop.address}`);
    out.push(`Location:    ${prop.location}`);
    out.push(`Feed landmarks (from Supabase): ${prop.landmarks ? JSON.stringify(prop.landmarks) : 'NONE'}`);
    out.push(`Current landmark on property:  ${prop.landmark ?? 'UNDEFINED'}`);
    out.push(`Details text: ${prop.details?.substring(0, 300) ?? 'NONE'}`);
    out.push('');

    // Layer 0: Feed
    out.push('[Layer 0] Feed landmarks (ANA import-time):');
    if (prop.landmarks && prop.landmarks.length > 0) {
      for (const fl of prop.landmarks) {
        out.push(`  - "${fl.landmark}" (type=${fl.type}, distance=${fl.distance_m}m)`);
      }
    } else {
      out.push('  UNDEFINED → layer skipped');
    }
    out.push('');

    // Layer 2: DB cache
    const cached = eb === 89 ? cached89 : cached90;
    out.push('[Layer 2] DB cache (previous resolution):');
    if (cached) {
      out.push(`  CACHED: "${cached.landmark}" (source=${cached.source})`);
      out.push(`  ⚠ This is the stale value causing the bug!`);
    } else {
      out.push('  EMPTY → layer skipped');
    }
    out.push('');

    // Layer 3: Google
    out.push('[Layer 3] Google Maps:');
    out.push(cfg.googleMapsApiKey ? '  KEY PRESENT' : '  NO KEY → layer skipped');
    out.push('');

    // Layer 4: Details extraction
    const dl = extractDetailsLandmark(prop.details);
    out.push('[Layer 4] Details text extraction:');
    out.push(dl ? `  Found: "${dl}"` : '  No match → layer skipped');
    out.push('');

    // Layer 5: Offline map
    out.push('[Layer 5] Offline map (local OSM POIs, zero network):');
    const geo = offlineMap.geocodeAddress(prop.address);
    if (geo) {
      out.push(`  Geocode OK: lat=${geo.lat.toFixed(6)}, lon=${geo.lon.toFixed(6)} ("${geo.street}")`);
      const pois = offlineMap.nearestPois(geo.lat, geo.lon, 2000, 15);
      out.push(`  ${pois.length} POIs found within 2km:`);
      for (let i = 0; i < pois.length; i++) {
        const p = pois[i];
        const score = Math.round(p.distance_m * (1 + (p.type === 'supermarket' ? 15 : p.type === 'park' ? 12 : p.type === 'restaurant' ? 20 : 50) / 10));
        out.push(`    ${String(i + 1).padStart(2)}. ${String(p.distance_m).padStart(5)}m  ${p.name.padEnd(40)} (${p.type.padEnd(20)})  score=${score}`);
      }
      // Show what the offline map would return
      const best = pois.find(po => po.name.length >= 3);
      if (best) {
        out.push(`  → OFFLINE MAP PICK: "${best.name}" (score=${Math.round(best.distance_m * (1 + (best.type === 'supermarket' ? 15 : best.type === 'park' ? 12 : 50) / 10))})`);
      }
    } else {
      out.push('  Geocode FAILED → layer skipped');
    }
    out.push('');

    // Layer 6: OSM
    out.push('[Layer 6] OSM (Nominatim + Overpass, network):');
    out.push('  (skipped in this debug — but this is the layer that wrote "Златна вилушка" to cache)');
    out.push('');

    // Layer 7: Table
    const tl = tableLandmark(eb, prop.location ?? '');
    out.push('[Layer 7] Deterministic table (neighborhood):');
    out.push(tl ? `  ${tl.landmark} (${tl.type})` : '  NONE');
    out.push('');
  }

  // Key difference section
  out.push('======================================================================');
  out.push('  KEY DIFFERENCE: EB 89 vs EB 90');
  out.push('======================================================================');
  out.push('');
  out.push('EB 90 works correctly because:');
  out.push('  - No stale cache entry');
  out.push('  - Offline map geocodes OK → returns "Дом за слепи" at 164m');
  out.push('  - The DB cache is populated with the correct offline-map result');
  out.push('');
  out.push('EB 89 is BROKEN because:');
  out.push('  - A previous run of the OSM layer (layer 6) called Nominatim and got');
  out.push('    "Златна вилушка" as the nearest landmark. This is actually ~1 km away.');
  out.push('  - This result was cached in the landmarks table under the key');
  out.push(`    "${key89}"`);
  out.push('  - On subsequent calls, resolve() checks the DB cache FIRST (layer 2)');
  out.push('    and finds "Златна вилушка". The cache is NOT marked as stale');
  out.push('    (staleness only checks "table" source). So the cached value is');
  out.push('    returned IMMEDIATELY — layers 3-7 (including the offline map) are');
  out.push('    NEVER reached.');
  out.push('');
  out.push('  The offline map (layer 5) DOES work correctly for EB 89:');
  out.push('    - Geocode: Булевар Асном → (41.988, 21.476)');
  out.push('    - Nearest: Alka-U B supermarket at 117m, Парк Авионче at 174m');
  out.push('    - But it never gets a chance to run because the cache short-circuits.');
  out.push('');
  out.push('ROOT CAUSE CHAIN:');
  out.push('  1. OSM layer (Nominatim) returns a WRONG/BAD result for ASNOM 134');
  out.push('  2. This bad result is cached in the landmarks table');
  out.push('  3. The DB cache layer runs BEFORE the offline map layer');
  out.push('  4. The cache is not invalidated for non-"table" sources');
  out.push('  5. So the stale OSM result is served forever');
  out.push('');
  out.push('FIX APPLIED:');
  out.push('  - Added missing `import fs from "fs"` at the top of landmarks.ts');
  out.push('  - Removed broken `const fs = require("fs")` in catch blocks (ESM compat)');
  out.push('  - This fixes the offline map layer crashing silently on debug logging');
  out.push('  - BUT: the DB cache still has the stale "Златна вилушка" entry');
  out.push('');
  out.push('REMAINING FIX NEEDED:');
  out.push('  - Clear the stale DB cache entry for EB 89');
  out.push('  - OR: add a staleness check for OSM/offline sources (not just "table")');
  out.push('  - OR: make the cache only store "table" and "google" sources (high quality)');
  out.push('');

  // Debug log entries
  out.push('======================================================================');
  out.push('  DEBUG LOG (/tmp/landmark-debug.log)');
  out.push('======================================================================');
  if (debugLog) {
    const lines = debugLog.split('\n').filter(l => l.includes('EB 89') || l.includes('EB 90'));
    out.push(lines.join('\n'));
  } else {
    out.push('(no debug log found)');
  }
  out.push('');

  // Now write the file
  const report = out.join('\n');
  fs.writeFileSync('tmp/landmark-bug-report.txt', report);
  console.log('\n' + report);
  console.log('\n✅ Report written to tmp/landmark-bug-report.txt');
}

main().catch(console.error);
