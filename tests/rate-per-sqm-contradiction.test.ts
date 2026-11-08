/**
 * THE [02:09]–[02:12] CAPTURE — the €/m² criterion, and the caught contradiction.
 *
 *   [02:09] STANCE VO AERODROM PO 1500E ZA KVADRAT ?
 *     → «Моментално во системот нема станови до 1.500 евра во Аеродром.»
 *     «PO 1500E ZA KVADRAT» caps the RATE (1.500 € per m²), not the sum. Read
 *     as a total it buys nothing in this market, so the funnel denied stock it
 *     OWNED — and then served a 1.250 €/m² flat in the same conversation.
 *
 *   [02:12] PA KAKO NEMA STANOVI DO 1500E ZA KVADRAT …, KOGA OVOJ E EDEN OD NIV?
 *     → «Да, директно до Аеродром. Точната адреса се открива на денот на
 *        посетата.»
 *     The POI lane read the area word and answered a place question nobody
 *     asked. A client who has CAUGHT a contradiction is owed an admission, the
 *     row's own facts and a next step — never a location line.
 *
 * The rate criterion is type-agnostic by construction: it filters price ÷ м²,
 * so a flat, a house or a shop all answer it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config';
import { Db } from '../src/store/db';
import { SessionStore } from '../src/fsm/session';
import { Classifier } from '../src/llm/classify';
import { Responder } from '../src/llm/respond';
import { PropertyService, Property, pricePerM2 } from '../src/data/properties';
import { AppointmentStore } from '../src/store/appointments';
import { EscalationStore } from '../src/store/escalations';
import { MetaStore } from '../src/store/meta';
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';
import { LlmClient } from '../src/llm/types';
import { detectBudget, detectSqmRate, detectStockContradiction, extractSlots } from '../src/llm/deterministic';

const cfg = loadConfig();

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getById(id: number): Promise<Property | undefined> { return this.rows.find(p => p.id === id); }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(p => p.eb === eb); }
  get healthy(): boolean { return true; }
}

const ROWS: Property[] = [
  // 1.250 €/m² — inside a 1.500 ceiling
  { eb: 53, id: 53, location: 'Аеродром', price: 55000, service: 'buy', sqm: 44, size: '44 м²',
    lat: 41.9863, lon: 21.4663, details: 'Мансарда со посебна спална соба.' } as Property,
  // 1.900 €/m² — OUTSIDE it
  { eb: 65, id: 65, location: 'Аеродром', price: 95000, service: 'buy', sqm: 50, size: '50 м²',
    lat: 41.985, lon: 21.467, details: 'Реновиран стан.' } as Property,
  // a HOUSE under the same ceiling — the rate is not an apartment metric
  { eb: 77, id: 77, location: 'Аеродром', price: 120000, service: 'buy', sqm: 120, size: '120 м²',
    house: true, lat: 41.984, lon: 21.468, details: 'Куќа со двор.' } as Property,
];

function makeHandler(rows: Property[] = ROWS, chatId = 'rate-sqm') {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, t: string) => { sent.push(t); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, new FakeProps(rows)),
    responder: new Responder(new FailingLlm(), cfg),
    properties: new FakeProps(rows),
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
  });
  const say = async (m: string): Promise<string> => {
    const before = sent.length;
    await handler.handle('test', chatId, m);
    return sent.slice(before).join('\n');
  };
  return { say, sessions, chatId };
}

// ── 1. the criterion is a RATE ──────────────────────────────────────────────

test('[02:09] a per-m² figure is a rate, never a total cap', () => {
  const cases: Array<[string, number | undefined]> = [
    ['STANCE VO AERODROM PO 1500E ZA KVADRAT ?', 1500],
    ['1000 evra po kvadrat', 1000],
    ['do 1200 e/m2', 1200],
    ['do 1200 evra/m²', 1200],
    ['околу 1.500 € за квадрат', 1500],
    ['1500 evra za kvadraten metar', 1500],
    // A BAND IS A BAND (the [02:14] capture): two figures, one rate marker. The
    // old digit run swallowed the space and read 15.001.600 €/m² — a cap no
    // flat can meet, so the pool emptied. The ceiling of the band is the cap.
    ['PA DA RECEME 1500 1600 EVRA ZA KVADRAT', 1600],
    ['1500 1600 evra za kvadrat', 1600],
    ['околу 1.400 1.600 € за квадрат', 1600],
    // NOT a rate — these keep their ordinary money reading.
    ['1500 evra za stanot', undefined],
    ['DAJ MI STAN DO 1500 EVRA', undefined],
    ['kirija do 1500 evra', undefined],
  ];
  for (const [text, want] of cases) assert.equal(detectSqmRate(text), want, `rate read: ${text}`);
  // …and the slot never lands in `budget`.
  const s = extractSlots('STANCE VO AERODROM PO 1500E ZA KVADRAT ?');
  assert.equal(s.sqmRate, 1500);
  assert.equal(s.budget, undefined, `a rate must never become a total cap: ${JSON.stringify(s)}`);
  const rentS = extractSlots('ZA IZNAJMUVANJE 1500 evra po kvadrat');
  assert.equal(rentS.sqmRate, undefined, 'a rent funnel has no €/m² metric');
  assert.equal(rentS.budget, '1500', 'the rent figure keeps its monthly reading');
});

test('[02:09] e2e: the rate filters and ranks ACROSS TYPES, and never asks the total', async () => {
  const { say, sessions, chatId } = makeHandler();
  await say('ZDRAVO');
  const ask = await say('STANCE VO AERODROM PO 1500E ZA KVADRAT ?');
  await say('DA KUPAM NORMALNO');
  const answer = await say('BILO KOLKU');

  // The market question comes first (the client had not named it). Bank
  // variants rotate («купување/изнајмување», «купите стан/стан под закуп») —
  // the contract is that BOTH sides of the market are offered, not one wording.
  assert.ok(/купув|купите|изнајм|закуп/iu.test(ask), `the market is owed first: ${ask}`);
  // …the 1.250 €/m² flat is inside the ceiling, the 1.900 €/m² one is not.
  assert.match(answer, /Евидентен број 53/u, `the in-rate flat must serve: ${answer}`);
  assert.doesNotMatch(answer, /Евидентен број 65/u, `a 1.900 €/m² flat is NOT inside 1.500 €/m²: ${answer}`);
  // The money question is answered by the rate — it is never re-asked.
  assert.doesNotMatch(answer, /До која цена|колку евра месечна кирија|горната граница/iu,
    `the total cap was re-asked over a rate answer: ${answer}`);
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.sqmRate, 1500, `the rate is on file: ${JSON.stringify(s.slots)}`);
  assert.equal(s.slots.budget, undefined, 'the rate never became a 1.500 € sum');
});

test('[02:14] two figures never glue into one: a money range survives the scan', () => {
  // The regression this pins: «1500 1600» came back as 15.001.600.
  assert.equal(detectBudget('PA DA RECEME 1500 1600 EVRA ZA KVADRAT'), '1600');
  assert.equal(detectBudget('DAJ MI STAN OKOLU 60 000 70 000'), '70000');
  // …while a genuine THOUSANDS group (exactly three digits after the space) is
  // still ONE number — the fix must not break «100 000» / «1 500 000».
  assert.equal(detectBudget('100 000'), '100000');
  assert.equal(detectBudget('OKOLU 1 500 000 EVRA'), '1500000');
  assert.equal(detectSqmRate('PA DA RECEME 1500 1600 EVRA ZA KVADRAT'), 1600);
});

test('[02:14] e2e: a capped rate filters the pool and speaks in €/m²', async () => {
  const { say, sessions, chatId } = makeHandler(ROWS, 'rate-cap-1800');
  await say('ZDRAVO');
  await say('STANCE VO AERODROM DO 1800E PO KVADRAT ?');
  await say('DA KUPAM NORMALNO');
  const answer = await say('BILO KOLKU');
  // 1.250 and 1.900 €/m² are both inside/outside 1.800: only the first serves.
  assert.match(answer, /Евидентен број 53/u, `the 1.250 €/m² flat must serve: ${answer}`);
  assert.doesNotMatch(answer, /Евидентен број 65/u, `1.900 €/m² is over the 1.800 cap: ${answer}`);
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.sqmRate, 1800, `the cap is a RATE, on file: ${JSON.stringify(s.slots)}`);
  assert.equal(s.slots.budget, undefined, 'a per-m² figure is never a 1.800 € total');
});

test('[02:09] the rate also answers a HOUSE ask (not an apartment-only metric)', async () => {
  const { say, chatId, sessions } = makeHandler();
  await say('ZDRAVO');
  await say('KUKJA VO AERODROM PO 1200E ZA KVADRAT ?');
  await say('ZA KUPUVANJE SUM');
  const answer = await say('DVE SPALNI');
  assert.equal(sessions.get(chatId)!.slots.budget, undefined, 'still no total cap');
  assert.match(answer, /Евидентен број 77/u, `the house at 1.000 €/m² must serve: ${answer}`);
});

// ── 2. the empty pool speaks the rate ──────────────────────────────────────

test('[02:09] an empty rate pool says «за м²», never a 1.000 € total', async () => {
  const { say } = makeHandler(ROWS, 'rate-empty');
  await say('ZDRAVO');
  await say('STANCE VO AERODROM PO 1000E ZA KVADRAT ?');
  await say('DA KUPAM NORMALNO');
  const answer = await say('BILO KOLKU');
  assert.match(answer, /нема станови до 1\.000 евра за м²/iu,
    `the absence names the RATE: ${answer}`);
  assert.match(answer, /Дали/u, `the pivot is offered: ${answer}`);
});

// ── 3. the caught contradiction ────────────────────────────────────────────

test('[02:12] the contradiction family fires only on stock traffic', () => {
  for (const t of [
    'PA KAKO NEMA STANOVI DO 1500E ZA KVADRAT VO AERODROM , KOGA OVOJ WE EDEN OD NIV?',
    'kako nema koga veke mi dade eden stan',
    'КАКО НЕМА? ВЕЌЕ МИ ДАДЕ ЕДЕН СТАН СО 1250Е',
    'PA KAKO NEMA STANOVI ?',
    'veke mi pokaza stan so 1250 evra, a velis nema',
  ]) assert.equal(detectStockContradiction(t), true, `the challenge must fire: ${t}`);
  for (const t of [
    'KAKO NEMA DA MOZAM UTRE',          // a scheduling refusal, not stock
    'KAKO NEMA VREME',
    'NEMA PROBLEM, DOJDETE',
    'PA KAKO NEMA?',                    // no stock noun, no proof — another lane
  ]) assert.equal(detectStockContradiction(t), false, `over-eager: ${t}`);
});

test('[02:12] e2e: caught out, she admits it with the row\'s own numbers', async () => {
  const { say } = makeHandler(ROWS, 'contradiction');
  await say('ZDRAVO');
  await say('STANCE VO AERODROM PO 1500E ZA KVADRAT ?');
  await say('DA KUPAM NORMALNO');
  await say('BILO KOLKU'); // serves EB 53 (1.250 €/m²)
  const answer = await say('PA KAKO NEMA STANOVI DO 1500E ZA KVADRAT VO AERODROM , KOGA OVOJ WE EDEN OD NIV?');
  assert.match(answer, /Извинете/iu, `the mistake is owned: ${answer}`);
  assert.match(answer, /Евидентен број 53/u, `the row is named: ${answer}`);
  assert.match(answer, /1\.250 евра за м²/u, `the row's own rate settles it: ${answer}`);
  assert.match(answer, /1\.500 евра за м²/u, `the client's threshold is quoted: ${answer}`);
  assert.match(answer, /Дали/u, `the funnel continues: ${answer}`);
  assert.doesNotMatch(answer, /Точната адреса се открива/u,
    `a location line answered a contradiction: ${answer}`);
  void pricePerM2;
});
