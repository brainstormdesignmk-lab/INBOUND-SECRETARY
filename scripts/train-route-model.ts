#!/usr/bin/env npx tsx
// train-route-model — fit the local route model from the Phase-1 corpus.
//
//   npm run route:corpus -- --emit data/route-corpus.jsonl
//   npm run route:train -- --corpus data/route-corpus.jsonl --out data/route-model.json
//
// Evaluation is deliberately HARD:
//   • the last 20 % by TIME is the test set (a random split leaks tomorrow's
//     phrasing into yesterday's training);
//   • a by-state holdout can be named (--hold-state closing): the model must
//     generalize to a state it never saw, or the accuracy was state lookup.
//
// The gate (runbook Phase 4): ≥ 95 % overall, ≥ 99 % on safe events, and a
// confidence floor that keeps coverage honest. The script prints the curve; it
// refuses to call a model shippable on its own.

import { readFileSync, writeFileSync } from 'fs';
import { RouteSig, parseRouteSig } from '../src/llm/routeSig';
import { trainLocalModel, predictLocal, LocalModel } from '../src/llm/localModel';
import { SAFE_EVENTS } from '../src/store/routes';

interface CorpusRow { norm: string; state: string; sig: string; sigKey: string; event: string; createdAt: number }

const args = process.argv.slice(2);
const argOf = (name: string, fallback?: string): string | undefined => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : fallback;
};
const corpusPath = argOf('--corpus', 'data/route-corpus.jsonl')!;
const outPath = argOf('--out', 'data/route-model.json')!;
const holdState = argOf('--hold-state');
const epochs = Number(argOf('--epochs', '20'));
const minConfidence = Number(argOf('--floor', '0.72'));

function readCorpus(path: string): Array<CorpusRow & { sigObj: RouteSig }> {
  const raw = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const out: Array<CorpusRow & { sigObj: RouteSig }> = [];
  for (const line of raw) {
    try {
      const row = JSON.parse(line) as CorpusRow;
      const sigObj = parseRouteSig(row.sig);
      if (!sigObj || !row.norm || !row.event) continue;
      out.push({ ...row, sigObj });
    } catch { /* torn line — skip */ }
  }
  return out;
}

const rows = readCorpus(corpusPath);
if (rows.length < 30) {
  console.error(`[route:train] corpus too small (${rows.length} rows) — link and seed first`);
  process.exit(2);
}

// TEMPORAL SPLIT: the last 20 % of rows (corpus is emitted in created_at order).
const cut = Math.floor(rows.length * 0.8);
let train = rows.slice(0, cut);
let test = rows.slice(cut);
if (holdState) {
  train = rows.filter(r => r.state !== holdState);
  test = rows.filter(r => r.state === holdState);
  console.log(`[route:train] BY-STATE HOLDOUT state=${holdState}: train=${train.length} test=${test.length}`);
}

const classes = [...new Set(train.map(r => r.event))].sort();
const model: LocalModel = trainLocalModel(
  train.map(r => ({ norm: r.norm, sig: r.sigObj, event: r.event })),
  { epochs, classes },
);

interface Eval { at: number; coverage: number; accuracy: number; safeAccuracy: number }
function evaluate(floor: number): Eval {
  let served = 0, correct = 0, safeServed = 0, safeCorrect = 0;
  for (const row of test) {
    const pred = predictLocal(model, row.norm, row.sigObj);
    if (pred.confidence < floor) continue;
    if (!SAFE_EVENTS.has(pred.event)) continue;
    served++;
    if (pred.event === row.event) correct++;
    if (SAFE_EVENTS.has(row.event)) {
      safeServed++;
      if (pred.event === row.event) safeCorrect++;
    }
  }
  return {
    at: floor,
    coverage: test.length ? served / test.length : 0,
    accuracy: served ? correct / served : 0,
    safeAccuracy: safeServed ? safeCorrect / safeServed : 0,
  };
}

const curve = [0.5, 0.6, 0.7, 0.72, 0.8, 0.9].map(evaluate);
console.log(`[route:train] rows=${rows.length} train=${train.length} test=${test.length} classes=${classes.length}`);
for (const e of curve) {
  console.log(`  floor=${e.at.toFixed(2)} coverage=${(e.coverage * 100).toFixed(1)}% accuracy=${(e.accuracy * 100).toFixed(1)}% safe=${(e.safeAccuracy * 100).toFixed(1)}%`);
}
const chosen = evaluate(minConfidence);
const ok = chosen.accuracy >= 0.95 && (chosen.safeAccuracy >= 0.99 || chosen.coverage === 0);
console.log(`[route:train] chosen floor=${minConfidence}: ${ok ? 'PASSES the gate' : 'FAILS the gate — do not serve'}`);

writeFileSync(outPath, JSON.stringify({ ...model, trainedAt: Date.now(), trainedRows: train.length }, null, 0), 'utf8');
console.log(`[route:train] wrote ${outPath} (${(JSON.stringify(model).length / 1024).toFixed(0)} KB)`);
if (!ok) process.exitCode = 3;
