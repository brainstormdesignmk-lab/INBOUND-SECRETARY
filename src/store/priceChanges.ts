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

  insert(p: {
    eb: number; oldPrice?: number | null; newPrice: number; chatId?: string; source?: string;
    /** The owner's CLEAN prices on this change (owner-confirmation path) — the
     *  figure Hermes writes into the app's clean-price field. `newPrice` stays
     *  the FINAL price, so the existing public-price sync keeps working. */
    cleanOld?: number | null; cleanNew?: number | null; agencyPercent?: number | null;
  }): number {
    const info = this.db.db.prepare(
      `INSERT INTO price_changes (eb, old_price, new_price, source, chat_id, created_at, clean_old, clean_new, agency_percent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      p.eb, p.oldPrice ?? null, p.newPrice, p.source ?? 'owner',
      p.chatId ?? '', Date.now(),
      p.cleanOld ?? null, p.cleanNew ?? null, p.agencyPercent ?? null
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
