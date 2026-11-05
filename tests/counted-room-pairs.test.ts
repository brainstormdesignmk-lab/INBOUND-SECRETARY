// THE [09:46] CAPTURE — THE TWO COUNTS THAT ANSWERED THE BEDROOMS QUESTION.
//
//   [09:45] ZDRAVO. SAKAM DA KUPAM STANCE OKOLU KAPITOL NEGDE
//   [09:46] ЛИНА: 1. колку спални соби очекувате… 2. максималната цена…
//   [09:46] MOZE SO EDNA DO 100 000 ILI SO DVE DO 150 000
//   [09:46] ЛИНА: За колку спални соби во станот размислувате Вие?
//
// The client answered BOTH questions in one line — ONE bedroom up to 100.000,
// TWO bedrooms up to 150.000 — and the funnel asked for bedrooms again.
//
// Root: «so edna do X ili dve do Y» was read ONLY as the [20:08] FLAT deal (one
// flat under X, or a pair whose total stays under Y), which carries no room
// slot at all, so the size criterion stayed empty and `buildDiscoveryAsk` asked
// the question the client had just answered.
//
// But the SAME words are the [20:08] shape, and the two money rules are
// incompatible (per-category caps vs. a pair TOTAL) — so the axis is decided by
// the CRITERION the counts answer, never by the words alone:
//   • a size the client has NOT released = the open question → the counts ARE
//     the two room categories, banked through `slots.categoryBudgets` (the
//     [19:14] pair ladder: one of each, each inside ITS OWN cap, nearest to the
//     named place first, drained category named honestly, both pivots offered);
//   • a waiver («SPALNI BILO KOLKU», [20:08]) or an already-banked room
//     criterion = the size axis is settled → the counts count FLATS and
//     `slots.countBudget` owns the pair total exactly as before.
//
// THE COUNTS ARE BEDROOMS, THE FEED IS ROOMS: «една спална» is a ДВОСОБЕН (2),
// «две спални» a ТРИСОБЕН (3) — `roomsFromBedrooms`, the same convention
// `detectBedrooms` applies («IMAVTE EDEN STAN KAJ SJO SO DVE SPALNI?» is the
// трисобен EB 66).

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
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LlmClient } from '../src/llm/types';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';
import { detectCountBudget, detectBareBedroomCount, extractSlots, roomsFromBedrooms } from '../src/llm/deterministic';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

// Rows around Универзална Сала (41.99922, 21.41648). The 2-room (one-bedroom)
// and the 3-room (two-bedroom) legs each hold a card inside its own cap and one
// OVER it, so an out-of-cap serve is a real assertion and not a fixture accident.
const ROWS: Property[] = [
  { eb: 701, id: 701, location: 'Центар', price: 95000, bedrooms: 2, sqm: 44, size: '44 м²', service: 'buy', lat: 41.9993, lon: 21.4165 },  // ~10 m, one bedroom, fits 100.000
  { eb: 702, id: 702, location: 'Центар', price: 88000, bedrooms: 2, sqm: 41, size: '41 м²', service: 'buy', lat: 41.9975, lon: 21.4187 },  // ~250 m, one bedroom
  { eb: 705, id: 705, location: 'Центар', price: 120000, bedrooms: 2, sqm: 48, size: '48 м²', service: 'buy', lat: 41.9991, lon: 21.4160 }, // one bedroom, 20.000 OVER
  { eb: 703, id: 703, location: 'Центар', price: 140000, bedrooms: 3, sqm: 68, size: '68 м²', service: 'buy', lat: 41.9991, lon: 21.4164 }, // ~20 m, two bedrooms, fits 150.000
  { eb: 704, id: 704, location: 'Центар', price: 160000, bedrooms: 3, sqm: 78, size: '78 м²', service: 'buy', lat: 41.9990, lon: 21.4163 }, // two bedrooms, 10.000 OVER
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  get healthy(): boolean { return true; }
}

