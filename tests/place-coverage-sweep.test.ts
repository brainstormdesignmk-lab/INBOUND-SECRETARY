/**
 * THE CLASS-LEVEL GUARANTEE BEHIND [23:26] — no place, present or future, may
 * be dropped between the client's words and the search's geography.
 *
 *   [23:26] ZDRAVO SAKAM DA KUPAM STAN BLISKU DO ZELEZNICKA STANICA
 *   [23:26] ЛИНА: Кој дел од градот Ви е најпривлечен …?          ← the bug
 *
 * The single incident was not one bad string. It was a CLASS, and every member
 * of the class produces the same sentence: a client names a place the map
 * actually holds, the lookup answers with ONE row, that row hides the client's
 * words behind a qualifier («Стара Железничка Станица»), the name-coverage
 * guard — correctly — refuses a name that does not OPEN with the client's words,
 * and the place dies. The funnel then asks «во кој дел од градот…?» about a
 * place he just named.
 *
 * The repair is structural, so the tests are structural too:
 *   1. the guard never refuses a map name against itself (every row, today's
 *      table and any future rebuild — the cheap invariant over all 5.7k rows);
 *   2. every leading name in the table can be reached even when a qualified
 *      row shadows it — the second-chance lookup (findPoisByName) must return a
 *      row the guard accepts (stratified over the landmark types clients name);
 *   3. the real pipeline, in every phrasing a client uses, anchors the search
 *      on the place and NEVER asks for a neighbourhood.
 *
 * Adding a property or a place must not require editing this file: the sweep
 * reads the shipped map, and the phrase matrix runs the shipped handler.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config';
import { Db } from '../src/store/db';
import { SessionStore } from '../src/fsm/session';
import { Classifier } from '../src/llm/classify';
import { Responder } from '../src/llm/respond';
import { PropertyService, Property } from '../src/data/properties';
import { AppointmentStore } from '../src/store/appointments';
import { EscalationStore } from '../src/store/escalations';
import { MetaStore } from '../src/store/meta';
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler, poiNameCoversClientWords } from '../src/handlers/inbound';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';
import { LlmClient } from '../src/llm/types';

const cfg = loadConfig();

type Row = { name: string; type: string; lat: number; lon: number };

/** The shipped POI table, read-only. The store has no listing API (nothing in
 *  production needs one), so the sweep opens the same rows its lookups scan. */
function allRows(map: OfflineMapStore): Row[] {
  const db = (map as unknown as { db: { prepare: (q: string) => { all: () => Row[] } } }).db;
  return db.prepare('SELECT name, type, lat, lon FROM pois').all();
}

/** The types clients actually name as a search anchor ("блиску до <place>").
 *  Restaurants/cafés are included — «до Броз кафе» is a real capture — while
 *  bare OSM `yes` rows (building fragments) are not places anyone points at. */
const LANDMARK_TYPES = new Set([
  'train_station', 'bus_station', 'mall', 'hospital', 'university', 'school',
  'diplomatic', 'marketplace', 'place_of_worship', 'museum', 'government',
  'hotel', 'Hotel', 'supermarket', 'Supermarket', 'bank', 'Bank', 'pharmacy',
  'Pharmacy', 'cafe', 'restaurant', 'fuel', 'place',
]);

const wordsOf = (name: string): string[] =>
  name.split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 0);

test('the guard never refuses a place against its own map name (every row)', () => {
  const map = new OfflineMapStore(cfg.skopjePoisDb);
  try {
    const rows = allRows(map);
    assert.ok(rows.length > 1000, `the shipped map must be present, got ${rows.length} rows`);
    const refused = rows.filter(r => !poiNameCoversClientWords(r.name, r.name)).map(r => r.name);
    assert.deepEqual(refused.slice(0, 8), [],
      `${refused.length} map rows name themselves and are still refused by the guard`);
  } finally { map.close(); }
});

test('a leading place name is reachable even when a qualified row shadows it', () => {
  const map = new OfflineMapStore(cfg.skopjePoisDb);
  try {
    const rows = allRows(map);
    // Stratify over the landmark types: clients point at these, and the set is
    // stable as the map grows (a new row joins its type's stride automatically).
    const landmarks = rows.filter(r => LANDMARK_TYPES.has(r.type) && wordsOf(r.name).length >= 2);
    assert.ok(landmarks.length > 50, `landmark rows found: ${landmarks.length}`);
    const stride = Math.max(1, Math.ceil(landmarks.length / 120));
    const sample = landmarks.filter((_, i) => i % stride === 0);
    // The incident's family, pinned by name whatever the stride lands on.
    for (const must of ['Железничка станица Скопје', 'Автобуска станица Скопје']) {
      if (rows.some(r => r.name === must) && !sample.some(r => r.name === must)) {
        const row = rows.find(r => r.name === must)!;
        sample.push(row);
      }
    }
    const misses: string[] = [];
    for (const row of sample) {
      // The BARE name a client would say: the first two words of the row. A
      // one-letter head is an abbreviation fragment («Ф-КА РЕПЛЕК»), not a
      // phrase anyone types, so it is not a client name to cover.
      const head = wordsOf(row.name);
      if (head.length < 2 || head[0].length < 2 || head[1].length < 2) continue;
      const lead = head.slice(0, 2).join(' ');
      if (lead.length < 4) continue;
      // The single fuzzy hit may be a qualified namesake; the SWEEP is whether
      // the map can still produce a row that opens with the client's words.
      const covering = map.findPoisByName(lead, 8)
        .some(c => poiNameCoversClientWords(lead, c.name));
      if (!covering) misses.push(`${lead}  (map row: ${row.name})`);
    }
    assert.deepEqual(misses.slice(0, 8), [],
      `${misses.length} client-nameable places have no row the guard accepts: ${misses.slice(0, 8).join(' | ')}`);
  } finally { map.close(); }
});

