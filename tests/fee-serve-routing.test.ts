// The [09:0x] V16K11 transcript regression — the wrong fee script + the wrong
// answer TYPE, three serves in one morning window.
//
//   (1) client: "samo vie rabotite taka / nikoj ne zema pari za poseta" (burst)
//       → Lina served "За купување преку Метрополис — провизија 0%. … 500
//       денари …" — the BUY rules-of-work script, at a RENT searcher (fee is
//       300 ден/5 евра), and the RULES OF WORK instead of the REASONS for the
//       visit fee (the serious-client filter). Two distinct bugs:
//         • why-family detector gap: "никoj не зема пари за посета" /
//           "samo vie rabotite taka" matched CHARGE_MONEY_RE inside
//           detectProvisionAsk → PROVISION_ASK lane → provision.ask bank.
//         • service default: the session had reset overnight (idle), the
//           ternary read slots.service === undefined as buy.
//   (2) client: "ako gledam 10 stana toa se 5000 od moj djeb za razgleduvanje"
//       → multiplication TOTAL-COST arithmetic about the FEE read as
//       INTERESTED (the amount re-triggered the search machinery).
//   (3) client: "ne otkazi / ne sakam da plakjam za otvaranje na stan"
//       → negated pay read as PROVISION_ASK → provision.ask.rent (which at
//       least proves the session had learned rent by then).
//
// Context for the business rule: the client is a RENT searcher — the visit fee
// is 300 денари (5 евра). The buy script (500 ден + 0% провизија) must never
// reach a rent client, and a market question WITHOUT a declared market gets
// the service-agnostic answer, never a defaulted buy copy.
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
  detectFeeWhy, detectFeeComplaint, detectProvisionAsk,
  detectFeePaymentAgreement,  detectNegatedFeePay, detectFeeRules, detectFeeTotalCost, detectAgreement,
  detectBye, detectSoftRefusal, detectVisitTimingQuestion, detectNegatedAgreement, detectFeeAmountAsk,
  detectProvisionResistance, detectProvisionWho,
} from '../src/llm/deterministic';
import { buildFeeAsk, feePersuasion, buildFeeRules, BYE_GRACEFUL, BYE_AGAIN, SOFT_REFUSAL_CLOSE, VISIT_CONFIRM_ASK,
  provisionLadder, buildProvisionAsk } from '../src/llm/prompts';

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
  { eb: 79, id: 79, location: 'Капиштец', price: 250, service: 'rent', bedrooms: 2, size: '55 м²', address: 'Партенија' },
  { eb: 78, id: 78, location: 'Капиштец', price: 185000, service: 'buy', bedrooms: 3, size: '82 м²', address: 'Народен Фронт' },
];

function makeHandler(): { handler: InboundHandler; sessions: SessionStore; sent: string[] } {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS);
  const llm = new FailingLlm();
  const classifier = new Classifier(llm, cfg, properties);
  const responder = new Responder(llm, cfg);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false }),
  });
  return { handler, sessions, sent };
}

// ── Detector-level pins ──────────────────────────────────────────────────────

test('why family: "nikoj ne zema pari za poseta" + "samo vie rabotite taka" (both orders, both scripts)', () => {
  assert.equal(detectFeeWhy('samo vie rabotite taka\nnikoj ne zema pari za poseta'), true, 'burst as relay-joined');
  assert.equal(detectFeeWhy('samo vie rabotite taka'), true, '2nd-person policy statement alone');
  assert.equal(detectFeeWhy('nikoj ne zema pari za poseta'), true, 'universal-nobody + take-money');
  assert.equal(detectFeeWhy('НИКОЈ НЕ ЗЕМА ПАРИ ЗА ПОСЕТА'), true, 'Cyrillic caps');
  assert.equal(detectFeeWhy('никогаш не сум платил за посета'), true, 'never-paid variant');
  // "vie zemate pari za poseta" (no negation) is a genuine fee QUESTION —
  // it stays in the provision-ask lane, where the service-agnostic bank now
  // guarantees the correct copy. Only NEGATED/universal forms are why-lane.
  assert.equal(detectFeeWhy('vie zemate pari za poseta'), false, 'plain charge question = provision lane');
  assert.equal(detectProvisionAsk('vie zemate pari za poseta'), true, 'zemate+pari pair owned by provision-ask');
  // old families still fire
  assert.equal(detectFeeWhy('nikoj ne go pravi toa'), true);
  assert.equal(detectFeeWhy('zosto naplakjate poseta'), true);
});

test('provision-ask veto: the why family is NOT a provision question', () => {
  assert.equal(detectProvisionAsk('nikoj ne zema pari za poseta'), false, 'CHARGE_MONEY_RE must lose to the why-lane');
  assert.equal(detectProvisionAsk('samo vie rabotite taka'), false, 'bare policy ack is not provision traffic');
  // genuine provision asks unchanged
  assert.equal(detectProvisionAsk('KOLKU VI E PROVIZIJATA?'), true);
  assert.equal(detectProvisionAsk('ZEMATE PARI ZA POSETA?'), true, 'plain charge question still owned');
});

test('total-cost family: multiplication math about the FEE is a complaint, never interest', () => {
  assert.equal(detectFeeComplaint('ako gledam 10 stana toa se 5000 od moj djeb za razgleduvanje'), true, 'the capture (bare amount + pocket)');
  assert.equal(detectFeeComplaint('ако гледам 10 стана тоа се 5000 од мој џеб'), true, 'Cyrillic');
  assert.equal(detectFeeComplaint('10 stanovi po 500 denari e mnogu'), true, 'fee-sized currency anchor');
  assert.equal(detectFeeComplaint('stanot e 185000'), false, 'property price never fires');
  assert.equal(detectFeeComplaint('baram stan do 60000 evra'), false, 'budget never fires');
});

// ── [02:16] family: the MULTI-VISIT total ──────────────────────────────────
//
//   client: "PA AKO POSETAM 10 STANA TOA SE 5000DEN NA GLADNO?"
//   → Lina served the EXHAUSTED-CRITERIA nag ("Сите имоти што соодветствуваат
//     на Вашите критериуми ги искористивме…") and advanced closing→presentation.
//
// Two detector gaps let the "10" ride into DETAILS_PROVIDED (a criterion):
//   1. the total-cost grammar knew arms A (own-spend anchor) and B (COUNT +
//      noun + по/× + amount) — not the visit-verb arithmetic "посетам 10 стана
//      тоа се …", and not the "на гладно" own-spend anchor;
//   2. a currency GLUED to the amount ("5000DEN", one token) broke the
//      amount's right boundary, so even arm A could not see the sum.

test('multi-visit total: "ako posetam 10 stana toa se 5000DEN" is fee math (both scripts)', () => {
  const live = 'PA AKO POSETAM 10 STANA TOA SE 5000DEN NA GLADNO?';
  assert.equal(detectFeeTotalCost(live), true, 'the live [02:16] burst');
  assert.equal(detectFeeComplaint(live), true, 'the complaint family owns it too');
  assert.equal(detectFeeWhy(live), false, 'not a why-question (no rationale wanted)');
  assert.equal(detectFeeTotalCost('А АКО ПОСЕТАМ 10 СТАНА ТОА СЕ 5000 ДЕНАРИ НА ГЛАДНО?'), true, 'Cyrillic caps');
  // The visit-verb arm needs no own-spend anchor at all: the arithmetic itself
  // (how many viewings × the fee) is unambiguous.
  assert.equal(detectFeeTotalCost('ako posetam 10 stana toa se 3000den'), true, 'no anchor');
  assert.equal(detectFeeTotalCost('AKO GLEDAM 5 STANA TOA SE 1500 DEN'), true, 'gledam variant');
  // Total head without the verb ("10 посети, тоа се 3000 ден")
  assert.equal(detectFeeTotalCost('10 poseti toa se 3000 den'), true, 'count + noun + total head');
  assert.equal(detectFeeTotalCost('ако разгледам 3 стана вкупно 900 денари'), true, 'вкупно head');
  // Property prices and budgets stay out — no anchor, no total head.
  assert.equal(detectFeeTotalCost('baram stan do 250 evra'), false, 'budget');
  assert.equal(detectFeeTotalCost('stanot e 185000 denari'), false, 'property price (5+ digits)');
  assert.equal(detectFeeTotalCost('imas 10 stana vo Centar?'), false, 'a search for 10 apartments is not fee math');
});

