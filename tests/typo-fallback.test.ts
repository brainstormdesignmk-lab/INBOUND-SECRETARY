// Single-letter-typo fallback (the poeKtino lesson, family-wide).
//
// The 21:39 transcript showed a one-letter slip ("poeKtino") silently voids
// every exact-spelling regex. The fix is a LENGTH-GATED (≥5-letter tokens,
// single unambiguous words only) edit-distance-≤1 fallback in fuzzyHasToken,
// wired ONLY into detectors whose anchor words are long and unambiguous.
// These tests pin BOTH sides of that contract: typos now match, and the
// deliberately unfuzzed families (short confirmation words, order-sensitive
// clitics, number-carrying words) keep their exact behavior.
import { test } from 'node:test';
import assert from 'node:assert';
import { fuzzyHasToken, normalizeMc } from '../src/llm/normalize';
import {
  detectService, detectAvailabilityAsk, detectPricePriority,
  detectSuggestAlternatives, detectGarsonjera, detectExplicitWiden,
  detectPropertyInterest, detectBedrooms, detectAgreement,
  detectVisitTime, detectDocumentsAsk, detectMortgageAsk, detectProvisionAsk,
} from '../src/llm/deterministic';

test('fuzzyHasToken: every single-edit class at distance ≤1 matches', () => {
  const K = ['купувам'];
  assert.equal(fuzzyHasToken('kupuvam', K), true, 'exact Latin fold');
  assert.equal(fuzzyHasToken('kupvam', K), true, 'deletion');
  assert.equal(fuzzyHasToken('kupuuvam', K), true, 'doubling');
  assert.equal(fuzzyHasToken('kjpuvam', K), true, 'substitution');
  assert.equal(fuzzyHasToken('kupuva', K), true, 'trailing deletion (m dropped) still ≤1');
  assert.equal(fuzzyHasToken('kupvua', K), false, 'two edits (swap + deletion) stays OUT');
  assert.equal(fuzzyHasToken('kuupvam', K), true, 'adjacent transposition (Damerau)');
  assert.equal(fuzzyHasToken('kjpuvam', K), true, 'digraph-collapse typo caught in RAW Latin space');
  assert.equal(fuzzyHasToken('КУПУВАМ', K), true, 'uppercase Cyrillic');
  assert.equal(fuzzyHasToken('купвам', K), true, 'Cyrillic deletion');
});

test('fuzzyHasToken: diacritic-stripped Latin base forms match', () => {
  // Users type "prosiri"/"predlozi", not "proshiri"/"predlozhi" — the ASCII
  // reverse-form comparison must catch first-letter slips of those too.
  assert.equal(fuzzyHasToken('rosiri ja potragata', ['прошири']), true, 'first-letter slip of stripped form');
  assert.equal(fuzzyHasToken('redlozete mi', ['предложете']), true, 'first-letter slip of stripped form (digraph kw)');
  assert.equal(fuzzyHasToken('iznajmuam stan', ['изнајмувам']), true, 'middle slip of stripped form');
});

test('fuzzyHasToken: distance-2 and short tokens stay OUT', () => {
  const K = ['поевтино'];
  assert.equal(fuzzyHasToken('povekje', K), false, 'distance-2 (повеќето class) must NOT match');
  assert.equal(fuzzyHasToken('povolno', K), false, 'different word');
  assert.equal(fuzzyHasToken('dс', ['да']), false, 'keywords <5 letters are refused by contract');
  assert.equal(fuzzyHasToken('ok', ['ок']), false, 'short confirmation words never fuzzed');
  assert.equal(fuzzyHasToken('kupv', K), false, 'too-short fragment (2 edits away)');
});

test('detectService: buy/rent survive one-letter typos', () => {
  assert.equal(detectService('KUPVAM STAN VO KISELA VODA'), 'buy', 'kupvam → buy');
  assert.equal(detectService('kupuam stan'), 'buy', 'kupuam → buy');
  assert.equal(detectService('kjpuvam stan'), 'buy', 'digraph-collapse → buy');
  assert.equal(detectService('sakam da se iznajmuam'), 'rent', 'iznajmuam → rent');
  assert.equal(detectService('iznajmuam stan'), 'rent', 'iznajmuam → rent');
  assert.equal(detectService('da li e dostapen'), undefined, 'availability must not become buy/rent');
});

