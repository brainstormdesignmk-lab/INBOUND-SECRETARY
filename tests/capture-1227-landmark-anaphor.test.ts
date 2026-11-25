// THE [12:27–12:28] CAPTURE — three answers that came apart on one flat.
//
//   [12:27] «КАДЕ ТОЧНО СЕ НАОЃА ?»
//           → «Тоа се наоѓа во близина на Kindergarten "Kocho Racin"…» + a bare
//             coordinate pin   ← the landmark is right now, the LINK is not
//   [12:28] «НА КОЛКАВО РАСТОЈАНИЕ Е ОД ГРАДИНКАВА ?»
//           → «Не, тоа е на 1,6 километри од Меморијален центар на
//              холокаустот на Евреите од Македонија, а недвижноста е во
//              Центар.»                                    ← a different place
//   [12:27] «Се разбира. Еве ги деталите…»
//           → «…Се наоѓа во близина на ПЗУ Аптека Линцура 2…»  ← the pharmacy
//             the claim rule had already removed from the «каде?» answer
//
// The causes, each pinned below:
//   1. A DISTANCE QUESTION WAS READ AS A PLACE CONFIRM. The confirm lane claims
//      any message with a place word and a trailing «?»; «на колкаво растојание
//      е од …» matched it, its place extraction then built the candidate out of
//      the QUESTION («КОЛКАВО РАСТОЈАНИЕ Е ОД»), and the map's fuzzy pass bound
//      that to the Holocaust memorial centre 1,6 km away. The distance lane owns
//      a measurement ask (detect-level veto + candidate guard).
//   2. THE DESTINATION WAS A CLASS NOUN. «ГРАДИНКАВА» is the kindergarten the
//      chat had just named, but it is a bare class word with a definite suffix:
//      the map has no name to look up, so the distance lane found nothing and
//      fell through — into the lane above. The rotation now stores each slot's
//      map type, and a class noun binds to it (placeTypesFromNoun).
//   3. THE CARD READ THE RAW FEED ROSTER. The roster was ranked by DISTANCE at
//      import, so the pharmacy in the flat's own building stays first forever —
//      the claim rule was applied to the rotation and the import resolver only,
//      and every reply builder prints `landmarks[0]`. ONE screen at the service
//      door now filters the roster for every builder at once.
//   4. THE LINK HAD NO CARD. A bare `?q=lat,lon` names nothing (the owner's
//      [12:27] verdict), so a landmark with map identity serves the place CARD
//      first and the PIN second.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig } from '../src/config';
import { Db } from '../src/store/db';
import { SessionStore, freshSession } from '../src/fsm/session';
import { Classifier } from '../src/llm/classify';
import { Responder } from '../src/llm/respond';
import { PropertyService, Property } from '../src/data/properties';
import { AppointmentStore } from '../src/store/appointments';
import { EscalationStore } from '../src/store/escalations';
import { MetaStore } from '../src/store/meta';
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LlmClient } from '../src/llm/types';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore, writeMap } from '../src/geo/offlineMap';
import { buildPropertyCard, displayPlaceName } from '../src/llm/prompts';
import { placeTypesFromNoun } from '../src/llm/lexicon';
import { canonicalPoisDb } from '../src/config';
import { findProjectRoot } from './helpers/project-root';
import {
  isPoiConfirmQuestion, extractPoiConfirmPlace, isDistanceQuestion, extractDistancePlaces,
} from '../src/llm/deterministic';

const ASK_DISTANCE = 'НА КОЛКАВО РАСТОЈАНИЕ Е ОД ГРАДИНКАВА ?';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429'); }
}

/** The [10:24] block, as the live map holds it: the pharmacy 94 m away with no
 *  reviews (a storefront in the flat's own building), the kindergarten 174 m
 *  away with six — the place the neighbourhood actually names. */
