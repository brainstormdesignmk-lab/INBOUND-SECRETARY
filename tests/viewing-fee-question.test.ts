// The [22:20]–[22:21] transcript, pinned permanently.
//
// What happened: fee disclosed ("…500 денари (10 евра)… Дали се согласувате…"),
// client asked back "500DEN ZA POSETA ?" — the AMOUNT-FIRST fee question. No
// detector owned it (no charge-verb → CHARGE_MONEY never fired; not agreement;
// not negotiate), so it fell through to the LLM classifier, which misread the
// amount as a budget slot and the flow landed on the CONTACT ask ("Одличен
// избор! Само Вашето име и презиме…") — collecting info from a client who had
// just asked what the fee IS. The [21:28] fix (441c597) covered CONDITIONAL
// CONSENT; this is the sibling QUESTION family.
//
// The fix (owner's full phrasing list, one family):
//   - VIEWING_NOUN family: посета/poseta, показување/pokazuvanje,
//     гледање/gledanje, визита/vizita, влез/vlez, влезница/vleznica,
//     отварање/otvaranje — one source constant shared by all arms.
//   - detectAmountFeeQuestion: "500DEN ZA POSETA ?" / "za poseta 500 den ?" —
//     fee-sized amount (≤2000 den / ≤100 evr) beside a viewing noun = the fee
//     question, even verb-less. Property-sized amounts stay counter-offers.
//   - kolku + viewing noun, both orders ("kolku e vleznica?", "za vizita
//     kolku?").
//   - charge-verb + viewing noun ("NAPLATUVATE ZA GLEDANJE", "NAPLAKJATE
//     VLEZNICA").
//   - amountless volitional pay + viewing noun ("DA PLATAM ZA VLEZ ?") = the
//     fee QUESTION (vetoed from consent); WITH an amount it stays consent
//     ("ke platam 500 den za poseta" → agreement lane).
// All routed through detectProvisionAsk → provision.ask.* bank explanation.
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
import {
  detectProvisionAsk, detectFeePaymentAgreement, detectAvailabilityAsk,
  detectAmountFeeQuestion,
} from '../src/llm/deterministic';

class FailingLlm implements LlmClient { async complete(): Promise<string> { throw new Error('429'); } }
class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

const ROWS: Property[] = [
  { eb: 90, id: 90, location: 'Центар', price: 95000, service: 'buy', bedrooms: 3, size: '70 м²' },
] as unknown as Property[];

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
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder,
    properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false }),
  });
  return { sessions, sent,
    send: async (chatId: string, m: string) => { await handler.handle('test', chatId, m); return sent.at(-1) ?? ''; } };
}

test('[22:21] detector matrix: the viewing-noun family is fee-question territory', () => {
  const feeQuestions = [
    '500DEN ZA POSETA ?', '500DEN VI E POSETA ?', '500 den za poseta?',
    'NAPLATUVATE ZA GLEDANJE ?', 'naplakjate vleznica?', 'NAPLAKJATE VLEZNICA',
    'DA PLATAM ZA VLEZ ?', 'da platam za gledanje?', 'da platam za pokazhuvanje',
    'DA PLATAM ZA OTVARANJE ?', 'kolku e vleznica?', 'za vizita kolku?',
    'kolku za poseta?', 'ZEMATE PARI ZA POSETA?', 'naplatuvate za poseta?',
  ];
  for (const t of feeQuestions) {
    assert.equal(detectProvisionAsk(t), true, `must be a fee question: ${t}`);
  }
  // Consent with an amount stays consent; availability/property traffic untouched.
  assert.equal(detectProvisionAsk('ke platam 500 den za poseta'), false);
  assert.equal(detectFeePaymentAgreement('ke platam 500 den za poseta'), true);
  assert.equal(detectProvisionAsk('dali e seuste dostapen?'), false);
  // The amount-first question never pollutes slots or reads as availability.
  assert.equal(detectAvailabilityAsk('500DEN ZA POSETA ?'), false);
  assert.equal(detectAmountFeeQuestion('500DEN ZA POSETA ?'), true);
  assert.equal(detectAmountFeeQuestion('140000 za poseta?'), false, 'property-sized amounts are counter-offers');
});

test('[22:21] e2e: "500DEN ZA POSETA ?" → fee explanation, no contact ask, no slot pollution', async () => {
  const { send, sessions } = await makeHandler();
  const chat = 'fee-amount-first';
  await send(chat, 'ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 90');
  const feeAsk = await send(chat, 'BI SAKAL DA GO VIDAV VO ZIVO AKO E NEPRODADEN');
  assert.ok(feeAsk.includes('500'), `fee disclosed first: ${feeAsk}`);

  const r = await send(chat, '500DEN ZA POSETA ?');
  const s = sessions.get(chat)!;
  assert.ok(/провизија/i.test(r) && r.includes('500'), `the fee explanation serves: ${r}`);
  assert.ok(!/Одличен избор! Само Вашето име/.test(r), `never the contact ask: ${r}`);
  assert.equal(s.slots.budget, undefined, 'the fee amount must never land as a budget slot');
  assert.equal(s.state, 'closing', 'the funnel stays at the fee question');
});