// ── [02:16] family, second half: the fee AMOUNT question ─────────────────
//
// The same funnel answered "KOLKU E ZA POSETA?" with the FLAT's rent
// ("Станот со Евидентен број 79 — киријата изнесува 250 евра") and "KOLKU KE ME
// KOSTA 10 POSETI?" with the owner-price policy — the property lanes claimed a
// question whose OBJECT is the visit fee.

test('fee-amount ask: the question is about the FEE, the property lanes must not answer', () => {
  assert.equal(detectFeeAmountAsk('KOLKU E ZA POSETA?'), true, 'the live [02:16] shape');
  assert.equal(detectFeeAmountAsk('KOLKU E POSETATA?'), true);
  assert.equal(detectFeeAmountAsk('KOLKU PARI ZA POSETA ?'), true);
  assert.equal(detectFeeAmountAsk('KOLKU E ZA 10 POSETI?'), true, 'a quantity of viewings');
  assert.equal(detectFeeAmountAsk('KOLKU KE ME KOSTA 10 POSETI?'), true, 'what will it cost me');
  assert.equal(detectFeeAmountAsk('KOLKU E RAZGLEDUVANJETO?'), true, 'browse noun');
  assert.equal(detectFeeAmountAsk('KOLKU E NADOMESTO?'), true, 'charge noun');
  assert.equal(detectFeeAmountAsk('КОЈА Е ЦЕНАТА НА ПОСЕТАТА?'), true, 'Cyrillic');
  // The property's own price questions keep their lane: the OBJECT decides.
  assert.equal(detectFeeAmountAsk('KOLKU E KIRIJATA ZA STANOT?'), false, 'rent is not the fee');
  assert.equal(detectFeeAmountAsk('KOLKU E STANOT?'), false, 'the flat, not the fee');
  assert.equal(detectFeeAmountAsk('KOLKU E DEPOZITOT?'), false, 'deposit');
  assert.equal(detectFeeAmountAsk('KOLKU E ZA 3 STANA?'), false, 'prices of three flats');
  assert.equal(detectFeeAmountAsk('imas 10 stana vo Centar?'), false, 'a search is not a fee question');
});

test('e2e [02:16]: "KOLKU E ZA POSETA?" discloses the FEE, never the flat rent', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'v16k11-fee-amount';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  await send('ZDRAVO. ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 79');
  let s = await send('KOLKU E ZA POSETA?');

  const reply = sent[sent.length - 1] ?? '';
  assert.ok(reply.includes('300 денари'), `the fee amount must be disclosed: ${reply.slice(0, 120)}`);
  assert.ok(!/киријата изнесува|чини \d/iu.test(reply), `the flat's price answered a fee question: ${reply.slice(0, 120)}`);
  assert.equal(s.state, 'closing', 'the fee question is the funnel position');

  // …and the "what will 10 visits cost me" phrasing does not fall into the
  // owner-price negotiation lane either.
  s = await send('KOLKU KE ME KOSTA 10 POSETI?');
  const reply2 = sent[sent.length - 1] ?? '';
  assert.ok(!/цената е исклучиво на сопственикот|одредува цената на имотот|преговар/iu.test(reply2),
    `owner-price policy answered a fee-total question: ${reply2.slice(0, 120)}`);
  assert.ok(reply2.includes('300 денари') || /филтер|разгледување|посета/iu.test(reply2), `not a fee answer: ${reply2.slice(0, 120)}`);
});

test('e2e [02:16]: a fee-amount ask with NO market declared gets the agnostic disclosure', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'v16k11-fee-agnostic';
  await handler.handle('test', chatId, 'ZDRAVO');
  const s = await (async () => { await handler.handle('test', chatId, 'KOLKU E ZA POSETA?'); return sessions.get(chatId)!; })();
  const reply = sent[sent.length - 1] ?? '';
  // Both fees named — never a defaulted buy copy at an undeclared market.
  assert.ok(reply.includes('300 денари') && reply.includes('500 денари'), `not the agnostic copy: ${reply.slice(0, 140)}`);
  assert.equal(s.slots.service, undefined, 'no market fabricated by the question');
  assert.equal(s.state, 'closing', 'the fee question moved the funnel to the fee gate');
});

test('e2e [02:16] regression: property-price questions still answer the property price', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'v16k11-price-kept';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };
  await send('ZDRAVO. ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 79');
  await send('KOLKU E KIRIJATA ZA STANOT?');
  const reply = sent[sent.length - 1] ?? '';
  assert.ok(/киријата изнесува 250 евра/iu.test(reply), `the rent answer must survive: ${reply.slice(0, 120)}`);
  assert.ok(!reply.includes('300 денари'), 'no fee disclosure on a rent question');
});

test('e2e [02:16]: multi-visit fee math at the fee question → fee.why rationale, never the exhausted nag', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'v16k11-multivisit';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  await send('ZDRAVO. ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 79');
  await send('DALI E SEUSTE DOSTAPEN ?');
  let s = await send('KONTAKTIRAJTE GO I KAZETE MI');
  assert.ok((sent[sent.length - 1] ?? '').includes('300 денари'), 'the fee was disclosed first');

  s = await send('PA AKO POSETAM 10 STANA TOA SE 5000DEN NA GLADNO?');

  const reply = sent[sent.length - 1] ?? '';
  // The rationale for the visit fee (the time-waster filter), never a second
  // disclosure and never the criteria/exhausted copy.
  assert.ok(/филтер|селекц|вистинск|сериозн|искрен|препознав/iu.test(reply), `not the fee rationale: ${reply.slice(0, 120)}`);
  assert.ok(!reply.includes('300 денари') && !reply.includes('500 денари'), `fee re-disclosed: ${reply.slice(0, 120)}`);
  assert.ok(!/ги искористивме и ги прегледавме|разгледавме сите опции|ги запишам Вашите барања|ги сочувам Вашите податоци/iu.test(reply),
    `the exhausted-criteria nag was served: ${reply.slice(0, 140)}`);
  assert.ok(!reply.includes('м²'), `property cards dumped on fee math: ${reply.slice(0, 120)}`);
  assert.equal(s.state, 'closing', 'the explanation lane must not advance the funnel');
  assert.equal(s.slots.feeRejections, undefined, 'no rung burned on arithmetic');
  assert.equal(s.slots.bedrooms, undefined, 'the "10" must not become a criterion');
});

test('negated-pay guard: "ne sakam da plakjam za otvaranje na stan" is NOT provision-ask', () => {
  const t = 'ne sakam da plakjam za otvaranje na stan';
  assert.equal(detectProvisionAsk(t), false, 'negation without amount = refusal family');
  assert.equal(detectFeePaymentAgreement(t), false, 'never consent');
  assert.equal(detectNegatedFeePay(t), true, 'refusal detector owns it (no agreement stem needed)');
  // committed-with-amount consent unchanged
  assert.equal(detectProvisionAsk('ke platam 500 den za poseta'), false, 'consent with amount stays out of provision-ask');
});

// ── [12:40] family: rules dismissal + total-cost math in ANY state ─────────

test('rules family: "тоа се правилата на агенцијата" is fee-rules traffic (both scripts)', () => {
  const live = 'тоа се правилата на агенцијата кои важат и за мене и за Вас';
  assert.equal(detectFeeRules(live), true, 'the user\'s exact answer-frame');
  assert.equal(detectFeeRules('toa se vashite pravila'), true, 'Latin');
  assert.equal(detectFeeRules('TOA E VASHA POLITIKA'), true, 'caps');
  assert.equal(detectFeeRules('vashata politika e takva'), true, 'policy noun + owner');
  assert.equal(detectFeeRules('ne sakam da platam'), false, 'refusal keeps its lane');
  assert.equal(detectFeeRules('baram stan vo Karpos'), false, 'search traffic untouched');
  // total-cost detector is the state-free public twin
  assert.equal(detectFeeTotalCost('ako gledam 10 stana toa se 5000 od moj djeb za razgleduvanje'), true);
  assert.equal(detectFeeTotalCost('stanot e 185000'), false);
});

