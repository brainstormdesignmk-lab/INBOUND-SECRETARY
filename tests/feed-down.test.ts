// FEED-DOWN vs EB-MISS (EB-miss probe follow-up) — the two zero-property
// answers must never be conflated. `healthy=false` means "fetch failed and
// there was NEVER any data": we cannot know whether an EB is gone, so every
// ghost/not-found decision is gated on health.
//
//   Down feed + anchored EB  → outage line, anchor PRESERVED (no ghost branding)
//   Down feed + praise       → outage line, funnel NOT advanced
//   Down feed + where-is     → outage line, not the not-found pivot
//   Healthy + empty portfolio → "немам слободни имоти" (NEVER "број 0", NEVER outage)
//
// Anchoring uses sessions.set() slot injection on purpose: the production
// scenario is "the client anchored EB 999 while the feed was healthy, THEN
// the feed died" — no turn on a dead feed can legitimately anchor an EB.

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

/** The dead-feed fake: healthy=false, zero data — the exact production
 *  state after a failed fetch with no cache. */
class DownFake extends PropertyService {
  constructor() { super('http://fake-feed-down'); }
  async getAll(): Promise<Property[]> { return []; }
  async getById(): Promise<Property | undefined> { return undefined; }
  get healthy(): boolean { return false; }
}

/** A HEALTHY feed with an empty portfolio — zero rows is REAL data, not an
 *  outage. The two fakes prove the answers stay distinct. */
class EmptyHealthyFake extends PropertyService {
  constructor() { super('http://fake-feed-empty'); }
  async getAll(): Promise<Property[]> { return []; }
  async getById(): Promise<Property | undefined> { return undefined; }
  get healthy(): boolean { return true; }
}

function makeHandler(db: Db, props: PropertyService) {
  const cfg = loadConfig();
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  writeMap(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fd-')), 'map.db'), [], []);
  const offlineMap = new OfflineMapStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fd2-')), 'map.db'));
  const handler = new InboundHandler({ cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, props), responder: new Responder(new FailingLlm(), cfg), properties: props,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db), meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap }),
    enrichment: new EnrichmentStore(db), bank: new BankStore(db) });
  return { handler, sessions, sent };
}

/** Inject an anchor the way production would have it: set while the feed was
 *  still healthy, before the outage. sessions.get() returns a copy — the
 *  mutation must be written back through sessions.set(). */
function anchor(sessions: SessionStore, chatId: string, slot: 'propertyId' | 'interestedPropertyId', eb: number): void {
  const s = sessions.get(chatId)!;
  s.slots[slot] = eb;
  sessions.set(s);
}

test('down feed: anchored-EB availability ask serves the outage line and PRESERVES the anchor', async () => {
  const db = new Db(':memory:');
  const { handler, sessions, sent } = makeHandler(db, new DownFake());
  const chatId = 'fd-avail';
  await handler.handle('test', chatId, 'dobar den');
  anchor(sessions, chatId, 'propertyId', 999);
  await handler.handle('test', chatId, 'dali e dostapen 999?');

  const reply = sent[sent.length - 1];
  assert.ok(/техничка потешкотија/i.test(reply), `must be the outage line: ${reply.slice(0, 70)}`);
  assert.ok(!/не можам да го најдам|нема во нашата понуда/i.test(reply),
    `a dead feed must not brand the EB a ghost: ${reply.slice(0, 70)}`);
  // The anchor is preserved — when the feed recovers, the client's question
  // still has its subject. A ghost cleanup here would destroy it on a guess.
  const after = sessions.get(chatId)!;
  assert.equal(after.slots.propertyId, 999, 'anchor must survive a feed-down turn');
  assert.notEqual(after.state, 'closing', 'feed-down must not advance the funnel');
  assert.ok(!after.slots.ownerContactPending, 'feed-down must not arm owner contact');
});

test('down feed: praise about an anchored EB gets the outage line, anchor preserved', async () => {
  const db = new Db(':memory:');
  const { handler, sessions, sent } = makeHandler(db, new DownFake());
  const chatId = 'fd-praise';
  await handler.handle('test', chatId, 'dobar den');
  anchor(sessions, chatId, 'interestedPropertyId', 999);
  await handler.handle('test', chatId, 'odlicna lokacija');

  const reply = sent[sent.length - 1];
  assert.ok(/техничка потешкотија/i.test(reply), `must be the outage line: ${reply.slice(0, 70)}`);
  assert.ok(!/Одличен избор|организирам посета|не можам да го најдам/i.test(reply),
    `neither the funnel nor ghost branding on a dead feed: ${reply.slice(0, 70)}`);
  const after = sessions.get(chatId)!;
  assert.equal(after.slots.interestedPropertyId, 999, 'anchor preserved');
  assert.notEqual(after.state, 'closing', 'feed-down must not advance the funnel');
});

test('down feed: where-is about an unresolvable EB serves the outage line, not the not-found pivot', async () => {
  const db = new Db(':memory:');
  const { handler, sessions, sent } = makeHandler(db, new DownFake());
  const chatId = 'fd-where';
  await handler.handle('test', chatId, 'dobar den');
  anchor(sessions, chatId, 'propertyId', 999);
  await handler.handle('test', chatId, 'kade tocno se naogja?');

  const reply = sent[sent.length - 1];
  assert.ok(/техничка потешкотија/i.test(reply), `must be the outage line: ${reply.slice(0, 70)}`);
  assert.ok(!/не можам да го најдам/i.test(reply), `no ghost verdict without data: ${reply.slice(0, 70)}`);
  assert.equal(sessions.get(chatId)!.slots.propertyId, 999, 'anchor preserved');
});

test('healthy empty portfolio: zero rows is REAL data — "no match", never "број 0", never the outage line', async () => {
  const db = new Db(':memory:');
  const { handler, sent } = makeHandler(db, new EmptyHealthyFake());
  const chatId = 'fd-empty';
  const send = async (m: string) => { await handler.handle('test', chatId, m); };

  await send('dobar den');
  await send('baram stan vo karpos do 60000');
  await send('edna spalna');

  const reply = sent[sent.length - 1];
  assert.ok(!/техничка потешкотија/i.test(reply),
    `an empty-but-healthy feed is not an outage: ${reply.slice(0, 70)}`);
  assert.ok(!/Евидентен број 0|број 0/i.test(reply),
    `never render the fabricated EB 0: ${reply.slice(0, 70)}`);
  assert.ok(/немам слободни имоти|нема имоти|не можам да го најдам|Не најдов имот/i.test(reply),
    `must be the no-match / not-found family: ${reply.slice(0, 70)}`);
});
