// THE [18:41] SEEN-LISTING RECALL — «ИМАВТЕ ЕДНА КУЌА НАКАЈ СКОПЈЕ СЕВЕР .
// ОКОЛУ 130 000 БЕШЕ» … «ДАЛИ УШТЕ СЕ ПРОДАВА ?» — was answered with the
// discovery bedroom question («Колку спални соби би биле идеални за куќата…»):
// a question for a NEW search, at a client who had just described the listing
// he saw. The contract now:
//   1. the recalled category + area + price is the description → the bank's
//      matching rows are served in HELP mode (his listing, "is one of these
//      the one you saw?"), never a criteria grill;
//   2. the serve stays inside the category he named (a house recall never
//      surfaces a flat, and a flat recall never surfaces a house);
//   3. a sale frame keeps rent rows out of a «дали уште се продава?» serve;
//   4. nothing matching → the honest no-match line, never an invented row;
//   5. a PRESENT-tense search («imate li kukja vo …?») never enters this lane.

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
import { detectSeenListingRecall, detectDescribeAsk } from '../src/llm/deterministic';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore, writeMap } from '../src/geo/offlineMap';
import { AVAILABILITY_CLAIM } from './helpers/availability-contract';
import * as os from 'os';
import * as path from 'path';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429'); }
}

// Скопје Север: two houses near the remembered 130.000, a RENT house at the
// same money (a sale ask must not serve it), a flat at the same money (a house
// recall must not serve it), and a house far above the remembered price.
const ROWS: Property[] = [
  { eb: 47, id: 47, location: 'Скопје Север', price: 128000, service: 'buy', house: true, sqm: 140, size: '140 м²', address: 'Визбегово' },
  { eb: 52, id: 52, location: 'Скопје Север', price: 133000, service: 'buy', house: true, sqm: 120, size: '120 м²', address: 'Сингелиќ' },
  { eb: 62, id: 62, location: 'Скопје Север', price: 130000, service: 'rent', house: true, sqm: 140, size: '140 м²', address: 'Визбегово' },
  { eb: 61, id: 61, location: 'Скопје Север', price: 129000, service: 'buy', sqm: 68, size: '68 м²', address: 'Визбегово' },
  { eb: 70, id: 70, location: 'Скопје Север', price: 300000, service: 'buy', house: true, sqm: 200, size: '200 м²', address: 'Сингелиќ' },
] as any;

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getById(eb: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === eb || r.id === eb);
  }
  get healthy(): boolean { return true; }
}

function makeHandler(rows: Property[] = ROWS) {
  const db = new Db(':memory:');
  const cfg = loadConfig();
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, t: string) => { sent.push(t); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, new FakeProps(rows)),
    responder: new Responder(new FailingLlm(), cfg),
    properties: new FakeProps(rows),
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
  } as never);
  return { handler, sessions, sent };
}

const chat = 'house-recall-client';
const BEDROOMS_ASK = /Колку спални соби/u;
const CARD = /Евидентен број \d/u;
const RECALL = 'IMAVTE EDNA KUKJA NAKAJ SKOPJE SEVER . OKOLU 130 000 BESE\n\nDALI USTE SE PRODAVA ?';

test('[18:41] the recall detector needs the past tense + a determiner + a category', () => {
  assert.equal(detectSeenListingRecall(RECALL), true);
  assert.equal(detectSeenListingRecall('ИМАВТЕ ЕДНА КУЌА НАКАЈ СКОПЈЕ СЕВЕР'), true);
  assert.equal(detectSeenListingRecall('imavte edna garsonjera kaj crnogorska ambasada'), true);
  // A SEARCH (present tense, bare category) is never a recall.
  assert.equal(detectSeenListingRecall('IMATE LI KUKJA VO SKOPJE SEVER?'), false);
  assert.equal(detectSeenListingRecall('imavte li kukja vo skopje sever'), false);
  assert.equal(detectSeenListingRecall('sakam da kupam kukja vo skopje sever'), false);
});

