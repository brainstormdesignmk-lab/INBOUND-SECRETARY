// THE [10:11]–[10:24] CAPTURE — THE €/m² CEILING, THE BAND SERVE AND THE
// CHEAPEST PAIRS.
//
//   [10:10] КАЖИ МИ КАКО ОДАТ СТАНОВИТЕ СО ЦЕНА ПО СКОПЈЕ ?
//   [10:10] ЛИНА: … од 1.234 до 2.889 евра за м² …
//   [10:11] КАДЕ ИМАШ СТАНОВИ ДО 1500 Е ЗА М2 ?
//   [10:11] ЛИНА: Моментално во системот нема станови до 1.500 евра …   ← the bug
//   [10:24] МИСЛАМ ДЕКА ТИ ОБЈАСНИВ ДЕКА БАРАМ ДВОСОБНИ СТАНОВИ
//
// The client capped the RATE (€/m²) and the funnel banked it as a 1.500 € TOTAL
// — a cap almost no flat can meet, so the answer denied stock the band it had
// just quoted (1.234–2.889) proves exists. Two gaps made that possible:
//   • «1500 Е ЗА М2» / «1500Е ЗА КВДРАТ» — the Cyrillic «Е» was not read as the
//     euro shorthand and «КВДРАТ» (one dropped letter) was not the unit, so the
//     per-m² marker never fired and the figure fell into the budget slot;
//   • the cheapest/dearest listing ranked SALE rows by €/m² while its intro
//     claimed «најниска цена», served THREE cards and ignored the room count —
//     «најевтини двособни» led with a 95.000 € трisобен over a 57.000 €
//     двособен.
//
// The contract these tests pin:
//   • the €/m² ceiling is a rate, whatever the spelling (Cyrillic Е, the
//     «КВДРАТ» slip), and «до 1500 евра за станот» stays a total;
//   • a city-wide band search leads from Центар and the ring, serves PAIRS and
//     never denies the range it quotes;
//   • «најевтини <type>» serves a PAIR of THAT type ordered by the price the
//     client pays, and the €/m² band stays a criterion of the ask.

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
import { detectBudget, detectSqmRate, extractSlots } from '../src/llm/deterministic';

// ── 1. THE RATE READER ──────────────────────────────────────────────────────

test('[10:11] the €/m² ceiling survives the client\'s own spelling', () => {
  // The two captured messages, in both scripts.
  for (const text of [
    'КАДЕ ИМАШ СТАНОВИ ДО 1500 Е ЗА М2 ?',
    'БИЛО КАДЕ ДА Е ДО 1500Е ЗА КВДРАТ',
    'STANOVI DO 1500 E ZA M2',
    'DO 1500 E ZA KVADRAT',
    '1500 eura za kvadrat',
  ]) {
    assert.equal(detectSqmRate(text), 1500, `the rate must be read: ${text}`);
    const slots = extractSlots(text);
    assert.equal(slots.sqmRate, 1500, `the rate slot must hold it: ${text}`);
    assert.equal(slots.budget, undefined,
      `a rate is never a total budget (this is the false «нема до 1.500 евра»): ${text}`);
  }
  // A QUOTED rate stays the figure the client read («1286E PO M2» — the [17:44]
  // capture; the number is quoted back, never rounded to the band's ceiling).
  assert.equal(detectSqmRate('1286E PO M2'), 1286);
  assert.equal(extractSlots('1286E PO M2').sqmRate, 1286);
  // A TOTAL stays a total — the same words without the per-m² unit.
  for (const text of ['DO 1500 EVRA ZA STANOT', 'ДО 1500 ЕВРА ЗА СТАНОТ', 'стан до 1500 евра']) {
    assert.equal(detectSqmRate(text), undefined, `no rate here: ${text}`);
    assert.equal(detectBudget(text), '1500', `the total must be read: ${text}`);
  }
});

// ── 2. THE REAL PIPELINE ────────────────────────────────────────────────────

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

const P = (eb: number, location: string, price: number, bedrooms: number, sqm: number): Property => ({
  eb, id: eb, location, address: `${location} ${eb}`, price, bedrooms, sqm, size: `${sqm} м²`,
  service: 'buy', lat: 41.99 + (eb % 7) / 500, lon: 21.43 + (eb % 5) / 500,
  geo_source: 'stored', details: '',
} as Property);

// €/m²: 53→1250 · 63→1286 · 74→2639 · 66→1734 · 87→1234 · 90→1240 · 91→1239
// 92→1385 · 93→1300 · 94→1727 · 95→1325
const ROWS: Property[] = [
  P(53, 'Аеродром', 55000, 2, 44),
  P(63, 'Центар', 36000, 1, 28),
  P(74, 'Центар', 190000, 3, 72),
  P(66, 'Центар', 137000, 3, 79),
  P(87, 'Ново Лисиче', 95000, 3, 77),
  P(90, 'Карпош', 62000, 2, 50),
  P(91, 'Аеродром', 57000, 2, 46),
  P(92, 'Аеродром', 90000, 2, 65),
  P(93, 'Центар', 78000, 2, 60),
  P(94, 'Центар', 95000, 2, 55),
  P(95, 'Капиштец', 53000, 1, 40),
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getById(id: number): Promise<Property | undefined> { return this.rows.find(r => r.id === id || r.eb === id); }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  get healthy(): boolean { return true; }
}

