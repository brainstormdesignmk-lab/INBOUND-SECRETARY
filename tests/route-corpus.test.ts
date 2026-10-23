// THE GOLDEN ROUTING CORPUS — every production misroute becomes a row here
// before it becomes a guard.
//
// Trigger case (2026-10-22): "MNOGU EFTINA CENA E TOA" — the client praised the
// quoted price — was routed to the visit-fee ladder and served
// fee.persuade.1.buy. Two lexical collisions stacked: `цена` is both the
// property price and a fee-charge noun, and the value class treated bare
// `многу` as a complaint. The row below was RED before the fix (detectFeeNag
// returned true) and is the permanent gate now.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectFeeNag, isFeeTraffic, detectFeeComplaint, detectCheaperSearch,
  detectPriceEval, isCheapPriceEval,
  PRICE_EVAL_CHEAP_KEY, PRICE_EVAL_EXPENSIVE_KEY,
  isMoneyWithoutTarget, MONEY_CLARIFY_KEY, cheapLaneConflict,
} from '../src/llm/deterministic';
import { PRICE_EVAL_CHEAP_SEEDS, FIXED_SEEDS } from '../src/data/responseBank';

test('corpus: a cheap-price compliment is PRICE valence — never fee, never a cheaper search', () => {
  for (const t of [
    'MNOGU EFTINA CENA E TOA',
    'mnogu eftina cena e toa',
    'CENATA E MNOGU EFTINA',
    'многу ефтина цена е тоа',
    'CENATA E DOBRA',
    'cenata e odlicna',
    'поволна цена за оваа локација',
  ]) {
    assert.equal(detectPriceEval(t), 'cheap', `not read as cheap: ${t}`);
    assert.equal(isCheapPriceEval(t), true, t);
    assert.equal(detectFeeNag(t), false, `fee nag claimed a compliment: ${t}`);
    assert.equal(isFeeTraffic(t), false, `fee traffic claimed a compliment: ${t}`);
    assert.equal(detectFeeComplaint(t), false, `fee complaint claimed a compliment: ${t}`);
    assert.equal(detectCheaperSearch(t), false, `cheaper search claimed a compliment: ${t}`);
  }
});

test('corpus: genuine fee resistance keeps every lane (the valence veto is one-directional)', () => {
  for (const t of [
    '50% E MNOGU',
    'MNOGU NEKAKO 500DEN ZA OTVARANJE NA STAN',
    '300 денари се премногу за посета',
    '10 evra ne e bas simbolichna cena',
    'PARI ZA POSETA BARATE',
    'NE SAKAM DA PLATAM',
  ]) {
    assert.equal(detectPriceEval(t), undefined, `fee traffic read as price valence: ${t}`);
    assert.equal(detectFeeNag(t), true, `fee lane lost: ${t}`);
  }
});

test('corpus: expensive is detected but NOT the wired cheap lane', () => {
  for (const t of ['SKAPO E TOA', 'mnogu e skapo', 'CENATA E PREVISOKA']) {
    assert.equal(detectPriceEval(t), 'expensive', t);
    assert.equal(isCheapPriceEval(t), false, t);
  }
});

test('corpus: a cheaper SEARCH is a command, not an opinion about the quoted price', () => {
  for (const t of ['daj poevtino', 'poeftino nesto', 'поевтино од ова']) {
    assert.equal(detectPriceEval(t), undefined, t);
    assert.equal(detectCheaperSearch(t), true, `the search command was lost: ${t}`);
  }
});

test('the cheap-price lane has a real key and bankable seeds', () => {
  assert.equal(PRICE_EVAL_CHEAP_KEY, 'remark.price.cheap');
  assert.equal(PRICE_EVAL_EXPENSIVE_KEY, 'remark.price.expensive');
  assert.ok(PRICE_EVAL_CHEAP_SEEDS.length >= 3, 'seed pool too thin to vary wording');
  for (const v of PRICE_EVAL_CHEAP_SEEDS) {
    assert.ok(/\?$/.test(v), `seed must end with a question: ${v}`);
    assert.ok(!/\d/.test(v), `seed must not name an amount: ${v}`);
    assert.ok(!/(?:спални|станот|куќата)/iu.test(v), `seed names the wrong category: ${v}`);
  }
});

// ── INVARIANT 3: NO MONEY REPLY WITHOUT A TARGET ───────────────────────────
test('corpus: money wording with an unresolved object is exactly the clarify probe', () => {
  for (const t of [
    'обично колку е цената тука',
    'CENATA KE E POSKAPA LI?',
    'плати ли напред нешто',
  ]) {
    assert.equal(isMoneyWithoutTarget(t), true, `probe lost an unresolved money turn: ${t}`);
  }
  // Every resolved object takes its own lane instead.
  for (const t of [
    'kolku e za poseta',           // fee referent — fee-amount-ask lane
    '50% E MNOGU',                 // provision — provision lane
    'kolku cini stanot',           // property noun — price-ask machinery
    ' nemam pari',                 // money noun — fee-funnel arm
    'ne sakam da platam',          // negated pay — ladder arm
    'daj poevtino',                // cheaper-search command
    'do 500 evra budget',          // budget statement
    'mnogu skapa cena ima',        // investment opinion (the #65 sibling)
  ]) {
    assert.equal(isMoneyWithoutTarget(t), false, `probe stole a resolved turn: ${t}`);
  }
});

test('the clarify lane has a real key, question-shaped amount-free seeds', () => {
  assert.equal(MONEY_CLARIFY_KEY, 'ask.money.clarify');
  const seeds = FIXED_SEEDS['ask.money.clarify'];
  assert.ok(Array.isArray(seeds) && seeds.length >= 3, 'clarify seed pool too thin');
  for (const v of seeds) {
    assert.ok(/\?$/.test(v), `clarify seed must end with a question: ${v}`);
    assert.ok(!/\d/.test(v), `clarify seed must not name an amount: ${v}`);
    assert.ok(/(?:недвижност|посет|стан)/i.test(v), `clarify seed must name the candidate objects: ${v}`);
  }
});

// ── INVARIANT 4: the collision record ──────────────────────────────────────
test('corpus: the veto leaves NO conflict on the whole trigger family', () => {
  for (const t of [
    'MNOGU EFTINA CENA E TOA', 'CENATA E MNOGU EFTINA', 'cenata e odlicna',
    'поволна цена за оваа локација',
  ]) {
    assert.equal(cheapLaneConflict(t), undefined, `residual lane conflict: ${t}`);
  }
});

test('corpus fuzz: synonym substitution flips the probe cleanly, never to a refusal', () => {
  // ефтино → скапо: the valence flips, the cheap lane MUST stay out.
  for (const t of ['MNOGU SKAPA CENA E TOA', 'CENATA E MNOGU SKAPA']) {
    assert.equal(detectPriceEval(t), 'expensive', t);
    assert.equal(isCheapPriceEval(t), false, t);
    assert.equal(isMoneyWithoutTarget(t), false, `skapo drifted into the clarify probe: ${t}`);
  }
  // цена → такса: a fee noun resolves the object; the fee grammar OWNS it.
  for (const t of ['MNOGU EFTINA TAKSA E TOA', 'TAKSATA E MNOGU EFTINA']) {
    assert.equal(detectPriceEval(t), undefined, `taksa read as price valence: ${t}`);
    assert.equal(detectFeeComplaint(t), true, `fee lane lost on the taksa variant: ${t}`);
  }
});
