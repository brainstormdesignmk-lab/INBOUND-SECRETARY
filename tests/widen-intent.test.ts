import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectExplicitWiden, detectWidenIntent, detectAgreement } from '../src/llm/deterministic';

// THE BUG: Lina asks "…или да ја прошириме потрагата во друга населба?" after
// the area is drained. The client answers with a COMMAND ("PROSIRI JA
// POTRAGATA") or an area question ("A VO DRUGI NASELBI NESTO SO TIE
// KARAKTERISTIKI?") — but detectWidenIntent only accepted pure AGREEMENT
// ("добро", "да"), so Lina looped the exhausted line instead of widening.

test('exact transcript: PROSIRI JA POTRAGATA is an explicit widen command', () => {
  assert.equal(detectExplicitWiden('PROSIRI JA POTRAGATA'), true);
  assert.equal(detectExplicitWiden('prosiri ja potragata'), true);
  assert.equal(detectExplicitWiden('прошири ја потрагата'), true);
  assert.equal(detectExplicitWiden('прошири'), true);
  assert.equal(detectExplicitWiden('prosiri'), true);
});

test('exact transcript: area question phrases widen', () => {
  assert.equal(detectExplicitWiden('A VO DRUGI NASELBI NESTO SO TIE KARAKTERISTIKI ?'), true);
  assert.equal(detectExplicitWiden('a vo drugi naselbi nesto?'), true);
  assert.equal(detectExplicitWiden('drugi naselbi?'), true);
  assert.equal(detectExplicitWiden('imash nesto vo druga naselba?'), true);
  assert.equal(detectExplicitWiden('што има во друг реон?'), true);
  assert.equal(detectExplicitWiden('друг дел од градот'), true);
});

test('ambiguous verbs widen only with an object or area', () => {
  assert.equal(detectExplicitWiden('провери ја листата'), true);
  assert.equal(detectExplicitWiden('razgledaj drugi naselbi'), true);
  assert.equal(detectExplicitWiden('провери друг дел од градот'), true);
  // bare ambiguous verb = "look!", NOT widen
  assert.equal(detectExplicitWiden('види'), false);
  assert.equal(detectExplicitWiden('провери'), false);
});

test('negatives never widen', () => {
  assert.equal(detectExplicitWiden('не барам стан'), false);
  assert.equal(detectExplicitWiden('друга населба ми е Карпош'), false);
  assert.equal(detectExplicitWiden('барам во Аеродром'), false);
  assert.equal(detectExplicitWiden('здраво'), false);
});

test('register intents stay excluded from the widen pivot (queue wins)', () => {
  // "запиши ме" is agreement but chooses the QUEUE — detectWidenIntent
  // excludes it; detectExplicitWiden must not capture it either.
  assert.equal(detectExplicitWiden('запиши ме'), false);
  assert.equal(detectExplicitWiden('контактирај ме'), false);
  assert.equal(detectWidenIntent('запиши ме'), false);
  // And a pure agreement still widens via detectWidenIntent (unchanged path).
  assert.equal(detectWidenIntent('добро'), true);
  assert.equal(detectAgreement('добро'), true);
});
