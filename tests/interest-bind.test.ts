// THE 00:09 TRANSCRIPT — "GARSONJERAVA KAJ CRNOGORSKA AMBASADA MI E INTERESNA"
// after EB 76 (garsonjera, "100м од Црногорска Амбасада") was offered at 00:06.
// Lina answered with a FRESH relaxed-category search (EB 48, Карпош III) —
// she pretended the garsonjera she herself had offered did not exist.
//
// Root causes fixed here:
//   1. detectPropertyInterest had no "ми е интересна / mi e interesna" form —
//      the deterministic classifier saw only the garsonjera type word →
//      DETAILS_PROVIDED → the presentation engine re-searched.
//   2. Even with INTERESTED, the property.liked branch anchored on the stale
//      slot / props[0] — it never consulted the mention resolver.
//
// The fix: interest detector + funnel override (classify) + bindMention in
// the property.liked branches (inbound). This test pins all three.

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
import { RESPONSE_BANK } from '../src/data/responses';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429'); }
}

function tmpMapDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'interest-')), 'map.db');
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === eb || r.id === eb);
  }
  get healthy(): boolean { return true; }
}

// The 00:09 chat: EB 76 offered at 00:06 (relaxed-category presentation),
// the interest line arrives at 00:09. EB 48 is the WRONG answer from the
// transcript (a trisoben stan in Карпош III the search engine produced).
const EB76 = 76, EB48 = 48;
const C76 = { lat: 41.99300, lon: 21.46800 };
const C48 = { lat: 41.99600, lon: 21.47400 };

const ROWS_0009: Property[] = [
  {
    eb: EB76, id: EB76, location: 'Центар', address: 'Ул. Мите Богоевски 3',
    price: 200, service: 'rent', sqm: 24,
    lat: C76.lat, lon: C76.lon, geo_source: 'osm_building',
    details: 'Реновирана Ефтина Гарсоњера во Строг Центар. Во потегот меѓу Универзална Сала и Католичка Црква, на 100м од Црногорска Амбасада. Гарсоњерата е во Сутерен.',
  },
  {
    eb: EB48, id: EB48, location: 'Карпош III', address: 'Ул. Партизанска 8',
    price: 250, service: 'rent', sqm: 8, bedrooms: 3,
    lat: C48.lat, lon: C48.lon, geo_source: 'source',
    details: 'Трособен стан во Карпош 3. Купатилото и Кујната се комплет изреновирани.',
  },
];

// The map POIs — "Црногорска амбасада" (client) vs "Embassy of Montenegro"
// (map row): the offline map is the name bridge.
const POIS_0009 = [
  { name: 'Embassy of Montenegro', type: 'embassy', lat: 41.98815, lon: 21.47585, source: 'google' },
  { name: 'Ул. Мите Богоевски', type: 'road', lat: 41.99310, lon: 21.46790, source: 'osm' },
];

const ADDRESSES_0009 = [
  { street: 'Ул. Мите Богоевски', housenumber: '3', lat: C76.lat, lon: C76.lon },
];

function makeHandler() {
  const mapPath = tmpMapDb();
  writeMap(mapPath, POIS_0009, ADDRESSES_0009);
  const offlineMap = new OfflineMapStore(mapPath);
  const db = new Db(':memory:');
  const cfg = loadConfig();
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, new FakeProps(ROWS_0009)),
    responder: new Responder(new FailingLlm(), cfg),
    properties: new FakeProps(ROWS_0009),
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap }),
  });
  return { handler, sessions, sent, offlineMap };
}

const chat = 'interest-client';

function seed(session: { slots: { presentedIds?: number[]; currentBatch?: number[] } }, ids: number[]): void {
  session.slots.presentedIds = ids;
  session.slots.currentBatch = ids;
}

test('00:09: "GARSONJERAVA KAJ CRNOGORSKA AMBASADA MI E INTERESNA" binds EB 76 (LLM down)', async () => {
  const { handler, sessions, sent, offlineMap } = makeHandler();
  const s = freshSession('test', chat);
  seed(s, [EB76]);
  sessions.set(s);

  await handler.handle('test', chat, 'GARSONJERAVA KAJ CRNOGORSKA AMBASADA MI E INTERESNA');

  const a1 = sent[sent.length - 1];
  assert.ok(a1, 'the interest line must be answered');
  // The enthusiasm + visit-offer family — NOT a fresh search presentation
  // ("нема слободна гарсоњера, но имам мало станче…" + a different EB).
  assert.ok(
    RESPONSE_BANK['property.liked'].some(v => a1.includes(v)),
    `must serve a property.liked variant verbatim: ${a1}`);
  assert.ok(!a1.includes('Карпош'), `must NOT re-fire the search engine (EB 48): ${a1}`);
  assert.ok(!a1.includes('мало станче'), `must NOT be the relaxed-category search reply: ${a1}`);
  // The funnel anchors on EB 76 — the NEXT message stays on it.
  const after = sessions.get(chat);
  assert.equal(after?.slots.interestedPropertyId, EB76, 'interest must bind EB 76');

  offlineMap.close();
});

test('00:09 Cyrillic: "гарсоњерата кај Црногорска амбасада ми е интересна" binds EB 76', async () => {
  const { handler, sessions, sent, offlineMap } = makeHandler();
  const s = freshSession('test', chat);
  seed(s, [EB76]);
  sessions.set(s);

  await handler.handle('test', chat, 'гарсоњерата кај Црногорска амбасада ми е интересна');

  const a = sent[sent.length - 1];
  assert.ok(
    RESPONSE_BANK['property.liked'].some(v => a.includes(v)),
    `must serve a property.liked variant verbatim: ${a}`);
  const after = sessions.get(chat);
  assert.equal(after?.slots.interestedPropertyId, EB76, 'interest must bind EB 76');

  offlineMap.close();
});

test('cold "mi e interesna" with NOTHING on the table does not invent a property', async () => {
  const { handler, sessions, sent, offlineMap } = makeHandler();
  const s = freshSession('test', 'cold-client');
  sessions.set(s);

  await handler.handle('test', 'cold-client', 'mi e interesna');

  const a = sent[sent.length - 1];
  assert.ok(a, 'the message must be answered');
  const after = sessions.get(chat);
  assert.equal(after?.slots.interestedPropertyId, undefined,
    'no property on the table — nothing may be bound');

  offlineMap.close();
});

test('negation: "ne mi e interesna" does NOT bind or enthuse', async () => {
  const { handler, sessions, sent, offlineMap } = makeHandler();
  const s = freshSession('test', chat);
  seed(s, [EB76]);
  sessions.set(s);

  await handler.handle('test', chat, 'ne mi e interesna');

  const a = sent[sent.length - 1];
  assert.ok(a, 'the negation must be answered');
  assert.ok(
    !RESPONSE_BANK['property.liked'].some(v => a.includes(v)),
    `must NOT serve the enthusiasm family: ${a}`);
  const after = sessions.get(chat);
  assert.equal(after?.slots.interestedPropertyId, undefined, 'negation must not bind');

  offlineMap.close();
});
