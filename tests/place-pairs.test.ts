/**
 * TWO PLACES IN ONE ASK, AND A PLACE THAT MOVES THE SEARCH — the [18:48]/[18:51]
 * transcript.
 *
 *   [18:48] ZDRAVO SAKAM DA SI KUPAM STANCE OKOLU UNIVERZALNA , BUNJAKOVEC
 *   [18:49] EDNA ILI DVE / IMAM OKOLU 169999
 *   [18:49] ЛИНА: … EB 77 (220 m) + EB 66 (320 m)   ← BOTH from Универзална;
 *           Буњаковец was never searched, only the first place was extracted
 *   [18:51] A NESTO KAJ DIMITAR MILADINOV SKOLOTO ?  ← «same kind of flat, other
 *           place»
 *   [18:51] ЛИНА: «Не, тоа е на 2,1 километри од Спортски терени…»  ← answered
 *           as a distance question about the flat on the table
 *
 * The contract these pin:
 *   1. EVERY place a message names is kept, and the pair SPANS them: one card
 *      near each, each stating its own distance.
 *   2. Places rotate two at a time through a cycle — two places: 1/2, 1/2;
 *      three: 1/2, then 3/1, then 2/3; four: 1/2, then 3/4, then 1/2.
 *   3. A place with nothing in the criteria does not cost the client half the
 *      pair: the stocked place fills both slots and one line says the other
 *      place has nothing.
 *   4. «a neshto kaj X?» is a SEARCH at another place: the criteria stand (one
 *      short confirm), and the agreement serves the pair nearest X — never a
 *      distance of some landmark from the previously shown flat.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config';
import { Db } from '../src/store/db';
import { SessionStore } from '../src/fsm/session';
import { Classifier } from '../src/llm/classify';
import { Responder } from '../src/llm/respond';
import { PropertyService, Property } from '../src/data/properties';
import { AppointmentStore } from '../src/store/appointments';
import { EscalationStore } from '../src/store/escalations';
import { MetaStore } from '../src/store/meta';
import { EnrichmentStore } from '../src/store/enrichment';
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LlmClient } from '../src/llm/types';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';
import { isPoiConfirmQuestion, isPlaceSearchPivot, extractPoiListCandidates, extractPoiWishCandidates } from '../src/llm/deterministic';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

// Real map pins — the resolver is the production one, so the test must speak
// the map's own places: Универзална Сала, Буњаковец, Католичка црква кон
// Центар, Собрание and the school in Димитар Миладинов.
const ROWS: Property[] = [
  // Универзална Сала (41.99922, 21.41648)
  { eb: 301, id: 301, location: 'Центар', price: 120000, bedrooms: 2, sqm: 50, size: '50 м²', service: 'buy', lat: 41.9993, lon: 21.4165 },
  { eb: 302, id: 302, location: 'Центар', price: 121000, bedrooms: 2, sqm: 51, size: '51 м²', service: 'buy', lat: 41.9991, lon: 21.4164 },
  // Буњаковец (41.99746, 21.41864)
  { eb: 311, id: 311, location: 'Центар', price: 122000, bedrooms: 2, sqm: 52, size: '52 м²', service: 'buy', lat: 41.9975, lon: 21.4187 },
  { eb: 312, id: 312, location: 'Центар', price: 123000, bedrooms: 2, sqm: 53, size: '53 м²', service: 'buy', lat: 41.9974, lon: 21.4185 },
  // Католичка црква кон Центар
  { eb: 321, id: 321, location: 'Центар', price: 124000, bedrooms: 2, sqm: 54, size: '54 м²', service: 'buy', lat: 41.9948, lon: 21.4165 },
  { eb: 322, id: 322, location: 'Центар', price: 125000, bedrooms: 2, sqm: 55, size: '55 м²', service: 'buy', lat: 41.9946, lon: 21.4163 },
  // ОУ „Димитар Миладинов“ (41.98922, 21.43478) — the [18:51] pivot target.
  { eb: 331, id: 331, location: 'Центар', price: 118000, bedrooms: 2, sqm: 56, size: '56 м²', service: 'buy', lat: 41.9893, lon: 21.4348 },
  { eb: 332, id: 332, location: 'Центар', price: 119000, bedrooms: 2, sqm: 57, size: '57 м²', service: 'buy', lat: 41.9891, lon: 21.4346 },
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === eb || r.id === eb);
  }
  get healthy(): boolean { return true; }
}

function makeHandler(id: string, rows: Property[] = ROWS) {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, new FakeProps(rows)),
    responder: new Responder(new FailingLlm(), cfg),
    properties: new FakeProps(rows),
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
    enrichment: new EnrichmentStore(db),
  });
  const chatId = id;
  const say = async (m: string): Promise<string> => {
    await handler.handle('test', chatId, m);
    return sent.at(-1) ?? '';
  };
  return { say, sessions, chatId, sent };
}

test('a comma-list of places is extracted, not only the first proximity tail', () => {
  const msg = 'ZDRAVO SAKAM DA SI KUPAM STANCE OKOLU UNIVERZALNA , BUNJAKOVEC';
  assert.deepEqual(extractPoiWishCandidates(msg, { withCriteria: true }), ['универзална'],
    'the proximity tail alone still sees one place');
  assert.deepEqual(extractPoiListCandidates(msg), ['универзална', 'BUNJAKOVEC'],
    'the list member after the comma is a second place candidate');
});

test('two places in one ask are served as ONE CARD EACH, with their own distances', async () => {
  const { say, sessions, chatId } = makeHandler('two-places');
  await say('ZDRAVO SAKAM DA SI KUPAM STANCE OKOLU UNIVERZALNA , BUNJAKOVEC');
  await say('EDNA ILI DVE');
  const reply = await say('DO 150000');

  assert.deepEqual(sessions.get(chatId)!.slots.poiPlaces?.map(p => p.name),
    ['Универзална Сала', 'Буњаковец'], 'both places were kept, in the client\'s order');
  assert.deepEqual(sessions.get(chatId)!.slots.currentBatch, [301, 311],
    'one card nearest each place — not two cards near the first');
  assert.match(reply, /Еве по една опција до Универзална Сала и до Буњаковец:/);
  assert.match(reply, /Евидентен број 301[\s\S]*од Универзална Сала/);
  assert.match(reply, /Евидентен број 311[\s\S]*од Буњаковец/);
});

test('three places rotate 1/2, 3/1, 2/3; four rotate 1/2, 3/4, 1/2', async () => {
  const three = makeHandler('three-places');
  await three.say('ZDRAVO SAKAM DA SI KUPAM STANCE OKOLU UNIVERZALNA , BUNJAKOVEC , KATOLICKA');
  await three.say('EDNA ILI DVE');
  await three.say('DO 150000');
  assert.deepEqual(three.sessions.get(three.chatId)!.slots.currentBatch, [301, 311], '1/2');
  const second = await three.say('DRUGI OPCII');
  assert.deepEqual(three.sessions.get(three.chatId)!.slots.currentBatch, [322, 302], '3/1');
  assert.match(second, /Еве по една опција до Католичка црква кон Центар и до Универзална Сала:/);
  await three.say('DRUGI OPCII');
  assert.deepEqual(three.sessions.get(three.chatId)!.slots.currentBatch, [312, 321], '2/3');

  const two = makeHandler('two-cycle');
  await two.say('ZDRAVO SAKAM DA SI KUPAM STANCE OKOLU UNIVERZALNA , BUNJAKOVEC');
  await two.say('EDNA ILI DVE');
  await two.say('DO 150000');
  assert.deepEqual(two.sessions.get(two.chatId)!.slots.currentBatch, [301, 311], '1/2');
  await two.say('DRUGI OPCII');
  assert.deepEqual(two.sessions.get(two.chatId)!.slots.currentBatch, [302, 312],
    'two places repeat 1/2 with the next nearest row at each');

  // FOUR places: 1/2, then 3/4, then back to 1/2 (Собрание is the 4th).
  const fourRows: Property[] = [...ROWS,
    { eb: 341, id: 341, location: 'Центар', price: 126000, bedrooms: 2, sqm: 58, size: '58 м²', service: 'buy', lat: 41.9928, lon: 21.4325 },
    { eb: 342, id: 342, location: 'Центар', price: 127000, bedrooms: 2, sqm: 59, size: '59 м²', service: 'buy', lat: 41.9926, lon: 21.4323 },
  ];
  const four = makeHandler('four-places', fourRows);
  await four.say('ZDRAVO SAKAM DA SI KUPAM STANCE OKOLU UNIVERZALNA , BUNJAKOVEC , KATOLICKA , SOBRANIE');
  await four.say('EDNA ILI DVE');
  await four.say('DO 150000');
  assert.deepEqual(four.sessions.get(four.chatId)!.slots.currentBatch, [301, 311], '1/2');
  await four.say('DRUGI OPCII');
  assert.deepEqual(four.sessions.get(four.chatId)!.slots.currentBatch, [322, 341], '3/4');
  await four.say('DRUGI OPCII');
  assert.deepEqual(four.sessions.get(four.chatId)!.slots.currentBatch, [302, 312], '1/2 again');
});

test('a place with nothing under the criteria: pair from the stocked place, said plainly', async () => {
  const { say, sessions, chatId } = makeHandler('empty-place');
  // ТЦ Џевахир is ~4,5 km from every row here — nothing in the criteria.
  const reply = await (async () => {
    await say('ZDRAVO SAKAM DA SI KUPAM STANCE OKOLU UNIVERZALNA , TC DZEVAHIR');
    await say('EDNA ILI DVE');
    return say('DO 150000');
  })();

  assert.deepEqual(sessions.get(chatId)!.slots.currentBatch, [301, 302],
    'both cards come from the place that has stock');
  assert.match(reply, /Околу Џевахир кула А во моментов немам ништо што одговара на овие критериуми\./);
  assert.match(reply, /Евидентен број 301/);
  assert.match(reply, /Евидентен број 302/);
});

test('«a neshto kaj X?» keeps the criteria, confirms them once, then serves near X', async () => {
  const { say, sessions, chatId } = makeHandler('place-pivot');
  await say('ZDRAVO SAKAM DA SI KUPAM STANCE OKOLU UNIVERZALNA , BUNJAKOVEC');
  await say('EDNA ILI DVE');
  await say('DO 150000');

  const confirm = await say('A NESTO KAJ DIMITAR MILADINOV SKOLOTO ?');
  assert.match(confirm, /истите критериуми/, 'the criteria are kept, not re-asked');
  assert.match(confirm, /една или две спални/);
  assert.match(confirm, /до 150\.000 евра/);
  assert.match(confirm, /Димитар Миладинов/);
  assert.doesNotMatch(confirm, /километри од/, 'never the landmark-distance correction');
  assert.deepEqual(sessions.get(chatId)!.slots.pendingPivot?.name, 'ОУ „Димитар Миладинов“');

  const served = await say('DA');
  assert.deepEqual(sessions.get(chatId)!.slots.currentBatch, [331, 332],
    'the pair nearest the school he named');
  assert.match(served, /Еве ги најблиските опции до ОУ „Димитар Миладинов“:/);
  assert.match(served, /Евидентен број 331[\s\S]*од ОУ „Димитар Миладинов“/);
});

test('a place name that is also a neighborhood name: it JOINS the rotation, and the pair spans both', async () => {
  // «ОПШТИНА БУТЕЛ» is a real map place (42.0312237, 21.4458274) AND the feed's
  // area dialect has «Бутел» in its known-neighborhood list (with no rows of
  // its own). The area reading used to win outright, so neither place reached
  // the rotation and the search locked to a district with no stock.
  const rows: Property[] = [
    ...ROWS,
    // ~150 m north of the municipality building — the «Бутел» stock.
    { eb: 351, id: 351, location: 'Чаир', price: 140000, bedrooms: 2, sqm: 60, size: '60 м²', service: 'buy', lat: 42.03255, lon: 21.4458 },
  ];
  const { say, sessions, chatId } = makeHandler('area-name-place', rows);
  await say('ZDRAVO SAKAM DA SI KUPAM STANCE OKOLU UNIVERZALNA , OPSTINA BUTEL');
  await say('EDNA ILI DVE');
  const reply = await say('DO 150000');

  assert.deepEqual(sessions.get(chatId)!.slots.poiPlaces?.map(p => p.name),
    ['Универзална Сала', 'Општина Бутел'], 'the municipality building is a PLACE, not only an area');
  assert.deepEqual(sessions.get(chatId)!.slots.currentBatch, [301, 351],
    'one card near each place, even though they sit in different districts');
  assert.match(reply, /Еве по една опција до Универзална Сала и до Општина Бутел:/);
  assert.match(reply, /Евидентен број 301[\s\S]*од Универзална Сала/);
  assert.match(reply, /Евидентен број 351[\s\S]*од Општина Бутел/);
});

test('a place anchor keeps the pair NEAR the place: no room-category card from 1,4 km', async () => {
  // The [18:51] school capture in miniature: the criteria allow 1–2 bedrooms
  // (2…3 rooms), so the range ladder alternates categories — and paired the
  // 2-room at 70 m with a 3-room at 1,4 km while a second 2-room sat at 320 m.
  // Under a place anchor the rotation survives only INSIDE a 250 m band.
  const rows: Property[] = [
    // The first serve's stock (Универзална + Буњаковец), consumed by turn 3.
    ...ROWS.filter(p => [301, 302, 311, 312].includes(p.eb)),
    // ~20 m from the school, 2 rooms — the lead card either way.
    { eb: 331, id: 331, location: 'Центар', price: 118000, bedrooms: 2, sqm: 56, size: '56 м²', service: 'buy', lat: 41.9893, lon: 21.4348 },
    // ~320 m, 2 rooms — the neighbour the band keeps.
    { eb: 361, id: 361, location: 'Центар', price: 150500, bedrooms: 2, sqm: 59, size: '59 м²', service: 'buy', lat: 41.9921, lon: 21.4348 },
    // ~1,4 km, 3 rooms — the far card the category rotation used to reach for.
    { eb: 362, id: 362, location: 'Центар', price: 154000, bedrooms: 3, sqm: 76, size: '76 м²', service: 'buy', lat: 42.0019, lon: 21.4348 },
  ];
  const { say, sessions, chatId } = makeHandler('school-band', rows);
  await say('ZDRAVO SAKAM DA SI KUPAM STANCE OKOLU UNIVERZALNA , BUNJAKOVEC');
  await say('EDNA ILI DVE');
  await say('DO 169999');
  await say('A NESTO KAJ DIMITAR MILADINOV SKOLOTO ?');
  await say('DA');

  assert.deepEqual(sessions.get(chatId)!.slots.currentBatch, [331, 361],
    'the two nearest options — the far 3-room does not win its category slot');
});

test('a location CONFIRM about the flat on the table is still a confirm', () => {
  assert.equal(isPlaceSearchPivot('A NESTO KAJ DIMITAR MILADINOV SKOLOTO ?'), true);
  assert.equal(isPoiConfirmQuestion('A NESTO KAJ DIMITAR MILADINOV SKOLOTO ?'), false,
    'the pivot is not the POI-confirm lane');
  assert.equal(isPlaceSearchPivot('DA NE E VO KARPOS ?'), false);
  assert.equal(isPoiConfirmQuestion('DA NE E VO KARPOS ?'), true);
  assert.equal(isPlaceSearchPivot('DALI E KAJ SKOPJANKA ?'), false);
  assert.equal(isPoiConfirmQuestion('DALI E KAJ SKOPJANKA ?'), true);
  // «vo TOJ del na gradot» is a deictic, not a place to pivot to.
  assert.equal(isPlaceSearchPivot('STO IMATE VO TOJ DEL NA GRADOT ?'), false);
});
