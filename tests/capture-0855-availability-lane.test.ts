// THE [08:55] CAPTURE — three misfires on one availability thread.
//
//   [08:54] КЛИЕНТ: НЕ МИ Е БИТНО КОЛКУ СПАЛНИ ЌЕ ИМА
//   [08:54] ЛИНА: … ЕВ 76 гарсоњера (Центар) … ЕВ 79 двособен (Водно) …
//   [08:55] КЛИЕНТ: ОВОЈ НА ВОДНО СЛОБОДЕН Е ?
//   [08:55] ЛИНА: Точно, Станот со Евидентен број 79 се наоѓа на Водно.
//                  Точната адреса се открива на денот на посетата.     ← PLACE answer
//   [08:56] КЛИЕНТ: ДАЛИ Е СЛОБОДЕН МОМЕНТАЛНО?
//   [08:56] ЛИНА: … Би требало да е сеуште достапен. Дали сакате да го
//                  исконтактирам сопственикот …?                     ← the ack
//   [08:56] КЛИЕНТ: ПА ВИДИ ПРАШАЈ ДАЛИ Е СЛОБОДЕН
//   [08:56] ЛИНА: (ЗБОР ПО ЗБОР ISTATA ack)                           ← verbatim repeat
//   [08:57] КЛИЕНТ: ДА
//   [08:57] ЛИНА: За жал, ги искористивме сите расположливи понуди на Водно
//                  што го следат Вашиот избор …                       ← EXHAUSTED
//
// Three causes, all fixed here:
//   1. «ОВОЈ НА ВОДНО СЛОБОДЕН Е ?» is a PROPERTY-STATE question that happens to
//      name the area — the POI-confirm lane claimed it on the trailing «?» and
//      answered the place he never asked about. An availability word beside a
//      flat is the availability lane's traffic now (the same stand-down shape as
//      isFeeTraffic on the place lanes).
//   2. «ПА ВИДИ ПРАШАЈ ДАЛИ Е СЛОБОДЕН» is the ARROW: he orders the check. The
//      ack's own question («Дали сакате да го исконтактирам сопственикот?») is
//      what he just answered, so the turn is the fee gate — never the ack again.
//   3. The bare «ДА» belongs to the availability question, but an OLD
//      criteria-done offer («поскапо тука или иста цена во друга населба?») was
//      still pending and its lane read the «да» as ITS answer, found nothing
//      pricier in Водно and served the exhausted line. The ack retires a pending
//      offer, and a pending offer never outranks an open owner-contact question.
//      With the fee told on the arrow turn, the «да» itself is the fee
//      agreement → contact collection (name + phone), not another fee question.
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
import { LandmarkService } from '../src/geo/landmarks';
import { LlmClient } from '../src/llm/types';
import { seedVariants, poolContractViolations } from '../src/data/responseBank';
import {
  isPoiConfirmQuestion, detectAvailabilityAsk, detectSendToOwnerAsk,
} from '../src/llm/deterministic';

const cfg = loadConfig();

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

// The card the field transcript shows, verbatim: a rent двособен on Водно.
const DVOSOBEN_79: Property = {
  eb: 79, id: 79, location: 'Водно', address: 'Водно', price: 300, service: 'rent',
  bedrooms: 2, sqm: 35, size: '35 м²',
} as Property;
// The other card of the batch — it is what makes the ack name its own EB.
const GARSONJERA_76: Property = {
  eb: 76, id: 76, location: 'Центар', address: 'Црногорска', price: 200, service: 'rent',
  studio: true, bedrooms: 1, sqm: 24, size: '24 м²',
} as Property;

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getById(id: number): Promise<Property | undefined> { return this.rows.find(p => p.id === id); }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(p => p.eb === eb); }
  get healthy(): boolean { return true; }
}

function makeHandler(id: string) {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps([GARSONJERA_76, DVOSOBEN_79]);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, t: string) => { sent.push(t); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, properties),
    responder: new Responder(new FailingLlm(), cfg),
    properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false }),
  });
  const say = async (m: string): Promise<string> => {
    await handler.handle('test', id, m);
    return sent.at(-1) ?? '';
  };
  return { say, sessions, chatId: id, sent };
}

/** The [08:54] state verbatim: both cards went out, and the criteria-done
 *  two-way offer was still the last question before the availability thread. */
function stateAfterThePair(id: string, sessions: SessionStore) {
  const s = freshSession('test', id);
  s.state = 'presentation';
  s.slots.service = 'rent';
  s.slots.budget = '300';
  s.slots.sizeWaived = true;
  s.slots.location = 'Водно';
  s.slots.presentedIds = [76, 79];
  s.slots.currentBatch = [76, 79];
  s.slots.moreChoicePending = true;
  s.history = [
    { role: 'assistant', text: 'Ги разгледав Вашите критериуми — предлозите што Ви ги покажав се сè што имам соодветно во моментов. Дали да Ви покажам нешто поскапо во истиот реон, или станови со истата цена во други населби?' },
  ];
  sessions.set(s);
}

// ── 1. the lane collision ────────────────────────────────────────────────────

