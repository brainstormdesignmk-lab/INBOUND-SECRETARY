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

import { loadConfig } from '../config';
import { Db } from '../store/db';
import { geocodeOsm, sanitizeLandmarkAnswer, landmarkCacheKey, LandmarkStore, googleMapsLink } from '../geo/landmarks';
import { OfflineMapStore } from '../geo/offlineMap';
import { EventStore } from '../store/events';
import { PropertyService, FeedLandmark } from '../data/properties';
import { pullWork, pushLandmarks, LandmarkCandidate } from '../hermes/client';

const SYSTEM_PROMPT = `Ти си Хермес, агентот за локации на агенцијата за недвижности Метрополис. Добиваш адреса на имот и треба да ја именуваш НАЈБЛИСКАТА јавна знаменитост — место што секретарката може да го спомене на клиент како приближна локација („во близина на …"), за да не ја открие точната адреса.

Прифатливи знаменитости: училиште, трговски центар, кафе-бар/ресторан, болница/клиника, општина, универзитет/факултет, хотел, стадион, парк, супермаркет, музеј, автобуска станица. Користи го знаењето за Скопје и дадените координати за да одлучиш што е навистина најблиску.

Одговори САМО со името на знаменитоста — кратко, како што клиент би ја препознала (најмногу 3-4 збора). НИКАКО не ја пишувај улицата или адресата. НИКАКВО објаснување, ниту вовед.`;

// The RANKED-list prompt (feed mode): the client-facing answer is no longer one
// fixed landmark per property — the import-time resolver stores 2-5 PUBLIC
// places, nearest first, so Lina can vary the answer across sessions.
const RANKED_SYSTEM_PROMPT = `Ти си Хермес, агентот за локации на агенцијата за недвижности Метрополис. Добиваш адреса на имот, нејзини координати и листа на јавни места во радиус од 1 километар, секое со растојание во метри.

Задача: избери 2-5 места од ЛИСТАТА кои клиент најлесно би ги препознал како ориентир (училиште, трговски центар, кафе-бар, ресторан, болница, универзитет/факултет, хотел, стадион, парк, супермаркет). Почни од најблиското, потоа следните. ОТФРЛИ нејасни/бескорисни записи (без име, само броеви, генерички ознаки).

Одговори САМО со JSON, користејќи ги ТОЧНИТЕ имиња од листата:
{"landmarks": ["Име 1", "Име 2"]}
НИКАКО не ја пишувај улицата или адресата. НИКАКВО објаснување, ниту вовед.`;

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

/** Distance in meters (haversine) — same formula as LandmarkService. */
function meters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

interface Poi {
  name: string;
  type: string;
  distance_m: number;
}

/** ONE Overpass query, radius 2000m, collecting ALL named amenity POIs with
 *  their distances — the 100m…1000m rings are the distances, no 10 queries. */
