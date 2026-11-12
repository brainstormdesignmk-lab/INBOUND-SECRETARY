// THE [01:48]–[01:51] FIELD CAPTURE, end to end.
//
// The client was anchored on Броз Кафе (the pair on screen sat 260 m and 540 m
// from it) and asked four things in a row:
//
//   [01:48] ДРУГО НЕШТО ИМА ?            → «нема поевтини … соседните населби»
//   [01:49] НЕМОРА ПОЕФТИНИ ДАЈ МИ ПОСКАПО АКО ИМА
//                                        → two flats 5 km away, «соседните населби»
//   [01:50] МИСЛЕВ ПОСКАПО КАЈ БРОЗ КАФЕ → the visit-FEE rationale
//   [01:50] ПОСКАПИ ОД 180000 СО ДВЕ СПАЛНИ
//   [01:51] ДО 200 000 МОЖЕ СЛОБОДНО     → «Сопственикот ја одредува сумата…»
//
// Every one of those turns was answered in the wrong lane: a cheaper search he
// never asked for, the city-wide pool under the name of "neighbouring
// neighbourhoods", the fee ladder for a price-direction word, and the owner-sets-
// prices pitch for a budget WINDOW. These tests drive the real handler.

import { test } from 'node:test';
import assert from 'node:assert/strict';
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
import { InboundHandler } from '../src/handlers/inbound';
import { LlmClient } from '../src/llm/types';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';
import {
  detectCheaperSearch, detectFeeComplaint, detectInvestmentOpinion, detectNegotiate,
  detectPriceFloor, detectMultiVisitIntent, detectBudgetUpAsk,
} from '../src/llm/deterministic';

const cfg = loadConfig();

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('probe: LLM disabled'); }
}

// Броз Кафе, from the offline map DB (the same place the field chat anchored).
const BROZ = { lat: 42.0002123, lon: 21.4170894 };

const ROWS: Property[] = [
  // The pair on screen: 260 m and 540 m from Броз Кафе.
  { eb: 66, id: 66, location: 'Центар', address: 'Рузвелтова 66', price: 137000, bedrooms: 2, sqm: 79, size: '79 м²', service: 'buy', lat: BROZ.lat + 0.0024, lon: BROZ.lon + 0.0006, geo_source: 'google_cached', details: '' },
  { eb: 84, id: 84, location: 'Центар', address: 'Рузвелтова 84', price: 117000, bedrooms: 2, sqm: 48, size: '48 м²', service: 'buy', lat: BROZ.lat + 0.0049, lon: BROZ.lon + 0.0012, geo_source: 'google_cached', details: '' },
  // The dearer neighbour INSIDE the walk radius — the answer he asked for.
  { eb: 42, id: 42, location: 'Центар', address: 'Улица 42', price: 195000, bedrooms: 2, sqm: 80, size: '80 м²', service: 'buy', lat: BROZ.lat + 0.0015, lon: BROZ.lon + 0.0020, geo_source: 'google_cached', details: '' },
  // …and the two far rows the capture served instead (Ново Лисиче, Водно).
  // A three-room („две спални") unit inside the money window, near the place.
  { eb: 63, id: 63, location: 'Центар', address: 'Улица 63', price: 190000, bedrooms: 3, sqm: 85, size: '85 м²', service: 'buy', lat: BROZ.lat + 0.0018, lon: BROZ.lon + 0.0009, geo_source: 'google_cached', details: '' },
  // A second three-room unit inside the window — the cap turn's next option.
  { eb: 70, id: 70, location: 'Центар', address: 'Улица 70', price: 185000, bedrooms: 3, sqm: 82, size: '82 м²', service: 'buy', lat: BROZ.lat + 0.0027, lon: BROZ.lon + 0.0011, geo_source: 'google_cached', details: '' },
  { eb: 87, id: 87, location: 'Ново Лисиче', address: 'Улица 87', price: 95000, bedrooms: 2, sqm: 77, size: '77 м²', service: 'buy', lat: 41.9643, lon: 21.4913, geo_source: 'google_cached', details: '' },
  { eb: 51, id: 51, location: 'Водно', address: 'Улица 51', price: 99000, bedrooms: 2, sqm: 70, size: '70 м²', service: 'buy', lat: 41.9890, lon: 21.4040, geo_source: 'google_cached', details: '' },
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
  } as never);
  const chatId = 'broz';
  const say = async (m: string): Promise<string> => {
    sent.length = 0;
    await handler.handle('test', chatId, m);
    return sent.at(-1) ?? '';
  };
  // The state the capture was in: the pair presented, anchored on the place.
  const seed = () => {
    const s = freshSession('test', chatId);
    s.state = 'closing';
    s.slots.service = 'buy';
    s.slots.currentBatch = [66, 84];
    s.slots.presentedIds = [66, 84];
    s.slots.poiAnchor = 'Broz Cafe';
    s.slots.bedrooms = 2;
    s.slots.budget = '180000';
    s.slots.location = 'Центар';
    s.slots.viewingFeeAgreed = true;
    s.slots.feeDisclosed = true;
    s.slots.name = 'Марко';
    s.slots.phone = '076845234';
    sessions.set(s);
    return s;
  };
  return { sessions, chatId, say, seed };
}

