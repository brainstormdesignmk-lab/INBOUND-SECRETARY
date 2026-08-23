import { LandmarkStore, landmarkCacheKey } from '../src/geo/landmarks.ts';
import { Db } from '../src/store/db.ts';
import path from 'path';
const db = new Db(path.join(process.cwd(), 'data', 'lina.db'));

// List ALL landmarks rows
const rows = db.db.prepare('SELECT address_key, landmark, source FROM landmarks ORDER BY address_key').all();
console.log('Total landmarks cache entries:', rows.length);
console.log('');

// Show any entry with vilushka/viljuska
const vilushka = rows.filter((r: any) => /вилушк|viljusk|vilushk/i.test(r.landmark));
console.log('Entries containing вилушк:', vilushka.length);
for (const r of vilushka) console.log(JSON.stringify(r));

// Also show any entry with ASNOM
const asnom = rows.filter((r: any) => /асном|asnom/i.test(r.address_key));
console.log('\nEntries with ASNOM address:', asnom.length);
for (const r of asnom) console.log(JSON.stringify(r));

// Show all entries
console.log('\n--- ALL CACHE ENTRIES ---');
for (const r of rows) console.log(JSON.stringify(r));
