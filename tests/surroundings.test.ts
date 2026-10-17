// THE [01:29] CAPTURE — a WHICH-SIDE question, not a fee question.
//
//   [01:29] od stranata na trgovskiot ili odkaj pazarceto
//   [01:29] ЛИНА: Мило ми е што го избравте овој имот. Во нашата агенција
//           купувачите се ослободени од провизија (0%)… Дали се согласувате
//           со овие услови…?
//
// The client asked which of the two places they can see the property is on the
// side of; the message fell through every detector (tui.log: FALLTHROUGH →
// classify STAY) and the closing funnel answered a LOCATION question with the
// fee pitch. These tests pin the three parts of the fix:
//   1. the detector — the side/relative grammar, and everything it must NOT claim
//   2. the anchor resolver — the client's definite forms resolve to THIS
//      neighbourhood, never to a same-named place two neighbourhoods away
//   3. the answer — through the real handler, with the real map and the real
//      EB 77 feed row, in the closing state the capture happened in

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config';
import { Db } from '../src/store/db';
import { SessionStore, freshSession } from '../src/fsm/session';
import { Classifier } from '../src/llm/classify';
import { Responder } from '../src/llm/respond';
import { PropertyService, Property, FeedLandmark } from '../src/data/properties';
import { AppointmentStore } from '../src/store/appointments';
import { EscalationStore } from '../src/store/escalations';
import { MetaStore } from '../src/store/meta';
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LlmClient } from '../src/llm/types';
import { LandmarkService, anchorWordForms } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';
import { detectNearbyAsk, detectSurroundingsAsk } from '../src/llm/deterministic';
import { resolveIntent } from '../src/handlers/router';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

/** The REAL EB 77 feed row (public-properties, fetched 2026-10-13) — the
 *  property the capture was about: МИРЧЕ ОРОЕЧАНЕЦ 86/1, Центar, with the
 *  feed's own landmark list (the mall is its top entry, 491 m). */
const EB = 77;
const ROW: Property = {
  eb: EB, id: EB, uuid: '487240e9-6e15-4a23-9093-9e05600fb141',
  address: 'МИРЧЕ ОРОЕЧАНЕЦ 86 - 1', location: 'Центар',
  lat: 41.999, lon: 21.4138, geo_source: 'osm_low_confidence',
  // The roster entry is the place the map really resolves INSIDE the 200 m ring
  // around this pin (~115 m). The old 491 m mall entry is exactly what the ring
  // guard now drops: a flat a kilometre from a mall may not call it „во близина“.
  landmarks: [
    { type: 'place_of_worship', landmark: 'Евангелска Конгрешанска Црква', distance_m: 115 },
  ] as FeedLandmark[],
  service: 'buy', price: 99000,
};

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

test('detectSurroundingsAsk: the [01:29] line and its spellings fire, with the places the client named', () => {
  for (const text of [
    'od stranata na trgovskiot ili odkaj pazarceto',
    'од страната на трговскиот или одкај пазарчето',
    'na koja strana e ?',
    'od koja strana e vlezot ?',
    'poblisku do trgovskiot ili do pazarceto ?',
  ]) {
    assert.ok(detectSurroundingsAsk(text), `must fire: ${text}`);
  }
  const m = detectSurroundingsAsk('od stranata na trgovskiot ili odkaj pazarceto');
  assert.deepEqual(m?.anchors, ['trgovskiot', 'pazarceto'],
    'the two places the client named, in the script the client typed — the geo layer bridges scripts, ' +
    'so a Latin typing must reach it as Latin („next rooms“ never survives a Cyrillic round trip)');
  assert.deepEqual(detectSurroundingsAsk('од страната на трговскиот или одкај пазарчето')?.anchors,
    ['трговскиот', 'пазарчето'],
    'and the Cyrillic typing keeps its own spellings');
  assert.deepEqual(detectSurroundingsAsk('na koja strana e ?')?.anchors, [],
    'a side ask that names nothing still fires — the handler then keeps its own answer');
});

test('detectSurroundingsAsk: a MULTI-WORD place stays one name — the side answer must resolve the name the client typed', () => {
  // The probe lesson: taking 3 loose words out of "od stranata na pizza jakomo
  // ili odkaj ресторан буре срна" made the handler resolve "pizza" (some other
  // pizza place, farther away) instead of "Pizza Jakomo" 29 m from the flat,
  // and the answer named the wrong side. Names are CONTIGUOUS runs.
  assert.deepEqual(
    detectSurroundingsAsk('od stranata na pizza jakomo ili odkaj ресторан буре срна')?.anchors,
    ['pizza jakomo', 'ресторан буре срна']);
  assert.deepEqual(
    detectSurroundingsAsk('od stranata na next rooms ili odkaj кривина островска')?.anchors,
    ['next rooms', 'кривина островска']);
  // A four-word name is the cap (extractPoiConfirmPlace's own cap); a property
  // noun never joins the name it is asked about.
  assert.deepEqual(
    detectSurroundingsAsk('od stranata na shopping center bunjakovec ili od pazarceto e ?')?.anchors,
    ['shopping center bunjakovec', 'pazarceto']);
});

