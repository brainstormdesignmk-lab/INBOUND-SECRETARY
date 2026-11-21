/**
 * THE [21:55]–[21:58] FIELD CAPTURE — geography, twice.
 *
 *   [21:55] sakam da kupam stan kaj bunjakovec ili beverli hils
 *   [21:56] familijarno nesto so dve spalni
 *   [21:56] do 180000
 *   ЛИНА: «Еве по една опција до Буњаковец и до Беверли Хилс» — EB 66 + EB 84,
 *          580 m and 910 m from the two places (correct)
 *   [21:56] uste nesto ima ?
 *   ЛИНА: «Ги одбрав следниве опции кои во целост одговараат на сите Ваши
 *          барања» — EB 51 (Водно, 600 m from Беверли Хилс — inside its ring)
 *          AND EB 85 (Ново Лисиче, 1,8 km from Буњаковец, ~2 km from Беверли
 *          Хилс — inside NEITHER ring)
 *   [21:58] moze vo centar
 *   ЛИНА: «Во моментов немам недвижност во непосредна близина на Ресторан
 *          Имес кон Центар (до 1 km) — најблиску што имам е на 1,3 km»
 *
 * TWO roots, each pinned here:
 *
 *   1. THE CROSS-PLACE QUEUE KEPT ITS LEFTOVERS. `placePairQueue` anchors a
 *      card only inside a place's honest radius, but the rotation's tail queued
 *      every remaining pool row anyway — so a flat two districts away went out
 *      under «во целост одговараат на сите Ваши барања». The rows are not
 *      lost: the ring question («да Ви покажам нешто подалеку?») is what offers
 *      them, and a picked widen releases the lock.
 *   2. «moze vo centar» REACHED THE MAP AS A SENTENCE. findPoiByName is a token
 *      match, so «центар» inside the bus stop «Ресторан Имес кон Центар» won,
 *      and the ring ask then measured every card from a stop in Карпош 3. A
 *      leading grammar run is trimmed now (stripPlaceFiller), and an area word
 *      resolves the NASELBA row — a settlement is not a landmark, so naming one
 *      retires the old anchor's ring instead of re-measuring the district from
 *      it.
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
import { InboundHandler, stripPlaceFiller } from '../src/handlers/inbound';
import { LlmClient } from '../src/llm/types';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';
import { BankStore } from '../src/store/bank';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

/**
 * The live feed's own rows and positions (map: Буњаковец 41.99746,21.41864;
 * Беверли Хилс 41.99368,21.41623; Ресторан Имес кон Центар is a bus stop at
 * 42.00754,21.39446 — Карпош 3):
 *   66 — Центар, 3 rooms, 137.000, Рузвелтова (184 m from Беверли Хилс, 580 m
 *        from Буњаковец — the pair's first card);
 *   84 — Центар, 3 rooms, 117.000 (910 m from Буњаковец — the second card);
 *   51 — Водно, 3 rooms, 99.000 (599 m from Беверли Хилс: inside its ring);
 *   85 — Ново Лисиче, 3 rooms, 133.000, feed pin 41.9993/21.44 (1,79 km from
 *        Буњаковец and ~2,1 km from Беверли Хилс: inside NEITHER ring);
 *   91 — Центар, 3 rooms, 178.000 (the flat the area-wide re-search serves).
 */
const ROWS: Property[] = [
  { eb: 66, id: 66, location: 'Центар', address: 'Рузвелтова 51', price: 137000, bedrooms: 3, sqm: 79, size: '79 м²', service: 'buy', lat: 41.9954, lon: 21.4163 },
  { eb: 84, id: 84, location: 'Центар', address: 'Роза Луксембург', price: 117000, bedrooms: 3, sqm: 48, size: '48 м²', service: 'buy', lat: 41.9953, lon: 21.4167 },
  { eb: 51, id: 51, location: 'Водно', address: 'Мајка Тереза 60', price: 99000, bedrooms: 3, sqm: 71, size: '71 м²', service: 'buy', lat: 41.9884, lon: 21.4177 },
  { eb: 85, id: 85, location: 'Ново Лисиче', address: 'Кај Бранка', price: 133000, bedrooms: 3, sqm: 100, size: '100 м²', service: 'buy', lat: 41.9993, lon: 21.44 },
  { eb: 91, id: 91, location: 'Центар', address: 'Никола Вапцаров', price: 178000, bedrooms: 3, sqm: 71, size: '71 м²', service: 'buy', lat: 41.9962, lon: 21.4252 },
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  async getById(id: number): Promise<Property | undefined> { return this.rows.find(r => r.id === id); }
  get healthy(): boolean { return true; }
}

