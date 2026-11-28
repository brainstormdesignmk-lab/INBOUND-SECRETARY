// FEATURES FOR THE LOCAL ROUTE MODEL (Phase 4).
//
// One extractor, used by the trainer AND the inference path — a second
// implementation is how a model silently stops matching its own weights.
//
// Two families, deliberately:
//   • HASHED CHAR 3-GRAMS of the normalized text (the same fold the ledger and
//     the capture store use). Char grams survive the Macedonian/Latin spelling
//     twins and the case/space noise that word tokens would split on.
//   • SIGNATURE INDICATORS — the seven flags of routeSig. The calibration showed
//     the label is NOT a function of text alone, so the model must see the same
//     context the route table keys on.
//
// No dependencies, no I/O, integer-hash only: an appliance must reproduce the
// same vector after a restart, on any machine.

import { RouteSig } from './routeSig';

export const GRAM_BUCKETS = 1024;
export const FLAG_BUCKETS = 64;
export const FEATURE_DIM = GRAM_BUCKETS + FLAG_BUCKETS;

/** FNV-1a, 32-bit — stable across processes and platforms (Math.random-free). */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Char 3-grams of the already-normalized text, hashed into buckets. Repeated
 *  grams are counted once (presence, not frequency): one client repeating a
 *  word must not move the vector more than the word itself. */
export function textFeatureIndices(norm: string): number[] {
  const out = new Set<number>();
  if (norm.length < 3) {
    if (norm.length > 0) out.add(hash32(`^${norm}`) % GRAM_BUCKETS);
  } else {
    for (let i = 0; i + 3 <= norm.length; i++) {
      out.add(hash32(norm.slice(i, i + 3)) % GRAM_BUCKETS);
    }
  }
  return [...out];
}

const AWAITING_ORDER = [
  'none', 'service', 'location', 'budget', 'bedrooms',
  'fee', 'contact', 'time', 'property', 'confirm',
] as const;

/** Fixed offsets in [GRAM_BUCKETS, FEATURE_DIM). The offsets are part of the
 *  weight file's meaning — never reorder without retraining (the model version
 *  carries the layout). */
export function sigFeatureIndices(sig: RouteSig): number[] {
  const out: number[] = [];
  const base = GRAM_BUCKETS;
  if (sig.negated) out.push(base + 0);
  if (sig.digit) out.push(base + 1);
  if (sig.moneyWord) out.push(base + 2);
  if (sig.propertyOnTable) out.push(base + 3);
  if (sig.feeRung) out.push(base + 4);
  const a = AWAITING_ORDER.indexOf(sig.awaiting);
  out.push(base + 8 + Math.max(0, a)); // 8..17
  out.push(base + 32 + (sig.service === 'buy' ? 0 : sig.service === 'rent' ? 1 : 2)); // 32..34
  return out;
}

export function featureIndices(norm: string, sig: RouteSig): number[] {
  return [...textFeatureIndices(norm), ...sigFeatureIndices(sig)];
}
