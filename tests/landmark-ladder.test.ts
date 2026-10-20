// THE LANDMARK LADDER — "I don't know that place" (the 11:45 capture):
//   [11:42] kazi mi prvo kade se naogja tocno?
//   [11:43] ЛИНА: Тоа се наоѓа во близина на Рептил.
//   [11:45] kade ima reptil tamu ?
//   [11:45] ЛИНА: … 500 денари (10 евра) за разгледувањето …
//
// The client was asking WHERE, not about the fee: naming an anchor they do not
// recognise means the ladder owes them the NEXT nearby landmark, then the
// third, and after that a polite "the area is clear enough". This file pins:
//   1. a dormitory/campus outranks the supermarket at the door (EB 94's
//      Студентски дом Пелагонија must be servable at all — it was rank 0);
//   2. "kade ima {L1} tamu?" / "ne znam toa" serves L2, then L3;
//   3. after the third landmark the reply is the exhausted "clear enough"
//      family — never the visit-fee pitch.
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
import { typeRank } from '../src/geo/types';
import { firstLandmarkProblem, FEED_LANDMARK_MAX_M } from '../src/geo/landmarks';
import { rankedLandmarks } from '../src/scripts/hermesLandmarks';
import { detectUnknownLandmark } from '../src/llm/deterministic';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429'); }
}

const FEE_LINE = /500\s*денари|300\s*денари|Дали\s+се\s+согласувате|провизија/iu;
// The bank draws a random member of the nearby.exhausted family (16 variants,
// freely worded: "реонот", "околината", "локацијата"…), so the assertion checks
// the two parts EVERY variant carries: the approximate area is done, and the
// exact address lands on the viewing day. A literal word list was flaky by
// construction — two different variants already broke it.
const EXHAUSTED_ADDRESS = /(?:адрес|локаци)/iu;
const EXHAUSTED_DAY = /(?:ден|увид|посета|гледање)/iu;

function buildTestMap(): OfflineMapStore {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lmladder-')), 'map.db');
  // Centred on EB 76 (41.9985, 21.4265). Significance-first ranking:
  // park(4) 35 m → school(4) 85 m → museum(3) 72 m.
  writeMap(dbPath, [
    { name: 'Градски парк', type: 'park', lat: 41.9988, lon: 21.4268, source: 'osm' },
    { name: 'Гимназија Јосип Броз', type: 'school', lat: 41.9992, lon: 21.4260, source: 'osm' },
    { name: 'Градски музеј', type: 'museum', lat: 41.9980, lon: 21.4272, source: 'osm' },
  ], []);
  return new OfflineMapStore(dbPath);
}

const ROWS: Property[] = [
  { eb: 76, id: 76, location: 'Центар', address: 'Ул. Тест 12', price: 200,
    service: 'rent', sqm: 24, bedrooms: 1, details: 'Гарсоњера во Центар.',
    lat: 41.9985, lon: 21.4265, geo_source: 'osm_building' } as any,
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === eb || r.id === eb);
  }
  get healthy(): boolean { return true; }
}

function makeHandler() {
  const offlineMap = buildTestMap();
  const db = new Db(':memory:');
  const cfg = loadConfig();
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const properties = new FakeProps(ROWS);
  const llm = new FailingLlm();
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(llm, cfg, properties),
    responder: new Responder(llm, cfg),
    properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap }),
  });
  return { handler, sessions, sent, offlineMap };
}

// ── 1. THE TYPE RANKING (why EB 94 could not name the dorm) ─────────────────

test('a dormitory outranks a supermarket and an Inn — rank sorts before distance', () => {
  assert.ok(typeRank('dormitory') > typeRank('supermarket'),
    'Студентски дом Пелагонија (63 m) must beat the 7 m Рептил — it was rank 0 before');
  assert.equal(typeRank('student_accommodation'), typeRank('dormitory'),
    'the OSM student_accommodation label is the same institution');
  assert.equal(typeRank('Inn'), typeRank('hotel'),
    'an unaliased "Inn" used Google prominence to outrank institutional anchors');
});

// ── 2. THE DETECTOR ─────────────────────────────────────────────────────────

