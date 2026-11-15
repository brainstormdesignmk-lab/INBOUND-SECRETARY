/**
 * THE 2026-11-15 DAY REPLAY — every class the day's route-drift telemetry still
 * reported, pinned by a real turn through `InboundHandler`.
 *
 * The day file (`data/route-drift-2026-11-15.jsonl`, 1415 pairs / 135 unique
 * texts) is written by `routeLog` itself, so each class in it is a turn where
 * the MIRROR (ROUTING_ORDER, what the router predicts) and the SERVE (the lane
 * the handler logged) disagreed. The cold replay of those texts through a fresh
 * handler reported thirteen classes; this file is the custody record for the
 * ones that were product defects, plus the two that were registry noise.
 *
 * Both sides are asserted for every case:
 *   • the MIRROR  — `session.lastTurn.predicted` names the same lane;
 *   • the SERVE   — the lane the handler really logged;
 *   • and `readRouteDrift()` stays EMPTY, which is the operator-facing contract:
 *     a correct turn must not teach the audit that a lane is broken.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';
import { LlmClient } from '../src/llm/types';
import { setRouteDriftDir, flushRouteDrift, readRouteDrift } from '../src/store/routeDrift';
import { extractWhereLandmarkPlace, isWhereLandmarkQuestion } from '../src/llm/deterministic';
import { laneForTag } from '../src/handlers/router';

const cfg = loadConfig();

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}
class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

/** Coordinates are the SHIPPED map's own anchors (Аеродром / Центар), so the
 *  map and the feed agree about where a place is. */
const FEED: Property[] = [
  { eb: 59, id: 59, location: 'Аеродром', address: 'Ул. А 1', price: 950, sqm: 105, size: '105 м²', service: 'rent', business: true, lat: 41.9840, lon: 21.4650 },
  { eb: 42, id: 42, location: 'Центар', address: 'Ул. Б 2', price: 1000, sqm: 126, size: '126 м²', service: 'rent', business: true, lat: 41.9870, lon: 21.4370 },
  { eb: 78, id: 78, location: 'Центар', address: 'Ул. В 3', price: 800, bedrooms: 2, sqm: 60, size: '60 м²', service: 'rent', details: 'стан со двор', lat: 41.9880, lon: 21.4380 },
  { eb: 63, id: 63, location: 'Центар', address: 'Ул. Г 4', price: 400, bedrooms: 2, sqm: 40, size: '40 м²', service: 'rent', details: 'стан со тераса', lat: 41.9890, lon: 21.4390 },
  { eb: 37, id: 37, location: 'Кисела Вода', address: 'Ул. Ж 7', price: 117500, bedrooms: 4, sqm: 90, size: '90 м²', service: 'buy', lat: 41.9800, lon: 21.4500 },
  { eb: 41, id: 41, location: 'Кисела Вода', address: 'Ул. З 8', price: 70200, bedrooms: 3, sqm: 54, size: '54 м²', service: 'buy', lat: 41.9810, lon: 21.4510 },
] as unknown as Property[];

const driftDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-day-'));
setRouteDriftDir(driftDir);

/** The lane family of a tag (`X:fast` is the fast path of lane X). */
const family = (tag?: string): string | undefined => tag?.split(':')[0];

interface Turn {
  predicted?: string;
  served: string[];
  reply: string;
  state: string;
}

async function turn(text: string, chatId: string): Promise<Turn> {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, t: string) => { sent.push(t); } });
  const props = new FakeProps(FEED);
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, props),
    responder: new Responder(new FailingLlm(), cfg),
    properties: props,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
  });
  sessions.set(freshSession('test', chatId));
  await handler.handle('test', chatId, text);
  const after = sessions.get(chatId)!;
  return {
    predicted: after.lastTurn?.predicted,
    served: (after.lastTurn?.lanes ?? [])
      .filter(t => !t.startsWith('ROUTE_UNKNOWN') && !t.startsWith('LANE_COLLISION'))
      .map(t => family(t)!),
    reply: sent[sent.length - 1] ?? '',
    state: after.state,
  };
}

/** One row per class the day replay reported. `text` is the client's own words
 *  (the day file truncates them at 80 chars, the shape is the same). */