test('[19:44] «ZA 130 000» — a price grouped in thousands is not an Евидентен број', async () => {
  const { handler, sessions, sent } = makeHandler();

  await handler.handle('test', chat, 'ZDRAVO. IMAVTE EDNA KUKJA VO SKOPJE SEVER ZA 130 000\n\nDALI USTE SE PRODAVA TOA ?');
  const s = sessions.get(chat)!;
  const r = sent[sent.length - 1];

  // inferPropertyId() reads the price's thousands group as EB 130 — the lane
  // must not be disabled by it (the [19:44] capture answered the bedrooms ask).
  assert.ok(!BEDROOMS_ASK.test(r), `no criteria grill on a recalled house: ${r}`);
  assert.ok(CARD.test(r), `the houses at that money are served: ${r}`);
  assert.ok(r.includes('Евидентен број 47') && r.includes('Евидентен број 52'),
    `the two for-sale houses near 130.000: ${r}`);
  assert.ok(!r.includes('Евидентен број 61'), `never the flat: ${r}`);
  assert.ok(!r.includes('Евидентен број 62'), `never the rental house on a sale ask: ${r}`);
  assert.equal(s.state, 'property_locate');
});

test('[20:11] after a single-card serve, «dali se prodava uste?» is ANSWERED, never re-served', async () => {
  // The live capture: EB 44 was served with «Дали ова е куќата што ја видовте?»,
  // the client answered «taa bese» + «dali se prodava uste ?», and the same card
  // and question came back. One card on the table, no number in the text: the
  // question is availability, so the owner-lane ack answers it.
  const only = [{ eb: 44, id: 44, location: 'Скопје Север', price: 130000, service: 'buy', house: true, sqm: 150, size: '150 м²', address: 'Визбегово' }] as any;
  const { handler, sessions, sent } = makeHandler(only);

  await handler.handle('test', chat, 'ZDRAVO. IMAVTE EDNA KUKJA VO SKOPJE SEVER ZA 130 000\n\nDALI USTE SE PRODAVA TOA ?');
  const first = sent[sent.length - 1];
  assert.ok(/Евидентен број 44/u.test(first), `the house is served: ${first}`);
  assert.ok(/Дали ова е куќата што ја видовте/u.test(first), `with the pick question: ${first}`);

  await handler.handle('test', chat, 'taa bese\ndali se prodava uste ?');
  const s = sessions.get(chat)!;
  const second = sent[sent.length - 1];

  assert.ok(!/Евидентен број 44/u.test(second), `the card is not repeated: ${second}`);
  assert.ok(!/Дали ова е куќата што ја видовте/u.test(second), `the pick question is not repeated: ${second}`);
  assert.match(second, AVAILABILITY_CLAIM, `the availability answer: ${second}`);
  assert.equal(s.state, 'closing');
  assert.equal(s.slots.interestedPropertyId, 44);
  assert.equal(s.slots.ownerContactPending, true, 'the owner lane arms from the ack');
});

test('[20:58] referent information questions are descriptions, not unrelated information requests', () => {
  for (const text of [
    'koi informacii gi imas za nejze ?',
    'КОИ ИНФОРМАЦИИ ГИ ИМАТЕ ЗА НЕА?',
    'kakvi informacii imate za nego?',
    'кои информации имате за нив?',
  ]) assert.equal(detectDescribeAsk(text), true, text);
  for (const text of [
    'koi informacii gi imas za provizijata?',
    'кои информации имате за условите?',
    'што има во близина?',
  ]) assert.equal(detectDescribeAsk(text), false, text);
});

test('[20:58] an info request after recalling a single house serves its full database card', async () => {
  const only = [{ eb: 44, id: 44, location: 'Скопје Север', price: 130000, service: 'buy', house: true, sqm: 150, size: '150 м²', features: ['тераса'], address: 'Визбегово' }] as any;
  const { handler, sessions, sent } = makeHandler(only);

  await handler.handle('test', chat, 'IMAVTE EDNA KUKJA VO SKOPJE SEVER ZA 130 000');
  await handler.handle('test', chat, 'za prodazba');
  await handler.handle('test', chat, 'dali se prodava seuste?');
  await handler.handle('test', chat, 'mislam deka taa bese\nkoi informacii gi imas za nejze ?');
  const reply = sent[sent.length - 1];
  assert.match(reply, /Куќата под Евидентен број 44/u);
  assert.match(reply, /150 м²/u);
  assert.match(reply, /тераса/u, `the full stored facts, not the short locate card: ${reply}`);
  assert.doesNotMatch(reply, /Дали ова е куќата што ја видовте/u);
  assert.ok(sessions.get(chat)!.slots.presentedIds?.includes(44));
});

