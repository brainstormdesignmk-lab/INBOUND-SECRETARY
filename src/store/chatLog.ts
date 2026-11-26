// THE DURABLE CHAT TRANSCRIPT — one row per inbound turn.
//
// WHY (the V16K11 incident). The operator asked to read the live Viber chat
// from the appliance and the appliance could not produce it: a session's whole
// history lives in ONE `sessions` row, the idle sweeper deletes that row, and a
// restart leaves nothing at all. What survived was the enrichment queue (only
// the turns that raised an event) and the capture log (user text only). The
// first real conversation could not be reviewed — which is exactly when you
// need to review one.
//
// The audit record already holds the truth of every turn: the raw inbound text,
// every reply actually SENT (appended by `sendRaw`, the one function that hands
// bytes to the transport), the states and the lanes. This store appends that
// record to a table that nothing sweeps, so the transcript outlives the session,
// the process and the deploy.
//
// Written from `closeTurn` — the ONE place a turn ends — so no lane can forget
// to log itself, and a failed turn is recorded too.

import { Db } from './db';

export interface ChatLogRow {
  chatId: string;
  at: number;
  /** How long the turn took, from the first byte in to the last reply out.
   *  THE OPERATOR'S OWN QUESTION (the V16K11 slow turns): a client waited
   *  minutes for deterministic answers and nothing on the box recorded which
   *  turn was slow, so the delay could not be attributed after the fact. The
   *  audit already stamps `at` when the turn opens, so this is measured at the
   *  one turn-end seam and rendered next to the reply. */
  ms?: number;
  stateBefore: string;
  stateAfter: string;
  source?: string;
  bankKey?: string;
  lanes: string[];
  userText: string;
  replyText: string;
}

export interface ChatLogEntry extends ChatLogRow {
  id: number;
}

/** How long a transcript is kept. Long enough to review a real conversation
 *  weeks later; bounded so the appliance's disk does not grow forever. */
const RETENTION_DAYS = 120;
/** The retention sweep runs once every N appends (it is a range delete, not
 *  something to pay for on every turn). */
const SWEEP_EVERY = 250;

const SEP = '\n—\n';

export class ChatLogStore {
  private appends = 0;

  constructor(private db: Db) {
    this.db.db.exec(`CREATE TABLE IF NOT EXISTS chat_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id      TEXT    NOT NULL,
      at           INTEGER NOT NULL,
      state_before TEXT    NOT NULL DEFAULT '',
      state_after  TEXT    NOT NULL DEFAULT '',
      source       TEXT,
      bank_key     TEXT,
      lanes        TEXT    NOT NULL DEFAULT '',
      user_text    TEXT    NOT NULL DEFAULT '',
      reply_text   TEXT    NOT NULL DEFAULT ''
    )`);
    this.db.db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_log_chat ON chat_log(chat_id, at)`);
    // THE LATENCY COLUMN LANDED AFTER THE TABLE DID (an appliance's table keeps
    // the turns it already has): add it in place rather than recreate — a
    // transcript that must be dropped to gain a column is not a transcript.
    const cols = this.db.db.prepare('PRAGMA table_info(chat_log)').all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'ms')) {
      this.db.db.exec('ALTER TABLE chat_log ADD COLUMN ms INTEGER');
    }
  }

  /** Append one finished turn. Never throws into the turn (a transcript write
   *  must never break a reply) — the caller is the turn's own close hook. */
  append(row: ChatLogRow): void {
    try {
      this.db.db.prepare(`INSERT INTO chat_log
        (chat_id, at, ms, state_before, state_after, source, bank_key, lanes, user_text, reply_text)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        row.chatId, row.at, row.ms ?? null, row.stateBefore, row.stateAfter,
        row.source ?? null, row.bankKey ?? null, row.lanes.join(','),
        row.userText, row.replyText,
      );
      if (++this.appends % SWEEP_EVERY === 0) {
        const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
        this.db.db.prepare('DELETE FROM chat_log WHERE at < ?').run(cutoff);
      }
    } catch (e) {
      console.error('[chat-log] append failed:', (e as Error).message);
    }
  }

  /** One chat's transcript, oldest first. `limit` caps the TAIL (the newest N
   *  turns) — the dump script prints a long chat in pages. */
  recent(chatId: string, limit = 200): ChatLogEntry[] {
    const rows = this.db.db.prepare(`SELECT * FROM chat_log WHERE chat_id = ?
      ORDER BY at DESC, id DESC LIMIT ?`).all(chatId, limit) as Array<Record<string, unknown>>;
    return rows.reverse().map(r => ({
      id: Number(r.id),
      chatId: String(r.chat_id),
      at: Number(r.at),
      ms: r.ms === null || r.ms === undefined ? undefined : Number(r.ms),
      stateBefore: String(r.state_before ?? ''),
      stateAfter: String(r.state_after ?? ''),
      source: r.source === null ? undefined : String(r.source),
      bankKey: r.bank_key === null ? undefined : String(r.bank_key),
      lanes: String(r.lanes ?? '').split(',').filter(Boolean),
      userText: String(r.user_text ?? ''),
      replyText: String(r.reply_text ?? ''),
    }));
  }

  /** Chat ids that have a transcript, newest activity first. */
  chats(limit = 50): Array<{ chatId: string; turns: number; lastAt: number }> {
    const rows = this.db.db.prepare(`SELECT chat_id, COUNT(*) AS turns, MAX(at) AS last_at
      FROM chat_log GROUP BY chat_id ORDER BY last_at DESC LIMIT ?`).all(limit) as Array<Record<string, unknown>>;
    return rows.map(r => ({ chatId: String(r.chat_id), turns: Number(r.turns), lastAt: Number(r.last_at) }));
  }

  /** Render rows as the readable transcript the operator asked for. */
  static render(rows: ChatLogEntry[]): string {
    return rows.map(r => {
      const when = new Date(r.at).toISOString().replace('T', ' ').slice(0, 19);
      const head = `[${when}] ${r.chatId} · ${r.stateBefore}→${r.stateAfter}`
        + `${r.bankKey ? ` · ${r.bankKey}` : ''}`
        + `${r.ms != null ? ` · ${renderMs(r.ms)}` : ''}`;
      const reply = r.replyText || '(no reply)';
      return `${head}\n  klient: ${oneLine(r.userText)}\n  LINA:   ${reply.split(SEP).map(oneLine).join('\n          ')}`;
    }).join('\n\n');
  }
}

/** A turn over this long is a defect worth SEEING in the transcript, not a
 *  number to scroll past: the client waited through it. The threshold is the
 *  operator's own patience line (the V16K11 waits were 3–7 minutes). */
const SLOW_TURN_MS = 5_000;

function renderMs(ms: number): string {
  const shown = ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  return ms >= SLOW_TURN_MS ? `${shown} ⚠ БАВНО` : shown;
}

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' / ').trim();
}
