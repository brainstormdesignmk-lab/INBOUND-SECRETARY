// MENTION-BIND AUDIT — the 12:33 rule ("a property named by ANYTHING beats
// the last-shown slot") was enforced in the where-is and info paths but
// MISSING in the fast price path, the nearby/nearby-thread paths, the
// location-nag path, the location-confirm anchor and the fast remark
// context. Every one of those resolved a NAMED property ("garsonjerata kaj
// ambasadata") from the stale slot chain — after a pair presentation that
// is the WRONG property (the 00:09 class: EB 48 answered for EB 76).
//
// This file pins the binds end-to-end through InboundHandler with the LLM
// DOWN (deterministic stack alone). EB 48 is presented LAST, so every stale
// fallback answers with EB 48's data (250 евра / Карпош III) — an assertion
// on 200/Центар/embassy landmarks can only pass through a real mention bind.

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

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429'); }
}

function tmpMapDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bindaudit-')), 'map.db');
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === eb || r.id === eb);
  }
  get healthy(): boolean { return true; }
}

// EB 76 — the garsonjera 100м од Црногорска Амбасада (the 00:09 property).
// EB 48 — the distractor, presented LAST so every stale chain serves IT.
const EB76 = 76, EB48 = 48;
const EMBASSY = { name: 'Embassy of Montenegro', lat: 41.98815, lon: 21.47585 };
const C76 = { lat: 41.99300, lon: 21.46800 };
const C48 = { lat: 41.99600, lon: 21.47400 };

const ROWS: Property[] = [
  {
    eb: EB76, id: EB76, location: 'Центар', address: 'Ул. Мите Богоевски 3',
    price: 200, service: 'rent', sqm: 24, bedrooms: 1,
    lat: C76.lat, lon: C76.lon, geo_source: 'osm_building',
    details: 'Реновирана Ефтина Гарсоњера во Строг Центар, на 100м од Црногорска Амбасада. Гарсоњерата е во Сутерен.',
    landmarks: [{ landmark: EMBASSY.name, distance_m: 100 }],
  },
  {
    eb: EB48, id: EB48, location: 'Карпош III', address: 'Ул. Партизанска 8',
    price: 250, service: 'rent', sqm: 74, bedrooms: 2,
    lat: C48.lat, lon: C48.lon, geo_source: 'source',
    details: 'Двособен стан во Карпош 3. Купатилото и кујната се комплет изреновирани.',
    landmarks: [],
  },
];

const POIS = [
  { name: EMBASSY.name, type: 'embassy', lat: EMBASSY.lat, lon: EMBASSY.lon, source: 'google' },
  { name: 'Ул. Мите Богоевски', type: 'road', lat: 41.99310, lon: 21.46790, source: 'osm' },
];

const ADDRESSES = [
  { street: 'Ул. Мите Богоевски', housenumber: '3', lat: C76.lat, lon: C76.lon },
];

function makeHandler() {
  const mapPath = tmpMapDb();
  writeMap(mapPath, POIS, ADDRESSES);
  const offlineMap = new OfflineMapStore(mapPath);
  const db = new Db(':memory:');
  const cfg = loadConfig();
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, new FakeProps(ROWS)),
    responder: new Responder(new FailingLlm(), cfg),
    properties: new FakeProps(ROWS),
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap }),
  });
  return { handler, sessions, sent, offlineMap };
}

const chat = 'bindaudit-client';

function seedPair(s: { slots: { presentedIds?: number[]; currentBatch?: number[] } }): void {
  s.slots.presentedIds = [EB76, EB48]; // EB 48 LAST — the stale-chain answer
  s.slots.currentBatch = [EB76, EB48];
}

test('price ask naming the garsonjera serves EB 76 (200), never the stale EB 48 (250)', async () => {
  const { handler, sessions, sent, offlineMap } = makeHandler();
  const s = freshSession('test', chat);
  seedPair(s);
  sessions.set(s);

  await handler.handle('test', chat, 'KOLKU E CENATA NA GARSONJERATA KAJ CRNOGORSKA AMBASADA?');

  const a = sent[sent.length - 1];
  assert.ok(a, 'the price ask must be answered');
  assert.ok(a.includes('200'), `must answer EB 76's price 200: ${a}`);
  assert.ok(!a.includes('250'), `must NOT answer the stale shown[last] EB 48 price: ${a}`);
  assert.ok(a.includes('76'), `must name EB 76: ${a}`);

  offlineMap.close();
});

test('where-is naming the garsonjera rotates EB 76 landmarks, never the stale EB 48', async () => {
  const { handler, sessions, sent, offlineMap } = makeHandler();
  const s = freshSession('test', chat);
  seedPair(s);
  sessions.set(s);

  await handler.handle('test', chat, 'KADE E GARSONJERATA KAJ CRNOGORSKA AMBASADA?');

  const a = sent[sent.length - 1];
  assert.ok(a, 'the where-is ask must be answered');
  assert.ok(!a.includes('Карпош'), `must not describe EB 48's area: ${a}`);
  const after = sessions.get(chat);
  assert.equal(after?.slots.nearbyLandmarkEb, EB76,
    `landmark rotation must be tagged to EB 76, got ${after?.slots.nearbyLandmarkEb}`);

  offlineMap.close();
});

