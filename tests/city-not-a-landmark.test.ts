// THE [09:50] CAPTURE — SKOPJE IS A CITY, NOT A NEIGHBOURHOOD AND NOT A LANDMARK.
//
//   [09:5x] КЛИЕНТ: МИ ТРЕБА СТАН ЗА КУПУВАЊЕ ВО СКОПЈЕ, ОД ДРУГ ГРАД СУМ
//   [09:50] ЛИНА: Еве ги најблиските опции до Скопје:
//                 Станот под Евидентен број 74 … Се наоѓа на 890 m од Скопје.
//                 Станот под Евидентен број 66 … Се наоѓа на 980 m од Скопје.
//
// The offline map holds a POI row literally named «Скопје» (osm type `city`, at
// the city centroid). The landmark resolver bound that row as an ANCHOR, and
// `areaAtPlace()` then derived the district «Центар» from the centroid — so the
// funnel believed the AREA was answered and never asked which neighbourhood of
// Skopje the client wants. The batch went out anchored to a city, with cards
// measuring «890 m од Скопје», exactly as if Skopje were a shopping centre.
//
// The contract these tests pin:
//   • a CITY is never a landmark: no anchor is bound from it, no district is
//     invented from it, and the area question stays open («во кој дел од
//     градот?» — the neighbourhood of Skopje the client actually needs);
//   • the row TYPE is the guard (`city`/municipality/region), so every seam
//     that binds a client-named place refuses it — including a session that
//     persisted the bad anchor before this fix (cards must never measure from
//     a city);
//   • a REAL place whose name merely carries the city word («Скопје Сити Мол»)
//     still binds — the veto is on the mention that is ONLY the city.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import { loadConfig } from '../src/config';
import { Db } from '../src/store/db';
import { SessionStore, freshSession } from '../src/fsm/session';
import { Classifier } from '../src/llm/classify';
import { Responder } from '../src/llm/respond';
import { PropertyService, Property } from '../src/data/properties';
import { AppointmentStore } from '../src/store/appointments';
import { EscalationStore } from '../src/store/escalations';
import { MetaStore } from '../src/store/meta';
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler, isCityLevelPlace } from '../src/handlers/inbound';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';
import { LlmClient } from '../src/llm/types';

const cfg = loadConfig();
const hasMap = !!cfg.skopjePoisDb && fs.existsSync(cfg.skopjePoisDb);

// ── 1. THE CLASS TEST ──────────────────────────────────────────────────────

test('[09:50] the CITY class is geography, never a landmark', () => {
  // The row the map actually holds for Скопје (see the seat below).
  assert.equal(isCityLevelPlace('city'), true, 'the city row itself');
  assert.equal(isCityLevelPlace('City'), true, 'the OSM spelling is folded');
  assert.equal(isCityLevelPlace('administrative'), true, 'a region row is the same class');
  assert.equal(isCityLevelPlace('municipality'), true);
  // Places INSIDE the city are untouched — this list is why a real anchor and a
  // real area still resolve after the guard.
  assert.equal(isCityLevelPlace('suburb'), false, 'Карпош is a suburb row, a real area');
  assert.equal(isCityLevelPlace('mall'), false);
  assert.equal(isCityLevelPlace('hotel'), false);
  assert.equal(isCityLevelPlace(undefined), false);
});

test('[09:50] the map really does carry Скопје as a city row — the bug\'s source', { skip: !hasMap }, () => {
  const map = new OfflineMapStore(cfg.skopjePoisDb);
  const row = map.findPoiByName('Скопје');
  assert.ok(row, 'the offline map resolves «Скопје» (that is how it became an anchor)');
  assert.equal(String(row!.type ?? '').toLowerCase(), 'city',
    `the row's class is what the veto keys on: ${row!.name} [${row!.type}]`);
  assert.equal(isCityLevelPlace(row!.type), true, '…and the guard refuses it');
});

// ── 2. THE REAL PIPELINE ──────────────────────────────────────────────────

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

const ROWS: Property[] = [
  { eb: 74, id: 74, location: 'Центар', address: 'Дебар Маало', price: 190000, bedrooms: 3, sqm: 72, size: '72 м²', service: 'buy', lat: 41.9985, lon: 21.4310, geo_source: 'stored', details: 'Дебар Маало.' } as Property,
  { eb: 66, id: 66, location: 'Центар', address: 'Рузвелтова', price: 137000, bedrooms: 3, sqm: 79, size: '79 м²', service: 'buy', lat: 41.9949, lon: 21.4336, geo_source: 'stored', details: 'Рузвелтова.' } as Property,
  { eb: 70, id: 70, location: 'Карпош', address: 'ул. Бледски договор', price: 150000, bedrooms: 2, sqm: 65, size: '65 м²', service: 'buy', lat: 42.0060, lon: 21.3890, geo_source: 'stored', details: 'Карпош 1.' } as Property,
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getById(id: number): Promise<Property | undefined> { return this.rows.find(r => r.id === id || r.eb === id); }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  get healthy(): boolean { return true; }
}

function makeHandler() {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const properties = new FakeProps(ROWS);
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, properties),
    responder: new Responder(new FailingLlm(), cfg),
    properties,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
  });
  const say = async (m: string, chatId = 'skopje-city'): Promise<string> => {
    await handler.handle('test', chatId, m);
    return sent.at(-1) ?? '';
  };
  return { say, sessions, chatId: 'skopje-city' };
}

const AREA_QUESTION = /дел од градот|дел од Скопје|населба|локациј/iu;
/** A distance FROM the city — the capture's «890 m од Скопје». */
const CITY_DISTANCE = /\b\d[\d.,]*\s*(?:m|метри|km|километри)\s+од\s+(?:Скопје|Skopje)/iu;

