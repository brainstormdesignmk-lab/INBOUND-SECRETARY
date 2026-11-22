// THE [04:41]–[05:35] CAPTURE — ten field defects from one operator session.
//
// 1/6. the chain silently moved the client's hour (17:30 → a 17:00 start, and
//      the second visit an hour later) and asked the owners about hours he had
//      never confirmed;
// 2/7. the route waited forty minutes for one silent owner while the other had
//      already answered — the client heard nothing at all;
// 3.   «KE MOZE LI POVEKJE INFORMACII ZA NEJZE?» about the гapсоњера on the
//      table was answered with every rental near Црногорска Амбасада;
// 4.   «DUNJAN» (a дуќан, typed with n) fell through to «кој тип недвижност…»;
// 5.   three flats asked for («42, 59 I 56») produced a visit for two;
// 8.   EB 85 printed «во Ново Лисиче … во близина на ТЦ Мавровка» — its own pin
//      stands next to the mall, 3,4 km from the naselba the row names;
// 9/10. a €/m² ask served ONE card, and the follow-up («DO 1600 DRUGI IMAS?»)
//      read the same figure as a whole price: «нема станови до 1.600 евра».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
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
import { LandmarkService, resolveSearchCenter, setOfflineMapRef } from '../src/geo/landmarks';
import { OfflineMapStore, writeMap } from '../src/geo/offlineMap';
import { OwnerStore } from '../src/store/owners';
import { EventStore } from '../src/store/events';
import { DeferredOwnerAgent } from '../src/backoffice/ownerAgent';
import { namedVisitEbs, detectDescribeAsk, extractSlots } from '../src/llm/deterministic';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

const ROWS: Property[] = [
  // The three business spaces of the [05:11] capture.
  { eb: 42, id: 42, location: 'Центар', address: 'Улица 42', price: 1000, sqm: 126, service: 'rent', business: true } as Property,
  { eb: 59, id: 59, location: 'Центар', address: 'Улица 59', price: 900, sqm: 80, service: 'rent', business: true } as Property,
  { eb: 56, id: 56, location: 'Центар', address: 'Улица 56', price: 1100, sqm: 95, service: 'rent', business: true } as Property,
  // Two flats for the route captures (74 and 84, the [04:41] pair).
  { eb: 74, id: 74, location: 'Центар', address: 'Улица 74', price: 190000, bedrooms: 3, sqm: 72, service: 'buy' } as Property,
  { eb: 84, id: 84, location: 'Центар', address: 'Улица 84', price: 137000, bedrooms: 2, sqm: 64, service: 'buy' } as Property,
  // Ново Лисиче stock for the €/m² list: 1.234 / 1.330 / 1.500 / 1.700 €/m².
  { eb: 87, id: 87, location: 'Ново Лисиче', address: 'Улица 87', price: 95000, bedrooms: 3, sqm: 77, service: 'buy' } as Property,
  // EB 85 as the live feed carried it for months: Ново Лисиче, a stale feed
  // roster pointing at a mall in another quarter, and no usable address.
  { eb: 85, id: 85, location: 'Ново Лисиче', address: 'Кај Бранка', price: 133000, bedrooms: 3, sqm: 100, service: 'buy', lat: 41.9840, lon: 21.4700, geo_source: 'osm_low_confidence', landmark: 'ТЦ Мавровка', landmarks: [{ landmark: 'ТЦ Мавровка', type: 'Shopping mall', distance_m: 54 }] } as unknown as Property,
  { eb: 93, id: 93, location: 'Ново Лисиче', address: 'Улица 93', price: 90000, bedrooms: 2, sqm: 60, service: 'buy' } as Property,
  { eb: 94, id: 94, location: 'Ново Лисиче', address: 'Улица 94', price: 119000, bedrooms: 2, sqm: 70, service: 'buy' } as Property,
  // The гapсоњера of the [04:52] capture (EB 76, Центар, 200 €).
  { eb: 76, id: 76, location: 'Центар', address: 'Улица 76', price: 200, sqm: 24, service: 'rent', bedrooms: 1, studio: true } as Property,
  { eb: 70, id: 70, location: 'Центар', address: 'Улица 70', price: 350, sqm: 39, service: 'rent', bedrooms: 1 } as Property,
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  async getById(id: number): Promise<Property | undefined> { return this.rows.find(r => r.id === id || r.eb === id); }
  get healthy(): boolean { return true; }
}

