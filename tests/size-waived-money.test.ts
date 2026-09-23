// THE [21:40] TRANSCRIPT — "DO 300 E" asked a bedrooms question, the client
// answered "NEBITNO", Lina re-asked, "NE E BITNO KOLKU SPALNI" also failed,
// "DO 300 E" got a THIRD bedrooms re-ask. Root causes (2):
//   1. buildSizeWaivedSlots demanded a verb ("nebitno e") or a subject clitic
//      ("ne MI e bitno") — bare "NEBITNO" and subject-less "NE E BITNO" both
//      missed, so sizeWaived never set and the funnel looped.
//   2. Even waived, candidates() sorted price-closest-to-budget: the client
//      who capped the money got neither the biggest nor any presentation.
// Fix: bare fused-negation slot + subject-less NEG BE ADJ slot; sizeWaived
// presentations lead with the BIGGEST м² first ("the money buys space").
// The user contract: waiving size = give the biggest apartment for the money;
// if the client later names a size, the flow adapts (existing pivot lane).

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
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sizewaived-')), 'map.db');
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getById(eb: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === eb || r.id === eb);
  }
  get healthy(): boolean { return true; }
}

// Аеродром, rent, all under the 300 budget, DIFFERENT sizes — the ordering
// pin needs a spread. EB 17 (small, cheapest), EB 22 (biggest), EB 31 (mid),
// EB 44/55 (двособни) — EB 55 stays OUTSIDE the first biggest-first batch so
// the later "edna spalna" pivot has fresh material to present.
const ROWS: Property[] = [
  { eb: 17, id: 17, location: 'Аеродром', address: 'Ул. Тест 1', price: 180,
    service: 'rent', sqm: 32, bedrooms: 1, details: 'Еднособен стан во Аеродром.' },
  { eb: 22, id: 22, location: 'Аеродром', address: 'Ул. Тест 2', price: 295,
    service: 'rent', sqm: 88, bedrooms: 3, details: 'Трисобен стан во Аеродром, голем.' },
  { eb: 31, id: 31, location: 'Аеродром', address: 'Ул. Тест 3', price: 240,
    service: 'rent', sqm: 55, bedrooms: 2, details: 'Двособен стан во Аеродром.' },
  { eb: 44, id: 44, location: 'Аеродром', address: 'Ул. Тест 4', price: 260,
    service: 'rent', sqm: 60, bedrooms: 2, details: 'Двособен стан во Аеродром, реновиран.' },
  { eb: 55, id: 55, location: 'Аеродром', address: 'Ул. Тест 5', price: 270,
    service: 'rent', sqm: 50, bedrooms: 2, details: 'Двособен стан во Аеродром, светол.' },
] as any;

function makeHandler(rows: Property[] = ROWS) {
  const mapPath = tmpMapDb();
  writeMap(mapPath, [], []);
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
  return { handler, sessions, sent, offlineMap };
}

const chat = 'size-waived-money-client';

test('[21:40] bare "NEBITNO" waives bedrooms and presents the biggest-in-budget unit', async () => {
  const { handler, sessions, sent, offlineMap } = makeHandler();
  const s = freshSession('test', chat);
  s.slots.service = 'rent';
  sessions.set(s);

  await handler.handle('test', chat, 'AERODROM DO 300E');
  const ask = sent[sent.length - 1];
  assert.ok(ask.includes('спални'), `the bedrooms ask must fire: ${ask}`);

  await handler.handle('test', chat, 'NEBITNO');
  const after = sessions.get(chat);
  assert.equal(after?.slots.sizeWaived, true, 'bare NEBITNO must set sizeWaived');
  assert.equal(after?.slots.budget, '300', 'the budget must survive the answer turn');
  assert.equal(after?.state, 'presentation', `the funnel must present, not re-ask: ${after?.state}`);
  const a = sent[sent.length - 1];
  assert.ok(a.includes('22'), `the BIGGEST in-budget unit (EB 22, 88 м²) must lead: ${a.slice(0, 160)}`);

  offlineMap.close();
});

test('[21:40] "NE E BITNO KOLKU SPALNI" (no subject clitic) also waives — the funnel never re-asks', async () => {
  const { handler, sessions, sent, offlineMap } = makeHandler();
  const s = freshSession('test', chat);
  s.slots.service = 'rent';
  sessions.set(s);

  await handler.handle('test', chat, 'AERODROM DO 300E');
  await handler.handle('test', chat, 'NE E BITNO KOLKU SPALNI');
  const after = sessions.get(chat);
  assert.equal(after?.slots.sizeWaived, true, 'subject-less NE E BITNO must set sizeWaived');
  assert.equal(after?.state, 'presentation', `must present, not re-ask: ${after?.state}`);
  const a = sent[sent.length - 1];
  assert.ok(!a.includes('спални'), `must NOT re-ask bedrooms: ${a}`);
  assert.ok(a.includes('22'), `biggest-in-budget must lead: ${a.slice(0, 160)}`);

  offlineMap.close();
});

test('the ladder walks the money down: cheapest pair follows the biggest lead', async () => {
  // Pool: 17 (32 м²), 22 (88 м²), 31 (55 м²) — the ladder is
  // [biggest lead 22] + [cheapest pair 17, 31] with this pool size.
  const { handler, sessions, sent, offlineMap } = makeHandler();
  const s = freshSession('test', chat);
  s.slots.service = 'rent';
  sessions.set(s);

  await handler.handle('test', chat, 'AERODROM DO 300E');
  await handler.handle('test', chat, 'NEBITNO');
  assert.ok(sent[sent.length - 1].includes('22'), 'batch 1 leads with the biggest');

  await handler.handle('test', chat, 'DRUGO'); // continue walking the ladder
  const a2 = sent[sent.length - 1];
  assert.ok(
    a2.includes('17'),
    `batch 2 must carry the remaining cheapest unit (17): ${a2.slice(0, 160)}`,
  );

  offlineMap.close();
});

test('later "EDNA SPALNA" still pivots the waived search to a real bedroom criterion', async () => {
  // The user contract: adapt with the flow when the client later names a size.
  const { handler, sessions, sent, offlineMap } = makeHandler();
  const s = freshSession('test', chat);
  s.slots.service = 'rent';
  sessions.set(s);

  await handler.handle('test', chat, 'AERODROM DO 300E');
  await handler.handle('test', chat, 'NEBITNO');
  assert.equal(sessions.get(chat)?.state, 'presentation', 'waived search must present');

  await handler.handle('test', chat, 'a so edna spalna nesto');
  const after = sessions.get(chat);
  assert.equal(after?.slots.bedrooms, 2, '"edna spalna" must capture 1 спална → 2-собен');
  assert.equal(after?.slots.sizeWaived, undefined, 'a fresh bedroom criterion must clear the waiver');
  assert.equal(after?.state, 'presentation', `the pivot must re-present, not dead-end: ${after?.state}`);
  const a = sent[sent.length - 1];
  // candidates() prefers exact 3-собен matches; both 31 and 44 are exact. The
  // behavioral pin: fresh in-budget material re-presented (not the exhausted line).
  assert.ok(a.includes('31') || a.includes('44'), `the pivot must present fresh двособен material: ${a.slice(0, 160)}`);
  assert.ok(!/исцрпивме|нема други/i.test(a), `must not serve the exhausted line: ${a.slice(0, 160)}`);

  offlineMap.close();
});
