// THE [20:08] CAPTURE — ALTERNATIVE BUDGET: ONE UP TO 80.000, OR TWO UP TO
// 140.000.
//
//   [20:08] MOZE SO EDNA DO 80000 ILI DVE DO 140000
//   [20:08] ЛИНА: EB 53 (двособен, 55.000) + EB 88 (трисобен, 133.000)
//   [20:09] DRUGO NESTO IMA , OSVEN OVIE DVA ?
//   [20:09] ЛИНА: EB 89 (двособен, 110.000)
//
// Three faults, one root: `detectBudget` kept the LARGEST figure (140.000) as
// "the budget", so the 80.000 single cap disappeared. EB 88 sits 53.000 over
// it, the pair totals 188.000 (48.000 over the "two" figure), and the next
// «DRUGO NESTO IMA?» refilled with EB 89 because 110.000 ≤ 140.000 looked like
// a criteria fit — the client never heard that everything inside his money was
// already shown.
//
// A second fault sat in front of the first: the message was routed to
// NEGOTIATE (the counter-offer modal bridge "moze … <amount>"), so the money
// never reached the slots at all and the fixed-price owner pitch answered a
// purchase plan.
//
// The contract these tests pin:
//   • «so edna do X ili dve do Y» is TWO money rules: each single card ≤ X and a
//     pair whose TOTAL ≤ Y. slots.budget keeps X (the stricter figure), the pair
//     total rides slots.countBudget — and the shape is never a counter-offer and
//     never a bedroom range (it counts FLATS, not rooms);
//   • when the money is spent the turn SAYS it with his own two figures, offers
//     the pricier pair (they match the characteristics, they are simply above
//     his money) and names the third way out (change the request/neighbourhood);
//   • consent to the pricier option serves a pair above the cap;
//   • a NAMED new neighbourhood re-runs the PRIMARY request THERE, still inside
//     the money he gave;
//   • with nothing pricier in the area, the turn says so and serves the closest
//     same-characteristics rows instead of going silent.

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
import { detectCountBudget, detectNegotiate, extractSlots } from '../src/llm/deterministic';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

// ── THE DETECTOR: two figures, two counts, both scripts and word orders ──────

test('[20:08] detectCountBudget: one up to X, or two up to Y — never "the budget is Y"', () => {
  const want = { single: '80000', pair: '140000' };
  for (const t of [
    'MOZE SO EDNA DO 80000 ILI DVE DO 140000',        // the capture
    'moze so edna do 80000 ili dve do 140000',
    'може со една до 80.000 или две до 140.000',
    'DVE DO 140000 ILI EDNA DO 80000',                // reversed order
    '1 DO 80000 ILI 2 DO 140000',                     // digits
    'do 80000 za edna ili do 140000 za dve',          // money first
    'EDEN STAN DO 80000 ILI DVA STANA DO 140000',     // counted nouns
  ]) {
    assert.deepEqual(detectCountBudget(t), want, `the either-or money must be read as a pair: ${t}`);
  }
});

test('[20:08] detectCountBudget: a room range, one figure or a category pair is NOT this lane', () => {
  for (const t of [
    'edna ili dve',                                   // the room RANGE — no money
    'EDNA ILI DVE DO 140000',                         // a range + ONE cap
    'DO 140000',
    'DVOSOBEN DO 90000 I TROSOBEN DO 150000',         // the [19:14] category pair
    'DVE DO 140000 ILI DVE DO 80000',                 // one count on both sides
    '2 SPALNI ILI 3',
  ]) {
    assert.equal(detectCountBudget(t), undefined, `not an either-or budget: ${t}`);
  }
});

test('[20:08] an either-or budget is a SEARCH, never a price counter-offer', () => {
  for (const t of [
    'MOZE SO EDNA DO 80000 ILI DVE DO 140000',
    'SPALNI BILO KOLKU . MOZE SO EDNA DO 80000 ILI DVE DO 140000',
    'moze so edna do 80000 ili dve do 140000',
  ]) {
    assert.equal(detectNegotiate(t), false, `the counter-offer lane stole a purchase plan: ${t}`);
  }
  // The SINGLE-count siblings of the same shape are budgets too: the modal
  // bridge used to swallow a cap word ("moze [eden stan] do 80000"), so a
  // plain "can I get one up to X" landed on the fixed-price pitch.
  for (const t of ['MOZE EDEN STAN DO 80000', 'MOZE SO EDNA DO 80000', 'moze do 80000']) {
    assert.equal(detectNegotiate(t), false, `a capped ask is a budget, not a counter: ${t}`);
  }
  // A REAL counter-offer still negotiates (the modal bridge keeps its job).
  assert.equal(detectNegotiate('DALI MOZE DA GO KUPAM ZA 150000'), true);
  assert.equal(detectNegotiate('moze za 150 e'), true);
  assert.equal(detectNegotiate('dali moze za 150 evra'), true);
});

