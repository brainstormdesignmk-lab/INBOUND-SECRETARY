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
import { displayAreaName, displayPlaceName } from '../src/llm/prompts';
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
    // The Montenegrin embassy, as the real map holds it (the feed's own
    // address field for EB 63 is literally "Црногорска Амбасада").
    { name: 'Црногорска Амбасада', type: 'embassy', lat: 41.9959869, lon: 21.418169, source: 'osm' },
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
  // The feed's own disambiguator is internal — the phone never says it.
  assert.equal(displayAreaName('Центар (населба)'), 'Центар');
  assert.equal(displayAreaName('Аеродром (општина)'), 'Аеродром');
  assert.equal(displayAreaName('Центар'), 'Центар');
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

test('[11:29] "IMAVTE EDNA GARSONJERA KAJ CRNOGORSKA AMBASADA": the unit type is a specific property too', async () => {
  // The [11:28]/[11:29] capture, deterministic path (no LLM):
  //   [11:28] sakam da kupam stance
  //   [11:28] nesto polmalo
  //   [11:28] ЛИНА: Во кој дел од градот…?
  //   [11:29] imavte edna garsonjera kaj crnogorska ambasada
  //   [11:29] ЛИНА: Во која градска населба…?          ← the bug: same ask, third time
  //   [11:29] dali e uste na prodazba ?
  // "гарсоњера" was not in the seen-property object list and the HAD-verb had
  // no slot, so the client's OWN recall (with the place in it!) was read as a
  // fresh search with no location. He answers the funnel's question with a
  // PLACE — the funnel must take it, ask for the Евидентен број, and then
  // answer the availability question from the rows nearest that place.
  const EMBASSY_ROWS: Property[] = [
    { eb: 63, id: 63, location: 'Центар (населба)', price: 36000, service: 'buy', sqm: 28, size: '28 м²', address: 'Црногорска Амбасада', lat: 41.995985, lon: 21.418172, geo_source: 'stored' } as Property,
    { eb: 76, id: 76, location: 'Центар', price: 45000, service: 'buy', sqm: 24, size: '24 м²', address: 'Васил Стефановски 16', lat: 41.9958, lon: 21.4176, geo_source: 'stored' } as Property,
    { eb: 84, id: 84, location: 'Центар', price: 117000, service: 'buy', bedrooms: 3, sqm: 48, size: '48 м²', address: 'Роза Луксембург', lat: 41.9941, lon: 21.4182, geo_source: 'stored' } as Property,
  ];
  const { send, sent, sessions, chatId, offlineMap } = await makeHandler(EMBASSY_ROWS);
  await send('sakam da kupam stance');
  await send('nesto polmalo');
  const s = await send('imavte edna garsonjera kaj crnogorska ambasada');
  const reply = sent[sent.length - 1];

  assert.equal(s.state, 'property_locate', `the recall must locate, not search again: ${s.state}`);
  // The question he already answered is never asked a third time.
  assert.ok(!/градска населба|иден стан/.test(reply), `never the discovery question again: ${reply}`);
  assert.ok(reply.includes('Евидентен број'), `the number is asked first: ${reply}`);
  // The area comes back the way a human says it: the feed's settlement tag
  // ("Центар (населба)") is internal and never spoken ("Разбрав — Центар (населба)"
  // was what the client actually read).
  assert.ok(reply.includes('Разбрав — Центар.'), `the area is spoken, not tagged: ${reply}`);
  assert.ok(!reply.includes('(населба)'), `no internal feed tag in the reply: ${reply}`);
  // The landmark he named IS the place — read off the map, not invented.
  assert.equal(s.slots.poiAnchor, 'Црногорска Амбасада');
  // The area comes from the bank's own rows near the place (EB 76 is tagged
  // "Центар", EB 63 "Центар (населба)") — the funnel takes the neighborhood they
  // agree on, never a guess of its own.
  assert.match(String(s.slots.location), /^Центар/u, `the landmark assumes the area the bank puts it in: ${s.slots.location}`);

  // …and the availability question that followed is answered from the rows
  // nearest that place: the гарсоњера in the embassy's own building comes
  // first, the 3-room flat 200 m away never pretends to be what he saw.
  const s2 = await send('dali e uste na prodazba ?');
  const avail = sent[sent.length - 1];
  assert.ok(avail.includes('Црногорска Амбасада'), `the place is confirmed back: ${avail}`);
  assert.ok(!/\(населба\)/.test(avail), `never nested tag parentheses in the sentence: ${avail}`);
  assert.ok(avail.includes('Евидентен број 63'), `EB 63 is 3 m from the embassy and IS the гарсоњера: ${avail}`);
  assert.ok(!/Евидентен број 84/.test(avail.split('Евидентен број 63')[1] ?? ''), `the nearest first: ${avail}`);
  assert.equal(s2.state, 'property_locate', 'still locating until he names one');
  void sessions; void chatId;
  offlineMap.close();
});