function makeMapPath(): string {
  return path.join(os.tmpdir(), `lina-0522-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

/** A map that holds the two quarters of the [05:32] capture and the mall. */
function buildMap(): OfflineMapStore {
  const dbPath = makeMapPath();
  writeMap(dbPath, [
    { name: 'Пајко Маало', type: 'suburb', lat: 41.9977663, lon: 21.4365615 },
    { name: 'Ново Лисиче', type: 'suburb', lat: 41.9840, lon: 21.4700 },
    { name: 'Центар', type: 'suburb', lat: 41.9955, lon: 21.4310 },
    { name: 'ТЦ Мавровка', type: 'mall', lat: 41.9996, lon: 21.4395 },
    { name: 'ТЦ Бисер', type: 'mall', lat: 41.9960, lon: 21.4325 },
  ], []);
  return new OfflineMapStore(dbPath);
}

function makeHandler() {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const sent: string[] = [];
  const asks: string[] = [];
  const channels = new ChannelRegistry();
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const props = new FakeProps(ROWS);
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, props),
    responder: new Responder(new FailingLlm(), cfg),
    properties: props,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: buildMap() }),
    ownerAgent: new DeferredOwnerAgent(new OwnerStore(db), new EventStore(db), 600_000, 60_000),
  });
  handler.onOwnerAsk = (_c: string, _eb: number, q: string) => { asks.push(q); };
  const chatId = 'capture-0522';
  const seed = (patch: (s: ReturnType<typeof freshSession>) => void) => {
    const s = freshSession('test', chatId);
    s.history = [];
    patch(s);
    sessions.set(s);
    return s;
  };
  const send = async (text: string) => {
    await handler.handle('test', chatId, text);
    return sessions.get(chatId)!;
  };
  return { handler, sessions, sent, asks, chatId, seed, send };
}

const tick = (ms = 120) => new Promise(r => setTimeout(r, ms));

// ── ITEM 1: the route's hours are SAID OUT LOUD ─────────────────────────────
// The field [04:41] capture: «NEKA BIDE 6» (18:00) for two flats, and Lina
// answered only «ќе Ве известам штом потврдам» while the owners were asked about
// 18:00 AND 19:00. Visits are 60-minute slots and one agent walks both doors,
// so the stagger is unavoidable — the client never being told about the second
// hour is the defect. The round still goes out in parallel (the owner's
// 2026-11-11 brief), and the ACK now names every hour it asks about.
test('[04:41] a two-flat route tells the client which hours it is asking the owners about', async () => {
  const h = makeHandler();
  h.seed((sess) => {
    sess.state = 'visit_scheduling';
    sess.slots.service = 'buy';
    sess.slots.visitWanted = true;
    sess.slots.visitEbs = [74, 84];
    sess.slots.presentedIds = [74, 84];
    sess.slots.currentBatch = [74, 84];
    sess.slots.clientName = 'Дафина';
    sess.slots.clientPhone = '076 723 456';
  });
  await h.send('VTORNIK NEKA BIDE 6');
  const line = h.sent.at(-1) ?? '';
  assert.equal(h.asks.length, 2, `both owners are asked: ${JSON.stringify(h.asks)}`);
  assert.match(h.asks[0]!, /18:00/u, h.asks[0]);
  assert.match(h.asks[1]!, /19:00/u, h.asks[1]);
  assert.match(line, /18:00/u, `the hour he named is stated: ${line}`);
  assert.match(line, /19:00/u, `and so is the second slot: ${line}`);
  assert.match(line, /24\.11\.2026/u, `on the day he named: ${line}`);
  assert.match(line, /\?$/u, `and it is his to refuse: ${line}`);

  // ONE HOUR, ONE FLAT: nothing to disclose — the plain ACK stays plain.
  const single = makeHandler();
  single.seed((sess) => {
    sess.state = 'visit_scheduling';
    sess.slots.service = 'buy';
    sess.slots.visitEbs = [74];
    sess.slots.presentedIds = [74];
    sess.slots.currentBatch = [74];
    sess.slots.clientName = 'Дафина';
    sess.slots.clientPhone = '076 723 456';
  });
  await single.send('VTORNIK NEKA BIDE 6');
  assert.doesNotMatch(single.sent.at(-1) ?? '', /последователни термини/u,
    `a single visit states no sequence: ${single.sent.at(-1)}`);
});

// ── ITEM 5: a LIST of flats is every number he typed ───────────────────────
test('[05:11] three named flats are three — a comma or a space is a list, not a fragment', () => {
  const text = 'SAKAM DA GI VIDAM 42 , 59 I 56 AKO SE SLOBODNI , PA KJE VIDIME';
  assert.deepEqual(namedVisitEbs(text, [42, 59, 56]), [42, 59, 56],
    'the third flat must survive the list separator');
  assert.deepEqual(namedVisitEbs('EB 42 i EB 59', [42, 59, 56]), [42, 59]);
  // …and the fragment guards still hold: a price, a date and a clock are not EBs.
  assert.deepEqual(namedVisitEbs('57 000 evra', [57, 59]), []);
  assert.deepEqual(namedVisitEbs('24.11.2026', [24, 11, 2026]), []);
  assert.deepEqual(namedVisitEbs('da mi kazes vo 19:30', [19, 30]), []);
});

test('[05:11] e2e: a visit for 42, 59 and 56 names all three and owes all three', async () => {
  const h = makeHandler();
  const s = h.seed((sess) => {
    sess.state = 'presentation';
    sess.slots.service = 'rent';
    sess.slots.business = true;
    sess.slots.presentedIds = [58, 42, 59, 57, 56];
    sess.slots.currentBatch = [56];
  });
  void s;
  await h.send('SAKAM DA GI VIDAM 42 , 59 I 56 AKO SE SLOBODNI , PA KJE VIDIME');
  const session = h.sessions.get(h.chatId)!;
  assert.deepEqual(session.slots.visitEbs, [42, 59, 56],
    `the visit set is the three he named: ${JSON.stringify(session.slots.visitEbs)}`);
  const line = h.sent.at(-1) ?? '';
  assert.match(line, /42/u, line);
  assert.match(line, /59/u, `the third flat is named to the client: ${line}`);
  assert.match(line, /56/u, line);
});

// ── ITEM 3: «more info about it» is about THE FLAT ─────────────────────────
test('[04:52] «POVEKJE INFORMACII ZA NEJZE» is a describe-ask', () => {
  assert.equal(detectDescribeAsk('KE MOZE LI POVEKJE INFORMACII ZA NEJZE ?'), true);
  assert.equal(detectDescribeAsk('DALI IMATE POVEKJE INFORMACII ZA STANOT'), true);
  // A stock question is not one: «повеќе станови имате?» names no referent.
  assert.equal(detectDescribeAsk('POVEKJE STANOVI IMATE ?'), false);
});

test('[04:52] e2e: more info about the гapсоњера describes THAT flat, not the neighbourhood', async () => {
  const h = makeHandler();
  // The field state: the гapсоњера was just served and the client answered with
  // the describe-ask (`— state: idle → closing —` on the transcript).
  h.seed((sess) => {
    sess.state = 'presentation';
    sess.slots.service = 'rent';
    sess.slots.propertyId = 76;
    sess.slots.interestedPropertyId = 76;
    sess.slots.presentedIds = [76];
    sess.slots.currentBatch = [76];
    sess.slots.location = 'Центар';
    sess.slots.poiAnchor = 'Црногорска Амбасада';
  });
  await h.send('KE MOZE LI POVEKJE INFORMACII ZA NEJZE ?');
  const line = h.sent.at(-1) ?? '';
  assert.match(line, /Евидентен број 76/u, `the flat on the table is the subject: ${line}`);
  assert.doesNotMatch(line, /најблиските опции/iu,
    `no neighbourhood batch for a question about one flat: ${line}`);
  assert.doesNotMatch(line, /Евидентен број 70/u,
    `the other rental is not the answer: ${line}`);
});

// ── ITEM 4: a дуќан typed «DUNJAN» is a commercial space ────────────────────
test('[05:04] «DUNJAN» is a business space, in every spelling people type', () => {
  for (const t of ['SAKAM DA IZNAJMAM DUNJAN VO CENTAR', 'DUNJAN', 'dukjan', 'дуњан', 'бутка', 'BUTKA', 'ducan']) {
    const slots = extractSlots(t);
    assert.equal(slots.business, true, `«${t}» must be commercial`);
  }
  // A residential word still wins: a стан beside a shop is a стан.
  assert.notEqual(extractSlots('SAKAM STAN DO DUNJAN').business, true);
});

test('[05:04] e2e: a дуќан starts the commercial funnel instead of the type question', async () => {
  const h = makeHandler();
  h.seed((sess) => { sess.state = 'idle'; });
  await h.send('SAKAM DA IZNAJMAM DUNJAN VO CENTAR');
  const line = h.sent.at(-1) ?? '';
  const s = h.sessions.get(h.chatId)!;
  assert.equal(s.slots.business, true, 'the type is on file as commercial');
  assert.equal(s.slots.service, 'rent', 'and the deal is a lease');
  assert.doesNotMatch(line, /кој тип недвижност/iu,
    `the client named the type: ${line}`);
  assert.match(line, /\?/u, `the funnel continues with its own question: ${line}`);
});

// ── ITEM 8: a landmark from another naselba is not evidence ────────────────
test('[05:32] a row whose pin contradicts its naselba never prints that naselba’s neighbour mall', async () => {
  const map = buildMap();
  const svc = new LandmarkService(new Db(':memory:'), { osm: false, offlineMap: map });
  const inconsistent: { eb: number; location: string; lat: number; lon: number; landmark?: string; landmarks?: unknown } = {
    eb: 85, location: 'Ново Лисиче', lat: 41.9993, lon: 21.44,
    landmarks: [{ landmark: 'ТЦ Мавровка', type: 'Shopping mall', distance_m: 54 }],
  };
  const healthy: { eb: number; location: string; lat: number; lon: number; landmark?: string; landmarks?: unknown } = {
    eb: 91, location: 'Центар', lat: 41.9960, lon: 21.4320,
    landmarks: [{ landmark: 'ТЦ Бисер', type: 'Shopping mall', distance_m: 40 }],
  };
  await svc.enrich([inconsistent as never, healthy as never]);
  assert.equal(inconsistent.landmarks, undefined,
    'the contradiction is dropped, not printed');
  assert.equal(inconsistent.landmark, undefined,
    'and the resolver does not re-mint it from the same pin');
  assert.ok(Array.isArray(healthy.landmarks) && healthy.landmarks.length === 1,
    'a row at home in its own naselba keeps its landmark');
});

// THE READ SIDE OF THE SAME WOUND (the EB 85 repair, ITEM 8). The row's address
// «КАЈ БРАНКА» is a local name, not a street: the map resolver fuzzy-matches it
// to a bank near the town centre, 3,5 km from the Ново Лисиче the row itself
// names. That candidate centre must not be used — before this the read side
// walked straight back into the contradiction the feed repair removed.
test('[05:32] a map resolution that lands in another quarter is refused, and a stale roster is withdrawn', async () => {
  const map = buildMap();
  setOfflineMapRef(map);
  const center = resolveSearchCenter({
    eb: 85, location: 'Ново Лисиче', address: 'Кај Бранка', lat: 41.9840, lon: 21.4700,
    geo_source: 'osm_low_confidence',
  } as never);
  assert.notEqual(center.source, 'map',
    `a town-centre point is not the answer for a Ново Лисиче row: ${JSON.stringify(center)}`);
  assert.notEqual(center.source, 'geocode', `nor is a geocode of the same unplaceable name: ${JSON.stringify(center)}`);

  // THE FEED ROSTER OUTLIVES ITS CENTRE. After the repair the row's centre is in
  // its own quarter, so the import-time roster (all 3,5 km away) no longer
  // measures: it is withdrawn instead of printed.
  const svc = new LandmarkService(new Db(':memory:'), { osm: false, offlineMap: map });
  const row: { eb: number; location: string; address: string; lat: number; lon: number; geo_source: string; landmark?: string; landmarks?: unknown } = {
    eb: 85, location: 'Ново Лисиче', address: 'Кај Бранка', lat: 41.9840, lon: 21.4700,
    geo_source: 'osm_low_confidence',
    landmark: 'ТЦ Мавровка',
    landmarks: [{ landmark: 'ТЦ Мавровка', type: 'Shopping mall', distance_m: 54 }],
  };
  await svc.enrich([row as never]);
  assert.equal(row.landmarks, undefined, 'the unmeasurable roster is withdrawn');
  assert.equal(row.landmark, undefined, 'and the single-landmark line with it');
  assert.deepEqual(svc.nearbyLandmarks(row as never), [], 'so the card names no foreign mall');
  setOfflineMapRef(undefined);
});

// ── ITEMS 1/6: the route never starts earlier than the hour he named ───────
test('[05:18] a half-hour term for several flats asks for the full hour instead of silently rounding down', async () => {
  const h = makeHandler();
  h.seed((sess) => {
    sess.state = 'visit_scheduling';
    sess.slots.service = 'buy';
    sess.slots.visitWanted = true;
    sess.slots.visitEbs = [74, 84];
    sess.slots.presentedIds = [74, 84];
    sess.slots.propertyId = 74;
    sess.slots.interestedPropertyId = 74;
    sess.slots.name = 'Test';
    sess.slots.phone = '070000000';
  });
  await h.send('VO VTORNIK VO 5 I POL NEKA BIDE');
  await tick();
  const line = h.sent.at(-1) ?? '';
  assert.match(line, /полн час/u, `the client is told about the full-hour rule: ${line}`);
  assert.match(line, /18:00/u, `…with the hour that keeps his wish: ${line}`);
  assert.equal(h.asks.length, 0, `no owner is asked an hour the client never saw: ${JSON.stringify(h.asks)}`);
  const s = h.sessions.get(h.chatId)!;
  assert.equal(s.slots.visitPlan, undefined, 'the route has not started');

  // THE RULE BELONGS TO THE ROUTE, NOT TO THE CLOCK — the sibling case that
  // stops the next reader from "fixing" this into a global rounding: a SINGLE
  // visit keeps the client's own 17:30 all the way to the owner, who is a human
  // with a diary ([22:50] «PA NEKA BIDE PET I POL» → «Вторник … во 17:30»,
  // [13:16] «VO PONEDELNIK NEKA BIDE 5 I 30»). Rounding that would rewrite a
  // term the owner may well accept.
  const one = makeHandler();
  one.seed((sess) => {
    sess.state = 'visit_scheduling';
    sess.slots.service = 'buy';
    sess.slots.visitEbs = [74];
    sess.slots.presentedIds = [74];
    sess.slots.propertyId = 74;
    sess.slots.interestedPropertyId = 74;
    sess.slots.name = 'Test';
    sess.slots.phone = '070000000';
  });
  await one.send('VO VTORNIK VO 5 I POL NEKA BIDE');
  await tick();
  assert.equal(one.asks.length, 1, `one visit still goes to its owner: ${JSON.stringify(one.asks)}`);
  assert.match(one.asks[0] ?? '', /17:30/u, `…with the client's own half-hour, never rounded: ${one.asks[0]}`);
});