test('fee.rules bank: amount-free, agency-policy + bind-both-sides rationale', () => {
  assert.ok(buildFeeRules().includes('правилата'), 'code-built fallback anchors the policy word');
  const seeds: string[] = RESPONSE_BANK['fee.rules'] ?? [];
  assert.ok(seeds.length >= 3, `expected seed pool, got ${seeds.length}`);
  for (const v of seeds) {
    assert.ok(!/\d/.test(v), `fee.rules carries an amount: ${v}`);
    assert.ok(/(?:правил|политик)/iu.test(v), `no policy word: ${v}`);
    assert.ok(/(?:Вас и за нас|нас и за Вас|подеднакво|сите|еднакво)/iu.test(v), `does not bind both sides: ${v}`);
    assert.ok(/\?\s*$/.test(v), `no agreement ask: ${v}`);
  }
});

test('e2e [12:40]: total-cost math in a FRESH IDLE session → fee.why, never a fee ask, never cards', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'v16k11-math-idle';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  await send('ZDRAVO'); // greeting → idle (the exact [12:40] pre-state)
  const s = await send('ako gledam 10 stana toa se 5000 od moj djeb za razgleduvanje');

  const reply = sent[sent.length - 1] ?? '';
  assert.ok(/филт|селекц|вистинск|сериозн|искрен|препознав/iu.test(reply), `not the rationale: ${reply.slice(0, 120)}`);
  assert.ok(!reply.includes('300 денари') && !reply.includes('500 денари'), `fee re-disclosed: ${reply.slice(0, 120)}`);
  assert.ok(!reply.includes('м²'), `property cards dumped on fee math: ${reply.slice(0, 120)}`);
  // The fast lane answers the EXPLANATION and leaves the funnel untouched
  // (the live [12:40] serve had also force-advanced idle→closing).
  assert.equal(s.state, 'idle', 'explanation lane must not advance the funnel');
  assert.equal(s.slots.service, undefined, 'no market fabricated by a fee complaint');
  assert.equal(s.slots.feeRejections, undefined, 'no rung burned on math');
});

test('e2e [12:40]: agency-rules dismissal in closing → fee.rules rationale, stay at the fee', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'v16k11-rules';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  await send('ZDRAVO. ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 79');
  await send('DALI E SEUSTE DOSTAPEN ?');
  let s = await send('KONTAKTIRAJTE GO I KAZETE MI');
  assert.ok((sent[sent.length - 1] ?? '').includes('300 денари'));
  assert.equal(s.slots.feeRejections, undefined, 'clean baseline');

  s = await send('тоа се правилата на агенцијата кои важат и за мене и за Вас');

  const reply = sent[sent.length - 1] ?? '';
  assert.ok(/(?:правил|политик)/iu.test(reply), `not the rules answer: ${reply.slice(0, 120)}`);
  assert.ok(!reply.includes('300 денари') && !reply.includes('500 денари'), `fee re-disclosed: ${reply.slice(0, 120)}`);
  assert.equal(s.state, 'closing', 'stays at the fee question');
  assert.equal(s.slots.feeRejections, undefined, 'a rules dismissal never burns a rung');
});

// ── [13:2x] family: conversation exit + soft refusal ───────────────────────

test('bye family: pure exits owned ("ne fala ti cao"), business messages never', () => {
  assert.equal(detectBye('ne fala ti\ncao'), true, 'the live burst');
  assert.equal(detectBye('cao'), true);
  assert.equal(detectBye('ЧАО ПРИЈАТНО'), true, 'caps');
  assert.equal(detectBye('до гледање'), true);
  assert.equal(detectBye('cao, baram stan'), false, 'business word wins');
  assert.equal(detectBye('fala, koga moze poseta?'), false, 'question stays in its lane');
  for (const v of (RESPONSE_BANK['bye.graceful'] ?? [])) {
    assert.ok(!/\?\s*$/.test(v), `bye variant ends with a question: ${v}`);
    assert.ok(/најдобро!\s*$/iu.test(v), `bye variant missing the close: ${v}`);
    assert.ok(!/туку сум|помогнам|доколку во иднина/iu.test(v), `bye variant re-offers help: ${v}`);
  }
  // сè/се (grave or plain) — the close must be the last thing the client reads.
  assert.ok(/најдобро!\s*$/iu.test(BYE_GRACEFUL), `BYE_GRACEFUL lacks the farewell close: ${BYE_GRACEFUL}`);
});

test('soft refusal: bare declines owned, content-bearing negations keep their lanes', () => {
  assert.equal(detectSoftRefusal('ne sakam'), true, 'the live capture');
  assert.equal(detectSoftRefusal('НЕ ФАЛА'), true, 'caps');
  assert.equal(detectSoftRefusal('ne, blagodaram'), true);
  assert.equal(detectSoftRefusal('ne sakam da platam'), false, 'fee refusal keeps its lane');
  assert.equal(detectSoftRefusal('ne sakam stan'), false, 'criteria negation keeps its lane');
  assert.equal(detectSoftRefusal('ne sakam, ama kolku e kirijata?'), false, 'question keeps its lane');
  for (const v of (RESPONSE_BANK['soft.refusal.close'] ?? [])) {
    assert.ok(!/\?\s*$/.test(v), `soft-refusal variant ends with a question: ${v}`);
    assert.ok(/најдобро!\s*$/iu.test(v), `soft-refusal variant missing the close: ${v}`);
    assert.ok(!/можам ли да Ви помогнам|помогнам со уште нешто/iu.test(v), `re-offer ask leaked: ${v}`);
  }
  assert.ok(/најдобро!\s*$/iu.test(SOFT_REFUSAL_CLOSE), `SOFT_REFUSAL_CLOSE lacks the farewell close: ${SOFT_REFUSAL_CLOSE}`);
});

test('e2e [13:2x]: "ne fala ti / cao" after the graceful close → Се најдобро farewell, NO help-offer question', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'v16k11-bye';
  // A hung turn must FAIL loudly, not wedge the suite: race each handle() against a 10 s clock.
  const send = async (m: string) => {
    await Promise.race([
      handler.handle('test', chatId, m),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`turn timeout (>10s): ${m.slice(0, 40)}`)), 10_000).unref()),
    ]);
    return sessions.get(chatId)!;
  };

  await send('ZDRAVO. ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 79');
  await send('DALI E SEUSTE DOSTAPEN ?');
  let s = await send('KONTAKTIRAJTE GO I KAZETE MI');
  assert.ok((sent[sent.length - 1] ?? '').includes('300 денари'));
  s = await send('ne otkazi\nne sakam da plakjam za otvaranje na stan');
  assert.equal(s.slots.feeRejections, 1);
  s = await send('ne sakam');
  assert.ok(/најдобро!/iu.test(sent[sent.length - 1] ?? ''), `not the graceful close: ${(sent[sent.length - 1] ?? '').slice(0, 90)}`);
  assert.ok(!s.slots.feeRejections || (s.slots.feeRejections ?? 0) <= 2, 'soft decline must not burn rungs');

  s = await send('ne fala ti\ncao');
  const reply = sent[sent.length - 1] ?? '';
  assert.ok(/најдобро!/iu.test(reply), `not the farewell: ${reply.slice(0, 90)}`);
  assert.ok(!reply.includes('?'), `farewell asks a question: ${reply}`);
  assert.ok(!/туку сум|помогнам|доколку во иднина/iu.test(reply), `farewell re-offers help: ${reply}`);
});

// ── [19:56] family: visit-timing question → confirm FIRST, fee AFTER ────────

