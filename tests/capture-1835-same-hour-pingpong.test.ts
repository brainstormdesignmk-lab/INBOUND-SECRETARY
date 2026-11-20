// THE [18:35] CAPTURE — the owner is asked about the hour he just offered.
//
//   owner: «…во 17:00 не можам. 18:00?»          → relayed to the client
//   client: «mislam deka ke moze vo 6»           → a YES to 18:00
//   Lina → OWNER: «Клиентот не е во можност за посета во 18:00.
//                  Има друг предлог: 18:00»
//
// Two string comparisons where an INSTANT was meant:
//   • classify `timeConfirmCounterEvent` compared normalizeOwnerTime(text) with
//     normalizeOwnerTime(ownerTerm) BEFORE the missing day was merged, so
//     «во 6» ≠ «Понеделник, 23.11.2026 во 18:00» and the acceptance became a
//     new proposal (time_confirm → owner_checking);
//   • `runOwnerCheck` then built the follow-up from `priorAsk !== askTime` —
//     again strings — and printed the same hour on both sides of «Има друг
//     предлог».
//
// The contracts pinned here:
//   1. the client's yes to the owner's counter is TIME_ACCEPTED and books the
//      counter's instant — no owner ping;
//   2. at the seam that talks to an owner, a term naming the instant the owner
//      himself offered is settled even if the classifier called it a proposal
//      (the LLM leg can, and the invariant must not depend on it);
//   3. a term naming the instant already in flight is never put to him twice;
//   4. a rejection that echoes the hour is never consent.
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
import { sameVisitInstant } from '../src/visits/time';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

const ROWS: Property[] = [
  { eb: 87, id: 87, location: 'Центар', address: 'Улица 87', price: 95000, bedrooms: 2, sqm: 60, service: 'buy' },
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  async getById(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  get healthy(): boolean { return true; }
}

// The owner's counter, in the canonical display form the relay prints.
const MONDAY = 'Понеделник, 23.11.2026 во 18:00';
// A fixed clock so the weekday resolution is the same on every run.
const NOW = new Date(2026, 10, 19, 10, 0, 0); // Thursday 19.11.2026

function makeHandler() {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const sent: string[] = [];
  const asks: string[] = [];
  const channels = new ChannelRegistry();
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const props = new FakeProps(ROWS);
  const appointments = new AppointmentStore(db);
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, props),
    responder: new Responder(new FailingLlm(), cfg),
    properties: props,
    appointments,
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false }),
    ownerAgent: new DeferredOwnerAgent(new OwnerStore(db), new EventStore(db), 600_000, 60_000),
  });
  handler.onOwnerAsk = (_c: string, _eb: number, q: string) => { asks.push(q); };
  const chatId = 'capture-1835';
  const seed = (patch: (s: ReturnType<typeof freshSession>) => void = () => {}) => {
    const s = freshSession('test', chatId);
    s.state = 'time_confirm';
    s.slots.service = 'buy';
    s.slots.propertyId = 87;
    s.slots.interestedPropertyId = 87;
    s.slots.visitTime = 'Понеделник во 17:00';
    // What applyOwnerVerdict's counter arm writes: the owner's own offer.
    s.slots.ownerTime = MONDAY;
    s.slots.ownerCounterTime = MONDAY;
    patch(s);
    sessions.set(s);
    return s;
  };
  return { handler, sessions, sent, asks, appointments, chatId, seed };
}

const tick = (ms = 80) => new Promise(r => setTimeout(r, ms));

// ── 1. the helper itself ───────────────────────────────────────────────────
test('[18:35] two terms are the same moment when they resolve to the same instant', () => {
  assert.equal(sameVisitInstant('во 6', MONDAY, [], NOW), true, 'the bare hour says 18:00');
  assert.equal(sameVisitInstant('vo 6 saat', MONDAY, [], NOW), true, 'the hour-word form too');
  assert.equal(sameVisitInstant('mislam deka ke moze vo 6', MONDAY, [], NOW), true);
  assert.equal(sameVisitInstant('18:00', MONDAY, [], NOW), true, 'the clock as written');
  assert.equal(sameVisitInstant('во 7', MONDAY, [], NOW), false, 'a different hour is different');
  assert.equal(sameVisitInstant('вторник во 6', MONDAY, [], NOW), false, 'a different DAY is different');
  // A day-less clock on either side borrows the day from the term on the table.
  assert.equal(sameVisitInstant('Понеделник во 6', MONDAY, [], NOW), true);
});

