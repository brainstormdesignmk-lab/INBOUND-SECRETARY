// PHASE 4 — THE LOCAL MODEL (docs/classifier-build-runbook.md).
//
// What must hold before this tier is allowed to serve:
//   • the extractor is deterministic and the signature moves the vector;
//   • training is reproducible on a fixed corpus;
//   • a mis-shaped weight file is REJECTED, not silently used;
//   • below the floor the tier ABSTAINS (the whole point);
//   • the commitment ban applies here too;
//   • the seam serves from `serve` mode and never calls the remote classifier.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { textFeatureIndices, sigFeatureIndices, featureIndices, FEATURE_DIM, hash32 } from '../src/llm/localFeatures';
import {
  trainLocalModel, predictLocal, validateModel, emptyModel, TrainRow,
  fitTemperature, withTemperature, evaluateLocal, majorityBaseline, routeCost, UNKNOWN,
} from '../src/llm/localModel';
import {
  localVerdict, localDecision, loadLocalModel, clearLocalModelCache, parseLocalMode,
} from '../src/llm/localClassify';
import { buildRouteSig } from '../src/llm/routeSig';
import { freshSession, SessionStore } from '../src/fsm/session';
import { normalizedKey } from '../src/store/capture';
import { Db } from '../src/store/db';
import { loadConfig } from '../src/config';
import { ClassifyTurnStore } from '../src/store/classifyTurns';
import { Responder } from '../src/llm/respond';
import { PropertyService, Property } from '../src/data/properties';
import { AppointmentStore } from '../src/store/appointments';
import { EscalationStore } from '../src/store/escalations';
import { MetaStore } from '../src/store/meta';
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LandmarkService } from '../src/geo/landmarks';

const sigOf = (text: string) => buildRouteSig(freshSession('test', 'c'), text);

// ── Features ────────────────────────────────────────────────────────────────

test('the extractor is deterministic and bounded', () => {
  const a = textFeatureIndices('dvosoben stan vo centar');
  const b = textFeatureIndices('dvosoben stan vo centar');
  assert.deepEqual(a, b);
  assert.ok(a.every(i => i >= 0 && i < FEATURE_DIM));
  assert.equal(hash32('abc'), hash32('abc'));
  assert.notEqual(hash32('abc'), hash32('abd'));
});

test('the signature moves the vector (the calibration finding)', () => {
  const quiet = sigFeatureIndices(sigOf('DOGOVORI MI'));
  const session = freshSession('test', 'c');
  session.slots.feeRejections = 1;
  const rung = sigFeatureIndices(buildRouteSig(session, 'DOGOVORI MI'));
  assert.notDeepEqual(quiet, rung);
  assert.ok(quiet.every(i => i >= 0 && i < FEATURE_DIM));
});

// ── Training/prediction ─────────────────────────────────────────────────────

function synthetic(): TrainRow[] {
  const rows: TrainRow[] = [];
  for (let i = 0; i < 40; i++) {
    rows.push({ norm: 'qwerty', sig: sigOf('QWE RTY'), event: 'DETAILS_PROVIDED' });
    rows.push({ norm: 'zxcvbn', sig: sigOf('ZXCVBN'), event: 'STAY' });
  }
  return rows;
}

test('a separable corpus trains and predicts correctly', () => {
  const model = trainLocalModel(synthetic(), { epochs: 20, classes: ['DETAILS_PROVIDED', 'STAY'] });
  const a = predictLocal(model, 'qwerty', sigOf('QWE RTY'));
  const b = predictLocal(model, 'zxcvbn', sigOf('ZXCVBN'));
  assert.equal(a.event, 'DETAILS_PROVIDED');
  assert.equal(b.event, 'STAY');
  assert.ok(a.confidence > 0.9);
});

test('training is reproducible on the same rows', () => {
  const m1 = trainLocalModel(synthetic(), { epochs: 5, classes: ['DETAILS_PROVIDED', 'STAY'] });
  const m2 = trainLocalModel(synthetic(), { epochs: 5, classes: ['DETAILS_PROVIDED', 'STAY'] });
  assert.deepEqual(m1.weights, m2.weights);
});

