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
import { extractSlots } from '../src/llm/deterministic';
import { LlmClient } from '../src/llm/types';
import { LandmarkService } from '../src/geo/landmarks';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

// ── THE [12:33] BUSINESS CAPTURE (dual-budget delivery) ────────────────────
// Client in the business funnel splits the money PER SERVICE across two
// messages: «za kirija do 1000 evra», then «za kupuvanje do 2000000». The
// first banks the rent budget; the second — a buy leg — arms dualService:
// slots.service and slots.budget RETIRE, and the per-service budgets stay
// (the wrong-serve bug: a second budget must never overwrite the first
// service's budget slot).
function makeHandler(): { handler: InboundHandler; sessions: SessionStore; sent: string[] } {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new (class extends PropertyService {
    constructor() { super('http://fake-feed'); }
    async getAll(): Promise<Property[]> { return []; }
    get healthy(): boolean { return true; }
  })();
  const llm = new FailingLlm();
  const classifier = new Classifier(llm, cfg, properties);
  const responder = new Responder(llm, cfg);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false }),
  });
  return { handler, sessions, sent };
}

test('[12:33] dual-budget capture: the buy leg arms dualService instead of overwriting the rent budget slot', async () => {
  const { handler, sessions } = makeHandler();
  const chat = 'cap1233';
  // Cold open into the business funnel (the [12:33] client was asking for a
  // business space): intent → discovery, business slot armed.
  await handler.handle('test', chat, 'baram deloven prostor');
  const s1 = sessions.get(chat)!;
  assert.equal(s1.slots.business, true);

  // LEG 1 — «za kirija do 1000 evra»: a pure budget delivery banks the rent
  // budget AND applies the legacy service/budget pair.
  await handler.handle('test', chat, 'za kirija do 1000 evra');
  const s2 = sessions.get(chat)!;
  assert.equal(s2.slots.service, 'rent');
  assert.equal(s2.slots.budget, '1000');
  assert.equal(s2.slots.rentBudget, '1000');
  assert.equal(s2.slots.dualService, undefined);

  // LEG 2 — «za kupuvanje do 2000000»: the classifier event may drop the
  // service noun (the [12:33] probe: the buy-noun "kupuvanje" was left
  // un-applied), so the capture probes the raw text for the service word.
  // The result must be the dual-service state, NOT a rent-budget overwrite.
  await handler.handle('test', chat, 'za kupuvanje do 2000000');
  const s3 = sessions.get(chat)!;
  assert.equal(s3.slots.dualService, true);
  assert.equal(s3.slots.service, undefined);
  assert.equal(s3.slots.budget, undefined);
  assert.equal(s3.slots.rentBudget, '1000', 'the rent budget MUST survive the buy leg');
  assert.equal(s3.slots.buyBudget, '2000000');
});

test('[12:33] the money-word service probe: "za kupuvanje" extracts as the BUY service even bare', () => {
  const slots1 = extractSlots('za kupuvanje do 2000000');
  assert.equal(slots1.service, 'buy');
  const slots2 = extractSlots('za prodazba do 2000000');
  assert.equal(slots2.service, 'buy');
  const slots3 = extractSlots('za kirija do 1000 evra');
  assert.equal(slots3.service, 'rent');
});

test('[12:33] pure budget delivery with a full search word stays single-service', async () => {
  // «do 2000000 za stan» carries a type noun — a full search event, whose
  // service applies through applySlots, never dual.
  const { handler, sessions } = makeHandler();
  const chat = 'cap1233b';
  await handler.handle('test', chat, 'baram stan');
  await handler.handle('test', chat, 'za kirija do 1000 evra');
  await handler.handle('test', chat, 'do 2000000 za stan');
  const s = sessions.get(chat)!;
  assert.equal(s.slots.dualService, undefined);
  assert.equal(s.slots.service, 'rent');
  assert.equal(s.slots.budget, '2000000');
});
