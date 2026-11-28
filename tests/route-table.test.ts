// PHASE 2/3 — THE ROUTE TABLE (docs/classifier-build-runbook.md).
//
// The contract worth more than any accuracy number: a learned route can never
// emit a COMMITMENT event. The rest pins the lifecycle — staged never serves,
// shadow only measures, a conflict freezes both rows, a correction retires.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/store/db';
import { RouteStore, COMMITMENT_EVENTS, SAFE_EVENTS } from '../src/store/routes';
import { ClassifyTurnStore } from '../src/store/classifyTurns';
import { buildRouteSig, sigKey } from '../src/llm/routeSig';
import { findRoute, routeVerdict, noteShadowAgreement, parseRouteMode } from '../src/llm/routeServe';
import { freshSession } from '../src/fsm/session';
import { normalizedKey } from '../src/store/capture';
import { loadConfig } from '../src/config';
import { SessionStore } from '../src/fsm/session';
import { Responder } from '../src/llm/respond';
import { PropertyService, Property } from '../src/data/properties';
import { AppointmentStore } from '../src/store/appointments';
import { EscalationStore } from '../src/store/escalations';
import { MetaStore } from '../src/store/meta';
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LandmarkService } from '../src/geo/landmarks';

const T = 1_700_000_000_000;

function identity(text: string, state = 'idle') {
  const session = freshSession('test', 'c');
  session.state = state as never;
  const sig = buildRouteSig(session, text);
  return { norm: normalizedKey(text), state, sig: JSON.stringify(sig), sigKey: sigKey(sig) };
}

// ── The commitment ban ──────────────────────────────────────────────────────

test('every commitment event is refused by the store, in every lifecycle', () => {
  const db = new Db(':memory:');
  const store = new RouteStore(db);
  for (const event of COMMITMENT_EVENTS) {
    const res = store.upsertFromCorpus({ ...identity('DOGOVORI MI'), event });
    assert.equal(res.action, 'refused', `${event} must never be learned`);
    assert.match((res as { reason: string }).reason, /commitment/);
  }
  assert.equal(store.stats().total, 0);
});

test('a payload-dependent event is refused (the table stores no EB)', () => {
  const db = new Db(':memory:');
  const store = new RouteStore(db);
  const res = store.upsertFromCorpus({ ...identity('DAJ MI 78'), event: 'PROPERTY_ID_REQUESTED' });
  assert.equal(res.action, 'refused');
});

test('the servable set and the commitment set are disjoint', () => {
  for (const e of SAFE_EVENTS) assert.equal(COMMITMENT_EVENTS.has(e), false);
});

// ── Lifecycle ───────────────────────────────────────────────────────────────

test('a new row is staged and cannot serve', () => {
  const db = new Db(':memory:');
  const store = new RouteStore(db);
  const id = identity('QWE RTY');
  const res = store.upsertFromCorpus({ ...id, event: 'DETAILS_PROVIDED' });
  assert.equal(res.action, 'inserted');
  const row = store.findExact(id.norm, id.state, id.sigKey);
  assert.equal(row?.lifecycle, 'staged');
  const cand = { route: row!, norm: id.norm, sigKey: id.sigKey };
  assert.equal(routeVerdict(cand, 'serve'), undefined, 'staged must abstain');
  assert.equal(routeVerdict(cand, 'shadow'), undefined, 'shadow must not serve');
});

test('an active row serves only the exact identity in serve mode', () => {
  const db = new Db(':memory:');
  const store = new RouteStore(db);
  const id = identity('QWE RTY');
  store.upsertFromCorpus({ ...id, event: 'DETAILS_PROVIDED' });
  activate(store, id);
  const row = store.findExact(id.norm, id.state, id.sigKey)!;
  assert.equal(row.lifecycle, 'active');
  const verdict = routeVerdict({ route: row, norm: id.norm, sigKey: id.sigKey }, 'serve');
  assert.equal(verdict?.event.type, 'DETAILS_PROVIDED');
  assert.equal(verdict?.tier, 'route');
  // A different signature is a different route: the same words with a flat on
  // the table must not reuse this row.
  const session = freshSession('test', 'c');
  session.slots.propertyId = 79;
  const other = buildRouteSig(session, 'QWE RTY');
  assert.equal(store.findExact(id.norm, id.state, sigKey(other)), null);
});

