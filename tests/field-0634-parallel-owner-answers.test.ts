/**
 * FIELD CAPTURE [06:34] — «AFTER THE FIRST OWNER SHE STOPS THE PING-PONG».
 *
 *   [06:33] ЛИНА: …последователни термини на Петок, 27.11.2026: 17:00 и 18:00 и
 *           19:00. Дали Ви одговара вака?
 *   [06:34] ДА МОЖЕ
 *   [06:34] СОПСТВЕНИК: ВО 6 БИ МОЖЕЛО          → EB 82 counter 18:00
 *   …and nothing reaches the client ever again.
 *
 * A route asks its owners IN PARALLEL: the deferred agent keeps one pending
 * check per (chat, EB). But every owner seam — the TUI pane's plain text, the
 * transport's ownerMessage — resolved the SUBJECT from the chat's own
 * `propertyId`, which is whichever stop was asked last (here 89, and the first
 * answer had already moved it to 82). So after the first owner spoke, the
 * second owner's answer was filed against the FIRST stop: `applyChainVerdict`
 * looked for a stop still `asked` with that eb, found none (it was already
 * `counter`), and dropped the sentence. Two owners had replied and the client
 * sat silent with the stops still marked `asked`.
 *
 * The pending check is the authority: the answer belongs to the flat he was
 * asked about. These tests drive the plain-text seam exactly as the operator
 * and the transport do (no EB named) and require each answer to land on its own
 * stop, and the whole route to reach the client when the last one answers.
 */
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

const cfg = loadConfig();

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('probe: LLM disabled'); }
}

const EBS = [82, 88, 89];
const ROWS: Property[] = EBS.map(eb => ({
  eb, id: eb, location: 'Аеродром', address: `Улица ${eb}`, price: 100000 + eb * 100,
  bedrooms: 3, sqm: 77, size: '77 м²', service: 'buy',
} as Property));

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getById(id: number): Promise<Property | undefined> { return this.rows.find(r => r.id === id || r.eb === id); }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  get healthy(): boolean { return true; }
}

function makeHandler() {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const properties = new FakeProps(ROWS);
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, properties),
    responder: new Responder(new FailingLlm(), cfg),
    properties,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db), meta: new MetaStore(db), channels,
  });
  const chatId = 'route-0634';
  const state = () => sessions.get(chatId)!;
  const stops = () => state().slots.visitPlan?.stops ?? [];
  const seed = () => {
    const s = freshSession('test', chatId);
    s.state = 'visit_scheduling';
    s.slots.service = 'buy';
    s.slots.currentBatch = EBS;
    s.slots.presentedIds = EBS;
    s.slots.viewingFeeAgreed = true;
    s.slots.feeDisclosed = true;
    s.slots.visitWanted = true;
    s.slots.visitEbs = EBS;
    s.slots.visitDayChoice = 'same';
    sessions.set(s);
  };
  const say = async (m: string): Promise<string> => {
    sent.length = 0;
    await handler.handle('test', chatId, m);
    return sent.at(-1) ?? '';
  };
  const ownerSays = async (m: string): Promise<string> => {
    sent.length = 0;
    const r = await handler.ownerMessage(chatId, m);
    await new Promise(res => setTimeout(res, 150));
    return r.replyText ?? sent.at(-1) ?? '';
  };
  return { handler, sessions, sent, chatId, state, stops, seed, say, ownerSays };
}

test('[06:34] the second owner\'s answer lands on HIS stop, not the answered one', async () => {
  const h = makeHandler();
  h.seed();
  await h.say('ПЕТОК ВО 17:00, САКАМ ДА ГИ ВИДАМ СИТЕ');
  assert.deepEqual(h.stops().map(s => s.eb).sort(), [82, 88, 89], 'the route asks all three');
  assert.equal(h.stops().every(s => s.status === 'asked'), true,
    `every stop is waiting on its owner: ${JSON.stringify(h.stops())}`);

  // The FIRST owner answers, as in the capture (a counter, his own hour).
  await h.ownerSays('ВО 6 БИ МОЖЕЛО');
  // The SECOND owner answers. Before the fix this sentence was applied to EB 82
  // (the chat's live eb), where no stop waited any more — and was dropped.
  const served = await h.ownerSays('МОЖЕ ВО 18:00');

  const stops = h.stops();
  const byEb = new Map(stops.map(s => [s.eb, s]));
  assert.equal(byEb.get(82)?.status, 'counter', `EB 82 keeps its own counter: ${JSON.stringify(stops)}`);
  // «може во 18» is HIS OWN hour — a counter with a clock, not the flat's asked
  // 18:00 read as consent. What matters here is WHERE it landed.
  assert.equal(byEb.get(88)?.status === 'asked', false,
    `the owner who said «може во 18» is EB 88, not the first flat: ${JSON.stringify(stops)}`);
  assert.deepEqual(byEb.get(88)?.hours, [18],
    `EB 88 carries HIS hour: ${JSON.stringify(stops)}`);
  assert.equal(byEb.get(89)?.status, 'asked', `EB 89 is still being asked: ${JSON.stringify(stops)}`);
  assert.equal(served.includes('нема активна проверка'), false,
    `no «no pending check» while his stop IS pending: ${served}`);
});

test('[06:34] the route reaches the client when the LAST owner answers', async () => {
  const h = makeHandler();
  h.seed();
  await h.say('ПЕТОК ВО 17:00, САКАМ ДА ГИ ВИДАМ СИТЕ');
  // Each owner accepts the hour HE was asked (a connecting chain), so the
  // solver has nothing to chase and the route is put to the client at once.
  await h.ownerSays('МОЖЕ ВО 17:00');    // 82
  await h.ownerSays('МОЖЕ ВО 18:00');    // 88
  await h.ownerSays('МОЖЕ ВО 19:00');    // 89

  const reply = h.sent.at(-1) ?? '';
  assert.notEqual(reply.trim(), '', 'the client is told the route once every owner answered');
  for (const eb of [82, 88, 89]) {
    assert.match(reply, new RegExp(`Евидентен број ${eb}`),
      `the plan names EB ${eb}: ${reply}`);
  }
  assert.equal(h.state().state, 'time_confirm', 'the plan is put to the client for his yes');
});

test('[06:34] the client hears one status bump while the other owners are out', async () => {
  const h = makeHandler();
  h.seed();
  await h.say('ПЕТОК ВО 17:00, САКАМ ДА ГИ ВИДАМ СИТЕ');
  // THE ROUND HAS BEEN WAITING: the status bump is for a real wait (ten
  // minutes), not for the millisecond before the route itself — age the round
  // exactly as the clock would have.
  const aged = h.state();
  aged.slots.visitPlan!.roundAt = Date.now() - 11 * 60_000;
  h.sessions.set(aged);
  const first = await h.ownerSays('ВО 6 БИ МОЖЕЛО');
  // The first owner answered; the chat is NOT silent while two others are out.
  assert.match(first, /Сè уште ги чекам/iu, `one honest status line: ${first}`);
  assert.match(first, /Евидентен број 88 и 89/u, `it names both flats still out: ${first}`);
  assert.doesNotMatch(first, /\b\d{2}:\d{2}\b/u,
    `no hour nobody confirmed appears in a status line: ${first}`);

  // A second verdict inside the same round does not turn the status into a census.
  h.sent.length = 0;
  await h.ownerSays('МОЖЕ ВО 18:00');
  assert.equal(h.sent.filter(t => /Сè уште ги чекам/iu.test(t)).length, 0,
    `one bump per round: ${JSON.stringify(h.sent)}`);
});
