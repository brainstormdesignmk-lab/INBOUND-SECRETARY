// THE [22:25] CAPTURE — a DISTANCE question, answered with the service ask.
//
//   [22:25] KOLKU IMA OD STANOT DO BUNJAKOVEC TRGOVSKI?
//   [22:25] ЛИНА: Здраво. Дали во моментов разгледувате имоти за купување
//           или барате нешто за изнајување?
//
// The client asked how far the apartment is from Bunyakovec shopping centre.
// Nothing claimed the turn: it is not a каде question (WHERE_LANDMARK), and the
// classifier read „STANOT“ as a property reference, so the answer was a service
// question (or, once the geo engine learned the name, a property CARD).
//
// These tests pin the three parts of the fix:
//   1. the detector — the distance grammar, and the price/cap families it must
//      NOT claim („kolku e stanot?“, „do 250 evra“)
//   2. the place extraction — the tail after „do/до“, never a quantity
//   3. the answer, through the real handler and the real map: the property's
//      OWN coordinates to the named place, in metres

import { test } from 'node:test';
import assert from 'node:assert/strict';
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
import { OfflineMapStore } from '../src/geo/offlineMap';
import { isDistanceQuestion, extractDistancePlace } from '../src/llm/deterministic';
import { resolveIntent } from '../src/handlers/router';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

/** The REAL EB 70 feed row (fetched 2026-10-17): Владимир Полежиновски 23,
 *  Центар, google_cached pin 41.9993/21.4213 — 133 m from the mall. */
const EB = 70;
const ROW: Property = {
  eb: EB, id: EB, uuid: 'eb70-capture',
  address: 'ВЛАДИМИР ПОЛЕЖИНОВСКИ 23', location: 'Центар (населба)',
  lat: 41.9993, lon: 21.4213, geo_source: 'google_cached',
  service: 'buy', price: 350,
} as Property;

class OneProp extends PropertyService {
  constructor(private row: Property) { super('http://feed-not-used'); }
  async getAll(): Promise<Property[]> { return [this.row]; }
  async getByEb(eb: number): Promise<Property | undefined> { return eb === this.row.eb ? this.row : undefined; }
  get healthy(): boolean { return true; }
}

const cfg = loadConfig();
let offlineMap: OfflineMapStore | undefined;
function map(): OfflineMapStore {
  if (!offlineMap) offlineMap = new OfflineMapStore(cfg.skopjePoisDb);
  return offlineMap;
}

// ── 1. THE DETECTOR ─────────────────────────────────────────────────────────

test('isDistanceQuestion: the [22:25] line and its spellings fire', () => {
  for (const text of [
    'KOLKU IMA OD STANOT DO BUNJAKOVEC TRGOVSKI?',
    'kolku e daleku od stanot do bunjakovec trgovski',
    'КОЛКУ Е ДАЛЕКУ ДО БУЊАКОВЕЦ ТРГОВСКИ',
    'kolku minuti peske do centar',
    'dalecina do centar?',
    // [16:11] — the client asks with the NOUN for distance and the landmark
    // after „od“. Both spellings (his Latin typing, her Cyrillic register).
    'NA KOLKAVO RASTOJANIE E STANOT OD LJUBEN LAPE ?',
    'na kolkavo rastojanie e stanot od ljuben lape',
    'КОЛКУ Е ДАЛЕКУ СТАНОТ ОД ЉУБЕН ЛАПЕ?',
    'НА КОЛКАВО РАСТОЈАНИЕ Е СТАНОТ ОД ЉУБЕН ЛАПЕ?',
  ]) {
    assert.ok(isDistanceQuestion(text), `must fire: ${text}`);
  }
});

test('isDistanceQuestion: price asks and distance CAPS are never distance questions', () => {
  for (const text of [
    'kolku e stanot?',        // price of the apartment
    'kolku chini stanot',     // price, the price-ask family
    'KOLKU IMA OD STANOT DO 250 EVRA', // „do 250“ is a budget cap
    'da ne e daleku',         // a statement, not a question
  ]) {
    assert.equal(isDistanceQuestion(text), false, `must NOT fire: ${text}`);
  }
});

