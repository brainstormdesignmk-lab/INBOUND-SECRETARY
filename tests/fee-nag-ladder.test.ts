// THE FEE-RESISTANCE LADDER — the [00:27]/[00:28] TUI capture.
//
//   [00:27] Lina discloses the fee and asks for agreement
//   [00:27] PARI ZA POSETA BARATE   → the client objects to PAYING at all
//   [00:28] OVA PRV PAT SLUSAM      → "never heard this before"
//
// What the capture showed: the accusation was read as fresh INTERESTED, so the
// fee.ask was disclosed a SECOND time; every later pushback drew another
// explanation out of the fee.why pool, the ladder never advanced, and nothing
// ever forced a decision.
//
// The owner's rule, pinned here:
//
//   ONE persuasion (value framing)
//     → the AGENCY RULE (it is the agency's standing rule, in our published
//       price list, the same for every client — not her personal decision)
//     → THE DECISION ("Дали да закажам посета по наведените услови или не?
//       Одлуката е Ваша.")
//     → YES continues the workflow (contact collection),
//       NO closes with the bye protocol (fee.graceful.close).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InboundHandler } from '../src/handlers/inbound';
import { Classifier } from '../src/llm/classify';
import { Responder } from '../src/llm/respond';
import { SessionStore } from '../src/fsm/session';
import { PropertyService, Property } from '../src/data/properties';
import { AppointmentStore } from '../src/store/appointments';
import { EscalationStore } from '../src/store/escalations';
import { MetaStore } from '../src/store/meta';
import { ChannelRegistry } from '../src/channels/types';
import { LandmarkService } from '../src/geo/landmarks';
import { Db } from '../src/store/db';
import { loadConfig } from '../src/config';
import { RESPONSE_BANK } from '../src/data/responses';
import { setLearnedBank } from '../src/data/responseBank';
import {
  detectFeeChargePushback, detectFeeFirstTime, detectFeeWhy, detectProvisionAsk,
  detectNegatedFeePay, detectFeeComplaint, detectFeeRules,
} from '../src/llm/deterministic';
import { buildFeeRule, buildFeeDecision, feeLadder, feePersuasion } from '../src/llm/prompts';

setLearnedBank({
  variants: () => [],
  addVariant: () => false,
  addExample: () => false,
  metric: () => {},
  retrieve: () => undefined,
} as any);

class FailingLlm { async complete(): Promise<string> { throw new Error('429 quota exhausted'); } }

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

const ROWS: Property[] = [
  { eb: 78, id: 78, location: 'Капиштец', price: 185000, service: 'buy', bedrooms: 3, size: '82 м²', address: 'Народен Фронт' },
  { eb: 63, id: 63, location: 'Центар', price: 180000, service: 'buy', bedrooms: 2, size: '60 м²' },
];

function makeHandler(): { handler: InboundHandler; sessions: SessionStore; sent: string[] } {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS);
  const llm = new FailingLlm();
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions,
    classifier: new Classifier(llm, cfg, properties),
    responder: new Responder(llm, cfg),
    properties,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false }),
  });
  return { handler, sessions, sent };
}

const ASK_POOL_BUY: string[] = RESPONSE_BANK['fee.ask.buy'] ?? [];
const PERSUADE_POOL_BUY: string[] = RESPONSE_BANK['fee.persuade.1.buy'] ?? [];
const RULE_POOL: string[] = RESPONSE_BANK['fee.rule.hold'] ?? [];
const DECIDE_POOL: string[] = RESPONSE_BANK['fee.decide'] ?? [];
const GRACEFUL_POOL: string[] = RESPONSE_BANK['fee.graceful.close'] ?? [];

const inAskPool = (r: string) => ASK_POOL_BUY.includes(r.trim());
const inPersuadePool = (r: string) => PERSUADE_POOL_BUY.includes(r.trim());
const inRulePool = (r: string) => RULE_POOL.includes(r.trim());
const inDecidePool = (r: string) => DECIDE_POOL.includes(r.trim());
const isGracefulClose = (r: string) => /(?:најдобро|пријатен ден|Убав ден|Благодарам)/iu.test(r) && !r.includes('?');

