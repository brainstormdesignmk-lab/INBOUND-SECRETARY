// THE LOCAL MODEL (v2) — calibrated multinomial logistic regression, pure TS.
//
// Why not Tiny 2.1: that net is a character-level FACT RECALL model ("outside
// those it makes things up confidently"). A router needs a calibrated decision
// over a small event space with an explicit ABSTAIN, so the right tool is a
// linear model over hashed char n-grams + the context signature, trained on
// the Phase-1 corpus.
//
// v2 closes the two calibration gaps v1 shipped open:
//   • TEMPERATURE SCALING — fitted on a held-out slice after training, stored
//     in the weight file. Without it the confidence floor means something
//     different after every retrain (20 epochs are sharper than 5), so the
//     abstain rate drifts for no reason.
//   • UNKNOWN AS A REAL CLASS — trained from the turns that FAILED to land
//     (outcome `repeat` / `followup`) plus degenerate features. The model can
//     then learn "this phrasing is unlike anything I was trained on" instead
//     of relying on an argmax that is arbitrary when every logit is near zero.
//   • CLASS WEIGHTING — inverse frequency, capped, so a rare commitment-adjacent
//     event is not drowned by STAY.
//
// Still: JSON weights, no native deps, deterministic training, microsecond
// inference, and an abstain that is a first-class outcome rather than a bug.

import { FEATURE_DIM, FEATURE_VERSION, featureIndices } from './localFeatures';
import { RouteSig } from './routeSig';
import { COMMITMENT_EVENTS } from '../store/routes';

export const UNKNOWN = 'UNKNOWN';

export interface TrainRow {
  norm: string;
  sig: RouteSig;
  /** The label. `UNKNOWN` is a normal label here — it is what the negative
   *  rows (turns that did not land) teach. */
  event: string;
}

export interface LocalModel {
  version: 2;
  featureVersion: number;
  dim: number;
  classes: string[];
  weights: number[][];
  /** Softmax temperature fitted after training (1 = untempered). */
  temperature: number;
  trainedAt?: number;
  trainedRows?: number;
}

export function emptyModel(classes: string[], temperature = 1): LocalModel {
  return {
    version: 2,
    featureVersion: FEATURE_VERSION,
    dim: FEATURE_DIM,
    classes,
    weights: classes.map(() => new Array<number>(FEATURE_DIM).fill(0)),
    temperature,
  };
}

function logits(model: LocalModel, idx: number[]): number[] {
  const t = model.temperature > 0 ? model.temperature : 1;
  return model.weights.map(w => {
    let s = 0;
    for (const i of idx) s += w[i] ?? 0;
    return s / t;
  });
}

function softmax(z: number[]): number[] {
  const max = Math.max(...z);
  const ex = z.map(v => Math.exp(v - max));
  const sum = ex.reduce((a, b) => a + b, 0) || 1;
  return ex.map(v => v / sum);
}

export interface TrainOpts {
  epochs?: number;
  lr?: number;
  l2?: number;
  /** Fixed class order so two runs on the same corpus are byte-identical. */
  classes?: string[];
  /** Inverse-frequency weighting bounds (rare classes matter, but must not
   *  dominate either). */
  weightMin?: number;
  weightMax?: number;
}

/** Train from scratch. Rows are visited in the given order, so the result is
 *  reproducible (the CLI sorts by time). */