test('[20:58] an information question following a separate confirmation serves the house card', async () => {
  const only = [{ eb: 44, id: 44, location: 'Скопје Север', price: 130000, service: 'buy', house: true, sqm: 150, size: '150 м²', features: ['тераса'], address: 'Визбегово' }] as any;
  const { handler, sessions, sent } = makeHandler(only);
  await handler.handle('test', chat, 'IMAVTE EDNA KUKJA VO SKOPJE SEVER ZA 130 000');
  await handler.handle('test', chat, 'za prodazba');
  await handler.handle('test', chat, 'dali se prodava seuste?');
  await handler.handle('test', chat, 'mislam deka taa bese');
  await handler.handle('test', chat, 'koi informacii gi imas za nejze ?');
  const reply = sent[sent.length - 1];
  assert.match(reply, /Куќата под Евидентен број 44/u);
  assert.match(reply, /150 м²/u);
  assert.match(reply, /тераса/u);
  assert.doesNotMatch(reply, /Дали ова е куќата што ја видовте/u);
  assert.ok(sessions.get(chat)!.slots.presentedIds?.includes(44));
});

test('[18:41] house recall: the matching houses are served, never a bedrooms question', async () => {
  const { handler, sessions, sent } = makeHandler();

  await handler.handle('test', chat, RECALL);
  const s = sessions.get(chat)!;
  const r = sent[sent.length - 1];

  assert.ok(!BEDROOMS_ASK.test(r), `the criteria ask must never fire on a recalled listing: ${r}`);
  assert.ok(CARD.test(r), `the bank's matches are served: ${r}`);
  assert.ok(r.includes('Евидентен број 47') && r.includes('Евидентен број 52'),
    `the houses near the remembered price lead: ${r}`);
  assert.ok(!r.includes('Евидентен број 61'), `a flat must not take a house recall slot: ${r}`);
  assert.ok(!r.includes('Евидентен број 62'), `a rent house must not answer «уште се продава?»: ${r}`);
  assert.ok(!r.includes('Евидентен број 70'), `a house 170k away is not what he remembers: ${r}`);
  assert.ok(/што ја видовте|што го видовте/u.test(r), `the pick question moves the hunt on: ${r}`);
  assert.equal(s.state, 'property_locate');
  assert.deepEqual(s.slots.currentBatch, [47, 52]);
});

test('[18:41] the recall split in two messages still never reaches the discovery grill', async () => {
  const { handler, sessions, sent } = makeHandler();

  await handler.handle('test', chat, 'IMAVTE EDNA KUKJA NAKAJ SKOPJE SEVER . OKOLU 130 000 BESE');
  const first = sent[sent.length - 1];
  assert.ok(!BEDROOMS_ASK.test(first), `no bedrooms ask on the recalled house: ${first}`);
  // The first message carries no deal word: the ONE question she may ask is
  // buy-or-rent — a pair now would guess it (and a rent house at the same
  // money answered «уште се продава?»).
  assert.ok(!CARD.test(first), `no pair before the deal is known: ${first}`);
  assert.ok(/за продажба или за изнајмување/u.test(first), `the one sale-or-rent question: ${first}`);

  await handler.handle('test', chat, 'DALI USTE SE PRODAVA ?');
  const second = sent[sent.length - 1];
  assert.ok(!BEDROOMS_ASK.test(second), `no bedrooms ask on the availability follow-up: ${second}`);
  assert.ok(CARD.test(second), `the availability turn answers with rows: ${second}`);
  assert.ok(!second.includes('Евидентен број 61'), `still houses only: ${second}`);
  assert.ok(!second.includes('Евидентен број 62'), `never the RENTAL house on a sale ask: ${second}`);
  assert.equal(sessions.get(chat)!.slots.house, true);
});

