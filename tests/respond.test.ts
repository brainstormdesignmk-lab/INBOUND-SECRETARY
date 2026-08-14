import { test } from 'node:test';
import assert from 'node:assert';
import { guardText } from '../src/llm/respond';
import { buildPropertyCards, buildPropertyCard, buildDiscoveryAsk, buildPropertyContext, buildFeeAsk, PRESENTATION_CLOSERS, PROPERTY_QUERY_CLOSERS } from '../src/llm/prompts';
import { SlotData } from '../src/fsm/session';
import { Property } from '../src/data/properties';

const SITE = 'https://preview--home-scan-search.lovable.app';

test('guardText: property prices are quoted in euros, never denars', () => {
  assert.equal(guardText('presentation', 'Цената изнесува 46.000 денари'), 'Цената изнесува 46.000 евра');
  assert.equal(guardText('presentation', 'има и 5.000 денари кирија'), 'има и 5.000 евра кирија');
  // already euros — untouched
  assert.equal(guardText('presentation', 'Цената изнесува 46.000 евра'), 'Цената изнесува 46.000 евра');
});

test('buildFeeAsk: the fee is disclosed the moment the client is interested — code-built, never skippable', () => {
  const buy = buildFeeAsk('buy');
  assert.ok(buy.includes('500 денари (10 евра)'), buy);
  assert.ok(buy.includes('НЕ плаќате агенциска провизија'), buy);
  assert.ok(buy.includes('Дали се согласувате'), buy);
  const rent = buildFeeAsk('rent');
  assert.ok(rent.includes('300 денари (5 евра)'), rent);
  assert.ok(rent.includes('Дали се согласувате'), rent);
  assert.ok(!rent.includes('600'), rent);
  // guard keeps it intact in closing (fee is legal there)
  assert.equal(guardText('closing', rent), rent);
});

test('guardText: owner-contact/phone asks are blocked before the fee is agreed', () => {
  const jump = 'Морам да го контактирам сопственикот. Кажете ми го вашиот телефонски број.';
  const out = guardText('property_query', jump);
  assert.ok(!out.includes('телефонски'), out);
  assert.ok(!out.includes('сопственик'), out);
  // legal in contact_collection (after FEE_AGREED)
  const legal = 'Ве молам кажете ми го вашето име и телефонски број за контакт.';
  assert.equal(guardText('contact_collection', legal), legal);
});

test('guardText: the viewing fee stays in denars (always < 1000)', () => {
  const s = 'Надоместот е 500 денари (10 евра). Дали се согласувате?';
  assert.equal(guardText('closing', s), s);
  assert.equal(guardText('closing', '300 денари за разгледување'), '300 денари за разгледување');
});

test('guardText: fee mention blocked before interest (fallback reply)', () => {
  const out = guardText('presentation', 'Надоместот е 500 денари');
  assert.ok(!out.includes('500'));
  assert.ok(!out.includes('Надомест'));
});

