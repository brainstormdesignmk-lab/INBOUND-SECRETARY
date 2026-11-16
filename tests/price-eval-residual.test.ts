/**
 * THE RESIDUAL PRICE EVALUATION IS A COLLECTOR, NOT A LANE — and the audit must
 * say so.
 *
 * `PRICE_EVAL_EXPENSIVE_UNWIRED` was the biggest entry in the gap audit's
 * backlog (69 turns a day, 183 over three days) and it looked like an unserved
 * lane. Replaying every row of it through the real handler showed the opposite:
 *
 *   • «MISLAM DEKA CENITE SE PREVISOKI ZA TOJ REON» / «…PREVISOKI» in
 *     presentation → the INVESTMENT OPINION lane answers, bank-backed;
 *   • «ne se soglasuvam, skapo e» in closing → the fee ladder's rung answers.
 *
 * The tag is registered with `K(...)`: a marker that logs and FALLS THROUGH, and
 * `routeLog` refuses to write a drift row for it, so it can never be a gap. Two
 * defects made the audit report otherwise, and both are pinned here:
 *
 *   1. the day files were not field-only — every test that drove the handler
 *      without calling `setRouteDriftDir` appended harness turns (chatIds
 *      `invest-cyr`, `closing-digress`, `negated-agree-e2e`) into `data/`, so
 *      the "field backlog" was built from fixtures;
 *   2. the audit classified any `intent: null` registry row as PENDING (backlog)
 *      without asking whether it is a marker — `tagStatus` now separates the
 *      two, and marker rows are reported as history.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
import { LlmClient } from '../src/llm/types';
import { flushRouteDrift, readRouteDrift, routeDriftDir } from '../src/store/routeDrift';
import {
  defaultPlaceMissDir, placeMissDir, recordPlaceMiss, flushPlaceMisses, readPlaceMisses,
} from '../src/store/placeMisses';
import { ROUTE_LANES, routeLog, tagStatus } from '../src/handlers/router';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

class MockEnrichment {
  records: Array<{ userMsg: string; replyText: string; bankKey?: string }> = [];
  insert(rec: { userMsg: string; replyText: string; bankKey?: string }): void { this.records.push(rec); }
}

const FEED: Property[] = [
  { eb: 53, id: 53, location: 'Аеродром', price: 55000, bedrooms: 2, sqm: 44, size: '44 м²', service: 'buy' },
  { eb: 65, id: 65, location: 'Центар', price: 950, bedrooms: 1, sqm: 32, size: '32 м²', service: 'rent' },
] as unknown as Property[];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

interface Run {
  predicted?: string;
  lanes: string[];
  reply: string;
  state: string;
  enrichment: MockEnrichment;
}

async function run(chatId: string, pre: string[], turn: string): Promise<Run> {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const props = new FakeProps(FEED);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, t: string) => { sent.push(t); } });
  const enrichment = new MockEnrichment();
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, props),
    responder: new Responder(new FailingLlm(), cfg),
    properties: props,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false }),
    enrichment: enrichment as never,
  });
  sessions.set(freshSession('test', chatId));
  for (const p of pre) await handler.handle('test', chatId, p);
  await handler.handle('test', chatId, turn);
  const s = sessions.get(chatId)!;
  return { predicted: s.lastTurn?.predicted, lanes: s.lastTurn?.lanes ?? [], reply: sent[sent.length - 1] ?? '', state: s.state, enrichment };
}

/** THE DAY FILES ARE FIELD EVIDENCE. A test run must not append to them:
 *  `routeDrift` defaults to a per-process temp dir when `node:test` marks the
 *  worker, and this file never overrides the dir — so this assertion reads the
 *  same default the harness writes through. */
test('a test run never writes route telemetry into the repo data dir', async () => {
  assert.ok(process.env.NODE_TEST_CONTEXT, 'run under node --test (npm test / test:c)');
  const dir = routeDriftDir();
  assert.ok(!dir.endsWith(path.join(process.cwd(), 'data')), `drift dir is the field dir: ${dir}`);
  assert.ok(dir.startsWith(os.tmpdir()), `drift dir is not a temp dir: ${dir}`);

  // …and a REAL drift still persists (the isolation must not mute the channel):
  routeLog('residual-probe', 'bank check', 'CHAIN_READY', 'predict');
  routeLog('residual-probe', 'bank check', 'CHAIN_READY');
  await flushRouteDrift();
  const rows = await readRouteDrift();
  assert.deepEqual(rows.filter(r => r.chatId === 'residual-probe'), [],
    'a marker intent can never be a drift row');

  // THE SIBLING STORE OBEYS THE SAME RULE (place misses are evidence too — a
  // handler-driven test that records one used to land in `data/`, which is how
  // the day files grew harness rows with an empty chatId).
  const missDir = placeMissDir();
  assert.equal(missDir, defaultPlaceMissDir(), 'the harness must read the default it writes through');
  assert.ok(!missDir.endsWith(path.join(process.cwd(), 'data')), `place-miss dir is the field dir: ${missDir}`);
  assert.ok(missDir.startsWith(os.tmpdir()), `place-miss dir is not a temp dir: ${missDir}`);
  recordPlaceMiss({ at: Date.now(), chatId: 'residual-probe', text: 'KADE E TEST PLACE X' });
  await flushPlaceMisses();
  assert.ok((await readPlaceMisses()).some(m => m.text === 'KADE E TEST PLACE X'),
    'the miss channel still persists (isolation must not mute it)');
});

