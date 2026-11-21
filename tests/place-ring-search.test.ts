/**
 * THE [06:31] FIELD CAPTURE — a micro-area inside a district.
 *
 *   [06:31] baram trosoben stan do 180000 ili dvocoben do 150000 kaj
 *           bunjakovec debar maalo
 *   [06:31] kupuvanje
 *   ЛИНА: «За жал, моментално во Дебар Маало немам достапна понуда…»
 *   [06:32] kako nemate , proveri uste ednas
 *   ЛИНА: «Моментално во системот нема трособни до 180.000 евра во Дебар
 *           Маало…»            ← the same line, four times
 *
 * THE FLATS WERE THERE. On the live feed, within 1 km of the map's own
 * «Дебар Маало» pin sit EB 84 (3 rooms, 117.000) and EB 66 (3 rooms, 137.000)
 * — both inside the client's budget — and neither ad prints the words «Дебар
 * Маало»: the search filter was a STRING test (feed naselba + the ad's own
 * words), so the two rows that DO print it (EB 74 at 190.000 and EB 95 at
 * 204.000) were the only matches, and both are over budget. «Немам ништо» was
 * therefore true of the matcher and false of the world.
 *
 * The fix is geometric, not lexical: the area slot's name is resolved on the
 * map, and the rows inside the honest 1 km ring are IN the area — the name
 * filter still holds (a district keeps every row it files), the ring only
 * closes what the words miss.
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

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

/**
 * The live feed's own rows around the two pins (map: Буњаковец
 * 41.99746,21.41864; Дебар Маало 42.00157,21.42006):
 *   84 — Центар, 3 rooms, 117.000, Роза Луксембург (≈ 300 m; ad never says
 *        «Дебар Маало» — the row the string filter could not see);
 *   66 — Центар, 3 rooms, 137.000, Рузвелтова (≈ 500 m, same blindness);
 *   74 — Центар, 3 rooms, 190.000, ad SAYS «Дебар Маало» — over budget;
 *   95 — Центар, 3 rooms, 204.000, ad says «Дебар маало» — over budget;
 *   77 — Центар, 2 rooms, 130.000, Мирче Оровчанец (the 2-room branch);
 *   89 — Аеродром, 2 rooms, 110.000 (far: must never ride the Дебар Маало ask).
 */
const ROWS: Property[] = [
  { eb: 84, id: 84, location: 'Центар', address: 'Роза Луксембург', price: 117000, bedrooms: 3, sqm: 48, size: '48 м²', service: 'buy', lat: 41.9953, lon: 21.4167 },
  { eb: 66, id: 66, location: 'Центар (населба)', address: 'Рузвелтова 51', price: 137000, bedrooms: 3, sqm: 79, size: '79 м²', service: 'buy', lat: 42.0018, lon: 21.4148 },
  { eb: 74, id: 74, location: 'Центар', address: 'Ѓорѓи Пулевски 27', details: 'Стан во Епицентарот на Скопје. Дебар Маало во близина на Влае', price: 190000, bedrooms: 3, sqm: 72, size: '72 м²', service: 'buy', lat: 42.0022, lon: 21.4162 },
  { eb: 95, id: 95, location: 'Центар', address: 'Црвена Вода', details: 'Се продава нов стан во Дебар маало близу до Броз кафе', price: 204000, bedrooms: 3, sqm: 74, size: '74 м²', service: 'buy', lat: 42.0006, lon: 21.4157 },
  { eb: 77, id: 77, location: 'Центар', address: 'Мирче Оровчанец 86', price: 130000, bedrooms: 2, sqm: 45, size: '45 м²', service: 'buy', lat: 41.9991, lon: 21.4135 },
  { eb: 89, id: 89, location: 'Аеродром', address: 'Парк Авионче', price: 110000, bedrooms: 2, sqm: 70, size: '70 м²', service: 'buy', lat: 41.9879, lon: 21.4765 },
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

test('[06:31] a micro-area search finds the flats inside the ring, not only the ads that print it', async () => {
  const { handler, sent, chatId } = makeHandler('ring-debar');
  await handler.handle('test', chatId,
    'baram trosoben stan do 180000 ili dvocoben do 150000 kaj bunjakovec debar maalo');
  await handler.handle('test', chatId, 'kupuvanje');
  const answer = sent[sent.length - 1] ?? '';
  assert.match(answer, /Евидентен број (84|66)|Евидентни броеви [^\n]*(84|66)/u,
    `the two in-budget flats inside the Дебар Маало ring are the answer: ${answer}`);
  assert.doesNotMatch(answer, /немам[^\n]*Дебар Маало/iu,
    `the empty-stock line is false once the ring is measured: ${answer}`);
  assert.doesNotMatch(answer, /Евидентен број (74|95)/u,
    `the over-budget rows must not be served: ${answer}`);
});

test('[06:33] a place follow-up after a serve says «druga opcija», not «nemam»', async () => {
  // The client named the place again after two flats near it were shown. The
  // pool is empty only because those flats are in `presentedIds` — so the
  // truthful turn is the DRAINED one («немаме друга опција / веќе прикажано»),
  // never a denial of stock («немам достапна понуда околу Буњаковец»), which is
  // what the field capture repeated until the client stopped believing her.
  const { handler, sent, chatId } = makeHandler('ring-recheck');
  await handler.handle('test', chatId,
    'baram trosoben stan do 180000 ili dvocoben do 150000 kaj bunjakovec debar maalo');
  await handler.handle('test', chatId, 'kupuvanje');
  const first = sent[sent.length - 1] ?? '';
  assert.match(first, /(84|66)/u, `the first serve is the in-ring pair: ${first}`);
  await handler.handle('test', chatId, 'a kaj bunjakovec ?');
  const second = sent[sent.length - 1] ?? '';
  assert.doesNotMatch(second, /немам[^.!?]*(?:достапна )?понуда/iu,
    `stock he is looking at must not be denied: ${second}`);
  // The drained family rotates („веќе прикажано“, „веќе ги погледнавме“,
  // „немаме друга опција“): the contract is that the turn offers a way
  // forward and never denies that stock exists near the place.
  assert.match(second, /друг/u, `the turn names the way out: ${second}`);
  await handler.handle('test', chatId, 'vo blizina na bunjakovec');
  const third = sent[sent.length - 1] ?? '';
  assert.doesNotMatch(third, /немам[^.!?]*(?:достапна )?понуда/iu,
    `no stock denial on the repeat either: ${third}`);
});