test('detectAvailabilityAsk: typo forms still ask about availability', () => {
  assert.equal(detectAvailabilityAsk('DALI E dostapes?'), true, 's→e slip');
  assert.equal(detectAvailabilityAsk('dostapen li e'), true, 'exact');
  assert.equal(detectAvailabilityAsk('e slobodeo utre?'), true, 'слободен slip');
});

test('detectPricePriority: the poeKtino family and beyond', () => {
  assert.equal(detectPricePriority('daj nesto poeKtino vo toj reon'), true, 'the 21:39 original');
  assert.equal(detectPricePriority('daj nesto povtino'), true, 'ф→в slip');
  assert.equal(detectPricePriority('daj nesto poeftin'), true, 'final-vowel drop via the ф-anchor');
  assert.equal(detectPricePriority('daj nesto pojevtino'), true, 'vowel insertion');
  assert.equal(detectPricePriority('nesto poevtkno'), true, 'substitution');
});

test('detectSuggestAlternatives / detectExplicitWiden / detectGarsonjera: typo forms', () => {
  assert.equal(detectSuggestAlternatives('predlozzi mi nesto'), true, 'predlozzi');
  assert.equal(detectSuggestAlternatives('predlozeete mi'), true, 'predlozeete');
  assert.equal(detectExplicitWiden('PROSIRR JA POTRAGATA'), true, 'prosirr');
  assert.equal(detectExplicitWiden('prosiiri ja potragata'), true, 'prosiiri');
  assert.equal(detectGarsonjera('garsOnera mi treba'), true, 'garsonera');
  assert.equal(detectGarsonjera('garsonjerra'), true, 'garsonjerra');
});

test('visit-time / documents / mortgage / provision: typo forms match', () => {
  // Only LONG day/period names are fuzzed — утре/денес/среда stay exact-only.
  assert.ok(detectVisitTime('SABTA posle 5'), 'sabta → сабота deletion');
  assert.ok(detectVisitTime('ponedelnek utre'), 'ponedelnek substitution');
  assert.ok(detectVisitTime('popladneo posle 6'), 'popladneo trailing slip');
  assert.ok(detectVisitTime('utre posle 5'), 'short word EXACT still works');
  assert.equal(detectVisitTime('kje dojde li'), undefined, 'no time reference');

  assert.equal(detectDocumentsAsk('dokumeti mi trebaat'), true, 'dokumeti deletion');
  assert.equal(detectDocumentsAsk('koi dokumenti se potrebni'), true, 'exact still works');
  assert.equal(detectDocumentsAsk('dogovori mi'), false, 'договори-ми guard intact');

  assert.equal(detectMortgageAsk('dali moze so kredito'), true, 'kredito slip');
  assert.equal(detectMortgageAsk('hipoteka'), true, 'hipoteka ASCII form');
  // NOTE: bare “banka …” matching mortgage is PRE-EXISTING exact-regex behavior
  // (MORTGAGE_RE contains банк(?:\s|$)) — out of the typo-fallback scope.

  assert.equal(detectProvisionAsk('dali ima provizijea'), true, 'provizijea insertion');
  assert.equal(detectProvisionAsk('kolku e provizijata'), true, 'exact stem still works');
});

test('SAFETY CONTRACTS: deliberately unfuzzed families keep exact behavior', () => {
  // "друго/други" is hyper-ambiguous (5 letters, distance-1 to real phrases
  // owned by other flows) — it must NOT enter the alt-anchor list.
  assert.equal(detectSuggestAlternatives('drugi opcii'), false, 'bare drugi opcii stays rejection-flow');
  assert.equal(detectSuggestAlternatives('drugo nesto ima?'), false, 'ladder phrase stays ladder-flow');
  // Clitic order carries meaning: reversed "svigja mi se" is NOT interest,
  // and normalizeMc folds "svigja" exactly onto "свиѓа" — so свиѓа/допаѓа
  // must never be token-fuzzed.
  assert.equal(detectPropertyInterest('svigja mi se'), false, 'reversed clitic order');
  assert.equal(detectPropertyInterest('zainteresiraan sum'), true, 'long-anchor typo DOES match');
  // A typo'd "спални" says nothing about the COUNT — bedrooms is never fuzzed.
  assert.equal(detectBedrooms('spalne mi trebaat'), undefined, 'typo without a number stays undefined');
  assert.equal(detectBedrooms('dve spalni'), 3, 'exact number still works');
  // Short confirmation words are never fuzzed into agreement.
  assert.equal(detectAgreement('dс'), false);
  assert.equal(detectAgreement('ook'), false);
});
