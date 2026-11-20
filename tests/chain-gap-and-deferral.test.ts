// TWO CLIENT DECISION POINTS OF THE ROUTE (the owner's 2026-11-19 answers).
//
//   1. A PAUSE IS THE CLIENT'S CALL. When nothing connects the owners' hours but
//      a 1–2 hour pause does, the route is OFFERED with the pause named and a
//      question that covers it — never booked silently.
//   2. NOBODY IS DROPPED. A flat that cannot share the day is named as a
//      separate term and, once the route is booked, the client is asked for ITS
//      day and hour — the owner is then contacted for that term.
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

const EBS = [82, 84, 88];
const ROWS: Property[] = EBS.map(eb => ({
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

function makeHandler(ebs: number[] = [82, 84]) {
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
  const chatId = 'route-decisions';
  const say = async (m: string): Promise<string> => {
    sent.length = 0;
    await handler.handle('test', chatId, m);
    return sent.at(-1) ?? '';
  };
  const seed = () => {
    const s = freshSession('test', chatId);
    s.state = 'visit_scheduling';
    s.slots.service = 'buy';
    s.slots.currentBatch = ebs;
    s.slots.presentedIds = ebs;
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
    await new Promise(r => setTimeout(r, 200));
    return sent.at(-1) ?? '';
  };
  return { handler, sessions, sent, asks, chatId, say, seed, answer, appointments };
}

test('[gap] a two-hour pause is OFFERED with the pause named, and his yes books it', async () => {
  const h = makeHandler();
  h.seed();
  await h.say('ПЕТОК ВО 17:00, САКАМ ДА ГИ ВИДАМ ДВАТА');
  // Owner 1 only 17, owner 2 cannot do 18 and offers 20 → a two-hour pause
  // would be the route, so ONE more question is asked first: can he do 19?
  await h.answer(82, 'MOZE', 'Петок во 17:00');
  const probe = await h.answer(84, 'MOZE VO 20:00', 'Петок во 18:00');
  assert.equal(probe, '', 'the pause is not offered while a connecting hour exists');
  assert.match(h.asks.at(-1) ?? '', /19:00/u, `she asks for the connecting hour: ${h.asks.at(-1)}`);

  // He agrees to 19 → the route is 17 + 19 (a one-hour pause), named and asked.
  const asked = await h.answer(84, 'MOZE', 'Петок во 19:00');
  assert.match(asked, /17:00/u, `the route is offered: ${asked}`);
  assert.match(asked, /19:00/u, asked);
  assert.match(asked, /пауза од 1 час/u, `the pause is named: ${asked}`);
  assert.match(asked, /Дали Ви одговара вака, со пауза/u, `and it is HIS decision: ${asked}`);
  assert.equal(h.appointments.count(), 0, 'a pause is never booked silently');

  await h.say('ДА, ВО РЕД Е');
  const rows = h.appointments.listByChat(h.chatId);
  assert.equal(rows.length, 2, `his yes books both: ${JSON.stringify(rows)}`);
});

test('[deferral] the flat that cannot share the day gets its OWN term next', async () => {
  const h = makeHandler([82, 84, 88]);
  h.seed();
  await h.say('ПЕТОК ВО 17:00, САКАМ ДА ГИ ВИДАМ ТРИТЕ');
  // Three owners asked in one parallel round: 17, 18, 19.
  assert.equal(h.asks.length, 3, `one round: ${JSON.stringify(h.asks)}`);

  // 82 and 84 agree; 88 can only do 12:00. The negotiator first tries ONE hour
  // that would still fit him into the route, then settles for his own term.
  await h.answer(82, 'MOZE', 'Петок во 17:00');
  await h.answer(84, 'MOZE', 'Петок во 18:00');
  const probe = await h.answer(88, 'SAMO VO 12:00', 'Петок во 19:00');
  assert.equal(probe, '', 'the route is not offered while a fitting hour exists');
  assert.match(h.asks.at(-1) ?? '', /број 88/u, `she asks EB 88 once more: ${h.asks.at(-1)}`);
  assert.match(h.asks.at(-1) ?? '', /20:00/u, h.asks.at(-1) ?? '');

  const second = await h.answer(88, 'SAMO VO 12:00', 'Петок во 20:00');
  assert.equal(second, '', 'still asking — one hour would take all three');
  assert.match(h.asks.at(-1) ?? '', /21:00/u, `the last fitting hour is asked: ${h.asks.at(-1)}`);

  // His third answer is the same: the budget is spent, the route is offered and
  // EB 88 keeps its own term — exactly three questions, never an endless ping.
  const asked = await h.answer(88, 'SAMO VO 12:00', 'Петок во 21:00');
  assert.match(asked, /17:00/u, `the route is offered: ${asked}`);
  assert.match(asked, /18:00/u, asked);
  assert.match(asked, /88/u, `the third flat is named: ${asked}`);
  assert.match(asked, /друг термин/u, `…as its own term, not dropped: ${asked}`);
  assert.doesNotMatch(asked, /12:00/u, `its hour is not forced into this day: ${asked}`);

  // His yes books the two that fit and asks for the third's own day/hour.
  const afterBooking = await h.say('ДА, ГИ ПОТВРДУВАМ');
  assert.equal(h.appointments.listByChat(h.chatId).length, 2);
  assert.match(afterBooking, /88/u, `the deferred flat is the next question: ${afterBooking}`);
  assert.match(afterBooking, /\?$/u, afterBooking);
  const s = h.sessions.get(h.chatId)!;
  assert.equal(s.state, 'visit_scheduling', `the chat collects its term: ${s.state}`);
  assert.equal(s.slots.propertyId, 88, 'the deferred flat is the subject');

  // A term for it reaches ITS owner.
  const before = h.asks.length;
  await h.say('ВТОРНИК ВО 14:00');
  assert.ok(h.asks.length > before, 'the deferred flat’s owner is asked');
  assert.match(h.asks.at(-1) ?? '', /88|број 88/u, `about EB 88: ${h.asks.at(-1)}`);
  assert.match(h.asks.at(-1) ?? '', /14:00/u, h.asks.at(-1) ?? '');
});
