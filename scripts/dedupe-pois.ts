/**
 * One-time dedupe migration for skopje-pois.db.
 *
 * Strategy: For each (name, ROUND(lat, 4), ROUND(lon, 4)) group, keep only
 * ONE row — preferring place_id-bearing (Google) rows over OSM-only ones.
 *
 * 4 decimal places ≈ 11m precision — close enough to be the same physical
 * place, far enough to distinguish adjacent buildings on a block.
 *
 * Usage:
 *   npx tsx scripts/dedupe-pois.ts [db-path]
 */
import Database from 'better-sqlite3';
import fs from 'fs';

const dbPath = process.argv[2] ?? 'data/skopje-pois.db';

if (!fs.existsSync(dbPath)) {
  console.error(`DB not found: ${dbPath}`);
  process.exit(1);
}

// Back up first
const backupPath = `${dbPath}.pre-dedupe-${Date.now()}`;
fs.copyFileSync(dbPath, backupPath);
console.log(`Backup: ${backupPath}`);

const db = new Database(dbPath);

// Report before
const total = (db.prepare('SELECT COUNT(*) as c FROM pois').get() as any).c;
const googleWithPid = (db.prepare('SELECT COUNT(*) as c FROM pois WHERE place_id IS NOT NULL').get() as any).c;
console.log(`Before: ${total} total rows, ${googleWithPid} with place_id`);

// Schema inspection (tolerate missing columns)
const cols = db.prepare('PRAGMA table_info(pois)').all() as Array<{ name: string }>;
const hasClosed = cols.some(c => c.name === 'closed');
const hasReviews = cols.some(c => c.name === 'review_count');

// Build ORDER BY for ROW_NUMBER(): place_id-bearing rows rank first (lowest)
// place_id IS NULL: FALSE(0) sorts before TRUE(1) in ASC, so non-null wins
const orderByParts = ['place_id IS NULL ASC'];
if (hasClosed) orderByParts.push('closed ASC');
if (hasReviews) orderByParts.push('COALESCE(review_count, 0) DESC');
const orderByClause = orderByParts.join(', ');

console.log(`Deduping with priority: ${orderByClause}`);
console.log('');

// Single DELETE: identify rowids to keep (ROW_NUMBER() = 1) per group,
// delete all others
db.exec('BEGIN IMMEDIATE');

const result = db.prepare(`
  DELETE FROM pois
  WHERE rowid IN (
    SELECT rowid FROM (
      SELECT rowid,
        ROW_NUMBER() OVER (
          PARTITION BY name, ROUND(lat, 4), ROUND(lon, 4)
          ORDER BY ${orderByClause}
        ) as rn
      FROM pois
    ) ranked WHERE rn > 1
  )
`).run();

const deleted = result.changes;
console.log(`Deleted ${deleted} duplicate rows`);

// Count actual duplicate groups eliminated
const groupsFixed = (db.prepare(`
  SELECT COUNT(*) as c FROM (
    SELECT name, ROUND(lat, 4), ROUND(lon, 4)
    FROM pois
    GROUP BY name, ROUND(lat, 4), ROUND(lon, 4)
    HAVING COUNT(*) > 1
  )
`).get() as any).c;
console.log(`Remaining duplicate groups: ${groupsFixed}`);

db.exec('COMMIT');

// Report after
const afterTotal = (db.prepare('SELECT COUNT(*) as c FROM pois').get() as any).c;
const afterGoogleWithPid = (db.prepare('SELECT COUNT(*) as c FROM pois WHERE place_id IS NOT NULL').get() as any).c;

console.log('');
console.log('=== RESULTS ===');
console.log(`Before: ${total} rows (${googleWithPid} with place_id)`);
console.log(`After:  ${afterTotal} rows (${afterGoogleWithPid} with place_id)`);
console.log(`Net reduction: ${total - afterTotal} rows`);
console.log('');

// Show some formerly-duplicated landmarks now deduped
const samples = db.prepare(`
  SELECT name, COUNT(*) as cnt, SUM(place_id IS NOT NULL) as with_pid
  FROM pois
  GROUP BY name
  HAVING cnt > 1
  ORDER BY cnt DESC
  LIMIT 10
`).all() as Array<{ name: string; cnt: number; with_pid: number }>;

console.log('Landmarks still with >1 row (different locations):');
samples.forEach(r => {
  console.log(`  "${r.name}" — ${r.cnt} locations (${r.with_pid} with place_id)`);
});

db.close();
console.log('');
console.log(`Done. Backup at: ${backupPath}`);
