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
  detectNeighborhoodAsk,
} from '../src/llm/deterministic';
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

function makeHandler(id: string) {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, new FakeProps(ROWS)),
    responder: new Responder(new FailingLlm(), cfg),
    properties: new FakeProps(ROWS),
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

test('e2e [02:15]: the OPENING ask is served from the place — and the place is remembered', async () => {
  const cfg = loadConfig();
  const map = new OfflineMapStore(cfg.skopjePoisDb);
  if (!map.available) return; // no live map on this machine — offlineMap.test.ts pins the DB
  const { say, sessions, chatId } = makeHandler('capture-0215');

  const first = await say('ZDRAVO. STO IMATE VO BUNJAKOVEC?');
  const s1 = sessions.get(chatId)!;
  // THE SERVE IS THE ANSWER (the owner's [01:45] extension of this rule): the
  // client named a place and asked for stock, so the rows near it are shown.
  // This assertion used to pin «nothing is served on a blank session (there is
  // no type to serve)» — the lost PLACE was the reported defect then; what the
  // place now buys is the serve itself, with the TYPE question riding it (the
  // [02:15] owner wording, type-neutral — no category is presumed).
  assert.match(first, /Евидентен број 92\d/u, `the rows near the place serve: ${first}`);
  assert.ok(!/стан(?:от)? го барате/iu.test(first), `no property type is presumed: ${first}`);
  assert.match(first, /тип|стан, куќа|деловен простор или плац|купување или за изнајмување/iu,
    `the type question rides the serve: ${first}`);
  assert.ok(s1.slots.poiAnchor, `the place the client named was dropped: ${first}`);
  assert.match(s1.slots.poiAnchor!, /буњак/iu, `wrong anchor: ${s1.slots.poiAnchor}`);
});

test('[01:45] the SAME ask in two openings gets the SAME answer — the options at the place', async () => {
  // One session, two clients:
  //   [01:45] DALI IMATE NESTO INTERESNO KAJ ZEBRA?   → three properties near Зебра
  //   [01:46] ZDRAVO . STO IMATE INTERESNO KAJ ZEBRA? → «дали сте во потрага по
  //           недвижност за купување или за изнајмување?»
  // Same question, two openings, two different answers. The dali/li shape was
  // not an inventory ask at all (it reached the classifier as a
  // PROPERTY_DESCRIPTION guess, so its serve depended on that guess) and the
  // «интересно/нешто» qualifier was ignored. Both are ONE family now: a PLACE +
  // an options qualifier is a SHOW-ME ask, answered from the rows around the
  // place. The PLAIN «што имате во X» keeps the [02:15] contract — remember the
  // place and ask the type, serve nothing before the category is known.
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
    assert.match(reply, /Евидентен број 92\d/u, `the rows near the place must serve: ${msg} → ${reply}`);
    assert.match(s.slots.poiAnchor ?? '', /буњак/iu, `${msg}: the place on file, got ${s.slots.poiAnchor}`);
    assert.equal(s.slots.inventoryOptionsServed, true, `${msg}: a blank options serve is on file`);
    assert.equal(s.slots.inventoryPending, true, `${msg}: the type is still owed`);
    assert.doesNotMatch(reply, LOCATION_ASK, `${msg}: the place he named is never re-asked: ${reply}`);
    // …and the type question rides the serve, type-neutral (names no category he
    // did not say — the cards describe the rows, the QUESTION presumes nothing).
    assert.match(reply, /тип|стан, куќа|деловен простор или плац/iu, `${msg}: the type ask: ${reply}`);
  }

  // The NEUTRAL shape serves too (the owner extended [01:45] to it): the cards
  // answer «what is there» and the type question rides them. The difference
  // between the openings is gone — one question, one answer.
  const { say, chatId } = makeHandler('capture-0145-plain');
  const plain = await say('ZDRAVO. STO IMATE VO BUNJAKOVEC?');
  assert.match(plain, /Евидентен број 92\d/u, `the neutral ask serves the rows: ${plain}`);
  assert.doesNotMatch(plain, LOCATION_ASK, `the place he named is never re-asked: ${plain}`);
});

