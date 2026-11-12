// THE OWNER'S EXTRA CONDITIONS REACH THE CLIENT (the operator's 2026-11-12
// request).
//
//   СОПСТВЕНИК: «ДА, МОЖЕ, АМА БАРА ДЕПОЗИТ ОД ЕДНА КИРИЈА И ПРВА КИРИЈА»
//
// Everything except the term already reached the client — availability, a moved
// price, a counter. The conditions he attaches to his yes died in the parser:
// the client was booked under terms he had never heard, and the only record was
// the owner's raw message. They are now relayed in the owner's own words BEFORE
// the visit is locked, and the booking stays the client's decision.
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
import { PriceChangeStore } from '../src/store/priceChanges';
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LlmClient } from '../src/llm/types';
import { detectOwnerVerdict, detectOwnerConditions } from '../src/llm/deterministic';

const cfg = loadConfig();

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

const RENT: Property = {
  eb: 77, id: 77, location: 'Карпош', address: 'Партизанска 5', price: 450,
  cleanPrice: 450, bedrooms: 1, sqm: 35, size: '35 м²', service: 'rent',
  lat: 42.0021, lon: 21.4061, geo_source: 'stored', details: '',
} as Property;

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
  const properties = new FakeProps([RENT]);
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, properties),
    responder: new Responder(new FailingLlm(), cfg),
    properties,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    priceChanges: new PriceChangeStore(db),
    channels,
  });
  const chatId = 'conditions';
  const say = async (m: string): Promise<string> => {
    await handler.handle('test', chatId, m);
    return sent.at(-1) ?? '';
  };
  const seed = () => {
    const s = freshSession('test', chatId);
    s.state = 'visit_scheduling';
    s.slots.propertyId = 77;
    s.slots.interestedPropertyId = 77;
    s.slots.presentedIds = [77];
    s.slots.currentBatch = [77];
    s.slots.service = 'rent';
    s.slots.viewingFeeAgreed = true;
    s.slots.feeDisclosed = true;
    s.slots.name = 'Дејан Узунов';
    s.slots.phone = '076845234';
    sessions.set(s);
    return s;
  };
  const propose = async (term: string) => {
    await say(term);
    assert.equal(sessions.get(chatId)!.state, 'owner_checking', `setup: the owner must be checking (${term})`);
    sent.length = 0;
  };
  const apply = async (v: ReturnType<typeof detectOwnerVerdict>) => {
    sent.length = 0;
    handler.ownerAnswer(chatId, 77, v!);
    await new Promise(r => setTimeout(r, 150));
    return sent.at(-1) ?? '';
  };
  return { handler, sessions, sent, chatId, say, seed, propose, apply };
}

// ── 1. THE PARSER ───────────────────────────────────────────────────────────

test('detectOwnerConditions: the deposit / first-rent clauses, in his own words', () => {
  assert.deepEqual(detectOwnerConditions('ДА, МОЖЕ, АМА БАРА ДЕПОЗИТ ОД ЕДНА КИРИЈА'),
    ['ама бара депозит од една кирија']);
  assert.deepEqual(detectOwnerConditions('moze, ama bara depozit i prva kirija'),
    ['ama bara depozit i prva kirija']);
  assert.deepEqual(detectOwnerConditions('ДА. БАРА КАПАРО ОД 300 ЕВРА. ПРВА КИРИЈА ВЕДНАШ.'),
    ['бара капаро од 300 евра', 'прва кирија веднаш']);
  // Ordinary chatter about the flat carries no condition noun.
  assert.deepEqual(detectOwnerConditions('ДА, МОЖЕ ВО ПЕТОК, СТАНОТ Е СЛОБОДЕН'), []);
  assert.deepEqual(detectOwnerConditions('НЕ МОЖАМ ВО ВТОРНИК'), []);
});