test('guardText: property prices in евра are never a fee mention', () => {
  // Regression: the unanchored FEE_RE matched "300 евра" inside "68.300 евра"
  // and replaced the whole property card with the generic fallback line.
  const s = 'Цената изнесува 68.300 евра, а Евидентен број 80 чини 46.000 евра';
  assert.equal(guardText('presentation', s), s);
  assert.equal(guardText('presentation', 'Гарсоњера 46.000 евра'), 'Гарсоњера 46.000 евра');
  // a real rent price of exactly 500 евра (EB 56) is a PRICE, not the 500-денар fee
  assert.equal(guardText('presentation', 'Цената е 500 евра'), 'Цената е 500 евра');
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
  const a = buildPropertyCards([prop], 'presentation', 0);
  const b = buildPropertyCards([prop], 'presentation', 1);
  assert.notEqual(a, b);
  assert.equal(a.split('\n\n').pop(), PRESENTATION_CLOSERS[0]);
  assert.equal(b.split('\n\n').pop(), PRESENTATION_CLOSERS[1]);
  assert.equal(new Set(PRESENTATION_CLOSERS).size, PRESENTATION_CLOSERS.length); // all distinct
  assert.equal(new Set(PROPERTY_QUERY_CLOSERS).size, PROPERTY_QUERY_CLOSERS.length);
  const q0 = buildPropertyCards([prop], 'property_query', 0);
  const q1 = buildPropertyCards([prop], 'property_query', 1);
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
  assert.ok(!card.includes('http'));
  assert.ok(!card.includes('Повеќе информации'));
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

test('guardText: property links are stripped — info is described in words, never linked', () => {
  // the exact pattern from the paste: bold label + bare path
  assert.equal(guardText('presentation', '**Повеќе информации:** /property/37c5d771-b26c-4993-bebd-9b9f4766d769', SITE), '');
  // full https URL behind the label
  const full = `Повеќе информации: ${SITE}/property/fe3c38df-63cb-4166-a295-0ab8d6831f1d`;
  assert.equal(guardText('presentation', full, SITE), '');
  // a property URL mid-sentence is removed, the surrounding words survive
  const mid = `Го најдов станот. ${SITE}/property/fe3c38df-63cb-4166-a295-0ab8d6831f1d Дали Ви се допаѓа?`;
  const out = guardText('presentation', mid, SITE);
  assert.ok(!out.includes('property/'), out);
  assert.ok(out.includes('Го најдов станот.'), out);
  assert.ok(out.includes('Дали Ви се допаѓа?'), out);
  // non-property URLs are NOT touched
  const other = 'Проверете на https://example.com/x';
  assert.ok(guardText('presentation', other, SITE).includes('https://example.com/x'));
});

test('buildDiscoveryAsk: куќа requests use house wording, never стан', () => {
  const ask = buildDiscoveryAsk({ service: 'buy', house: true } as SlotData);
  assert.ok(ask.includes('Разбрав — барате куќа за купување.'), ask);
  assert.ok(ask.includes('Во кој дел од градот ја барате куќата?'), ask);
  assert.ok(!ask.includes('стан'), ask);
  const more = buildDiscoveryAsk({ service: 'rent', house: true, location: 'Визбегово' } as SlotData);
  assert.ok(more.includes('барате куќа за изнајмување, во Визбегово'), more);
  assert.ok(more.includes('Колку спални соби би сакале да има куќата?'), more);
  assert.ok(more.includes('До која цена ја барате куќата?'), more);
  assert.ok(!more.includes('станот'), more);
});

test('buildPropertyCard: houses render as куќа, never стан', () => {
  const prop: Property = {
    eb: 44, id: 44, address: 'Визбегово', location: 'Скопје Север',
    price: 150000, size: '150 м²', bedrooms: 4, house: true,
  };
  const card = buildPropertyCard(prop);
  assert.ok(card.includes('Куќата под Евидентен број 44 е во Скопје Север.'), card);
  assert.ok(card.includes('Има 150 м² станбена површина.'), card);
  assert.ok(!card.includes('Станот'), card);
  // feminine agreement for features
  const furnished = buildPropertyCard({ ...prop, features: ['лифт', 'наместен'] });
  assert.ok(furnished.includes('Во неа има лифт.'), furnished);
  assert.ok(furnished.includes('Куќата е целосно наместена.'), furnished);
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

test('buildPropertyCard: NEVER includes a link — the DB data is described in words', () => {
  const prop: Property = {
    eb: 63, id: 63, address: 'Црногорска Амбасада', location: 'Центар',
    price: 36000, size: '28 м²', url: '/property/37c5d771-b26c-4993-bebd-9b9f4766d769',
  };
  const card = buildPropertyCard(prop);
  assert.ok(!card.includes('Повеќе информации'), card);
  assert.ok(!card.includes('/property/'), card);
  assert.ok(!card.includes('http'), card);
  assert.ok(card.includes('Станот под Евидентен број 63 е гарсоњера во Центар.'), card);
  assert.ok(card.includes('Цената е 36.000 евра.'), card);
});

test('buildPropertyCard: the DB description (details) is written out in words', () => {
  const prop: Property = {
    eb: 63, id: 63, address: 'Црногорска Амбасада', location: 'Центар',
    price: 36000, size: '28 м²',
    details: 'Гарсоњера во сутерен на зграда, комплетно реновирана на одлична локација.',
  };
  const card = buildPropertyCard(prop);
  assert.ok(card.includes('Гарсоњера во сутерен на зграда, комплетно реновирана на одлична локација.'), card);
  assert.ok(!card.includes('http'), card);
});

test('buildPropertyContext: no url field — the model cannot echo a link', () => {
  const prop: Property = {
    eb: 63, id: 63, address: 'x', location: 'Центар',
    price: 36000, url: '/property/37c5d771-b26c-4993-bebd-9b9f4766d769',
  };
  const ctx = buildPropertyContext([prop]);
  assert.ok(!ctx.includes('url'), ctx);
  assert.ok(!ctx.includes('property/'), ctx);
  assert.ok(ctx.includes('Центар'), ctx);
  assert.ok(ctx.includes('price_eur'), ctx);
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
