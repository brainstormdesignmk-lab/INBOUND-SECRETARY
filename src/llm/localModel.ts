// THE LOCAL MODEL (Phase 4) — multinomial logistic regression, pure TS.
//
// Why not Tiny 2.1: that net is a character-level FACT RECALL model ("outside
// those it makes things up confidently"). A router needs a calibrated 16-class
// decision with an explicit ABSTAIN, so the right tool is a linear model over
// hashed char n-grams + the context signature, trained on the Phase-1 corpus.
//
// Properties that matter on an appliance:
//   • deterministic training (fixed order, fixed seed-free init at zero);
//   • weights are plain JSON — no native deps, no ONNX, no GPU;
//   • inference is a dot product per class: microseconds;
//   • a confidence floor makes ABSTAIN the default below it.
//
// This module is PURE (no fs, no clock) so the trainer, the CLI and the tests
// share one implementation.

import { FEATURE_DIM, featureIndices } from './localFeatures';
import { RouteSig } from './routeSig';

export interface TrainRow {
  norm: string;
  sig: RouteSig;
  event: string;
}

export interface LocalModel {
  version: 1;
  dim: number;
  classes: string[];
  weights: number[][];
  /** Trained-at epoch ms, for provenance only — never read by inference. */
  trainedAt?: number;
  /** Rows that produced it, for the same reason. */
  trainedRows?: number;
}

export function emptyModel(classes: string[]): LocalModel {
  return {
    version: 1,
    dim: FEATURE_DIM,
    classes,
    weights: classes.map(() => new Array<number>(FEATURE_DIM).fill(0)),
  };
}

function logits(model: LocalModel, idx: number[]): number[] {
  return model.weights.map(w => {
    let s = 0;
    for (const i of idx) s += w[i] ?? 0;
    return s;
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
  /** Class order may be fixed by the caller so two training runs on the same
   *  corpus produce byte-identical files (the CLI sorts it). */
  classes?: string[];
}

/** Train from scratch. Rows are visited in the given order (the CLI sorts by
 *  time), so the result is reproducible. */
export function trainLocalModel(rows: TrainRow[], opts: TrainOpts = {}): LocalModel {
  const epochs = opts.epochs ?? 12;
  const lr = opts.lr ?? 0.35;
  const l2 = opts.l2 ?? 1e-5;
  const classes = opts.classes ?? [...new Set(rows.map(r => r.event))].sort();
  if (classes.length === 0) return emptyModel(['STAY']);
  const model = emptyModel(classes);
  const index = new Map(classes.map((c, i) => [c, i]));
  const prepared = rows
    .filter(r => index.has(r.event))
    .map(r => ({ y: index.get(r.event)!, idx: featureIndices(r.norm, r.sig) }));

  for (let epoch = 0; epoch < epochs; epoch++) {
    for (const row of prepared) {
      const p = softmax(logits(model, row.idx));
      for (let c = 0; c < classes.length; c++) {
        const err = p[c]! - (c === row.y ? 1 : 0);
        if (err === 0) continue;
        const w = model.weights[c]!;
        for (const f of row.idx) {
          w[f] = (w[f] ?? 0) - lr * (err + l2 * (w[f] ?? 0));
        }
      }
    }
    // Learning-rate decay keeps the last epochs from oscillating.
    lrDecay(model, epoch, epochs);
  }
  return model;
}

/** Decay is applied through a module-level scale so the signature stays clean.
 *  It is monotonic and deterministic: epoch 0 uses the full rate. */
let lrScale = 1;
function lrDecay(_model: LocalModel, epoch: number, epochs: number): void {
  lrScale = Math.max(0.2, 1 - (epoch + 1) / (epochs * 1.25));
}
export function currentLrScale(): number { return lrScale; }

export interface Prediction {
  event: string;
  confidence: number;
  /** Full distribution, for the review tooling (never served). */
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

/** Structural validation of a loaded weight file. A model that does not match
 *  its own dimension must be rejected LOUDLY — serving a mis-shaped one is a
 *  silent random router. */
export function validateModel(value: unknown): LocalModel {
  const m = value as Partial<LocalModel>;
  if (!m || m.version !== 1) throw new Error('route model: unsupported version');
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
  return { version: 1, dim: FEATURE_DIM, classes: m.classes, weights: m.weights, trainedAt: m.trainedAt, trainedRows: m.trainedRows };
}
