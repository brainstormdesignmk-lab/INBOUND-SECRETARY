// THE [19:14] BATCH — TWO ROOM CATEGORIES, ONE CAP EACH.
//
//   [19:14] DVOSOBEN MOZE DO 90000 I TROSOBEN DO 150000
//   [19:14] IMATE LI NESTO TAKVO VO TOJ REON ?
//   [19:14] ЛИНА: EB 53 (двособен, 55.000) + EB 89 (двособен, 110.000)
//
// Two faults in one serve:
//   1. NO ТРИСОБЕН: the second category was dropped, so the pair the client
//      asked for was two flats of the same type;
//   2. THE 90.000 CAP WAS IGNORED: EB 89 came in at 110.000 — 20.000 over the
//      money he named FOR THAT CATEGORY (the 150.000 of the трисобен leg had
//      silently become the only budget).
//
// The contract these tests pin:
//   • a message naming two categories with a cap each banks BOTH
//     (slots.categoryBudgets), keeps the highest cap in slots.budget so every
//     other lane stays honest, and never collapses to one room count;
//   • every batch is ONE OF EACH, each inside ITS OWN cap, nearest to the named
//     place first;
//   • when a category runs out the turn SAYS it (with the money he gave) and
//     serves the remaining one;
//   • when both run out the turn offers the two pivots: another neighbourhood,
//     or another category.

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
import { detectCategoryBudgets, extractSlots } from '../src/llm/deterministic';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

// ── THE DETECTOR (one source of truth for "which cap belongs to which rooms") ─

test('[19:14] detectCategoryBudgets: two categories, two caps — word order and script do not matter', () => {
  const want = [{ rooms: 2, budget: '90000' }, { rooms: 3, budget: '150000' }];
  for (const t of [
    'DVOSOBEN MOZE DO 90000 I TROSOBEN DO 150000',
    'dvosoben moze do 90000 i trosoben do 150000',
    'двособен до 90.000 и трособен до 150.000',
    'DVOSOBEN DO 90.000 I TROSOBEN DO 150.000',
    // the money BEFORE the category (the reversed order a client types just as often)
    'DO 90000 DVOSOBEN I DO 150000 TROSOBEN',
    'do 90.000 dvosoben i do 150.000 trosoben',
    // counted nouns instead of the adjective
    '2 sobi do 90.000 , 3 sobi do 150.000',
    '2 sobni do 90000 i 3 sobni do 150000',
  ]) {
    assert.deepEqual(detectCategoryBudgets(t), want, `two caps must pair with their own rooms: ${t}`);
  }
  // Cheapest category first, whatever order the client said them in.
  assert.deepEqual(detectCategoryBudgets('TROSOBEN DO 150000 I DVOSOBEN DO 90000'), want);
});

test('[19:14] detectCategoryBudgets: a single category, a single figure or a size is NOT this lane', () => {
  // One category — the plain budget slot owns it.
  assert.equal(detectCategoryBudgets('DVOSOBEN DO 90000'), undefined);
  // Two categories, ONE figure — which cap is whose? Never guess.
  assert.equal(detectCategoryBudgets('DVOSOBEN I TROSOBEN DO 150000'), undefined);
  // Sizes and counts are not money.
  assert.equal(detectCategoryBudgets('DVOSOBEN 44 M2 I TROSOBEN 76 M2'), undefined);
  assert.equal(detectCategoryBudgets('DVOSOBEN SO 2 SPALNI I TROSOBEN'), undefined);
});

test('[19:14] extractSlots banks the pair on the SIZE axis too, with the highest cap as the budget', () => {
  const slots = extractSlots('DVOSOBEN MOZE DO 90000 I TROSOBEN DO 150000');
  assert.deepEqual(slots.categoryBudgets, [{ rooms: 2, budget: '90000' }, { rooms: 3, budget: '150000' }]);
  assert.equal(slots.bedrooms, undefined, 'one room count would drop the other category');
  assert.equal(slots.bedroomsMin, 2);
  assert.equal(slots.bedroomsMax, 3);
  assert.equal(slots.budget, '150000', 'the highest cap keeps every other lane honest');
  // A single-category message keeps the legacy shape (one rooms slot, one cap).
  const single = extractSlots('DVOSOBEN DO 90000');
  assert.equal(single.categoryBudgets, undefined);
  assert.equal(single.bedrooms, 2);
  assert.equal(single.budget, '90000');
});

// ── THE FUNNEL ───────────────────────────────────────────────────────────────

const ROWS: Property[] = [
  // 2 rooms: 601 and 604 fit 90.000; 602 does NOT (the [19:14] EB 89 bug).
  { eb: 601, id: 601, location: 'Аеродром', price: 55000, bedrooms: 2, sqm: 44, size: '44 м²', service: 'buy' },
  { eb: 602, id: 602, location: 'Аеродром', price: 110000, bedrooms: 2, sqm: 70, size: '70 м²', service: 'buy' },
  { eb: 604, id: 604, location: 'Аеродром', price: 88000, bedrooms: 2, sqm: 60, size: '60 м²', service: 'buy' },
  // 3 rooms: 603 and 606 fit 150.000; 605 does NOT.
  { eb: 603, id: 603, location: 'Аеродром', price: 145000, bedrooms: 3, sqm: 71, size: '71 м²', service: 'buy' },
  { eb: 605, id: 605, location: 'Аеродром', price: 175000, bedrooms: 3, sqm: 90, size: '90 м²', service: 'buy' },
  { eb: 606, id: 606, location: 'Аеродром', price: 120000, bedrooms: 3, sqm: 80, size: '80 м²', service: 'buy' },
];