test('detector: naming the served landmark in a where/what ask means "I do not know it"', () => {
  assert.equal(detectUnknownLandmark('kade ima reptil tamu ?', 'Рептил'), true);
  assert.equal(detectUnknownLandmark('ne znam kade e reptil', 'Рептил'), true);
  assert.equal(detectUnknownLandmark('sto e reptil', 'Рептил'), true);
  assert.equal(detectUnknownLandmark('ne znam toa', 'Рептил'), true, 'bare ignorance after a landmark reply');
  // A DIFFERENT place keeps its own where-the-landmark answer.
  assert.equal(detectUnknownLandmark('kade e skopjanka', 'Рептил'), false);
  // Fee/price traffic is never a landmark-ladder turn.
  assert.equal(detectUnknownLandmark('kade se plakja 500 denari?', 'Рептил'), false);
  assert.equal(detectUnknownLandmark('kolku e reptil', 'Рептил'), false);
  // A SEARCH around a known anchor is not "I don't recognise it".
  assert.equal(detectUnknownLandmark('dali ima stan vo blizina na reptil?', 'Рептил'), false);
});

// ── 3. THE FIRST-LANDMARK CONTRACT ────────────────────────────────────────
// The first entry is the one name a client hears, so it must be measurable
// (≤ 200 m) and a recognisable public place. EB 94's dormitory failed both in
// spirit: unranked, it never reached the first slot the client was told.

test('first-landmark contract: within 200 m, a recognised type, a real distance', () => {
  assert.equal(firstLandmarkProblem([{ landmark: 'Студентски дом Пелагонија', type: 'dormitory', distance_m: 63 }]), undefined);
  assert.equal(firstLandmarkProblem([]), undefined, 'no claim is not a bad claim');
  assert.equal(firstLandmarkProblem(undefined), undefined);

  const far = firstLandmarkProblem([{ landmark: 'Скопје Сити Мол', type: 'mall', distance_m: FEED_LANDMARK_MAX_M + 57 }]);
  assert.ok(far && /200/.test(far), `257 m must be rejected: ${far}`);

  const junk = firstLandmarkProblem([{ landmark: 'Бутик Галион', type: 'clothes', distance_m: 35 }]);
  assert.ok(junk && /тип/.test(junk), `an unranked type must be rejected: ${junk}`);

  const unmeasured = firstLandmarkProblem([{ landmark: 'Нешто', type: 'park' }]);
  assert.ok(unmeasured && /растојание/.test(unmeasured), `a missing distance must be rejected: ${unmeasured}`);

  assert.equal(firstLandmarkProblem([{ landmark: 'Парк', type: 'park', distance_m: FEED_LANDMARK_MAX_M }]), undefined,
    'exactly 200 m is still inside the ring');
});

test('the feed writer never lets an unrecognised type take the first slot', () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'firstlm-')), 'map.db');
  const center = { lat: 41.9985, lon: 21.4265 };
  writeMap(dbPath, [
    { name: 'Бутик Галион', type: 'clothes', lat: 41.9986, lon: 21.4266, source: 'osm' }, // ~15 m, unranked
    { name: 'Градски парк', type: 'park', lat: 41.9988, lon: 21.4268, source: 'osm' },      // ~35 m, rank 4
  ], []);
  const map = new OfflineMapStore(dbPath);
  const { list } = rankedLandmarks({ address: 'Ул. Тест 12' }, center, map);
  assert.equal(list[0]?.landmark, 'Градски парк', `the boutique must not be the first landmark: ${JSON.stringify(list)}`);
  assert.equal(firstLandmarkProblem(list), undefined, 'the produced list satisfies the contract');
  map.close();
});

// ── 4. THE LADDER ───────────────────────────────────────────────────────────

