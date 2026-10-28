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
 * The map of Skopje puts the church at 41.9947, 21.4164 (Центар).
 */
const MSG_KATOLICKA_INTAKE = 'ZDRAVO SAKAM DA KUPAM DVOSOBNO STANCE VO REONOT NA KATOLICKA';
const KATOLICKA_ROWS: Property[] = [
  { eb: 202, id: 202, location: 'Центар', address: 'Ул. Никола Вапцаров 5', price: 139000, bedrooms: 2, sqm: 58, size: '58 м²', service: 'buy', lat: 41.9940, lon: 21.4160 },
  { eb: 201, id: 201, location: 'Центар', address: 'Ул. Македонија 3', price: 148000, bedrooms: 2, sqm: 62, size: '62 м²', service: 'buy', lat: 41.9952, lon: 21.4171 },
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
    `nearest-first: 202 (≈80 m) before 201 (≈90 m): ${answer}`);
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
