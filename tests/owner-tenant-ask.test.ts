// THE OWNER ASKS WHO WILL RENT IT — the client is asked, the answer is relayed
// (#4 field request, 2026-11-12).
//
//   СОПСТВЕНИК: «КОЈ САКА ДА ЈА ИЗНАЈМИ?»
//
// The owner is vetting the client before he gives a viewing. The question used
// to fall through the answer seam: he was sent the availability/term question
// straight back (a robot that did not listen), the client was never asked, and
// nobody ever gave the owner a name. The operator's rule:
//
//   ask the client «За кого би била изнајмена недвижноста?»
//   and relay HIS answer to the owner.
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
import { detectOwnerTenantAsk } from '../src/llm/deterministic';

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
    channels,
  });
  const toOwner: string[] = [];
  // The flat travels as the hook's own EB argument (production dials the owner
  // by it), so the harness keeps both halves of the relay.
  handler.onOwnerMessage = (_c, eb, text) => toOwner.push(`${eb}: ${text}`);
  const chatId = 'tenant-ask';
  const say = async (m: string): Promise<string> => {
    await handler.handle('test', chatId, m);
    return sent.at(-1) ?? '';
  };
  // The chat is mid-visit: the owner is being asked for a term.
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
  return { handler, sessions, sent, toOwner, chatId, say, seed, propose };
}

// ── 1. THE DETECTOR ─────────────────────────────────────────────────────────

test('detectOwnerTenantAsk: who + rent/occupy, both scripts and spellings', () => {
  for (const text of [
    'КОЈ САКА ДА ЈА ИЗНАЈМИ?',
    'КОЈ САКА ДА ЈА ИЗНАЈМИ',
    'koj saka da ja iznajmi ?',
    'КОЈ ЌЕ ЈА ИЗНАЈМИ',
    'koj ke ja iznajmi',
    'КОЈ ЌЕ ЖИВЕЕ ВО СТАНОТ?',
    'koi ke zivee vo stanot',
    'ЗА КОГО БИ БИЛА ИЗНАЈМЕНА?',
    'za kogo bi bila iznajmena',
  ]) {
    assert.equal(detectOwnerTenantAsk(text), true, `«${text}» is the owner vetting the tenant`);
  }
});

test('detectOwnerTenantAsk: tenant nouns in an ask shape, but never a plain statement', () => {
  assert.equal(detectOwnerTenantAsk('КОЈ Е ЗАКУПНИКОТ?'), true);
  assert.equal(detectOwnerTenantAsk('koj e zakupnikot ?'), true);
  assert.equal(detectOwnerTenantAsk('Дали станарот е вработен?'), true);
  // A statement about the tenant is not the question — it keeps its lane.
  assert.equal(detectOwnerTenantAsk('закупникот плаќа струја'), false);
  assert.equal(detectOwnerTenantAsk('ДА, МОЖЕ ВО ПЕТОК'), false);
  assert.equal(detectOwnerTenantAsk('НЕ МОЖАМ ВО ВТОРНИК'), false);
});

// ── 2. THE OWNER'S QUESTION ─────────────────────────────────────────────────

test('owner asks «КОЈ САКА ДА ЈА ИЗНАЈМИ?» → the owner is answered and the CLIENT is asked', async () => {
  const h = makeHandler();
  h.seed();
  await h.propose('УТРЕ ВО 17:00');

  const res = await h.handler.ownerMessage(h.chatId, 'КОЈ САКА ДА ЈА ИЗНАЈМИ?');
  assert.equal(res.effect, 'answered', `the owner must be ANSWERED, not re-asked: ${JSON.stringify(res)}`);
  assert.ok(res.replyText && !/Дали е слободен тој термин/u.test(res.replyText),
    `the term question must not be thrown back at him: ${res.replyText}`);
  assert.ok(/изнајмена|изнајмување|закупник|клиентот/iu.test(res.replyText ?? ''),
    `the ack must say what will happen: ${res.replyText}`);

  // …and the client is asked the operator's own question.
  await new Promise(r => setTimeout(r, 100));
  assert.ok(h.sent.some(m => m.includes('За кого би била изнајмена недвижноста?')),
    `the client must be asked who the flat is for: ${h.sent.join(' | ')}`);
  assert.equal(h.sessions.get(h.chatId)!.slots.ownerTenantAsk, true, 'the chat waits on that answer');
  // The visit funnel itself is untouched: no verdict was applied.
  assert.equal(h.sessions.get(h.chatId)!.state, 'owner_checking');
});

// ── 3. THE CLIENT'S ANSWER IS RELAYED ───────────────────────────────────────

test('the client’s answer reaches the owner, and the chat carries on', async () => {
  const h = makeHandler();
  h.seed();
  await h.propose('УТРЕ ВО 17:00');
  await h.handler.ownerMessage(h.chatId, 'КОЈ САКА ДА ЈА ИЗНАЈМИ?');
  await new Promise(r => setTimeout(r, 100));
  h.sent.length = 0;

  const ack = await h.say('ЗА МЕНЕ И МОЈАТА СОПРУГА, САМОСТОЈНО ЖИВЕЕМЕ');
  assert.equal(h.toOwner.length, 1, `the owner must hear the answer: ${JSON.stringify(h.toOwner)}`);
  assert.ok(h.toOwner[0].includes('ЗА МЕНЕ И МОЈАТА СОПРУГА'),
    `the relay carries the client's own words: ${h.toOwner[0]}`);
  assert.ok(h.toOwner[0].includes('77'), `…and which flat it is about: ${h.toOwner[0]}`);
  assert.ok(/благодарам|пренесам/iu.test(ack), `the client is thanked: ${ack}`);
  // Consumed once: the flag is cleared and the answer never repeats.
  assert.equal(h.sessions.get(h.chatId)!.slots.ownerTenantAsk, undefined);
  await h.say('А КОГА ЌЕ ДОЈДЕ СОПСТВЕНИКОТ?');
  assert.equal(h.toOwner.length, 1, 'a later turn must not re-send the tenant answer');
});

test('a question of the client’s own is not an answer — the flag stays armed', async () => {
  const h = makeHandler();
  h.seed();
  await h.propose('УТРЕ ВО 17:00');
  await h.handler.ownerMessage(h.chatId, 'КОЈ САКА ДА ЈА ИЗНАЈМИ?');
  await new Promise(r => setTimeout(r, 100));
  h.sent.length = 0;

  await h.say('А КОЈ Е СОПСТВЕНИКОТ?');
  assert.equal(h.toOwner.length, 0, `his own question must not be forwarded as an answer: ${JSON.stringify(h.toOwner)}`);
  assert.equal(h.sessions.get(h.chatId)!.slots.ownerTenantAsk, true, 'the chat still waits on the real answer');

  // …and the real answer does land.
  await h.say('ЗА МЕНЕ');
  assert.equal(h.toOwner.length, 1);
  assert.ok(h.toOwner[0].includes('ЗА МЕНЕ'));
});
