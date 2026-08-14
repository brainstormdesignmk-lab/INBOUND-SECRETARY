import { test } from 'node:test';
import assert from 'node:assert';
import { guardText } from '../src/llm/respond';
import { buildPropertyCards, buildPropertyCard } from '../src/llm/prompts';
import { Property } from '../src/data/properties';

test('guardText: property prices are quoted in euros, never denars', () => {
  assert.equal(guardText('presentation', 'Цената изнесува 46.000 денари'), 'Цената изнесува 46.000 евра');
  assert.equal(guardText('presentation', 'има и 5.000 денари кирија'), 'има и 5.000 евра кирија');
  // already euros — untouched
  assert.equal(guardText('presentation', 'Цената изнесува 46.000 евра'), 'Цената изнесува 46.000 евра');
});

test('guardText: the viewing fee stays in denars (always < 1000)', () => {
  const s = 'Надоместот е 600 денари (10 евра). Дали се согласувате?';
  assert.equal(guardText('closing', s), s);
  assert.equal(guardText('closing', '300 денари за разгледување'), '300 денари за разгледување');
});

test('guardText: fee mention blocked before interest (fallback reply)', () => {
  const out = guardText('presentation', 'Надоместот е 600 денари');
  assert.ok(!out.includes('600'));
  assert.ok(!out.includes('Надомест'));
});

test('guardText: a property price ending in 300/600 евра is NOT a fee mention', () => {
  // Regression: the unanchored FEE_RE matched "300 евра" inside "68.300 евра"
  // and replaced the whole property card with the generic fallback line.
  const s = 'Цената изнесува 68.300 евра, а Евидентен број 80 чини 46.000 евра';
  assert.equal(guardText('presentation', s), s);
  assert.equal(guardText('presentation', 'Гарсоњера 46.000 евра'), 'Гарсоњера 46.000 евра');
});

test('guardText: ИД/ID terminology is normalized (Cyrillic boundary works)', () => {
  assert.equal(guardText('presentation', 'имотот има ИД 95'), 'имотот има Евидентен број 95');
  assert.equal(guardText('presentation', 'имотот има ID 95'), 'имотот има Евидентен број 95');
  assert.equal(guardText('presentation', 'Евидентен број 95 е достапен'), 'Евидентен број 95 е достапен');
});

test('guardText: Russian intrusion is replaced deterministically', () => {
  assert.equal(guardText('closing', 'спремна за используется'), 'спремна за користење');
});

test('guardText: tokenizer garbage characters are stripped', () => {
  assert.equal(guardText('presentation', 'е во顶 сосојба'), 'е во сосојба');
  assert.equal(guardText('presentation', 'објект ✅ 😀'), 'објект');
});

test('guardText: newlines survive sanitization (code-built cards stay readable)', () => {
  const card = 'Евидентен број 80\nЛокација: Кисела Вода\nЦена: 46.000 евра';
  assert.equal(guardText('presentation', card), card);
});

test('buildPropertyCards: code-built PROSE card quotes euros and real data (LLM-less fallback)', () => {
  const prop: Property = {
    eb: 82, id: 82, address: 'Јане Сандански 35', location: 'Аеродром',
    price: 143000, bedrooms: 3, size: '77 м²',
    features: ['лифт', 'парно', 'јавен паркинг', 'наместен'],
  };
  const card = buildPropertyCard(prop);
  assert.ok(card.includes('Станот под Евидентен број 82 е трисобен стан во Аеродром.'), card);
  assert.ok(card.includes('Се наоѓа на улица Јане Сандански 35.'), card);
  assert.ok(card.includes('Има 77 м² станбена површина.'), card);
  assert.ok(card.includes('Во него има лифт, парно и јавен паркинг.'), card);
  assert.ok(card.includes('Станот е целосно наместен.'), card);
  assert.ok(card.includes('Цената е 143.000 евра.'), card);
  // prose, not a spec sheet — no "Клуч: Вредност" walls
  assert.ok(!card.includes('Локација:'));
  assert.ok(!card.includes('Одлики:'));
  assert.ok(!card.includes('денари'));
  const pres = buildPropertyCards([prop], 'presentation');
  assert.ok(pres.includes('организираме посета'));
  const q = buildPropertyCards([prop], 'property_query');
  assert.ok(q.includes('Дали би сакале да организираме посета'));
});

test('buildPropertyCard: гарсоњера inferred from size when bedrooms are missing', () => {
  const prop: Property = {
    eb: 80, id: 80, address: 'Ефтим Спространов', location: 'Кисела Вода',
    price: 46000, size: '24 м²', features: ['лифт', 'греење на струја', 'јавен паркинг'],
  };
  const card = buildPropertyCard(prop);
  assert.ok(card.includes('е гарсоњера во Кисела Вода'), card);
  assert.ok(card.includes('Во него има лифт, греење на струја и јавен паркинг.'), card);
  assert.ok(card.includes('Цената е 46.000 евра.'), card);
});

test('buildPropertyCard: partially furnished renders honestly (future rows)', () => {
  const prop: Property = {
    eb: 999, id: 999, address: 'Драчево 12а', location: 'Драчево',
    price: 88000, size: '68 м²', features: ['лифт', 'делумно наместен'],
  };
  const card = buildPropertyCard(prop);
  assert.ok(card.includes('Станот е делумно наместен.'), card);
  assert.ok(!card.includes('целосно наместен'), card);
});
