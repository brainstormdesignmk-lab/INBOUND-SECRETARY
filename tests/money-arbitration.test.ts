// P5.2 OPTION 1+2 — the money arbiter's contract tests.
//
// The corpus (route-corpus.test.ts) pins every production misroute as a
// detector pair. These tests pin the ARBITER that replaced the money region's
// array order:
// - every legacy serve stays identical (evidence strength, ties → legacy order),
// - the expensive lane is wired ONLY under the evidence boundary (explicit
//   price noun + property on the table + non-question + no negotiation shape),
// - a tie at the top is a LOGGED collision, never a shifted serve,
// - an unclaimed money turn gets its explicit unknown.<topic>.<act> address —
//   the failure is named, never filed under a family by accident.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  arbitrateMoney, collisionTag, unknownBucket,
  type MoneyArbiterCtx,
} from '../src/llm/moneyArbitration';
import { PRICE_EVAL_EXPENSIVE_SEEDS, FIXED_SEEDS } from '../src/data/responseBank';

const ctx = (over: Partial<MoneyArbiterCtx> = {}): MoneyArbiterCtx => ({
  state: 'property_query',
  propertyOnTable: true,
  feeAgreed: false,
  feeBlocked: false,
  provisionBlocked: false,
  ...over,
});

// ── LEGACY PARITY: same serve the array order made ──────────────────────────
test('arbiter parity: the cheap compliment keeps the cheap lane with its evidence', () => {
  for (const t of ['MNOGU EFTINA CENA E TOA', 'CENATA E MNOGU EFTINA', 'многу ефтина цена е тоа']) {
    const v = arbitrateMoney(t, ctx({ state: 'presentation' }));
    assert.equal(v.lane, 'cheap', `parity broken: ${t} → ${v.lane}`);
    assert.equal(v.conflict, false, `legacy chain had no conflict log: ${t}`);
    const cheap = v.claims.find(c => c.lane === 'cheap');
    assert.ok(cheap, `cheap claim missing: ${t}`);
    assert.ok(cheap.evidence.some(e => e.includes('valence:cheap')), `evidence chip lost: ${t}`);
    assert.ok(cheap.evidence.some(e => e.startsWith('state:')), `state chip lost: ${t}`);
  }
});

test('arbiter parity: the fee-amount ask keeps the feeAmount lane', () => {
  for (const t of ['kolku e za poseta', 'КОЛКУ ЌЕ МЕ КОСТА 10 ПОСЕТИ?', 'Која е цената на разгледувањето?']) {
    const v = arbitrateMoney(t, ctx({ state: 'closing', propertyOnTable: false }));
    assert.equal(v.lane, 'feeAmount', `parity broken: ${t} → ${v.lane}`);
  }
});

test('arbiter parity: the provision resistance keeps the provision lane', () => {
  for (const t of ['NE SAKAM DA PLATAM PROVIZIJA', 'нема да платам провизија', 'PROVIZIJATA E MNOGU VISOKA', '50% Е МНОГУ']) {
    const v = arbitrateMoney(t, ctx({ state: 'closing', propertyOnTable: false }));
    assert.equal(v.lane, 'provision', `parity broken: ${t} → ${v.lane}`);
  }
});

test('arbiter parity: the fee-nag complaint keeps the nag lane', () => {
  // The script folding is script-normalized inside the detectors; ground
  // truth pinned with tmp/arbd.ts. The percent-shaped "50%" belongs to the
  // provision tier; the rest are the fee-sized complaints the corpus moves to
  // the fee grammar.
  for (const t of ['MNOGU NEKAKO 500DEN ZA OTVARANJE NA STAN', 'PARI ZA POSETA BARATE']) {
    const v = arbitrateMoney(t, ctx({ state: 'closing', propertyOnTable: false }));
    assert.equal(v.lane, 'nag', `parity broken: ${t} → ${v.lane}`);
  }
});

test('arbiter parity: the clarify probe keeps the clarify lane in the protocol states', () => {
  for (const t of ['обично колку е цената тука', 'CENATA KE E POSKAPA LI?']) {
    const v = arbitrateMoney(t, ctx({ state: 'closing', propertyOnTable: false, feeAgreed: false }));
    assert.equal(v.lane, 'clarify', `parity broken: ${t} → ${v.lane}`);
  }
  // Outside the protocol states the probe never claimed and the arbiter must
  // not invent a claim the array order did not have.
  const v = arbitrateMoney('обично колку е цената тука', ctx({ state: 'discovery', propertyOnTable: false }));
  assert.equal(v.lane, null, 'clarify claimed outside the protocol states');
  assert.ok(v.bucket, 'an unclaimed money turn must carry its unknown.* address');
});