test('timing question detector: koga + visit ref owned, commands/fee traffic/answers are not', () => {
  assert.equal(detectVisitTimingQuestion('KOGA BI MOZELO DA SE POSETI'), true, 'the live burst');
  assert.equal(detectVisitTimingQuestion('koga moze poseta?'), true);
  assert.equal(detectVisitTimingQuestion('koga mozam da ja poglednam?'), true, 'verb form');
  assert.equal(detectVisitTimingQuestion('кога би можела посетата?'), true, 'cyrillic');
  assert.equal(detectVisitTimingQuestion('utre vo 12 mozhe li poseta?'), false, 'a concrete time is a scheduling answer');
  assert.equal(detectVisitTimingQuestion('DOGOVORI MI POSETA'), false, 'visit command keeps its lane');
  assert.equal(detectVisitTimingQuestion('kolku e nadomestot za poseta?'), false, 'fee traffic keeps its lane');
  for (const v of (RESPONSE_BANK['visit.confirm.ask'] ?? [])) {
    assert.ok(/\?\s*$/u.test(v), `confirm variant must end with the ask: ${v}`);
    assert.ok(/сопствени/iu.test(v), `confirm variant lost the owner ping: ${v}`);
    assert.ok(!/\d|евр|денар|\bден\b|denar|evr/iu.test(v), `confirm variant leaks a fee amount: ${v}`);
  }
  assert.ok(/\?\s*$/u.test(VISIT_CONFIRM_ASK), 'VISIT_CONFIRM_ASK must end with the ask');
});

test('e2e [19:56]: koga → confirm ask (NO fee), VO RED → fee, DOBRO → contact collection', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'v16k11-koga';
  // A hung turn must FAIL loudly, not wedge the suite: race each handle() against a 10 s clock.
  const send = async (m: string) => {
    await Promise.race([
      handler.handle('test', chatId, m),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`turn timeout (>10s): ${m.slice(0, 40)}`)), 10_000).unref()),
    ]);
    return sessions.get(chatId)!;
  };

  await send('ZDRAVO. ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 79');
  await send('DALI E SEUSTE DOSTAPEN ?');

  let s = await send('KOGA BI MOZELO DA SE POSETI');
  let reply = sent[sent.length - 1] ?? '';
  assert.ok(/сопствени/iu.test(reply), `not the confirm ask: ${reply.slice(0, 120)}`);
  assert.ok(!reply.includes('300 денари') && !reply.includes('500 денари') && !reply.includes('0%'), `fee leaked BEFORE the confirm: ${reply.slice(0, 120)}`);
  assert.ok(/\?\s*$/u.test(reply), `confirm ask must end with the question: ${reply.slice(0, 120)}`);
  assert.equal(s.slots.ownerContactPending, true, 'confirm gate must be armed');
  assert.equal(s.slots.viewingFeeAgreed, undefined, 'no fee agreement before the confirm');

  s = await send('VO RED SO VAS');
  reply = sent[sent.length - 1] ?? '';
  assert.ok(reply.includes('300 денари'), `after the confirm the fee must be disclosed, got: ${reply.slice(0, 120)}`);
  assert.ok(!reply.includes('500 денари'), `rent client must never hear the buy fee: ${reply.slice(0, 120)}`);
  // CHANGED CONTRACT (the 300-ден capture): the turn that DISCLOSES the fee
  // cannot also register fee consent. "VO RED SO VAS" agreed to the VISIT;
  // the fee is what the client has just now heard about, and consent comes
  // from their NEXT answer. The old expectation set the flag here, so the next
  // message (even a fee question) skipped the ladder and jumped to contact
  // collection — exactly the rent transcript this suite now pins.
  assert.equal(s.slots.viewingFeeAgreed, undefined, 'the disclosure turn is not fee consent');

  s = await send('DOBRO');
  assert.equal(s.state, 'contact_collection', `fee OK must move to contact collection, got: ${s.state}`);
});

test('negated agree-phrase is never consent: "ne, ne e vo red" declines the confirm', () => {
  assert.equal(detectNegatedAgreement('ne, ne e vo red'), true, 'negated vo red must flip');
  assert.equal(detectAgreement('ne, ne e vo red'), false, 'must not read as consent');
  assert.equal(detectAgreement('vo red so vas'), true, 'plain confirm still consents');
  assert.equal(detectAgreement('koga mozam da ja poglednam?'), false, 'timing question is no consent');
});

// ── Service-aware copy pins ──────────────────────────────────────────────────

test('buildFeeAsk/feePersuasion: undefined service = literal both-scripts case, never buy', () => {
  const ask = buildFeeAsk(undefined);
  assert.ok(ask.includes('300 денари') && ask.includes('500 денари'), `agnostic ask names both fees: ${ask}`);
  assert.ok(/изнајмување или купување|купување или изнајмување/iu.test(ask), 'asks which market');
  const p1 = feePersuasion(undefined, 1);
  assert.ok(p1.includes('300 денари') && p1.includes('500 денари'), `agnostic persuade names both: ${p1}`);
  const p2 = feePersuasion(undefined, 2);
  assert.ok(p2.includes('300 денари') && p2.includes('500 денари'), `agnostic deep-persuade names both: ${p2}`);
  // rent copy still exactly rent
  assert.ok(feePersuasion('rent', 1).includes('300 денари') && !feePersuasion('rent', 1).includes('500'));
  assert.ok(feePersuasion('buy', 1).includes('500 денари') && !feePersuasion('buy', 1).includes('300'));
});

test('fee.why bank stays amount-free and rationale-only (no buy-terms leakage)', () => {
  const seeds: string[] = RESPONSE_BANK['fee.why'] ?? [];
  assert.ok(seeds.length >= 10, `expected a real pool, got ${seeds.length}`);
  for (const v of seeds) {
    assert.ok(!/\d/.test(v), `fee.why carries an amount (rent clients would read 500): ${v}`);
    assert.ok(!/провизиј/iu.test(v), `fee.why mentions commission: ${v}`);
    assert.ok(!/адвокат|нотар/iu.test(v), `fee.why drifts into rules-of-work: ${v}`);
    assert.ok(/филт|селекц|вистинск|сериозн|искрен|препознав/iu.test(v), `no rationale: ${v}`);
  }
});

// ── E2E — FailingLlm, mirroring the live window ─────────────────────────────

test('e2e: rent funnel, session RESET, burst "samo vie…/nikoj ne zema…" → fee.why (never the buy script)', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'v16k11-why';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // Rent funnel to closing, fee disclosed (300 денари). The EB →
  // availability-ack → contact-order path is the proven route to the fee
  // disclosure (mirrors tests/fee-surprise-why.test.ts).
  let s = await send('ZDRAVO. ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 79');
  s = await send('DALI E SEUSTE DOSTAPEN ?');
  assert.ok(s.slots.ownerContactPending, 'availability ack must arm ownerContactPending');
  s = await send('KONTAKTIRAJTE GO I KAZETE MI');
  assert.equal(s.state, 'closing', 'contact order must land in closing');
  const feeAsk = sent[sent.length - 1] ?? '';
  assert.ok(feeAsk.includes('300 денари'), `rent fee disclosure expected, got: ${feeAsk.slice(0, 80)}`);

  // Simulate the overnight session loss (the live bug: state=idle, slots gone).
  const fresh = sessions.get(chatId)!;
  fresh.state = 'idle';
  fresh.slots = { ...fresh.slots, service: undefined, propertyId: undefined, interestedPropertyId: undefined };
  sessions.set(fresh);

  // The burst.
  s = await send('samo vie rabotite taka\nnikoj ne zema pari za poseta');

  const reply = sent[sent.length - 1] ?? '';
  assert.ok(!reply.includes('500 денари') && !reply.includes('10 евра'), `buy script leaked: ${reply.slice(0, 120)}`);
  assert.ok(!/провизиј/iu.test(reply), `rules-of-work served instead of the reasons: ${reply.slice(0, 120)}`);
  assert.ok(/филт|селекц|вистинск|сериозн|искрен|препознав/iu.test(reply), `not the fee rationale: ${reply.slice(0, 120)}`);
  // The FSM-leg feeWhy branch re-pins the funnel at the fee question (idle is
  // an allowed before-state) — the client answers the agreement ask, no rung
  // burned, no property dumped.
  assert.equal(s.state, 'closing', 'why-question re-pins the funnel at the fee');
  assert.equal(s.slots.feeRejections, undefined, 'a why-question never burns a refusal rung');
});

