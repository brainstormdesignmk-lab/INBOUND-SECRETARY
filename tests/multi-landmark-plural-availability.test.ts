// THE OWNER'S 2026-11-11 BRIEF — two flats, two landmarks, and a pair of
// availability questions answered from the database:
//
//   [field] «МИ ТРЕБА РЕОНОТ ОКОЛУ БЕВЕРЛИ ХИЛС И ЗЕБРА» → both flats shown.
//   [field] «КОЛКУ СЕ ОДДАЛЕЧЕНИ ОД БЕВЕРЛИ ХИЛС А КОЛКУ ОД ЗЕБРА?» was
//           answered for ONE flat and ONE landmark — the second landmark and
//           the second flat were silently dropped.
//   [field] «ДАЛИ СЕ СЛОБОДНИ?» was answered for the flat on the table only,
//           and «А 42?» then went to the LLM (gemini:2) instead of the row.
//
// The contracts pinned here: every named landmark is measured for every flat
// the question covers; a plural availability ask answers every flat on the
// table (with the per-property fee stated); and a bare «А <EB>?» about a shown
// flat is answered from the feed, deterministically, with no brain round.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
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
import { extractDistancePlaces, detectAvailabilityPlural, detectBareEbFollowup } from '../src/llm/deterministic';

const cfg = loadConfig();

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('probe: LLM disabled'); }
}

// Two landmarks on opposite sides of the centre, two flats near each.
function buildMap(): OfflineMapStore {
  const dbPath = path.join(os.tmpdir(), `two-places-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  writeMap(dbPath, [
    { name: 'Беверли Хилс', type: 'mall', lat: 42.0046, lon: 21.3926, source: 'osm' },
    { name: 'Зебра', type: 'mall', lat: 42.0004, lon: 21.4322, source: 'osm' },
  ], []);
  return new OfflineMapStore(dbPath);
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getById(id: number): Promise<Property | undefined> { return this.rows.find(r => r.id === id || r.eb === id); }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  get healthy(): boolean { return true; }
}

const EB42: Property = {
  eb: 42, id: 42, location: 'Карпош', address: 'Беверли Хилс 2', price: 82000,
  bedrooms: 2, sqm: 58, size: '58 м²', service: 'buy',
  lat: 42.0051, lon: 21.3951, geo_source: 'google_cached', details: '',
} as Property;
const EB59: Property = {
  eb: 59, id: 59, location: 'Центар', address: 'Зебра 11', price: 95000,
  bedrooms: 2, sqm: 61, size: '61 м²', service: 'buy',
  lat: 42.0009, lon: 21.4310, geo_source: 'google_cached', details: '',
} as Property;

function makeHandler(rows: Property[] = [EB42, EB59]) {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const properties = new FakeProps(rows);
  const map = buildMap();
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, properties),
    responder: new Responder(new FailingLlm(), cfg),
    properties,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: map }),
  });
  const chatId = 'pair';
  const say = async (m: string): Promise<string> => {
    await handler.handle('test', chatId, m);
    return sent.at(-1) ?? '';
  };
  const seed = (st?: 'presentation' | 'closing') => {
    const s = freshSession('test', chatId);
    s.state = st ?? 'presentation';
    s.slots.service = 'buy';
    s.slots.currentBatch = [42, 59];
    s.slots.presentedIds = [42, 59];
    s.slots.location = 'Карпош';
    sessions.set(s);
    return s;
  };
  return { handler, sessions, sent, chatId, say, seed, map };
}

test('the multi-place extractor keeps EVERY landmark in the question', () => {
  const places = extractDistancePlaces('КОЛКУ СЕ ОДДАЛЕЧЕНИ ОД БЕВЕРЛИ ХИЛС А КОЛКУ ОД ЗЕБРА ?');
  assert.deepEqual(places.length, 2, JSON.stringify(places));
  assert.match(places[0]!, /БЕВЕРЛИ/u);
  assert.match(places[1]!, /ЗЕБРА/u);
});

test('[field] two flats × two landmarks: each flat gets BOTH distances', async () => {
  const h = makeHandler();
  h.seed();
  const answer = await h.say('КОЛКУ СЕ ОДДАЛЕЧЕНИ ОД БЕВЕРЛИ ХИЛС А КОЛКУ ОД ЗЕБРА ?');
  // Both landmarks are named…
  assert.match(answer, /Беверли/iu, `the first landmark is measured: ${answer}`);
  assert.match(answer, /Зебра/iu, `the second landmark is measured: ${answer}`);
  // …both flats are answered, and each line carries BOTH landmarks.
  assert.match(answer, /42/u, answer);
  assert.match(answer, /59/u, answer);
  const line42 = answer.split('\n').find(l => /42/u.test(l)) ?? '';
  const line59 = answer.split('\n').find(l => /\b59\b/u.test(l)) ?? '';
  assert.match(line42, /Беверли/iu, `EB 42 × both: ${line42}`);
  assert.match(line42, /Зебра/iu, `EB 42 × both: ${line42}`);
  assert.match(line59, /Беверли/iu, `EB 59 × both: ${line59}`);
  assert.match(line59, /Зебра/iu, `EB 59 × both: ${line59}`);
});

test('a plural availability ask answers EVERY flat on the table', async () => {
  const h = makeHandler();
  h.seed('closing');
  assert.equal(detectAvailabilityPlural('ДАЛИ СЕ СЛОБОДНИ?'), true);
  const answer = await h.say('ДАЛИ СЕ СЛОБОДНИ?');
  assert.match(answer, /42/u, `the first flat is answered: ${answer}`);
  assert.match(answer, /59/u, `the second flat is answered: ${answer}`);
  // The fee is per property, and the pair's arithmetic is stated (2 × 500).
  assert.match(answer, /1\.000|1000/u, `the per-property fee is stated: ${answer}`);
});

test('«А 42?» is answered from the row, not the brain', async () => {
  const h = makeHandler();
  h.seed('closing');
  assert.equal(detectBareEbFollowup('А 42 ?'), 42);
  const answer = await h.say('А 42 ?');
  assert.match(answer, /42/u, `the named flat is answered: ${answer}`);
  // CONTRACT, not a wording: `availability.ack.masc` rotates («достапен»,
  // «слободен», «активен», «фигурира», «на располагање»), so pinning «достап»
  // made a false failure on the sanctioned «се води како активен» variant.
  assert.match(answer, /достап|слобод|актив|располага|фигурира|база/iu,
    `with the availability answer: ${answer}`);
  assert.match(answer, /сопственик/iu, `the owner-confirm question is owed: ${answer}`);
  // Never a fallback/LLM line, and the discussion anchor moves to that flat.
  assert.doesNotMatch(answer, /Не разбрав|не можам да одговорам/iu, answer);
  assert.equal(h.sessions.get(h.chatId)!.slots.propertyId, 42);
});

test('a bare number that is NOT a shown flat keeps its own lane', async () => {
  const h = makeHandler();
  h.seed('closing');
  const answer = await h.say('А 77 ?');
  assert.doesNotMatch(answer, /Евидентен број 77/u, `77 was never shown: ${answer}`);
});