test('an empty corpus produces an empty, valid model', () => {
  const model = trainLocalModel([]);
  // With nothing learned the only honest class is the abstain class: a default
  // of STAY would make an untrained model vote "do nothing" with confidence.
  assert.deepEqual(model.classes, [UNKNOWN]);
  assert.equal(model.weights[0]?.length, FEATURE_DIM);
  assert.equal(model.temperature, 1);
});

// ── Validation ──────────────────────────────────────────────────────────────

test('a mis-shaped or non-finite weight file is rejected loudly', () => {
  const bad = { version: 2, featureVersion: 2, dim: 8, classes: ['STAY'], weights: [[1, 2, 3]], temperature: 1 };
  assert.throws(() => validateModel(bad), /weight row/);
  const nan = emptyModel(['STAY']);
  nan.weights[0]![5] = Number.NaN;
  assert.throws(() => validateModel(nan), /non-finite/);
  // A v1 file must be refused with the retrain instruction, not reinterpreted
  // under the v2 layout (the bucket ranges moved — silent use would be a
  // random router that looks healthy).
  assert.throws(() => validateModel({ version: 1 }), /unsupported version/);
  assert.throws(() => validateModel({ ...emptyModel(['STAY']), featureVersion: 1 }), /feature layout/);
  assert.throws(() => validateModel({ ...emptyModel(['STAY']), temperature: 0 }), /temperature/);
});

test('the v2 layout reserves disjoint ranges for 3-, 4- and 5-grams', () => {
  const idx = textFeatureIndices('dvosoben stan vo centar');
  assert.ok(idx.some(i => i >= 0 && i < 1024), '3-gram bucket');
  assert.ok(idx.some(i => i >= 1024 && i < 1536), '4-gram bucket');
  assert.ok(idx.some(i => i >= 1536 && i < 1792), '5-gram bucket');
  const flags = sigFeatureIndices(sigOf('NE SAKAM'));
  assert.ok(flags.every(i => i >= 1792 && i < FEATURE_DIM));
});

// ── Abstain ─────────────────────────────────────────────────────────────────

test('below the floor the tier abstains instead of guessing', () => {
  const model = emptyModel(['DETAILS_PROVIDED', 'STAY']); // uniform → 0.5 each
  const session = freshSession('test', 'c');
  assert.equal(localVerdict(model, 0.72, session, 'QWE RTY'), undefined);
  const served = localVerdict(model, 0.4, session, 'QWE RTY');
  assert.ok(served, 'above the floor it may answer');
  assert.equal(served?.tier, 'local');
});

test('the commitment ban applies to the local tier too', () => {
  const model = emptyModel(['FEE_AGREED']);
  const session = freshSession('test', 'c');
  const decision = localDecision(model, session, 'DOGOVORI MI');
  assert.equal(decision, undefined, 'a learned consent is never a routing convenience');
});

test('an absent model file disables the tier without throwing', () => {
  assert.equal(loadLocalModel(path.join(tmpdir(), 'definitely-not-a-model.json')), undefined);
  assert.equal(localVerdict(undefined, 0.7, freshSession('test', 'c'), 'X'), undefined);
});

test('a model file is loaded, cached and reloaded when it changes', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lina-model-'));
  const file = path.join(dir, 'm.json');
  const model = trainLocalModel(synthetic(), { epochs: 5, classes: ['DETAILS_PROVIDED', 'STAY'] });
  writeFileSync(file, JSON.stringify(model));
  clearLocalModelCache();
  const first = loadLocalModel(file);
  assert.ok(first);
  assert.equal(loadLocalModel(file), first, 'cached while unchanged');
  writeFileSync(file, JSON.stringify({ ...model, trainedRows: 2 }));
  const second = loadLocalModel(file);
  assert.ok(second);
  assert.equal(second?.trainedRows, 2, 'a rewritten file is re-read');
});

