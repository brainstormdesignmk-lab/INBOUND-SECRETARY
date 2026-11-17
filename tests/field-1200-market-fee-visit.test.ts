// THE [11:47]–[12:00] CLIENT BATCH — the operator's five numbered defects from
// the field transcript, each one a family, not a spelling:
//
//   1. [09:56] «KOGA BI MOZELO ?» — a bare when-question (the visit IS the
//      subject; no visit noun, no viewing verb) fell past the timing lane to
//      the model. A stored protocol answer is required, not a generated one.
//   2. [11:47]–[11:48] «САКАМ ДА КУПАМ СТАНЧЕ …» then «ТРОСОБЕН МИ ТРЕБА ДО
//      160 000» — the market had to be remembered, and 160.000 is a PURCHASE
//      figure (no rent on this market is that high).
//   3. [11:52] «КУПУВАЊЕ ТИ КАЖАВ ПРЕЕСКА» — the told-you recall apologised,
//      then asked «купи или изнајми?» again: the nag's own words are the answer.
//   4. [11:54] «НА КОЕ РАСТОЈАНИЕ СЕ ОД КАПИТОЛ ?» answered «Растојанието до
//      Ramstore - Kapitol» — the supermarket INSIDE the mall beat the mall in
//      the landmark lookup (the shortest-name tie-break).
//   5. [12:00] «АКО ПОСЕТАМ 3 ?» after the two-flat fee (1.000) was answered
//      with the contact ask — a visit count is arithmetic: 3 × 500 = 1.500.
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
import { detectVisitTimingQuestion, feeArithmeticCount } from '../src/llm/deterministic';
import { discoveryAskCriteria, serviceCriterionKnown } from '../src/llm/prompts';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';
import { RESPONSE_BANK } from '../src/data/responses';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}
class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

// The Аеродром block the client named, three-bed, under his 160.000 cap — the
// same shape the probe used against the shipped map.
const ROWS: Property[] = [
  { eb: 82, id: 82, location: 'Аеродром', price: 158000, service: 'buy', bedrooms: 3, sqm: 78,
    size: '78 м²', address: 'Христо Узунов', lat: 41.9859, lon: 21.4666, geo_source: 'stored' } as Property,
  { eb: 88, id: 88, location: 'Аеродром', price: 152000, service: 'buy', bedrooms: 3, sqm: 74,
    size: '74 м²', address: 'Јане Сандански', lat: 41.9862, lon: 21.4670, geo_source: 'stored' } as Property,
  { eb: 90, id: 90, location: 'Аеродром', price: 165000, service: 'buy', bedrooms: 3, sqm: 80,
    size: '80 м²', address: 'Реонски', lat: 41.9865, lon: 21.4680, geo_source: 'stored' } as Property,
];

// The SAME criteria on flats OUTSIDE the 1 km ring around the mall — the field
// state behind the [11:55] ring answer (the cards existed, the pool was far).
const FAR_ROWS: Property[] = [
  { eb: 82, id: 82, location: 'Аеродром', price: 158000, service: 'buy', bedrooms: 3, sqm: 78,
    size: '78 м²', address: 'Христо Узунов', lat: 41.9990, lon: 21.4900, geo_source: 'stored' } as Property,
  { eb: 88, id: 88, location: 'Аеродром', price: 152000, service: 'buy', bedrooms: 3, sqm: 74,
    size: '74 м²', address: 'Јане Сандански', lat: 41.9995, lon: 21.4905, geo_source: 'stored' } as Property,
];

function makeHandler(chat: string, rows: Property[] = ROWS) {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(rows);
  const llm = new FailingLlm();
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  const heavy: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, t: string) => { sent.push(t); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(llm, cfg, properties),
    responder: new Responder(llm, cfg),
    properties,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    // The SHIPPED map: this batch is about what the appliance actually says.
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
  } as never);
  handler.onOwnerAsk = () => { /* owner round-trip is asserted elsewhere */ };
  const send = async (m: string) => {
    await handler.handle('test', chat, m);
    const s = sessions.get(chat)!;
    const last = sent[sent.length - 1] ?? '';
    heavy.push(last);
    return { session: s, reply: last };
  };
  return { handler, sessions, sent, send };
}