test('L1 → unknown → L2 → unknown → L3 → "clear enough", never the fee pitch', async () => {
  const { handler, sessions, sent, offlineMap } = makeHandler();
  const s = freshSession('test', 'ladder-client');
  s.slots.propertyId = 76;
  s.slots.interestedPropertyId = 76;
  sessions.set(s);

  const send = async (m: string) => { await handler.handle('test', 'ladder-client', m); return sent[sent.length - 1]; };

  const l1 = await send('kazi mi prvo kade se naogja tocno?');
  const list = sessions.get('ladder-client')!.slots.nearbyLandmarks ?? [];
  assert.ok(list.length >= 3, `the fixture must resolve three rotation slots: ${JSON.stringify(list)}`);
  assert.ok(l1.includes(list[0]), `turn 1 must name L1 (${list[0]}): ${l1}`);
  assert.equal(sessions.get('ladder-client')!.slots.lastLandmark, list[0], 'the served anchor is remembered');

  // The live 11:45 transcript had the exact-address protocol between the
  // landmark and the "kade ima reptil tamu?" ask — the ladder must still see
  // that the client means the anchor it gave, two turns back.
  await send('tocnata ulica i broj');

  const l2 = await send(`kade ima ${list[0]} tamu ?`);
  assert.ok(l2.includes(list[1]), `unknown L1 must serve L2 (${list[1]}): ${l2}`);
  assert.ok(!FEE_LINE.test(l2), `a location question must never get the fee pitch: ${l2}`);
  assert.equal(sessions.get('ladder-client')!.slots.lastLandmark, list[1]);

  const l3 = await send('ne znam toa');
  assert.ok(l3.includes(list[2]), `unknown L2 must serve L3 (${list[2]}): ${l3}`);
  assert.ok(!FEE_LINE.test(l3), `a location question must never get the fee pitch: ${l3}`);

  // The [11:50] tail of the transcript: "what else is in the area?" after all
  // three anchors is the terminal rung — no fourth landmark, no availability
  // ack, no fee pitch.
  const done = await send('sto uste ima vo reonot?');
  assert.ok(EXHAUSTED_ADDRESS.test(done) && EXHAUSTED_DAY.test(done),
    `after all three the area is "clear enough" and the address waits for the viewing day: ${done}`);
  assert.ok(!/во\s+бли[зж]ин/u.test(done), `no fourth landmark exists: ${done}`);
  assert.ok(!FEE_LINE.test(done), `the fee pitch must never close a location thread: ${done}`);
  assert.ok(!/достапна|слободна|сопственикот/iu.test(done), `not the availability ack either: ${done}`);

  offlineMap.close();
});

// The 13:30 capture: an all-caps night client walks the same ladder through the
// "what else is around there?" phrasing, then shortens to "I STO DRUGO?". That
// third ask is a question by shape, so the classifier got it and answered with
// the discovery greeting ("Добредојдовте… купување или изнајмување?") while L3
// was still owed. Landing "tamu"/"vo blizina" makes the named landmark its
// referent: it is the rotation, whatever the sentence looks like.
test('"I STO DRUGO?" after two landmarks serves L3, never the discovery greeting', async () => {
  const { handler, sessions, sent, offlineMap } = makeHandler();
  const s = freshSession('test', 'i-sto-drugo');
  s.slots.propertyId = 76;
  s.slots.interestedPropertyId = 76;
  sessions.set(s);

  const send = async (m: string) => { await handler.handle('test', 'i-sto-drugo', m); return sent[sent.length - 1]; };

  const l1 = await send('ZDRAVO KADE SE NAOGJA 76?');
  const list = sessions.get('i-sto-drugo')!.slots.nearbyLandmarks ?? [];
  assert.ok(list.length >= 3, `the fixture must resolve three rotation slots: ${JSON.stringify(list)}`);
  assert.ok(l1.includes(list[0]), `turn 1 must name L1 (${list[0]}): ${l1}`);

  const l2 = await send('STO DRUGO IMA VO BLIZINA TAMU ?');
  assert.ok(l2.includes(list[1]), `"what else is around there" must serve L2 (${list[1]}): ${l2}`);

  const l3 = await send('I STO DRUGO?');
  assert.ok(l3.includes(list[2]), `the third nearby place is still owed (${list[2]}): ${l3}`);
  assert.ok(!/Добредојдовте|купување или изнајмување/iu.test(l3),
    `the landmark has a referent — this is not a discovery opener: ${l3}`);
  assert.ok(!FEE_LINE.test(l3), `a location question must never get the fee pitch: ${l3}`);

  offlineMap.close();
});