test('promotion needs shadow agreements and no shadow miss', () => {
  const db = new Db(':memory:');
  const store = new RouteStore(db);
  const id = identity('QWE RTY');
  store.upsertFromCorpus({ ...id, event: 'DETAILS_PROVIDED' });
  assert.equal(store.promoteEligible(), 0, 'no evidence, no promotion');
  const row = store.findExact(id.norm, id.state, id.sigKey)!;
  for (let i = 0; i < RouteStore.PROMOTE_AFTER; i++) store.recordShadow(row.id, true);
  assert.equal(store.promoteEligible(), 1);
  // A miss in the shadow record proves it is not stable: a retired-then-reshadowed
  // row may not be promoted on a stale count.
  const second = identity('ASDF ZXCV');
  store.upsertFromCorpus({ ...second, event: 'STAY' });
  const r2 = store.findExact(second.norm, second.state, second.sigKey)!;
  for (let i = 0; i < RouteStore.PROMOTE_AFTER; i++) store.recordShadow(r2.id, true);
  store.recordShadow(r2.id, false);
  assert.equal(store.promoteEligible(), 0);
});

test('a conflicting rule freezes BOTH rows and files one correction', () => {
  const db = new Db(':memory:');
  const store = new RouteStore(db);
  const id = identity('DOGOVORI MI');
  store.upsertFromCorpus({ ...id, event: 'INTERESTED' });
  const res = store.upsertFromCorpus({ ...id, event: 'STAY' });
  assert.equal(res.action, 'conflict');
  const rows = store.list('frozen');
  assert.equal(rows.length, 2);
  assert.equal(store.corrections().length, 1);
  assert.equal(store.corrections()[0]?.reason, 'conflicting rules for one identity');
});

test('a correction retires the row and is kept as evidence', () => {
  const db = new Db(':memory:');
  const store = new RouteStore(db);
  const id = identity('QWE RTY');
  store.upsertFromCorpus({ ...id, event: 'DETAILS_PROVIDED' });
  activate(store, id);
  const row = store.findExact(id.norm, id.state, id.sigKey)!;
  assert.equal(store.retireByCorrection(row.id, 'client meant a visit', 'INTERESTED'), true);
  assert.equal(store.findExact(id.norm, id.state, id.sigKey)?.lifecycle, 'retired');
  const c = store.corrections()[0]!;
  assert.equal(c.servedEvent, 'DETAILS_PROVIDED');
  assert.equal(c.expected, 'INTERESTED');
});

test('shadow agreement is recorded without touching the route lifecycle', () => {
  const db = new Db(':memory:');
  const store = new RouteStore(db);
  const id = identity('QWE RTY');
  store.upsertFromCorpus({ ...id, event: 'DETAILS_PROVIDED' });
  const row = store.findExact(id.norm, id.state, id.sigKey)!;
  noteShadowAgreement(store, { route: row, norm: id.norm, sigKey: id.sigKey }, 'STAY');
  assert.equal(store.byId(row.id)?.lifecycle, 'staged');
  assert.equal(store.byId(row.id)?.shadowMisses, 1);
});

test('modes parse conservatively — anything unknown is off', () => {
  assert.equal(parseRouteMode('serve'), 'serve');
  assert.equal(parseRouteMode('shadow'), 'shadow');
  assert.equal(parseRouteMode('off'), 'off');
  assert.equal(parseRouteMode(undefined), 'off');
  assert.equal(parseRouteMode('servee'), 'off');
});

