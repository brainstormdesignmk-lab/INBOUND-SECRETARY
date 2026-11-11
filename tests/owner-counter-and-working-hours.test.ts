// THE [10:05]–[10:33] CAPTURE — THE PING-PONG OWNS THE TERM, AND THE WORKING
// WEEK OWNS THE DAYS.
//
//   [10:05] ПЕТОК ВО 10                       (client)
//   [10:05] Во ред, ќе Ве известам штом потврдам.
//   [10:06] МОЖЕ НАКАЈ 6 АКО ВИ ОДГОВАРА       (owner — a COUNTER at ~18:00)
//   [10:06] — одговор примен: ok (ПЕТОК ВО 10)   ← the bug: read as consent
//   [10:06] Договорена посета … 10:00            ← the visit locked at the
//                                                 client's time, the owner's
//                                                 term thrown away
//   [10:32] НЕМА ШАНСИ ВО ПЕТОК                 → relayed as «Има друг предлог:
//                                                 Петок» (the refused day back)
//   [10:33] ВО САБОТА РАБОТИТЕ ?                (the owner weighing a weekend)
//                                                 → answered with the ask again
//
// The contracts pinned here:
//   • an owner message that names a DIFFERENT clock is a counter, even when it
//     opens with «може» — and «накај 6» is a clock;
//   • the counter is RELAYED and the client must accept it; the visit is never
//     finalised on the owner's counter or on the client's own proposal;
//   • a client counter after the relay re-asks the owner (ping-pong until both
//     sides agree), and the acceptance books the OWNER'S term;
//   • «НЕМА ШАНСИ ВО ПЕТОК» is a refusal, never a proposal of Friday;
//   • Saturday/Sunday terms — from the client or the owner — are answered with
//     the agency's working-hours protocol (Mon–Fri 09:00–17:00, weekends closed)
//     and a working-day term is requested; nothing is relayed or locked.

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
import { isWeekendTerm } from '../src/visits/time';

const cfg = loadConfig();

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

const ROWS: Property[] = [{
  eb: 38, id: 38, location: 'Кисела Вода', address: 'Рампа', price: 101750,
  bedrooms: 3, sqm: 57, size: '57 м²', service: 'buy',
  lat: 41.98865, lon: 21.43722, geo_source: 'stored', details: '',
} as Property];

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
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
  });
  const asks: string[] = [];
  handler.onOwnerAsk = (_c, _eb, q) => asks.push(q);
  const chatId = 'pingpong';
  const say = async (m: string): Promise<string> => {
    await handler.handle('test', chatId, m);
    return sent.at(-1) ?? '';
  };
  /** A chat parked just before the owner check: flat picked, fee agreed. */
  const seed = () => {
    const s = freshSession('test', chatId);
    s.state = 'visit_scheduling';
    s.slots.propertyId = 38;
    s.slots.interestedPropertyId = 38;
    s.slots.presentedIds = [38];
    s.slots.currentBatch = [38];
    s.slots.service = 'buy';
    s.slots.viewingFeeAgreed = true;
    s.slots.feeDisclosed = true;
    s.slots.name = 'Дејан Узунов';
    s.slots.phone = '076845234';
    sessions.set(s);
    return s;
  };
  /** The client proposes a term THROUGH THE PIPELINE, so the owner check is
   *  armed exactly as in production (a hand-seeded slot has no pending check
   *  and `ownerAnswer` would be dropped). */
  const propose = async (term: string) => {
    await say(term);
    assert.equal(sessions.get(chatId)!.state, 'owner_checking', `setup: the owner must be checking (${term})`);
    sent.length = 0;
  };
  const apply = async (v: ReturnType<typeof detectOwnerVerdict>) => {
    sent.length = 0;
    handler.ownerAnswer(chatId, 38, v!);
    await new Promise(r => setTimeout(r, 120));
    return sent.at(-1) ?? '';
  };
  return { handler, sessions, sent, asks, chatId, say, seed, propose, apply };
}

const HOURS = /понеделник до петок/iu;
const CLOSED = /сабота и недела не работиме|сабота и недела/iu;
const FINALISED = /Договорена посета/u;