test('[11:29] the same HAD-verb without the determiner stays a SEARCH ask', async () => {
  // "imavte garsonjera kaj crnogorska ambasada" does not name ONE unit — it
  // asks whether we have any, which is a search about a place. The anchor is
  // taken (the search ranks from it), but the locate funnel must not fire and
  // the number must not be asked.
  const EMBASSY_ROWS: Property[] = [
    { eb: 63, id: 63, location: 'Центар', price: 36000, service: 'buy', sqm: 28, size: '28 м²', address: 'Црногорска Амбасада', lat: 41.995985, lon: 21.418172, geo_source: 'stored' } as Property,
  ];
  const { send, sent, offlineMap } = await makeHandler(EMBASSY_ROWS);
  await send('sakam da kupam stance');
  const s = await send('imavte garsonjera kaj crnogorska ambasada');

  assert.notEqual(s.state, 'property_locate', `a plain question is not a recall: ${s.state}`);
  const reply = sent[sent.length - 1];
  assert.ok(!reply.includes('Евидентен број'), `never the number ask here: ${reply}`);
  offlineMap.close();
});

test('[11:29] a COLD «имавте гарсоњера кај Црногорска амбасада?» is answered from the FEED, never with the number question', async () => {
  // Fresh chat, no service declared yet. The guided search answered this with
  // «Дали го знаете Евидентен број?» — a number the client does not have, about
  // a flat he just described. One гapсоњера at the place → the availability
  // answer about THAT flat, named once (EB · type · м² · price · area).
  const EMBASSY_ROWS: Property[] = [
    { eb: 63, id: 63, location: 'Центар', price: 36000, service: 'buy', sqm: 28, size: '28 м²', studio: true, address: 'Црногорска Амбасада', lat: 41.995985, lon: 21.418172, geo_source: 'stored', landmarks: [{ landmark: 'Црногорска Амбасада' }] } as Property,
  ];
  const { send, sent, offlineMap } = await makeHandler(EMBASSY_ROWS);
  const s = await send('imavte edna garsonjera kaj crnogorska ambasada');
  const reply = sent[sent.length - 1];
  assert.ok(!/го знаете Евидентен|Кажете ми Евидентен/.test(reply), `never the number question: ${reply}`);
  assert.ok(reply.includes('Евидентен број 63'), `the flat at that place is named: ${reply}`);
  assert.ok(/достапн|активн|слободн|база|евиденц/iu.test(reply), `and its availability is answered: ${reply}`);
  assert.equal(s.state, 'closing', `the owner lane opens: ${s.state}`);
  assert.equal(s.slots.interestedPropertyId, 63);
  offlineMap.close();
});

