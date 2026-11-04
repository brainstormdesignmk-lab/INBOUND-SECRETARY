// THE [20:16]–[20:33] CAPTURE — four defects around the visit ping-pong.
//
//   [20:27] owner: «NE MOZAM UTRE , ZAUZET SUM»   → relayed, check consumed
//   [20:28] owner: (next sentence)                → «нема активна проверка»
//   [20:31] client: «CETVRTOK ISTO VREME MOZE ?»  → «во колку часот точно?»
//   [20:33] client: «6»                           → owner pinged with a DAY,
//                                                   no clock at all
//
// Plus the info miss line that glued BOTH variants into one sentence. The
// contracts pinned here:
//   1. ONE no-data variant per turn, rotating (never both in one breath);
//   2. «isto vreme» reuses the CLOCK already in play — the client only moves
//      the day, and the owner's ping carries the hour;
//   3. a day-only slot + a bare hour completes to a full term (the owner hears
//      «Четврток … во 18:00», never a day alone);
//   4. the OWNER's channel stays live while the term is unsettled: a second
//      verdict is relayed instead of dying with «нема активна проверка».
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
import { OwnerStore } from '../src/store/owners';
import { EventStore } from '../src/store/events';
import { DeferredOwnerAgent } from '../src/backoffice/ownerAgent';
import { mergeVisitTerm, detectSameTimeReference } from '../src/visits/time';
import { INFO_NO_DATA_LINES, noDataLine } from '../src/llm/infoAnswer';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

const ROWS: Property[] = [
  { eb: 78, id: 78, location: 'Центар', price: 90000, bedrooms: 2, sqm: 55, service: 'buy' },
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  async getById(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  get healthy(): boolean { return true; }
}

function makeHandler() {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const sent: string[] = [];
  const asks: string[] = [];
  const channels = new ChannelRegistry();
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const props = new FakeProps(ROWS);
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, props),
    responder: new Responder(new FailingLlm(), cfg),
    properties: props,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false }),
    // DEFERRED: the owner answers by hand, so the check stays pending and the
    // ping-pong is driven by ownerAnswer / ownerFollowup — the seam the TUI uses.
    ownerAgent: new DeferredOwnerAgent(new OwnerStore(db), new EventStore(db), 600_000, 60_000),
  });
  handler.onOwnerAsk = (_c: string, _eb: number, q: string) => { asks.push(q); };
  return { handler, sessions, sent, asks, db };
}

const tick = (ms = 60) => new Promise(r => setTimeout(r, ms));

function seeded(sessions: SessionStore, chatId: string, patch: (s: ReturnType<typeof freshSession>) => void) {
  const s = freshSession('test', chatId);
  s.slots.service = 'buy';
  s.slots.propertyId = 78;
  s.slots.interestedPropertyId = 78;
  s.slots.visitTime = 'Утре во 18:00';
  patch(s);
  sessions.set(s);
  return s;
}

// ── 1. the miss line: ONE variant per turn, in rotation ────────────────────
test('[20:16] the no-data line is ONE variant per turn, rotating', () => {
  assert.equal(INFO_NO_DATA_LINES.length, 2);
  for (const line of INFO_NO_DATA_LINES) {
    assert.ok(!line.includes(';'), `never both variants glued together: ${line}`);
    assert.ok(/ќе го прашам сопственикот и ќе Ви потврдам/u.test(line), line);
  }
  const a = noDataLine();
  const b = noDataLine();
  assert.notEqual(a, b, 'consecutive misses rotate the wording');
  assert.ok(INFO_NO_DATA_LINES.includes(a) && INFO_NO_DATA_LINES.includes(b));
});

