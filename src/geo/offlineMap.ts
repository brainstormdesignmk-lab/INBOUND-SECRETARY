// OfflineMapStore — the local OSM engine for the Hermes machine (T60 plan).
//
// The resolver used to hit live Nominatim + Overpass per property (rate limits,
// 429s, uptime). Instead we download Skopje's NAMED POIs + address rows ONCE
// (and refresh weekly, Sunday 03:17) into a small SQLite DB:
//   data/skopje-pois.db   (~3-8 MB — a few tens of thousands of rows)
//
//   - nearestPois(lat, lon)   — bbox prefilter + haversine, ms-fast, the
//                               100m…1000m rings are just the distances.
//   - geocodeAddress(street)  — local address→coordinates (Latin↔Cyrillic
//                               street matching); live Nominatim only as fallback.
//
// The DB is opened READ-ONLY by consumers; the weekly build writes a temp file
// and atomically renames it, so a failed pull never leaves a half-written map.
// No map file yet → `available` is false and callers fall back to live APIs.

import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import * as path from 'path';
import { renameSync, rmSync, statSync } from 'fs';

/** Skopje metro bbox (south, west, north, east) — Центар, Карпош, Аеродром,
 *  Кисела Вода, Влае, Ѓорче Петров, Чаир, Бутел, Гази Баба. */
export const SKOPJE_BBOX: [number, number, number, number] = [41.95, 21.25, 42.10, 21.55];

/** Public Overpass mirrors — the build tries them in order (they are flaky —
 *  that is exactly why we go offline). */
const OVERPASS_MIRRORS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

export interface LocalPoi {
  name: string;
  type: string;
  distance_m: number;
  lat?: number;
  lon?: number;
}

export interface GeocodeHit {
  lat: number;
  lon: number;
  street: string;
}

export interface MapStats {
  pois: number;
  addresses: number;
  bytes: number;
}

// --- Latin ↔ Cyrillic street matching ----------------------------------------
// Feed addresses are Cyrillic ("ул. Борис Трајковски"), OSM addr:street can be
// Latin ("Boris Trajkovski") or Cyrillic. Match on a canonical LATIN key.

const CYR2LAT: Array<[string, string]> = [
  ['ѓ', 'gj'], ['ќ', 'kj'], ['љ', 'lj'], ['њ', 'nj'], ['ѕ', 'dz'], ['џ', 'dz'],
  ['а', 'a'], ['б', 'b'], ['в', 'v'], ['г', 'g'], ['д', 'd'], ['е', 'e'],
  ['ж', 'z'], ['з', 'z'], ['и', 'i'], ['ј', 'j'], ['к', 'k'], ['л', 'l'],
  ['м', 'm'], ['н', 'n'], ['о', 'o'], ['п', 'p'], ['р', 'r'], ['с', 's'],
  ['т', 't'], ['у', 'u'], ['ф', 'f'], ['х', 'h'], ['ц', 'c'], ['ч', 'c'],
  ['ш', 's'],
];

// Longest-match first: lj/nj/dz before single letters.
const LAT2CYR: Array<[string, string]> = [
  ['dzh', 'џ'], ['lj', 'љ'], ['nj', 'њ'], ['gj', 'ѓ'], ['kj', 'ќ'], ['dz', 'ѕ'],
  ['a', 'а'], ['b', 'б'], ['v', 'в'], ['g', 'г'], ['d', 'д'], ['e', 'е'],
  ['z', 'з'], ['i', 'и'], ['j', 'ј'], ['k', 'к'], ['l', 'л'], ['m', 'м'],
  ['n', 'н'], ['o', 'о'], ['p', 'п'], ['r', 'р'], ['s', 'с'], ['t', 'т'],
  ['u', 'у'], ['f', 'ф'], ['h', 'х'], ['c', 'ц'], ['y', 'ј'], ['zh', 'ж'],
  ['ch', 'ч'], ['sh', 'ш'],
];

export function toLatin(s: string): string {
  let out = '';
  for (const ch of s.toLowerCase()) {
    const hit = CYR2LAT.find(([k]) => k === ch);
    out += hit ? hit[1] : ch;
  }
  return out;
}

export function toCyrillic(s: string): string {
  const low = s.toLowerCase();
  let out = '';
  let i = 0;
  while (i < low.length) {
    const two = LAT2CYR.find(([k]) => k === low.slice(i, i + 2));
    if (two) { out += two[1]; i += 2; continue; }
    const one = LAT2CYR.find(([k]) => k === low[i]);
    out += one ? one[1] : low[i];
    i += 1;
  }
  return out;
}

