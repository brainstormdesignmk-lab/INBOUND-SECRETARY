// The 21:51 transcript regression — EB 57 (Ѓуро Стругар):
//   1. "OVOJ 57 KADE SE NAOGJA VO STROG CENTAR ?" parsed the AREA phrase and
//      dropped the EB → the handler served the session's current property
//      (EB 56) and its cached landmark slots → Завод „Топанско поле", 3.2 km
//      from EB 57's real location (correct for 56 at 158 m — wrong property).
//   2. Rotation slots are now TAGGED with the EB they were resolved for and
//      self-heal in whereIsReply: a stale tag is discarded and re-resolved
//      for the property actually being served.
//   3. The property card printed "Има 0 м² деловна површина" — the feed's
//      missing-value 0 must never render; the mapper now treats 0 as absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectWhereIs } from '../src/llm/deterministic';
import { buildPropertyCard } from '../src/llm/prompts';
import type { Property } from '../src/data/properties';

test('where-is: a pre-verbal EB wins over a trailing area phrase', () => {
  // the exact 21:51 message
  assert.deepEqual(detectWhereIs('OVOJ 57 KADE SE NAOGJA VO STROG CENTAR ?'), { place: '57', generic: false });
  assert.deepEqual(detectWhereIs('ovoj 57 kade se naogja?'), { place: '57', generic: false });
  assert.deepEqual(detectWhereIs('ovoj 76 kade se naogja?'), { place: '76', generic: false });
  assert.deepEqual(detectWhereIs('станот 89 каде се наоѓа?'), { place: '89', generic: false });
  assert.deepEqual(detectWhereIs('toj 12 kade e?'), { place: '12', generic: false });
  // homoglyph mixes ("OVOJ" with Latin o) survive via normalizeMc
  assert.deepEqual(detectWhereIs('OVOJ 57 KADE SE NAOGJA ?'), { place: '57', generic: false });
  // existing forms still work
  assert.deepEqual(detectWhereIs('каде е 89?'), { place: '89', generic: false });
  assert.deepEqual(detectWhereIs('57 kade se naogja?'), { place: '57', generic: false });
});

test('where-is: stray numbers are NOT EB lookups', () => {
  // "80 м2" is a size, never an evidence number
  assert.deepEqual(detectWhereIs('стан од 80 м2 каде е?'), { place: '', generic: true });
  assert.deepEqual(detectWhereIs('stan od 80 m2 kade e?'), { place: '', generic: true });
  // a named place stays a named place
  assert.deepEqual(detectWhereIs('каде е Палома Бјанка?'), { place: 'Палома Бјанка', generic: false });
});

test('property card: sqm 0 / missing renders NO area line', () => {
  const base = {
    eb: 57, id: 57, price: 1000, service: 'rent' as const,
    business: true, address: 'Ѓуро Стругар', location: 'Центар',
  };
  const sqm0 = { ...base, sqm: 0, size: undefined } as unknown as Property;
  const card0 = buildPropertyCard(sqm0);
  assert.ok(!/0\s*м²/i.test(card0), `0 m² leaked into the card: ${card0}`);
  const missing = { ...base } as unknown as Property;
  const cardMissing = buildPropertyCard(missing);
  assert.ok(!/површин/i.test(cardMissing), `missing size rendered: ${cardMissing}`);
  // a real size still shows
  const real = { ...base, sqm: 45, size: '45 м²' } as unknown as Property;
  const cardReal = buildPropertyCard(real);
  assert.ok(/45\s*м²/.test(cardReal), `real size missing: ${cardReal}`);
});

test('feed mapper: povrsina_m2 = 0 is MISSING (the EB 57 data bug)', async () => {
  const { mapRow } = await import('../src/data/properties');
  const p = mapRow({
    evidenten_broj: '57', adresa: 'Ѓуро Стругар', cena_eur: 1000,
    servis: 'Издава', povrsina_m2: 0, tip_na_nedviznina: 'Деловен простор',
  });
  assert.ok(p);
  assert.equal(p!.sqm, undefined, '0 m² must map to undefined');
  assert.equal(p!.size, undefined, '0 m² must not render a size label');
  const pReal = mapRow({
    evidenten_broj: '58', adresa: 'X', cena_eur: 1000,
    servis: 'Издава', povrsina_m2: 42, tip_na_nedviznina: 'Деловен простор',
  });
  assert.equal(pReal!.size, '42 м²');
});