// ── 2. «ISTO VREME» — the day moves, the clock is reused ───────────────────
test('[20:31] «isto vreme» reuses the clock on the table, in both scripts', () => {
  assert.equal(detectSameTimeReference('CETVRTOK ISTO VREME MOZE ?'), true);
  assert.equal(detectSameTimeReference('четврток исто време може?'), true);
  assert.equal(detectSameTimeReference('četvrtok isto vreme'), true);
  assert.equal(detectSameTimeReference('четврток во 6'), false);

  // The owner's/ client's term donates the hour; the message donates the day.
  assert.equal(mergeVisitTerm('четврток isto vreme moze', ['Утре во 18:00']), 'четврток во 18:00');
  // A bare clock still takes the donor's DAY (never a TODAY collapse).
  assert.equal(mergeVisitTerm('во 6', ['Четврток']), 'четврток во 6');
  // A complete term is never rewritten.
  assert.equal(mergeVisitTerm('петок во 11', ['Утре во 18:00']), 'петок во 11');
});

test('[20:31] e2e: «CETVRTOK ISTO VREME» asks the owner for Четврток 18:00', async () => {
  const { handler, sessions, asks } = makeHandler();
  const chatId = 'same-time';
  seeded(sessions, chatId, (s) => { s.state = 'time_confirm'; s.slots.ownerTime = undefined; });

  await handler.handle('test', chatId, 'CETVRTOK ISTO VREME MOZE ?');
  await tick();

  assert.equal(asks.length, 1, `one owner ping: ${JSON.stringify(asks)}`);
  assert.match(asks[0], /Четврток/u, `the client's day reaches the owner: ${asks[0]}`);
  assert.match(asks[0], /18:00/u, `the reused clock reaches the owner: ${asks[0]}`);
  const s = sessions.get(chatId)!;
  assert.equal(s.state, 'owner_checking');
  assert.match(s.slots.visitTime ?? '', /18:00/u, `the merged term is stored: ${s.slots.visitTime}`);
});

// ── 3. a day-only slot + a bare hour is a COMPLETE term ────────────────────
test('[20:33] e2e: «6» after a day-only term pings the owner with Четврток 18:00', async () => {
  const { handler, sessions, asks } = makeHandler();
  const chatId = 'bare-hour';
  seeded(sessions, chatId, (s) => { s.state = 'visit_scheduling'; s.slots.visitTime = 'Четврток'; });

  await handler.handle('test', chatId, '6');
  await tick();

  assert.equal(asks.length, 1, `one owner ping: ${JSON.stringify(asks)}`);
  assert.match(asks[0], /Четврток/u, `the stored day rides along: ${asks[0]}`);
  assert.match(asks[0], /18:00/u, `the hour the client gave reaches the owner: ${asks[0]}`);
});

// ── 4. the owner's channel stays live while the term is unsettled ──────────
test('[20:28] e2e: a second owner verdict is relayed, never «нема активна проверка»', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'owner-followup';
  seeded(sessions, chatId, (s) => { s.state = 'time_confirm'; s.slots.visitTime = 'Утре во 18:00'; });

  // The owner's first correction → the client hears it.
  assert.equal(handler.ownerFollowup(chatId, 78, { status: 'counter', ownerTime: 'Четврток во 11:00' }), true);
  await tick();
  assert.match(sent[sent.length - 1] ?? '', /11:00/u, `the first relay: ${sent[sent.length - 1]}`);

  // …and his NEXT sentence (a correction to the correction) still lands.
  assert.equal(sessions.get(chatId)!.state, 'time_confirm');
  assert.equal(handler.ownerFollowup(chatId, 78, { status: 'counter', ownerTime: 'Сабота во 12:30' }), true);
  await tick();
  assert.match(sent[sent.length - 1] ?? '', /12:30/u, `the follow-up must reach the client: ${sent[sent.length - 1]}`);

  // Outside the waiting states there is nothing to amend — the console says so.
  const idle = 'owner-no-term';
  sessions.set(freshSession('test', idle));
  assert.equal(handler.ownerFollowup(idle, 78, { status: 'counter', ownerTime: 'Сабота во 12:30' }), false);
});