test('[10:06] «МОЖЕ НАКАЈ 6» is a counter at 18:00, never consent to 10:00', () => {
  const v = detectOwnerVerdict('МОЖЕ НАКАЈ 6 АКО ВИ ОДГОВАРА', 'ПЕТОК ВО 10');
  assert.ok(v, 'the owner text must parse');
  assert.equal(v.status, 'counter', `never 'ok': ${JSON.stringify(v)}`);
  // «накај 6» is shaped through the visit window: 6 → 18:00, never 06:00.
  assert.match(v.ownerTime ?? '', /18:00/u, `the owner's clock must survive: ${JSON.stringify(v)}`);
  // The Latin sibling and the same-day guard (a clock equal to the proposal
  // stays consent).
  assert.equal(detectOwnerVerdict('moe nakaj 6 ako vi odgovara', 'ПЕТОК ВО 10')?.status, 'counter');
  assert.equal(detectOwnerVerdict('MOZE NAKAJ 10', 'ПЕТОК ВО 10')?.status, 'ok');
});

test('[10:32] «НЕМА ШАНСИ ВО ПЕТОК» refuses the day — it never proposes it back', () => {
  const v = detectOwnerVerdict('НЕМА ШАНСИ ВО ПЕТОК', 'ПЕТОК ВО 10');
  assert.ok(v, 'a no-chance phrase is a refusal, not silence');
  assert.equal(v.status, 'counter');
  assert.equal(v.ownerTime, undefined, `no term of his own: ${JSON.stringify(v)}`);
  assert.equal(v.canAcceptWholeDay, undefined, `Friday is not offered back: ${JSON.stringify(v)}`);
  // A refusal of the clock with an any-time idiom on the SAME day IS an offer.
  const same = detectOwnerVerdict('NE MOZAM TOGAS . PETOK BILO KOE VREME MI ODGOVARA', 'ПЕТОК ВО 10')!;
  assert.equal(same.canAcceptWholeDay, true, `the whole day stands: ${JSON.stringify(same)}`);
});

test('[10:06] e2e: the counter is relayed, time_confirm opens, nothing is booked', async () => {
  const { sessions, chatId, seed, propose, apply } = makeHandler();
  seed();
  await propose('ПЕТОК ВО 10');
  const reply = await apply(detectOwnerVerdict('МОЖЕ НАКАЈ 6 АКО ВИ ОДГОВАРА', 'ПЕТОК ВО 10'));
  const s = sessions.get(chatId)!;
  assert.equal(s.state, 'time_confirm', `the client must close the term: ${s.state}`);
  assert.match(reply, /18:00/u, `the owner's term reaches the client: ${reply}`);
  assert.match(reply, /\?/u, `and asks for his confirmation: ${reply}`);
  assert.doesNotMatch(reply, FINALISED, `nothing is arranged yet: ${reply}`);
  assert.equal(s.slots.visitTime, 'ПЕТОК ВО 10', 'the client proposal is kept until he answers');
});

test('[10:06] e2e: the client accepts the OWNER’s term — 18:00 is booked, not 10:00', async () => {
  const { sessions, chatId, seed, propose, apply, say } = makeHandler();
  seed();
  await propose('ПЕТОК ВО 10');
  await apply(detectOwnerVerdict('МОЖЕ НАКАЈ 6 АКО ВИ ОДГОВАРА', 'ПЕТОК ВО 10'));
  const booked = await say('ДА, МИ ОДГОВАРА');
  assert.match(booked, FINALISED, `the visit is arranged on his yes: ${booked}`);
  assert.match(booked, /18:00/u, `at the owner's hour: ${booked}`);
  assert.doesNotMatch(booked, /во 10:00/u, `never the refused hour: ${booked}`);
  assert.equal(sessions.get(chatId)!.state, 'pending');
});

test('[10:33] e2e: the ping-pong continues — a client counter re-asks the owner', async () => {
  const { sessions, asks, chatId, seed, propose, say } = makeHandler();
  seed();
  await propose('ПЕТОК ВО 18:00');
  const s0 = sessions.get(chatId)!;
  s0.state = 'time_confirm'; // the client is holding the owner's term
  sessions.set(s0);
  const hold = await say('НЕ МИ ОДГОВАРА, САБОТА ВО 12');
  const s = sessions.get(chatId)!;
  // A SATURDAY counter is answered with the working-hours protocol, never sent
  // to the owner for a check that cannot succeed…
  assert.match(hold, HOURS, hold);
  assert.match(hold, CLOSED, hold);
  assert.ok(!asks.some(a => /Сабота/u.test(a)), `no weekend owner ask: ${JSON.stringify(asks)}`);
  assert.notEqual(s.state, 'owner_checking', `the check must not open on a weekend: ${s.state}`);
  // …while a working-day counter reaches the owner and keeps the loop alive.
  const hold2 = await say('ВТОРНИК ВО 17');
  assert.equal(sessions.get(chatId)!.state, 'owner_checking', `the owner is asked again: ${hold2}`);
  assert.ok(asks.some(a => /Вторник/u.test(a)), `the new term reaches the owner: ${JSON.stringify(asks)}`);
  assert.doesNotMatch(hold2, FINALISED, hold2);
});