const PHARMACY = {
  name: 'ПЗУ Аптека Линцура 2', type: 'Pharmacy',
  lat: 41.99560, lon: 21.41518, source: 'google', review_count: 0,
};
const KINDERGARTEN = {
  name: 'Kindergarten "Kocho Racin" - Naum N. Borche', type: 'Kindergarten',
  lat: 41.99727, lon: 21.41594, source: 'google', review_count: 6,
  place_id: '0x1354144883450a07:0xb954062264c6a4c4',
};

const ROSTER = [
  { landmark: PHARMACY.name, type: 'Pharmacy', distance_m: 94,
    maps_url: `https://maps.google.com/?q=${PHARMACY.lat},${PHARMACY.lon}` },
  { landmark: KINDERGARTEN.name, type: 'Kindergarten', distance_m: 174,
    maps_url: `https://maps.google.com/?q=${KINDERGARTEN.lat},${KINDERGARTEN.lon}` },
];

const EB50: Property = {
  eb: 50, id: 50, location: 'Центар', address: 'Ул. Тест 50',
  price: 300, service: 'rent', sqm: 74, bedrooms: 2, house: true,
  details: 'Куќа во Центар, мирно катче со тераса и двор.',
  lat: 41.9962, lon: 21.4147, geo_source: 'stored',
  landmarks: ROSTER as never,
} as unknown as Property;

function buildMap(): OfflineMapStore {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'c1227-')), 'map.db');
  writeMap(dbPath, [PHARMACY, KINDERGARTEN] as never, []);
  return new OfflineMapStore(dbPath);
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getById(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  get healthy(): boolean { return true; }
}

function makeHandler(props: PropertyService, map: OfflineMapStore) {
  const db = new Db(':memory:');
  const cfg = loadConfig();
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, props),
    responder: new Responder(new FailingLlm(), cfg),
    properties: props,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: map }),
  });
  return { handler, sessions, sent, db };
}

// ── 1. the lane that must NOT own a measurement ask ─────────────────────────
test('a distance question is never a place confirm (the candidate was the question itself)', () => {
  assert.equal(isPoiConfirmQuestion(ASK_DISTANCE), false,
    'the confirm lane must stand down: the distance lane owns a measurement ask');
  assert.equal(extractPoiConfirmPlace(ASK_DISTANCE), undefined,
    'never hand the map «КОЛКАВО РАСТОЈАНИЕ Е ОД» — that is how the Holocaust memorial became the answer');
  // The distance readers still see it, and they see the CLASS NOUN as the place.
  assert.equal(isDistanceQuestion(ASK_DISTANCE), true);
  assert.deepEqual(extractDistancePlaces(ASK_DISTANCE), ['ГРАДИНКАВА']);
});

// ── 2. a class noun names the place the chat just served ────────────────────
test('the class vocabulary binds «градинкава» to the map type, a real name to nothing', () => {
  assert.deepEqual(placeTypesFromNoun('ГРАДИНКАВА'), ['kindergarten', 'preschool']);
  assert.deepEqual(placeTypesFromNoun('училиштето'), ['school', 'primary_school', 'secondary_school']);
  assert.deepEqual(placeTypesFromNoun('аптекава'), ['pharmacy', 'chemist']);
  assert.equal(placeTypesFromNoun('Kocho Racin'), undefined, 'a NAME is the map search\'s job');
  // A NAME THAT ENDS IN A CLASS NOUN IS STILL A NAME. «SITI MOL» is the mall's
  // own name; reading the trailing «мол» as the CLASS bound a mall question to
  // the last mall slot on the rotation instead of measuring to Сити Мол
  // (tests/capture-0443-stock-place-and-buy.test.ts caught it on the full run).
  assert.equal(placeTypesFromNoun('SITI MOL'), undefined, 'the name is not the class');
  assert.equal(placeTypesFromNoun('трговски центар'), undefined,
    'two content words are a NAME, not a bare class noun');
  // …while the prepositions the client wraps around the class still bind.
  assert.deepEqual(placeTypesFromNoun('до градинкава'), ['kindergarten', 'preschool']);
  assert.deepEqual(placeTypesFromNoun('во молот'), ['mall', 'shopping_mall', 'department_store']);
  assert.equal(placeTypesFromNoun('паркинг'), undefined, '«паркинг» is not a park');
});

