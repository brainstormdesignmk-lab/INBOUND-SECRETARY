import { LandmarkService, extractDetailsLandmark } from '../src/geo/landmarks.js';
import { OfflineMapStore, streetKey } from '../src/geo/offlineMap.js';
import { Db } from '../src/store/db.js';
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
  const offlineMap = new OfflineMapStore(
    process.env.SKOPJE_POIS_DB || path.join(process.cwd(), 'data', 'skopje-pois.db')
  );
  const db = new Db(path.join(process.cwd(), 'data', 'lina.db'));
  const svc = new LandmarkService(db, { offlineMap, osm: false });

  // Try various address formats
  const addresses = [
    'Бул. Асном бр.134',
    'Бул. Асном 134',
    'Bulevard ASNOM 134',
    'Булевар Асном 134',
    'Асном 134',
    'Бул. Асном',
  ];

  for (const addr of addresses) {
    console.log(`\n=== Address: "${addr}" ===`);
    console.log(`  streetKey: "${streetKey(addr)}"`);
    const geo = offlineMap.geocodeAddress(addr);
    if (geo) {
      console.log(`  geocode: ${geo.lat.toFixed(6)}, ${geo.lon.toFixed(6)}`);
      const pois = offlineMap.nearestPois(geo.lat, geo.lon, 500, 3);
      console.log(`  nearest: ${pois.map(p => `${p.name}(${p.distance_m}m)`).join(', ')}`);
    } else {
      console.log(`  geocode: FAILED`);
    }
  }

  // Now test resolve with different addresses
  console.log('\n=== Full resolve for each address ===');
  for (const addr of addresses) {
    // Clear cache first to force fresh resolution
    try {
      const key = `аеродром | ${addr.toLowerCase().replace(/\s+/g, ' ')}`;
      db.db.prepare('DELETE FROM landmarks WHERE address_key = ?').run(key);
    } catch {}

    const result = await svc.resolve({
      eb: 89,
      address: addr,
      location: 'Аеродром',
    });
    console.log(`  "${addr}" → ${result.landmark} (source: ${result.source})`);
  }

  // Check what details landmark would extract
  const details = 'Стан се продава комплетно наместен, Златна Вилушка nearby';
  const dl = extractDetailsLandmark(details);
  console.log('\nDetails extract from test text:', dl);
}

main().catch(console.error);
