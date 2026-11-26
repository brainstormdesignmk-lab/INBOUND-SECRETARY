// THE V16K11 06:25 TURN — a RELEASED criterion must leave its slot (§4c).
//
//   [06:25] klient: spalnite ne se tolku bitni. kirijata treba da e do 300 evra
//   [06:25] LINA:   Колку спални соби би сакале да има Вашиот иден стан?
//
// He had answered «dvosoben» twenty minutes earlier, then released the rooms.
// Three defects met on that one turn:
//   1. the size-waiver grammar knew «nebitni se spalnite» and «spalnite ne se
//      bitni», but the ONE adverb a client actually says — «ne se TOLKU bitni»
//      — broke the match, so nothing was recorded;
//   2. the same words sat in SEE_OFFERS_RE, so the release was read as «show me
//      the inventory» and its `!detectSeeOffers` veto blocked the
//      new-criteria path — the turn fell through to the exhausted line;
//   3. even with the flag armed, slots.bedrooms stayed 2, so the pool kept
//      filtering on the very criterion the client had dropped.

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
import { detectSeeOffers, extractSlots } from '../src/llm/deterministic';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429'); }
}

/** The live rows for this search: the house EB 50 (two rooms, 300 €), the
 *  garsonjera EB 76 the bedroom filter was hiding (200 €), and a two-room
 *  flat one district over. */
const ROWS: Property[] = [
  {
    eb: 50, id: 50, location: 'Центар (населба)', address: 'Ул. Тест 50',
    price: 300, bedrooms: 2, sqm: 74, service: 'rent', house: true,
    lat: 41.9962, lon: 21.4147, geo_source: 'stored',
    features: ['двор'], details: 'Куќа во вид на двоспратна галерија.',
  } as Property,
  {
    eb: 76, id: 76, location: 'Центар', address: 'Ул. Тест 76',
    price: 200, sqm: 24, service: 'rent',
    lat: 41.9949, lon: 21.4318, geo_source: 'stored',
    features: ['наместен'], details: 'Мал стан во центарот.',
  } as Property,
  {
    eb: 79, id: 79, location: 'Водно', address: 'Ул. Тест 79',
    price: 300, bedrooms: 2, sqm: 35, service: 'rent',
    lat: 41.9895, lon: 21.4152, geo_source: 'stored',
    features: ['лифт'], details: 'Двособен стан на Водно.',
  } as Property,
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  async getAllEbs(): Promise<Set<number>> { return new Set(this.rows.map(r => r.eb)); }
  get healthy(): boolean { return true; }
}

function makeHandler() {
  const mapPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'size-waiver-')), 'map.db');
  writeMap(mapPath, [], []);
  const db = new Db(':memory:');
  const cfg = loadConfig();
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const props = new FakeProps(ROWS);
  const map = new OfflineMapStore(mapPath);
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, props),
    responder: new Responder(new FailingLlm(), cfg),
    properties: props,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: map }),
  });
  return { handler, sessions, sent, map };
}

// ── 1. the grammar must hear the adverb ────────────────────────────────────

test('a size waiver carrying a degree adverb is still a waiver', () => {
  for (const t of [
    'spalnite ne se tolku bitni',
    'спалните не се толку битни',
    'spalnite ne se mnogu bitni',
    'ne mi se tolku bitni spalnite',
    'ne mi se mnogu vazni spalni',
    'ne e tolku bitno',
    'ne e posebno bitno kolku spalni',
    'sobite ne se mnogu bitni',
  ]) {
    assert.equal(extractSlots(t).sizeWaived, true, `a waiver: ${t}`);
  }
});

test('the adverb slot is closed — a size the client KEEPS is never waived', () => {
  for (const t of [
    'spalnite se bitni',
    'spalnite ne se svetli',
    'dve spalni',
    'nebitno za golemina, edna spalna',
  ]) {
    assert.notEqual(extractSlots(t).sizeWaived, true, `not a waiver: ${t}`);
  }
});

test('a released size is not a «show me the offers» request', () => {
  // The release used to sit in SEE_OFFERS_RE, and that lane's `!detectSeeOffers`
  // veto kept the new-criteria path from ever running (the exhausted line).
  assert.equal(detectSeeOffers('spalnite ne se tolku bitni'), false);
  assert.equal(detectSeeOffers('spalnite ne se bitni'), false);
  assert.equal(detectSeeOffers('pokazi mi sto imate'), true, 'the real show-me still fires');
});

// ── 2. the live turn, end to end ───────────────────────────────────────────

test('[V16K11 06:25] releasing the rooms serves the flat the filter hid', async () => {
  const { handler, sessions, sent, map } = makeHandler();
  const chatId = 'v16k11-waiver';
  const s = freshSession('test', chatId);
  s.state = 'presentation';
  s.slots.service = 'rent';
  s.slots.location = 'Центар (населба)';
  s.slots.flat = true;
  s.slots.bedrooms = 2;
  s.slots.budget = '300';
  s.slots.currentBatch = [50];
  s.slots.presentedIds = [50];
  s.slots.propertyId = 50;
  s.slots.interestedPropertyId = 50;
  sessions.set(s);

  await handler.handle('test', chatId, 'spalnite ne se tolku bitni. kirijata treba da e do 300 evra');
  const answer = sent[sent.length - 1] ?? '';
  const after = sessions.get(chatId)!;

  // THE RELEASE LANDS IN THE SLOTS, not only in a flag.
  assert.equal(after.slots.sizeWaived, true, 'the waiver is recorded');
  assert.equal(after.slots.bedrooms, undefined, 'the released count left its slot');
  assert.equal(after.slots.budget, '300', 'the money he restated is kept');

  // AND IT IS ANSWERED WITH STOCK: the 200 € garsonjera the 2-room filter hid.
  assert.match(answer, /Евидентен број 76/u, `the released-criterion serve: ${answer}`);
  assert.doesNotMatch(answer, /Колку спални соби/u, `never the question he just released: ${answer}`);
  assert.doesNotMatch(answer, /ги исцрпивме/u, `not the dead-end: ${answer}`);
  assert.ok((after.slots.presentedIds ?? []).includes(76), 'the served flat is remembered');
  map.close();
});

test('a size named again after the waiver retires the waiver', async () => {
  const { handler, sessions, map } = makeHandler();
  const chatId = 'v16k11-waiver-back';
  const s = freshSession('test', chatId);
  s.state = 'presentation';
  s.slots.service = 'rent';
  s.slots.location = 'Центар (населба)';
  s.slots.budget = '300';
  s.slots.sizeWaived = true;
  sessions.set(s);

  await handler.handle('test', chatId, 'ne, sakam dve spalni');
  const after = sessions.get(chatId)!;
  assert.equal(after.slots.sizeWaived, undefined, 'a fresh count retires the waiver');
  // 3, not 2: the notebook counts ROOMS, and «dve spalni» is two bedrooms plus
  // the living room (deterministic.ts BED_WORD_COUNT: «dve spalni» → 3-room).
  // The expectation was wrong, not the product.
  assert.equal(after.slots.bedrooms, 3, 'and the count is what the pool will use');
  map.close();
});