// ── Detector pins ────────────────────────────────────────────────────────────

test('charge-pushback family: "pari za poseta barate" / "zemate pari za poseta" — never a why-question or a refusal', () => {
  assert.equal(detectFeeChargePushback('PARI ZA POSETA BARATE'), true, 'the live burst (both scripts, statement shape)');
  assert.equal(detectFeeChargePushback('pari za poseta barate'), true, 'Latin');
  assert.equal(detectFeeChargePushback('uste mi barate pari'), true, 'repeated charge accusation');
  assert.equal(detectFeeChargePushback('SE USTE MI BARATE PARI'), true, 'caps');
  assert.equal(detectFeeChargePushback('барате пари за посета'), true, 'Cyrillic demand verb');
  assert.equal(detectFeeChargePushback('земате пари за посета'), false, 'the charge+n-money pair is the provision-ask lane');
  assert.equal(detectProvisionAsk('земате пари за посета'), true, 'and it still owns that pair');
  // explanation traffic keeps its OWN lane (the why-family detector owns it)
  assert.equal(detectFeeChargePushback('zosto barate pari za poseta ?'), false, 'why-question');
  assert.equal(detectFeeChargePushback('OTA E NESTO NOVO'), false, 'surprise reaction');
  assert.equal(detectFeeChargePushback('ne sakam da platam'), false, 'refusal keeps its lane');
  assert.equal(detectFeeChargePushback('kolku e nadomestot za poseta ?'), false, 'amount question');
  assert.equal(detectFeeChargePushback('DALI ZEMATE PARI ZA POSETA?'), false, 'provision-ask owns the pointed question');
  assert.equal(detectProvisionAsk('DALI ZEMATE PARI ZA POSETA?'), true, 'and it still does');
  assert.equal(detectFeeWhy('PARI ZA POSETA BARATE'), false, 'it is NOT explanation traffic');
  assert.equal(detectFeeComplaint('PARI ZA POSETA BARATE'), false, 'nor a price complaint');
  assert.equal(detectFeeRules('PARI ZA POSETA BARATE'), false, 'nor a rules dismissal');
});

test('first-time-hearing family: "prv pat slusam" is its own serve (the agency rule), never a why-question', () => {
  assert.equal(detectFeeFirstTime('OVA PRV PAT SLUSAM'), true, 'the live burst');
  assert.equal(detectFeeFirstTime('prv pat slusam da se naplatuva poseta'), true, 'full form');
  assert.equal(detectFeeFirstTime('прв пат слушам за посета'), true, 'Cyrillic');
  assert.equal(detectFeeFirstTime('ova e nesto novo'), false, 'the surprise family keeps fee.why');
  assert.equal(detectFeeFirstTime('kolku e nadomestot ?'), false, 'amount question');
  // the why-detector still owns it (gates elsewhere depend on that)
  assert.equal(detectFeeWhy('OVA PRV PAT SLUSAM'), true, 'detectFeeWhy stays true — only the SERVE differs');
});

// ── The ladder itself (one place: feeLadder) ────────────────────────────────

test('feeLadder: 1 = one persuasion, 2 = the agency rule, 3+ = the decision', () => {
  const r1 = feeLadder('buy', 1);
  assert.equal(r1.key, 'fee.persuade.1.buy');
  assert.equal(r1.line, feePersuasion('buy', 1), 'the persuasion carries the value framing');

  const r2 = feeLadder('buy', 2);
  assert.equal(r2.key, 'fee.rule.hold');
  assert.equal(r2.line, buildFeeRule());

  const r3 = feeLadder('buy', 3);
  assert.equal(r3.key, 'fee.decide');
  assert.equal(r3.line, buildFeeDecision());
  assert.equal(feeLadder('buy', 9).key, 'fee.decide', 'every rung beyond 3 is still the decision');

  // the retired deep-persuasion rung is never served back
  assert.notEqual(feeLadder('buy', 2).key, 'fee.persuade.2.buy');
  assert.notEqual(feeLadder('buy', 3).key, 'fee.persuade.2.buy');
});

