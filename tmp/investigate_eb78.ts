import { OfflineMapStore } from '../src/geo/offlineMap.js';
import * as path from 'path';

const dbPath = process.env.SKOPJE_POIS_DB || path.join(process.cwd(), 'data', 'skopje-pois.db');
const map = new OfflineMapStore(dbPath);

// Test the address
const addr = 'Народен Фронт 23';
console.log('=== Geocoding:', addr, '===');
const geo = map.geocodeAddress(addr);
console.log('Result:', JSON.stringify(geo, null, 2));

if (geo) {
  console.log('\nNearest POIs within 500m:');
  const pois = map.nearestPois(geo.lat, geo.lon, 500, 15);
  for (const p of pois) {
    console.log(`  ${p.name} — ${p.distance_m}m — ${p.type}`);
  }
}

// Also try "Народен Фронт" without number
console.log('\n=== Geocoding: Народен Фронт (no number) ===');
const geo2 = map.geocodeAddress('Народен Фронт');
console.log('Result:', JSON.stringify(geo2, null, 2));
if (geo2) {
  console.log('\nNearest POIs:');
  const pois2 = map.nearestPois(geo2.lat, geo2.lon, 500, 15);
  for (const p of pois2) {
    console.log(`  ${p.name} — ${p.distance_m}m — ${p.type}`);
  }
}

// Check what building numbers exist for this street in the DB
import Database from 'better-sqlite3';
const db = new Database(dbPath, { readonly: true });

console.log('\n=== All addresses matching "народен фронт" ===');
const rows = db.prepare(`
  SELECT street, housenumber, lat, lon, name
  FROM addresses
  WHERE street LIKE '%народен фронт%' OR street LIKE '%naroden front%'
  ORDER BY housenumber
`).all() as any[];
for (const r of rows) {
  console.log(`  '${r.housenumber}' → (${r.lat}, ${r.lon}) ${r.name || ''}`);
}
console.log(`  Total: ${rows.length} entries`);

// Check what Beverly Hills Center is near
console.log('\n=== POI search: Beverly Hills / беверли ===');
const poiRows = db.prepare(`
  SELECT name, lat, lon, type
  FROM pois
  WHERE name LIKE '%еверли%' OR name LIKE '%everly%' OR name LIKE '%Beverly%'
`).all() as any[];
for (const r of poiRows) {
  console.log(`  ${r.name} → (${r.lat}, ${r.lon}) type=${r.type}`);
}

// Real location from user
console.log('\n=== Real location: 41.9934507, 21.41492 ===');
const realPois = map.nearestPois(41.9934507, 21.41492, 800, 15);
for (const p of realPois) {
  console.log(`  ${p.name} — ${p.distance_m}m — ${p.type}`);
}
