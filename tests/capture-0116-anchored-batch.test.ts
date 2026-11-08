/**
 * THE [01:16]–[01:33] CAPTURE — four field defects, one root each.
 *
 *   [01:16] KOLKU IDAT TAMU STANOVITE                     ← no answer
 *   [01:18] … DO 1800E PO KVADRAT  (pair near Бисер + Капитол)
 *   [01:19] OVIE NE SE KAJ KAPITOL I BISER
 *   [01:19] ЛИНА: … Кисела Вода + Маџари cards «до ТЦ Капитол»  ← WRONG, 2 km away
 *   [01:20] KISELA VODA MOZE KAJ RAMPA
 *   [01:20] ЛИНА: a ТРОСОБЕН card near Бисер                     ← wrong type, wrong place
 *   [01:21] NAA KOLKU METRI E 69 DO RAMPA?                       ← answered with a card
 *
 *   1. THE MARKET PRICE ASK: «KOLKU IDAT TAMU STANOVITE» names a move verb and
 *      the type plural, never a price noun, so the market-rate detector
 *      refused it and the turn died on the funnel. The client asked what flats
 *      GO FOR there — the answer is the €/m² range for the area on file.
 *   2. THE RING BOUNDS A CROSS-PLACE BATCH: the 1 km radius and the too-far
 *      pick were applied only when ONE place was named (`singlePlace`), so a
 *      pair anchor served rows 2 km from both places under «Еве ги најблиските
 *      опции до ТЦ Капитол».
 *   3. A PLACE NAMED BESIDE AN AREA IS THE ANCHOR: any place named alongside
 *      an area the feed files rows under was dropped, so «KISELA VODA MOZE KAJ
 *      RAMPA» kept the shop anchor from two turns earlier while the area said
 *      Кисела Вода. The pair is ranked from the place he named, inside his area.
 *      The map files that place as «тобако РАМПА» — a CLASS word in front,
 *      which the name-coverage guard read as a brand.
 *   4. «KOLKU METRI E 69 DO RAMPA» IS A DISTANCE QUESTION: the detector's
 *      «kolku metri/minuti» arm consumed its own separator twice, so any single
 *      space failed and the turn fell through to a card.
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
import { BankStore } from '../src/store/bank';
import { detectMarketPriceAsk, isDistanceQuestion } from '../src/llm/deterministic';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

/**
 * The capture's own rows and pins (Biser 41.98498,21.46566; Капитол
 * 41.98612,21.46673; тобако РАМПА 41.98703,21.43691):
 *   EB 53 — dvosoben, 20 m from Бисер;
 *   EB 89 — dvosoben, 910 m from Капитол;
 *   EB 90 — dvosoben in Кисела Вода, 2,0 km from both place pins (the row that
 *           rode the «до ТЦ Капитол» opener);
 *   EB 43 — dvosoben in Маџари, 2,3 km away (the second one);
 *   EB 47 — dvosoben, 583 m from Рампа;
 *   EB 38 — ТРОСОБЕН, 150 m from Рампа (the wrong-type card of the capture).
 */
const ROWS: Property[] = [
  { eb: 53, id: 53, location: 'Аеродром', address: 'Бисер', price: 55000, bedrooms: 2, sqm: 44, size: '44 м²', service: 'buy', lat: 41.9851, lon: 21.4658 },
  { eb: 89, id: 89, location: 'Аеродром', address: 'Парк Авионче', price: 110000, bedrooms: 2, sqm: 70, size: '70 м²', service: 'buy', lat: 41.9894, lon: 21.4768 },
  { eb: 90, id: 90, location: 'Кисела Вода', address: 'Internat Dimitar Vlahov', price: 75000, bedrooms: 2, sqm: 54, size: '54 м²', service: 'buy', lat: 41.9762, lon: 21.4448 },
  { eb: 43, id: 43, location: 'Маџари', address: 'Хатунџук Џамија', price: 68300, bedrooms: 2, sqm: 48, size: '48 м²', service: 'buy', lat: 41.9961, lon: 21.4892 },
  { eb: 47, id: 47, location: 'Центар', address: 'Партизански', price: 150500, bedrooms: 2, sqm: 59, size: '59 м²', service: 'buy', lat: 41.9886, lon: 21.4302 },
  { eb: 38, id: 38, location: 'Кисела Вода', address: 'Рампа', price: 101750, bedrooms: 3, sqm: 57, size: '57 м²', service: 'buy', lat: 41.9862, lon: 21.4355 },
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === eb || r.id === eb);
  }
  get healthy(): boolean { return true; }
}

