/**
 * THE [17:26] ЛЕПТОКАРИЈА CAPTURE — the place is the geography, not the vote.
 *
 *   [17:26] ZDRAVO SAKAM DA KUPAM STANCE DVOSOBNO OKOLU LEPTOKARIJA
 *   [17:26] ЛИНА: Која е горната граница на цената…?
 *   [17:26] DO 120000
 *   [17:26] ЛИНА: Во моментов немам недвижност во непосредна близина на ТЦ
 *           Лептокарија. Еве ги најблиските опции во Центар: … EB 69 (3,3 km)
 *   [17:28] TE PRASUVAM VO KOJA NASELBA E TC LEPTOKARIJA
 *   [17:28] ЛИНА: Тоа се наоѓа во близина на Општина Бутел. (2 km away)
 *
 * Three root causes, one test each:
 *   1. the area a place implies was a VOTE over feed tags — the Центар rows
 *      outvoted Карпош III, so the correct district's flats (EB 54, 303 m) were
 *      excluded from the pool before ranking;
 *   2. the served pair carried NO distances, so nothing said WHICH card was
 *      around the place the client named;
 *   3. «во која населба е X» was owned by no lane, so the property's landmark
 *      answered for the place.
 *
 * The map knows ТЦ Лептокарија at 42.00356, 21.39909 and its nearest OSM
 * quarter is Карпош 3 (219 m).
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

/** The live feed's rows around the mall (real EBs, real areas, real pins). */
const ROWS: Property[] = [
  // 303 m from the mall, the client's own criteria (2 rooms, buy, under 120k).
  { eb: 54, id: 54, location: 'Карпош III', address: 'Роберт Кох 3', price: 69500, bedrooms: 2, sqm: 35, size: '35 м²', service: 'buy', lat: 42.0036, lon: 21.3955 },
  // 615 m, same quarter — but a RENT row: never part of a buy pair.
  { eb: 48, id: 48, location: 'Карпош III', address: 'Руските Згради', price: 250, bedrooms: 3, sqm: 70, size: '70 м²', service: 'rent', lat: 42.0018, lon: 21.3925 },
  // 1,3 km away in Центар — the card the old vote-derived lock served FIRST.
  { eb: 69, id: 69, location: 'Центар', address: 'Димитар Миладинов', price: 99000, bedrooms: 2, sqm: 51, size: '51 м²', service: 'buy', lat: 42.0005, lon: 21.4121 },
  // Кисела Вода, buy — far from the mall, must never answer «околу Лептокарија».
  { eb: 46, id: 46, location: 'Кисела Вода', address: 'Народни Херои', price: 72000, bedrooms: 2, sqm: 43, size: '43 м²', service: 'buy', lat: 41.9952, lon: 21.4450 },
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === eb || r.id === eb);
  }
  get healthy(): boolean { return true; }
}

function makeHandler(rows: Property[] = ROWS, id = 'leptokarija') {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const handler = new InboundHandler({
    cfg, db, sessions, bank: new BankStore(db),
    classifier: new Classifier(new FailingLlm(), cfg, new FakeProps(rows)),
    responder: new Responder(new FailingLlm(), cfg),
    properties: new FakeProps(rows),
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
    enrichment: new EnrichmentStore(db),
  });
  return { handler, sessions, sent, chatId: id };
}

test('the area a place implies comes from the map, not from a vote over feed tags', async () => {
  const { handler, sessions, chatId } = makeHandler();
  await handler.handle('test', chatId, 'ZDRAVO SAKAM DA KUPAM STANCE DVOSOBNO OKOLU LEPTOKARIJA');
  const s = sessions.get(chatId)!;
  assert.match(String(s.slots.poiAnchor), /лептокарија|leptokarija/iu,
    `the anchor is the place the client named, got ${s.slots.poiAnchor}`);
  // The mall sits in OSM's Карпош 3 — the feed spells it «Карпош III», and the
  // slot must carry the FEED's spelling (cards and locPrep read it).
  assert.match(String(s.slots.location), /карпош\s*(?:3|iii)/iu,
    `the derived area is the mall's own quarter, got ${s.slots.location}`);
  assert.match(String(s.slots.poiArea), /карпош\s*(?:3|iii)/iu,
    `the derived area is the anchor's, got ${s.slots.poiArea}`);
});

