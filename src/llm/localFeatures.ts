// FEATURES FOR THE LOCAL ROUTE MODEL — LAYOUT v2 (3-, 4- and 5-grams).
//
// One extractor, used by the trainer AND the inference path — a second
// implementation is how a model silently stops matching its own weights.
//
// LAYOUT IS VERSIONED AND EXPLICIT. The bucket ranges are baked into every
// weight file, so changing them is a model-version bump, never a silent
// reinterpretation. v1 shipped 3-grams only (1024 buckets); v2 adds the longer
// n-grams in their own disjoint ranges so a 4-gram can never collide with a
// 3-gram bucket.
//
//   [    0 .. 1023]  3-grams  (1024 buckets)
//   [ 1024 .. 1535]  4-grams  ( 512 buckets)
//   [ 1536 .. 1791]  5-grams  ( 256 buckets)
//   [ 1792 .. 1855]  signature flags (64 buckets)
//
// Why longer grams at all: a 3-gram cannot distinguish «не сакам» from
// «сакам» reliably on short client messages — the negation is carried by a
// 4/5-gram boundary. The signature's `negated` flag already encodes it, but
// the grams give the model a second, independent view.
//
// No dependencies, no I/O, integer-hash only: an appliance must reproduce the
// same vector after a restart, on any machine.

import { RouteSig } from './routeSig';

export const FEATURE_VERSION = 2;

const N3_BUCKETS = 1024;
const N4_BUCKETS = 512;
const N5_BUCKETS = 256;
const N3_BASE = 0;
const N4_BASE = N3_BASE + N3_BUCKETS;      // 1024
const N5_BASE = N4_BASE + N4_BUCKETS;      // 1536
export const GRAM_BUCKETS = N5_BASE + N5_BUCKETS; // 1792
export const FLAGS_BASE = GRAM_BUCKETS;    // 1792
export const FLAG_BUCKETS = 64;
export const FEATURE_DIM = GRAM_BUCKETS + FLAG_BUCKETS; // 1856

/** FNV-1a, 32-bit — stable across processes and platforms (Math.random-free). */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Grams of one length, hashed into that length's OWN range. Presence, not
 *  frequency: one client repeating a word must not move the vector more than
 *  the word itself. */
function gramIndices(norm: string, n: number, base: number, buckets: number): number[] {
  const out: number[] = [];
  if (norm.length < n) return out;
  for (let i = 0; i + n <= norm.length; i++) {
    out.push(base + (hash32(norm.slice(i, i + n)) % buckets));
  }
  return out;
}

export function textFeatureIndices(norm: string): number[] {
  if (!norm) return [];
  const seen = new Set<number>();
  if (norm.length < 3) {
    // A one- or two-letter message still needs a feature: hash the whole token.
    seen.add(hash32(`^${norm}`) % N3_BUCKETS);
    return [...seen];
  }
  for (const i of gramIndices(norm, 3, N3_BASE, N3_BUCKETS)) seen.add(i);
  for (const i of gramIndices(norm, 4, N4_BASE, N4_BUCKETS)) seen.add(i);
  for (const i of gramIndices(norm, 5, N5_BASE, N5_BUCKETS)) seen.add(i);
  return [...seen];
}

const AWAITING_ORDER = [
  'none', 'service', 'location', 'budget', 'bedrooms',
  'fee', 'contact', 'time', 'property', 'confirm',
] as const;

/** Fixed offsets in [FLAGS_BASE, FEATURE_DIM). Reordering these without a
 *  version bump silently reinterprets every stored weight. */
export function sigFeatureIndices(sig: RouteSig): number[] {
  const out: number[] = [];
  const base = FLAGS_BASE;
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