test('extractDistancePlace: the place after do/до, in the client\'s own script', () => {
  assert.equal(extractDistancePlace('KOLKU IMA OD STANOT DO BUNJAKOVEC TRGOVSKI?'), 'BUNJAKOVEC TRGOVSKI');
  assert.equal(extractDistancePlace('КОЛКУ ИМА ОД СТАНОТ ДО БУЊАКОВЕЦ ТРГОВСКИ?'), 'БУЊАКОВЕЦ ТРГОВСКИ');
  // A quantity tail is a cap, not a place.
  assert.equal(extractDistancePlace('kolku ima od stanot do 250 evra'), undefined);
  assert.equal(extractDistancePlace('kolku e daleku do centar li e'), 'centar');
});

test('extractDistancePlace: the FROM-form ([16:11]) reads the landmark after од', () => {
  // The client asks about the property's distance FROM a place he can name.
  assert.equal(extractDistancePlace('NA KOLKAVO RASTOJANIE E STANOT OD LJUBEN LAPE ?'), 'LJUBEN LAPE');
  assert.equal(extractDistancePlace('КОЛКУ Е ДАЛЕКУ СТАНОТ ОД ЉУБЕН ЛАПЕ?'), 'ЉУБЕН ЛАПЕ');
  assert.equal(extractDistancePlace('kolku e oddalecen od parkot?'), 'parkot');
  // The destination still wins when both ends are named (returned as the
  // client typed it — the geo layer bridges the script, not this extractor).
  assert.equal(extractDistancePlace('kolku ima od stanot do bunjakovec trgovski'), 'bunjakovec trgovski');
  // A property noun after „od“ is the SUBJECT, never a place: nothing to
  // measure, so the lane must fall through instead of inventing one.
  assert.equal(extractDistancePlace('KOLKU E DALEKU OD STANOT?'), undefined);
  assert.equal(extractDistancePlace('kolku e daleku od kukjata'), undefined);
  // A quantity is a cap, not a place.
  assert.equal(extractDistancePlace('kolku e daleku od 250 evra'), undefined);
});

test('the router mirror predicts DISTANCE for the [16:11] line', () => {
  assert.equal(resolveIntent('NA KOLKAVO RASTOJANIE E STANOT OD LJUBEN LAPE ?', 'property_locate'), 'DISTANCE');
});

test('the router mirror predicts DISTANCE for the capture line', () => {
  assert.equal(resolveIntent('KOLKU IMA OD STANOT DO BUNJAKOVEC TRGOVSKI?', 'idle'), 'DISTANCE');
});

// ── 2. THE ANSWER, THROUGH THE REAL HANDLER ─────────────────────────────────

/** The REAL EB 61 feed row (public-properties, fetched 2026-10-20): Стан
 *  4-собен, Издава 380 €, Аеродром, Јане Сандански 36 — the row behind the
 *  [16:08–16:11] transcript. Its stored point is osm_low_confidence; the map
 *  resolves the actual building (#36, 41.9860029/21.4614652, 3 m away). */
const EB61: Property = {
  eb: 61, id: 61, uuid: 'eb61-capture',
  address: 'ЈАНЕ САНДАНСКИ 36', location: 'Аеродром',
  lat: 41.986, lon: 21.4615, geo_source: 'osm_low_confidence',
  service: 'rent', price: 380,
} as Property;

async function makeHandler(row: Property = ROW): Promise<{ handler: InboundHandler; sessions: SessionStore; sent: string[] }> {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const sent: string[] = [];
  const channels = new ChannelRegistry();
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, new OneProp(row)),
    responder: new Responder(new FailingLlm(), cfg),
    properties: new OneProp(row),
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: map() }),
  });
  return { handler, sessions, sent };
}

