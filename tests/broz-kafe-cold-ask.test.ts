// The [20:24] capture, end-to-end:
//
//   [20:24] ZDRAVO GLEDAV KAJ VAS NA SAJT STAN KAJ BROZ KAFE. DALI USTE E NA PRODAZBA ?
//   [20:24] ЛИНА [без LLM]: Евидентен број 94 · двособен стан · 92.000 евра · Кисела Вода
//                          «Би требало да е сеуште достапен…»
//
// Two defects met on that one turn:
//   1. the extractor read «кај ВАС НА САЈТ» as the place and swallowed the real
//      one («кај БРОЗ КАФЕ») in the same greedy capture, so the map was never
//      asked about Броз кафе; and
//   2. with no place resolved, the mention bind fell back to the WHOLE feed and
//      bound EB 94 — a Кисела Вода flat 5 km from the place the client named —
//      then answered availability about it.
//
// The flat the client means is not in the bank (nothing sits at Броз кафе), so
// the honest turn is the locate funnel anchored ON that place: the club of
// flats that really are near it, phrased with the client-facing place name.
// What must never happen is an ad from another neighbourhood presented as the
// one he asked about.
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import os from 'os';
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

// Synthetic map with the ONE place the client named. Broz Cafe sits in Центар.
function buildMap(): OfflineMapStore {
  const dbPath = path.join(os.tmpdir(), `broz-kafe-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  writeMap(dbPath, [
    { name: 'Broz Cafe', type: 'bar', lat: 42.0002123, lon: 21.4170894, source: 'osm' },
  ], []);
  return new OfflineMapStore(dbPath);
}

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('probe: LLM disabled'); }
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

// EB 95 is 123 m from Broz Cafe (Центар); EB 94 is the Kisela Voda ad the
// broken turn answered with (5 km away). EB 77 is another Центар flat 303 m
// from the bar — the second scenario puts it on the table.
const NEAR_95: Property = { eb: 95, id: 95, location: 'Центар', price: 204000, service: 'buy', bedrooms: 3,
  sqm: 74, size: '74 м²', address: 'Црвена Вода', lat: 41.9997, lon: 21.4186, geo_source: 'google_cached' };
const NEAR_77: Property = { eb: 77, id: 77, location: 'Центар', price: 130000, service: 'buy', bedrooms: 2,
  sqm: 45, size: '45 м²', address: 'Мирче Оровчанец 86', lat: 41.9985, lon: 21.4192, geo_source: 'google_cached' };
const KISELA_94: Property = { eb: 94, id: 94, location: 'Кисела Вода', price: 92000, service: 'buy', bedrooms: 2,
  sqm: 56, size: '56 м²', address: 'Тоне Томшиќ Бр.25', lat: 41.9813, lon: 21.4382, geo_source: 'google_cached' };

const ASK = 'ZDRAVO GLEDAV KAJ VAS NA SAJT STAN KAJ BROZ KAFE. DALI USTE E NA PRODAZBA ?';

async function turn(rows: Property[], chatId: string): Promise<{ answer: string; session: ReturnType<SessionStore['get']> }> {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(rows);
  const llm = new FailingLlm();
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const map = buildMap();
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(llm, cfg, properties),
    responder: new Responder(llm, cfg),
    properties,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: map }),
  });
  await handler.handle('test', chatId, ASK);
  const answer = sent[sent.length - 1] ?? '';
  const session = sessions.get(chatId)!;
  map.close();
  return { answer, session };
}

test('[20:24] one flat AT «Броз кафе»: the availability ack is about THAT flat', async () => {
  const { answer, session } = await turn([NEAR_95, KISELA_94], 'broz-kafe-one');
  // The flat at the place answers the question…
  assert.ok(/\b95\b/u.test(answer), `the flat at the place must answer: ${answer}`);
  // …and the far ad is never offered as the flat he asked about.
  assert.ok(!/Кисела Вода/iu.test(answer), `an ad from another neighbourhood leaked: ${answer}`);
  assert.ok(!/\b94\b/u.test(answer), `EB 94 must not be bound to «кај Броз кафе»: ${answer}`);
  assert.equal(session.slots.interestedPropertyId, 95, `the bound flat must be the one at the place, got ${session.slots.interestedPropertyId}`);
});

test('[20:24] several flats near «Броз кафе»: she asks WHICH, naming the place', async () => {
  const { answer, session } = await turn([NEAR_95, NEAR_77, KISELA_94], 'broz-kafe-many');
  // The place is the anchor of the turn, in the client-facing spelling every
  // other place line uses («Broz Cafe» → «Броз Кафе»).
  assert.ok(/Броз Кафе/iu.test(answer), `the place must be named: ${answer}`);
  assert.ok(/\b95\b/u.test(answer) && /\b77\b/u.test(answer), `both flats at the place must be offered: ${answer}`);
  // The far ad is not one of the options and nothing is bound yet.
  assert.ok(!/Кисела Вода/iu.test(answer), `an ad from another neighbourhood leaked: ${answer}`);
  assert.ok(!/\b94\b/u.test(answer), `EB 94 must not be offered for «кај Броз кафе»: ${answer}`);
  assert.equal(session.slots.interestedPropertyId, undefined, 'no flat may be bound before the client answers');
  assert.equal(session.state, 'property_locate', `the locate funnel owns the turn, got ${session.state}`);
});
