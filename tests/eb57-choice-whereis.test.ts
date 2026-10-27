/**
 * THE [17:00–17:01] CAPTURE (EB 57, deloven prostor on Ѓуро Стругар):
 *
 *   [17:00] serve: EB 57 (Строг Центар … 1.000 €) + EB 59 — presentation state
 *   [17:01] MISLAM DEKA NAJDOBAR BI BIL 57          ← the client CHOSES EB 57 …
 *   [17:01] KADE TOCNO SE NAOGJA ?                  ← … and asks WHERE it is
 *   [17:01] ЛИНА [без LLM]: Сопственикот е оној кој ги одредува сите услови за
 *           цената…                                  ← NONSENSE (price.negotiate)
 *
 * Repair pinned here:
 *   (1) A choice-by-EB ("najdobar bi bil 57") must never read as a price
 *       negotiation: the counter-offer B8 bridge (modal `bi` + short bridge +
 *       bare digits) fires, but the digits are an EB REFERENCE — ≤4 digits, no
 *       currency, no za/na preposition, and matching a property already shown.
 *       The choice serves the property, never the owner-relay line.
 *   (2) The following "KADE TOCNO SE NAOGJA ?" must answer with the property's
 *       OWN nearby landmark (EB 57 resolves Министерство за правда at 48 m),
 *       never the owner-relay line and never the neighborhood-only fallback.
 *   (3) REAL offers are untouched: big amounts or currency-suffixed digits
 *       ("ke dadam 115000", "ke dadam 400 e") keep the negotiate lane.
 */
import { test } from 'node:test';
import assert from 'node:assert';
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
import { LlmClient } from '../src/llm/types';
import { LandmarkService } from '../src/geo/landmarks';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

// EB 56/57/59 as the live feed serves them (business rent, Центар). EB 57 is
// the REAL feed row: ул. Ѓуро Стругар, ranked landmarks resolved at import.
const ROWS: Property[] = [
  { eb: 57, id: 57, address: 'Ѓуро Стругар', location: 'Центар', city: 'Скопје',
    price: 1000, service: 'rent', sqm: 110, size: '110 м²', business: true, house: false,
    details: 'деловен простор', lat: 41.9942, lon: 21.4297,
    geo_source: 'osm_low_confidence', landmark: 'Министерство за правда',
    landmarks: [
      { type: 'government', landmark: 'Министерство за правда', distance_m: 48 },
      { type: 'square', landmark: 'Плоштад ВМРО', distance_m: 66 },
      { type: 'government', landmark: 'Министерство за социјална политика, демографија и млади', distance_m: 67 },
    ] } as Property,
  { eb: 59, id: 59, address: 'Палома Бјанка', location: 'Центар', city: 'Скопје',
    price: 950, service: 'rent', sqm: 105, size: '105 м²', business: true, house: false,
    details: 'деловен простор', landmark: 'Палома Бјанка',
    landmarks: [{ type: 'mall', landmark: 'Палома Бјанка', distance_m: 12 }] } as Property,
  { eb: 56, id: 56, address: 'ул. Народни Герои', location: 'Центар', city: 'Скопје',
    price: 500, service: 'rent', sqm: 40, size: '40 м²', business: true, house: false,
    details: 'деловен простор', landmark: 'АМБ Росимон',
    landmarks: [{ type: 'am', landmark: 'АМБ Росимон', distance_m: 120 }] } as Property,
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

const OWNER_RELAY_RE = /сопственикот[^\n]*(?:условно|опредуву|одредуву)?|одредува сите услови|го пренесам тоа што го предложивте|услови за цената/iu;

/** The capture's context: business rent, Центар, batch [57, 59] presented. */
function makeHandler(): { handler: InboundHandler; sessions: SessionStore; sent: string[]; chatId: string } {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS);
  const llm = new FailingLlm();
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const handler = new InboundHandler({
    cfg, db, sessions, classifier: new Classifier(llm, cfg, properties),
    responder: new Responder(llm, cfg), properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels, landmarks: new LandmarkService(db, { osm: false }),
  });
  const chatId = 'eb57-choice';
  const chatSession = sessions.get(chatId) ?? freshSession('test', chatId);
  chatSession.slots.service = 'rent';
  chatSession.slots.location = 'Центар';
  chatSession.state = 'presentation';
  chatSession.slots.presentedIds = [57, 59];
  chatSession.slots.propertyId = 59;
  chatSession.slots.interestedPropertyId = 59;
  sessions.set(chatSession);
  return { handler, sessions, sent, chatId };
}

test('a choice by EB ("najdobar bi bil 57") serves the property, never the owner-relay line', async () => {
  const { handler, sessions, sent, chatId } = makeHandler();
  await handler.handle('test', chatId, 'MISLAM DEKA NAJDOBAR BI BIL 57');
  const answer = sent[sent.length - 1] ?? '';
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.propertyId, 57, `the chosen EB must bind: got ${s.slots.propertyId}`);
  assert.ok(/Евидентен број 57/.test(answer), `the choice must serve EB 57, got: ${answer}`);
  assert.ok(!OWNER_RELAY_RE.test(answer), `the negotiate owner-relay line must never fire on an EB choice: ${answer}`);
});

test('the where-ask after the choice answers with EB 57 OWN nearby landmark', async () => {
  const { handler, sessions, sent, chatId } = makeHandler();
  await handler.handle('test', chatId, 'MISLAM DEKA NAJDOBAR BI BIL 57');
  await handler.handle('test', chatId, 'KADE TOCNO SE NAOGJA ?');
  const answer = sent[sent.length - 1] ?? '';
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.propertyId, 57, `still EB 57: got ${s.slots.propertyId}`);
  assert.ok(/во близина на/iu.test(answer), `a nearby answer is required, got: ${answer}`);
  assert.ok(/Министерство за правда/.test(answer), `EB 57's own landmark expected, got: ${answer}`);
  assert.ok(!OWNER_RELAY_RE.test(answer), `the owner-relay line must never answer a where-ask: ${answer}`);
});

test('REAL offers keep the negotiate lane in closing (big amount, currency suffix)', async () => {
  for (const offer of ['KE DADAM 115000', 'KE DADAM 400 E']) {
    const { handler, sessions, sent, chatId } = makeHandler();
    const s0 = sessions.get(chatId)!;
    s0.state = 'closing';
    s0.slots.presentedIds = [57];
    s0.slots.propertyId = 57;
    s0.slots.interestedPropertyId = 57;
    sessions.set(s0);
    await handler.handle('test', chatId, offer);
    const answer = sent[sent.length - 1] ?? '';
    // pickVariant rotates the negotiate family; the owner-relay wording opens
    // the sentence ("Сопственикот ја одредува сумата…") as often as not, so the
    // lane check must be case-insensitive and accept the relay-move phrasing.
    assert.ok(/сопственикот|искомуницирам|пренесам/iu.test(answer),
      `a real price offer must reach the negotiate lane: "${offer}" answered: ${answer}`);
  }
});