test('[22:25] the distance question is answered with the measured distance to the named place', async () => {
  const { handler, sessions, sent } = await makeHandler();
  const chatId = 'capture-2225';
  sessions.set(freshSession('test', chatId));

  // The turn before it, verbatim from the capture: the property is named by EB.
  await handler.handle('test', chatId, 'ZDRAVO KADE VI SE NAOGJA EV BR 70 ?');
  sent.length = 0;
  await handler.handle('test', chatId, 'KOLKU IMA OD STANOT DO BUNJAKOVEC TRGOVSKI?');

  const answer = sent[sent.length - 1] ?? '';
  assert.ok(answer, 'the distance question must be answered');
  // THE PLACE: the map's own name for „BUNJAKOVEC TRGOVSKI“ (word order and
  // language bridged — no such string exists in the POI table).
  assert.match(answer, /Shopping Center Bunjakovec|Трговски Центар Буњаковец/,
    `the answer names the place the client asked about: ${answer}`);
  // THE NUMBER: measured from the property's REAL point, not the raw feed
  // column. This fixture's google_cached pin (41.9993,21.4213) is 485 m from
  // the mapped building on the street, so the lane resolves the building
  // first (Владимир Полежиновски 23а, 41.99834/21.41558 — the pin the row is
  // actually repaired to) and measures from there: 352 m to the mall.
  assert.match(answer, /на 3[45]0 метри/, `the measured distance, rounded to 10 m: ${answer}`);
  assert.match(answer, /од недвижноста/, `it is stated as a distance FROM the property: ${answer}`);
  // The three wrong answers this capture produced are gone.
  assert.ok(!/купување или|изнајмување|Ве интересира/.test(answer),
    `never the service question: ${answer}`);
  assert.ok(!/Евидентен број|двособен|м²|Цената е/.test(answer),
    `never the property card: ${answer}`);
  assert.ok(!/ВЛАДИМИР|ПОЛЕЖИНОВСКИ|23/.test(answer), `the street never appears: ${answer}`);
  assert.ok(!/cid=|api=1/.test(answer), `no place-card/search link: ${answer}`);

  // Context contract: the property stays under discussion.
  assert.equal(sessions.get(chatId)?.slots.location, 'Центар (населба)');
});

test('[16:11] “на колкаво растојание … од Љубен Лапе?” is answered with the measured distance', async () => {
  const { handler, sessions, sent } = await makeHandler(EB61);
  const chatId = 'capture-1611';
  sessions.set(freshSession('test', chatId));

  // The turns before it, verbatim: two where-is asks. The rotation answered
  // Парк на светлината, then ОУГС Љубен Лапе — and the DISTANCE question on
  // the third turn was answered with a THIRD landmark instead of a number.
  await handler.handle('test', chatId, 'ZDRAVO KADE VI SE NAOGJA EV BR 61 ?');
  sent.length = 0;
  await handler.handle('test', chatId, 'NA KOLKAVO RASTOJANIE E STANOT OD LJUBEN LAPE ?');

  const answer = sent[sent.length - 1] ?? '';
  assert.ok(answer, 'the distance question must be answered');
  // THE PLACE the client named, resolved from the map's own row („LJUBEN
  // LAPE“ → „ОУГС Љубен Лапе“).
  assert.match(answer, /ОУГС Љубен Лапе/, `the answer names the place asked about: ${answer}`);
  // THE NUMBER: from EB 61's REAL building point (Јане Сандански 36,
  // 41.9860029/21.4614652) to the school (41.98458/21.46030) — 185 m, so the
  // rounded metre figure is 190. Measured, never invented.
  assert.match(answer, /на 190 метри/, `the measured distance, rounded to 10 m: ${answer}`);
  assert.match(answer, /од недвижноста/, `stated as a distance FROM the property: ${answer}`);
  // The failure this capture produced is gone: no third landmark in place of
  // the number.
  assert.ok(!/Срнич|Парк на светлината/.test(answer),
    `never the next landmark of the rotation: ${answer}`);
  // Privacy contract unchanged: the street never appears.
  assert.ok(!/ЈАНЕ|САНДАНСКИ/.test(answer), `the street never appears: ${answer}`);
  assert.ok(!/Евидентен број|м²|Цената е/.test(answer), `never the property card: ${answer}`);
});