const CASES: Array<{ id: string; text: string; lane: string; why: string }> = [
  // ── the where-landmark extractor bound FILLERS as place names ──────────────
  {
    id: 'where-filler-adverb',
    text: 'kade tocno se naogja?',
    lane: 'WHERE_IS',
    why: '«точно» is an adverb modifying the question, not a place: the landmark lane missed the map and the where-is rotation answered instead of the mirror saying so',
  },
  {
    id: 'where-filler-verb',
    text: 'KAZI MI TOCNO KADE SE NAOGJA ?',
    lane: 'WHERE_IS',
    why: 'the extractor backtracked onto the VERB «NAOGJA» and called it a landmark',
  },
  {
    id: 'where-locative-phrase',
    text: 'ovoj 57 kade se naogja vo strog centar ?',
    lane: 'WHERE_IS',
    why: '«во струг центар» names where the FLAT is — the topic stays the flat, so the where-is lane owns it',
  },
  {
    id: 'where-real-landmark',
    text: 'kade ti e toa 26 juli tc ?',
    lane: 'WHERE_LANDMARK',
    why: 'the sibling case: a REAL place name still resolves and the landmark lane still owns it (the fix must not close the lane)',
  },
  // ── exact-address demands without a where-word ────────────────────────────
  {
    id: 'exact-address-plain',
    text: 'tocnata ulica i broj',
    lane: 'EXACT_ADDRESS',
    why: 'the where-is EXTENSION fires on the address family without каде; the executor defers only to a REAL where-word, and the mirror had to read the same guard',
  },
  {
    id: 'exact-address-eb',
    text: 'koja mu e lokacijata na 89?',
    lane: 'EXACT_ADDRESS',
    why: 'the same family with an Евидентен број — privacy ladder, never a landmark rotation',
  },
  // ── nearby asks are not where-is / distance asks ──────────────────────────
  {
    id: 'nearby-not-where-is',
    text: 'dobro togas kazi mi sto ima vo blizina poznato ?',
    lane: 'NEARBY_ASK',
    why: 'the executor intercepts the near-by read BEFORE the where-is lane; a где-word inside it does not make it a where-is question',
  },
  {
    id: 'nearby-question-gate',
    text: 'a sto drugo ima vo blizina',
    lane: 'WHERE_IS',
    why: 'the near-by interceptor sits BEHIND the question gate: a genuine question skips it, so the where-is lane keeps the turn and the mirror must not veto it',
  },
  {
    id: 'distance-needs-a-place',
    text: 'kolku e daleku od stanot?',
    lane: 'NEARBY_ASK',
    why: '«од станот» names the FLAT, not a destination — no place, no map hit, so the distance lane stands down',
  },
  // ── the price-extreme serve outruns the fast investment leg ───────────────
  {
    id: 'price-extreme-not-investment',
    text: 'koja e najvisokata cena vo aerodrom?',
    lane: 'PRICE_EXTREME',
    why: 'the price-extreme block (inbound.ts 6455) runs long before the fast investment leg, so the mirror must refuse the investment row',
  },
  // ── the area ask needs criteria to search with ────────────────────────────
  {
    id: 'area-have-cold',
    text: 'а во која населба има?',
    lane: 'NEIGHBORHOOD_ASK',
    why: 'the area-have block needs a criterion in the notebook; a cold ask is the neighbourhood-advice lane',
  },
  // ── the business pair vs a recalled listing ───────────────────────────────
  {
    id: 'business-recall',
    text: 'imavte eden lokal kaj aerodrom . okolu 130 000 bese dali uste se prodava ?',
    lane: 'SEEN_LISTING_RECALL',
    why: 'a RECALL is not a pair search: the business serve stood down for the past-tense shape the recall lane owns',
  },
  // ── a landmark-anchored, figure-less recall is the description lane ───────
  {
    id: 'recall-anchored-description',
    text: 'imavte edna garsonjera kaj crnogorska ambasada',
    lane: 'PROPERTY_DESCRIPTION',
    why: 'the remembered-property block runs first and keeps the anchored, figure-less recall (the [11:29] cold pin)',
  },
  {
    id: 'recall-priced-sized-funnel',
    text: 'imavte eden stan vo madjar maalo so dve spalni cena okolu 180 000 dali uste se prodava ?',
    lane: 'PROPERTY_DESCRIPTION',
    why: 'a recall carrying BOTH a price and a size is the locate funnel\'s (the [madjari] money-anchor gate), so the recall row stands down',
  },
  // ── the persona lane ──────────────────────────────────────────────────────
  {
    id: 'personal-name',
    text: 'kako ti e imeto?',
    lane: 'PERSONAL',
    why: 'the closed-class persona lane had no mirror row at all — four gaps a day on correct turns',
  },
  {
    id: 'personal-origin',
    text: 'od koe selo si?',
    lane: 'PERSONAL',
    why: 'the origin kind rides the same lane (the tag carries the KIND)',
  },
];

