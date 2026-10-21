// THE INFO-ANSWER FAMILY (scope C) — the public-add becomes quotable.
//
// "kolku e garsonjerata?" must answer about THE GARSONJERA THE CHAT NAMED
// (EB 63, 36.000 €) — never about the last-shown property. Every ask family
// binds through the mention resolver and answers from the feed's public-add
// data: price, m², rooms, floor, features. A facet with no stored data gets
// the honest owner-relay line — never a fabricated feature. A criterion
// ("stan od 80 m2", "do 500 evra") and an opinion ("цените се превисоки")
// never become info answers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig } from '../src/config';
import { Db } from '../src/store/db';
import { SessionStore, freshSession } from '../src/fsm/session';
import { Classifier } from '../src/llm/classify';
import { Responder } from '../src/llm/respond';
import { PropertyService, Property, mapRow } from '../src/data/properties';
import { AppointmentStore } from '../src/store/appointments';
import { EscalationStore } from '../src/store/escalations';
import { MetaStore } from '../src/store/meta';
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LlmClient } from '../src/llm/types';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore, writeMap } from '../src/geo/offlineMap';
import { detectInfoFacets, buildInfoAnswer, INFO_NO_DATA_LINE, INFO_NO_FLOORS_LINE, INFO_NO_YEAR_LINE, INFO_NO_RENOVATION_LINE } from '../src/llm/infoAnswer';
import { detectGlossaryAsk, answerGlossary, isGlossaryAsk, SUTEREN_MEANING, SUTEREN_DUG_IN } from '../src/llm/glossary';
import { isSuterenUnit } from '../src/llm/infoAnswer';
import { hasParkingWord } from '../src/llm/morphology';
import { detectFeatureAsk, detectPriceAsk } from '../src/llm/deterministic';
import { inferPropertyId } from '../src/llm/classify';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429'); }
}

function tmpMapDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'info-')), 'map.db');
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === eb || r.id === eb);
  }
  get healthy(): boolean { return true; }
}

// The 12:33 chat, one family over: EB 69 (стан 51 м², 99.000 €) and EB 63
// (гарсоњера 28 м², 36.000 €, сутерен, греење на струја).
const EB69 = 69, EB63 = 63, EB84 = 84;
const ROWS_INFO: Property[] = [
  {
    eb: EB69, id: EB69, location: 'Центар', address: 'Ул. Димитар Миладинов 12',
    price: 99000, bedrooms: 2, sqm: 51, service: 'buy',
    lat: 41.98810, lon: 21.47580, geo_source: 'osm_building',
    details: 'Стан со една спална соба на одлична локација, до УЈП, преку У. Димитар Миладинов. Здрава Југословенска Градба. Реновиран во 2013.',
  },
  {
    eb: EB63, id: EB63, location: 'Центар', address: 'Ул. Мите Богоевски 3',
    price: 36000, bedrooms: 1, sqm: 28, service: 'buy',
    lat: 41.99300, lon: 21.46800, geo_source: 'osm_building',
    features: ['греење на струја'],
    details: 'Гарсоњера во сутерен, комплетно реновирана.',
  },
  // The [08:58] chat: EB 84 was ASKED ABOUT by number while EB 63 sat in the
  // "currently discussed" slot — the follow-up "kolku kvadrati ima ?" must
  // answer 84's size, not 63's 28 м².
  {
    eb: EB84, id: EB84, location: 'Центар', address: 'Ул. Никола Вапцаров 7',
    price: 117000, bedrooms: 2, sqm: 34, service: 'buy', floor: 3,
    lat: 41.99000, lon: 21.47000, geo_source: 'osm_building',
    details: 'Стан со две спални соби, на трети кат.',
  },
];

const MAP_POIS = [
  { name: 'УЈП', type: 'government', lat: 41.98820, lon: 21.47590, source: 'google' },
];
const MAP_ADDRESSES = [
  { street: 'Ул. Димитар Миладинов', housenumber: '12', lat: 41.98810, lon: 21.47580 },
  { street: 'Ул. Мите Богоевски', housenumber: '3', lat: 41.99300, lon: 21.46800 },
];

