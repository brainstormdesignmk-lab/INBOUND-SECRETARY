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
  detectFeePaymentAgreement, detectNegatedFeePay, detectFeeRules, detectFeeTotalCost,
} from '../src/llm/deterministic';
import { buildFeeAsk, feePersuasion, buildFeeRules } from '../src/llm/prompts';

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
