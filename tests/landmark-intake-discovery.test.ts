/**
 * THE [13:29] CAPTURE — «во близина на Буњаковец» is a LOCATION ANSWER.
 *
 *   [13:29] ZDRAVO , MI TREBA STANCE VO BLIZINA NA BUNJAKOVEC
 *   [13:29] STO IMA DOSTAPNO ?                  ← batched with the line above
 *   [13:29] ЛИНА [dynamic]: Здраво! … Дали барате стан за изнајмување или за
 *           купување, и кога би сакале да го погледнете?
 *   [13:29] SAKAM DA KUPAM
 *   [13:29] ЛИНА [без LLM]: Дали имате одредена населба во градот во која
 *           сакате да бараме стан за Вас?
 *
 * Two failures, one repair each:
 *   (1) The intake was eaten by the LEARNED bank: the phrasing matched a stored
 *       dynamic row (`dynamic:idle:zdravo-treba-stance`), so the message never
 *       reached the funnel and the landmark was never resolved. A property NEED
 *       that names a PLACE is funnel traffic — never a canned answer.
 *   (2) With the anchor stored (Буњаковец → Центар, the feed's own area for
 *       the place), discovery must ask the PAIR — bedrooms and budget — not the
 *       neighborhood the client had just pointed at.
 * The serve stays anchored: the flat on Ул. Буњаковец wins over a cheaper
 * Карпош row.
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
import { buildDiscoveryAsk } from '../src/llm/prompts';
import { extractPoiWish, fsmRequired } from '../src/llm/deterministic';
import type { SlotData } from '../src/fsm/session';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

const MSG_INTAKE = 'ZDRAVO , MI TREBA STANCE VO BLIZINA NA BUNJAKOVEC';
/** The stored row the live run served instead of running the funnel. */
const LEARNED_ANSWER =
  'Здраво! Со задоволство ќе ви помогнам да најдеме соодветен стан во близина на Буњаковец. Веднаш ќе ги проверам сите достапни опции.';

const ROWS: Property[] = [
  // The neighbourhood + the street the anchor names (Bunjakovec is in Центар).
  { eb: 104, id: 104, location: 'Центар', address: 'Ул. Буњаковец 8', price: 105000, bedrooms: 2, sqm: 55, size: '55 м²', service: 'buy', lat: 41.9962, lon: 21.4358 },
  { eb: 102, id: 102, location: 'Центар', address: 'Ул. Буњаковец 12', price: 120000, bedrooms: 2, sqm: 62, size: '62 м²', service: 'buy', lat: 41.9960, lon: 21.4360 },
  // Cheaper, same size — but another municipality: the anchor must outrank it.
  { eb: 105, id: 105, location: 'Карпош', address: 'Ул. Карпош 9', price: 102000, bedrooms: 2, sqm: 54, size: '54 м²', service: 'buy', lat: 42.0050, lon: 21.4100 },
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === eb || r.id === eb);
  }
  get healthy(): boolean { return true; }
}

/**
 * THE [16:11] CAPTURE — «во реонот на Католичка» must resolve to the church's
 * COORDINATES and the serve must be the flats nearest them.
 *
 *   [16:11] ZDRAVO SAKAM DA KUPAM DVOSOBNO STANCE VO REONOT NA KATOLICKA
 *   [16:11] ЛИНА [без LLM]: Дали имате одредена населба во градот…?   ← the
 *           place was never extracted («реонот» is not «реон»), so the funnel
 *           re-asked the neighborhood the client had just pointed at
 *   [16:12] VO BLIZINA NA KATOLICKA
 *   [16:12] ЛИНА [без LLM]: До која сума…?
 *   [16:12] DO 150000
 *   [16:12] ЛИНА [без LLM]: Во ред, ги забележав Вашите критериуми.   ← nothing
 *           ever served: «KATOLICKA» (the client's own ч → c spelling) did not
 *           resolve in the map, so the landmark had no coordinates to rank
 *           from, and slotsComplete() did not count the anchor as the location
 *           answer the discovery ask had already treated it as.
 * The map of Skopje puts THE CATHEDRAL — «Римокатоличка Катедрала Пресвето
 * Срце Исусово», Google's «Sacred Heart Catholic Church» — at 41.9950,
 * 21.4178 (Центар).
 */