function makeHandler(id: string, rows: Property[] = ROWS) {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const props = new FakeProps(rows);
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, props),
    responder: new Responder(new FailingLlm(), cfg),
    properties: props,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
  });
  const say = async (m: string): Promise<string> => {
    await handler.handle('test', id, m);
    return sent.at(-1) ?? '';
  };
  return { say, sessions, chatId: id };
}

const priceOf = (id: number): number => ROWS.find(r => r.eb === id)!.price as number;

test('[09:46] the two counts still read as an either-or budget at the detector', () => {
  // The TEXT reading is unchanged: the axis is a SESSION decision (below), so
  // the detector keeps its [20:08] contract — `extractSlots` is a pure function
  // with no session and must not start guessing.
  assert.deepEqual(detectCountBudget('MOZE SO EDNA DO 100 000 ILI SO DVE DO 150 000'),
    { single: '100000', pair: '150000' });
  const slots = extractSlots('MOZE SO EDNA DO 100 000 ILI SO DVE DO 150 000');
  assert.deepEqual(slots.countBudget, { single: '100000', pair: '150000' });
});

test('[09:46] a bare «SO EDNA / SO DVE» names BEDROOMS unless a type/quantity noun rides it', () => {
  assert.equal(detectBareBedroomCount('MOZE SO EDNA DO 100 000'), 1);
  assert.equal(detectBareBedroomCount('MOZE SO DVE DO 150 000'), 2);
  assert.equal(detectBareBedroomCount('може со две до 150.000'), 2);
  // A property noun makes the count a QUANTITY (flats/options), never a size.
  assert.equal(detectBareBedroomCount('MOZE EDEN STAN DO 80000'), undefined);
  assert.equal(detectBareBedroomCount('DAJ MI DVE OPCII'), undefined);
  // The [20:08] sentence carries no noun — its axis comes from the session's
  // size waiver, not from this detector.
  assert.equal(detectBareBedroomCount('MOZE SO EDNA DO 80000 ILI DVE DO 140000'), 1);
  assert.equal(roomsFromBedrooms(1), 2);
  assert.equal(roomsFromBedrooms(2), 3);
});

test('[09:46] e2e: with the size question OPEN the counts are ROOM categories — never a second bedrooms ask', async () => {
  const { say, sessions, chatId } = makeHandler('counted-rooms');
  await say('ZDRAVO SAKAM DA KUPAM STAN OKOLU UNIVERZALNA SALA');

  const reply = await say('MOZE SO EDNA DO 100 000 ILI SO DVE DO 150 000');
  const s = sessions.get(chatId)!;

  // THE REGRESSION: the client answered "колку спални?" — asking it again is
  // the loop this capture is about.
  assert.ok(!/колку спални|спални соби|максималната цена|до која цена/iu.test(reply),
    `the answered criteria must never be re-asked: ${reply}`);
  assert.equal(s.slots.categoryBudgets?.['2'], '100000', JSON.stringify(s.slots.categoryBudgets));
  assert.equal(s.slots.categoryBudgets?.['3'], '150000');
  assert.equal(s.slots.countBudget, undefined, 'a per-category split never carries the pair TOTAL rule');
  assert.equal(s.slots.bedrooms, undefined, 'no single room count may pin the search');
  assert.equal(s.slots.bedroomsMin, 2, 'one bedroom IS a двособен in the feed');
  assert.equal(s.slots.bedroomsMax, 3, 'two bedrooms IS a трисобен');
  assert.equal(s.slots.budget, '150000', 'the highest cap keeps every other lane honest');
  assert.equal(s.slots.poiAnchor, 'Универзална Сала');

  // One of each, each inside ITS OWN cap, the nearer card leading.
  assert.deepEqual(s.slots.currentBatch, [701, 703], `one of each, nearest first: ${JSON.stringify(s.slots.currentBatch)}`);
  assert.ok(!(s.slots.currentBatch ?? []).includes(705), 'EB 705 (120.000) is 20.000 over the one-bedroom cap');
  assert.ok(!(s.slots.currentBatch ?? []).includes(704), 'EB 704 (160.000) is 10.000 over the two-bedroom cap');
  assert.ok(priceOf(701) <= 100000 && priceOf(703) <= 150000);
});