test('modes parse conservatively', () => {
  assert.equal(parseLocalMode('serve'), 'serve');
  assert.equal(parseLocalMode('shadow'), 'shadow');
  assert.equal(parseLocalMode('nonsense'), 'off');
  assert.equal(parseLocalMode(undefined), 'off');
});

// ── Calibration: temperature ────────────────────────────────────────────────

test('temperature scaling tames an overconfident model', () => {
  const rows = synthetic();
  const model = trainLocalModel(rows, { epochs: 20, classes: ['DETAILS_PROVIDED', 'STAY'] });
  // A calibration slice with realistic label noise (10 %): a PERFECT slice
  // carries no calibration signal — NLL would just sharpen the model, which
  // the fitter now refuses to do.
  const noisy: TrainRow[] = rows.map((r, i) => ({
    ...r,
    event: i % 10 === 0 ? (r.event === 'STAY' ? 'DETAILS_PROVIDED' : 'STAY') : r.event,
  }));
  // Blow the weights up to simulate the post-training overconfidence that a
  // long run (or a future optimizer change) produces.
  const hot = withTemperature({ ...model, weights: model.weights.map(w => w.map(v => v * 8)) }, 1);
  const hotBefore = predictLocal(hot, 'qwerty', sigOf('QWE RTY')).confidence;
  const t = fitTemperature(hot, noisy);
  assert.ok(t > 1, `expected T > 1 for overconfidence on a noisy slice, got ${t}`);
  const cooled = withTemperature(hot, t);
  assert.ok(predictLocal(cooled, 'qwerty', sigOf('QWE RTY')).confidence <= hotBefore);
});

test('temperature never sharpens, even when NLL would prefer it', () => {
  const rows = synthetic(); // perfectly separable: NLL prefers T < 1
  const model = trainLocalModel(rows, { epochs: 20, classes: ['DETAILS_PROVIDED', 'STAY'] });
  assert.equal(fitTemperature(model, rows), 1);
});

test('fitTemperature never uses the empty slice as a free pass', () => {
  const model = trainLocalModel(synthetic(), { epochs: 3, classes: ['DETAILS_PROVIDED', 'STAY'] });
  assert.equal(fitTemperature(model, []), 1);
});

// ── The trained UNKNOWN class ───────────────────────────────────────────────

test('UNKNOWN is learned from the turns that failed to land', () => {
  const rows: TrainRow[] = [
    ...synthetic(),
  ];
  for (let i = 0; i < 20; i++) {
    rows.push({ norm: 'qqqzzz', sig: sigOf('QQQ ZZZ'), event: UNKNOWN });
  }
  const model = trainLocalModel(rows, { epochs: 20, classes: ['DETAILS_PROVIDED', 'STAY', UNKNOWN] });
  const pred = predictLocal(model, 'qqqzzz', sigOf('QQQ ZZZ'));
  assert.equal(pred.event, UNKNOWN, 'the reject class must be reachable');
});

test('an UNKNOWN verdict abstains even at floor 0', () => {
  const model = emptyModel([UNKNOWN, 'STAY']);
  const session = freshSession('test', 'c');
  assert.equal(localDecision(model, session, 'QWE RTY'), undefined);
  assert.equal(localVerdict(model, 0, session, 'QWE RTY'), undefined);
});

test('class weighting keeps a rare event learnable', () => {
  const rows: TrainRow[] = [];
  for (let i = 0; i < 100; i++) rows.push({ norm: 'stanaaaa', sig: sigOf('STAN'), event: 'STAY' });
  for (let i = 0; i < 4; i++) rows.push({ norm: 'garsonjeraaaa', sig: sigOf('GARSONJERA'), event: 'DETAILS_PROVIDED' });
  const model = trainLocalModel(rows, { epochs: 30, classes: ['DETAILS_PROVIDED', 'STAY'] });
  assert.equal(predictLocal(model, 'garsonjeraaaa', sigOf('GARSONJERA')).event, 'DETAILS_PROVIDED');
});

// ── Cost-weighted evaluation ────────────────────────────────────────────────

