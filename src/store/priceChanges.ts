import { Db } from './db';

export interface PriceChangeRow {
  id: number;
  eb: number;
  oldPrice: number | null;
  newPrice: number;
  source: string;
  status: 'pending' | 'resolved';
  chatId: string;
  createdAt: number;
  resolvedAt: number | null;
}

/** The owner dictated a new price — recorded for Hermes to sync to the public
 *  app (Lovable/Cloudflare), then resolve. pending = not yet synced. */
export class PriceChangeStore {
  constructor(private db: Db) {}

  insert(p: { eb: number; oldPrice?: number | null; newPrice: number; chatId?: string; source?: string }): number {
    const info = this.db.db.prepare(
      `INSERT INTO price_changes (eb, old_price, new_price, source, chat_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      p.eb, p.oldPrice ?? null, p.newPrice, p.source ?? 'owner',
      p.chatId ?? '', Date.now()
    );
    return Number(info.lastInsertRowid);
  }

  listPending(): PriceChangeRow[] {
    return this.db.db.prepare(
      `SELECT id, eb, old_price as oldPrice, new_price as newPrice, source,
              status, chat_id as chatId, created_at as createdAt, resolved_at as resolvedAt
       FROM price_changes WHERE status = 'pending' ORDER BY created_at`
    ).all() as PriceChangeRow[];
  }

  resolve(id: number): void {
    this.db.db.prepare(
      `UPDATE price_changes SET status = 'resolved', resolved_at = ? WHERE id = ?`
    ).run(Date.now(), id);
  }
}