const MSG_KATOLICKA_INTAKE = 'ZDRAVO SAKAM DA KUPAM DVOSOBNO STANCE VO REONOT NA KATOLICKA';
const KATOLICKA_ROWS: Property[] = [
  { eb: 202, id: 202, location: 'Центар', address: 'Ул. Никола Вапцаров 5', price: 139000, bedrooms: 2, sqm: 58, size: '58 м²', service: 'buy', lat: 41.9954, lon: 21.4174 },
  { eb: 201, id: 201, location: 'Центар', address: 'Ул. Македонија 3', price: 148000, bedrooms: 2, sqm: 62, size: '62 м²', service: 'buy', lat: 41.9944, lon: 21.4164 },
  // Центар, but on the far side of the area (~1.2 km from the church): it is
  // what a THIRD serve near the anchor may hold, never part of the nearest pair.
  { eb: 205, id: 205, location: 'Центар', address: 'Ул. Партизански Одреди 60', price: 149000, bedrooms: 2, sqm: 70, size: '70 м²', service: 'buy', lat: 42.0000, lon: 21.4030 },
  // Cheaper than anything in Центар — a price-first sort would lead with it.
  { eb: 203, id: 203, location: 'Карпош', address: 'Ул. Карпош 9', price: 120000, bedrooms: 2, sqm: 60, size: '60 м²', service: 'buy', lat: 42.0050, lon: 21.4100 },
  { eb: 204, id: 204, location: 'Аеродром', address: 'Ул. Јане Сандански 20', price: 145000, bedrooms: 2, sqm: 65, size: '65 м²', service: 'buy', lat: 41.9800, lon: 21.4500 },
  { eb: 206, id: 206, location: 'Аеродром', address: 'Ул. Јане Сандански 44', price: 141000, bedrooms: 2, sqm: 61, size: '61 м²', service: 'buy', lat: 41.9812, lon: 21.4512 },
];

function makeHandler(rows: Property[] = ROWS, id = 'bunjakovec-intake') {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  // The live learned row — it must never answer an intake turn.
  const bank = new BankStore(db);
  bank.addDynamic('dynamic:idle:zdravo-treba-stance', 'idle', MSG_INTAKE, LEARNED_ANSWER);
  const handler = new InboundHandler({
    cfg, db, sessions, bank,
    classifier: new Classifier(new FailingLlm(), cfg, new FakeProps(rows)),
    responder: new Responder(new FailingLlm(), cfg),
    properties: new FakeProps(rows),
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
    enrichment: new EnrichmentStore(db),
  });
  const chatId = id;
  return { handler, sessions, sent, chatId };
}

test('a property need that names a place is FSM traffic, never a learned answer', () => {
  assert.equal(fsmRequired(MSG_INTAKE), true, 'the intake must reach the funnel');
  // Landmark chatter with no need keeps the learned lane.
  assert.equal(fsmRequired('KAJ OLYMPICO IMA POSTAVA'), false);
});

test('the intake resolves Буњаковец to Центар and the learned row does not answer', async () => {
  const { handler, sessions, sent, chatId } = makeHandler();
  await handler.handle('test', chatId, MSG_INTAKE);
  const answer = sent[sent.length - 1] ?? '';
  const s = sessions.get(chatId)!;
  assert.notEqual(answer, LEARNED_ANSWER, 'the stored dynamic answer must not serve intake');
  // pickVariant CHOOSES AT RANDOM among the bank's variants, and they phrase the
  // buy/rent question in several ways («… за купување или за изнајмување?»,
  // «… за да го купите или … под закуп?») — the assertion is about WHAT is
  // asked, never one wording of it.
  assert.match(answer, /купув|купит|купиле|изнајм|закуп|кирија|kupuv|kupit|iznajm|zakup/iu,
    `the buy/rent question is the intake answer, got: ${answer}`);
  assert.ok(s.slots.poiAnchor, 'the landmark anchor is stored');
  assert.match(s.slots.poiAnchor!.toLowerCase(), /буњаковец|bunjakovec/u,
    `the anchor is the place the client named, got ${s.slots.poiAnchor}`);
  assert.equal(s.slots.location, 'Центар', `Буњаковец resolves to its feed area, got ${s.slots.location}`);
});