function makeHandler() {
  const mapPath = tmpMapDb();
  writeMap(mapPath, MAP_POIS, MAP_ADDRESSES);
  const offlineMap = new OfflineMapStore(mapPath);
  const db = new Db(':memory:');
  const cfg = loadConfig();
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, new FakeProps(ROWS_INFO)),
    responder: new Responder(new FailingLlm(), cfg),
    properties: new FakeProps(ROWS_INFO),
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap }),
  });
  return { handler, sessions, sent, offlineMap };
}

function seed(sessions: SessionStore, chatId: string, ids: number[]) {
  const s = freshSession('test', chatId);
  s.slots.presentedIds = ids;
  sessions.set(s);
}

// ── Pure units: facets ───────────────────────────────────────────────────────

test('facets: price/sqm/rooms/floor/features, both scripts', () => {
  assert.equal(detectInfoFacets('kolku e garsonjerata ?')?.price, true);
  assert.equal(detectInfoFacets('која е цената на 69 ?')?.price, true);
  assert.equal(detectInfoFacets('a 63 kolku kvadrati ?')?.sqm, true);
  assert.equal(detectInfoFacets('колку е голем станот?')?.sqm, true);
  assert.equal(detectInfoFacets('kaj 69 kolku spalni ima ?')?.rooms, true);
  assert.equal(detectInfoFacets('na koj kat e ?')?.floor, true);
  assert.equal(detectInfoFacets('сутерен ли е ?')?.floor, true);
  assert.deepEqual(detectInfoFacets('dali 76 ima lift ?')?.features, ['лифт']);
  assert.deepEqual(detectInfoFacets('ima li parking ?')?.features, ['паркинг']);
});

// ── PARKING — the [22:26] transcript ────────────────────────────────────────
// „O E RESENO PARKIRANJETO?“ fell to the presentation card and „KAKO E RESENO
// PARKIRANJETO?“ to the off-topic redirect, while only „IMA PARKING“ was
// recognized. The family is matched by MORPHOLOGY (two stems: паркинг- /
// паркир-), plus a one-edit typo tolerance.
test('parking: every derivation and a one-slip typo is recognized', () => {
  for (const m of [
    'IMA PARKING ?', 'DALI IMA PARKING?', 'PARKING?',
    'DALI IMA PARKIRANJE?', 'KAKO E RESENO PARKIRANJETO?',
    'O E RESENO PARKIRANJETO?', 'KAKO E RESHENO PARKIRANETO?',
    'дали има паркиралиште?', 'паркинзи има?', 'kolku parking mesta?',
    'PAKRING?', 'PARKNIG?', 'PARKIG?', 'PARKINGS?',
  ]) {
    assert.equal(hasParkingWord(m), true, m);
  }
  // Unrelated words that share letters must never fire.
  for (const m of ['паркет', 'пари', 'стан со двор', 'гаража', 'партија']) {
    assert.equal(hasParkingWord(m), false, m);
  }
  assert.equal(detectFeatureAsk('PARKING?'), true, 'trailing punctuation is not a boundary miss');
  assert.equal(detectFeatureAsk('KAKO E RESENO PARKIRANJETO ?'), true);
});

test('parking: the ask becomes a parking facet — and not a price facet', () => {
  assert.deepEqual(detectInfoFacets('KAKO E RESENO PARKIRANJETO ?')?.features, ['паркинг']);
  assert.deepEqual(detectInfoFacets('PAKRING?')?.features, ['паркинг']);
  // "колку паркинг места" counts the FEATURE; the old "пар" money arm read it
  // as "колку пари" and the answer carried the flat price beside the parking line.
  const count = detectInfoFacets('Колку паркинг места има?')!;
  assert.deepEqual(count.features, ['паркинг']);
  assert.equal(count.price, undefined);
  assert.equal(detectPriceAsk('Колку паркинг места има?'), false);

  const parked = { ...ROWS_INFO[0], features: ['јавен паркинг'] } as Property;
  assert.equal(buildInfoAnswer(parked, { features: ['паркинг'] }), 'Има јавен паркинг.');
});

test('parking: a SEARCH criterion is intake, not an info ask about the bound flat', () => {
  // The client wants a flat WITH parking — the funnel owns this.
  assert.equal(detectInfoFacets('BARAM STAN SO PARKING ?'), undefined);
  assert.equal(detectInfoFacets('ми треба стан со паркинг?'), undefined);
  assert.equal(detectInfoFacets('IMATE LI STAN SO PARKING?'), undefined);
  // …but asking ABOUT the discussed flat is still an info ask.
  assert.deepEqual(detectInfoFacets('BARAM DA ZNAM DALI IMA PARKING ?')?.features, ['паркинг']);
});