async function osmPoisNear(lat: number, lon: number): Promise<Poi[]> {
  const AMENITIES = 'school|university|hospital|clinic|mall|hotel|theatre|cinema|stadium|library|cafe|restaurant|bar|bank|pharmacy|supermarket|park|townhall';
  const q = `[out:json][timeout:10];(node["amenity"~"^(${AMENITIES})$"](around:2000,${lat},${lon});way["amenity"~"^(${AMENITIES})$"](around:2000,${lat},${lon}););out center tags;`;
  const res = await fetchWithRetry(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(q)}`, {
    headers: { 'User-Agent': 'metropolis-hermes/1.0' },
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  const data = await res.json() as { elements?: Array<{ lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }> };
  const pois: Poi[] = [];
  for (const e of data.elements ?? []) {
    const p = { lat: e.lat ?? e.center?.lat ?? NaN, lon: e.lon ?? e.center?.lon ?? NaN };
    if (!Number.isFinite(p.lat)) continue;
    const name = (e.tags?.name ?? '').trim();
    if (!name) continue; // unnamed POIs are useless landmarks
    pois.push({ name, type: e.tags?.amenity ?? 'place', distance_m: Math.round(meters({ lat, lon }, p)) });
  }
  return pois.sort((a, b) => a.distance_m - b.distance_m).slice(0, 10);
}

/** One LLM call naming the 2-5 recognizable places, nearest first. */
async function llmPickLandmarks(
  cfg: { hermesLlmBaseUrl: string; hermesLlmApiKey: string; hermesLlmModel: string },
  input: { address?: string; location?: string; lat: number; lon: number },
  pois: Poi[],
): Promise<string[]> {
  const res = await fetchWithRetry(`${cfg.hermesLlmBaseUrl.replace(TRAILING_SLASH_RE, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.hermesLlmApiKey}` },
    body: JSON.stringify({
      model: cfg.hermesLlmModel,
      temperature: 0.1,
      max_tokens: 1024,
      messages: [
        { role: 'system', content: RANKED_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Адреса: ${input.address ?? '?'}\nНаселба: ${input.location ?? '?'}\nКоординати: ${input.lat}, ${input.lon}\n\nЛиста:\n${pois.map(p => `- ${p.name} (${p.type}, ${p.distance_m}м)`).join('\n')}`,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
  const data = await res.json() as { choices?: Array<{ message?: { content?: string | null; reasoning_content?: string } }> };
  const msg = data.choices?.[0]?.message;
  // Reasoning models (nemotron-nano, deepseek-r1) put the answer in content
  // after thinking in reasoning_content. If content is null, fall back to
  // reasoning_content (the answer is embedded there).
  const raw = (msg?.content?.trim() || msg?.reasoning_content?.trim() || '').replace(/^\n+/, '');
  // JSON object {"landmarks": [...]} — extract every quoted string as a fallback.
  const m = raw.match(/\{[\s\S]*?\}/);
  if (m) {
    try {
      const obj = JSON.parse(m[0]) as { landmarks?: unknown };
      if (Array.isArray(obj.landmarks)) {
        return obj.landmarks.map(x => String(x).trim()).filter(Boolean).slice(0, 5);
      }
    } catch { /* fall through */ }
  }
  return (raw.match(/"([^"]+)"/g) ?? []).map(x => x.replace(/"/g, '').trim()).filter(Boolean).slice(0, 5);
}

/** Resolve the RANKED list for one address: geocode once → POIs once → one LLM
 *  pick → sanitize each entry (the street must never leak). With the offline
 *  map, the POIs come from the LOCAL SQLite store (zero network); the live
 *  Overpass query is the fallback when the map is missing or empty. */
