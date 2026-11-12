import { Db } from './db';

export interface AppointmentRow {
  id: number;
  chatId: string;
  clientName: string;
  clientPhone: string;
  propertyId: number;
  service: string;
  viewingFee: string;
  status: 'pending' | 'finalized';
  time: string | null;
  agentPhone: string | null;
  createdAt: number;
}

export class AppointmentStore {
  constructor(private db: Db) {}

  insert(a: Omit<AppointmentRow, 'id' | 'createdAt' | 'status'>): number {
    const info = this.db.db.prepare(
      `INSERT INTO appointments (chat_id, client_name, client_phone, property_id, service, viewing_fee, time, agent_phone, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      a.chatId, a.clientName, a.clientPhone, a.propertyId, a.service, a.viewingFee,
      a.time ?? null, a.agentPhone ?? null, Date.now()
    );
    return Number(info.lastInsertRowid);
  }

  listByChat(chatId: string): AppointmentRow[] {
    return this.db.db.prepare(
      `SELECT id, chat_id as chatId, client_name as clientName, client_phone as clientPhone,
              property_id as propertyId, service, viewing_fee as viewingFee, status, time, agent_phone as agentPhone, created_at as createdAt
       FROM appointments WHERE chat_id = ? ORDER BY created_at DESC`
    ).all(chatId) as AppointmentRow[];
  }

  listAll(): AppointmentRow[] {
    return this.db.db.prepare(
      `SELECT id, chat_id as chatId, client_name as clientName, client_phone as clientPhone,
              property_id as propertyId, service, viewing_fee as viewingFee, status, time, agent_phone as agentPhone, created_at as createdAt
       FROM appointments ORDER BY created_at DESC`
    ).all() as AppointmentRow[];
  }

  markFinalized(id: number, time: string): void {
    this.db.db.prepare(`UPDATE appointments SET status = 'finalized', time = ? WHERE id = ?`).run(time, id);
  }

  /** Every CONFIRMED visit whose slot starts in [from, to) — the day calendar
   *  the chain solver and the taken-hour answer read. Only `finalized` rows
   *  carry a real term (`visit_at`); a pending row is still a negotiation and
   *  holds its slot through the handler's short hold window instead. */
  listVisitsBetween(from: number, to: number): Array<{ id: number; chatId: string; eb: number; visitAt: number }> {
    return this.db.db.prepare(
      `SELECT id, chat_id as chatId, property_id as eb, visit_at as visitAt
       FROM appointments
       WHERE status = 'finalized' AND visit_at IS NOT NULL AND visit_at >= ? AND visit_at < ?
       ORDER BY visit_at`
    ).all(from, to) as Array<{ id: number; chatId: string; eb: number; visitAt: number }>;
  }

  count(): number {
    const row = this.db.db.prepare(`SELECT COUNT(*) as c FROM appointments`).get() as { c: number };
    return row.c;
  }
}
