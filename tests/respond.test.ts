import { test } from 'node:test';
import assert from 'node:assert';
import { guardText } from '../src/llm/respond';
import { buildPropertyCards, buildPropertyCard, buildDiscoveryAsk, buildPropertyContext, buildFeeAsk, buildContactAsk, PRESENTATION_CLOSERS, PROPERTY_QUERY_CLOSERS } from '../src/llm/prompts';
import { RESPONSE_BANK } from '../src/data/responses';
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

test('buildPropertyCards: the closer rotation includes the generated bank variants', () => {
  const prop: Property = {
    eb: 63, id: 63, address: 'x', location: 'Центар', price: 36000,
  };
  const seen = new Set<string>();
  for (let i = 0; i < 60; i++) {
    seen.add(buildPropertyCards([prop], 'presentation', i).split('\n\n').pop()!);
  }
  const bank = RESPONSE_BANK['closer.presentation'];
  const fromBank = bank.filter(c => seen.has(c));
  assert.ok(fromBank.length > 0, 'bank closers must appear in the rotation');
  assert.ok(fromBank.length === bank.length, 'every bank closer must appear');
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
  // ADDRESS PRIVACY: the exact street NEVER appears — the location is the
  // neighborhood (already in the opener) or a landmark when one is resolved.
  assert.ok(!card.includes('Јане Сандански'), card);
  assert.ok(!card.includes('Се наоѓа на улица'), card);
  assert.ok(card.includes('Има 77 м² станбена површина.'), card);
  assert.ok(card.includes('Во него има лифт, парно и јавен паркинг.'), card);
  assert.ok(card.includes('Станот е целосно наместен.'), card);
  assert.ok(card.includes('Цената е 143.000 евра.'), card);
  // With a resolved landmark the card names it ("Се наоѓа во близина на …"),
  // never the street.
  const landmarked = buildPropertyCard({ ...prop, landmark: 'Градежниот факултет' });
  assert.ok(landmarked.includes('Се наоѓа во близина на Градежниот факултет.'), landmarked);
  assert.ok(!landmarked.includes('Јане Сандански'), landmarked);
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

test('guardText: the two question-prefix flourishes are stripped from LLM prose (code-built once-each only)', () => {
  // the exact overuse from live: every question in the collecting phase opened with one of these
  const out = guardText('presentation', 'Супер. Уште неколку прашања. Дали Ви се допаѓа овој стан?');
  assert.ok(!out.includes('Уште неколку прашања'), out);
  assert.ok(out.includes('Дали Ви се допаѓа овој стан?'), out); // the question itself survives
  const last = guardText('contact_collection', 'Одлично, уште последниве информации и завршуваме. Кажете ми го Вашето име и презиме.');
  assert.ok(!last.includes('последниве информации'), last);
  assert.ok(last.includes('име и презиме'), last);
  // standalone "Супер." (a normal interjection) is NOT touched
  const ok = guardText('presentation', 'Супер. Дали Ви се допаѓа овој стан?');
  assert.ok(ok.includes('Супер.'), ok);
  assert.ok(ok.includes('Дали Ви се допаѓа овој стан?'), ok);
});

test('buildDiscoveryAsk: куќа requests use house wording, never стан — NO recap', () => {
  const ask = buildDiscoveryAsk({ service: 'buy', house: true } as SlotData);
  // the recap is GONE — the question carries the type itself
  assert.ok(!ask.includes('Разбрав — барате'), ask);
  assert.ok(/куќ/.test(ask) && /(дел од градот|населба|локаци)/iu.test(ask), ask);
  assert.ok(!ask.includes('стан'), ask);
  const more = buildDiscoveryAsk({ service: 'rent', house: true, location: 'Визбегово' } as SlotData);
  assert.ok(!more.includes('Разбрав — барате'), more);
  assert.ok(/спални/.test(more) && /куќ/.test(more), more);
  assert.ok(/куќ/.test(more) && /(цена|евра)/iu.test(more), more);
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

test('buildDiscoveryAsk: business spaces ask location/sqm/price — NEVER bedrooms, NO recap', () => {
  const ask = buildDiscoveryAsk({ service: 'rent', location: 'Карпош III', business: true } as SlotData);
  assert.ok(!ask.includes('Разбрав — барате'), ask);
  assert.ok(/(површина|м²|m²|квадрат)/iu.test(ask), ask);
  assert.ok(/(цена|евра)/iu.test(ask), ask);
  assert.ok(!ask.includes('спални'), ask);
  assert.ok(!ask.includes('Колку спални'), ask);
  // known sqm -> only the price is missing
  const partial = buildDiscoveryAsk({ service: 'rent', location: 'Карпош III', business: true, sqm: 40 } as SlotData);
  assert.ok(!partial.includes('Разбрав — барате'), partial);
  assert.ok(!/(површина|м²|m²|квадрат)/iu.test(partial), partial);
  assert.ok(/(цена|евра)/iu.test(partial), partial);
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

test('conversationalDetails: the ad copy is REWRITTEN, never pasted verbatim', () => {
  // The exact transcript case: "Агенција за Недвижности МЕТРОПОЛИС Продава…"
  // must not survive into the chat — only the real facts (тераса, прв кат) do.
  const prop80: Property = {
    eb: 80, id: 80, location: 'Кисела Вода', price: 46000, size: '24 м²',
    details: 'Агенција за Недвижности МЕТРОПОЛИС Продава Нова Гарсоњера во Кисела Вода. Станче во Топ Состојба, спремно за Компактно Домување или Издавање. 24м2 со Тераса. Прв Кат со Лифт. Без Провизија за Купецот. Ексклузивно Преку МЕТРОПОЛИС.',
  };
  const card = buildPropertyCard(prop80);
  assert.ok(!card.includes('Агенција'), card);
  assert.ok(!card.includes('МЕТРОПОЛИС'), card);
  assert.ok(!card.includes('Продава'), card);
  assert.ok(!card.includes('Провизија'), card);
  assert.ok(!card.includes('Ексклузивно'), card);
  assert.ok(!card.includes('Компактно'), card);
  assert.ok(card.includes('Има тераса'), card);
  assert.ok(/прв кат со лифт/.test(card), card);

  // "Се продава…" openers and the sell/agency boilerplate are stripped,
  // keeping only the facts (реновирана, посебна спална соба).
  const prop63: Property = {
    eb: 63, id: 63, location: 'Центар (населба)', price: 36000, size: '28 м²',
    details: 'Се Продава Гарсоњера во Сутерен на Зграда. Гарсоњерата е комплетно реновирана и е на Одлична Локација, во близина на Црногорска Амбасада. Поседува Посебна Спална Соба која не е во имотен лист. Пристапна Опција за Урбано Живеење.',
  };
  const card63 = buildPropertyCard(prop63);
  assert.ok(!card63.includes('Се Продава'), card63);
  assert.ok(!card63.includes('Пристапна Опција'), card63);
  assert.ok(!card63.includes('Урбано Живеење'), card63);
  assert.ok(card63.includes('комплетно реновирана'), card63);
  assert.ok(card63.includes('посебна спална соба'), card63);
  assert.ok(card63.includes('не е во имотен лист'), card63);
});

test('conversationalDetails: the exact street NEVER survives (address secrecy)', () => {
  const prop: Property = {
    eb: 84, id: 84, location: 'Центар', price: 48000, size: '48 м²',
    details: '-Улица Роза Луксембург -Дневна и две спални -Станот има многу добар распоред, нема изгубени квадрати, на високо приземје во мирна околина.',
  };
  const card = buildPropertyCard(prop);
  assert.ok(!card.includes('Роза Луксембург'), card);
  assert.ok(!card.includes('улица'), card);
  assert.ok(card.includes('нема изгубени квадрати'), card);
  // a street inside a sentence ("на улица Ефтим Спространов") is stripped too
  const prop2: Property = {
    eb: 80, id: 80, location: 'Кисела Вода', price: 46000, size: '24 м²',
    details: 'Се наоѓа на улица Ефтим Спространов. Има 24 м2 станбена површина.',
  };
  const card2 = buildPropertyCard(prop2);
  assert.ok(!card2.includes('Ефтим'), card2);
  assert.ok(!card2.includes('улица'), card2);
});

test('conversationalDetails: the proximity landmark is said ONCE, not twice', () => {
  // The ad names a landmark ("во близина на Мајчин Дом") — the resolver's
  // landmark line is skipped so the proximity never repeats.
  const prop: Property = {
    eb: 88, id: 88, location: 'Аеродром', price: 68000, size: '68 м²', landmark: 'Мајчин Дом',
    details: 'Агенција МЕТРОПОЛИС Продава Одличен Фамилијарен Стан во Аеродром. Во Близина на Мајчин Дом, во најпожелниот дел на Аеродром. Две Спални Соби.',
  };
  const card = buildPropertyCard(prop);
  assert.equal(card.split('Мајчин Дом').length - 1, 1, card); // exactly once
  assert.ok(/близина на Мајчин Дом/.test(card), card);
  // when the ad has NO landmark, the resolver's line still names it
  const prop2: Property = {
    eb: 95, id: 95, location: 'Центар', price: 204000, size: '74 м²', landmark: 'ГТЦ',
    details: 'Се продава нов стан на прв спрат и гаражно место.',
  };
  const card2 = buildPropertyCard(prop2);
  assert.ok(card2.includes('Се наоѓа во близина на ГТЦ'), card2);
});

test('conversationalDetails: niche ad phrases are stripped too („Сите Потреби…", mid-sentence „се продава")', () => {
  // EB 82: "опкружен со Зеленило и Сите Потреби За Модерно Живеење" — the
  // marketing flourish is replaced by the plain fact "опкружен со зеленило".
  const prop82: Property = {
    eb: 82, id: 82, location: 'Аеродром', price: 77000, size: '77 м²',
    details: 'Агенција МЕТРОПОЛИС Продава Фамилијарен Стан во Аеродром. 6ти кат од 8 со две спални соби и купатило на одлична локација опкружен со Зеленило и Сите Потреби За Модерно Живеење. 77 м2 + подрум од 5м2 реновиран и опремен.',
  };
  const card82 = buildPropertyCard(prop82);
  assert.ok(!card82.includes('Сите Потреби'), card82);
  assert.ok(!card82.includes('Модерно Живеење'), card82);
  assert.ok(card82.includes('опкружен со зеленило'), card82);
  assert.ok(/подрум од 5м2 реновиран и опремен/i.test(card82), card82);

  // EB 78: "Единствено преку МЕТРОПОЛИС." (variant of Ексклузивно) is dropped.
  const prop78: Property = {
    eb: 78, id: 78, location: 'Капиштец', price: 185000, size: '82 м²',
    details: 'Станот има 70 м2 корисна површина + 12 м2 Тераси. Се наоѓа на 8 кат од 8 со рамна плоча без косини и одличен поглед. Единствено преку МЕТРОПОЛИС.',
  };
  const card78 = buildPropertyCard(prop78);
  assert.ok(!card78.includes('Единствено преку'), card78);
  assert.ok(!card78.includes('МЕТРОПОЛИС'), card78);

  // Mid-sentence "се продава" ("Скопјанка Аеродром се продава стан 3 собен…")
  // is stripped, while "ретко се продаваат" (a legit fact) survives.
  const prop75: Property = {
    eb: 75, id: 75, location: 'Аеродром', price: 90000, size: '65 м²',
    details: 'Скопјанка Аеродром се продава стан 3 собен 2 кат 2 лифта градско парно. Во одлична состојба одличен поглед кон парк Североисток.',
  };
  const card75 = buildPropertyCard(prop75);
  assert.ok(!card75.includes('се продава стан'), card75);
  assert.ok(card75.includes('Во одлична состојба'), card75);
  const prop66: Property = {
    eb: 66, id: 66, location: 'Центар', price: 120000, size: '60 м²',
    details: 'Реон во кој ретко се продаваат станови.',
  };
  const card66 = buildPropertyCard(prop66);
  assert.ok(card66.includes('ретко се продаваат'), card66);
});

test('conversationalDetails: ALL-CAPS ad sentences read like chat, size repeat dropped', () => {
  const prop: Property = {
    eb: 94, id: 94, location: 'Кисела Вода', price: 56000, size: '56 м²',
    details: 'ПРОДАВАМ СТАН ВО КИСЕЛА ВОДА КАЈ ЕКОНОМСКОТО УЧИЛИШТЕ. СТАНОТ Е ДВОСОБЕН (56 М2) НА ОСМИ СПРАТ СО ПАРНО И ЛИФТ. СТАНОТ ИМА ДНЕВНА СОБА, КУЈНА, СПАЛНА И ДВЕ ТЕРАСИ.',
  };
  const card = buildPropertyCard(prop);
  assert.ok(!card.includes('ПРОДАВАМ'), card);
  assert.ok(!card.includes('56 М2'), card);      // size repeat dropped (own line: Има 56 м²)
  assert.ok(card.includes('Станот е двособен на осми спрат'), card);
  assert.ok(card.includes('две тераси'), card);
  // no marketing uppercase shouting remains
  assert.ok(!card.includes('ДВОСОБЕН'), card);
});

test('buildPropertyContext: the model gets the REWRITTEN ad, never the raw copy', () => {
  const prop: Property = {
    eb: 80, id: 80, location: 'Кисела Вода', price: 46000, size: '24 м²',
    details: 'Агенција за Недвижности МЕТРОПОЛИС Продава Нова Гарсоњера во Кисела Вода. Станче во Топ Состојба. 24м2 со Тераса. Прв Кат со Лифт. Без Провизија за Купецот.',
  };
  const ctx = buildPropertyContext([prop]);
  assert.ok(!ctx.includes('Агенција'), ctx);
  assert.ok(!ctx.includes('МЕТРОПОЛИС'), ctx);
  assert.ok(!ctx.includes('Провизија'), ctx);
  assert.ok(ctx.includes('Има тераса'), ctx);
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

test('buildContactAsk: bank-backed — name-only form never mentions a phone, name+phone asks both', () => {
  const nameOnly = buildContactAsk({ phone: '078123456' } as SlotData);
  assert.ok(nameOnly.includes('име и презиме'), nameOnly);
  assert.ok(!nameOnly.includes('телефонски'), nameOnly);
  assert.ok(!nameOnly.includes('број'), nameOnly);
  const namePhone = buildContactAsk({} as SlotData);
  assert.ok(namePhone.includes('име и презиме'), namePhone);
  assert.ok(/телефон/.test(namePhone), namePhone);
});

test('buildDiscoveryAsk: the recap NEVER appears — only the missing question, enriched wording', () => {
  const slots = { service: 'rent', location: 'Центар (населба)', business: true, budget: '500' } as SlotData;
  // business with everything but sqm -> just the sqm question, NO recap
  const ask = buildDiscoveryAsk(slots);
  assert.ok(!ask.includes('Разбрав — барате'), ask);
  assert.ok(!ask.includes('деловен простор, за изнајмување'), ask);
  assert.ok(/(површина|м²|m²|квадрат)/iu.test(ask), ask);
  // a house location ask carries ONLY the question (bank-backed wording varies)
  const house = buildDiscoveryAsk({ service: 'buy', house: true } as SlotData);
  assert.ok(!house.includes('Разбрав — барате'), house);
  assert.ok(/куќ/.test(house) && /(дел од градот|населба|локаци)/iu.test(house), house);
  // the generic greeting path is untouched
  const generic = buildDiscoveryAsk({} as SlotData);
  assert.ok(/куп|изнајм|кириј/i.test(generic), generic);
  assert.ok(!generic.includes('Разбрав — барате'), generic);
});

test('buildDiscoveryAsk: a bare "zdravo" gets a GENERIC greeting — never an apartment assumption', () => {
  const ask = buildDiscoveryAsk({} as SlotData);
  const bank = RESPONSE_BANK['greeting.open'] ?? [];
  const fallback = 'Повелете. Дали Ве интересира купување или изнајмување на имот?';
  assert.ok(bank.includes(ask) || ask === fallback, ask);
  // the property type is UNKNOWN — no apartment (or any type) talk
  assert.ok(!ask.includes('стан'), ask);
  assert.ok(!ask.includes('куќ'), ask);
  assert.ok(!ask.includes('деловен'), ask);
  // but it still asks the buy/rent intent question
  assert.ok(/куп|изнајм|кириј/i.test(ask), ask);
  assert.ok(ask.endsWith('?'), ask);
});

test('buildDiscoveryAsk: never re-asks known slots, never the generic buy/rent battery', () => {
  // intent + location + bedrooms known -> asks ONLY for the budget
  const ask = buildDiscoveryAsk({ service: 'buy', location: 'Кисела Вода', bedrooms: 1 } as SlotData);
  assert.ok(!ask.includes('Разбрав — барате'), ask);
  assert.ok(/стан/.test(ask) && /(цена|евра)/iu.test(ask), ask);
  assert.ok(!ask.includes('купување или за изнајмување'), ask);
  assert.ok(!ask.includes('Колку спални'), ask);
  assert.ok(!ask.includes('Во кој дел'), ask);
  // intent known, no location -> asks location only
  const loc = buildDiscoveryAsk({ service: 'buy' } as SlotData);
  assert.ok(/стан/.test(loc) && /(дел од градот|населба|локаци)/iu.test(loc), loc);
  assert.ok(!loc.includes('купување или за изнајмување'), loc);
  assert.ok(!loc.includes('Колку спални'), loc);
  // nothing known -> generic greeting + intent question, NO apartment assumption
  const first = buildDiscoveryAsk({} as SlotData);
  assert.ok(/куп|изнајм|кириј/i.test(first), first);
  assert.ok(first.endsWith('?'), first);
  assert.ok(!first.includes('стан'), first);
  // budget renders with thousands separator (when it appears in a recap-less ask)
  const budget = buildDiscoveryAsk({ service: 'buy', location: 'Центар', bedrooms: 2, budget: '80000' } as SlotData);
  assert.ok(!budget.includes('80.000'), budget); // the recap is gone — no echo of the budget
  assert.ok(budget.length > 0, budget);
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
