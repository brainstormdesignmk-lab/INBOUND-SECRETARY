import { LandmarkService, LandmarkStore, landmarkCacheKey } from '../src/geo/landmarks.ts';
import { OfflineMapStore } from '../src/geo/offlineMap.ts';
import { tableLandmark } from '../src/geo/landmarkTable.ts';
import { extractDetailsLandmark } from '../src/geo/landmarks.ts';
import { Db } from '../src/store/db.ts';
import path from 'path';

async function main() {
  const db = new Db(path.join(process.cwd(), 'data', 'lina.db'));
  const offlineMap = new OfflineMapStore(
    process.env.SKOPJE_POIS_DB || path.join(process.cwd(), 'data', 'skopje-pois.db')
  );

  const p = { eb: 89, address: 'Бул. АСНОМ Бр.134', location: 'Аеродром',
    details: 'Станот е стар и се е функционално. Во него се живееше до пред 2 месеци.. Одлична локација со убав поглед од балконите кон Мерцедес и авиончето. Многу простор пред зградата. Чист имотен лист..58м2 + 12м2 балкони +4м2 подиум..',
    landmarks: undefined };

  console.log('=== Step-by-step resolve for EB 89 ===\n');

  // 1) Feed layer
  console.log('1) Feed landmarks:', p.landmarks ?? 'UNDEFINED → SKIPPED');

  // 2) DB cache
  const key = landmarkCacheKey(p);
  console.log(`2) DB cache key: "${key}"`);
  const store = new LandmarkStore(db);
  const cached = store.get(key);
  console.log('   Cached:', cached ? JSON.stringify(cached) : 'EMPTY');

  // 3) Google
  console.log('3) Google Maps:', process.env.GOOGLE_MAPS_API_KEY ? 'KEY PRESENT' : 'NO KEY → SKIPPED');

  // 4) Details extraction
  const dl = extractDetailsLandmark(p.details);
  console.log('4) Details extraction:', dl ?? 'NO MATCH');

  // 5) Offline map
  console.log('5) Offline map:');
  const geo = offlineMap.geocodeAddress(p.address);
  if (geo) {
    console.log(`   Geocode: ${geo.lat.toFixed(6)}, ${geo.lon.toFixed(6)} ("${geo.street}")`);
    const pois = offlineMap.nearestPois(geo.lat, geo.lon, 1500, 5);
    for (const poi of pois) {
      console.log(`     ${poi.distance_m}m  ${poi.name}  (${poi.type})`);
    }
  } else {
    console.log('   Geocode FAILED');
  }

  // 6) Deterministic table
  const tLandmark = tableLandmark(89, 'Аеродром');
  console.log('6) Table landmark:', tLandmark ? JSON.stringify(tLandmark) : 'NONE');

  // Full resolve
  console.log('\n=== Full resolve (with DB cache) ===');
  const svc = new LandmarkService(db, { offlineMap, osm: false });
  const result = await svc.resolve(p);
  console.log('Result:', JSON.stringify(result));

  // Clear DB cache and re-resolve
  console.log('\n=== Full resolve AFTER clearing DB cache ===');
  try { db.db.prepare('DELETE FROM landmarks WHERE address_key = ?').run(key); } catch {}
  const svc2 = new LandmarkService(db, { offlineMap, osm: false });
  const result2 = await svc2.resolve({ ...p });
  console.log('Result:', JSON.stringify(result2));
  const cached2 = store.get(key);
  console.log('New cache:', cached2 ? JSON.stringify(cached2) : 'EMPTY');
}

main().catch(console.error);