// ── ДВОР — the card's «Двор (м²)» number ───────────────────────────────────
// The app writes yard_area from the operator's number: a value IS the yard (and
// its size), 0 is the default and means no yard. The feed emits `dvor_m2` so the
// ask can answer "Има двор од 300 м²" instead of a bare yes/no.
test('yard: the Двор (м²) number is quoted; 0 is no yard', () => {
  const withYard = { ...ROWS_INFO[0], features: ['двор'], yardSqm: 300 } as Property;
  assert.equal(buildInfoAnswer(withYard, { features: ['двор'] }), 'Има двор од 300 м².');
  // A legacy yard with no size still answers yes, without inventing м².
  const noSize = { ...ROWS_INFO[0], features: ['двор'] } as Property;
  assert.equal(buildInfoAnswer(noSize, { features: ['двор'] }), 'Има двор.');

  const feedRow = (over: Record<string, unknown>) => mapRow({
    evidenten_broj: '55', naslov: 'Куќа Повеќе соби', naselba: 'Влае', cena_eur: 40000,
    povrsina_m2: 240, tip_na_sobi: 'Повеќе соби', servis: 'Продава',
    tip_na_nedviznina: 'Куќа', ...over,
  })!;
  assert.equal(feedRow({ dvor: 'Да', dvor_m2: 300 }).yardSqm, 300);
  assert.equal(feedRow({ dvor: 'Да', dvor_m2: 0 }).yardSqm, undefined, '0 is not a size');
  assert.equal(feedRow({ dvor: 'Не' }).yardSqm, undefined);
  // The answer path uses it end-to-end.
  assert.equal(buildInfoAnswer(feedRow({ dvor: 'Да', dvor_m2: 300, garaza: 'Не' }), { features: ['двор'] }), 'Има двор од 300 м².');
});

// THE [00:33] YEAR ASK — "od koja godina e zgradata?" must answer from the
// real column, or say the datum is missing. It must never fall through to the
// dynamic lane and come back with a visit pitch (the stored wrong answer).
test('year: construction/renovation years are mapped and answered, missing data stays honest', () => {
  const feedRow = (over: Record<string, unknown>) => mapRow({
    evidenten_broj: '90', naslov: 'Стан', naselba: 'Центар', cena_eur: 100000,
    povrsina_m2: 60, tip_na_sobi: 'Две соби', servis: 'Продава', ...over,
  })!;
  const known = feedRow({ godina_na_gradba: 1987, renoviran: 2019 });
  assert.equal(known.yearBuilt, 1987);
  assert.equal(known.renovationYear, 2019);
  // The feed's empty marker is a STRING — it must not become NaN/0.
  const empty = feedRow({ godina_na_gradba: 'Не е наведено', renoviran: 'Не е наведено' });
  assert.equal(empty.yearBuilt, undefined);
  assert.equal(empty.renovationYear, undefined);

  // Detection covers the phrasings clients actually use (Latin is folded).
  for (const line of ['od koja godina e zgradata?', 'KOJA GODINA E IZGRADENA?', 'koga e izgradena zgradata?', 'kolku e stara zgradata?']) {
    assert.equal(detectInfoFacets(line)?.yearBuilt, true, `must detect: ${line}`);
  }
  assert.equal(detectInfoFacets('koga e renovirana?')?.renovation, true);
  // Not every "godina" is the facet.
  assert.equal(detectInfoFacets('kolku godini iskustvo imate?')?.yearBuilt, undefined);

  // Answer: the stored fact, or the honest owner-relay line — never invented.
  assert.equal(buildInfoAnswer(known, { yearBuilt: true }), 'Зградата е изградена во 1987 година.');
  assert.equal(buildInfoAnswer(empty, { yearBuilt: true }), INFO_NO_YEAR_LINE);
  assert.equal(buildInfoAnswer(known, { renovation: true }), 'Реновирана е во 2019 година.');
  assert.equal(buildInfoAnswer(empty, { renovation: true }), INFO_NO_RENOVATION_LINE);
  assert.match(buildInfoAnswer({ ...known, house: true }, { yearBuilt: true })!, /^Куќата/);
});

