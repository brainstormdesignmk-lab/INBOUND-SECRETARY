import { test } from 'node:test';
import assert from 'node:assert';
import { titleCase, featurePhrases } from '../src/data/properties';

test('titleCase: feed ALL-CAPS addresses become proper Macedonian titles', () => {
  assert.equal(titleCase('ШАМПИОНЧЕ КАК КИПЕР МАРКЕТ'), 'Шампионче Как Кипер Маркет');
  assert.equal(titleCase('ЛОКОВ 5'), 'Локов 5');
  assert.equal(titleCase('РОБЕРТ КОХ 3'), 'Роберт Кох 3');
  // already mixed-case — idempotent
  assert.equal(titleCase('Ефтим Спространов'), 'Ефтим Спространов');
  assert.equal(titleCase(''), '');
});

test('featurePhrases: "Клуч: Вредност" noise becomes clean Macedonian phrases', () => {
  const row = {
    lift: 'Да', greenje: 'Струја', parking: 'Јавен паркинг',
    opremenost: 'Наместен', garaza: 'Не',
  };
  assert.deepEqual(featurePhrases(row), ['лифт', 'греење на струја', 'јавен паркинг', 'наместен']);
  assert.deepEqual(featurePhrases({ greenje: 'Градско парно' }), ['парно']);
  assert.deepEqual(featurePhrases({ greenje: 'Дрва' }), ['греење на дрва']);
  assert.deepEqual(featurePhrases({ parking: 'Приватен' }), ['приватен паркинг']);
  assert.deepEqual(featurePhrases({ parking: 'Јавен' }), ['јавен паркинг']);
  assert.deepEqual(featurePhrases({ garaza: 'Да' }), ['гаража']);
  // partially furnished keeps its qualifier (future rows)
  assert.deepEqual(featurePhrases({ opremenost: 'Делумно наместен' }), ['делумно наместен']);
  assert.deepEqual(featurePhrases({ lift: 'Не', greenje: 'Не е наведено' }), []);
  assert.deepEqual(featurePhrases({}), []);
});