// ── 3. the field sequence, end to end ──────────────────────────────────────
test('[12:27→12:28] «каде?» then «на колкаво растојание е од градинкава?» answers the kindergarten', async () => {
  const map = buildMap();
  const { handler, sessions, sent } = makeHandler(new FakeProps([EB50]), map);
  const s = freshSession('test', 'c1227-anaphor');
  s.slots.propertyId = 50;
  s.slots.interestedPropertyId = 50;
  sessions.set(s);

  await handler.handle('test', 'c1227-anaphor', 'КАДЕ ТОЧНО СЕ НАОЃА ?');
  const where = sent[sent.length - 1]!;
  // THE COPY IS MACEDONIAN: the map's Latin name is rendered for the client
  // («Градинка "Кочо Рацин" - Наум Н. Борче» — displayPlaceName; the owner's
  // «before the landmarks were Cyrillic» note). The MAP still spells it in
  // Latin; only the copy changes, so the assertion is on the rendered form.
  assert.match(where, /Градинка "Кочо Рацин"/u, `the claim rule serves the kindergarten: ${where}`);
  assert.doesNotMatch(where, /Линцура/u, `never the pharmacy in the flat's own building: ${where}`);
  // …and the link Names the place, not just a point (the owner's [12:27] ask).
  assert.match(where, /maps\.google\.com\/\?cid=\d+/u, `the landmark link must be a place CARD: ${where}`);
  assert.match(where, /maps\.google\.com\/\?q=41\.\d+,21\.\d+/u, `…and the pin still shows WHERE: ${where}`);

  await handler.handle('test', 'c1227-anaphor', ASK_DISTANCE);
  const answer = sent[sent.length - 1]!;
  assert.match(answer, /Градинка "Кочо Рацин"/u,
    `the destination «градинкава» IS the kindergarten just named: ${answer}`);
  assert.match(answer, /\d+\s*метри/u, `and its distance is MEASURED, not invented: ${answer}`);
  assert.doesNotMatch(answer, /Меморијален|холокауст/u,
    `never an unrelated place — that was the [12:28] bug: ${answer}`);
  assert.doesNotMatch(answer, /^\s*Не, тоа е/u,
    `a measurement is not a denial: ${answer}`);
  assert.doesNotMatch(answer, /не можам да го пронајдам/u, `the destination is known: ${answer}`);
  map.close();
});

// ── 4. one card, two readers: the rotation AND the info block ──────────────
test('the info block reads the same claim-screened roster as the «каде?» answer', () => {
  const map = buildMap();
  const db = new Db(':memory:');
  const svc = new LandmarkService(db, { osm: false, offlineMap: map });
  const screened = svc.screenFeedLandmarks(EB50 as never);
  assert.ok(screened, 'a measurable roster is screened, never left alone');
  assert.deepEqual(screened!.map(e => e.landmark), [KINDERGARTEN.name],
    `only the place a client could name survives: ${JSON.stringify(screened)}`);
  assert.equal(screened![0]!.distance_m, 157,
    'the distance is RE-MEASURED from the row\'s own centre, never the stored import-time number');
  const card = buildPropertyCard({ ...EB50, landmarks: screened } as never);
  assert.match(card, /Градинка "Кочо Рацин"/u, `the card names the kindergarten: ${card}`);
  assert.doesNotMatch(card, /Линцура/u, `the card must not keep the pharmacy the chat dropped: ${card}`);
  map.close();
});

