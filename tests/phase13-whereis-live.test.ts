// TASK 1.3 — the Phase-1 chain is LIVE at runtime.
//
// Blocking test: a property "imported via onImport" (importPropertyGeo resolved
// its address OFFLINE to a trusted osm_building center and cached a landmark)
// must, when Lina is asked "каде се наоѓа?", produce a full answer —
// "Тоа се наоѓа во близина на {landmark}." + one original Google link — with
// resolveSearchCenter returning trusted:true and geocodeAddress NEVER called
// (stored coords serve; the request path stays DB-only, zero network). Agency
// rules: no "X мин пеш", no "Имотот е приближно тука" second sentence, no
// tinyurl — the reply is ONE landmark + ONE link, rotating L1→L2→L3 on
// sequential asks (the t60 workflow).
//
// This is the test that was impossible before Task 0.1 (coords never flowed
// through the runtime, so resolveSearchCenter always fell to the untrusted
// geocodeAddress branch and the tiered cache was inert).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig } from '../src/config';
import { Db } from '../src/store/db';
import { SessionStore } from '../src/fsm/session';
import { freshSession } from '../src/fsm/session';
import { Classifier } from '../src/llm/classify';
import { Responder } from '../src/llm/respond';
import { PropertyService, Property } from '../src/data/properties';
import { AppointmentStore } from '../src/store/appointments';
import { EscalationStore } from '../src/store/escalations';
import { MetaStore } from '../src/store/meta';
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LlmClient } from '../src/llm/types';
import { LandmarkService, resolveSearchCenter, PropertyRow } from '../src/geo/landmarks';
import { OfflineMapStore, writeMap } from '../src/geo/offlineMap';
import { importPropertyGeo } from '../src/geo/importGeo';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

/** The imported property — EB 76 on Бул. АСНОМ 134 (compound door 16/134),
 *  the address Task 1.1 resolves to a TRUSTED exact building. */
const EB = 76;
const ADDRESS = 'Бул. АСНОМ Бр.134';
const BUILDING_LAT = 41.9878895;   // 16/134 exact building (fixture row)
const BUILDING_LON = 21.4764927;

// The two landmarks nearest the 16/134 building. Рамстор (mall) wins the
// preference sort over the park — cached at import as tier osm_poi.
const POIS = [
  { name: 'Рамстор Мол', type: 'mall', lat: 41.9880, lon: 21.4770, source: 'osm' },
  { name: 'Парк Авионче', type: 'park', lat: 41.9885, lon: 21.4765, source: 'osm' },
];
const ADDRESSES = [
  { street: 'Булевар Асном', housenumber: '16/134', lat: BUILDING_LAT, lon: BUILDING_LON },
];

function tmpMapDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'phase13-')), 'map.db');
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === eb || r.id === eb);
  }
  get healthy(): boolean { return true; }
}

test('TASK 1.3: imported trusted-coords property answers каде е? — landmark + one original link, zero geocodeAddress', async () => {
  // ── 1. Local map: the address resolves to a trusted exact building ──
  const mapPath = tmpMapDb();
  writeMap(mapPath, POIS, ADDRESSES);
  const offlineMap = new OfflineMapStore(mapPath);

  // ── 2. "Import" the property: onImport hook runs the offline resolution,
  //       caches the landmark (osm_poi, property-id keyed) — DB-only. ──
  const db = new Db(':memory:');
  const imp = importPropertyGeo({ id: EB, eb: EB, address: ADDRESS, location: 'Аеродром' }, { db, offlineMap });
  assert.equal(imp.geo_source, 'osm_building', 'import resolves to a trusted building center');
  assert.equal(imp.landmarkCached, true, 'import caches a nearby landmark offline');
  assert.equal(imp.queueReason, null, 'trusted import never queues for the cron');
  assert.equal(imp.lat, BUILDING_LAT);
  assert.equal(imp.lon, BUILDING_LON);

  // ── 3. The property row now carries the trusted coords (as persisted on
  //        the Supabase row by the import caller, per Phase 0.1) ──
  const rows: Property[] = [{
    eb: EB, id: EB, location: 'Аеродром', address: ADDRESS,
    lat: BUILDING_LAT, lon: BUILDING_LON, geo_source: 'osm_building',
    service: 'buy', price: 99000,
  }];

  // ── 4. Live handler, same DB + map as the import. geocodeAddress is now a
  //        spy: if ANY request-path code calls it, the test fails. ──
  const cfg = loadConfig();
  let geocodeCalls = 0;
  (offlineMap as any).geocodeAddress = () => { geocodeCalls++; return undefined; };

  const sessions = new SessionStore(db);
  const properties = new FakeProps(rows);
  const llm = new FailingLlm();
  const classifier = new Classifier(llm, cfg, properties);
  const responder = new Responder(llm, cfg);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap }),
  });

  // The client saw EB 76 in a presentation → generic "каде се наоѓа?" means
  // THAT property. Seed the presented slot exactly like the presentation flow
  // does; the where-is handler must resolve the hit from shown properties.
  const chatId = 'phase13-client';
  const session = freshSession('test', chatId);
  session.slots.presentedIds = [EB];
  sessions.set(session);

  // ── 5. resolveSearchCenter on that row: trusted, from STORED coords ──
  const row: PropertyRow = { id: EB, eb: EB, address: ADDRESS, lat: BUILDING_LAT, lon: BUILDING_LON, geo_source: 'osm_building' };
  const center = resolveSearchCenter(row);
  assert.deepEqual(center, { lat: BUILDING_LAT, lon: BUILDING_LON, trusted: true });
  assert.equal(geocodeCalls, 0, 'resolveSearchCenter must not call geocodeAddress with stored coords');

  // ── 6. Lina asks "каде се наоѓа?" ──
  await handler.handle('test', chatId, 'kade se naogja?');

  const answer = sent[sent.length - 1];
  assert.ok(answer, 'the where-is question must produce an answer');

  // Agency rules: "во близина на" wording (never "мин пеш"), ONE landmark +
  // ONE original-Google link (never tinyurl), no second coordinate sentence.
  assert.ok(answer.includes('Рамстор Мол'), `answer names the import-cached landmark: ${answer}`);
  assert.ok(answer.includes('во близина на Рамстор Мол'), `answer uses the "во близина на" wording: ${answer}`);
  assert.ok(!answer.includes('мин пеш'), `no walk-minutes line: ${answer}`);
  assert.ok(!answer.includes('Имотот е приближно тука'), `no second coordinate sentence: ${answer}`);
  assert.ok(!answer.includes('tinyurl'), `no third-party shortener: ${answer}`);
  // The landmark link is a coordinate pin (maps.google.com/?q=lat,lon):
  // POLICY 2026-09-06 — name searches are banned (ambiguous, can open a
  // country-zoom results list); the pin always opens a red pin on the spot,
  // the landmark's name is carried in the reply text.
  assert.ok(answer.includes('maps.google.com/?q='), `landmark link = coordinate pin: ${answer}`);
  assert.ok(/maps\.google\.com\/\?q=\d+\.\d{5},\d+\.\d{5}$/.test(answer.trim().split('\n').pop() ?? ''), `link ends with a 5-decimal coordinate pin: ${answer}`);
  assert.ok(!/\d\.\d{2},/.test(answer), `no 2-decimal coordinate may appear: ${answer}`);

  // ── 7. The whole request path never touched the geocoder ──
  assert.equal(geocodeCalls, 0, 'geocodeAddress must NOT be called anywhere in the каде е? request path');

  offlineMap.close();
});

