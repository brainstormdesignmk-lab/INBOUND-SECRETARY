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
  detectWhereIs, detectDocumentsAsk, detectExactAddressAsk, detectFeeWhy,
  detectMarketMemoryAsk, detectMarketPriceAsk,
} from '../src/llm/deterministic';
import { PRICE_EVAL_CHEAP_SEEDS, FIXED_SEEDS } from '../src/data/responseBank';
import { resolveIntent } from '../src/handlers/router';

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

// ── THE [02:30] POZICIJATA MISROUTE ──────────────────────────────────────
// "a kade odprilika mu e pozicijata?" was served the DOCUMENTS lecture. Two
// bugs stacked: (1) editDistanceAtMost1 returned true from inside its
// transposition branch WITHOUT checking the rest of the string, so "одприлика"
// collided with "документи" (од↔до swap at positions 0–1, the remaining eight
// letters ignored) and the documents fuzzy arm fired; (2) no location lane
// covered "позиција" — even after (1) was fixed the kade object had no owner.
// The row must always be a generic WHERE_IS (landmark rotation), never documents.
test('corpus: a kade-question about the pozicija is WHERE_IS — never the documents lecture', () => {
  for (const t of [
    'a kade odprilika mu e pozicijata?',     // the [02:30] verbatim row
    'kade odprilika mu e pozicijata?',
    'kade mu e pozicijata?',
    'каде одприлика му е позицијата?',        // Cyrillic script
  ]) {
    assert.equal(detectWhereIs(t)?.generic, true, `where-is lost: ${t}`);
    assert.equal(detectDocumentsAsk(t), false, `documents arm claimed a kade-question: ${t}`);
    assert.equal(detectExactAddressAsk(t), false, `privacy protocol claimed a kade-question: ${t}`);
  }
  // "kade e lokacijata?" dual-fires detectWhereIs AND detectExactAddressAsk —
  // pre-existing overlap (the pozicija rows are new). Routing is still
  // WHERE_IS: ROUTING_ORDER gates EXACT_ADDRESS with !detectWhereIs(t), so
  // the invariant to pin is the ROUTE, read the way the router reads it.
  const routeFor = (t: string): 'WHERE_IS' | 'EXACT_ADDRESS' | undefined => {
    if (detectWhereIs(t)) return 'WHERE_IS';
    if (detectExactAddressAsk(t)) return 'EXACT_ADDRESS';
    return undefined;
  };
  for (const t of ['kade e lokacijata?', 'каде е локацијата?']) {
    assert.equal(routeFor(t), 'WHERE_IS', `route deviated on: ${t}`);
  }
  // The documents arm keeps its own phrasings — the collision fix must not
  // have turned the fuzzy fallback off.
  for (const t of ['koi dokumenti mi trebaat?', 'koi dokumeti treba?', 'какви документи да имам?']) {
    assert.equal(detectDocumentsAsk(t), true, `documents phrasing lost: ${t}`);
  }
});

// ── THE [02:4x] ZOSKA ROW ─────────────────────────────────────────────────
// "zoska 500 denari ?" / "zoshto 500 denari ?" — a why-word beside a
// FEE-SIZED money figure, no visit noun, no charge verb. The sweep probe
// found EVERY detector false: the row routed nothing. A zoshto-family word
// next to a fee-sized amount is the filter-rationale question (feeWhyFast);
// property-priced why-rows ("zoshto 1.430.000 denari za stanot?") keep
// their price machinery.
test('corpus: bare zoshto/zoska + a fee-sized amount is the fee-why rationale', () => {
  for (const t of [
    'zoska 500 denari ?',          // the sweep's verbatim row
    'zoshto 500 denari ?',
    'zasto 500 den?',
    'ЗОШТО 500 ДЕНАРИ?',           // Cyrillic script
  ]) {
    assert.equal(detectFeeWhy(t), true, `why-amount row lost: ${t}`);
  }
  for (const t of [
    'zoshto 1.430.000 denari za stanot?',   // property-sized price ask
    'zoshto 140000 denari cena?',
    'kolku e za poseta?',                    // kolku = provision ask
  ]) {
    assert.equal(detectFeeWhy(t), false, `why lane stole: ${t}`);
  }
});

// ── THE [02:00] MARKET-MEMORY KEEPER ────────────────────────────────────
// route:health --emit-corpus fed these two production rows back:
//   { userMsg: 'ИМАШЕчЕ ЕДНА КУчА ПРЕД НЕКОЕ ВРЕМЕ КАЈ ВАС КАЈ ОЛИМПИКО ОКОЛУ
//     400 ЕВРА КИРИЈА\nДАЛИ Е СЛОБОДНА МОМЕНТАЛНО ?', note: 'drift 2026-10-26:
//     predicted=MARKET_PRICE actual=ROUTE_UNKNOWN:unknown.unknown.ask' }
// This is the MARKET_MEMORY keeper now wired in src/llm/deterministic.ts +
// src/handlers/inbound.ts. What stays pinned: the full field message resolves
// MARKET_MEMORY in the mirror (the rent noun + «?» pair that produced the
// MARKET_PRICE prediction must net out), and the market mirror itself stays
// untouched — the lane wins by ORDER, not by weakening detectMarketPriceAsk.
test('corpus: the [02:00] old-listing recall row resolves MARKET_MEMORY', () => {
  const keeper = 'ИМАШЕчЕ ЕДНА КУчА ПРЕД НЕКОЕ ВРЕМЕ КАЈ ВАС КАЈ ОЛИМПИКО ОКОЛУ 400 ЕВРА КИРИЈА\nДАЛИ Е СЛОБОДНА МОМЕНТАЛНО ?';
  for (const t of [keeper, keeper.replace('ИМАШЕчЕ', 'ИМАШЕ')]) {
    assert.equal(resolveIntent(t, 'discovery'), 'MARKET_MEMORY', `keeper row lost: ${t}`);
    assert.equal(detectMarketMemoryAsk(t), true, `memory detector lost a keeper: ${t}`);
  }
  // the market mirror that predicted MARKET_PRICE must still fire on the full
  // message — the corpus row documents the collision without disabling it
  assert.equal(detectMarketPriceAsk(keeper), true, 'the merge must keep the market mirror intact');
});