// ── 5. the rotation is the WHOLE memory, at every site that writes it ───────
// A rotation written as names only (the seven pre-resolve sites did) breaks
// TODAY'S contract twice: a follow-up «каде?» on that turn serves a bare pin
// (no place card — the owner's complaint) and the anaphor resolver finds no
// type to bind «градинкава» to. The sites are seven and grow silently, so the
// guard is structural: EVERY `nearbyLandmarks = <var>.map(n => n.landmark)` in
// the handler must write its own place_ids and types in the same block.
test('every rotation write carries the parallel arrays (no lane serves a bare pin)', () => {
  // findProjectRoot, not `__dirname/..`: the compiled runner bundles this file
  // OUTSIDE the repo tree, so a relative walk lands in dist-test/ and the guard
  // dies with ENOENT instead of checking the source it exists to check.
  const src = fs.readFileSync(path.join(findProjectRoot(__dirname), 'src', 'handlers', 'inbound.ts'), 'utf8')
    .split('\n');
  const writes = src
    .map((line, i) => ({ line, i }))
    .filter(x => /nearbyLandmarks = \w+\.map\(n => n\.landmark\)/u.test(x.line));
  assert.ok(writes.length >= 6, `the rotation sites are read: ${writes.length}`);
  for (const { line, i } of writes) {
    const name = /nearbyLandmarks = (\w+)\.map/u.exec(line)![1]!;
    const block = src.slice(i, i + 6).join('\n');
    assert.match(block, new RegExp(`nearbyLandmarkPlaceIds = ${name}\\.map\\(n => n\\.place_id`, 'u'),
      `site ${i + 1} writes no place_ids — the follow-up would serve a pin with no card:\n${block}`);
    assert.match(block, new RegExp(`nearbyLandmarkTypes = ${name}\\.map\\(n => n\\.type`, 'u'),
      `site ${i + 1} writes no types — «градинкава» could not bind:\n${block}`);
  }
});

// ── 6. the screen is INSTALLED by the handler, not just available ──────────
// It is installed ONCE, at construction, never per turn. The live EB 50 probe
// caught why: the per-turn install ran AFTER the feed's first fetch, and
// PropertyService screened rows only while BUILDING its cache — so every later
// read of that cache served the pharmacy again in the property block, which is
// exactly the owner's [12:27] complaint. Both halves are pinned here: the
// handler's install (this test) and the service's read-time screen (below).
test('the handler installs the claim screen at construction (a read before any turn is screened)', async () => {
  const map = buildMap();
  const real = new PropertyService('http://feed.test');
  const fetchStub = (async () => ({
    ok: true, status: 200,
    json: async () => ({ properties: [{
      evidenten_broj: 50, naselba: 'Центар', adresa: 'Ул. Тест 50', opis: 'Куќа во Центар.',
      cena_eur: 300, povrsina_m2: 74, servis: 'rent',
      lat: 41.9962, lon: 21.4147, geo_source: 'stored',
      // The edge function hands JSONB over as an ARRAY (parseFeedLandmarks
      // accepts nothing else); the roster is the pharmacy-first one the feed
      // really stores for EB 50.
      landmarks: ROSTER,
    }] }),
  })) as unknown as typeof fetch;
  const savedFetch = globalThis.fetch;
  globalThis.fetch = fetchStub;
  try {
    const { handler } = makeHandler(real, map);
    // NO TURN YET. The feed's first fetch, a prefetch and the TUI's own card
    // all read the service before handle() ever runs.
    const row = await real.getByEb(50);
    assert.ok(row, 'the feed row is loaded through the real service');
    assert.deepEqual(row!.landmarks?.map(l => l.landmark), [KINDERGARTEN.name],
      `the first read of the process must already be screened: ${JSON.stringify(row!.landmarks)}`);
    // …and a turn neither clears the screen nor re-serves the raw roster.
    await handler.handle('test', 'c1227-door', 'zdravo');
    const after = await real.getByEb(50);
    assert.deepEqual(after!.landmarks?.map(l => l.landmark), [KINDERGARTEN.name],
      `the screen survives the turn: ${JSON.stringify(after!.landmarks)}`);
  } finally {
    globalThis.fetch = savedFetch;
    map.close();
  }
});