function makeHandler() {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const properties = new FakeProps(ROWS);
  const handler = new InboundHandler({
    cfg: loadConfig(), db, sessions,
    classifier: new Classifier(new FailingLlm(), loadConfig(), properties),
    responder: new Responder(new FailingLlm(), loadConfig()),
    properties,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false }),
  });
  const chatId = 'rate-band';
  const say = async (m: string): Promise<string> => {
    await handler.handle('test', chatId, m);
    return sent.at(-1) ?? '';
  };
  return { say, sessions, chatId };
}

const NO_STOCK = /нема станови до 1\.500|нема двособни до 1\.500|Моментално во системот нема/iu;
const ebsIn = (text: string): number[] => [...text.matchAll(/Евидентен број (\d+)/gu)].map(m => Number(m[1]));

test('[10:11] e2e: «до 1500 Е за м²» never becomes a 1.500 € total — Центар leads, pairs only', async () => {
  const { say, sessions, chatId } = makeHandler();
  sessions.set(freshSession('test', chatId));
  await say('КАЖИ МИ КАКО ОДАТ СТАНОВИТЕ СО ЦЕНА ПО СКОПЈЕ ?');
  const ask = await say('КАДЕ ИМАШ СТАНОВИ ДО 1500 Е ЗА М2 ?');
  assert.equal(sessions.get(chatId)!.slots.sqmRate, 1500,
    `the ceiling is a RATE: ${ask}`);
  assert.equal(sessions.get(chatId)!.slots.budget, undefined,
    `…and never a total budget: ${ask}`);
  await say('ЗА КУПУВАЊЕ НОРМАЛНО');
  const served = await say('БИЛО КАДЕ ДА Е ДО 1500Е ЗА КВДРАТ');
  const s = sessions.get(chatId)!;
  assert.equal(s.state, 'presentation', served);
  assert.doesNotMatch(served, NO_STOCK, `the band it quoted proves stock exists: ${served}`);
  const ebs = ebsIn(served);
  assert.ok(ebs.length >= 1, `a batch must be served: ${served}`);
  assert.ok(ebs.length <= 2, `a PAIR, never a triplet: ${ebs.join(',')}`);
  // The most popular area leads (the owner's order): the first card is Центар.
  assert.match(served, /Евидентен број (?:93|63) е [^.]*во Центар/u,
    `Центар must lead a city-wide band batch: ${served}`);
  // Every card inside the ceiling it was asked to respect (1.500 €/m²).
  const perM2: Record<number, number> = Object.fromEntries(ROWS.map(p => [p.eb, (p.price as number) / (p.sqm as number)]));
  for (const eb of ebs) assert.ok(perM2[eb]! <= 1500, `EB ${eb} is ${Math.round(perM2[eb]!)} €/m² — outside the band`);
});

test('[10:24] e2e: «најевтини двособни» is a PAIR of двособни, cheapest price first', async () => {
  const { say, sessions, chatId } = makeHandler();
  sessions.set(freshSession('test', chatId));
  const reply = await say('KOI TI SE NAJEFTINI DVOSOBNI STANOVI SO GI IMATE VO PONUDA ?');
  const ebs = ebsIn(reply);
  assert.equal(ebs.length, 2, `exactly two cards (the capture served three): ${reply}`);
  // The two cheapest ДВОСОБНИ by the price he pays: 53 (55.000) then 91 (57.000).
  // 63 (36.000) and 95 (53.000) are one-room units and may not lead.
  assert.deepEqual(ebs, [53, 91], `the cheapest двособни in price order: ${reply}`);
  assert.match(reply, /двособен/u, reply);
  assert.doesNotMatch(reply.replace(/двособен/gu, ''), /трисобен|еднособен/u,
    `the type he asked for is the type served: ${reply}`);
  assert.equal(sessions.get(chatId)!.state, 'presentation');
});

test('[10:24] e2e: the €/m² band stays a criterion of the cheapest listing', async () => {
  const { say, sessions, chatId } = makeHandler();
  sessions.set(freshSession('test', chatId));
  const s = freshSession('test', chatId);
  s.slots.service = 'buy';
  s.slots.sqmRate = 1300;     // 53 (1.250) and 87 (1.234) fit, 91 (1.239) fits too
  sessions.set(s);
  const reply = await say('KOI TI SE NAJEFTINI DVOSOBNI STANOVI ?');
  assert.doesNotMatch(reply, NO_STOCK, `stock inside the band exists: ${reply}`);
  const ebs = ebsIn(reply);
  assert.equal(ebs.length, 2, `a pair: ${reply}`);
  const perM2: Record<number, number> = Object.fromEntries(ROWS.map(p => [p.eb, (p.price as number) / (p.sqm as number)]));
  for (const eb of ebs) assert.ok(perM2[eb]! <= 1300, `EB ${eb} breaks the 1.300 €/m² ceiling`);
});