test('[16:11] a distance ask with no landmark in it never invents a place', async () => {
  const { handler, sessions, sent } = await makeHandler(EB61);
  const chatId = 'capture-1611-noplace';
  sessions.set(freshSession('test', chatId));
  await handler.handle('test', chatId, 'ZDRAVO KADE VI SE NAOGJA EV BR 61 ?');
  sent.length = 0;
  await handler.handle('test', chatId, 'KOLKU E DALEKU OD STANOT?');
  const answer = sent[sent.length - 1] ?? '';
  assert.ok(!/се наоѓа на \d+ метри/.test(answer), `no invented distance: ${answer}`);
});

// ── THE EB NAMED IN THE ASK OWNS THE NUMBER (the [21:22] capture) ───────────
//
//   [21:21] NA KOLKAVO RASTOJANIE E OD BROZ KAFE ?
//   [21:21] ЛИНА: Broz Cafe се наоѓа на околу 530 метри од недвижноста …   (EB 84 ✓)
//   [21:22] A OVOJ PRVIOT 95 NA KOLKAVO RASTOJANIE E OD BROZ KAFE?
//   [21:22] ЛИНА: Broz Cafe се наоѓа на околу 530 метри …                   (still 84 ✗)
//
// The client compared TWO flats by the same landmark and heard one number
// twice: the lane only read the slots, never the Евидентен број in the message,
// so every distance came back as the flat described first.
const EB95: Property = {
  eb: 95, id: 95, uuid: 'eb95-capture',
  address: 'ЦРВЕНА ВОДА', location: 'Центар',
  lat: 41.9997, lon: 21.4186, geo_source: 'google_cached',
  service: 'buy', price: 204000, bedrooms: 3,
} as Property;
const EB84: Property = {
  eb: 84, id: 84, uuid: 'eb84-capture',
  address: 'РОЗА ЛУКСЕМБУРГ', location: 'Центар',
  lat: 42.0050, lon: 21.4171, geo_source: 'google_cached',
  service: 'buy', price: 117000, bedrooms: 3,
} as Property;

const EB77: Property = {
  eb: 77, id: 77, uuid: 'eb77-capture',
  address: 'МИРЧЕ ОРОВЧАНЕЦ 86', location: 'Центар',
  lat: 41.9985, lon: 21.4192, geo_source: 'google_cached',
  service: 'buy', price: 130000, bedrooms: 2,
} as Property;

class MultiProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://feed-not-used'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(p => p.eb === eb); }
  get healthy(): boolean { return true; }
}

async function makeMultiHandler(rows: Property[]): Promise<{ handler: InboundHandler; sessions: SessionStore; sent: string[] }> {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const sent: string[] = [];
  const channels = new ChannelRegistry();
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const props = new MultiProps(rows);
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, props),
    responder: new Responder(new FailingLlm(), cfg),
    properties: props,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: map() }),
  });
  return { handler, sessions, sent };
}

/** The metres the reply states („на околу 130 метри“), or undefined. */
function metresOf(answer: string): number | undefined {
  const m = answer.match(/на (?:околу )?(\d+) метри/u);
  return m ? parseInt(m[1], 10) : undefined;
}

