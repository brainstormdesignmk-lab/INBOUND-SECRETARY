/**
 * THE [02:15]/[02:16] CAPTURE — the place is remembered, the typed answer SERVES.
 *
 *   [02:15] ZDRAVO. STO IMATE VO BUNJAKOVEC?
 *   [02:15] ЛИНА: Добар ден. Како можам да Ви помогнам… купување или изнајмување?
 *   [02:16] SAKAM DA IZNAJMAM STAN VO BUNJAKOVEC ?
 *   [02:16] ЛИНА: Во кој дел од градот најмногу би Ви одговарало да го најдеме
 *           станот?
 *
 * The opening greeting is an acceptable answer to the first message — but only
 * if the PLACE survives it. Буњаковец is a naselba the offline map knows and the
 * FEED does not hold as a neighbourhood, so nothing carried it; the second
 * message then had no geography, and the funnel asked for a neighbourhood the
 * client had named twice.
 *
 * The contract pinned here:
 *   1. an inventory ask names a place the map knows → it is ON FILE, whatever
 *      answered the turn;
 *   2. a typed acquisition at that place (service + type) SERVES a pair ranked
 *      from it and asks THAT TYPE's characteristics — never the location
 *      question again;
 *   3. every category has its own questions: стан/куќа → спални + цена,
 *      деловен простор → м² + цена.
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
import { EnrichmentStore } from '../src/store/enrichment';
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LlmClient } from '../src/llm/types';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';
import {
  detectInventoryAsk, detectSeeOffers, detectPropertyTypeWord, extractInventoryPlace,
  detectNeighborhoodAsk, detectFlat,
} from '../src/llm/deterministic';
import { assertsStockAtPlace } from '../src/llm/placeTemplate';
import { dispatchSimple } from '../src/handlers/router';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

// Around the MAP's own Буњаковец pin (41.9974581, 21.4186442) — a few dozen
// metres, so the batch is a real "here" serve and not the honest far line.
// Both markets are seeded so the TYPE the client names decides which pair is
// served.
const ROWS: Property[] = [
  { eb: 921, id: 921, location: 'Центар', address: 'Ул. Никола Вапцаров 8', price: 450, service: 'rent', bedrooms: 2, sqm: 62, size: '62 м²', lat: 41.9976, lon: 21.4182 },
  { eb: 922, id: 922, location: 'Центар', address: 'Ул. Никола Вапцаров 21', price: 380, service: 'rent', bedrooms: 1, sqm: 40, size: '40 м²', lat: 41.9981, lon: 21.4195 },
  { eb: 923, id: 923, location: 'Центар', address: 'Ул. Буњаковец 4', price: 700, service: 'rent', business: true, sqm: 55, size: '55 м²', lat: 41.9970, lon: 21.4179 },
  { eb: 924, id: 924, location: 'Центар', address: 'Ул. Буњаковец 9', price: 900, service: 'rent', business: true, sqm: 90, size: '90 м²', lat: 41.9985, lon: 21.4188 },
  // The other two categories, same place: a house (bedrooms exist) and a land
  // plot (no bedrooms — it is sized in м², and only its price is asked).
  { eb: 925, id: 925, location: 'Центар', address: 'Ул. Буњаковец 12', price: 600, service: 'rent', house: true, bedrooms: 4, sqm: 150, size: '150 м²', lat: 41.9972, lon: 21.4185 },
  { eb: 926, id: 926, location: 'Центар', address: 'Ул. Буњаковец 20', price: 45000, service: 'buy', plac: true, sqm: 300, size: '300 м²', lat: 41.9980, lon: 21.4190 },
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  get healthy(): boolean { return true; }
}

function makeHandler(id: string, rows: Property[] = ROWS) {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, new FakeProps(rows)),
    responder: new Responder(new FailingLlm(), cfg),
    properties: new FakeProps(rows),
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
    enrichment: new EnrichmentStore(db),
  });
  const say = async (m: string): Promise<string> => {
    await handler.handle('test', id, m);
    return sent.at(-1) ?? '';
  };
  return { say, sessions, chatId: id };
}

const LOCATION_ASK = /во кој дел од градот|која локација|на која конкретна локација|која населба/iu;

test('[02:15] «STO IMATE VO BUNJAKOVEC?» is inventory — the place is a POI, not a feed area', () => {
  const asks = [
    'ZDRAVO. STO IMATE VO BUNJAKOVEC?',
    'Здраво. Што имате во Буњаковец?',
    'STO IMATE POVOLNO VO BUNJAKOVEC ?',
    'што имаш во Ѓорче Петров?',
  ];
  for (const t of asks) {
    assert.equal(detectInventoryAsk(t), true, `inventory ask not recognised: ${t}`);
    assert.equal(detectSeeOffers(t), true, `the show-me lane must own it: ${t}`);
    assert.equal(detectNeighborhoodAsk(t), false, `area advice claimed inventory: ${t}`);
    for (const st of ['idle', 'intent', 'discovery']) {
      assert.equal(dispatchSimple(t, st), undefined, `an advice lane answered it in ${st}: ${t}`);
    }
  }
  // The place itself, shape-only: the caller resolves it against the map.
  assert.equal(extractInventoryPlace('ZDRAVO. STO IMATE VO BUNJAKOVEC?'), 'BUNJAKOVEC');
  assert.equal(extractInventoryPlace('STO IMATE POVOLNO VO CENTAR ?'), 'CENTAR');
  // …while an offer/grammar tail is not a place, and a demonstrative tail (the
  // known-area arm's own shape) is never read as a place name.
  assert.equal(extractInventoryPlace('STO IMATE VO PONUDA ?'), undefined);
  assert.equal(extractInventoryPlace('STO IMATE VO TOJ REON ?'), undefined);
  // EVERY category counts as a named type — not only стан.
  for (const t of ['SAKAM STAN', 'sakam kukja', 'mi treba dukjan', 'baram lokal',
    'sakam deloven prostor', 'baram plac', 'garsonjera', 'garaza']) {
    assert.equal(detectPropertyTypeWord(t), true, `type word missed: ${t}`);
  }
  assert.equal(detectPropertyTypeWord('ZDRAVO'), false);
});

test('e2e [02:15]: the OPENING ask is answered in prose — the place is remembered', async () => {
  const cfg = loadConfig();
  const map = new OfflineMapStore(cfg.skopjePoisDb);
  if (!map.available) return; // no live map on this machine — offlineMap.test.ts pins the DB
  const { say, sessions, chatId } = makeHandler('capture-0215');

  const first = await say('ZDRAVO. STO IMATE VO BUNJAKOVEC?');
  const s1 = sessions.get(chatId)!;
  // THE [17:30] OWNER RULE: a stock-at-a-place ask is a FUNNEL step — the place
  // is named, the offer is warm, and the question that is still owed is asked
  // (the MARKET here: the client never said buy or rent). No card is served,
  // because a card would answer a category he never named. Cards come after the
  // market and the type ([02:16]).
  assert.match(first, /Буњак/iu, `the answer names the place he asked about: ${first}`);
  assert.doesNotMatch(first, /Евидентен број/u, `no card pair before a category is known: ${first}`);
  assert.ok(!/стан(?:от)? го барате/iu.test(first), `no property type is presumed: ${first}`);
  assert.match(first, /(?:куп|набав)\p{L}*[\s\S]{0,60}изнајм|изнајм\p{L}*[\s\S]{0,60}(?:куп|набав)/iu,
    `the market question is the answer: ${first}`);
  assert.ok(s1.slots.poiAnchor, `the place the client named was dropped: ${first}`);
  assert.match(s1.slots.poiAnchor!, /буњак/iu, `wrong anchor: ${s1.slots.poiAnchor}`);
  assert.equal(s1.slots.inventoryPending, true, 'the type is still owed');
});

test('[01:45] the SAME ask in two openings gets the SAME answer — prose, one question', async () => {
  // One session, two clients:
  //   [01:45] DALI IMATE NESTO INTERESNO KAJ ZEBRA ?   → properties near Зебра
  //   [01:46] ZDRAVO . STO IMATE INTERESNO KAJ ZEBRA? → «дали сте во потрага по
  //           недвижност за купување или за изнајмување?»
  // Same question, two openings, two different answers. The [17:30] owner rule
  // settles it on the SECOND shape for BOTH: the client named a place and a
  // category was never said, so the answer is the prose + the market question —
  // never a card pair that presumes the category.
  const cfg = loadConfig();
  const map = new OfflineMapStore(cfg.skopjePoisDb);
  if (!map.available) return; // no live map on this machine — offlineMap.test.ts pins the DB
  const OPENINGS = [
    'DALI IMATE NESTO INTERESNO KAJ BUNJAKOVEC ?',
    'ZDRAVO . STO IMATE INTERESNO KAJ BUNJAKOVEC ?',
  ];
  for (const [i, msg] of OPENINGS.entries()) {
    const { say, sessions, chatId } = makeHandler(`capture-0145-${i}`);
    const reply = await say(msg);
    const s = sessions.get(chatId)!;
    assert.doesNotMatch(reply, /Евидентен број/u, `${msg}: no cards before the category: ${reply}`);
    assert.match(reply, /Буњак/iu, `${msg}: the place rides the answer: ${reply}`);
    assert.match(s.slots.poiAnchor ?? '', /буњак/iu, `${msg}: the place on file, got ${s.slots.poiAnchor}`);
    assert.equal(s.slots.inventoryPending, true, `${msg}: the type is still owed`);
    assert.doesNotMatch(reply, LOCATION_ASK, `${msg}: the place he named is never re-asked: ${reply}`);
    // CONTRACT, not one wording: the market question's bank variants read
    // «купување или изнајмување», «купување или ЗА изнајмување» and «барате
    // опција за изнајмување» — what must hold is BOTH markets named.
    assert.match(reply, /(?:куп|набав)\p{L}*[\s\S]{0,60}изнајм|изнајм\p{L}*[\s\S]{0,60}(?:куп|набав)/iu,
      `${msg}: the market question is the funnel step: ${reply}`);
  }

  // The NEUTRAL shape gets the SAME treatment (the owner extended [01:45] to
  // it). The difference between the openings is gone — one question, one answer.
  const { say, chatId } = makeHandler('capture-0145-plain');
  const plain = await say('ZDRAVO. STO IMATE VO BUNJAKOVEC?');
  assert.doesNotMatch(plain, /Евидентен број/u, `the neutral ask serves no cards: ${plain}`);
  assert.match(plain, /Буњак/iu, `the neutral ask names the place: ${plain}`);
  assert.doesNotMatch(plain, LOCATION_ASK, `the place he named is never re-asked: ${plain}`);
});

test('[16:57]/[17:30] the owner chain: prose → market → TYPE → the pair', async () => {
  // The [16:57] capture: «ZDRAVO , STO INTERESNO IMATE KAJ LEPTOKARIJA ?» — he
  // named a place and asked for stock; he never said apartment, buy or rent.
  // The [17:30] capture is the answer the owner accepted, and it is the chain
  // pinned here end to end:
  //   prose + «купување или изнајмување?» → «DA KUPAM SAKAM» asks the TYPE
  //   («стан, куќа, деловен простор или можеби плац?») → only then the pair,
  //   with that category's own criteria questions.
  const cfg = loadConfig();
  const map = new OfflineMapStore(cfg.skopjePoisDb);
  if (!map.available) return;
  // Near Буњаковец: two flats are the closest rows, a house is farther.
  const rows: Property[] = [
    { eb: 901, id: 901, location: 'Центар', address: 'Ул. Буњаковец 2', price: 69500, service: 'buy', bedrooms: 2, sqm: 35, size: '35 м²', lat: 41.9975, lon: 21.4186 },
    { eb: 902, id: 902, location: 'Центар', address: 'Ул. Буњаковец 6', price: 60000, service: 'buy', bedrooms: 3, sqm: 55, size: '55 м²', lat: 41.9976, lon: 21.4187 },
    { eb: 903, id: 903, location: 'Центар', address: 'Ул. Буњаковец 30', price: 90000, service: 'buy', house: true, bedrooms: 4, sqm: 150, size: '150 м²', lat: 41.9989, lon: 21.4202 },
  ];
  const { say, sessions, chatId } = makeHandler('capture-1657', rows);

  const first = await say('ZDRAVO , STO INTERESNO IMATE KAJ BUNJAKOVEC ?');
  assert.doesNotMatch(first, /Евидентен број/u, `no cards on the stock ask: ${first}`);
  // CONTRACT-level, not one bank wording: BOTH markets named in the question.
  // The owner's [20:38] copy («…дали Ве интересира купување на недвижност или
  // претпочитате изнајмување?») puts «на недвижност» between them, which the
  // old «купување или изнајмување» pattern could not see.
  assert.match(first, /(?:куп|набав)\p{L}*[\s\S]{0,60}изнајм|изнајм\p{L}*[\s\S]{0,60}(?:куп|набав)/iu,
    `the market question is the answer: ${first}`);
  const s1 = sessions.get(chatId)!;
  assert.equal(s1.slots.inventoryPending, true, 'the type is still owed');

  const second = await say('DA KUPAM SAKAM');
  assert.match(second, /стан, куќа, деловен простор или плац/iu,
    `the TYPE question follows the market: ${second}`);
  assert.ok(!/спалн/iu.test(second), `no bedrooms question before the type: ${second}`);

  // STEP 3 — the category's OWN questions, and NO pair yet (the owner's
  // [17:43] order: market → type → the category's information → the pair).
  const third = await say('STAN MI TREBA');
  assert.doesNotMatch(third, /Евидентен број/u,
    `no card before the category's criteria are known: ${third}`);
  assert.match(third, /спалн/iu, `the flat's own size question: ${third}`);
  assert.match(third, /цена|буџет|кирија/iu, `and its price question: ${third}`);

  // STEP 4 — with the criteria on file the pair is served, from that place.
  const fourth = await say('DVOSOBEN DO 80000');
  assert.match(fourth, /Евидентен број 90[12]/u, `the pair is served once the criteria are known: ${fourth}`);
});

test('[20:39] «STANCE» is a flat — the plural the type word knows is still the category answer', async () => {
  // The capture: the client wrote the PLURAL the field writes («STANCE», not
  // «STAN»). `detectPropertyTypeWord` knew it, `detectFlat` did not — so the
  // flat slot stayed empty, the category-ask lane could not fire, and the serve
  // lane put a pair on the table and asked «колку спални / која цена» AFTER it.
  // The owner's order is the opposite: define the ask, then serve a pair.
  const cfg = loadConfig();
  const map = new OfflineMapStore(cfg.skopjePoisDb);
  if (!map.available) return;
  assert.equal(detectFlat('STANCE SAKAM DA ZEMAM'), true, 'the plural is a flat');
  assert.equal(detectFlat('STANCEVI'), true, 'and so is the longer plural');
  assert.equal(detectFlat('СТАНЦЕ') || detectFlat('станце'), true, 'in either script');

  const { say, sessions, chatId } = makeHandler('capture-2039');
  const first = await say('ZDRAVO , KAZI MI STO IMA INTERESNO KAJ BUNJAKOVEC ?');
  // The place prose claims NOTHING about stock (the [20:38] owner rule).
  assert.equal(assertsStockAtPlace(first), false, `no stock claim in the opening: ${first}`);
  assert.doesNotMatch(first, /Евидентен број/u, `no cards on the stock ask: ${first}`);
  assert.match(first, /купување[\s\S]{0,40}изнајмување/iu, `the market question: ${first}`);

  const second = await say('ZA KUPUVANJE SUM');
  assert.match(second, /стан, куќа, деловен простор или плац/iu, `the TYPE is asked: ${second}`);

  // THE TURN THE CAPTURE GOT WRONG: the category alone (no rooms, no price).
  const third = await say('STANCE SAKAM DA ZEMAM');
  assert.doesNotMatch(third, /Евидентен број/u,
    `no pair before the criteria are known: ${third}`);
  assert.match(third, /спалн/iu, `the flat's size question is asked FIRST: ${third}`);
  assert.match(third, /цена|буџет/iu, `and its price question: ${third}`);
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.flat, true, 'the plural armed the flat slot');
  assert.deepEqual(s.slots.presentedIds ?? [], [], 'nothing was presented');

  // …and the pair only after the criteria (the order, end to end).
  const fourth = await say('DVOSOBEN DO 80000');
  assert.match(fourth, /Евидентен број/u, `the pair serves once the criteria are known: ${fourth}`);
});

test('e2e [02:16]: the typed acquisition SERVES from that place and asks its own questions', async () => {
  const cfg = loadConfig();
  const map = new OfflineMapStore(cfg.skopjePoisDb);
  if (!map.available) return;
  const { say, sessions, chatId } = makeHandler('capture-0216');
  await say('ZDRAVO. STO IMATE VO BUNJAKOVEC?');

  // The type answer comes BEFORE the criteria and before any card (the [17:43]
  // order): the flat's own rooms + rent questions are the answer here.
  const ask = await say('SAKAM DA IZNAJMAM STAN VO BUNJAKOVEC ?');
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.service, 'rent', `the market is rent: ${ask}`);
  assert.equal(s.state, 'discovery', `the criteria are still owed: ${ask}`);
  assert.doesNotMatch(ask, LOCATION_ASK, `the place he named must not be re-asked: ${ask}`);
  assert.doesNotMatch(ask, /Евидентен број/u, `no card before the criteria: ${ask}`);
  assert.match(ask, /спалн/iu, `the rooms question: ${ask}`);
  assert.match(ask, /кирија|цена|износ/iu, `the rent question: ${ask}`);

  // …and the pair is served once they are answered — from that place, RENT only,
  // with its distance stated.
  const reply = await say('DVOSOBEN DO 500');
  assert.equal(sessions.get(chatId)!.state, 'presentation', `the criteria complete the funnel: ${reply}`);
  assert.match(reply, /Евидентен број 92[12]/u, `a rent card must serve: ${reply}`);
  assert.ok(!/Евидентен број 92[34]/u.test(reply), `business rows in a стан answer: ${reply}`);
  assert.match(reply, /(?:м|метри|km) од|Железнич|Буњак/iu, `the serve states its anchor: ${reply}`);
});

test('e2e [02:16] sibling: a BUSINESS ask gets м² + price, never the bedrooms question', async () => {
  const cfg = loadConfig();
  const map = new OfflineMapStore(cfg.skopjePoisDb);
  if (!map.available) return;
  const { say, sessions, chatId } = makeHandler('capture-0216-biz');
  await say('ZDRAVO. STO IMATE VO BUNJAKOVEC?');

  const ask = await say('SAKAM DA IZNAJMAM DUKJAN VO BUNJAKOVEC ?');
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.service, 'rent');
  assert.equal(s.slots.business, true, 'the commercial market is on file');
  assert.doesNotMatch(ask, LOCATION_ASK, `the place must not be re-asked: ${ask}`);
  // A деловен простор is sized in м², not in спални — and asked BEFORE the pair.
  assert.doesNotMatch(ask, /колку спални|спални соби/iu, `a business ask was asked for bedrooms: ${ask}`);
  assert.doesNotMatch(ask, /Евидентен број/u, `no card before the criteria: ${ask}`);
  assert.match(ask, /површина|м²|квадрат/iu, `the business size question: ${ask}`);
  assert.match(ask, /цена|кирија|износ/iu, `and its price question: ${ask}`);

  const reply = await say('60 KVADRATI DO 800');
  assert.match(reply, /Евидентен број 92[34]/u, `a business card must serve: ${reply}`);
});

// THE OTHER TWO CATEGORIES (the [02:16] sweep): the shared builder must give
// each type ITS OWN questions — a house has bedrooms, a land plot has none, and
// neither may be asked in the words of a flat.
test('e2e [02:16] sibling: a HOUSE ask asks the house criteria, never the flat wording', async () => {
  const cfg = loadConfig();
  const map = new OfflineMapStore(cfg.skopjePoisDb);
  if (!map.available) return;
  const { say, sessions, chatId } = makeHandler('capture-0216-house');
  await say('ZDRAVO. STO IMATE VO BUNJAKOVEC?');

  const ask = await say('SAKAM DA IZNAJMAM KUKJA VO BUNJAKOVEC ?');
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.service, 'rent');
  assert.equal(s.slots.house, true, 'the house category is on file');
  assert.doesNotMatch(ask, LOCATION_ASK, `the place must not be re-asked: ${ask}`);
  assert.doesNotMatch(ask, /Евидентен број/u, `no card before the criteria: ${ask}`);
  assert.match(ask, /спалн/iu, `the house is asked for bedrooms: ${ask}`);
  assert.match(ask, /кирија|цена/iu, `and for its money: ${ask}`);

  const reply = await say('CETIRISOBEN DO 700');
  assert.match(reply, /Евидентен број 925/u, `the house card must serve: ${reply}`);
  assert.match(reply, /Куќата под Евидентен број/u, `a house reads as куќата: ${reply}`);
});

test('e2e [02:16] sibling: a PLOT ask is asked for the plot — no bedrooms, no «станот»', async () => {
  const cfg = loadConfig();
  const map = new OfflineMapStore(cfg.skopjePoisDb);
  if (!map.available) return;
  const { say, sessions, chatId } = makeHandler('capture-0216-plac');
  await say('ZDRAVO. STO IMATE VO BUNJAKOVEC?');

  const ask = await say('SAKAM DA KUPAM PLAC VO BUNJAKOVEC ?');
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.service, 'buy');
  assert.equal(s.slots.plac, true, 'the plot category is on file');
  assert.doesNotMatch(ask, LOCATION_ASK, `the place must not be re-asked: ${ask}`);
  // A ПЛАЦ has no спални and is never «станот» — the builder's own rule.
  assert.doesNotMatch(ask, /спалн/iu, `a land plot was asked for bedrooms: ${ask}`);
  assert.doesNotMatch(ask, /станот/iu, `a land plot was called a flat: ${ask}`);
  assert.match(ask, /плац/iu, `the plot question names the plot: ${ask}`);
  assert.match(ask, /цена/iu, `and asks its price: ${ask}`);
  assert.doesNotMatch(ask, /Евидентен број/u, `no card before the criteria: ${ask}`);

  const reply = await say('DO 50000');
  assert.match(reply, /Евидентен број 926/u, `the plot card must serve: ${reply}`);
});