// The landmark serve: rows around Универзална Сала (41.99922, 21.41648) — the
// resolver in the production map DB knows this place, so the ordering assertion
// is about the real distance ladder, not a stub.
const NEAR_ROWS: Property[] = [
  { eb: 611, id: 611, location: 'Центар', price: 80000, bedrooms: 2, sqm: 50, size: '50 м²', service: 'buy', lat: 41.9993, lon: 21.4165 },  // ~10 m
  { eb: 612, id: 612, location: 'Центар', price: 70000, bedrooms: 2, sqm: 48, size: '48 м²', service: 'buy', lat: 41.9975, lon: 21.4187 },  // ~250 m
  { eb: 613, id: 613, location: 'Центар', price: 140000, bedrooms: 3, sqm: 72, size: '72 м²', service: 'buy', lat: 41.9991, lon: 21.4164 }, // ~20 m
  { eb: 614, id: 614, location: 'Центар', price: 130000, bedrooms: 3, sqm: 70, size: '70 м²', service: 'buy', lat: 41.9944, lon: 21.4162 }, // ~550 m
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

test('[19:14] e2e: one of each, each inside its OWN cap — never a 110.000 двособен under a 90.000 ask', async () => {
  const { say, sessions, chatId } = makeHandler('cat-pair');
  await say('ZDRAVO SAKAM DA KUPAM STAN VO AERODROM');
  await say('DVOSOBEN MOZE DO 90000 I TROSOBEN DO 150000');

  const s = sessions.get(chatId)!;
  assert.deepEqual(s.slots.categoryBudgets, { '2': '90000', '3': '150000' },
    'both caps are banked per category');
  assert.equal(s.slots.budget, '150000', 'the highest cap is the single budget figure');
  assert.equal(s.slots.bedrooms, undefined, 'no single room count may pin the search');

  const first = s.slots.currentBatch ?? [];
  assert.equal(first.length, 2, `a pair must be served: ${JSON.stringify(first)}`);
  const roomsOf = (ids: number[]) => ids.map(id => ROWS.find(r => id === r.eb)!.bedrooms).sort();
  assert.deepEqual(roomsOf(first), [2, 3], 'ONE OF EACH — never two of the same category');
  assert.ok(!first.includes(602), 'the 110.000 двособен is 20.000 over the 90.000 cap');
  assert.ok(!first.includes(605), 'the 175.000 трисобен is over the 150.000 cap');
  for (const id of first) {
    const row = ROWS.find(r => r.eb === id)!;
    const cap = id === 601 || id === 604 ? 90000 : 150000;
    assert.ok((row.price as number) <= cap, `EB ${id} must sit under ITS category cap`);
  }

  // Next turn: the next pair, still one of each — and the caps still hold.
  const next = await say('DRUGI OPCII');
  const second = sessions.get(chatId)!.slots.currentBatch ?? [];
  assert.deepEqual(roomsOf(second), [2, 3], 'the next turn is one of each again');
  assert.ok(!/Евидентен број 602|Евидентен број 605/u.test(next),
    `an over-cap row must never be served: ${next}`);

  // Both categories drained: the turn says so and offers BOTH pivots.
  const drained = await say('DRUGI OPCII');
  assert.match(drained, /исцрпивме/iu, `the drained pair must be stated: ${drained}`);
  assert.match(drained, /друга населба/iu, `another neighbourhood must be offered: ${drained}`);
  assert.match(drained, /друга категорија/iu, `another category must be offered: ${drained}`);
  assert.ok(!/Евидентен број 60[1-6]/u.test(drained), `no recycled card on the drained turn: ${drained}`);
});

test('[19:14] e2e: a drained category is NAMED, and the survivor fills both slots', async () => {
  // Only ONE двособен left; the трисобен side has two.
  const rows = ROWS.filter(r => r.eb !== 604);
  const { say, sessions, chatId } = makeHandler('cat-drain', rows);
  await say('ZDRAVO SAKAM DA KUPAM STAN VO AERODROM');
  await say('DVOSOBEN MOZE DO 90000 I TROSOBEN DO 150000');
  assert.deepEqual(sessions.get(chatId)!.slots.currentBatch, [601, 603], 'the pair leads');

  const reply = await say('DRUGI OPCII');
  assert.deepEqual(sessions.get(chatId)!.slots.currentBatch, [606],
    'the survivor continues alone once the двособен side is empty');
  assert.match(reply, /двособни/iu, `the drained category must be named: ${reply}`);
  assert.match(reply, /90\.000|90000/u, `with the money he gave for it: ${reply}`);
  // «трособни» — the owner's own spelling of the three-room plural (the
  // [03:45] capture: NOT «трисобни»); the middle letter is a LATIN o.
  assert.match(reply, /трособни/iu, `and the served category named as the continuation: ${reply}`);
});

test('[19:14] e2e: near a landmark the pair starts with the CLOSEST to it', async () => {
  const { say, sessions, chatId } = makeHandler('cat-anchor', NEAR_ROWS);
  await say('ZDRAVO SAKAM DA KUPAM STAN VO BLIZINA NA UNIVERZALNA SALA');
  await say('DVOSOBEN MOZE DO 90000 I TROSOBEN DO 150000');
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.poiAnchor, 'Универзална Сала', JSON.stringify(s.slots.poiAnchor));
  // 611 ≈10 m (2-room) is nearer than 613 ≈20 m (3-room): one of each, and the
  // nearer card LEADS.
  assert.deepEqual(s.slots.currentBatch, [611, 613],
    `one of each, closest to the place first: ${JSON.stringify(s.slots.currentBatch)}`);
});
