// PHASE 0 — THE VERDICT LEDGER (docs/classifier-build-runbook.md).
//
// These tests pin the contract the rest of the build stands on:
//   • a fresh AND an existing DB both get `classify_turns`;
//   • every verdict carries (norm, state, sigKey) and the tier that decided it;
//   • a FAILED remote classify is degraded=1 — never a silent STAY;
//   • the deadline converts a hanging brain into a degraded verdict;
//   • the handler records real turns at the seam (det and remote legs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config';
import { Db } from '../src/store/db';
import { SessionStore, freshSession } from '../src/fsm/session';
import { Classifier } from '../src/llm/classify';
import { Responder } from '../src/llm/respond';
import { ClassifyTurnStore } from '../src/store/classifyTurns';
import { buildRouteSig, sigKey, awaitingKind, parseRouteSig } from '../src/llm/routeSig';
import { shouldRecordTurn, shouldTeachBank } from '../src/llm/enrichPolicy';
import { PropertyService, Property } from '../src/data/properties';
import { AppointmentStore } from '../src/store/appointments';
import { EscalationStore } from '../src/store/escalations';
import { MetaStore } from '../src/store/meta';
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LandmarkService } from '../src/geo/landmarks';
import { LlmClient } from '../src/llm/types';

const ROWS: Property[] = [
  { eb: 79, id: 79, location: 'Водно', address: 'Водно', price: 300, service: 'rent', bedrooms: 2, sqm: 35, size: '35 м²' } as Property,
  { eb: 80, id: 80, location: 'Кисела Вода', address: 'Рампа', price: 46000, service: 'buy', bedrooms: 2, sqm: 55, size: '55 м²' } as Property,
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getById(id: number): Promise<Property | undefined> { return this.rows.find(r => r.id === id || r.eb === id); }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  get healthy(): boolean { return true; }
}

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

/** Holds the completion until the test releases it — the deadline must fire
 *  while the brain is still thinking. The gate is then settled explicitly, so
 *  the abandoned promise does not outlive the test (node:test reports a
 *  dangling async operation otherwise, which would hide real failures). */
class GatedLlm implements LlmClient {
  private release!: (v: string) => void;
  readonly gate = new Promise<string>(resolve => { this.release = resolve; });
  complete(): Promise<string> { return this.gate; }
}

function makeHandler(llm: LlmClient, cfgOverrides: Record<string, unknown> = {}) {
  const cfg = loadConfig(cfgOverrides as any);
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const classifyTurns = new ClassifyTurnStore(db);
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(llm, cfg, properties),
    responder: new Responder(llm, cfg),
    properties,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false }),
    classifyTurns,
  });
  return { handler, sessions, sent, db, classifyTurns };
}

// ── Schema + store ──────────────────────────────────────────────────────────

test('classify_turns exists on a fresh DB and accepts a row', () => {
  const db = new Db(':memory:');
  const store = new ClassifyTurnStore(db);
  const id = store.insert({
    chatId: 'c1', state: 'idle', text: 'ZDRAVO', norm: 'zdravo',
    sig: '{}', sigKey: 'n0|d0|m0|p0|f0|a:none|s:unknown',
    event: 'STAY', tier: 'det', latencyMs: 3,
  });
  assert.ok(id > 0);
  const row = store.byId(id);
  assert.equal(row?.event, 'STAY');
  assert.equal(row?.tier, 'det');
  assert.equal(row?.degraded, 0);
  assert.equal(row?.outcome, null);
});

test('the migration is idempotent — a second Db open keeps the rows', () => {
  const file = `${process.env.TMPDIR ?? '/tmp'}/lina-classify-turns-${process.pid}-${Date.now()}.db`;
  const first = new Db(file);
  new ClassifyTurnStore(first).insert({
    chatId: 'c', state: 'idle', text: 'X', norm: 'x', sig: '{}', sigKey: 'k',
    event: 'STAY', tier: 'remote', degraded: true,
  });
  first.close();
  const second = new Db(file);
  const store = new ClassifyTurnStore(second);
  assert.equal(store.count(), 1);
  assert.equal(store.recent(1)[0]?.degraded, 1);
  second.close();
});