test('[field] the four detectors stand where the client stood', () => {
  // «ДРУГО НЕШТО ИМА?» is a MORE-OPTIONS ask, not a cheaper one.
  assert.equal(detectCheaperSearch('ДРУГО НЕШТО ИМА ?'), false);
  // …and a real cheaper ask still is one.
  assert.equal(detectCheaperSearch('барам нешто поевтино'), true);
  // A dismissed cheaper with a dearer ask is the UP direction.
  assert.equal(detectCheaperSearch('НЕМОРА ПОЕФТИНИ ДАЈ МИ ПОСКАПО АКО ИМА'), false);
  assert.equal(detectBudgetUpAsk('НЕМОРА ПОЕФТИНИ ДАЈ МИ ПОСКАПО АКО ИМА'), true);
  // A price-direction word is NEVER a visit-fee complaint (the fee ladder).
  assert.equal(detectFeeComplaint('МИСЛЕВ ПОСКАПО КАЈ БРОЗ КАФЕ'), false);
  assert.equal(detectFeeComplaint('НЕМОРА ПОЕФТИНИ ДАЈ МИ ПОСКАПО АКО ИМА'), false);
  // …while a real fee complaint keeps its lane.
  assert.equal(detectFeeComplaint('500 денари се многу за посета'), true);
  // A budget floor + a criterion is a SEARCH, not a market opinion.
  assert.equal(detectInvestmentOpinion('ПОСКАПИ ОД 180000 СО ДВЕ СПАЛНИ'), false);
  assert.equal(detectInvestmentOpinion('становите се поскапеа'), true);
  // A stated cap is a budget, not a counter-offer.
  assert.equal(detectNegotiate('ДО 200 000 МОЖЕ СЛОБОДНО'), false);
  assert.equal(detectNegotiate('ke dadam 120000'), true);
  // The floor itself.
  assert.equal(detectPriceFloor('ПОСКАПИ ОД 180000 СО ДВЕ СПАЛНИ'), '180000');
  assert.equal(detectPriceFloor('поскапи од 180.000 евра'), '180000');
  assert.equal(detectPriceFloor('над 1500 евра за м²'), undefined, 'a rate is not a floor');
  assert.equal(detectPriceFloor('сакам поскап стан'), undefined, 'no amount, no floor');
  // A plural viewing of two NAMED flats is a route, the «посети» verb included.
  assert.equal(detectMultiVisitIntent('САКАМ ДА ГИ ПОСЕТАМ 66 И 84'), true);
  assert.equal(detectMultiVisitIntent('сакам да го посетам 66'), false, 'one flat stays single');
});

test('[field] «ДРУГО НЕШТО ИМА ?» searches, never the cheaper pitch', async () => {
  const h = makeHandler();
  h.seed();
  const answer = await h.say('ДРУГО НЕШТО ИМА ?');
  assert.doesNotMatch(answer, /поевтини/iu, `no cheaper pitch: ${answer}`);
  assert.doesNotMatch(answer, /помали станови во истата населба/iu, `no cheaper choice ask: ${answer}`);
  // Either the next nearby pair, or the honest "that is all" line — a SEARCH
  // answer, never the visit fee (the closing black hole).
  assert.doesNotMatch(answer, /500 денари|провизија/iu, `not the fee: ${answer}`);
});

test('[field] «дај ми поскапо» serves the dearer NEIGHBOUR, near the place', async () => {
  const h = makeHandler();
  h.seed();
  const answer = await h.say('НЕМОРА ПОЕФТИНИ ДАЈ МИ ПОСКАПО АКО ИМА');
  assert.match(answer, /42/u, `the dearer flat near Броз Кафе: ${answer}`);
  assert.match(answer, /195\.000|195,000/u, answer);
  assert.match(answer, /Броз Кафе/u, `the place is named on the card: ${answer}`);
  // The far rows are NOT "neighbouring neighbourhoods" of Центар.
  assert.doesNotMatch(answer, /87|51/u, `no 5 km rows: ${answer}`);
  assert.doesNotMatch(answer, /поевтини/iu, answer);
});

