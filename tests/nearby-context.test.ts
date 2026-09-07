import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectWhereIs, isOptionsFollowUp, hasProximityAnchor, mentionsMore, lastReplyWasProperty, detectDrugAlternative } from '../src/llm/deterministic';

// THE BUG: client gives criteria ("so edna spalna ili garsonjera", "do
// 100.000"), Lina presents EB 54 + EB 53, client asks "STO DRUGO IMA?"
// meaning "what OTHER apartments match" — Lina answered with a landmark
// ("Biser Shopping Center"). The whereIsSecondary list intercepted the
// phrase before the classifier ever saw it. The fix: context decides.

const OPTIONS_TEXT =
  'Врз основа на Вашите желби, составив листа од неколку опции:\n\n' +
  'Станот под Евидентен број 54 е двособен стан во Карпош III. Цената е 69.500 евра.';
const LANDMARK_TEXT =
  'Тоа се наоѓа во близина на Biser Shopping Center.\n' +
  'https://maps.google.com/?cid=3283248369585876398';

test('whereIsSecondary intercepts the ambiguous phrase (precondition of the bug)', () => {
  assert.deepEqual(detectWhereIs('STO DRUGO IMA?'), { place: '', generic: true });
});

test('presentation context: bare "more" ask is an options follow-up', () => {
  assert.equal(isOptionsFollowUp('STO DRUGO IMA?', OPTIONS_TEXT), true);
  assert.equal(isOptionsFollowUp('sto uste ima?', OPTIONS_TEXT), true);
  assert.equal(isOptionsFollowUp('nesto drugo?', OPTIONS_TEXT), true);
});

test('landmark context: same phrases stay where-is/nearby', () => {
  assert.equal(isOptionsFollowUp('STO DRUGO IMA?', LANDMARK_TEXT), false);
  assert.equal(isOptionsFollowUp('sto uste ima?', LANDMARK_TEXT), false);
  assert.equal(isOptionsFollowUp('STO DRUGO IMA?', 'Добар ден. Како можам да Ви помогнам?'), false);
});

test('a proximity anchor always wins — options context cannot capture it', () => {
  assert.equal(hasProximityAnchor('STO DRUGO IMA VO BLIZINA?'), true);
  assert.equal(hasProximityAnchor('sto uste ima okolu'), true);
  assert.equal(hasProximityAnchor('kade se naogja'), true);
  assert.equal(hasProximityAnchor('sto drugo ima'), false);
  assert.equal(isOptionsFollowUp('STO DRUGO IMA VO BLIZINA?', OPTIONS_TEXT), false);
});

test('no more-marker → never an options follow-up ("koi objekti ima" stays nearby)', () => {
  assert.equal(mentionsMore('koi objekti ima'), false);
  assert.equal(isOptionsFollowUp('koi objekti ima', OPTIONS_TEXT), false);
});

test('property-content marker: cards, price lines, visit messages AND exhausted/no-match lines; landmarks never', () => {
  assert.equal(lastReplyWasProperty(OPTIONS_TEXT), true);
  assert.equal(lastReplyWasProperty('Станот со Евидентен број 78 во Капиштец чини 185.000 евра.'), true);
  assert.equal(lastReplyWasProperty('ЛОКАЦИЈА ЗА ЕВИДЕНТЕН БРОЈ 76; 08.09.2026; 15:00'), true);
  assert.equal(lastReplyWasProperty('Ги исцрпивме сите расположливи имоти што одговараат на Вашите критериуми во Карпош III. Можам да ги забележам Вашите барања?'), true);
  assert.equal(lastReplyWasProperty('За жал, моментално немам слободни имоти во Карпош што одговараат на Вашите критериуми.'), true);
  assert.equal(lastReplyWasProperty(LANDMARK_TEXT), false);
});

test('classifier override: presentation state + "more" ask → SEARCH_REQUESTED (next batch)', () => {
  // detectDrugAlternative carries "друго" (the reported phrase); bare
  // "ustе" asks are covered by the presentation-only mentionsMore override.
  // NOTE: hasDrugAlt must NOT match bare "ustе" — "dali go imate uste?" is a
  // seen-property description and must keep the PROPERTY_DESCRIPTION path.
  assert.equal(detectDrugAlternative('STO DRUGO IMA?'), true);
  assert.equal(detectDrugAlternative('dali go imate uste ?'), false);
  // Price questions are excluded — "kolku ceni ima drugo?" is not a search.
  assert.equal(detectDrugAlternative('kolku cena ima drugo?'), false);
});