test('after the buy answer the funnel asks bedrooms AND budget, never the neighborhood', async () => {
  const { handler, sessions, sent, chatId } = makeHandler();
  await handler.handle('test', chatId, MSG_INTAKE);
  await handler.handle('test', chatId, 'SAKAM DA KUPAM');
  const answer = sent[sent.length - 1] ?? '';
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.service, 'buy');
  assert.match(answer, /спалн|spaln/iu, `the bedrooms question is part of the pair, got: ${answer}`);
  assert.match(answer, /цена|cenа|budget|цената|износ/iu, `the budget question is part of the pair, got: ${answer}`);
  assert.ok(!/населба|naselba|дел од градот|локација во градот|lokacija vo gradot/iu.test(answer),
    `the neighborhood question must NOT be re-asked after «во близина на Буњаковец»: ${answer}`);
});

test('buildDiscoveryAsk: a landmark anchor satisfies the location question', () => {
  // A CITY-LEVEL value (typically inferred, never said) does not — but the
  // anchor already named the area, so the pair is asked, not the neighborhood.
  const ask = buildDiscoveryAsk({ service: 'buy', location: 'Скопје', poiAnchor: 'Буњаковец', poiArea: 'Центар' } as SlotData);
  assert.ok(!/населба|naselba|дел од градот|локација во градот/iu.test(ask), `no neighborhood ask: ${ask}`);
  assert.match(ask, /спалн|spaln/iu, `bedrooms asked: ${ask}`);
  assert.match(ask, /цена|cenа/iu, `budget asked: ${ask}`);
  // Without an anchor the behavior is unchanged: city-level → ask the area.
  const bare = buildDiscoveryAsk({ service: 'buy', location: 'Скопје' } as SlotData);
  assert.match(bare, /населба|naselba|дел од градот|локација во градот|lokacija vo gradot/iu,
    `city-level alone still asks the area: ${bare}`);
});

test('«во реонот на Католичка» names a place — the definite form is a wish too', () => {
  // «во реон на» was in the pattern, «во РЕОНОТ на» — how people actually
  // speak — was not, so the landmark never reached the map and the funnel
  // re-asked for a neighborhood the client had already pointed at.
  const wish = extractPoiWish(MSG_KATOLICKA_INTAKE, { withCriteria: true });
  assert.ok(wish, 'the place after «во реонот на» must be read');
  assert.match(wish!, /katolicka|католицка|католичка/iu, `got ${wish}`);
  assert.equal(fsmRequired(MSG_KATOLICKA_INTAKE), true, 'the intake is funnel traffic');
});

test('the [16:11] capture: KATOLICKA resolves, and the budget turn serves the nearest flats', async () => {
  const { handler, sessions, sent, chatId } = makeHandler(KATOLICKA_ROWS, 'katolicka-intake');
  await handler.handle('test', chatId, MSG_KATOLICKA_INTAKE);
  let s = sessions.get(chatId)!;
  let answer = sent[sent.length - 1] ?? '';
  // The intake must not ask the neighborhood it was just given, and bedrooms
  // are already in the message: the ONE thing missing is the price.
  assert.ok(!/населба|naselba|дел од градот|lokacija vo gradot/iu.test(answer),
    `no neighborhood re-ask after «во реонот на Католичка»: ${answer}`);
  assert.match(answer, /цена|cenа|сума|suma|износ/iu, `the price is the missing criterion: ${answer}`);
  assert.match(String(s.slots.poiAnchor), /католичка|katolicka/iu,
    `the anchor is a place the map resolved, got ${s.slots.poiAnchor}`);
  assert.equal(s.slots.location, 'Центар', `the church's feed area, got ${s.slots.location}`);

  await handler.handle('test', chatId, 'DO 150000');
  s = sessions.get(chatId)!;
  answer = sent[sent.length - 1] ?? '';
  assert.equal(s.state, 'presentation', 'the criteria are complete — she serves');
  assert.ok(!/ги забележав/iu.test(answer), `the spec-sheet dead-end is what this fixes: ${answer}`);
  assert.match(answer, /Евидентен број 202/u, `the flat nearest the church leads: ${answer}`);
  assert.match(answer, /Евидентен број 201/u, `the second nearest is the pair: ${answer}`);
  assert.ok(!/Евидентен број 203/u.test(answer),
    `the cheaper Карпош flat is 1.6 km from Католичка — the anchor outranks price: ${answer}`);
  assert.ok(answer.indexOf('202') < answer.indexOf('201'),
    `nearest-first: 202 (≈50 m) before 201 (≈140 m): ${answer}`);
});

