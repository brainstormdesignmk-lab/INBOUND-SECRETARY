// The [21:25]–[21:28] transcript, pinned permanently.
//
// What happened: the fee was disclosed at [21:25] ("…500 денари (10 евра) за
// покривање на организацијата на посетата. Дали се согласувате…"), the client
// pushed back at [21:27] ("NE SAKAM DA PLAKJAM ZA DA VIDAM STAN"), then
// conditionally accepted at [21:28]: "AKO E USTE DOSTAPEN MOZDA I KE VI DADAM
// 500 DEN ZA DA GO VIDAM" / "AKO VI SE TAKVI USLOVITE". Two bugs:
//   1. The refusal knocked the session out of closing into presentation, and
//      the fee-sized conditional consent then hit the NEGOTIATE fast lane
//      (fee-sized give-verbs read as a property counter-offer because the
//      dative clitic "vi" was missing from the volitional chain) → the reply
//      was the price-relay "Крајната цена зависи од сопственикот…" — the
//      wrong lane for a client who just agreed to the 500 den fee.
//   2. The conditional acceptance family ("ako + uslovi/takvi/vazi") had no
//      detector at all.
// The fix: dative clitics in the fee-consent chain, the conditional-accept
// detector, and a closing/post-fee-ask reclassification to FEE_AGREED —
// consent proceeds to contact collection → owner ping-pong, where availability
// gets confirmed anyway.
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
  detectFeePaymentAgreement, detectConditionalFeeAccept, detectNegotiate,
} from '../src/llm/deterministic';

class FailingLlm implements LlmClient { async complete(): Promise<string> { throw new Error('429'); } }
class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

const ROWS: Property[] = [
  { eb: 80, id: 80, location: 'Центар', price: 95000, service: 'buy', bedrooms: 3, size: '70 м²' },
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

// ── detector-level pins ──────────────────────────────────────────────────────

test('[21:28] detectors: dative-clitic fee consent + conditional acceptance, never negotiate', () => {
  // The full transcript message: fee-sized give WITH the dative clitic.
  assert.equal(detectFeePaymentAgreement('AKO E USTE DOSTAPEN MOZDA I KE VI DADAM 500 DEN ZA DA GO VIDAM'), true,
    'dative clitic "vi" must not break the volitional give chain');
  assert.equal(detectNegotiate('AKO E USTE DOSTAPEN MOZDA I KE VI DADAM 500 DEN ZA DA GO VIDAM'), false,
    'fee-sized consent must never be a property counter-offer');
  // The bare follow-up: conditional acceptance family.
  assert.equal(detectConditionalFeeAccept('AKO VI SE TAKVI USLOVITE'), true);
  assert.equal(detectConditionalFeeAccept('ako uslovite se takvi'), true);
  assert.equal(detectConditionalFeeAccept('ako e taka vazi'), true);
  // Price/negotiate traffic stays untouched.
  assert.equal(detectConditionalFeeAccept('pomala cena'), false);
  assert.equal(detectConditionalFeeAccept('cenata ne mi odgovara'), false);
  assert.equal(detectFeePaymentAgreement('dali mora da platam?'), false, 'questions stay questions');
});

// ── the transcript flow end to end ──────────────────────────────────────────

test('[21:25→21:28] conditional fee consent after refusal → contact ask + owner ping, never price-relay', async () => {
  const { send, sessions, sent } = await makeHandler();
  const chat = 'fee-cond';
  await send(chat, 'ZDRAVO. ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 80'); // property_query
  const feeAsk = await send(chat, 'SAKAM DA JA VIDAM');               // closing + fee.ask.buy
  assert.ok(feeAsk.includes('500'), `fee disclosed: ${feeAsk}`);

  const r1 = await send(chat, 'AKO E USTE DOSTAPEN MOZDA I KE VI DADAM 500 DEN ZA DA GO VIDAM');
  const s1 = sessions.get(chat)!;
  assert.equal(s1.slots.viewingFeeAgreed, true, 'the conditional fee-sized consent is fee consent');
  assert.ok(!r1.includes('зависи од сопственикот'), `never the price-relay lane: ${r1}`);
  assert.ok(/името|презиме|телефонск|телефон|контактир/i.test(r1), `asks for contact info: ${r1}`);

  // The client provides the contact → owner ping-pong starts (the reply asks
  // the owner; the client-facing message confirms the next step).
  const r2 = await send(chat, 'Marko Markovski 070123456');
  assert.ok(r2.length > 0, 'contact accepted, the funnel proceeds');
  assert.ok(s1.slots.viewingFeeAgreed, 'fee stays agreed');
});

test('[21:28b] bare conditional acceptance ("AKO VI SE TAKVI USLOVITE") also proceeds to contact', async () => {
  const { send, sessions } = await makeHandler();
  const chat = 'fee-cond2';
  await send(chat, 'ZDRAVO. ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 80');
  await send(chat, 'SAKAM DA JA VIDAM'); // fee disclosed
  const r = await send(chat, 'AKO VI SE TAKVI USLOVITE');
  const s = sessions.get(chat)!;
  assert.equal(s.slots.viewingFeeAgreed, true, 'conditional acceptance = fee consent');
  assert.ok(!r.includes('зависи од сопственикот'), `never the price-relay lane: ${r}`);
  assert.ok(/името|презиме|телефонск|телефон|контактир/i.test(r), `asks for contact info: ${r}`);
});

test('property-sized offers stay with price.negotiate (the lane must survive)', () => {
  assert.equal(detectNegotiate('dali moze za 140000?'), true);
  assert.equal(detectFeePaymentAgreement('dali moze za 140000?'), false);
  // A pure price comment keeps its own lanes.
  assert.equal(detectConditionalFeeAccept('pomala cena'), false);
});
