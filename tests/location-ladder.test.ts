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
