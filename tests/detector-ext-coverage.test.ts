// THE REGENERATION AUDIT, PINNED (the [23:2x] fix that re-emitted
// src/llm/detectorExt.ts).
//
// The generator drops an entry when a corpus row is covered by something else
// (usually the base detector). That is correct for a ROW, but a verbatim
// literal is not a generalizer: dropping a stem or an idiom can lose every
// unseen phrasing of the same class, and the corpus still reports "0 gaps"
// because its own row is matched. Three real shapes were lost that way and are
// pinned here:
//
//   • "ИМА ЛИ НЕШТО КИЛА ПОДОЛУ" — "кила" is the price slang for thousands;
//     with it listed as a stop word the COLLOCATION could not form, the two
//     idioms vanished and the cheaper family answered nothing. (The other
//     audit lead — the fee-why why-word stem — was NOT a regression: ext stems
//     are exact surfaces, so "зоск" never matched "зоска". The corpus row is
//     covered verbatim, which is what is pinned below.)
//   • the whole-message bare rejection literals ("не овој" / "овој не") must
//     never fire inside an ordinary sentence — the negated-bad idiom «ОВОЈ НЕ
//     Е ЛОШ» is an understated POSITIVE, and reading it as a rejection is what
//     buried the praise lane.
//
// Everything else the regeneration dropped was verified to still fire through
// the base detector, and those surfaces are pinned too so a future base change
// cannot quietly remove the replacement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectAgreement, detectPriceAsk, detectVagueTime, detectVisitCancellation,
  detectFeeWhy, detectCheaperSearch, detectNeighborhoodAsk, detectRejection,
} from '../src/llm/deterministic';

test('fee-why: the corpus why-question still reaches the explanation lane, in both scripts', () => {
  // The family's literal is the verbatim row; Latin input folds onto it.
  assert.equal(detectFeeWhy('ЗОСКА СЕ ПЛАКА ЗА ТЕРМИНОВ?'), true);
  assert.equal(detectFeeWhy('zoska se plaka za terminov?'), true);
});

test('cheaper: the "кила" collocations still ask for a cheaper property', () => {
  // "кила" = thousands of euros; these are comparatives, not generic nouns.
  assert.equal(detectCheaperSearch('ИМА ЛИ НЕШТО КИЛА ПОДОЛУ'), true);
  assert.equal(detectCheaperSearch('НЕСТО 20-30 КИЛА ПОМАЛКУ?'), true);
  assert.equal(detectCheaperSearch('кила подолу'), true);
});

test('bare rejection literals never fire inside a sentence', () => {
  assert.equal(detectRejection('НЕ ОВОЈ'), true);
  assert.equal(detectRejection('ОВОЈ НЕ.'), true);
  // The understated positive that motivated the regeneration.
  assert.equal(detectRejection('ОВОЈ НЕ Е ЛОШ'), false);
  assert.equal(detectRejection('овој не е лош, баш ми се допаѓа'), false);
});

test('the entries the regeneration dropped are still covered by the base detectors', () => {
  // agreement-yes: bare «важи» became a base case; a whole-message yes must
  // stay a yes. (The doubled «важи важи» is deliberately NOT agreement — the
  // base detector's own header explains that bare «важи» is an availability
  // word «огласот уште важи?», so the old substring literal was a greedy gate.)
  assert.equal(detectAgreement('ВАЖИ'), true);
  assert.equal(detectAgreement('ОК ВАЖИ'), true);
  assert.equal(detectAgreement('DALI OGLASOT USHTE VAZI?'), false);
  // price-ask / vague-time: whole-message anchors replaced the substring forms.
  assert.equal(detectPriceAsk('КОЛКУ Е ЦЕНУА?'), true);
  assert.equal(detectPriceAsk('ЦЕНА МОЛАМ'), true);
  assert.equal(detectVagueTime('БИЛО КОГА'), true);
  // visit-cancel: the base CANCEL_RE owns the dropped stems.
  for (const text of [
    'САКАМ ДА ОТКАЖАМ', 'ИПАК ОТКАЖЕТЕ',
    'СЕ ИЗВИНУВАМ АМА МОРА ДА ОТКАЖАМ',
    'НЕ КЕ ДОЈДАМ СЕ ИПАК, ОТКАЖЕТЕ ГО',
    'МОРАМ ДА ОТКАЖАМ СВЕС, СЕ ИЗВИНУВАМ',
    'ОТКАЖЕТЕ ГО ТЕРМИНОТ НЕМА ДА ДОАЃАМЕ',
    'НЕ МОЖАМ ДА ДОЈДАМ, СЕ ИЗВИНУВАМ',
  ]) assert.equal(detectVisitCancellation(text), true, text);
  // neighborhood: the base NEIGHBORHOOD_RE owns "населби" / "квартали".
  for (const text of [
    'КАДЕ СЕ НАОЃААТ СТАНОВИТЕ, ВО КОИ НАСЕЛБИ РАБОТИТЕ',
    'ВО КОИ НАСЕЛБИ ИМАТЕ ПОНУДИ, МЕНЕ МЕ ИНТЕРЕСИРА КИСЕЛА ВОДА',
    'ЗДР, КОИ КВАРТАЛИ ГИ ПОКРИВАТЕ ЗА ПРОДАЖБА?',
    'МЕ ИНТЕРЕСИРА ВО КОИ НАСЕЛБИ ИМАТЕ СТАНОВИ ЗА ПРОДАЖБА',
    'ШО НАСЕЛБИ ИМАТЕ ВО ПОНУДА ВО МОМЕНТОВ?',
    'ПОЗДРАВ, ВО КОИ НАСЕЛБИ ИМАТЕ НАЈМНОГУ СТАНОВИ?',
    'КАДЕ СЕ НАОЃААТ СТАНОВИТЕ ОД ВАШАТА ПОНУДА, ВО КОИ НАСЕЛБИ?',
  ]) assert.equal(detectNeighborhoodAsk(text), true, text);
});
