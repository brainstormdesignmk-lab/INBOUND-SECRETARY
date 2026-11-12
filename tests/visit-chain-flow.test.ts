// THE VISIT CHAIN, END TO END (the owner's 2026-11-11 brief).
//
// Two flats were presented and the client wants to see BOTH on Friday at
// 16:00. Lina asks owner 42 for 16:00; on his yes she asks owner 59 for 17:00;
// when both agree the client gets the whole route in ONE ask (EB + hour only,
// per property fee); his yes books both visits and sends the planned-visit
// lines. A flat whose owner cannot do any hour that day is dropped from the
// route and named — never silently skipped.

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

const ROWS: Property[] = [42, 59].map(eb => ({
  eb, id: eb, location: 'Центар', address: `Улица ${eb}`, price: 80000 + eb * 100,
  bedrooms: 2, sqm: 58, size: '58 м²', service: 'buy',
  lat: 41.995 + eb / 10000, lon: 21.431 + eb / 10000, geo_source: 'google_cached', details: '',
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
  const chatId = 'chain';
  const say = async (m: string): Promise<string> => {
    sent.length = 0;
    await handler.handle('test', chatId, m);
    return sent.at(-1) ?? '';
  };
  const seed = () => {
    const s = freshSession('test', chatId);
    s.state = 'visit_scheduling';
    s.slots.service = 'buy';
    s.slots.currentBatch = [42, 59];
    s.slots.presentedIds = [42, 59];
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
    await new Promise(r => setTimeout(r, 150));
    return sent.at(-1) ?? '';
  };
  return { handler, sessions, sent, asks, chatId, say, seed, answer, appointments };
}

test('[chain] two flats, two owners, one route: 16:00 and 17:00', async () => {
  const h = makeHandler();
  h.seed();
  await h.say('ПЕТОК ВО 16:00, САКАМ ДА ГИ ВИДАМ ДВАТА');
  const s = h.sessions.get(h.chatId)!;
  // The FIRST owner is asked about the client's hour…
  assert.equal(s.state, 'owner_checking');
  assert.match(h.asks.at(-1) ?? '', /16:00/u, `owner 1 is asked 16:00: ${h.asks.at(-1)}`);
  // …his yes advances the chain to the SECOND owner at the next hour.
  await h.answer(42, 'MOZE', 'Петок во 16:00');
  assert.match(h.asks.at(-1) ?? '', /17:00/u, `owner 2 is asked 17:00: ${h.asks.at(-1)}`);
  // Both agreed → the client gets the whole route in one ask.
  const asked = await h.answer(59, 'MOZE', 'Петок во 17:00');
  const session = h.sessions.get(h.chatId)!;
  assert.equal(session.state, 'time_confirm', `the client closes the route: ${session.state}`);
  assert.match(asked, /16:00/u, asked);
  assert.match(asked, /17:00/u, asked);
  assert.match(asked, /42/u, asked);
  assert.match(asked, /59/u, asked);
  assert.match(asked, /Дали да ги потврдам посетите/u, asked);
  // The fee is PER PROPERTY (500 ден each → 1.000).
  assert.match(asked, /1\.000|1000/u, asked);
  // Nothing is booked before the client answers.
  assert.equal(h.appointments.count(), 0, 'no visit is arranged on the owner’s yes alone');
});

test('[chain] the client’s yes books every stop and sends the route', async () => {
  const h = makeHandler();
  h.seed();
  await h.say('ПЕТОК ВО 16:00, САКАМ ДА ГИ ВИДАМ ДВАТА');
  await h.answer(42, 'MOZE', 'Петок во 16:00');
  await h.answer(59, 'MOZE', 'Петок во 17:00');
  await h.say('ДА, ГИ ПОТВРДУВАМ');
  const rows = h.appointments.listByChat(h.chatId);
  assert.equal(rows.length, 2, `two visits are booked: ${JSON.stringify(rows)}`);
  const ebs = rows.map(r => r.propertyId).sort((a, b) => a - b);
  assert.deepEqual(ebs, [42, 59]);
  // The planned-visit line reaches the client with the agent's phone.
  assert.ok(h.sent.some(t => /PLANIRANA POSETA NA NEDVIZNOST/u.test(t)),
    `the plan line is sent: ${JSON.stringify(h.sent)}`);
});

test('[chain] an owner who cannot do the day is dropped and named', async () => {
  const h = makeHandler();
  h.seed();
  await h.say('ПЕТОК ВО 16:00, САКАМ ДА ГИ ВИДАМ ДВАТА');
  await h.answer(42, 'MOZE', 'Петок во 16:00');
  // Owner 59 has no chance that day → he leaves the route, the client is told.
  const answer = await h.answer(59, 'НЕМА ШАНСИ ВО ПЕТОК', 'Петок во 17:00');
  assert.match(answer, /16:00/u, `the remaining stop is offered: ${answer}`);
  assert.match(answer, /59/u, `the dropped flat is named: ${answer}`);
  assert.match(answer, /друг термин/u, answer);
});

test('[chain] a batch on screen is NOT a route: a picked flat keeps its own visit', async () => {
  // THE [22:03]/[21:03] КАТОЛИЧКА CAPTURE: several flats were presented during
  // the conversation, the client chose ONE («PRVIOT») and gave a term. The
  // route must not be inferred from the presented batch — his single visit
  // would be replaced by owner pings for flats he never chose, and the owner
  // verdict would then be swallowed by the chain (the visit never confirmed).
  const h = makeHandler();
  const s = h.seed();
  s.slots.currentBatch = [42, 59];
  s.slots.presentedIds = [42, 59];
  s.slots.interestedPropertyId = 59; // the flat he actually picked
  h.sessions.set(s);
  await h.say('ПЕТОК ВО 16:00');
  const session = h.sessions.get(h.chatId)!;
  assert.equal(session.slots.visitPlan, undefined, 'no route from the batch alone');
  assert.equal(session.state, 'owner_checking');
  assert.equal(session.slots.interestedPropertyId, 59, 'the picked flat stays the subject');
  assert.match(h.asks.at(-1) ?? '', /16:00/u, `the picked flat’s owner is asked: ${h.asks.at(-1)}`);
  // The owner copy says «со број 59» (buildOwnerAsk), not «номер».
  assert.match(h.asks.at(-1) ?? '', /број 59/u, `the ask is about EB 59: ${h.asks.at(-1)}`);
});

test('[chain] the plural request starts the route even after a pick', async () => {
  const h = makeHandler();
  const s = h.seed();
  s.slots.interestedPropertyId = 42;
  h.sessions.set(s);
  await h.say('ПЕТОК ВО 16:00, САКАМ ДА ГИ ВИДАМ ДВАТА');
  assert.ok(h.sessions.get(h.chatId)!.slots.visitPlan, 'the client’s own plural starts the route');
});

test('[chain] a new term mid-route restarts the asks on the new day', async () => {
  // The client moves the day while the first owner is being asked. The answers
  // on file were about the OLD day/hour, so they are void: every stop returns
  // to pending and the first owner is asked about the new term (the brief: a
  // different day is a new chain). Before this the reply was the ACK and NOBODY
  // was asked — «ќе Ве известам штом потврдам» with no check behind it.
  const h = makeHandler();
  h.seed();
  await h.say('ПЕТОК ВО 16:00, САКАМ ДА ГИ ВИДАМ ДВАТА');
  assert.equal(h.asks.length, 1, `one ask so far: ${JSON.stringify(h.asks)}`);

  const before = h.asks.length;
  await h.say('ПОНЕДЕЛНИК ВО 12:00, САКАМ ДА ГИ ВИДАМ ДВАТА');
  assert.ok(h.asks.length > before, 'the owner is asked about the NEW term');
  assert.match(h.asks.at(-1) ?? '', /12:00/u, `the new hour reaches the owner: ${h.asks.at(-1)}`);
  const plan = h.sessions.get(h.chatId)!.slots.visitPlan!;
  assert.equal(plan.targetHour, 12, 'the route starts at the new hour');
  const day = new Date(plan.dayMs);
  assert.equal(day.getDay(), 1, `the route moved to Monday: ${day.toString()}`);
  // The restart is an ask, not a fresh chain: the stop keeps its ask history so
  // the three-ask budget still bounds it.
  const stop = plan.stops.find(s => s.eb === 42)!;
  assert.equal(stop.asks, 2, `the first owner was asked twice: ${JSON.stringify(stop)}`);
  assert.equal(stop.askedHour, 12);
});

test('[chain] an owner’s counter that moves the start hour is re-solved and disclosed', async () => {
  // The client is open to any hour («БИЛО КОГА»). Owner 42 cannot do 16:00 and
  // offers 18:00; owner 59 is free at 17:00. The route therefore STARTS at 17:00
  // — the brief's own rule: the counters re-solve the chain, the client is told
  // the start moved, and nothing is booked before his yes.
  const h = makeHandler();
  h.seed();
  await h.say('ПЕТОК ВО 16:00, БИЛО КОГА, САКАМ ДА ГИ ВИДАМ ДВАТА');
  await h.answer(42, 'MOZE VO 18:00', 'Петок во 16:00');
  const asked = await h.answer(59, 'MOZE', 'Петок во 17:00');
  assert.match(asked, /17:00/u, `the route starts at the counter hour: ${asked}`);
  assert.match(asked, /18:00/u, `the counter stop is placed at its own hour: ${asked}`);
  assert.match(asked, /подоцна за 1 час/u, `the moved start is disclosed: ${asked}`);
  assert.match(asked, /Дали да ги потврдам посетите/u, asked);
  assert.equal(h.appointments.count(), 0, 'a counter books nothing');
});

test('[chain] no linkable hours that day: an honest ask, never a fabricated route', async () => {
  // 42 can only do 18:00 and 59 only 17:00, the client is NOT flexible and
  // asked for 16:00 — no contiguous route exists. The old fallback placed each
  // stop at the hour it had been ASKED about (16:00/17:00), i.e. put a flat on
  // the table at a time its owner had just ruled out. The honest turn names the
  // day and asks for another — and the client's plural wish survives it.
  const h = makeHandler();
  h.seed();
  await h.say('ПЕТОК ВО 16:00, САКАМ ДА ГИ ВИДАМ ДВАТА');
  await h.answer(42, 'SAMO VO 18:00', 'Петок во 16:00');
  const answer = await h.answer(59, 'MOZE', 'Петок во 17:00');
  assert.match(answer, /не можат да ги поврзам/u, `the honest no-link turn: ${answer}`);
  assert.doesNotMatch(answer, /16:00|17:00/u, `no invented route: ${answer}`);
  const s = h.sessions.get(h.chatId)!;
  assert.equal(s.slots.visitPlan, undefined, 'the impossible plan is cleared');
  assert.equal(s.state, 'visit_scheduling');
  assert.equal(h.appointments.count(), 0, 'nothing is booked');

  // His plural wish is remembered: the next term starts the route again even
  // without repeating «двата».
  await h.say('ПОНЕДЕЛНИК ВО 12:00');
  assert.ok(h.sessions.get(h.chatId)!.slots.visitPlan, 'the route restarts for the next term');
});

test('[chain] a single flat keeps the ordinary single-visit flow', async () => {
  const h = makeHandler();
  const s = h.seed();
  s.slots.currentBatch = [42];
  s.slots.presentedIds = [42];
  h.sessions.set(s);
  await h.say('ПЕТОК ВО 16:00, САКАМ ДА ГИ ВИДАМ ДВАТА');
  assert.equal(h.sessions.get(h.chatId)!.slots.visitPlan, undefined, 'no chain for one flat');
  assert.equal(h.sessions.get(h.chatId)!.state, 'owner_checking');
  assert.match(h.asks.at(-1) ?? '', /16:00/u);
});