test('the 2026-11-15 replay: the mirror and the serve agree, and nothing drifts', async () => {
  const wrong: string[] = [];
  const before = (await readRouteDrift()).length;
  for (const c of CASES) {
    const out = await turn(c.text, `day-${c.id}`);
    if (family(out.predicted) !== c.lane) {
      wrong.push(`${c.id}: the MIRROR predicted ${out.predicted ?? '(none)'}, expected ${c.lane} (\"${c.text}\")`);
    }
    if (!out.served.includes(c.lane)) {
      wrong.push(`${c.id}: the SERVE was ${out.served.join(',') || '(none)'}, expected ${c.lane} (\"${c.text}\")`);
    }
  }
  await flushRouteDrift();
  const drift = (await readRouteDrift()).slice(before);
  assert.deepEqual(wrong, [], `a lane disagrees on the day's own telemetry:\n${wrong.join('\n')}`);
  assert.deepEqual(drift.map(d => `${d.kind} ${d.predicted} -> ${d.actual} :: ${d.text}`), [],
    'a correct turn must not log a route gap/drift — the audit would train the operator to ignore it');
});

/** AN EITHER-OR BUDGET KEEPS ITS OWN DRAIN. «еден до 80.000 или два до 140.000»
 *  leaves `countBudget` in the notebook, and «DRUGO NESTO IMA , OSVEN OVIE DVA ?»
 *  must hear the two caps and the pricier pair — the plan's own lane — never the
 *  next-pair serve, which knows nothing about the two counts and re-served pairs
 *  until the pool ran out. The mirror has to stand down for the same reason, or
 *  the router-driven branch answers the turn (inbound.ts 10380). */
test('an either-or budget drain belongs to the plan lane, not the next-pair serve', async () => {
  const rows: Property[] = [
    { eb: 53, id: 53, location: 'Аеродром', price: 55000, bedrooms: 2, sqm: 44, size: '44 м²', service: 'buy' },
    { eb: 33, id: 33, location: 'Аеродром', price: 70000, bedrooms: 2, sqm: 50, size: '50 м²', service: 'buy' },
    { eb: 34, id: 34, location: 'Аеродром', price: 62000, bedrooms: 2, sqm: 45, size: '45 м²', service: 'buy' },
    { eb: 35, id: 35, location: 'Аеродром', price: 58000, bedrooms: 2, sqm: 40, size: '40 м²', service: 'buy' },
    { eb: 88, id: 88, location: 'Аеродром', price: 133000, bedrooms: 3, sqm: 68, size: '68 м²', service: 'buy' },
  ] as unknown as Property[];
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, t: string) => { sent.push(t); } });
  const props = new FakeProps(rows);
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, props),
    responder: new Responder(new FailingLlm(), cfg),
    properties: props,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
  });
  const chatId = 'day-count-budget';
  sessions.set(freshSession('test', chatId));
  await handler.handle('test', chatId, 'ZDRAVO SAKAM DA KUPAM STAN VO AERODROM');
  await handler.handle('test', chatId, 'SPALNI BILO KOLKU . MOZE SO EDNA DO 80000 ILI DVE DO 140000');
  await handler.handle('test', chatId, 'DRUGO NESTO IMA , OSVEN OVIE DVA ?');
  const reply = await handler.handle('test', chatId, 'DRUGO NESTO IMA , OSVEN OVIE DVA ?')
    .then(() => sent[sent.length - 1] ?? '');
  const s = sessions.get(chatId)!;
  assert.notEqual(family(s.lastTurn?.predicted), 'MORE_STOCK',
    `the mirror sent a two-cap drain to the next-pair serve ("${reply.slice(0, 160)}")`);
  assert.match(reply, /80\.000/u, `the single cap must be stated: ${reply.slice(0, 200)}`);
  assert.match(reply, /140\.000/u, `the "two" figure must be stated: ${reply.slice(0, 200)}`);
  assert.equal(s.slots.moreChoicePending, true, 'the pricier-pair offer must be answerable');
});