// ── THE SOVEREIGN VALENCE AXIOM ─────────────────────────────────────────────
test('arbiter sovereignty: a surviving cheap claim outranks every fee lane', () => {
  // The corpus pins this at the detector level; here it is pinned at the
  // resolution level, so predicate drift cannot sneak a fee serve past a
  // compliment again.
  const v = arbitrateMoney('MNOGU EFTINA CENA E TOA', ctx({ state: 'closing', propertyOnTable: true }));
  assert.equal(v.lane, 'cheap');
  assert.equal(v.claims.filter(c => c.lane !== 'cheap').length, 0,
    'a compliment co-claimed with a fee lane — the veto must stay sovereign');
});

// ── THE WIRED EXPENSIVE LANE (the new P5.2 serve) ───────────────────────────
test('arbiter wiring: expensive serves when the evidence boundary is met', () => {
  for (const t of ['CENATA E PREVISOKA', 'цената е превисока', 'PREVISOKA E CENATA']) {
    const v = arbitrateMoney(t, ctx({ state: 'property_query', propertyOnTable: true }));
    assert.equal(v.lane, 'expensive', `the wired lane did not fire: ${t} → ${v.lane}`);
    const exp = v.claims.find(c => c.lane === 'expensive');
    assert.ok(exp, t);
    assert.ok(exp.evidence.some(e => e.includes('valence:expensive')), t);
    assert.ok(exp.evidence.some(e => e.includes('referent:price-noun')), t);
    assert.ok(exp.evidence.some(e => e.includes('target:property-on-table')), t);
  }
});

test('arbiter boundary: bare skapo, questions, negotiation shape and closing stay OUT', () => {
  for (const [t, over] of [
    ['SKAPO E TOA', {}],                                   // no explicit price noun
    ['mnogu e skapa ovaa nekretnina', {}],                 // no explicit price noun
    ['CENATA E PREVISOKA?', {}],                           // a question — price-ask machinery
    ['PREVISOKA E CENATA, DAJ POEVTINO', {}],              // negotiation shape
    ['CENATA E PREVISOKA', { state: 'closing' }],          // closing keeps its lanes
    ['CENATA E PREVISOKA', { propertyOnTable: false }],    // nothing to evaluate
    ['CENATA E PREVISOKA', { feeAgreed: true }],           // fee agreed — price talk outranked
  ] as const) {
    const v = arbitrateMoney(t, ctx(over));
    assert.notEqual(v.lane, 'expensive', `expensive fired past the boundary: ${t}`);
  }
});

// ── COLLISION: ties are an event, never a shifted serve ────────────────────
test('arbiter collision: equal-strength top claims resolve in legacy order and are tagged', () => {
  // A combined burst: the fee-amount ask AND the provision resistance in one
  // turn. Both claims are strength 7; the tie resolves to the legacy head
  // (feeAmount ran first) and the collision log carries the pair.
  const v = arbitrateMoney('НЕМА ДА ПЛАТАМ ПРОВИЗИЈА, КОЛКУ Е ЗА ПОСЕТА?', ctx({ state: 'closing', propertyOnTable: false }));
  assert.equal(v.lane, 'feeAmount', 'the tie must resolve to the legacy head');
  assert.equal(v.conflict, true, 'a tie at the top must raise the collision');
  assert.ok(v.claims.some(c => c.lane === 'provision'), 'the provision claim disappeared');
  assert.equal(collisionTag(v.claims).startsWith('LANE_COLLISION:'), true);
  assert.ok(/LANE_COLLISION:(?:[\w.]+\|)+[\w.]+/.test(collisionTag(v.claims)));
});

test('collision tag shape', () => {
  assert.equal(
    collisionTag([{ lane: 'cheap', evidence: [], strength: 8 }, { lane: 'feeAmount', evidence: [], strength: 7 }]),
    'LANE_COLLISION:cheap|feeAmount',
  );
});