test('the pair leads with the closest in-budget flat and carries its distance', async () => {
  const { handler, sent, sessions, chatId } = makeHandler();
  await handler.handle('test', chatId, 'ZDRAVO SAKAM DA KUPAM STANCE DVOSOBNO OKOLU LEPTOKARIJA');
  await handler.handle('test', chatId, 'DO 120000');
  const answer = sent[sent.length - 1] ?? '';
  assert.equal(sessions.get(chatId)!.state, 'presentation');
  assert.match(answer, /Евидентен број 54/u,
    `the 303 m flat in the mall's own quarter is the answer, got: ${answer}`);
  // The distance is the whole point of an anchored search: without it the card
  // says nothing about «околу Лептокарија».
  assert.match(answer, /од ТЦ Лептокарија/u, `the card names the place: ${answer}`);
  assert.match(answer, /на (?:2|3)\d0 m од ТЦ Лептокарија/u,
    `the card measures the distance (≈300 m): ${answer}`);
  // The vote winner (Центар, 1,3 km) and the far Кисела Вода row are NOT the
  // closest options — they must not lead the pair.
  assert.ok(!/Евидентен број 69/u.test(answer), `EB 69 is 1,3 km away: ${answer}`);
  assert.ok(!/Евидентен број 46/u.test(answer), `EB 46 is in Кисела Вода: ${answer}`);
  // The rent row in the same quarter never rides a buy search.
  assert.ok(!/Евидентен број 48/u.test(answer), `EB 48 is a rental: ${answer}`);
});

test('«во која населба е X» answers with the map quarter, without any property', async () => {
  const { handler, sent, chatId } = makeHandler();
  await handler.handle('test', chatId, 'TE PRASUVAM VO KOJA NASELBA E TC LEPTOKARIJA');
  const answer = sent[sent.length - 1] ?? '';
  assert.match(answer, /Карпош 3/u, `the mall's quarter, got: ${answer}`);
  assert.ok(!/Општина Бутел|Бутел/u.test(answer),
    `the property landmark must never answer for a place: ${answer}`);
});

test('mid-session «во која населба е X» uses the nearest card of the batch', async () => {
  const { handler, sent, chatId } = makeHandler();
  await handler.handle('test', chatId, 'ZDRAVO SAKAM DA KUPAM STANCE DVOSOBNO OKOLU LEPTOKARIJA');
  await handler.handle('test', chatId, 'DO 120000');
  await handler.handle('test', chatId, 'VO KOJA NASELBA E TC LEPTOKARIJA');
  const answer = sent[sent.length - 1] ?? '';
  assert.match(answer, /Карпош 3/u, `the quarter, got: ${answer}`);
  assert.match(answer, /Евидентен број 54/u,
    `the nearest card is the reference point, got: ${answer}`);
  assert.match(answer, /на (?:2|3)\d0 метри/iu, `its real distance (≈300 m): ${answer}`);
});

test('«kade e X» works before any property was served — no landmark rotation', async () => {
  const { handler, sent, chatId } = makeHandler();
  await handler.handle('test', chatId, 'KADE E TC LEPTOKARIJA');
  const answer = sent[sent.length - 1] ?? '';
  assert.match(answer, /Карпош 3/u, `the place's quarter, got: ${answer}`);
  assert.ok(!/во близина на (?!ТЦ Лептокарија)/iu.test(answer),
    `no other place's landmark may stand in for the answer: ${answer}`);
});

test('the flat on the table is not a PLACE — «во која населба е станот» keeps its own lane', async () => {
  // The recogniser must not swallow the property question: its answer is the
  // card's area, not a map lookup that ends in «немам во мојата евиденција».
  const { handler, sent, chatId } = makeHandler();
  await handler.handle('test', chatId, 'ZDRAVO SAKAM DA KUPAM STANCE DVOSOBNO OKOLU LEPTOKARIJA');
  await handler.handle('test', chatId, 'DO 120000');
  await handler.handle('test', chatId, 'VO KOJA NASELBA E STANOT');
  const answer = sent[sent.length - 1] ?? '';
  assert.ok(!/го немам во мојата евиденција/u.test(answer),
    `the property question must not be read as an unknown place: ${answer}`);
});

test('a place the map does not know is answered honestly, never invented', async () => {
  const { handler, sent, chatId } = makeHandler();
  await handler.handle('test', chatId, 'VO KOJA NASELBA E ZULUFTAR');
  const answer = sent[sent.length - 1] ?? '';
  assert.match(answer, /немам|нема/iu, `an honest miss, got: ${answer}`);
  assert.ok(!/населба на|се наоѓа во (?:Центар|Карпош|Аеродром)/iu.test(answer),
    `no district may be invented for an unknown place: ${answer}`);
});
