import { LandmarkService, LandmarkStore, landmarkCacheKey } from '../src/geo/landmarks.ts';
import { OfflineMapStore } from '../src/geo/offlineMap.ts';
import { Db } from '../src/store/db.ts';
import path from 'path';
import fs from 'fs';

async function main() {
  const db = new Db(path.join(process.cwd(), 'data', 'lina.db'));
  const offlineMap = new OfflineMapStore(
    process.env.SKOPJE_POIS_DB || path.join(process.cwd(), 'data', 'skopje-pois.db')
  );
  console.log('offline map available:', offlineMap.available);

  // Clear any cached landmark for EB 89
  const key = 'аеродром | бул. асном бр.134';
  try { db.db.prepare('DELETE FROM landmarks WHERE address_key = ?').run(key); } catch {}
  // Also clear debug log
  try { fs.unlinkSync('/tmp/landmark-debug.log'); } catch {}

  // Resolve
  const p = { eb: 89, address: 'Бул. АСНОМ Бр.134', location: 'Аеродром',
    details: 'Станот е стар и се е функционално.',
    landmarks: undefined };
  const svc = new LandmarkService(db, { offlineMap, osm: false });

  console.log('\nResolving...');
  const result = await svc.resolve(p);
  console.log('Result:', JSON.stringify(result));

  // Check debug log
  console.log('\n=== Debug log ===');
  try {
    const log = fs.readFileSync('/tmp/landmark-debug.log', 'utf8');
    const lines = log.split('\n').filter(l => l.includes('89'));
    for (const l of lines) console.log(l);
  } catch { console.log('No debug log'); }

  // Now try manually with the offline map module directly
  console.log('\n=== Manual offline map test ===');
  const geo = offlineMap.geocodeAddress('Бул. АСНОМ Бр.134');
  console.log('geocode:', geo?.lat, geo?.lon, geo?.street);
  if (geo) {
    const pois = offlineMap.nearestPois(geo.lat, geo.lon, 1500, 5);
    for (const poi of pois) {
      console.log(`  ${poi.distance_m}m  "${poi.name}"  (${poi.type})`);
    }
  }
  // Check findPoiByName with the address
  const poiByName = offlineMap.findPoiByName('Бул. АСНОМ Бр.134');
  console.log('findPoiByName("Бул. АСНОМ Бр.134"):', poiByName ?? 'null');
}

main().catch(console.error);
