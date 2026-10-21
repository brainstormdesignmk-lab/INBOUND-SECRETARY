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
import * as fs from 'node:fs';
import * as path from 'node:path';
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
  detectNegatedFeePay, detectFeeComplaint, detectFeeRules, detectFeeNag,
  detectFeePaymentAgreement, detectWhereIs, isWhereLandmarkQuestion, isFeeTraffic,
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

/** The 300-ден market: one rent row, so every ladder assertion can run for BOTH
 *  services (the owner's rule: the planned order is the same for buy and rent). */
const RENT_ROWS: Property[] = [
  { eb: 79, id: 79, location: 'Водно', price: 300, service: 'rent', bedrooms: 2, size: '35 м²', address: 'Клиника' },
];

function makeHandler(rows: Property[] = ROWS): { handler: InboundHandler; sessions: SessionStore; sent: string[] } {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(rows);
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

const PERSUADE_POOL_RENT: string[] = RESPONSE_BANK['fee.persuade.1.rent'] ?? [];

const inAskPool = (r: string) => ASK_POOL_BUY.includes(r.trim());
const inPersuadePool = (r: string) => PERSUADE_POOL_BUY.includes(r.trim());
const inRentPersuadePool = (r: string) => PERSUADE_POOL_RENT.includes(r.trim());
const inRulePool = (r: string) => RULE_POOL.includes(r.trim());
const inDecidePool = (r: string) => DECIDE_POOL.includes(r.trim());
// The graceful close is a POOL whose variants do not share one closing word
// (two are "Благодарам"-only) — assert membership, plus the contract that the
// bye protocol asks nothing. Pinning wording made the check depend on which
// variant the rotation served that run.
const isGracefulClose = (r: string) => GRACEFUL_POOL.includes(r.trim()) && !r.includes('?');

// ── Detector pins ────────────────────────────────────────────────────────────

test('charge-pushback family: "pari za poseta barate" / "zemate pari za poseta" — never a why-question or a refusal', () => {
  assert.equal(detectFeeChargePushback('PARI ZA POSETA BARATE'), true, 'the live burst (both scripts, statement shape)');
  assert.equal(detectFeeChargePushback('pari za poseta barate'), true, 'Latin');
  assert.equal(detectFeeChargePushback('uste mi barate pari'), true, 'repeated charge accusation');
  assert.equal(detectFeeChargePushback('SE USTE MI BARATE PARI'), true, 'caps');
  assert.equal(detectFeeChargePushback('барате пари за посета'), true, 'Cyrillic demand verb');
  // CHANGED CONTRACT (the 300-ден capture): a charge verb whose OBJECT is the
  // VISIT is the visit-fee lane, not the commission ask. The old pin sent
  // "PARI ZEMATE ZA POSETA ?" to provision.ask.rent while the visit fee was on
  // the table, so the rent ladder never ran and the funnel jumped to contact
  // collection. detectProvisionAsk stays true (it is still a fee question);
  // the charge-pushback owns the RESISTANCE reading of the same words.
  assert.equal(detectFeeChargePushback('земате пари за посета'), true, 'visit-object charge = fee resistance');
  assert.equal(detectProvisionAsk('земате пари за посета'), true, 'and it is still a fee question');
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

test('fee-nag grammar: paraphrases in both scripts climb the same ladder (families, not phrases)', () => {
  // The client never quotes our bank. Each family below is matched by stems +
  // any inflection after normalizeMc (Latin→Cyrillic), so word order, clitics
  // and script do not matter.
  const nags = [
    // 1 · negated pay/accept
    'НЕ ПЛАЌАМ ЗА ПОСЕТА', 'нема да платам за гледање', 'никогаш не сум платил за посета',
    'не прифаќам надомест', 'NE SAKAM DA PLATAM', 'ne platam za poseta',
    // 2 · charge + object, both orders, money optional
    'PARI ZA POSETA', 'PARI ZEMATE ZA POSETA ?', 'ZEMATE PARI ZA POSETA?',
    'само вие барате пари за посета', 'nemam pari za poseta',
    // 3 · universal/comparative
    'NIKOJ NE NAPLATUVA ZA POSETA SAMO KAJ VAS VAKVI GLUPOSTI',
    'кај другите агенции не се плаќа за гледање',
    // 4 · value complaint
    'MNOGU NEKAKO 500DEN ZA OTVARANJE NA STAN', '300 денари се премногу за посета',
    'не ми е во ред да плаќам за посета', 'gluposti se ovie, samo vie zemate pari',
    // 5 · hesitation / non-acceptance (the [22:0x] rule: non-positive climbs).
    //     CHANGED CONTRACT: "ne znam dali da platam" was on the owner's
    //     NOT-a-nag list; the classifier's FEE_REFUSED ladder burned a rung for
    //     it anyway, and the owner's later rule is that every non-positive
    //     message follows the order to the end. The predicate now agrees with
    //     the ladder (rung 1's copy ends with the ask that doubt needs).
    'NEZNAM', 'OVA NE GO OCEKUVAV', 'ne sum siguren', 'se mislam', 'не го очекував',
    'ne znam dali da platam',
    // 6 · the accusation with a TRAILING why (the [22:02] burst: the client
    //     names the money as the object of the complaint, then appends "why")
    'PARI ZA POSETA ZEMATE ? ZOSTO?', 'не ви е во ред, пари за посета земате зошто',
    // 7 · practice disapproval — the FEE MODEL rejected, not a property
    //     ([23:12] in the field; the deployed session answered this turn with
    //     rung 2's copy, so the ladder already owned it there.)
    'NE MI SE DOPAGJA VAKOV PRINCIP NA RABOTA', 'не ми се допаѓа вашиот пристап',
    'не ми е ок оваа политика', 'ne mi se svigja vashiot nacin na rabota',
  ];
  for (const t of nags) assert.equal(detectFeeNag(t), true, `nag not recognised: ${t}`);
  // Consent, a neutral amount/how-much ask, a neutral why-question, the
  // surprise reaction and non-fee traffic are NOT resistance — they keep their
  // own lanes. The scheduling/location hesitations are listed LAST: they are
  // doubt-shaped but they are not about the fee.
  const notNags = [
    'ne znam koga ke mozam', 'не знам утре дали можам',
    'не знам дали во 18:00 ми одговара', 'ne znam kade e stanot',
    'ke platam 300 den za poseta', 'SE SOGLASUVAM', '500DEN ZA POSETA ?',
    'kolku e za poseta?', 'KOLKU E ZA POSETA?', 'zosto naplakjate?', 'ЗОШТО НАПЛАЌАТЕ?',
    'OVA PRV PAT SLUSAM', 'baram stan do 60000 evra',
    'DALI E SEUSTE DOSTAPEN?', 'SAKAM DA IZNAJMAM STAN VO CENTAR',
    // "zosto" is typed z-o-s-t-o → normalised "зосто"; the neutral-ask guard
    // must recognise it or a genuine why-question burns a rung.
    'zosto naplatuvate poseta ?', 'ЗОШТО НАПЛАТУВАТЕ ПОСЕТА ?',
    // Surprise alone is a REACTION, not resistance — it keeps the fee.why lane.
    'OVA E NESTO NOVO ?',
    // A dislike with NO policy noun is about a PROPERTY (or the flat's price)
    // and must never burn a fee rung; a policy ASSERTION is the explanation lane.
    'ne mi se dopagja stanot', 'не ми се допаѓа локацијата',
    'тоа се правилата на агенцијата кои важат и за мене и за Вас',
  ];
  for (const t of notNags) assert.equal(detectFeeNag(t), false, `false positive: ${t}`);
});

test('fee-nag value class: captured dismissals drive the word class (fixtures, not inline phrases)', () => {
  // The VALUE complaint is a word class (grammar.ts, buildFeeValueComplaintSlots),
  // so a dialect a capture surfaces is one entry there — the predicate and both
  // ladder callers inherit it with no new branch. The CAPTURES live in
  // tests/fixtures/fee-dialect-captures.json: a new transcript is appended
  // there, never encoded into this test. `source=field` entries are real
  // transcript lines (the id is the time); `source=coverage` entries pin the
  // class while a field capture is still missing. Both are asserted the same
  // way, so the word class cannot drift from the transcripts.
  const fixturePath = path.join(__dirname, 'fixtures', 'fee-dialect-captures.json');
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
    version: string;
    captures: Array<{ id: string; source: string; text: string; expect: string; why: string }>;
  };
  assert.equal(fixture.version, 'fee-dialect-v1');
  assert.ok(fixture.captures.length > 0, 'the capture fixture is empty');
  for (const c of fixture.captures) {
    // SCHEMA: every capture declares provenance and a reason, so a future
    // entry cannot be a bare phrase with no story behind it.
    assert.match(c.id, /\S/, 'capture id is required');
    assert.ok(['field', 'coverage'].includes(c.source), `${c.id}: source must be field|coverage`);
    assert.ok(['nag', 'not-nag'].includes(c.expect), `${c.id}: expect must be nag|not-nag`);
    assert.match(c.why, /\S/, `${c.id}: say WHY this capture exists`);
    const want = c.expect === 'nag';
    assert.equal(detectFeeNag(c.text), want, `${c.id} (${c.source}) → expected ${c.expect}: ${c.text}`);
  }
  // The fixture must stay a mix: a field transcript set with no coverage would
  // mean the class was never pinned ahead of the field, and vice versa.
  assert.ok(fixture.captures.some(c => c.source === 'field'), 'no field captures in the fixture');
  assert.ok(fixture.captures.some(c => c.source === 'coverage'), 'no coverage entries in the fixture');

  // The dialect NEGATOR is a consent bug, not just a nag: the standalone
  // "платам" arm must not read it as the yes.
  assert.equal(detectFeeNag('NEKJAM DA PLATAM'), true);
  assert.equal(detectFeePaymentAgreement('NEKJAM DA PLATAM'), false, 'a dialect refusal is never consent');
  assert.equal(detectNegatedFeePay('NEKJAM DA PLATAM'), true, 'and it is the negated-pay family');
});

test('[22:02] the why-word decides the lane by POSITION: leading = the rationale, trailing = resistance', () => {
  // The [22:02] field burst: the accusation comes first and "ZOSTO?" is its
  // tail, so the client is NOT asking for a rationale — he objects. Before
  // this, the why-family veto sent it to fee.why without burning a rung, and
  // the ladder never moved.
  assert.equal(detectFeeNag('PARI ZA POSETA ZEMATE ? ZOSTO?'), true, 'accusation + trailing why = nag');
  assert.equal(detectFeeChargePushback('PARI ZA POSETA ZEMATE ? ZOSTO?'), true, 'the accusation owns it');
  // …while a why-word that LEADS is the explanation lane (fee.why owns it and
  // no rung is burned — the owner's original rule for "zosto naplakjate?")
  assert.equal(detectFeeNag('ZOSTO BARATE PARI ZA POSETA ?'), false, 'leading why = question');
  assert.equal(detectFeeChargePushback('ZOSTO BARATE PARI ZA POSETA ?'), false, 'no accusation to own');
  assert.equal(detectFeeWhy('ZOSTO BARATE PARI ZA POSETA ?'), true, 'and fee.why serves it');
  assert.equal(detectFeeNag('zosto naplatuvate poseta ?'), false, 'the same rule for the charge verb alone');
  // The hesitation family answers to the same rule, but it must never hijack a
  // scheduling or location question: those are not about the fee.
  for (const t of ['NEZNAM', 'OVA NE GO OCEKUVAV', 'ne sum siguren', 'se mislam']) {
    assert.equal(detectFeeNag(t), true, `hesitation must climb: ${t}`);
  }
  for (const t of ['ne znam koga ke mozam', 'не знам утре дали можам', 'ne znam kade e stanot']) {
    assert.equal(detectFeeNag(t), false, `not fee hesitation: ${t}`);
  }
  // …and a hesitation is never FEE TRAFFIC (the location lanes stay open).
  assert.equal(isFeeTraffic('NEZNAM'), false, 'bare hesitation is not fee traffic');
  assert.equal(isFeeTraffic('ne znam kade e stanot'), false, 'nor is a location ask');
  assert.ok(detectWhereIs('ne znam kade e stanot'), 'the where-is lane still resolves it');
});

test('[22:03] rhetorical challenge: "KAJ SE VIDELO PARI ZA OTVARANJE STAN" is a nag — and NEVER a place question', () => {
  // The capture: the client denies the fee exists and demands its source, and
  // the where-is lane answered with a landmark + a maps pin for a place nobody
  // asked about. Both halves are pinned here: the message IS resistance, and
  // the location lanes stand down on fee traffic.
  const challenges = [
    'KAJ SE VIDELO PARI ZA OTVARANJE STAN', 'KAJ SE VIDELO PARI ZA OTVARANJE NA STAN',
    'kaj se videlo pari za otvaranje stan', 'каде се видело пари за отворање стан',
    'KADE PISE DEKA SE PLATKA ZA POSETA', 'kade pisuva deka se plakja za poseta',
    'OD KADE PARI ZA POSETA', 'од каде пари за гледање',
    'каде си видел такса за посета',
    // money noun + viewing noun with no charge verb at all (the family fix in
    // the accusation arm: отварање/гледање/влезница beside "pari")
    'PARI ZA OTVARANJE STAN', 'pari za gledanje?',
  ];
  for (const t of challenges) assert.equal(detectFeeNag(t), true, `challenge not recognised: ${t}`);
  for (const t of challenges) assert.equal(isFeeTraffic(t), true, `not fee traffic: ${t}`);
  // The location lanes must not touch fee traffic (the [22:03] map-pin bug).
  assert.equal(detectWhereIs('KAJ SE VIDELO PARI ZA OTVARANJE STAN'), undefined, 'no place to strip out of a fee challenge');
  assert.equal(isWhereLandmarkQuestion('KAJ SE VIDELO PARI ZA OTVARANJE STAN'), false, 'never a landmark question');
  assert.equal(isWhereLandmarkQuestion('KADE PISE DEKA SE PLATKA ZA POSETA'), false, 'nor this one');
  // …while a genuine place question is untouched (the veto is fee-scoped).
  assert.ok(detectWhereIs('KADE SE NAOGJA GEOLOSKI ZAVOD?'), 'a real where-is still resolves');
  assert.equal(isWhereLandmarkQuestion('KADE TI E TOA 26 JULI TC ?'), true, 'and so does a landmark probe');
  assert.equal(detectWhereIs('kade e stanot?')?.generic, true, 'and the property where-is');
  assert.equal(isFeeTraffic('kade e stanot?'), false, 'a plain location ask is not fee traffic');
  assert.equal(isFeeTraffic('kolku e kirijata za stanot?'), false, 'nor is a rent question');
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

test('e2e [23:12]: the field burst climbs persuasion → rule → DECISION, never a cheaper-property pivot', async () => {
  // The live capture: after the fee ladder had served the persuasion, the client
  // said "NE MI SE DOPAGJA VAKOV PRINCIP NA RABOTA" (the agency rule's copy) and
  // then "SKAPO E TOA . ZA SEKOJ STAN PO 300DEN" — and the reply PIVOTED to a
  // cheaper-property pair (EB 56 + EB 42) instead of finishing the order with
  // the binary question the owner expects: book or not, your call.
  const { handler, sessions, sent } = makeHandler(RENT_ROWS);
  const chatId = 'field-2312';
  const send = async (m: string) => {
    await Promise.race([
      handler.handle('test', chatId, m),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`turn timeout (>10s): ${m.slice(0, 40)}`)), 10_000).unref()),
    ]);
    return { s: sessions.get(chatId)!, reply: sent[sent.length - 1] ?? '' };
  };

  await send('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 79');
  let r = await send('SAKAM VIZITA DA SE DOGOVORI');
  assert.equal(r.s.state, 'closing');
  assert.ok(r.reply.includes('300 денари'), `the rent disclosure comes first: ${r.reply.slice(0, 90)}`);

  r = await send('VIE STE PRVA AGENCIJA STO NAPLAKJA ZA POSETA');
  assert.equal(r.s.slots.feeRejections, 1, 'rung 1 = one persuasion');
  assert.ok(inRentPersuadePool(r.reply), `rung 1 is the persuasion: ${r.reply.slice(0, 90)}`);

  r = await send('NE MI SE DOPAGJA VAKOV PRINCIP NA RABOTA');
  assert.equal(r.s.slots.feeRejections, 2, 'disapproving the way the agency works is rung 2, not an explanation');
  assert.equal(r.s.state, 'closing', 'still at the fee question');
  assert.ok(inRulePool(r.reply), `rung 2 is the agency rule: ${r.reply.slice(0, 90)}`);

  r = await send('SKAPO E TOA . ZA SEKOJ STAN PO 300DEN');
  assert.equal(r.s.slots.feeRejections, 3, 'the price objection closes the ladder');
  assert.equal(r.s.state, 'closing');
  assert.ok(inDecidePool(r.reply), `rung 3 is the DECISION, not a pivot: ${r.reply.slice(0, 120)}`);
  assert.ok(/дали да ја закажам посетата/iu.test(r.reply), `the client gets the binary question: ${r.reply.slice(0, 120)}`);
  assert.ok(/Одлуката е Ваша/iu.test(r.reply), `and owns the decision: ${r.reply.slice(0, 120)}`);
  // The regression itself: no property card and no cheaper-search intro.
  assert.ok(!/Евидентен број \d+/u.test(r.reply), `a fee nag must never serve a property: ${r.reply.slice(0, 160)}`);
  assert.ok(!/најпристапно|најмногу одговара на Вашите барања/iu.test(r.reply),
    `a fee nag must never open a cheaper search: ${r.reply.slice(0, 160)}`);
  assert.equal(r.s.slots.budget, undefined, 'the fee amount never lands as a budget');
});

