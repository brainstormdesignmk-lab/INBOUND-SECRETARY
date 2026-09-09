import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectWhyFollowUp,
  lastReplyWasNearby,
  mentionsMore,
  hasProximityAnchor,
  detectWidenIntent,
  detectExplicitWiden,
  detectAvailabilityAsk,
  detectPriceAsk,
  detectWhereIs,
  isOptionsFollowUp,
} from '../src/llm/deterministic';
import { RESPONSE_BANK } from '../src/data/responses';
import { FROZEN_BANK_KEYS, isExcludedFromEnrichment } from '../src/store/bank';

// THE TRANSCRIPT BUGS (20:56 / 21:00):
// 1. "ZOSTO?" after the privacy-protocol line fell through to the options-
//    exhausted reply instead of the agency-rules explanation.
// 2. "I STO USTE?" after a landmark/protocol reply leaked into the options
//    thread ("Ги погледнавме сите достапни опции…") instead of continuing
//    the nearby rotation toward the shut-down.

const LANDMARK_REPLY =
  'Тоа се наоѓа во близина на Shopping Center Capitol Mall.\n' +
  'https://maps.google.com/?cid=6060322835712121595';
const PROTOCOL_REPLY =
  'Точните податоци за локацијата ќе Ви ги доставам непосредно пред посетата, бидејќи тоа е официјално правило на Агенцијата.';
const SHUTDOWN_REPLY =
  'Мислам дека Ви е јасен реонот во кој се наоѓа недвижнината. Точната адреса ќе ја дознаете на ден на посетата.';
const OPTIONS_REPLY =
  'Врз основа на Вашите желби, составив листа од неколку опции:\n\nСтанот под Евидентен број 54 е двособен стан во Карпош III.';

test('bare why detector: grammar word classes cover the family', () => {
  assert.equal(detectWhyFollowUp('ZOSTO?'), true);
  assert.equal(detectWhyFollowUp('зошто?'), true);
  assert.equal(detectWhyFollowUp('зошто така?'), true);
  assert.equal(detectWhyFollowUp('зошто тоа?'), true);
  assert.equal(detectWhyFollowUp('zosto'), true);
  assert.equal(detectWhyFollowUp('zashto?'), true);
  assert.equal(detectWhyFollowUp('zoshto?'), true);
  assert.equal(detectWhyFollowUp('зошто па?'), true);
  assert.equal(detectWhyFollowUp('зошто вака?'), true);
  // Topic why-questions are owned by their own detectors — the bare form
  // must NOT capture them.
  assert.equal(detectWhyFollowUp('зошто наплаќате посета?'), false);
  assert.equal(detectWhyFollowUp('зошто е цената 185.000?'), false);
  assert.equal(detectWhyFollowUp('зошто треба да платам?'), false);
});

test('nearby-thread marker: landmark, protocol and shut-down replies all anchor the thread; visit message never', () => {
  assert.equal(lastReplyWasNearby(LANDMARK_REPLY), true);
  assert.equal(lastReplyWasNearby(PROTOCOL_REPLY), true);
  assert.equal(lastReplyWasNearby(SHUTDOWN_REPLY), true);
  assert.equal(lastReplyWasNearby('ЛОКАЦИЈА ЗА ЕВИДЕНТЕН БРОЈ 76; 08.09.2026; 15:00'), false);
  assert.equal(lastReplyWasNearby(OPTIONS_REPLY), false);
  assert.equal(lastReplyWasNearby('Добар ден. Како можам да Ви помогнам?'), false);
});

