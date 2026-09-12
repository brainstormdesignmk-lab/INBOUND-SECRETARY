// The 21:51 transcript END-TO-END: client sees a presentation pair of the
// sibling business spaces (EB 56/58), then asks about EB 57 — Lina must
// serve EB 57's OWN nearby landmark, never the cached slots of the sibling.
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

// Synthetic map mirroring the REAL 21:51 geography:
//   56/58 block (42.0230, 21.4418) — Завод „Топанско поле" area (Чаир side)
//   57 block   (41.9942, 21.4297) — Ѓуро Стругар: Парк Форум / Министерство за правда / Hotel Tourist
function buildIncidentMap(): OfflineMapStore {
  const dbPath = path.join(os.tmpdir(), `eb57-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  writeMap(dbPath, [
    { name: 'Завод „Топанско поле“', type: 'hospital', lat: 42.0230, lon: 21.4354, source: 'osm' },
    { name: 'Кипер Маркет', type: 'supermarket', lat: 42.0225, lon: 21.4400, source: 'osm' },
    { name: 'Парк Форум', type: 'mall', lat: 41.9946, lon: 21.4301, source: 'google' },
    { name: 'Министерство за правда', type: 'government', lat: 41.9950, lon: 21.4290, source: 'osm' },
    { name: 'Hotel Tourist', type: 'hotel', lat: 41.9938, lon: 21.4305, source: 'osm' },
  ], [
    { street: 'Ѓуро Стругар', housenumber: '5', lat: 41.9942, lon: 21.4297 },
  ]);
  return new OfflineMapStore(dbPath);
}

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

// Real geography from the 21:51 incident:
//   EB 56/58 — Строг Центар, 158 m from Завод „Топанско поле" (their OWN correct landmarks)
//   EB 57    — Ѓуро Стругар, ~110 m from the real Google pin; nearest true
//              anchors: Парк Форум / Министерство за правда / Hotel Tourist
const ROWS: Property[] = [
  { eb: 56, id: 56, location: 'Центар', price: 1000, service: 'rent', business: true,
    sqm: 40, size: '40 м²', address: 'Непозната', lat: 42.0230, lon: 21.4418, geo_source: 'google_cached' },
  { eb: 58, id: 58, location: 'Центар (населба)', price: 1000, service: 'rent', business: true,
    sqm: 105, size: '105 м²', address: 'Непозната', lat: 42.0230, lon: 21.4418, geo_source: 'google_cached' },
  { eb: 57, id: 57, location: 'Центар', price: 1000, service: 'rent', business: true,
    sqm: 0, size: undefined, address: 'Ѓуро Стругар', lat: 41.9942, lon: 21.4297, geo_source: 'google_cached' },
];

test('21:51 e2e: sibling presentation then "OVOJ 57 KADE SE NAOGJA" serves EB 57 landmarks', async () => {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS);
  const llm = new FailingLlm();
  const classifier = new Classifier(llm, cfg, properties);
  const responder = new Responder(llm, cfg);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: buildIncidentMap() }),
  });
  const chatId = 'eb57-e2e';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // The presentation pair 56 + 58 was shown (their landmarks get cached first)
  let s = await send('deloven prostor do 1000 evra vo centar');
  assert.ok(s.state === 'presentation' || sent.length > 0, 'presentation expected');
  const preSlots = s.slots.nearbyLandmarks;
  if (preSlots && preSlots.length > 0) {
    // Sanity: 56/58's own slots name the Завод-area POIs — the WRONG anchors
    // for EB 57 — proving the stale-slot trap was real.
    assert.ok(preSlots.some(n => /Топанско|Кипер|Стоко/i.test(n)), `expected 56/58-area landmarks, got: ${JSON.stringify(preSlots)}`);
  }

  // The client asks about EB 57 (presented last): EB must WIN over the area
  // phrase, slots must self-heal to EB 57's own location.
  s = await send('OVOJ 57 KADE SE NAOGJA VO STROG CENTAR ?');
  const answer = sent[sent.length - 1] ?? '';
  assert.equal(s.slots.propertyId, 57, `session must track EB 57, got ${s.slots.propertyId}`);
  // The served landmark must be within ~500 m of EB 57's coords
  // (41.9942, 21.4297) — the Завод POI (42.023, 21.4354, 3.2 km) must NEVER appear.
  assert.ok(!/Завод|Топанско|Кипер|Стоко/iu.test(answer), `sibling landmark leaked: ${answer}`);
  assert.ok(/во близина на/iu.test(answer), `landmark answer expected: ${answer}`);
  // No "0 м²" in any reply (card fix).
  assert.ok(!/0\s*м²/iu.test(answer), `0 m² leaked: ${answer}`);
  // Slots re-resolved FOR 57.
  assert.equal(s.slots.nearbyLandmarkEb, 57, `slots must be tagged EB 57, got ${s.slots.nearbyLandmarkEb}`);
});
