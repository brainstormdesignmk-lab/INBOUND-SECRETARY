// THE MARKET-MEMORY LANE — a client recalls a listing that USED to be at the
// agency: „ИМАШЕчЕ ЕДНА КУчА ПРЕД НЕКОЕ ВРЕМЕ КАЈ ВАС КАЈ ОЛИМПИКО ОКОЛУ 400
// ЕВРА КИРИЈА / ДАЛИ Е СЛОБОДНА МОМЕНТАЛНО ?" ([02:00] field capture).
//
// No detector owned that line: the rent word („кирија") + the question shape
// made the mirror predict MARKET_PRICE, but the lane's own capture conditions
// (`areaInMessage || pluralType || (anchoredEb===undefined && !rentOnlyAsk)`)
// all failed — „Олимпико" is a landmark, not a feed area, „куќа" is singular,
// and the rent-only guard keeps bare rent words with the property-price lane.
// So the turn fell through to the discovery funnel and the client was asked
// „Кој дел од градот Ви е најпривлечен?" about a house the agency itself once
// listed. The rows below are the permanent gate: the recall phrasing IS the
// memory lane (past-tense existence + agency anchor + property noun + a money
// figure), and every neighbor lane keeps out the way the router reads it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectMarketMemoryAsk, memoryTypeNoun, detectMarketPriceAsk,
  isMarketRentWordAsk, detectService, detectBothServices,
} from '../src/llm/deterministic';
import { ROUTING_ORDER, resolveIntent } from '../src/handlers/router';

const COLD_RECALL =
  'ИМАШЕчЕ ЕДНА КУчА ПРЕД НЕКОЕ ВРЕМЕ КАЈ ВАС КАЈ ОЛИМПИКО ОКОЛУ 400 ЕВРА КИРИЈА';

test('corpus: a recollected old-listing line is the MARKET_MEMORY lane', () => {
  for (const t of [
    // the [02:00] verbatim row (Cyrillic, with the long-press „ч" noise tail)
    COLD_RECALL,
    'imaseche edna kuca pred nekoje vreme kaj vas kaj olimpiko okolu 400 evra kirija', // latin typing
    'ИМАШЕ СТАН ПРЕД НЕКОЕ ВРЕМЕ КАЈ ВАС ОКОЛУ 300 ЕВРА',                             // no landmark, still a recall
    'BESE EDNA GARSONJERA KAJ NAS DO 12000',                                          // „беше" + „кај нас" + amount
    'ПРЕД ВАЛМА ГОДИНА ИМАШЕ КУЌА КАЈ НАС ВО 400 КИРИЈА',                             // time phrase first
  ]) {
    assert.equal(detectMarketMemoryAsk(t), true, `the memory lane lost a recall: ${t}`);
  }
});

test('corpus: no memory lane on neighbor traffic', () => {
  // the bare availability follow-up of the recall message — the second line of
  // the [02:00] message — carries no past-tense existence claim itself
  assert.equal(detectMarketMemoryAsk('ДАЛИ Е СЛОБОДНА МОМЕНТАЛНО ?'), false);
  for (const t of [
    'SAKAM DA IZNAJMAM KUKJA DO 400 EVRA',           // fresh need, no past form
    'kolku e kirijata vo aerodrom?',                 // today's rent band
    'kako se dvizat cenive za stanovi vo karpos?',   // the market band
    'dali kuca okolu 400 evra e slobodna?',          // present search with availability
    'imam kurir do vashaar?',                        // nonsense must never claim
  ]) {
    assert.equal(detectMarketMemoryAsk(t), false, `memory lane stole a live lane row: ${t}`);
  }
  // The fresh-need family still carries its own detectors end to end.
  assert.equal(detectService('SAKAM DA IZNAJMAM KUKJA DO 400 EVRA'), 'rent');
});

// WHY the lane must sit BEFORE MARKET_PRICE: the FULL field message — the
// recall PLUS the availability follow-up with its «?» — trips the market
// mirror's rent-word + ask-shape pair; that exact pair produced the [02:00]
// predicted=MARKET_PRICE drift while the market arm failed to capture it.
const FULL_RECALL = COLD_RECALL + '\\nДАЛИ Е СЛОБОДНА МОМЕНТАЛНО ?';

test('corpus: the collision that must not reorder', () => {
  assert.equal(isMarketRentWordAsk(COLD_RECALL), true, 'the rent word must stay visible to the guard');
  assert.equal(detectMarketPriceAsk(FULL_RECALL), true, 'the MARKET_PRICE mirror must stay intact');
  assert.equal(detectBothServices(FULL_RECALL), false, 'buy-or-rent never rides a recall');
  // NOTE: detectService DOES read a truthy rent cue off «КИРИЈА» (its
  // long-token typo fallback) — that is exactly why detectMarketMemoryAsk
  // carries no service veto: a veto there would reject every genuine recall.
  // ...and the memory lane still claims the FULL message, so the mirror
  // resolution comes out MARKET_MEMORY (the fix, not a silent veto).
  assert.equal(detectMarketMemoryAsk(FULL_RECALL), true, 'the memory lane lost the full field message');
});

test('memoryTypeNoun reads the recollected noun for the ack wording', () => {
  assert.equal(memoryTypeNoun(COLD_RECALL), 'куќа');
  assert.equal(memoryTypeNoun('beshe edna garsonjera kaj nas 12000'), 'гарсоњера');
  assert.equal(memoryTypeNoun('imashe lokаl kaj vas do 900'), 'локал');
  assert.equal(memoryTypeNoun('ИМАШЕ ДЕЛОВЕН ПРОСТОР КАЈ НАС ОКОЛУ 400'), 'деловен простор');
  assert.equal(memoryTypeNoun('imashe stan kaj vas za 80.000'), 'стан');
});

test('routing order: the recall outruns MARKET_PRICE in the mirror', () => {
  const memIdx = ROUTING_ORDER.findIndex(r => r.intent === 'MARKET_MEMORY');
  const marketIdx = ROUTING_ORDER.findIndex(r => r.intent === 'MARKET_PRICE');
  assert.ok(memIdx !== -1, 'the mirror has no MARKET_MEMORY row');
  assert.ok(marketIdx === -1 || memIdx < marketIdx,
    `MARKET_MEMORY must sit before MARKET_PRICE (got ${memIdx} vs ${marketIdx})`);
  assert.equal(resolveIntent(COLD_RECALL, 'discovery'), 'MARKET_MEMORY');
  assert.equal(resolveIntent(FULL_RECALL, 'discovery'), 'MARKET_MEMORY',
    'the full field message — recall + availability «?» — must resolve MARKET_MEMORY, never MARKET_PRICE');
  // ...and the mirror never hands a current search to the memory lane
  assert.equal(resolveIntent('SAKAM DA IZNAJMAM KUKJA DO 400 EVRA', 'discovery'), 'FALLTHROUGH');
});