test('the landmark named AFTER the criteria are complete serves the nearest matches', async () => {
  // The [16:11] follow-on: the client searched in Аеродром, was served its pair,
  // and THEN narrowed by the church. The place is the geography the next pair
  // must be ranked by — the turn used to end as a STAY (the exhausted line
  // «веќе ги погледнавме сите недвижности…»), with the two flats nearest the
  // church never ranked at all.
  const { handler, sessions, sent, chatId } = makeHandler(KATOLICKA_ROWS, 'late-anchor');
  await handler.handle('test', chatId, 'ZDRAVO SAKAM DA KUPAM DVOSOBNO STANCE VO AERODROM');
  await handler.handle('test', chatId, 'DO 150000');
  const firstServe = sent[sent.length - 1] ?? '';
  assert.match(firstServe, /Аеродром/u, `the first serve is the area asked for: ${firstServe}`);

  await handler.handle('test', chatId, 'VO BLIZINA NA KATOLICKA');
  const s = sessions.get(chatId)!;
  const answer = sent[sent.length - 1] ?? '';
  assert.equal(s.state, 'presentation');
  assert.match(String(s.slots.poiAnchor), /католичка|katolicka/iu, 'the place steers the search now');
  assert.equal(s.slots.location, 'Центар', `the place re-pins the area: ${s.slots.location}`);
  assert.match(answer, /Евидентен број 202/u, `the flat nearest the church leads: ${answer}`);
  assert.match(answer, /Евидентен број 201/u, `the second nearest is the pair: ${answer}`);
  assert.ok(!/Евидентен број 20[346]/u.test(answer),
    `no Аеродром/Карпош card answers a «близина на Католичка» turn: ${answer}`);
  assert.ok(answer.indexOf('202') < answer.indexOf('201'), `nearest-first: ${answer}`);
  assert.ok(!/немам|ги погледнавме/iu.test(answer),
    `and it IS a serve, not an empty-area line: ${answer}`);
});

test('the landmark named once the criteria are in (before any serve) serves too', async () => {
  // The same rule one step earlier: service + bedrooms + budget are in, nothing
  // has been presented yet, and the client points at the church. Discovery used
  // to answer «Во ред, ги забележав Вашите критериуми» and stay there.
  const { handler, sessions, sent, chatId } = makeHandler(KATOLICKA_ROWS, 'late-discovery');
  await handler.handle('test', chatId, 'ZDRAVO SAKAM DA KUPAM DVOSOBNO STANCE');
  await handler.handle('test', chatId, 'DO 150000');
  assert.equal(sessions.get(chatId)!.state, 'discovery', 'the area is still missing — she asks for it');

  await handler.handle('test', chatId, 'VO BLIZINA NA KATOLICKA');
  const s = sessions.get(chatId)!;
  const answer = sent[sent.length - 1] ?? '';
  assert.equal(s.state, 'presentation', 'the place completes the search');
  assert.ok(!/ги забележав/iu.test(answer), `no spec-sheet dead-end: ${answer}`);
  assert.match(answer, /Евидентен број 202/u, `the nearest flat leads: ${answer}`);
  assert.match(answer, /Евидентен број 201/u, `the pair is the two nearest: ${answer}`);
});

