// THE [10:40] FLOOR TRANSCRIPT — three different questions, one wrong answer.
//
//   [10:39] 85 DALI E SO LIFT ?                       → "Нема лифт." (feed: lift = Не)
//   [10:40] DALI E NA POSLEDEN KAT?                   → "Се наоѓа на 3 кат."
//   [10:40] KOLKU IMA SPRATOVI ZGRADATA ?             → "Се наоѓа на 3 кат."
//   [10:42] KOLKU VKUPNO SPRATOVI IMA ZGRADATA … 73?  → "Се наоѓа на 1 кат."
//
// Every one of those answers is the UNIT'S floor, because detectInfoFacets
// collapsed the whole floor family into `floor`. "Колку ката има зградата"
// asks for the BUILDING's height (feed column `vkupno_katovi`), and "е на
// последен кат?" needs BOTH facts — the unit floor alone cannot answer it.
// The structured columns were also never mapped (`kat`/`vkupno_katovi` were
// ignored; the floor was scraped out of `opis`), so a hand-entered property
// whose ad text never names the floor answered "not in the data" while the
// feed knew it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapRow, Property } from '../src/data/properties';
import {
  detectInfoFacets, buildInfoAnswer, INFO_NO_DATA_LINE, INFO_NO_FLOORS_LINE,
} from '../src/llm/infoAnswer';

const row = (over: Record<string, unknown>): Record<string, unknown> => ({
  evidenten_broj: '85',
  naslov: 'Ул. Тест 1',
  naselba: 'Центар',
  cena_eur: 100000,
  povrsina_m2: 60,
  tip_na_sobi: 'Двособен',
  servis: 'Купување',
  ...over,
});

test('mapRow reads the structured storey columns (kat / vkupno_katovi)', () => {
  const p = mapRow(row({ kat: '3', vkupno_katovi: '5' }))!;
  assert.equal(p.floor, 3, 'kat → unit floor');
  assert.equal(p.totalFloors, 5, 'vkupno_katovi → building storeys');
  // The edge feed emits the literal string for "unknown" — never NaN/0.
  const unknown = mapRow(row({ kat: 'Не е наведено', vkupno_katovi: 'Не е наведено' }))!;
  assert.equal(unknown.floor, undefined);
  assert.equal(unknown.totalFloors, undefined);
  // Ground floor has its own word in the feed.
  assert.equal(mapRow(row({ kat: 'приземје' }))!.floor, 0);
  // Numeric columns (the raw Supabase table names) work too.
  assert.equal(mapRow(row({ floor: 2, total_floors: 4 }))!.floor, 2);
  assert.equal(mapRow(row({ floor: 2, total_floors: 4 }))!.totalFloors, 4);
});

test('mapRow keeps an explicit "Не" as a known absence, not missing data', () => {
  const no = mapRow(row({ lift: 'Не', garaza: 'Не', dvor: 'Не' }))!;
  assert.deepEqual(no.noFeatures, ['гаража', 'лифт', 'двор']);
  assert.deepEqual(no.features, []);
  const yes = mapRow(row({ lift: 'Да' }))!;
  assert.ok(yes.features?.includes('лифт'));
  assert.deepEqual(yes.noFeatures, []);
  // "Не е наведено" is MISSING, not absent — it must stay owner-relay.
  const unknown = mapRow(row({ lift: 'Не е наведено' }))!;
  assert.deepEqual(unknown.noFeatures, []);
});

