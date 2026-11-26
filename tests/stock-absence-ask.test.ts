// THE V16K11 CAPTURE (live Viber, 2026-11-25) — «stance nema?»
//
//   [21:41] klient: zdravo rabotite li
//   [21:41] LINA:   Добар ден. Дали за Вас е актуелно купување или сакате да изнајмите…?
//   [21:42] klient: mi treba stan pod kirija / centar
//   [21:42] LINA:   1. Колку спални соби…? 2. Кој износ за месечна кирија…?
//   [21:44] klient: dvosoben ili kukja moze do 300 evra
//   [21:44] LINA:   <куќата EB 50 — no flat at all, and «следниве опции» in the plural>
//   [21:53] klient: stance nema?
//   [21:53] LINA:   Посетата е за куќата со Евидентен број 50 (Центар). … 300 денари …
//                   Дали се согласувате со овој услов…?      ← the visit fee
//
// Two defects, one conversation:
//   1. «dvosoben ili kukja» is the client's EITHER/OR — a two-room flat or a
//      house. The room adjective is not a type noun, so only the house
//      survived and the pool ran houses-only: the flat he named first was
//      never a candidate.
//   2. «stance nema?» is a question about the OFFER. It was read as a pick,
//      and the turn quoted a viewing — a commitment he never made — while
//      saying nothing about whether a flat exists. It is answered with the
//      stock truth now, and never with the fee.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig } from '../src/config';
import { Db } from '../src/store/db';
import { SessionStore, freshSession, ChatSession } from '../src/fsm/session';
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
import { OfflineMapStore, writeMap } from '../src/geo/offlineMap';
import { detectStockAbsenceAsk, detectResidentialNeed, extractSlots } from '../src/llm/deterministic';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429'); }
}

/** The live feed's own rows for this search: the house that was served, the
 *  small flat in the same district, and the two-room flat one district over. */
const ROWS: Property[] = [
  {
    eb: 50, id: 50, location: 'Центар (населба)', address: 'Ул. Тест 50',
    price: 300, bedrooms: 2, sqm: 74, service: 'rent', house: true,
    lat: 41.9962, lon: 21.4147, geo_source: 'stored',
    features: ['двор', 'тераса'],
    landmarks: [{
      landmark: 'Kindergarten "Kocho Racin" - Naum N. Borche', type: 'kindergarten', distance_m: 74,
      maps_url: 'https://maps.google.com/?q=41.9966,21.4144',
    }],
    details: 'Куќа во вид на двоспратна галерија.',
  } as Property,
  {
    eb: 76, id: 76, location: 'Центар', address: 'Ул. Тест 76',
    price: 200, sqm: 24, service: 'rent',
    lat: 41.9949, lon: 21.4318, geo_source: 'stored',
    features: ['наместен'],
    details: 'Мал стан во центарот.',
  } as Property,
  {
    eb: 79, id: 79, location: 'Водно', address: 'Ул. Тест 79',
    price: 300, bedrooms: 2, sqm: 35, service: 'rent',
    lat: 41.9895, lon: 21.4152, geo_source: 'stored',
    features: ['лифт'],
    details: 'Двособен стан на Водно.',
  } as Property,
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  async getAllEbs(): Promise<Set<number>> { return new Set(this.rows.map(r => r.eb)); }
  get healthy(): boolean { return true; }
}

function makeHandler(): {
  handler: InboundHandler; sessions: SessionStore; sent: string[]; map: OfflineMapStore;
} {
  const mapPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stock-absence-')), 'map.db');
  writeMap(mapPath, [], []);
  const db = new Db(':memory:');
  const cfg = loadConfig();
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const props = new FakeProps(ROWS);
  const map = new OfflineMapStore(mapPath);
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, props),
    responder: new Responder(new FailingLlm(), cfg),
    properties: props,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: map }),
  });
  return { handler, sessions, sent, map };
}

/** The notebook as the live turn left it: a rent search in Центар, two rooms,
 *  300 €, the house EB 50 already on the table. */
function seedServed(chatId: string, sessions: SessionStore): ChatSession {
  const s = freshSession('test', chatId);
  s.state = 'presentation';
  s.slots.service = 'rent';
  s.slots.location = 'Центар (населба)';
  s.slots.bedrooms = 2;
  s.slots.budget = '300';
  s.slots.currentBatch = [50];
  s.slots.presentedIds = [50];
  s.slots.interestedPropertyId = 50;
  s.slots.propertyId = 50;
  sessions.set(s);
  return s;
}

// ── 1. the detector ────────────────────────────────────────────────────────

test('a stock question about a type is recognised, in both scripts and every word order', () => {
  for (const t of [
    'stance nema?', 'nema stan?', 'ima li stan?', 'има ли стан во Центар?',
    'nema li kukja do 300?', 'NEMA LI STAN VO CENTAR ?', 'dali ima garsonjera?',
    'ima uste stan?', 'имате ли двособен стан?',
  ]) {
    assert.equal(detectStockAbsenceAsk(t), true, `a stock question: ${t}`);
  }
});

