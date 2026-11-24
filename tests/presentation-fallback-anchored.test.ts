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
 *   2. nothing already on file is re-asked — `missingCriteriaAsk` is
 *      type-aware (спални + money for a стан, м² + price for a деловен
 *      простор) and asks ONLY what is missing. Since the [17:43] order
 *      completes the criteria BEFORE the pair, a batch on the table normally
 *      has nothing left to ask: the fallback must not invent a question about
 *      a criterion the session already holds (the old assertion required the
 *      questions to ride the serve, which only held while the pair was served
 *      with the criteria still owed).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config';
import { Db } from '../src/store/db';
import { SessionStore, freshSession } from '../src/fsm/session';
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
  // TWO MORE two-room rent rows: the [17:43] order makes the setup answer the
  // flat's criteria before the pair, so the criteria answer itself serves a pair
  // and the audit's turn must still find a SECOND batch behind it.
  { eb: 925, id: 925, location: 'Центар', address: 'Ул. Никола Вапцаров 30', price: 480, service: 'rent', bedrooms: 2, sqm: 61, size: '61 м²', lat: 41.9974, lon: 21.4186 },
  { eb: 926, id: 926, location: 'Центар', address: 'Ул. Никола Вапцаров 34', price: 470, service: 'rent', bedrooms: 2, sqm: 58, size: '58 м²', lat: 41.9972, lon: 21.4183 },
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
  // The order the owner fixed ([17:43]): market → TYPE → the category's own
  // questions → the pair. The type answer asks the criteria, so the audit's
  // setup must answer them before a pair is on the table.
  await say('SAKAM DA IZNAJMAM STAN VO BUNJAKOVEC ?');
  await say('DVOSOBEN DO 500');
  const s = sessions.get(chatId)!;
  assert.equal(s.state, 'presentation', 'the setup turn must be in presentation');
  assert.ok(s.slots.poiAnchor, 'the setup turn must carry the place');
  return say(message);
}

const assertAnchoredServe = (reply: string, lane: string): void => {
  assert.match(reply, /Буњак/iu, `${lane}: the place the client named is dropped: ${reply}`);
  assert.match(reply, /(?:m|метри|km) од/iu, `${lane}: the cards state no measured distance: ${reply}`);
  assert.match(reply, /Евидентен број 92\d/u, `${lane}: nothing was served: ${reply}`);
  assert.doesNotMatch(reply, /колку спални/iu, `${lane}: the rooms are on file, never re-asked: ${reply}`);
  assert.doesNotMatch(reply, /До колку евра|До која цена/iu, `${lane}: the money is on file, never re-asked: ${reply}`);
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

// ── THE OWN-AREA RULE REACHES THE FALLBACK TOO (§4p) ────────────────────────
// The [09:03] capture was served by a deterministic lane, but the SAME cards
// are built here when every brain is down, from the session anchor and the pool
// — and a card that names its own naselba must not then measure itself from it.
// The rule lives in `llm/ownArea.ts` only because two serve sites need it; this
// pins the second one (and the handler's resolver wiring, below).
const OWN_AREA_ROWS: Property[] = [
  // Inside Аеродром: roughly 845 m from its centre, ~150 m from Ново Лисиче's.
  { eb: 301, id: 301, location: 'Ново Лисиче', address: 'Ул. Ново Лисиче 4', price: 120000, service: 'buy', bedrooms: 2, sqm: 50, size: '50 м²', lat: 41.98437, lon: 21.4750 },
  // A genuinely different part of town: 4,1 km from Аеродром, so this distance
  // is REAL information and must survive.
  { eb: 302, id: 302, location: 'Центар', address: 'Ул. Македонија 8', price: 121000, service: 'buy', bedrooms: 2, sqm: 51, size: '51 м²', lat: 41.9975, lon: 21.4187 },
];

const cardParagraph = (reply: string, eb: number): string =>
  reply.split(/\n\n/).find(p => p.includes(`број ${eb}`)) ?? '';

test('audit: the fallback never measures a card from the district it sits in', async () => {
  const cfg = loadConfig();
  const offlineMap = new OfflineMapStore(cfg.skopjePoisDb);
  if (!offlineMap.available) return;
  const db = new Db(':memory:');
  const landmarks = new LandmarkService(db, { osm: false, offlineMap });
  const responder = new Responder(new FailingLlm(), cfg);
  responder.setPlaceResolver(name => {
    const hit = landmarks.findPlace(name);
    return hit ? { name: hit.name, lat: hit.lat, lon: hit.lon, type: hit.type } : undefined;
  });
  const session = freshSession('fallback-own-area');
  session.state = 'presentation';
  session.slots.poiAnchor = 'Аеродром';
  session.slots.service = 'buy';
  session.slots.budget = '150000';

  const reply = (await responder.respond(session, OWN_AREA_ROWS, 'HMMM INTERESNO')).text;

  // The opener still names the place the client asked around…
  assert.match(reply, /до Аеродром/iu, `the anchored search must still name Аеродром: ${reply}`);
  // …the flat INSIDE that district states its area without measuring itself…
  const inner = cardParagraph(reply, 301);
  assert.ok(inner, `the inner card is missing: ${reply}`);
  assert.match(inner, /во Ново Лисиче/u, `the inner card names its own area: ${inner}`);
  assert.doesNotMatch(inner, /од Аеродром/u,
    `a flat in Ново Лисиче measured itself from Аеродром: ${inner}`);
  // …and a cross-town flat keeps its real distance (the rule is containment,
  // not «everyone loses their anchor»).
  const outer = cardParagraph(reply, 302);
  assert.ok(outer, `the outer card is missing: ${reply}`);
  assert.match(outer, /од Аеродром/u,
    `a flat 4 km away lost its real distance: ${outer}`);
  db.close();
});

test('audit: the handler hands the responder the place CLASS, not just the pin', async () => {
  // The fallback's own-area rule needs the map row's TYPE (only a RESIDENTIAL
  // AREA can swallow a card's distance). The handler wires that resolver once
  // in its constructor; wiring only `{ name, lat, lon }` would leave the nested
  // case unmarked in the fallback while the deterministic lanes dropped it — the
  // two serve sites disagreeing about the same flat.
  const cfg = loadConfig();
  const offlineMap = new OfflineMapStore(cfg.skopjePoisDb);
  if (!offlineMap.available) return;
  let resolver: ((name: string) => { name: string; lat: number; lon: number; type?: string | null } | undefined) | undefined;
  const fakeResponder = {
    setPlaceResolver(fn: typeof resolver) { resolver = fn; },
  } as unknown as Responder;
  const db = new Db(':memory:');
  new InboundHandler({
    cfg, db, sessions: new SessionStore(db),
    classifier: new Classifier(new FailingLlm(), cfg, new FakeProps(ROWS)),
    responder: fakeResponder,
    properties: new FakeProps(ROWS),
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels: new ChannelRegistry(),
    landmarks: new LandmarkService(db, { osm: false, offlineMap }),
    enrichment: new EnrichmentStore(db),
  });
  assert.ok(resolver, 'the handler must wire a place resolver into the responder');
  const aerodrom = resolver!('Аеродром');
  assert.ok(aerodrom, 'the map knows Аеродром');
  assert.equal(typeof aerodrom!.type, 'string', `the resolver must carry the row class: ${JSON.stringify(aerodrom)}`);
  db.close();
});