test('the floor family splits: unit floor / building height / last floor', () => {
  const unit = detectInfoFacets('NA KOJ KAT E ?')!;
  assert.equal(unit.floor, true);
  assert.equal(unit.totalFloors, undefined);
  assert.equal(unit.lastFloor, undefined);

  const height = detectInfoFacets('KOLKU IMA SPRATOVI ZGRADATA ?')!;
  assert.equal(height.totalFloors, true, 'колку спратови = building height');
  assert.equal(height.floor, undefined, 'never the unit floor');

  const total = detectInfoFacets('KOLKU VKUPNO SPRATOVI IMA ZGRADATA KAGE STO SE NAOGJA 73?')!;
  assert.equal(total.totalFloors, true);
  assert.equal(total.floor, undefined);

  const last = detectInfoFacets('DALI E NA POSLEDEN KAT?')!;
  assert.equal(last.lastFloor, true, 'last-floor is a yes/no, not the floor');
  assert.equal(last.floor, undefined);

  // A size question that happens to name a floor stays a size question.
  const size = detectInfoFacets('KOLKU E Golem STANOT NA 3 KAT ?')!;
  assert.equal(size.sqm, true);
  assert.equal(size.totalFloors, undefined, 'колку + кат in a size phrase');
});

const P85 = {
  eb: 85, id: 85, location: 'Центар', price: 100000, sqm: 60, bedrooms: 2,
  service: 'buy', floor: 3, totalFloors: 5, details: 'Стан во Центар.',
} as Property;
const P85_UNKNOWN_HEIGHT = { ...P85, totalFloors: undefined } as Property;
const P73 = {
  eb: 73, id: 73, location: 'Карпош', price: 80000, sqm: 45, bedrooms: 1,
  service: 'buy', floor: 1, totalFloors: 4, details: 'Стан во Карпош.',
} as Property;

test('building height answers the count — never the unit floor', () => {
  const facets = detectInfoFacets('KOLKU IMA SPRATOVI ZGRADATA ?')!;
  const answer = buildInfoAnswer(P85, facets)!;
  assert.match(answer, /Зградата има 5 ката/);
  assert.doesNotMatch(answer, /Се наоѓа на 3 кат/, 'the unit floor is a different fact');
});

test('unknown building height is stated as missing — the floor is not repeated as the answer', () => {
  const facets = detectInfoFacets('KOLKU IMA SPRATOVI ZGRADATA ?')!;
  const answer = buildInfoAnswer(P85_UNKNOWN_HEIGHT, facets)!;
  assert.equal(answer, INFO_NO_FLOORS_LINE);
});

test('last-floor: yes/no with both facts, honest deferral with one', () => {
  const last = detectInfoFacets('DALI E NA POSLEDEN KAT?')!;
  const top = buildInfoAnswer({ ...P85, floor: 5 } as Property, last)!;
  assert.match(top, /Да — станот е на последниот кат \(5 од 5\)/);
  const notTop = buildInfoAnswer(P85, last)!;
  assert.match(notTop, /Не, станот е на 3 кат од вкупно 5/);
  // Height unknown: say the floor, then defer the actual question.
  const unknown = buildInfoAnswer(P85_UNKNOWN_HEIGHT, last)!;
  assert.match(unknown, /Се наоѓа на 3 кат, но немам податок во базата колку ката има зградата/);
  assert.doesNotMatch(unknown, /последниот кат/, 'never guess the top floor');
});

test('unit floor comes from the feed column first, the ad text only as fallback', () => {
  const facets = detectInfoFacets('NA KOJ KAT E ?')!;
  // The details never name a floor — the structured `kat` still answers.
  assert.equal(buildInfoAnswer(P73, facets), 'Се наоѓа на 1 кат.');
  // No structured floor, but the ad text names it.
  const textOnly = { ...P73, floor: undefined, details: 'Стан на 4 кат, реновиран.' } as Property;
  assert.equal(buildInfoAnswer(textOnly, facets), 'Се наоѓа на 4 кат.');
  // Neither: the honest line, never silence or a guess.
  const nothing = { ...P73, floor: undefined, details: 'Стан во Карпош.' } as Property;
  assert.equal(buildInfoAnswer(nothing, facets), INFO_NO_DATA_LINE);
});

test('a floor question about ANOTHER EB answers that EB, not the discussed one', () => {
  const facets = detectInfoFacets('KOLKU VKUPNO SPRATOVI IMA ZGRADATA KAGE STO SE NAOGJA 73?')!;
  assert.match(buildInfoAnswer(P73, facets)!, /Зградата има 4 ката/);
  assert.match(buildInfoAnswer(P85, facets)!, /Зградата има 5 ката/);
});
