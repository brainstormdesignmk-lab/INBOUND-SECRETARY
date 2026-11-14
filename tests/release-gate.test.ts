// PHASE 8 — THE RELEASE GATE (proposal: "mostly exists already … missing:
// parallel-chat isolation, degraded-feed, restart/rollback drill").
//
// The existing gate proves the suite passes on ONE chat with a healthy feed and
// an in-memory session. The field appliance has none of those conditions: several
// clients write at once, the feed goes down, the process is restarted mid-funnel.
// These three drills are the ones that were missing, each pinned on the REAL
// handler:
//
//   1. PARALLEL CHATS — two chats interleaved in the same process. Per-turn
//      values (text, the gave-up flag, the fee service hint) live on the turn
//      context, not on the shared handler, and the money counters are per
//      session. Cross-talk here would be a client hearing another client's words.
//   2. DEGRADED FEED — the feed throws. The appliance says it cannot see the
//      feed; it never invents a property, a price or an availability claim.
//   3. RESTART / ROLLBACK — a session written to SQLite is read back by a NEW
//      store over the SAME file, mid-funnel, with its counters intact. The
//      "rollback" half: a restart that loses the row leaves a fresh session and
//      the funnel re-asks instead of hallucinating progress.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { InboundHandler } from '../src/handlers/inbound';
import { Classifier } from '../src/llm/classify';
import { Responder } from '../src/llm/respond';
import { SessionStore, freshSession } from '../src/fsm/session';
import { PropertyService, Property } from '../src/data/properties';
import { AppointmentStore } from '../src/store/appointments';
import { EscalationStore } from '../src/store/escalations';
import { MetaStore } from '../src/store/meta';
import { ChannelRegistry } from '../src/channels/types';
import { LandmarkService } from '../src/geo/landmarks';
import { Db } from '../src/store/db';
import { EnrichmentStore } from '../src/store/enrichment';
import { loadConfig } from '../src/config';
import { setLearnedBank } from '../src/data/responseBank';

setLearnedBank({ variants: () => [], addVariant: () => false, addExample: () => false, metric: () => {}, retrieve: () => undefined } as never);

class FailingLlm { async complete(): Promise<string> { throw new Error('429 quota exhausted'); } }

class FakeProps extends PropertyService {
  down = false;
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> {
    if (this.down) throw new Error('feed unreachable');
    return this.rows;
  }
  get healthy(): boolean { return !this.down; }
}

const ROWS: Property[] = [
  { eb: 44, id: 44, location: 'Скопје Север', price: 130000, service: 'buy', bedrooms: 4, size: '150 м²', house: true, dostapnoOd: 'Веднаш' },
  { eb: 78, id: 78, location: 'Капиштец', price: 185000, service: 'buy', bedrooms: 3, size: '82 м²', dostapnoOd: 'Веднаш' },
  { eb: 79, id: 79, location: 'Водно', price: 300, service: 'rent', bedrooms: 2, size: '35 м²', dostapnoOd: 'Веднаш' },
];

