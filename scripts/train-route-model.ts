#!/usr/bin/env npx tsx
// train-route-model — fit and CALIBRATE the local route model (v2).
//
//   npm run route:corpus -- --with-negatives --emit data/route-corpus.jsonl
//   npm run route:train -- --corpus data/route-corpus.jsonl --out data/route-model.json
//
// What v2 adds over a plain classifier:
//   • a trained UNKNOWN class, learned from the turns that failed to land
//     (`--with-negatives` labels repeat/followup rows as UNKNOWN);
//   • a TEMPERATURE fitted on a held-out slice, so the confidence floor means
//     the same thing after every retrain;
//   • class weighting, so a rare event is not drowned by STAY;
//   • a COST-WEIGHTED gate: a wrong consent costs 100× a misread question.
//
// Evaluation is deliberately hard: the last 20 % by TIME is the test set (a
// random split leaks tomorrow's phrasing into yesterday's training), and
// `--hold-state` tests generalization to a state the model never saw.
//
// The gate: ≥ 95 % overall, ≥ 99 % on safe events, and a cost per served turn
// below the majority-class baseline at non-zero coverage. The script exits 3
// when the gate fails — a model that cannot beat "always guess STAY" is not a
// router.

import { readFileSync, writeFileSync } from 'fs';
import { RouteSig, parseRouteSig } from '../src/llm/routeSig';
import {
  trainLocalModel, predictLocal, fitTemperature, withTemperature,
  evaluateLocal, majorityBaseline, LocalModel, UNKNOWN,
} from '../src/llm/localModel';
import { COMMITMENT_EVENTS } from '../src/store/routes';

interface CorpusRow {
  norm: string; state: string; sig: string; sigKey: string;
  event: string; label?: string; outcome?: string; createdAt: number;
}

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

interface Row extends CorpusRow { sigObj: RouteSig; label: string }

function readCorpus(path: string): Row[] {
  const raw = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const out: Row[] = [];
  for (const line of raw) {
    try {
      const row = JSON.parse(line) as CorpusRow;
      const sigObj = parseRouteSig(row.sig);
      if (!sigObj || !row.norm) continue;
      // `label` is the training target (UNKNOWN for negatives); `event` is what
      // the tier actually decided and is kept for the audit, never trained on.
      const label = (row.label ?? row.event ?? '').trim();
      if (!label) continue;
      out.push({ ...row, sigObj, label });
    } catch { /* torn line — skip */ }
  }
  return out;
}

const rows = readCorpus(corpusPath);
if (rows.length < 30) {
  console.error(`[route:train] corpus too small (${rows.length} rows) — link and export first`);
  process.exit(2);
}

// TEMPORAL SPLIT: the corpus is emitted in created_at order.
const cut = Math.floor(rows.length * 0.8);
let train = rows.slice(0, cut);
let test = rows.slice(cut);
if (holdState) {
  train = rows.filter(r => r.state !== holdState);
  test = rows.filter(r => r.state === holdState);
  console.log(`[route:train] BY-STATE HOLDOUT state=${holdState}: train=${train.length} test=${test.length}`);
}

// The temperature is fitted on the LAST 10 % of TRAIN — never on the test set,
// or the calibration would be graded on the data it was fitted to.
const calCut = Math.max(1, Math.floor(train.length * 0.9));
const fitRows = train.slice(0, calCut);
const calRows = train.slice(calCut);

const classes = [...new Set(fitRows.map(r => r.label))].sort();
const model = trainLocalModel(
  fitRows.map(r => ({ norm: r.norm, sig: r.sigObj, event: r.label })),
  { epochs, classes },
);
const temperature = fitTemperature(model, calRows.map(r => ({ norm: r.norm, sig: r.sigObj, event: r.label })));
const calibrated = withTemperature(model, temperature);

const evalRows = test.map(r => ({ norm: r.norm, sig: r.sigObj, event: r.label }));
const result = evaluateLocal(calibrated, evalRows, minConfidence);
const majority = majorityBaseline(evalRows);

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
console.log(`[route:train] rows=${rows.length} train=${fitRows.length} cal=${calRows.length} test=${test.length} classes=${classes.length}`);
console.log(`[route:train] temperature=${temperature.toFixed(2)} (fitted on ${calRows.length} rows)`);
console.log(`  coverage=${pct(result.coverage)} accuracy=${pct(result.accuracy)} safe=${pct(result.safeAccuracy)} served=${result.served}`);
console.log(`  abstained: unknown=${result.unknownServed} below-floor=${result.total - result.served - result.unknownServed - 0}`);
console.log(`  cost: ${result.cost.toFixed(1)} total · ${result.costPerServed.toFixed(2)}/served`);
console.log(`  majority baseline: "${majority.event}" accuracy=${pct(majority.accuracy)} cost=${majority.costPerRow.toFixed(2)}/row`);
console.log(`  commitment events in test: ${evalRows.filter(r => COMMITMENT_EVENTS.has(r.event)).length}`);

const beatsMajority = result.served > 0 && result.costPerServed < majority.costPerRow;
const ok = result.served > 0
  && result.accuracy >= 0.95
  && (result.safeServed === 0 || result.safeAccuracy >= 0.99)
  && beatsMajority;
const reasons: string[] = [];
if (result.served === 0) reasons.push('coverage is zero');
if (result.accuracy < 0.95) reasons.push(`accuracy ${pct(result.accuracy)} < 95%`);
if (result.safeServed > 0 && result.safeAccuracy < 0.99) reasons.push(`safe accuracy ${pct(result.safeAccuracy)} < 99%`);
if (!beatsMajority) reasons.push(`cost/served ${result.costPerServed.toFixed(2)} is not below majority ${majority.costPerRow.toFixed(2)}`);
console.log(`[route:train] ${ok ? 'PASSES the gate' : `FAILS the gate — ${reasons.join('; ')}`}`);

writeFileSync(outPath, JSON.stringify({ ...calibrated, trainedAt: Date.now(), trainedRows: fitRows.length }), 'utf8');
console.log(`[route:train] wrote ${outPath} (${(JSON.stringify(calibrated).length / 1024).toFixed(0)} KB)`);
if (!ok) process.exitCode = 3;
