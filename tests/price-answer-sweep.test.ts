// THE PRICE-ANSWER SWEEP — every way a client states his money must be banked
// AS HE SAID IT (or as the dropped thousands he obviously meant), and NEVER as
// something else: not an Евидентен број, not a fraction of some earlier figure.
//
// Harvested from the field captures (data/*.jsonl, the messages that carry a
// price and no property/size/locate word — 84 distinct):
//
//   DO 200 EVRA · DO 500 EVRA · do 250 evra · DO 350 EVR · POMALO NESTO DO
//   300EVRA · BUDJET DO 250 EVRA · 40 KVADRATI, DO 500 EVRA · DO 90000 EVRA ·
//   DO 100.000 · DO 60.000 EVRA · DO 150.000 EVRA · DO 185000 EVRA ·
//   do 100 000 · 200 ILJADI · 100 ILJADI EVRA · 80 ILJADI · 100000 ·
//   KE DADAM 115000 · KE DADAM 400 E · CENTAR SO CENA OKOLU 115 EVRA ·
//   CENTAR SO CENA OKOLU 115 ILJADI EVRA · cena okolu 180 000
//
// WHAT THE SWEEP FOUND (both fixed here):
//   1. A BUY cap typed in small euros dead-ended the funnel: «DO 200 EVRA» was
//      banked as 200 € and the turn answered a NO-MATCH for money the client
//      never meant. On a purchase, a euro figure below anything this market
//      sells is the dropped-thousands shorthand (`purchaseBudgetMagnitude`,
//      200 → 200.000). RENT keeps its literal hundreds (250–1300 € a month is
//      the real band), and a figure with NO euro marker is never touched.
//   2. «KE DADAM 400 E» / «400 E» was read as ЕВИДЕНТЕН БРОЈ 400 — «400
//      моментално го нема во нашата понуда» — because the lone market «E» was
//      not a currency token in the money scan. It is now (Latin, clause-final),
//      in BOTH readers: money and the EB grammar.
//
// NOTHING is read as a fraction of an asked/stored budget: the figures land
// verbatim, or ×1000 for the purchase shorthand. That is what these cases pin.

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
import { detectBudget, extractSlots } from '../src/llm/deterministic';
import { inferPropertyId } from '../src/llm/classify';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

// 3-room rows on both services (the funnel answer below is «DVE SPALNI»).
const ROWS: Property[] = [
  { eb: 901, id: 901, location: 'Центар', price: 70000, bedrooms: 3, sqm: 60, size: '60 м²', service: 'buy', lat: 41.9993, lon: 21.4165 },
  { eb: 902, id: 902, location: 'Центар', price: 120000, bedrooms: 3, sqm: 68, size: '68 м²', service: 'buy', lat: 41.9992, lon: 21.4166 },
  { eb: 903, id: 903, location: 'Центар', price: 180000, bedrooms: 3, sqm: 80, size: '80 м²', service: 'buy', lat: 41.9991, lon: 21.4164 },
  { eb: 904, id: 904, location: 'Центар', price: 260000, bedrooms: 3, sqm: 95, size: '95 м²', service: 'buy', lat: 41.9990, lon: 21.4163 },
  { eb: 951, id: 951, location: 'Центар', price: 250, bedrooms: 3, sqm: 60, size: '60 м²', service: 'rent', lat: 41.9993, lon: 21.4165 },
  { eb: 952, id: 952, location: 'Центар', price: 350, bedrooms: 3, sqm: 65, size: '65 м²', service: 'rent', lat: 41.9992, lon: 21.4166 },
  { eb: 953, id: 953, location: 'Центар', price: 500, bedrooms: 3, sqm: 70, size: '70 м²', service: 'rent', lat: 41.9991, lon: 21.4164 },
  { eb: 954, id: 954, location: 'Центар', price: 900, bedrooms: 3, sqm: 85, size: '85 м²', service: 'rent', lat: 41.9990, lon: 21.4163 },
  { eb: 955, id: 955, location: 'Центар', price: 1300, bedrooms: 3, sqm: 100, size: '100 м²', service: 'rent', lat: 41.9989, lon: 21.4162 },
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  get healthy(): boolean { return true; }
}