// A PLAC recall: the land-plot category must lock exactly like house/business.
const PLAC_ROWS: Property[] = [
  { eb: 501, id: 501, location: 'Карпош', price: 60000, service: 'buy', plac: true, sqm: 400, size: '400 м²', address: 'Букурешка', lat: 42.0006, lon: 21.4402, geo_source: 'stored' },
  { eb: 502, id: 502, location: 'Карпош', price: 62000, service: 'buy', plac: true, sqm: 350, size: '350 м²', address: 'Букурешка', lat: 42.0030, lon: 21.4410, geo_source: 'stored' },
  { eb: 601, id: 601, location: 'Карпош', price: 59000, service: 'buy', sqm: 68, size: '68 м²', address: 'Букурешка', lat: 42.0003, lon: 21.4405, geo_source: 'stored' },
  { eb: 602, id: 602, location: 'Карпош', price: 60000, service: 'buy', house: true, sqm: 150, size: '150 м²', address: 'Букурешка', lat: 42.0005, lon: 21.4403, geo_source: 'stored' },
] as any;

// Commercial premises that are the SAME category but nowhere near the landmark
// (another municipality, ~4 km away): the alternatives fallback must run.
const BIZ_FAR_ROWS: Property[] = [
  { eb: 701, id: 701, location: 'Аеродром', price: 130000, service: 'buy', business: true, sqm: 90, size: '90 м²', address: 'Јане Сандански', lat: 41.9850, lon: 21.4640, geo_source: 'stored' },
  { eb: 702, id: 702, location: 'Аеродром', price: 131000, service: 'buy', business: true, sqm: 85, size: '85 м²', address: 'Јане Сандански', lat: 41.9855, lon: 21.4645, geo_source: 'stored' },
  { eb: 703, id: 703, location: 'Аеродром', price: 129000, service: 'buy', sqm: 68, size: '68 м²', address: 'Јане Сандански', lat: 41.9852, lon: 21.4642, geo_source: 'stored' },
] as any;

test('[18:41] a плац recall keeps the land-plot category — never a flat or a house', async () => {
  const { handler, sessions, sent, offlineMap } = makePlaceHandler(PLAC_ROWS);

  await handler.handle('test', chat, 'IMAVTE EDEN PLAC KAJ OLIMPIKO . OKOLU 60 000 BESE\n\nDALI USTE SE PRODAVA ?');
  const s = sessions.get(chat)!;
  const r = sent[sent.length - 1];

  assert.ok(r.includes('Евидентен број 501') && r.includes('Евидентен број 502'),
    `the plots at the place: ${r}`);
  assert.ok(!r.includes('Евидентен број 601'), `a flat must never take a plot slot: ${r}`);
  assert.ok(!r.includes('Евидентен број 602'), `a house must never take a plot slot: ${r}`);
  assert.ok(!BEDROOMS_ASK.test(r), `no bedrooms grill over a plot: ${r}`);
  assert.equal(s.slots.plac, true);
  assert.notEqual(s.slots.house, true);
  offlineMap.close();
});

test('[18:41] a business recall with nothing at the landmark offers same-category alternatives', async () => {
  const { handler, sent, offlineMap } = makePlaceHandler(BIZ_FAR_ROWS);

  await handler.handle('test', chat, 'IMAVTE EDEN LOKAL KAJ OLIMPIKO . OKOLU 130 000 BESE\n\nDALI USTE SE PRODAVA ?');
  const r = sent[sent.length - 1];

  assert.ok(/алтернативи/u.test(r), `the honest alternatives intro, not proximity: ${r}`);
  assert.ok(r.includes('Евидентен број 701'), `the premise with the same characteristics: ${r}`);
  assert.ok(!r.includes('Евидентен број 703'), `never the flat: ${r}`);
  offlineMap.close();
});

