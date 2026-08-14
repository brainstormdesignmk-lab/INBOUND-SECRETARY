import { test } from 'node:test';
import assert from 'node:assert';
import { guardText } from '../src/llm/respond';
import { buildPropertyCards, buildPropertyCard, buildDiscoveryAsk, buildPropertyContext, PRESENTATION_CLOSERS, PROPERTY_QUERY_CLOSERS } from '../src/llm/prompts';
import { SlotData } from '../src/fsm/session';
import { Property } from '../src/data/properties';

const SITE = 'https://preview--home-scan-search.lovable.app';

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

test('buildPropertyCards: the closing question rotates — no repeated sentences', () => {
  const prop: Property = {
    eb: 63, id: 63, address: 'x', location: 'Центар', price: 36000,
  };
  const a = buildPropertyCards([prop], 'presentation', undefined, 0);
  const b = buildPropertyCards([prop], 'presentation', undefined, 1);
  assert.notEqual(a, b);
  assert.equal(a.split('\n\n').pop(), PRESENTATION_CLOSERS[0]);
  assert.equal(b.split('\n\n').pop(), PRESENTATION_CLOSERS[1]);
  assert.equal(new Set(PRESENTATION_CLOSERS).size, PRESENTATION_CLOSERS.length); // all distinct
  assert.equal(new Set(PROPERTY_QUERY_CLOSERS).size, PROPERTY_QUERY_CLOSERS.length);
  const q0 = buildPropertyCards([prop], 'property_query', undefined, 0);
  const q1 = buildPropertyCards([prop], 'property_query', undefined, 1);
  assert.notEqual(q0, q1);
  assert.equal(q0.split('\n\n').pop(), PROPERTY_QUERY_CLOSERS[0]);
  assert.equal(q1.split('\n\n').pop(), PROPERTY_QUERY_CLOSERS[1]);
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

test('guardText: a bare /property/... path becomes a full clickable public link', () => {
  const s = '**Повеќе информации:** /property/37c5d771-b26c-4993-bebd-9b9f4766d769';
  const out = guardText('presentation', s, SITE);
  assert.equal(out, `**Повеќе информации:** ${SITE}/property/37c5d771-b26c-4993-bebd-9b9f4766d769`);
  // already-full URLs are left untouched
  const full = `Повеќе информации: ${SITE}/property/fe3c38df-63cb-4166-a295-0ab8d6831f1d`;
  assert.equal(guardText('presentation', full, SITE), full);
  // without a configured site the path stays as-is (nothing to prepend)
  assert.equal(guardText('presentation', s), s);
});

test('buildDiscoveryAsk: business spaces ask location/sqm/price — NEVER bedrooms', () => {
  const ask = buildDiscoveryAsk({ service: 'rent', location: 'Карпош III', business: true } as SlotData);
  assert.ok(ask.includes('Разбрав — барате деловен простор, за изнајмување, во Карпош III.'), ask);
  assert.ok(ask.includes('Која површина (во м²) ја барате?'), ask);
  assert.ok(ask.includes('До која цена го барате?'), ask);
  assert.ok(!ask.includes('спални'), ask);
  assert.ok(!ask.includes('Колку спални'), ask);
  // known sqm -> only the price is missing
  const partial = buildDiscoveryAsk({ service: 'rent', location: 'Карпош III', business: true, sqm: 40 } as SlotData);
  assert.ok(partial.includes('со 40 м²'), partial);
  assert.ok(!partial.includes('површина (во м²)'), partial);
  assert.ok(partial.includes('До која цена'), partial);
});

test('buildPropertyCard: business spaces read as деловен простор, not стан', () => {
  const prop: Property = {
    eb: 56, id: 56, address: 'Палома Бјанка', price: 500, sqm: 40, size: '40 м²',
    business: true, service: 'rent',
  };
  const card = buildPropertyCard(prop);
  assert.ok(card.includes('Деловниот простор под Евидентен број 56.'), card);
  assert.ok(card.includes('Има 40 м² деловна површина.'), card);
  assert.ok(!card.includes('Станот'), card);
  assert.ok(!card.includes('станбена'), card);
});

test('buildPropertyCard: includes the full public link when the feed has a url', () => {
  const prop: Property = {
    eb: 63, id: 63, address: 'Црногорска Амбасада', location: 'Центар',
    price: 36000, size: '28 м²', url: '/property/37c5d771-b26c-4993-bebd-9b9f4766d769',
  };
  const card = buildPropertyCard(prop, SITE);
  assert.ok(card.includes(`Повеќе информации: ${SITE}/property/37c5d771-b26c-4993-bebd-9b9f4766d769`), card);
  assert.ok(!card.includes('/property/37c5d771') || card.includes(SITE), card);
});

test('buildPropertyContext: the LLM receives the FULL url, never the relative path', () => {
  const prop: Property = {
    eb: 63, id: 63, address: 'x', location: 'Центар',
    price: 36000, url: '/property/37c5d771-b26c-4993-bebd-9b9f4766d769',
  };
  const ctx = buildPropertyContext([prop], SITE);
  assert.ok(ctx.includes(`${SITE}/property/37c5d771-b26c-4993-bebd-9b9f4766d769`), ctx);
  assert.ok(!ctx.includes('"url": "/property/'), ctx);
});

test('buildDiscoveryAsk: never re-asks known slots, never the generic buy/rent battery', () => {
  // intent + location + bedrooms known -> asks ONLY for the budget
  const ask = buildDiscoveryAsk({ service: 'buy', location: 'Кисела Вода', bedrooms: 1 } as SlotData);
  assert.ok(ask.includes('Разбрав — барате стан за купување, во Кисела Вода, со една спална соба.'), ask);
  assert.ok(ask.includes('До која цена го барате станот?'), ask);
  assert.ok(!ask.includes('купување или за изнајмување'), ask);
  assert.ok(!ask.includes('Колку спални'), ask);
  assert.ok(!ask.includes('Во кој дел'), ask);
  // intent known, no location -> asks location only
  const loc = buildDiscoveryAsk({ service: 'buy' } as SlotData);
  assert.ok(loc.includes('Во кој дел од градот го барате станот?'), loc);
  assert.ok(!loc.includes('купување или за изнајмување'), loc);
  assert.ok(!loc.includes('Колку спални'), loc);
  // nothing known -> asks the intent question (the ONLY legitimate case)
  const first = buildDiscoveryAsk({} as SlotData);
  assert.ok(first.includes('Дали станот го барате за купување или за изнајмување?'), first);
  // budget renders with thousands separator
  const budget = buildDiscoveryAsk({ service: 'buy', location: 'Центар', bedrooms: 2, budget: '80000' } as SlotData);
  assert.ok(budget.includes('до 80.000 евра'), budget);
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