// ── 2. the capture, end to end ─────────────────────────────────────────────
test('[18:35] e2e: the client’s yes to the owner’s counter books it, with no owner ping', async () => {
  const h = makeHandler();
  h.seed();

  await h.handler.handle('test', h.chatId, 'mislam deka ke moze vo 6');
  await tick();

  assert.equal(h.asks.length, 0,
    `the owner is never asked about the hour he named: ${JSON.stringify(h.asks)}`);
  const s = h.sessions.get(h.chatId)!;
  assert.equal(s.state, 'pending', 'the accepted term is settled, the negotiation is closed');
  const rows = h.appointments.listByChat(h.chatId);
  assert.equal(rows.length, 1, `the visit is booked: ${JSON.stringify(rows)}`);
  assert.match(rows[0]!.time ?? '', /18:00/u, `at the counter’s hour: ${rows[0]!.time}`);
  const last = h.sent.at(-1) ?? '';
  assert.match(last, /Договорена посета/u, `the client hears the booking: ${last}`);
  assert.match(last, /18:00/u, last);
  for (const line of h.sent) {
    assert.doesNotMatch(line, /не е во можност/u,
      `no refusal of a term nobody refused: ${line}`);
  }
});

// ── 3. the seam invariant, independent of the classifier ───────────────────
test('[18:35] the seam refuses to ask an owner about the instant he offered', async () => {
  const h = makeHandler();
  const s = h.seed();
  // The LLM leg (or a future lane) minted a PROPOSAL for the same instant.
  const seam = h.handler as unknown as {
    runOwnerCheck: (session: unknown, eb: number, term: string) => Promise<void>;
  };
  // A COMPLETE term naming the counter's instant (the shape the merge hands
  // over when the classifier/lane disagreed about the event type).
  await seam.runOwnerCheck(s, 87, '23.11.2026 во 18:00');
  await tick();

  assert.equal(h.asks.length, 0, `nothing is asked: ${JSON.stringify(h.asks)}`);
  assert.equal(h.appointments.listByChat(h.chatId).length, 1, 'the offered instant is booked');
});

// ── 4. an identical question already in flight is not repeated ─────────────
test('[18:35] an identical term while the check is pending is not a second ask', async () => {
  const h = makeHandler();
  // The owner was asked 18:00 (no counter yet), the check is open, and the
  // client restates that hour: the same question must not go out twice.
  const s = h.seed((sess) => {
    sess.slots.ownerCounterTime = undefined;
    sess.slots.ownerTime = MONDAY;
    sess.state = 'owner_checking';
    sess.slots.ownerAskTime = MONDAY;
    sess.slots.visitTime = MONDAY;
  });
  // A pending check exists (the deferred agent holds one per chat).
  void h.handler.ownerAgent.check(h.chatId, 87, MONDAY, 'Дали е слободна?');
  await tick();

  const seam = h.handler as unknown as {
    runOwnerCheck: (session: unknown, eb: number, term: string) => Promise<void>;
  };
  const before = h.asks.length;
  await seam.runOwnerCheck(s, 87, '23.11.2026 во 18:00');
  await tick();
  assert.equal(h.asks.length, before, 'the duplicate never reaches the owner');
  assert.equal(h.appointments.listByChat(h.chatId).length, 0, 'and nothing is booked on a duplicate');
});

// ── 5. a rejection is never consent, even when it echoes the hour ──────────
test('[18:35] a rejection that echoes the counter’s hour books nothing', async () => {
  const h = makeHandler();
  const s = h.seed((sess) => {
    sess.history.push({ role: 'user', text: 'ne mi odgovara vo 6' } as never);
  });
  const seam = h.handler as unknown as {
    runOwnerCheck: (session: unknown, eb: number, term: string) => Promise<void>;
  };
  await seam.runOwnerCheck(s, 87, '23.11.2026 во 18:00');
  await tick();
  assert.equal(h.appointments.listByChat(h.chatId).length, 0,
    'the client’s own words veto the instant match');
  assert.equal(h.sessions.get(h.chatId)!.state, 'visit_scheduling',
    'a refused hour goes back to collecting a term');
  assert.match(h.sent.at(-1) ?? '', /\?/u, 'the client is asked for a term');
});