// ── The seam ────────────────────────────────────────────────────────────────

const ROWS: Property[] = [{ eb: 79, id: 79, location: 'Водно', address: 'Водно', price: 300, service: 'rent', bedrooms: 2, sig: 35, size: '35 м²' } as unknown as Property];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

function makeHandler(routes: RouteStore, mode: 'off' | 'shadow' | 'serve', onClassify: () => void) {
  const cfg = loadConfig({ routesMode: mode });
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS);
  const channels = new ChannelRegistry();
  channels.register({ name: 'test', send: async () => { /* sink */ } });
  const classifyTurns = new ClassifyTurnStore(db);
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: {
      deterministicClassify: async () => undefined,
      classify: async () => { onClassify(); return { event: { type: 'STAY' }, offensive: false, offenseLevel: 0, tier: 'remote' }; },
    } as never,
    responder: new Responder({ complete: async () => 'ok' } as never, cfg),
    properties,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false }),
    classifyTurns, routes,
  });
  return { handler, classifyTurns, routes };
}

test('serve mode answers from an active row without calling the classifier', async () => {
  const db = new Db(':memory:');
  const store = new RouteStore(db);
  const id = identity('QWE RTY');
  store.upsertFromCorpus({ ...id, event: 'DETAILS_PROVIDED' });
  activate(store, id);
  let calls = 0;
  const { handler, classifyTurns } = makeHandler(store, 'serve', () => { calls++; });
  await handler.handle('test', 'route-serve', 'QWE RTY');
  assert.equal(calls, 0, 'the remote classifier must not run for a served route');
  assert.equal(classifyTurns.forChat('route-serve')[0]?.tier, 'route');
  assert.ok(store.stats().hits >= 1);
});

test('shadow mode still asks the classifier and records agreement', async () => {
  const db = new Db(':memory:');
  const store = new RouteStore(db);
  const id = identity('QWE RTY');
  store.upsertFromCorpus({ ...id, event: 'DETAILS_PROVIDED' });
  let calls = 0;
  const { handler, classifyTurns } = makeHandler(store, 'shadow', () => { calls++; });
  await handler.handle('test', 'route-shadow', 'QWE RTY');
  assert.equal(calls, 1, 'shadow must not change the client turn');
  assert.equal(classifyTurns.forChat('route-shadow')[0]?.tier, 'remote');
  const row = store.findExact(id.norm, id.state, id.sigKey)!;
  assert.equal(row.shadowMisses, 1, 'the remote said STAY, the route said DETAILS_PROVIDED');
});

test('off mode ignores the table entirely', async () => {
  const db = new Db(':memory:');
  const store = new RouteStore(db);
  const id = identity('QWE RTY');
  store.upsertFromCorpus({ ...id, event: 'DETAILS_PROVIDED' });
  activate(store, id);
  let calls = 0;
  const { handler } = makeHandler(store, 'off', () => { calls++; });
  await handler.handle('test', 'route-off', 'QWE RTY');
  assert.equal(calls, 1);
  // The turn must leave the shadow record EXACTLY as activate() left it: off
  // mode neither serves nor measures.
  const row = store.findExact(id.norm, id.state, id.sigKey)!;
  assert.equal(row.shadowHits, RouteStore.PROMOTE_AFTER);
  assert.equal(row.shadowMisses, 0);
});

/** Test-only shortcut: promotion is evidence-driven in production, so the
 *  tests that need an ACTIVE row reach it through store.recordShadow +
 *  promoteEligible — the real path — rather than writing the column directly. */
function activate(store: RouteStore, id: ReturnType<typeof identity>): void {
  const row = store.findExact(id.norm, id.state, id.sigKey)!;
  for (let i = 0; i < RouteStore.PROMOTE_AFTER; i++) store.recordShadow(row.id, true);
  store.promoteEligible();
}
