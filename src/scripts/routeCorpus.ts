// THE OUTCOME LINKER + CORPUS BUILDER (Phase 1).
//
// Phase 0 records every verdict with its context signature; this module turns
// those rows into LABELLED ones by asking what happened next (routeOutcome.ts
// owns the rules). The corpus is the only thing a route table, an abstain
// threshold or a local model may be trained on.
//
// Two hard rules, both from the build runbook:
//   1. the model's own verdict is never a label — the outcome is;
//   2. unlinked rows are a work queue, never deleted.

import { Db } from '../store/db';
import { ClassifyTurnStore, ClassifyTurnRow, ClassifyTier } from '../store/classifyTurns';
import { classifyOutcome, isTeachable, OUTCOME_WINDOW_MS } from '../llm/routeOutcome';
import { normalizedKey } from '../store/capture';

export interface LinkStats {
  scanned: number;
  linked: number;
  byOutcome: Record<string, number>;
  byTier: Record<string, number>;
}

/** A corpus row: the route identity plus the label the outcome justified. */
export interface CorpusRow {
  norm: string;
  state: string;
  sigKey: string;
  event: string;
  tier: ClassifyTier;
  outcome: string;
  createdAt: number;
}

interface CorrectionRow { msg: string; created_at: number }

/** Join every unlinked verdict to (a) a same-question bank correction filed in
 *  the window and (b) the chat's next verdict. Idempotent: a linked row is
 *  never relinked unless `relink` is set. */
export function linkOutcomes(
  db: Db,
  store: ClassifyTurnStore,
  opts: { windowMs?: number; limit?: number; relink?: boolean } = {},
): LinkStats {
  const windowMs = opts.windowMs ?? OUTCOME_WINDOW_MS;
  const limit = opts.limit ?? 2_000;
  const stats: LinkStats = { scanned: 0, linked: 0, byOutcome: {}, byTier: {} };

  const rows = store.unlinked(0, limit);
  // Corrections are small and question-shaped; cache them once. A correction
  // carries no chat id (it is filed from the bank), so identity is the
  // normalized question + the time window — the same rule the capture dedupe
  // uses.
  const corrections = db.db.prepare(
    'SELECT msg, created_at FROM bank_corrections ORDER BY created_at DESC LIMIT 5000',
  ).all() as CorrectionRow[];

  for (const row of rows) {
    stats.scanned++;
    const next = store.nextAfter(row.chatId, row.createdAt);
    const corrected = corrections.some(c =>
      c.created_at >= row.createdAt && c.created_at <= row.createdAt + windowMs
      && normalizedKey(c.msg) === row.norm,
    );
    const outcome = classifyOutcome(
      { event: row.event, state: row.state, createdAt: row.createdAt },
      next ? { event: next.event, state: next.state, createdAt: next.createdAt } : undefined,
      corrected,
      windowMs,
    );
    store.markOutcome(row.id, outcome);
    stats.linked++;
    stats.byOutcome[outcome] = (stats.byOutcome[outcome] ?? 0) + 1;
    stats.byTier[row.tier] = (stats.byTier[row.tier] ?? 0) + 1;
  }
  return stats;
}

/** The teachable corpus: clean outcomes only, with the identity the route
 *  table keys on. Deterministic and remote rows are both included — the table
 *  must abstain on the former and replace the latter. */
export function buildCorpus(
  store: ClassifyTurnStore,
  opts: { sinceMs?: number; limit?: number } = {},
): CorpusRow[] {
  const since = opts.sinceMs ?? 0;
  const limit = opts.limit ?? 50_000;
  const rows = store.linkedSince(since, limit);
  return rows
    .filter(r => r.outcome !== null && isTeachable(r.outcome as never))
    .map(r => ({
      norm: r.norm, state: r.state, sigKey: r.sigKey, event: r.event,
      tier: r.tier, outcome: r.outcome as string, createdAt: r.createdAt,
    }));
}

export interface CorpusStats {
  total: number;
  byState: Record<string, number>;
  byEvent: Record<string, number>;
  byWeek: Record<string, number>;
  /** Coverage the route table could reach: distinct identities in the corpus. */
  distinctIdentities: number;
  /** Identities seen more than once — the only ones an exact-match table can
   *  ever serve from history. */
  repeatedIdentities: number;
}

export function corpusStats(rows: CorpusRow[]): CorpusStats {
  const byState: Record<string, number> = {};
  const byEvent: Record<string, number> = {};
  const byWeek: Record<string, number> = {};
  const identities = new Map<string, number>();
  for (const r of rows) {
    byState[r.state] = (byState[r.state] ?? 0) + 1;
    byEvent[r.event] = (byEvent[r.event] ?? 0) + 1;
    const week = new Date(r.createdAt).toISOString().slice(0, 10);
    byWeek[week] = (byWeek[week] ?? 0) + 1;
    const id = `${r.norm}|${r.sigKey}`;
    identities.set(id, (identities.get(id) ?? 0) + 1);
  }
  let repeated = 0;
  for (const n of identities.values()) if (n > 1) repeated++;
  return {
    total: rows.length, byState, byEvent, byWeek,
    distinctIdentities: identities.size, repeatedIdentities: repeated,
  };
}

/** Rows whose outcome is linked — the corpus builder's input. */
export function linkedRows(store: ClassifyTurnStore, sinceMs = 0): ClassifyTurnRow[] {
  return store.linkedSince(sinceMs, 50_000);
}
