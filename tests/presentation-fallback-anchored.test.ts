/**
 * THE PRESENTATION-LANE AUDIT — every lane that ends in 'presentation' must
 * reach a COMPOSITION site, not the LLM-less fallback's bare catalogue.
 *
 * The FSM has more edges into 'presentation' than the criteria-refinement
 * branch reads: `presentation.STAY`, `presentation.REJECTED`,
 * `property_query.REJECTED`, `closing.REJECTED` all land there with no
 * DETAILS_PROVIDED/SEARCH_REQUESTED event, so the reply composition branch is
 * skipped and the turn falls through to `Responder`. With a brain up that is
 * fine (the LLM composes). With every brain DOWN the code-built fallback ran —
 * and it served the batch with NO place, NO distance and NO criteria question:
 *
 *   Врз основа на информациите што ми ги споделивте, издвоив неколку опции…
 *   Станот под Евидентен број 922 е еднособен стан во Центар. …
 *   Што мислите за понудените опции…?
 *
 * The client had named Буњаковец two messages earlier. Two pins here:
 *   1. the place the client named survives into the fallback, with the
 *      MEASURED distance on every card (the handler wires its landmark
 *      service into the responder once, in the constructor);
 *   2. the funnel's own questions ride the serve — `missingCriteriaAsk` is
 *      type-aware, so a стан asks спални + money and a деловен простор asks
 *      м² + price, and nothing already on file is re-asked.
 */
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
import { EnrichmentStore } from '../src/store/enrichment';
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LlmClient } from '../src/llm/types';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

// Around the map's Буњаковец pin (41.9974581, 21.4186442), enough rent rows for
// a second batch after the first pair was served.
const ROWS: Property[] = [
  { eb: 921, id: 921, location: 'Центар', address: 'Ул. Никола Вапцаров 8', price: 450, service: 'rent', bedrooms: 2, sqm: 62, size: '62 м²', lat: 41.9976, lon: 21.4182 },
  { eb: 922, id: 922, location: 'Центар', address: 'Ул. Никола Вапцаров 21', price: 380, service: 'rent', bedrooms: 1, sqm: 40, size: '40 м²', lat: 41.9981, lon: 21.4195 },
  { eb: 923, id: 923, location: 'Центар', address: 'Ул. Буњаковец 4', price: 700, service: 'rent', bedrooms: 2, sqm: 55, size: '55 м²', lat: 41.9970, lon: 21.4179 },
  { eb: 924, id: 924, location: 'Центар', address: 'Ул. Буњаковец 9', price: 900, service: 'rent', bedrooms: 3, sqm: 90, size: '90 м²', lat: 41.9985, lon: 21.4188 },
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
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, new FakeProps(ROWS)),
    responder: new Responder(new FailingLlm(), cfg),
    properties: new FakeProps(ROWS),
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
    enrichment: new EnrichmentStore(db),
  });
  const say = async (m: string): Promise<string> => {
    await handler.handle('test', id, m);
    return sent.at(-1) ?? '';
  };
  return { say, sessions, chatId: id };
}

/**
 * The audit's shared body: reach presentation the REAL way (place named, then
 * market + type typed), then send the lane's own message. Every assertion is
 * about the fallback's composition, not about which event fired.
 */
async function auditTurn(id: string, message: string): Promise<string> {
  const cfg = loadConfig();
  const map = new OfflineMapStore(cfg.skopjePoisDb);
  if (!map.available) return ''; // no live map on this machine — the pins below are unreachable
  const { say, sessions, chatId } = makeHandler(id);
  await say('ZDRAVO. STO IMATE VO BUNJAKOVEC?');
  await say('SAKAM DA IZNAJMAM STAN VO BUNJAKOVEC ?');
  const s = sessions.get(chatId)!;
  assert.equal(s.state, 'presentation', 'the setup turn must be in presentation');
  assert.ok(s.slots.poiAnchor, 'the setup turn must carry the place');
  return say(message);
}

const assertAnchoredServe = (reply: string, lane: string): void => {
  assert.match(reply, /Буњак/iu, `${lane}: the place the client named is dropped: ${reply}`);
  assert.match(reply, /(?:m|метри|km) од/iu, `${lane}: the cards state no measured distance: ${reply}`);
  assert.match(reply, /Евидентен број 92\d/u, `${lane}: nothing was served: ${reply}`);
  assert.match(reply, /спалн/iu, `${lane}: the rooms question is missing: ${reply}`);
  assert.match(reply, /кирија|цена/iu, `${lane}: the money question is missing: ${reply}`);
};

test('audit: a STAY in presentation still serves the anchor + the questions', async () => {
  const reply = await auditTurn('audit-stay', 'HMMM INTERESNO');
  if (!reply) return; // no map
  assertAnchoredServe(reply, 'STAY');
});

test('audit: a REJECTED in presentation still serves the anchor + the questions', async () => {
  const reply = await auditTurn('audit-rejected', 'NE MI SE DOPAGA OVOJ STAN');
  if (!reply) return;
  assertAnchoredServe(reply, 'REJECTED');
});

test('audit: the ask is TYPE-aware — a business turn is never asked for bedrooms', async () => {
  const cfg = loadConfig();
  const map = new OfflineMapStore(cfg.skopjePoisDb);
  if (!map.available) return;
  const { say, sessions, chatId } = makeHandler('audit-business');
  await say('ZDRAVO. STO IMATE VO BUNJAKOVEC?');
  await say('SAKAM DA IZNAJMAM DUKJAN VO BUNJAKOVEC ?');
  const reply = await say('HMMM INTERESNO');
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.business, true, 'the business category is on file');
  assert.doesNotMatch(reply, /спалн/iu, `a business turn was asked for bedrooms: ${reply}`);
});