test('[10:33] e2e: the owner’s weekend counter is answered with the protocol on HIS side', async () => {
  const { handler, sessions, sent, asks, chatId, seed, propose } = makeHandler();
  seed();
  await propose('ПЕТОК ВО 10');
  const v = detectOwnerVerdict('ВО САБОТА ВО 12 МОЖЕ', 'ПЕТОК ВО 10');
  assert.equal(v?.status, 'counter', JSON.stringify(v));
  sent.length = 0;
  asks.length = 0;
  assert.equal(handler.ownerAnswer(chatId, 38, v!), true, 'the verdict is applied');
  await new Promise(r => setTimeout(r, 120));
  const s = sessions.get(chatId)!;
  assert.equal(s.state, 'owner_checking', `the check stays open for a working-day term: ${s.state}`);
  assert.deepEqual(sent, [], `nothing reaches the client on a weekend counter: ${JSON.stringify(sent)}`);
  const weekendAsk = asks.at(-1) ?? '';
  assert.match(weekendAsk, HOURS, `the owner is told the hours: ${weekendAsk}`);
  assert.match(weekendAsk, /работен ден/u, `and asked for a working day: ${weekendAsk}`);
});

test('[10:33] the owner’s «ВО САБОТА РАБОТИТЕ ?» is answered with the hours, not the ask again', async () => {
  const { handler, chatId, seed, propose } = makeHandler();
  seed();
  await propose('ПЕТОК ВО 10');
  const answer = handler.ownerQuestionReply(chatId, 'ВО САБОТА РАБОТИТЕ ?') ?? '';
  assert.match(answer, HOURS, `the protocol is stated: ${answer}`);
  assert.match(answer, CLOSED, answer);
  // …and the ask still follows, so his answer lands on the funnel.
  assert.match(answer, /Дали е слободен тој термин/u, answer);
});

test('the operator pane is told a relay ONLY when the client really received one', async () => {
  const { handler, sent, chatId, seed, propose, apply } = makeHandler();
  const relays: string[] = [];
  handler.onOwnerRelay = (_c, text) => relays.push(text);
  seed();
  await propose('ПЕТОК ВО 10');
  // A WEEKEND counter re-asks the OWNER: nothing went to the client, so no
  // relay may be mirrored («пренесено на клиентот: во сабота не работиме» was
  // the [10:33] lie the owner saw in the pane).
  await apply(detectOwnerVerdict('ВО САБОТА ВО 12 МОЖЕ', 'ПЕТОК ВО 10'));
  assert.deepEqual(sent, [], `the client heard nothing: ${JSON.stringify(sent)}`);
  assert.deepEqual(relays, [], `no relay may be mirrored: ${JSON.stringify(relays)}`);
  // A real counter is both sent and mirrored — with the exact sentence served.
  const reply = await apply(detectOwnerVerdict('МОЖЕ НАКАЈ 6 АКО ВИ ОДГОВАРА', 'ПЕТОК ВО 10'));
  assert.equal(relays.at(-1), reply, `the mirror is the served text: ${JSON.stringify(relays)}`);
  assert.match(reply, /18:00/u, reply);
});

test('isWeekendTerm: word days and explicit dates, weekdays untouched', () => {
  for (const p of ['САБОТА ВО 12', 'САБОТА', 'субота попладне', 'НЕДЕЛА ВО 11', '14.11.2026', '14.11 во 12']) {
    assert.equal(isWeekendTerm(p), true, `${p} is a weekend day`);
  }
  for (const p of ['ПЕТОК ВО 10', 'СРЕДА ВО 11', '04.11.2026', 'утре', '',
    // an ambiguous dotted pair is a CLOCK, never a date (14.30 · 11.30)
    'во 14.30', 'СРЕДА ВО 14.30', '18.11.2026']) {
    assert.equal(isWeekendTerm(p), false, `${p} is not a weekend day`);
  }
});
