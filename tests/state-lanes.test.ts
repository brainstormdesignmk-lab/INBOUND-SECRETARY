// STATE LANES (R2) — serve-allowance is data, decided at the serve
// chokepoint on the PRE-serve state. A lane resolving correctly but
// serving wrongly ("SKAPO E TOA" → property card in the fee lane's
// clothing) must land here as one map row, never another inline veto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
import {
  GENERIC_ACK_FALLBACK, GENERIC_ACK_KEY, laneServeDenied, PROPERTY_SERVE_DENY_STATES,
} from '../src/llm/stateLanes';

class FailingLlm implements LlmClient { async complete(): Promise<string> { throw new Error('429'); } }
class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

const ROWS: Property[] = [
  { eb: 48, id: 48, location: 'Карпош III', price: 250, service: 'rent' },
] as unknown as Property[];

async function makeHandler() {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS);
  const classifier = new Classifier(new FailingLlm(), cfg, properties);
  const responder = new Responder(new FailingLlm(), cfg);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false }),
  });
  return { handler, sessions, sent,
    send: async (chatId: string, m: string) => {
      await handler.handle('test', chatId, m);
      return { s: sessions.get(chatId)!, reply: sent.at(-1) ?? '' };
    } };
}

// Pure matrix: fail-open everywhere except the calibrated deny rows.
test('the deny matrix denies the queue/terminal states and fails open elsewhere', () => {
  for (const s of PROPERTY_SERVE_DENY_STATES) {
    assert.equal(laneServeDenied('ANY_LANE', s, 'property-batch'), true, s);
    assert.equal(laneServeDenied('ANY_LANE', s, 'property-card'), true, s);
  }
  // Presentation-family states must NEVER deny: this is where batches live.
  for (const s of ['property_locate', 'property_query', 'presentation', 'closing']) {
    assert.equal(laneServeDenied('ANY_LANE', s, 'property-batch'), false, s);
    assert.equal(laneServeDenied('ANY_LANE', s, 'property-card'), false, s);
  }
  // Fail-open: uncalibrated grades are untouchable by this module.
  assert.equal(laneServeDenied('X', 'terminated', 'info'), false);
  assert.equal(laneServeDenied('X', 'terminated', 'funnel-ask'), false);
});

test('not-found denies queue/handshake/terminal states but answers a live EB ask', () => {
  for (const s of ['queued', 'escalated', 'terminated', 'owner_checking', 'pending', 'visit_scheduling', 'time_confirm']) {
    assert.equal(laneServeDenied('GHOST_NOTFOUND', s, 'not-found'), true, s);
  }
  for (const s of ['property_query', 'presentation', 'closing', 'discovery', 'idle']) {
    assert.equal(laneServeDenied('GHOST_NOTFOUND', s, 'not-found'), false, s);
  }
});

test('the generic acknowledge exists as data, never as silence', () => {
  assert.ok(GENERIC_ACK_KEY.length > 0);
  assert.ok(/Прислушувам/.test(GENERIC_ACK_FALLBACK));
});

// INTEGRATION: the chokepoint sits INSIDE serveBatch, before it re-points
// the session at 'presentation' — a caller arriving from a queue/terminal
// state keeps its state, gets the ack, and never a batch.
test('a batch serve from an escalated session is the ack, not a card', async () => {
  const send = (await makeHandler());
  const chatId = 'deny-escalated';
  await send.send(chatId, 'zdravo'); // create the session row first
  const s0 = send.sessions.get(chatId)!;
  s0.state = 'escalated';
  (s0.slots as Record<string, unknown>).cheaperChoicePending = true;
  (s0.slots as Record<string, unknown>).cheaperAnchor = { eb: 48, price: 40000, bedrooms: 2 };
  s0.slots.presentedIds = [48];
  send.sessions.set(s0);
  await send.handler.handle('test', chatId, 'DA');
  const reply = send.sent[send.sent.length - 1] ?? '';
  const after = send.sessions.get(chatId)!;
  // The batchgrades are DENIED — whatever the interceptor ultimately says
  // (an ack when a serve was pending, the pool-drained follow-up when it was
  // empty), the property modality never serves from this state.
  assert.ok(!/Евидентен број/.test(reply), `no batch from an escalated session: ${reply}`);
  assert.ok(!(GENERIC_ACK_FALLBACK && /Прислушувам/.test(reply) && after.state !== 'escalated'),
    'if the ack fires, the FSM stays put');
  assert.equal(after.state, 'escalated', 'the denied serve must not re-point the FSM');
});

// Same chokes for the terminal state via the cheaper-search serve route.
// The chat is BANNED (`terminatedAt`, strike 3): that is the termination that
// is answered with silence. A CANCELLATION releases the chat instead — it
// paints no `terminatedAt`, and its returning client is answered
// (tests/fixtures/transcripts/post-cancel-return.txt).
test('a cheaper-search serve from a terminated session is the ack, not a batch', async () => {
  const send = (await makeHandler());
  const chatId = 'deny-terminated';
  await send.send(chatId, 'zdravo');
  const s0 = send.sessions.get(chatId)!;
  s0.state = 'terminated';
  s0.terminatedAt = Date.now();
  s0.slots.presentedIds = [48];
  send.sessions.set(s0);
  await send.handler.handle('test', chatId, 'daj nesto poeKtino vo toj reon');
  const reply = send.sent[send.sent.length - 1] ?? '';
  const after = send.sessions.get(chatId)!;
  assert.ok(!/Евидентен број 48/.test(reply), `no batch from a terminated session: ${reply}`);
  assert.equal(after.state, 'terminated', 'the denial must not re-point the FSM');
});
