import { Db } from './db';

/** Persistent blocklist (3-strike protocol, ANA parity): a chat that reached
 *  strike 3 is blocked forever — checked at EVERY inbound, before the session
 *  TTL could otherwise reset it back to life.
 *
 *  The PHONE is the blocking key: in Viber the sender id IS the caller's
 *  number, so a repeat offender is caught even on a fresh chat. An entry with
 *  no phone (synthetic TUI/sim chatIds like "client-1") blocks NOTHING — a
 *  terminated SIM chat must never poison a real contact that later reuses the
 *  id. chat_id is still stored for the audit trail. */
export class BlocklistStore {
  constructor(private db: Db) {}

  isBlocked(chatId: string, phone?: string): boolean {
    const row = this.db.db.prepare(
      `SELECT id FROM blocklist
       WHERE phone != '' AND (phone = ? OR chat_id = ?) LIMIT 1`
    ).get(phone ?? '', chatId) as { id: number } | undefined;
    return !!row;
  }

  add(chatId: string, reason: string, phone?: string): void {
    this.db.db.prepare(
      `INSERT INTO blocklist (chat_id, phone, reason, created_at) VALUES (?, ?, ?, ?)`
    ).run(chatId, phone ?? '', reason, Date.now());
  }
}