test('repeating the same place continues the pair queue — it never restarts it', async () => {
  // A repeat is not a new search: the ladder key carries the anchor, so the
  // echoed place serves what is still unshown near it instead of re-serving the
  // pair just handed over (the loop the funnel is forever fixed for).
  const { handler, sessions, sent, chatId } = makeHandler(KATOLICKA_ROWS, 'echo-anchor');
  await handler.handle('test', chatId, 'ZDRAVO SAKAM DA KUPAM DVOSOBNO STANCE VO BLIZINA NA KATOLICKA');
  await handler.handle('test', chatId, 'DO 150000');
  const first = sent[sent.length - 1] ?? '';
  assert.match(first, /Евидентен број 202/u, `first pair: ${first}`);

  await handler.handle('test', chatId, 'VO BLIZINA NA KATOLICKA');
  const second = sent[sent.length - 1] ?? '';
  assert.ok(!/Евидентен број 202/u.test(second),
    `the echo must not re-serve the pair just shown: ${second}`);
  assert.ok(!/Евидентен број 201/u.test(second),
    `neither half of it: ${second}`);
  assert.match(second, /Евидентен број 205/u,
    `it walks on to the remaining Центар flat: ${second}`);
});

test('a place the map cannot find keeps the neighborhood question — no silent stall', async () => {
  // The honesty twin of the capture: if the wish does not verify, it must not
  // land in the slots (both the ask and slotsComplete read the anchor as the
  // LOCATION answer), or the funnel would go quiet with no geography at all.
  const { handler, sessions, sent, chatId } = makeHandler(KATOLICKA_ROWS, 'zuluftar-intake');
  await handler.handle('test', chatId, 'ZDRAVO SAKAM DA KUPAM DVOSOBNO STANCE VO BLIZINA NA ZULUFTAR');
  await handler.handle('test', chatId, 'DO 150000');
  const s = sessions.get(chatId)!;
  const answer = sent[sent.length - 1] ?? '';
  assert.equal(s.slots.poiAnchor, undefined, 'an unplaceable wish never becomes an anchor');
  assert.equal(s.state, 'discovery', 'without a location the search cannot serve yet');
  assert.match(answer, /населба|дел од градот|lokacija|локација/iu,
    `she asks for the area instead of pretending: ${answer}`);
});

test('the served pair is the flat AT the anchor', async () => {
  const { handler, sessions, sent, chatId } = makeHandler();
  await handler.handle('test', chatId, MSG_INTAKE);
  await handler.handle('test', chatId, 'SAKAM DA KUPAM');
  await handler.handle('test', chatId, 'EDNA SPALNA');
  await handler.handle('test', chatId, 'DO 110000');
  const answer = sent[sent.length - 1] ?? '';
  const s = sessions.get(chatId)!;
  assert.equal(s.state, 'presentation');
  assert.match(answer, /Евидентен број 104/u,
    `the flat on Ул. Буњаковец (104) must win over the cheaper Карпош row: ${answer}`);
  assert.ok(!/Евидентен број 105/u.test(answer), `the Карпош row is not the pair: ${answer}`);
});

// ── THE [18:34] CAPTURE — «MI TREBA STAN KAJ CITY MALL ZA STUDENT» ──────────
//   [18:34] MI TREBA STAN KAJ CITY MALL ZA STUDENT
//   [18:34] ЛИНА: … за купување или повеќе Ве интересира изнајмување?
//   [18:35] DA IZNAJMAM
//   [18:35] ЛИНА: Имате ли омилена локација или конкретен дел од градот…?
// The client named City Mall in the FIRST message; the funnel asked him for a
// location anyway. The extractor hands the place over folded to CYRILLIC
// («цитy малл») while the map stores it in Latin («Skopje City Mall»), and the
// coverage guard compared the two word lists across scripts — no shared word,
// no place, and the anchor never reached the session.
const CITY_MALL_ROWS: Property[] = [
  // 10 m from the mall, rent, in budget — the flat the capture was looking for.
  { eb: 48, id: 48, location: 'Карпош III', address: 'Ул. Роберт Кох 4', price: 250, bedrooms: 3, sqm: 70, size: '70 м²', service: 'rent', lat: 42.0042, lon: 21.3917 },
  { eb: 49, id: 49, location: 'Карпош III', address: 'Ул. Роберт Кох 6', price: 380, bedrooms: 2, sqm: 55, size: '55 м²', service: 'rent', lat: 42.0048, lon: 21.3923 },
];