// ── THE UNKNOWN.* BUCKET (option 2) ────────────────────────────────────────
test('unknown bucket: unclaimed money vocabulary gets an explicit address', () => {
  // "немам пари" in closing IS claimed — the fee-nag ladder owns the bare
  // money noun (the corpus moves it to the fee-funnel arm). The residue the
  // bucket must NAME is the same turn OUTSIDE the protocol states: no lane
  // claims it there, and the legacy order never served it either — the
  // failure now has an address instead of drifting into a family.
  const claimed = arbitrateMoney('немам пари', ctx({ state: 'closing', propertyOnTable: false }));
  assert.equal(claimed.lane, 'nag', 'the ladder lost its bare-money-noun turn');
  assert.equal(claimed.bucket, null, 'a claimed turn must not carry a bucket');
  const residue = arbitrateMoney('немам пари', ctx({ state: 'idle', propertyOnTable: false }));
  assert.equal(residue.lane, null, 'an unclaimed turn invented a serve');
  assert.equal(residue.bucket, unknownBucket(residue.tuple), 'bucket must address the tuple');
  assert.equal(residue.bucket, 'unknown.fee.assert', `bucket address drifted: ${residue.bucket}`);
  const ask = arbitrateMoney('пари?', ctx({ state: 'idle', propertyOnTable: false }));
  assert.equal(ask.lane, null);
  assert.equal(ask.bucket, 'unknown.unknown.ask', `ask address drifted: ${ask.bucket}`);
  // Fee vocabulary resolves into its own topic, never the unknown bucket.
  const fee = arbitrateMoney('kolku e za poseta', ctx({ state: 'closing', propertyOnTable: false }));
  assert.equal(fee.lane, 'feeAmount');
  assert.equal(fee.bucket, null);
  assert.equal(fee.tuple.target, 'visit-fee');
});

test('unknown bucket: no money vocabulary, no bucket — plain turns stay out of the ledger', () => {
  const v = arbitrateMoney('jak lokacija, fala', ctx({ state: 'property_query', propertyOnTable: true }));
  assert.equal(v.lane, null);
  assert.equal(v.bucket, null);
});

// THE FEE-WHY CLAIM (the [01:23] transcript): the WHY/EXISTENCE question
// ("IMATE NEKAKVA TAKSA ZA POSETA ?") is fee-explanation traffic — the fast
// feeWhyFast intercept owns the serve — so the money region claims it as a
// KNOWN lane instead of addressing it as residue (unknown.fee.ask). Same
// evidence tier as nag and placed after it in the legacy order, so a why-word
// riding a COMPLAINT keeps the legacy nag serve; the pure why/exists rows had
// no claim at all before (they fell into the residue bucket), so this claim
// only upgrades the address, it never shifts a serve.
test('fee-why claim: the existence/why question is a KNOWN lane, never unknown.fee.ask', () => {
  for (const t of ['IMATE NEKAKVA TAKSA ZA POSETA ?', 'dali ima taksa za poseta?',
    'има ли надоместок за посета?', 'zoska 500 denari ?']) {
    const v = arbitrateMoney(t, ctx({ state: 'closing', propertyOnTable: false }));
    assert.equal(v.lane, 'feeWhy', `the why/exists row lost its claim: ${t} → ${v.lane}`);
    assert.equal(v.bucket, null, `a claimed why row must not carry a residue address: ${t}`);
    const why = v.claims.find(c => c.lane === 'feeWhy');
    assert.ok(why, `feeWhy claim missing: ${t}`);
    assert.ok(why.evidence.some(e => e.includes('act:ask-why')), `evidence chip lost: ${t}`);
    // tuple stays fee-topic with the visit-fee target
    assert.equal(v.tuple.topic, 'fee', `tuple topic drift: ${t}: ${v.tuple.topic}`);
  }
  // outside the fee/protocol states no lane runs the money serve machinery —
  // the claim must not fire there, the residue address keeps telling the truth
  const idleRow = arbitrateMoney('IMATE NEKAKVA TAKSA ZA POSETA ?', ctx({ state: 'quarantine', propertyOnTable: false }));
  assert.equal(idleRow.lane, null, 'feeWhy claimed outside the fee states');
  assert.equal(idleRow.bucket, 'unknown.fee.ask', `state gate drift: ${idleRow.bucket}`);
});

// ── THE EXPENSIVE SEEDS GUARD (same policy class as the cheap seeds) ───────
test('the expensive lane has real bankable policy seeds', () => {
  const seeds = PRICE_EVAL_EXPENSIVE_SEEDS;
  assert.ok(Array.isArray(seeds) && seeds.length >= 3, 'seed pool too thin to vary wording');
  for (const v of seeds) {
    assert.ok(/\?$/.test(v), `seed must end with a question: ${v}`);
    assert.ok(!/\d/.test(v), `seed must not name an amount: ${v}`);
    assert.ok(!/(?:провизи|такс|надомес|наплат|плат)/iu.test(v), `seed drifts into fee talk: ${v}`);
    assert.ok(/(?:сопственик|пазар)/iu.test(v), `seed must state the owner/market fact: ${v}`);
  }
  assert.ok(Array.isArray(FIXED_SEEDS['remark.price.expensive']), 'expensive key not in the seed bank');
});
