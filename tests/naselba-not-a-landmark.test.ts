// A NASELBA IS NOT A LANDMARK (the owner's 2026-11-16 rule: «CENTAR AND
// SKOPJE SEVER ARE NASELBAS»).
//
// The offline map files a neighbourhood as an OSM settlement row (`suburb`,
// `neighbourhood`, `quarter`, `hamlet`, `village`, `locality`) pinned at its
// centroid: «Центар» [suburb], «Скопје Север» [suburb], «Карпош 3» [suburb].
// Reading one as a POI produced two defects that the weekly place-miss digest
// kept surfacing:
//
//   • THE ANSWER WAS A TAUTOLOGY: «KADE E CENTAR?» → «Центар се наоѓа во
//     Центар.» — the place's own quarter IS itself, because areaAt() looks up
//     the settlement a point sits in and the centroid of a suburb sits in that
//     suburb.
//   • THE DIGEST CALLED THEM MAP GAPS. `центар` and `скопје север` ranked with
//     the truly unknown words (`црногорска амбасада`, `зулуфтар`) even though
//     both resolve on the map — the class of the row was never considered.
//
// The class is the one truth (exactly as for `isCityLevelPlace`): the map also
// carries a «Centar Bar» and a bus station called «Скопје Север», which stay
// ordinary POIs. And a real landmark keeps the «се наоѓа во <quarter>» line.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig } from '../src/config';
import { Db } from '../src/store/db';
import { SessionStore } from '../src/fsm/session';
import { Classifier } from '../src/llm/classify';
import { Responder } from '../src/llm/respond';
import { PropertyService, Property } from '../src/data/properties';
import { AppointmentStore } from '../src/store/appointments';
import { EscalationStore } from '../src/store/escalations';
import { MetaStore } from '../src/store/meta';
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler, isSettlementPlace } from '../src/handlers/inbound';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore, mapNameCoversClientWords, mapNameOpensWithClientWord } from '../src/geo/offlineMap';
import { LlmClient } from '../src/llm/types';
import { readPlaceMisses, flushPlaceMisses, setPlaceMissDir } from '../src/store/placeMisses';
import { detectLocation } from '../src/llm/deterministic';
import { displayAreaName } from '../src/llm/prompts';

const cfg = loadConfig();
const hasMap = !!cfg.skopjePoisDb && fs.existsSync(cfg.skopjePoisDb);

// ── 1. THE CLASS TEST ──────────────────────────────────────────────────────

test('a settlement row is a NASELBA; a shop or a bar of the same name is not', () => {
  for (const t of ['suburb', 'neighbourhood', 'quarter', 'hamlet', 'village', 'locality']) {
    assert.equal(isSettlementPlace(t), true, `${t} is a settlement class`);
  }
  assert.equal(isSettlementPlace('Suburb'), true, 'the OSM spelling is folded');
  assert.equal(isSettlementPlace('mall'), false, 'Центар мол is a building');
  assert.equal(isSettlementPlace('bus_station'), false, 'Скопје Север is also a bus station');
  assert.equal(isSettlementPlace('bar'), false, 'Centar Bar is a bar');
  assert.equal(isSettlementPlace(undefined), false);
});

test('the map really files both names as settlement rows', { skip: !hasMap }, () => {
  const map = new OfflineMapStore(cfg.skopjePoisDb);
  for (const name of ['Центар', 'Скопје Север']) {
    const row = map.findPoiByName(name);
    assert.ok(row, `the map resolves «${name}»`);
    assert.equal(isSettlementPlace(row!.type), true,
      `«${name}» is a naselba, got [${row!.type}] on «${row!.name}»`);
  }
  map.close();
});

