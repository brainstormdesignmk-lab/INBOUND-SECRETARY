import { Db } from './db';

export type OwnerStatus = 'available' | 'sold' | 'rented' | 'under_option' | 'unknown';

export interface OwnerRow {
  eb: number;
  name: string;
  phone: string;
  status: OwnerStatus;
  windows: string | null;
  note: string;
  updatedAt: number;
}

export class OwnerStore {
  constructor(private db: Db) {}

  get(eb: number): OwnerRow | undefined {
    return this.db.db.prepare(
      `SELECT eb, name, phone, status, windows, note, updated_at as updatedAt
       FROM owners WHERE eb = ?`
    ).get(eb) as OwnerRow | undefined;
  }

  upsert(o: {
    eb: number;
    name?: string;
    phone?: string;
    status?: OwnerStatus;
    windows?: string[];
    note?: string;
  }): void {
    const existing = this.get(o.eb);
    this.db.db.prepare(
      `INSERT INTO owners (eb, name, phone, status, windows, note, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(eb) DO UPDATE SET
         name = COALESCE(excluded.name, owners.name),
         phone = COALESCE(excluded.phone, owners.phone),
         status = COALESCE(excluded.status, owners.status),
         windows = COALESCE(excluded.windows, owners.windows),
         note = COALESCE(excluded.note, owners.note),
         updated_at = excluded.updated_at`
    ).run(
      o.eb,
      o.name ?? existing?.name ?? '',
      o.phone ?? existing?.phone ?? '',
      o.status ?? existing?.status ?? 'available',
      o.windows ? JSON.stringify(o.windows) : (existing?.windows ?? null),
      o.note ?? existing?.note ?? '',
      Date.now()
    );
  }

  setStatus(eb: number, status: OwnerStatus, note = ''): void {
    this.db.db.prepare(
      `UPDATE owners SET status = ?, note = ?, updated_at = ? WHERE eb = ?`
    ).run(status, note, Date.now(), eb);
  }

  list(): OwnerRow[] {
    return this.db.db.prepare(
      `SELECT eb, name, phone, status, windows, note, updated_at as updatedAt
       FROM owners ORDER BY eb`
    ).all() as OwnerRow[];
  }
}
