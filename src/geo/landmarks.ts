// LandmarkService — resolves the APPROXIMATE public location of a property.
//
// The exact street address is a trade secret of the funnel: a client who knows
// the street goes straight to the owner and cuts the agency out (the owner
// agrees — nobody likes paying agencies when they can bypass them). So Lina
// answers "каде се наоѓа?" with a nearby PUBLIC LANDMARK, like a human agent
// would: "во близина на Градежен Факултет". The exact location (Google Maps
// link with the real address) is revealed ONLY in the visit protocol, 2 hours
// before the visit, when the visit is already arranged.
//
// Resolution layers, quality-first (each hit is cached in the `landmarks`
// table so live APIs are called at most ONCE per address ever):
//   1. feed landmarks      — ANA's import-time ranked list (Supabase).
//   2. DB cache            — previous resolution (any source).
//   3. Google Maps         — Geocoding + Places Nearby Search (professional
//      quality, the primary layer when a key is available).
//   4. details extraction  — parse "спроти X", "кај X", "близина на X" from
//      the property's own description text. Zero cost, always available.
//   5. offline map         — local OSM POIs, zero network (Skopje only).
//   6. OSM                 — Nominatim + Overpass (free fallback).
//   7. deterministic table — per-neighborhood Skopje landmarks (last resort).
//   8. Hermes event        — async LLM resolver (phase 2).
// If everything fails → { source: 'none' } and the caller falls back to the
// neighborhood alone — the street is never revealed.

import fs from 'fs';
import { Db } from '../store/db';
import { tableLandmark } from './landmarkTable';
import { FeedLandmark } from '../data/properties';
import { OfflineMapStore } from './offlineMap';

export interface Landmark {
  landmark: string;
  type: string;
  mapsUrl?: string;
  source: 'feed' | 'table' | 'google' | 'osm' | 'hermes' | 'none';
}

export interface LandmarkOpts {
  /** street address (used ONLY for the live geocoders, never shown) */
  address?: string;
  location?: string;
  /** Google Places API key, or '' to skip the Google layer */
  googleKey?: string;
  /** false = skip Google Maps layer (use offline map instead) */
  googleEnabled?: boolean;
  /** Enable the free OSM layer (Nominatim + Overpass). ON by default for
   *  production; tests turn it off so the suite never hits the network. */
  osm?: boolean;
  /** false = skip live OSM layer (Nominatim + Overpass) */
  osmEnabled?: boolean;
  /** Local OSM map (named POIs + addresses) — the zero-network landmark
   *  layer for Skopje. Geocodes the address locally, finds the nearest
   *  named POI, returns it as the landmark. Falls through when the map
   *  is unavailable or the address can't be geocoded. */
  offlineMap?: OfflineMapStore;
  /** called when no layer produced a landmark — the Hermes contract */
  onHermesRequest?: (opts: { address?: string; location?: string }) => void;
}

const TIMEOUT_MS = 8000;
const GEO_MAX_RETRIES = 3;

/** Sleep helper. */
function geoSleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<any> {
  for (let attempt = 0; attempt <= GEO_MAX_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers, signal: ctrl.signal });
      if (res.status === 429 && attempt < GEO_MAX_RETRIES) {
        const retryAfter = Number(res.headers.get('Retry-After'));
        const delay = (Number.isFinite(retryAfter) && retryAfter > 0)
          ? retryAfter * 1000
          : 2000 * Math.pow(2, attempt);
        console.log(`    ⏳ geocode 429 — retrying in ${Math.round(delay / 1000)}s (${GEO_MAX_RETRIES - attempt} left)`);
        await geoSleep(delay);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('geocode: max retries exceeded');
}

/** Distance in meters (haversine) between two lat/lon points. */
function meters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// --- Photon layer (Komoot) --------------------------------------------------
// Free, fast, no key, no rate limits. Better than Nominatim for forward
// geocoding (address → coordinates). Used to center the offline map POI search.
const PHOTON_URL = 'https://photon.komoot.io/api/';