const isBankVariant = (key: string, reply: string): boolean =>
  (RESPONSE_BANK[key] ?? []).some(v => v.trim() === reply.trim());

// ── 1. THE BARE WHEN-QUESTION IS THE PROTOCOL'S ────────────────────────────

test('[09:56] «KOGA BI MOZELO ?» is a visit-timing question in every spelling', () => {
  for (const t of ['KOGA BI MOZELO ?', 'КОГА БИ МОЖЕЛО ?', 'koga bi mozelo', 'КОГА ?', 'ПА КОГА ?']) {
    assert.equal(detectVisitTimingQuestion(t), true, `the bare when-question must claim ${t}`);
  }
  // …and the lanes it must NOT steal: a concrete term is scheduling, fee
  // traffic is the money lane.
  assert.equal(detectVisitTimingQuestion('УТРЕ ВО 12'), false);
  assert.equal(detectVisitTimingQuestion('КОГА СЕ ПЛАЌА НАДОМЕСТОТ ?'), false);
});

test('[09:56] a served card + «KOGA BI MOZELO ?» answers the stored confirm ask', async () => {
  const { send } = makeHandler('barewhen');
  await send('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 82');
  const { session, reply } = await send('KOGA BI MOZELO ?');
  assert.equal(session.state, 'closing');
  assert.ok(isBankVariant('visit.confirm.ask', reply),
    `the stored visit.confirm.ask must answer, got: ${reply}`);
  // The fee is disclosed only AFTER the consent — the protocol's order.
  assert.ok(!/денар|500|300/u.test(reply), 'no money in the confirm ask');
});

// ── 2. THE DECLARED MARKET IS REMEMBERED, AND THE MONEY IMPLIES IT ─────────

test('[11:47] a declared BUY survives the funnel and a 160.000 budget is a purchase', async () => {
  const { send } = makeHandler('declaredbuy');
  await send('ЗДРАВО');
  const a = await send('САКАМ ДА КУПАМ СТАНЧЕ ВО АЕРОДРОМ КАЈ КАПИТОЛ');
  assert.equal(a.session.slots.service, 'buy', 'the client declared buy');
  assert.equal(a.session.slots.serviceInferred, undefined, 'a declaration clears the inferred flag');
  const b = await send('ТРОСОБЕН МИ ТРЕБА ДО 160 000 ВО ТОЈ РЕОН');
  assert.equal(b.session.slots.service, 'buy');
  assert.equal(b.session.slots.budget, '160000');
  // The market question must never be asked again: the funnel moves on.
  assert.ok(!/купите стан или|купување или изнајмување|за купување или/u.test(b.reply),
    `the market was already answered, got: ${b.reply}`);
});

test('[11:48] a purchase-magnitude budget answers the market even when pinned from a row', () => {
  // The [10:16] pin (`serviceInferred`) is not a declaration — but the figure
  // IS: nothing is rented at 160.000 on this market.
  const slots = { service: 'buy', serviceInferred: true, budget: '160000' } as never;
  assert.equal(serviceCriterionKnown(slots), true);
  const criteria = discoveryAskCriteria(slots);
  assert.ok(!criteria.includes('service'), `no market re-ask, got ${JSON.stringify(criteria)}`);
  // A rent-sized figure keeps the question: a pin plus 300 € is not evidence.
  const rentish = { service: 'buy', serviceInferred: true, budget: '300' } as never;
  assert.equal(serviceCriterionKnown(rentish), false);
  // …and no pinned market at all is still an open question, budget or not.
  assert.equal(serviceCriterionKnown({ budget: '160000' } as never), false);
});

