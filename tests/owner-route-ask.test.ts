// THE OWNER'S COPY ON A ROUTE (the 2026-11-19 brief: one client, several
// viewings, owners asked in parallel, hours chain-linked).
//
// The single-visit intro is right for a lone visit and wrong for a stop: the
// owner is asked for a specific hour that was chosen to link him with the next
// flat, and nothing in «Клиентот сака посета: 17:00» says so — his counter then
// looks arbitrary and the negotiation costs a question. The route ask carries
// that ONE fact (the client sees several properties that day, one after
// another) beside the same three anchors: is it still available, the term, and
// agree-or-counter. It never names another property, never promises one and
// never mentions money.
//
// The second question to the same owner stays the one-fact follow-up: whatever
// brought it about, a follow-up is «клиентот не е во можност … предлага …».
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
import { RESPONSE_BANK, RESPONSE_GENERATION_CONTEXT } from '../src/data/responses';

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

/** The sentence that makes the hour make sense — pinned as a CONTRACT (the
 *  bank rotates its wording, the meaning does not). */
const ROUTE_REASON = /повеќе недвижности по ред|повеќе посети по ред|една по друга|еден по друг/iu;
// The owner's OWN advertised figure may ride his first ask (the clean-price
// confirmation, owner-facing only) — what never rides it is the AGENCY FEE.
const FEE_RE = /надомест|денар/iu;

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
  const asks: Array<{ eb: number; text: string }> = [];
  handler.onOwnerAsk = (_c, eb, q) => asks.push({ eb, text: q });
  const chatId = 'route-owner-copy';
  const say = async (m: string): Promise<void> => { await handler.handle('test', chatId, m); };
  const seed = (ebs: number[]) => {
    const s = freshSession('test', chatId);
    s.state = 'visit_scheduling';
    s.slots.service = 'buy';
    s.slots.currentBatch = ebs;
    s.slots.presentedIds = ebs;
    s.slots.viewingFeeAgreed = true;
    s.slots.feeDisclosed = true;
    sessions.set(s);
  };
  const answer = async (eb: number, text: string, term: string): Promise<void> => {
    handler.ownerAnswer(chatId, eb, detectOwnerVerdict(text, term));
    await new Promise(r => setTimeout(r, 200));
  };
  return { handler, sessions, asks, chatId, say, seed, answer };
}

test('[route ask] every stop’s owner hears why the hour is tight', async () => {
  const h = makeHandler();
  h.seed([82, 84]);
  await h.say('ПЕТОК ВО 17:00, САКАМ ДА ГИ ВИДАМ ДВАТА');

  assert.equal(h.asks.length, 2, `both owners asked in one round: ${JSON.stringify(h.asks)}`);
  for (const ask of h.asks) {
    assert.match(ask.text, ROUTE_REASON, `the route is stated to EB ${ask.eb}: ${ask.text}`);
    assert.match(ask.text, new RegExp(`број ${ask.eb}`, 'u'), `his own flat is named: ${ask.text}`);
    assert.match(ask.text, /\?$/u, `it still ends with a question: ${ask.text}`);
    assert.doesNotMatch(ask.text, FEE_RE, `no agency fee to an owner: ${ask.text}`);
    assert.doesNotMatch(ask.text, /\{eb\}|\{time\}/u, `placeholders are filled: ${ask.text}`);
  }
  // The two stops are asked different hours (the chain), and each ask carries
  // HIS hour — a shared hour would promise a double booking.
  assert.match(h.asks[0]!.text, /17:00/u, h.asks[0]!.text);
  assert.match(h.asks[1]!.text, /18:00/u, h.asks[1]!.text);
});