// THE [00:00] COLD ASK — "ZDRAVO DALI KUKJATA 55 IMA DVORCE?" arrived with
// no property on the table. The facet was found (yard), but the INFO gate
// required a slot, so the turn became the discovery/service question. A
// message that NAMES its EB is its own binding signal.
test('cold ask: a named EB binds the info answer with no session context', () => {
  assert.deepEqual(detectInfoFacets('ZDRAVO DALI KUKJATA 55 IMA DVORCE?')?.features, ['двор']);
  assert.deepEqual(detectInfoFacets('DALI 55 IMA DVORISTE?')?.features, ['двор']);
  assert.equal(inferPropertyId('ZDRAVO DALI KUKJATA 55 IMA DVORCE?'), 55);
  // A price is never read as an EB (the guard the gate relies on).
  assert.equal(inferPropertyId('BARAM KUKJA DO 80000'), undefined);
});

test('E2E: "od koja godina e zgradata?" answers from the info lane, never the dynamic pitch', async () => {
  const { handler, sessions, sent, offlineMap } = makeHandler();
  seed(sessions, 'info-year', [EB69]);
  // EB 69 has no year_built (the live feed has zero rows with one) — the
  // honest owner-relay line is the answer. Before the facet existed this fell
  // through to the dynamic lane and came back with a visit pitch.
  await handler.handle('test', 'info-year', 'od koja godina e zgradata?');
  assert.equal(sent.at(-1), INFO_NO_YEAR_LINE);
  offlineMap.close();
});

test('handler: a cold ask naming its EB answers from the feed, not discovery', async () => {
  const { handler, sent } = makeHandler();
  await handler.handle('test', 'cold', 'ZDRAVO DALI STANOT 63 IMA GREJNO?');
  assert.equal(sent.at(-1), 'Има греење на струја.');
});

test('handler: a parking ask routes to INFO, never the presentation card', async () => {
  const { handler, sessions, sent } = makeHandler();
  seed(sessions, 'parking', [EB63]);
  await handler.handle('test', 'parking', 'KAKO E RESENO PARKIRANJETO ?');
  // EB 63 stores nothing about parking — the honest owner-relay line, NOT the
  // full property card / off-topic redirect.
  assert.equal(sent.at(-1), INFO_NO_DATA_LINE);
});

test('facets: criteria and opinions are NOT info asks', () => {
  assert.equal(detectInfoFacets('stan od 80 m2'), undefined);
  assert.equal(detectInfoFacets('do 500 evra'), undefined);
  assert.equal(detectInfoFacets('so parking i lift'), undefined);
  // "колку саати работите" is a different question entirely
  assert.equal(detectInfoFacets('kolku saati rabotite ?')?.price, undefined);
  // size/rooms колку-phrases never double-fire as price
  const sqm = detectInfoFacets('колку е голем станот?');
  assert.equal(sqm?.price, undefined);
  assert.equal(sqm?.sqm, true);
});

// ── Pure units: builders ─────────────────────────────────────────────────────

const P63: Property = ROWS_INFO[1];

test('builders: price answer names EB, type and the feed price', () => {
  const a = buildInfoAnswer(P63, { price: true });
  assert.ok(a?.includes('63'), a);
  assert.ok(a?.includes('36.000') || a?.includes('36,000'), a);
  assert.ok(a?.includes('Гарсоњерата'), a);
});

test('builders: multi-facet compound ask answers all facets in one reply', () => {
  const a = buildInfoAnswer(P63, { sqm: true, rooms: true, floor: true });
  assert.ok(a?.includes('28 м²'), a);
  assert.ok(a?.includes('една спална'), a);
  assert.ok(a?.includes('сутерен'), a);
});

test('builders: known feature answered, unknown feature gets the honest no-data line', () => {
  const yes = buildInfoAnswer(P63, { features: ['греење'] });
  assert.ok(yes?.includes('греење на струја'), yes);
  const no = buildInfoAnswer(P63, { features: ['клима'] });
  assert.equal(no, INFO_NO_DATA_LINE);
});