test('a wrong commitment costs 100x a wrong question', () => {
  assert.equal(routeCost('FEE_AGREED', 'STAY'), 100);
  assert.equal(routeCost('STAY', 'FEE_AGREED'), 100);
  assert.equal(routeCost('STAY', 'DETAILS_PROVIDED'), 1);
  assert.equal(routeCost('STAY', 'STAY'), 0);
});

test('evaluateLocal counts UNKNOWN as abstain, not as a served error', () => {
  // A zero-weight model over [UNKNOWN, STAY] argmaxes to UNKNOWN (index 0),
  // which must be counted as an abstain at any floor — not as a served STAY.
  const model = emptyModel([UNKNOWN, 'STAY']);
  const res = evaluateLocal(model, [
    { norm: 'aaaa', sig: sigOf('AAAA'), event: 'STAY' },
  ], 0);
  assert.equal(res.served, 0);
  assert.equal(res.coverage, 0);
  assert.equal(res.unknownServed, 1);
  assert.equal(res.cost, 0);
});

test('the majority baseline is what a model must beat', () => {
  const rows = [
    { norm: 'a', sig: sigOf('A'), event: 'STAY' },
    { norm: 'b', sig: sigOf('B'), event: 'STAY' },
    { norm: 'c', sig: sigOf('C'), event: 'STAY' },
    { norm: 'd', sig: sigOf('D'), event: 'INTERESTED' },
  ];
  const base = majorityBaseline(rows);
  assert.equal(base.event, 'STAY');
  assert.equal(base.accuracy, 0.75);
  assert.equal(base.costPerRow, 0.25);
});

// ── The seam ────────────────────────────────────────────────────────────────

const ROWS = [{ eb: 79, id: 79, location: 'Водно', address: 'Водно', price: 300, service: 'rent', bedrooms: 2, sqm: 35, size: '35 м²' }] as unknown as Property[];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

test('serve mode answers from the local model without calling the classifier', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lina-model-'));
  const file = path.join(dir, 'm.json');
  const sig = sigOf('QWE RTY');
  writeFileSync(file, JSON.stringify(trainLocalModel(
    [{ norm: 'qwerty', sig, event: 'DETAILS_PROVIDED' }],
    { epochs: 30, classes: ['DETAILS_PROVIDED', 'STAY'] },
  )));
  clearLocalModelCache();

  const cfg = loadConfig({ localMode: 'serve', localModelPath: file, localConfidenceFloor: 0.1 });
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  channels.register({ name: 'test', send: async () => { /* sink */ } });
  const classifyTurns = new ClassifyTurnStore(db);
  let calls = 0;
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: {
      deterministicClassify: async () => undefined,
      classify: async () => { calls++; return { event: { type: 'STAY' }, offensive: false, offenseLevel: 0, tier: 'remote' }; },
    } as never,
    responder: new Responder({ complete: async () => 'ok' } as never, cfg),
    properties: new FakeProps(ROWS),
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false }),
    classifyTurns,
  });
  await handler.handle('test', 'local-serve', 'QWE RTY');
  assert.equal(calls, 0, 'the remote tier must not run');
  assert.equal(classifyTurns.forChat('local-serve')[0]?.tier, 'local');
});

test('LINA_LOCAL=off is a real kill switch (the remote tier runs)', async () => {
  const cfg = loadConfig({ localMode: 'off', localModelPath: path.join(tmpdir(), 'absent.json') });
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  channels.register({ name: 'test', send: async () => { /* sink */ } });
  const classifyTurns = new ClassifyTurnStore(db);
  let calls = 0;
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: {
      deterministicClassify: async () => undefined,
      classify: async () => { calls++; return { event: { type: 'STAY' }, offensive: false, offenseLevel: 0, tier: 'remote' }; },
    } as never,
    responder: new Responder({ complete: async () => 'ok' } as never, cfg),
    properties: new FakeProps(ROWS),
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false }),
    classifyTurns,
  });
  await handler.handle('test', 'local-off', 'QWE RTY');
  assert.equal(calls, 1, 'off must restore today\'s behaviour exactly');
  assert.equal(classifyTurns.forChat('local-off')[0]?.tier, 'remote');
});
