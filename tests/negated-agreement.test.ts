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
import { detectAgreement, detectNegatedAgreement } from '../src/llm/deterministic';

// The [22:2x] LLM-down fee-refusal gap: "ne sum soglasen za ova plakjanje"
// carries the agree-word "soglasen" INSIDE a negation. The token scan had no
// negation guard, so with the LLM down the closing agreement override fired
// FEE_AGREED and the funnel advanced to contact collection — the client who
// just REFUSED the fee was asked for his name and phone. Negated agreements
// must be FEE_REFUSED (the persuasion rungs), never consent. Also found in
// the same sweep: "ne prifakjam nadomestok" read as fee PAYMENT agreement
// (FEE_PAY_NEG_RE covered only the h-spelling "prihakam", not "prifakjam").

class FailingLlm implements LlmClient { async complete(): Promise<string> { throw new Error('429'); } }
class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

const ROWS: Property[] = [
  { eb: 48, id: 48, location: 'Карпош III', price: 250, service: 'rent' },
] as unknown as Property[];

test('detectNegatedAgreement/detectAgreement: negated consent flips to non-agreement', () => {
  for (const t of ['ne sum soglasen za ova plakjanje', 'ne sum soglasen', 'НЕ СУМ СОГЛАСЕН',
    'ne se soglasuvam', 'не се согласувам', 'ne, ne sum soglasen',
    'ne prifakjam nadomestok']) {
    assert.equal(detectNegatedAgreement(t), true, `${t} must be detected as negated`);
    assert.equal(detectAgreement(t), false, `${t} must NOT read as agreement`);
  }
  // genuine agreements stay agreements
  for (const t of ['da, se soglasuvam', 'soglasen sum', 'se soglasuvam so nadomestokot',
    'vo red', 'добро, ќе платам']) {
    assert.equal(detectNegatedAgreement(t), false, `${t} is not negated`);
    assert.equal(detectAgreement(t), true, `${t} must stay agreement`);
  }
  // a negation with NO consent token stays non-agreement without the flag
  assert.equal(detectNegatedAgreement('ne, nemam vreme'), false);
  assert.equal(detectAgreement('ne, nemam vreme'), false);
});

test('fee payment agreement: "ne prifakjam nadomestok" is never consent (f-spelling in the neg guard)', () => {
  // feePay previously fired through the h-spelling-only arm
  const { detectFeePaymentAgreement } = require('../src/llm/deterministic');
  assert.equal(detectFeePaymentAgreement('ne prifakjam nadomestok'), false);
  assert.equal(detectFeePaymentAgreement('ne prihakam nadomestok'), false);
  assert.equal(detectFeePaymentAgreement('ke platam 500 denari'), true); // consent intact
});

async function makeHandler() {
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
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false }),
  });
  return { sessions, sent,
    send: async (chatId: string, m: string) => {
      await handler.handle('test', chatId, m);
      return { s: sessions.get(chatId)!, reply: sent.at(-1) ?? '' };
    } };
}

test('[22:2x] LLM-down closing refusal: "ne sum soglasen za ova plakjanje" runs the fee protocol, never contact collection', async () => {
  const { send, sessions } = await makeHandler();
  const chat = 'negated-agree-e2e';
  await send(chat, 'mi treba stan pod kirija vo karpos do 300');
  await send(chat, 'sakam da go vidam 48');   // -> closing, fee.ask.rent
  assert.equal(sessions.get(chat)!.state, 'closing');

  // THE REFUSAL — with the LLM down. Must stay in the fee funnel (persuasion),
  // increment feeRejections, and NEVER reach contact collection.
  const r1 = await send(chat, 'ne sum soglasen za ova plakjanje');
  const s1 = sessions.get(chat)!;
  assert.equal(s1.state, 'closing', `refusal stays in the fee funnel, got ${s1.state}`);
  assert.equal(s1.slots.feeRejections, 1, 'the refusal is counted');
  assert.ok(!/име|презиме|телефон/iu.test(r1.reply), `never the contact ask: ${r1.reply}`);
  assert.ok(/надомест|симболичн|фиkлтер|разбирам|согласувате/iu.test(r1.reply), `fee protocol served: ${r1.reply}`);

  // a second refusal escalates the persuasion (still never contact)
  const r2 = await send(chat, 'ne se soglasuvam, skapo e');
  assert.equal(sessions.get(chat)!.state, 'closing');
  assert.equal(sessions.get(chat)!.slots.feeRejections, 2);
  assert.ok(!/име и презиме/iu.test(r2.reply), `never the contact ask: ${r2.reply}`);

  // ...and a REAL agreement still advances to contact collection
  const r3 = await send(chat, 'da, se soglasuvam, ke platam');
  assert.equal(sessions.get(chat)!.state, 'contact_collection');
  assert.ok(/име|презиме|телефон/iu.test(r3.reply), `contact ask served: ${r3.reply}`);
});
