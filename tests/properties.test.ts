import { test } from 'node:test';
import assert from 'node:assert';
import { detectLocation } from '../src/llm/deterministic';
import { titleCase, cleanMacedonian, featurePhrases, locMatches, normalizeLocation, PropertyService, Property } from '../src/data/properties';

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
}

const ROWS: Property[] = [
  { eb: 54, id: 54, location: 'Карпош III', price: 69500, service: 'buy' },
  { eb: 48, id: 48, location: 'Карпош III', price: 250, service: 'rent' },  // rental — never for a buyer
  { eb: 43, id: 43, location: 'Маџари', price: 68300, service: 'buy' },
  { eb: 63, id: 63, location: 'Центар', price: 36000, service: 'buy' },
  { eb: 80, id: 80, location: 'Кисела Вода', price: 46000, service: 'buy' },
  { eb: 46, id: 46, location: 'Кисела Вода', price: 72000, service: 'buy' },
  { eb: 56, id: 56, location: undefined, price: 500, service: 'rent', business: true, sqm: 40 },
  { eb: 59, id: 59, location: 'Центар', price: 950, service: 'rent', business: true, sqm: 105 },
];

test('candidates: house requests match only houses; стан requests exclude them', async () => {
  const ps = new FakeProps([
    { eb: 44, id: 44, location: 'Скопје Север', price: 150000, service: 'buy', house: true },
    { eb: 80, id: 80, location: 'Кисела Вода', price: 46000, service: 'buy' },
  ]);
  const houses = await ps.candidates({ service: 'buy', house: true });
  assert.deepEqual(houses.map(p => p.eb), [44]);
  const flats = await ps.candidates({ service: 'buy', house: false });
  assert.deepEqual(flats.map(p => p.eb), [80]);
  const any = await ps.candidates({ service: 'buy' });
  assert.deepEqual(any.map(p => p.eb).sort((a, b) => a - b), [44, 80]);
});

test('candidates: a "во Карпош?" request never mixes in unrelated areas', async () => {
  const ps = new FakeProps(ROWS);
  // Карпош has exactly ONE buy property -> batch is that one alone, NO Маџари
  const batch = await ps.candidates({ location: 'Карпош', service: 'buy' });
  assert.deepEqual(batch.map(p => p.eb), [54]);
  // the area is DRAINED -> [] — the funnel asks about other areas FIRST
  // ("Ги исцрпивме… или да погледнеме во друга населба?"), never spills
  const next = await ps.candidates({ location: 'Карпош', service: 'buy', exclude: [54] });
  assert.deepEqual(next, []);
});

test('candidates: business searches match by size, never residential (and vice versa)', async () => {
  const ps = new FakeProps(ROWS);
  // business space: size filter instead of bedrooms
  const biz = await ps.candidates({ business: true, sqm: 50 });
  assert.deepEqual(biz.map(p => p.eb), [59]); // 105 м² >= 50; EB 56 is only 40 м²
  const allBiz = await ps.candidates({ business: true });
  assert.deepEqual(allBiz.map(p => p.eb), [56, 59]);
  // business search by location + size narrows correctly
  const centarBiz = await ps.candidates({ business: true, location: 'Центар' });
  assert.deepEqual(centarBiz.map(p => p.eb), [59]);
});

test('candidates: sortBySqm orders SMALLEST м² first ("помало нешто")', async () => {
  const ps = new FakeProps([
    { eb: 71, id: 71, location: 'Центар', price: 450, service: 'rent', business: true, sqm: 90 },
    { eb: 72, id: 72, location: 'Центар', price: 300, service: 'rent', business: true, sqm: 35 },
    { eb: 73, id: 73, location: 'Центар', price: 350, service: 'rent', business: true, sqm: 60 },
  ]);
  const asc = await ps.candidates({ location: 'Центар', business: true, sortBySqm: true });
  assert.deepEqual(asc.map(p => p.eb), [72, 73, 71]); // 35 -> 60 -> 90 м²
  // the default sort keeps price-proximity behavior
  const def = await ps.candidates({ location: 'Центар', business: true });
  assert.deepEqual(def.map(p => p.eb), [72, 73, 71]); // prices 300, 350, 450 -> same order here
  // budget still filters even with sortBySqm
  const filtered = await ps.candidates({ location: 'Центар', business: true, budget: '400', sortBySqm: true });
  assert.deepEqual(filtered.map(p => p.eb), [72, 73]); // EB 71 (450) over budget
});