test('[09:46] e2e: ONE count answering the same question banks the bedrooms, not just the cap', async () => {
  const { say, sessions, chatId } = makeHandler('counted-single');
  await say('ZDRAVO SAKAM DA KUPAM STAN OKOLU UNIVERZALNA SALA');

  const reply = await say('MOZE SO EDNA DO 100 000');
  const s = sessions.get(chatId)!;
  assert.ok(!/колку спални|спални соби/iu.test(reply),
    `one bedroom was just named — the size question must not come back: ${reply}`);
  assert.equal(s.slots.bedrooms, 2, 'one bedroom = двособен');
  assert.equal(s.slots.budget, '100000');
  assert.equal(s.state, 'presentation');
  assert.deepEqual(s.slots.currentBatch, [701, 702], `the двособни inside the cap: ${JSON.stringify(s.slots.currentBatch)}`);
});

test('[09:46] e2e: a drained count is NAMED, then both pivots are offered', async () => {
  const { say, sessions, chatId } = makeHandler('counted-rooms-drain');
  await say('ZDRAVO SAKAM DA KUPAM STAN OKOLU UNIVERZALNA SALA');
  await say('MOZE SO EDNA DO 100 000 ILI SO DVE DO 150 000');

  // The two-bedroom leg is out of stock under its cap: the survivor continues,
  // and the turn says WHICH category is gone and with what money.
  const drained = await say('DRUGI OPCII');
  assert.deepEqual(sessions.get(chatId)!.slots.currentBatch, [702], JSON.stringify(sessions.get(chatId)!.slots.currentBatch));
  // «трособни» — the owner's own spelling of the three-room plural (the
  // [03:45] capture: NOT «трисобни»). The letter after «тр» is a CYRILLIC о:
  // the first version of this line carried a LATIN o and this assertion
  // carried the same mixed string, so the defect could never fail. Assert the
  // pure spelling AND that no served word mixes scripts.
  assert.match(drained, /\u0442\u0440\u043e\u0441\u043e\u0431\u043d\u0438/u, `the drained category must be named: ${drained}`);
  assert.ok(!/[\u0400-\u04FF][a-z]|[a-z][\u0400-\u04FF]/u.test(drained),
    `no word in the served copy may mix Cyrillic and Latin glyphs: ${drained}`);
  assert.match(drained, /150\.000/u, `with the money he gave for it: ${drained}`);
  assert.match(drained, /двособни/iu, `and the served category as the continuation: ${drained}`);

  // Both counts drained: the turn says it and offers BOTH pivots.
  const all = await say('DRUGI OPCII');
  assert.match(all, /исцрпивме/iu, `the exhausted pair must be stated: ${all}`);
  assert.match(all, /друга населба/iu, `another neighbourhood must be offered: ${all}`);
  assert.match(all, /друга категорија/iu, `another category must be offered: ${all}`);
  assert.ok(!/Евидентен број 70[1-5]/u.test(all), `no recycled card on the drained turn: ${all}`);
});

test('[20:08] e2e: a WAIVED size keeps the counts on the FLAT axis (the pinned [20:08] contract)', async () => {
  const { say, sessions, chatId } = makeHandler('counted-flats');
  await say('ZDRAVO SAKAM DA KUPAM STAN VO AERODROM');
  await say('SPALNI BILO KOLKU . MOZE SO EDNA DO 80000 ILI DVE DO 140000');
  const s = sessions.get(chatId)!;
  assert.deepEqual(s.slots.countBudget, { single: '80000', pair: '140000' });
  assert.equal(s.slots.budget, '80000', 'the stricter figure governs every single-card lane');
  assert.equal(s.slots.categoryBudgets, undefined, 'a released size axis means FLATS, not rooms');
  assert.equal(s.slots.sizeWaived, true);
});