test('builders: an explicit feed "Не" answers Нема, not the owner-relay line', () => {
  // The feed stores lift: "Не" for EB 85 — a KNOWN fact, not missing data.
  const noLift: Property = { ...P63, features: [], noFeatures: ['лифт'] };
  assert.equal(buildInfoAnswer(noLift, { features: ['лифт'] }), 'Нема лифт.');
  // Genuinely unrecorded stays the honest deferral.
  const unknown: Property = { eb: 98, id: 98, address: 'Y', location: 'Центар', service: 'buy' };
  assert.equal(buildInfoAnswer(unknown, { features: ['лифт'] }), INFO_NO_DATA_LINE);
});

test('builders: missing PRICE falls through; missing FLOOR is answered honestly', () => {
  const bare: Property = { eb: 99, id: 99, address: 'X', location: 'Центар', service: 'buy' };
  // Price has a legacy fallback lane (the FSM price path) — never steal it.
  assert.equal(buildInfoAnswer(bare, { price: true }), undefined);
  // Floor has NO such lane: falling through used to hand the ask to whatever
  // answered next (the [10:40] "колку ката" → unit-floor bug). A missing
  // fact is stated as missing and deferred to the owner.
  assert.equal(buildInfoAnswer(bare, { floor: true }), INFO_NO_DATA_LINE);
  assert.equal(buildInfoAnswer(bare, { totalFloors: true }), INFO_NO_FLOORS_LINE);
});

// ── E2E: the 12:33 chat, one family over ────────────────────────────────────

test('E2E: "kolku e garsonjerata?" binds EB 63 and answers 36.000, not shown[last]', async () => {
  const { handler, sessions, sent, offlineMap } = makeHandler();
  seed(sessions, 'info-c', [EB69, EB63]);

  await handler.handle('test', 'info-c', 'kolku e garsonjerata ?');
  const a = sent[sent.length - 1];
  assert.ok(a?.includes('63'), `must answer about EB 63: ${a}`);
  assert.ok(a?.includes('36.000') || a?.includes('36,000'), `must quote EB 63's price: ${a}`);
  assert.ok(!a?.includes('99.000') && !a?.includes('99,000'), `must NOT quote EB 69's price: ${a}`);

  offlineMap.close();
});

test('E2E: "kaj 69 kolku kvadrati" binds by EB; bare "kolku e" keeps legacy binding', async () => {
  const { handler, sessions, sent, offlineMap } = makeHandler();
  seed(sessions, 'info-d', [EB69, EB63]);

  await handler.handle('test', 'info-d', 'kaj 69 kolku kvadrati ?');
  const a = sent[sent.length - 1];
  assert.ok(a?.includes('51 м²'), `EB 69's size: ${a}`);

  // No binding signal → the current/last-shown chain answers (unchanged behavior).
  await handler.handle('test', 'info-d', 'kolku e ?');
  const b = sent[sent.length - 1];
  assert.ok(b?.includes('евра'), `bare kolku still answers a price: ${b}`);

  offlineMap.close();
});

test('E2E: feature ask about unstored data falls through honestly (no fabricated features)', async () => {
  const { handler, sessions, sent, offlineMap } = makeHandler();
  seed(sessions, 'info-f', [EB69, EB63]);

  // EB 69 has no feature data in the harness rows → the no-data line.
  await handler.handle('test', 'info-f', 'dali 69 ima klima ?');
  const a = sent[sent.length - 1];
  assert.ok(
    a?.includes('ќе го прашам сопственикот') || a?.includes('не е наведено'),
    `honest no-data line: ${a}`);

  offlineMap.close();
});

// ── GLOSSARY — the [08:52] transcript ───────────────────────────────────────
// "na koj kat e garsonjerata?" → "Се наоѓа во сутерен."
// "sto znaci toa suteren ?"    → the SAME line again (the word "сутерен" was
// read as a floor facet). A definition is not a fact about the property: it is
// answered as vocabulary, and the floor ask keeps its own answer.

test('glossary: the definition ask is recognized in both scripts', () => {
  for (const m of [
    'sto znaci toa suteren ?', 'шо значи сутерен?', 'што е сутерен',
    'što znači toa suteren?', 'suteren sto znaci', 'објасни ми што е сутерен',
    'не знам што е сутерен', 'a sto e suteren ?',
  ]) {
    assert.equal(detectGlossaryAsk(m), 'suteren-meaning', m);
    assert.equal(answerGlossary(m), SUTEREN_MEANING, m);
  }
  assert.equal(SUTEREN_MEANING, 'Сутерен е кат −1 — позиција еден кат подолу од приземјето на објектот.');
});