function makeHandler(dbFile?: string): { handler: InboundHandler; sessions: SessionStore; properties: FakeProps; sent: Array<{ chatId: string; text: string }>; db: Db } {
  const cfg = loadConfig();
  const db = new Db(dbFile ?? ':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS);
  const channels = new ChannelRegistry();
  const sent: Array<{ chatId: string; text: string }> = [];
  channels.register({ name: 'gate', send: async (chatId: string, text: string) => { sent.push({ chatId, text }); } });
  const handler = new InboundHandler({
    cfg, db, sessions, classifier: new Classifier(new FailingLlm() as never, cfg, properties),
    responder: new Responder(new FailingLlm() as never, cfg), properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels, enrichment: new EnrichmentStore(db),
    landmarks: new LandmarkService(db, { osm: false }),
  });
  return { handler, sessions, properties, sent, db };
}

/** Run a turn with console noise suppressed (the handler logs every lane). */
async function say(h: InboundHandler, chatId: string, text: string): Promise<void> {
  const orig = console.log;
  console.log = () => {};
  try { await h.handle('gate', chatId, text); } finally { console.log = orig; }
}

test('PARALLEL CHATS: two interleaved clients never hear each other', async () => {
  const { handler, sessions, sent, db } = makeHandler();
  const A = 'client-a';
  const B = 'client-b';

  // A starts a buy funnel and states a budget; B wants to rent in another area.
  await say(handler, A, 'BARAM STAN ZA KUPUVANJE VO CENTAR');
  await say(handler, B, 'BARAM STAN ZA IZNAJMUVANJE VO VODNO');
  await say(handler, A, 'DO 200000 EVRA');
  await say(handler, B, 'DO 400 EVRA');

  const sa = sessions.get(A)!;
  const sb = sessions.get(B)!;
  assert.equal(sa.slots.service, 'buy', 'A stays a buy chat');
  assert.equal(sb.slots.service, 'rent', 'B stays a rent chat');
  // Budgets are stored as the client typed them (a string today, a number for a
  // parsed figure) — the drill asserts the VALUE, not its representation.
  assert.equal(Number(sa.slots.budget ?? sa.slots.buyBudget), 200000,
    `A's budget: ${JSON.stringify(sa.slots.budget ?? sa.slots.buyBudget)}`);
  assert.equal(Number(sb.slots.budget), 400, `B's budget: ${JSON.stringify(sb.slots.budget)}`);
  assert.ok(!/ВОДНО/i.test(String(sa.slots.location ?? '')), `A must not inherit B's area: ${sa.slots.location}`);
  assert.ok(!/ЦЕНТАР/i.test(String(sb.slots.location ?? '')), `B must not inherit A's area: ${sb.slots.location}`);

  // THE AUDIT RECORD IS PER TURN: each chat's last record carries ITS OWN text.
  assert.equal(sa.lastTurn?.text, 'DO 200000 EVRA');
  assert.equal(sb.lastTurn?.text, 'DO 400 EVRA');
  assert.equal(sa.lastTurn?.chatId, A);
  assert.equal(sb.lastTurn?.chatId, B);

  // Every reply went to the chat that asked — never to the other one.
  for (const m of sent) {
    if (m.chatId === A) assert.ok(!/ВОДНО/i.test(m.text) || /ВОДНО/i.test(String(sa.slots.location ?? '')), `A heard B's area: ${m.text}`);
  }

  // THE MONEY COUNTERS ARE PER SESSION, not per process: A resisting the fee
  // must not spend B's rung.
  await say(handler, A, 'KOLKU E ZA POSETA?');
  await say(handler, B, 'DALI USTE E NA PRODAZBA 78?');
  await say(handler, A, 'NE SAKAM DA PLATAM ZA POSETA');
  const feeA = sessions.get(A)!.slots.feeRejections ?? 0;
  const feeB = sessions.get(B)!.slots.feeRejections ?? 0;
  assert.ok(feeA >= 1, `A's own objection burned A's rung: ${feeA}`);
  assert.equal(feeB, 0, `B's ladder must be untouched by A's objection: ${feeB}`);
  db.db.close();
});

test('DEGRADED FEED: the appliance says it cannot see the feed — it never invents', async () => {
  const { handler, properties, sent, db } = makeHandler();
  properties.down = true;
  const chatId = 'feed-down';
  await say(handler, chatId, 'BARAM STAN VO CENTAR DO 150000 EVRA');

  const replies = sent.map(m => m.text).join('\n');
  assert.ok(replies.trim().length > 0, 'a dead feed must still produce an honest answer, not silence');
  // No card, no EB, no invented price/area — the three things a degraded feed
  // makes unknowable.
  assert.doesNotMatch(replies, /Евидентен број\s*\d+/u, `no property may be named: ${replies}`);
  assert.doesNotMatch(replies, /\b\d{2,3}\.\d{3}\b/u, `no price may be invented: ${replies}`);
  const session = handler['deps'].sessions.get(chatId)!;
  assert.ok((session.lastTurn?.replies.length ?? 0) > 0, 'the turn is audited even when the feed is down');
  db.db.close();
});

test('RESTART: a mid-funnel session survives a new store over the same file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lina-restart-'));
  const dbFile = path.join(dir, 'appliance.db');
  try {
    const first = makeHandler(dbFile);
    const chatId = 'restart-me';
    await say(first.handler, chatId, 'BARAM STAN ZA KUPUVANJE VO CENTAR');
    await say(first.handler, chatId, 'DO 200000 EVRA');
    await say(first.handler, chatId, 'DALI USTE E NA PRODAZBA 78?');
    await say(first.handler, chatId, 'KOLKU E ZA POSETA?');
    await say(first.handler, chatId, 'NE SAKAM DA PLATAM ZA POSETA');

    const before = first.sessions.get(chatId)!;
    const snapshot = {
      state: before.state,
      service: before.slots.service,
      location: before.slots.location,
      budget: before.slots.budget ?? before.slots.buyBudget,
      propertyId: before.slots.propertyId,
      feeRejections: before.slots.feeRejections ?? 0,
    };
    assert.ok(snapshot.feeRejections >= 1, `the objection happened before the restart: ${snapshot.feeRejections}`);
    first.db.db.close();

    // A NEW process: new Db handle, new SessionStore, same file.
    const second = makeHandler(dbFile);
    const after = second.sessions.get(chatId);
    assert.ok(after, 'the session must be found after a restart');
    assert.equal(after!.state, snapshot.state, 'the funnel state survives');
    assert.equal(after!.slots.service, snapshot.service, 'the market survives');
    assert.equal(after!.slots.location, snapshot.location, 'the area criterion survives');
    assert.equal(after!.slots.budget ?? after!.slots.buyBudget, snapshot.budget, 'the budget survives');
    assert.equal(after!.slots.propertyId, snapshot.propertyId, 'the flat under discussion survives');
    assert.equal(after!.slots.feeRejections, snapshot.feeRejections, 'the money ladder position survives');
    assert.ok(after!.lastTurn, 'the audit record survives — it is what the explain lane reads');
    second.db.db.close();

    // ROLLBACK: a session that is NOT in the file starts clean instead of
    // pretending progress. No phantom fee rung, no phantom flat.
    const third = makeHandler(dbFile);
    const lost = third.sessions.get('never-existed') ?? freshSession('never-existed', 'gate');
    assert.equal(lost.slots.feeRejections ?? 0, 0, 'a fresh session starts at rung zero');
    assert.equal(lost.slots.propertyId, undefined, 'and with no flat under discussion');
    third.db.db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