test('[10:25] "PROMENETE GI PRAVILATA" is a nag — a rules/terms QUESTION is not', () => {
  // The field burst: the client tells the agency to rewrite its rules. That is
  // resistance (the practice-disapproval family in imperative shape), so the
  // ladder must climb; asking WHAT the rules are stays explanation traffic.
  assert.equal(detectFeeNag('PA PROMENETE GI PRAVILATA ZOSTO OVA STVARNO NE E NORMALNO'), true, 'the live burst');
  assert.equal(detectFeeNag('PROMENETE GI PRAVILATA'), true, 'bare demand');
  assert.equal(detectFeeNag('SMENETE GI USLOVITE'), true, 'terms demand');
  assert.equal(detectFeeNag('PRAVILATA DA GI PROMENITE'), true, 'reversed word order');
  assert.equal(detectFeeNag('KOI SE VASITE PRAVILA?'), false, 'asking what the rules are is the fee.rules lane');
  assert.equal(detectFeeNag('KAKVI SE USLOVITE ZA IZNAJMUVANJE?'), false, 'a terms question is not a demand');
  assert.equal(detectFeeNag('PROMENETE JA CENATA'), false, 'a price change stays with the negotiation lanes');
  assert.equal(detectFeeNag('SAKAM DA PROMENAM STANOT'), false, 'a property change is never fee traffic');
  assert.equal(detectFeeNag('DALI MOZE DA JA SMENIME CENATA?'), false, 'a price question is not a rules demand');
});