test('[21:22] the Евидентен број named in the ask is the flat the distance is for', async () => {
  const { handler, sessions, sent } = await makeMultiHandler([EB95, EB84]);
  const chatId = 'capture-2122';
  sessions.set(freshSession('test', chatId));

  // The turn before: EB 84 was described, so it owns the slots.
  await handler.handle('test', chatId, 'ZDRAVO STO MOZES DA MI KAZES ZA EV BR 84 ?');
  assert.equal(sessions.get(chatId)?.slots.propertyId, 84, 'EB 84 owns the conversation first');
  await handler.handle('test', chatId, 'NA KOLKAVO RASTOJANIE E OD BROZ KAFE ?');
  const for84 = sent[sent.length - 1] ?? '';
  assert.match(for84, /Broz Cafe/u, `the place is named: ${for84}`);
  const d84 = metresOf(for84);
  assert.ok(d84 !== undefined, `EB 84's distance is measured: ${for84}`);

  // The client now points at the OTHER flat by its number…
  await handler.handle('test', chatId, 'A OVOJ PRVIOT 95 NA KOLKAVO RASTOJANIE E OD BROZ KAFE?');
  const for95 = sent[sent.length - 1] ?? '';
  const d95 = metresOf(for95);
  assert.ok(d95 !== undefined, `EB 95's distance is measured: ${for95}`);
  assert.notEqual(for95, for84, `the second flat gets its OWN answer: ${for95}`);
  // EB 95 is the near one in this pair — the number must follow the flat, not
  // the slot the previous turn left behind.
  assert.ok(d95 < d84!, `EB 95 (${d95} m) is nearer than EB 84 (${d84} m)`);
  // …and it becomes the flat under discussion.
  assert.equal(sessions.get(chatId)?.slots.propertyId, 95, 'the named flat is under discussion from here on');
});


// ── THE COMPARISON (the [22:03] capture) ────────────────────────────────────
//
//   [22:02] ZDRAVO IMAVTE EDEN STAN ZA PRODAZBA KAJ BROZ KAFE . DALI USTE SE PRODAVA ?
//   [22:02] ЛИНА: Имам три недвижности близу Броз Кафе: 95 / 84 / 77 …
//   [22:03] KOJ E NAJBLISKU DO KAFICOT ?
//   [22:03] ЛИНА: Тоа се наоѓа во близина на УДГС Здравко Цветковски. <maps link>
//
// The client asks WHICH of the three is nearest to the café he just named. The
// reply was the LAST flat's nearby landmark — a landmark nobody asked about,
// for a flat he had not chosen.
test('[22:03] “koj e najblisku do kaficot?” names the nearest of the offered flats', async () => {
  const { handler, sessions, sent } = await makeMultiHandler([EB95, EB84, EB77]);
  const chatId = 'capture-2203';
  sessions.set(freshSession('test', chatId));

  await handler.handle('test', chatId, 'ZDRAVO IMAVTE EDEN STAN ZA PRODAZBA KAJ BROZ KAFE . DALI USTE SE PRODAVA ?');
  const offered = sent[sent.length - 1] ?? '';
  assert.ok(/95/u.test(offered) && /84/u.test(offered) && /77/u.test(offered),
    `the three flats near the place are offered first: ${offered}`);
  sent.length = 0;

  // The café is a PRONOUN here — the anchor of the hunt is what it means.
  await handler.handle('test', chatId, 'KOJ E NAJBLISKU DO KAFICOT ?');
  const answer = sent[sent.length - 1] ?? '';
  assert.match(answer, /Најблизу до Броз Кафе е Евидентен број 95/u,
    `the nearest of the three answers the question: ${answer}`);
  // Every offered flat is ranked, and the ranking follows the real distances.
  assert.match(answer, /Евидентен број 77/u, `the others are ranked too: ${answer}`);
  assert.match(answer, /Евидентен број 84/u, `the others are ranked too: ${answer}`);
  const metres = [...answer.matchAll(/(\d+) метри/gu)].map(m => parseInt(m[1], 10));
  assert.ok(metres.length === 3, `three measured distances: ${answer}`);
  assert.deepEqual(metres, [...metres].sort((a, b) => a - b), `nearest first: ${answer}`);
  // The failure is gone: no landmark line, no rotation, no link.
  assert.ok(!/се наоѓа во близина на/u.test(answer), `never the nearby-landmark line: ${answer}`);
  assert.ok(!/maps\.google/u.test(answer), `no place link: ${answer}`);

  // Naming the place explicitly answers the same way.
  sent.length = 0;
  await handler.handle('test', chatId, 'A KOJ E NAJBLISKU DO BROZ KAFE ?');
  const explicit = sent[sent.length - 1] ?? '';
  assert.match(explicit, /Најблизу до Броз Кафе е Евидентен број 95/u, `same answer for the named place: ${explicit}`);
});