async function photonGeocode(address: string, location: string): Promise<{ lat: number; lon: number; street: string } | undefined> {
  const q = [address, location, 'Skopje'].filter(Boolean).join(' ');
  try {
    const data = await fetchJson(
      `${PHOTON_URL}?q=${encodeURIComponent(q)}&limit=1&osm_tag=building`
    );
    const f = data?.features?.[0];
    if (!f?.geometry?.coordinates) return undefined;
    const street = f.properties?.street ?? f.properties?.name ?? '';
    return { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], street };
  } catch {
    return undefined;
  }
}

// --- Google layer -----------------------------------------------------------
/** Google Maps link for a query (real address or landmark name) — the ONLY
 *  link format that may ever reach a customer: "everyone uses Google Maps".
 *  The visit protocol's exact-address link and every landmark layer build
 *  through this, so an OSM/other URL can never leak into a message or cache. */
export function googleMapsLink(query: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

// Priority POI types: well-known public places that people use for navigation.
// Ranked by how recognizable they are as landmarks (hospital > school > mall > etc).
const GOOGLE_POI_TYPES = 'hospital|school|university|shopping_mall|stadium|pharmacy|bank|tourist_attraction|church|mosque|museum|library|fire_station|police|city_hall';

async function googleLandmark(
  address: string | undefined,
  location: string | undefined,
  key: string,
  eb?: number,
): Promise<Landmark | undefined> {
  const q = [address, location, 'Скопје'].filter(Boolean).join(', ');
  const geo = await fetchJson(
    `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&key=${encodeURIComponent(key)}`
  );
  const gres = geo?.results?.[0];
  if (!gres?.geometry?.location) return undefined;
  const { lat, lng } = gres.geometry.location;
  // 1500m radius — wide enough to find a recognizable landmark, narrow enough
  // to be relevant ("во близина на" implies walking distance).
  const nearby = await fetchJson(
    `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=1500&type=${GOOGLE_POI_TYPES}&key=${encodeURIComponent(key)}`
  );
  const results: Array<{ name: string; type: string; dist: number }> = (nearby?.results ?? [])
    .filter((r: any) => r.name && r.name.length >= 3)
    .map((r: any) => {
      const dlat = ((r.geometry?.location?.lat ?? lat) - lat) * 111320;
      const dlng = ((r.geometry?.location?.lng ?? lng) - lng) * 111320 * Math.cos((lat * Math.PI) / 180);
      return { name: r.name as string, type: (r.types?.[0] ?? 'place') as string, dist: Math.sqrt(dlat ** 2 + dlng ** 2) };
    })
    .sort((a: { dist: number }, b: { dist: number }) => a.dist - b.dist);
  if (results.length === 0) return undefined;
  // Rotate among the top 3 by EB hash (like the feed layer) so two
  // properties on the same street don't get the same landmark.
  const top = results.slice(0, 3);
  const pick = eb !== undefined ? top[Math.abs(eb * 2654435761) % top.length] : top[0];
  return {
    landmark: pick.name,
    type: pick.type,
    mapsUrl: googleMapsLink(pick.name),
    source: 'google',
  };
}

// --- OSM layer (Nominatim + Overpass) ---------------------------------------
const OSM_AMENITIES = 'school|university|hospital|clinic|mall|hotel|theatre|cinema|stadium|library';

/** Geocode an address via OSM Nominatim (free, no key) — shared by the nearby
 *  lookup and the Hermes resolver (which hands the coordinates to the LLM). */
export async function geocodeOsm(address: string | undefined, location: string | undefined): Promise<{ lat: number; lon: number } | undefined> {
  const q = [address, location, 'Скопје'].filter(Boolean).join(', ');
  const geo = await fetchJson(
    `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`,
    { 'User-Agent': 'metropolis-lina-bot/1.0', 'Accept-Language': 'mk' }
  );
  const g = geo?.[0];
  if (!g || g.lat === undefined || g.lon === undefined) return undefined;
  return { lat: Number(g.lat), lon: Number(g.lon) };
}

async function osmLandmark(address: string | undefined, location: string | undefined): Promise<Landmark | undefined> {
  const g = await geocodeOsm(address, location);
  if (!g) return undefined;
  const { lat, lon } = g;
  // Nearest amenity POI within 800m — names come out in the local script.
  const overpass = await fetchJson(
    `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(
      `[out:json][timeout:8];(node["amenity"~"^(${OSM_AMENITIES})$"](around:800,${lat},${lon});way["amenity"~"^(${OSM_AMENITIES})$"](around:800,${lat},${lon}););out center tags;`
    )}`
  );
  const elems: Array<{ lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }> =
    overpass?.elements ?? [];
  if (!elems.length) return undefined;
  let best: (typeof elems)[0] | undefined;
  let bestDist = Infinity;
  for (const e of elems) {
    const p = { lat: e.lat ?? e.center?.lat ?? NaN, lon: e.lon ?? e.center?.lon ?? NaN };
    if (!Number.isFinite(p.lat)) continue;
    const name = e.tags?.name;
    if (!name) continue; // unnamed POIs are useless landmarks
    const d = meters({ lat, lon }, p);
    if (d < bestDist) { bestDist = d; best = e; }
  }
  if (!best?.tags?.name) return undefined;
  return {
    landmark: best.tags.name,
    type: best.tags.amenity ?? 'place',
    // OSM is the DATA source, never the customer link — always Google Maps.
    mapsUrl: googleMapsLink(best.tags.name),
    source: 'osm',
  };
}

// --- DB cache ---------------------------------------------------------------
export class LandmarkStore {
  constructor(private db: Db) {}

  get(addressKey: string): { landmark: string; type: string; mapsUrl: string | null; source: string } | undefined {
    return this.db.db.prepare(
      `SELECT landmark, type, maps_url as mapsUrl, source FROM landmarks WHERE address_key = ?`
    ).get(addressKey) as any;
  }

  put(addressKey: string, l: { landmark: string; type: string; mapsUrl?: string; source: string }): void {
    this.db.db.prepare(
      `INSERT OR REPLACE INTO landmarks (address_key, landmark, type, maps_url, source, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(addressKey, l.landmark, l.type, l.mapsUrl ?? null, l.source, Date.now());
  }

  getNearby(addressKey: string): Array<{ landmark: string; lat: number; lon: number }> | undefined {
    const row = this.db.db.prepare(
      `SELECT nearby FROM landmarks WHERE address_key = ? AND nearby IS NOT NULL`
    ).get(addressKey) as { nearby: string } | undefined;
    if (!row) return undefined;
    try { return JSON.parse(row.nearby); } catch { return undefined; }
  }

  putNearby(addressKey: string, nearby: Array<{ landmark: string; lat: number; lon: number }>): void {
    if (nearby.length === 0) return;
    // UPDATE only — the row must already exist from put(); never create a
    // row with only nearby (no landmark) to avoid partial entries.
    this.db.db.prepare(
      `UPDATE landmarks SET nearby = ? WHERE address_key = ?`
    ).run(JSON.stringify(nearby), addressKey);
  }
}

/** Canonical cache key — a property is identified by location + street, so a
 *  price update or EB change never needs a new lookup. */
export function landmarkCacheKey(p: { address?: string; location?: string }): string {
  return `${p.location ?? ''} | ${p.address ?? ''}`.toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Extract a landmark name from the property's description text. Real estate
 * listings almost always mention nearby landmarks: "спроти ОУ Димитар
 * Миладинов", "кај ТЦ Олимпико", "близина на Црногорска Амбасада",
 * "до Клинички центар". This layer is FREE (no geocoding, no network),
 * always available, and gives the MOST ACCURATE landmark because it comes
 * from the person who created the listing.
 *
 * Returns the first valid match ( спроти > кај > близина > до ), cleaned
 * and length-guarded. Undefined when the details have no landmark phrase.
 */
const LANDMARK_DETAIL_RE = /(?:спроти|спротив|кај|близина\s+на|близу\s+на|до|на\s+\d+\s*(?:м|метри|метар|meter|m)\s+од)\s+(.{3,50}?)(?:\.|,\s|\s+и\s|\s+се\s|\s+во\s|\s+на\s|\s+е\s|\s+има\s|$)/iu;

export function extractDetailsLandmark(details: string | undefined): string | undefined {
  if (!details || details.length < 10) return undefined;
  const m = details.match(LANDMARK_DETAIL_RE);
  if (!m) return undefined;
  let name = m[1].trim();
  // Strip trailing junk: quotes, parens, trailing prepositions
  name = name.replace(/[{}`\[\]()"„‟«»'']+$/g, '').trim();
  // Remove leading articles: "на" etc.
  name = name.replace(/^на\s+/i, '').trim();
  if (name.length < 3 || name.length > 60) return undefined;
  // Reject time expressions: "пред 2 месеци", "до јануари", etc.
  if (/пред\s+\d|\bмесец|\bден|\bгодин|\bнедел|januar|februar|mart|april|maj|juni|juli|avgust|septembar|oktombar|noembar|deke(mbar|c)/iu.test(name)) return undefined;
  return name;
}

/**
 * Clean + guard an LLM-provided landmark name. The whole point of the address
 * privacy rule is that the STREET never leaks — so any answer containing the
 * street name (case/space-insensitive) is rejected. Also strips markdown,
 * quotes, numbering ("1. Кафе бар") and keeps only a short clean name.
 */
// A landmark must be a PUBLIC PLACE — a street name (улица/булевар/ул./бул.)
// would hand the client the exact location, defeating the whole privacy
// protocol. Applied to EVERY layer (table included) as a hard guard.
// Unicode boundaries are required: bare "ул" / "пат" match inside words
// ("фаКУЛтет", "ПАТека") unless bounded on both sides.
const STREET_NAME_RE = /(?<![А-Яа-яA-Za-z])(?:улиц(?:а|и|ата|ите)|булевар(?:от|и)?|бул\.?|ул\.?|пат(?:от|и)?|street|boulevard)(?![А-Яа-яA-Za-z])/i;
const isStreetName = (s: string): boolean => STREET_NAME_RE.test(s);
// Time expressions that are NOT landmarks: "пред 2 месеци", "до јануари", etc.
const IS_TIME_EXPR = /пред\s+\d|\bмесец|\bден|\bгодин|\bнедел|\bjanuar|\bfebruar|\bmart|\bapril|\bmaj|\bjuni|\bjuli|\bavgust|\bseptembar|\boktombar|\bnoembar|\bdeke(mbar|c)/iu;

/** Drop a landmark that is actually a street or time expression — every layer is checked. */
function publicPlace(l: Landmark | undefined): Landmark | undefined {
  if (!l) return undefined;
  if (isStreetName(l.landmark)) return undefined;
  if (IS_TIME_EXPR.test(l.landmark)) return undefined;
  return l;
}

export function sanitizeLandmarkAnswer(raw: string, street?: string): string | undefined {
  let s = raw.trim().split(/\n/)[0].trim(); // the LLM's first line only
  s = s
    .replace(/^\d+[.)]\s*/, '')        // "1. Кафе бар" / "2) …"
    .replace(/^[„“”«»"'`\[\]()\-*_]+/, '') // leading decoration
    .replace(/[„“”«»"'`\[\]()\-*_]+$/, '') // trailing decoration
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length < 2 || s.length > 80) return undefined;
  // The exact street must never appear in the landmark.
  if (street) {
    const norm = (x: string) => x.toLowerCase().replace(/\s+/g, ' ');
    const st = norm(street);
    if (st.length >= 3 && norm(s).includes(st)) return undefined;
  }
  // Junk guard: must contain at least one letter.
  if (!/[\p{L}]/u.test(s)) return undefined;
  return s;
}

export class LandmarkService {
  private store: LandmarkStore;

  constructor(private db: Db, private opts: LandmarkOpts = {}) {
    this.store = new LandmarkStore(db);
  }

  /** Resolve the approximate location for a property. Cached in the DB after
   *  the first successful layer — later calls cost nothing. */
  async resolve(p: { eb: number; address?: string; location?: string; details?: string; landmarks?: FeedLandmark[] }): Promise<Landmark> {
    // 0) FEED layer
    if (p.landmarks && p.landmarks.length > 0) {
      const ranked = p.landmarks
        .map(l => ({ l, hit: publicPlace({ landmark: l.landmark, type: l.type ?? 'place', mapsUrl: l.maps_url, source: 'feed' as const }) }))
        .filter((x): x is { l: FeedLandmark; hit: Landmark } => !!x.hit)
        .sort((a, b) => {
          // Prefer malls first ("Беверли Хилс" / "ТЦ Бисер" / "Рамстор"),
          // then by distance. People navigate by malls, not by kiosks.
          const aMall = a.l.type === 'mall' || a.l.type === 'shopping_mall' ? 0 : 1;
          const bMall = b.l.type === 'mall' || b.l.type === 'shopping_mall' ? 0 : 1;
          if (aMall !== bMall) return aMall - bMall;
          return (a.l.distance_m ?? Infinity) - (b.l.distance_m ?? Infinity);
        });
      if (ranked.length > 0) {
        const top = ranked.slice(0, 3);
        const _r = top[Math.abs(p.eb * 2654435761) % top.length].hit; fs.appendFileSync('/tmp/landmark-debug.log',
        `[${new Date().toISOString()}] EB ${p.eb}: RETURN-FEED ${_r.landmark} [${_r.source}]\n`); return _r;
      }
    }

    const key = landmarkCacheKey(p);

    // 2) DB cache — previous resolution. High-quality sources (feed,
    //    google, offline, details, table) are served immediately. OSM-sourced
    //    entries are SUSPECT: Nominatim returns unreliable landmarks for some
    //    addresses (e.g. 'Златна вилушка' at ~1km for ASNOM 134). When the
    //    offline map is available, skip the OSM cache and let it re-resolve —
    //    the offline map has 3,796 local POIs and is far more accurate.
    const cached = this.store.get(key);
    const HIGH_QUALITY = new Set(['feed', 'google', 'offline', 'details']);
    if (cached) {
      const stale = cached.source === 'table' && p.location
        ? (() => {
            const t = tableLandmark(p.eb, p.location);
            return !t || t.landmark !== cached.landmark;
          })()
        : false;
      // OSM cache is suspect: skip if offline map can re-resolve
      // TABLE cache is also suspect: neighborhood-level hash-picked landmarks
      // (e.g. 'Хотел Парк' for EB 69) are coarse — re-resolve when a
      // higher-quality layer (offline map, Google) is available.
      const betterAvailable = this.opts.offlineMap?.available || !!this.opts.googleKey;
      const suspect = cached.source === 'osm' && betterAvailable
        || cached.source === 'table' && betterAvailable;
      const hit = (stale || suspect) ? undefined : publicPlace({
        landmark: cached.landmark, type: cached.type,
        mapsUrl: cached.mapsUrl ?? undefined,
        source: cached.source as Landmark['source'],
      });
      if (hit) { fs.appendFileSync('/tmp/landmark-debug.log',
        `[${new Date().toISOString()}] EB ${p.eb}: RETURN-DB-CACHE ${hit.landmark} [${hit.source}] key=${key}\n`); return hit; }
      if (suspect) { fs.appendFileSync('/tmp/landmark-debug.log',
        `[${new Date().toISOString()}] EB ${p.eb}: SKIP-SUSPECT-CACHE ${cached.landmark} [${cached.source}] → re-resolving via higher-quality layer\n`); }
    }

    // 3) Google Maps — the PRIMARY professional layer. Geocodes the exact
    //    address to coordinates, finds the nearest named POI (hospital,
    //    school, mall, etc.). Quality is far above OSM/offline. Free tier
    //    (10K geocode + 5K nearby/month) covers this scale permanently.
    //    Results are cached so Google is called ONCE per address ever.
    if (this.opts.googleKey && this.opts.googleEnabled !== false) {
      try {
        const g = publicPlace(await googleLandmark(p.address, p.location, this.opts.googleKey, p.eb));
        if (g) { fs.appendFileSync('/tmp/landmark-debug.log',
        `[${new Date().toISOString()}] EB ${p.eb}: RETURN-GOOGLE ${g.landmark} [${g.source}]\n`); this.store.put(key, g); return g; }
      } catch (e) {
        console.warn('[landmark] google failed:', (e as Error).message);
      }
    }

    // 4) DETAILS extraction — parse landmark names from the property's own
    //    description text ("спроти ОУ Димитар Миладинов", "кај ТЦ Олимпико").
    //    Zero cost, always available. Fallback when Google is unavailable.
    const detailsLandmark = extractDetailsLandmark(p.details);
    if (detailsLandmark) {
      const l = publicPlace({ landmark: detailsLandmark, type: 'details', source: 'table' as const });
      if (l) { fs.appendFileSync('/tmp/landmark-debug.log',
        `[${new Date().toISOString()}] EB ${p.eb}: RETURN-DETAILS ${l.landmark} [${l.source}]\n`); this.store.put(key, l); return l; }
    }

    // 5) OFFLINE MAP + PHOTON — local OSM POIs with Photon geocoding.
    //    The offline map has 3,796 named POIs. When the local geocoder can't
    //    match the address, Photon (free, no key) provides coordinates so the
    //    POI search still works. This eliminates flaky Nominatim/Overpass calls.
    if (this.opts.offlineMap?.available) {
      try {
        // 5a) Try the address as a POI name first ("Кај Бранка", "Палома Бјанка")
        if (p.address) {
          const poi = this.opts.offlineMap.findPoiByName(p.address);
          if (poi) {
            const l = publicPlace({ landmark: poi.name, type: 'poi', source: 'osm' as const });
            if (l) { this.store.put(key, l); return l; }
          }
        }
        // 5b) Local geocode → nearest POI
        let geo = p.address ? this.opts.offlineMap.geocodeAddress(p.address) : undefined;
        // 5c) If local geocode fails, try Photon (free, fast, no key)
        if (!geo && p.address) {
          geo = await photonGeocode(p.address, p.location ?? '');
        }
        if (geo) {
          // ADAPTIVE RADIUS — same philosophy as the rotation: a landmark
          // 150m away is a real reference ("кај Тинекс"); "близина на ТЦ
          // Џевахир" 1.1km away is not. Start tight at 150m, widen only when
          // the area is genuinely sparse.
          let pois = this.opts.offlineMap.nearestPois(geo.lat, geo.lon, 150, 25);
          if (pois.length === 0) pois = this.opts.offlineMap.nearestPois(geo.lat, geo.lon, 400, 25);
          if (pois.length === 0) pois = this.opts.offlineMap.nearestPois(geo.lat, geo.lon, 1000, 25);
          // Three-tier landmark preference:
          //   1. Malls — everyone knows "Беверли Хилс" / "ТЦ Бисер" / "Рамстор"
          //   2. Government, schools, hospitals, parks, hotels — permanent structures
          //   3. Any POI with name >= 3 chars (fallback)
          const isMall = (t: string) => t === 'mall' || t === 'shopping_mall';
          const isLandmark = (t: string) => [
            'school', 'university', 'college',
            'government', 'townhall', 'diplomatic', 'embassy',
            'hospital', 'clinic', 'healthcare',
            'place_of_worship', 'church', 'mosque',
            'stadium', 'sports_centre', 'museum', 'theatre', 'cinema', 'library',
            'park', 'garden', 'playground',
            'hotel', 'hostel', 'motel', 'department_store',
          ].includes(t);
          const best = pois.find(po => po.name.length >= 3 && isMall(po.type))
            ?? pois.find(po => po.name.length >= 3 && isLandmark(po.type))
            ?? pois.find(po => po.name.length >= 3);
          if (best) {
            const l = publicPlace({ landmark: best.name, type: best.type, source: 'offline' as const });
            if (l) { fs.appendFileSync('/tmp/landmark-debug.log',
            `[${new Date().toISOString()}] EB ${p.eb}: RETURN-OFFLINE-MAP ${l.landmark} [${l.source}]\n`); this.store.put(key, l); return l; }
          }
        }
      } catch (e) { try { fs.appendFileSync('/tmp/landmark-debug.log',
          `[${new Date().toISOString()}] EB ${p.eb}: OFFLINE-MAP-FAILED: ${(e as Error).message}\n`); } catch {} }
    }

    // 6) OSM network — Nominatim + Overpass (free, no key)
    if (this.opts.osm !== false && this.opts.osmEnabled !== false) {
      try {
        const o = publicPlace(await osmLandmark(p.address, p.location));
        if (o) { try { fs.appendFileSync('/tmp/landmark-debug.log',
          `[${new Date().toISOString()}] EB ${p.eb}: LAYER6-OSM gave ${o.landmark} addr=${JSON.stringify(p.address?.substring(0, 40))}\n`); } catch {} this.store.put(key, o); return o; }
      } catch (e) {
        console.warn('[landmark] osm failed:', (e as Error).message);
      }
    }

    // 7) Deterministic table — per-neighborhood, offline, coarse.
    //    PROXIMITY GUARD: static table entries are neighborhood-level guesses
    //    and can be kilometers off (Кисела Вода → „Стадион Борис Трајковски“
    //    is 4.9 km from properties on Ефтим Спространов). If we can measure
    //    the real distance and it exceeds TABLE_MAX_DISTANCE_M, reject the
    //    entry — better no landmark than a misleading one.
    if (p.location) {
      const t = tableLandmark(p.eb, p.location);
      if (t) {
        const TABLE_MAX_DISTANCE_M = 800;
        let tooFar = false;
        try {
          const propGeo = p.address && this.opts.offlineMap?.available
            ? this.opts.offlineMap.geocodeAddress(p.address) : undefined;
          const lmPoi = this.opts.offlineMap?.findPoiByName(t.landmark);
          if (propGeo && lmPoi) {
            const d = meters(propGeo, { lat: lmPoi.lat, lon: lmPoi.lon });
            if (d > TABLE_MAX_DISTANCE_M) {
              tooFar = true;
              try { fs.appendFileSync('/tmp/landmark-debug.log',
                `[${new Date().toISOString()}] EB ${p.eb}: REJECT-TABLE ${t.landmark} — ${Math.round(d)}m > ${TABLE_MAX_DISTANCE_M}m\n`); } catch {}
            }
          }
        } catch {}
        const hit = tooFar ? undefined : publicPlace({ landmark: t.landmark, type: t.type, source: 'table' });
        if (hit) { this.store.put(key, hit); return hit; }
      }
    }

    // 8) Hermes contract — async LLM resolver (phase 2)
    this.opts.onHermesRequest?.({ address: p.address, location: p.location });
    return { landmark: '', type: '', source: 'none' };
  }

  /** Batch stamp: enriches properties with `landmark` before they reach any
   *  reply builder (cards, LLM context, where-is, availability). */
  async enrich(props: Array<{ eb: number; address?: string; location?: string; details?: string; landmark?: string; landmarks?: FeedLandmark[] }>): Promise<void> {
    await Promise.all(props.map(async pr => {
      // Feed landmarks from Supabase (ANA's import-time resolution) are
      // authoritative — never override them. But ALWAYS re-resolve for all
      // other cases: the DB cache (sub-ms) handles performance, and skipping
      // based on pr.landmark causes stale results when the PropertyService
      // caches a mutated property object for 5 minutes.
      const l = await this.resolve(pr);
      if (l.source !== 'none') pr.landmark = l.landmark;
      try { fs.appendFileSync('/tmp/landmark-debug.log',
        `[${new Date().toISOString()}] EB ${pr.eb}: resolved=${l.landmark} source=${l.source} addr=${JSON.stringify(pr.address?.substring(0, 40))}\n`); } catch {}
    }));
  }

  /** Returns the top 3 nearby landmarks with coordinates for rotation
   *  ("каде?" → first, "каде поточно?" → second, …) and Google Maps links.
   *  Uses ONLY the offline map (zero network) — if the local geocode fails,
   *  returns empty (no live API fallback for bulk POI queries).
   *  Results are cached in the landmarks table so the geocode+POI query
   *  runs at most ONCE per unique address. */
  nearbyLandmarks(p: { eb: number; address?: string; location?: string; landmark?: string }): Array<{ landmark: string; lat: number; lon: number }> {
    const key = landmarkCacheKey(p);
    // 1) Check DB cache
    const cached = this.store.getNearby(key);
    if (cached) return cached;
    // 2) Compute from offline map
    try {
      if (!this.opts.offlineMap || !p.address) return [];
      let geo = this.opts.offlineMap.geocodeAddress(p.address);
      // FALLBACK 1: address may be a landmark name ("Беверли Хилс") not a street.
      if (!geo && p.address) {
        const poi = this.opts.offlineMap.findPoiByName(p.address);
        if (poi) geo = { lat: poi.lat, lon: poi.lon };
      }
      // FALLBACK 2: use the already-resolved landmark name ("Католичка црква...")
      if (!geo && p.landmark) {
        const poi = this.opts.offlineMap.findPoiByName(p.landmark);
        if (poi) geo = { lat: poi.lat, lon: poi.lon };
      }
      if (!geo) return [];
      // ADAPTIVE WIDENING: dense city blocks have plenty of POIs within
      // 150m; sparse suburbs don't. Widen until we have 3 candidates for
      // the rotation so clients always get the full 3-step drill-down.
      // Dedupe by name — wider radii re-report the same POIs.
      const seen = new Set<string>();
      let pois: typeof validPois = [];
      const validPois: Array<{ name: string; type: string; distance_m: number; lat?: number; lon?: number }> = [];
      for (const radius of [150, 300, 600]) {
        for (const po of this.opts.offlineMap.nearestPois(geo.lat, geo.lon, radius, 50)) {
          if (!seen.has(po.name)) { seen.add(po.name); validPois.push(po); }
        }
        const good = validPois.filter(po => po.name.length >= 3 && po.lat != null && po.lon != null);
        if (good.length >= 3) break;
      }
      pois.push(...validPois.filter(po => po.name.length >= 3 && po.lat != null && po.lon != null));
      // nearestPois scores by distance × effective priority × permanence.
      // Malls and big chains under 100m get boosted to priority 1-2.
      // Exclude the primary POI (distance < 10m).
      const nearby = pois.slice(0, 3).map(po => ({ landmark: po.name, lat: po.lat!, lon: po.lon! }));
      // 3) Cache for next time
      if (nearby.length > 0) this.store.putNearby(key, nearby);
      return nearby;
    } catch (e) {
      console.warn('[landmarks] nearbyLandmarks failed:', (e as Error).message);
      return [];
    }
  }
}
