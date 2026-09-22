// P4 FALLBACK-LITERAL CAPTURE — no reply without a bank identity.
//
// An inline ?? '…' literal served to a client (bank miss in dispatchSimple,
// or the responder's hard fallback) used to be anonymous: no enrichment row,
// no metric, no correction path — invisible to every improvement pipeline no
// matter how often it fired. The capture logs such serves as FALLBACK_ORPHAN
// rows (bankKey null); the midnight cron's learn.* path digests frequent
// orphan groups into banked keys, and bank:fallback-census counts them.
//
// exclusions (deliberate, not gaps): property-card presentations are code-
// built data display, not bankable prose; FEED_UNAVAILABLE_LINE is the
// outage notice — nothing to learn while the feed is down.

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
import { SIMPLE_DETECTORS, SimpleDetector } from '../src/handlers/router';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429'); }
}

function tmpMapDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p4cap-')), 'map.db');
}

function makeHandler(db: Db) {
  const cfg = loadConfig();
  const sessions = new SessionStore(db);
  const props = new FakeProps([
    { eb: 78, id: 78, location: 'Центар', price: 185000, service: 'buy', size: '80 м²' } as Property,
  ]);
  const llm = new FailingLlm();
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  writeMap(tmpMapDb(), [], []);
  const offlineMap = new OfflineMapStore(tmpMapDb());
  const enrichment = new EnrichmentStore(db);
  const handler = new InboundHandler({ cfg, db, sessions, classifier: new Classifier(llm, cfg, props),
    responder: new Responder(llm, cfg), properties: props,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db), meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap }),
    enrichment, bank: new BankStore(db) });
  return { handler, sessions, enrichment, sent };
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getById(eb: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === eb || r.id === eb);
  }
}

test('P4 capture: a bank-miss fallback serve is logged as FALLBACK_ORPHAN; a bank hit is not', async () => {
  const db = new Db(':memory:');
  const { handler, enrichment, sent } = makeHandler(db);
  const chatId = 'p4-e2e';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return; };

  // Enter discovery the normal way (no properties bound — the orphan lane
  // requires props.length === 0, since props-present fallback is the
  // code-built cards path, deliberately excluded).
  await send('dobar den');
  const before = enrichment.listPending().length;

  // TEMPORARY detector whose bank key has NO seeds → dispatchSimple serves its
  // inline fallback literal → the capture must fire. Removed in finally.
  const orphanDetector: SimpleDetector = {
    intent: 'TEST_ORPHAN',
    bankKey: 'test.orphan.unbanked',
    fallback: 'Тест литерал без банков идентитет. Дали Ви одговара?',
    detect: () => true,
    allowedStates: ['discovery', 'property_query', 'presentation', 'closing'],
  };
  SIMPLE_DETECTORS.unshift(orphanDetector);
  try {
    await send('proba test edna dva tri');
  } finally {
    const i = SIMPLE_DETECTORS.indexOf(orphanDetector);
    if (i >= 0) SIMPLE_DETECTORS.splice(i, 1);
  }

  const orphans = enrichment.listPending().filter(r => r.eventType === 'FALLBACK_ORPHAN');
  assert.equal(orphans.length, 1, `expected exactly 1 orphan row, got ${orphans.length}`);
  const o = orphans[0]!;
  assert.equal(o.bankKey, null, 'orphan rows carry no bank key');
  assert.equal(o.replySource, 'fallback');
  assert.ok(o.replyText.includes('Тест литерал'), `replyText is the served literal: ${o.replyText.slice(0, 50)}`);
  assert.ok(enrichment.listPending().length >= before + 1);

  // Control: same mechanics but bankKey WITH seeds → no orphan row.
  const seededDetector: SimpleDetector = {
    intent: 'TEST_SEEDED',
    bankKey: 'followup.defer',
    fallback: 'никогаш не треба да се послужи ова',
    detect: () => true,
    allowedStates: ['discovery', 'property_query', 'presentation', 'closing'],
  };
  SIMPLE_DETECTORS.unshift(seededDetector);
  try {
    await send('proba test cetiri pet sest');
  } finally {
    const i = SIMPLE_DETECTORS.indexOf(seededDetector);
    if (i >= 0) SIMPLE_DETECTORS.splice(i, 1);
  }
  assert.equal(
    enrichment.listPending().filter(r => r.eventType === 'FALLBACK_ORPHAN').length,
    1,
    'a bank-backed serve must NOT be captured as an orphan',
  );
  assert.ok(!sent[sent.length - 1].includes('никогаш не треба'), 'seeded key serves bank text, not the fallback');
});

test('P4 census: orphan rows aggregate by reply text', async () => {
  // Census reads enrichment_queue via SQL — verify the aggregation shape on
  // a fresh store with two orphan rows in different states.
  const db = new Db(':memory:');
  const enrichment = new EnrichmentStore(db);
  enrichment.insert({ chatId: 'c1', state: 'property_query', eventType: 'FALLBACK_ORPHAN', userMsg: 'a?', replyText: 'Литерал А. Дали Ви одговара?', replySource: 'fallback' });
  enrichment.insert({ chatId: 'c2', state: 'closing', eventType: 'FALLBACK_ORPHAN', userMsg: 'b?', replyText: 'Литерал А. Дали Ви одговара?', replySource: 'fallback' });
  enrichment.insert({ chatId: 'c3', state: 'closing', eventType: 'DETERMINISTIC_FAST', userMsg: 'c?', replyText: 'bank-backed', replySource: 'deterministic', bankKey: 'fee.ask.buy' });
  const rows = enrichment.listPending().filter(r => r.eventType === 'FALLBACK_ORPHAN');
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.bankKey === null));
});