function makeHandler(id: string) {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const handler = new InboundHandler({
    cfg, db, sessions, bank: new BankStore(db),
    classifier: new Classifier(new FailingLlm(), cfg, new FakeProps(ROWS)),
    responder: new Responder(new FailingLlm(), cfg),
    properties: new FakeProps(ROWS),
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
    enrichment: new EnrichmentStore(db),
  });
  return { handler, sessions, sent, chatId: id };
}

// ── 1. «KOLKU IDAT TAMU STANOVITE» IS A MARKET-RATE ASK ────────────────────

test('[01:16] a move verb + the type plural is a market-price ask', () => {
  // Both field variants, Latin and Cyrillic, with and without the «?».
  assert.equal(detectMarketPriceAsk('KOLKU IDAT TAMU STANOVITE'), true);
  assert.equal(detectMarketPriceAsk('KOLKU IDAT TAMU STANOVITE?'), true);
  assert.equal(detectMarketPriceAsk('КОЛКУ ИДАТ ТАМУ СТАНОВИТЕ?'), true);
});

test('[01:16] the market ask is answered with the €/m² range for the area on file', async () => {
  const { handler, sent, chatId } = makeHandler('capture-0116-market');
  await handler.handle('test', chatId, 'ZDRAVO');
  await handler.handle('test', chatId, 'STN MI TREBA');
  await handler.handle('test', chatId, 'AERODROM');
  await handler.handle('test', chatId, 'DA KUPAM');
  await handler.handle('test', chatId, 'KOLKU IDAT TAMU STANOVITE');
  const answer = sent[sent.length - 1] ?? '';
  assert.match(answer, /за м²/u,
    `the client asked what flats GO FOR — the €/m² range is the answer: ${answer}`);
  assert.match(answer, /Аеродром/u,
    `the range is for the area he named: ${answer}`);
});

// ── 2. THE 1 km RING BOUNDS A CROSS-PLACE BATCH ────────────────────────────

test('[01:19] a cross-place ask never serves rows beyond the ring as «nearest»', async () => {
  const { handler, sent, sessions, chatId } = makeHandler('capture-0116-ring');
  await handler.handle('test', chatId, 'SAKAM DA KUPAM DVOSOBEN STAN KAJ BISER ILI KAPITOL');
  await handler.handle('test', chatId, 'DO 1800E PO KVADRAT');
  await handler.handle('test', chatId, 'OVIE NE SE KAJ KAPITOL I BISER');
  const answer = sent[sent.length - 1] ?? '';
  // The two rows that rode the old opener are 2,0 km and 2,3 km from BOTH pins.
  assert.doesNotMatch(answer, /Кисела Вода/u,
    `a card 2 km from both named places is not «близу Капитол»: ${answer}`);
  assert.doesNotMatch(answer, /Маџари/u,
    `a card 2,3 km away is not «близу Бисер»: ${answer}`);
  assert.match(answer, /до 1 km/u,
    `the honest ring statement is owed instead: ${answer}`);
  assert.match(answer, /подалеку/u,
    `and the widen pick is the way out: ${answer}`);
  assert.equal(sessions.get(chatId)!.slots.poiTooFarAsk, true,
    'the ring question is pending');
});

// ── 3. THE PLACE NAMED BESIDE AN AREA IS THE ANCHOR ────────────────────────

test('[01:20] a place named beside an area anchors the pair, and the area stands', async () => {
  const { handler, sent, sessions, chatId } = makeHandler('capture-0116-rampa');
  await handler.handle('test', chatId, 'SAKAM DA KUPAM DVOSOBEN STAN KAJ BISER ILI KAPITOL');
  await handler.handle('test', chatId, 'DO 1800E PO KVADRAT');
  await handler.handle('test', chatId, 'KISELA VODA MOZE KAJ RAMPA');
  // The place pivots a live search, so it is CONFIRMED first (one question),
  // then the confirmed turn is the serve.
  const pending = sessions.get(chatId)!.slots.pendingPivot;
  assert.match(String(pending?.name ?? ''), /рампа|rampa/iu,
    `the client named the place he wants the pair ranked from, got ${pending?.name}`);
  const ask = sent[sent.length - 1] ?? '';
  assert.match(ask, /рампа/iu, `the confirmation names his place: ${ask}`);
  assert.doesNotMatch(ask, /Бисер/u, `the old anchor must not answer: ${ask}`);
  await handler.handle('test', chatId, 'DA');
  const s = sessions.get(chatId)!;
  assert.match(String(s.slots.poiAnchor), /рампа|rampa/iu,
    `the anchor moved to his place, got ${s.slots.poiAnchor}`);
  assert.equal(s.slots.location, 'Кисела Вода',
    'the area he stated himself is never overwritten by the place\'s derived one');
});

