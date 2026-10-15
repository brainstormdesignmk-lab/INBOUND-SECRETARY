// THE LOCATION LADDER — the agency's three-client contract:
//   • location lurkers get the APPROXIMATE location first, always — even an
//     explicit "na koja lokacija e / dali mi mozete da ja kazete tocnata
//     lokacija" serves ROTATION 1 on turn 1 ("во близина на {landmark}");
//   • the ones satisfied continue the chat normally;
//   • the ones who want NEARBY LANDMARKS — turn 2 serves rotation 2;
//   • the ones who want the EXACT ADDRESS — turn 2 hits the AGENCY PROTOCOL
//     ("Точната адреса… 2 часа пред посетата").
// Before this fix an exact-ask jumped straight to the privacy protocol and
// the Cyrillic "НА КОЈА ЛОКАЦИЈА Е" missed every detector (bare локација was
// missing from the на-која branch) and fell to the LLM.
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
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'locladder-')), 'map.db');
}

function buildTestMap(): OfflineMapStore {
  const dbPath = tmpMapDb();
  const pois = [
    { name: 'Универзална сала', type: 'hall', lat: 41.998, lon: 21.425, source: 'google' },
    { name: 'Градски парк', type: 'park', lat: 41.996, lon: 21.428, source: 'osm' },
    { name: 'Градежен факултет', type: 'university', lat: 42.003, lon: 21.433, source: 'osm' },
  ];
  writeMap(dbPath, pois, []);
  return new OfflineMapStore(dbPath);
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getById(eb: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === eb || r.id === eb);
  }
  get healthy(): boolean { return true; }
}

const ROWS: Property[] = [
  { eb: 76, id: 76, location: 'Центар', address: 'Ул. Тест 12', price: 200,
    service: 'rent', sqm: 24, bedrooms: 1, details: 'Гарсоњера во Центар.',
    lat: 41.9985, lon: 21.4265 } as any,
  { eb: 77, id: 77, location: 'Карпош', address: 'Ул. Втора 3', price: 220,
    service: 'rent', sqm: 30, bedrooms: 1, details: 'Стан во Карпош.',
    lat: 42.0021, lon: 21.4102 } as any,
  // EB 78 carries the FEED's own landmark roster (item 3): the rotation must
  // serve that, even though the map's own nearest POI is Универсална сала.
  { eb: 78, id: 78, location: 'Центар', address: 'Ул. Трета 4', price: 240,
    service: 'rent', sqm: 35, bedrooms: 1, details: 'Стан во Центар.',
    lat: 41.9985, lon: 21.4265,
    landmarks: [{ landmark: 'Градежен факултет', type: 'university', distance_m: 410,
      maps_url: 'https://maps.google.com/?q=42.00300,21.43300' }] } as any,
];

