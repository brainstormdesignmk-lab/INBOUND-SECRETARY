// Hermes — the landmark resolver (the reasoning-LLM layer of the address
// privacy funnel).
//
// The runtime answers "каде се наоѓа?" with a nearby PUBLIC landmark and never
// the street. The deterministic table + OSM/Google layers give a landmark, but
// the user wants what a human agent would name: the TRUE nearest place for the
// EXACT address ("во близина на Кафе бар Ван Гог"), not a whole-neighborhood
// label. This script's job, per candidate address:
//
//   1. Geocode via OSM Nominatim (free, no key) to get coordinates.
//   2. Ask the reasoning LLM (NVIDIA NIM, OpenAI-compatible — Hermes' own
//      wired brain, free tier) to name the NEAREST public place.
//   3. Hard-validate the answer (the street must never leak) and write it back
//      as source='hermes' — the runtime picks it up from the cache next lookup.
//
// TWO MODES (env-driven):
//   local  — no LINA_API_URL: reads Lina's data/lina.db directly (one box).
//   remote — LINA_API_URL + HERMES_TOKEN set (Hermes on its own machine):
//            pulls candidates from Lina's /hermes/v1/work, pushes results to
//            /hermes/v1/landmarks. No local DB is touched or created.
//
// Usage:
//   npm run hermes:landmarks            # one pass
//   npm run hermes:landmarks -- --dry-run   # report only, no writes, no LLM calls

import '../compat/node16';

import { loadConfig } from '../config';
import { Db } from '../store/db';
import { sanitizeLandmarkAnswer, stripPoiAnnotation, FEED_LANDMARK_MAX_M, landmarkCacheKey, LandmarkStore, googleMapsLink } from '../geo/landmarks';
import { identityKey, type LocalPoi } from '../geo/offlineMap';
import { landmarkLink } from '../geo/precision';
import { OfflineMapStore } from '../geo/offlineMap';
import { EventStore } from '../store/events';
import { PropertyService, FeedLandmark } from '../data/properties';
import { pullWork, pushLandmarks, LandmarkCandidate } from '../hermes/client';

const SYSTEM_PROMPT = `Ти си Хермес, агентот за локации на агенцијата за недвижности Метрополис. Добиваш адреса на имот и треба да ја именуваш НАЈБЛИСКАТА јавна знаменитост — место што секретарката може да го спомене на клиент како приближна локација („во близина на …"), за да не ја открие точната адреса.

Прифатливи знаменитости: училиште, трговски центар, кафе-бар/ресторан, болница/клиника, општина, универзитет/факултет, хотел, стадион, парк, супермаркет, музеј, автобуска станица. Користи го знаењето за Скопје и дадените координати за да одлучиш што е навистина најблиску.

Одговори САМО со името на знаменитоста — кратко, како што клиент би ја препознала (најмногу 3-4 збора). НИКАКО не ја пишувај улицата или адресата. НИКАКВО објаснување, ниту вовед.`;

/** Sleep helper for rate limiting. */
function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

/** Rate-limit: 2s between LLM calls to stay under NIM free-tier limits. */
const LLM_DELAY_MS = 5_000;
const MAX_LLM_RETRIES = 3;

/** Addresses that are garbage, placeholder, or unresolvable — skip silently. */
const JUNK_ADDRESS_RE = /^(непозната|непознато|unknown|.test|keyboard mash)$/i;
//.keyboard mash: 3+ repeating Cyrillic consonants with no vowels (хфг, фгх, etc.)
const KEYBOARD_MASH_RE = /^(?:[бвгджзклмнпрстфхцчшщ]{3,})+$/i;

function isJunkAddress(addr: string): boolean {
  const a = addr.trim();
  if (!a || a.length < 3) return true;
  if (JUNK_ADDRESS_RE.test(a)) return true;
  if (KEYBOARD_MASH_RE.test(a)) return true;
  // "Оу" prefix without a real street name
  if (/^оу\s+/.test(a) && a.split(/\s+/).length <= 2) return true;
  return false;
}

/** Fetch with exponential backoff on 429 (rate limit). NVIDIA NIM free tier
 *  is strict (~1-2 req/s). The Retry-After header (seconds) is honored when
 *  present; otherwise we back off 4s → 8s → 16s. Returns the Response on
 *  success, throws after exhausting retries. */