test('e2e: total-cost math in closing → fee.why rationale, no property dump', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'v16k11-math';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  await send('ZDRAVO. ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 79');
  await send('DALI E SEUSTE DOSTAPEN ?');
  let s = await send('KONTAKTIRAJTE GO I KAZETE MI');
  assert.ok((sent[sent.length - 1] ?? '').includes('300 денари'));
  assert.equal(s.state, 'closing');

  s = await send('ako gledam 10 stana toa se 5000 od moj djeb za razgleduvanje');

  const reply = sent[sent.length - 1] ?? '';
  assert.ok(/филт|селекц|вистинск|сериозн|искрен|препознав/iu.test(reply), `not the rationale: ${reply.slice(0, 120)}`);
  assert.ok(!reply.includes('Капиштец') && !reply.includes('м²'), `card re-dumped on fee math: ${reply.slice(0, 120)}`);
  assert.equal(s.state, 'closing', 'math complaint stays at the fee question');
});

test('e2e: negated pay "ne sakam da plakjam za otvaranje na stan" → refusal rung 1, rent copy', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'v16k11-negpay';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  await send('ZDRAVO. ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 79');
  await send('DALI E SEUSTE DOSTAPEN ?');
  let s = await send('KONTAKTIRAJTE GO I KAZETE MI');
  assert.ok((sent[sent.length - 1] ?? '').includes('300 денари'));
  assert.equal(s.slots.feeRejections, undefined, 'clean baseline');

  s = await send('ne otkazi\nne sakam da plakjam za otvaranje na stan');

  const reply = sent[sent.length - 1] ?? '';
  assert.equal(s.slots.feeRejections, 1, 'negated pay = refusal #1');
  assert.ok(reply.includes('300 денари'), `persuasion must quote the RENT fee, got: ${reply.slice(0, 120)}`);
  assert.ok(!reply.includes('500 денари'), `buy copy leaked into rent persuasion: ${reply.slice(0, 120)}`);
  assert.equal(s.state, 'closing', 'refusal #1 stays in closing (persuasion)');
});

test('e2e: provision ask in a FRESH idle session → service-agnostic answer, never buy-only', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'prov-fresh-idle';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  await send('ZDRAVO'); // greeting → idle
  const s = await send('KOLKU VI E PROVIZIJATA?');

  const reply = sent[sent.length - 1] ?? '';
  assert.ok(reply.includes('300 денари') && reply.includes('500 денари'), `agnostic answer names both scripts, got: ${reply.slice(0, 160)}`);
  assert.ok(/купување или изнајмување|изнајмување или купување/iu.test(reply), 'asks which market');
  assert.equal(s.slots.service, undefined, 'no market fabricated');
});

// ── [20:0x] family: bare "Pari zemate…? Zosto?" → fee.why; second bye → short parting ──

test('e2e [20:0x]: "Pari zemate za posetam? Zosto?" → fee.why rationale, never the 0%/legal script', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'v16k11-why-reversed';
  // A hung turn must FAIL loudly, not wedge the suite: race each handle() against a 10 s clock.
  const send = async (m: string) => {
    await Promise.race([
      handler.handle('test', chatId, m),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`turn timeout (>10s): ${m.slice(0, 40)}`)), 10_000).unref()),
    ]);
    return sessions.get(chatId)!;
  };

  await send('ZDRAVO');
  await send('Pari zemate za posetam?\nZosto?');
  const reply = sent[sent.length - 1] ?? '';
  assert.ok(/филт|селекц|вистинск|сериозн|искрен|препознав|квалитет|енерги/iu.test(reply),
    `not the filter rationale: ${reply.slice(0, 160)}`);
  assert.ok(!/0%/u.test(reply), `the 0% provision script served: ${reply.slice(0, 160)}`);
  assert.ok(!/адвокат|нотар/iu.test(reply), `the legal-obligations script served: ${reply.slice(0, 160)}`);
});

// ── 300-ден rent ladder: the SAME four rungs as the 500-ден buy fee ────────
//
// Owner rule: the rent fee (300 денари / 5 евра) has its OWN questions (rent
// provision / the 50% commission), but the VISIT-fee conversation must follow
// the buy ladder's logic —
//   1. the client wants a visit → she DISCLOSES the fee (rent copy, 300)
//   2. he nags → she PERSUADES (the quality-service filter answer)
//   3. he nags again → the AGENCY RULES (the fee is in the published price
//      list, the same for client and agency)
//   4. he nags again → THE DECISION ("дали да ја закажам посетата по
//      наведените услови или не? Одлуката е Ваша.")
//   5. a 4th nag → the graceful close (queued, no further pitch)
// The 300-ден copy is pinned at every rung — the buy 500 must never leak.
// The blocker this pins: "NEMA DA PLATAM" (the negated FUTURE) used to read as
// a bare "да" = consent, so nag #3 advanced to contact collection instead of
// serving the decision rung.

test('negated future pay is resistance, never consent (both scripts)', () => {
  const refusals = [
    'NEMA DA PLATAM',
    'PA NEMA DA PLATAM. KRAJ',
    'PA I TI VAKA RABOTIS. NEMA DA PLATAM',
    'нема да платам',
    'НЕМА ДА ПЛАТАМ НАДОМЕСТ',
    'nemam da platam',
    'nema da dadam pari za poseta',
  ];
  for (const t of refusals) {
    assert.equal(detectAgreement(t), false, `read as consent: ${t}`);
    assert.equal(detectFeePaymentAgreement(t), false, `read as fee consent: ${t}`);
    assert.equal(detectNegatedFeePay(t), true, `not owned by the refusal family: ${t}`);
  }
  // The consent phrases that LOOK like the same family are untouched.
  assert.equal(detectAgreement('nema problem, vo red'), true, 'nema problem is still consent');
  assert.equal(detectNegatedFeePay('nema problem, ke platam'), false, 'nema problem + pay is consent');
  assert.equal(detectAgreement('ke platam 300 denara'), false, 'a pay promise alone is not the yes');
});

test('e2e 300-ден rent ladder: disclose → persuade → agency rules → decision → close', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'rent-300-ladder';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  await send('ZDRAVO. ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 79');
  await send('DALI E SEUSTE DOSTAPEN ?');
  let s = await send('KONTAKTIRAJTE GO I KAZETE MI');

  // Rung 0 — the disclosure, rent script.
  assert.ok((sent[sent.length - 1] ?? '').includes('300 денари'), `rent fee disclosure expected: ${(sent[sent.length - 1] ?? '').slice(0, 90)}`);

  // Rung 1 — first nag: ONE persuasion, quoted in the 300-ден rent copy.
  s = await send('NE SAKAM DA PLATAM');
  let reply = sent[sent.length - 1] ?? '';
  assert.equal(s.slots.feeRejections, 1, 'first nag is rung 1');
  assert.ok(reply.includes('300 денари'), `rent persuasion must quote the rent fee: ${reply.slice(0, 130)}`);
  assert.ok(!reply.includes('500 денари'), `buy copy leaked into the rent rung: ${reply.slice(0, 130)}`);
  assert.equal(s.state, 'closing', 'rung 1 stays at the fee question');

  // Rung 2 — second nag: the AGENCY RULES, never a second persuasion.
  s = await send('NE SAKAM DA PLATAM');
  reply = sent[sent.length - 1] ?? '';
  assert.equal(s.slots.feeRejections, 2, 'second nag is rung 2');
  assert.ok(/правил|ценовник/iu.test(reply), `not the agency-rules answer: ${reply.slice(0, 130)}`);
  assert.equal(s.state, 'closing');

  // Rung 3 — third nag: THE DECISION (book under the conditions, or not).
  // The negated-future refusal must land here instead of consent → contact
  // collection (the bug this suite pins).
  s = await send('PA I TI VAKA RABOTIS. NEMA DA PLATAM');
  reply = sent[sent.length - 1] ?? '';
  assert.equal(s.slots.feeRejections, 3, 'third nag is rung 3');
  assert.equal(s.state, 'closing', `the decision rung stays at the fee question, got ${s.state}`);
  assert.ok(/дали да ја закажам посетата|одлуката е ваша/iu.test(reply), `not the decision question: ${reply.slice(0, 130)}`);
  assert.ok(!/име и презиме|телефонски број/iu.test(reply), `contact collection ran on a refusal: ${reply.slice(0, 130)}`);

  // Rung 4 — fourth nag: the graceful close, queued, no pitch.
  s = await send('NE SAKAM DA PLATAM');
  reply = sent[sent.length - 1] ?? '';
  assert.equal(s.state, 'queued', `the 4th resistance closes the chat, got ${s.state}`);
  assert.ok(!reply.includes('?'), `the close asks a question: ${reply.slice(0, 130)}`);
  assert.ok(!reply.includes('300 денари') && !reply.includes('500 денари'), `the close re-pitches the fee: ${reply.slice(0, 130)}`);
});