test('e2e [10:23–10:25]: the third nag reaches the BINARY DECISION, never a typed-search miss', async () => {
  // The live transcript: persuade → agency rule → and then the client demands
  // the rules be changed. Before this fix the third message matched no fee
  // lane, the classifier read it as criteria traffic, and the answer was
  // "Во моментов немам куќа во Центар што одговара на Вашите барања" — a
  // property miss served in the middle of a fee fight, with the decision
  // question the owner expects never asked.
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'field-1025';
  const send = async (m: string) => {
    await Promise.race([
      handler.handle('test', chatId, m),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`turn timeout (>10s): ${m.slice(0, 40)}`)), 10_000).unref()),
    ]);
    return { s: sessions.get(chatId)!, reply: sent[sent.length - 1] ?? '' };
  };

  await send('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78');
  let r = await send('SAKAM DA JA VIDAM');
  assert.equal(r.s.state, 'closing');
  assert.ok(inAskPool(r.reply), `the disclosure comes first: ${r.reply.slice(0, 90)}`);

  r = await send('NE SAKAM DA PLAKJAM ZA POSETI');
  assert.equal(r.s.slots.feeRejections, 1, 'rung 1 = the one persuasion');
  assert.ok(inPersuadePool(r.reply), `rung 1 is the persuasion: ${r.reply.slice(0, 90)}`);

  r = await send('KAKO MOZE DA ZEMATE PARI ZA POKAZUVANJE NA IMOTI?');
  assert.equal(r.s.slots.feeRejections, 2, 'rung 2 = the agency rule');
  assert.ok(inRulePool(r.reply), `rung 2 is the agency rule: ${r.reply.slice(0, 90)}`);

  r = await send('PA PROMENETE GI PRAVILATA ZOSTO OVA STVARNO NE E NORMALNO');
  assert.equal(r.s.slots.feeRejections, 3, 'the third nag is the decision rung');
  assert.equal(r.s.state, 'closing', 'still at the fee question');
  assert.ok(inDecidePool(r.reply), `rung 3 is the DECISION: ${r.reply.slice(0, 120)}`);
  assert.ok(/Одлуката е Ваша/iu.test(r.reply), `the client owns the yes/no: ${r.reply.slice(0, 120)}`);
  // The regression itself: no property-search answer in a fee fight.
  assert.ok(!/немам (?:куќа|стан|деловен)|одговара на Вашите барања/iu.test(r.reply),
    `never a typed-search miss: ${r.reply.slice(0, 160)}`);
  assert.ok(!/Евидентен број \d+/u.test(r.reply), `never a property card: ${r.reply.slice(0, 160)}`);
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

