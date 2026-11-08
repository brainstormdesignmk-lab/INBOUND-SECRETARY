/**
 * THE [00:47] CAPTURE — the place named before the search was armed, and the
 * place the client moved the search to.
 *
 *   [00:47] ZDRAVO
 *   [00:47] ЛИНА: Дали планирате да купите недвижност или барате опција за
 *                 изнајмување?
 *   [00:47] STN MI TREBA
 *   [00:48] LEPTOKARIJA ILI CITY MALL
 *   [00:48] ЛИНА: На кој дел од градот … потрагата по стан?   ← asked AGAIN
 *   [00:48] DA KUPAM
 *   [00:48] LEPTOKARIJA ILI CITY MALL                          ← caught this time
 *   [00:49] A KAJ CITY MALL?
 *   [00:49] ЛИНА: Да барам истите критериуми … околу Скопје Сити Мол?
 *   [00:49] NORMALNO
 *   [00:49] ЛИНА: … немам недвижност во непосредна близина на ТЦ Лептокарија
 *
 * Two root causes, one test each:
 *   1. `searchSignals` — the guard that keeps landmark CHATTER from locking an
 *      area — listed every category EXCEPT the flat. «STN MI TREBA» is a стан
 *      search, so the named place was refused as chatter and dropped; the
 *      funnel then asked for the neighbourhood the client had just named.
 *   2. the confirmed pivot was promoted only when `detectAgreement` recognised
 *      the answer. «NORMALNO» — a plain yes to the bot's own yes/no question —
 *      is not in that lexicon, so the pending pivot was thrown away in silence
 *      and the OLD anchor served: he asked for City Mall and got Лептокарија.
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
import { detectAgreement } from '../src/llm/deterministic';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

/**
 * Two buy flats in the mall's own quarter, both real EBs with pins:
 *   EB 54 — 303 m from ТЦ Лептокарија (42.00356, 21.39909), also < 1 km from
 *           Skopje City Mall (42.00422, 21.39171);
 *   EB 71 — 660 m from Skopje City Mall but ≳1 km from Лептокарија, so it is
 *           exactly the card that answers «a kaj City Mall?» and never the
 *           one within the first place's ring.
 */
const ROWS: Property[] = [
  { eb: 54, id: 54, location: 'Карпош III', address: 'Роберт Кох 3', price: 69500, bedrooms: 2, sqm: 35, size: '35 м²', service: 'buy', lat: 42.0036, lon: 21.3955 },
  { eb: 71, id: 71, location: 'Карпош III', address: 'Тодор Александров', price: 99000, bedrooms: 2, sqm: 51, size: '51 м²', service: 'buy', lat: 41.9998, lon: 21.3872 },
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
  const handler = new InboundHandler({
    cfg, db, sessions, bank: new BankStore(db),
    classifier: new Classifier(new FailingLlm(), cfg, new FakeProps(ROWS)),
    responder: new Responder(new FailingLlm(), cfg),
    properties: new FakeProps(ROWS),
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
    enrichment: new EnrichmentStore(db),
  });
  return { handler, sessions, sent, chatId: id };
}

// ── 1. THE PLACE NAMED BEFORE THE SEARCH WAS ARMED ─────────────────────────

test('[00:47] a place named with the FLAT category alone is still a search, not chatter', async () => {
  const { handler, sessions, chatId } = makeHandler('capture-0047-first');
  await handler.handle('test', chatId, 'ZDRAVO');
  // «STN MI TREBA» — the стан category, and NO buy/rent answer yet.
  await handler.handle('test', chatId, 'STN MI TREBA');
  await handler.handle('test', chatId, 'LEPTOKARIJA ILI CITY MALL');
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.flat, true, 'the station category is on file');
  assert.equal(s.slots.service, undefined, 'the buy/rent answer has NOT arrived yet');
  assert.match(String(s.slots.poiAnchor), /лептокарија|leptokarija/iu,
    `the named place must not be dropped as chatter, got ${s.slots.poiAnchor}`);
});

test('[00:47] the client never has to repeat the place after answering buy/rent', async () => {
  const { handler, sent, sessions, chatId } = makeHandler('capture-0047-repeat');
  await handler.handle('test', chatId, 'ZDRAVO');
  await handler.handle('test', chatId, 'STN MI TREBA');
  await handler.handle('test', chatId, 'LEPTOKARIJA ILI CITY MALL');
  await handler.handle('test', chatId, 'DA KUPAM');
  const answer = sent[sent.length - 1] ?? '';
  assert.doesNotMatch(answer, /кој дел од градот/iu,
    `the place is already known — the neighbourhood must not be asked again: ${answer}`);
  const s = sessions.get(chatId)!;
  assert.match(String(s.slots.poiAnchor), /лептокарија|leptokarija/iu,
    `the anchor survives the buy answer, got ${s.slots.poiAnchor}`);
});

// ── 2. THE SEARCH MOVED TO A NEW PLACE, AND CONFIRMED ──────────────────────

test('[00:47] «NORMALNO» is a plain yes to a yes/no question', () => {
  assert.equal(detectAgreement('NORMALNO'), true);
  assert.equal(detectAgreement('Нормално.'), true);
  // A whole-message bare affirmation only: the same word inside a sentence is
  // not a yes, and the NEGATED form is a complaint (the fee-nag family).
  assert.equal(detectAgreement('NE E NORMALNO'), false);
  assert.equal(detectAgreement('OVA STVARNO NE E NORMALNO'), false);
});

test('[00:47] the confirmed pivot serves from City Mall, never from Лептокарија', async () => {
  const { handler, sent, sessions, chatId } = makeHandler('capture-0047-pivot');
  // «двособен» is the feed's own label for the two-bedroom row (EB 54/71), so
  // the criteria are the card's, not a room-count interpretation.
  await handler.handle('test', chatId, 'ZDRAVO SAKAM DA KUPAM DVOSOBEN OKOLU LEPTOKARIJA');
  const served = (await handler.handle('test', chatId, 'DO 120000'), sent[sent.length - 1] ?? '');
  assert.match(served, /Евидентен број/u, `the first pair is served from Лептокарија: ${served}`);
  assert.match(served, /Лептокарија/u, `the first pair is anchored at the place he named: ${served}`);
  await handler.handle('test', chatId, 'A KAJ CITY MALL?');
  const ask = sent[sent.length - 1] ?? '';
  assert.match(ask, /Сити Мол/u, `the pivot asks about the place he named: ${ask}`);
  assert.match(String(sessions.get(chatId)!.slots.pendingPivot?.name ?? ''), /city mall/iu,
    'the pivot is held until the client answers');
  await handler.handle('test', chatId, 'NORMALNO');
  const answer = sent[sent.length - 1] ?? '';
  assert.match(answer, /Сити Мол/u,
    `the answer is about the place he moved the search to: ${answer}`);
  assert.ok(!/Лептокарија/iu.test(answer),
    `the old anchor must not answer for the new place: ${answer}`);
  assert.match(String(sessions.get(chatId)!.slots.poiAnchor), /city mall/iu,
    `the anchor moved: ${sessions.get(chatId)!.slots.poiAnchor}`);
});