// ── ITEMS 2/7: a silent owner must not freeze the route ────────────────────
test('[04:44] a stop whose owner never answers is dropped and the client hears the rest', async () => {
  const h = makeHandler();
  const dayMs = new Date(2026, 10, 24).getTime(); // Tuesday 24.11.2026
  h.seed((sess) => {
    sess.state = 'owner_checking';
    sess.slots.service = 'buy';
    sess.slots.visitTime = 'Вторник, 24.11.2026 во 18:00';
    sess.slots.visitPlan = {
      dayMs,
      targetHour: 18,
      term: 'Вторник, 24.11.2026 во 18:00',
      stops: [
        { eb: 74, status: 'asked', askedHour: 18, askedAt: Date.now() - 40 * 60_000 },
        { eb: 84, status: 'asked', askedHour: 19, askedAt: Date.now() - 40 * 60_000 },
      ],
    };
  });
  // Owner 74 answers the hour he was asked about (the route has no single
  // pending check — its verdicts come through the same applyOwnerVerdict).
  assert.equal(h.handler.ownerFollowup(h.chatId, 74, { status: 'ok', ownerTime: 'Вторник, 24.11.2026 во 18:00' }), true);
  await tick(200);
  const line = h.sent.at(-1) ?? '';
  assert.match(line, /Посета/u, `the answered stop is offered to the client: ${line}`);
  assert.match(line, /18:00/u, line);
  assert.match(line, /84/u, `the silent owner is named, not forgotten: ${line}`);
  assert.doesNotMatch(line, /не е слободен/iu,
    `a timeout is not a refusal: ${line}`);
  const s = h.sessions.get(h.chatId)!;
  assert.equal(s.state, 'time_confirm', `the client can now accept the plan: ${s.state}`);
});

