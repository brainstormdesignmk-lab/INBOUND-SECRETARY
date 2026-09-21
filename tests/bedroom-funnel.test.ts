// THE [13:44] TRANSCRIPT — the client answered the bedrooms question with
// the bare number word "EDNA" (no noun), TWICE, and Lina re-asked the same
// question both times. Root cause: detectBedrooms only mapped number words
// when a noun ("спална"/"соба") was present — a bare answer fell through,
// the funnel looped.
//
// Fix: a guarded bare-answer branch (≤3 words, no type word, no budget/size
// numbers) mapping "една/dve/3" through the rooms convention (1 спална → 2).
// This test pins the whole funnel: search → bedrooms ask → bare answer →
// presentation, with the LLM DOWN (deterministic stack alone).

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
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bedfunnel-')), 'map.db');
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getById(eb: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === eb || r.id === eb);
  }
  get healthy(): boolean { return true; }
}

// Аеродром, 2-спални buy at 89.000 — the exact match for the [13:44] search.
const ROWS: Property[] = [
  { eb: 41, id: 41, location: 'Аеродром', address: 'Ул. Тест 1', price: 89000,
    service: 'buy', sqm: 50, bedrooms: 2, lat: 41.99, lon: 21.47,
    geo_source: 'source', details: 'Двособен стан во Аеродром, реновиран.' },
] as any;

function makeHandler() {
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
    classifier: new Classifier(new FailingLlm(), cfg, new FakeProps(ROWS)),
    responder: new Responder(new FailingLlm(), cfg),
    properties: new FakeProps(ROWS),
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap }),
  });
  return { handler, sessions, sent, offlineMap };
}

const chat = 'bed-funnel-client';

test('[13:44] bare "EDNA" answers the bedrooms ask and the funnel presents (LLM down)', async () => {
  const { handler, sessions, sent, offlineMap } = makeHandler();
  const s = freshSession('test', chat);
  s.slots.service = 'buy'; // captured earlier in the real funnel
  sessions.set(s);

  await handler.handle('test', chat, 'AERODROM DO 89999');
  const ask = sent[sent.length - 1];
  assert.ok(ask.includes('спални'), `the bedrooms ask must fire: ${ask}`);

  await handler.handle('test', chat, 'EDNA');
  const after = sessions.get(chat);
  assert.equal(after?.slots.bedrooms, 2, 'bare EDNA must capture 1 спална → 2-собен');
  assert.equal(after?.slots.budget, '89999', 'the budget must survive the answer turn');
  assert.equal(after?.state, 'presentation', `the funnel must present, not re-ask: ${after?.state}`);
  const a = sent[sent.length - 1];
  assert.ok(a.includes('41'), `the presentation must include the matching EB 41: ${a.slice(0, 120)}`);

  offlineMap.close();
});

test('[13:44] bare digit "2" and bare "две" also answer the funnel (LLM down)', async () => {
  for (const answer of ['2', 'две']) {
    const { handler, sessions, sent, offlineMap } = makeHandler();
    const s = freshSession('test', chat);
    s.slots.service = 'buy';
    sessions.set(s);
    await handler.handle('test', chat, 'AERODROM DO 89999');
    await handler.handle('test', chat, answer);
    const after = sessions.get(chat);
    assert.equal(after?.slots.bedrooms, 3, `"${answer}" must capture 2 спални → 3-собен`);
    assert.equal(after?.state, 'presentation', `"${answer}" must complete the funnel: ${after?.state}`);
    offlineMap.close();
  }
});

test('bare number words are NOT answers when a budget/size/type word is present', async () => {
  const { detectBedrooms } = await import('../src/llm/deterministic');
  // "една гарсоњера" is a QUANTITY (the garsonjera branch keeps it), not an answer
  assert.equal(detectBedrooms('EDNA GARSONJERA'), 1);
  // a budget number makes it a search criterion, never a bedroom answer
  assert.equal(detectBedrooms('EDNA DO 250 EVRA'), undefined);
  assert.equal(detectBedrooms('2 DO 500'), undefined);
  // size answers belong to the sqm slot
  assert.equal(detectBedrooms('EDNA 55 M2'), undefined);
});