test('[20:08] extractSlots banks the STRICTER figure and never turns the deal into a room range', () => {
  const slots = extractSlots('MOZE SO EDNA DO 80000 ILI DVE DO 140000');
  assert.deepEqual(slots.countBudget, { single: '80000', pair: '140000' });
  assert.equal(slots.budget, '80000', 'every single-card lane filters on the single cap');
  assert.equal(slots.bedroomsMin, undefined, 'this counts FLATS — not 2…3 rooms');
  assert.equal(slots.bedroomsMax, undefined);
  // A plain cap keeps the legacy shape.
  const plain = extractSlots('DO 140000');
  assert.equal(plain.countBudget, undefined);
  assert.equal(plain.budget, '140000');
});

// ── THE FUNNEL ───────────────────────────────────────────────────────────────

const ROWS: Property[] = [
  // Аеродром: inside the money (four rows → two full pairs).
  { eb: 53, id: 53, location: 'Аеродром', price: 55000, bedrooms: 2, sqm: 44, size: '44 м²', service: 'buy' },
  { eb: 33, id: 33, location: 'Аеродром', price: 70000, bedrooms: 2, sqm: 50, size: '50 м²', service: 'buy' },
  { eb: 34, id: 34, location: 'Аеродром', price: 62000, bedrooms: 2, sqm: 45, size: '45 м²', service: 'buy' },
  { eb: 35, id: 35, location: 'Аеродром', price: 58000, bedrooms: 2, sqm: 40, size: '40 м²', service: 'buy' },
  // Аеродром: ABOVE the single cap — the [20:08] EB 88 / [20:09] EB 89 leaks.
  { eb: 88, id: 88, location: 'Аеродром', price: 133000, bedrooms: 3, sqm: 68, size: '68 м²', service: 'buy' },
  { eb: 89, id: 89, location: 'Аеродром', price: 110000, bedrooms: 2, sqm: 70, size: '70 м²', service: 'buy' },
  // Кисела Вода: the named new neighbourhood the client asks for by name.
  { eb: 41, id: 41, location: 'Кисела Вода', price: 66000, bedrooms: 2, sqm: 48, size: '48 м²', service: 'buy' },
  { eb: 42, id: 42, location: 'Кисела Вода', price: 74000, bedrooms: 2, sqm: 52, size: '52 м²', service: 'buy' },
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getById(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
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

const priceOf = (id: number, rows: Property[] = ROWS): number => rows.find(r => r.eb === id)!.price as number;

/** The intake the capture used: a flat type, the size waived, then the money. */
async function ask(say: (m: string) => Promise<string>): Promise<string> {
  await say('ZDRAVO SAKAM DA KUPAM STAN VO AERODROM');
  return say('SPALNI BILO KOLKU . MOZE SO EDNA DO 80000 ILI DVE DO 140000');
}

/** Drain every in-budget row, asserting nothing over the caps is ever served. */
async function drain(
  say: (m: string) => Promise<string>, sessions: SessionStore, chatId: string,
): Promise<string> {
  let reply = '';
  for (let i = 0; i < 5; i++) {
    reply = await say('DRUGO NESTO IMA , OSVEN OVIE DVA ?');
    const batch = sessions.get(chatId)!.slots.currentBatch ?? [];
    for (const id of batch) {
      assert.ok(priceOf(id) <= 80000, `EB ${id} is over the 80.000 single cap: ${reply.slice(0, 200)}`);
    }
    const total = batch.reduce((s, id) => s + priceOf(id), 0);
    assert.ok(total <= 140000, `the pair totals ${total} — over the 140.000 "two" figure`);
    if (sessions.get(chatId)!.slots.moreChoicePending) break;
  }
  return reply;
}

test('[20:08] e2e: one up to 80.000 or two up to 140.000 — the pair stays inside BOTH', async () => {
  const { say, sessions, chatId } = makeHandler('count-budget');
  await ask(say);

  const s = sessions.get(chatId)!;
  assert.deepEqual(s.slots.countBudget, { single: '80000', pair: '140000' });
  assert.equal(s.slots.budget, '80000', 'the single cap is the budget every lane reads');
  assert.equal(s.slots.service, 'buy');
  const batch = s.slots.currentBatch ?? [];
  assert.equal(batch.length, 2, `a pair must be served: ${JSON.stringify(batch)}`);
  for (const id of batch) assert.ok(priceOf(id) <= 80000, `EB ${id} over the single cap`);
  const total = batch.reduce((sum, id) => sum + priceOf(id), 0);
  assert.ok(total <= 140000, `the pair totals ${total} — the "two" figure is 140.000`);
  assert.ok(!batch.includes(88), 'EB 88 (133.000) is 53.000 over the single cap');
  assert.ok(!batch.includes(89), 'EB 89 (110.000) is 30.000 over the single cap');
});

test('[20:08] e2e: the spend is SAID with his own figures, then the pricier pair is offered', async () => {
  const { say, sessions, chatId } = makeHandler('count-budget-drain');
  await ask(say);

  // [20:09] «DRUGO NESTO IMA , OSVEN OVIE DVA ?» must NEVER answer with EB 89.
  const drained = await drain(say, sessions, chatId);
  assert.match(drained, /80\.000/u, `the single cap must be stated: ${drained.slice(0, 300)}`);
  assert.match(drained, /140\.000/u, `the "two" figure must be stated: ${drained.slice(0, 300)}`);
  assert.match(drained, /поскап/iu, `the over-budget option must be offered: ${drained.slice(0, 300)}`);
  assert.match(drained, /друга населба/iu, `another neighbourhood must be offered: ${drained.slice(0, 300)}`);
  assert.match(drained, /критериуми/iu, `changing the request must be offered: ${drained.slice(0, 300)}`);
  assert.equal(sessions.get(chatId)!.slots.moreChoicePending, true, 'the offer must be answerable');

  // Consent to the pricier option: a pair ABOVE the cap, since the cap lifted.
  const pricier = await say('DA , POKAZI POSKAPO');
  const batch = sessions.get(chatId)!.slots.currentBatch ?? [];
  assert.equal(batch.length, 2, `a pair must be served: ${pricier.slice(0, 300)}`);
  for (const id of batch) assert.ok(priceOf(id) > 80000, `EB ${id} is not pricier than the spent cap`);
  assert.ok(batch.includes(88) && batch.includes(89), `the pricier rows must be the ones served: ${batch}`);
});

test('[20:08] e2e: a NAMED new neighbourhood re-runs the primary request THERE, inside the money', async () => {
  const { say, sessions, chatId } = makeHandler('count-budget-area');
  await ask(say);
  await drain(say, sessions, chatId);
  assert.equal(sessions.get(chatId)!.slots.moreChoicePending, true);

  const reply = await say('NE , DAJ MI STO IMAS VO KISELA VODA');
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.location, 'Кисела Вода', `the named area must become the search: ${reply.slice(0, 200)}`);
  assert.equal(s.slots.budget, '80000', 'the PRIMARY money still governs the re-search');
  const batch = s.slots.currentBatch ?? [];
  assert.ok(batch.length > 0, `the named neighbourhood must be served: ${reply.slice(0, 300)}`);
  for (const id of batch) {
    assert.ok([41, 42].includes(id), `only Кисела Вода rows may be served: EB ${id}`);
    assert.ok(priceOf(id) <= 80000, `EB ${id} still respects the single cap`);
  }
});

test('[20:08] e2e: nothing pricier than the anchor — say it and serve the closest similar rows', async () => {
  // Popularity order across the city: the pair is [Центар 90.000, Карпош 65.000],
  // so the anchor is the CHEAPER card of the batch and the only row left
  // (Аеродром 60.000) is BELOW it. "Poskapo" therefore has nothing above the
  // anchor: the turn must SAY that and still serve the remaining row.
  const rows: Property[] = [
    { eb: 82, id: 82, location: 'Центар', price: 88000, bedrooms: 2, sqm: 60, size: '60 м²', service: 'buy' },
    { eb: 84, id: 84, location: 'Центар', price: 78000, bedrooms: 2, sqm: 46, size: '46 м²', service: 'buy' },
    { eb: 83, id: 83, location: 'Центар', price: 55000, bedrooms: 2, sqm: 44, size: '44 м²', service: 'buy' },
  ];
  const { say, sessions, chatId } = makeHandler('count-budget-similar', rows);
  // Type, area, waived size and the cap in ONE message: the pool is then
  // ordered by money-proximity (and biggest-first), so the two pricier rows
  // lead and the cheapest one is the row left for the similar serve.
  await say('ZDRAVO SAKAM DA KUPAM STAN VO CENTAR . SPALNI BILO KOLKU . DO 90000');
  const first = sessions.get(chatId)!.slots.currentBatch ?? [];
  assert.equal(first.length, 2, `the first pair must be served: ${JSON.stringify(first)}`);
  const anchor = first[first.length - 1];
  const left = [82, 83, 84].filter(id => !first.includes(id));
  assert.equal(left.length, 1, 'exactly one row must remain for the similar serve');
  assert.ok(priceOf(left[0], rows) <= priceOf(anchor, rows),
    'the remaining row is NOT pricier than the anchor — the similar branch owns the turn');

  const reply = await say('DAJ NESTO POSKAPO');
  assert.match(reply, /немам/iu, `the honest "nothing pricier" sentence is required: ${reply.slice(0, 300)}`);
  const batch = sessions.get(chatId)!.slots.currentBatch ?? [];
  assert.deepEqual(batch, left, `the similar row must still be served: ${reply.slice(0, 300)}`);
});
