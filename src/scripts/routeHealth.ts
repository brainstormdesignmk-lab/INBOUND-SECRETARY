/**
 * ROUTE HEALTH — the collision report, as pure logic so a test can pin it.
 *
 * The router is safe at serve time (invariants + lanes), but the queue is the
 * only place that remembers what actually happened. This module reads queue
 * rows and answers three questions without touching the bank:
 *
 *   1. FROZEN MISROUTE — a turn filed under a frozen policy key whose wording is
 *      a PROPERTY-price evaluation. That is the `MNOGU EFTINA CENA E TOA`
 *      family: the fee pool cannot be edited, so the row would sit refused
 *      forever; it must be re-homed (BankReview.suggestKey) or the detector
 *      guard is missing.
 *   2. COLLISION — the same phrase reached two different keys. Either routing is
 *      state-dependent (fine, but must be explained) or vocabulary is colliding.
 *   3. ORPHAN — a turn with no key. It is capturable but has no home yet.
 *
 * Nothing here serves a client and nothing writes; `scripts/route-health.ts`
 * is the CLI, `--strict` turns findings into a non-zero exit for CI/pre-deploy.
 */
import { FROZEN_BANK_KEYS } from '../store/bank';
import { detectPriceEval } from '../llm/deterministic';

export interface HealthRow {
  id: number;
  state: string;
  eventType: string;
  bankKey: string | null;
  userMsg: string;
  /** The operator's retarget (bank:tui K / rehome script), when set. The
   *  ORIGINAL routing evidence in bank_key is never rewritten; a row with a
   *  re-home is no longer a misroute — the question found its learn.* route
   *  while the original serve stays as history. */
  reviewKey?: string | null;
  /** Epoch ms, when the queue recorded the turn (optional for old fixtures). */
  createdAt?: number;
}

export type FindingKind = 'frozen-misroute' | 'collision' | 'orphan';

export interface Finding {
  kind: FindingKind;
  /** Present for row-level findings, absent for phrase-level collisions. */
  id?: number;
  key?: string;
  phrase: string;
  detail: string;
}

const normalize = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** A phrase reaching both market variants of ONE family (`fee.ask.buy` and
 *  `fee.ask.rent`, `provision.ask.*`) is expected routing, not a collision. */
const marketFamily = (key: string): string => key.replace(/\.(?:buy|rent|danok)$/i, '');

// P5.1 PER-KEY METRICS — the rates behind the findings. A finding tells you
// THAT something is wrong; the rate tells you whether it is a draining wound
// or stale history. Family = market-collapsed key (`.buy/.rent` are one lane).
export interface HealthRates {
  /** Key-bearing turns per family. */
  serves: Record<string, number>;
  /** frozen-misroute rows / serves, per family (0 when no captures). */
  misrouteRate: Record<string, number>;
  /** rows with no key / all rows. */
  orphanRate: number;
  /** frozen-misroute rows / key-bearing rows — the freeze-refusal share. */
  freezeRefusalRate: number;
}

const rate = (n: number, d: number): number => (d > 0 ? Number((n / d).toFixed(3)) : 0);

/** The row's EFFECTIVE route: the operator's re-home wins; the original serve
 *  is preserved as evidence either way. */
const effectiveKey = (r: HealthRow): string =>
  (r.reviewKey ?? '').trim() || (r.bankKey ?? '').trim();

export function computeRates(rows: HealthRow[], counts: Record<FindingKind, number>): HealthRates {
  const serves: Record<string, number> = {};
  const misroutes: Record<string, number> = {};
  for (const r of rows) {
    const key = (r.bankKey ?? '').trim();
    if (!key) continue;
    const family = marketFamily(key);
    serves[family] = (serves[family] ?? 0) + 1;
    if (FROZEN_BANK_KEYS.has(effectiveKey(r)) && detectPriceEval(r.userMsg) !== undefined) {
      misroutes[family] = (misroutes[family] ?? 0) + 1;
    }
  }
  const keyBearing = rows.filter(r => (r.bankKey ?? '').trim()).length;
  const frozenTotal = Object.values(misroutes).reduce((a, b) => a + b, 0);
  const misrouteRate: Record<string, number> = {};
  for (const family of Object.keys(serves)) misrouteRate[family] = rate(misroutes[family] ?? 0, serves[family]);
  return {
    serves,
    misrouteRate,
    orphanRate: rate(counts.orphan, rows.length),
    freezeRefusalRate: rate(frozenTotal, keyBearing),
  };
}

/** Rates summary line: family = rate% (n serves). Sorted by rate. */
export function healthRatesLine(rates: HealthRates): string {
  const entries = Object.keys(rates.misrouteRate)
    .map(family => `${family}=${rates.misrouteRate[family] * 100}%/${rates.serves[family]}`)
    .sort();
  return `misroute-rate:${entries.join(' ')} · orphan-rate=${rates.orphanRate * 100}% · freeze-refusal-rate=${rates.freezeRefusalRate * 100}%`;
}

export function analyzeRows(rows: HealthRow[]): {
  findings: Finding[];
  counts: Record<FindingKind, number>;
  rates: HealthRates;
} {
  const findings: Finding[] = [];
  const counts: Record<FindingKind, number> = { 'frozen-misroute': 0, collision: 0, orphan: 0 };

  // Phrase → distinct keys (collision evidence).
  const byPhrase = new Map<string, Set<string>>();
  for (const r of rows) {
    const key = (r.bankKey ?? '').trim();
    if (r.userMsg && key) {
      const set = byPhrase.get(normalize(r.userMsg)) ?? new Set<string>();
      set.add(key);
      byPhrase.set(normalize(r.userMsg), set);
    }
    if (!key) {
      counts.orphan += 1;
      findings.push({ kind: 'orphan', id: r.id, phrase: r.userMsg, detail: `${r.state}/${r.eventType} reached no key` });
      continue;
    }
    // A frozen policy pool can never own a PROPERTY-price evaluation: the fee is
    // never called cheap/expensive by a client who has not paid it. The check
    // runs on the EFFECTIVE route: a re-homed row (review_key set by the
    // operator or the rehome script) has left the frozen key and is no longer
    // a standing misroute — the bank_key evidence is kept, not hidden.
    if (FROZEN_BANK_KEYS.has(effectiveKey(r)) && detectPriceEval(r.userMsg) !== undefined) {
      counts['frozen-misroute'] += 1;
      findings.push({
        kind: 'frozen-misroute', id: r.id, key, phrase: r.userMsg,
        detail: `price valence filed under frozen ${key} — re-home the question to a learn.* key`,
      });
    }
  }

  for (const [phrase, keys] of byPhrase) {
    if (keys.size < 2) continue;
    // Market variants of one family are the SAME route (the service slot decides
    // the wording); only a genuine cross-family split is a collision.
    if (new Set([...keys].map(marketFamily)).size < 2) continue;
    counts.collision += 1;
    findings.push({
      kind: 'collision', phrase,
      detail: `reached ${keys.size} keys: ${[...keys].sort().join(', ')}`,
    });
  }

  return { findings, counts, rates: computeRates(rows, counts) };
}

/** One-line summary for logs/status bars. */
export function healthLine(counts: Record<FindingKind, number>): string {
  return `frozen-misroute=${counts['frozen-misroute']} collision=${counts.collision} orphan=${counts.orphan}`;
}
