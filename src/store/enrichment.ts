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
  origin?: string;
  sourceRecordId?: number | null;
  reviewKey?: string | null;
  reviewStatus?: string;
  reviewReason?: string | null;
}

export class EnrichmentStore {
  constructor(private db: Db) { this.migrateAuditFields(); }

  private migrateAuditFields(): void {
    const columns = this.db.db.prepare('PRAGMA table_info(enrichment_queue)').all() as Array<{ name: string }>;
    const add = (name: string, sql: string): void => {
      if (!columns.some(column => column.name === name)) this.db.db.exec(sql);
    };
    add('source_id', `ALTER TABLE enrichment_queue ADD COLUMN source_id TEXT NOT NULL DEFAULT 'local'`);
    add('source_record_id', 'ALTER TABLE enrichment_queue ADD COLUMN source_record_id INTEGER');
    add('review_key', 'ALTER TABLE enrichment_queue ADD COLUMN review_key TEXT');
    add('review_status', `ALTER TABLE enrichment_queue ADD COLUMN review_status TEXT NOT NULL DEFAULT 'pending'`);
    add('review_reason', 'ALTER TABLE enrichment_queue ADD COLUMN review_reason TEXT');
    this.db.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_enrichment_source_record
      ON enrichment_queue(source_id, source_record_id) WHERE source_record_id IS NOT NULL`);
  }

  insert(rec: {
    chatId: string; state: string; eventType: string; userMsg: string;
    replyText: string; replySource: string; bankKey?: string; sourceId?: string;
  }): void {
    this.db.db.prepare(`
      INSERT INTO enrichment_queue (chat_id, state, event_type, user_msg, reply_text, reply_source, bank_key, created_at, source_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(rec.chatId, rec.state, rec.eventType, rec.userMsg, rec.replyText,
      rec.replySource, rec.bankKey ?? null, Date.now(), rec.sourceId ?? 'local');
  }

  /** Import immutable audit rows idempotently; source databases stay read-only. */
  importRecords(sourceId: string, records: readonly EnrichmentRecord[]): { added: number; duplicates: number } {
    if (!sourceId || sourceId === 'local') throw new Error('import sourceId must identify a machine');
    const insert = this.db.db.prepare(`
      INSERT OR IGNORE INTO enrichment_queue
        (chat_id,state,event_type,user_msg,reply_text,reply_source,bank_key,created_at,enriched,source_id,source_record_id,review_key,review_status,review_reason)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const tx = this.db.db.transaction(() => {
      let added = 0;
      for (const record of records) {
        const result = insert.run(record.chatId, record.state, record.eventType, record.userMsg,
          record.replyText, record.replySource, record.bankKey, record.createdAt, Number(record.enriched),
          sourceId, record.id, record.reviewKey ?? null, record.reviewStatus ?? 'pending', record.reviewReason ?? null);
        added += result.changes;
      }
      return added;
    });
    const added = tx();
    return { added, duplicates: records.length - added };
  }

  /** Retarget the review candidate without changing the original routing evidence. */
  setReviewKey(id: number, key: string): boolean {
    const target = key.trim();
    if (!target) return false;
    return this.db.db.prepare(`UPDATE enrichment_queue SET review_key = ? WHERE id = ?`).run(target, id).changes > 0;
  }

  /** Keep a human decision and explanation in the retained audit log. */
  setReviewStatus(id: number, status: string, reason: string | null = null): boolean {
    return this.db.db.prepare(`UPDATE enrichment_queue SET review_status = ?, review_reason = ? WHERE id = ?`)
      .run(status, reason, id).changes > 0;
  }

  listPending(sinceMs?: number, limit = 500): EnrichmentRecord[] {
    const since = sinceMs ?? 0;
    return this.db.db.prepare(`
      SELECT id, chat_id AS chatId, state, event_type AS eventType,
             user_msg AS userMsg, reply_text AS replyText, reply_source AS replySource,
             bank_key AS bankKey, created_at AS createdAt, enriched
      FROM enrichment_queue WHERE enriched = 0 AND created_at >= ? ORDER BY created_at ASC LIMIT ?
    `).all(since, limit) as EnrichmentRecord[];
  }

  rewriteReply(chatId: string, oldReply: string, newReply: string): number {
    const row = this.db.db.prepare(`SELECT id FROM enrichment_queue WHERE chat_id = ? AND reply_text = ? ORDER BY id DESC LIMIT 1`)
      .get(chatId, oldReply) as { id: number } | undefined;
    if (!row) return 0;
    return this.db.db.prepare(`UPDATE enrichment_queue SET reply_text = ? WHERE id = ?`).run(newReply, row.id).changes;
  }

  listRecent(limit = 8): EnrichmentRecord[] {
    return this.db.db.prepare(`
      SELECT id, chat_id AS chatId, state, event_type AS eventType, user_msg AS userMsg,
             reply_text AS replyText, reply_source AS replySource, bank_key AS bankKey,
             created_at AS createdAt, enriched FROM enrichment_queue ORDER BY id DESC LIMIT ?
    `).all(limit) as EnrichmentRecord[];
  }

  updateReply(id: number, text: string): boolean {
    const t = text.trim();
    if (!t) return false;
    return this.db.db.prepare(`UPDATE enrichment_queue SET reply_text = ? WHERE id = ?`).run(t, id).changes > 0;
  }

  setBankKey(id: number, key: string): boolean {
    const k = key.trim();
    if (!k) return false;
    return this.db.db.prepare(`UPDATE enrichment_queue SET bank_key = ? WHERE id = ?`).run(k, id).changes > 0;
  }

  byId(id: number): EnrichmentRecord | null {
    const row = this.db.db.prepare(`
      SELECT id, chat_id AS chatId, state, event_type AS eventType, user_msg AS userMsg,
             reply_text AS replyText, reply_source AS replySource, bank_key AS bankKey,
             created_at AS createdAt, enriched, source_id AS origin,
             source_record_id AS sourceRecordId, review_key AS reviewKey,
             review_status AS reviewStatus, review_reason AS reviewReason
      FROM enrichment_queue WHERE id = ?
    `).get(id) as EnrichmentRecord | undefined;
    return row ?? null;
  }

  findByReply(chatId: string, replyText: string): EnrichmentRecord | null {
    const row = this.db.db.prepare(`
      SELECT id, chat_id AS chatId, state, event_type AS eventType, user_msg AS userMsg,
             reply_text AS replyText, reply_source AS replySource, bank_key AS bankKey,
             created_at AS createdAt, enriched
      FROM enrichment_queue WHERE chat_id = ? AND reply_text = ? ORDER BY id DESC LIMIT 1
    `).get(chatId, replyText) as EnrichmentRecord | undefined;
    return row ?? null;
  }

  totalCount(): number {
    return (this.db.db.prepare(`SELECT COUNT(*) AS cnt FROM enrichment_queue`).get() as { cnt: number }).cnt;
  }

  pendingCount(): number {
    return (this.db.db.prepare(`SELECT COUNT(*) AS cnt FROM enrichment_queue WHERE enriched = 0`).get() as { cnt: number }).cnt;
  }

  markDynamicProcessed(): number {
    return this.db.db.prepare(`UPDATE enrichment_queue SET enriched = 1 WHERE enriched = 0 AND reply_source IN ('dynamic', 'dynamic-recall')`).run().changes;
  }

  questionsForKey(key: string, limit = 3): string[] {
    return (this.db.db.prepare(`SELECT user_msg AS userMsg FROM enrichment_queue WHERE bank_key = ? ORDER BY id DESC LIMIT ?`)
      .all(key, limit) as Array<{ userMsg: string }>).map(row => row.userMsg);
  }

  /** Full retained audit history, including source provenance and decisions. */
  listLog(limit = 5000): EnrichmentRecord[] {
    return this.db.db.prepare(`
      SELECT id, chat_id AS chatId, state, event_type AS eventType, user_msg AS userMsg,
             reply_text AS replyText, reply_source AS replySource, bank_key AS bankKey,
             created_at AS createdAt, enriched, source_id AS origin,
             source_record_id AS sourceRecordId, review_key AS reviewKey,
             review_status AS reviewStatus, review_reason AS reviewReason
      FROM enrichment_queue ORDER BY id DESC LIMIT ?
    `).all(limit) as EnrichmentRecord[];
  }

  latestForChat(chatId: string): { id: number; userMsg: string; bankKey: string | null; replyText: string; createdAt: number } | null {
    const row = this.db.db.prepare(`
      SELECT id, user_msg AS userMsg, bank_key AS bankKey, reply_text AS replyText, created_at AS createdAt
      FROM enrichment_queue WHERE chat_id = ? ORDER BY id DESC LIMIT 1
    `).get(chatId) as { id: number; userMsg: string; bankKey: string | null; replyText: string; createdAt: number } | undefined;
    return row ?? null;
  }

  markEnriched(ids: number[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db.db.prepare(`UPDATE enrichment_queue SET enriched = 1 WHERE id IN (${placeholders})`).run(...ids);
  }

  /** Processed turns are never purged: retention is part of the audit contract. */
  purgeOld(_days = 30): number { return 0; }
}
