// The property card stores terrace / basement / AC, but until feed v11 the
// public-properties select never asked for them — so Lina always answered
// "немам податок" for questions the agency HAD answered on the card.
// These tests pin the feed keys to the feature phrases the replies use.
import { test } from 'node:test';
import assert from 'node:assert';
import { absentFeaturePhrases, featurePhrases, mapRow } from '../src/data/properties';

const feedRow = (extra: Record<string, unknown>) => ({
  evidenten_broj: '95',
  naslov: 'Стан 3-собен',
  adresa: 'ЦРВЕНА ВОДА',
  naselba: 'Центар',
  cena_eur: 204000,
  povrsina_m2: 74,
  servis: 'Продава',
  ...extra,
});

test('feed v11: terrace/basement/AC YES become answerable features', () => {
  const r = feedRow({ terasa: 'Да', podrum: 'Да', klima: 'Да' });
  const features = featurePhrases(r);
  assert.ok(features.includes('тераса'), features.join(' | '));
  assert.ok(features.includes('подрум'), features.join(' | '));
  assert.ok(features.includes('клима'), features.join(' | '));
});

test('feed v11: explicit NO is a known fact, not missing data', () => {
  const r = feedRow({ terasa: 'Не', podrum: 'Не', klima: 'Не' });
  const absent = absentFeaturePhrases(r);
  assert.ok(absent.includes('тераса'), absent.join(' | '));
  assert.ok(absent.includes('подрум'), absent.join(' | '));
  assert.ok(absent.includes('клима'), absent.join(' | '));
  assert.deepEqual(featurePhrases(r).filter(f => ['тераса', 'подрум', 'клима'].includes(f)), []);
});

test('feed v11: missing attributes are neither present nor absent', () => {
  const r = feedRow({});
  const both = [...featurePhrases(r), ...absentFeaturePhrases(r)];
  for (const f of ['тераса', 'подрум', 'клима']) {
    assert.ok(!both.includes(f), `${f} must stay unknown, got ${both.join(' | ')}`);
  }
});

test('feed v11: total_floors reaches Lina as the building storey count', () => {
  const p = mapRow(feedRow({ kat: 3, vkupno_katovi: 7 }));
  assert.ok(p);
  assert.equal(p!.floor, 3);
  assert.equal(p!.totalFloors, 7);
});

test('feed v11: "Не е наведено" storeys stay unknown (no 0-storey building)', () => {
  const p = mapRow(feedRow({ kat: 'Не е наведено', vkupno_katovi: 'Не е наведено' }));
  assert.ok(p);
  assert.equal(p!.floor, undefined);
  assert.equal(p!.totalFloors, undefined);
});

test('feed v11: a 0 total_floors from the old empty card is not a building', () => {
  const p = mapRow(feedRow({ kat: 0, vkupno_katovi: 0 }));
  assert.ok(p);
  assert.equal(p!.floor, 0, 'приземје is floor 0');
  assert.equal(p!.totalFloors, undefined, '0 storeys must stay unknown');
});
