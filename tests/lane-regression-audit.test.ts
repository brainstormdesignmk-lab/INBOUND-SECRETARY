/**
 * THE LANE-REGRESSION AUDIT — a new lane can never silently change an OLDER
 * lane's answer.
 *
 * The failure class this exists for: a lane is added (or promoted, or its gate
 * widened), it happens to claim a turn an older lane used to own, and nothing
 * fails — the served copy looks plausible, so the regression is found weeks
 * later in a field capture (the terms regression, the [05:20] pair family).
 *
 * A row here is a DECISIVE field turn: a scripted session, the client's exact
 * sentence, and the ONE lane that must answer it. Two sides are asserted:
 *
 *   • the MIRROR (ROUTING_ORDER, what the router predicts) — so a new row that
 *     steals the turn in `resolveIntent` fails here, not in production;
 *   • the EXECUTOR (the lane the handler actually served) — so a new branch
 *     that intercepts the turn before the owner fails here too.
 *
 * THE EXPECTATIONS ARE A CUSTODY RECORD, NOT A STYLE GUIDE. Changing one is
 * allowed and sometimes right — but it must be a deliberate edit with the reason
 * in the commit, never a silent flip: that is the whole point of the table.
 *
 * Only lanes are compared. `ROUTE_UNKNOWN:…` tags are the classifier's
 * pre-serve guess and `LANE_COLLISION:…` is a diagnostic, so both are filtered
 * (the same taxonomy `routeLog` uses — neither is a serve).
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
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';
import { LlmClient } from '../src/llm/types';
import type { ChatSession } from '../src/fsm/session';

const cfg = loadConfig();

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}
class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

/** Coordinates are the SHIPPED map's own anchors (Рампа, Центар), so the map
 *  lanes answer from the same geography an operator's chat does. */
const FEED: Property[] = [
  { eb: 59, id: 59, location: 'Аеродром', address: 'Ул. А 1', price: 950, sqm: 105, size: '105 м²', service: 'rent', business: true, lat: 41.9840, lon: 21.4650 },
  { eb: 42, id: 42, location: 'Центар', address: 'Ул. Б 2', price: 1000, sqm: 126, size: '126 м²', service: 'rent', business: true, lat: 41.9870, lon: 21.4370 },
  { eb: 78, id: 78, location: 'Центар', address: 'Ул. В 3', price: 800, bedrooms: 2, sqm: 60, size: '60 м²', service: 'rent', lat: 41.9880, lon: 21.4380 },
  { eb: 63, id: 63, location: 'Центар', address: 'Ул. Г 4', price: 400, bedrooms: 2, sqm: 40, size: '40 м²', service: 'rent', lat: 41.9890, lon: 21.4390 },
  { eb: 37, id: 37, location: 'Кисела Вода', price: 117500, bedrooms: 4, sqm: 90, size: '90 м²', service: 'buy', lat: 41.9800, lon: 21.4500 },
  { eb: 41, id: 41, location: 'Кисела Вода', price: 70200, bedrooms: 3, sqm: 54, size: '54 м²', service: 'buy', lat: 41.9810, lon: 21.4510 },
] as unknown as Property[];

interface CustodyRow {
  /** What the turn is, in one line — the operator-facing name of the custody. */
  id: string;
  /** The session the client is in when he types it. */
  setup: (s: ChatSession) => void;
  /** Earlier turns, oldest first (the funnel setup the capture had). */
  turns?: string[];
  /** The message under audit. */
  text: string;
  /** THE LANE THAT MUST OWN IT — both at the mirror and at the serve. */
  lane: string;
  /** The state the turn must leave behind, when it matters. */
  state?: string;
}

