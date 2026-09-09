import Database from 'better-sqlite3';
import { loadConfig } from './src/config';

const cfg = loadConfig();
const poiPath = cfg.skopjePoisDb;

console.log('POI DB path:', poiPath);

const poiDb = new Database(poiPath);
const tables = poiDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[];
console.log('Tables:', tables.map((t: any) => t.name));

for (const t of tables) {
  const count = poiDb.prepare(`SELECT COUNT(*) as c FROM ${t.name}`).get() as any;
  console.log(`  ${t.name}: ${count.c} rows`);
}
poiDb.close();