function makeHandler(id: string) {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const props = new FakeProps(ROWS);
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

/** Drive the funnel to the budget question, then answer it. */
async function askPrice(service: 'buy' | 'rent', answer: string, id: string) {
  const { say, sessions, chatId } = makeHandler(id);
  await say(service === 'buy'
    ? 'ZDRAVO SAKAM DA KUPAM STAN OKOLU UNIVERZALNA SALA'
    : 'ZDRAVO SAKAM DA IZNAJMAM STAN OKOLU UNIVERZALNA SALA');
  await say('DVE SPALNI');
  const reply = await say(answer);
  return { reply, slots: sessions.get(chatId)!.slots, chatId };
}

/** The Евидентен-број dead end the lone «E» used to trigger. */
const EB_MISS = /нема во нашата понуда|не се наоѓа во моменталната понуда|не го најдов|Евидентен број 400/u;

test('[20:11] a BUY cap typed in small euros is the dropped thousands, never 200 €', async () => {
  const cases: Array<[string, string]> = [
    ['DO 200 EVRA', '200000'],
    ['POMALO NESTO DO 300EVRA', '300000'],
    ['DO 350 EVR', '350000'],
    ['BUDJET DO 250 EVRA', '250000'],
    ['CENTAR SO CENA OKOLU 115 EVRA', '115000'],
    ['KE DADAM 400 E', '400000'],
    ['400 E', '400000'],
  ];
  const failures: string[] = [];
  for (const [i, [answer, want]] of cases.entries()) {
    const { reply, slots } = await askPrice('buy', answer, `buy-small-${i}`);
    if (slots.budget !== want) failures.push(`"${answer}" → budget ${slots.budget}, expected ${want}`);
    if (EB_MISS.test(reply)) failures.push(`"${answer}" → read as an Евидентен број: ${reply.slice(0, 120)}`);
    if (slots.propertyId !== undefined) failures.push(`"${answer}" → pinned a property id ${slots.propertyId}`);
    // The money is inside the pool now: the turn must serve, not dead-end.
    if ((slots.currentBatch ?? []).length === 0) failures.push(`"${answer}" → nothing served for ${want}`);
  }
  assert.deepEqual(failures, []);
});

test('[20:11] a figure that already IS a purchase price is left exactly as typed', async () => {
  const cases: Array<[string, string]> = [
    ['DO 90000 EVRA', '90000'],
    ['DO 100.000', '100000'],
    ['do 100 000', '100000'],
    ['100000', '100000'],
    ['200 ILJADI', '200000'],
    ['100 ILJADI EVRA', '100000'],
    ['DO 150.000 EVRA', '150000'],
    ['DO 80 ILJADI', '80000'],
    ['CENA OKOLU 180 000', '180000'],
    ['KE DADAM 115000', '115000'],
  ];
  const failures: string[] = [];
  for (const [i, [answer, want]] of cases.entries()) {
    const { slots } = await askPrice('buy', answer, `buy-plain-${i}`);
    if (slots.budget !== want) failures.push(`"${answer}" → budget ${slots.budget}, expected ${want}`);
  }
  assert.deepEqual(failures, []);
});

test('[20:11] RENT keeps its literal hundreds — the same words are correct there', async () => {
  const cases: Array<[string, string]> = [
    ['DO 350 EVRA', '350'],
    ['KE DADAM 400 E', '400'],
    ['BUDJET DO 500 EVRA', '500'],
  ];
  const failures: string[] = [];
  for (const [i, [answer, want]] of cases.entries()) {
    const { slots } = await askPrice('rent', answer, `rent-${i}`);
    if (slots.budget !== want) failures.push(`rent "${answer}" → budget ${slots.budget}, expected ${want}`);
    const batch = slots.currentBatch ?? [];
    if (batch.length === 0) failures.push(`rent "${answer}" → nothing served for ${want} €/month`);
    // Contract level, not one fixed pair: the serve is the cheapest pair inside
    // the cap (the exact-cap row arrives on a later «други опции»), so assert
    // the cap holds for every card instead of a pinned EB.
    for (const eb of batch) {
      const price = ROWS.find(r => r.eb === eb)!.price as number;
      if (price > Number(want)) failures.push(`rent "${answer}" → EB ${eb} at ${price} is over the ${want} € cap`);
    }
  }
  assert.deepEqual(failures, []);
});

test('[20:11] the lone «E» is money, the Cyrillic copula is not', () => {
  assert.equal(detectBudget('KE DADAM 400 E'), '400');
  assert.equal(detectBudget('400 e'), '400');
  assert.equal(inferPropertyId('KE DADAM 400 E'), undefined, 'a price is never an Евидентен број');
  assert.equal(inferPropertyId('400 E'), undefined);
  // The copula: «63 e taa» points AT a flat — it is not 63 euros.
  assert.equal(inferPropertyId('DA, 63 E TAA'), 63);
  assert.equal(detectBudget('DA, 63 E TAA'), undefined);
  // A rate is not a cap either.
  assert.equal(inferPropertyId('KOJ TI E TOJ STAN PO 1286E PO M2'), undefined);
  // The service decides the magnitude at the DETECTOR level too.
  assert.equal(extractSlots('MOZE DA KUPAM STAN DO 200 EVRA').budget, '200000');
  assert.equal(extractSlots('SAKAM DA IZNAJMAM STAN DO 300 EVRA').budget, '300');
});