test('candidates: sortByPopularity orders city-wide searches from the most popular neighborhoods', async () => {
  const ps = new FakeProps([
    { eb: 81, id: 81, location: 'Маџари', price: 150, service: 'rent' },      // rest
    { eb: 63, id: 63, location: 'Центар', price: 200, service: 'rent' },      // rank 0
    { eb: 78, id: 78, location: 'Капиштец', price: 180, service: 'rent' },    // rank 1
    { eb: 54, id: 54, location: 'Карпош III', price: 230, service: 'rent' },  // rank 2
    { eb: 53, id: 53, location: 'Аеродром', price: 220, service: 'rent' },    // rank 3
    { eb: 80, id: 80, location: 'Кисела Вода', price: 210, service: 'rent' }, // rank 4
    { eb: 55, id: 55, location: 'Влае', price: 190, service: 'rent' },        // rank 5
    { eb: 48, id: 48, location: 'Карпош III', price: 250, service: 'rent' },  // rank 2 (after 54 by price)
    { eb: 90, id: 90, location: 'Центар', price: 300, service: 'rent' },      // over budget 250
  ]);
  const ordered = await ps.candidates({ service: 'rent', budget: '250', sortByPopularity: true });
  assert.deepEqual(ordered.map(p => p.eb),
    [63, 78, 48, 54, 53, 80, 55, 81]); // Центар → Капиштец → Карпош (48 price-closest to 250) → Аеродром → Кисела Вода → Влае → rest
  // without the flag the ordering stays price-distance-based (no surprise):
  // closest to the 250 budget first (48=250, 54=230, 53=220, … 81=150)
  const byPrice = await ps.candidates({ service: 'rent', budget: '250' });
  assert.deepEqual(byPrice.map(p => p.eb), [48, 54, 53, 80, 63, 55, 78, 81]);
});

test('candidates: batches stay inside the requested area while it has matches', async () => {
  const ps = new FakeProps(ROWS);
  const b1 = await ps.candidates({ location: 'Кисела Вода' });
  assert.deepEqual(b1.map(p => p.eb), [80, 46]); // both Кисела Вода
  // an area with zero matches stays EMPTY — no silent spill; the funnel asks
  // whether to look elsewhere before offering anything else
  const spill = await ps.candidates({ location: 'Дебар Маало' });
  assert.deepEqual(spill, []);
});

test('titleCase: feed ALL-CAPS addresses become proper Macedonian titles', () => {
  assert.equal(titleCase('ШАМПИОНЧЕ КАК КИПЕР МАРКЕТ'), 'Шампионче Как Кипер Маркет');
  assert.equal(titleCase('ЛОКОВ 5'), 'Локов 5');
  assert.equal(titleCase('РОБЕРТ КОХ 3'), 'Роберт Кох 3');
  // already mixed-case — idempotent
  assert.equal(titleCase('Ефтим Спространов'), 'Ефтим Спространов');
  assert.equal(titleCase(''), '');
});

test('cleanMacedonian: feed lossy-Latin corruption is fixed word by word — never valid words', () => {
  // the exact corrupted sentences from the live feed
  assert.equal(
    cleanMacedonian('Во него се зивеесе до пред 2 месеца.. Одлицна локација со поглед кон авионцето. Цист имотен лист'),
    'Во него се живееше до пред 2 месеци.. Одлична локација со поглед кон авиончето. Чист имотен лист');
  assert.equal(
    cleanMacedonian('две инвертер клими, сопствено парно, фризидер, масина за перење, масина за садови'),
    'две инвертер клими, сопствено парно, фрижидер, машина за перење, машина за садови');
  assert.equal(
    cleanMacedonian('Со мозност за изведба на усте една соба. Има сематски приказ и детски игралиста.'),
    'Со можност за изведба на уште една соба. Има шематски приказ и детски игралишта.');
  assert.equal(
    cleanMacedonian('паркингот не се наплака ни ке се наплака во иднина, 3 спаизи и без многу комсии'),
    'паркингот не се наплаќа ни ќе се наплаќа во иднина, 3 спални и без многу комшии');
  assert.equal(
    cleanMacedonian('паркот Авионце и Југосвовенска машина во Маџери'),
    'паркот Авионче и Југословенска машина во Маџари');
});

test('cleanMacedonian: keeps the token casing and never touches valid words', () => {
  // casing is preserved: ALL CAPS, title case, lowercase
  assert.equal(cleanMacedonian('ЦИСТ ИМОТЕН ЛИСТ'), 'ЧИСТ ИМОТЕН ЛИСТ');
  assert.equal(cleanMacedonian('Цист имотен лист'), 'Чист имотен лист');
  assert.equal(cleanMacedonian('Одлицна локација'), 'Одлична локација');
  // acronyms always render in their fixed case
  assert.equal(cleanMacedonian('Бул. Асном бр.134'), 'Бул. АСНОМ бр.134');
  assert.equal(cleanMacedonian('според дупот на Карпош'), 'според ДУП-от на Карпош');
  // valid words with the same letters are NEVER touched
  assert.equal(cleanMacedonian('одлична локација, чист имотен лист, машина за перење'), 'одлична локација, чист имотен лист, машина за перење');
  assert.equal(cleanMacedonian('зграда во Центар со соба'), 'зграда во Центар со соба');
  assert.equal(cleanMacedonian(''), '');
});