test('the feed and the map agree that both names are areas, not map gaps', () => {
  // The feed files properties under these names, so a client naming one is
  // naming the AREA the funnel's own question asks for — not an unknown place.
  const FEED = ['Центар', 'Центар (населба)', 'Скопје Север', 'Аеродром', 'Карпош III'];
  assert.equal(detectLocation('VO CENTAR', FEED), 'Центар (населба)');
  assert.equal(detectLocation('BARAM STAN VO SKOPJE SEVER', FEED), 'Скопје Север');
  assert.equal(detectLocation('SAKAM DA KUPAM STAN VO SKOPJE SEVER', FEED), 'Скопје Север');
  // The parenthetical is an internal feed tag and is never spoken.
  assert.equal(displayAreaName('Центар (населба)'), 'Центар');
});

// ── 2. THE REAL PIPELINE ──────────────────────────────────────────────────

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('probe: LLM disabled'); }
}

const ROWS: Property[] = [
  { eb: 66, id: 66, location: 'Скопје Север', address: 'ул. Север 1', price: 120000, bedrooms: 2, sqm: 60, size: '60 м²', service: 'buy', lat: 42.0234, lon: 21.4394, geo_source: 'stored', details: '' },
  { eb: 74, id: 74, location: 'Центар', address: 'Дебар Маало', price: 190000, bedrooms: 3, sqm: 72, size: '72 м²', service: 'buy', lat: 41.9985, lon: 21.4310, geo_source: 'stored', details: '' },
] as Property[];

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
  const chatId = 'naselba';
  const say = async (m: string): Promise<string> => {
    sent.length = 0;
    await handler.handle('test', chatId, m);
    return sent.at(-1) ?? '';
  };
  return { handler, sessions, chatId, say };
}

test('e2e: «KADE E CENTAR ?» answers the NASELBA, never «Центар се наоѓа во Центар»', { skip: !hasMap }, async () => {
  const h = makeHandler();
  const reply = await h.say('KADE E CENTAR ?');
  assert.match(reply, /Центар/u, `the place is named: ${reply}`);
  assert.match(reply, /населба/u, `it is answered as a naselba: ${reply}`);
  assert.doesNotMatch(reply, /Центар се наоѓа во Центар/u, `never the tautology: ${reply}`);
});

test('e2e: «во која населба е Скопје Север» is the same naselba answer', { skip: !hasMap }, async () => {
  const h = makeHandler();
  const reply = await h.say('VO KOJA NASELBA E SKOPJE SEVER ?');
  assert.match(reply, /Скопје Север/u, reply);
  assert.doesNotMatch(reply, /Скопје Север се наоѓа во Скопје Север/u, `never the tautology: ${reply}`);
});

test('e2e: a real LANDMARK keeps its quarter line', { skip: !hasMap }, async () => {
  const h = makeHandler();
  // Црногорска Амбасада is a diplomatic row in Центар — a place INSIDE a
  // neighbourhood, so the old sentence is the correct one there.
  const reply = await h.say('KADE E CRNOGORSKA AMBASADA ?');
  assert.match(reply, /се наоѓа во/u, `a landmark is placed in its quarter: ${reply}`);
  assert.doesNotMatch(reply, /е населба во Скопје/u, `a building is not a naselba: ${reply}`);
});

test('e2e: naming a naselba writes NO place miss and banks the AREA', { skip: !hasMap }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naselba-misses-'));
  setPlaceMissDir(dir);
  const h = makeHandler();
  const reply = await h.say('BARAM STAN ZA KUPUVANJE VO SKOPJE SEVER');
  const s = h.sessions.get(h.chatId)!;
  assert.match(String(s.slots.location), /Скопје Север/u,
    `the naselba is the area of the search: ${JSON.stringify({ loc: s.slots.location, anchor: s.slots.poiAnchor })} — ${reply}`);
  await flushPlaceMisses();
  const misses = await readPlaceMisses();
  assert.deepEqual(misses.map(m => m.text), [],
    `a neighbourhood the map holds is never a map gap: ${misses.map(m => m.text).join(' | ')}`);
});

