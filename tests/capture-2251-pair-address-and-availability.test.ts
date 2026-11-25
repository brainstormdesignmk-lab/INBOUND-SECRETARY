/**
 * FIELD CAPTURE [22:51]–[22:55] — THE PAIR IS THE SUBJECT, ALL THREE TIMES.
 *
 *   [22:51] НА КОЈА АДРЕСА СЕ СТАНОВИВЕ ?      ← asks about BOTH served flats
 *   [22:51] ЛИНА: Евидентен број 66 се наоѓа во близина на СЈО…   ← one only
 *   [22:52] А ДРУГИОТ ?                        ← asks about the other card
 *   [22:52] ЛИНА: Евидентен број 66 се наоѓа во близина на Crescendo School…
 *   [22:55] DOSTAPNI LI SE USTE ?               ← are they still available?
 *   [22:55] ЛИНА: Евидентен број 66 се наоѓа во близина на Неуромедика.
 *
 * Three distinct causes, all pinned here:
 *   1. THE PLURAL ADDRESS ASK answered ONE property. The batch was two flats;
 *      «становиве» («these flats») is about the pair, so the turn owes one
 *      location line per flat — each labelled by its Евидентен број, each from
 *      its OWN row's nearest landmark.
 *   2. «А ДРУГИОТ?» was read as «what else is near» and rotated the SAME flat's
 *      landmarks (Crescendo School is EB 66's second anchor). The definite
 *      "other" reference must reach the OTHER card of the pair.
 *   3. «DOSTAPNI LI SE USTE ?» was read as more-nearby traffic and answered with
 *      a landmark. The availability family knew only the SINGULAR adjective and
 *      the SINGULAR copula «е»; the plural is «достапни … СЕ», so the pair
 *      availability ask (both rows + the per-property fee) never fired.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config';
import { Db } from '../src/store/db';
import { SessionStore, freshSession, assistantTexts } from '../src/fsm/session';
import { Classifier } from '../src/llm/classify';
import { Responder } from '../src/llm/respond';
import { InboundHandler } from '../src/handlers/inbound';
import { PropertyService, Property } from '../src/data/properties';
import { AppointmentStore } from '../src/store/appointments';
import { EscalationStore } from '../src/store/escalations';
import { MetaStore } from '../src/store/meta';
import { ChannelRegistry } from '../src/channels/types';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';
import { LlmClient } from '../src/llm/types';
import { setLearnedBank } from '../src/data/responseBank';
import {
  detectAvailabilityAsk, detectAvailabilityPlural, detectOtherFlatAsk, detectPluralFlatAsk,
} from '../src/llm/deterministic';

setLearnedBank({
  variants: () => [], addVariant: () => false, addExample: () => false,
  metric: () => {}, retrieve: () => undefined,
} as any);

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

const cfg = loadConfig();
let offlineMap: OfflineMapStore | undefined;
const map = (): OfflineMapStore => (offlineMap ??= new OfflineMapStore(cfg.skopjePoisDb));

/** The two Центар three-room flats the capture was holding (EB 66 is the real
 *  Рузвелтова row: 79 м², 137.000 €; EB 95 the second of the pair). */
const ROWS: Property[] = [
  { eb: 66, id: 66, uuid: 'c-66', address: 'РУЗВЕЛТОВА', location: 'Центар', service: 'buy', price: 137000, bedrooms: 3, sqm: 79, size: '79 м²', type: 'flat', lat: 42.0006, lon: 21.4145 } as Property,
  { eb: 95, id: 95, uuid: 'c-95', address: 'УЛ. Б', location: 'Центар', service: 'buy', price: 204000, bedrooms: 3, sqm: 74, size: '74 м²', type: 'flat', lat: 41.9990, lon: 21.4100 } as Property,
];

class FakeProps extends PropertyService {
  constructor() { super('http://feed-not-used'); }
  async getAll(): Promise<Property[]> { return ROWS; }
  async getByEb(eb: number): Promise<Property | undefined> { return ROWS.find(p => p.eb === eb); }
  get healthy(): boolean { return true; }
}

function makePair(): { handler: InboundHandler; sessions: SessionStore; sent: string[]; chatId: string } {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const props = new FakeProps();
  const llm = new FailingLlm();
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(llm, cfg, props),
    responder: new Responder(llm, cfg),
    properties: props,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: map() }),
  });
  const chatId = 'pair-2251';
  const s = freshSession('test', chatId);
  s.state = 'presentation';
  s.slots.location = 'Центар';
  s.slots.poiArea = 'Центар';
  s.slots.service = 'buy';
  s.slots.bedrooms = 3;
  s.slots.currentBatch = [66, 95];
  s.slots.presentedIds = [66, 95];
  s.slots.propertyId = 66;
  s.slots.interestedPropertyId = 66;
  sessions.set(s);
  return { handler, sessions, sent, chatId };
}

// ── 1. The detectors ────────────────────────────────────────────────────────

test('[22:55] the plural availability family includes the plural copula', () => {
  for (const t of [
    'DOSTAPNI LI SE USTE ?',
    'ДАЛИ СЕ ДОСТАПНИ УШТЕ ?',
    'дали се уште се достапни',
    'се уште се достапни?',
    'уште ли се слободни?',
    'СЕ УШТЕ СЕ СЛОБОДНИ?',
    'DALI SE SEUSTE DOSTAPNI?',
  ]) {
    assert.equal(detectAvailabilityAsk(t), true, `availability ask: ${t}`);
    assert.equal(detectAvailabilityPlural(t), true, `plural availability: ${t}`);
  }
  // An ASSERTION about the flats is not an ask (the plural slots all demand a
  // question marker: Q, TIME or LI).
  assert.equal(detectAvailabilityAsk('становите се продадени'), false);
  assert.equal(detectAvailabilityAsk('ДВАТА СТАНА СЕ ДОБРИ'), false);
});

