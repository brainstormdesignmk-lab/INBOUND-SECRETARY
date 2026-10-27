// ROUTE DRIFT PERSISTENCE (R3) — the drift line must survive the process.
// Before this module, `[route-drift]` was console-only inside a 500-entry
// in-memory ring: every production misroute had to be re-derived from a
// transcribed capture. Now each pair lands in a day-rotated JSONL and
// `route:health --emit-corpus` turns them into corpus suggestions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import {
  DriftPair, flushRouteDrift, readRouteDrift, recordRouteDrift, routeDriftDir, setRouteDriftDir,
} from '../src/store/routeDrift';
import { emitCorpusRows } from '../src/scripts/routeHealth';
import { routeLog } from '../src/handlers/router';

async function freshDir(tag: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), `route-drift-${tag}-`));
  setRouteDriftDir(dir);
  return dir;
}

function pair(overrides: Partial<DriftPair> = {}): DriftPair {
  return {
    at: Date.now(),
    chatId: 'c1',
    text: 'MISLAM DEKA NAJDOBAR BI BIL 57',
    predicted: 'NEGOTIATE',
    actual: 'PROPERTY_SERVE',
    ...overrides,
  };
}

test('a drift pair survives the "process": reader sees exactly what was written', async () => {
  const dir = await freshDir('readback');
  recordRouteDrift(pair());
  await flushRouteDrift();
  const rows = await readRouteDrift();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].predicted, 'NEGOTIATE');
  assert.equal(rows[0].actual, 'PROPERTY_SERVE');
  assert.equal(rows[0].text, 'MISLAM DEKA NAJDOBAR BI BIL 57');
  await fs.rm(dir, { recursive: true, force: true });
});

test('the hourly dedupe keeps one row per identical tuple', async () => {
  const dir = await freshDir('dedupe');
  recordRouteDrift(pair());
  recordRouteDrift(pair());
  recordRouteDrift(pair());
  await flushRouteDrift();
  assert.equal((await readRouteDrift()).length, 1);
  // A different actual intent is a different tuple — it must land.
  recordRouteDrift(pair({ actual: 'FEE_NAG' }));
  await flushRouteDrift();
  assert.equal((await readRouteDrift()).length, 2);
  await fs.rm(dir, { recursive: true, force: true });
});

test('rotation: the pair is stored under the file of ITS day, not today when at is old', async () => {
  const dir = await freshDir('rotation');
  const twoDaysAgo = Date.now() - 2 * 86_400_000;
  recordRouteDrift(pair({ at: twoDaysAgo }));
  await flushRouteDrift();
  const files = (await fs.readdir(dir)).filter(n => n.startsWith('route-drift-'));
  const expectedDay = new Date(twoDaysAgo).toISOString().slice(0, 10);
  assert.deepEqual(files, [`route-drift-${expectedDay}.jsonl`]);
  // --days filtering removes it.
  assert.equal((await readRouteDrift({ days: 1 })).length, 0);
  assert.equal((await readRouteDrift({ days: 7 })).length, 1);
  await fs.rm(dir, { recursive: true, force: true });
});

test('the router hook persists what it prints: predict ≠ actual lands in the JSONL', async () => {
  const dir = await freshDir('router');
  routeLog('hook-chat', 'predlozi mi drugi lokacii', 'NEARBY_ASK', 'predict');
  routeLog('hook-chat', 'predlozi mi drugi lokacii', 'NOT_FOUND_REPEAT', 'actual');
  await flushRouteDrift();
  const rows = (await readRouteDrift()).filter(r => r.chatId === 'hook-chat');
  assert.equal(rows.length, 1, 'predict+actual within the window = one drift row');
  assert.equal(rows[0].predicted, 'NEARBY_ASK');
  assert.equal(rows[0].actual, 'NOT_FOUND_REPEAT');
  await fs.rm(dir, { recursive: true, force: true });
});

test('emitCorpusRows: TS-ready suggestions, deduped by phrase, newest first, drift metadata kept', () => {
  const day = Date.parse('2026-10-23T10:00:00Z');
  const rows = emitCorpusRows([
    pair({ at: day, text: 'predlozi mi', predicted: 'NOT_FOUND_REPEAT', actual: 'PRESENTATION_SERVE' }),
    pair({ at: day + 1, text: 'predlozi mi', predicted: 'NEARBY_ASK', actual: 'PRESENTATION_SERVE' }), // same phrase, later
    pair({ at: day, text: 'ZA SEKOJ STAN PO 300DEN', predicted: 'PROPERTY_SERVE', actual: 'FEE_NAG' }),
    pair({ at: day, text: '   ' }), // blank never becomes a row
  ]);
  assert.equal(rows.length, 2, JSON.stringify(rows));
  const predlozi = rows[0];
  assert.match(predlozi, /userMsg: 'predlozi mi'/);
  assert.match(predlozi, /predicted=NEARBY_ASK actual=PRESENTATION_SERVE/, 'newest duplicate wins');
  const stan = rows[1];
  assert.match(stan, /userMsg: 'ZA SEKOJ STAN PO 300DEN'/);
  assert.match(stan, /2026-10-23/);
  // Malicious quote in a phrase cannot break out of the single-quoted literal.
  const injected = emitCorpusRows([pair({ text: "it's a trap" })]);
  assert.equal(injected.length, 1);
  assert.match(injected[0], /^\s*\{ userMsg: 'it\\'s a trap',/);
});

test('persistence is loss-allowed: an unreadable dir never throws', async () => {
  await freshDir('lossy');
  // Force a state where the dir path is a FILE — mkdir/append must not throw.
  const fileAsDir = path.join(tmpdir(), `route-drift-notadir-${Date.now()}`);
  await fs.writeFile(fileAsDir, 'x');
  setRouteDriftDir(path.join(fileAsDir, 'sub'));
  assert.doesNotThrow(() => recordRouteDrift(pair()));
  assert.equal(routeDriftDir(), path.join(fileAsDir, 'sub'));
  setRouteDriftDir(tmpdir());
  await fs.rm(fileAsDir, { recursive: true, force: true });
});