export function trainLocalModel(rows: TrainRow[], opts: TrainOpts = {}): LocalModel {
  const epochs = opts.epochs ?? 20;
  const lr = opts.lr ?? 0.35;
  const l2 = opts.l2 ?? 1e-5;
  const weightMin = opts.weightMin ?? 0.2;
  const weightMax = opts.weightMax ?? 6;
  const labels = opts.classes ?? [...new Set(rows.map(r => r.event))].sort();
  const classes = labels.length > 0 ? labels : [UNKNOWN];
  const model = emptyModel(classes);
  const index = new Map(classes.map((c, i) => [c, i]));
  const prepared = rows
    .filter(r => index.has(r.event))
    .map(r => ({ y: index.get(r.event)!, idx: featureIndices(r.norm, r.sig) }));

  // CLASS WEIGHTS: n / (classes × count). Capped both ways — a class seen twice
  // in 400 rows must be learnable, but must not outweigh the rest 200:1.
  const counts = new Map<number, number>();
  for (const r of prepared) counts.set(r.y, (counts.get(r.y) ?? 0) + 1);
  const classWeight = classes.map((_, c) => {
    const n = counts.get(c) ?? 0;
    if (n === 0) return 1;
    const raw = prepared.length / (classes.length * n);
    return Math.min(weightMax, Math.max(weightMin, raw));
  });

  let rate = lr;
  for (let epoch = 0; epoch < epochs; epoch++) {
    for (const row of prepared) {
      const p = softmax(logits({ ...model, temperature: 1 }, row.idx));
      const wgt = classWeight[row.y] ?? 1;
      for (let c = 0; c < classes.length; c++) {
        const err = p[c]! - (c === row.y ? 1 : 0);
        if (err === 0) continue;
        const w = model.weights[c]!;
        const step = rate * wgt * err;
        for (const f of row.idx) {
          w[f] = (w[f] ?? 0) - step - rate * l2 * (w[f] ?? 0);
        }
      }
    }
    rate = Math.max(0.02, rate * 0.92);
  }
  return model;
}

/** Fit softmax temperature on a held-out slice by minimising NLL. Called AFTER
 *  training; the weights never change, only the confidence scale.
 *
 *  THE FIT MAY ONLY SOFTEN (default floor T = 1). NLL on a slice the model
 *  classifies perfectly prefers SHARPENING (T < 1), which is arithmetically
 *  correct and operationally wrong: it raises confidence without adding
 *  evidence, and the confidence floor then lies about what the tier knows. A
 *  classifier that cannot earn a lower NLL by softening keeps T = 1. */
export function fitTemperature(
  model: LocalModel,
  rows: TrainRow[],
  range: { min?: number; max?: number; step?: number } = {},
): number {
  const min = range.min ?? 1;
  const max = range.max ?? 4;
  const step = range.step ?? 0.05;
  const index = new Map(model.classes.map((c, i) => [c, i]));
  const prepped = rows
    .filter(r => index.has(r.event))
    .map(r => ({ y: index.get(r.event)!, idx: featureIndices(r.norm, r.sig) }));
  if (prepped.length === 0) return 1;

  let best = 1;
  let bestNll = Number.POSITIVE_INFINITY;
  for (let t = min; t <= max + 1e-9; t += step) {
    const candidate: LocalModel = { ...model, temperature: t };
    let nll = 0;
    for (const row of prepped) {
      const p = softmax(logits(candidate, row.idx));
      nll -= Math.log(Math.max(1e-12, p[row.y] ?? 1e-12));
    }
    nll /= prepped.length;
    // Prefer the SIMPLEST temperature when the NLL is effectively tied: a
    // precisely-fitted T on a small slice is noise, not calibration.
    if (nll < bestNll - 1e-6) { bestNll = nll; best = Number(t.toFixed(2)); }
  }
  return best;
}

/** Assign the fitted temperature immutably (training returns a bare model). */
export function withTemperature(model: LocalModel, temperature: number): LocalModel {
  return { ...model, temperature };
}

export interface Prediction {
  event: string;
  confidence: number;
  /** Full distribution, for review tooling (never served as copy). */
  probs: Record<string, number>;
}

export function predictLocal(model: LocalModel, norm: string, sig: RouteSig): Prediction {
  const p = softmax(logits(model, featureIndices(norm, sig)));
  let best = 0;
  for (let i = 1; i < p.length; i++) if (p[i]! > p[best]!) best = i;
  const probs: Record<string, number> = {};
  model.classes.forEach((c, i) => { probs[c] = p[i]!; });
  return { event: model.classes[best]!, confidence: p[best] ?? 0, probs };
}

// ── Evaluation: cost-weighted, because a wrong consent is not a wrong label ──

export interface EvalRow {
  norm: string;
  sig: RouteSig;
  event: string;
}

export interface EvalResult {
  total: number;
  served: number;
  correct: number;
  coverage: number;
  accuracy: number;
  safeServed: number;
  safeCorrect: number;
  safeAccuracy: number;
  /** 100 for any error touching a commitment event, 1 otherwise. */
  cost: number;
  costPerServed: number;
  unknownServed: number;
}

