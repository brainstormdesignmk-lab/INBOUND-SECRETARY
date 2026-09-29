// The [00:36] transcript, pinned permanently.
//
// What happened: rent funnel at budget 250, options exhausted. The client did
// the commission arithmetic themselves — "ZNACI 0D 250 EVRA 125 SE ZA VAS?" —
// and Lina answered with the exhausted.plain line ("Сите имоти што
// соодветствуваат…"): the amount re-triggered the search machinery (budget →
// re-present → zero matches) and the exhaustion ask swallowed a math question.
//
// THE CONTRACT (owner-corrected arithmetic, math-ready on any specific rent):
//   commission  = rent / 2    (agency — "половина од месечната кирија")
//   deposit+1st = rent × 2    (owner — "првата месечна кирија и депозит")
//   TOTAL       = rent × 2.5  на денот на потпишување на договорот
//   → rent 250: agency 125, owner 500, TOTAL 625 (NOT 750 — the owner's
//     correction: "my math was wrong, the final sum should be 625 not 750").
// Numbers are always COMPUTED by extractRentMath, never LLM-guessed and never
// hardcoded in the template — the bank variants only carry {r}/{c}/{d}/{t}.
import { test } from 'node:test';
import assert from 'node:assert';
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
import { extractRentMath, computeRentMath, detectTotalCostAsk, extractSlots, fsmRequired } from '../src/llm/deterministic';

class FailingLlm implements LlmClient { async complete(): Promise<string> { throw new Error('429'); } }
class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

const ROWS: Property[] = [
  { eb: 41, id: 41, location: 'Центар', price: 250, service: 'rent', bedrooms: 2, size: '55 м²' },
  { eb: 42, id: 42, location: 'Центар', price: 1200, service: 'rent', bedrooms: 3, size: '90 м²' },
] as unknown as Property[];

test('commission TIERS: <1000 → 50% agency, >=1000 → 100% agency; owner payload unchanged', () => {
  // Low tier: total = rent × 2.5 (the owner-corrected 625 case).
  const low = computeRentMath(250);
  assert.equal(low.tier, 'low');
  assert.equal(low.commission, 125);
  assert.equal(low.deposit, 500);
  assert.equal(low.total, 625);
  assert.equal(computeRentMath(999)!.tier, 'low');
  assert.equal(computeRentMath(999)!.commission, 499.5);
  // Boundary: exactly 1000 is HIGH.
  const boundary = computeRentMath(1000);
  assert.equal(boundary.tier, 'high');
  assert.equal(boundary.commission, 1000);
  assert.equal(boundary.deposit, 2000);
  assert.equal(boundary.total, 3000);
  const high = computeRentMath(1200);
  assert.equal(high.commission, 1200, 'high tier: agency takes the full monthly rent');
  assert.equal(high.total, 3600);
  // Owner payload identical across tiers: deposit+first = rent × 2.
  assert.equal(computeRentMath(250)!.deposit, 500);
  assert.equal(computeRentMath(1200)!.deposit, 2400);
});

test('total-cost ask family: grammar-based, amount-free, vetoed on own lanes', () => {
  for (const t of ['KOLKU KE ME KOSTA KOMPLET OVA?', 'kolku ke me kosta ovoj stan?',
    'KOLKU TREBA DA NOSAM SO MENE ?', 'kolku treba da nosam pari?',
    'SO KOLKU PARI TREBA DA DOJDAM ?', 'so kolku pari da dojdam na potpisuvanjeto?',
    'kolku pari da ponesam?', 'kolku da spremam za denot na potpis?',
    'kolku vkupno ke me cini?']) {
    assert.equal(detectTotalCostAsk(t), true, `total-cost ask: ${t}`);
  }
  // Amount-bearing messages belong to the math lane; consent and viewing
  // fees keep their own lanes; no false fires on plain traffic.
  assert.equal(detectTotalCostAsk('kolku za 500 den?'), false, 'amounts → extractRentMath');
  assert.equal(detectTotalCostAsk('ke platam 500 den za poseta'), false);
  assert.equal(detectTotalCostAsk('kolku e vleznica?'), false);
  assert.equal(detectTotalCostAsk('kolku e kirijata?'), false);
  assert.equal(detectTotalCostAsk('dali e dostapen?'), false);
});

