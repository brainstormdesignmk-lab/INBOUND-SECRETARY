import Database from 'better-sqlite3';
import * as path from 'path';

// Check what the property feed data looks like for EB76, 78
const feedDb = new Database(path.resolve('data/lina.db'), { readonly: true });

// Look at properties table
const cols = feedDb.prepare("PRAGMA table_info(properties)").all();
console.log('Properties columns:', cols.map((c: any) => c.name).join(', '));

// Check EB76 and EB78
for (const eb of [76, 78, 79, 69]) {
  const row = feedDb.prepare('SELECT * FROM properties WHERE evidenten_broj = ?').get(eb) as any;
  if (!row) { console.log(`\nEB ${eb}: NOT FOUND`); continue; }
  console.log(`\n=== EB ${eb} ===`);
  console.log('  address:', row.adresa);
  console.log('  location:', row.naselba);
  console.log('  gmaps:', row.gmaps);
  console.log('  lat:', row.lat);
  console.log('  lon:', row.lon);
  console.log('  all columns with values:');
  for (const [k, v] of Object.entries(row)) {
    if (v !== null && v !== '' && v !== undefined) {
      console.log(`    ${k}: ${String(v).substring(0, 100)}`);
    }
  }
}

feedDb.close();
