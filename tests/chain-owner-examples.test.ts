// THE OWNER'S TWO ROUTE EXAMPLES, END TO END (2026-11-19 brief).
//
//   example 1 — client wants 17, owner 1 wants 18, owner 2 is asked for 17:
//               if he agrees the route is 84@17 + 82@18.
//   example 2 — owner 2 cannot do 17 but offers 16: she does NOT accept a 16/18
//               with a pause, she asks him for 19, and only then tells the
//               client «18 за ЕБ 82, 19 за ЕБ 84».
//
// The owners are contacted IN PARALLEL (one question each, in one round), every
// answer is merged against ITS OWN stop, the negotiator picks the hour, and the
// client hears ONE plan with the shift stated.
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
import { detectOwnerVerdict } from '../src/llm/deterministic';

const cfg = loadConfig();

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('probe: LLM disabled'); }
}

const ROWS: Property[] = [82, 84].map(eb => ({
  eb, id: eb, location: 'Центар', address: `Улица ${eb}`, price: 80000 + eb * 100,
  bedrooms: 2, sqm: 58, size: '58 м²', service: 'buy',
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
  const appointments = new AppointmentStore(db);
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, properties),
    responder: new Responder(new FailingLlm(), cfg),
    properties,
    appointments,
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
  });
  const asks: string[] = [];
  handler.onOwnerAsk = (_c, _eb, q) => asks.push(q);
  const chatId = 'route-examples';
  const say = async (m: string): Promise<string> => {
    sent.length = 0;
    await handler.handle('test', chatId, m);
    return sent.at(-1) ?? '';
  };
  const seed = () => {
    const s = freshSession('test', chatId);
    s.state = 'visit_scheduling';
    s.slots.service = 'buy';
    s.slots.currentBatch = [82, 84];
    s.slots.presentedIds = [82, 84];
    s.slots.viewingFeeAgreed = true;
    s.slots.feeDisclosed = true;
    s.slots.name = 'Дејан Узунов';
    s.slots.phone = '076845234';
    sessions.set(s);
    return s;
  };
  const answer = async (eb: number, text: string, term: string): Promise<string> => {
    sent.length = 0;
    handler.ownerAnswer(chatId, eb, detectOwnerVerdict(text, term));
    await new Promise(r => setTimeout(r, 180));
    return sent.at(-1) ?? '';
  };
  return { handler, sessions, sent, asks, chatId, say, seed, answer, appointments };
}

test('[example 1] the second owner fills the client’s hour (17 + 18)', async () => {
  const h = makeHandler();
  h.seed();
  await h.say('ПЕТОК ВО 17:00, САКАМ ДА ГИ ВИДАМ ДВАТА');

  // ONE round: owner 82 is asked 17:00, owner 84 is asked 18:00.
  assert.equal(h.asks.length, 2, `both owners, one round: ${JSON.stringify(h.asks)}`);
  assert.match(h.asks[0] ?? '', /17:00/u, h.asks[0] ?? '');
  assert.match(h.asks[1] ?? '', /18:00/u, h.asks[1] ?? '');

  // Owner 1 cannot do 17 and offers 18.
  await h.answer(82, 'MOZE VO 18:00', 'Петок во 17:00');
  assert.equal(h.asks.length, 2, `owner 2 is not re-asked while his answer is out: ${JSON.stringify(h.asks)}`);

  // Owner 2 accepted HIS 18:00 — which now clashes with owner 1's 18:00. The
  // negotiator asks him for the CLIENT's hour (17) instead of deferring a flat.
  await h.answer(84, 'MOZE', 'Петок во 18:00');
  assert.equal(h.asks.length, 3, `the clash produces one connecting question: ${JSON.stringify(h.asks)}`);
  assert.match(h.asks[2] ?? '', /Клиентот не е во можност/u, `the follow-up shape: ${h.asks[2]}`);
  assert.match(h.asks[2] ?? '', /17:00/u, `owner 2 is asked for 17:00: ${h.asks[2]}`);
  assert.equal(h.appointments.count(), 0, 'nothing is booked from owners alone');

  // His yes completes the route: 84@17, 82@18 — the client’s own hour kept.
  const asked = await h.answer(84, 'MOZE', 'Петок во 17:00');
  assert.match(asked, /17:00/u, asked);
  assert.match(asked, /18:00/u, asked);
  assert.match(asked, /Дали да ги потврдам посетите/u, asked);
  assert.doesNotMatch(asked, /пауза/u, `no pause in a connected route: ${asked}`);
  assert.doesNotMatch(asked, /подоцна|порано/u, `the client’s start was kept: ${asked}`);
  assert.equal(h.sessions.get(h.chatId)!.state, 'time_confirm');
});

test('[example 2] a 16 answer is not a 16/18 route: she keeps asking for a link', async () => {
  const h = makeHandler();
  h.seed();
  await h.say('ПЕТОК ВО 17:00, САКАМ ДА ГИ ВИДАМ ДВАТА');
  assert.equal(h.asks.length, 2, JSON.stringify(h.asks));

  // Owner 1 can only do 18.
  await h.answer(82, 'MOZE VO 18:00', 'Петок во 17:00');
  // Owner 2 cannot do 18 and offers 16.
  await h.answer(84, 'MOZE VO 16:00', 'Петок во 18:00');

  // NOT "16 + 18 with a pause": the client's own hour (17) is the question
  // that links them, so she asks it.
  assert.equal(h.asks.length, 3, `the connecting question: ${JSON.stringify(h.asks)}`);
  assert.match(h.asks[2] ?? '', /Клиентот не е во можност/u, `the follow-up shape: ${h.asks[2]}`);
  assert.match(h.asks[2] ?? '', /17:00/u, `she asks him for the client’s hour: ${h.asks[2]}`);

  // He cannot do 17 either — only 16. NOW the remaining link is 19:00, and the
  // brief's own arithmetic applies (18 + 19, the start one hour later).
  await h.answer(84, 'SAMO VO 16:00', 'Петок во 17:00');
  assert.equal(h.asks.length, 4, `the second connecting question: ${JSON.stringify(h.asks)}`);
  assert.match(h.asks[3] ?? '', /Клиентот не е во можност/u, `the follow-up shape: ${h.asks[3]}`);
  assert.match(h.asks[3] ?? '', /19:00/u, `she asks him for 19:00: ${h.asks[3]}`);
  assert.equal(h.appointments.count(), 0, 'still nothing booked');

  // He agrees to 19 → the client hears the linked route and the moved start.
  const asked = await h.answer(84, 'MOZE', 'Петок во 19:00');
  assert.match(asked, /18:00/u, `the route is offered: ${asked}`);
  assert.match(asked, /19:00/u, asked);
  assert.match(asked, /подоцна за 1 час/u, `the moved start is disclosed: ${asked}`);
  assert.doesNotMatch(asked, /пауза/u, `no pause is accepted while a link exists: ${asked}`);
  assert.match(asked, /Дали да ги потврдам посетите/u, asked);

  // …and his yes books BOTH visits at those hours.
  await h.say('ДА, ГИ ПОТВРДУВАМ');
  const rows = h.appointments.listByChat(h.chatId);
  assert.equal(rows.length, 2, `both visits are booked: ${JSON.stringify(rows)}`);
  const times = rows.map(r => `${r.propertyId}@${(r.time ?? '').match(/(\d{2}):(\d{2})/)?.[0] ?? ''}`).sort();
  assert.deepEqual(times, ['82@18:00', '84@19:00']);
});