test('learned address.exact variants with гледање phrasing anchor the why-gate (the 18:35 transcript)', () => {
  // A learned address.exact variant whose phrasing the old matcher missed:
  const learned = 'Прецизните детали за адресата ќе ги споделам со Вас на денот на закажаното гледање, во согласност со правилата по кои работи Агенцијата.';
  assert.equal(lastReplyWasNearby(learned), true);
  assert.equal(detectWhyFollowUp('ZOSTO?') && lastReplyWasNearby(learned), true);
  // Other learned interpolations stay covered:
  assert.equal(lastReplyWasNearby('Точната адреса ќе ја добиете на денот на гледањето, согласно политиката на Агенцијата.'), true);
  assert.equal(lastReplyWasNearby('Адресата ќе Ви биде доставена пред закажаниот термин за разгледување.'), true);
  // A plain address line with no rule/visit marker never anchors:
  assert.equal(lastReplyWasNearby('Адресата на имотот е во Центар, спроти паркот.'), false);
});

test('bare more-ask after nearby replies qualifies for the nearby thread', () => {
  const qualifies = (t: string) =>
    mentionsMore(t) && !hasProximityAnchor(t)
    && !detectWidenIntent(t) && !detectExplicitWiden(t)
    && !detectAvailabilityAsk(t) && !detectPriceAsk(t);
  assert.equal(qualifies('I STO USTE?'), true);
  assert.equal(qualifies('nesto drugo?'), true);
  // "сто друго има?" collides with detectAvailabilityAsk (its "има") so the
  // NEW gate stands down. The LATIN form ("STO DRUGO IMA?", the one clients
  // actually type) keeps its existing detectWhereIs interception → rotation.
  assert.equal(qualifies('сто друго има?'), false);
  assert.deepEqual(detectWhereIs('STO DRUGO IMA?'), { place: '', generic: true });
  assert.equal(isOptionsFollowUp('STO DRUGO IMA?', LANDMARK_REPLY), false);
  // Excluded intents own their words regardless of context:
  assert.equal(qualifies('sto uste ima vo blizina'), false);   // proximity anchor → NEARBY_ASK path
  assert.equal(qualifies('PROSIRI JA POTRAGATA'), false);      // widen → options thread
  assert.equal(qualifies('dali uste e dostapen?'), false);     // availability
  assert.equal(qualifies('kolku chini?'), false);              // price
});

test('address.why bank key: user wording first, all variants clean', () => {
  const v = (RESPONSE_BANK as Record<string, string[]> | undefined)['address.why'];
  assert.ok(Array.isArray(v) && v.length >= 6, 'address.why must carry >=6 seed variants');
  assert.match(v![0]!, /Затоа што тоа се правилата на Агенцијата/);
  for (const s of v!) {
    assert.doesNotMatch(s, /\{|\}|https?:|Евидентен|евра|денари/);
  }
  // FROZEN — same family as fee.why: fixed pool, never enriched, never
  // learned (no unbounded bank growth).
  assert.equal(FROZEN_BANK_KEYS.has('address.why'), true);
  assert.equal(isExcludedFromEnrichment('address.why'), true);
});

test('nearby.exhausted bank key still intact (the shut-down wording)', () => {
  const v = (RESPONSE_BANK as Record<string, string[]> | undefined)['nearby.exhausted'];
  assert.ok(Array.isArray(v) && v.length >= 6);
  assert.match(v![0]!, /Мислам дека Ви е јасен реонот/);
});

test('protocol lines anchor the nearby thread for the bare more-ask (regression of the 21:00 leak)', () => {
  // After a protocol line, a bare "I STO USTE?" must NOT be an options
  // follow-up — it must continue the nearby thread.
  assert.equal(isOptionsFollowUpSafe('I STO USTE?', PROTOCOL_REPLY), false);
  assert.equal(isOptionsFollowUpSafe('I STO USTE?', LANDMARK_REPLY), false);
  assert.equal(isOptionsFollowUpSafe('I STO USTE?', OPTIONS_REPLY), true);
});

// Local re-implementation of the whereIs gate condition (mirrors inbound.ts)
// so the test stays independent of the handler wiring.
function isOptionsFollowUpSafe(text: string, last: string): boolean {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { isOptionsFollowUp } = require('../src/llm/deterministic') as typeof import('../src/llm/deterministic');
  return isOptionsFollowUp(text, last);
}
