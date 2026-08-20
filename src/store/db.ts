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
      -- v3: price changes dictated by the OWNER ("цената се промени на 60.000").
      -- Lina stores them so Hermes corrects the public app (Lovable/Cloudflare);
      -- status pending = not yet synced, resolved = Hermes applied the change.
      CREATE TABLE IF NOT EXISTS price_changes (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        eb          INTEGER NOT NULL,
        old_price   INTEGER,
        new_price   INTEGER NOT NULL,
        source      TEXT NOT NULL DEFAULT 'owner',
        status      TEXT NOT NULL DEFAULT 'pending',
        chat_id     TEXT NOT NULL DEFAULT '',
        created_at  INTEGER NOT NULL,
        resolved_at INTEGER
      );
      -- v4: approximate locations (landmarks) per property — resolved ONCE via
      -- the layered resolver (deterministic table -> Google/OSM -> Hermes) and
      -- cached here so live APIs are hit at most once per address EVER. The
      -- exact street address is NEVER stored here: only the public landmark.
      CREATE TABLE IF NOT EXISTS landmarks (
        address_key  TEXT PRIMARY KEY,
        landmark     TEXT NOT NULL,
        type         TEXT NOT NULL DEFAULT '',
        maps_url     TEXT,
        source       TEXT NOT NULL DEFAULT 'table',
        resolved_at  INTEGER NOT NULL
      );
      -- v4: scheduled visit notifications (turns 2+3 of the visit protocol;
      -- turn 1 "arranged" is sent inline at confirmation). status per party
      -- lets the operator log show who actually got each message.
      CREATE TABLE IF NOT EXISTS visit_turns (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        appointment_id INTEGER NOT NULL,
        turn           TEXT NOT NULL,             -- 'confirm' | 'location'
        scheduled_at   INTEGER NOT NULL,
        status         TEXT NOT NULL DEFAULT 'pending', -- pending|sent|skipped
        owner_status   TEXT NOT NULL DEFAULT 'pending', -- pending|sent|failed
        client_status  TEXT NOT NULL DEFAULT 'pending', -- pending|sent|failed
        sent_at        INTEGER,
        UNIQUE(appointment_id, turn)
      );
      -- v5: persistent blocklist (3-strike protocol, ANA parity) — a chat that
      -- reached strike 3 stays silent FOREVER, even after the session TTL would
      -- normally reset it. Keyed by chat_id (the Viber sender id IS the phone)
      -- and by the collected phone, so a repeat offender is caught on a fresh
      -- chat too. Chat_id is never blocked alone without a phone: TUI/sim ids
      -- are per-process, so a terminated SIM chat must not block a real number.
      CREATE TABLE IF NOT EXISTS blocklist (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id    TEXT NOT NULL,
        phone      TEXT NOT NULL DEFAULT '',
        reason     TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      -- v6: enrichment queue — LLM-backed responses logged for the midnight
      -- cron job that generates bank variants. No electricity / no internet
      -- needed to READ — the queue lives in SQLite (WAL mode = crash-safe).
      -- The cron job runs at 24:00; if missed, it catches up tomorrow.
      CREATE TABLE IF NOT EXISTS enrichment_queue (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id      TEXT NOT NULL,
        state        TEXT NOT NULL,             -- FSM state when LLM answered
        event_type   TEXT NOT NULL,             -- classified event type
        user_msg     TEXT NOT NULL,             -- the client's message
        reply_text   TEXT NOT NULL,             -- the LLM's response
        reply_source TEXT NOT NULL,             -- 'gemini:1', 'groq', etc.
        bank_key     TEXT,                      -- matched bank key (if any)
        created_at   INTEGER NOT NULL,
        enriched     INTEGER NOT NULL DEFAULT 0 -- 0=pending, 1=enriched
      );
      CREATE INDEX IF NOT EXISTS idx_enrichment_pending
        ON enrichment_queue(enriched, created_at);
    `);
    // v4 migration: the assigned agent's phone rides the appointment so the
    // visit protocol (turns 2+3) can name the agent without re-picking.
    const cols = this.db.prepare(`PRAGMA table_info(appointments)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'agent_phone')) {
      this.db.exec(`ALTER TABLE appointments ADD COLUMN agent_phone TEXT`);
    }
    // v4: the CONCRETE visit datetime (epoch ms), pinned at arrange time — the
    // visit protocol must not re-parse free text later ("утре" drifts).
    if (!cols.some(c => c.name === 'visit_at')) {
      this.db.exec(`ALTER TABLE appointments ADD COLUMN visit_at INTEGER`);
    }
  }

  close(): void {
    this.db.close();
  }
}
