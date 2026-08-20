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
// Resolution layers, cheapest first (each hit is cached in the `landmarks`
// table so live APIs are called at most ONCE per address ever):
//   1. deterministic table  — per-neighborhood Skopje landmarks, zero cost,
//      offline, works in the LLM-free state.
//   2. Google Maps          — Geocoding + Places Nearby Search when
//      GOOGLE_MAPS_API_KEY is set (free tier covers this scale forever).
//   3. OSM                  — Nominatim geocode + Overpass nearest amenity,
//      free, no key, no billing.
//   4. Hermes event         — `landmark_requested` on the events bus; Hermes
//      (its own LLM via NVIDIA) answers in phase 2. Nothing consumes it yet.
// If everything fails → { source: 'none' } and the caller falls back to the
// neighborhood alone — the street is never revealed.

import { Db } from '../store/db';
import { tableLandmark } from './landmarkTable';
import { FeedLandmark } from '../data/properties';

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
  /** Enable the free OSM layer (Nominatim + Overpass). ON by default for
   *  production; tests turn it off so the suite never hits the network. */
  osm?: boolean;
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

// --- Google layer -----------------------------------------------------------
/** Google Maps link for a query (real address or landmark name) — the ONLY
 *  link format that may ever reach a customer: "everyone uses Google Maps".
 *  The visit protocol's exact-address link and every landmark layer build
 *  through this, so an OSM/other URL can never leak into a message or cache. */
export function googleMapsLink(query: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

async function googleLandmark(address: string | undefined, location: string | undefined, key: string): Promise<Landmark | undefined> {
  const q = [address, location, 'Скопје'].filter(Boolean).join(', ');
  const geo = await fetchJson(
    `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&key=${encodeURIComponent(key)}`
  );
  const gres = geo?.results?.[0];
  if (!gres?.geometry?.location) return undefined;
  const { lat, lng } = gres.geometry.location;
  const nearby = await fetchJson(
    `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=800&type=tourist_attraction|shopping_mall|hospital|university|school|hotel|stadium&key=${encodeURIComponent(key)}`
  );
  const place = nearby?.results?.[0];
  if (!place?.name) return undefined;
  return {
    landmark: place.name,
    type: place.types?.[0] ?? 'place',
    mapsUrl: googleMapsLink(place.name),
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
}

/** Canonical cache key — a property is identified by location + street, so a
 *  price update or EB change never needs a new lookup. */
export function landmarkCacheKey(p: { address?: string; location?: string }): string {
  return `${p.location ?? ''} | ${p.address ?? ''}`.toLowerCase().replace(/\s+/g, ' ');
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

/** Drop a landmark that is actually a street — every layer is checked. */
function publicPlace(l: Landmark | undefined): Landmark | undefined {
  if (!l) return undefined;
  return isStreetName(l.landmark) ? undefined : l;
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
  async resolve(p: { eb: number; address?: string; location?: string; landmarks?: FeedLandmark[] }): Promise<Landmark> {
    // 0) FEED layer — ANA's import-time resolution, stored next to the property
    //    in Supabase. The ranked list IS the answer: pick the nearest VALID
    //    PUBLIC place, rotating among the top few by EB hash for variety (two
    //    properties in one neighborhood must not parrot the same landmark, the
    //    same spirit as the table pick). Street-name entries are rejected by
    //    the shared guard (defense in depth — the edge function validates too).
    //    NOT cached in the local DB: the feed is the source of truth and the
    //    property cache already refreshes it.
    if (p.landmarks && p.landmarks.length > 0) {
      const ranked = p.landmarks
        .map(l => ({ l, hit: publicPlace({ landmark: l.landmark, type: l.type ?? 'place', mapsUrl: l.maps_url, source: 'feed' as const }) }))
        .filter((x): x is { l: FeedLandmark; hit: Landmark } => !!x.hit)
        .sort((a, b) => (a.l.distance_m ?? Infinity) - (b.l.distance_m ?? Infinity));
      if (ranked.length > 0) {
        const top = ranked.slice(0, 3);
        return top[Math.abs(p.eb * 2654435761) % top.length].hit;
      }
    }
    const key = landmarkCacheKey(p);

    const cached = this.store.get(key);
    if (cached) {
      // Two reasons a cached row must NOT be served:
      //  1. It was written BEFORE the street-name guard existed (e.g. a table
      //     row "Булеварот Партизански Одреди") — never serve one.
      //  2. It is table-sourced but the TABLE no longer lists it (landmarks
      //     get replaced — "Универзалната сала" → Плоштад „Македонија“) —
      //     the stale landmark would point the client at the wrong place.
      const stale = cached.source === 'table' && p.location
        ? (() => {
            const t = tableLandmark(p.eb, p.location);
            return !t || t.landmark !== cached.landmark;
          })()
        : false;
      const hit = stale ? undefined : publicPlace({
        landmark: cached.landmark, type: cached.type,
        mapsUrl: cached.mapsUrl ?? undefined,
        source: cached.source as Landmark['source'],
      });
      if (hit) return hit;
    }

    // LIVE layers FIRST — the client wants the TRUE nearest landmark ("во
    // близина на Кафе бар Ван Гог"), never a whole-neighborhood label ("ГТЦ
    // за целиот Центар"). Google when a key exists, else the free OSM layer.

    // 1) Google (only with a key — free tier covers this scale)
    if (this.opts.googleKey) {
      try {
        const g = publicPlace(await googleLandmark(p.address, p.location, this.opts.googleKey));
        if (g) { this.store.put(key, g); return g; }
      } catch (e) {
        console.warn('[landmark] google failed:', (e as Error).message);
      }
    }

    // 2) OSM — free, no key (opt-in: tests keep the suite offline)
    if (this.opts.osm !== false) {
      try {
        const o = publicPlace(await osmLandmark(p.address, p.location));
        if (o) { this.store.put(key, o); return o; }
      } catch (e) {
        console.warn('[landmark] osm failed:', (e as Error).message);
      }
    }

    // 3) deterministic table — the OFFLINE fallback (network down, LLM-free
    // state, ungeocodable address). Coarse on purpose; Hermes upgrades it.
    // The table's own entries are vetted, but the street-name guard still runs
    // (defense in depth — a bad entry must never leak the exact location).
    if (p.location) {
      const t = tableLandmark(p.eb, p.location);
      if (t) {
        const hit = publicPlace({ landmark: t.landmark, type: t.type, source: 'table' });
        if (hit) { this.store.put(key, hit); return hit; }
      }
    }

    // 4) Hermes contract — the reasoning-LLM resolver (npm run hermes:landmarks)
    // answers via its own NVIDIA LLM. Emitted every time until answered; the
    // caller falls back to the neighborhood alone.
    this.opts.onHermesRequest?.({ address: p.address, location: p.location });
    return { landmark: '', type: '', source: 'none' };
  }

  /** Batch stamp: enriches properties with `landmark` before they reach any
   *  reply builder (cards, LLM context, where-is, availability). */
  async enrich(props: Array<{ eb: number; address?: string; location?: string; landmark?: string; landmarks?: FeedLandmark[] }>): Promise<void> {
    await Promise.all(props.map(async pr => {
      if (pr.landmark) return;
      const l = await this.resolve(pr);
      if (l.source !== 'none') pr.landmark = l.landmark;
    }));
  }
}