// ── ITEMS 9/10: a €/m² ask is a LIST, and the axis survives the next figure ─
test('[05:32] a €/m² ask lists the flats under the rate, closest to it first, in pairs', async () => {
  const h = makeHandler();
  h.seed((sess) => {
    sess.state = 'presentation';
    sess.slots.service = 'buy';
    sess.slots.location = 'Ново Лисиче';
    sess.slots.presentedIds = [];
    sess.slots.currentBatch = [];
  });
  await h.send('KOJ STANOVI TI SE PO 1600 VO NOVO LISICE');
  const line = h.sent.at(-1) ?? '';
  assert.match(line, /за м²/u, `the rate is spoken as a rate: ${line}`);
  // 1.600 ЕВРА ЗА М² cap, rows at 1.500 (93), 1.330 (85), 1.234 (87), 1.700 (94):
  // the pair starts at the cap and goes DOWN, the rest queues.
  assert.match(line, /Евидентен број 93/u, `the 1.500 €/м² row is closest to the cap: ${line}`);
  assert.match(line, /Евидентен број 85/u, `and the next one follows (a pair): ${line}`);
  assert.doesNotMatch(line, /Евидентен број 87/u, `the third card is queued, not dumped: ${line}`);
  assert.doesNotMatch(line, /Евидентен број 94/u, 'a row over the cap is not served');
  assert.doesNotMatch(line, /1\.700 евра/u, 'nor named as the scope\u2019s ceiling');
  // THE STALE FEED ROSTER IS NOT PRINTED: this row's landmarks all sit in
  // another quarter, so no entry measures from its own centre.
  assert.doesNotMatch(line, /Мавровка/u, `the foreign mall is gone: ${line}`);
  const s = h.sessions.get(h.chatId)!;
  assert.equal(s.slots.sqmRate, 1600, 'the ceiling is a rate');
  assert.deepEqual(s.slots.extremeQueue, [87], 'the rest waits behind');
});

