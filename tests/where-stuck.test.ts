// THE 20:51–20:54 TRANSCRIPT — the client saw "stanot so broj 77" and asked:
//   [20:51] kade tocno se naogja ?
//   [20:53] moram da znam kade mu e lokacijata prvo...
//   [20:54] kazi mi togas odprilika kade e
// Old behavior: every ask landed on the SAME line — "За точната локација,
// можам да Ви организирам посета — сакате ли?" — three times in a row.
// THE CONTRACT:
//   1. An anchored property with low-confidence coords gets the nearby
//      landmark ROTATION (L1 → L2 → L3), never the visit pitch, never the
//      same line twice;
//   2. A NAMED property that is GONE from the feed gets the honest
//      not-found pivot (property.notfound) with an offer of similar
//      properties — not the pitch;
//   3. A where-is ask with NO property under discussion gets the
//      ask-for-the-Евидентен-број escape — not the pitch, twice.
import { test } from 'node:test';
import assert from 'node:assert';
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
import path from 'path';
import os from 'os';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

// EB 77 mirror: Центар, low-confidence coordinates, nothing else resolvable.
// EB 76: real anchors (a landmark already stamped by the feed layer).
// EB 57: Бутел — the not-found pivot must match its neighborhood, not Центар.
const ROWS: Property[] = [
  { eb: 77, id: 77, address: 'МИРЧЕ ОРОВЧАНЕЦ 86 - 1', location: 'Центар', price: 130000, service: 'buy', lat: 41.999, lon: 21.4138, geo_source: 'osm_low_confidence' },
  { eb: 76, id: 76, address: 'Партизанска 12', location: 'Центар', price: 120000, service: 'buy', landmark: 'Градежен факултет' },
  { eb: 57, id: 57, address: 'Бутелска 4', location: 'Бутел', price: 60000, service: 'buy' },
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

// A small offline map: two POIs 350–420 m from EB 77's center (inside the
// 300–500m grace window) and Градежен факултет 425 m from EB 76's.
function buildTestMap(): OfflineMapStore {
  const dbPath = path.join(os.tmpdir(), `where-stuck-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  writeMap(dbPath, [
    { name: 'ТЦ Олимписки', type: 'mall', lat: 41.9990, lon: 21.4178, source: 'osm' },   // ≈331 m
    { name: 'ОУ Гоце Делчев', type: 'school', lat: 42.0018, lon: 21.4132, source: 'osm' }, // ≈315 m
    { name: 'Градежен факултет', type: 'university', lat: 42.003, lon: 21.433, source: 'osm' },
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

// The exact line the transcript got stuck on.
const VISIT_PITCH = /За точната локација, можам да Ви организирам посета/iu;
const LANDMARK_LINE = /Тоа се наоѓа во близина на/iu;
const EB_NAMED = /број 77|77/iu;

test('detector: the three transcript messages all fire the generic where-is family', async () => {
  const { detectWhereIs } = await import('../src/llm/deterministic');
  assert.deepEqual(detectWhereIs('kade tocno se naogja ?'), { place: '', generic: true });
  assert.deepEqual(detectWhereIs('moram da znam kade mu e lokacijata prvo , za da znam da li e toa - toa'), { place: '', generic: true });
  assert.deepEqual(detectWhereIs('kazi mi togas odprilika kade e'), { place: '', generic: true });
});

test('low-confidence coords still rotate landmarks (never the stuck pitch)', async () => {
  const svc = new LandmarkService(new Db(':memory:'), { osm: false, offlineMap: buildTestMap() });
  const { handler, sessions, sent } = makeHandler(svc);
  const chatId = 'eb77';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // The client names EB 77, then asks where it is — the exact transcript.
  await send('go gledav stanot so broj 77');
  await send('kade tocno se naogja ?');
  const s1 = sessions.get(chatId)!;
  assert.equal(s1.slots.propertyId, 77, 'the EB from msg 1 must anchor the session');
  assert.ok(!VISIT_PITCH.test(sent[1]), `L1 must be a landmark, not the pitch: ${sent[1]}`);
  assert.ok(LANDMARK_LINE.test(sent[1]), `L1 must be a landmark line: ${sent[1]}`);

  await send('kazi mi togas odprilika kade e');
  assert.ok(LANDMARK_LINE.test(sent[2]), `second ask must advance the rotation: ${sent[2]}`);
  assert.notEqual(sent[1], sent[2], 'the two landmark lines must differ (rotation)');
});

test('grace window: POIs 300–500m from a low-confidence center are servable', async () => {
  const svc = new LandmarkService(new Db(':memory:'), { osm: false, offlineMap: buildTestMap() });
  const nearby = svc.nearbyLandmarks({
    id: 77, eb: 77, address: 'МИРЧЕ ОРОВЧАНЕЦ 86 - 1', location: 'Центар',
    lat: 41.999, lon: 21.4138, geo_source: 'osm_low_confidence',
  });
  assert.ok(nearby.length >= 2, `grace window must surface POIs: ${JSON.stringify(nearby)}`);
  assert.ok(nearby.every(n => n.landmark.length >= 3));
});

test('coordinate-less low-confidence rows stay blocked (no invented geography)', async () => {
  const svc = new LandmarkService(new Db(':memory:'), { osm: false, offlineMap: buildTestMap() });
  const nearby = svc.nearbyLandmarks({
    id: 5, eb: 5, address: 'Непостојна 99', location: 'Аеродром',
    geo_source: 'osm_low_confidence',
  });
  assert.equal(nearby.length, 0, 'no coords → no rotation, honest fallback stands');
});

test('named-but-missing EB → the not-found pivot names the EB and offers the area', async () => {
  const svc = new LandmarkService(new Db(':memory:'), { osm: false, offlineMap: buildTestMap() });
  const { handler, sessions, sent } = makeHandler(svc);
  const chatId = 'eb999';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // The client names an EB that is NOT in the feed, then asks where it is.
  await send('go gledav stanot so broj 999');
  await send('kade tocno se naogja ?');
  const reply = sent[sent.length - 1];
  assert.ok(!VISIT_PITCH.test(reply), `must not repeat the visit pitch: ${reply}`);
  assert.ok(/999/.test(reply), `the missing EB must be named: ${reply}`);
  assert.ok(/побар|прикаж|предлож|понуд|сличн|алтернат/iu.test(reply), `must offer an out (search/pivot): ${reply}`);
  assert.ok(EB_NAMED.test('77')); // sanity: the EB-naming helper itself
});

test('where-is with no anchored property → ask for the EB, never a repeated pitch', async () => {
  const svc = new LandmarkService(new Db(':memory:'), { osm: false, offlineMap: buildTestMap() });
  const { handler, sessions, sent } = makeHandler(svc);
  const chatId = 'noanchor';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // Fresh session, bare where-is. No property was ever discussed.
  await send('zdravo');
  await send('kade tocno se naogja ?');
  const reply = sent[sent.length - 1];
  assert.ok(!VISIT_PITCH.test(reply), `the pitch is no longer the no-anchor answer: ${reply}`);
  assert.ok(/Евидентен број|Евидентен број/iu.test(reply), `must ask for the EB: ${reply}`);
});