test('fee.rule.hold: amount-free agency rule that binds every client, ending on the agreement ask', () => {
  const all = [...RULE_POOL, buildFeeRule()];
  assert.ok(RULE_POOL.length >= 3, `expected a real pool, got ${RULE_POOL.length}`);
  for (const v of all) {
    assert.ok(/(?:правил|политик|ценовник|деловник)/iu.test(v), `no rule/policy word: ${v}`);
    assert.ok(/(?:секој клиент|сите клиенти|без исклучок|ист за сите|подеднакво)/iu.test(v), `does not bind every client: ${v}`);
    assert.ok(!/\d/.test(v), `the rule rung carries an amount (the fee was already disclosed): ${v}`);
    assert.ok(!/провизиј|адвокат|нотар/iu.test(v), `drifts into commission/contract terms: ${v}`);
    assert.ok(/\?\s*$/.test(v), `no agreement ask: ${v}`);
  }
});

test('fee.decide: the binary decision question + the ownership of the decision', () => {
  const all = [...DECIDE_POOL, buildFeeDecision()];
  assert.ok(DECIDE_POOL.length >= 3, `expected a real pool, got ${DECIDE_POOL.length}`);
  for (const v of all) {
    assert.ok(/дали\s+да\s+(?:ја\s+)?закажам/iu.test(v), `no decision question: ${v}`);
    assert.ok(/(?:одлуката е ваша|ваша е одлуката|вие одлучувате|решението е ваше)/iu.test(v), `decision not handed to the client: ${v}`);
    assert.ok(!/\d/.test(v), `the decision rung carries an amount: ${v}`);
    assert.ok(!/провизиј|адвокат|нотар/iu.test(v), `drifts into commission/contract terms: ${v}`);
  }
});

// ── E2E — the exact capture, then the owner's rule ──────────────────────────

test('e2e [00:27/00:28]: the accusation persuades ONCE, "prv pat slusam" gets the AGENCY RULE, never a fee re-disclosure', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'ladder-live';
  const send = async (m: string) => {
    await Promise.race([
      handler.handle('test', chatId, m),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`turn timeout (>10s): ${m.slice(0, 40)}`)), 10_000).unref()),
    ]);
    return sessions.get(chatId)!;
  };

  await send('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78');
  let s = await send('SAKAM DA JA VIDAM');
  assert.equal(s.state, 'closing');
  assert.ok(inAskPool(sent[sent.length - 1]), `the disclosure must come first: ${sent[sent.length - 1].slice(0, 90)}`);
  assert.equal(s.slots.feeRejections, undefined, 'the disclosure is not a rung');

  // [00:27] PARI ZA POSETA BARATE — the accusation is resistance #1
  s = await send('PARI ZA POSETA BARATE');
  let reply = sent[sent.length - 1];
  assert.equal(s.state, 'closing', 'the fee question is where the resistance is answered');
  assert.equal(s.slots.feeRejections, 1, 'one rung burned');
  assert.ok(inPersuadePool(reply), `rung 1 is the ONE persuasion: ${reply.slice(0, 90)}`);
  assert.ok(!inAskPool(reply), `the fee must NOT be re-disclosed: ${reply.slice(0, 90)}`);
  assert.ok(reply.includes('500 денари'), `the buy copy names the buy fee: ${reply.slice(0, 90)}`);

  // [00:28] OVA PRV PAT SLUSAM — explanation traffic, but the RULE answer
  s = await send('OVA PRV PAT SLUSAM');
  reply = sent[sent.length - 1];
  assert.equal(s.slots.feeRejections, 1, 'a "first time hearing it" never burns a rung');
  assert.ok(inRulePool(reply), `the agency rule is the answer: ${reply.slice(0, 90)}`);
  assert.ok(/(?:ценовник|правил|политик)/iu.test(reply), `the client hears it is agency policy: ${reply.slice(0, 90)}`);
  assert.ok(!inAskPool(reply), 'and never a second disclosure');

  // Still resisting → the rule rung (2), then the DECISION (3)
  s = await send('NE SAKAM DA PLATAM');
  assert.equal(s.slots.feeRejections, 2);
  assert.ok(inRulePool(sent[sent.length - 1]), `rung 2 is the agency rule: ${sent[sent.length - 1].slice(0, 90)}`);

  s = await send('NE SAKAM DA PLATAM');
  assert.equal(s.slots.feeRejections, 3);
  reply = sent[sent.length - 1];
  assert.ok(inDecidePool(reply), `rung 3 is the decision: ${reply.slice(0, 90)}`);
  assert.ok(/Одлуката е Ваша/iu.test(reply), `the decision belongs to the client: ${reply.slice(0, 90)}`);
});

