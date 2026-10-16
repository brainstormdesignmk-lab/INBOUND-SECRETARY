// The [13:27] transcript, end to end:
//   [13:27] SAKAM DA KUPAM STAN TROSOBEN
//   [13:28] GLEDAV EDEN STAN KAJ VAS
//   [13:28] PISUVASE DO BROZ KAFE
//
// The client saw one of OUR properties on the site and remembers only that it
// was near Broz Kafe — not the Евидентен број. Lina must (1) recognize the
// specific-property probe and ask for the number FIRST, (2) read Broz Kafe off
// the MAP, assume the area the bank's own rows put it in (Центар) and answer
// with the listings that match the criteria he described (троsoben, купување),
// nearest to the bar first, and (3) when nothing matches there, offer the
// closest alternatives with the SAME characteristics instead of dead-ending.
import { test } from 'node:test';
import assert from 'node:assert';
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
import { displayPlaceName } from '../src/llm/prompts';
import { LlmClient } from '../src/llm/types';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore, writeMap } from '../src/geo/offlineMap';
import path from 'path';
import os from 'os';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

// Broz Cafe (42.0002, 21.4171) as the map holds it — Latin name, "Cafe" spelled
// with a c, while the client types "BROZ KAFE".
function buildRealMap(): OfflineMapStore {
  const dbPath = path.join(os.tmpdir(), `locate-landmark-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  writeMap(dbPath, [
    { name: 'Broz Cafe', type: 'cafe', lat: 42.0002123, lon: 21.4170894, source: 'osm' },
    { name: 'Автокоманда', type: 'suburb', lat: 41.9985, lon: 21.4640, source: 'osm' },
    // The real map holds BOTH the suburb and a Google POI whose name merely
    // contains it — the post office the [10:28] phantom came from.
    { name: 'Ново Лисиче', type: 'suburb', lat: 41.9843691, lon: 21.4768374, source: 'osm' },
    { name: 'ELS Novo Lisice', type: 'Post office', lat: 41.9829438, lon: 21.4768218, source: 'google' },
  ], []);
  return new OfflineMapStore(dbPath);
}

// Real geography of the feed around the bar: EB 95 (Центар, 3-собен) ~130 m
// from Broz Cafe, EB 84 (Центар, 3-собен) ~640 m, EB 77 (Центар, 2-собен) —
// the WRONG room count — and EB 88 (Аеродром, 3-собен) ~4.4 km away.
const ROWS: Property[] = [
  { eb: 95, id: 95, location: 'Центар', price: 204000, service: 'buy', bedrooms: 3, sqm: 74, size: '74 м²', address: 'Дебар маало', lat: 42.0006, lon: 21.4157, geo_source: 'stored' } as Property,
  { eb: 84, id: 84, location: 'Центар', price: 117000, service: 'buy', bedrooms: 3, sqm: 48, size: '48 м²', address: 'Партизанска', lat: 41.9955, lon: 21.4157, geo_source: 'stored' } as Property,
  { eb: 77, id: 77, location: 'Центар', price: 130000, service: 'buy', bedrooms: 2, sqm: 45, size: '45 м²', address: 'Македонија', lat: 41.9990, lon: 21.4138, geo_source: 'stored' } as Property,
  { eb: 88, id: 88, location: 'Аеродром', price: 133000, service: 'buy', bedrooms: 3, sqm: 68, size: '68 м²', address: 'Јане Сандански', lat: 41.9884, lon: 21.4633, geo_source: 'stored' } as Property,
];

async function makeHandler(rows: Property[] = ROWS) {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(rows);
  const llm = new FailingLlm();
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const offlineMap = buildRealMap();
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(llm, cfg, properties),
    responder: new Responder(llm, cfg),
    properties,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false, google: false, offlineMap }),
    enrichment: new EnrichmentStore(db),
  });
  const chatId = 'broz';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };
  return { send, sent, sessions, chatId, offlineMap };
}

test('[13:27] seen property on our site: the Евидентен број is asked FIRST', async () => {
  const { send, sent, offlineMap } = await makeHandler();
  await send('SAKAM DA KUPAM STAN TROSOBEN'); // discovery: the neighborhood ask
  let s = await send('GLEDAV EDEN STAN KAJ VAS');

  assert.equal(s.state, 'property_locate', `the seen-property probe must locate: ${s.state}`);
  assert.ok(sent[sent.length - 1].includes('Евидентен број'),
    `the number must be asked first: ${sent[sent.length - 1]}`);
  assert.ok(!/иден стан/.test(sent[sent.length - 1]),
    `never the discovery question again: ${sent[sent.length - 1]}`);
  // The criteria he stated up front survive the funnel switch.
  assert.equal(s.slots.service, 'buy');
  assert.equal(s.slots.bedrooms, 3);
  offlineMap.close();
});

test('[13:28] "PISUVASE DO BROZ KAFE": the landmark is read off the map and the matches are served', async () => {
  const { send, sent, sessions, chatId, offlineMap } = await makeHandler();
  await send('SAKAM DA KUPAM STAN TROSOBEN');
  await send('GLEDAV EDEN STAN KAJ VAS');
  const s = await send('PISUVASE DO BROZ KAFE');
  const reply = sent[sent.length - 1];

  // The place + the area the bank's rows put it in. The map holds a LATIN name
  // ("Broz Cafe") and the client is written to in Cyrillic — the [10:29]
  // capture: a Macedonian client read "во близина на ELS Novo Lisice". The
  // slot keeps the map's own spelling (asserted below); the REPLY transliterates.
  assert.ok(reply.includes('Броз Кафе'), `the landmark is served in Cyrillic: ${reply}`);
  assert.ok(!reply.includes('Broz Cafe'), `never the raw Google/OSM Latin name: ${reply}`);
  assert.ok(reply.includes('Центар'), `Broz Kafe is in Центар: ${reply}`);
  // The listings: the 3-room flats of that area, nearest to the bar first.
  assert.ok(reply.includes('Евидентен број 95'), `EB 95 sits ~130 m from the bar: ${reply}`);
  assert.ok(reply.includes('Евидентен број 84'), `EB 84 is the next closest 3-room: ${reply}`);
  // He described a ТРОСОБЕН КУПУВАЊЕ flat — the 2-room and the 4.4 km away one
  // are not what he saw.
  assert.ok(!reply.includes('Евидентен број 77'), `a 2-room must not ride a троsoben search: ${reply}`);
  assert.ok(!reply.includes('Евидентен број 88'), `Аеродром is not "близина на Broz Kafe": ${reply}`);
  // He remembers the place, not the price — the number ask is the pick, the
  // price stays the open question.
  assert.ok(reply.includes('по која цена'), `the missing price must stay asked: ${reply}`);

  const after = sessions.get(chatId)!;
  assert.equal(after.state, 'property_locate');
  assert.equal(after.slots.location, 'Центар', 'the landmark ASSUMES the area');
  // The SLOT keeps the map's own spelling — display is a rendering decision,
  // never a data change (lookups and matching still use this exact name).
  assert.equal(after.slots.poiAnchor, 'Broz Cafe');
  offlineMap.close();
});

test('[13:28] the landmark with the price in the same breath still ranks from the place', async () => {
  const { send, sent, offlineMap } = await makeHandler();
  await send('SAKAM DA KUPAM STAN TROSOBEN');
  await send('GLEDAV EDEN STAN KAJ VAS');
  await send('PISUVASE DO BROZ KAFE. BESE OKOLU 200 000 EVRA');
  const reply = sent[sent.length - 1];

  assert.ok(reply.includes('Броз Кафе'), `the place must survive the criteria in the same message: ${reply}`);
  assert.ok(reply.includes('Евидентен број 95'), `204.000 € is the closest to the remembered 200.000: ${reply}`);
  assert.ok(!reply.includes('Евидентен број 88'), `the criterion filter stands: ${reply}`);
  offlineMap.close();
});

test('[13:28] nothing matches at the landmark: the SAME characteristics are offered as alternatives', async () => {
  // The Автокоманда area holds nothing троsoben-купување; the only 3-room flat
  // in the bank is in Центар, 4 km away. The honest answer names the place —
  // ONCE, the area must not repeat it — and serves the closest alternatives
  // with the criteria the client himself described.
  const FAR_ROWS: Property[] = [
    { eb: 96, id: 96, location: 'Автокоманда', price: 60000, service: 'buy', bedrooms: 2, sqm: 50, size: '50 м²', address: 'Сердарот', lat: 41.9986, lon: 21.4638, geo_source: 'stored' } as Property,
    { eb: 95, id: 95, location: 'Центар', price: 204000, service: 'buy', bedrooms: 3, sqm: 74, size: '74 м²', address: 'Дебар маало', lat: 42.0006, lon: 21.4157, geo_source: 'stored' } as Property,
  ];
  const { send, sent, offlineMap } = await makeHandler(FAR_ROWS);
  await send('SAKAM DA KUPAM STAN TROSOBEN');
  await send('GLEDAV EDEN STAN KAJ VAS');
  await send('PISUVASE DO AVTOKOMANDA');
  const reply = sent[sent.length - 1];

  assert.ok(reply.includes('Автокоманда'), `the place stays named: ${reply}`);
  assert.ok(!/\(Автокоманда\)/.test(reply), `the area must not repeat the place name: ${reply}`);
  assert.ok(/алтернатив/i.test(reply), `the alternatives line is the honest pivot: ${reply}`);
  assert.ok(reply.includes('Евидентен број 95'), `the only 3-room flat is the honest alternative: ${reply}`);
  assert.ok(!reply.includes('Евидентен број 96'), `a 2-room is never served on a троsoben search: ${reply}`);
  offlineMap.close();
});

test('[10:28] an area the client named is never served back as a BUSINESS he never mentioned', async () => {
  // The map holds the suburb "Ново Лисиче" AND the Google POI "ELS Novo Lisice"
  // (a post office whose name contains the neighborhood), and findPlace is a
  // FUZZY lookup: "kaj vas vo novo lisice" came back as the post office, which
  // the next turn then served as "баравте стан во близина на ELS Novo Lisice".
  // The client named an AREA — the funnel must search it, and never put a
  // business in his mouth.
  const AREA_ROWS: Property[] = [
    { eb: 101, id: 101, location: 'Ново Лисиче', price: 120000, service: 'buy', bedrooms: 3, sqm: 70, size: '70 м²', address: 'Јане Сандански', lat: 41.9844, lon: 21.4768, geo_source: 'stored' } as Property,
    { eb: 102, id: 102, location: 'Ново Лисиче', price: 99000, service: 'buy', bedrooms: 3, sqm: 62, size: '62 м²', address: 'Јане Сандански', lat: 41.9830, lon: 21.4750, geo_source: 'stored' } as Property,
  ];
  const { send, sent, sessions, chatId, offlineMap } = await makeHandler(AREA_ROWS);
  await send('SAKAM DA KUPAM STAN TROSOBEN');
  await send('gledav eden stan kaj vas vo novo lisice');

  const after = sessions.get(chatId)!;
  assert.equal(after.slots.location, 'Ново Лисиче', `the area is exactly what he named: ${after.slots.location}`);
  // The anchor may be the AREA ITSELF (the map holds it as a place, and the
  // landmark lane ranks from it — the [13:28] Автокоманда contract), but never
  // a business the client did not name.
  const anchor = after.slots.poiAnchor;
  assert.ok(!anchor || /Ново Лисиче/u.test(anchor), `no business may be invented from an area, got: ${anchor}`);
  const recap = sent[sent.length - 1];
  assert.ok(!/ELS|ЕЛС/u.test(recap), `the post office must not appear: ${recap}`);

  // …and the search answers from the AREA rows, still without the post office.
  await send('sakam da kupam stan vo novo lisice');
  const reply = sent[sent.length - 1];
  assert.ok(reply.includes('Евидентен број 101') && reply.includes('Евидентен број 102'), reply);
  assert.ok(!/ELS|ЕЛС/u.test(reply), `no phantom landmark in the search answer: ${reply}`);
  offlineMap.close();
});

test('[10:29] the client reads place names in Cyrillic, the map keeps its own spelling', () => {
  // The map holds what OSM and Google hold — ~38% of it Latin-only — and the
  // landmark copy used to print those names VERBATIM ("ELS Novo Lisice"). The
  // operator writes to clients in Cyrillic, so the DISPLAY transliterates; the
  // slots above still carry "Broz Cafe", and nothing here touches the map.
  assert.equal(displayPlaceName('Broz Cafe'), 'Броз Кафе');
  assert.equal(displayPlaceName('ELS Novo Lisice'), 'ЕЛС Ново Лисиче');
  assert.equal(displayPlaceName('City Mall'), 'Сити Мол');
  assert.equal(displayPlaceName('Tinex'), 'Тинекс');
  assert.equal(displayPlaceName('Hotel Kapistec'), 'Хотел Капиштец');
  assert.equal(displayPlaceName('Embassy of Montenegro'), 'Амбасада Монтенегро');
  // Already Cyrillic (or mixed) → shown exactly as the map holds it.
  assert.equal(displayPlaceName('Кафе бар Ван Гог'), 'Кафе бар Ван Гог');
  assert.equal(displayPlaceName('Трговски Лисиче'), 'Трговски Лисиче');
  // English PROSE is left alone: folding it letter-by-letter produced
  // pseudo-Cyrillic ("Министрј Фореигн Аффаирс"), which is worse than the
  // Latin the map holds — the bot never invents what it cannot stand behind.
  const prose = 'Boris Sarafov Palace - Ministry of Foreign Affairs and foreign trade of the Republic of North Macedonia';
  assert.equal(displayPlaceName(prose), prose);
});

test('[13:28] he DOES know the number: the normal property_query workflow runs', async () => {
  const { send, sent, sessions, chatId, offlineMap } = await makeHandler();
  await send('SAKAM DA KUPAM STAN TROSOBEN');
  await send('GLEDAV EDEN STAN KAJ VAS');
  const s = await send('DA, GO ZNAM BROJOT 95');

  assert.equal(s.state, 'property_query', `the number is the easy path: ${s.state}`);
  assert.equal(s.slots.propertyId, 95);
  const reply = sent[sent.length - 1];
  assert.ok(reply.includes('204.000'), `the card quotes ITS price in евра: ${reply}`);
  assert.ok(!reply.includes('Дали го знаете Евидентен број'), `never the ask once the number is given: ${reply}`);
  assert.equal(sessions.get(chatId)!.slots.bedrooms, 3);
  offlineMap.close();
});

test('[13:28] he does NOT know the number: price and neighborhood are asked', async () => {
  const { send, sent, offlineMap } = await makeHandler();
  await send('SAKAM DA KUPAM STAN TROSOBEN');
  await send('GLEDAV EDEN STAN KAJ VAS');
  const s = await send('NE GO ZNAM BROJOT');
  const reply = sent[sent.length - 1];

  assert.equal(s.state, 'property_locate');
  assert.ok(reply.includes('населба'), `the neighborhood is asked: ${reply}`);
  assert.ok(reply.includes('цена'), `the price is asked: ${reply}`);
  offlineMap.close();
});