test('e2e 300-ден rent: the charge question climbs rung 1 (the capture), then complaint → rules → decision', async () => {
  // The owner's transcript: 300 disclosed, then "PARI ZEMATE ZA POSETA ?" was
  // answered with the CONTACT ASK — the question was read as consent/commission
  // and the visit-fee ladder never ran. Here every nag TYPE climbs one rung, in
  // the same order as the 500: accusation → complaint → "nobody charges but
  // you" → refusal, with the 300 copy on rung 1 and no commission tier leak.
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'rent-300-nag-grammar';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  await send('ZDRAVO. ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 79');
  await send('DALI E SEUSTE DOSTAPEN ?');
  let s = await send('KONTAKTIRAJTE GO I KAZETE MI');
  assert.ok((sent[sent.length - 1] ?? '').includes('300 денари'), 'rent fee disclosure expected');

  // Rung 1 — the charge QUESTION (the exact capture wording).
  s = await send('PARI ZEMATE ZA POSETA ?');
  let reply = sent[sent.length - 1] ?? '';
  assert.equal(s.slots.feeRejections, 1, 'the charge question is nag #1');
  assert.equal(s.state, 'closing', 'the funnel stays at the fee question');
  assert.ok(reply.includes('300 денари'), `rung 1 must quote the rent fee: ${reply.slice(0, 130)}`);
  assert.ok(!reply.includes('500 денари'), `buy copy leaked into the rent rung: ${reply.slice(0, 130)}`);
  assert.ok(!/50\s*%|провизиј/iu.test(reply), `the commission tier leaked into the visit-fee rung: ${reply.slice(0, 130)}`);
  assert.ok(!/име и презиме|телефонски број/iu.test(reply), `contact collection ran on a fee question: ${reply.slice(0, 130)}`);

  // Rung 2 — a value complaint. Before the fix this was answered from fee.why
  // WITHOUT advancing, and the ladder stalled here forever.
  s = await send('MNOGU NEKAKO 300DEN ZA OTVARANJE NA STAN');
  reply = sent[sent.length - 1] ?? '';
  assert.equal(s.slots.feeRejections, 2, 'the complaint is nag #2');
  assert.ok(/правил|ценовник|политик/iu.test(reply), `rung 2 must be the agency rule: ${reply.slice(0, 130)}`);
  assert.ok(!/\d/.test(reply), `the rule rung carries a figure: ${reply.slice(0, 130)}`);

  // Rung 3 — "nobody charges but you".
  s = await send('NIKOJ NE NAPLATUVA ZA POSETA SAMO KAJ VAS');
  reply = sent[sent.length - 1] ?? '';
  assert.equal(s.slots.feeRejections, 3, 'the universal objection is nag #3');
  assert.ok(/дали да ја закажам посетата|одлуката е ваша/iu.test(reply), `rung 3 must be the decision: ${reply.slice(0, 130)}`);
  assert.equal(s.state, 'closing', 'the decision rung stays at the fee question');

  // Rung 4 — still refusing: the graceful close, queued.
  s = await send('NE SAKAM DA PLATAM');
  reply = sent[sent.length - 1] ?? '';
  assert.equal(s.state, 'queued', `the 4th nag closes the chat, got ${s.state}`);
  assert.ok(!reply.includes('300 денари') && !reply.includes('500 денари'), `the close re-pitches the fee: ${reply.slice(0, 130)}`);
});

test('e2e 500-ден buy: complaints and "nobody charges" climb the same order as refusals', async () => {
  // The owner's rule: these are NAGS, not free explanations. The buy ladder
  // must not stall on repeated fee.why answers.
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'buy-500-nag-grammar';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  await send('ZDRAVO. ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78');
  await send('DALI E SEUSTE DOSTAPEN ?');
  let s = await send('KONTAKTIRAJTE GO I KAZETE MI');
  assert.ok((sent[sent.length - 1] ?? '').includes('500 денари'), 'buy fee disclosure expected');

  s = await send('MNOGU NEKAKO 500DEN ZA OTVARANJE NA STAN');
  let reply = sent[sent.length - 1] ?? '';
  assert.equal(s.slots.feeRejections, 1, 'the complaint is nag #1');
  assert.ok(reply.includes('500 денари'), `rung 1 must quote the buy fee: ${reply.slice(0, 130)}`);
  assert.ok(!reply.includes('300 денари'), `rent copy leaked into the buy rung: ${reply.slice(0, 130)}`);

  s = await send('NIKOJ NE NAPLATUVA ZA POSETA SAMO KAJ VAS');
  reply = sent[sent.length - 1] ?? '';
  assert.equal(s.slots.feeRejections, 2, 'the universal objection is nag #2');
  assert.ok(/правил|ценовник|политик/iu.test(reply), `rung 2 must be the agency rule: ${reply.slice(0, 130)}`);

  s = await send('PA I TI VAKA RABOTIS. NEMA DA PLATAM');
  reply = sent[sent.length - 1] ?? '';
  assert.equal(s.slots.feeRejections, 3);
  assert.ok(/дали да ја закажам посетата|одлуката е ваша/iu.test(reply), `rung 3 must be the decision: ${reply.slice(0, 130)}`);
  assert.ok(!/име и презиме|телефонски број/iu.test(reply), `contact collection ran on a nag: ${reply.slice(0, 130)}`);
});

test('e2e 500-ден buy ladder parity: same rungs, buy copy at every step', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'buy-500-ladder';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  await send('ZDRAVO. ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78');
  await send('DALI E SEUSTE DOSTAPEN ?');
  let s = await send('KONTAKTIRAJTE GO I KAZETE MI');
  assert.ok((sent[sent.length - 1] ?? '').includes('500 денари'), 'buy fee disclosure expected');

  s = await send('NE SAKAM DA PLATAM');
  let reply = sent[sent.length - 1] ?? '';
  assert.equal(s.slots.feeRejections, 1);
  assert.ok(reply.includes('500 денари') && !reply.includes('300 денари'), `buy persuasion copy: ${reply.slice(0, 130)}`);

  s = await send('NE SAKAM DA PLATAM');
  reply = sent[sent.length - 1] ?? '';
  assert.equal(s.slots.feeRejections, 2);
  assert.ok(/правил|ценовник/iu.test(reply), `buy rung 2 must be the agency rule: ${reply.slice(0, 130)}`);

  s = await send('NEMA DA PLATAM');
  reply = sent[sent.length - 1] ?? '';
  assert.equal(s.slots.feeRejections, 3);
  assert.ok(/дали да ја закажам посетата|одлуката е ваша/iu.test(reply), `buy rung 3 decision: ${reply.slice(0, 130)}`);
  assert.equal(s.state, 'closing', `buy rung 3 stays at the fee question, got ${s.state}`);
  assert.ok(!/име и презиме|телефонски број/iu.test(reply), `contact collection ran on a refusal: ${reply.slice(0, 130)}`);
});