test('[01:21] a bare «да» spends the ring question instead of repeating it', async () => {
  const { handler, sent, sessions, chatId } = makeHandler('capture-0116-widen');
  await handler.handle('test', chatId, 'SAKAM DA KUPAM DVOSOBEN STAN KAJ BISER ILI KAPITOL');
  await handler.handle('test', chatId, 'DO 1800E PO KVADRAT');
  await handler.handle('test', chatId, 'KISELA VODA MOZE KAJ RAMPA');
  await handler.handle('test', chatId, 'DA');
  const ringLine = sent[sent.length - 1] ?? '';
  assert.match(ringLine, /до 1 km/u, `the ring statement comes first: ${ringLine}`);
  await handler.handle('test', chatId, 'DA');
  const served = sent[sent.length - 1] ?? '';
  assert.notEqual(served, ringLine,
    'the identical paragraph must never be served twice — the yes was not read');
  assert.match(served, /Евидентен број/u, `the widen answer is the pair: ${served}`);
  // Distance, price and м² are what the owner asked to be served.
  assert.match(served, /на 1,4 km од/u, `the distance to the named place: ${served}`);
  assert.match(served, /м²/u, `the surface: ${served}`);
  assert.match(served, /евра/u, `the price: ${served}`);
  // The ring is released INSIDE his naselba, so the card is from Кисела Вода.
  assert.match(served, /Кисела Вода/u, `the widen stays in his area: ${served}`);
  assert.equal(sessions.get(chatId)!.slots.poiWidenScope, 'area');
});

test('[01:20] the wrong-type card is never the answer to a dvosoben search', async () => {
  const { handler, sent, chatId } = makeHandler('capture-0116-type');
  await handler.handle('test', chatId, 'SAKAM DA KUPAM DVOSOBEN STAN KAJ BISER ILI KAPITOL');
  await handler.handle('test', chatId, 'DO 1800E PO KVADRAT');
  await handler.handle('test', chatId, 'KISELA VODA MOZE KAJ RAMPA');
  await handler.handle('test', chatId, 'DA');
  await handler.handle('test', chatId, 'DA');
  const served = sent[sent.length - 1] ?? '';
  // EB 38 is 150 m from Рампа and a ТРОСОБЕН — the capture served it anyway.
  assert.doesNotMatch(served, /Евидентен број 38/u,
    `a трисобен may not answer a dvosoben search: ${served}`);
});

// ── 4. «KOLKU METRI E 69 DO RAMPA» IS A DISTANCE QUESTION ───────────────────

test('[01:21] the distance ask is read with a single space, and before the place', () => {
  assert.equal(isDistanceQuestion('NAA KOLKU METRI E 69 DO RAMPA'), true);
  assert.equal(isDistanceQuestion('KOLKU METRI E 69 DO RAMPA?'), true);
  assert.equal(isDistanceQuestion('KOLKU METRI'), true);
  assert.equal(isDistanceQuestion('KOLKU MINUTI PESKE'), true);
  assert.equal(isDistanceQuestion('КОЛКУ МЕТРИ Е 69 ДО РАМПА?'), true);
});

test('[01:21] the distance answer is a distance, never a card', async () => {
  const { handler, sent, chatId } = makeHandler('capture-0116-distance');
  await handler.handle('test', chatId, 'SAKAM DA KUPAM DVOSOBEN STAN KAJ BISER');
  await handler.handle('test', chatId, 'DO 1800E PO KVADRAT');
  await handler.handle('test', chatId, 'NAA KOLKU METRI E 69 DO RAMPA');
  const answer = sent[sent.length - 1] ?? '';
  assert.match(answer, /километри|метри|минути/u,
    `the question is HOW FAR — the answer is the distance: ${answer}`);
  assert.match(answer, /рампа|rampa/iu, `the distance is to the place he named: ${answer}`);
  assert.doesNotMatch(answer, /Цената е/u,
    `a card is not a distance answer: ${answer}`);
});