// ── E2E — the [22:0x] field chain, on BOTH ladders (buy + rent) ─────────────

interface ServiceCase {
  label: string; eb: number; fee: string; askPool: string[]; persuadePool: string[];
  rows: Property[];
}
const SERVICE_CASES: ServiceCase[] = [
  { label: 'buy (500)', eb: 78, fee: '500 денари', rows: ROWS,
    askPool: RESPONSE_BANK['fee.ask.buy'] ?? [], persuadePool: RESPONSE_BANK['fee.persuade.1.buy'] ?? [] },
  { label: 'rent (300)', eb: 79, fee: '300 денари', rows: RENT_ROWS,
    askPool: RESPONSE_BANK['fee.ask.rent'] ?? [], persuadePool: RESPONSE_BANK['fee.persuade.1.rent'] ?? [] },
];

function makeSender(rows: Property[], chatId: string) {
  const { handler, sessions, sent } = makeHandler(rows);
  const send = async (m: string) => {
    await Promise.race([
      handler.handle('test', chatId, m),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`turn timeout (>10s): ${m.slice(0, 40)}`)), 10_000).unref()),
    ]);
    return { s: sessions.get(chatId)!, reply: sent[sent.length - 1] ?? '' };
  };
  return send;
}

for (const c of SERVICE_CASES) {
  test(`e2e [22:02–22:03] ${c.label}: the whole field burst climbs the planned order to its END`, async () => {
    const send = makeSender(c.rows, `chain-${c.eb}`);
    await send(`ZAINTERESIRAN SUM ZA EVIDENTEN BROJ ${c.eb}`);
    let { s, reply } = await send('SAKAM VIZITA DA SE DOGOVORI');
    assert.equal(s.state, 'closing');
    assert.ok(c.askPool.includes(reply.trim()), `the disclosure comes first: ${reply.slice(0, 90)}`);
    assert.equal(s.slots.feeRejections, undefined, 'the disclosure is not a rung');

    // [22:02] the accusation with the trailing why → rung 1 (one persuasion,
    // never a second disclosure)
    ({ s, reply } = await send('PARI ZA POSETA ZEMATE ? ZOSTO?'));
    assert.equal(s.slots.feeRejections, 1, 'the accusation burns exactly one rung');
    assert.ok(c.persuadePool.includes(reply.trim()), `rung 1 is the persuasion: ${reply.slice(0, 90)}`);
    assert.ok(reply.includes(c.fee), `it names the sanctioned fee (${c.fee}): ${reply.slice(0, 90)}`);
    assert.ok(!c.askPool.includes(reply.trim()), `never a re-disclosure: ${reply.slice(0, 90)}`);

    // [22:03] hesitation + "every agency does visits for free" → rung 2 = the
    // agency rule (amount-free: the fee was already disclosed)
    ({ s, reply } = await send('NEZNAM , OVA NE GO OCEKUVAV . SITE AGENCII PRAVAT POSETI BESPLATNO'));
    assert.equal(s.slots.feeRejections, 2, 'the universal complaint is rung 2');
    assert.ok(RULE_POOL.includes(reply.trim()), `rung 2 is the agency rule: ${reply.slice(0, 90)}`);
    assert.ok(!/\d/.test(reply), `the rule rung carries no figure: ${reply.slice(0, 90)}`);

    // [22:03] the каде challenge → rung 3 = the decision, NEVER a location
    ({ s, reply } = await send('KAJ SE VIDELO PARI ZA OTVARANJE STAN'));
    assert.equal(s.slots.feeRejections, 3, 'the challenge is rung 3');
    assert.ok(DECIDE_POOL.includes(reply.trim()), `rung 3 is the decision: ${reply.slice(0, 90)}`);
    assert.ok(/Одлуката е Ваша/iu.test(reply), `the decision belongs to the client: ${reply.slice(0, 90)}`);
    assert.ok(!/во близина на|maps\.google|https?:\/\//iu.test(reply), `never a location: ${reply.slice(0, 90)}`);

    // Still not positive → the order ENDS: graceful close + the chat queued
    ({ s, reply } = await send('NE SAKAM DA PLATAM ZA POSETA'));
    assert.equal(s.slots.feeRejections, 4, 'the fourth nag is the last rung');
    assert.equal(s.state, 'queued', 'the bye protocol queues the chat');
    assert.ok(isGracefulClose(reply), `the graceful close: ${reply.slice(0, 120)}`);
    assert.ok(!/филтер|ценовник|Одлуката е Ваша/iu.test(reply), `no fifth rung: ${reply.slice(0, 120)}`);
  });

  test(`e2e ${c.label}: a POSITIVE mid-order proceeds to info collecting`, async () => {
    const send = makeSender(c.rows, `positive-${c.eb}`);
    await send(`ZAINTERESIRAN SUM ZA EVIDENTEN BROJ ${c.eb}`);
    await send('SAKAM VIZITA DA SE DOGOVORI');
    let { s, reply } = await send('PARI ZA POSETA ZEMATE ? ZOSTO?');   // rung 1
    assert.equal(s.slots.feeRejections, 1);
    assert.ok(c.persuadePool.includes(reply.trim()), reply.slice(0, 90));

    // The client accepts MID-LADDER: the fee is settled and the workflow moves
    // on to contact collection — never another rung.
    ({ s, reply } = await send('DOBRO, SE SOGLASUVAM SO USLOVITE'));
    assert.equal(s.state, 'contact_collection', `the workflow continues: ${s.state}`);
    assert.equal(s.slots.viewingFeeAgreed, true, 'and the fee is settled');
    assert.equal(s.slots.feeRejections, 1, 'a positive never burns a rung');
    assert.ok(/име|презиме|телефон/iu.test(reply), `the contact ask follows: ${reply.slice(0, 90)}`);
  });

  test(`e2e ${c.label}: a goodBYE mid-order runs the bye protocol`, async () => {
    const send = makeSender(c.rows, `bye-${c.eb}`);
    await send(`ZAINTERESIRAN SUM ZA EVIDENTEN BROJ ${c.eb}`);
    await send('SAKAM VIZITA DA SE DOGOVORI');
    const { s: s1 } = await send('PARI ZA POSETA ZEMATE ? ZOSTO?');   // rung 1
    assert.equal(s1.slots.feeRejections, 1);
    const { s, reply } = await send('NE FALA, CAO');
    assert.equal(s.slots.feeRejections, 1, 'a goodbye is not resistance');
    assert.ok(/најдобро|Благодарам/iu.test(reply), `the bye protocol: ${reply.slice(0, 90)}`);
    assert.ok(!/\?/.test(reply), `no question after a goodbye: ${reply.slice(0, 90)}`);
  });
}

test('e2e: a bare hesitation burns rung 1 (never the fee.ask re-disclosure)', async () => {
  const send = makeSender(ROWS, 'hesitation-buy');
  await send('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78');
  const { reply: disclosed } = await send('SAKAM VIZITA DA SE DOGOVORI');
  assert.ok(ASK_POOL_BUY.includes(disclosed.trim()), disclosed.slice(0, 90));

  // "NEZNAM" used to be answered with ANOTHER fee disclosure (the exact
  // re-disclosure the owner flagged) without advancing. Now it is resistance #1.
  const { s, reply } = await send('NEZNAM');
  assert.equal(s.slots.feeRejections, 1, 'a bare hesitation climbs');
  assert.ok(inPersuadePool(reply), `rung 1 is the persuasion: ${reply.slice(0, 90)}`);
  assert.ok(!inAskPool(reply), `never a re-disclosure: ${reply.slice(0, 90)}`);

  // …while a scheduling hesitation is the scheduler's turn, not a rung.
  const { s: s2 } = await send('ne znam koga ke mozam');
  assert.equal(s2.slots.feeRejections, 1, 'scheduling doubt never burns a rung');
});

test('e2e [22:03]: the fee challenge under каде climbs rung 1 — the client never gets a map pin', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'ladder-kaj';
  const send = async (m: string) => {
    await Promise.race([
      handler.handle('test', chatId, m),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`turn timeout (>10s): ${m.slice(0, 40)}`)), 10_000).unref()),
    ]);
    return sessions.get(chatId)!;
  };

  await send('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78');
  let s = await send('SAKAM DA JA VIDAM');
  assert.ok(inAskPool(sent[sent.length - 1]), `the disclosure comes first: ${sent[sent.length - 1].slice(0, 90)}`);

  // The capture: "ITS A NAG BUT SHE WRONGLY GIVES LOCATION".
  s = await send('KAJ SE VIDELO PARI ZA OTVARANJE STAN');
  const reply = sent[sent.length - 1];
  assert.equal(s.slots.feeRejections, 1, 'the challenge burns exactly one rung');
  assert.ok(inPersuadePool(reply), `rung 1 is the ONE persuasion: ${reply.slice(0, 90)}`);
  assert.ok(!/во близина на|мин пеш|населбата|Точната адреса/iu.test(reply),
    `a fee challenge is never answered with a location: ${reply.slice(0, 120)}`);
  assert.ok(!/https?:\/\/|maps\.google/iu.test(reply), `no map link on fee traffic: ${reply.slice(0, 120)}`);
  assert.equal(s.slots.landmarkIndex ?? 0, 0, 'the landmark rotation must not advance');
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
