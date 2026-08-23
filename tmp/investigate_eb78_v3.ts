import Database from 'better-sqlite3';
import * as path from 'path';

const dbPath = process.env.SKOPJE_POIS_DB || path.join(process.cwd(), 'data', 'skopje-pois.db');
const db = new Database(dbPath, { readonly: true });

// Import streetKey
// We need to check what key the geocoder produces
// Let's look at all unique keys in addresses table
console.log('=== Keys containing "народ" or "front" ===');
const rows = db.prepare(`
  SELECT DISTINCT key, lat, lon, housenumber
  FROM addresses
  WHERE key LIKE '%народ%' OR key LIKE '%front%' OR key LIKE '%народен%'
  ORDER BY housenumber
`).all() as any[];
for (const r of rows) {
  console.log(`  key='${r.key}' num='${r.housenumber}' → (${r.lat}, ${r.lon})`);
}
console.log(`  Total: ${rows.length} unique keys`);

// Check what the FULL geocode query returns when key = streetKey('Народен Фронт')
// The key is likely just "народен фронт" or stripped
console.log('\n=== Trying various key patterns ===');
for (const pattern of ['народен фронт', 'народен', 'front', 'народенфронт']) {
  const cnt = db.prepare(`SELECT COUNT(*) as c FROM addresses WHERE key = ?`).get(pattern) as any;
  console.log(`  key='${pattern}': ${cnt.c} rows`);
  const like = db.prepare(`SELECT COUNT(*) as c FROM addresses WHERE key LIKE ?`).get(`%${pattern}%`) as any;
  console.log(`  LIKE '%${pattern}%': ${like.c} rows`);
}

// The geocoder returned a location but 0 addresses match - where did it come from?
// Let me check if there are entries with slightly different encoding
console.log('\n=== Checking key column encoding ===');
const allKeys = db.prepare(`SELECT DISTINCT key FROM addresses ORDER BY key`).all() as any[];
const narodni = allKeys.filter((r: any) => r.key.includes('народ') || r.key.includes('Народ'));
console.log(`Keys with 'народ':`, narodni.map((r: any) => r.key));

// Maybe it matched via ББ on a different street? Let me check what's at 41.9935603
console.log('\n=== Addresses near 41.9935603, 21.4188693 ===');
const nearAddrs = db.prepare(`
  SELECT street, key, housenumber, lat, lon
  FROM addresses
  WHERE lat BETWEEN 41.992 AND 41.995 AND lon BETWEEN 21.417 AND 21.420
  ORDER BY ABS(lat - 41.9935603) + ABS(lon - 21.4188693) * 2
  LIMIT 10
`).all() as any[];
for (const r of nearAddrs) {
  console.log(`  key='${r.key}' street='${r.street}' num='${r.housenumber}' → (${r.lat}, ${r.lon})`);
}

// Check the DB schema
console.log('\n=== addresses table schema ===');
const schema = db.prepare(`PRAGMA table_info(addresses)`).all() as any[];
for (const s of schema) {
  console.log(`  ${s.name} (${s.type})`);
}