// ── «OVA BESE BLISKU» (the [20:17] capture) ─────────────────────────────────
//
//   [20:16] GLEDAV EDEN STAN KAJ VAS KAJ BROZ KAFE / DALI E USTE AKTIVEN ?
//   [20:16] ЛИНА: Имам три недвижности близу Броз Кафе: 95 / 84 / 77 …
//   [20:17] OVA BESE BLISKU
//   [20:17] ЛИНА: Во ред, ќе се обидам да го најдам. Кажете ми — во која
//                   населба е, колку квадрати има и по која цена беше?   ✗
//
// The client pointed BACK at the batch. The mandated answer names the one
// nearest of the offered flats and the measured distance, in one sentence.
test('[20:17] “ova bese blisku” names the nearest of the batch and its distance', async () => {
  const { handler, sessions, sent } = await makeMultiHandler([EB95, EB84, EB77]);
  const chatId = 'capture-2017';
  sessions.set(freshSession('test', chatId));

  await handler.handle('test', chatId, 'ZDRAVO IMAVTE EDEN STAN ZA PRODAZBA KAJ BROZ KAFE . DALI USTE SE PRODAVA ?');
  const offered = sent[sent.length - 1] ?? '';
  assert.ok(/95/u.test(offered) && /84/u.test(offered) && /77/u.test(offered),
    `the batch near the place is on the table: ${offered}`);
  sent.length = 0;

  await handler.handle('test', chatId, 'OVA BESE BLISKU');
  const answer = sent[sent.length - 1] ?? '';
  // The dictated shape: the nearest EB and the distance from the place.
  assert.match(answer,
    /Недвижноста која е најблиску до Броз Кафе е: Евидентен број 95 на \d+ метри растојание\./u,
    `the dictated sentence, nearest of the batch: ${answer}`);
  // THE TURN ADVANCES: the sentence names the flat, then the visit offer asks
  // for it — one question, and no fee wording before the client agrees.
  assert.match(answer, /посета/iu, `a visit must be offered after the sentence: ${answer}`);
  // The pool's variants are both shapes — a question ("Дали би сакале…?") and
  // an offer with its promise ("…Ќе организирам посета во термин по Ваш
  // избор.") — so the contract is the OFFER, not a trailing question mark.
  assert.match(answer, /(?:организирам|закажам|договорам) посета/iu,
    `the offer must say it arranges the visit: ${answer}`);
  assert.ok(answer.split('\n\n').length >= 2, `the offer is its own paragraph: ${answer}`);
  assert.ok(!/надомест|денар|300|500/u.test(answer), `no fee wording yet: ${answer}`);
  // …and the nearest flat is the one under discussion, so a "да" continues the
  // visit protocol on it instead of restarting the hunt.
  assert.equal(sessions.get(chatId)?.slots.propertyId, 95, 'the nearest flat is bound');
  // The [20:17] failure is gone: no recall ask, no card re-serve, no landmark
  // line about a flat nobody chose.
  assert.ok(!/во која населба е/u.test(answer), `never the recall ask: ${answer}`);
  assert.ok(!/се наоѓа во близина на/u.test(answer), `no nearby-landmark line: ${answer}`);
  assert.ok(!/maps\.google/u.test(answer), `no place link: ${answer}`);
});

test('[22:25] a place the map does not know is never given a fabricated distance', async () => {
  const { handler, sessions, sent } = await makeHandler();
  const chatId = 'capture-2225-miss';
  sessions.set(freshSession('test', chatId));
  await handler.handle('test', chatId, 'ZDRAVO KADE VI SE NAOGJA EV BR 70 ?');
  sent.length = 0;
  await handler.handle('test', chatId, 'KOLKU IMA OD STANOT DO NEPOSTOECHKO MESTO XYZ?');
  const answer = sent[sent.length - 1] ?? '';
  assert.ok(!/се наоѓа на \d+ метри/.test(answer), `no invented distance: ${answer}`);
});