async function rankedLandmarks(
  cfg: { hermesLlmBaseUrl: string; hermesLlmApiKey: string; hermesLlmModel: string },
  c: { address?: string; location?: string },
  geo: { lat: number; lon: number },
  offline?: OfflineMapStore,
): Promise<FeedLandmark[]> {
  const pois = offline?.available
    ? offline.nearestPois(geo.lat, geo.lon, 2000, 10)
    : await osmPoisNear(geo.lat, geo.lon);
  if (pois.length === 0) return [];
  const picked = await llmPickLandmarks(cfg, { ...c, lat: geo.lat, lon: geo.lon }, pois);
  const out: FeedLandmark[] = [];
  for (const rawName of picked) {
    const name = sanitizeLandmarkAnswer(rawName, c.address);
    if (!name) continue;
    // Attach the POI's type/distance when the pick matches a list entry.
    const norm = (x: string) => x.toLowerCase().replace(/\s+/g, ' ');
    const poi = pois.find(p => norm(p.name) === norm(name) || norm(p.name).includes(norm(name)) || norm(name).includes(norm(p.name)));
    out.push({
      landmark: name,
      type: poi?.type ?? 'place',
      distance_m: poi?.distance_m,
      maps_url: googleMapsLink(name),
    });
  }
  return out;
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

/** Candidates in LOCAL mode: feed addresses without a precise row + the
 *  runtime's pending landmark_requested events. */
async function localCandidates(db: Db): Promise<Array<{ address?: string; location?: string }>> {
  const store = new LandmarkStore(db);
  const events = new EventStore(db);
  const props = new PropertyService(loadConfig().propertyDataUrl);
  const candidates: Array<{ address?: string; location?: string }> = [];
  for (const p of await props.getAll()) {
    const key = landmarkCacheKey(p);
    if (store.get(key) && store.get(key)!.source !== 'table') continue;
    if (!p.address && !p.location) continue;
    if (p.address && isJunkAddress(p.address)) continue;
    candidates.push({ address: p.address, location: p.location });
  }
  for (const ev of events.listPending('landmark_requested')) {
    const payload = JSON.parse(ev.payload) as { address?: string; location?: string };
    if (payload.address && isJunkAddress(payload.address)) continue;
    if (!store.get(landmarkCacheKey(payload))) candidates.push(payload);
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
    const pushUrl = cfg.hermesLandmarksWriteUrl;
    if (!pushUrl) console.log('[hermes-landmarks] HERMES_LANDMARKS_WRITE_URL not set — REPORT MODE (nothing pushed).');
    else if (!configured) console.log('[hermes-landmarks] HERMES_LLM_API_KEY / HERMES_LLM_MODEL not set — REPORT MODE (nothing resolved).');
    else if (dryRun) console.log('[hermes-landmarks] --dry-run: reporting candidates, nothing written, no LLM calls.');

    const props = new PropertyService(cfg.propertyDataUrl);
    const all = await props.getAll();
    // The property row itself is the job: address present + no landmark list yet.
    const candidates = all.filter(p => !!p.address && !isJunkAddress(p.address) && (!p.landmarks || p.landmarks.length === 0));
    // Local OSM map (T60 plan): geocode + POIs come from SQLite when present;
    // live Nominatim/Overpass remain the fallback (missing map, unmatched
    // street, empty POI ring).
    const offline = new OfflineMapStore(cfg.skopjePoisDb);
    const stats = offline.available ? offline.stats() : null;
    console.log(`[hermes-landmarks] offline map: ${stats ? `${stats.pois} POIs / ${stats.addresses} addresses` : 'NOT PRESENT (live OSM fallback)'} — ${cfg.skopjePoisDb}`);
    console.log(`[hermes-landmarks] ${candidates.length} candidate(s) without a resolved landmark list.`);
    let resolved = 0;
    let failed = 0;
    for (const c of candidates) {
      const label = `${c.address}${c.location ? ` (${c.location})` : ''}`;
      if (!pushUrl || !configured || dryRun) {
        console.log(`  candidate: ${label}`);
        failed++;
        continue;
      }
      try {
        // Local geocode first (Latin↔Cyrillic street match), live Nominatim fallback.
        // Landmark-style addresses ("Кај Бранка", "Палома Бјанка") are looked up
        // directly in the POI table — they aren't streets.
        let geo = offline.available
          ? offline.geocodeAddress(c.address) ?? await geocodeOsm(c.address, c.location)
          : await geocodeOsm(c.address, c.location);
        if (!geo && offline.available) {
          const poi = offline.findPoiByName(c.address);
          if (poi) geo = { lat: poi.lat, lon: poi.lon, street: poi.name } as any;
        }
        if (!geo) {
          console.log(`  ✗ ${label} — не може да се геокодира (останува табелата)`);
          failed++;
          continue;
        }
        const list = await rankedLandmarks(cfg, { address: c.address, location: c.location }, geo, offline);
        // Rate-limit: 2s between LLM calls to avoid 429 on NIM free tier.
        await sleep(LLM_DELAY_MS);
        if (list.length === 0) {
          console.log(`  ✗ ${label} — нема јавни места во радиус 2 км (останува табелата)`);
          failed++;
          continue;
        }
        const res = await fetch(pushUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', [cfg.hermesAuthHeader]: cfg.hermesToken },
          body: JSON.stringify({ property_number: c.eb, landmarks: list }),
        });
        const body = await res.json().catch(() => ({})) as { unchanged?: boolean };
        if (!res.ok) {
          console.log(`  ✗ ${label} — edge function HTTP ${res.status}`);
          failed++;
          continue;
        }
        resolved++;
        console.log(`  ✓ ${label} → ${list.map(l => `„${l.landmark}“ (${l.distance_m ?? '?'}м)`).join(', ')}${body.unchanged ? ' (unchanged)' : ''}`);
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
  const remoteResults: Array<{ address?: string; location?: string; landmark: string; type: string; maps_url: string }> = [];

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
        remoteResults.push({ address: c.address, location: c.location, landmark, type: 'llm', maps_url: mapsUrl });
      } else if (store && events) {
        store.put(landmarkCacheKey(c), { landmark, type: 'llm', mapsUrl, source: 'hermes' });
        for (const ev of events.listPending('landmark_requested')) {
          const payload = JSON.parse(ev.payload) as { address?: string; location?: string };
          if (landmarkCacheKey(payload) === landmarkCacheKey(c)) events.resolve(ev.id);
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

main().catch(e => {
  console.error('[hermes-landmarks] fatal:', e);
  process.exit(1);
});
