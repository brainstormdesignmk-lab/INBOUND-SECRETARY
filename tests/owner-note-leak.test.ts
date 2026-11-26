// THE V16K11 [10:58] TURN — the owner's internal note read out to the client.
//
//   [10:56] klient: moze i drugi opcii
//   [10:57] LINA:   Имотот под Евидентен број 55 се наоѓа во Влае, на адреса
//                   Reptil 7. Има површина од 240 м². Цената е 40.000 евра.
//                   Во описот е наведено: 35. 000 чисти бара 2%.
//
// «35.000 чисти» is what the OWNER wants net and «бара 2%» is his own ask —
// negotiation ground, written for the agent, never for the client. The ad text
// is served through ONE reader (conversationalDetails), so the veto lives
// there: the note's sentence is dropped and the property's real facts stay.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPropertyCard, conversationalDetails } from '../src/llm/prompts';
import { Property } from '../src/data/properties';

const EB55 = {
  eb: 55, id: 55, location: 'Влае', address: 'Reptil 7', price: 40000,
  sqm: 240, size: '240 м²', service: 'buy', details: 'Куќа со двор. Во описот е наведено: 35. 000 чисти бара 2%.',
} as unknown as Property;

test('the owner\'s net-price note never reaches the card', () => {
  const details = conversationalDetails(EB55) ?? '';
  assert.doesNotMatch(details, /чисти/iu, `the net ask is ours to hold: ${details}`);
  assert.doesNotMatch(details, /2\s*%/u, `the owner's rate is not a property fact: ${details}`);
  assert.doesNotMatch(details, /\b35[\s.]000\b/u, `the net figure is not in the copy: ${details}`);
  // The real fact beside the note survives.
  assert.match(details, /двор/iu, `the property's own fact stays: ${details}`);

  const card = buildPropertyCard(EB55);
  assert.doesNotMatch(card, /чисти|бара\s*2\s*%|35[\s.]000/u, `nothing leaks through the card: ${card}`);
});

test('the other owner-note shapes are dropped too, plain facts are not', () => {
  const rows = [
    'Бара 3% провизија од купувачот.',
    'Цената е фиксна, бара 2% за агенцијата.',
    '2% провизија за посредувањето.',
  ];
  for (const note of rows) {
    const p = { ...EB55, details: `Светол стан со тераса. ${note}` } as unknown as Property;
    const details = conversationalDetails(p) ?? '';
    assert.doesNotMatch(details, /%|провизи|чисти|бара/iu, `dropped: ${note} → ${details}`);
    assert.match(details, /тераса/iu, `the fact stays: ${details}`);
  }
  // A sentence that merely MENTIONS a commission in a non-owner-note shape is
  // untouched (only the owner's terms are the leak).
  const neutral = { ...EB55, details: 'Стан со тераса. Агенцијата не наплаќа провизија за купувачот.' } as unknown as Property;
  assert.match(conversationalDetails(neutral) ?? '', /купувачот/iu);
});
