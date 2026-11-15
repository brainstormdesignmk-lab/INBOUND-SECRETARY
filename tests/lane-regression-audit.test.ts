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
import { SessionStore, freshSession, pushHistory } from '../src/fsm/session';
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
  { eb: 78, id: 78, location: 'Центар', address: 'Ул. В 3', price: 800, bedrooms: 2, sqm: 60, size: '60 м²', service: 'rent', details: 'стан со двор', lat: 41.9880, lon: 21.4380 },
  { eb: 63, id: 63, location: 'Центар', address: 'Ул. Г 4', price: 400, bedrooms: 2, sqm: 40, size: '40 м²', service: 'rent', details: 'стан со тераса', lat: 41.9890, lon: 21.4390 },
  // A MICRO-AREA ONLY THE FEED KNOWS: «Ново Маало» is not in the alias table nor
  // in `detectLocation`, so the market band's scope test can only be predicted
  // through the evidence channel (the borrowed LIMIT this table now pins).
  { eb: 88, id: 88, location: 'Карпош', address: 'Ул. Д 5', price: 500, bedrooms: 1, sqm: 45, size: '45 м²', service: 'rent', details: 'Ново Маало, стан', lat: 42.0000, lon: 21.4100 },
  // A ROW WITH NO STORED PRICE: «дали е уште таа цена?» must still be answered
  // by PRICE_FRESHNESS (the honest «немам внесено цена» line), not by the plain
  // price ask.
  { eb: 902, id: 902, location: 'Центар', address: 'Ул. Ж 7', bedrooms: 1, sqm: 40, size: '40 м²', service: 'rent' },
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
    id: 'identify-figure-cold',
    // THE COLD HALF OF THE SAME LANE: the figure is on NO served row (60 м² is
    // EB 78, the table holds EB 63), so the answer comes from the offer. Before
    // the fix this row was predicted here and SERVED as a fresh search — the
    // drift the custody table exists to catch.
    setup: s => { s.state = 'presentation'; s.slots.service = 'rent'; s.slots.currentBatch = [63]; s.slots.presentedIds = [63]; },
    text: 'KOJ IMA 60 M2 ?',
    lane: 'IDENTIFY_BY_FIGURE',
    state: 'presentation',
  },
  {
    id: 'identify-figure-none',
    // …and a figure nothing in the offer carries is still the LANE's turn: the
    // honest absence line, never a search with the figure read as money.
    setup: s => { s.state = 'presentation'; s.slots.service = 'rent'; s.slots.currentBatch = [78, 63]; s.slots.presentedIds = [78, 63]; },
    text: 'KOJ IMA 300 M2 ?',
    lane: 'IDENTIFY_BY_FIGURE',
    state: 'presentation',
  },
  {
    id: 'which-property-cold',
    // THE DOCUMENTED LIMITS ARE CLOSED BY THE SERVE, NOT BY A COMMENT: with no
    // anchor flat the which-flat question is still this lane's turn — the bank's
    // `property.which.none` line asks for the Евидентен број. It used to fall
    // through to the funnel while the mirror predicted this lane.
    setup: () => {},
    text: 'ZA KOJ STAN STANUVA ZBOR ?',
    lane: 'WHICH_PROPERTY',
  },
  {
    id: 'stock-contradiction-cold',
    // Same class: a caught contradiction with no card to correct from gets the
    // apology + the EB ask, never the geography reader.
    setup: () => {},
    text: 'PA KAKO NEMA ? KOGA OVOJ E EDEN OD NIV ?',
    lane: 'STOCK_CONTRADICTION',
  },
  {
    id: 'price-freshness-no-price',
    setup: s => { s.state = 'property_query'; s.slots.service = 'rent'; s.slots.propertyId = 902; s.slots.interestedPropertyId = 902; s.slots.presentedIds = [902]; },
    text: 'A DALI MU E USTE TAA CENA ?',
    lane: 'PRICE_FRESHNESS',
    state: 'property_query',
  },
  {
    id: 'price-freshness-gone',
    // The row the offer no longer holds: «веќе не е во понудата», not «за кое
    // станува збор?».
    setup: s => { s.state = 'property_query'; s.slots.service = 'rent'; s.slots.propertyId = 999; s.slots.interestedPropertyId = 999; s.slots.presentedIds = [999]; },
    text: 'A DALI MU E USTE TAA CENA ?',
    lane: 'PRICE_FRESHNESS',
    state: 'property_query',
  },
  {
    id: 'info-stale-slot',
    // A facet ask about a slot the feed no longer has — answered in-lane.
    setup: s => { s.state = 'property_query'; s.slots.service = 'rent'; s.slots.propertyId = 999; s.slots.presentedIds = [999]; },
    text: 'KOLKU E ?',
    lane: 'INFO_ASK',
    state: 'property_query',
  },
  {
    id: 'market-micro-area',
    // The market band's scope test reads the FEED's micro-areas: «Ново Маало» is
    // in one ad's text and in no neighbourhood list, and only the evidence probe
    // can see it (resolveIntent without the evidence predicts INFO_ASK here).
    setup: s => { s.state = 'property_query'; s.slots.service = 'rent'; s.slots.propertyId = 78; s.slots.presentedIds = [78]; },
    text: 'KOLKU E KIRIJATA VO NOVO MAALO ?',
    lane: 'MARKET_PRICE',
    state: 'property_query',
  },
  {
    id: 'pick-by-detail',
    // «онаа со дворот» picks by a row's OWN field — the arm the mirror can only
    // reach through the evidence channel (which of the described rows has a yard).
    setup: s => { s.state = 'property_locate'; s.slots.service = 'rent'; s.slots.describedEbs = [78, 63]; },
    text: 'ONAA SO DVOROT ?',
    lane: 'PICK_DESCRIBED',
    state: 'closing',
  },
  {
    id: 'facet-over-described-pair',
    // A facet ask while a described pair is in memory is the INFO block's — the
    // executor reaches it long before the pick, and the pick row must not claim
    // the turn (it did: PICK_DESCRIBED→INFO_ASK drift).
    setup: s => { s.state = 'property_locate'; s.slots.service = 'rent'; s.slots.describedEbs = [78, 63]; },
    text: 'KOLKU E 78 ?',
    lane: 'INFO_ASK',
    state: 'property_locate',
  },
  {
    id: 'elliptical-last-floor',
    // «POSLEDEN ?» is a top-floor ask only after a line that named a кат: that
    // fact now lives in `slots.lastReplyNamedFloor` (pushHistory records it), so
    // the mirror reads the same memory the executor does.
    setup: s => {
      s.state = 'property_query'; s.slots.service = 'rent';
      s.slots.propertyId = 78; s.slots.presentedIds = [78];
      pushHistory(s, { role: 'assistant', text: 'Станот со Евидентен број 78 се наоѓа на 3 кат.' }, 20);
    },
    text: 'POSLEDEN ?',
    lane: 'INFO_ASK',
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

async function runCustody(row: CustodyRow): Promise<{ predicted?: string; served: string[]; state: string; reply: string }> {
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
    reply: sent[sent.length - 1] ?? '',
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

/** A LAW OF THIS TABLE DOES NOT HOLD FOR EVERY TURN: the notebook recall
 *  («ПА ТИ КАЖАВ КАДЕ») stands down when a flat is on the table (that makes it a
 *  where-is/visit topic) and when the message carries a DIGIT (a figure IS the
 *  criterion answer). Both facts are slots/text, so both sides could read them
 *  — but the mirror did not, and predicted a lane the executor never served. */
test('a told-you nag with a shown flat or a figure is not the notebook lane', async () => {
  const cases: Array<{ id: string; setup: (s: ChatSession) => void; text: string }> = [
    {
      id: 'told-you-flat-on-table',
      setup: s => { s.state = 'discovery'; s.slots.service = 'rent'; s.slots.propertyId = 78; s.slots.presentedIds = [78]; },
      text: 'PA TI KAZAV KADE',
    },
    {
      id: 'told-you-carries-a-figure',
      setup: s => { s.state = 'discovery'; s.slots.service = 'rent'; },
      text: 'PA TI KAZAV 2 SOBI',
    },
  ];
  const wrong: string[] = [];
  for (const c of cases) {
    const out = await runCustody({ id: c.id, setup: c.setup, text: c.text, lane: 'TOLD_YOU_RECALL' });
    if (out.predicted?.split(':')[0] === 'TOLD_YOU_RECALL') {
      wrong.push(`${c.id}: the MIRROR predicted TOLD_YOU_RECALL for "${c.text}"`);
    }
    if (out.served.includes('TOLD_YOU_RECALL')) {
      wrong.push(`${c.id}: the SERVE was TOLD_YOU_RECALL for "${c.text}"`);
    }
  }
  assert.deepEqual(wrong, [], `the recall lane took a turn its own gate refuses:\n${wrong.join('\n')}`);
});

/** THE CLOSED LIMITS SERVE HONESTLY, not merely "own the turn".
 *
 *  A lane that keeps the turn with the wrong sentence is not a fix: each of
 *  these used to fall through because the fact it needed was outside the
 *  mirror's reach (a card that does not exist, a row the feed lost, a price
 *  never entered), so the sentence that replaced the fall-through has to be
 *  pinned: the absence stated, the next step asked, and NO fee, no search, and
 *  no invented figure. */
test('the closed limits answer with an honest line, never a fall-through', async () => {
  const byId = async (id: string) => {
    const row = rows.find(r => r.id === id)!;
    return { row, out: await runCustody(row) };
  };

  // 1. WHICH flat, with nothing bound — the property.which.none line asks for
  //    the number instead of guessing a flat.
  {
    const { out } = await byId('which-property-cold');
    assert.match(out.reply, /Евидентен број/u, `the ask names the handle: ${out.reply}`);
    assert.match(out.reply, /\?/u, `and it is a question: ${out.reply}`);
    assert.doesNotMatch(out.reply, /(?:300|500)\s*(?:ден|den|евра)/iu,
      `never the fee: ${out.reply}`);
  }

  // 2. A caught contradiction with no card — the apology + the EB ask, never a
  //    landmark or an address-protocol line.
  {
    const { out } = await byId('stock-contradiction-cold');
    assert.match(out.reply, /Извинете/u, `the apology: ${out.reply}`);
    assert.match(out.reply, /Евидентниот број/u, `and the handle asked for: ${out.reply}`);
    assert.doesNotMatch(out.reply, /адреса|населба|километри/iu,
      `no geography answer to a caught mistake: ${out.reply}`);
  }

  // 3. A price freshness ask on a row with NO price on file — the absence of
  //    the figure is stated and the owner check offered, never a bare amount.
  {
    const { out } = await byId('price-freshness-no-price');
    assert.match(out.reply, /немам внесена цена/u, `the absent figure is named: ${out.reply}`);
    assert.match(out.reply, /\?/u, `and the owner check is offered: ${out.reply}`);
    assert.doesNotMatch(out.reply, /\d{2,}\.?\d*\s*евра/u, `no invented figure: ${out.reply}`);
  }

  // 4. The same ask about a row the offer no longer holds — said plainly.
  {
    const { out } = await byId('price-freshness-gone');
    assert.match(out.reply, /веќе не е во понудата/u, `the row is gone, and that is said: ${out.reply}`);
    assert.match(out.reply, /\?/u, `with the next step: ${out.reply}`);
  }

  // 5. A facet ask about a slot the feed lost — the honest absence, never a
  //    card re-serve or another flat's fact.
  {
    const { out } = await byId('info-stale-slot');
    assert.match(out.reply, /веќе не е во понудата/u, `the slot is stale: ${out.reply}`);
    assert.doesNotMatch(out.reply, /Евидентен број \d+ ·/u, `no card: ${out.reply}`);
  }
});
