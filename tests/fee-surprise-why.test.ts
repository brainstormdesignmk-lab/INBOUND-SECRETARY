// The 08:32 transcript regression — the fee-surprise question answered, not re-asked.
//
//   client: KONTAKTIRAJTE GO I KAZETE MI   → fee disclosure (fee.ask.buy)
//   client: OVA E NESTO NOVO ?             → MUST be the fee-why rationale
//                                            (the time-waster filter), never a
//                                            second fee disclosure.
//
// Why it broke: the B/E boundary macros in LOC_CONFIRM_QUESTION_RE were
// (?<!\p{L}\p{N}) — a TWO-char lookbehind matching letter+digit pairs, not a
// negated class. So "NOVO ?" matched the "vo … ?" leg (no letter/digit pair
// directly before "VO"), detectLocationConfirm fired, fsmRequired blocked the
// FEE_SURPRISE fast interceptor, the FSM + classifier tagged INTERESTED, and
// the closing branch re-disclosed fee.ask — answering "is this new?" by
// repeating the fee verbatim.
//
// Context for the business rule: Macedonian agencies usually charge NO visit
// fee, so clients meet the practice for the first time here. The surprise is
// fee-protocol traffic — Lina explains the time-waster-filter rationale and
// re-asks for agreement, never a second copy-paste of the amount.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InboundHandler } from '../src/handlers/inbound';
import { Classifier } from '../src/llm/classify';
import { Responder } from '../src/llm/respond';
import { SessionStore } from '../src/fsm/session';
import { PropertyService } from '../src/data/properties';
import { AppointmentStore } from '../src/store/appointments';
import { EscalationStore } from '../src/store/escalations';
import { MetaStore } from '../src/store/meta';
import { ChannelRegistry } from '../src/channels/types';
import { LandmarkService } from '../src/geo/landmarks';
import { Db } from '../src/store/db';
import { loadConfig } from '../src/config';
import { Property } from '../src/data/properties';
import { RESPONSE_BANK } from '../src/data/responses';
import { setLearnedBank } from '../src/data/responseBank';
import { detectFeeSurprise, detectFeeWhy } from '../src/llm/deterministic';

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

// Every fee.why seed must carry the filter rationale, and the pool must
// include the literal "is this new?" answer (the 08:32 question family).
test('fee.why pool: rationale present + the "is this new?" literal answer', () => {
  const seeds: string[] = RESPONSE_BANK['fee.why'] ?? [];
  assert.ok(seeds.length >= 10, `expected a real pool, got ${seeds.length}`);
  const literal = seeds.find(v => /новост|ново\s+за\s|прв\s*пат/iu.test(v));
  assert.ok(literal, `no "is this new?" literal variant in fee.why:\n${seeds.join('\n')}`);
  for (const v of seeds) {
    assert.ok(/филт|селекци|издвој|препознаваме|луѓето со вистински/iu.test(v), `no filter rationale: ${v}`);
  }
});

test('08:32 flow: fee ask → "OVA E NESTO NOVO ?" → fee.why, never a second disclosure', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'nesto-novo';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // Client names the property, asks availability (arms ownerContactPending),
  // then orders the contact → fee disclosure (the 12:51 flow).
  let s = await send('ZDRAVO. ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78');
  s = await send('DALI E SEUSTE DOSTAPEN ?');
  assert.ok(s.slots.ownerContactPending, 'availability ack must arm ownerContactPending');
  s = await send('KONTAKTIRAJTE GO I KAZETE MI');
  assert.equal(s.state, 'closing', 'contact order must land in closing');
  const feeAsk = sent[sent.length - 1] ?? '';
  assert.ok(feeAsk.includes('500 денари'), `expected fee disclosure, got: ${feeAsk}`);

  // The surprise question.
  assert.equal(detectFeeSurprise('OVA E NESTO NOVO ?'), true);
  s = await send('OVA E NESTO NOVO ?');

  const reply = sent[sent.length - 1] ?? '';
  // NEVER a second fee disclosure: the amount was already on the table.
  assert.ok(!reply.includes('500 денари') && !reply.includes('10 евра'),
    `fee-surprise re-disclosed the fee: ${reply}`);
  // It must be the RATIONALE (filter for real clients / time-wasters).
  // Covers ALL fee.why variants: most say филтер/филтрирање (v10 is
  // "филтрирање" — no "е" after филтр), селективност (v10 — "т" where
  // селекци needs "ц"), or the искрен-interest line.
  // "правиме СЕЛЕКЦИЈА и ги препознаваме клиентите со реални намери" (the one
  // bank variant) carries none of the other stems — pickVariant serves the
  // bank at RANDOM, so missing it made this test fail ~1 run in 17. The word is
  // the same rationale, so селекц belongs in the guard.
  assert.ok(/филт|селект|селекц|вистинск|сериозн|искрен/iu.test(reply), `no rationale in reply: ${reply}`);
  // Funnel keeps moving: still in closing, waiting for the fee agreement.
  assert.equal(s.state, 'closing');
});