test('e2e [02:16]: the typed acquisition SERVES from that place and asks its own questions', async () => {
  const cfg = loadConfig();
  const map = new OfflineMapStore(cfg.skopjePoisDb);
  if (!map.available) return;
  const { say, sessions, chatId } = makeHandler('capture-0216');
  await say('ZDRAVO. STO IMATE VO BUNJAKOVEC?');

  const reply = await say('SAKAM DA IZNAJMAM STAN VO BUNJAKOVEC ?');
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.service, 'rent', `the market is rent: ${reply}`);
  assert.equal(s.state, 'presentation', `the typed answer presents: ${reply}`);
  assert.doesNotMatch(reply, LOCATION_ASK, `the place he named must not be re-asked: ${reply}`);
  // A pair from that place, RENT only, with its distance stated.
  assert.match(reply, /Евидентен број 92[12]/u, `a rent card must serve: ${reply}`);
  assert.ok(!/Евидентен број 92[34]/u.test(reply), `business rows in a стан answer: ${reply}`);
  assert.match(reply, /(?:м|метри|km) од|Железнич|Буњак/iu, `the serve states its anchor: ${reply}`);
  // …and the rooms + rent questions ride the same turn.
  assert.match(reply, /спалн/iu, `the rooms question rides the serve: ${reply}`);
  assert.match(reply, /кирија|цена|износ/iu, `the rent question rides the serve: ${reply}`);
});

test('e2e [02:16] sibling: a BUSINESS ask gets м² + price, never the bedrooms question', async () => {
  const cfg = loadConfig();
  const map = new OfflineMapStore(cfg.skopjePoisDb);
  if (!map.available) return;
  const { say, sessions, chatId } = makeHandler('capture-0216-biz');
  await say('ZDRAVO. STO IMATE VO BUNJAKOVEC?');

  const reply = await say('SAKAM DA IZNAJMAM DUKJAN VO BUNJAKOVEC ?');
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.service, 'rent');
  assert.equal(s.slots.business, true, 'the commercial market is on file');
  assert.doesNotMatch(reply, LOCATION_ASK, `the place must not be re-asked: ${reply}`);
  // A деловен простор is sized in м², not in спални.
  assert.doesNotMatch(reply, /колку спални|спални соби/iu, `a business ask was asked for bedrooms: ${reply}`);
  assert.match(reply, /површина|м²|квадрат/iu, `the business size question rides the serve: ${reply}`);
  assert.match(reply, /цена|кирија|износ/iu, `and its price question: ${reply}`);
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

  const reply = await say('SAKAM DA IZNAJMAM KUKJA VO BUNJAKOVEC ?');
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.service, 'rent');
  assert.equal(s.slots.house, true, 'the house category is on file');
  assert.doesNotMatch(reply, LOCATION_ASK, `the place must not be re-asked: ${reply}`);
  assert.match(reply, /Евидентен број 925/u, `the house card must serve: ${reply}`);
  assert.match(reply, /Куќата под Евидентен број/u, `a house reads as куќата: ${reply}`);
  assert.match(reply, /спалн/iu, `the house is asked for bedrooms: ${reply}`);
  assert.match(reply, /кирија|цена/iu, `and for its money: ${reply}`);
});

test('e2e [02:16] sibling: a PLOT ask is asked for the plot — no bedrooms, no «станот»', async () => {
  const cfg = loadConfig();
  const map = new OfflineMapStore(cfg.skopjePoisDb);
  if (!map.available) return;
  const { say, sessions, chatId } = makeHandler('capture-0216-plac');
  await say('ZDRAVO. STO IMATE VO BUNJAKOVEC?');

  const reply = await say('SAKAM DA KUPAM PLAC VO BUNJAKOVEC ?');
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.service, 'buy');
  assert.equal(s.slots.plac, true, 'the plot category is on file');
  assert.doesNotMatch(reply, LOCATION_ASK, `the place must not be re-asked: ${reply}`);
  // A ПЛАЦ has no спални and is never «станот» — the builder's own rule.
  assert.doesNotMatch(reply, /спалн/iu, `a land plot was asked for bedrooms: ${reply}`);
  assert.doesNotMatch(reply, /станот|станот под/iu, `a land plot was called a flat: ${reply}`);
  assert.match(reply, /плац/iu, `the plot question names the plot: ${reply}`);
  assert.match(reply, /цена/iu, `and asks its price: ${reply}`);
  assert.match(reply, /Евидентен број 926/u, `the plot card must serve: ${reply}`);
});