test('detectSurroundingsAsk: never claims the address asks, the каде asks, search or fee messages', () => {
  for (const text of [
    'kazi mi molimte na koja ulica e?',   // EXACT_ADDRESS — the privacy ladder owns it
    'dobro a na koja ulica e ?',
    'kade e 77?',                          // WHERE_IS
    'kade se naogja?',
    'sto ima vo blizina ?',                // WHERE_IS (nearby)
    'sakam stan do 100000 ili poevtino',   // search: „или“ alone is NOT a side ask
    'dali e uste dostapen?',
    'kolku e provizijata?',
    'zdravo',
  ]) {
    assert.equal(detectSurroundingsAsk(text), undefined, `must NOT fire: ${text}`);
  }
});

test('router mirror: a side ask resolves SURROUNDINGS in the state the capture happened in', () => {
  // The capture was in 'closing' — the state whose STAY path served the fee pitch.
  assert.equal(resolveIntent('od stranata na trgovskiot ili odkaj pazarceto', 'closing'), 'SURROUNDINGS');
  assert.equal(resolveIntent('na koja strana e ?', 'closing'), 'SURROUNDINGS');
  // Precedence: каде-questions and address asks keep their own lanes.
  assert.equal(resolveIntent('kade e 77?', 'closing'), 'WHERE_IS');
  assert.equal(resolveIntent('dobro a na koja ulica e ?', 'closing'), 'EXACT_ADDRESS');
});

// ── 2. THE ANCHOR RESOLVER ──────────────────────────────────────────────────

test('findAnchor: the client\'s definite forms resolve to the LOCAL place, never a same-named one a neighbourhood away', () => {
  const svc = new LandmarkService(new Db(':memory:'), { osm: false, offlineMap: map() });
  const center = { lat: ROW.lat!, lon: ROW.lon! };

  // The article a client types is not in the POI table: "trgovskiot" finds
  // nothing as typed, "trgovski" finds the mall.
  assert.deepEqual(anchorWordForms('трговскиот'), ['трговскиот', 'трговски']);

  const mall = svc.findAnchor('трговскиот', center);
  assert.ok(mall, 'the mall must resolve');
  assert.match(mall!.name, /Трговски Центар Буњаковец/, `${mall!.name} — the mall the property is next to`);
  assert.ok(mall!.distance_m < 900, `${mall!.distance_m}m — a real anchor of THIS property`);

  const market = svc.findAnchor('пазарцето', center);
  assert.ok(market, 'the client\'s second place must resolve too');
  assert.match(market!.name, /Пазарче Буњаковец/, `${market!.name} — the market the client meant`);
  assert.ok(market!.distance_m < 900, `${market!.distance_m}m — local, not the Тафталиџе market`);
  assert.ok(!/Тафталиџе/i.test(market!.name),
    `the same word also matches a market 1.9 km away — the radius gate must reject it, got ${market!.name}`);

  // …and this test is not vacuous: the lookup the WHERE_IS handler uses for
  // "каде е X?" (findPlace) happily returns the Тафталиџе market for this very
  // word — 1.9 km away — which is exactly what the radius gate must refuse.
  const viaFindPlace = svc.findPlace('пазарчето', center);
  assert.ok(viaFindPlace, 'the un-gated lookup finds something — the trap is real');
  const trapM = Math.round(Math.hypot(
    (viaFindPlace!.lat - center.lat) * 111000,
    (viaFindPlace!.lon - center.lon) * 82000));
  assert.ok(/Тафталиџе/i.test(viaFindPlace!.name) && trapM > 900,
    `findPlace returns ${viaFindPlace!.name} (${trapM}m) for the same word — the gate is what keeps the answer local`);
  // The client's OTHER word shows the same contrast from the opposite side:
  // the definite form the map cannot look up at all (MISS) resolves through
  // anchorWordForms to the mall.
  assert.equal(svc.findPlace('трговскиот', center), undefined,
    'the definite form the client typed is not in the POI table — the article strip is what makes it resolvable');
});

