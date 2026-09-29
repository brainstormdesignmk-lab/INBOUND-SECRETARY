// The three remaining TUI captures (data/tui-capture.jsonl, 2026-09-28), mined
// and pinned. Each was a deterministicClassify() fallthrough — the reply was
// usually RIGHT (deterministic downstream), but an LLM classify round decided
// it, which means: latency, quota dependence, and (for ZDRAVO) the documented
// SEEN_PROPERTY hallucination class that GUARD 1b exists for. The learning
// layer's whole point: a captured phrasing stops being "novel" once a
// detector owns it — det-classify must return non-undefined.
//
// 1. "ZDRAVO" @idle → GREETING_STAY. Pure greetings are owned by det-classify
//    via the shared GREETING_ONLY_RE (moved from inbound.ts so the reset
//    consumer and the pre-classify agree on what a "pure" hello is). The
//    LLM once routed this to property_locate ("do you know the EB?").
// 2. "SAKAM DA ZEMAM STAN POD KIRIJA" @idle → INTENT_DECLARED(service=rent).
//    The old deferral — "INTENT_DECLARED without details → let the LLM
//    enrich" — treated an EXPLICIT service as enrichment material; with the
//    LLM down the funnel re-asked "купување или изнајмување?" — the exact
//    question the client had just answered. Service is stated fact; discovery
//    asks only what is still missing (location → bedrooms → budget).
// 3. "PA VIDI STO E SO NEGO\nZAINTERESIRAN SUM" @closing → CLOSING_INTEREST_STAY.
//    Deferred-interest tail while the fee funnel is live: the interest
//    override only owned the intake states, so closing fell to the LLM (which
//    kept the funnel — right verdict, wrong owner). Now det-classify returns
//    STAY directly (after the no-slot deferral gate, which fires first on
//    empty slots) and the fee ask re-serves. Guarded: no investment opinion,
//    property still on the table, rejections/agreements keep their lanes.
// 4. "ZDRAVO\nSAKAM DA IZNAJMAM STANCE" (22:22) → INTENT_DECLARED(rent). The
//    greeting-plus-intent burst rode an LLM classify round (1471 ms) before
//    the INTENT_DECLARED ownership branch landed; det-classify owns it now —
//    pinned as a regression guarantee (stance = станче diminutive is in the
//    service lexicon).
// 5. "NE MISLEV NISTO VULGARNO" (22:30) → META_CLARIFY_STAY. After an abrupt
//    deterministic serve the client defended their own words (they had read
//    the address-privacy deflection as an insinuation). A no-info meta line
//    with no question, no criteria, no property — an LLM round classified it
//    (1645 ms) while the funnel re-asked anyway. detectMetaClarify owns the
//    family (first-person negated-thought arms + topic veto) as STAY.
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
import { GREETING_ONLY_RE, detectMetaClarify } from '../src/llm/deterministic';

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

test('mined captures: det-classify owns all three TUI fallthroughs (FailingLlm)', async () => {
  const cfg = loadConfig();
  const classifier = new Classifier(new FailingLlm(), cfg, undefined);

  // 1. Pure greeting in idle — owned, no LLM round-trip.
  const g = await classifier.deterministicClassify({ state: 'idle', slots: {} } as any, 'ZDRAVO');
  assert.ok(g, 'ZDRAVO must be owned by det-classify');
  assert.equal(g!.event.type, 'STAY');

  // 2. Explicit rent need, no location — owned as INTENT_DECLARED(service=rent).
  const r = await classifier.deterministicClassify({ state: 'idle', slots: {} } as any, 'SAKAM DA ZEMAM STAN POD KIRIJA');
  assert.ok(r, 'rent need must be owned by det-classify');
  assert.equal(r!.event.type, 'INTENT_DECLARED');
  assert.equal((r!.event as any).service, 'rent');

  // 3. Deferred-interest tail in closing (property on table) — owned as STAY.
  const c = await classifier.deterministicClassify(
    { state: 'closing', slots: { propertyId: 90, service: 'buy' } } as any,
    'PA VIDI STO E SO NEGO\nZAINTERESIRAN SUM');
  assert.ok(c, 'closing interest re-affirmation must be owned by det-classify');
  assert.equal(c!.event.type, 'STAY');
});

test('mined captures: the greeting whitelist is shared and tight', () => {
  for (const g of ['ZDRAVO', 'здраво', 'Zdravo!', 'dobar den, kako ste?', 'Pozz 😊']) {
    assert.ok(GREETING_ONLY_RE.test(g.trim()), `pure greeting: ${g}`);
  }
  for (const b of ['ZDRAVO, dali stanot 90 e dostapen?', 'ZDRAVO baram stan do 300',
    'zdravo, 500den za poseta?']) {
    assert.ok(!GREETING_ONLY_RE.test(b.trim()), `not a pure greeting: ${b}`);
  }
});