test('rent-math detector matrix: pair arm, halving arm, total-flip, vetoes', () => {
  // Pair arm (2:1 + agency-share marker) — the transcript phrasings.
  const transcript = extractRentMath('ZNACI 0D 250 EVRA 125 SE ZA VAS?');
  assert.ok(transcript, 'the exact transcript line must fire');
  assert.equal(transcript!.rent, 250);
  assert.equal(transcript!.commission, 125);
  assert.equal(transcript!.deposit, 500);
  assert.equal(transcript!.total, 625, 'the corrected total: 250 × 2.5 = 625, never 750');

  for (const [t, rent] of [
    ['od 300 evra 150 za vas?', 300],
    ['znaci od 180 denari 90 se za vas?', 180],
    ['250 евра, 125 за вас?', 250],
  ] as const) {
    const r = extractRentMath(t);
    assert.ok(r, `pair fires: ${t}`);
    assert.equal(r!.rent, rent);
    assert.equal(r!.total, rent * 2.5);
  }

  // Halving arm: single amount + explicit halving token.
  for (const t of ['kirijata e 400, polovina za vas?', '200 evra /2 agencijata?',
    'mesecna kirija 300 evra — pola za vas']) {
    const r = extractRentMath(t);
    assert.ok(r, `halving fires: ${t}`);
    assert.equal(r!.total, r!.rent * 2.5);
  }

  // Total-flip ONLY with an explicit total marker ("vkupno 625 za 2.5?").
  const flip = extractRentMath('znaci vkupno 625 evra t.e. 2.5?');
  assert.ok(flip, 'total-flip fires');
  assert.equal(flip!.rent, 250, '625 stated as the TOTAL → rent 250');
  const confirm = extractRentMath('kirijata e 300, t.e. 2.5?');
  assert.ok(confirm, 'multiplier confirmation fires');
  assert.equal(confirm!.rent, 300, 'a bare "2.5?" never flips — the amount is the rent');

  // VETOES — own lanes and non-math traffic stay out.
  assert.equal(extractRentMath('ke platam 500 den za poseta'), undefined, 'consent stays consent');
  assert.equal(extractRentMath('kolku e vleznica?'), undefined, 'viewing fees stay fees');
  assert.equal(extractRentMath('baram stan do 500 evra'), undefined, 'budget range, no math question');
  assert.equal(extractRentMath('od 250 do 500 evra moze?'), undefined, '2:1 RANGE without the agency marker');
  assert.equal(extractRentMath('imas nesto do 400?'), undefined, 'budget ask, no pair/marker');
  assert.equal(extractRentMath('dali e dostapen?'), undefined, 'no amounts at all');

  // Why the lane sits above the fsmRequired gate: the transcript line
  // extracts budget:"250" — the search machinery would eat it otherwise.
  assert.equal(extractSlots('ZNACI 0D 250 EVRA 125 SE ZA VAS?').budget, '250');
  assert.equal(fsmRequired('ZNACI 0D 250 EVRA 125 SE ZA VAS?'), true);

  // (c) single STATED rent + rent-context + share/cost marker — tier-aware.
  const high = extractRentMath('kirijata e 1200 evra mesecno, kolku e provizijata?');
  assert.ok(high, 'stated high rent with share marker fires');
  assert.equal(high!.tier, 'high');
  assert.equal(high!.commission, 1200, '>=1000 → agency takes the full rent');
  assert.equal(high!.total, 3600);
  const lowStated = extractRentMath('kolku e provizijata za kirija od 800 evra?');
  assert.ok(lowStated, 'stated low rent with share marker fires');
  assert.equal(lowStated!.commission, 400);
  assert.equal(lowStated!.total, 2000);
  // A high rent never reads as a 2:1 pair (no halving exists above 1000).
  assert.equal(extractRentMath('znaci od 1200 evra 600 se za vas?'), undefined,
    '>=1000 has no 2:1 split — the pair arm must not fire');
});

test('[00:36] e2e: rent-math question gets the computed breakdown, never the exhausted line', async () => {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS);
  const classifier = new Classifier(new FailingLlm(), cfg, properties);
  const responder = new Responder(new FailingLlm(), cfg);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db), meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false }) });
  const chat = 'rent-math-0036';
  await handler.handle('test', chat, 'SAKAM STAN POD KIRIJA VO CENTAR DO 250 EVRA');
  await handler.handle('test', chat, 'DA'); // proceed into the funnel (rent intent)

  await handler.handle('test', chat, 'ZNACI 0D 250 EVRA 125 SE ZA VAS?');
  const r = sent.at(-1) ?? '';
  const s = sessions.get(chat)!;
  // The computed breakdown serves — with the owner-corrected arithmetic.
  assert.ok(/125/.test(r), `commission (rent/2) in the reply: ${r}`);
  assert.ok(/625/.test(r), `the corrected total (rent×2.5 = 625) in the reply: ${r}`);
  assert.ok(/500/.test(r), `deposit+first month (rent×2) in the reply: ${r}`);
  assert.ok(!/750/.test(r), `the wrong total must never appear: ${r}`);
  assert.ok(!/исцрпивме|искористивме/.test(r), `never the exhausted.plain line: ${r}`);
  assert.ok(!/Одличен избор! Само Вашето име/.test(r), `never the contact ask: ${r}`);
  // The math amount must never pollute the search slots.
  assert.equal(s.slots.budget, '250', 'budget stays the actual search budget');
});

test('HIGH tier e2e: "KOLKU TREBA DA NOSAM SO MENE ?" on a 1200 rent → the 100% math', async () => {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS);
  const classifier = new Classifier(new FailingLlm(), cfg, properties);
  const responder = new Responder(new FailingLlm(), cfg);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db), meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false }) });
  const chat = 'rent-math-high';
  await handler.handle('test', chat, 'SAKAM STAN POD KIRIJA VO CENTAR DO 1300 EVRA');
  await handler.handle('test', chat, 'DA');
  // Name EB 42 and ask its price — the price relay pins slots.lastPrice=1200
  // (the rent anchor the total-cost lane reads).
  await handler.handle('test', chat, 'KOLKU E STANOT SO EVIDENTEN BROJ 42?');
  const s0 = sessions.get(chat)!;
  assert.equal(s0.slots.lastPrice, '1200', `rent anchor pinned: ${s0.slots.lastPrice}`);

  const r = await handler.handle('test', chat, 'KOLKU TREBA DA NOSAM SO MENE ?') as unknown as void;
  const reply = sent.at(-1) ?? '';
  const s = sessions.get(chat)!;
  assert.ok(/1.200/.test(reply), `rent in the reply: ${reply}`);
  assert.ok(/2.400/.test(reply), `owner payload (rent×2) in the reply: ${reply}`);
  assert.ok(/3.600/.test(reply), `HIGH total (rent×3) in the reply: ${reply}`);
  assert.ok(/целосна/.test(reply), `the 100% wording (not 50%) in the reply: ${reply}`);
  assert.ok(!/половина/.test(reply), `never the low-tier wording: ${reply}`);
  assert.equal(s.slots.service, 'rent');
});
