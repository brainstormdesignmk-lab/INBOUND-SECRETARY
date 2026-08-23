import { LandmarkService } from '../src/geo/landmarks.js';
import { OfflineMapStore } from '../src/geo/offlineMap.js';
import { Db } from '../src/store/db.js';
import * as path from 'path';

// Simulate the exact TUI setup
const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'data', 'lina.db');
const skopjeDb = process.env.SKOPJE_POIS_DB || path.join(process.cwd(), 'data', 'skopje-pois.db');

const db = new Db(dbPath);
const offlineMap = new OfflineMapStore(skopjeDb);

console.log('DB path:', dbPath);
console.log('Offline map:', skopjeDb);
console.log('Offline available:', offlineMap.available);
if (offlineMap.available) {
  const s = offlineMap.stats();
  console.log('Stats:', s);
}

const svc = new LandmarkService(db, {
  offlineMap,
  // NO osm: false — matching TUI config (osm defaults to true)
});

// Clear cache
db.db.prepare('DELETE FROM landmarks').run();

// Resolve EB 89 with the EXACT address from the feed
const result = svc.resolve({
  eb: 89,
  address: 'Бул. АСНОМ Бр.134',
  location: 'Аеродром',
});
console.log('\nResolve result:', JSON.stringify(result));

// Also test: what does the offline map directly return?
const geo = offlineMap.geocodeAddress('Бул. АСНОМ Бр.134');
console.log('Geocode:', geo);
if (geo) {
  const pois = offlineMap.nearestPois(geo.lat, geo.lon, 1500, 5);
  console.log('Direct nearestPois:', pois.map(p => p.name + '(' + p.distance_m + 'm)'));
}

// Test enrich (which the TUI calls)
async function testEnrich() {
  const prop = { eb: 89, address: 'Бул. АСНОМ Бр.134', location: 'Аеродром' };
  await svc.enrich([prop]);
  console.log('\nAfter enrich, landmark:', prop.landmark);
}
testEnrich().catch(console.error);