function makeHandler() {
  const offlineMap = buildTestMap();
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

const chat = 'location-ladder-client';

test('turn 1: an explicit exact-location ask gets ROTATION 1 (landmark), never the protocol', async () => {
  const { handler, sessions, sent, offlineMap } = makeHandler();
  const s = freshSession('test', chat);
  s.slots.propertyId = 76;
  s.slots.interestedPropertyId = 76;
  sessions.set(s);

  await handler.handle('test', chat, 'dali mi mozete da ja kazete tocnata lokacija');
  const a = sent[sent.length - 1];
  assert.ok(/во близина на/i.test(a), `turn 1 must serve the landmark rotation: ${a}`);
  assert.ok(!/два часа пред|денот на посетата/i.test(a), `turn 1 must NOT hit the protocol: ${a}`);
  assert.equal(sessions.get(chat)?.slots.landmarkIndex, 1, 'rotation must have advanced');

  offlineMap.close();
});

test('turn 2 after rotation 1: the same exact ask hits the AGENCY PROTOCOL', async () => {
  const { handler, sessions, sent, offlineMap } = makeHandler();
  const s = freshSession('test', chat);
  s.slots.propertyId = 76;
  s.slots.interestedPropertyId = 76;
  sessions.set(s);

  await handler.handle('test', chat, 'dali mi mozete da ja kazete tocnata lokacija');
  await handler.handle('test', chat, 'ne , tocna lokacija molam');
  const a2 = sent[sent.length - 1];
  // Family invariant: the visit-day rule (variant draws say "денот/ден на
  // посетата", "ден на гледањето", "правило", "политика", "предвидува") —
  // never another rotation answer.
  assert.ok(/два часа пред|ден(от)? на (посетата|гледањето)|правил|политик|предвидува|непосредно пред/i.test(a2), `turn 2 must serve the agency protocol: ${a2}`);

  offlineMap.close();
});

test('turn 2 as a NEARBY ask continues the rotation (L2), never the protocol', async () => {
  const { handler, sessions, sent, offlineMap } = makeHandler();
  const s = freshSession('test', chat);
  s.slots.propertyId = 76;
  s.slots.interestedPropertyId = 76;
  sessions.set(s);

  await handler.handle('test', chat, 'na koja lokacija e');
  const l1 = sent[sent.length - 1];
  assert.ok(/во близина на/i.test(l1), `turn 1 rotation: ${l1}`);

  await handler.handle('test', chat, 'a sto drugo ima vo blizina');
  const l2 = sent[sent.length - 1];
  assert.ok(/во близина на/i.test(l2), `turn 2 must stay in the rotation: ${l2}`);
  assert.ok(!/два часа пред|денот на посетата/i.test(l2), `turn 2 nearby must NOT hit the protocol: ${l2}`);
  assert.notEqual(l1, l2, 'rotation 2 must name a DIFFERENT landmark');

  offlineMap.close();
});

test('Cyrillic "НА КОЈА ЛОКАЦИЈА Е" rides the ladder like the Latin form', async () => {
  const { handler, sessions, sent, offlineMap } = makeHandler();
  const s = freshSession('test', chat);
  s.slots.propertyId = 76;
  s.slots.interestedPropertyId = 76;
  sessions.set(s);

  await handler.handle('test', chat, 'НА КОЈА ЛОКАЦИЈА Е');
  const a = sent[sent.length - 1];
  assert.ok(/во близина на/i.test(a), `Cyrillic exact-ask must serve rotation 1: ${a}`);
  assert.equal(sessions.get(chat)?.slots.landmarkIndex, 1, 'rotation advanced on the Cyrillic form');

  offlineMap.close();
});

test('12:08 field case: BARE insistence ("AMA TOCNO , TOCNO") climbs to the protocol, never the fee pitch', async () => {
  const { handler, sessions, sent, offlineMap } = makeHandler();
  const s = freshSession('test', chat);
  s.slots.propertyId = 76;
  s.slots.interestedPropertyId = 76;
  sessions.set(s);

  // Turn 1: the exact ask serves the landmark reveal (approximate location).
  await handler.handle('test', chat, 'KAZI MI TOCNO KADE SE NAOGJA ?');
  const a1 = sent[sent.length - 1];
  assert.ok(/во близина на/i.test(a1), `turn 1 must reveal the landmark: ${a1}`);

  // Turn 2: the bare push (no address word!) — the fee ask NEVER fires, the
  // client has not agreed to a visit; the ladder serves the privacy protocol.
  await handler.handle('test', chat, 'AMA TOCNO , TOCNO');
  const a2 = sent[sent.length - 1];
  assert.ok(/два часа пред|ден(от)? на (посетата|гледањето)|правил|политик|предвидува|непосредно пред/u.test(a2), `turn 2 must serve the visit-day protocol: ${a2}`);
  assert.ok(!/300\s*денари|500\s*денари|Дали\s+се\s+согласувате/iu.test(a2), `the fee pitch must NEVER fire on bare insistence: ${a2}`);
  assert.equal(sessions.get(chat)?.slots.exactLocationTurns, 2, 'the bare push must count as ladder turn 2');

  offlineMap.close();
});

test('bare insistence with NO location thread and NO anchor never pitches the fee', async () => {
  const { handler, sent, offlineMap } = makeHandler();
  const s = freshSession('test', chat);
  (handler as any).deps.sessions.set(s);

  // No property bound, no nearby/protocol reply before — the lane must stay
  // dormant; the FSM may do whatever it wants, but not the fee ask.
  await handler.handle('test', chat, 'AMA TOCNO , TOCNO');
  const a = sent[sent.length - 1];
  assert.ok(!/300\s*денари|500\s*денари/iu.test(a), `no fee pitch without a location thread: ${a}`);

  offlineMap.close();
});

// ── FIX LIST, ITEM 2 ─────────────────────────────────────────────────────────
// An EXPLICIT STREET/NUMBER ask (улица и број / адреса) is answered with the
// agency protocol line FOR THAT PROPERTY, gets no landmark instead, and spends
// no rotation slot: the rotation belongs to the WHERE/NEARBY asks. A pure
// LOCATION word still rides the documented ladder above (approximation first).

test('item 2: an explicit street/number ask serves the protocol, never a landmark, and spends no rotation slot', async () => {
  const { handler, sessions, sent, offlineMap } = makeHandler();
  const s = freshSession('test', chat);
  s.slots.propertyId = 76;
  s.slots.interestedPropertyId = 76;
  sessions.set(s);

  await handler.handle('test', chat, 'tocnata ulica i broj , ako moze?');
  const a = sent[sent.length - 1];
  assert.ok(/два часа пред|ден(от)? на (посетата|гледањето)|правил|политик|предвидува|непосредно пред/iu.test(a),
    `an explicit street ask must serve the agency protocol: ${a}`);
  assert.ok(!/во близина на/iu.test(a), `no landmark for an explicit street ask: ${a}`);
  assert.ok(!/https?:/iu.test(a), `no maps link for an explicit street ask: ${a}`);
  const after = sessions.get(chat)!;
  assert.equal(after.slots.landmarkIndex, undefined, 'the address ask must NOT advance the landmark rotation');
  assert.equal(after.slots.addressProtocolEb, 76, 'the protocol round is keyed by the property');
  assert.equal(after.slots.addressProtocolIndex, 1, 'round 1 served for EB 76');

  // …and the LOCATION ladder is untouched by it: the next location ask still
  // starts at the approximation (the documented ladder, not round 2).
  await handler.handle('test', chat, 'НА КОЈА ЛОКАЦИЈА Е');
  const loc = sent[sent.length - 1];
  assert.ok(/во близина на/iu.test(loc), `a location ask still starts at the approximation: ${loc}`);
  assert.equal(sessions.get(chat)!.slots.landmarkIndex, 1, 'the location ladder advanced on its own ask');

  offlineMap.close();
});

test('item 2: the protocol round count is keyed by the property — a stale round never leaks onto another ЕВ', async () => {
  const { handler, sessions, sent, offlineMap } = makeHandler();
  const s = freshSession('test', chat);
  // EB 77 is the property under discussion, but the counter still carries EB
  // 76's round 1 (the pre-fix session shape). The new property must start its
  // OWN rotation — round 2 would be EB 76's answer, and round ≥2 is the
  // shut-down, i.e. the client asking about 77 would never get the protocol.
  s.slots.propertyId = 77;
  s.slots.interestedPropertyId = 77;
  s.slots.addressProtocolIndex = 1;
  sessions.set(s);

  await handler.handle('test', chat, 'koja e tocnata adresa na 77?');
  const a = sent[sent.length - 1];
  assert.ok(/два часа пред|ден(от)? на (посетата|гледањето)|правил|политик|предвидува|непосредно пред/iu.test(a),
    `EB 77 must get its own round 1 protocol line: ${a}`);
  const after = sessions.get(chat)!;
  assert.equal(after.slots.addressProtocolEb, 77, 'the counter re-keys to the new property');
  assert.equal(after.slots.addressProtocolIndex, 1, 'EB 77 starts at round 1, not at EB 76\'s round 2');

  offlineMap.close();
});

// ── FIX LIST, ITEM 3 ─────────────────────────────────────────────────────────
// A property the feed HAS placed rotates on the feed's own curated landmark
// list; the offline map's nearby scan is the fallback for the rest.

test('item 3: a property with a feed roster rotates on the ROSTER, not the map scan', async () => {
  const { handler, sessions, sent, offlineMap } = makeHandler();
  const s = freshSession('test', chat);
  s.slots.propertyId = 78;
  s.slots.interestedPropertyId = 78;
  sessions.set(s);

  await handler.handle('test', chat, 'kade e ?');
  const a = sent[sent.length - 1];
  assert.ok(a.includes('Градежен факултет'), `the feed roster is the rotation: ${a}`);
  assert.ok(!a.includes('Универсална сала'),
    `never the map's own nearest while a curated roster exists: ${a}`);
  assert.deepEqual(sessions.get(chat)!.slots.nearbyLandmarks, ['Градежен факултет']);

  offlineMap.close();
});

test('exact ask with NO anchored property asks for the Евидентен број, never the protocol', async () => {
  const { handler, sent, offlineMap } = makeHandler();
  const s = freshSession('test', chat);
  (handler as any).deps.sessions.set(s);

  await handler.handle('test', chat, 'tocna lokacija molam');
  const a = sent[sent.length - 1];
  assert.ok(/Евидентен број|Евидентен број/i.test(a), `no anchor must ask for the EB: ${a.slice(0, 200)}`);
  assert.ok(!/два часа пред/i.test(a), `no anchor must NOT serve the protocol: ${a}`);

  offlineMap.close();
});