test('[09:50] e2e: «стан за купување во Скопје» asks WHICH PART of Skopje', { skip: !hasMap }, async () => {
  const { say, sessions, chatId } = makeHandler();
  const reply = await say('ЗДРАВО, МИ ТРЕБА СТАН ЗА КУПУВАЊЕ ВО СКОПЈЕ, БИДЕЈЌИ СУМ ОД ДРУГ ГРАД');
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.service, 'buy', `the market is heard: ${reply}`);
  assert.equal(s.slots.poiAnchor, undefined,
    `a city may never become an anchor (the capture's «до Скопје» opener): ${s.slots.poiAnchor}`);
  assert.equal(s.slots.location, undefined,
    `no district may be derived from the city centroid (the capture invented «Центар»): ${s.slots.location}`);
  assert.match(reply, AREA_QUESTION,
    `the client must be asked which neighbourhood of Skopje he wants: ${reply}`);
  assert.doesNotMatch(reply, CITY_DISTANCE, reply);
});

test('[09:50] e2e: the serve never measures a flat from the city', { skip: !hasMap }, async () => {
  const { say, sessions, chatId } = makeHandler();
  await say('ЗДРАВО, МИ ТРЕБА СТАН ЗА КУПУВАЊЕ ВО СКОПЈЕ, БИДЕЈЌИ СУМ ОД ДРУГ ГРАД');
  // The funnel still owes the area, so the criteria turn asks it again instead
  // of serving cities-wide inventory as if the area were known.
  const asked = await say('СО ДВЕ СПАЛНИ САКАМ, ДО 200.000 ЕВРА');
  assert.equal(sessions.get(chatId)!.state, 'discovery',
    `nothing is served until the neighbourhood is named: ${asked}`);
  assert.match(asked, AREA_QUESTION, asked);
  // The client finally names a real neighbourhood — the batch is ranked there,
  // and no card carries a distance to the city.
  const served = await say('ЦЕНТАР');
  const s = sessions.get(chatId)!;
  assert.equal(s.state, 'presentation', `the named area serves the batch: ${served}`);
  assert.equal(s.slots.poiAnchor, undefined, 'the district is an area, not a landmark');
  assert.doesNotMatch(served, CITY_DISTANCE, `no «m од Скопје» claim: ${served}`);
  assert.doesNotMatch(served, /најблиските опции до Скопје/iu, served);
});

test('[09:50] e2e: answering the area question with the city means the WHOLE city, not a loop', { skip: !hasMap }, async () => {
  const { say, sessions, chatId } = makeHandler();
  const first = await say('ЗДРАВО, МИ ТРЕБА СТАН ЗА КУПУВАЊЕ ВО СКОПЈЕ, БИДЕЈЌИ СУМ ОД ДРУГ ГРАД');
  assert.match(first, AREA_QUESTION, `the neighbourhood is asked once: ${first}`);
  // He has no particular part in mind — he repeats the city. That answers the
  // AREA question (exactly like «било каде»): city-wide, ordered from the most
  // popular neighbourhoods, and the SAME question is never asked again.
  const second = await say('ВО СКОПЈЕ');
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.anywhere, true,
    `a city answer releases the area (the probe re-asked it four times): ${second}`);
  assert.doesNotMatch(second, AREA_QUESTION, `the area may not be re-asked: ${second}`);
  assert.match(second, /цена|буџет|спалн/iu, `the funnel moves on: ${second}`);
  // …and the batch it ends in is city-wide with no card measured from the city.
  const served = await say('СО ДВЕ СПАЛНИ, ДО 200.000 ЕВРА');
  assert.equal(sessions.get(chatId)!.state, 'presentation', served);
  assert.doesNotMatch(served, CITY_DISTANCE, served);
  assert.doesNotMatch(served, AREA_QUESTION, `nothing is asked again once the batch is out: ${served}`);
});

test('[09:50] e2e: a PERSISTED city anchor measures nothing (sessions stored before the fix)', { skip: !hasMap }, async () => {
  const { say, sessions, chatId } = makeHandler();
  const s = freshSession('test', chatId);
  s.state = 'presentation';
  s.slots.service = 'buy';
  s.slots.location = 'Центар';
  s.slots.bedrooms = 3;
  s.slots.budget = '200000';
  s.slots.propertyId = 74;
  s.slots.interestedPropertyId = 74;
  s.slots.presentedIds = [74];
  s.slots.currentBatch = [74];
  s.slots.poiAnchor = 'Скопје';   // the row the old resolver bound
  s.slots.poiArea = 'Центар';     // …and the district areaAtPlace() invented
  s.slots.location = 'Центар';
  sessions.set(s);
  const reply = await say('DAJ MI POEVTINO');
  assert.doesNotMatch(reply, CITY_DISTANCE,
    `an old city anchor must not put a distance on the cards: ${reply}`);
  const after = sessions.get(chatId)!;
  assert.equal(after.slots.poiAnchor, undefined,
    'the turn boundary drops a city anchor an old session still holds');
  assert.equal(after.slots.location, undefined,
    '…and the district derived from its centroid (neighbourhood still owed)');
});

test('[09:50] a real place whose name carries the city still binds (Скопје Сити Мол)', { skip: !hasMap }, async () => {
  const { say, sessions, chatId } = makeHandler();
  const reply = await say('ZDRAVO MI TREBA STAN ZA KUPUVANJE KAJ SKOPJE SITI MOL');
  const anchor = sessions.get(chatId)!.slots.poiAnchor;
  assert.match(anchor ?? '', /сити|siti|city/iu,
    `the mall the client named must still anchor the search (the veto is on the CITY alone): ${reply}`);
});