// ── «ЕКОНОМСКОТО» IS A MAP PLACE, NOT A GAP (the [11:28] capture) ────────────
//
//   [11:27] cards for EB 94 and EB 90 — both Кисела Вода
//   [11:28] NA KOLKAVO RASTOJANIE SE DO EKONOMSKOTO ?
//   [11:31] ЛИНА [dynamic]: Точното растојание до Економското училиште не ми е
//            заведено во записите. Веднаш ќе проверам кај сопствениците…     ✗
//
// The map KNOWS the school: «СЕПУГС Васил Антевски - Дрен», the city's Средно
// економско-правно училиште in Кисела Вода — 166 m from EB 94, 622 m from
// EB 90. Its row carries only the official abbreviation, so the client's words
// («економското», «економското сколо») never matched it, the lane fell through
// and the LLM invented a gap about a place the map measures to the metre. Both
// halves are pinned here: the name bridge, and one measured line per flat.
const EB94: Property = {
  eb: 94, id: 94, uuid: 'eb94-capture',
  address: 'ТОНЕ ТОМШИЌ 25', location: 'Кисела Вода',
  lat: 41.9813, lon: 21.4382, geo_source: 'osm_building',
  service: 'buy', price: 92000, bedrooms: 2,
} as Property;
const EB90: Property = {
  eb: 90, id: 90, uuid: 'eb90-capture',
  address: 'ЛОКОВ 5', location: 'Кисела Вода',
  lat: 41.9744, lon: 21.4403, geo_source: 'google_cached',
  service: 'buy', price: 75000, bedrooms: 2,
} as Property;

test('«економското» reaches the school row filed under СЕПУГС', () => {
  for (const q of ['економското', 'EKONOMSKOTO', 'економското училиште',
    'ЕКОНОМСКОТО СКОЛО', 'ekonomsko uciliste']) {
    const hit = map().findPoiByName(q, { lat: 41.9813, lon: 21.4382 });
    assert.ok(hit, `${q} must resolve`);
    assert.match(hit!.name, /СЕПУГС/u, `${q} → the economics school row: ${hit!.name}`);
  }
});

test('[11:28] the distance question after two cards answers for BOTH flats', async () => {
  const { handler, sessions, sent } = await makeMultiHandler([EB94, EB90]);
  const chatId = 'capture-1128';
  const s = freshSession('test', chatId);
  s.slots.currentBatch = [94, 90];
  s.slots.presentedIds = [94, 90];
  s.slots.propertyId = 94;
  s.slots.service = 'buy';
  sessions.set(s);

  await handler.handle('test', chatId, 'NA KOLKAVO RASTOJANIE SE DO EKONOMSKOTO ?');
  const answer = sent[sent.length - 1] ?? '';
  assert.ok(answer, 'the distance question must be answered');
  // The failure is gone: never an invented gap about a place the map measures.
  assert.ok(!/не ми е заведено|не е заведено|ќе проверам кај сопственик/u.test(answer),
    `never the invented gap: ${answer}`);
  // The school, spelled out — an acronym alone tells the client nothing.
  assert.match(answer, /Средно економско-правно училиште/u, `the school is named in full: ${answer}`);
  const at = (eb: number): number | undefined => {
    const m = answer.match(new RegExp(`Евидентен број ${eb} — на (?:околу )?(\\d+) метри`, 'u'));
    return m ? parseInt(m[1], 10) : undefined;
  };
  const d94 = at(94), d90 = at(90);
  assert.ok(d94 !== undefined, `EB 94 has its own distance: ${answer}`);
  assert.ok(d90 !== undefined, `EB 90 has its own distance: ${answer}`);
  // Measured, not invented: EB 94 is ~166–200 m from the school, EB 90 ~600 m.
  assert.ok(d94! >= 100 && d94! <= 300, `EB 94 is close to the school: ${d94}`);
  assert.ok(d90! >= 450 && d90! <= 900, `EB 90 is farther from it: ${d90}`);
  assert.ok(d94! < d90!, `nearest first: ${answer}`);
  // The turn advances, and the nearest flat is the one a «да» continues on.
  assert.match(answer, /посета/iu, `a visit is offered: ${answer}`);
  assert.equal(sessions.get(chatId)?.slots.propertyId, 94, 'the nearest flat is bound');
});

