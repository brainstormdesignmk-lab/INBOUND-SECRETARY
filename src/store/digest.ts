/**
 * BANK LOOP HOUSEKEEPING — digest, verbatim bind, bind-file parsing.
 *
 * WHY THIS LIVES IN `src/` AND NOT `scripts/`: tsconfig compiles only `src`, and
 * the atoms run COMPILED code with no `tsx` installed (the 2026-10-07
 * `tsx: not found` lesson from hermes-price.sh). `scripts/relearn.ts` is the
 * workstation convenience; `node dist/scripts/relearnBank.js` is the atom path.
 * Both call the functions here, so the two entry points can never drift.
 *
 * The split inside is deliberate:
 *   - the PHRASE → KEY binding is a ROUTING fact: no model, no prose, free.
 *   - the ANSWER → staged variant is POLICY prose: it waits for bank:review.
 * Nothing here calls an LLM, which is what makes it safe to run on an atom.
 */

import { Db } from './db';
import { BankStore } from './bank';
import { EnrichmentStore } from './enrichment';

export interface DigestResult {
  /** Dynamic groups (dynamicSlug folds near-duplicates into one group). */
  groups: number;
  /** Client phrasings written into bank_examples (retrieval material). */
  examples: number;
  /** Answers staged for `bank:review` — NOT served until a human promotes. */
  staged: number;
  /** FIFO rows dropped to keep the dynamic store a fresh signal. */
  purged: number;
  /** Serve rows marked processed (advisory: skipped if the table is absent). */
  marked: number;
}

/**
 * NIGHTLY DIGEST: fold dynamic groups into deterministic coverage.
 * Trigger side: client messages become retrieval examples. Answer side: the
 * stored answer becomes ONE staged variant (a human promotes it). FIFO purge
 * keeps the store from becoming an archive.
 */
export function digestDynamic(bank: BankStore, db: Db, keep = 400): DigestResult {
  const groups = bank.dynamicGroups();
  let examples = 0;
  let staged = 0;
  for (const g of groups) {
    for (const m of g.msgs) {
      if (bank.addExample(g.key, m)) examples++;
    }
    if (bank.addStagedVariant(g.key, g.answer, `dynamic digest from ${g.msgs.length} stored question(s)`)) staged++;
  }
  const purged = bank.purgeDynamic(keep);
  // Advisory: the serve log is a convenience, never a prerequisite for the fold.
  let marked = 0;
  try {
    marked = new EnrichmentStore(db).markDynamicProcessed();
  } catch { /* table absent on a fresh DB — nothing to mark */ }
  return { groups: groups.length, examples, staged, purged, marked };
}

export interface BindEntry {
  id: number;
  key: string;
}

export interface BindOutcome extends BindEntry {
  ok: boolean;
  /** true = the phrase landed in bank_examples; false = it was already bound. */
  added?: boolean;
  msg?: string;
  reason?: string;
}

/**
 * VERBATIM bind of many captures. `isServable` is the caller's key check (the
 * CLI passes seed-variant membership): binding to a key that cannot answer
 * routes to a dead end and falls through silently — the failure this whole
 * command exists to remove. A refused entry is reported, never reported as ok.
 */
export function bindMany(
  bank: BankStore,
  entries: BindEntry[],
  isServable?: (key: string) => boolean,
): BindOutcome[] {
  return entries.map(e => {
    if (isServable && !isServable(e.key)) {
      return { ...e, ok: false, reason: 'no seed or active variant for that key' };
    }
    const r = bank.bindDynamic(e.id, e.key);
    return r.ok
      ? { ...e, ok: true, added: r.added, msg: r.msg, reason: r.reason }
      : { ...e, ok: false, reason: r.reason ?? 'refused' };
  });
}

/**
 * Parse a bind file: one `<id> <key>` per line, `=`/`:` also accepted as the
 * separator, `#` starts a comment, blank lines ignored. Malformed lines are
 * reported with their number instead of being skipped silently — a typo that
 * disappears turns into a capture nobody ever binds.
 */
export function parseBindFile(text: string): { entries: BindEntry[]; errors: string[] } {
  const entries: BindEntry[] = [];
  const errors: string[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) return;
    const m = line.match(/^(\d+)(?:\s*[=,:]\s*|\s+)(\S+)$/);
    if (!m) {
      errors.push(`line ${i + 1}: expected "<id> <key>" — got "${raw.trim()}"`);
      return;
    }
    entries.push({ id: Number(m[1]), key: m[2] });
  });
  return { entries, errors };
}