test('glossary: the dug-in follow-ups answer Делумно вкопан', () => {
  for (const m of [
    'dali e vkopan ?', 'дали е вкопана ?', 'дали е под земја ?', 'e pod zemja ?',
    'pod zemja?', 'dali e podrum', 'podrum li e ?', 'дали е подрум?',
  ]) {
    assert.equal(detectGlossaryAsk(m), 'suteren-dug-in', m);
    assert.equal(answerGlossary(m, { suteren: true }), SUTEREN_DUG_IN, m);
  }
  assert.equal(SUTEREN_DUG_IN, 'Делумно вкопан.');
});

test('glossary: Делумно вкопан is RESERVED for suteren units', () => {
  // No suteren on the table → the phrase is not produced at all.
  assert.equal(answerGlossary('dali e vkopan ?'), undefined);
  assert.equal(answerGlossary('dali e pod zemja ?', { suteren: false }), undefined);
  assert.equal(answerGlossary('dali e podrum ?', { suteren: false }), undefined);
  // The definition is not property-specific and always answers.
  assert.equal(answerGlossary('sto znaci suteren ?'), SUTEREN_MEANING);
  assert.equal(answerGlossary('sto znaci suteren ?', { suteren: false }), SUTEREN_MEANING);
  // The unit test: EB 63 is in a suteren; a third-floor flat is not.
  assert.equal(isSuterenUnit(ROWS_INFO[1]), true);
  assert.equal(isSuterenUnit({ ...ROWS_INFO[0], floor: 3 }), false);
});

test('glossary: the property asks stay with the property lanes', () => {
  // "сутерен ли е" is the storey, "има ли подрум" is a feature — neither is a
  // definition and neither may be stolen by the glossary lane.
  assert.equal(detectGlossaryAsk('сутерен ли е ?'), undefined);
  assert.equal(isGlossaryAsk('suteren li e'), false);
  assert.equal(detectGlossaryAsk('ima li podrum ?'), undefined);
  assert.equal(detectGlossaryAsk('дали има подрум?'), undefined);
  assert.equal(detectGlossaryAsk('na koj kat e ?'), undefined);
  // …and the definition never becomes a floor facet again.
  assert.equal(detectInfoFacets('sto znaci toa suteren ?'), undefined);
  assert.equal(detectInfoFacets('објасни ми што е сутерен'), undefined);
  // The dug-in ask is not a feature/facet either.
  assert.equal(detectInfoFacets('dali e vkopan ?'), undefined);
  // The genuine floor ask is untouched.
  assert.equal(detectInfoFacets('na koj kat e ?')?.floor, true);
  assert.equal(detectInfoFacets('сутерен ли е ?')?.floor, true);
});

test('E2E: floor → "what does suteren mean" → dug-in, each gets its own answer', async () => {
  const { handler, sessions, sent, offlineMap } = makeHandler();
  seed(sessions, 'gloss', [EB63]);

  await handler.handle('test', 'gloss', 'na koj kat e garsonjerata ?');
  assert.equal(sent.at(-1), 'Се наоѓа во сутерен.');

  // THE BUG: this used to repeat the line above.
  await handler.handle('test', 'gloss', 'sto znaci toa suteren ?');
  assert.equal(sent.at(-1), SUTEREN_MEANING);

  await handler.handle('test', 'gloss', 'dali e vkopan ?');
  assert.equal(sent.at(-1), SUTEREN_DUG_IN);

  await handler.handle('test', 'gloss', 'dali e pod zemja ?');
  assert.equal(sent.at(-1), SUTEREN_DUG_IN);

  await handler.handle('test', 'gloss', 'dali e podrum ?');
  assert.equal(sent.at(-1), SUTEREN_DUG_IN);

  // The floor question still answers the storey afterwards.
  await handler.handle('test', 'gloss', 'na koj kat e ?');
  assert.equal(sent.at(-1), 'Се наоѓа во сутерен.');

  offlineMap.close();
});