test('[11:28] one flat keeps the single-sentence distance answer', async () => {
  const { handler, sessions, sent } = await makeMultiHandler([EB94]);
  const chatId = 'capture-1128-one';
  const s = freshSession('test', chatId);
  s.slots.propertyId = 94;
  s.slots.service = 'buy';
  sessions.set(s);
  await handler.handle('test', chatId, 'NA KOLKAVO RASTOJANIE E STANOT OD EKONOMSKOTO ?');
  const answer = sent[sent.length - 1] ?? '';
  assert.match(answer, /Средно економско-правно училиште[^.]*се наоѓа на \d+ метри/u,
    `the measured sentence, school spelled out: ${answer}`);
  assert.match(answer, /од недвижноста/u, `stated as a distance FROM the property: ${answer}`);
});

// ── THE FLAT HE JUST ASKED ABOUT OWNS THE DISTANCE (the [09:09] capture) ────
//
//   [09:09] 66 DALI E DOSTAPEN USTE ?            → availability ack, 66 pinned
//   [09:09] NA KOLKAVO RASTOJANIE E OD BUNJAKOVEC ?
//   [09:09] ЛИНА: Растојанието до Буњаковец:  • 84 …  • 51 …      ✗ (the batch)
//   [09:10] TE PRASAV ZA 66                                        (and again)
//
// 66 was the flat under discussion; the batch arm answered for the two cards
// behind it and then stamped the nearest of THEM onto the slots, so the next
// turn had no anchor at all. The batch is the subject only while nothing else
// is: either no flat is under discussion, or the discussed one is IN the batch.
const EB66D: Property = {
  eb: 66, id: 66, uuid: 'eb66-capture',
  address: 'РУЗВЕЛТОВА', location: 'Центар',
  lat: 41.9990, lon: 21.4320, geo_source: 'google_cached',
  service: 'buy', price: 145000, bedrooms: 3,
} as Property;
const EB51D: Property = {
  eb: 51, id: 51, uuid: 'eb51-capture',
  address: 'ВОДНО', location: 'Водно',
  lat: 41.9900, lon: 21.4000, geo_source: 'google_cached',
  service: 'buy', price: 105000, bedrooms: 3,
} as Property;

test('[09:09] a discussed flat OUTSIDE the batch answers the distance alone, by its number', async () => {
  const { handler, sessions, sent } = await makeMultiHandler([EB66D, EB84, EB51D]);
  const chatId = 'capture-0909';
  const s = freshSession('test', chatId);
  s.state = 'closing';
  s.slots.service = 'buy';
  // «66 DALI E DOSTAPEN USTE?» pinned 66; the batch behind it is the OLD pair.
  s.slots.propertyId = 66;
  s.slots.interestedPropertyId = 66;
  s.slots.currentBatch = [84, 51];
  s.slots.presentedIds = [84, 51, 66];
  sessions.set(s);

  await handler.handle('test', chatId, 'NA KOLKAVO RASTOJANIE E OD BUNJAKOVEC ?');
  const answer = sent[sent.length - 1] ?? '';

  assert.match(answer, /Буњаковец/u, `the named place is resolved: ${answer}`);
  assert.match(answer, /Евидентен број 66/u, `the flat he asked about is NAMED: ${answer}`);
  // Measured, never invented — the unit follows the distance (this fixture's
  // EB 66 is ~1,1 km from the mall, so the metre-only helper would miss it).
  assert.match(answer, /се наоѓа на (?:околу )?\d+(?:,\d+)? (?:метри|километри)/u,
    `66's distance is measured: ${answer}`);
  assert.ok(!/Евидентен број 84|Евидентен број 51/u.test(answer),
    `the flats of the old batch are not the subject: ${answer}`);
  assert.equal(sessions.get(chatId)?.slots.propertyId, 66,
    'the discussed flat stays bound (it was overwritten with the batch before)');
});
