// THE [20:33] CAPTURE — bare "drugo" on a DRAINED criteria pool. Lina
// silently refilled with off-criteria rows (Аеродром 380€ over the 350 cap,
// a деловен простор at 500€ into a residential funnel) instead of saying the
// matching options were done and offering the two standard pivots. Root
// causes (3):
//   1. Nothing owned the drained-pool more-ask in presentation — the refill
//      lanes served whatever candidates() could find (near-center relaxation).
//   2. The category-neutral candidates() absence branch let деловен rows
//      fill a residential funnel whose bedrooms axis was already engaged
//      ("spalni bilo kolku") — the businessPoolLock now excludes them.
//   3. The over-budget lift for the pricier pivot comes only on ANSWER,
//      never silently on the more-ask.

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

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429'); }
}

function tmpMapDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'drugopivot-')), 'map.db');
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getById(eb: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === eb || r.id === eb);
  }
  get healthy(): boolean { return true; }
}

// Центар rent pool for the 350 cap:
//   EB 76 garsonjera 200€, EB 70 двособен 350€ — the criteria-fit pair.
//   EB 56 деловен простор 500€ in Центар — must NEVER fill the residential
//   funnel (no business slot ever armed).
//   EB 61 Аеродром 380€ — over budget, and NOT this area.
//   EB 33 Аеродром 320€ — the honest "same price elsewhere" answer.
const ROWS: Property[] = [
  { eb: 76, id: 76, location: 'Центар', address: 'Ул. Тест 1', price: 200,
    service: 'rent', sqm: 24, bedrooms: 1, details: 'Реновирана ефтина гарсоњера во строг центар.' },
  { eb: 70, id: 70, location: 'Центар', address: 'Ул. Тест 2', price: 350,
    service: 'rent', sqm: 39, bedrooms: 2, details: 'Тест наместен стан со една спална во Центар.' },
  { eb: 61, id: 61, location: 'Аеродром', address: 'Ул. Тест 3', price: 380,
    service: 'rent', sqm: 82, bedrooms: 4, details: 'Убаво опремен четирисобен стан во Аеродром.' },
  { eb: 56, id: 56, location: 'Центар', address: 'Ул. Тест 4', price: 500,
    service: 'rent', sqm: 40, business: true, details: 'Одлична локација, деловен простор.' },
  { eb: 33, id: 33, location: 'Аеродром', address: 'Ул. Тест 5', price: 320,
    service: 'rent', sqm: 44, bedrooms: 2, details: 'Двособен стан во Аеродром, светол.' },
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

/** The client the tests share; each test uses a fresh session on it. */
const chat = 'drugo-pivot-client';

/** The last message the fake channel captured. */
function latest(list: string[]): string {
  assert.ok(list.length > 0, 'the channel must have captured at least one message');
  return list[list.length - 1];
}

test('[20:33] "drugo" on a drained pool asks the criteria-done choice, never a junk refill', async () => {
  const { handler, sessions, sent, offlineMap } = makeHandler();
  // «STAN» is named on purpose (expectation fixed, not the product): since the
  // [19:06] contract an unnamed type is ASKED first — the right answer there,
  // but not the lane this test pivots in (see
  // tests/type-unknown-ask-and-correction.test.ts).
  await handler.handle('test', chat, 'STAN KIRIJA DO 350E VO CENTAR');
  assert.ok(latest(sent).includes('спални'), `the bedrooms ask must fire: ${latest(sent).slice(0, 160)}`);

  await handler.handle('test', chat, 'SPALNI BILO KOLKU');
  const pair = latest(sent);
  assert.ok(/број (70|76)/u.test(pair), `the criteria-fit pair must be presented: ${pair.slice(0, 200)}`);

  // Drain: repeat the bare more-ask until the pool empties. Every refill
  // before the pivot must stay clean: no Аеродром 380, no деловен 500.
  let pivot = '';
  for (let i = 0; i < 4; i++) {
    await handler.handle('test', chat, 'DRUGO');
    pivot = latest(sent);
    assert.ok(!/број 61\b/u.test(pivot), `no over-budget junk before the pivot ask: ${pivot.slice(0, 200)}`);
    assert.ok(!/број 56\b/u.test(pivot), `no business junk in the residential funnel: ${pivot.slice(0, 200)}`);
    if (/поскапо/iu.test(pivot)) break;
  }
  // THE CONTRACT: options come only AFTER the criteria-done ask.
  assert.ok(/поскапо/iu.test(pivot), `the drained pool must ask the criteria-done choice: ${pivot.slice(0, 200)}`);
  assert.ok(/други населби/iu.test(pivot), `the two standard pivots must be named: ${pivot.slice(0, 200)}`);
  assert.equal(sessions.get(chat)?.slots.moreChoicePending, true, 'the pivot answer state must be armed');

  // Same price, different neighborhoods — the honest elsewhere batch. The
  // widen phrasing must be answered with the batch in the SAME turn: no
  // clarification ask, no re-present, no junk cards ahead of EB 33.
  await handler.handle('test', chat, 'DA, POKAZI I VO DRUGA NASELBA');
  const elsewhere = latest(sent);
  assert.ok(/број 33\b/u.test(elsewhere), `the elsewhere batch must serve EB 33 (Аеродром 320€): ${elsewhere.slice(0, 200)}`);
  assert.ok(!/број 61\b/u.test(elsewhere), `the 380€ row stays over the client's cap: ${elsewhere.slice(0, 200)}`);
  assert.ok(!/број 56\b/u.test(elsewhere), `the business row stays out of the residential funnel: ${elsewhere.slice(0, 200)}`);

  offlineMap.close();
});

test('[20:33] "poskapo" on an empty pricier pool answers honestly — no silent junk lift', async () => {
  const { handler, sessions, sent, offlineMap } = makeHandler();
  await handler.handle('test', chat, 'KIRIJA DO 350E VO CENTAR');
  await handler.handle('test', chat, 'SPALNI BILO KOLKU');
  assert.ok(/број (70|76)/u.test(latest(sent)), 'the pair must be presented first');

  let pivot = '';
  for (let i = 0; i < 4; i++) {
    await handler.handle('test', chat, 'DRUGO');
    pivot = latest(sent);
    if (/поскапо/iu.test(pivot)) break;
  }
  assert.ok(/поскапо/iu.test(pivot), `the pivot ask must fire: ${pivot.slice(0, 200)}`);

  // The FIRST-named option: more expensive in the same area. Центар has
  // nothing pricier (EB 56 деловен is locked out of the residential funnel)
  // → the honest exhausted line, never EB 61/56 junk and never silence.
  await handler.handle('test', chat, 'DA POSKAPO');
  const pricier = latest(sent);
  assert.ok(!/(евидентен број|Evidenten broj)\s*\d/iu.test(pricier), `no junk cards after the pivot: ${pricier.slice(0, 200)}`);
  assert.ok(pricier.length >= 20, `the turn must still get a reply: ${pricier.slice(0, 200)}`);

  offlineMap.close();
});
