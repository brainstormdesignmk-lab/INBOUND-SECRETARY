import { LandmarkService, LandmarkStore, landmarkCacheKey } from '../src/geo/landmarks.ts';
import { OfflineMapStore } from '../src/geo/offlineMap.ts';
import { tableLandmark } from '../src/geo/landmarkTable.ts';
import { extractDetailsLandmark } from '../src/geo/landmarks.ts';
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
  const offlineMap = new OfflineMapStore(
    process.env.SKOPJE_POIS_DB || path.join(process.cwd(), 'data', 'skopje-pois.db')
  );
  const store = new LandmarkStore(db);

  for (const eb of [89, 90]) {
    const prop = all.find(p => p.eb === eb);
    if (!prop) { console.log(`EB ${eb} not found in feed`); continue; }

    console.log(`\n${'='.repeat(70)}`);
    console.log(`  EB ${eb}`);
    console.log(`${'='.repeat(70)}`);
    console.log(`address:   ${prop.address}`);
    console.log(`location:  ${prop.location}`);
    console.log(`landmarks: ${JSON.stringify(prop.landmarks)}`);
    console.log(`details:   ${prop.details?.substring(0, 200)}`);
    console.log(`landmark (current on prop): ${prop.landmark ?? 'undefined'}`);

    // Clear cache for fresh resolution
    const key = landmarkCacheKey({ address: prop.address, location: prop.location });
    console.log(`\ncache key: "${key}"`);
    try { db.db.prepare('DELETE FROM landmarks WHERE address_key = ?').run(key); } catch {}
    console.log('  -> cache CLEARED');

    // Feed layer
    console.log(`\n[Layer 0] Feed landmarks: ${prop.landmarks ? JSON.stringify(prop.landmarks) : 'UNDEFINED → SKIP'}`);

    // DB cache (should be empty now)
    const cached = store.get(key);
    console.log(`[Layer 2] DB cache: ${cached ? JSON.stringify(cached) : 'EMPTY → SKIP'}`);

    // Google
    console.log(`[Layer 3] Google Maps: ${cfg.googleMapsApiKey ? 'KEY PRESENT' : 'NO KEY → SKIP'}`);

    // Details extraction
    const dl = extractDetailsLandmark(prop.details);
    console.log(`[Layer 4] Details extract: ${dl ?? 'NO MATCH → SKIP'}`);

    // Offline map
    console.log(`[Layer 5] Offline map:`);
    const geo = offlineMap.geocodeAddress(prop.address);
    if (geo) {
      console.log(`  geocode: ${geo.lat.toFixed(6)}, ${geo.lon.toFixed(6)} ("${geo.street}")`);
      const pois = offlineMap.nearestPois(geo.lat, geo.lon, 2000, 15);
      console.log(`  POIs found (${pois.length} within 2km):`);
      for (let i = 0; i < pois.length; i++) {
        const p = pois[i];
        const score = Math.round(p.distance_m * (1 + (p.type === 'supermarket' ? 15 : p.type === 'park' ? 12 : p.type === 'restaurant' ? 20 : 50) / 10));
        console.log(`    ${String(i+1).padStart(2)}. ${String(p.distance_m).padStart(5)}m  ${p.name.padEnd(40)} (${p.type})  score=${score}`);
      }
    } else {
      console.log(`  geocode: FAILED`);
    }

    // Table layer
    const tl = tableLandmark(eb, prop.location ?? '');
    console.log(`[Layer 7] Table: ${tl ? `${tl.landmark} (${tl.type})` : 'NONE'}`);

    // Full resolve
    console.log(`\n[RESOLVE] Running full resolve...`);
    const svc = new LandmarkService(db, { offlineMap, osm: false });
    const result = await svc.resolve({ eb, address: prop.address, location: prop.location, details: prop.details, landmarks: prop.landmarks });
    console.log(`  RESULT: "${result.landmark}" (source: ${result.source})`);

    // Check what the card would say
    const landmarkLine = result.landmark ? `Се наоѓа во близина на ${result.landmark}.` : '(no landmark)';
    console.log(`  CARD LINE: ${landmarkLine}`);

    // Read debug log for this EB
    console.log(`\n[DEBUG LOG] Entries for EB ${eb}:`);
    try {
      const log = fs.readFileSync('/tmp/landmark-debug.log', 'utf8');
      const lines = log.split('\n').filter(l => l.includes(`EB ${eb}`) || l.includes(`EB ${eb}:`));
      for (const l of lines) console.log(`  ${l}`);
    } catch { console.log('  (no log file)'); }
  }

  // Now diff the two
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  COMPARISON EB 89 vs EB 90`);
  console.log(`${'='.repeat(70)}`);

  for (const eb of [89, 90]) {
    const prop = all.find(p => p.eb === eb);
    if (!prop) continue;
    const geo = offlineMap.geocodeAddress(prop.address);
    const pois = geo ? offlineMap.nearestPois(geo.lat, geo.lon, 2000, 5) : [];
    console.log(`\nEB ${eb}: ${prop.address} (${prop.location})`);
    console.log(`  geocode: ${geo ? `${geo.lat.toFixed(6)}, ${geo.lon.toFixed(6)} (${geo.street})` : 'FAILED'}`);
    console.log(`  top POIs: ${pois.map(p => `${p.name}@${p.distance_m}m(${p.type})`).join(', ')}`);
    console.log(`  feed landmarks: ${JSON.stringify(prop.landmarks)}`);
    console.log(`  details: ${prop.details?.substring(0, 150)}`);
  }
}

main().catch(console.error);
