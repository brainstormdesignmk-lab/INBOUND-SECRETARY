import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectNearbyAsk } from '../src/llm/deterministic';
import { RESPONSE_BANK } from '../src/data/responses';
import { pickVariant } from '../src/data/responseBank';

// THE BUG: "STO DRUGO IMA VO BLIZINA NA 78 ?" was detected as a nearby ask
// but the handler resolved shown[last] (EB 55, Влае) instead of EB 78
// (Капиштец) — serving landmarks from a totally different neighborhood
// (Reptil 7, Badu). The detection already matched; the FIX is the handler's
// EB extraction. These tests lock the detection contract the fix relies on.
test('EB-anchored nearby asks are detected (detection half of the contract)', () => {
  assert.equal(detectNearbyAsk('STO DRUGO IMA VO BLIZINA NA 78 ?'), true);
  assert.equal(detectNearbyAsk('sto uste ima vo blizina na 78'), true);
  assert.equal(detectNearbyAsk('sto drugo ima vo blizina na 63'), true);
});

test('plain nearby asks still detected; area-target asks stay search wishes', () => {
  assert.equal(detectNearbyAsk('STO USTE IMA VO BLIZINA ?'), true);
  assert.equal(detectNearbyAsk('I STO DRUGO?'), false); // no anchor → not nearby
  assert.equal(detectNearbyAsk('sto ima vo blizina na centar'), false); // area → search
});

// THE SHUT-DOWN: after 3 landmarks + 2 privacy-protocol rounds, further
// nearby asks get the exhausted line — not new landmarks, not options.
test('nearby.exhausted key exists in the seed bank with variants', () => {
  const vars = RESPONSE_BANK['nearby.exhausted'];
  assert.ok(Array.isArray(vars) && vars.length >= 5, `expected ≥5 variants, got ${vars?.length}`);
});

test('nearby.exhausted variants carry the approved wording (reon + visit day)', () => {
  const line = pickVariant('nearby.exhausted', {});
  assert.ok(line, 'pickVariant must serve a variant');
  // Family invariant over the whole Gemini-grown pool: area-is-clear word +
  // a visit-day/moment word ("ден на увид", "денот на нашата средба"…).
  const vars = RESPONSE_BANK['nearby.exhausted'];
  for (const s of [...(vars ?? []), line!]) {
    assert.match(s, /(?:реон|ориентир|близин|локаци|околи|населб|микролокаци|област|зона|местополож)/iu, s);
    assert.match(s, /(?:ден|кога|пред|час)/iu, s);
  }
  assert.ok(!/\d{2}\.\d+/.test(line!), 'no coordinates in the shut-down line');
  assert.ok(!/maps\.google|google\.com/.test(line!), 'no links in the shut-down line');
});

test('pickVariant rotates without repeating while fresh variants remain', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 6; i++) {
    const v = pickVariant('nearby.exhausted', { recent: [...seen] });
    if (v) seen.add(v);
  }
  assert.ok(seen.size >= 4, `expected ≥4 distinct variants across 6 picks, got ${seen.size}`);
});