test('[18:34] «STAN KAJ CITY MALL» is a location answer — intake and service turn never re-ask the area', async () => {
  const { handler, sessions, sent, chatId } = makeHandler(CITY_MALL_ROWS, 'city-mall-intake');
  await handler.handle('test', chatId, 'MI TREBA STAN KAJ CITY MALL ZA STUDENT');
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.poiAnchor, 'Skopje City Mall', 'the Latin map place resolves from the client\'s Latin words');
  assert.ok(s.slots.location, 'the place also seeds the area');
  assert.ok(!/населба|дел од градот|локација во градот/iu.test(sent[0]),
    `the first reply must not ask for a location he just named: ${sent[0]}`);

  await handler.handle('test', chatId, 'DA IZNAJMAM');
  assert.match(sent[1], /спалн|spaln/iu, `bedrooms asked instead: ${sent[1]}`);
  assert.ok(!/населба|дел од градот|локација во градот/iu.test(sent[1]),
    `the area is never re-asked: ${sent[1]}`);

  await handler.handle('test', chatId, 'DO 400 EVRA');
  await handler.handle('test', chatId, 'NEBITNO ZA SPALNI');
  const serve = sent[sent.length - 1];
  assert.match(serve, /Евидентен број 48[\s\S]*од Скопје Сити Мол/, `the flat is served near the mall: ${serve}`);
  // ONE PLACE, SAID ONCE PER CARD: the landmark sentence and the anchor
  // sentence may not name the same mall twice (two spellings read as two
  // different places). The anchor line — with the measured distance — stays.
  assert.doesNotMatch(serve, /во близина на[^.]*Сити Мол/iu, serve);
  assert.doesNotMatch(serve, /Skopje City Mall/, serve);
});

// ── THE [18:56] CAPTURE — «STANCE ZA PRODAVANJE KAJ DRZAVNA BOLNICA?» ───────
//   [18:56] ZDRAVO STANCE ZA PRODAVANJE KAJ DRZAVNA BOLNICA?
//   [18:57] ЛИНА [без LLM]: Имате ли омилена локација или конкретен дел од
//            градот каде што го барате станот?
// The client named the state hospital — the place Skopjani mean when they say
// «државна болница», the УКЦ „Мајка Тереза“ complex. The map carried the
// complex's twenty individual clinics but NOT the complex itself, and the
// alias table knew only «воена болница», so no pass could place it: the wish
// died, no anchor reached the session, and the funnel asked for a
// neighborhood. The row now lives in the overrides file and the colloquial
// name is an alias for it.
const BOLNICA_ROWS: Property[] = [
  // 200 m from the complex, at the top of the client's budget.
  { eb: 61, id: 61, location: 'Центар', address: 'Ул. Водњанска 12', price: 95000, bedrooms: 2, sqm: 58, size: '58 м²', service: 'buy', lat: 41.9880, lon: 21.4240 },
  // 400 m away, the second option in Центар.
  { eb: 62, id: 62, location: 'Центар', address: 'Ул. Водњанска 30', price: 108000, bedrooms: 2, sqm: 60, size: '60 м²', service: 'buy', lat: 41.9869, lon: 21.4231 },
  // Cheaper — but across the river: the anchor must outrank it.
  { eb: 63, id: 63, location: 'Карпош', address: 'Ул. Карпош 9', price: 82000, bedrooms: 2, sqm: 57, size: '57 м²', service: 'buy', lat: 42.0050, lon: 21.4100 },
];

