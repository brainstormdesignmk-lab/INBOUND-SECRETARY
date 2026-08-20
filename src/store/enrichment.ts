import { Db } from './db';

export interface EnrichmentRecord {
  id: number;
  chatId: string;
  state: string;
  eventType: string;
  userMsg: string;
  replyText: string;
  replySource: string;
  bankKey: string | null;
  createdAt: number;
  enriched: boolean;
}

export class EnrichmentStore {
  constructor(private db: Db) {}

  /** Log an LLM-backed response for later enrichment. */
  insert(rec: {
    chatId: string;
    state: string;
    eventType: string;
    userMsg: string;
    replyText: string;
    replySource: string;
    bankKey?: string;
  }): void {
    this.db.db.prepare(`
      INSERT INTO enrichment_queue (chat_id, state, event_type, user_msg, reply_text, reply_source, bank_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      rec.chatId, rec.state, rec.eventType, rec.userMsg,
      rec.replyText, rec.replySource, rec.bankKey ?? null, Date.now(),
    );
  }

  /** Fetch pending (not yet enriched) records, optionally limited to a date range. */
  listPending(sinceMs?: number, limit = 500): EnrichmentRecord[] {
    const since = sinceMs ?? 0;
    return this.db.db.prepare(`
      SELECT id, chat_id AS chatId, state, event_type AS eventType,
             user_msg AS userMsg, reply_text AS replyText,
             reply_source AS replySource, bank_key AS bankKey,
             created_at AS createdAt, enriched
      FROM enrichment_queue
      WHERE enriched = 0 AND created_at >= ?
      ORDER BY created_at ASC
      LIMIT ?
    `).all(since, limit) as EnrichmentRecord[];
  }

  /** Count pending records. */
  pendingCount(): number {
    const row = this.db.db.prepare(`
      SELECT COUNT(*) AS cnt FROM enrichment_queue WHERE enriched = 0
    `).get() as { cnt: number };
    return row.cnt;
  }

  /** Mark records as enriched (by IDs). */
  markEnriched(ids: number[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db.db.prepare(`
      UPDATE enrichment_queue SET enriched = 1 WHERE id IN (${placeholders})
    `).run(...ids);
  }

  /** Purge enriched records older than N days (keeps the DB small). */
  purgeOld(days = 30): number {
    const cutoff = Date.now() - days * 86_400_000;
    const res = this.db.db.prepare(`
      DELETE FROM enrichment_queue WHERE enriched = 1 AND created_at < ?
    `).run(cutoff);
    return res.changes;
  }
}