test('stats count tiers, events and degraded separately', () => {
  const db = new Db(':memory:');
  const store = new ClassifyTurnStore(db);
  const base = { chatId: 'c', state: 'idle', text: 'T', norm: 't', sig: '{}', sigKey: 'k' };
  store.insert({ ...base, event: 'STAY', tier: 'det', latencyMs: 10 });
  store.insert({ ...base, event: 'STAY', tier: 'remote', latencyMs: 5000, degraded: true });
  store.insert({ ...base, event: 'INTERESTED', tier: 'remote', latencyMs: 1000 });
  const s = store.stats();
  assert.equal(s.total, 3);
  assert.equal(s.degraded, 1);
  assert.equal(s.byTier.det, 1);
  assert.equal(s.byTier.remote, 2);
  assert.equal(s.byEvent.INTERESTED, 1);
});

test('outcome linking only touches unlinked rows', () => {
  const db = new Db(':memory:');
  const store = new ClassifyTurnStore(db);
  const id = store.insert({
    chatId: 'c', state: 'idle', text: 'T', norm: 't', sig: '{}', sigKey: 'k',
    event: 'STAY', tier: 'remote',
  });
  assert.equal(store.unlinked().length, 1);
  assert.equal(store.markOutcome(id, 'clean'), true);
  assert.equal(store.unlinked().length, 0);
  assert.equal(store.byId(id)?.outcome, 'clean');
});

// ── Signature ───────────────────────────────────────────────────────────────

test('sigKey is order-stable and total', () => {
  const s = {
    negated: true, digit: false, moneyWord: true, propertyOnTable: false,
    feeRung: true, awaiting: 'contact' as const, service: 'rent' as const,
  };
  assert.equal(sigKey(s), 'n1|d0|m1|p0|f1|a:contact|s:rent');
  assert.deepEqual(parseRouteSig(JSON.stringify(s)), s);
});

test('the signature separates the DOGOVORI MI class', () => {
  const session = freshSession('test', 'c');
  session.slots.service = 'buy';
  const quiet = buildRouteSig(session, 'DOGOVORI MI');
  session.slots.feeRejections = 1;
  const rung = buildRouteSig(session, 'DOGOVORI MI');
  assert.notEqual(sigKey(quiet), sigKey(rung), 'rung depth must change the key');
  session.slots.propertyId = 79;
  const anchored = buildRouteSig(session, 'DOGOVORI MI');
  assert.notEqual(sigKey(rung), sigKey(anchored), 'a flat on the table must change the key');
});

test('negation, digits and money words are flagged', () => {
  const session = freshSession('test', 'c');
  assert.equal(buildRouteSig(session, 'NE MOZE').negated, true);
  assert.equal(buildRouteSig(session, 'MOZE').negated, false);
  assert.equal(buildRouteSig(session, 'nekolku opcii').negated, false, 'nekolku is not a negator');
  assert.equal(buildRouteSig(session, 'DAJ MI 78').digit, true);
  assert.equal(buildRouteSig(session, 'ПРОВИЗИЈАТА НЕ Е ВИСОКА').moneyWord, true);
  assert.equal(buildRouteSig(session, 'ПРОВИЗИЈАТА НЕ Е ВИСОКА').negated, true);
});

test('awaiting reads the previous question, not a statement', () => {
  assert.equal(awaitingKind('Колку е Вашиот телефонски број?'), 'contact');
  assert.equal(awaitingKind('За посета се плаќа 500 денари. Дали се согласувате?'), 'fee');
  assert.equal(awaitingKind('Во кој дел од градот?'), 'location');
  assert.equal(awaitingKind('Евидентен број 79 — Водно, 300 евра.'), 'none');
  assert.equal(awaitingKind('Кој е Вашиот буџет?').toString(), 'budget');
});