/** THE SUFFIXED TAG IS THE LANE IT NAMES. The executor logs the WORDING SOURCE
 *  (`OWNER_HOLD:fast`, `FEE_SURPRISE:fast`) and even the state
 *  (`VISIT_CANCEL:visit_scheduling`) after a colon on the same lane. The day
 *  file carried 191 such rows (VISIT_CANCEL ×181, PROPERTY_CHOICE ×10), every
 *  one of them a GAP on a turn that was served exactly right, because the
 *  comparison looked the raw tag up in ROUTE_LANES. `laneForTag` resolves the
 *  base lane, and both readers (routeLog + scripts/route-gap-audit.ts) use it. */
test('a suffixed tag resolves to its base lane — no gap on a correct turn', async () => {
  // THE TAGS THE REGISTRY DOES NOT KEY DIRECTLY: a state/kind suffix is what
  // the executor appends (`VISIT_CANCEL:visit_scheduling`, `PERSONAL:age`), and
  // the registry keys only the BASE lane — so these resolved to undefined and
  // every such turn was logged as an UNREGISTERED lane (191 rows in the day
  // file: VISIT_CANCEL ×181, PROPERTY_CHOICE ×10).
  assert.equal(laneForTag('VISIT_CANCEL:visit_scheduling')?.intent, 'VISIT_CANCEL');
  assert.equal(laneForTag('VISIT_CANCEL:owner_checking')?.intent, 'VISIT_CANCEL');
  assert.equal(laneForTag('PROPERTY_CHOICE:fast')?.intent, 'PROPERTY_CHOICE');
  assert.equal(laneForTag('PERSONAL:age')?.intent, 'PERSONAL');
  // …and a lane registered only under its `:fast` spelling still resolves from
  // the bare base name (the audit's own day-file tags: FEE_PUSH, OWNER_HOLD).
  assert.equal(laneForTag('OWNER_HOLD')?.intent, 'OWNER_HOLD');
  assert.equal(laneForTag('FEE_PUSH')?.intent, 'FEE_PUSH');
  const before = (await readRouteDrift()).length;
  const hold = await turn('ne go kontaktiraj uste', 'day-owner-hold');
  assert.deepEqual(hold.served, ['OWNER_HOLD'], `the serve was ${hold.served.join(',')}`);
  assert.equal(family(hold.predicted), 'OWNER_HOLD');
  await flushRouteDrift();
  const drift = (await readRouteDrift()).slice(before).filter(d => d.text.includes('kontaktiraj'));
  assert.deepEqual(drift, [], 'a :fast tag must not be reported as an unregistered lane');
});

/** THE EXTRACTOR IS THE LANE'S TEXT GATE. The mirror and the executor both call
 *  `extractWhereLandmarkPlace`, so the fillers had to be refused THERE — a row
 *  guard would have left the executor searching the map for «tocno». */
test('where-landmark extraction refuses fillers, verbs and locative phrases', () => {
  assert.equal(extractWhereLandmarkPlace('kade tocno se naogja?'), undefined);
  assert.equal(extractWhereLandmarkPlace('KAZI MI TOCNO KADE SE NAOGJA ?'), undefined);
  assert.equal(extractWhereLandmarkPlace('ovoj 57 kade se naogja vo strog centar ?'), undefined);
  // The real landmark asks are untouched (the lane must stay open). The
  // comparison is case-insensitive: the extractor normalises the capture
  // (`matchesBothCapture` lowercases), which is the map's own key shape.
  assert.equal(extractWhereLandmarkPlace('kade ti e toa 26 juli tc ?')?.toLowerCase(), '26 juli tc');
  assert.equal(extractWhereLandmarkPlace('kade e skopjanka?')?.toLowerCase(), 'skopjanka');
  assert.equal(isWhereLandmarkQuestion('kade e tc leptokarija'), true);
});
