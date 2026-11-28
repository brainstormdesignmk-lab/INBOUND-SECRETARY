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
import { trainLocalModel, predictLocal, validateModel, emptyModel, TrainRow } from '../src/llm/localModel';
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
  assert.deepEqual(model.classes, ['STAY']);
  assert.equal(model.weights[0]?.length, FEATURE_DIM);
});

// ── Validation ──────────────────────────────────────────────────────────────

test('a mis-shaped or non-finite weight file is rejected loudly', () => {
  const bad = { version: 1, dim: 8, classes: ['STAY'], weights: [[1, 2, 3]] };
  assert.throws(() => validateModel(bad), /weight row/);
  const nan = emptyModel(['STAY']);
  nan.weights[0]![5] = Number.NaN;
  assert.throws(() => validateModel(nan), /non-finite/);
  assert.throws(() => validateModel({ version: 2 }), /version/);
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