const rows: CustodyRow[] = [
  {
    id: 'fee-amount',
    setup: s => { s.state = 'closing'; s.slots.service = 'rent'; s.slots.propertyId = 78; s.slots.interestedPropertyId = 78; s.slots.presentedIds = [78]; },
    text: 'KOLKU E ZA POSETA ?',
    lane: 'FEE_AMOUNT_ASK',
  },
  {
    id: 'fee-nag',
    // §2: a trailing why-word on an accusation is the accusation — it burns a
    // rung, it never becomes the fee.why explanation.
    setup: s => { s.state = 'closing'; s.slots.service = 'rent'; s.slots.propertyId = 78; s.slots.presentedIds = [78]; },
    text: 'PARI ZA POSETA ZEMATE ? ZOSTO ?',
    lane: 'FEE_PUSH',
  },
  {
    id: 'availability-plural',
    setup: s => { s.state = 'presentation'; s.slots.service = 'rent'; s.slots.currentBatch = [78, 63]; s.slots.presentedIds = [78, 63]; },
    text: 'DALI SE SLOBODNI DVA ?',
    lane: 'AVAILABILITY_PLURAL',
    state: 'closing',
  },
  {
    id: 'more-stock',
    // Defect #3 of the [05:20] family: an ask for OTHER stock, never the
    // availability table and never the fee.
    setup: s => { s.state = 'presentation'; s.slots.service = 'rent'; s.slots.currentBatch = [78, 63]; s.slots.presentedIds = [78, 63]; },
    text: 'OSVEN OVIE STO MI GI POKAZA DALI IMATE DRUGI ?',
    lane: 'MORE_STOCK',
    state: 'presentation',
  },
  {
    id: 'info-pair',
    // Defect #4: the pair on the table answers both rows.
    setup: s => { s.state = 'presentation'; s.slots.service = 'rent'; s.slots.currentBatch = [59, 42]; s.slots.presentedIds = [59, 42]; },
    text: 'KOLKU M2 IMAAT DVATA DUKJANI ?',
    lane: 'INFO_ASK_PAIR',
  },
  {
    id: 'identify-figure',
    // Defect #5: a figure a served row carries is an IDENTIFIER.
    setup: s => { s.state = 'presentation'; s.slots.service = 'rent'; s.slots.currentBatch = [59, 42]; s.slots.presentedIds = [59, 42]; },
    text: 'KOJ IMA 126 M2 ?',
    lane: 'IDENTIFY_BY_FIGURE',
  },
  {
    id: 'golem-smaller',
    setup: s => { s.state = 'presentation'; s.slots.service = 'buy'; s.slots.propertyId = 37; s.slots.presentedIds = [37]; },
    text: 'GOLEM MI E NEKAKO',
    lane: 'GOLEM_SMALLER',
  },
  {
    id: 'golem-empty',
    // The smallest flat on the table: nothing smaller exists, so the honest
    // line owns the turn.
    setup: s => { s.state = 'presentation'; s.slots.service = 'buy'; s.slots.propertyId = 41; s.slots.presentedIds = [41]; },
    text: 'GOLEM MI E NEKAKO',
    lane: 'GOLEM_SMALLER_EMPTY',
  },
  {
    id: 'smaller-per-m2',
    setup: s => { s.state = 'presentation'; s.slots.service = 'buy'; s.slots.propertyId = 37; s.slots.presentedIds = [37]; },
    text: 'POMAL MI TREBA SO TAKVA CENA ZA KVADRAT',
    lane: 'SMALLER_PER_M2',
  },
  {
    id: 'place-pivot',
    // The criteria stand; only the PLACE moved. The confirm question owns the
    // turn — never a where-is about the flat on the table ([18:51]).
    setup: s => { s.state = 'presentation'; s.slots.service = 'buy'; s.slots.bedrooms = 3; s.slots.budget = '100000'; s.slots.location = 'Центар'; s.slots.presentedIds = [78]; },
    text: 'A NESTO KAJ BROZ KAFE ?',
    lane: 'PLACE_PIVOT',
  },
  {
    id: 'locate-reject-place',
    // «не е таа» about the flat she stands at: the place is a LOCK, so the next
    // options come from there and the chat moves into the hunt.
    setup: s => {
      s.state = 'closing'; s.slots.service = 'rent';
      s.slots.propertyId = 78; s.slots.interestedPropertyId = 78; s.slots.presentedIds = [78];
      s.slots.clarifyAnchor = { name: 'Рампа', lat: 41.98703, lon: 21.43691 };
    },
    text: 'NE, NE E TAA',
    lane: 'LOCATE_REJECT_PLACE',
    state: 'property_locate',
  },
  {
    id: 'where-is',
    setup: s => { s.state = 'property_query'; s.slots.service = 'rent'; s.slots.propertyId = 78; s.slots.presentedIds = [78]; },
    text: 'KADE SE NAOGJA STANOT ?',
    lane: 'WHERE_IS',
  },
  {
    id: 'price-question',
    setup: s => { s.state = 'closing'; s.slots.service = 'rent'; s.slots.propertyId = 78; s.slots.presentedIds = [78]; },
    text: 'KOLKU E KIRIJATA ?',
    lane: 'INFO_ASK',
  },
];

/** Only served lanes count: the classifier's pre-serve guess and the collision
 *  diagnostic are tags, not answers (the same taxonomy `routeLog` applies).
 *
 *  AND A SUFFIX IS NOT A DIFFERENT LANE: the executor logs `X:fast` on the fast
 *  path (and `:bank`/`:WHICH` on their own branches), and ROUTE_LANES registers
 *  each alias against the lane it belongs to — so the custody compares the lane
 *  FAMILY, exactly as the registry does. Comparing the raw tag would fail on a
 *  path choice instead of on an ownership change. */
const servedLanes = (tags: string[]): string[] =>
  tags.filter(t => !t.startsWith('ROUTE_UNKNOWN') && !t.startsWith('LANE_COLLISION'))
    .map(t => t.split(':')[0]!);

async function runCustody(row: CustodyRow): Promise<{ predicted?: string; served: string[]; state: string }> {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
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
  const chatId = `custody-${row.id}`;
  const s = freshSession('test', chatId);
  row.setup(s);
  sessions.set(s);
  for (const t of row.turns ?? []) await handler.handle('test', chatId, t);
  await handler.handle('test', chatId, row.text);
  const after = sessions.get(chatId)!;
  return {
    predicted: after.lastTurn?.predicted,
    served: servedLanes(after.lastTurn?.lanes ?? []),
    state: after.state,
  };
}

test('the lane custody table — every decisive field turn keeps its owner', async () => {
  const wrong: string[] = [];
  for (const row of rows) {
    const { predicted, served, state } = await runCustody(row);
    if (predicted !== undefined && predicted.split(':')[0] !== row.lane) {
      wrong.push(`${row.id}: the MIRROR now predicts ${predicted}, expected ${row.lane} ("${row.text}")`);
    }
    if (!served.includes(row.lane)) {
      wrong.push(`${row.id}: the SERVE is ${served.join(',') || '(none)'}, expected ${row.lane} ("${row.text}")`);
    }
    if (row.state !== undefined && state !== row.state) {
      wrong.push(`${row.id}: the turn left the session in ${state}, expected ${row.state}`);
    }
  }
  assert.deepEqual(wrong, [],
    `a lane changed an older lane's answer — a deliberate edit to the custody table is required:\n${wrong.join('\n')}`);
});