// THE LIST IS COMPLETE — say so (the [05:35] follow-up). With every row under
// the cap already shown, the queue is empty; the turn used to fall to a generic
// lane that offered a Центар гарсоњера for 36.000 — another quarter and another
// money frame entirely.
test('[05:35] «DRUGI?» with the rate list exhausted says so instead of pivoting to another quarter', async () => {
  const h = makeHandler();
  h.seed((sess) => {
    sess.state = 'presentation';
    sess.slots.service = 'buy';
    sess.slots.location = 'Ново Лисиче';
    sess.slots.sqmRate = 1600;
    sess.slots.extremeQueue = [];
    sess.slots.extremeWhere = ' во Ново Лисиче';
    sess.slots.extremePlural = 'станови';
    sess.slots.presentedIds = [93, 85];
    sess.slots.currentBatch = [93, 85];
  });
  await h.send('DO 1600 DRUGI IMAS?');
  const line = h.sent.at(-1) ?? '';
  assert.match(line, /сите станови/u, `the list is complete: ${line}`);
  assert.match(line, /1\.600 евра за м²/u, `and the frame is still the rate: ${line}`);
  assert.doesNotMatch(line, /Евидентен број (?:94|87|76|70)\b/u, `no unrelated row is served: ${line}`);
  assert.doesNotMatch(line, /Центар/u, `and no other quarter: ${line}`);
  assert.match(line, /\?$/u, `it ends with the offer to widen the ceiling: ${line}`);
});