function makeHandler(id: string) {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const props = new FakeProps(ROWS);
  const handler = new InboundHandler({
    cfg, db, sessions, bank: new BankStore(db),
    classifier: new Classifier(new FailingLlm(), cfg, props),
    responder: new Responder(new FailingLlm(), cfg),
    properties: props,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
    enrichment: new EnrichmentStore(db),
  });
  return { handler, sessions, sent, chatId: id };
}

// ── 1. THE PLACE LOCK BOUNDS EVERY BATCH ────────────────────────────────────

test('[21:56] «uste nesto ima?» never serves a flat from another district', async () => {
  const { handler, sessions, sent, chatId } = makeHandler('lock-batch');
  await handler.handle('test', chatId, 'sakam da kupam stan kaj bunjakovec ili beverli hils');
  await handler.handle('test', chatId, 'familijarno nesto so dve spalni');
  await handler.handle('test', chatId, 'do 180000');
  const first = sent[sent.length - 1] ?? '';
  assert.match(first, /по една опција до Буњаковец и до Беверли Хилс/u, `the pair is one card per place: ${first}`);
  await handler.handle('test', chatId, 'uste nesto ima ?');
  const second = sent[sent.length - 1] ?? '';
  assert.doesNotMatch(second, /Евидентен број 85/u,
    `EB 85 stands 1,8 km from Буњаковец and ~2 km from Беверли Хилс — it answers neither place: ${second}`);
  // …and the flat that IS inside a named ring may still be served.
  assert.match(second, /Евидентен број 51/u, `EB 51 is 600 m from Беверли Хилс: ${second}`);
  const s = sessions.get(chatId)!;
  assert.doesNotMatch(JSON.stringify(s.slots.ladderQueue ?? []), /\b85\b/u,
    `the leftover never enters the rotation while the search is place-locked: ${JSON.stringify(s.slots.ladderQueue)}`);
});

// ── 2. AN AREA WORD IS THE NASELBA, NOT A LANDMARK ──────────────────────────

test('[21:58] «moze vo centar» neither binds a bus stop nor re-measures the district from the old place', async () => {
  const { handler, sessions, sent, chatId } = makeHandler('area-ask');
  await handler.handle('test', chatId, 'sakam da kupam stan kaj bunjakovec ili beverli hils');
  await handler.handle('test', chatId, 'familijarno nesto so dve spalni');
  await handler.handle('test', chatId, 'do 180000');
  await handler.handle('test', chatId, 'uste nesto ima ?');
  await handler.handle('test', chatId, 'moze vo centar');
  const answer = sent[sent.length - 1] ?? '';
  assert.doesNotMatch(answer, /Ресторан Имес/u,
    `a bus stop named «… кон Центар» is not the place the client named: ${answer}`);
  assert.doesNotMatch(answer, /во непосредна близина на Буњаковец/u,
    `the district is not the old landmark's ring: ${answer}`);
  const s = sessions.get(chatId)!;
  assert.notEqual(s.slots.poiAnchor, 'Ресторан Имес кон Центар', 'the anchor is not the token match');
  assert.equal(s.slots.poiAnchor, undefined, 'an area ask retires the landmark anchor');
  // The area is the geography now: the serve is a Центар row (or the honest
  // «нема во Центар» line) — never a card measured from a place he left.
  assert.match(answer, /Центар/u, `the answer is about the district he named: ${answer}`);
});

test('[21:58] the phrase reaching the map carries no sentence grammar', () => {
  // The whole clause used to reach findPoiByName, whose token match accepted
  // «Ресторан Имес кон Центар» for «мозе во центар».
  // The MODAL and the PREPOSITION are both grammar — the place word is what
  // remains, and «центар» is the map's own suburb row (the preposition is not
  // part of a name: «во центар» and «центар» are the same place).
  assert.equal(stripPlaceFiller('мозе во центар'), 'центар');
  assert.equal(stripPlaceFiller('може во центар'), 'центар');
  assert.equal(stripPlaceFiller('sakam kaj bunjakovec'), 'bunjakovec');
  assert.equal(stripPlaceFiller('Буњаковец'), 'Буњаковец', 'a bare name is untouched');
  // The trim is a LEADING run only, and it never eats the whole phrase.
  assert.equal(stripPlaceFiller('мост на вардар'), 'мост на вардар');
  assert.equal(stripPlaceFiller('во'), 'во');
});
