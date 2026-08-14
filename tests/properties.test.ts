import { test } from 'node:test';
import assert from 'node:assert';
import { titleCase, cleanMacedonian, featurePhrases, locMatches, PropertyService, Property } from '../src/data/properties';

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
  // only AFTER the area is exhausted does the spillover start (cheapest first)
  const next = await ps.candidates({ location: 'Карпош', service: 'buy', exclude: [54] });
  assert.deepEqual(next.slice(0, 2).map(p => p.eb), [63, 80]);
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

test('candidates: batches stay inside the requested area while it has matches', async () => {
  const ps = new FakeProps(ROWS);
  const b1 = await ps.candidates({ location: 'Кисела Вода' });
  assert.deepEqual(b1.map(p => p.eb), [80, 46]); // both Кисела Вода
  // an area with zero matches spills immediately (cheapest first)
  const spill = await ps.candidates({ location: 'Дебар Маало' });
  assert.deepEqual(spill.map(p => p.eb), [48, 56, 59, 63, 80, 43, 54, 46]);
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