test('[09:59]/[11:29] two гapсоњери at the place → both are DESCRIBED, and the number is still never asked', async () => {
  // Nothing on the table, two candidates near the named place: guessing one is
  // the wrong-property class, so she ASKS — but with the Евидентен број, size
  // and price of each, which is the only thing that lets the client answer.
  const EMBASSY_ROWS: Property[] = [
    { eb: 63, id: 63, location: 'Центар', price: 36000, service: 'buy', sqm: 28, size: '28 м²', studio: true, address: 'Црногорска Амбасада', lat: 41.995985, lon: 21.418172, geo_source: 'stored', landmarks: [{ landmark: 'Црногорска Амбасада' }] } as Property,
    { eb: 76, id: 76, location: 'Центар', price: 41000, service: 'buy', sqm: 24, size: '24 м²', studio: true, address: 'Строг Центар', lat: 41.995800, lon: 21.417600, geo_source: 'stored', landmarks: [{ landmark: 'Црногорска Амбасада' }] } as Property,
  ];
  const { send, sent, offlineMap } = await makeHandler(EMBASSY_ROWS);
  const s = await send('ima li garsonjera kaj crnogorska ambasada?');
  const reply = sent[sent.length - 1];
  // Each option is a DESCRIPTION, not a number in brackets: the client asked
  // about a flat he remembers, so EB + type + м² + price are all named, and the
  // question is one he can answer («is one of these the one you meant?»).
  assert.match(reply, /Евидентен број 63 · гарсоњера, 28 м²/u, `the first is described: ${reply}`);
  assert.match(reply, /Евидентен број 76 · гарсоњера, 24 м²/u, `the second is described: ${reply}`);
  assert.ok(reply.includes('Дали некоја од нив е таа што ја баравте? Ако не, продолжувам да барам'),
    `the question invites the no: ${reply}`);
  assert.ok(!/го знаете Евидентен|Кажете ми Евидентен/.test(reply), `never the number question: ${reply}`);
  assert.equal(s.state, 'property_locate', `still choosing: ${s.state}`);
  // The offered numbers are recorded, so a «не» pulls the NEXT options instead
  // of re-offering the same two.
  assert.deepEqual([...(s.slots.presentedIds ?? [])].sort((a, b) => a - b), [63, 76]);
  offlineMap.close();
});