test('[18:41] a flat recall serves flats only — the category he named is a lock', async () => {
  const { handler, sessions, sent } = makeHandler();

  await handler.handle('test', chat, 'IMAVTE EDEN STAN NAKAJ SKOPJE SEVER . OKOLU 130 000 BESE\n\nDALI USTE SE PRODAVA ?');
  const r = sent[sent.length - 1];
  assert.ok(!BEDROOMS_ASK.test(r), `no criteria grill: ${r}`);
  assert.ok(r.includes('Евидентен број 61'), `the flat at the remembered money serves: ${r}`);
  assert.ok(!r.includes('Евидентен број 47') && !r.includes('Евидентен број 52'),
    `houses must not take a flat recall slot: ${r}`);
  // The category slot follows his word: not a house (never true), so every
  // later turn keeps serving flats.
  assert.notEqual(sessions.get(chat)!.slots.house, true);
});

test('[18:41] nothing at that area+price → the honest line, never an invented row', async () => {
  const { handler, sent } = makeHandler();

  await handler.handle('test', chat, 'IMAVTE EDNA KUKJA NAKAJ AERODROM . OKOLU 130 000 BESE\n\nDALI USTE SE PRODAVA ?');
  const r = sent[sent.length - 1];
  assert.ok(!CARD.test(r), `no cards when the bank holds nothing there: ${r}`);
  assert.ok(/Во моментов немам/u.test(r), `the honest no-match line: ${r}`);
  assert.ok(!BEDROOMS_ASK.test(r), `and still no criteria grill: ${r}`);
});

// ── THE LANDMARK-PLUS-PRICE VARIANT ─────────────────────────────────────────
// «имавте една куќа кај Олимпико, околу 130 000 беше»: the map place is the
// finer anchor, so the rows NEAREST it lead and the remembered price orders
// them — the same recalled listing, located from a landmark instead of a
// neighbourhood.
const PLACE_ROWS: Property[] = [
  { eb: 201, id: 201, location: 'Карпош', price: 128000, service: 'buy', house: true, sqm: 150, size: '150 м²', address: 'Букурешка', lat: 42.0006, lon: 21.4402, geo_source: 'stored' },
  { eb: 202, id: 202, location: 'Карпош', price: 132000, service: 'buy', house: true, sqm: 130, size: '130 м²', address: 'Букурешка', lat: 42.0032, lon: 21.4415, geo_source: 'stored' },
  { eb: 203, id: 203, location: 'Аеродром', price: 130000, service: 'buy', house: true, sqm: 160, size: '160 м²', address: 'Јане Сандански', lat: 41.9850, lon: 21.4640, geo_source: 'stored' },
  { eb: 204, id: 204, location: 'Карпош', price: 129000, service: 'buy', sqm: 68, size: '68 м²', address: 'Букурешка', lat: 42.0003, lon: 21.4405, geo_source: 'stored' },
] as any;

// Commercial rows around the same landmark: two for-sale premises at the
// remembered money, a RENTAL premise, and the far one in another municipality —
// plus the residential rows above, which a business recall must never serve.
const BIZ_PLACE_ROWS: Property[] = [
  { eb: 301, id: 301, location: 'Карпош', price: 130000, service: 'buy', business: true, sqm: 90, size: '90 м²', address: 'Букурешка', lat: 42.0006, lon: 21.4402, geo_source: 'stored' },
  { eb: 306, id: 306, location: 'Карпош', price: 131000, service: 'buy', business: true, sqm: 80, size: '80 м²', address: 'Букурешка', lat: 42.0030, lon: 21.4410, geo_source: 'stored' },
  { eb: 303, id: 303, location: 'Карпош', price: 130000, service: 'rent', business: true, sqm: 90, size: '90 м²', address: 'Букурешка', lat: 42.0008, lon: 21.4406, geo_source: 'stored' },
  { eb: 304, id: 304, location: 'Аеродром', price: 130000, service: 'buy', business: true, sqm: 95, size: '95 м²', address: 'Јане Сандански', lat: 41.9850, lon: 21.4640, geo_source: 'stored' },
  ...PLACE_ROWS,
] as any;

