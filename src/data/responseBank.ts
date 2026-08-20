// The response-bank picker: repeat-avoiding variant selection for the
// LLM-free / code-built paths. The bank (src/data/responses.ts) is GENERATED
// by `npm run responses:generate`; this module is the hand-written runtime
// half. Variants are DECORATIVE — the funnel logic stays code-built and
// deterministic, this only varies wording.
//
// Repeat avoidance is derived from the session history (recent assistant
// texts), never stored per-chat: a variant whose normalized text already
// appeared recently is skipped, so Lina never parrots the same sentence in a
// row. When every variant of a key was recently used, the picker falls back to
// the full pool rather than returning nothing.

import { RESPONSE_BANK } from './responses';
import type { State } from '../fsm/machine';

/** Normalized comparison form — same rules as the generator's dedupe. */
export function normalizeVariant(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').replace(/[.,!?;:„“"'()—–-]/g, '').trim();
}

function fillVars(text: string, vars?: Record<string, string>): string {
  if (!vars) return text;
  let out = text;
  for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(v);
  return out;
}

export interface PickOpts {
  /** Assistant texts already sent (from session history) — picked variants avoid these. */
  recent?: string[];
  /** Placeholder values, e.g. { location: 'Центар' } fills "{location}". */
  vars?: Record<string, string>;
}

/** Pick a variant for a bank key, or undefined when the key has no variants yet. */
export function pickVariant(key: string, opts: PickOpts = {}): string | undefined {
  const variants = RESPONSE_BANK[key];
  if (!variants || variants.length === 0) return undefined;
  const recent = new Set((opts.recent ?? []).map(normalizeVariant));
  const fresh = variants.filter(v => !recent.has(normalizeVariant(v)));
  const pool = fresh.length > 0 ? fresh : variants;
  return fillVars(pool[Math.floor(Math.random() * pool.length)], opts.vars);
}

/**
 * LLM-down / guard-blocked fallback line. Most states will get a
 * 'fallback.<state>' bank key in later generation batches; today only
 * owner_checking has one (the patience line). A missing key returns undefined
 * and the caller uses its code-built FALLBACKS line unchanged.
 */
export function fallbackVariant(state: State, recent: string[] = []): string | undefined {
  const key = state === 'owner_checking' ? 'patience.line' : `fallback.${state}`;
  return pickVariant(key, { recent });
}

/**
 * The deterministic empty-result line, bank-backed: the location form fills
 * {location}, the plain form is used when no area was named. Returns undefined
 * when the bank has no variants, so the caller keeps its code-built line.
 */
export function noMatchLine(location: string | undefined, recent: string[] = []): string | undefined {
  return location
    ? pickVariant('no.match.location', { recent, vars: { location } })
    : pickVariant('no.match.plain', { recent });
}

/**
 * The exhausted-area line, bank-backed: the selected area(s) are drained and
 * Lina asks whether to look elsewhere (or register the criteria). The location
 * form fills {location}; the plain form is used when no area was fixed.
 * Returns undefined when the bank has no variants, so the caller keeps its
 * code-built line.
 */
export function exhaustedLine(location: string | undefined, recent: string[] = []): string | undefined {
  return location
    ? pickVariant('exhausted.location', { recent, vars: { location } })
    : pickVariant('exhausted.plain', { recent });
}
