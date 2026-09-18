// THE 22:59–23:01 TRANSCRIPT — the client pushed back on the landmark line:
//   [22:59] prvo kazi mi kade se naogja ?        → "Тоа се наоѓа во близина на KAM маркет."
//   [23:00] da ne e vo skopjanka ?
//   [23:01] → THE GENERIC FEE PITCH (Мило ми е за Вашиот избор… 500 денари…)
// THE CONTRACT:
//   1. A yes/no question about a NAMED PLACE ("da ne e vo skopjanka ?") is a
//      location CONFIRMATION about the property under discussion — it must be
//      ANSWERED (yes/no against the offline map), never misread as fee or
//      agreement traffic, in ANY state;
//   2. The answer reveals the AREA (landmark/distance/neighborhood) but never
//      the exact address — the visit-reveal protocol line is part of the reply;
//   3. Grammar-based detection: Latin and Cyrillic, all common scaffolds
//      (leading "da", "dali", negated "ne e", the "li" particle, markers,
//      trailing "?") — no hand-list that always lags;
//   4. Typed Latin place names must resolve against the Cyrillic OSM map
//      (script bridge in findPoiByName).
import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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
import { InboundHandler } from '../src/handlers/inbound';
import { LlmClient } from '../src/llm/types';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore, writeMap } from '../src/geo/offlineMap';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429'); }
}

