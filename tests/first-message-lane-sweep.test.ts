/**
 * THE FIRST-MESSAGE LANE SWEEP — the [01:45] defect class, not just its case.
 *
 * The capture: two clients in one session asked the same question and got two
 * answers, because the lane that owns the question was gated on a STATE the
 * chat had not reached yet (a stock-at-a-place serve only fired from
 * `discovery`, so as a first message it fell to the intake and asked
 * «дали сте во потрага по недвижност за купување или за изнајмување?»).
 *
 * A state gate is only safe when the message cannot arrive that early. These
 * are the conditions a FIRST message (idle) must satisfy, for every captured
 * phrasing in the corpus below:
 *
 *   1. STOCK AT A PLACE IS SERVED — a place the map resolves + a have-ask gets
 *      the rows near it, never a generic question;
 *   2. NEVER ASK BACK WHAT WAS SAID — a named place is never answered with
 *      «кој дел од градот / која населба», a named market never with
 *      «купување или изнајмување?», a named category never with «кој тип»;
 *   3. A BLANK ACQUISITION IS NOT A RECALL — an inventory ask never gets «таа
 *      што ја баравте» (the [02:38] rule), even though rows were served;
 *   4. THE FEATURE LANE KEEPS ITS TURN — «dali ima terasa vo stanot?» is about
 *      the flat, never an inventory ask, even with a card on the table.
 *
 * The feed is synthetic (rows at the map's own БUNJAKOVEC pin) so the
 * assertions are deterministic; the MAP is the shipped one, because the place
 * is what makes a serve possible at all.
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

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

// Around the map's own Буњаковец pin — one row per category, so every typed
// answer below has something real to serve.
const ROWS: Property[] = [
  { eb: 921, id: 921, location: 'Центар', address: 'Ул. Никола Вапцаров 8', price: 450, service: 'rent', bedrooms: 2, sqm: 62, size: '62 м²', lat: 41.9976, lon: 21.4182 },
  { eb: 922, id: 922, location: 'Центар', address: 'Ул. Никола Вапцаров 21', price: 380, service: 'rent', bedrooms: 1, sqm: 40, size: '40 м²', lat: 41.9981, lon: 21.4195 },
  { eb: 923, id: 923, location: 'Центар', address: 'Ул. Буњаковец 4', price: 700, service: 'rent', business: true, sqm: 55, size: '55 м²', lat: 41.9970, lon: 21.4179 },
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

const LOCATION_ASK = /во кој дел од градот|која локација|на која конкретна локација|која населба|кој дел од градот/iu;
const SERVICE_ASK = /(?:купув|изнајм|закуп|кириј)\p{L}*[^.?!]{0,45}(?:купув|изнајм|закуп|кириј)|(?:купув|изнајм|закуп|кириј)\p{L}*[^.?!]{0,45}(?:изнајм|закуп|кириј)/iu;
const TYPE_ASK = /тип недвижност|стан, куќа|деловен простор или плац/iu;
const RECALL_ASK = /таа што ја баравте|which of these did you mean/iu;
const CARDS = /Евидентен број \d+|Станот под Евидентен|Куќата под Евидентен|Деловниот простор под Евидентен|Плацот под Евидентен/iu;

test('first-message stock-at-a-place asks are ANSWERED from the place, in every opening', async () => {
  const cfg = loadConfig();
  const map = new OfflineMapStore(cfg.skopjePoisDb);
  if (!map.available) return; // no live map on this machine — offlineMap.test.ts pins the DB
  // The [01:45] pair, the [02:15] neutral shape, and the «кај» opening — one
  // question in four spellings.
  //
  // THE ANSWER IS THE [20:38] PROSE, NOT A CARD PAIR (the owner's rule, for
  // EVERY landmark): the place is acknowledged and the market question is
  // asked — «Здраво. За <place> — дали Ве интересира купување на недвижност
  // или претпочитате изнајмување?». Two flats with prices on top of that read
  // as «an apartment was assumed, buy or rent was assumed» — exactly what the
  // capture was — and a stock claim («имаме одлични понуди») asserts inventory
  // we have not looked at. Cards come AFTER the category and its criteria are
  // known (the [02:16] chain), never before.
  for (const [i, msg] of [
    'DALI IMATE NESTO INTERESNO KAJ BUNJAKOVEC ?',
    'ZDRAVO . STO IMATE INTERESNO KAJ BUNJAKOVEC ?',
    'ZDRAVO. STO IMATE VO BUNJAKOVEC?',
    'IMATE LI NESTO KAJ BUNJAKOVEC ?',
  ].entries()) {
    const { say, sessions, chatId } = makeHandler(`sweep-serve-${i}`);
    const reply = await say(msg);
    assert.doesNotMatch(reply, CARDS, `no card may be served before the category: ${msg} → ${reply}`);
    assert.match(reply, /Буњак/u, `the place the client named is the answer's anchor: ${msg} → ${reply}`);
    // CONTRACT: both markets named in ONE question (the bank's variants put
    // «на недвижност» between them — pinning one wording made a false failure).
    assert.match(reply, /(?:куп|набав)\p{L}*[\s\S]{0,60}изнајм|изнајм\p{L}*[\s\S]{0,60}(?:куп|набав)/iu,
      `the one question still owed (the market) is asked: ${msg} → ${reply}`);
    assert.doesNotMatch(reply, /тип недвижност|стан, куќа/iu,
      `the type follows the market, not the other way round: ${msg} → ${reply}`);
    assert.doesNotMatch(reply, LOCATION_ASK, `the place is named — never re-asked: ${msg} → ${reply}`);
    assert.doesNotMatch(reply, RECALL_ASK, `a blank acquisition is not a recall (the [02:38] rule): ${msg} → ${reply}`);
    // The type is STILL OWED and no batch was shown — the flags the next turn reads.
    const s = sessions.get(chatId)!;
    assert.equal(s.slots.inventoryPending, true, `the type is still owed: ${msg}`);
    assert.notEqual(s.slots.inventoryOptionsServed, true, `no batch was served: ${msg}`);
  }
});

test('a first message that already names the market is never asked it again', async () => {
  const cfg = loadConfig();
  const map = new OfflineMapStore(cfg.skopjePoisDb);
  if (!map.available) return;
  for (const [i, msg] of [
    'SAKAM DA KUPAM STAN VO BUNJAKOVEC',
    'STAN POD KIRIJA KAJ BUNJAKOVEC DO 500',
    'SAKAM DA IZNAJMAM DUKJAN VO BUNJAKOVEC',
    'BARAM KUKJA ZA KUPUVANJE KAJ BUNJAKOVEC',
  ].entries()) {
    const { say, sessions, chatId } = makeHandler(`sweep-market-${i}`);
    const reply = await say(msg);
    const s = sessions.get(chatId)!;
    assert.ok(s.slots.service, `the market the client declared is on file: ${msg} → ${reply}`);
    assert.doesNotMatch(reply, LOCATION_ASK, `the place he named is never re-asked: ${msg} → ${reply}`);
    assert.doesNotMatch(reply, SERVICE_ASK, `the market he declared is never re-asked: ${msg} → ${reply}`);
  }
});

test('a first message that names the category is never asked which category', async () => {
  const cfg = loadConfig();
  const map = new OfflineMapStore(cfg.skopjePoisDb);
  if (!map.available) return;
  for (const [i, msg] of [
    'SAKAM DA IZNAJMAM DUKJAN VO BUNJAKOVEC',
    'MI TREBA PLAC VO BUNJAKOVEC ZA KUPUVANJE',
    'SAKAM KUKJA POD KIRIJA KAJ BUNJAKOVEC',
  ].entries()) {
    const { say } = makeHandler(`sweep-type-${i}`);
    const reply = await say(msg);
    assert.doesNotMatch(reply, TYPE_ASK, `the category he named is never re-asked: ${msg} → ${reply}`);
    assert.doesNotMatch(reply, LOCATION_ASK, `the place he named is never re-asked: ${msg} → ${reply}`);
  }
});

test('the feature lane keeps its turn — «dali ima terasa vo stanot?» is not an inventory ask', async () => {
  const cfg = loadConfig();
  const map = new OfflineMapStore(cfg.skopjePoisDb);
  if (!map.available) return;
  const { say } = makeHandler('sweep-feature');
  // A stock ask at the place is answered with prose (no card), then the typed
  // answer serves the pair — so a card IS on the table when the feature
  // question arrives, which is the case that used to be answered with a second
  // inventory serve (the word «стан» in «vo stanot» read as the category
  // answer to the ask still owed).
  const prose = await say('ZDRAVO. STO IMATE VO BUNJAKOVEC?');
  assert.doesNotMatch(prose, CARDS, `the stock ask serves prose, not a pair: ${prose}`);
  const ask = await say('SAKAM DA IZNAJMAM STAN VO BUNJAKOVEC ?');
  assert.doesNotMatch(ask, CARDS, `the type is answered with its criteria, not a pair: ${ask}`);
  const cards = await say('DVOSOBEN DO 500');
  assert.match(cards, CARDS, `the criteria serve the pair: ${cards}`);
  const reply = await say('DALI IMA TERASA VO STANOT ?');
  assert.doesNotMatch(reply, /Еве ги најблиските опции/iu,
    `a feature question is not a new inventory serve: ${reply}`);
});