test('[field] «мислев поскапо кај Броз Кафе» is a dearer search, not the fee line', async () => {
  const h = makeHandler();
  h.seed();
  const answer = await h.say('МИСЛЕВ ПОСКАПО КАЈ БРОЗ КАФЕ');
  // The comparative is a price DIRECTION: the pricier neighbour near the place.
  assert.match(answer, /42/u, `the dearer nearby flat: ${answer}`);
  assert.doesNotMatch(answer, /надомест|симболичн|500 денари/iu, `not the visit fee: ${answer}`);
  assert.doesNotMatch(answer, /Да барам истите критериуми/iu, `no confirm-instead-of-search: ${answer}`);
});

test('[field] a budget floor then a cap is ONE window, never the owner-sets-prices pitch', async () => {
  const h = makeHandler();
  h.seed();
  const asked = await h.say('ПОСКАПИ ОД 180000 СО ДВЕ СПАЛНИ');
  assert.doesNotMatch(asked, /пазарот диктира|Сопственикот ја одредува сумата|посредници/iu,
    `a search, not an opinion: ${asked}`);
  // «две спални» = a three-room flat, and the row above the floor is served
  // with its distance to the place the client named.
  assert.match(asked, /63/u, `the flat above the floor: ${asked}`);
  assert.match(asked, /190\.000|190,000/u, asked);
  assert.match(asked, /Броз Кафе/u, asked);
  const s = h.sessions.get(h.chatId)!;
  assert.equal(s.slots.priceMin, '180000', 'the floor is banked');

  const capped = await h.say('ДО 200 000 МОЖЕ СЛОБОДНО');
  const s2 = h.sessions.get(h.chatId)!;
  assert.equal(s2.slots.priceMin, '180000', 'the cap above the floor keeps it');
  assert.equal(s2.slots.budget, '200000', 'the ceiling is the cap');
  assert.doesNotMatch(capped, /Сопственикот ја одредува сумата|посредници|пазарот диктира/iu, capped);
  // The rows inside the window were served on the floor turn, so the cap either
  // offers the next one or says the area is drained AND keeps the funnel open
  // — never the empty-system claim («Моментално во системот нема … до
  // 200.000») over rows it just showed. CONTRACT, not a wording: the drained
  // family rotates (that is not a failure), the lie and the dead end are.
  assert.doesNotMatch(capped, /Моментално во системот нема/iu, `no empty-system lie: ${capped}`);
  assert.match(capped, /прошириме|забележам|известам|70/u, `the funnel stays open: ${capped}`);
});

test('[field] the two-flat info line counts BEDROOMS, not rooms', async () => {
  const h = makeHandler();
  h.seed();
  // Both rows carry the feed's ROOM count (2 = двособен = ONE спална). The op
  // card printed «двособен … 3 спални» in the field (the same +1).
  const answer = await h.say('САКАМ ДА ПРАШАМ ЗА СТАН СО ЕВИДЕНТЕН БРОЈ 66 И 84');
  assert.match(answer, /66/u, answer);
  assert.match(answer, /84/u, answer);
  assert.match(answer, /една спална/u, `one bedroom per двособен: ${answer}`);
  assert.doesNotMatch(answer, /3 спални|три спални/u, `never the room count sold as bedrooms: ${answer}`);
});

test('[field] «сакам да ги посетам 66 и 84» is a two-flat wish, not an info card', async () => {
  const h = makeHandler();
  h.seed();
  const answer = await h.say('САКАМ ДА ГИ ПОСЕТАМ 66 И 84');
  assert.doesNotMatch(answer, /За кој од нив сакате повеќе детали/iu,
    `no "which one?" card: ${answer}`);
  assert.equal(h.sessions.get(h.chatId)!.slots.visitWanted, true, 'the plural wish is banked');
});

test('[field] the two-flat visit fee names BOTH flats and the per-property total', async () => {
  const h = makeHandler();
  const s = h.seed();
  // The capture's state: the pair on screen and EB 66 the last subject.
  s.slots.propertyId = 66;
  // …and the fee not yet agreed.
  s.slots.viewingFeeAgreed = undefined;
  s.slots.feeDisclosed = undefined;
  h.sessions.set(s);
  const answer = await h.say('САКАМ ДА ДИ ВИДАМ ВО ЖИВО ДВАТА');
  assert.match(answer, /66/u, `first flat named: ${answer}`);
  assert.match(answer, /84/u, `second flat named: ${answer}`);
  // 500 ден each → 1.000 in total.
  assert.match(answer, /1\.000|1000/u, `per-property arithmetic: ${answer}`);
  assert.match(answer, /Дали се согласувате/iu, `the fee question stays open: ${answer}`);
});
