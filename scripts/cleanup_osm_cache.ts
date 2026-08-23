import { Db } from '../src/store/db.ts';
import path from 'path';

const db = new Db(path.join(process.cwd(), 'data', 'lina.db'));

// Count OSM entries before
const before = db.db.prepare("SELECT COUNT(*) as c FROM landmarks WHERE source = 'osm'").get() as { c: number };
console.log(`OSM cache entries before cleanup: ${before.c}`);

// Show them
const rows = db.db.prepare("SELECT address_key, landmark, source FROM landmarks WHERE source = 'osm'").all();
for (const r of rows) console.log(`  ${JSON.stringify(r)}`);

// Delete all OSM-sourced entries
const result = db.db.prepare("DELETE FROM landmarks WHERE source = 'osm'").run();
console.log(`\nDeleted ${result.changes} OSM cache entries`);

// Show remaining
const after = db.db.prepare("SELECT COUNT(*) as c FROM landmarks").get() as { c: number };
console.log(`Remaining cache entries: ${after.c}`);
const remaining = db.db.prepare("SELECT address_key, landmark, source FROM landmarks").all();
for (const r of remaining) console.log(`  ${JSON.stringify(r)}`);