test('detectOwnerVerdict: the conditions ride an ok AND a counter', () => {
  const term = 'Утре попладне';
  const ok = detectOwnerVerdict('ДА, МОЖЕ, АМА БАРА ДЕПОЗИТ ОД ЕДНА КИРИЈА', term)!;
  assert.equal(ok.status, 'ok');
  assert.deepEqual(ok.conditions, ['ама бара депозит од една кирија']);
  // A counter keeps them too — the client must hear them with the new term.
  const counter = detectOwnerVerdict('NE MOZAM VO VTORNIK, AMA SAKAM DEPOZIT PRVATA KIRIJA', term)!;
  assert.equal(counter.status, 'counter');
  assert.ok(counter.conditions?.length, `the counter carries the conditions: ${JSON.stringify(counter)}`);
  // …and a plain verdict stays clean (no empty array, no key at all).
  const plain = detectOwnerVerdict('DA, MOZE', term)!;
  assert.equal(plain.conditions, undefined);
});

test('detectOwnerVerdict: a figure inside a CONDITION is never the property price', () => {
  // Caught while building this relay: «БАРА КАПАРО ОД 300 ЕВРА» made the parser
  // read 300 as a new asking price and put a «цената е променета» notice on the
  // owner's own deposit. The condition clauses are cut out of the price text.
  const v = detectOwnerVerdict('ДА. БАРА КАПАРО ОД 300 ЕВРА. ПРВА КИРИЈА ВЕДНАШ.', 'Утре попладне')!;
  assert.equal(v.price, undefined, `the deposit amount is not a price: ${JSON.stringify(v)}`);
  assert.deepEqual(v.conditions, ['бара капаро од 300 евра', 'прва кирија веднаш']);
  // …and a real price stated ALONGSIDE a condition is still read.
  const both = detectOwnerVerdict('ДА, МОЖЕ. ЦЕНАТА Е 500 ЕВРА, АМА БАРА ДЕПОЗИТ ОД ЕДНА КИРИЈА.', 'Утре попладне')!;
  assert.equal(both.price, 500, `the flat's own figure still lands: ${JSON.stringify(both)}`);
  assert.deepEqual(both.conditions, ['ама бара депозит од една кирија']);
});

// ── 2. THE RELAY ────────────────────────────────────────────────────────────

test('e2e: the conditions reach the client BEFORE the booking, which stays HIS call', async () => {
  const h = makeHandler();
  h.seed();
  await h.propose('УТРЕ ВО 17:00');

  const reply = await h.apply(detectOwnerVerdict('ДА, МОЖЕ, АМА БАРА ДЕПОЗИТ ОД ЕДНА КИРИЈА', 'УТРЕ ВО 17:00'));
  assert.match(reply, /депозит/iu, `the client must hear the condition: ${reply}`);
  assert.match(reply, /Евидентен број 77/u, `…about the right flat: ${reply}`);
  assert.doesNotMatch(reply, /Договорена посета/u, `nothing is booked behind his back: ${reply}`);
  assert.equal(h.sessions.get(h.chatId)!.slots.ownerConditionsPending, true, 'the gate is armed');
  assert.equal(h.sessions.get(h.chatId)!.state, 'time_confirm', 'the chat asks him');

  // His own yes books it — and the booking line still carries the conditions.
  const booked = await h.say('ДА');
  assert.match(booked, /Договорена посета/u, `his yes books the visit: ${booked}`);
  assert.match(booked, /депозит/iu, `the conditions stay in the record: ${booked}`);
  assert.equal(h.sessions.get(h.chatId)!.slots.ownerConditionsPending, undefined, 'the gate is cleared');
});

test('e2e: a verdict WITHOUT conditions still books in one turn (unchanged)', async () => {
  const h = makeHandler();
  h.seed();
  await h.propose('УТРЕ ВО 17:00');
  const reply = await h.apply(detectOwnerVerdict('ДА, МОЖЕ', 'УТРЕ ВО 17:00'));
  assert.match(reply, /Договорена посета/u, `the plain yes books straight away: ${reply}`);
  assert.doesNotMatch(reply, /Услови од сопственикот/u, 'no invented conditions');
});
