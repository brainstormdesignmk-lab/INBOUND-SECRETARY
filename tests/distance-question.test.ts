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

test('the router mirror predicts DISTANCE for the capture line', () => {
  assert.equal(resolveIntent('KOLKU IMA OD STANOT DO BUNJAKOVEC TRGOVSKI?', 'idle'), 'DISTANCE');
});

// ── 2. THE ANSWER, THROUGH THE REAL HANDLER ─────────────────────────────────

async function makeHandler(): Promise<{ handler: InboundHandler; sessions: SessionStore; sent: string[] }> {
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
  // THE NUMBER: EB 70's own pin (41.9993,21.4213) to the mall — 133 m, so a
  // three-digit metre figure. Measured, never invented.
  assert.match(answer, /на 1[0-9]0 метри/, `the measured distance, rounded to 10 m: ${answer}`);
  assert.match(answer, /од имотот/, `it is stated as a distance FROM the property: ${answer}`);
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