test('[11:52] «КУПУВАЊЕ ТИ КАЖАВ ПРЕЕСКА» applies the market it names', async () => {
  const { sessions, send } = makeHandler('toldyou');
  await send('ЗДРАВО');
  const opened = await send('САКАМ СТАНЧЕ ВО АЕРОДРОМ КАЈ КАПИТОЛ');
  assert.equal(opened.session.state, 'discovery');
  // The [10:16] state the capture was in: a market PINNED from a browsed row,
  // never declared by the client, and an empty notebook of criteria besides it.
  const pinned = sessions.get('toldyou')!;
  pinned.slots.service = 'buy';
  pinned.slots.serviceInferred = true;
  pinned.slots.budget = undefined;
  pinned.slots.bedrooms = undefined;
  sessions.set(pinned);
  const nag = await send('КУПУВАЊЕ ТИ КАЖАВ ПРЕЕСКА');
  assert.equal(nag.session.slots.service, 'buy');
  assert.equal(nag.session.slots.serviceInferred, undefined,
    'the nag named the market, so it is a declaration');
  assert.ok(!/купите стан или|купување или изнајмување|за купување или/u.test(nag.reply),
    `the told-you lane must not re-ask the market, got: ${nag.reply}`);
});

// ── 3. THE MALL IS THE LANDMARK, NOT THE SHOP INSIDE IT ────────────────────

test('[11:54] «Капитол» resolves to the mall, never the supermarket beside it', () => {
  const cfg = loadConfig();
  const map = new OfflineMapStore(cfg.skopjePoisDb);
  for (const q of ['Капитол', 'КАПИТОЛ', 'KAPITOL', 'кај Капитол']) {
    const hit = map.findPoiByName(q);
    assert.ok(hit, `${q} must resolve`);
    assert.equal(hit!.type, 'mall', `${q} must name the mall, got ${hit!.name} [${hit!.type}]`);
  }
  // The ACKNOWLEDGED abbreviation is the same place (the map files the bus stop
  // that serves it as «ТЦ Капитол») — and a real place beats a stop.
  const tc = map.findPoiByName('ТЦ Капитол');
  assert.equal(tc?.type, 'mall', `«ТЦ Капитол» is the centre, got ${tc?.name} [${tc?.type}]`);
  // A genuine tenant ask keeps its own answer: the shop fallback still serves.
  // THE CONTRACT IS THE SHOP, NOT ONE SPELLING: the chain is filed on the map as
  // «Рамстор», «Ramstore», «Ramstor» and «Рамстор Express» in different rows, and
  // which one a query lands on is a lookup detail. What must never happen is the
  // mall for a tenant ask, so the assertion pins the TYPE and the brand in either
  // script (dropping duplicates from the map re-armed this tie-break: the exact
  // «Рамстор» → «Ramstor» match now wins over «Ramstore»).
  const shop = map.findPoiByName('Рамстор');
  assert.ok(shop && /amstor|амстор/iu.test(shop.name), `a shop query keeps its shop, got ${shop?.name}`);
  assert.match(shop!.type, /supermarket|market|grocery/iu,
    `a tenant ask is served by a shop, never the mall: ${shop?.name} [${shop?.type}]`);
});

test('[11:54] the distance line names the mall for the Аеродром pair', async () => {
  const { send } = makeHandler('distance');
  await send('САКАМ ДА КУПАМ СТАНЧЕ ВО АЕРОДРОМ КАЈ КАПИТОЛ');
  await send('ТРОСОБЕН МИ ТРЕБА ДО 160 000 ВО ТОЈ РЕОН');
  const { reply } = await send('НА КОЕ РАСТОЈАНИЕ СЕ ОД КАПИТОЛ ?');
  assert.ok(/Капитол/iu.test(reply), `the landmark is named: ${reply}`);
  assert.ok(!/Ramstore/iu.test(reply), `never the supermarket tenant: ${reply}`);
});