test('findAnchor: the nearest named place is the side — the mall beats the market from EB 77', () => {
  const svc = new LandmarkService(new Db(':memory:'), { osm: false, offlineMap: map() });
  const center = { lat: ROW.lat!, lon: ROW.lon! };
  const found = ['трговскиот', 'пазарцето']
    .map(w => svc.findAnchor(w, center))
    .filter((a): a is NonNullable<typeof a> => !!a)
    .sort((a, b) => a.distance_m - b.distance_m);
  assert.equal(found.length, 2, 'both places resolve locally');
  assert.match(found[0].name, /Трговски Центар Буњаковец/,
    `the property is on the side of the mall (${found[0].name} ${found[0].distance_m}m vs ${found[1].name} ${found[1].distance_m}m)`);
});

// ── 3. THE ANSWER, THROUGH THE REAL HANDLER ─────────────────────────────────

test('[01:29] in the closing state: the side question is answered with the property\'s real anchor — never the fee pitch', async () => {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const sent: string[] = [];
  const channels = new ChannelRegistry();
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, new OneProp(ROW)),
    responder: new Responder(new FailingLlm(), cfg),
    properties: new OneProp(ROW),
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: map() }),
  });

  // The capture's context: EB 77 under discussion, already past the
  // exact-address ask (the fee pitch is what the closing state serves).
  const chatId = 'capture-0129';
  const session = freshSession('test', chatId);
  session.state = 'closing';
  session.slots.propertyId = EB;
  session.slots.service = 'buy';
  sessions.set(session);

  await handler.handle('test', chatId, 'od stranata na trgovskiot ili odkaj pazarceto');
  const answer = sent[sent.length - 1] ?? '';

  assert.ok(answer, 'the side question must be answered');
  assert.match(answer, /на страната на Трговски Центар Буњаковец/,
    `the answer names the property's real, nearest anchor: ${answer}`);
  // The three ways the old behaviour went wrong, pinned:
  assert.ok(!/провизија|ден|услови|согласувате/.test(answer),
    `never the closing fee pitch for a location question: ${answer}`);
  assert.ok(!/МИРЧЕ|ОРОЕЧАНЕЦ|86/i.test(answer), `the street never appears: ${answer}`);
  assert.ok(!/cid=/.test(answer), `no place-card link: ${answer}`);
  // Context contract: the property is now under discussion for the next ask.
  assert.equal(sessions.get(chatId)?.slots.propertyId, EB, 'the asked-about property becomes the one under discussion');
});

test('[01:29] one place is never both the side AND the farther one — the probe on 5 real Skopje addresses', async () => {
  // Two of the client's names can reach the SAME place ("трговскиот" and the
  // mall's full name; before the connector fix, also "castello" + "by" +
  // "alikas" as two halves of one name). The answer then said "… е на страната
  // на X. X е понатаму од имотот." — naming one place as both the side and the
  // distance. The anchors are deduped on the resolved point.
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const sent: string[] = [];
  const channels = new ChannelRegistry();
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, new OneProp(ROW)),
    responder: new Responder(new FailingLlm(), cfg),
    properties: new OneProp(ROW),
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: map() }),
  });
  const chatId = 'capture-same-place-twice';
  const session = freshSession('test', chatId);
  session.state = 'closing';
  session.slots.propertyId = EB;
  sessions.set(session);

  await handler.handle('test', chatId, 'od stranata na trgovskiot ili odkaj трговски центар буњаковец ?');
  const answer = sent[sent.length - 1] ?? '';
  assert.match(answer, /на страната на Трговски Центар Буњаковец/, answer);
  assert.ok(!/понатаму/.test(answer),
    `one place is not also the farther one: ${answer}`);
});

function makeHandler(db: Db, sessions: SessionStore, sent: string[]): InboundHandler {
  const channels = new ChannelRegistry();
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  return new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, new OneProp(ROW)),
    responder: new Responder(new FailingLlm(), cfg),
    properties: new OneProp(ROW),
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: map() }),
  });
}

/** One closing-state turn from the property under discussion. */
async function sideTurn(text: string, label: string): string {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const sent: string[] = [];
  const handler = makeHandler(db, sessions, sent);
  const session = freshSession('test', label);
  session.state = 'closing';
  session.slots.propertyId = EB;
  sessions.set(session);
  await handler.handle('test', label, text);
  return sent[sent.length - 1] ?? '';
}

const FEE_PITCH = /провизија|500 денари|10 евра|услови за да/;

