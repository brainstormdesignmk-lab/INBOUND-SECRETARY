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
import { extractRentMath, extractSlots, fsmRequired } from '../src/llm/deterministic';

class FailingLlm implements LlmClient { async complete(): Promise<string> { throw new Error('429'); } }
class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

const ROWS: Property[] = [
  { eb: 41, id: 41, location: 'Центар', price: 250, service: 'rent', bedrooms: 2, size: '55 м²' },
] as unknown as Property[];

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