test('fresh session "zdravo kade se naogjaa 76 ?" (verb typo) answers the map AND keeps context for follow-ups', async () => {
  // Production regression: the client opened a NEW session with the EB number
  // inside a where-question whose verb was misspelled ("наогjaa" — double a).
  // The old single-form verb list matched only "kade se", swallowed the verb
  // fragment as a fake place ("naogjaa 76"), and Lina claimed ignorance — then
  // every follow-up in the session dead-ended on the visit pitch, no map at all.
  const mapPath = tmpMapDb();
  writeMap(mapPath, POIS, ADDRESSES);
  const offlineMap = new OfflineMapStore(mapPath);
  const db = new Db(':memory:');

  const rows: Property[] = [{
    eb: EB, id: EB, location: 'Аеродром', address: ADDRESS,
    lat: BUILDING_LAT, lon: BUILDING_LON, geo_source: 'osm_building',
    service: 'buy', price: 99000,
  }];

  const cfg = loadConfig();
  let geocodeCalls = 0;
  (offlineMap as any).geocodeAddress = () => { geocodeCalls++; return undefined; };

  const sessions = new SessionStore(db);
  const properties = new FakeProps(rows);
  const llm = new FailingLlm();
  const classifier = new Classifier(llm, cfg, properties);
  const responder = new Responder(llm, cfg);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap }),
  });

  // BRAND-NEW session: nothing shown, no slots — exactly the production case.
  const chatId = 'phase13-fresh-client';
  sessions.set(freshSession('test', chatId));

  // 1. The misspelled where-question with the EB number.
  await handler.handle('test', chatId, 'zdravo kade se naogjaa 76 ?');
  const first = sent[sent.length - 1];
  assert.ok(first.includes('Рамстор Мол'), `first message must resolve EB 76 and name its landmark: ${first}`);
  assert.ok(first.includes('во близина на'), `first message uses the "во близина на" wording: ${first}`);
  assert.ok(!first.includes('мин пеш'), `no walk-minutes line: ${first}`);
  assert.ok(!first.includes('Имотот е приближно тука:'), `no second coordinate sentence: ${first}`);

  // 2. Context recorded → the follow-up generic "каде се наоѓа?" resolves to
  //    the SAME property (rotation advances to the NEXT nearby landmark, the
  //    t60 workflow) instead of the visit pitch.
  await handler.handle('test', chatId, 'kade se naogja?');
  const second = sent[sent.length - 1];
  assert.ok(second.includes('Парк Авионче'), `follow-up rotates to the 2nd nearby landmark: ${second}`);
  assert.ok(second.includes('во близина на Парк Авионче'), `follow-up keeps the wording: ${second}`);
  assert.ok(!second.includes('организирам посета'), `no dead-end visit pitch when the property is known: ${second}`);
  assert.ok(!second.includes('Имотот е приближно тука:'), `follow-up has no second sentence: ${second}`);

  // Zero network AND zero local geocoding: the property row carries stored
  // trusted coords (osm_building), so resolve()/resolveSearchCenter() serve
  // from them — they never fall back to geocodeAddress. The follow-up is
  // served from the DB cache (layer 2). Total across both messages: 0.
  assert.equal(geocodeCalls, 0, 'geocodeAddress must NOT be called when stored trusted coords exist');
  offlineMap.close();
});