test('e2e 300-ден rent: per-visit fee question, arithmetic and the property rent keep their lanes', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'rent-300-cases';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  await send('ZDRAVO. ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 79');
  await send('DALI E SEUSTE DOSTAPEN ?');

  // (a) The per-visit fee question — the 300 version of "ZA SEKOJ STAN … PO
  // 500DEN?": the rent fee is disclosed and the funnel stays at the fee.
  let s = await send('ZA SEKOJ STAN STO KE GO POSETAM PO 300DEN ?');
  let reply = sent[sent.length - 1] ?? '';
  assert.ok(reply.includes('300 денари'), `per-visit fee answer must quote 300: ${reply.slice(0, 130)}`);
  assert.ok(!reply.includes('500 денари'), `buy copy leaked: ${reply.slice(0, 130)}`);
  assert.equal(s.state, 'closing', 'the per-visit fee question is the fee question');
  assert.equal(s.slots.viewingFeeAgreed, undefined, 'no consent fabricated by a fee question');

  // (b) The rent version of the multi-visit arithmetic (10 × 300) — the fee
  // rationale, never a property search, never cards, never the exhausted nag.
  s = await send('AKO POSETAM 10 STANA TOA SE 3000 DEN OD MOJ DJEB');
  reply = sent[sent.length - 1] ?? '';
  assert.ok(/филт|селекц|вистинск|сериозн|искрен|препознав/iu.test(reply), `not the fee rationale: ${reply.slice(0, 130)}`);
  assert.ok(!reply.includes('м²'), `cards dumped on rent fee math: ${reply.slice(0, 130)}`);
  assert.ok(!reply.includes('300 денари') && !reply.includes('500 денари'), `fee re-disclosed: ${reply.slice(0, 130)}`);
  assert.equal(s.state, 'closing', 'explanation traffic never advances the funnel');
  assert.equal(s.slots.bedrooms, undefined, 'the "10" must not become a criterion');

  // (c) A property-rent question still answers the property rent (250 евра),
  // never the 300-ден visit fee.
  s = await send('KOLKU MU E KIRIJATA?');
  reply = sent[sent.length - 1] ?? '';
  assert.ok(/киријата изнесува 250 евра/iu.test(reply), `the rent answer must survive: ${reply.slice(0, 130)}`);
  assert.ok(!reply.includes('300 денари'), `fee answered a rent question: ${reply.slice(0, 130)}`);
});

// ── 300-ден rent COMMISSION: the second money ladder, isolated from the fee ──
//
// Owner rule: the rent commission (50% of one monthly rent below 1.000 €, one
// full monthly rent from 1.000 € up) gets the SAME four-rung protocol as the
// visit fee — disclose → persuade → agency rules → binary decision → close —
// but it is its OWN topic with its OWN counter: a commission nag must never
// burn a visit-fee rung, and a fee nag must never burn a commission rung.
// A buyer pays 0% commission, so "resistance" there is a misunderstanding
// answered with the 0%-clarification and NO rung.

test('commission resistance detector: the topic decides, never the word "no"', () => {
  // Rent-commission resistance (both scripts, three shapes).
  for (const t of ['50% E MNOGU', 'PROVIZIJATA E PREVISOKA', 'NE SAKAM DA PLATAM PROVIZIJA',
    'нема да платам провизија', 'провизијата е многу висока', 'bez provizija', '50% E SKAPO']) {
    assert.equal(detectProvisionResistance(t), true, `not owned by the commission ladder: ${t}`);
  }
  // VISIT-FEE resistance keeps the fee ladder.
  for (const t of ['MNOGU MI E ZA POSETA', 'NE SAKAM DA PLATAM', '200 E MNOGU ZA POSETA']) {
    assert.equal(detectProvisionResistance(t), false, `commission ladder stole fee traffic: ${t}`);
  }
  // Informational commission questions stay the ask/who lanes.
  assert.equal(detectProvisionResistance('KOLKU E PROVIZIJATA?'), false);
  assert.equal(detectProvisionAsk('KOLKU E PROVIZIJATA?'), true, 'the ask lane owns it');
  // …and the RESISTANCE is never predicted as the ask: the lane prediction is a
  // learning signal, and a refusal logged as "the client asked about the
  // commission" would teach the classifier the opposite of the truth.
  for (const t of ['ПРОВИЗИЈАТА НЕ ЈА ПРИФАЌАМ', 'NE SAKAM PROVIZIJA', 'PROVIZIJATA E PREVISOKA', '50% E MNOGU', 'bez provizija']) {
    assert.equal(detectProvisionAsk(t), false, `a refusal predicted as a provision QUESTION: ${t}`);
  }
  assert.equal(detectProvisionWho('KOJ GI PLAKJA ADVOKAT I NOTAR?'), true);
  assert.equal(detectProvisionWho('КОЈ ГИ ПЛАЌА АДВОКАТ И НОТАР?'), true);
  // A rent-PRICE complaint is not a commission complaint.
  assert.equal(detectProvisionResistance('KIRIJATA E MNOGU'), false);
});

test('provisionLadder: the buy side has nothing to ladder, the rent side has three rungs', () => {
  assert.equal(provisionLadder('buy', 1).rung, 'clarify');
  assert.equal(provisionLadder(undefined, 1).rung, 'clarify');
  assert.equal(provisionLadder('rent', 1).key, 'provision.persuade.1.rent');
  assert.equal(provisionLadder('rent', 2).key, 'provision.rule.hold');
  assert.equal(provisionLadder('rent', 3).key, 'provision.decide');
  assert.equal(provisionLadder('rent', 9).key, 'provision.decide');
  assert.ok(provisionLadder('rent', 1).line.includes('50%'), 'rung 1 restates the tier');
  assert.ok(/ценовник|правил/iu.test(provisionLadder('rent', 2).line), 'rung 2 is the agency rule');
  assert.ok(/дали да продолжиме по наведените услови или не/iu.test(provisionLadder('rent', 3).line), 'rung 3 is the house decision sentence');
  assert.ok(buildProvisionAsk('rent').includes('50%') && buildProvisionAsk('rent').includes('1.000'), 'rent fallback names the tier rule');
  assert.ok(buildProvisionAsk('buy').includes('0%'), 'buy fallback names the 0%');
});

test('commission bank pools: 50% on the persuasion, no figures on the rule, house sentence on the decision', () => {
  const persuade = RESPONSE_BANK['provision.persuade.1.rent'] ?? [];
  const rule = RESPONSE_BANK['provision.rule.hold'] ?? [];
  const decide = RESPONSE_BANK['provision.decide'] ?? [];
  assert.ok(persuade.length >= 3, `persuasion pool too small: ${persuade.length}`);
  assert.ok(rule.length >= 3, `rule pool too small: ${rule.length}`);
  assert.ok(decide.length >= 3, `decision pool too small: ${decide.length}`);
  for (const v of persuade) {
    assert.ok(/50\s*%/iu.test(v), `persuasion misses the tier: ${v}`);
    assert.ok(/\?\s*$/.test(v), `persuasion does not end with the agreement ask: ${v}`);
  }
  for (const v of rule) {
    assert.ok(/(?:правил|ценовник|политик)/iu.test(v), `not the published-rule frame: ${v}`);
    assert.ok(!/\d/.test(v), `rule carries a figure: ${v}`);
  }
  for (const v of decide) {
    assert.ok(v.includes('дали да продолжиме по наведените услови или не? Одлуката е Ваша.'),
      `decision rung must keep the house sentence verbatim: ${v}`);
  }
});

test('e2e rent commission ladder: 4 rungs on the commission counter, the fee counter untouched', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'rent-commission-ladder';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  await send('ZDRAVO. ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 79');
  await send('DALI E SEUSTE DOSTAPEN ?');
  let s = await send('KONTAKTIRAJTE GO I KAZETE MI');
  assert.ok((sent[sent.length - 1] ?? '').includes('300 денари'), 'the visit fee was disclosed first');

  // Rung 1 — ONE persuasion, the commission tier restated.
  s = await send('50% E MNOGU');
  let reply = sent[sent.length - 1] ?? '';
  assert.equal(s.slots.provisionRejections, 1, 'first commission nag is rung 1');
  assert.ok(/50\s*%/iu.test(reply), `commission persuasion must restate the tier: ${reply.slice(0, 130)}`);
  assert.equal(s.slots.feeRejections, undefined, 'the visit-fee counter must not move');
  assert.equal(s.state, 'closing', 'the commission fight stays at the terms');

  // Rung 2 — the AGENCY RULE, amount-free.
  s = await send('PROVIZIJATA E PREVISOKA');
  reply = sent[sent.length - 1] ?? '';
  assert.equal(s.slots.provisionRejections, 2, 'second commission nag is rung 2');
  assert.ok(/(?:правил|ценовник|политик)/iu.test(reply), `not the published-rule answer: ${reply.slice(0, 130)}`);
  assert.equal(s.slots.feeRejections, undefined);

  // Rung 3 — THE DECISION (the house sentence, the same protocol as the fee).
  s = await send('NE SAKAM DA PLATAM PROVIZIJA');
  reply = sent[sent.length - 1] ?? '';
  assert.equal(s.slots.provisionRejections, 3, 'third commission nag is rung 3');
  assert.ok(/дали да продолжиме по наведените услови или не/iu.test(reply), `not the decision rung: ${reply.slice(0, 130)}`);
  assert.ok(!/име и презиме|телефонски број/iu.test(reply), `contact collection ran on a refusal: ${reply.slice(0, 130)}`);
  assert.equal(s.state, 'closing');
  assert.equal(s.slots.feeRejections, undefined);

  // Rung 4 — the graceful close, queued, no pitch.
  s = await send('NEMA DA PLATAM PROVIZIJA');
  reply = sent[sent.length - 1] ?? '';
  assert.equal(s.state, 'queued', `the 4th commission nag closes the chat, got ${s.state}`);
  assert.ok(!reply.includes('?'), `the close asks a question: ${reply.slice(0, 130)}`);
  assert.equal(s.slots.feeRejections, undefined, 'the visit-fee counter still untouched');
});

