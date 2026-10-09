/**
 * Fix D: Cross-language embassy merge.
 *
 * OSM embassies with Cyrillic names ("Британска амбасада") sometimes sit
 * 100-500m from their verified Google counterpart ("British Embassy Skopje")
 * with a place_id. This script finds those pairs and copies the place_id
 * onto the OSM row so it resolves to a ?cid= card instead of a raw ?q= pin.
 *
 * Uses the EMBASSY_COUNTRY_EN dictionary pattern from offlineMap.ts to
 * match country-adjective variants across languages.
 *
 * Usage:
 *   npx tsx scripts/embassy-merge.ts [db-path]
 */
import Database from 'better-sqlite3';
import fs from 'fs';

const dbPath = process.argv[2] ?? 'data/skopje-pois.db';

if (!fs.existsSync(dbPath)) {
  console.error(`DB not found: ${dbPath}`);
  process.exit(1);
}

const backupPath = `${dbPath}.pre-embassy-merge-${Date.now()}`;
fs.copyFileSync(dbPath, backupPath);
console.log(`Backup: ${backupPath}`);

const db = new Database(dbPath);

// EMBASSY_COUNTRY_EN — same dict as offlineMap.ts
const EMBASSY_COUNTRY_EN: Record<string, string> = {
  'црногорск': 'Montenegro',
  'бугарск': 'Bulgaria',
  'српск': 'Serbia',
  'грчк': 'Greece',
  'албанск': 'Albania',
  'турск': 'Turkey',
  'германск': 'Germany',
  'француск': 'France',
  'италијанск': 'Italy',
  'американск': 'United States',
  'холандск': 'Netherlands',
  'британск': 'United Kingdom',
  'австриск': 'Austria',
  'швајцарск': 'Switzerland',
  'шведск': 'Sweden',
  'руск': 'Russia',
  'словачк': 'Slovakia',
  'украинск': 'Ukraine',
  'шпанск': 'Spain',
  'кинеск': 'China',
  'јапонск': 'Japan',
  'польск': 'Poland',
  'чешк': 'Czechia',
  'словенечк': 'Slovenia',
  'хорватск': 'Croatia',
  'руманск': 'Romania',
};

// Find OSM embassy rows WITHOUT place_id, and their nearby Google embassy matches
const pairs = db.prepare(`
  SELECT 
    osm.rowid as osm_rowid,
    osm.name as osm_name,
    osm.lat as osm_lat,
    osm.lon as osm_lon,
    google.rowid as google_rowid,
    google.name as google_name,
    google.lat as google_lat,
    google.lon as google_lon,
    google.place_id,    -- Distance in meters (approximate)
    SQRT(POWER((osm.lat - google.lat) * 111139, 2) +
         POWER((osm.lon - google.lon) * 77145, 2)) as dist_m
  FROM pois osm
  JOIN pois google ON google.place_id IS NOT NULL
    AND google.type IN ('embassy', 'diplomatic', 'government')
  WHERE osm.source = 'osm' 
    AND osm.place_id IS NULL
    AND osm.name LIKE '%амбасада%'
    AND (
      -- Match country name in both directions
      (${Object.entries(EMBASSY_COUNTRY_EN).map(([cyr, en]) => 
        `LOWER(osm.name) LIKE '%${cyr}%' AND LOWER(google.name) LIKE '%${en.toLowerCase()}%'`
      ).join(' OR ')})
      OR
      -- Direct name match patterns
      LOWER(osm.name) LIKE '%' || REPLACE(REPLACE(LOWER(google.name), 'embassy of ', ''), 'skopje', '') || '%'
      OR LOWER(google.name) LIKE '%' || REPLACE(LOWER(osm.name), 'амбасада ', '') || '%'
    )
    AND ABS(osm.lat - google.lat) < 0.005  -- ~500m
    AND ABS(osm.lon - google.lon) < 0.005  -- ~500m
  ORDER BY dist_m ASC
`).all() as Array<{
  osm_rowid: number;
  osm_name: string;
  google_rowid: number;
  google_name: string;
  place_id: string;
  dist_m: number;
}>;

console.log(`Found ${pairs.length} cross-language embassy pairs to merge:\n`);

let merged = 0;
const seenOsmRows = new Set<number>();

db.exec('BEGIN IMMEDIATE');

for (const p of pairs) {
  // One OSM row gets one place_id (closest Google match)
  if (seenOsmRows.has(p.osm_rowid)) continue;
  seenOsmRows.add(p.osm_rowid);

  if (p.dist_m > 500) {
    console.log(`  SKIP: "${p.osm_name}" (${p.dist_m.toFixed(0)}m from "${p.google_name}") — too far`);
    continue;
  }

  // Check if the OSM row would survive nearestPois deduplication
  // The dedupe in nearestPois merges rows within 30m by name — if both survive,
  // the query-time merge needs the place_id on the right row.
  console.log(`  MERGE: "${p.osm_name}" (${p.dist_m.toFixed(0)}m) ← "${p.google_name}"`);
  
  db.prepare('UPDATE pois SET place_id = ?, place_url = (SELECT place_url FROM pois WHERE rowid = ?) WHERE rowid = ?')
    .run(p.place_id, p.google_rowid, p.osm_rowid);
  merged++;
}

db.exec('COMMIT');
console.log(`\nMerged ${merged} place_ids onto OSM embassy rows`);

// Report
const osmEmbassiesWithPid = (db.prepare(`
  SELECT COUNT(*) as c FROM pois 
  WHERE source = 'osm' AND name LIKE '%амбасада%' AND place_id IS NOT NULL
`).get() as any).c;

console.log(`OSM embassy rows with place_id: ${osmEmbassiesWithPid}`);

db.close();
console.log(`\nDone. Backup at: ${backupPath}`);