/** Canonical key for a street: strip the ул./бул./street prefixes and the house
 *  number, collapse spaces, fold to Latin lowercase. "ул. Борис Трајковски 12"
 *  and "Boris Trajkovski" both → "boris trajkovski".
 *
 *  Handles: Бул. АСНОМ Бр.134 → asnom, Јане Сандански 25 - 17 → jane sandanski,
 *  Кузман Јосифовски Питу 19/5 → kuzman josifovski pitu, Рузвелтова 51 2-10
 *  → ruzveltova, Тоне Томшиќ Бр.25 → tone tomsikj. */
export function normalizeStreet(s: string): string {
  return s.toLowerCase()
    // Street-type prefixes
    .replace(/^(?:ул\.?|улица|бул\.?|булевар|пат|street|st\.?|boulevard|blvd|ave\.?|avenue)\s+/i, '')
    // "Бр." / "Бр" (Број = number) prefix before house number
    // Note: \b doesn't work with Cyrillic in Node 18, so match after space/start
    .replace(/(?:^|\s)бр\.?\s*/i, ' ')
    // Trailing house number: ranges (25 - 17, 86 - 1, 51 2-10, 26-2),
    // slash fractions (19/5), compound numbers (51 2-10), and simple numbers.
    // Strategy: strip everything from the FIRST trailing number pattern onward,
    // but only if it's preceded by a space (so street names with numbers like
    // "11 Октомври" aren't touched).
    .replace(/\s+\d+(?:[\s.\-/]*(?:\d+|[а-яa-z]+))*\s*$/i, '')
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function streetKey(s: string): string {
  return toLatin(normalizeStreet(s));
}

/** Distance in meters (haversine). */
function meters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// --- The read store -----------------------------------------------------------

/** POI type priority for landmark selection. Lower = better landmark.
 *  Institutional places (hospitals, schools, government) are universally
 *  recognized navigation anchors. Shops and cafes are only useful when
 *  very close. People say "кај болницата", never "кај фурната". */
const POI_PRIORITY: Record<string, number> = {
  // place types — squares are the BEST Skopje landmarks
  square: 0, plaza: 0,
  // neighbourhood/locality/suburb are geographic LABELS, not landmarks.
  // 'во близина на Центар' is meaningless when you ARE in Центар.
  neighbourhood: 40, locality: 40, suburb: 40,
  // institutional
  hospital: 1, clinic: 1, healthcare: 1,
  school: 2, university: 2, college: 2,
  government: 3, townhall: 3, embassy: 3, diplomatic: 3, political_party: 3,
  stadium: 4, sports_centre: 4, swimming_pool: 4,
  place_of_worship: 5, church: 5, mosque: 5, synagogue: 5,
  museum: 6, gallery: 6, theatre: 6, cinema: 6, library: 6,
  hotel: 7, motel: 7, hostel: 7,
  mall: 8, shopping_mall: 8, department_store: 8,
  bank: 9, atm: 9, bureau_de_change: 9,
  pharmacy: 10, chemist: 10,
  police: 11, fire_station: 11, ambulance_station: 11,
  park: 12, garden: 12, playground: 12, nature_reserve: 12,
  supermarket: 15, convenience: 15,
  restaurant: 20, cafe: 20, fast_food: 20, bar: 20, pub: 20,
  bakery: 25, clothes: 25, jewelry: 25, books: 25,
  fuel: 30, parking: 30,
  parking_landmark: 7, // named garages ("Катна гаража Беко") — hotel-level landmark
};

/** Named parking garages ("Катна гаража Беко") are Skopje landmarks — boost
 *  them from parking (30) to hotel level (7). Generic "Parking" stays at 30. */
function boostNamedLandmark(type: string, name: string): string {
  if (type === 'parking' && /каража|гараж|garage/i.test(name)) return 'parking_landmark';
  return type;
}

export class OfflineMapStore {
  private db: Database.Database | null = null;

  constructor(dbPath: string) {
    try {
      this.db = new Database(dbPath, { readonly: true });
      // Validate the schema — an empty/foreign file must not masquerade as a map.
      this.db.prepare('SELECT COUNT(*) FROM pois').get();
    } catch {
      if (this.db) { try { this.db.close(); } catch { /* ignore */ } }
      this.db = null; // no map built yet — callers fall back to live APIs
    }
  }

  get available(): boolean {
    return this.db !== null;
  }

  close(): void {
    if (this.db) { this.db.close(); this.db = null; }
  }

  stats(): MapStats | null {
    if (!this.db) return null;
    const pois = (this.db.prepare('SELECT COUNT(*) as c FROM pois').get() as { c: number }).c;
    const addresses = (this.db.prepare('SELECT COUNT(*) as c FROM addresses').get() as { c: number }).c;
    return { pois, addresses, bytes: 0 };
  }

  /** The named POIs within radiusM of a point, nearest first. */
  nearestPois(lat: number, lon: number, radiusM = 2000, limit = 10): LocalPoi[] {
    if (!this.db) return [];
    const dLat = radiusM / 111320;
    const dLon = radiusM / (111320 * Math.cos((lat * Math.PI) / 180));
    const rows = this.db.prepare(
      `SELECT name, type, lat, lon FROM pois WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?`
    ).all(lat - dLat, lat + dLat, lon - dLon, lon + dLon) as Array<{ name: string; type: string; lat: number; lon: number }>;
    const out: LocalPoi[] = [];
    for (const r of rows) {
      const d = meters({ lat, lon }, { lat: r.lat, lon: r.lon });
      if (d <= radiusM) out.push({ name: r.name, type: boostNamedLandmark(r.type, r.name), distance_m: Math.round(d), lat: r.lat, lon: r.lon });
    }
    // SCORE-BASED ranking: blends distance and type recognizability.
    // A government building at 82m (score 107) beats a hospital at 216m (score 238)
    // — because 'кај Министерството' is a real Skopje navigation phrase.
    // score = distance_m * (1 + priority/10). Lower = better landmark.
    // Cap: max 3 results per type to prevent flooding.
    out.sort((a, b) => {
      const sa = a.distance_m * (1 + (POI_PRIORITY[a.type] ?? 50) / 10);
      const sb = b.distance_m * (1 + (POI_PRIORITY[b.type] ?? 50) / 10);
      return sa - sb;
    });
    // Cap per-type: no more than 3 of any single type so diverse landmarks surface
    const MAX_PER_TYPE = 3;
    const typeCounts = new Map<string, number>();
    const capped: LocalPoi[] = [];
    for (const p of out) {
      const count = typeCounts.get(p.type) ?? 0;
      if (count >= MAX_PER_TYPE) continue;
      typeCounts.set(p.type, count + 1);
      capped.push(p);
    }
    return capped.slice(0, limit);
  }

  /** Local address → coordinates. When the address includes a house number
   *  ("Јане Сандански 25"), we prefer the EXACT building at that number so
   *  the POI radius is centred on the right spot (not the whole boulevard).
   *  Falls back to any building on the street when the number isn't in the DB. */
  geocodeAddress(street: string): GeocodeHit | undefined {
    if (!this.db || !street) return undefined;
    const key = streetKey(street);
    if (!key) return undefined;
    // Extract the house number from the original address: the first number
    // after the street name ("Јане Сандански 25 - 17" → "25", "Бр.134" → "134").
    const numMatch = street.match(/\b(\d+[а-яa-z]?)\b/i);
    const houseNum = numMatch ? numMatch[1] : '';
    // Try exact house number first, then fall back to any building on the street.
    if (houseNum) {
      const exact = this.db.prepare(
        `SELECT street, lat, lon FROM addresses WHERE key = ? AND housenumber = ?
         OR (key = ? AND housenumber = ? COLLATE NOCASE) LIMIT 1`
      ).get(key, houseNum, key, houseNum) as { street: string; lat: number; lon: number } | undefined;
      if (exact) return { lat: exact.lat, lon: exact.lon, street: exact.street };
    }
    const row = this.db.prepare(
      `SELECT street, lat, lon FROM addresses WHERE key = ?
       ORDER BY CASE WHEN housenumber != '' THEN 0 ELSE 1 END LIMIT 1`
    ).get(key) as { street: string; lat: number; lon: number } | undefined;
    if (!row) return undefined;
    return { lat: row.lat, lon: row.lon, street: row.street };
  }

  /** Search POIs by name — for landmark-style addresses like "Кај Бранка"
   *  or "Палома Бјанка" where the address IS the landmark, not a street.
   *  Returns the best match (exact > starts-with > contains). */
  findPoiByName(name: string): { lat: number; lon: number; name: string } | undefined {
    if (!this.db || !name) return undefined;
    const clean = name.replace(/^(?:кај|спроти|кај штипски|кај скопски)\s+/i, '').trim();
    if (!clean || clean.length < 2) return undefined;
    // Try exact match first, then starts-with, then contains
    const patterns = [
      { q: clean, sql: 'SELECT name, type, lat, lon FROM pois WHERE name = ? COLLATE NOCASE LIMIT 1' },
      { q: clean + '%', sql: 'SELECT name, type, lat, lon FROM pois WHERE name LIKE ? COLLATE NOCASE LIMIT 1' },
      { q: '%' + clean + '%', sql: 'SELECT name, type, lat, lon FROM pois WHERE name LIKE ? COLLATE NOCASE LIMIT 1' },
    ];
    for (const { q, sql } of patterns) {
      const row = this.db.prepare(sql).get(q) as { name: string; type: string; lat: number; lon: number } | undefined;
      if (row) return { lat: row.lat, lon: row.lon, name: row.name };
    }
    return undefined;
  }
}

// --- The build (pull + rebuild) ------------------------------------------------

interface RawElem {
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

function coordsOf(e: RawElem): { lat: number; lon: number } | undefined {
  const lat = e.lat ?? e.center?.lat;
  const lon = e.lon ?? e.center?.lon;
  if (lat === undefined || lon === undefined) return undefined;
  return { lat: Number(lat), lon: Number(lon) };
}

async function overpass(data: string): Promise<{ elements: RawElem[] }> {
  let lastErr: Error | undefined;
  const MAX_RETRIES = 2;
  for (const mirror of OVERPASS_MIRRORS) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 120_000);
        try {
          const res = await fetch(mirror, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'metropolis-hermes/1.0' },
            body: `data=${encodeURIComponent(data)}`,
            signal: ctrl.signal,
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const j = await res.json() as { remarks?: string; elements?: RawElem[] };
          if (j.remarks && /error/i.test(j.remarks)) throw new Error(j.remarks);
          return { elements: j.elements ?? [] };
        } finally {
          clearTimeout(timer);
        }
      } catch (e) {
        lastErr = e as Error;
        if (attempt < MAX_RETRIES) {
          const delay = attempt * 15_000; // 15s, 30s backoff
          console.warn(`[skopje-map] mirror ${mirror} attempt ${attempt} failed: ${lastErr.message} — retrying in ${delay / 1000}s`);
          await new Promise(r => setTimeout(r, delay));
        } else {
          console.warn(`[skopje-map] mirror ${mirror} failed (${MAX_RETRIES}x): ${lastErr.message}`);
        }
      }
    }
  }
  throw lastErr ?? new Error('all Overpass mirrors failed');
}