test('[05:35] «DO 1600 DRUGI IMAS?» continues the €/m² axis instead of claiming no stock', async () => {
  const h = makeHandler();
  h.seed((sess) => {
    sess.state = 'presentation';
    sess.slots.service = 'buy';
    sess.slots.location = 'Ново Лисиче';
    sess.slots.presentedIds = [];
    sess.slots.currentBatch = [];
  });
  // The [05:32] turn sets the axis, the [05:35] follow-up must ride it.
  await h.send('KOJ STANOVI TI SE PO 1600 VO NOVO LISICE');
  h.sent.length = 0;
  await h.send('DO 1600 DRUGI IMAS?');
  const s = h.sessions.get(h.chatId)!;
  assert.equal(s.slots.sqmRate, 1600, 'the rate ceiling stays the money frame');
  assert.equal(s.slots.budget, undefined, 'and never becomes a whole-price cap');
  const line = h.sent.at(-1) ?? '';
  assert.match(line, /м²/u, `the answer stays on the rate axis: ${line}`);
  assert.match(line, /Евидентен број 87/u, `the queued 1.234 €/м² row is served: ${line}`);
  for (const l of h.sent) {
    assert.doesNotMatch(l, /нема станови до 1\.600 евра/iu,
      `the 1.234 €/м² row disproves that sentence: ${l}`);
  }
});