test('[18:56] «KAJ DRZAVNA BOLNICA» is a location answer — the state hospital is the clinical centre', async () => {
  const { handler, sessions, sent, chatId } = makeHandler(BOLNICA_ROWS, 'drzavna-bolnica-intake');
  await handler.handle('test', chatId, 'ZDRAVO STANCE ZA PRODAVANJE KAJ DRZAVNA BOLNICA?');
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.poiAnchor, 'Клинички центар',
    'the colloquial state hospital resolves to the complex the map now holds');
  assert.equal(s.slots.service, 'buy', 'ZA PRODAVANJE is flats for SALE');
  assert.ok(s.slots.location, `the place seeds the area, got ${s.slots.location}`);
  assert.ok(!/населба|дел од градот|омилена локација/iu.test(sent[0]),
    `no location question for a place he just named: ${sent[0]}`);

  await handler.handle('test', chatId, 'EDNA SPALNA');
  await handler.handle('test', chatId, 'DO 110000');
  const serve = sent[sent.length - 1];
  assert.match(serve, /Евидентен број 61/u, `the flat at the hospital is served: ${serve}`);
  assert.ok(!/Евидентен број 63/u.test(serve), `the cheaper Карпош row is not: ${serve}`);
});

// ── THE [20:49] CAPTURE — «MI TREBA STAN KAJ CITY MOL» ─────────────────────
//   [20:49] MI TREBA STAN KAJ CITY MOL
//   [20:49] ЛИНА: … купување или изнајмување …?
//   [20:49] DA KUPAM SAKAM
//   [20:50] ЛИНА [без LLM]: Кој конкретен дел од градот го имате предвид …?
// The client wrote MOL — the Macedonian word for a mall — where the earlier
// capture wrote MALL. The extractor hands over «цитy мол»; the map holds
// «Сити Мол» and «Skopje City Mall». The same English word is spelled city /
// siti / сити and mall / mol / мол, and the coverage guard compared the raw
// words: [city, mol] equalled neither [siti, mol] nor [skopje, city, mall], so
// the resolved mall was thrown away and the funnel asked for the area he had
// just named.
const CITY_MOL_ROWS: Property[] = [
  { eb: 91, id: 91, location: 'Карпош III', address: 'Ул. Роберт Кох 4', price: 110000, bedrooms: 2, sqm: 58, size: '58 м²', service: 'buy', lat: 42.0042, lon: 21.3917 },
  { eb: 92, id: 92, location: 'Карпош III', address: 'Ул. Роберт Кох 6', price: 118000, bedrooms: 2, sqm: 60, size: '60 м²', service: 'buy', lat: 42.0048, lon: 21.3923 },
  // Cheaper, same profile — three kilometres away: the anchor must outrank it.
  { eb: 93, id: 93, location: 'Аеродром', address: 'Ул. Јане Сандански 20', price: 88000, bedrooms: 2, sqm: 57, size: '57 м²', service: 'buy', lat: 41.9800, lon: 21.4500 },
];

test('[20:49] «STAN KAJ CITY MOL» is the same mall as «CITY MALL» — one spelling family, one place', async () => {
  const { handler, sessions, sent, chatId } = makeHandler(CITY_MOL_ROWS, 'city-mol-intake');
  await handler.handle('test', chatId, 'MI TREBA STAN KAJ CITY MOL');
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.poiAnchor, 'Skopje City Mall', 'MOL binds to the mall the map holds');
  assert.ok(s.slots.location, `the place seeds the area, got ${s.slots.location}`);
  assert.ok(!/населба|дел од градот|омилена локација/iu.test(sent[0]),
    `no location question for the place he just named: ${sent[0]}`);

  await handler.handle('test', chatId, 'DA KUPAM SAKAM');
  assert.match(sent[1], /спалн|spaln/iu, `bedrooms asked instead: ${sent[1]}`);
  assert.ok(!/дел од градот|населба/iu.test(sent[1]), `the area is never re-asked: ${sent[1]}`);

  await handler.handle('test', chatId, 'EDNA SPALNA');
  await handler.handle('test', chatId, 'DO 120000');
  const serve = sent[sent.length - 1];
  assert.match(serve, /Евидентен број 91/u, `the flat at the mall is served: ${serve}`);
  assert.match(serve, /Сити Мол/u, `the anchor is named the way the operator writes it: ${serve}`);
  assert.ok(!/Евидентен број 93/u.test(serve), `the cheaper Аеродром row is not: ${serve}`);
});