/** The metro bbox split into 2×2 tiles — each Overpass request stays light, so
 *  the pull survives the public servers' load spikes (they 504 on big scans). */
function tiles(): Array<[number, number, number, number]> {
  const [s, w, n, e] = SKOPJE_BBOX;
  const midLat = (s + n) / 2;
  const midLon = (w + e) / 2;
  return [
    [s, w, midLat, midLon],
    [s, midLon, midLat, e],
    [midLat, w, n, midLon],
    [midLat, midLon, n, e],
  ];
}

/** Named POIs (amenity/shop/leisure/tourism/office/healthcare/historic/building) in the Skopje bbox. */
async function fetchPois(): Promise<Array<{ name: string; type: string; lat: number; lon: number }>> {
  const out: Array<{ name: string; type: string; lat: number; lon: number }> = [];
  const seen = new Set<string>();
  for (const bbox of tiles()) {
    // Comprehensive query: pulls ALL named POIs that could be landmarks.
    // place = squares, neighborhoods, localities (Плоштад ВМРО, etc.)
    const q = `[out:json][timeout:90];(
      nwr["name"]["amenity"](${bbox.join(',')});
      nwr["name"]["shop"](${bbox.join(',')});
      nwr["name"]["leisure"](${bbox.join(',')});
      nwr["name"]["tourism"](${bbox.join(',')});
      nwr["name"]["office"](${bbox.join(',')});
      nwr["name"]["healthcare"](${bbox.join(',')});
      nwr["name"]["historic"](${bbox.join(',')});
      nwr["name"]["building"]["building"!="yes"](${bbox.join(',')});
      nwr["name"]["man_made"](${bbox.join(',')});
      nwr["name"]["place"](${bbox.join(',')});
    );out center tags;`;
    const { elements } = await overpass(q);
    for (const e of elements) {
      const name = (e.tags?.name ?? '').trim();
      const c = coordsOf(e);
      if (!name || !c) continue;
      const type = e.tags?.amenity ?? e.tags?.shop ?? e.tags?.leisure ?? e.tags?.tourism ?? e.tags?.office ?? e.tags?.healthcare ?? e.tags?.historic ?? e.tags?.building ?? e.tags?.man_made ?? e.tags?.place ?? 'other';
      const k = `${name}|${c.lat.toFixed(5)}|${c.lon.toFixed(5)}`;
      if (seen.has(k)) continue; // tile borders can double-return a POI
      seen.add(k);
      out.push({ name, type, lat: c.lat, lon: c.lon });
    }
    console.log(`[skopje-map] POI tile ${bbox.join(',')} → ${elements.length} raw elements`);
  }
  return out;
}