test('everything that only LOOKS like a stock question keeps its own lane', () => {
  for (const t of [
    // a dismissive names no property
    'nema veze, sakam stan', 'нема врска, барам стан',
    // a correction of the type is a statement, not a question
    'nema stan, sakam kukja',
    // a where-is question is geography
    'kade e stanot?',
    // the caught contradiction has its own lane (a card against our «нема»)
    'PA KAKO NEMA STANOVI KOGA OVOJ E EDEN OD NIV?',
    // money and greetings carry no type
    'kolku e kirijata?', 'zdravo', 'nema veze', 'ima 300 evra?',
    // A FEATURE of a known property is FEATURE_ASK (the route mirror caught
    // this one): «станот има паркинг» is a possession sentence, not stock.
    'DALI STANOT IMA PARKING?', 'има ли станот лифт?',
    // A DEMONSTRATIVE type is the SHOWN set — the counted-inventory lane
    // (the [23:57] capture: «SAMO OVIE DVA STANA GI IMATE …?»).
    'SAMO OVIE DVA STANA GI IMATE SO DVE ILI TRI SPALNI ?',
    'овие станови ги имате?',
  ]) {
    assert.equal(detectStockAbsenceAsk(t), false, `not this lane: ${t}`);
  }
});

// ── 2. the either/or is a UNION, not the last word ─────────────────────────

test('«dvosoben ili kukja» is a residential union (the flat is not dropped)', () => {
  const slots = extractSlots('dvosoben ili kukja moze do 300 evra');
  assert.equal(slots.residential, true, 'the union is armed');
  assert.equal(slots.house, undefined, 'the house word does not win the union');
  assert.equal(slots.bedrooms, 2, 'the room count is kept');
  // A NAMED single type is not a union — and neither is a house that happens
  // to carry the room adjective («dvosoбna kukja» is one house).
  assert.equal(detectResidentialNeed('dvosoбna kukja'), false);
  assert.equal(detectResidentialNeed('dvosoben stan'), false);
  assert.equal(detectResidentialNeed('kukja so dve spalni'), false);
});

// ── 3. the live conversation, end to end ───────────────────────────────────

test('[V16K11] the union serves what the client named, and «stance nema?» is answered, not billed', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'v16k11';
  sessions.set(freshSession('test', chatId));

  await handler.handle('test', chatId, 'mi treba stan pod kirija\ncentar');
  await handler.handle('test', chatId, 'dvosoben ili kukja moze do 300 evra');
  const served = sent[sent.length - 1] ?? '';
  const afterServe = sessions.get(chatId)!;
  assert.equal(afterServe.slots.residential, true, 'the union survives the serve');
  // THE UNION IS WHAT MAKES A FLAT APPEAR AT ALL: the live run pooled houses
  // only (`house: true` won the either/or) and served the house alone.
  assert.deepEqual(afterServe.slots.presentedIds, [50, 76],
    `the house AND the flat in the district: ${JSON.stringify(afterServe.slots.presentedIds)}`);
  assert.match(served, /Куќата под Евидентен број 50/u, `the house is served: ${served}`);
  assert.match(served, /Евидентен број 76/u, `the flat beside it is served too: ${served}`);

  sent.length = 0;
  await handler.handle('test', chatId, 'stance nema?');
  const answer = sent[sent.length - 1] ?? '';
  const after = sessions.get(chatId)!;

  // THE QUESTION IS ANSWERED: no such flat, and what there is instead.
  assert.match(answer, /Двособен стан/u, `the asked category is named: ${answer}`);
  assert.match(answer, /немам/u, `the absence is stated: ${answer}`);
  assert.match(answer, /Евидентен број 76/u, `the closest flat in the area is named: ${answer}`);
  assert.match(answer, /Евидентен број 50/u, `the card on the table is not erased: ${answer}`);
  // …AND IT IS NOT A VISIT: no fee, no rung, no closing.
  assert.doesNotMatch(answer, /денари|надомест|посета/u, `never the visit protocol: ${answer}`);
  assert.equal(after.state, 'presentation', `the funnel did not jump to closing: ${after.state}`);
  assert.equal(after.slots.feeDisclosed, undefined, 'no fee was disclosed');
  assert.equal(after.slots.feeRejections ?? 0, 0, 'no rung was burned — this is not resistance');
  assert.equal(after.slots.viewingFeeAgreed, undefined, 'nothing was agreed');
});

test('[V16K11] the absence ask is never a choice of the card on the table', async () => {
  // A house is on the table and the client asks about a flat: without the lane
  // the classifier read the question as a pick and the fee protocol named the
  // house as the visit's subject (the live turn). The house must stay
  // un-picked by a question about something else.
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'v16k11-pick';
  seedServed(chatId, sessions);
  await handler.handle('test', chatId, 'stance nema?');
  const after = sessions.get(chatId)!;
  assert.equal(after.state, 'presentation');
  assert.equal(after.slots.visitWanted, undefined, 'no visit was requested by the question');
  assert.equal(after.slots.ownerContactPending, undefined, 'the owner is not contacted');
  assert.doesNotMatch(sent[sent.length - 1] ?? '', /Посетата е за/u);
});

// ── 4. the yes case is served, not guessed ─────────────────────────────────

test('a stock question the stock can answer is served as a card', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'stock-yes';
  const s = seedServed(chatId, sessions);
  // The client widens the budget: a two-room flat IS available then (EB 79).
  s.slots.location = 'Водно';
  s.slots.budget = '300';
  sessions.set(s);
  await handler.handle('test', chatId, 'ima li dvosoben stan?');
  const answer = sent[sent.length - 1] ?? '';
  const after = sessions.get(chatId)!;
  assert.match(answer, /Да, имам/u, `the yes is stated: ${answer}`);
  assert.match(answer, /Евидентен број 79/u, `the matching flat is served: ${answer}`);
  assert.equal(after.state, 'presentation');
  assert.equal(after.slots.feeDisclosed, undefined, 'still no fee on a stock answer');
  assert.ok((after.slots.presentedIds ?? []).includes(79), 'the served flat is remembered');
});
