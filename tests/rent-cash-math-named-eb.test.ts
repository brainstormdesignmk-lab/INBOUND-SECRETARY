// THE [19:12] CAPTURE — the money question that names the flat.
//
//   [19:10] KOLKU ZEMATE PROVIZIJA ?            → the commission explained ✓
//   [19:12] ZNACI KOLKU PARI TREBA DA IMAM SO MENE ZA DA GO IZNAJMAM 57 ?
//   [19:12] ЛИНА: … надоместот од 300 денари (5 евра) е симболичен …  ✗
//
// The owner's standing rule: when the client asks what to bring on signing day,
// Lina does the ARITHMETIC for that property (commission + deposit + first
// rent). Two defects kept it from happening:
//  1. `detectTotalCostAsk` bailed on ANY digit, so the ЕВИДЕНТЕН БРОЈ in the
//     same sentence threw the question away — the digit reads as an amount to
//     the guard, but an EB is a LISTING;
//  2. the «колку пари треба да имам со мене» shape (the have-family) was not in
//     the cost grammar at all (it knew «што да носам / ќе ме кошта»);
//  3. the lane's anchor came from the session's subjects only, and the flat the
//     client had just NAMED was invisible to it.
//
// Everything here is anchored on the bring-with phrase, so a count question
// («колку спални треба да има станот») can never read as money.
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
import { detectTotalCostAsk } from '../src/llm/deterministic';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

// EB 57 rent at 350 €: commission 175 (50%), owner side 700 (deposit + rent),
// total 875.
const ROWS: Property[] = [
  { eb: 57, id: 57, location: 'Центар', price: 350, service: 'rent', bedrooms: 2, size: '55 м²' },
  { eb: 62, id: 62, location: 'Центар', price: 400, service: 'rent', bedrooms: 2, size: '60 м²' },
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  get healthy(): boolean { return true; }
}

test('[19:12] the have-family is a total-cost ask; an EB is not an amount', () => {
  for (const t of [
    'ZNACI KOLKU PARI TREBA DA IMAM SO MENE ZA DA GO IZNAJMAM 57 ?',
    'KOLKU PARI TREBA DA IMAM SO MENE ?',
    'KOLKU TREBA DA IMAM SO MENE ?',
    'KOLKU TREBA DA NOSAM SO MENE ?',
    'kolku treba da imam so mene',
    'КОЛКУ ПАРИ ТРЕБА ДА ИМАМ СО МЕНЕ?',
  ]) {
    assert.equal(detectTotalCostAsk(t), true, `not read as a cash question: ${t}`);
  }
  // Not money: a count, and a message that STATES an amount (that one is
  // extractRentMath's own lane).
  for (const t of [
    'KOLKU SPALNI TREBA DA IMA STANOT?',
    'KOLKU TREBA DA IMAM',
    'KOLKU PARI TREBA DA IMAM ZA 350 EVRA KIRIJA?',
    'KOLKU PARI TREBA DA IMAM SO MENE ZA 350 EVRA?',
  ]) {
    assert.equal(detectTotalCostAsk(t), false, `false positive: ${t}`);
  }
});

test('[19:12] e2e: the named flat is the anchor — the client gets the arithmetic, not a fee pitch', async () => {
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
    landmarks: new LandmarkService(db, { osm: false }),
  });
  const chatId = 'cash-math-eb';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sent[sent.length - 1] ?? ''; };

  await send('ZDRAVO, BARAM STAN ZA KIRIJA DO 400 EVRA VO CENTAR');
  const reply = await send('ZNACI KOLKU PARI TREBA DA IMAM SO MENE ZA DA GO IZNAJMAM 57 ?');

  // The arithmetic for EB 57's own rent (350 → 175 / 700 / 875), in the copy.
  // EVERY figure carries its unit — a bare «350» is the same defect class as a
  // naked hour (the [19:12] capture's own wording).
  assert.match(reply, /350 евра/u, `the rent is the anchor, with its unit: ${reply}`);
  assert.match(reply, /175 евра/u, `the commission (50%) is computed: ${reply}`);
  assert.match(reply, /700 евра/u, `the owner payload is computed: ${reply}`);
  assert.match(reply, /875 евра/u, `the total on signing day is computed: ${reply}`);
  assert.ok(!/(?<![\d.])(?:350|175|700|875)(?! евра)/u.test(reply),
    `a figure without its unit: ${reply}`);
  // It is the money lane, not the visit-fee ladder and not a bare card.
  assert.ok(!/300 денари|надомест/u.test(reply), `the visit fee was re-sold: ${reply}`);
  assert.ok(!/Евидентен број 57 е/u.test(reply), `a card re-serve instead of the answer: ${reply}`);
  db.close();
});