// The AREA variant with the feed actually holding that area: two for-sale
// premises, one rental premise, one flat and one house at the same money.
const BIZ_AREA_ROWS: Property[] = [
  { eb: 401, id: 401, location: 'Скопје Север', price: 130000, service: 'buy', business: true, sqm: 90, size: '90 м²', address: 'Визбегово' },
  { eb: 402, id: 402, location: 'Скопје Север', price: 128000, service: 'buy', business: true, sqm: 85, size: '85 м²', address: 'Визбегово' },
  { eb: 403, id: 403, location: 'Скопје Север', price: 130000, service: 'rent', business: true, sqm: 90, size: '90 м²', address: 'Визбегово' },
  { eb: 404, id: 404, location: 'Скопје Север', price: 129000, service: 'buy', sqm: 68, size: '68 м²', address: 'Визбегово' },
  { eb: 405, id: 405, location: 'Скопје Север', price: 128000, service: 'buy', house: true, sqm: 150, size: '150 м²', address: 'Визбегово' },
] as any;

function makePlaceHandler(rows: Property[] = PLACE_ROWS) {
  const dbPath = path.join(os.tmpdir(), `recall-place-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  writeMap(dbPath, [{ name: 'Олимпико', type: 'stadium', lat: 42.0009, lon: 21.4404, source: 'osm' }] as never, []);
  const offlineMap = new OfflineMapStore(dbPath);
  const db = new Db(':memory:');
  const cfg = loadConfig();
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, t: string) => { sent.push(t); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, new FakeProps(rows)),
    responder: new Responder(new FailingLlm(), cfg),
    properties: new FakeProps(rows),
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false, google: false, offlineMap }),
  } as never);
  return { handler, sessions, sent, offlineMap };
}

test('[18:41] a landmark-anchored recall is served from the place, ordered by the remembered price', async () => {
  const { handler, sessions, sent, offlineMap } = makePlaceHandler();

  await handler.handle('test', chat, 'IMAVTE EDNA KUKJA KAJ OLIMPIKO . OKOLU 130 000 BESE\n\nDALI USTE SE PRODAVA ?');
  const s = sessions.get(chat)!;
  const r = sent[sent.length - 1];

  assert.ok(!BEDROOMS_ASK.test(r), `no criteria grill at a recalled listing: ${r}`);
  assert.ok(/кај Олимпико/u.test(r), `the place he named is confirmed back: ${r}`);
  assert.ok(r.includes('Евидентен број 201') && r.includes('Евидентен број 202'),
    `the houses by the landmark, nearest first: ${r}`);
  assert.ok(!r.includes('Евидентен број 204'), `a flat must not take a house recall slot: ${r}`);
  assert.ok(!r.includes('Евидентен број 203'), `a house 4 km away is not by the landmark: ${r}`);
  assert.equal(s.state, 'property_locate');
  assert.equal(s.slots.poiAnchor, 'Олимпико', 'the landmark becomes the anchor');
  assert.equal(s.slots.location, 'Карпош', 'the area comes from the bank rows at the place');
  assert.deepEqual(s.slots.currentBatch, [201, 202]);
  offlineMap.close();
});

test('[18:41] landmark without a remembered price keeps the pre-existing anchored serve', async () => {
  const { handler, sessions, sent, offlineMap } = makePlaceHandler();

  await handler.handle('test', chat, 'IMAVTE EDNA KUKJA KAJ OLIMPIKO');
  const r = sent[sent.length - 1];
  assert.ok(r.includes('Евидентен број 201'), `the rows at the place are served: ${r}`);
  assert.ok(!r.includes('Евидентен број 204'), `never the flat: ${r}`);
  assert.ok(/по која цена/u.test(r), `the missing price is still probed: ${r}`);
  assert.equal(sessions.get(chat)!.slots.poiAnchor, 'Олимпико');
  offlineMap.close();
});

test('[18:41] a BUSINESS-space recall stays business-only — the category lock at a landmark', async () => {
  const { handler, sessions, sent, offlineMap } = makePlaceHandler(BIZ_PLACE_ROWS);

  await handler.handle('test', chat, 'IMAVTE EDEN LOKAL KAJ OLIMPIKO . OKOLU 130 000 BESE\n\nDALI USTE SE PRODAVA ?');
  const s = sessions.get(chat)!;
  const r = sent[sent.length - 1];

  assert.ok(r.includes('Евидентен број 301') && r.includes('Евидентен број 306'),
    `the for-sale premises at the place, nearest/closest price first: ${r}`);
  assert.ok(!r.includes('Евидентен број 303'), `a RENTAL premise must not answer «уште се продава?»: ${r}`);
  assert.ok(!r.includes('Евидентен број 304'), `a premise in another municipality is not by the place: ${r}`);
  assert.ok(!r.includes('Евидентен број 204'), `a flat must never take a commercial slot: ${r}`);
  assert.ok(!r.includes('Евидентен број 201') && !r.includes('Евидентен број 202'),
    `houses must never take a commercial slot: ${r}`);
  assert.ok(/деловен простор/u.test(r), `the commercial noun is spoken: ${r}`);
  assert.equal(s.slots.business, true);
  assert.notEqual(s.slots.house, true);
  offlineMap.close();
});

test('[18:41] a BUSINESS-space recall by AREA stays business-only too', async () => {
  const { handler, sessions, sent, offlineMap } = makePlaceHandler(BIZ_AREA_ROWS);

  // The deal is stated (a sale frame), so the RENTAL premise is excluded by
  // the service leg; with no deal word at all both legs may rank, which is the
  // pre-existing locate behaviour (see the split-path note in the fix summary).
  await handler.handle('test', chat, 'IMAVTE EDEN LOKAL NA KAJ SKOPJE SEVER . OKOLU 130 000 BESE\n\nDALI USTE SE PRODAVA ?');
  const s = sessions.get(chat)!;
  const r = sent[sent.length - 1];

  assert.ok(r.includes('Евидентен број 401') && r.includes('Евидентен број 402'),
    `the premises in the area he named: ${r}`);
  assert.ok(!r.includes('Евидентен број 403'), `a RENTAL premise must not answer «уште се продава?»: ${r}`);
  assert.ok(!r.includes('Евидентен број 404') && !r.includes('Евидентен број 405'),
    `a flat or a house must never take a commercial slot: ${r}`);
  assert.ok(!BEDROOMS_ASK.test(r), `no criteria grill: ${r}`);
  assert.equal(s.state, 'property_locate');
  assert.equal(s.slots.location, 'Скопје Север');
  assert.deepEqual(s.slots.currentBatch, [401, 402]);
  offlineMap.close();
});

test('[18:41] a present-tense search keeps its own funnel — the lane is recall-only', async () => {
  const { handler, sessions, sent } = makeHandler();

  await handler.handle('test', chat, 'IMATE LI KUKJA VO SKOPJE SEVER?');
  const s = sessions.get(chat)!;
  const r = sent[sent.length - 1];
  assert.ok(!CARD.test(r), `a search without criteria must not serve a pair: ${r}`);
  assert.ok(!s.slots.currentBatch?.length, 'no batch was presented');
  assert.ok(!BEDROOMS_ASK.test(r) || /купување или/u.test(r) || /цена/u.test(r),
    `the ordinary funnel stays in charge: ${r}`);
});

// ── THE SIZE-ONLY RECALL AT A PLACE (the [09:07] capture) ───────────────────
//
//   [09:07] IMAVTE EDEN STAN KAJ SJO SO DVE SPALNI ?
//   [09:07] ЛИНА: Ќе ја побарам оваа информација директно од сопственикот … во
//           меѓувреме, може ли да ми кажете кои карактеристики Ви се најклучни?  ✗
//
// EB 66 — a трисобен (две спални), 79 м² — stands opposite СЈО and costs
// 145.000, above the 120.000 the client set for his SEARCH. The budget dropped
// it from the pool, the funnel had nothing, and the client who asked whether we
// HAVE that flat got an owner-consult line plus a criteria questionnaire.
// The recall's own two facts (place + size) are the description: serve the rows
// with that room count at that place, over the cap if that is what they cost,
// and SAY they are over it.
const SJO_ROWS: Property[] = [
  { eb: 66, id: 66, location: 'Центар', price: 145000, service: 'buy', sqm: 79, bedrooms: 3, size: '79 м²', address: 'Рузвелтова', lat: 41.9990, lon: 21.4320, geo_source: 'stored' },
  // A гарсоњера 20 m closer: a wrong-size flat must never take the served slot.
  { eb: 90, id: 90, location: 'Центар', price: 40000, service: 'buy', sqm: 28, size: '28 м²', address: 'Рузвелтова', lat: 41.9992, lon: 21.4318, geo_source: 'stored' },
  // A three-room flat across town: never preferred over the one at the place.
  { eb: 51, id: 51, location: 'Водно', price: 105000, service: 'buy', sqm: 70, bedrooms: 3, size: '70 м²', address: 'Водно', lat: 41.9900, lon: 21.4000, geo_source: 'stored' },
] as any;

function makeSjoHandler(rows: Property[] = SJO_ROWS) {
  const dbPath = path.join(os.tmpdir(), `recall-sjo-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  writeMap(dbPath, [{ name: 'СЈО', type: 'institution', lat: 41.9990, lon: 21.4320, source: 'osm' }] as never, []);
  const offlineMap = new OfflineMapStore(dbPath);
  const db = new Db(':memory:');
  const cfg = loadConfig();
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, t: string) => { sent.push(t); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, new FakeProps(rows)),
    responder: new Responder(new FailingLlm(), cfg),
    properties: new FakeProps(rows),
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false, google: false, offlineMap }),
  } as never);
  return { handler, sessions, sent, offlineMap };
}

