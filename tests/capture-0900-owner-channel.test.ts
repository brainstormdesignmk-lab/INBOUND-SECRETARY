/**
 * THE [09:00]–[09:04] V16K11 OWNER CHANNEL — two rules the capture demanded.
 *
 * 1. THE CLIENT'S ORDER OPENS THE ROUTE. He answered «ПОНЕДЕЛНИК 6» (= 18:00) for
 *    a PAIR, and the owner of the first flat was asked about 19:00 while 18:00
 *    went to the second («the ask to the owners should be based on his choice
 *    first, not 19:00»). An unknown hour is free, so the first question of a
 *    round is his own hour on the FIRST flat in his order, then one hour per
 *    following flat, ascending, never over an occupied hour.
 *
 * 2. THE SAME SENTENCE INSIDE THE TYPING WINDOW IS ONE MESSAGE. His «ВО 6
 *    МОЖАМ» was delivered twice (the pane logged «одговор примен: counter (ВО
 *    6)» twice) and applied twice — the exact double-send the client-side burst
 *    window exists to stop. The owner now gets the same window
 *    (`ownerTypingDelayMs`) and the repeat is a replay with the first answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planAsks, type NegotiateView, type NegotiateStop } from '../src/visits/negotiate';
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

const stop = (eb: number, extra: Partial<NegotiateStop> = {}): NegotiateStop => ({ eb, ...extra });

test('[09:00] the first flat in the client’s order is asked HIS hour', () => {
  // The pair as he saw it: 85 first, 88 second, and his own hour is 18:00.
  const asks = planAsks({ targetHour: 18, stops: [stop(85), stop(88)] });
  assert.deepEqual(asks, [
    { eb: 85, hour: 18, reason: 'first' },
    { eb: 88, hour: 19, reason: 'first' },
  ], `his hour belongs to the first flat: ${JSON.stringify(asks)}`);

  // An occupied 18:00 must not silently hand 18:00 to the SECOND stop: the
  // order survives, the hours merely shift up.
  const busy = planAsks({ targetHour: 18, busy: [18], stops: [stop(85), stop(88)] });
  assert.deepEqual(busy.map(a => a.eb), [85, 88], `the client's order is kept: ${JSON.stringify(busy)}`);
  assert.ok(busy[0]!.hour < busy[1]!.hour, `the hours ascend with it: ${JSON.stringify(busy)}`);

  // A deferred flat's own earlier hour still wins for THAT flat.
  const prefer = planAsks({ targetHour: 18, stops: [stop(85, { prefer: [17] }), stop(88)] });
  assert.equal(prefer.find(a => a.eb === 85)?.hour, 17, `the owner's earlier hour leads: ${JSON.stringify(prefer)}`);
});

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}
class FakeProps extends PropertyService {
  constructor() { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return []; }
  get healthy(): boolean { return true; }
}

function makeHandler() {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const props = new FakeProps();
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, props),
    responder: new Responder(new FailingLlm(), cfg),
    properties: props,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
  });
  return { handler, sessions, sent, cfg };
}

test('[09:04] the same owner sentence inside the window is one delivery, not two verdicts', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chat = 'v16k11-owner-burst';
  const s = freshSession('test', chat);
  s.state = 'owner_checking';
  s.slots.service = 'buy';
  s.slots.visitTime = 'Понеделник, 30.11.2026 во 18:00';
  sessions.set(s);

  const first = await handler.ownerMessage(chat, 'ZDRAVO');
  const second = await handler.ownerMessage(chat, '  zdravo  ');
  assert.equal(second.replay, true, `the repeat is a replay: ${JSON.stringify(second)}`);
  assert.equal(second.effect, first.effect, 'and it is the FIRST outcome');
  assert.equal(second.replyText, first.replyText, 'with the same sentence back');
  assert.equal(sent.length, 0, 'an owner turn never reaches the client');

  // A DIFFERENT sentence is a new turn (the window is not a mute).
  const third = await handler.ownerMessage(chat, 'DALI E SLOBODNA ?');
  assert.notEqual(third.replay, true, `a new sentence is answered: ${JSON.stringify(third)}`);
});