// ── 8. THE ENTRY'S OWN CLASS, for every property (the owner's «rule, not
// patches») — EB 53 is the sibling of this capture: its roster led with
// «Pharmacy Biser» (12 reviews), and the map made it ADMISSIBLE by carrying a
// second row with the pharmacy's own name typed «Shopping mall» (a data error
// that lent its durable class to a storefront). The entry's declared type now
// decides durability; twins donate only their review count. A pharmacy the map
// EVIDENCES is still a landmark (tests/landmark-claim-relevance.test.ts) — the
// rule refuses an unevidenced branch, not the class.
test('a same-name mall row cannot lend its class to a pharmacy (the EB 53 shape)', async () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'c1227-ph-')), 'map.db');
  writeMap(dbPath, [
    { name: 'Pharmacy Biser', type: 'Pharmacy', lat: 41.98484, lon: 21.46604, source: 'google', review_count: 12 },
    // the map's own mis-typed twin: same name, mall class, same 12 reviews
    { name: 'Pharmacy Biser', type: 'Shopping mall', lat: 41.98484, lon: 21.46604, source: 'google', review_count: 12 },
    { name: 'Deni Market', type: 'Supermarket', lat: 41.98431, lon: 21.46531, source: 'osm' },
  ] as never, []);
  const map = new OfflineMapStore(dbPath);
  const real = new PropertyService('http://feed.test');
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true, status: 200,
    json: async () => ({ properties: [{
      evidenten_broj: 53, naselba: 'Аеродром', adresa: 'Ул. ТЦ Бисер 2', opis: 'Двособен стан.',
      cena_eur: 55000, povrsina_m2: 44, servis: 'buy',
      lat: 41.9848, lon: 21.466, geo_source: 'google_cached',
      landmarks: [
        { landmark: 'Pharmacy Biser', type: 'Pharmacy', distance_m: 35, maps_url: 'https://maps.google.com/?q=41.98484,21.46604' },
        { landmark: 'Deni Market', type: 'Supermarket', distance_m: 80, maps_url: 'https://maps.google.com/?q=41.98431,21.46531' },
      ],
    }] }),
  })) as unknown as typeof fetch;
  try {
    const svc = new LandmarkService(new Db(':memory:'), { osm: false, offlineMap: map });
    real.setLandmarkScreen(p => svc.screenFeedLandmarks({
      id: p.id, eb: p.eb, address: p.address, landmark_name: p.landmark,
      lat: p.lat, lon: p.lon, geo_source: p.geo_source ?? null,
      details: p.details, landmarks: p.landmarks,
    } as never));
    const row = await real.getByEb(53);
    const names = (row!.landmarks ?? []).map(l => l.landmark);
    assert.ok(!names.some(n => /аптек|pharmac/iu.test(n)), `no pharmacy may anchor the card: ${names.join(' | ')}`);
    assert.ok(names.includes('Deni Market'), `the supermarket neighbour stays (кај Тинекс): ${names.join(' | ')}`);
    const card = buildPropertyCard(row!);
    assert.doesNotMatch(card, /аптек|pharmac/iu, `the card must not name a pharmacy: ${card}`);
  } finally {
    globalThis.fetch = savedFetch;
    map.close();
  }
});

