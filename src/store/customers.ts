import { Db } from './db';

export interface CustomerRow {
  id: number;
  chatId: string;
  phone: string;
  name: string;
  service: string;
  location: string;
  bedrooms: number | null;
  budget: string;
  refusedEb: number | null;
  reason: string;
  status: string; // queued | contacted | client
  createdAt: number;
  lastContactedAt: number | null;
}

export interface CustomerInput {
  chatId: string;
  phone?: string;
  name?: string;
  service?: string;
  location?: string;
  bedrooms?: number;
  budget?: string;
  refusedEb?: number;
  reason?: string;
}

export class CustomerStore {
  constructor(private db: Db) {}

  getByChat(chatId: string): CustomerRow | undefined {
    return this.db.db.prepare(
      `SELECT id, chat_id as chatId, phone, name, service, location, bedrooms, budget,
              refused_eb as refusedEb, reason, status, created_at as createdAt,
              last_contacted_at as lastContactedAt
       FROM customers WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1`
    ).get(chatId) as CustomerRow | undefined;
  }

  /** Upsert: created on 1st fee refusal, updated on 3rd, promoted to 'client' after appointment. */
  upsert(input: CustomerInput, status?: string): number {
    const existing = this.getByChat(input.chatId);
    if (existing) {
      const sets: string[] = [];
      const vals: unknown[] = [];
      const push = (col: string, v: unknown) => {
        if (v !== undefined) { sets.push(`${col} = ?`); vals.push(v); }
      };
      push('phone', input.phone);
      push('name', input.name);
      push('service', input.service);
      push('location', input.location);
      push('bedrooms', input.bedrooms);
      push('budget', input.budget);
      push('refused_eb', input.refusedEb);
      push('reason', input.reason);
      if (status) {
        sets.push('status = ?'); vals.push(status);
        sets.push('last_contacted_at = ?'); vals.push(Date.now());
      }
      if (!sets.length) return existing.id;
      vals.push(existing.id);
      this.db.db.prepare(`UPDATE customers SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      return existing.id;
    }
    const info = this.db.db.prepare(
      `INSERT INTO customers (chat_id, phone, name, service, location, bedrooms, budget, refused_eb, reason, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      input.chatId, input.phone ?? '', input.name ?? '', input.service ?? '',
      input.location ?? '', input.bedrooms ?? null, input.budget ?? '',
      input.refusedEb ?? null, input.reason ?? '', status ?? 'queued', Date.now()
    );
    return Number(info.lastInsertRowid);
  }

  listQueued(): CustomerRow[] {
    return this.db.db.prepare(
      `SELECT id, chat_id as chatId, phone, name, service, location, bedrooms, budget,
              refused_eb as refusedEb, reason, status, created_at as createdAt,
              last_contacted_at as lastContactedAt
       FROM customers WHERE status != 'client' ORDER BY created_at DESC`
    ).all() as CustomerRow[];
  }
}