test('nearby ask naming the garsonjera binds EB 76 — never shown[last] (the audit fix)', async () => {
  const { handler, sessions, sent, offlineMap } = makeHandler();
  const s = freshSession('test', chat);
  seedPair(s);
  sessions.set(s);

  await handler.handle('test', chat, 'STO IMA VO BLIZINA NA GARSONJERATA KAJ CRNOGORSKA AMBASADA?');

  const a = sent[sent.length - 1];
  assert.ok(a, 'the nearby ask must be answered');
  assert.ok(!a.includes('Карпош'), `must not describe EB 48's area: ${a}`);
  const after = sessions.get(chat);
  assert.equal(after?.slots.nearbyLandmarkEb, EB76,
    `nearby must bind EB 76 (rotation tag), got ${after?.slots.nearbyLandmarkEb}`);

  offlineMap.close();
});

test('sqm facet naming the garsonjera answers EB 76 (24 м²), never the stale EB 48 (74 м²)', async () => {
  const { handler, sessions, sent, offlineMap } = makeHandler();
  const s = freshSession('test', chat);
  seedPair(s);
  sessions.set(s);

  await handler.handle('test', chat, 'KOLKU KVADRATI IMA GARSONJERATA KAJ CRNOGORSKA AMBASADA?');

  const a = sent[sent.length - 1];
  assert.ok(a, 'the sqm ask must be answered');
  assert.ok(a.includes('24'), `must answer EB 76's 24 м²: ${a}`);
  assert.ok(!a.includes('74'), `must NOT answer the stale EB 48's 74 м²: ${a}`);

  offlineMap.close();
});

test('two garsonjeras by the same landmark: price ask asks back ONCE, never a silent guess', async () => {
  const rows: Property[] = [
    { ...ROWS[0] },
    {
      eb: 90, id: 90, location: 'Центар', address: 'Ул. Друга 5',
      price: 180, service: 'rent', sqm: 22, bedrooms: 1,
      lat: EMBASSY.lat + 0.0003, lon: EMBASSY.lon + 0.0002, geo_source: 'osm_building',
      details: 'Гарсоњера во строг центар, блиску до Црногорска Амбасада.',
      landmarks: [{ landmark: EMBASSY.name, distance_m: 150 }],
    },
  ];
  const mapPath = tmpMapDb();
  writeMap(mapPath, POIS, ADDRESSES);
  const offlineMap = new OfflineMapStore(mapPath);
  const db = new Db(':memory:');
  const cfg = loadConfig();
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, new FakeProps(rows)),
    responder: new Responder(new FailingLlm(), cfg),
    properties: new FakeProps(rows),
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap }),
  });
  const s = freshSession('test', chat);
  s.slots.presentedIds = [EB76, 90];
  s.slots.currentBatch = [EB76, 90];
  sessions.set(s);

  await handler.handle('test', chat, 'KOLKU E CENATA NA GARSONJERATA KAJ CRNOGORSKA AMBASADA?');

  const a = sent[sent.length - 1];
  assert.ok(a.includes('Кажете ми точно'), `ambiguous → ONE clarify naming the options: ${a}`);
  assert.ok(!a.includes('200') && !a.includes('180'),
    `no silent price on ambiguity: ${a}`);

  offlineMap.close();
});

test('event path: availability ask naming the garsonjera acks EB 76, never the stale anchored EB 48', async () => {
  // The classifier's availability-with-known-EB guard stamps the SLOT EB
  // (48 — the stale anchor) into the event; applySlots then re-anchors the
  // whole funnel on it. The event-seam mention bind must outrank that stamp.
  const { handler, sessions, sent, offlineMap } = makeHandler();
  const s = freshSession('test', chat);
  seedPair(s);
  s.slots.propertyId = EB48; // stale discussion anchor — the wrong property
  sessions.set(s);

  await handler.handle('test', chat, 'DALI E DOSTAPNA GARSONJERATA KAJ CRNOGORSKA AMBASADA?');

  const a = sent[sent.length - 1];
  assert.ok(a, 'the availability ask must be answered');
  assert.ok(!a.includes('Дали го знаете Евидентен број'),
    `must NOT be the guided-search ask about a property on the table: ${a}`);
  const after = sessions.get(chat);
  assert.equal(after?.slots.nearbyLandmarkEb, EB76,
    `the ack's pre-resolved landmarks must belong to EB 76, got ${after?.slots.nearbyLandmarkEb}`);
  assert.equal(after?.slots.propertyId, EB76,
    `the funnel must re-anchor on EB 76, got ${after?.slots.propertyId}`);
  assert.equal(after?.state, 'closing', `availability ack moves to closing, got ${after?.state}`);

  offlineMap.close();
});

test('event path: availability ask naming the garsonjera with NO anchor slot still acks EB 76', async () => {
  // Fresh pair presented, nothing anchored: the availability guard cannot
  // stamp anything and the LLM is down — the event-seam bind must promote
  // the ask to PROPERTY_ID_REQUESTED(76) so the ack branch fires for the
  // property the client NAMED, not the guided-search "Дали го знаете…".
  const { handler, sessions, sent, offlineMap } = makeHandler();
  const s = freshSession('test', chat);
  seedPair(s);
  sessions.set(s);

  await handler.handle('test', chat, 'DALI E DOSTAPNA GARSONJERATA KAJ CRNOGORSKA AMBASADA?');

  const a = sent[sent.length - 1];
  assert.ok(a, 'the availability ask must be answered');
  assert.ok(!a.includes('Дали го знаете Евидентен број'),
    `must NOT be the guided-search ask about a property on the table: ${a}`);
  const after = sessions.get(chat);
  assert.equal(after?.slots.nearbyLandmarkEb, EB76,
    `the ack's pre-resolved landmarks must belong to EB 76, got ${after?.slots.nearbyLandmarkEb}`);
  assert.equal(after?.slots.interestedPropertyId, EB76,
    `interest must anchor on EB 76, got ${after?.slots.interestedPropertyId}`);

  offlineMap.close();
});