// ── 4/5. THE COUNT QUESTION IS ARITHMETIC, NOT CONSENT ─────────────────────

test('[12:00] a visit count is read in digits and in words', () => {
  assert.equal(feeArithmeticCount('АКО ПОСЕТАМ 3 ?'), 3);
  assert.equal(feeArithmeticCount('AKO POSETAM 3 ?'), 3);
  assert.equal(feeArithmeticCount('АКО ПОСЕТАМ ТРИ ?'), 3);
  assert.equal(feeArithmeticCount('ЗА ТРИ ПОСЕТИ'), 3);
  assert.equal(feeArithmeticCount('KOLKU BI PLATIL ZA TRI POSETI ?'), 3);
  // An Евидентен број is not a count, and a money word keeps the amount lane.
  assert.equal(feeArithmeticCount('АКО ПОСЕТАМ 82 ?'), undefined);
  assert.equal(feeArithmeticCount('SAKAM DA GI POSETAM 82 I 88'), undefined);
  // A bare figure with no visit verb and no visit noun is never a count.
  assert.equal(feeArithmeticCount('ДО 160 000'), undefined);
});

test('[12:00] «АКО ПОСЕТАМ 3 ?» after the pair serves the 1.500 total', async () => {
  const { send } = makeHandler('countfee');
  await send('САКАМ ДА КУПАМ СТАНЧЕ ВО АЕРОДРОМ КАЈ КАПИТОЛ');
  await send('ТРОСОБЕН МИ ТРЕБА ДО 160 000 ВО ТОЈ РЕОН');
  const dual = await send('ДВАТА БИ ГИ ПОСЕТИЛ АКО СЕ ДОСТАПНИ НОРМАЛНО ?');
  assert.ok(/1\.000/u.test(dual.reply), `the pair total is disclosed: ${dual.reply}`);
  const { session, reply } = await send('АКО ПОСЕТАМ 3 ?');
  assert.ok(/1\.500/u.test(reply), `three visits cost 1.500, got: ${reply}`);
  assert.ok(!/име и презиме/iu.test(reply), `never the contact ask: ${reply}`);
  // The count is visits, not bedrooms — the session's size criterion is intact.
  assert.equal(session.slots.bedrooms, 3, 'the 3 is a VISIT count, not 3 спални→4');
  // A rung is never burned by arithmetic.
  assert.equal(session.slots.feeRejections ?? 0, 0);
});

// ── 6. THE ONE-KILOMETRE RING IS A SEARCH OFFER, NOT AN ANSWER ─────────────

test('[11:54]/[11:55] the ring ask never answers a distance question or a visit decision', async () => {
  const { send } = makeHandler('ring', FAR_ROWS);
  await send('САКАМ ДА КУПАМ СТАНЧЕ ВО АЕРОДРОМ КАЈ КАПИТОЛ');
  const ring = await send('ТРОСОБЕН МИ ТРЕБА ДО 160 000 ВО ТОЈ РЕОН');
  // The ring IS the answer to an empty search — that part must keep working.
  assert.ok(/непосредна близина|подалеку/iu.test(ring.reply), `the ring ask still fires: ${ring.reply}`);
  assert.equal(ring.session.slots.poiTooFarAsk, true);

  const dist = await send('НА КОЕ РАСТОЈАНИЕ СЕ ОД КАПИТОЛ ?');
  assert.ok(!/непосредна близина/iu.test(dist.reply),
    `a distance question is not a widen offer: ${dist.reply}`);

  const visit = await send('ДВАТА БИ ГИ ПОСЕТИЛ АКО СЕ ДОСТАПНИ НОРМАЛНО ?');
  assert.ok(!/непосредна близина|да Ви покажам нешто подалеку/iu.test(visit.reply),
    `a visit decision is not a widen offer: ${visit.reply}`);
});
