import { Db } from './db';

// AddressChangeStore — the owner's corrected ADDRESS, queued for the app.
//
// The exact mirror of PriceChangeStore, for the same reason and with the same
// contract. Lina confirms the address with the owner before a visit (Turn 0);
// when the owner answers with a different address than the feed's, the owner is
// the source of truth. Until this store existed the correction stopped at
// `appointments.corrected_address` — used for turns 2+3 of that one visit — and
// the public listing kept the feed's wrong street forever.
//
// What writes here: Scheduler.confirmAddress (src/visits/scheduler.ts), the one
// place the owner's answer is parsed.
// What drains it: the SAME 5-minute Hermes pass as prices (src/scripts/hermes.ts)
// → T60 Hub /ingest/address → update-property-address edge function. One job,
// two syncs — no extra schedule.
//
// status: 'pending' = not yet on the app, 'resolved' = applied (2xx from the
// function). A failed push leaves the row pending, so a hub outage DELAYS a
// correction instead of losing it.

export interface AddressChangeRow {
  id: number;
  eb: number;
  oldAddress: string | null;
  newAddress: string;
  source: string;
  status: 'pending' | 'resolved';
  chatId: string;
  createdAt: number;
  resolvedAt: number | null;
}

export class AddressChangeStore {
  constructor(private db: Db) {}

  /**
   * Queue a correction, unless it is redundant:
   *   - the new address equals the one already stored (nothing to change), or
   *   - an identical correction is already PENDING (the owner may confirm the
   *     same address on a later visit — one queue row, not five).
   * Returns true when a row was written.
   */
  insertIfChanged(p: {
    eb: number;
    oldAddress?: string | null;
    newAddress: string;
    chatId?: string;
    source?: string;
  }): boolean {
    const next = p.newAddress.trim();
    if (!next) return false;

    const old = (p.oldAddress ?? '').trim();
    if (old && sameAddress(old, next)) return false; // already what the app has

    // Dedupe in JS, not SQL: SQLite's lower() is ASCII-only, so a Cyrillic
    // address ("Васил Стефановски 16") would never match its lowercased twin.
    const pending = this.db.db.prepare(
      `SELECT new_address as newAddress FROM address_changes WHERE eb = ? AND status = 'pending'`
    ).all(p.eb) as Array<{ newAddress: string }>;
    if (pending.some(r => sameAddress(r.newAddress, next))) return false;

    this.db.db.prepare(
      `INSERT INTO address_changes (eb, old_address, new_address, source, chat_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(p.eb, old || null, next, p.source ?? 'owner', p.chatId ?? '', Date.now());
    return true;
  }

  listPending(): AddressChangeRow[] {
    return this.db.db.prepare(
      `SELECT id, eb, old_address as oldAddress, new_address as newAddress, source,
              status, chat_id as chatId, created_at as createdAt, resolved_at as resolvedAt
       FROM address_changes WHERE status = 'pending' ORDER BY created_at`
    ).all() as AddressChangeRow[];
  }

  resolve(id: number): void {
    this.db.db.prepare(
      `UPDATE address_changes SET status = 'resolved', resolved_at = ? WHERE id = ?`
    ).run(Date.now(), id);
  }
}

/** Same building, written two ways ("ул. Партизанска 16" vs "Partizanska 16, 16"). */
export function sameAddress(a: string, b: string): boolean {
  const norm = (s: string) => s
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^(ул|бул|ул\.|бул\.)\s*/, '')
    .trim();
  return norm(a) === norm(b);
}