test('locMatches: a single-word query matches a multi-word feed location', () => {
  // "karpos" (latin, embedded in a sentence) must find "Карпош III"
  assert.equal(locMatches('STO IMAS VO KARPOS ?', 'Карпош III'), true);
  assert.equal(locMatches('VIDI VO KARPOS', 'Карпош III'), true);
  assert.equal(locMatches('а во карпош', 'Карпош III'), true);
  // short words never collide ("вода" is not "Кисела Вода")
  assert.equal(locMatches('имате ли топла вода', 'Кисела Вода'), false);
  assert.equal(locMatches('дали е достапен 82?', 'Кисела Вода'), false);
  // exact short names still match via containment
  assert.equal(locMatches('што имате во Влае', 'Влае'), true);
});

test('locMatches: the bare CITY is city-wide, never a sub-district embedding it', () => {
  // "skopje" must NOT resolve to "Скопје Север" — the district name embeds the
  // city word, which carries no district identity (Skopje bug, 2026-09-10).
  assert.equal(locMatches('skopje', 'Скопје Север'), false);
  assert.equal(locMatches('во скопје', 'Скопје Север'), false);
  assert.equal(locMatches('sakam da kupan stance vo skopje', 'Скопје Север'), false);
  assert.equal(locMatches('sakam stan vo skopje', 'скопје север'), false);
  // A real district ask still matches (alias + full name)
  assert.equal(locMatches('skopje sever', 'Скопје Север'), true);
  assert.equal(locMatches('sever', 'Скопје Север'), true);
  assert.equal(locMatches('стан во Скопје Север', 'Скопје Север'), true);
  // A bare-city FEED location still matches the bare-city ask
  assert.equal(locMatches('skopje', 'скопје'), true);
});

test('locMatches: sibling settlements (Ново Лисиче vs Лисиче) never merge', () => {
  // Adjacent but DISTINCT municipalities — a bare-base ask must not match the
  // compound feed location, and vice versa. Same for Ново Маџари vs Маџари.
  assert.equal(locMatches('vo lisice', 'Ново Лисиче'), false);
  assert.equal(locMatches('lisice', 'Ново Лисиче'), false);
  assert.equal(locMatches('novo lisice', 'Лисиче'), false);
  assert.equal(locMatches('novo lisice', 'Ново Лисиче'), true);
  assert.equal(locMatches('vo novo lisice', 'Ново Лисиче'), true);
  assert.equal(locMatches('madjari', 'Ново Маџари'), false);
  assert.equal(locMatches('novo madjari', 'Маџари'), false);
  assert.equal(locMatches('novo madjari', 'Ново Маџари'), true);
  // Cyrillic asks behave identically
  assert.equal(locMatches('во лисиче', 'Ново Лисиче'), false);
  assert.equal(locMatches('ново лисиче', 'Лисиче'), false);
  // Base-word matching OUTSIDE a modifier compound survives (Карпош ⊃ Карпош III)
  assert.equal(locMatches('STO IMAS VO KARPOS ?', 'Карпош III'), true);
  // Mid-word containment never matches: 'novo lisice' does not contain 'vo lisice'
  assert.equal(locMatches('vo lisice', 'novo lisice'), false);
});

test('detectLocation: the exact ask wins over its sibling settlement', () => {
  const feed = ['Ново Лисиче', 'Лисиче', 'Ново Маџари', 'Маџари', 'Карпош III', 'Карпош'];
  assert.equal(detectLocation('vo lisice', feed), 'Лисиче');
  assert.equal(detectLocation('novo lisice', feed), 'Ново Лисиче');
  assert.equal(detectLocation('vo novo madjari', feed), 'Ново Маџари');
  assert.equal(detectLocation('vo madjari', feed), 'Маџари');
  assert.equal(detectLocation('novo lisice, karpos', feed), 'Ново Лисиче, Карпош III');
});

test('normalizeLocation: Latin asks canonicalize to the feed spelling', () => {
  assert.equal(normalizeLocation('novo lisice'), 'Ново Лисиче');
  assert.equal(normalizeLocation('novo madjari'), 'Ново Маџари');
  assert.equal(normalizeLocation('karpos'), 'Карпош');
  assert.equal(normalizeLocation('kapistec'), 'Капиштец');
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
