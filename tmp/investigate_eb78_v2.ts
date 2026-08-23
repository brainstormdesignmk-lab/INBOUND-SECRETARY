import Database from 'better-sqlite3';
import * as path from 'path';

const dbPath = process.env.SKOPJE_POIS_DB || path.join(process.cwd(), 'data', 'skopje-pois.db');
const db = new Database(dbPath, { readonly: true });

// All addresses matching Народен Фронт
console.log('=== All addresses matching "народен фронт" ===');
const rows = db.prepare(`
  SELECT street, housenumber, lat, lon
  FROM addresses
  WHERE street LIKE '%народен фронт%' OR street LIKE '%naroden front%'
  ORDER BY housenumber
`).all() as any[];
for (const r of rows) {
  console.log(`  '${r.housenumber}' → (${r.lat}, ${r.lon})`);
}
console.log(`  Total: ${rows.length} entries`);

// Beverly Hills POI
console.log('\n=== POI search: Beverly Hills / беверли ===');
const poiRows = db.prepare(`
  SELECT name, lat, lon, type
  FROM pois
  WHERE name LIKE '%еверли%' OR name LIKE '%everly%' OR name LIKE '%Beverly%' OR name LIKE '%Beverli%'
`).all() as any[];
for (const r of poiRows) {
  console.log(`  ${r.name} → (${r.lat}, ${r.lon}) type=${r.type}`);
}
if (poiRows.length === 0) console.log('  (none found)');

// What POIs are near the REAL location (41.9934507, 21.41492)?
console.log('\n=== POIs near real location 41.9934507, 21.41492 (800m radius) ===');
const dLat = 800 / 111320;
const dLon = 800 / (111320 * Math.cos((41.9934507 * Math.PI) / 180));
const realPois = db.prepare(`
  SELECT name, type, lat, lon,
    ((lat - ?) * (lat - ?) + (lon - ?) * (lon - ?) * 0.64) as dist2
  FROM pois
  WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?
  ORDER BY dist2 ASC
  LIMIT 20
`).all(41.9934507, 41.9934507, 21.41492, 21.41492,
       41.9934507 - dLat, 41.9934507 + dLat, 21.41492 - dLon, 21.41492 + dLon) as any[];
for (const r of realPois) {
  const d = Math.sqrt(r.dist2) * 111320;
  console.log(`  ${r.name} — ~${Math.round(d)}m — ${r.type}`);
}

// What the geocoder currently resolves (41.9935603, 21.4188693)
console.log('\n=== POIs near geocoded location 41.9935603, 21.4188693 (wrong!) ===');
const gLat = 41.9935603;
const gLon = 21.4188693;
const dLat2 = 800 / 111320;
const dLon2 = 800 / (111320 * Math.cos((gLat * Math.PI) / 180));
const wrongPois = db.prepare(`
  SELECT name, type, lat, lon FROM pois
  WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?
  ORDER BY ((lat - ?) * (lat - ?) + (lon - ?) * (lon - ?) * 0.64) ASC
  LIMIT 10
`).all(gLat - dLat2, gLat + dLat2, gLon - dLon2, gLon + dLon2, gLat, gLat, gLon, gLon) as any[];
for (const r of wrongPois) {
  const d = Math.sqrt((r.lat-gLat)**2 + (r.lon-gLon)**2 * 0.64) * 111320;
  console.log(`  ${r.name} — ~${Math.round(d)}m — ${r.type}`);
}