// ── 3. THE REAL PIPELINE, IN EVERY PHRASING ────────────────────────────────
// The words a client actually types around a place: the buy wish, the "around"
// search, and the "near" search. All three must hand the place to the search.

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

// A feed with rows around every area the places below sit in, so the funnel
// can seed a district from the map without ever asking the client for one.
const ROWS: Property[] = [
  { eb: 401, id: 401, location: 'Центар', address: 'Ул. Браќа Миладиновци 4', price: 118000, bedrooms: 2, sqm: 58, size: '58 м²', service: 'buy', lat: 41.9918, lon: 21.4452 },
  { eb: 402, id: 402, location: 'Центар', address: 'Ул. Македонија 3', price: 128000, bedrooms: 2, sqm: 60, size: '60 м²', service: 'buy', lat: 41.9954, lon: 21.4310 },
  { eb: 403, id: 403, location: 'Карпош', address: 'Ул. Карпош 9', price: 96000, bedrooms: 2, sqm: 57, size: '57 м²', service: 'buy', lat: 42.0050, lon: 21.4100 },
  { eb: 404, id: 404, location: 'Аеродром', address: 'Ул. Јане Сандански 20', price: 99000, bedrooms: 2, sqm: 56, size: '56 м²', service: 'buy', lat: 41.9800, lon: 21.4500 },
];

function makeHandler() {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const properties = new FakeProps(ROWS);
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, properties),
    responder: new Responder(new FailingLlm(), cfg),
    properties,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
  });
  return { handler, sessions, sent };
}

/** Places across the families a client names — station, mall, market, hospital,
 *  church, venue — each of which the shipped map holds. */
const PLACES = [
  'ZELEZNICKA STANICA',
  'AVTOBUSKA STANICA SKOPJE',
  'BIT PAZAR',
  'TC RAMSTOR',
  'KLINICKI CENTAR',
  'SKOPJE CITY MOL',
  'KATOLICKA',
  'UNIVERZALNA SALA',
];

const TEMPLATES = [
  (p: string) => `ZDRAVO SAKAM DA KUPAM STAN BLISKU DO ${p}`,
  (p: string) => `BARAM STAN OKOLU ${p}`,
  (p: string) => `MI TREBA STAN VO BLIZINA NA ${p}`,
];

const AREA_QUESTION_RE = /дел од градот|населба|омилена локација|lokacija vo gradot/iu;

test('every place × every phrasing gives the search its geography and never asks for a neighbourhood', async () => {
  // THE CONTRACT: the client named a place, so the search must END UP WITH a
  // geography — the anchor, or the feed's own district — and must never ask the
  // question this incident is about: «во кој дел од градот…?».
  const failures: string[] = [];
  for (const place of PLACES) {
    for (const tpl of TEMPLATES) {
      const text = tpl(place);
      const { handler, sessions, sent } = makeHandler();
      const chatId = `sweep-${place}-${TEMPLATES.indexOf(tpl)}`;
      await handler.handle('test', chatId, text);
      const s = sessions.get(chatId)!;
      const answer = sent[0] ?? '';
      if (!s.slots.poiAnchor && !s.slots.location) failures.push(`no geography: «${text}» → ${answer.replace(/\n/g, ' ')}`);
      else if (AREA_QUESTION_RE.test(answer)) failures.push(`area asked: «${text}» → ${answer.replace(/\n/g, ' ')}`);
      else if (s.state !== 'discovery') failures.push(`state ${s.state}: «${text}»`);
    }
  }
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('a place whose name ENDS in an area word is the place, not the district', async () => {
  // «КЛИНИЧКИ ЦЕНТАР» ends in «Центар», and the feed files rows under «Центар»:
  // the intake used to drop the place (the area was read as the ask) and search
  // the whole district. The hospital is a map place, the client said its own
  // name, and the anchor must be it — the district then FOLLOWS the place.
  // The neighbourhood reading is untouched: «kaj vas vo novo lisice» stays the
  // area (and never becomes the post office «ELS Novo Lisice»).
  for (const tpl of TEMPLATES) {
    const text = tpl('KLINICKI CENTAR');
    const { handler, sessions, sent } = makeHandler();
    const chatId = `area-word-${TEMPLATES.indexOf(tpl)}`;
    await handler.handle('test', chatId, text);
    const s = sessions.get(chatId)!;
    assert.equal(s.slots.poiAnchor, 'Клинички центар',
      `the hospital is the anchor: «${text}» → ${s.slots.poiAnchor}`);
    assert.doesNotMatch(sent[0] ?? '', AREA_QUESTION_RE, `never the area question: ${sent[0]}`);
  }
});

test('the incident itself, on the shipped map, with the LLM off', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'sweep-2326';
  await handler.handle('test', chatId, 'ZDRAVO SAKAM DA KUPAM STAN BLISKU DO ZELEZNICKA STANICA');
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.poiAnchor, 'Железничка станица Скопје',
    `the station the city means, got ${s.slots.poiAnchor}`);
  assert.doesNotMatch(sent[0], AREA_QUESTION_RE, `never «во кој дел од градот»: ${sent[0]}`);
});
