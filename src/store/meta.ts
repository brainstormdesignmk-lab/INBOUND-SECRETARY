import { Db } from './db';

export class MetaStore {
  constructor(private db: Db) {}

  get(key: string): number {
    const row = this.db.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row ? Number(row.value) || 0 : 0;
  }

  set(key: string, value: number): void {
    this.db.db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(key, String(value));
  }

  increment(key: string, by = 1): number {
    const next = this.get(key) + by;
    this.set(key, next);
    return next;
  }
}
