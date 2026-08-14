import { Db } from './db';

export type EventType =
  | 'owner_check_requested'
  | 'owner_check_result'
  | 'agent_assigned'
  | 'visit_confirmed'
  | 'customer_reengage';

export interface EventRow {
  id: number;
  type: EventType;
  chatId: string;
  eb: number | null;
  payload: string; // JSON
  status: 'pending' | 'resolved';
  createdAt: number;
  resolvedAt: number | null;
}

export class EventStore {
  constructor(private db: Db) {}

  insert(type: EventType, chatId: string, eb: number | null, payload: Record<string, unknown> = {}): number {
    const info = this.db.db.prepare(
      `INSERT INTO events (type, chat_id, eb, payload, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`
    ).run(type, chatId, eb, JSON.stringify(payload), Date.now());
    return Number(info.lastInsertRowid);
  }

  resolve(id: number): void {
    this.db.db.prepare(
      `UPDATE events SET status = 'resolved', resolved_at = ? WHERE id = ?`
    ).run(Date.now(), id);
  }

  listPending(type?: EventType): EventRow[] {
    if (type) {
      return this.db.db.prepare(
        `SELECT id, type, chat_id as chatId, eb, payload, status, created_at as createdAt, resolved_at as resolvedAt
         FROM events WHERE status = 'pending' AND type = ? ORDER BY created_at`
      ).all(type) as EventRow[];
    }
    return this.db.db.prepare(
      `SELECT id, type, chat_id as chatId, eb, payload, status, created_at as createdAt, resolved_at as resolvedAt
       FROM events WHERE status = 'pending' ORDER BY created_at`
    ).all() as EventRow[];
  }

  listByChat(chatId: string): EventRow[] {
    return this.db.db.prepare(
      `SELECT id, type, chat_id as chatId, eb, payload, status, created_at as createdAt, resolved_at as resolvedAt
       FROM events WHERE chat_id = ? ORDER BY created_at DESC LIMIT 50`
    ).all(chatId) as EventRow[];
  }
}