// Every refusal SHAPE must climb the COMMISSION ladder. The trap this pins:
// "NE SAKAM PROVIZIJA" carries no pay verb (just sakam + the noun), so the
// fee-side negated-pay family cannot see it — before the object arm existed the
// turn fell through to the visit-fee rungs and the client heard the 300-ден
// copy while arguing about the 50% commission.
test('e2e commission refusal shapes: every wording pays the 50% copy, never a fee rung', async () => {
  const shapes = [
    'NE SAKAM PROVIZIJA',
    'NEMA DA PLATAM PROVIZIJA',
    'NE SAKAM DA PLATAM PROVIZIJA',
    'PROVIZIJATA NE JA PLAKJAM',
    'ПРОВИЗИЈАТА НЕ ЈА ПРИФАЌАМ',
    'нема да платам провизија',
  ];
  for (const shape of shapes) {
    const { handler, sessions, sent } = makeHandler();
    const chatId = `shape-${shapes.indexOf(shape)}`;
    const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };
    await send('ZDRAVO. ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 79');
    await send('DALI E SEUSTE DOSTAPEN ?');
    await send('KONTAKTIRAJTE GO I KAZETE MI');
    const feeDisclosure = sent[sent.length - 1] ?? '';
    assert.ok(feeDisclosure.includes('300 денари'), `setup: the RENT fee must be disclosed first (${shape})`);
    const s = await send(shape);
    const reply = sent[sent.length - 1] ?? '';
    assert.equal(s.slots.provisionRejections, 1, `"${shape}" is rung 1 of the commission ladder`);
    assert.equal(s.slots.feeRejections, undefined, `"${shape}" burned a visit-fee rung`);
    assert.ok(/50\s*%/iu.test(reply), `"${shape}" did not hear the commission tier: ${reply.slice(0, 140)}`);
    assert.ok(!/300\s*денари|500\s*денари/iu.test(reply), `"${shape}" was answered with the visit-fee copy: ${reply.slice(0, 140)}`);
    assert.equal(s.state, 'closing', `"${shape}" left the terms state: ${s.state}`);
  }
});

test('e2e isolation: the two ladders count independently, in both orders', async () => {
  // (a) commission nag → then a fee refusal: each gets rung 1 of ITS ladder.
  {
    const { handler, sessions, sent } = makeHandler();
    const chatId = 'isolation-a';
    const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };
    await send('ZDRAVO. ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 79');
    await send('DALI E SEUSTE DOSTAPEN ?');
    await send('KONTAKTIRAJTE GO I KAZETE MI');
    let s = await send('50% E MNOGU');
    assert.equal(s.slots.provisionRejections, 1);
    s = await send('NE SAKAM DA PLATAM');
    assert.equal(s.slots.feeRejections, 1, 'the fee refusal is rung 1 of the FEE ladder');
    assert.equal(s.slots.provisionRejections, 1, 'the commission counter did not move');
    assert.ok((sent[sent.length - 1] ?? '').includes('300 денари'), `fee rung 1 quotes the 300-ден rent fee: ${(sent[sent.length - 1] ?? '').slice(0, 130)}`);
  }
  // (b) fee refusal → then a commission nag: still independent.
  {
    const { handler, sessions } = makeHandler();
    const chatId = 'isolation-b';
    const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };
    await send('ZDRAVO. ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 79');
    await send('DALI E SEUSTE DOSTAPEN ?');
    await send('KONTAKTIRAJTE GO I KAZETE MI');
    let s = await send('NE SAKAM DA PLATAM');
    assert.equal(s.slots.feeRejections, 1);
    s = await send('50% E MNOGU');
    assert.equal(s.slots.provisionRejections, 1, 'the commission nag is rung 1 of the COMMISSION ladder');
    assert.equal(s.slots.feeRejections, 1, 'the fee counter did not move');
  }
});

test('e2e buy: commission resistance is the 0% clarification, never a rung', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'buy-commission';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };
  await send('ZDRAVO. ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78');
  await send('DALI E SEUSTE DOSTAPEN ?');
  await send('KONTAKTIRAJTE GO I KAZETE MI');
  const s = await send('NE SAKAM DA PLATAM PROVIZIJA');
  const reply = sent[sent.length - 1] ?? '';
  assert.ok(/0\s*%/u.test(reply), `the buyer must hear the 0% fact: ${reply.slice(0, 140)}`);
  assert.equal(s.slots.provisionRejections, undefined, 'no commission rung can exist on the buy side');
  assert.equal(s.slots.feeRejections, undefined, 'and no fee rung either');
  assert.equal(s.state, 'closing', 'the terms question stays at the terms');
});

test('e2e commission ask: the tier rule answers, never the bound flat\'s rent', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'rent-commission-ask';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };
  await send('ZDRAVO. ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 79');
  await send('DALI E SEUSTE DOSTAPEN ?');
  await send('KONTAKTIRAJTE GO I KAZETE MI');
  const s = await send('KOLKU E PROVIZIJATA?');
  const reply = sent[sent.length - 1] ?? '';
  assert.ok(/50\s*%/u.test(reply), `the published tier rule must answer: ${reply.slice(0, 140)}`);
  assert.ok(!/киријата изнесува/iu.test(reply), `the flat's rent answered a commission question: ${reply.slice(0, 140)}`);
  assert.equal(s.slots.provisionRejections, undefined, 'an informational ask burns no rung');
  assert.equal(s.slots.feeRejections, undefined);
});

test('bye.again: a SECOND goodbye in one session serves the short parting, not a repeated thank-you', async () => {
  for (const v of (RESPONSE_BANK['bye.again'] ?? [])) {
    assert.ok(!/\?\s*$/.test(v), `bye.again variant ends with a question: ${v}`);
    assert.ok(!/благодарам/iu.test(v), `bye.again variant thanks: ${v}`);
    assert.ok(/пријатно|поздрав|нареден пат/iu.test(v), `bye.again variant not a parting: ${v}`);
  }
  assert.ok(!/благодарам/iu.test(BYE_AGAIN), `BYE_AGAIN thanks: ${BYE_AGAIN}`);

  const { handler, sessions, sent } = makeHandler();
  const chatId = 'v16k11-bye-again';
  const send = async (m: string) => {
    await Promise.race([
      handler.handle('test', chatId, m),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`turn timeout (>10s): ${m.slice(0, 40)}`)), 10_000).unref()),
    ]);
    return sessions.get(chatId)!;
  };

  await send('ZDRAVO');
  await send('ne fala'); // soft refusal → graceful close (the FIRST goodbye)
  const first = sent[sent.length - 1] ?? '';
  assert.ok(/благодар|фала/iu.test(first), `first farewell is not the thank-you family: ${first.slice(0, 90)}`);
  const s = await send('cao'); // the SECOND goodbye → bye.again
  const reply = sent[sent.length - 1] ?? '';
  assert.ok(/пријатно|поздрав|нареден пат/iu.test(reply), `second bye did not serve the short parting: ${reply}`);
  assert.ok(!/благодарам/iu.test(reply), `second bye repeats the thank-you skeleton: ${reply}`);
  assert.ok(!reply.includes('?'), `second bye asks a question: ${reply}`);
  assert.equal(s.slots.byeServed, true, 'flag not persisted');
});