test('[09:07] a size-only recall is served at the place — over the search budget, and said so', async () => {
  const { handler, sessions, sent, offlineMap } = makeSjoHandler();
  const CAP = '120000';
  // The state the capture arrived in: a buy search capped at 120.000, two
  // cards of an earlier batch already on the table.
  const s = freshSession('test', chat);
  s.state = 'property_locate';
  s.slots.service = 'buy';
  s.slots.location = 'Центар';
  s.slots.budget = CAP;
  s.slots.bedrooms = 3;
  s.slots.propertyId = 51;
  s.slots.presentedIds = [51, 90];
  s.slots.currentBatch = [51, 90];
  sessions.set(s);

  await handler.handle('test', chat, 'IMAVTE EDEN STAN KAJ SJO SO DVE SPALNI ?');
  const r = sent[sent.length - 1];
  const after = sessions.get(chat)!;

  // The flat he described is served — it is the one standing at СЈО.
  assert.match(r, /Евидентен број 66/u, `the трисобен at СЈО is served: ${r}`);
  assert.match(r, /СЈО/u, `the place he named is the anchor: ${r}`);
  // …and the over-budget fact is spoken, never hidden (it is what kept it out
  // of every earlier serve) and never claimed to fit.
  assert.match(r, /над буџетот од 120\.000 евра/u, `the cap is stated: ${r}`);
  // A wrong-size flat 20 m closer must not take a slot.
  assert.ok(!/Евидентен број 90/u.test(r), `a гарсоњера never answers «со две спални»: ${r}`);
  // The cards on the table are not the answer to a recall of another listing.
  assert.ok(!/Евидентен број 51/u.test(r), `the old batch does not answer the recall: ${r}`);
  // The failure is gone: no owner-consult line, no criteria questionnaire, and
  // no buy-or-rent question on a chat that already knows the deal.
  assert.ok(!/сопственикот|карактеристики Ви се најклучни/u.test(r), `never the owner-consult line: ${r}`);
  assert.ok(!BEDROOMS_ASK.test(r), `never the criteria grill: ${r}`);
  assert.ok(!/за продажба или за изнајмување/u.test(r), `the deal is known: ${r}`);
  // The hunt continues on these rows.
  assert.equal(after.state, 'property_locate');
  assert.ok(after.slots.currentBatch?.includes(66), `the batch is the recalled flat's: ${after.slots.currentBatch}`);
  offlineMap.close();
});