test('[08:55] an availability question that names an area is a STATE question, not a place question', () => {
  for (const text of ['ОВОЈ НА ВОДНО СЛОБОДЕН Е ?', 'ОВОК НА ВОДНО СЛОБОДЕН Е?']) {
    assert.equal(detectAvailabilityAsk(text), true, `availability is asked: ${text}`);
    assert.equal(isPoiConfirmQuestion(text), false, `never the POI-confirm lane: ${text}`);
  }
  // Genuine place confirms carry no availability word and keep their answer.
  for (const text of ['da ne e vo karpos ?', 'DALI E VO KARPOS ?', 'DA NE E VO SKOPJANKA ?']) {
    assert.equal(detectAvailabilityAsk(text), false, text);
    assert.equal(isPoiConfirmQuestion(text), true, text);
  }
});

test('[08:55] the arrow («ПА ВИДИ ПРАШАЈ…») is the owner check, not a fresh question', () => {
  assert.equal(detectAvailabilityAsk('ПА ВИДИ ПРАШАЈ ДАЛИ Е СЛОБОДЕН'), true);
  assert.equal(detectSendToOwnerAsk('ПА ВИДИ ПРАШАЈ ДАЛИ Е СЛОБОДЕН'), true);
  // A plain availability question is NOT the arrow.
  for (const text of ['ДАЛИ Е СЛОБОДЕН МОМЕНТАЛНО?', 'ОВОЈ НА ВОДНО СЛОБОДЕН Е ?']) {
    assert.equal(detectSendToOwnerAsk(text), false, text);
  }
});

// ── 2. the masculine ack pool ────────────────────────────────────────────────

test('[08:55] the masculine ack pool exists, rotates, and honours its contract', () => {
  const pool = seedVariants('availability.ack.masc');
  assert.ok(pool.length >= 10, `a real pool is owed, got ${pool.length}`);
  assert.deepEqual(poolContractViolations('availability.ack.masc'), [],
    'every masculine ack keeps the availability claim, the owner question and no fee');
  assert.ok(new Set(pool).size === pool.length, 'no duplicate variants — a repeat is what the client heard');
  // The family every availability-ack assertion in the suite reads (the card
  // tests can only see ONE random variant per run). A new variant outside this
  // vocabulary would make those assertions flaky instead of failing honestly.
  const CLAIM = /(?:достап|слобод|актив|располага|фигурира|води|база|понуда|систем|евиденц)/iu;
  for (const v of pool) assert.match(v, CLAIM, `outside the claim family: ${v}`);
});

// ── 3. the field replay, through the real handler ────────────────────────────

test('[08:55] the availability thread answers the flat, rotates, then closes on the fee', async () => {
  const { say, sessions, chatId } = makeHandler('avail-0855');
  stateAfterThePair(chatId, sessions);

  // 1) «ОВОЈ НА ВОДНО СЛОБОДЕН Е ?» — the ack for EB 79, never a location answer.
  const first = await say('ОВОЈ НА ВОДНО СЛОБОДЕН Е ?');
  assert.match(first, /Евидентен број 79/u, `the flat must be named: ${first}`);
  assert.doesNotMatch(first, /Точната адреса се открива на денот на посетата/u,
    `a place answer is the [08:55] defect: ${first}`);
  assert.match(first, /(достапен|слободен|активен|располага|база|фигурира)/iu, first);
  assert.doesNotMatch(first, /достапна(?![а-ш])/u, `a стан takes the masculine ack: ${first}`);
  let s = sessions.get(chatId)!;
  assert.equal(s.slots.interestedPropertyId, 79);
  assert.equal(s.slots.ownerContactPending, true, 'the owner check is offered');
  assert.equal(s.slots.moreChoicePending, undefined,
    'the stale criteria-done offer is retired by the ack');

  // 2) the same question again gets DIFFERENT wording — the repeat was the defect.
  const second = await say('ДАЛИ Е СЛОБОДЕН МОМЕНТАЛНО?');
  assert.notEqual(second, first, `the identical ack was the repeat defect: ${second}`);
  assert.match(second, /Евидентен број 79/u, second);

  // 3) the arrow opens the FEE gate, never a third ack.
  const arrow = await say('ПА ВИДИ ПРАШАЈ ДАЛИ Е СЛОБОДЕН');
  assert.match(arrow, /300\s*денари/u, `the rent visit fee is owed: ${arrow}`);
  assert.doesNotMatch(arrow, /(достапен|слободен)/iu, `the ack is not re-served: ${arrow}`);
  s = sessions.get(chatId)!;
  assert.equal(s.slots.feeDisclosed, true);
  assert.equal(s.slots.ownerContactPending, false, 'the arrow consumed the owner check');
  assert.equal(s.state, 'closing');

  // 4) «ДА» agrees to the fee → contact collection, never an exhausted line.
  const yes = await say('ДА');
  assert.doesNotMatch(yes, /(искористивме|исцрпивме|исцрпени|немаме повеќе)/iu,
    `an exhausted line for a «да» is the [08:57] defect: ${yes}`);
  assert.match(yes, /(име|телефон)/iu, `the contact ask is owed: ${yes}`);
  s = sessions.get(chatId)!;
  assert.equal(s.state, 'contact_collection');
  assert.equal(s.slots.viewingFeeAgreed, true);
  assert.equal(s.slots.propertyId, 79, 'the funnel stays on the flat he asked about');
});