/** THE THREE RESIDUAL SHAPES OF THE DAY FILES, each one answered by the lane
 *  its mirror predicted — never by the marker. */
test('a negative price evaluation is answered by the lane it belongs to, and never drifts', async () => {
  // 1. presentation, no flat on the table → the investment opinion lane
  const a = await run('residual-p1', ['SAKAM DA KUPAM STAN VO VODNO', 'DO 500 EVRA, DVOSOBEN'],
    'MISLAM DEKA CENITE SE PREVISOKI ZA TOJ REON');
  assert.equal(a.predicted, 'INVESTMENT_OPINION', `mirror said ${a.predicted}`);
  assert.deepEqual(a.lanes, ['PRICE_EVAL_EXPENSIVE_UNWIRED'],
    `the residual is the only logged tag, the serve is the investment lane: ${a.lanes.join(',')}`);
  assert.equal(a.state, 'presentation', 'a digression keeps the state');
  const opinion = a.enrichment.records.find(r => r.userMsg.includes('PREVISOKI'));
  assert.ok(opinion, 'the turn is logged to enrichment');
  assert.equal(opinion!.bankKey, 'investment.opinion', '…as the investment opinion it is');

  // 2. the same complaint without the place phrase → the same lane
  const b = await run('residual-p2', ['SAKAM DA KUPAM STAN VO VODNO', 'DO 500 EVRA, DVOSOBEN'],
    'MISLAM DEKA CENITE SE PREVISOKI');
  assert.equal(b.predicted, 'INVESTMENT_OPINION');
  assert.ok(b.reply.length > 40, `no answer served: ${b.reply}`);

  // 3. closing, after a viewing request → the FEE RUNG answers, not the marker
  const c = await run('residual-p3', ['mi treba stan pod kirija vo karpos do 300', 'sakam da go vidam 65'],
    'ne se soglasuvam, skapo e');
  assert.equal(c.state, 'closing');
  assert.ok(/300 денари|надомест|симболич/iu.test(c.reply), `the fee rung must answer: ${c.reply}`);
  assert.deepEqual(c.lanes, ['PRICE_EVAL_EXPENSIVE_UNWIRED']);

  await flushRouteDrift();
  const rows = await readRouteDrift();
  for (const id of ['residual-p1', 'residual-p2', 'residual-p3']) {
    assert.deepEqual(rows.filter(r => r.chatId === id), [], `${id} must not teach the audit a gap`);
  }
});

/** THE AUDIT'S OWN CLASSIFICATION — the four families, in the one place both
 *  readers use. A marker row in an old day file is history, never backlog. */
test('tagStatus separates a lane, a marker, a backlog row and a retired tag', () => {
  assert.equal(tagStatus('WHERE_IS', true), 'mirrored');
  assert.equal(tagStatus('PROPERTY_CHOICE:fast', true), 'mirrored', 'the suffixed spelling of a mirrored lane');
  assert.equal(tagStatus('PRICE_EVAL_EXPENSIVE_UNWIRED', true), 'residual');
  assert.equal(tagStatus('CHAIN_READY', true), 'residual');
  assert.equal(tagStatus('SOME_TAG_NOBODY_REGISTERED', true), 'unlisted');
  assert.equal(tagStatus('SOME_TAG_NOBODY_REGISTERED', false), 'history');
  // The registry really does mark them: a P(...) row has no marker, a K(...) row
  // has one — the audit's "pending backlog" line may only ever count the former.
  assert.equal(ROUTE_LANES.PRICE_EVAL_EXPENSIVE_UNWIRED?.marker, true);
  assert.equal(ROUTE_LANES.CHAIN_READY?.marker, true);
  assert.equal(ROUTE_LANES.WHERE_IS?.marker, undefined);
});