/** The cost of one wrong route. A false consent (or a missed one) is two
 *  orders of magnitude worse than a misread question — the same weighting the
 *  money-ladder doctrine applies to the fee lanes. */
export function routeCost(predicted: string, truth: string): number {
  if (predicted === truth) return 0;
  if (COMMITMENT_EVENTS.has(predicted) || COMMITMENT_EVENTS.has(truth)) return 100;
  return 1;
}

export function evaluateLocal(model: LocalModel, rows: EvalRow[], floor: number): EvalResult {
  const out: EvalResult = {
    total: rows.length, served: 0, correct: 0, coverage: 0, accuracy: 0,
    safeServed: 0, safeCorrect: 0, safeAccuracy: 0, cost: 0, costPerServed: 0,
    unknownServed: 0,
  };
  for (const row of rows) {
    const pred = predictLocal(model, row.norm, row.sig);
    // UNKNOWN is an abstain even when it wins the argmax: serving it would be
    // serving a label that has no meaning to the FSM.
    if (pred.event === UNKNOWN) { out.unknownServed++; continue; }
    if (pred.confidence < floor) continue;
    out.served++;
    if (pred.event === row.event) out.correct++;
    out.cost += routeCost(pred.event, row.event);
    if (!COMMITMENT_EVENTS.has(row.event)) {
      out.safeServed++;
      if (pred.event === row.event) out.safeCorrect++;
    }
  }
  out.coverage = out.total ? out.served / out.total : 0;
  out.accuracy = out.served ? out.correct / out.served : 0;
  out.safeAccuracy = out.safeServed ? out.safeCorrect / out.safeServed : 0;
  out.costPerServed = out.served ? out.cost / out.served : 0;
  return out;
}

/** The naive baselines a model must beat. `always-abstain` costs 0 but serves
 *  nothing (coverage 0); `majority` is what a router that always guessed the
 *  most common event would pay. Beating majority at meaningful coverage is the
 *  minimum evidence that the features learned anything. */
export function majorityBaseline(rows: EvalRow[]): { event: string; accuracy: number; costPerRow: number } {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.event, (counts.get(r.event) ?? 0) + 1);
  let event = UNKNOWN;
  let best = -1;
  for (const [e, n] of counts) if (n > best) { best = n; event = e; }
  let cost = 0, correct = 0;
  for (const r of rows) {
    cost += routeCost(event, r.event);
    if (event === r.event) correct++;
  }
  return { event, accuracy: rows.length ? correct / rows.length : 0, costPerRow: rows.length ? cost / rows.length : 0 };
}

/** Structural validation. A model that does not match its own layout must be
 *  rejected LOUDLY — serving a mis-shaped one is a silent random router. */
export function validateModel(value: unknown): LocalModel {
  const m = value as Partial<LocalModel>;
  if (!m || m.version !== 2) {
    throw new Error('route model: unsupported version — retrain with the v2 trainer');
  }
  if (m.featureVersion !== FEATURE_VERSION) {
    throw new Error(`route model: feature layout v${String(m.featureVersion)} != v${FEATURE_VERSION} — retrain`);
  }
  if (!Array.isArray(m.classes) || m.classes.length === 0) throw new Error('route model: no classes');
  if (!Array.isArray(m.weights) || m.weights.length !== m.classes.length) {
    throw new Error('route model: weights do not match classes');
  }
  for (const w of m.weights) {
    if (!Array.isArray(w) || w.length !== FEATURE_DIM) {
      throw new Error(`route model: weight row must have ${FEATURE_DIM} entries`);
    }
    for (const v of w) if (!Number.isFinite(v)) throw new Error('route model: non-finite weight');
  }
  const temperature = m.temperature ?? 1;
  if (!Number.isFinite(temperature) || temperature <= 0) {
    throw new Error('route model: invalid temperature');
  }
  return {
    version: 2, featureVersion: FEATURE_VERSION, dim: FEATURE_DIM,
    classes: m.classes, weights: m.weights, temperature,
    trainedAt: m.trainedAt, trainedRows: m.trainedRows,
  };
}