/** Address rows (addr:street) — the local geocoding layer. */
async function fetchAddresses(): Promise<Array<{ street: string; housenumber: string; lat: number; lon: number }>> {
  const out: Array<{ street: string; housenumber: string; lat: number; lon: number }> = [];
  const seen = new Set<string>();
  for (const bbox of tiles()) {
    const q = `[out:json][timeout:60];nwr["addr:street"](${bbox.join(',')});out center tags;`;
    const { elements } = await overpass(q);
    for (const e of elements) {
      const street = (e.tags?.['addr:street'] ?? '').trim();
      const c = coordsOf(e);
      if (!street || !c) continue;
      const k = `${street.toLowerCase()}|${c.lat.toFixed(5)}|${c.lon.toFixed(5)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ street, housenumber: (e.tags?.['addr:housenumber'] ?? '').trim(), lat: c.lat, lon: c.lon });
    }
    console.log(`[skopje-map] address tile ${bbox.join(',')} → ${elements.length} raw elements`);
  }
  return out;
}

/** Write the map tables from given data (atomic: temp file + rename). Exported
 *  so tests can build a map without the network; the CLI uses it via
 *  buildSkopjeDb (which fetches first). */
export function writeMap(
  dbPath: string,
  pois: Array<{ name: string; type: string; lat: number; lon: number }>,
  addresses: Array<{ street: string; housenumber: string; lat: number; lon: number }>,
): MapStats {
  mkdirSync(path.dirname(dbPath), { recursive: true });

  const tmp = `${dbPath}.tmp`;

  // Clean up ALL stale files from a previous crashed run — including the
  // journal, WAL, and SHM files that SQLite leaves behind.  The old code
  // only rmSync'd the .tmp itself, leaving the -journal/-wal/-shm which
  // made the next run hang on WAL recovery.
  for (const suffix of ['', '-journal', '-wal', '-shm', '.journal', '.wal', '.shm']) {
    rmSync(tmp + suffix, { force: true });
  }

  console.log(`[skopje-map] writing ${pois.length} POIs + ${addresses.length} addresses to ${tmp}...`);
  const db = new Database(tmp);
  try {
    // DELETE journal + synchronous OFF for max write speed during the build.
    // We don't need crash safety — the build is idempotent and atomic (rename).
    db.pragma('journal_mode = DELETE');
    db.pragma('synchronous = OFF');

    db.exec(`
      CREATE TABLE pois (
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        lat  REAL NOT NULL,
        lon  REAL NOT NULL
      );
      CREATE INDEX idx_pois_lat ON pois(lat);
      CREATE TABLE addresses (
        street      TEXT NOT NULL,
        housenumber TEXT NOT NULL DEFAULT '',
        lat         REAL NOT NULL,
        lon         REAL NOT NULL,
        key         TEXT NOT NULL
      );
      CREATE INDEX idx_addr_key ON addresses(key);
    `);

    // Wrap ALL inserts in a single transaction — 10-100x faster than
    // auto-commit per row.
    const insertAll = db.transaction(() => {
      const insPoi = db.prepare('INSERT INTO pois (name, type, lat, lon) VALUES (?, ?, ?, ?)');
      for (const p of pois) insPoi.run(p.name, p.type, p.lat, p.lon);
      console.log(`[skopje-map] inserted ${pois.length} POIs`);

      const insAddr = db.prepare('INSERT INTO addresses (street, housenumber, lat, lon, key) VALUES (?, ?, ?, ?, ?)');
      for (const a of addresses) insAddr.run(a.street, a.housenumber, a.lat, a.lon, streetKey(a.street));
      console.log(`[skopje-map] inserted ${addresses.length} addresses`);
    });
    insertAll();

    db.close();
  } catch (e) {
    try { db.close(); } catch { /* ignore */ }
    rmSync(tmp, { force: true });
    throw e;
  }

  renameSync(tmp, dbPath);
  return { pois: pois.length, addresses: addresses.length, bytes: statSync(dbPath).size };
}

/** Pull + rebuild the map. Writes a temp file and renames atomically, so a
 *  failed pull never leaves a half-written map for the resolver. */
export async function buildSkopjeDb(dbPath: string): Promise<MapStats> {
  const [pois, addresses] = await Promise.all([fetchPois(), fetchAddresses()]);
  return writeMap(dbPath, pois, addresses);
}