test('[11:07] a house for rent at Олимпико: the area is the house’s own, and the number is never asked after the disclaim', async () => {
  // The [11:07]/[11:08] capture, deterministic path (no LLM):
  //   [11:07] ЗДРАВО , ИМАТЕ ОБЈАВЕНО ЕДНА КУЌА ЗА ИЗДАВАЊЕ КАЈ ОЛИМПИКО
  //   [11:07] ЛИНА: 1. колку спални соби?  2. до која цена?      ← the grill
  //   [11:08] ЈА ВИДОВ ОВАА КУЌА НА ВАШАТА СТРАНИЦА . АМА БРОЈОТ НЕ ГО ЗАПИШАВ
  //   [11:08] ЛИНА: Разбрав — Карпош III. … Евидентен број?    ← two bugs
  // The area was WRONG: the vote over the 1.5 km ring counted two Карпош III
  // rows, while the row standing AT the place (address "Тц Олимпико", 247 m)
  // is tagged Тафталиџе — so she named a neighborhood the client never said and
  // then served the Тафталиџе card in the same breath. And the number he had
  // just disclaimed was invited again.
  const OLIMPIKO_MAP = () => {
    const dbPath = path.join(os.tmpdir(), `olimpiko-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    writeMap(dbPath, [
      { name: 'Олимпико', type: 'mall', lat: 42.0005215, lon: 21.39187, source: 'google' },
    ], []);
    return new OfflineMapStore(dbPath);
  };
  const ROWS_OLIMPIKO: Property[] = [
    // The house for rent standing at the place itself.
    { eb: 62, id: 62, location: 'Тафталиџе', price: 450, service: 'rent', house: true, sqm: 100, size: '100 м²', address: 'Тц Олимпико', lat: 41.9983, lon: 21.3919, geo_source: 'stored' } as Property,
    // Neighbours inside the 1.5 km ring, tagged Карпош III / Козле — without
    // the address evidence their vote outnumbered the house's own area.
    { eb: 48, id: 48, location: 'Карпош III', price: 600, service: 'rent', sqm: 80, size: '80 м²', address: 'Руските Згради', lat: 42.0037, lon: 21.3934, geo_source: 'stored' } as Property,
    { eb: 54, id: 54, location: 'Карпош III', price: 550, service: 'rent', sqm: 70, size: '70 м²', address: 'Роберт Кох 3', lat: 42.0042, lon: 21.3920, geo_source: 'stored' } as Property,
    { eb: 52, id: 52, location: 'Козле', price: 500, service: 'rent', sqm: 65, size: '65 м²', address: 'Козле', lat: 42.0055, lon: 21.3890, geo_source: 'stored' } as Property,
  ];
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS_OLIMPIKO);
  const llm = new FailingLlm();
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const offlineMap = OLIMPIKO_MAP();
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
  const chatId = 'olimpiko';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  const s = await send('ЗДРАВО , ИМАТЕ ОБЈАВЕНО ЕДНА КУЌА ЗА ИЗДАВАЊЕ КАЈ ОЛИМПИКО');
  const reply = sent[sent.length - 1];
  // ОБЈАВЕНО … ЗА ИЗДАВАЊЕ is a RENT listing — never a buy search.
  assert.equal(s.slots.service, 'rent', `издавање is the rent category: ${s.slots.service}`);
  assert.equal(s.slots.house, true, 'a house was named');
  assert.equal(s.slots.location, 'Тафталиџе', `the area is the house’s own: ${s.slots.location}`);
  assert.ok(!/карпош/i.test(reply), `the neighbours’ Карпош III vote must not be spoken: ${reply}`);
  assert.ok(reply.includes('Тафталиџе'), `the house’s area is connected to the place: ${reply}`);
  // The place IS the search — the one house there is served, not a grill.
  assert.ok(reply.includes('Евидентен број 62'), `the house at Олимпико is served: ${reply}`);
  assert.ok(!/Колку спални соби/.test(reply), `no specs grill on a place the bank can answer: ${reply}`);
  // One card, one question — never a choice between «првиот» and «вториот»
  // when only one property is on screen.
  assert.ok(reply.includes('Дали ова е куќата што ја видовте?'), `a lone card gets the singular question: ${reply}`);
  assert.ok(!/вториот/.test(reply), `no second option to pick: ${reply}`);

  // [11:08] he says he does not have the number: no invite may follow.
  const s2 = await send('ЈА ВИДОВ ОВАА КУЌА НА ВАШАТА СТРАНИЦА . АМА БРОЈОТ НЕ ГО ЗАПИШАВ');
  const reply2 = sent[sent.length - 1];
  assert.ok(!/Евидентен број на недвижноста|го знаете Евидентен број/.test(reply2),
    `the disclaimed number is never invited again: ${reply2}`);
  assert.ok(reply2.includes('Тафталиџе'), `the same area is confirmed back: ${reply2}`);
  assert.equal(s2.slots.location, 'Тафталиџе');
  // …and the intro agrees in number with the single card it introduces.
  assert.ok(reply2.includes('Еве ја најблиската недвижност'), `singular agreement: ${reply2}`);
  assert.ok(!/Еве ги најблиските недвижности/.test(reply2), `never the plural opener over one card: ${reply2}`);

  // The pick closes the locate funnel on the house itself: EB 62 is bound and
  // the RENT fee protocol opens (300 ден = 5 евра, never the buy 500).
  const s3 = await send('ПРВИОТ');
  assert.equal(s3.slots.propertyId, 62, 'the pick binds the house that was served');
  assert.equal(s3.state, 'closing', `the pick opens the closing lane: ${s3.state}`);
  assert.ok(/300 денари/.test(sent[sent.length - 1]), `the rent fee is the one disclosed: ${sent[sent.length - 1]}`);
  // …and availability is answered from the row, not from a guess.
  // The ACK rotates through the bank's availability.ack variants, and they word
  // the same fact in several ways («сè уште е достапна», «се води како активна»,
  // «е сè уште во базата», «е на располагање», «во нашата понуда»). Asserting
  // one family of words made this line a coin flip — a variant that said «во
  // базата» failed a passing turn. The contract is: an availability answer, and
  // never another card batch.
  const s4 = await send('ДАЛИ Е УШТЕ СЛОБОДНА?');
  const ack = sent[sent.length - 1];
  assert.ok(/достапн|активна|слободн|во базата|во нашата база|во понудата|на располагање|во нашата евиденција/i.test(ack),
    `availability is answered: ${ack}`);
  assert.ok(/сопственик/i.test(ack), `the ack offers the owner check: ${ack}`);
  assert.doesNotMatch(ack, /Евидентен број/, `availability is not a fresh batch: ${ack}`);
  assert.equal(s4.slots.propertyId, 62);

  // A money question asked in the same breath as the fee gets BOTH answers:
  // the rent figure of the property on the table first, then the fee protocol.
  // The fee lane owns the turn, so suppressing the figure read as evasion.
  await send('КОЛКУ Е КИРИЈАТА И ШТО ПЛАЌАМ ЗА ПОСЕТА?');
  const moneyReply = sent[sent.length - 1];
  assert.ok(moneyReply.includes('450'), `the rent he asked about is quoted: ${moneyReply}`);
  assert.ok(moneyReply.includes('300 денари'), `the fee is still disclosed: ${moneyReply}`);
  assert.ok(moneyReply.indexOf('450') < moneyReply.indexOf('300'),
    `the figure comes before the fee pitch: ${moneyReply}`);
  offlineMap.close();
});

test('[20:56] "КАЈ ОЛИМПИКО ОКОЛУ 400 ЕВРА БЕШЕ": a LIVE listing is never called archived', async () => {
  // The [20:56] capture:
  //   [20:56] CLEDAV EDNA KUKJAA KAJ VAS NA SAJT ZA RENTANJE
  //   [20:56] KAJ OLIMPIKO OKOLU 400 EVRA BESE
  //   [20:56] ЛИНА: Таа куќа беше стара понуда од нашата архива и веќе не е активна…
  // EB 62 was live the whole time (house, rent, 450 €, 247 m from ТЦ Олимпико).
  // Two defects fed that lie: «ZA RENTANJE» was not read as rent (so the funnel
  // re-asked buy-or-rent), and the MARKET_MEMORY lane declared the recall
  // archived WITHOUT looking at the bank.
  const dbPath = path.join(os.tmpdir(), `recall-2056-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  writeMap(dbPath, [
    { name: 'Олимпико', type: 'mall', lat: 42.0005215, lon: 21.39187, source: 'google' },
    // A place with no property anywhere near it — the honest archive case.
    { name: 'Курирска Станица Исток', type: 'post', lat: 42.0800, lon: 21.5200, source: 'google' },
  ], []);
  const offlineMap = new OfflineMapStore(dbPath);
  const ROWS_RECALL: Property[] = [
    { eb: 62, id: 62, location: 'Тафталиџе', price: 450, service: 'rent', house: true, sqm: 100, size: '100 м²', address: 'Тц Олимпико', lat: 41.9983, lon: 21.3919, geo_source: 'stored' } as Property,
    { eb: 50, id: 50, location: 'Центар', price: 250, service: 'rent', house: true, sqm: 74, size: '74 м²', address: 'Христо Смирненски 41', lat: 41.9950, lon: 21.4180, geo_source: 'stored' } as Property,
  ];
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS_RECALL);
  const llm = new FailingLlm();
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
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
  const say = async (chat: string, m: string) => {
    await handler.handle('test', chat, m);
    return { reply: sent[sent.length - 1], session: sessions.get(chat)! };
  };

  // «ZA RENTANJE» is a RENT word — the funnel must not ask buy-or-rent again.
  const t1 = await say('c2056a', 'CLEDAV EDNA KUKJAA KAJ VAS NA SAJT ZA RENTANJE');
  assert.equal(t1.session.slots.service, 'rent', 'rentanje names the rent segment');
  assert.ok(!/купување или|изнајмување\?/.test(t1.reply), `never the buy-or-rent re-ask: ${t1.reply}`);

  // Place + remembered price: the live house is served.
  const t2 = await say('c2056a', 'KAJ OLIMPIKO OKOLU 400 EVRA BESE');
  assert.ok(t2.reply.includes('Евидентен број 62'), `the live house is served: ${t2.reply}`);
  assert.ok(!/архива|не е активна/.test(t2.reply), `never called archived: ${t2.reply}`);

  // The recall SHAPE that reached the archive lane: the bank is consulted first.
  const t3 = await say('c2056b', 'IMASE EDNA KUKJA KAJ VAS KAJ OLIMPIKO OKOLU 400 EVRA KIRIJA');
  assert.ok(!/архива|не е активна/.test(t3.reply), `a live listing is never an archive: ${t3.reply}`);
  assert.ok(t3.reply.includes('Евидентен број 62'), `the live listing answers the recall: ${t3.reply}`);
  assert.ok(t3.reply.includes('Олимпико'), `the place is confirmed back: ${t3.reply}`);

  // …and a recall with NOTHING near the place keeps the honest admission.
  const t4 = await say('c2056c', 'IMASE EDNA KUKJA KAJ VAS KAJ KURIRSKA STANICA ISTOK OKOLU 400 EVRA KIRIJA');
  assert.ok(/архива/.test(t4.reply), `a genuinely old offer is still admitted: ${t4.reply}`);
  offlineMap.close();
});

test('[21:27] after serving a house, "КОГА МОЖЕ ДА СЕ ВИДИ?" opens the owner check, never a search', async () => {
  // The [21:27]/[21:28] capture:
  //   [21:27] DALI E SLOBODNA I DALI JA IMATE USTE?      → the house is served
  //   [21:28] MISLAM DEKA BESE TAA
  //   [21:28] KOGA MOZE DA SE VIDI ?
  //   [21:28] ЛИНА: Во моментов немам куќа во Тафталиџе … но имам куќа во Центар
  // The property she had just confirmed was declared absent one message later,
  // because the viewing question was routed as a fresh SEARCH: the presentation
  // re-ran without the card it had already shown and spilled to another area.
  // A timing question about a shown card belongs to the owner-check protocol.
  const dbPath = path.join(os.tmpdir(), `visit-2127-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  writeMap(dbPath, [
    { name: 'Олимпико', type: 'mall', lat: 42.0005215, lon: 21.39187, source: 'google' },
  ], []);
  const offlineMap = new OfflineMapStore(dbPath);
  const ROWS_VISIT: Property[] = [
    { eb: 62, id: 62, location: 'Тафталиџе', price: 450, service: 'rent', house: true, sqm: 100, size: '100 м²', address: 'Тц Олимпико', lat: 41.9983, lon: 21.3919, geo_source: 'stored' } as Property,
    { eb: 50, id: 50, location: 'Центар', price: 250, service: 'rent', house: true, sqm: 74, size: '74 м²', address: 'Христо Смирненски 41', lat: 41.9950, lon: 21.4180, geo_source: 'stored' } as Property,
  ];
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS_VISIT);
  const llm = new FailingLlm();
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
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
  const say = async (m: string) => {
    await handler.handle('test', 'c2127', m);
    return { reply: sent[sent.length - 1], session: sessions.get('c2127')! };
  };

  await say('CLEDAV EDNA KUKJAA KAJ VAS NA SAJT ZA RENTANJE');
  await say('KAJ OLIMPIKO OKOLU 400 EVRA BESE');
  const a = await say('DALI E SLOBODNA I DALI JA IMATE USTE?');
  assert.ok(!/немам/.test(a.reply), `the availability answer never denies the house: ${a.reply}`);
  assert.ok(/сопственик/.test(a.reply), `the owner check is offered: ${a.reply}`);

  const b = await say('MISLAM DEKA BESE TAA');
  assert.ok(b.reply.includes('62'), `the shown house is confirmed: ${b.reply}`);
  assert.ok(!/Евидентен број 50/.test(b.reply), `never a different house: ${b.reply}`);

  const c = await say('KOGA MOZE DA SE VIDI ?');
  assert.ok(!/Во моментов немам/.test(c.reply), `never an absence claim after serving it: ${c.reply}`);
  assert.ok(/сопственик/.test(c.reply), `the owner check protocol answers the timing question: ${c.reply}`);
  assert.ok(!/Евидентен број 50/.test(c.reply), `no second house on a viewing question: ${c.reply}`);
  assert.equal(c.session.slots.interestedPropertyId, 62, 'the viewing question binds the shown house');
  offlineMap.close();
});

test('the area rule is DATA, not a fixture: any imported row whose address names the place wins', async () => {
  // The Олимпико repair must hold for properties imported TOMORROW, not just
  // the rows that exist today: nothing in it may know an EB, a place name or a
  // neighborhood. This pins the rule itself — a made-up place, a made-up EB,
  // three neighbours voting for another area, and one row whose ADDRESS names
  // the place. The address-bearing row's area must win.
  const dbPath = path.join(os.tmpdir(), `new-import-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  writeMap(dbPath, [
    { name: 'Магацин Пелагонија', type: 'shop', lat: 42.0100, lon: 21.4200, source: 'google' },
  ], []);
  const offlineMap = new OfflineMapStore(dbPath);
  const NEW_ROWS: Property[] = [
    // The freshly imported listing — its address names the place.
    { eb: 9001, id: 9001, location: 'Влае', price: 700, service: 'rent', house: true, sqm: 120, size: '120 м²', address: 'Магацин Пелагонија', lat: 42.0091, lon: 21.4200, geo_source: 'stored' } as Property,
    // Three older rows around it, all tagged another area.
    { eb: 9002, id: 9002, location: 'Карпош', price: 400, service: 'rent', sqm: 60, size: '60 м²', address: 'Ул. А', lat: 42.0085, lon: 21.4205, geo_source: 'stored' } as Property,
    { eb: 9003, id: 9003, location: 'Карпош', price: 420, service: 'rent', sqm: 62, size: '62 м²', address: 'Ул. Б', lat: 42.0080, lon: 21.4195, geo_source: 'stored' } as Property,
    { eb: 9004, id: 9004, location: 'Карпош', price: 440, service: 'rent', sqm: 64, size: '64 м²', address: 'Ул. В', lat: 42.0078, lon: 21.4208, geo_source: 'stored' } as Property,
  ];
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(NEW_ROWS);
  const llm = new FailingLlm();
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
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
  await handler.handle('test', 'new-import', 'имате куќа за издавање кај магацин пелагонија');
  const s = sessions.get('new-import')!;
  assert.equal(s.slots.location, 'Влае', `the address-bearing row's area wins: ${s.slots.location}`);
  const reply = sent[sent.length - 1];
  assert.ok(reply.includes('Влае'), `the area follows the row at the place: ${reply}`);
  assert.ok(!/Карпош/.test(reply), `the neighbours' majority is not spoken: ${reply}`);
  assert.ok(reply.includes('9001'), `the newly imported house is served: ${reply}`);
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