test('the digest\'s "does it bind today?" probe refuses a fuzzy coincidence', { skip: !hasMap }, () => {
  // The rule the place-miss digest concludes "resolves now" with: every word
  // the client said must be in the row AND the row must OPEN with one of them.
  assert.equal(mapNameCoversClientWords('центар', 'Центар'), true);
  assert.equal(mapNameCoversClientWords('Центар', 'Центар'), true);
  assert.equal(mapNameCoversClientWords('скопје север', 'Скопје Север'), true);
  assert.equal(mapNameCoversClientWords('BUTEL', 'Бутел'), true, 'the script fold bridges it');
  assert.equal(mapNameCoversClientWords('Црногорска амбасада', 'Црногорска Амбасада'), true);
  // A PARTIAL NAME IS NOT THE NAME — these were reported as "nothing to add"
  // for two names the map genuinely does not hold as typed.
  assert.equal(mapNameCoversClientWords('амбасадата', 'Паркинг на амбасадата на САД'), false,
    'a parking lot is not the embassy the client named');
  assert.equal(mapNameCoversClientWords('SKOPJE SEVER E', 'Скопје север ЕВН'), false,
    'a bus station that starts with the area name is not the area');
  assert.equal(mapNameCoversClientWords('zivo', 'Центар'), false);
  // THE SPELLING FOLD IS THE RESOLVER'S: the map writes «Карпош», a client's
  // keyboard writes «KARPOS» (s for ш) — a digest that folds `toCyrillic` only
  // calls a name that RESOLVES a gap forever (45 rows in the 2026-11-16 replay).
  assert.equal(mapNameCoversClientWords('KARPOS', 'Карпош'), true);
  assert.equal(mapNameCoversClientWords('KARPOS', 'Карпош 3'), true, 'coverage is not the whole name — see todayBinding');
  // THE EXTRACTOR'S OPENER/FILLER IS NOT PART OF THE NAME: «KAJ SKOPJE SEVER»
  // and «PA AERODROM» both name the area, and the audit forgot to strip the
  // opener while the CLI did — the two reports disagreed about the same row.
  assert.equal(mapNameCoversClientWords('KAJ SKOPJE SEVER', 'Скопје Север'), true);
  assert.equal(mapNameCoversClientWords('PA AERODROM', 'Аеродром'), true);
  // A NAME THE MAP DECLARED AFTER A SEPARATOR IS THE SAME INSTITUTION («Управа
  // за јавни приходи - УЈП»), but a tail alone is not: «тобако РАМПА» is a
  // kiosk named AFTER the Рампа area, and accepting it made a tobacco shop the
  // place the client named.
  assert.equal(mapNameCoversClientWords('ујп', 'Управа за јавни приходи - УЈП'), true);
  assert.equal(mapNameCoversClientWords('рампа', 'тобако РАМПА'), false,
    'a kiosk named after the area is not the area');
  // The LOOSER form used to PROPOSE an alias: the row's head must be a word the
  // client said, so a filler («PA») does not make a kindergarten the target.
  assert.equal(mapNameOpensWithClientWord('PA AERODROM', 'Kindergarten "Crvenkapa" - Aerodrom'), false);
  assert.equal(mapNameOpensWithClientWord('PA AERODROM', 'Аеродром'), true);
});

