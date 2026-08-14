import { Db } from './db';

export interface EscalationRow {
  id: number;
  chatId: string;
  customer: string;
  history: string;
  resolved: number;
  createdAt: number;
}

export class EscalationStore {
  constructor(private db: Db) {}

  insert(a: { chatId: string; customer: string; history: string }): number {
    const info = this.db.db.prepare(
      `INSERT INTO escalations (chat_id, customer, history, created_at) VALUES (?, ?, ?, ?)`
    ).run(a.chatId, a.customer, a.history, Date.now());
    return Number(info.lastInsertRowid);
  }

  listOpen(): EscalationRow[] {
    return this.db.db.prepare(
      `SELECT id, chat_id as chatId, customer, history, resolved, created_at as createdAt
       FROM escalations WHERE resolved = 0 ORDER BY created_at DESC`
    ).all() as EscalationRow[];
  }

  resolve(id: number): void {
    this.db.db.prepare(`UPDATE escalations SET resolved = 1 WHERE id = ?`).run(id);
  }
}