test('E2E: an upper-floor flat never gets the dug-in line', async () => {
  const upper = { ...ROWS_INFO[0], floor: 3 } as Property;
  const { handler, sessions, sent, offlineMap } = makeHandler();
  seed(sessions, 'gloss-up', [upper.eb]);

  for (const m of ['dali e vkopan ?', 'dali e pod zemja ?', 'dali e podrum ?']) {
    await handler.handle('test', 'gloss-up', m);
    const a = sent.at(-1);
    assert.notEqual(a, SUTEREN_DUG_IN, `must never claim «Делумно вкопан» for a 3rd-floor flat: ${m} → ${a}`);
    assert.ok(!a?.includes('вкопан'), `no dug-in wording for an upper floor: ${m} → ${a}`);
  }

  offlineMap.close();
});

// ── PRICE PER M² + the follow-up stays on the asked property ────────────────
// The [08:58] transcript: "kolku mu e cena po m2 na 84 ?" was answered with the
// total price only, and the bare follow-up "kolku kvadrati ima ?" answered a
// DIFFERENT property's 28 м² (the one sitting in the discussed slot).
test('E2E: "cena po m2 na 84" quotes the per-m² price, and the bare follow-up stays on 84', async () => {
  const { handler, sessions, sent, offlineMap } = makeHandler();
  const s = freshSession('test', 'perm2');
  s.slots.presentedIds = [EB63, EB84];
  s.slots.propertyId = EB63; // the flat that was being discussed before EB 84 was named
  sessions.set(s);

  await handler.handle('test', 'perm2', 'kolku mu e cena po m2 na 84 ?');
  const a = sent.at(-1) ?? '';
  assert.ok(a.includes('84'), `must name EB 84: ${a}`);
  assert.ok(a.includes('117.000') || a.includes('117,000'), `must quote the total: ${a}`);
  assert.ok(/3\.441/.test(a), `must quote the per-m² price (117.000 / 34 = 3.441): ${a}`);

  await handler.handle('test', 'perm2', 'kolku kvadrati ima ?');
  const b = sent.at(-1) ?? '';
  assert.ok(b.includes('34'), `the follow-up must answer EB 84's 34 м²: ${b}`);
  assert.ok(!b.includes('28'), `never the previously discussed flat's 28 м²: ${b}`);

  offlineMap.close();
});

// ── PRICE PER M² — the pure units ───────────────────────────────────────────
test('facets: "cena po m2" is the RATE facet, not the total price', () => {
  for (const m of [
    'kolku mu e cena po m2 na 84 ?', 'цена по м2?', 'cena za kvadrat ?',
    'kolku e evra na m² ?', 'цена по квадратен метар?',
  ]) {
    const f = detectInfoFacets(m);
    assert.equal(f?.pricePerSqm, true, m);
    assert.equal(f?.price, undefined, `the total must not double-answer: ${m}`);
  }
  // Plain price/size asks are untouched.
  assert.equal(detectInfoFacets('kolku e garsonjerata ?')?.price, true);
  assert.equal(detectInfoFacets('kolku e garsonjerata ?')?.pricePerSqm, undefined);
  const sqm = detectInfoFacets('a 63 kolku kvadrati ?');
  assert.equal(sqm?.sqm, true);
  assert.equal(sqm?.pricePerSqm, undefined);
  assert.equal(detectInfoFacets('58 m2')?.pricePerSqm, undefined);
  assert.equal(detectInfoFacets('na 3 kat e ?')?.pricePerSqm, undefined);
});

test('builders: the rate is computed from the feed price and surface', () => {
  const a = buildInfoAnswer(ROWS_INFO[2], { pricePerSqm: true })!;
  assert.ok(a.includes('117.000') || a.includes('117,000'), a);
  assert.ok(a.includes('3.441'), a);
  assert.ok(a.includes('34 м²'), a);
  // No stored surface → the total plus the honest deferral, never a fake rate.
  const noSize: Property = { eb: 98, id: 98, address: 'Y', location: 'Центар', service: 'buy', price: 50000 };
  const b = buildInfoAnswer(noSize, { pricePerSqm: true })!;
  assert.ok(b.includes('50.000'), b);
  assert.ok(b.includes('ќе го прашам сопственикот'), b);
  assert.ok(!b.includes('за м²'), `no invented rate: ${b}`);
  // No price at all → the facet falls through (the FSM price lane owns it).
  const bare: Property = { eb: 97, id: 97, address: 'Z', location: 'Центар', service: 'buy', sqm: 40 };
  assert.equal(buildInfoAnswer(bare, { pricePerSqm: true }), INFO_NO_DATA_LINE);
});
