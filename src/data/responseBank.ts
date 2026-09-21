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
import { locPrep } from './properties';
import type { State } from '../fsm/machine';
import type { BankStore } from '../store/bank';

/** The learned bank layer (SQLite), injected at boot. May be undefined in
 *  scripts/tests that run without the store — the seed bank still works. */
let learned: BankStore | undefined;
export function setLearnedBank(b: BankStore | undefined): void { learned = b; }
export function getLearnedBank(): BankStore | undefined { return learned; }

/** Normalized comparison form — same rules as the generator's dedupe. */
export function normalizeVariant(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').replace(/[.,!?;:„“"'()—–-]/g, '').trim();
}

function fillVars(text: string, vars?: Record<string, string>): string {
  if (!vars) return text;
  let out = text;
  for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(v);
  // NA/VO agreement: the bank templates hardcode "во {location}" — but Водно
  // is a mountain and takes "на" ("на Водно"). Normalize at fill time so every
  // variant (seed AND learned) speaks correct Macedonian without editing each.
  const loc = vars['location'];
  if (loc && locPrep(loc) === 'на') {
    out = out
      .split(`во ${loc}`).join(`на ${loc}`)
      .split(`во ${loc.toLowerCase()}`).join(`на ${loc}`)
      .split(`vo ${loc}`).join(`на ${loc}`);
  }
  return out;
}

export interface PickOpts {
  /** Assistant texts already sent (from session history) — picked variants avoid these. */
  recent?: string[];
  /** Placeholder values, e.g. { location: 'Центар' } fills "{location}". */
  vars?: Record<string, string>;
}

/** Pick a variant for a bank key, or undefined when the key has no variants yet.
 *  Layered: seed (responses.ts) + learned (SQLite bank_variants). Learned
 *  variants are LIVE without rebuild; the seed layer is the boot fallback if
 *  the DB is corrupted. Repeat avoidance spans BOTH layers. */
export function pickVariant(key: string, opts: PickOpts = {}): string | undefined {
  const seed = RESPONSE_BANK[key] ?? [];
  const learnedVars = learned ? learned.variants(key) : [];
  const variants = [...seed, ...learnedVars];
  // P0 meters: every serve is a hit, every empty lookup a miss — this is the
  // single funnel all bank-backed replies pass through, so the per-key
  // serve-rate here IS the production coverage signal.
  if (variants.length === 0) { learned?.metric(key, false); return undefined; }
  const recent = new Set((opts.recent ?? []).map(normalizeVariant));
  const fresh = variants.filter(v => !recent.has(normalizeVariant(v)));
  const pool = fresh.length > 0 ? fresh : variants;
  learned?.metric(key, true);
  return fillVars(pool[Math.floor(Math.random() * pool.length)], opts.vars);
}

/**
 * RETRIEVAL: match a free-form client message against the learned examples
 * table and serve a variant for the matched key — the card catalog of the
 * bank. Offline (SQLite read), sub-ms. Returns undefined when nothing
 * matches or the matched key has no variants in either layer; callers then
 * escalate to the LLM. Records a hit/miss metric when a store is attached.
 */
export function retrieveVariant(userMsg: string, opts: PickOpts = {}): string | undefined {
  if (!learned) return undefined;
  const hit = learned.retrieve(userMsg);
  if (!hit) return undefined;
  // pickVariant records the hit/miss metric — no double-count here.
  return pickVariant(hit.key, opts);
}

/** Record a bank MISS for a key the runtime needed but could not serve. */
export function recordBankMiss(key: string): void {
  learned?.metric(key, false);
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
 * The TYPE-AWARE empty-result intro: when a small-category search (garsonjera)
 * has no EXACT hits in the area but bigger units exist, Lina says so honestly
 * and offers the closest options — one sentence, then the cards. The prefix
 * + opener combo ("нема… Еве ги најблиските" followed by "Врз основа на…")
 * read as two contradictory speakers; this replaces both when present.
 * The 19:34 bug also fabricated "стан со една спална" — a criterion the
 * client never gave (garsonjera is a TYPE, not a спални count).
 */
export function relaxedCategoryLine(
  garsonjera: boolean | undefined,
  requestedBeds: number | undefined,
  location: string | undefined,
  recent: string[] = [],
): string | undefined {
  if (!garsonjera) return undefined;
  const where = location ? ` ${locPrep(location)}` : '';
  return pickVariant('presentation.relaxed.category', { recent })
    ?? `Во моментов немам слободна гарсоњера${where}, но имам мало станче во Ваша цена — ако Ви се допаѓа, може веднаш да организираме посета.`;
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