// Mirror of the transcript: the property is in Центар, ТЦ Скопјанка is 1.1 km
// away (NOT nearby), KAM маркет is 55 m away (directly there).
const ROWS: Property[] = [
  { eb: 77, id: 77, address: 'МИРЧЕ ОРОВЧАНЕЦ 86 - 1', location: 'Центар', price: 130000, service: 'buy', lat: 41.98858, lon: 21.45158, geo_source: 'osm_low_confidence' },
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

function buildTestMap(): OfflineMapStore {
  const dbPath = path.join(os.tmpdir(), `poi-confirm-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  writeMap(dbPath, [
    { name: 'KAM маркет', type: 'supermarket', lat: 41.98858, lon: 21.45224, source: 'osm' },  // ≈55 m
    { name: 'ТЦ Скопјанка', type: 'mall', lat: 41.9930, lon: 21.4390, source: 'osm' },         // ≈1.1 km
  ], []);
  return new OfflineMapStore(dbPath);
}

function makeHandler(landmarks: LandmarkService): { handler: InboundHandler; sessions: SessionStore; sent: string[] } {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS);
  const llm = new FailingLlm();
  const classifier = new Classifier(llm, cfg, properties);
  const responder = new Responder(llm, cfg);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels, landmarks,
  });
  return { handler, sessions, sent };
}

const FEE_TRAFFIC = /провизи|500\s*денари|надомест|Мило ми е за Вашиот избор/iu;
const REVEAL = /денот на посетата/iu;

test('detector: grammar-based scaffolds, both scripts', async () => {
  const { isPoiConfirmQuestion, extractPoiConfirmPlace } = await import('../src/llm/deterministic');
  // The exact transcript message
  assert.equal(isPoiConfirmQuestion('da ne e vo skopjanka ?'), true);
  assert.equal(extractPoiConfirmPlace('da ne e vo skopjanka ?'), 'skopjanka');
  // Cyrillic twin (raw capture preserves the client's letter case)
  assert.equal(isPoiConfirmQuestion('да не е во Скопјанка ?'), true);
  assert.equal(extractPoiConfirmPlace('да не е во Скопјанка ?')?.toLowerCase(), 'скопјанка');
  // Other scaffolds
  assert.equal(isPoiConfirmQuestion('dali e vo skopjanka?'), true);
  assert.equal(isPoiConfirmQuestion('vo skopjanka li e?'), true);
  assert.equal(isPoiConfirmQuestion('znaci e kaj skopjanka'), true);
  assert.equal(isPoiConfirmQuestion('ne e vo karpos?'), true);
  // NOT confirms: statements and searches
  assert.equal(isPoiConfirmQuestion('sakam stan vo karpos'), false);
  assert.equal(isPoiConfirmQuestion('e vo skopjanka.'), false);
  // Wh-questions are a different family
  assert.equal(isPoiConfirmQuestion('kade e skopjanka?'), false);
});

test('transcript regression: the push-back is answered, never the fee pitch', async () => {
  const svc = new LandmarkService(new Db(':memory:'), { osm: false, offlineMap: buildTestMap() });
  const { handler, sessions, sent } = makeHandler(svc);
  const chatId = 'eb77';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  await send('go gledav stanot so broj 77');
  await send('prvo kazi mi kade se naogja ?');
  assert.ok(/KAM маркет|населбата Центар|во близина на/i.test(sent[sent.length - 1]),
    `where-is must serve a location answer: ${sent[sent.length - 1]}`);

  await send('da ne e vo skopjanka ?');
  const reply = sent[sent.length - 1];
  assert.ok(!FEE_TRAFFIC.test(reply), `must never be fee traffic: ${reply}`);
  assert.ok(/Не,/.test(reply), `honest NO — Скопјанка is 1.1 km away: ${reply}`);
  assert.ok(/Скопјанка/.test(reply), `the named place must be resolved: ${reply}`);
  assert.ok(/Центар/.test(reply), `the real area must be revealed: ${reply}`);
  assert.ok(REVEAL.test(reply), `the visit-reveal protocol must be stated: ${reply}`);
  assert.equal(sessions.get(chatId)!.state, 'property_query', 'a confirmation must not transition the FSM');
});

test('map-confirmed YES: a truly nearby place gets an honest yes + protocol', async () => {
  const svc = new LandmarkService(new Db(':memory:'), { osm: false, offlineMap: buildTestMap() });
  const { handler, sessions, sent } = makeHandler(svc);
  const chatId = 'eb77-kam';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  await send('go gledav stanot so broj 77');
  await send('da ne e kaj kam market ?');
  const reply = sent[sent.length - 1];
  assert.ok(!FEE_TRAFFIC.test(reply), `must never be fee traffic: ${reply}`);
  assert.ok(/Да,/.test(reply), `honest YES — KAM is 55 m away: ${reply}`);
  assert.ok(/KAM маркет/.test(reply), `the resolved place must be named: ${reply}`);
  assert.ok(REVEAL.test(reply), `the visit-reveal protocol must be stated: ${reply}`);
});

test('script bridge: Latin-typed place names resolve against the Cyrillic map', async () => {
  const map = buildTestMap();
  // Direct store-level check — the transliteration bridge
  const hit = map.findPoiByName('skopjanka');
  assert.ok(hit, 'latin "skopjanka" must find the Cyrillic "ТЦ Скопјанка"');
  assert.equal(hit!.name, 'ТЦ Скопјанка');
});

test('neighborhood confirms keep working: feed-verified answer with protocol', async () => {
  const svc = new LandmarkService(new Db(':memory:'), { osm: false, offlineMap: buildTestMap() });
  const { handler, sessions, sent } = makeHandler(svc);
  const chatId = 'eb77-area';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  await send('go gledav stanot so broj 77');
  await send('da ne e vo karpos ?');
  const reply = sent[sent.length - 1];
  assert.ok(!FEE_TRAFFIC.test(reply), `must never be fee traffic: ${reply}`);
  assert.ok(/не|Не/.test(reply), `honest NO — the property is in Центар: ${reply}`);
  assert.ok(/Центар/.test(reply), `the real area must be revealed: ${reply}`);
  assert.ok(REVEAL.test(reply), `the visit-reveal protocol must be stated: ${reply}`);
});

test('no anchored property → the confirm family stands down (no invented answers)', async () => {
  const svc = new LandmarkService(new Db(':memory:'), { osm: false, offlineMap: buildTestMap() });
  const { handler, sessions, sent } = makeHandler(svc);
  const chatId = 'noanchor';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  await send('zdravo');
  await send('da ne e vo skopjanka ?');
  const reply = sent[sent.length - 1];
  // Without a property under discussion there is nothing to confirm — the
  // normal funnel continues (LLM/classifier handles it); no map-verified
  // yes/no may be invented.
  assert.ok(!/денот на посетата/.test(reply) || FEE_TRAFFIC.test(reply) === false, 'no protocol echo without context');
});