test('mined captures e2e: rent need → discovery asks LOCATION, never re-asks the intent', async () => {
  const { send, sessions } = await makeHandler();
  const chat = 'capture-rent-need';
  const r = await send(chat, 'SAKAM DA ZEMAM STAN POD KIRIJA');
  const s = sessions.get(chat)!;
  assert.equal(s.state, 'discovery', `funnel advances to discovery, got ${s.state}`);
  assert.equal(s.slots.service, 'rent', 'the stated service is pinned');
  // Wording-agnostic: the location-ask pool mixes seed AND learned variants
  // ("во кој дел…", "која населба…", "одредена локација во градот…").
  assert.ok(/дел|населб|локаци/i.test(r), `asks for the missing LOCATION: ${r}`);
  assert.ok(!/купување или изнајмување/i.test(r), `never re-asks the answered intent: ${r}`);
});

test('mined captures e2e: closing interest tail re-serves the fee ask, no contact ask', async () => {
  const { send, sessions } = await makeHandler();
  const chat = 'capture-closing-tail';
  await send(chat, 'ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 90');
  const feeAsk = await send(chat, 'BI SAKAL DA GO VIDAV VO ZIVO AKO E NEPRODADEN');
  assert.ok(feeAsk.includes('500'), `fee disclosed first: ${feeAsk}`);

  const r = await send(chat, 'PA VIDI STO E SO NEGO\nZAINTERESIRAN SUM');
  const s = sessions.get(chat)!;
  assert.ok(r.includes('500'), `the fee ask re-serves: ${r}`);
  assert.ok(!/Само Вашето име/.test(r), `never the contact ask: ${r}`);
  assert.equal(s.state, 'closing', 'the fee funnel stays live');
});

test('mined captures e2e: fresh-session ZDRAVO gets the greeting.open ask, not an EB probe', async () => {
  const { send, sessions } = await makeHandler();
  const chat = 'capture-zdravo';
  const r = await send(chat, 'ZDRAVO');
  const s = sessions.get(chat)!;
  assert.equal(s.state, 'idle', 'no hallucinated property funnel');
  assert.ok(/Повелете|Здраво|Добар ден|купување или изнајмување/i.test(r), `greeting/open ask serves: ${r}`);
  assert.ok(!/Евидентен број/.test(r), `never the "do you know the EB" probe: ${r}`);
});

// The [22:22] capture (greeting + "stance" diminutive in one burst): the
// ownership branch predates the capture, but it must STAY owned — pinned as a
// regression guarantee. Byte-for-byte verbatim, newline included.
test('mined captures: greeting+intent burst ("ZDRAVO\nSAKAM DA IZNAJMAM STANCE") is det-owned INTENT_DECLARED(rent)', async () => {
  const cfg = loadConfig();
  const classifier = new Classifier(new FailingLlm(), cfg, undefined);
  const r = await classifier.deterministicClassify({ state: 'idle', slots: {} } as any,
    'ZDRAVO\nSAKAM DA IZNAJMAM STANCE');
  assert.ok(r, 'burst must be owned by det-classify');
  assert.equal(r!.event.type, 'INTENT_DECLARED');
  assert.equal((r!.event as any).service, 'rent', 'the diminutive stance is rent vocabulary');
});

// The [22:30] capture: a no-info defense of the client's own words. The
// detector matrix guards the family (topic veto: opinions/corrections about
// the SEARCH keep their lanes; quoted offense replays never match).
test('mined captures: meta-clarification ("NE MISLEV NISTO VULGARNO") is det-owned STAY', async () => {
  // detector family
  for (const t of ['NE MISLEV NISTO VULGARNO', 'не мислев ништо вулгарно',
    'ne mislam nisto losho', 'немав намера ништо лошо', 'nemas veze, ne bev so zla namera']) {
    assert.equal(detectMetaClarify(t), true, `${t} must fire`);
  }
  for (const t of ['stanot nema nishto losho', 'не мислам дека е добра цена',
    'не мислам да купам', 'ti reka deka sum vulgaren', 'mi treba stan pod kirija']) {
    assert.equal(detectMetaClarify(t), false, `${t} must stay clean`);
  }
  // det-classify ownership in funnel states
  const cfg = loadConfig();
  const classifier = new Classifier(new FailingLlm(), cfg, undefined);
  for (const state of ['discovery', 'closing', 'presentation']) {
    const r = await classifier.deterministicClassify(
      { state, slots: state === 'discovery' ? {} : { propertyId: 90, service: 'buy' } } as any,
      'NE MISLEV NISTO VULGARNO');
    assert.ok(r, `${state}: capture must be owned by det-classify`);
    assert.equal(r!.event.type, 'STAY');
  }
});

test('mined captures e2e: meta-clarify lands STAY — funnel re-asks, no strike, no offense reply', async () => {
  const { send, sessions } = await makeHandler();
  const chat = 'capture-meta-clarify';
  await send(chat, 'SAKAM DA ZEMAM STAN POD KIRIJA');
  const r = await send(chat, 'NE MISLEV NISTO VULGARNO');
  const s = sessions.get(chat)!;
  assert.equal(s.state, 'discovery', 'funnel stays live');
  assert.equal(s.strikes, 0, 'never an offense');
  assert.ok(!/професионалн/i.test(r), `no rebuff: ${r}`);
  // Wording-agnostic: seed AND learned location-ask variants share the pool.
  assert.ok(/дел|населб|локаци/i.test(r), `the next missing criterion is re-asked: ${r}`);
});