// The [02:34] transcript regression — the BARE noun-phrase form of the same
// surprise: no "ova e", no "nesto" — only "nova praksa nekoja [?]". With the
// old FEE_SURPRISE_RE nothing fired, the closing stall served the provision
// BUY pitch ("немателитe трошоци за провизија 0%… Дали се согласувате") — a
// re-ask of the very condition the client was questioning, the opposite turn.
test('02:34 flow: fee ask → "nova praksa nekoja" → fee.why, never the closing re-ask', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'nova-praksa';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  let s = await send('ZDRAVO. ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78');
  s = await send('DALI E SEUSTE DOSTAPEN ?');
  s = await send('KONTAKTIRAJTE GO I KAZETE MI');
  assert.equal(s.state, 'closing', 'contact order must land in closing');
  const feeAsk = sent[sent.length - 1] ?? '';
  assert.ok(feeAsk.includes('500 денари'), `expected fee disclosure, got: ${feeAsk}`);

  // The verbatim [02:34] row + scripts/spellings/typos of the same reaction
  // (the sweep found no other bare-family misses in 14k routed turns; the
  // pravka/praktika rows are the colloquial spellings clients type).
  for (const t of [
    'nova praksa nekoja', 'NOVA PRAKSA?!', 'нова пракса', 'ova e nova praksa',
    'nova pravka', 'nova praktika', 'нова правка',
  ]) {
    assert.equal(detectFeeSurprise(t), true, `surprise lost on: ${t}`);
  }
  // contract exists — "imate nesto novo vo karpos?" is a search, not a fee).
  for (const t of ['imate nesto novo vo karpos?', 'dajte mi nesto novo']) {
    assert.equal(detectFeeSurprise(t), false, `surprise claimed a property ask: ${t}`);
  }

  s = await send('nova praksa nekoja');
  const reply = sent[sent.length - 1] ?? '';
  assert.ok(!reply.includes('500 денари') && !reply.includes('10 евра'),
    `nova-praksa served a second fee disclosure: ${reply}`);
  assert.ok(/филт|селект|селекц|вистинск|сериозн|искрен/iu.test(reply),
    `no filter rationale in reply: ${reply}`);
  assert.equal(s.state, 'closing');
});

// The [02:4x] ZOSKA row, replayed through the live closing-state funnel:
// "zoska 500 denari ?" — the why-word + a fee-sized money figure, no visit
// noun, no charge verb — must be the RATIONALE serve (feeWhyFast → fee.why),
// never a second disclosure, never a re-ask of consent.
test('02:4x flow: fee ask → "zoska 500 denari ?" → fee.why, never a re-disclosure', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'zoska-fee-amount';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  let s = await send('ZDRAVO. ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78');
  s = await send('DALI E SEUSTE DOSTAPEN ?');
  s = await send('KONTAKTIRAJTE GO I KAZETE MI');
  assert.equal(s.state, 'closing', 'contact order must land in closing');
  const feeAsk = sent[sent.length - 1] ?? '';
  assert.ok(feeAsk.includes('500 денари'), `expected fee disclosure, got: ${feeAsk}`);

  assert.equal(detectFeeWhy('zoska 500 denari ?'), true);
  s = await send('zoska 500 denari ?');
  const reply = sent[sent.length - 1] ?? '';
  assert.ok(!reply.includes('500 денари') && !reply.includes('10 евра'),
    `zoska row re-disclosed the fee: ${reply}`);
  assert.ok(/филт|селект|селекц|вистинск|сериозн|искрен/iu.test(reply),
    `no filter rationale in reply: ${reply}`);
  assert.equal(s.state, 'closing');
});

// The [01:23] transcript regression — the FEE-EXISTENCE question served the
// fee.ask pool a SECOND time ("Прекрасен избор! Сакам да Ве информирам дека…
// 500 денари (10 евра)… Дали се согласувате…"), repeating the intro verbatim.
//   client: KONTAKTIRAJTE GO I KAZETE MI   → fee disclosure
//           (property_locate → closing)
//   client: IMATE NEKAKVA TAKSA ZA POSETA ? → MUST be the rationale, never a
//           second disclosure / consent re-ask. The client has not parsed the
//           intro as a fee — the HAVE-word + fee-noun frame is explanation
//           traffic (detectFeeWhy → isFeeWhyExistFrame), same family as the
//           08:32 / 02:34 / 02:4x why-questions.
test('01:23 flow: fee ask → "IMATE NEKAKVA TAKSA ZA POSETA ?" → fee.why, never a second intro', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'imate-taksa';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  let s = await send('ZDRAVO. ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78');
  s = await send('DALI E SEUSTE DOSTAPEN ?');
  s = await send('KONTAKTIRAJTE GO I KAZETE MI');
  assert.equal(s.state, 'closing', 'contact order must land in closing');
  const feeAsk = sent[sent.length - 1] ?? '';
  assert.ok(feeAsk.includes('500 денари'), `expected fee disclosure, got: ${feeAsk}`);

  // Verbatim [01:23] row + the existence-question family.
  for (const t of [
    'IMATE NEKAKVA TAKSA ZA POSETA ?',
    'dali ima taksa za poseta?', 'има ли надоместок за посета?',
    'imate li taksa uste?', 'treba nekakva taksa?',
  ]) {
    assert.equal(detectFeeWhy(t), true, `existence question lost: ${t}`);
  }
  // Amount asks (what IS the fee) and refusals keep their own lanes.
  assert.equal(detectFeeWhy('kolku e taksa za poseta?'), false,
    'the kolku amount ask belongs to the fee-amount lane');
  assert.equal(detectFeeWhy('ne treba taksa'), false,
    '"ne treba" is refusal traffic (fee-nag ladder), not fee.why');

  s = await send('IMATE NEKAKVA TAKSA ZA POSETA ?');
  const reply = sent[sent.length - 1] ?? '';
  // The re-disclosure regression: the fee.ask pool served the SAME intro a
  // second time (the [01:23] verbatim repeat).
  assert.ok(!reply.includes('500 денари') && !reply.includes('10 евра'),
    `existence question re-disclosed the fee: ${reply}`);
  assert.ok(/филт|селект|селекц|вистинск|сериозн|искрен/iu.test(reply),
    `no filter rationale in reply: ${reply}`);
  assert.equal(s.state, 'closing');
});