test('an AREA name is never answered by a place NAMED AFTER it (the [07:16] KARPOS)', { skip: !hasMap }, () => {
  const map = new OfflineMapStore(cfg.skopjePoisDb);
  const hit = (q: string) => map.findPoiByName(q);
  // «KARPOS» is the Serbian/ASCII spelling (s for ш) a client's keyboard
  // produces. Before the fix it bound «Карпош 3» [mall] — a shopping centre
  // 1 km from the area — because every row NAMED AFTER the area matched as a
  // prefix and typeRank ranks a mall above a naselba.
  for (const q of ['KARPOS', 'КАРПОС', 'Karpos', 'ПА КАРПОШ']) {
    const row = hit(q);
    assert.ok(row, `«${q}» resolves`);
    assert.equal(row!.name, 'Карпош', `«${q}» is the AREA: got «${row!.name}» [${row!.type}]`);
    assert.equal(isSettlementPlace(row!.type), true, `«${q}» answers a naselba row`);
  }
  // The numbered quarters are discriminates, not noise: the number used to be
  // dropped by the phonetic fold, so «KARPOS 3» answered the bare «Карпош».
  for (const [q, want] of [['KARPOS 3', 'Карпош 3'], ['KARPOS 1', 'Карпош 1'], ['KARPOS 4', 'Карпош 4']]) {
    const row = hit(q);
    assert.ok(row, `«${q}» resolves`);
    assert.equal(row!.name, want, `«${q}» is «${want}»: got «${row!.name}» [${row!.type}]`);
    assert.equal(isSettlementPlace(row!.type), true, `«${q}» answers the naselba, not the mall`);
  }
  // The same s-for-ш keyboard across the city, and the filler «PA».
  assert.equal(hit('SUTO ORIZARI')?.name, 'Шуто Оризари');
  assert.equal(hit('KISELA VODA')?.name, 'Кисела Вода');
  assert.equal(hit('PA AERODROM')?.name, 'Аеродром');
  assert.equal(isSettlementPlace(hit('PA AERODROM')?.type), true);
  // A client who NAMES the mall keeps the mall: the rule is order, not a veto.
  assert.equal(hit('ТЦ КАРПОШ 3')?.name, 'Карпош 3');
  assert.equal(hit('ТЦ КАРПОШ 3')?.type, 'mall');
  // …and significance still decides among rows the needle merely STARTS
  // (the [00:46] «Бисер» capture: a travel AGENCY must not beat the mall).
  assert.equal(hit('Бисер')?.name, 'Biser Shopping Center');
  assert.equal(hit('КАПИТОЛ')?.name, 'Трговски центар Капитол');
  map.close();
});

test('todayBinding: a name binds only through the resolver\'s own answer', { skip: !hasMap }, () => {
  const map = new OfflineMapStore(cfg.skopjePoisDb);
  // The digest's conclusion is "the map binds this TODAY" — it must agree with
  // the resolver, including the opener strip and the phonetic fold, or the
  // operator keeps closing tickets for names that already work.
  assert.equal(map.todayBinding('KARPOS')?.name, 'Карпош');
  assert.equal(map.todayBinding('KARPOS')?.type, 'suburb');
  assert.equal(map.todayBinding('KARPOS 3')?.name, 'Карпош 3');
  assert.equal(map.todayBinding('KARPOS 3')?.type, 'suburb');
  assert.equal(map.todayBinding('PA AERODROM')?.name, 'Аеродром');
  assert.equal(map.todayBinding('KAJ SKOPJE SEVER')?.name, 'Скопје Север');
  assert.equal(map.todayBinding('ујп')?.name, 'Управа за јавни приходи - УЈП');
  // A log fragment that names NO coherent place stays unresolved: the resolver
  // answers something, and the coverage guard refuses to believe it.
  assert.equal(map.todayBinding('zumzulce bez vrska'), undefined);
  map.close();
});

test('e2e: «KADE E KARPOS ?» answers the naselba, not the shopping centre', { skip: !hasMap }, async () => {
  const h = makeHandler();
  const reply = await h.say('KADE E KARPOS ?');
  assert.match(reply, /Карпош/u, `the area is named: ${reply}`);
  assert.match(reply, /населба/u, `answered as a naselba: ${reply}`);
  assert.doesNotMatch(reply, /Карпош 3|мол|трговски/u, `never the mall named after it: ${reply}`);
});

test('e2e: the same for Центар — the area is banked, nothing is logged', { skip: !hasMap }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naselba-misses-'));
  setPlaceMissDir(dir);
  const h = makeHandler();
  const reply = await h.say('SAKAM STAN VO CENTAR DO 150000');
  const s = h.sessions.get(h.chatId)!;
  assert.match(String(s.slots.location), /Центар/u, `the area is Центар: ${reply}`);
  await flushPlaceMisses();
  assert.deepEqual((await readPlaceMisses()).map(m => m.text), [],
    'Центар resolves — it must never be reported as a place the map does not know');
});