test('[22:51]/[22:52] the pair references are their own shape', () => {
  for (const t of ['А ДРУГИОТ ?', 'a drugiot?', 'И ДРУГАТА?', 'другото?']) {
    assert.equal(detectOtherFlatAsk(t), true, `other: ${t}`);
  }
  // «друго» = something else, «други станови» = other flats: search wishes.
  for (const t of ['STO DRUGO IMATE?', 'други станови?', 'DALI IMATE DRUGI?']) {
    assert.equal(detectOtherFlatAsk(t), false, `not the pair's other card: ${t}`);
  }
  for (const t of ['НА КОЈА АДРЕСА СЕ СТАНОВИВЕ ?', 'ДВАТА?', 'овие два', 'и двете', 'both']) {
    assert.equal(detectPluralFlatAsk(t), true, `pair: ${t}`);
  }
  assert.equal(detectPluralFlatAsk('становите се добри'), false);
});

// ── 2. The capture, end to end ──────────────────────────────────────────────

test('[22:51] a plural address ask answers BOTH flats, each from its own row', async () => {
  const { handler, sessions, sent, chatId } = makePair();
  await handler.handle('test', chatId, 'НА КОЈА АДРЕСА СЕ СТАНОВИВЕ ?');
  const reply = sent[sent.length - 1] ?? '';

  assert.match(reply, /Евидентен број 66/u, `EB 66 answered: ${reply}`);
  assert.match(reply, /Евидентен број 95/u, `EB 95 answered too: ${reply}`);
  // Both location lines, from the rows' own landmarks (СЈО sits by EB 66).
  assert.match(reply, /СЈО/u, `EB 66's own landmark: ${reply}`);
  // The street is still never disclosed — the privacy contract is unchanged.
  assert.doesNotMatch(reply, /Рузвелтова|РУЗВЕЛТОВА|УЛ\. Б/u, `no street: ${reply}`);
  assert.equal((reply.match(/maps\.google\.com/gu) ?? []).length, 2,
    `one pin per flat: ${reply}`);
  // The chat now answers about the LAST flat served.
  assert.equal(sessions.get(chatId)!.slots.propertyId, 95);
});

test('[22:52] «А ДРУГИОТ?» switches to the OTHER flat — never the same one rotated', async () => {
  const { handler, sessions, sent, chatId } = makePair();
  await handler.handle('test', chatId, 'НА КОЈА АДРЕСА СЕ СТАНОВИВЕ ?');
  const first = sent[sent.length - 1] ?? '';
  const firstLandmark95 = /Евидентен број 95 се наоѓа во близина на ([^\n.]+)/u.exec(first)?.[1];

  await handler.handle('test', chatId, 'А ДРУГИОТ ?');
  const second = sent[sent.length - 1] ?? '';
  assert.match(second, /Евидентен број 66/u, `the other card is EB 66: ${second}`);
  assert.doesNotMatch(second, /Евидентен број 95/u, `not the flat already answered: ${second}`);
  assert.equal(sessions.get(chatId)!.slots.propertyId, 66);
  // …and it is EB 66's OWN nearest landmark, not the second anchor of EB 95.
  assert.match(second, /СЈО/u, `EB 66's landmark: ${second}`);
  if (firstLandmark95) assert.ok(!second.includes(firstLandmark95),
    `EB 95's landmark (${firstLandmark95}) is never served for EB 66`);
});

test('[22:55] «DOSTAPNI LI SE USTE ?» answers availability for BOTH flats', async () => {
  const { handler, sent, chatId } = makePair();
  await handler.handle('test', chatId, 'DOSTAPNI LI SE USTE ?');
  const reply = sent[sent.length - 1] ?? '';

  assert.match(reply, /Евидентен број 66/u, `EB 66 availability: ${reply}`);
  assert.match(reply, /Евидентен број 95/u, `EB 95 availability: ${reply}`);
  // The availability lane, not a geography line.
  assert.doesNotMatch(reply, /во близина на/u, `never a landmark: ${reply}`);
  assert.doesNotMatch(reply, /maps\.google\.com/u, `never a pin: ${reply}`);
  assert.match(reply, /достап|актив/u, `availability wording: ${reply}`);
  // The fee is stated PER PROPERTY, as the plural lane always did.
  assert.match(reply, /1\.000 денари|1000 денари/u, `the per-property sum: ${reply}`);
});

test('[22:55] the pair ask never answers for one flat when the batch has two', async () => {
  const { handler, sent, chatId, sessions } = makePair();
  await handler.handle('test', chatId, 'НЕМА ЗНАЧЕЊЕ');
  const baseline = sent.length;
  await handler.handle('test', chatId, 'DOSTAPNI LI SE USTE ?');
  assert.equal(sent.length, baseline + 1, 'exactly one reply');
  const reply = sent[sent.length - 1] ?? '';
  const s = sessions.get(chatId)!;
  // The availability turn owns the fee disclosure (and the visit set it names).
  assert.deepEqual([...(s.slots.visitEbs ?? [])].sort((a, b) => a - b), [66, 95]);
  assert.equal(assistantTexts(s).length > 0, true);
  assert.match(reply, /Дали/u, `the turn ends asking for consent: ${reply}`);
});
