// GHOST-ANCHOR GUARD (P4 follow-up) — an anchored EB the feed cannot resolve
// must never arm the funnel. Before this fix:
//   "ZA EB 999"            → honest not-found ✓ (the only lane that worked)
//   "dali e dostapen 999?" → availability ack claiming the ghost is fine,
//                            ownerContactPending armed, FSM → closing
//   "shto e so 999?"       → the FEE PITCH for a property that does not exist
// Now every ghost anchor serves the not-found pivot, clears the poisoned
// slots, and reverts the FSM so the funnel never progresses on a ghost.
// Fee/availability/enthusiasm traffic for REAL properties is unchanged.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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
import { EnrichmentStore } from '../src/store/enrichment';
import { BankStore } from '../src/store/bank';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429'); }
}

class HealthyFake extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getById(eb: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === eb || r.id === eb);
  }
  get healthy(): boolean { return true; } // feed UP: an EB miss is a REAL miss
}

function makeHandler(db: Db, rows: Property[]) {
  const cfg = loadConfig();
  const sessions = new SessionStore(db);
  const props = new HealthyFake(rows);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  writeMap(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-')), 'map.db'), [], []);
  const offlineMap = new OfflineMapStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ghost2-')), 'map.db'));
  const handler = new InboundHandler({ cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, props), responder: new Responder(new FailingLlm(), cfg), properties: props,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db), meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap }),
    enrichment: new EnrichmentStore(db), bank: new BankStore(db) });
  return { handler, sessions, sent };
}

const ROWS = [
  { eb: 78, id: 78, location: 'Центар', price: 185000, service: 'buy', size: '80 м²' },
  { eb: 41, id: 41, location: 'Аеродром', price: 250, service: 'rent', size: '55 м²' },
] as unknown as Property[];

test('ghost sequence: availability + praise about a dead EB never claim or arm the funnel', async () => {
  const db = new Db(':memory:');
  const { handler, sessions, sent } = makeHandler(db, ROWS);
  const chatId = 'ghost-e2e';
  const send = async (m: string) => { await handler.handle('test', chatId, m); };

  const NOTFOUND_FAMILY = /не\s+се\s+(наоѓа|појавува)|нема во нашата понуда|не можам да го најдам|моменталната листа|Не го гледам|продаден или привремено повлечен/i;

  await send('ZA EB 999');
  assert.ok(NOTFOUND_FAMILY.test(sent[sent.length - 1]), `not-found pivot: ${sent[sent.length - 1].slice(0, 60)}`);

  // Availability ask about the ghost: NOT the availability ack, and the
  // session must NOT be dragged to closing.
  await send('dali e dostapen 999?');
  const reply2 = sent[sent.length - 1];
  assert.ok(!/сè уште е евидентиран|би требало да е слободен/i.test(reply2), `must not claim availability for a ghost: ${reply2.slice(0, 70)}`);
  assert.ok(NOTFOUND_FAMILY.test(reply2), `must be the not-found family: ${reply2.slice(0, 70)}`);
  assert.notEqual(sessions.get(chatId)!.state, 'closing', 'ghost must not drag the FSM to closing');

  // Praise about the ghost: NOT the fee pitch, NOT enthusiasm for a ghost.
  await send('shto e so 999?');
  const reply3 = sent[sent.length - 1];
  assert.ok(!/провизија|500 денари|300 денари/i.test(reply3), `must never fee-pitch a ghost: ${reply3.slice(0, 70)}`);
  assert.ok(NOTFOUND_FAMILY.test(reply3), `must stay in the not-found family: ${reply3.slice(0, 70)}`);

  // The poisoned anchor is gone — a later generic agreement cannot re-arm it.
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.propertyId, undefined);
  assert.equal(s.slots.interestedPropertyId, undefined);
  assert.ok(!s.slots.ownerContactPending);
});

test('control: availability + interest for a REAL property keeps the funnel intact', async () => {
  const db = new Db(':memory:');
  const { handler, sessions, sent } = makeHandler(db, ROWS);
  const chatId = 'ghost-control';
  const send = async (m: string) => { await handler.handle('test', chatId, m); };

  await send('ZA EB 78');
  await send('dali e dostapen 78?');
  const ack = sent[sent.length - 1];
  assert.ok(/достапен|слободен|контакт|сопственикот/i.test(ack), `real property keeps the availability ack: ${ack.slice(0, 70)}`);
  assert.equal(sessions.get(chatId)!.state, 'closing');

  await send('da');
  const after = sent[sent.length - 1];
  assert.ok(/надомест|500 денари|провизија/i.test(after), `fee protocol proceeds for a real property: ${after.slice(0, 70)}`);
});

test('fast-enthusiasm lane: ghost praise (typo EB from a locate flow) gets not-found, not the visit offer', async () => {
  const db = new Db(':memory:');
  const { handler, sessions, sent } = makeHandler(db, ROWS);
  const chatId = 'ghost-fast';
  const send = async (m: string) => { await handler.handle('test', chatId, m); };

  await send('dobar den');
  await send('baram stan vo karpos do 500');
  // Simulate a stale/typo anchor in the slot, then praise.
  const s = sessions.get(chatId)!;
  s.slots.interestedPropertyId = 999;
  await send('prekrasen izbor');
  assert.ok(!/Одличен избор|организирам посета/i.test(sent[sent.length - 1]), `fast lane must not enthuse over a ghost: ${sent[sent.length - 1].slice(0, 70)}`);
});