test('[01:29] a side ask that names nothing, or nothing this property has, is STILL a location question', async () => {
  // The capture's back door: the side lane answered only when it could name a
  // local anchor, so every other side ask fell through to the classifier — and
  // an LLM-down turn answered the location question with the closing fee pitch.
  // An unnamed side ask is still about the property's position, so it gets the
  // same approximate-location line "kade e?" gets (code-owned, ladder advanced,
  // street never shown) — never the fee pitch.
  const nameless = await sideTurn('na koja strana e ?', 'nameless-side');
  assert.match(nameless, /во близина на Евангелска Конгрешанска Црква/, nameless);
  assert.ok(!FEE_PITCH.test(nameless), `no fee pitch for a location question: ${nameless}`);

  // The same shape that CO-FIRES the comparison reader ("X или Y") and used to
  // be punted to the classifier by skipInterceptors.
  const unknown = await sideTurn('od stranata na nekoe nepoznato mesto ili od drugo nepoznato ?', 'unknown-names');
  assert.match(unknown, /во близина на Евангелска Конгрешанска Црква/, unknown);
  assert.ok(!/на страната на/.test(unknown),
    `nothing the map cannot place is claimed as a side: ${unknown}`);
  assert.ok(!FEE_PITCH.test(unknown), `no fee pitch for a location question: ${unknown}`);
});

test('surroundings wording that is not a side ask and not a „što ima“ ask still reads as surroundings', () => {
  // THE LIVE-BRAIN PROBE: with the real feed and the real brain, "kako izgleda
  // okolinata, dali e mirno i zeleno ?" classified STAY in the closing state
  // and the state's deterministic reply served the viewing FEE over a
  // surroundings question — the [01:29] failure class again, one phrasing over.
  // The „што има…“ slots have no HAVE verb here, so the shape is
  // opinion-word + a proximity/surrounding NOUN (okolina/sosedstvo/kvart/…).
  for (const text of [
    'kako izgleda okolinata, dali e mirno i zeleno ?',
    'sto bi mi kazala za sosedstvoto okolu zgradata ?',
    'kakva e okolinata na ovoj stan ?',
    'kakov e kvartot ?',
    'opisi mi go sosedstvoto',
    'kazi mi nesto za okolinata',
    'kako e okolu zgradata ?',
  ]) {
    assert.ok(detectNearbyAsk(text), `must read as a surroundings ask: ${text}`);
  }
  // …and it stays a QUESTION ABOUT THE PLACE: no proximity/surrounding noun,
  // no match — the property itself, prices, the address ladder and small talk
  // must all keep their own lanes.
  for (const text of [
    'kako e stanot ?',
    'kako izgleda voziloto ?',
    'kazi mi nesto za stanot',
    'kazi mi koja e adresata',
    'kolku e golem stanot ?',
    'dobro a na koja ulica e ?',
    'kolku e cenata ?',
    'kako e vremeto ?',
  ]) {
    assert.equal(detectNearbyAsk(text), false, `must NOT read as a surroundings ask: ${text}`);
  }
});

test('[01:29] a surroundings question in the closing state is answered from the real map — never the fee pitch', async () => {
  const answer = await sideTurn('kako izgleda okolinata, dali e mirno i zeleno ?', 'live-brain-shape');
  assert.ok(answer, 'a surroundings question must be answered');
  assert.match(answer, /во близина на /,
    `answered from the property's own location: ${answer}`);
  assert.ok(!FEE_PITCH.test(answer), `never the closing fee pitch: ${answer}`);
  assert.ok(!/МИРЧЕ|ОРОЕЧАНЕЦ|86/i.test(answer), `the street never appears: ${answer}`);
});

test('[01:29] a side ask is answered only with places the map really resolved near this property', async () => {
  // "na koja strana e taftalidze ?" — the client names a NEIGHBOURHOOD the
  // property is not in. The map's nearest name-match is a store 733 m away, so
  // whatever the lane answers, the named place must be one findAnchor resolved
  // for THIS centre (inside the radius) — never the far neighbourhood the
  // client named, which would be invented geography.
  const answer = await sideTurn('na koja strana e taftalidze ?', 'taftalidze-side');
  const svc = new LandmarkService(new Db(':memory:'), { osm: false, offlineMap: map() });
  const anchor = svc.findAnchor('taftalidze', { lat: ROW.lat!, lon: ROW.lon! });
  if (/на страната на /.test(answer)) {
    assert.ok(anchor, `a side was claimed, so the map must have resolved a local anchor: ${answer}`);
    assert.ok(answer.includes(anchor!.name),
      `the claimed side is the map's own local anchor "${anchor!.name}", not a place 2 км away: ${answer}`);
  } else {
    // No local match → the approximate-location line, still no fee pitch.
    assert.match(answer, /во близина на /, answer);
  }
  assert.ok(!FEE_PITCH.test(answer), `no fee pitch for a location question: ${answer}`);
});

process.on('exit', () => offlineMap?.close());
