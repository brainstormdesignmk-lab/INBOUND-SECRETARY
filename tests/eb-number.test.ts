// THE EB NUMBER READER — one grammar for "the client named a flat by number".
//
// THE [20:11] CAPTURE that started this file:
//
//   [20:11] KOLKU DOAGJA CENA PO KVADRAT ZA 53 ?
//   [20:11] ЛИНА: Во Аеродром, цените варираат од 1.250 до 2.026 евра за м² …
//
// The client asked EB 53's RATE; he got the neighbourhood's market band. The
// market lane already carried the right guard — "a named property owns its
// lane" — but it asks inferPropertyId, and that reader vetoed the whole
// MESSAGE as soon as a unit word appeared («…|kvadrat|…»). The word that asked
// for the rate destroyed the number that named the flat.
//
// So this file pins both directions of the shared grammar: what is a flat, and
// what is a criterion wearing the same digits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ebNumbersInText, firstEbNumber } from '../src/llm/ebNumber';
import { inferPropertyId } from '../src/llm/classify';
import { detectMarketPriceAsk } from '../src/llm/deterministic';

test('[20:11] a flat named beside the rate question is READ, in both scripts', () => {
  for (const t of [
    'KOLKU DOAGJA CENA PO KVADRAT ZA 53 ?',
    'kolku doagja cena po kvadrat za 53 ?',
    'КОЛКУ ДОАЃА ЦЕНА ПО КВАДРАТ ЗА 53 ?',
    'kolku mu e cena po m2 na 84 ?',
    'KOLKU SPALNI IMA 66 ?',            // «спални» is about 66, not a veto on 66
    'DALI 69 IMA KLIMA ?',
    'NA KOJ SPRAT E 94 ?',
  ]) {
    assert.equal(firstEbNumber(t) !== undefined, true, `the flat must be read: ${t}`);
  }
  assert.equal(firstEbNumber('KOLKU DOAGJA CENA PO KVADRAT ZA 53 ?'), 53);
  assert.equal(firstEbNumber('kolku mu e cena po m2 na 84 ?'), 84);
  assert.equal(firstEbNumber('KOLKU SPALNI IMA 66 ?'), 66);
});

test('a criterion number stays a criterion — units, caps, thousands figures', () => {
  assert.deepEqual(ebNumbersInText('NAD 50 M2'), [], 'a size behind a comparison word');
  assert.deepEqual(ebNumbersInText('DO 250 EVRA'), [], 'a budget cap');
  assert.deepEqual(ebNumbersInText('OKOLU 40 KVADRATI'), [], 'an approximate size');
  assert.deepEqual(ebNumbersInText('120 000 EVRA'), [], 'a space-separated thousands figure');
  assert.deepEqual(ebNumbersInText('CENA 1.286 EVRA ZA M2'), [], 'a dot-separated thousands figure');
  assert.deepEqual(ebNumbersInText('58 M2'), [], 'the surface itself');
  assert.deepEqual(ebNumbersInText('3 KAT'), [], 'a floor');
  assert.deepEqual(ebNumbersInText('ИМАМ 120000 ЕВРА БУЏЕТ'), [], 'a whole price');
});

test('a criterion AND a flat in one sentence: only the free number is the flat', () => {
  assert.equal(firstEbNumber('STAN 53, 50 M2, DO 90000 EVRA'), 53,
    'the unit/cap words belong to 50 and 90000, not to 53');
  assert.equal(firstEbNumber('IMAM BUDJET 120000 EVRA, ZAINTERESIRAN SUM ZA 78'), 78,
    'the budget is not an ЕВ; the interest line is');
  assert.deepEqual(ebNumbersInText('DVOSOBEN 60 M2 DO 90000'), []);
});

test('inferPropertyId: the [20:11] line names EB 53, and the guards still hold', () => {
  // THE BUG: the «kvadrat» in the question killed the number.
  assert.equal(inferPropertyId('KOLKU DOAGJA CENA PO KVADRAT ZA 53 ?'), 53);
  // …and a number that IS a size stays one, even in the same frame.
  assert.equal(inferPropertyId('KOLKU E CENATA ZA 53 M2?'), undefined);
  // ...while the guards that keep budgets/sizes out of the EB slot still hold.
  assert.equal(inferPropertyId('NAD 50 M2'), undefined);
  assert.equal(inferPropertyId('DO 250 EVRA'), undefined);
  assert.equal(inferPropertyId('SAKAM STAN SO 60 M2'), undefined);
  // The eye-catch idiom: «око» is the EYE here, not «околу» — the number IS the EB.
  assert.equal(inferPropertyId('MI FATI OKO 94'), 94);
  // Times and phones are never EBs.
  assert.equal(inferPropertyId('UTRE VO 18:30'), undefined);
});

test('detectMarketPriceAsk: a named flat is the property lane, never a band', () => {
  for (const t of [
    'KOLKU DOAGJA CENA PO KVADRAT ZA 53 ?',
    'kolku mu e cena po m2 na 84 ?',
    'CENA PO KVADRAT ZA STANOT 61?',
  ]) {
    assert.equal(detectMarketPriceAsk(t), false, `a single flat is not a market level: ${t}`);
  }
  // …and the CATEGORY/AREA questions are untouched (no flat named).
  for (const t of [
    'KOJA CENA PO KVADRAT?',
    'KOLKU E CENATA PO KVADRAT VO KARPOS?',
    'CENI PO KVADRAT ZA STANOVI?',
    'KAKO SE DVIZAT CENITE ZA STANOVI VO AERODROM?',
    'KOLKU E CENATA ZA M2 VO CENTAR?',
  ]) {
    assert.equal(detectMarketPriceAsk(t), true, `the band lane lost a question: ${t}`);
  }
});