test('e2e: the decision answered with NO runs the BYE PROTOCOL (graceful close, chat queued)', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'ladder-no';
  const send = async (m: string) => {
    await Promise.race([
      handler.handle('test', chatId, m),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`turn timeout (>10s): ${m.slice(0, 40)}`)), 10_000).unref()),
    ]);
    return sessions.get(chatId)!;
  };

  await send('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78');
  let s = await send('SAKAM DA JA VIDAM');
  assert.equal(s.state, 'closing');
  s = await send('PARI ZA POSETA BARATE');   // rung 1
  assert.equal(s.slots.feeRejections, 1);
  s = await send('NE SAKAM DA PLATAM');      // rung 2 — the agency rule
  assert.equal(s.slots.feeRejections, 2);
  assert.ok(inRulePool(sent[sent.length - 1]), sent[sent.length - 1].slice(0, 90));
  s = await send('USTE MI BARATE PARI');    // rung 3 — the decision (charge accusation)
  assert.equal(s.slots.feeRejections, 3);
  assert.ok(inDecidePool(sent[sent.length - 1]), sent[sent.length - 1].slice(0, 90));

  // The decision answered with NO → the bye protocol, never another persuasion.
  s = await send('NE, NEMA DA PLATAM');
  assert.equal(s.state, 'queued', JSON.stringify({ state: s.state, rejects: s.slots.feeRejections }));
  assert.equal(s.slots.feeRejections, 4);
  const reply = sent[sent.length - 1];
  assert.ok(isGracefulClose(reply), `the graceful close: ${reply.slice(0, 120)}`);
  assert.ok(!/филтер|ценовник|Одлуката е Ваша/iu.test(reply), `no fifth rung after the decision: ${reply.slice(0, 120)}`);
  assert.ok(GRACEFUL_POOL.length >= 1, 'the graceful-close pool is seeded');
});

test('e2e: the decision answered with YES continues the workflow (contact collection)', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'ladder-yes';
  const send = async (m: string) => {
    await Promise.race([
      handler.handle('test', chatId, m),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`turn timeout (>10s): ${m.slice(0, 40)}`)), 10_000).unref()),
    ]);
    return sessions.get(chatId)!;
  };

  await send('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78');
  let s = await send('SAKAM DA JA VIDAM');
  assert.equal(s.state, 'closing');
  s = await send('PARI ZA POSETA BARATE');
  s = await send('NE SAKAM DA PLATAM');
  s = await send('NE SAKAM DA PLATAM');
  assert.equal(s.slots.feeRejections, 3);
  assert.ok(inDecidePool(sent[sent.length - 1]), sent[sent.length - 1].slice(0, 90));

  s = await send('DOBRO, ZAKAZI');
  assert.equal(s.state, 'contact_collection', JSON.stringify({ state: s.state, rejects: s.slots.feeRejections }));
  assert.ok(/име|презиме|телефон/iu.test(sent[sent.length - 1]), `the contact ask follows: ${sent[sent.length - 1].slice(0, 90)}`);
});
