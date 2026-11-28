// THE CLASSIFIER LEDGER — every verdict, with the context it was decided in.
//
// Why this exists (docs/classifier-build-runbook.md, Phase 0): 513 classify
// calls were computed over three months and NOT ONE was stored. Every
// calibration since had to reconstruct the label by pairing `[timing] classify`
// log lines to capture files by timestamp — median 432 ms, which worked only
// because the machine was quiet. A route table, an abstain threshold and a
// local model are all graded against this ledger; without it they have no
// ground truth at all.
//
// The contract is the same as every other learning store in this repo: a lost
// row is better than a broken turn. Writes happen at the ONE classify seam and
// never throw into the chat path.

import { Db } from './db';

/** Which tier produced the verdict. `degraded` marks a remote call that FAILED
 *  (timeout / every key refused) — the STAY it returns must never be read as a
 *  genuine "stay". */
export type ClassifyTier = 'det' | 'route' | 'local' | 'remote';

export interface ClassifyTurnInput {
  chatId: string;
  /** FSM state BEFORE the turn. */
  state: string;
  /** The client's message, verbatim. */
  text: string;
  /** `normalizedKey(text)` — the identity the route table keys on. */
  norm: string;
  /** JSON of the context signature (routeSig.ts). */
  sig: string;
  /** Stable encoding of that signature (sigKey()). */
  sigKey: string;
  event: string;
  tier: ClassifyTier;
  provider?: string;
  latencyMs?: number;
  attempts?: number;
  degraded?: boolean;
}

export type ClassifyTurnRow = Omit<ClassifyTurnInput, 'provider' | 'degraded' | 'latencyMs' | 'attempts'> & {
  id: number;
  degraded: boolean;
  latencyMs: number;
  attempts: number;
  provider: string | null;
  /** Filled by the Phase-1 outcome linker: cleaned | corrected | reask |
   *  regression | unknown. NULL means not linked yet. */
  outcome: string | null;
  outcomeAt: number | null;
  createdAt: number;
};

export interface ClassifyStats {
  total: number;
  degraded: number;
  byTier: Record<string, number>;
  byEvent: Record<string, number>;
  medianLatencyMs: number;
  p90LatencyMs: number;
}

export class ClassifyTurnStore {
  constructor(private db: Db) {}

  insert(rec: ClassifyTurnInput): number {
    const info = this.db.db.prepare(`
      INSERT INTO classify_turns
        (chat_id, state, text, norm, sig, sig_key, event, tier, provider,
         latency_ms, attempts, degraded, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      rec.chatId, rec.state, rec.text, rec.norm, rec.sig, rec.sigKey, rec.event,
      rec.tier, rec.provider ?? null, Math.max(0, Math.round(rec.latencyMs ?? 0)),
      Math.max(0, rec.attempts ?? 0), rec.degraded ? 1 : 0, Date.now(),
    );
    return Number(info.lastInsertRowid);
  }

  byId(id: number): ClassifyTurnRow | null {
    return (this.db.db.prepare(`${SELECT} WHERE id = ?`).get(id) as ClassifyTurnRow | undefined) ?? null;
  }

  /** Newest first — the operator's view of what the tiers decided. */
  recent(limit = 20): ClassifyTurnRow[] {
    return this.db.db.prepare(`${SELECT} ORDER BY id DESC LIMIT ?`).all(limit) as ClassifyTurnRow[];
  }

  forChat(chatId: string, limit = 20): ClassifyTurnRow[] {
    return this.db.db.prepare(`${SELECT} WHERE chat_id = ? ORDER BY id DESC LIMIT ?`)
      .all(chatId, limit) as ClassifyTurnRow[];
  }

  /** The Phase-1 linker's work queue. */
  unlinked(sinceMs = 0, limit = 500): ClassifyTurnRow[] {
    return this.db.db.prepare(`${SELECT} WHERE outcome IS NULL AND created_at >= ? ORDER BY id ASC LIMIT ?`)
      .all(sinceMs, limit) as ClassifyTurnRow[];
  }

  markOutcome(id: number, outcome: string): boolean {
    return this.db.db.prepare('UPDATE classify_turns SET outcome = ?, outcome_at = ? WHERE id = ?')
      .run(outcome, Date.now(), id).changes > 0;
  }

  /** The chat's NEXT verdict after `createdAt` (Phase-1 outcome linking). Same
   *  timestamp ties are excluded (`>`), so a row never links to itself. */
  nextAfter(chatId: string, createdAt: number): ClassifyTurnRow | null {
    return (this.db.db.prepare(`${SELECT} WHERE chat_id = ? AND created_at > ? ORDER BY created_at ASC LIMIT 1`)
      .get(chatId, createdAt) as ClassifyTurnRow | undefined) ?? null;
  }

  /** Linked rows (outcome not null) — the corpus builder's read. */
  linkedSince(sinceMs = 0, limit = 50_000): ClassifyTurnRow[] {
    return this.db.db.prepare(`${SELECT} WHERE outcome IS NOT NULL AND created_at >= ? ORDER BY created_at ASC LIMIT ?`)
      .all(sinceMs, limit) as ClassifyTurnRow[];
  }

  /** Rows for a given route identity — the shadow/route comparison primitive. */
  byKey(norm: string, sigKey: string, limit = 50): ClassifyTurnRow[] {
    return this.db.db.prepare(`${SELECT} WHERE norm = ? AND sig_key = ? ORDER BY id DESC LIMIT ?`)
      .all(norm, sigKey, limit) as ClassifyTurnRow[];
  }

  stats(sinceMs = 0): ClassifyStats {
    const rows = this.db.db.prepare(
      'SELECT tier, event, degraded, latency_ms AS latencyMs FROM classify_turns WHERE created_at >= ?',
    ).all(sinceMs) as Array<{ tier: string; event: string; degraded: number; latencyMs: number }>;
    const byTier: Record<string, number> = {};
    const byEvent: Record<string, number> = {};
    let degraded = 0;
    const latencies: number[] = [];
    for (const r of rows) {
      byTier[r.tier] = (byTier[r.tier] ?? 0) + 1;
      byEvent[r.event] = (byEvent[r.event] ?? 0) + 1;
      if (r.degraded) degraded++;
      latencies.push(r.latencyMs);
    }
    latencies.sort((a, b) => a - b);
    const at = (q: number): number => latencies.length === 0
      ? 0
      : latencies[Math.min(latencies.length - 1, Math.floor(q * (latencies.length - 1)))];
    return {
      total: rows.length,
      degraded,
      byTier,
      byEvent,
      medianLatencyMs: at(0.5),
      p90LatencyMs: at(0.9),
    };
  }

  count(): number {
    return (this.db.db.prepare('SELECT COUNT(*) AS cnt FROM classify_turns').get() as { cnt: number }).cnt;
  }

  /** Retention: the ledger is field evidence, but it must not grow without
   *  bound on an appliance. Linked rows are pruned first; unlinked rows are
   *  never deleted (they are the work queue). */
  pruneLinkedBefore(ms: number): number {
    return this.db.db.prepare(
      'DELETE FROM classify_turns WHERE outcome IS NOT NULL AND created_at < ?',
    ).run(ms).changes;
  }
}

const SELECT = `
  SELECT id, chat_id AS chatId, state, text, norm, sig, sig_key AS sigKey,
         event, tier, provider, latency_ms AS latencyMs, attempts, degraded,
         outcome, outcome_at AS outcomeAt, created_at AS createdAt
  FROM classify_turns`;