test('[route ask] a lone visit keeps the single-visit intro', async () => {
  const h = makeHandler();
  h.seed([82]);
  await h.say('ПЕТОК ВО 17:00, САКАМ ДА ГО ВИДАМ');
  assert.equal(h.asks.length, 1, JSON.stringify(h.asks));
  assert.doesNotMatch(h.asks[0]!.text, ROUTE_REASON,
    `a single visit must not claim a route: ${h.asks[0]!.text}`);
  assert.match(h.asks[0]!.text, /17:00/u);
  assert.match(h.asks[0]!.text, /\?$/u);
});

test('[route ask] a second question to the same owner is the one-fact follow-up', async () => {
  const h = makeHandler();
  h.seed([82, 84]);
  await h.say('ПЕТОК ВО 17:00, САКАМ ДА ГИ ВИДАМ ДВАТА');
  await h.answer(82, 'MOZE', 'Петок во 17:00');
  // 84 cannot do 18 and offers 16. 17 is already taken by the other stop, so
  // the hour that keeps the client's own 17:00 as the start is asked of him.
  await h.answer(84, 'MOZE VO 16:00', 'Петок во 18:00');
  const followup = h.asks.at(-1)!;
  assert.equal(followup.eb, 84, `the same owner is asked again: ${JSON.stringify(followup)}`);
  assert.match(followup.text, /19:00/u, `the connecting hour, not the taken one: ${followup.text}`);
  assert.doesNotMatch(followup.text, /во 17:00/u, `a taken hour is never proposed: ${followup.text}`);
  assert.doesNotMatch(followup.text, ROUTE_REASON,
    `the three-sentence intro is not repeated: ${followup.text}`);
  assert.match(followup.text, /Клиентот/u, `it is the owner follow-up: ${followup.text}`);
});

test('[route ask] the bank pool keeps the contract every variant must satisfy', () => {
  const variants = RESPONSE_BANK['owner.routeAsk'] ?? [];
  assert.ok(variants.length >= 8, `the route pool is seeded: ${variants.length}`);
  for (const v of variants) {
    assert.equal(v.match(/\{eb\}/gu)?.length, 1, `{eb} exactly once: ${v}`);
    assert.equal(v.match(/\{time\}/gu)?.length, 1, `{time} exactly once: ${v}`);
    assert.match(v, ROUTE_REASON, `the route is the pool's meaning: ${v}`);
    assert.match(v, /(?:достапна|слободна|термин)/iu, `availability/term is asked: ${v}`);
    assert.match(v, /\?$/u, `it ends with the question: ${v}`);
    assert.doesNotMatch(v, FEE_RE, `the agency fee stays out of owner copy: ${v}`);
  }
  const spec = RESPONSE_GENERATION_CONTEXT['owner.routeAsk'];
  assert.ok(spec, 'the pool has a generation spec (the loop can grow it)');
  assert.match(spec!.instruction, /\{eb\}/u);
  assert.match(spec!.instruction, /\{time\}/u);
});

test('[route re-arm] an availability-only answer is filed against HIS stop', async () => {
  const h = makeHandler();
  h.seed([82, 84]);
  await h.say('ПЕТОК ВО 17:00, САКАМ ДА ГИ ВИДАМ ДВАТА');
  // The SECOND stop's owner answers only the availability half («DOSTAPNA E DA»)
  // — the operator pane has his card open, so he is the chat's current property
  // while the client's term is still the START of the route (17:00).
  const s = h.sessions.get(h.chatId)!;
  assert.match(s.slots.visitTime ?? '', /17:00/u, `the client's start: ${s.slots.visitTime}`);
  s.slots.propertyId = 84;
  s.state = 'owner_checking';
  h.sessions.set(s);
  const ack = h.handler.ownerQuestionReply(h.chatId, 'DOSTAPNA E DA');
  assert.ok(ack, 'the owner must be answered');
  assert.match(ack!, /Евидентен број 84/u, `his flat is named: ${ack}`);
  assert.match(ack!, /18:00/u, `his stop's hour: ${ack}`);
  assert.doesNotMatch(ack!, /17:00/u, `never the other stop's hour: ${ack}`);
});
