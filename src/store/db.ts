import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import * as path from 'path';

export class Db {
  readonly db: Database.Database;

  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        chat_id    TEXT PRIMARY KEY,
        channel    TEXT NOT NULL,
        data       TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS appointments (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id      TEXT NOT NULL,
        client_name  TEXT NOT NULL,
        client_phone TEXT NOT NULL,
        property_id  INTEGER NOT NULL,
        service      TEXT NOT NULL,
        viewing_fee  TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'pending',
        time         TEXT,
        created_at   INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS escalations (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id    TEXT NOT NULL,
        customer   TEXT NOT NULL,
        history    TEXT NOT NULL,
        resolved   INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      -- v2: owner records (availability truth, never shown to clients)
      CREATE TABLE IF NOT EXISTS owners (
        eb         INTEGER PRIMARY KEY,
        name       TEXT NOT NULL DEFAULT '',
        phone      TEXT NOT NULL DEFAULT '',
        status     TEXT NOT NULL DEFAULT 'available', -- available|sold|rented|under_option|unknown
        windows    TEXT,                              -- JSON availability windows
        note       TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
      );
      -- v2: field agents (brokers) + per-service monthly visit quotas
      CREATE TABLE IF NOT EXISTS agents (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        name     TEXT NOT NULL,
        phone    TEXT NOT NULL,
        services TEXT NOT NULL DEFAULT 'sale,rent',
        on_duty  INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS agent_visits (
        agent_id INTEGER NOT NULL,
        service  TEXT NOT NULL,
        month    TEXT NOT NULL,
        count    INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (agent_id, service, month)
      );
      -- v2: queued customers (fee-refused warm leads, re-engaged by outbound)
      CREATE TABLE IF NOT EXISTS customers (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id          TEXT NOT NULL,
        phone            TEXT NOT NULL DEFAULT '',
        name             TEXT NOT NULL DEFAULT '',
        service          TEXT NOT NULL DEFAULT '',
        location         TEXT NOT NULL DEFAULT '',
        bedrooms         INTEGER,
        budget           TEXT NOT NULL DEFAULT '',
        refused_eb       INTEGER,
        reason           TEXT NOT NULL DEFAULT '',
        status           TEXT NOT NULL DEFAULT 'queued',
        created_at       INTEGER NOT NULL,
        last_contacted_at INTEGER
      );
      -- v2: event bus (owner checks, agent assignment, confirmations) —
      --      Lina writes requests; Hermes/sim/ops console answer them
      CREATE TABLE IF NOT EXISTS events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        type        TEXT NOT NULL,
        chat_id     TEXT NOT NULL,
        eb          INTEGER,
        payload     TEXT NOT NULL DEFAULT '{}',
        status      TEXT NOT NULL DEFAULT 'pending',
        created_at  INTEGER NOT NULL,
        resolved_at INTEGER
      );
    `);
  }

  close(): void {
    this.db.close();
  }
}