// ── 9. THE NAME IS RENDERED, for EVERY property (the owner's rule) ─────────
test('every Latin landmark name reaches the client in Macedonian', () => {
  // The fold is a MACEDONIAN transliteration: right for the names the map
  // carries in that spelling, wrong for English words.
  assert.equal(displayPlaceName('Kindergarten "Kocho Racin" - Naum N. Borche'),
    'Градинка "Кочо Рацин" - Наум Н. Борче');
  assert.equal(displayPlaceName('Elipso 2 Madzari'), 'Елипсо 2 Маџари');
  assert.equal(displayPlaceName('Pharmacy Biser'), 'Аптека Бисер');
  // AN ENGLISH NAME IS TRANSLATED + FOLDED THE ENGLISH WAY — never left Latin
  // (the owner: «before the landmarks were Cyrillic, now: Crescendo School of
  // Music & Ballet»), and never Macedonian-folded either («Мусиц»,
  // «Елизабетх», «Цресцендо» were the defect).
  assert.equal(displayPlaceName('Crescendo School of Music & Ballet'),
    'Кресендо училиште за музика и балет');
  assert.equal(displayPlaceName('Elizabeth Apart House'), 'Елизабет апартманска куќа');
  assert.equal(displayPlaceName('AgroTehnA - Head Office'), 'Агротехна - седиште');
  assert.equal(displayPlaceName('State school'), 'Државно училиште');
  // A DIACRITIC is a Latin letter, not decoration: a half-folded name
  // («Виола Капиšтец») is broken script on the client's screen.
  assert.equal(displayPlaceName('Viola Kapištec'), 'Виола Капиштец');
  // A run of x is ONE «кс» (the Cineplexx cinema).
  assert.equal(displayPlaceName('Cineplexx'), 'Цинеплекс');
  // THE RULE OVER THE WHOLE CORPUS, not over the names that happened to fail:
  // the shipped map's every PURE-LATIN place name must reach the client in
  // Cyrillic. The only ones allowed to stay Latin are the ones the render cap
  // itself refuses (a long English sentence is prose, not a place name — the
  // pseudo-Cyrillic would be worse than the Latin).
  const map = new OfflineMapStore(canonicalPoisDb()!);
  const left: string[] = [];
  for (const name of map.allNames()) {
    if (!/[A-Za-z\u00C0-\u024F]/u.test(name) || /[\u0400-\u04FF]/u.test(name)) continue;
    const out = displayPlaceName(name);
    if (!/[A-Za-z\u00C0-\u024F]/u.test(out)) continue;
    // the cap counts the words the renderer has no spelling for
    const words = out.trim().split(/\s+/).filter(w => /\p{L}/u.test(w));
    if (words.length > 6) continue;
    left.push(`${name} → ${out}`);
  }
  map.close();
  assert.deepEqual(left, [], `every Latin place name reads Macedonian: ${left.join(' | ')}`);
});

// ── 7. a cache filled before the screen existed is screened ON READ ─────────
// The screen is installed at construction, but PropertyService must not depend
// on that ordering: its cache lives for five minutes, and a row built before
// the install (or by any other reader) has to be screened when it is handed
// out. This is the exact shape the live probe found — screen at build time
// only, raw pharmacy in the card forever after.
test('a roster cached before the screen exists is screened on read, not just at build', async () => {
  const map = buildMap();
  const real = new PropertyService('http://feed.test');
  const fetchStub = (async () => ({
    ok: true, status: 200,
    json: async () => ({ properties: [{
      evidenten_broj: 50, naselba: 'Центар', adresa: 'Ул. Тест 50', opis: 'Куќа во Центар.',
      cena_eur: 300, povrsina_m2: 74, servis: 'rent',
      lat: 41.9962, lon: 21.4147, geo_source: 'stored',
      landmarks: ROSTER,
    }] }),
  })) as unknown as typeof fetch;
  const savedFetch = globalThis.fetch;
  globalThis.fetch = fetchStub;
  try {
    // 1. the cache is filled with the feed's own (pharmacy-first) roster.
    const before = await real.getByEb(50);
    assert.deepEqual(before!.landmarks?.map(l => l.landmark), [PHARMACY.name, KINDERGARTEN.name],
      'the fixture starts from the real roster order');

    // 2. the screen arrives afterwards, as it does at boot.
    const svc = new LandmarkService(new Db(':memory:'), { osm: false, offlineMap: map });
    real.setLandmarkScreen(p => svc.screenFeedLandmarks({
      id: p.id, eb: p.eb, address: p.address, landmark_name: p.landmark,
      lat: p.lat, lon: p.lon, geo_source: p.geo_source ?? null,
      details: p.details, landmarks: p.landmarks,
    } as never));

    // 3. the cache HIT must still be screened — and the cached row untouched.
    const after = await real.getByEb(50);
    assert.deepEqual(after!.landmarks?.map(l => l.landmark), [KINDERGARTEN.name],
      `a cached roster read after the install is screened: ${JSON.stringify(after!.landmarks)}`);
    assert.deepEqual(before!.landmarks?.map(l => l.landmark), [PHARMACY.name, KINDERGARTEN.name],
      'the screen returns a new row, never mutates the cached one');
  } finally {
    globalThis.fetch = savedFetch;
    map.close();
  }
});