// ── Degradation ─────────────────────────────────────────────────────────────

test('a failed remote classify is degraded, never a silent STAY', async () => {
  const cfg = loadConfig();
  const classifier = new Classifier(new FailingLlm(), cfg, new FakeProps(ROWS));
  const session = freshSession('test', 'c');
  const verdict = await classifier.classify(session, 'SHTO IMATE VO CENTAR');
  // The EVENT may be recomputed by the LLM-down slot path (that is the
  // documented degradation ladder, not a bug) — what must never be lost is
  // the fact that the remote tier FAILED.
  assert.equal(verdict.degraded, true);
  assert.equal(verdict.tier, 'remote');
});

test('the classify deadline turns a hanging brain into a degraded verdict', async () => {
  const cfg = loadConfig({ classifyTimeoutMs: 40 });
  const llm = new GatedLlm();
  const classifier = new Classifier(llm, cfg, new FakeProps(ROWS));
  const session = freshSession('test', 'c');
  const t0 = Date.now();
  const verdict = await classifier.classify(session, 'NEPOZNATO PRASHANJE');
  assert.equal(verdict.event.type, 'STAY');
  assert.equal(verdict.degraded, true);
  assert.ok(Date.now() - t0 < 2_000, 'the deadline must not wait for the brain');
  // Settle the abandoned completion so nothing dangles past the test.
  llm.release('{"event":"STAY"}');
  await llm.gate;
});

test('deterministic verdicts are tagged with their tier', async () => {
  const cfg = loadConfig();
  const classifier = new Classifier(new FailingLlm(), cfg, new FakeProps(ROWS));
  const session = freshSession('test', 'c');
  const verdict = await classifier.deterministicClassify(session, 'ZDRAVO');
  assert.ok(verdict, 'a greeting is deterministic');
  assert.equal(verdict?.tier, 'det');
  assert.equal(typeof verdict?.latencyMs, 'number');
});

// ── The seam ────────────────────────────────────────────────────────────────

test('the handler records the deterministic leg at the classify seam', async () => {
  const { handler, sessions, classifyTurns } = makeHandler(new FailingLlm());
  await handler.handle('test', 'ledger-det', 'SAKAM DA KUPAM STAN VO VODNO');
  const rows = classifyTurns.forChat('ledger-det');
  assert.ok(rows.length >= 1, 'the turn must leave a ledger row');
  const row = rows[0]!;
  assert.equal(row.tier, 'det');
  assert.equal(row.state, 'idle');
  assert.ok(row.norm.includes('sakam'), 'the row keeps the normalized identity');
  assert.ok(row.sigKey.includes('a:'), 'the row keeps the signature');
  assert.equal(row.degraded, 0);
  assert.ok(sessions.get('ledger-det'));
});

test('the seam records a degraded remote verdict', async () => {
  const { handler, classifyTurns } = makeHandler(new FailingLlm());
  // Drive the SEAM directly (classifier degradation has its own test above):
  // a deterministic miss followed by a degraded remote verdict is exactly the
  // shape that used to leave no trace anywhere.
  (handler as unknown as { deps: { classifier: unknown } }).deps.classifier = {
    deterministicClassify: async () => undefined,
    classify: async () => ({
      event: { type: 'STAY' }, offensive: false, offenseLevel: 0,
      tier: 'remote', degraded: true, latencyMs: 8_001, attempts: 9,
    }),
  };
  await handler.handle('test', 'ledger-remote', 'QWE RTY');
  const rows = classifyTurns.forChat('ledger-remote');
  assert.equal(rows.length, 1, 'exactly one verdict row for the turn');
  assert.equal(rows[0]!.tier, 'remote');
  assert.equal(rows[0]!.degraded, 1);
  assert.equal(rows[0]!.attempts, 9);
});

// ── Policy split ────────────────────────────────────────────────────────────

test('exam mode still measures (it only stops TEACHING)', () => {
  assert.equal(shouldTeachBank('free'), false);
  assert.equal(shouldRecordTurn(), true);
});
