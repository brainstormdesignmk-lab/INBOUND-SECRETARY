import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectRecommendAsk, collectMentionedEbs, buildRecommendation } from '../src/llm/recommend';
import { buildRecommendClose } from '../src/llm/prompts';
import { RESPONSE_BANK } from '../src/data/responses';

// THE TRANSCRIPT: "me interesira stanot 89" / "i stanot 94" / "koj bi mi go
// preporacale?" — the client named TWO EBs and asked which to choose. No
// detector fired, the LLM misread it as SEEN_PROPERTY, and Lina asked
// "Дали го знаете Евидентен број?" — for numbers the client JUST gave.

test('recommend-ask detector: grammar family coverage', () => {
  assert.equal(detectRecommendAsk('koj bi mi go preporacale ?'), true);
  assert.equal(detectRecommendAsk('Koj da go izberam?'), true);
  assert.equal(detectRecommendAsk('кој би ми го препорачале?'), true);
  assert.equal(detectRecommendAsk('што би ми препорачале?'), true);
  assert.equal(detectRecommendAsk('preporacaj mi nesto'), true);
  assert.equal(detectRecommendAsk('ПРЕПОРАЧАЈ МИ'), true);
  assert.equal(detectRecommendAsk('preporaka?'), true);
});

test('recommend-ask detector: unrelated messages never match', () => {
  assert.equal(detectRecommendAsk('me interesira stanot 89'), false);
  assert.equal(detectRecommendAsk('i stanot 94'), false);
  assert.equal(detectRecommendAsk('kade se naogja?'), false);
  assert.equal(detectRecommendAsk('kolku chini?'), false);
  assert.equal(detectRecommendAsk('dali e dostapen 89?'), false);
});

test('collectMentionedEbs: finds valid EBs across the recent messages', () => {
  const valid = new Set([89, 94, 76]);
  assert.deepEqual(
    collectMentionedEbs(['zdravo', 'me interesira stanot 89', 'i stanot 94', 'koj bi mi go preporacale ?'], valid),
    [89, 94],
  );
  // Order = mention order; single mention works:
  assert.deepEqual(collectMentionedEbs(['stan 76'], valid), [76]);
  // Invalid EBs are dropped:
  assert.deepEqual(collectMentionedEbs(['stan 55'], valid), []);
});

test('collectMentionedEbs: prices never read as EBs', () => {
  const valid = new Set<number>([89, 94, 100]);
  // "110 000" / "100.000" are PRICES — the thousands-guard must reject them
  // even when 100 happens to be a valid EB. "cena od" prefix likewise.
  assert.deepEqual(
    collectMentionedEbs(['cena od 110 000 evra', 'do 100.000'], valid),
    [],
  );
});

test('buildRecommendation: full cards from DB facts + the clientela close', () => {
  const p = {
    eb: 89, address: '', location: 'Аеродром', bedrooms: 1,
    price: 110000, house: false, business: false, features: [],
  } as never;
  const out = buildRecommendation([p], buildRecommendClose([]));
  assert.match(out, /Евидентен број 89/);
  assert.match(out, /Аеродром/);
  assert.match(out, /110\.000/);
  // The close: any variant, but always the clientela/in-person framing +
  // the visit offer.
  assert.match(out, /посета\?$/);
  assert.match(out, /осетите просторот|на лице место|во живо|погледнете во живо/);
});

test('recommend.close bank key: seeds present and clean', () => {
  const v = (RESPONSE_BANK as Record<string, string[]> | undefined)['recommend.close'];
  assert.ok(Array.isArray(v) && v.length >= 6, 'recommend.close must carry >=6 seed variants');
  for (const s of v!) {
    assert.doesNotMatch(s, /\{|\}|https?:|денари/);
    assert.match(s, /посета|осетите/);
  }
});
