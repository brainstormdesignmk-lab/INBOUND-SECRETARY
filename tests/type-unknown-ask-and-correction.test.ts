// THE [19:06]/[19:07] CAPTURE — the apartment nobody named, twice.
//
//   [19:06] MI TREBA NESTO INTERESNO KAJ CITY MOL
//   [19:06] ЛИНА: Ве интересира ли купување … или изнајмување?
//   [19:06] PA DA KUPAM BI SAKAL
//   [19:06] ЛИНА: 1. Колку спални соби би Ви одговарале во СТАНОТ?   ✗
//                 2. Дали имате дефинирана максимална цена … за СТАНОТ?
//   [19:07] SAKAM DUKJAN DA ZEMAM , NE STAN
//   [19:07] ЛИНА: 1. Колкав број на спални соби барате во Вашиот нов СТАН? ✗
//
// Two defects, one family:
//  1. the TYPE question was gated on the stock-at-a-place intake only, so any
//     other opening fell through to the residential sequence and ASSUMED a
//     flat — bedrooms and «цената на станот» for a client who never said стан;
//  2. «NE STAN» — the CORRECTION — was read as the category itself: the flat
//     flag armed and `detectBusiness` vetoed itself on the negated residential
//     word, so a дуќан search was never on file.
//
// The contract: the type is ASKED whenever nothing names it (a bedroom count,
// an м² figure and the price wording are all category-specific), and a category
// word behind a correction negation is the category being REFUSED — stripped
// before every category reader, in both directions.
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
import { detectBusiness, detectFlat, detectHouse, stripNegatedCategoryWords } from '../src/llm/deterministic';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

// One flat and one business space near City Mall (Аеродром) — so whichever
// category is on file decides what the serve can offer.
const ROWS: Property[] = [
  { eb: 53, id: 53, location: 'Аеродром', price: 55000, service: 'buy', bedrooms: 1, size: '44 м²' },
  { eb: 82, id: 82, location: 'Аеродром', price: 143000, service: 'buy', bedrooms: 3, size: '77 м²' },
  { eb: 59, id: 59, location: 'Аеродром', price: 95000, service: 'buy', business: true, sqm: 105, size: '105 м²' },
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  get healthy(): boolean { return true; }
}

function makeHandler(): { send: (m: string) => Promise<string>; slots: () => any } {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const props = new FakeProps(ROWS);
  const llm = new FailingLlm();
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions,
    classifier: new Classifier(llm, cfg, props),
    responder: new Responder(llm, cfg),
    properties: props,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
  });
  const chatId = `type-ask-${Math.random().toString(36).slice(2, 8)}`;
  return {
    send: async (m: string) => { await handler.handle('test', chatId, m); return sent[sent.length - 1] ?? ''; },
    slots: () => sessions.get(chatId)?.slots ?? {},
  };
}

const TYPE_ASK = /кој тип|каков вид|стан, куќа, деловен/iu;
const CATEGORY_ASSUMED = /станот|спални/iu;

test('[19:07] a negated category is stripped — the correction, not the category', () => {
  // The capture: business named, the flat REFUSED.
  assert.equal(detectBusiness('SAKAM DUKJAN DA ZEMAM , NE STAN'), true);
  assert.equal(detectFlat('SAKAM DUKJAN DA ZEMAM , NE STAN'), false);
  // Both scripts, both orders.
  for (const t of ['NE STAN, SAKAM DUKJAN', 'не ми треба стан, барам дуќан',
    'namesto stan sakam lokal', 'НЕ САКАМ СТАН САКАМ ЛОКАЛ']) {
    assert.equal(detectBusiness(t), true, `business lost behind a negated flat: ${t}`);
    assert.equal(detectFlat(t), false, `the refused flat armed the flat flag: ${t}`);
  }
  // SYMMETRIC: a negated BUSINESS releases the residential search.
  assert.equal(detectBusiness('NE SAKAM DUKJAN, BARAM STAN'), false);
  assert.equal(detectFlat('NE SAKAM DUKJAN, BARAM STAN'), true);
  // The positive shapes are untouched.
  assert.equal(detectFlat('SAKAM STAN'), true);
  assert.equal(detectBusiness('SAKAM STAN'), false);
  assert.equal(detectHouse('NE KUKJA, STAN'), false);
  // A negated span with real content is not a correction of the whole message:
  // the apartment is still the subject, the shop is the landmark.
  assert.equal(detectFlat('STANOT NE E BLIZU DO DUKJANOT'), true);
  assert.equal(stripNegatedCategoryWords('NE STAN').trim(), '');
});

test('[19:06] e2e: with no type named the funnel ASKS it, never assumes the flat', async () => {
  const { send, slots } = makeHandler();
  await send('MI TREBA NESTO INTERESNO KAJ CITY MOL');
  const reply = await send('PA DA KUPAM BI SAKAL');
  assert.match(reply, TYPE_ASK, `the type must be asked: ${reply}`);
  assert.ok(!CATEGORY_ASSUMED.test(reply), `a flat nobody named: ${reply}`);
  assert.equal(slots().service, 'buy', 'the service is on file');
  assert.equal(slots().bedrooms, undefined, 'no bedroom slot was invented');
});

test('[19:07] e2e: «SAKAM DUKJAN DA ZEMAM , NE STAN» switches the category and its questions', async () => {
  const { send, slots } = makeHandler();
  await send('MI TREBA NESTO INTERESNO KAJ CITY MOL');
  await send('PA DA KUPAM BI SAKAL');
  const reply = await send('SAKAM DUKJAN DA ZEMAM , NE STAN');
  assert.equal(slots().business, true, `the shop is the category: ${JSON.stringify(slots())}`);
  assert.ok(!slots().flat, 'the refused flat must not be armed');
  assert.match(reply, /м²|површина|квадрат/iu, `a business space is asked its surface: ${reply}`);
  assert.match(reply, /цена|евра|буџет|вклопи/iu, `and its price: ${reply}`);
  assert.ok(!/спални/iu.test(reply), `a shop has no bedrooms: ${reply}`);
});
