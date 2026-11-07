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

  /** TEXT values on the same table (the column is TEXT; the numeric helpers
   *  above simply coerce). Used for durable, restart-safe keys whose value is
   *  not a counter — e.g. the replay record of an owner transport message, so
   *  a retried webhook answers with the SAME text instead of serving a second
   *  turn of the conversation. */
  getText(key: string): string | undefined {
    const row = this.db.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row?.value;
  }

  setText(key: string, value: string): void {
    this.db.db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(key, value);
  }
}