async function fetchWithRetry(url: string, opts: RequestInit, retries = MAX_LLM_RETRIES): Promise<Response> {
  const res = await fetch(url, opts);
  if (res.status !== 429 || retries <= 0) return res;
  const retryAfter = Number(res.headers.get('Retry-After'));
  const delayMs = (Number.isFinite(retryAfter) && retryAfter > 0)
    ? retryAfter * 1000
    : LLM_DELAY_MS * Math.pow(2, MAX_LLM_RETRIES - retries + 1);
  console.log(`    ⏳ 429 — retrying in ${Math.round(delayMs / 1000)}s (${retries} left)`);
  await sleep(delayMs);
  return fetchWithRetry(url, opts, retries - 1);
}

/** Regex to strip trailing forward slashes from a URL. Defined as a constant
 *  to avoid a template-literal parsing quirk with /\/ in `${}`. */
const TRAILING_SLASH_RE = /\/+$/;

/** Geocode an address via OSM Nominatim (free, no key) — script-side only.
 *  The runtime request path is DB-only; this live fallback belongs to this
 *  nightly resolver, never to a client message. */
async function geocodeOsm(address: string | undefined, location: string | undefined): Promise<{ lat: number; lon: number; street: string } | undefined> {
  const q = [address, location, 'Скопје'].filter(Boolean).join(', ');
  try {
    const res = await fetchWithRetry(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`,
      { headers: { 'User-Agent': 'metropolis-lina-bot/1.0', 'Accept-Language': 'mk' } },
      2,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as Array<{ lat?: string | number; lon?: string | number; display_name?: string }> | undefined;
    const g = data?.[0];
    if (!g || g.lat === undefined || g.lon === undefined) return undefined;
    return { lat: Number(g.lat), lon: Number(g.lon), street: g.display_name ?? '' };
  } catch {
    return undefined;
  }
}

/** Distance in meters (haversine) — same formula as LandmarkService. */
function meters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** The ranked landmark list for one address, straight from the map.
 *
 *  No model, no network with the offline map present: the pool is the engine's
 *  own ranking (typeRank → Google prominence → distance) inside the client-facing
 *  500m ring, and the list is its first N entries — the same ladder the chat
 *  rotation serves, so the page and the conversation cannot disagree. The live
 *  Overpass query remains the fallback when the map is missing or empty. */

// The client-facing ceiling for a feed landmark lives with the reader
// (properties.parseFeedLandmarks enforces the same number) — neither side may
// claim a place it cannot see from the door.

/** How many landmarks a feed row carries — the same count the conversation
 *  rotates through (L1→L3), so the page and the replies name the same places. */
export const FEED_LANDMARK_COUNT = 3;
export function rankedLandmarks(
  c: { address?: string; location?: string },
  geo: { lat: number; lon: number },
  offline?: OfflineMapStore,
): { list: FeedLandmark[]; poolSize: number } {
  // THE RING IS THE RADIUS — measure first, rank inside it.
  // nearestPois is PREFERENCE-ranked, not distance-sorted: asking it for 25 POIs
  // within 2km fills the list with malls across the city (top rank first) and
  // then a 500m filter finds none of them. That is exactly what happened on
  // 2026-10-11 — EB 89 reported "нема јавни места во радиус 500 м" while
  // „Парк Авионче“ sat 174m away, and the same bug made the pass declare a
  // dozen properties (Емил Зола 35, Визбегово, Козле…) unresolvable. The radius
  // must bound the query, so the client-facing 500m ceiling is applied HERE.
  const pois = offline?.available
    ? offline.nearestPois(geo.lat, geo.lon, FEED_LANDMARK_MAX_M, 25)
    : [] as LocalPoi[];
  if (pois.length === 0) return { list: [], poolSize: 0 };
  // Guard for the live fallback (osmPoisNear has its own 2km query).
  const pool = pois.filter(p => typeof p.distance_m !== 'number' || p.distance_m <= FEED_LANDMARK_MAX_M);
  if (process.env.DBG_GEO) {
    try {
      process.stderr.write(`[feed-dbg] geo=${geo.lat.toFixed(5)},${geo.lon.toFixed(5)} map=${offline?.available ? 'yes' : 'no'} pois(2km)=${pois.length} pool(500m)=${pool.length}\n`);
      process.stderr.write(`[feed-dbg] nearest raw: ${pois.slice(0, 4).map(p => `${p.name}@${p.distance_m}m`).join(' | ') || '(none)'}\n`);
    } catch { /* ignore */ }
  }
  // Nothing within 500m → an honest empty list (the caller says so explicitly).
  if (pool.length === 0) return { list: [], poolSize: 0 };
  // THE LIST IS THE MAP'S OWN RANKED ORDER — no model in the loop.
  //
  // The pool arrives already ranked by the map (typeRank → Google prominence →
  // distance), which is the SAME ladder the chat rotation serves. Asking an LLM
  // to re-pick from it bought nothing and cost a lot: a 2–4 minute call per
  // property, a different list every run, and three failure modes that all
  // looked like "the map is empty" (a model that answered nothing usable, a
  // model that echoed the prompt line back — the 2026-10-10 EB 94 corruption —
  // and a missing API key that silently turned the whole pass into REPORT MODE).
  // The page and the conversation now agree by construction, and the result is
  // reproducible on any machine, with no keys.
  const out: FeedLandmark[] = [];
  const seen = new Set<string>();
  for (const poi of pool) {
    if (out.length >= FEED_LANDMARK_COUNT) break;
    const name = sanitizeLandmarkAnswer(poi.name, c.address);
    if (!name) continue;
    const key = identityKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      landmark: name,
      type: poi.type ?? 'place',
      distance_m: poi.distance_m,
      // The SAME link policy as every other surface (precision.landmarkLink):
      // a stored Google place URL, else ?cid=<decimal> from the place_id, else a
      // coordinate pin. A name-query URL is never emitted — percent-encoded
      // Cyrillic made it longer than the writer function's 300-char limit, so
      // long-named rows (EB 37) were rejected with HTTP 400 and never healed.
      maps_url: landmarkLink(name, poi.place_id ?? null, poi.lat ?? geo.lat, poi.lon ?? geo.lon, poi.place_url),
    });
  }
  return { list: out, poolSize: pool.length };
}

/** The list AS STORED in the DB, before the reader's contract filter runs.
 *
 *  p.landmarks is the PARSED list: parseFeedLandmarks has already dropped
 *  >500m claims, annotation residue and malformed entries. Comparing that
 *  filtered list against `desired` makes a dirty row look already-correct — the
 *  filter hides exactly the rows the sweep exists to repair, which is how 8
 *  legacy rows kept live 600m–1.2km "во близина" claims for weeks while the
 *  sweep reported them clean. The stored raw JSON is the thing that must
 *  converge on the map, entry for entry; the reader's cap is a guard for
 *  clients, never a licence for the writer to leave bad data behind. */
export function storedLandmarkList(p: { landmarks?: FeedLandmark[]; raw?: Record<string, unknown> }): FeedLandmark[] {
  const raw = p.raw?.landmarks;
  return Array.isArray(raw) ? (raw as FeedLandmark[]) : (p.landmarks ?? []);
}

/** Same list, same order, same distances (the writer rounds to metres) — the
 *  comparison behind "this row already matches the map". */
export function sameFeedList(stored: FeedLandmark[], desired: FeedLandmark[]): boolean {
  if (stored.length !== desired.length) return false;
  for (let i = 0; i < desired.length; i++) {
    if (identityKey(stored[i].landmark) !== identityKey(desired[i].landmark)) return false;
    const a = stored[i].distance_m, b = desired[i].distance_m;
    if (a != null && b != null && Math.abs(a - b) > 1) return false;
  }
  return true;
}

async function llmLandmark(
  cfg: { hermesLlmBaseUrl: string; hermesLlmApiKey: string; hermesLlmModel: string },
  input: { address?: string; location?: string; lat: number; lon: number },
): Promise<string | undefined> {
  const res = await fetchWithRetry(`${cfg.hermesLlmBaseUrl.replace(TRAILING_SLASH_RE, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.hermesLlmApiKey}`,
    },
    body: JSON.stringify({
      model: cfg.hermesLlmModel,
      temperature: 0.2,
      max_tokens: 512,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Адреса: ${input.address ?? '?'}\nНаселба: ${input.location ?? '?'}\nКоординати: ${input.lat}, ${input.lon}`,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
  const data = await res.json() as { choices?: Array<{ message?: { content?: string | null; reasoning_content?: string } }> };
  const msg2 = data.choices?.[0]?.message;
  return (msg2?.content?.trim() || msg2?.reasoning_content?.trim() || '').replace(/^\n+/, '') || undefined;
}

/** Candidates in LOCAL mode: feed properties without a precise cached row +
 *  the runtime's pending landmark_requested events (matched to a property id
 *  via address, since the cache is property.id keyed). */
async function localCandidates(db: Db): Promise<LandmarkCandidate[]> {
  const store = new LandmarkStore(db);
  const events = new EventStore(db);
  const props = new PropertyService(loadConfig().propertyDataUrl);
  const all = await props.getAll();
  const keyOf = (a?: string, l?: string) => `${l ?? ''} | ${a ?? ''}`.toLowerCase().replace(/\s+/g, ' ');
  const candidates: LandmarkCandidate[] = [];
  for (const p of all) {
    if (p.id == null) continue;
    const row = store.get(p.id);
    if (row && row.tier && row.tier !== 'osm_low_confidence') continue; // already precise
    if (!p.address && !p.location) continue;
    if (p.address && isJunkAddress(p.address)) continue;
    candidates.push({ id: p.id, address: p.address, location: p.location });
  }
  const idByKey = new Map(all.filter(p => p.id != null).map(p => [keyOf(p.address, p.location), p.id as number]));
  for (const ev of events.listPending('landmark_requested')) {
    const payload = JSON.parse(ev.payload) as { address?: string; location?: string };
    if (payload.address && isJunkAddress(payload.address)) continue;
    const id = idByKey.get(keyOf(payload.address, payload.location));
    if (id == null) continue; // no property id — the cache can't key it
    const row = store.get(id);
    if (!row || !row.tier || row.tier === 'osm_low_confidence') candidates.push({ id, address: payload.address, location: payload.location });
  }
  return candidates;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const dryRun = process.argv.includes('--dry-run');
  const feedMode = process.argv.includes('--feed');
  const remote = !!(cfg.linaApiUrl && cfg.hermesToken);
  const configured = !!(cfg.hermesLlmApiKey && cfg.hermesLlmModel);

  if (feedMode) {
    console.log('[hermes-landmarks] FEED mode (import-time resolution → ranked list next to the property)');
    // FEED mode needs exactly ONE thing: the map. The list is derived from the
    // engine's own ranking, so there is no model to be configured and no key to
    // be missing — the old "no HERMES_LLM_API_KEY → REPORT MODE, nothing
    // resolved" silence is gone with the model.
    const pushUrl = cfg.hermesLandmarksWriteUrl;
    if (!pushUrl) console.log('[hermes-landmarks] HERMES_LANDMARKS_WRITE_URL not set — REPORT MODE (nothing pushed).');
    else if (dryRun) console.log('[hermes-landmarks] --dry-run: reporting candidates, nothing written.');

    const props = new PropertyService(cfg.propertyDataUrl);
    const all = await props.getAll();
    const offline = new OfflineMapStore(cfg.skopjePoisDb);
    if (!offline.available) {
      // The map IS the authority for this pass. Without it the honest answer is
      // to stop, not to guess from a live query (unverifiable, unreproducible,
      // and unreviewable against the engine's own ranking).
      console.error(`[hermes-landmarks] ✗ offline map missing/unreadable at ${cfg.skopjePoisDb} — nothing written. Set SKOPJE_POIS_DB.`);
      return;
    }
    const stats = offline.stats();

    // Optional surgical run: --eb 89 repairs ONE property.
    const ebIdx = process.argv.indexOf('--eb');
    const onlyEb = ebIdx >= 0 ? process.argv[ebIdx + 1] : undefined;

    // THE DETECTOR IS THE ENGINE: a row is a candidate when the list the map
    // would produce TODAY differs from the list that is stored. That single rule
    // replaces a detector per symptom — missing list, annotation residue,
    // over-cap claim, a ranking that has since improved — so a row heals itself
    // after any future change to the map, with no rule to remember.
    //
    // The map may only speak for addresses it KNOWS (resolvePropertyOffline:
    // exact building or interpolated). When the snapshot has not seen the street,
    // the property's OWN feed pin is the fallback — it is the same authoritative
    // coordinate the map itself is built around (geo_source = stored/google_cached),
    // so a row whose street is missing from the snapshot is still resolved
    // deterministically and reproducibly. The live geocoder is never consulted.
    const todo: Array<{ eb: number; address: string; location?: string; desired: FeedLandmark[] }> = [];
    let unmapped = 0;
    let current = 0;
    for (const p of all) {
      if (!p.address || isJunkAddress(p.address)) continue;
      if (onlyEb && String(p.eb) !== onlyEb) continue;
      // Two authorities, in order: the map's own address resolution when it is
      // TRUSTED, else the property's own feed pin — the same authoritative
      // coordinate the map itself is built from. Deliberately a plain {lat,lon}
      // (never the resolver's wider union), so the point handed to the ranker is
      // always a real coordinate.
      const resolved = offline.available ? offline.resolvePropertyOffline(p.address) : undefined;
      let geo: { lat: number; lon: number } | undefined;
      if (resolved?.trusted && resolved.lat != null && resolved.lon != null) {
        geo = { lat: resolved.lat, lon: resolved.lon };
      } else if (typeof p.lat === 'number' && typeof p.lon === 'number') {
        geo = { lat: p.lat, lon: p.lon };
      }
      if (!geo) { unmapped++; continue; }
      const desired = rankedLandmarks({ address: p.address, location: p.location }, geo, offline).list;
      if (desired.length === 0) {
        // The map resolved this property and the ring is genuinely empty. A
        // stored list here is dead weight — the reader already drops every
        // out-of-ring claim, so the page shows nothing while the DB keeps
        // promising places the client can never see. Write the honest empty
        // list (the writer accepts [] as an explicit clear) instead of leaving
        // legacy claims in the data layer.
        if (storedLandmarkList(p).length > 0) {
          todo.push({ eb: p.eb, address: p.address, location: p.location, desired: [] });
        } else {
          current++;
        }
        continue;
      }
      if (sameFeedList(storedLandmarkList(p), desired)) { current++; continue; }
      todo.push({ eb: p.eb, address: p.address, location: p.location, desired });
    }
    console.log(`[hermes-landmarks] ${all.length} propert(ies): ${current} already match the map, ${todo.length} to write, ${unmapped} address(es) the map cannot resolve (left untouched).`);

    let resolved = 0;
    let failed = 0;
    for (const c of todo) {
      const label = `${c.address}${c.location ? ` (${c.location})` : ''}`;
      const shown = c.desired.length === 0
        ? '(clear — the map sees no public place inside the ring)'
        : c.desired.map(l => `„${l.landmark}“ (${l.distance_m ?? '?'}м)`).join(', ');
      if (!pushUrl || dryRun) {
        console.log(`  would write: ${label} → ${shown}`);
        continue;
      }
      try {
        const res = await fetch(pushUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', [cfg.hermesAuthHeader]: cfg.hermesToken },
          body: JSON.stringify({ property_number: c.eb, landmarks: c.desired }),
        });
        const body = await res.json().catch(() => ({})) as { unchanged?: boolean; error?: string };
        if (!res.ok) {
          console.log(`  ✗ ${label} — edge function HTTP ${res.status}${body.error ? ` (${body.error})` : ''}`);
          failed++;
          continue;
        }
        resolved++;
        console.log(`  ✓ ${label} → ${shown}${body.unchanged ? ' (unchanged)' : ''}`);
      } catch (e) {
        console.log(`  ✗ ${label} — ${(e as Error).message}`);
        failed++;
      }
    }
    offline.close();
    console.log(`[hermes-landmarks] done: ${resolved} resolved, ${failed} skipped/failed${dryRun ? ' (dry-run)' : ''}.`);
    return;
  }

  if (remote) {
    console.log(`[hermes-landmarks] REMOTE mode → ${cfg.linaApiUrl}`);
  } else {
    console.log('[hermes-landmarks] LOCAL mode (reads Lina DB directly)');
  }
  if (!configured) {
    console.log('[hermes-landmarks] HERMES_LLM_API_KEY / HERMES_LLM_MODEL not set — REPORT MODE (nothing resolved).');
  } else if (dryRun) {
    console.log('[hermes-landmarks] --dry-run: reporting candidates, nothing written, no LLM calls.');
  }

  let candidates: LandmarkCandidate[] = [];
  let db: Db | null = null;
  let store: LandmarkStore | null = null;
  let events: EventStore | null = null;
  const offlineLocal = new OfflineMapStore(cfg.skopjePoisDb);
  if (remote) {
    if (configured && !dryRun) {
      candidates = (await pullWork(cfg.linaApiUrl, cfg.hermesToken)).landmarks;
    } else if (dryRun) {
      console.log('  (remote dry-run: would pull candidates from /hermes/v1/work)');
    }
  } else {
    db = new Db(cfg.dbPath);
    store = new LandmarkStore(db);
    events = new EventStore(db);
    candidates = await localCandidates(db);
  }

  console.log(`[hermes-landmarks] ${candidates.length} candidate(s).`);
  let resolved = 0;
  let failed = 0;
  const remoteResults: Array<{ id?: number; address?: string; location?: string; landmark: string; type: string; maps_url: string }> = [];

  for (const c of candidates) {
    if (!configured || dryRun) {
      console.log(`  candidate: ${[c.address, c.location].filter(Boolean).join(', ')}`);
      failed++;
      continue;
    }
    try {
      let geo = offlineLocal.available
        ? offlineLocal.geocodeAddress(c.address ?? '') ?? await geocodeOsm(c.address, c.location)
        : await geocodeOsm(c.address, c.location);
      if (!geo && offlineLocal.available && c.address) {
        const poi = offlineLocal.findPoiByName(c.address);
        if (poi) geo = { lat: poi.lat, lon: poi.lon, street: poi.name } as any;
      }
      if (!geo) {
        console.log(`  ✗ ${[c.address, c.location].filter(Boolean).join(', ')} — не може да се геокодира (останува табелата)`);
        failed++;
        continue;
      }
      const raw = await llmLandmark(cfg, { ...c, lat: geo.lat, lon: geo.lon });
      // Rate-limit: 2s between LLM calls to avoid 429 on NIM free tier.
      await sleep(LLM_DELAY_MS);
      const landmark = raw ? sanitizeLandmarkAnswer(raw, c.address) : undefined;
      if (!landmark) {
        console.log(`  ✗ ${[c.address, c.location].filter(Boolean).join(', ')} — LLM одговор одбиен („${raw ?? '(празно)'}") — останува табелата`);
        failed++;
        continue;
      }
      const mapsUrl = googleMapsLink(landmark);
      if (remote) {
        remoteResults.push({ id: c.id, address: c.address, location: c.location, landmark, type: 'llm', maps_url: mapsUrl });
      } else if (store && events) {
        if (c.id == null) {
          console.log(`  ✗ ${[c.address, c.location].filter(Boolean).join(', ')} — no property id (cache is property.id keyed)`);
          failed++;
          continue;
        }
        store.put(c.id, { landmark, type: 'llm', mapsUrl, source: 'hermes' }, 'extract');
        for (const ev of events.listPending('landmark_requested')) {
          const payload = JSON.parse(ev.payload) as { eb?: number };
          if (payload.eb === c.id) events.resolve(ev.id);
        }
      }
      resolved++;
      console.log(`  ✓ ${[c.address, c.location].filter(Boolean).join(', ')} → „${landmark}“ (hermes)`);
    } catch (e) {
      console.log(`  ✗ ${[c.address, c.location].filter(Boolean).join(', ')} — ${(e as Error).message}`);
      failed++;
    }
  }

  if (db) db.close();

  if (remote && remoteResults.length > 0) {
    const res = await pushLandmarks(cfg.linaApiUrl, cfg.hermesToken, remoteResults);
    console.log(`[hermes-landmarks] pushed ${remoteResults.length} → Lina accepted ${res.accepted}, rejected ${res.rejected.length}`);
  }

  console.log(`[hermes-landmarks] done: ${resolved} resolved, ${failed} skipped/failed${dryRun ? ' (dry-run)' : ''}.`);
}

// Run ONLY when executed (npm run hermes:landmarks …). Importing this module
// must have no side effects: the tests import rankedLandmarks / sameFeedList /
// storedLandmarkList, and an unguarded call fired a whole live pass — network
// fetch, LLM calls, feed writes — inside the test process. Symptom: the sweep
// test printed pages of rejected LLM answers and ran for minutes instead of
// milliseconds. tsx compiles this file to CJS, so require.main is reliable.
if (require.main === module) {
  main().catch(e => {
    console.error('[hermes-landmarks] fatal:', e);
    process.exit(1);
  });
}
