// VisitScheduler — the timed turns of the visit protocol.
//
// Turn 1 (arranged) is sent INLINE by the handler at confirmation; this
// scheduler owns turns 2 and 3, fired by a periodic tick:
//   turn 'confirm'   — morning of the visit day: 09:00 (morning visit) or
//                      10:00 (afternoon visit, window 10:00-12:00). Multiple
//                      due visits are sent in visit-hour order (earliest
//                      visit hour first), per the agency's rule.
//   turn 'location'  — 2 hours before the visit: the EXACT location + maps
//                      link (the only allowed disclosure of the address).
// Every send is tracked per party (owner/client) in visit_turns, so a crash
// or double tick can never double-send; failures are recorded for the
// operator log. A free-text time that can't be resolved to a datetime marks
// the timed turns skipped once and tells the operator to confirm manually.

import { Db } from '../store/db';
import { EventStore } from '../store/events';
import { OwnerStore } from '../store/owners';
import { PropertyService } from '../data/properties';
import type { OfflineMapStore } from '../geo/offlineMap';
import { parseVisitDateTime } from './time';
import { buildArrangedVisit, buildMorningConfirm, CLIENT_LOCATION_FOLLOWUP, buildLocationMsg, mapsLinkFor, buildOperatorLog, buildAddressConfirm, ADDRESS_CONFIRM_BUMP, buildCancelledByClient, buildCancelledByOwner, Party } from './messages';

export type TurnName = 'address_confirm' | 'confirm' | 'location';

export interface ArrangeInput {
  appointmentId: number;
  chatId: string;         // the CLIENT's chat id
  eb: number;
  time: string;           // free text, e.g. "петок 11.06 во 17:30"
  agentPhone: string;
  clientName: string;
  clientPhone: string;
  owner?: Party;
}

export interface SchedulerDeps {
  db: Db;
  events: EventStore;
  owners: OwnerStore;
  properties: PropertyService;
  /** Local OSM map — geocodes the visit address to precise coordinates so
   *  the visit-day maps link is a clean `query=lat,lon` instead of a wall of
   *  percent-encoded Cyrillic. Optional: without it links fall back to the
   *  encoded-address form (still functional, just ugly). */
  offlineMap?: OfflineMapStore;
  notifyClient: (chatId: string, text: string) => Promise<void>;
  /** TUI shows owner messages in the owner panel (clientChatId); production
   *  sends to the owner's phone via the channel. */
  notifyOwner: (clientChatId: string, eb: number, text: string) => Promise<void>;
  /** The operator log: console + events + optional Viber message. */
  notifyOperator: (text: string) => Promise<void>;
  now?: () => Date;
}

interface TurnRow {
  id: number;
  appointment_id: number;
  turn: TurnName;
  scheduled_at: number;
  status: 'pending' | 'sent' | 'skipped';
  owner_status: 'pending' | 'sent' | 'failed';
  client_status: 'pending' | 'sent' | 'failed';
}

export class VisitScheduler {
  constructor(private deps: SchedulerDeps) {}

  /** Visit-day maps link: precise coordinates when the address geocodes
   *  locally (clean link, exact building), encoded-address fallback otherwise. */
  private visitMapsLink(address: string | undefined, location: string | undefined): string {
    let coords: { lat: number; lon: number } | undefined;
    if (address && this.deps.offlineMap?.available) {
      try { coords = this.deps.offlineMap.geocodeAddress(address) ?? undefined; } catch {}
    }
    return mapsLinkFor(address, location, coords);
  }

  private get now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private get db(): Db {
    return this.deps.db;
  }

  /** When the morning confirmation goes out on the visit day: 09:00 for a
   *  morning visit (first visit hour gets the first message, so due visits are
   *  processed in visit-hour order), 10:00 for an afternoon one. */
  private confirmTime(visit: Date): Date {
    const d = new Date(visit.getFullYear(), visit.getMonth(), visit.getDate());
    d.setHours(visit.getHours() < 12 ? 9 : 10, 0, 0, 0);
    return d;
  }

  private lookupTurn(appointmentId: number, turn: TurnName): TurnRow | undefined {
    return this.db.db.prepare(
      `SELECT id, appointment_id, turn, scheduled_at, status, owner_status, client_status
       FROM visit_turns WHERE appointment_id = ? AND turn = ?`
    ).get(appointmentId, turn) as TurnRow | undefined;
  }

  private upsertTurn(appointmentId: number, turn: TurnName, scheduledAt: number, skipped: boolean): void {
    this.db.db.prepare(
      `INSERT INTO visit_turns (appointment_id, turn, scheduled_at, status, owner_status, client_status)
       VALUES (?, ?, ?, ?, 'pending', 'pending')
       ON CONFLICT(appointment_id, turn) DO NOTHING`
    ).run(appointmentId, turn, scheduledAt, skipped ? 'skipped' : 'pending');
  }

  /**
   * Turn 1 — called by the handler the moment the visit is confirmed: both
   * parties get ДОГОВОРЕНА ПОСЕТА, the operator gets the ARRANGED log line,
   * and turns 2+3 are scheduled (or marked skipped when the time is vague).
   * The CONCRETE visit datetime is pinned on the appointment so the timed
   * turns never re-parse free text against a later clock ("утре" drifts).
   */
  async arrange(input: ArrangeInput): Promise<void> {
    const visit = parseVisitDateTime(input.time, this.now);
    this.db.db.prepare(`UPDATE appointments SET visit_at = ? WHERE id = ?`)
      .run(visit ? visit.getTime() : null, input.appointmentId);

    if (!visit) {
      // Vague time — send Turn 1 directly (no address confirm possible)
      const arranged = `ДОГОВОРЕНА ПОСЕТА НА ЕВИДЕНТЕН БРОЈ ${input.eb}; ${input.time}`;
      const ownerOk = await this.sendBoth(input, arranged);
      await this.deps.notifyOperator(buildOperatorLog(input.eb, 'arranged', input.owner,
        { name: input.clientName, phone: input.clientPhone }, ownerOk));
      this.upsertTurn(input.appointmentId, 'confirm', 0, true);
      this.upsertTurn(input.appointmentId, 'location', 0, true);
      await this.deps.notifyOperator(
        `[ЛОГ ПОСЕТА ЕБ ${input.eb}] термин не може да се планира: „${input.time}“ — потребна е рачна потврда на датум/час.`);
      return;
    }

    // Turn 0: send address confirmation to OWNER ONLY.
    // The client does NOT get Turn 1 until the owner confirms the address.
    const prop = await this.deps.properties.getById(input.eb);
    const address = prop?.address ?? '';
    const mapsUrl = this.visitMapsLink(address, prop?.location);
    const addrConfirm = buildAddressConfirm(input.eb, visit, address, mapsUrl);
    try {
      await this.deps.notifyOwner(input.chatId, input.eb, addrConfirm);
    } catch (e) {
      console.error('[visit] owner address-confirm failed:', (e as Error).message);
    }
    await this.deps.notifyOperator(
      `[ЛОГ ПОСЕТА ЕБ ${input.eb}] TURN 0 ADDRESS CONFIRM sent to owner — awaiting confirmation`);

    // Schedule the 2-hour bump for address confirmation
    const bumpAt = this.now.getTime() + 2 * 3600_000;
    this.upsertTurn(input.appointmentId, 'address_confirm', bumpAt, false);
    // Turns 2+3 are scheduled but Turn 1 is BLOCKED until address_confirm completes.
    const confirmAt = this.confirmTime(visit).getTime();
    const locationAt = visit.getTime() - 2 * 3600_000;
    const skipGraceMs = 30 * 60_000;
    this.upsertTurn(input.appointmentId, 'confirm', confirmAt,
      confirmAt < this.now.getTime() - skipGraceMs);
    this.upsertTurn(input.appointmentId, 'location', locationAt,
      locationAt < this.now.getTime() - skipGraceMs);
  }

  /** Owner confirms or corrects the address. Called by the handler when
   *  the owner replies to the Turn 0 address confirmation.
   *  - If confirmed (no new address): sends Turn 1 to client.
   *  - If corrected (new address provided): updates property, then sends Turn 1.
   *  After Turn 1, turns 2+3 continue as normal. */
  async confirmAddress(appointmentId: number, newAddress?: string): Promise<boolean> {
    const t = this.lookupTurn(appointmentId, 'address_confirm');
    if (!t || t.status !== 'pending') return false;
    const row = this.db.db.prepare(
      `SELECT id, chat_id as chatId, client_name as clientName, client_phone as clientPhone,
              property_id as propertyId, time, agent_phone as agentPhone, visit_at as visitAt,
              corrected_address as correctedAddress
       FROM appointments WHERE id = ?`
    ).get(appointmentId) as any;
    if (!row) return false;
    const visit = this.visitFor(row);
    if (!visit) return false;
    const eb = row.propertyId;

    // If the owner provided a corrected address, store it on the appointment
    // so turns 2+3 use the real address instead of the feed address.
    if (newAddress) {
      this.db.db.prepare(
        `UPDATE appointments SET corrected_address = ? WHERE id = ?`
      ).run(newAddress, appointmentId);
      await this.deps.notifyOperator(
        `[ЛОГ ПОСЕТА ЕБ ${eb}] ADDRESS CORRECTED by owner: "${newAddress}"`);
    }

    // Mark address_confirm as sent
    this.db.db.prepare(
      `UPDATE visit_turns SET status = 'sent', owner_status = 'sent', sent_at = ?
       WHERE appointment_id = ? AND turn = 'address_confirm'`
    ).run(Date.now(), appointmentId);

    // Build the corrected address line and Google Maps link for Turn 1
    const prop = await this.deps.properties.getById(eb);
    const finalAddress = newAddress || prop?.address || '';
    const mapsUrl = this.visitMapsLink(finalAddress, prop?.location);
    const addrLine = finalAddress ? `\nАдреса: ${finalAddress}\n${mapsUrl}` : '';
    const arranged = buildArrangedVisit(eb, visit, finalAddress);

    // Send Turn 1 to BOTH owner and client (owner already confirmed, client
    // needs the arranged message with the confirmed/corrected address).
    const owner = this.deps.owners.get(eb);
    const ownerParty: Party | undefined = owner && (owner.name || owner.phone)
      ? { name: owner.name || 'Сопственик', phone: owner.phone || '?' }
      : undefined;
    try {
      await this.deps.notifyClient(row.chatId, arranged);
    } catch (e) {
      console.error('[visit] client Turn 1 failed:', (e as Error).message);
    }
    try {
      await this.deps.notifyOwner(row.chatId, eb, arranged);
    } catch (e) {
      console.error('[visit] owner Turn 1 failed:', (e as Error).message);
    }
    await this.deps.notifyOperator(buildOperatorLog(eb, 'arranged', ownerParty,
      { name: row.clientName, phone: row.clientPhone }, { owner: 'OK', client: 'OK' }));
    return true;
  }

  /** Cancel a visit. Called when the client or owner says they can't make it.
   *  Marks all pending turns as skipped and sends the cancellation message
   *  to both parties. */
  async cancelVisit(appointmentId: number, by: 'client' | 'owner'): Promise<boolean> {
    const row = this.db.db.prepare(
      `SELECT id, chat_id as chatId, client_name as clientName, client_phone as clientPhone,
              property_id as propertyId, time, agent_phone as agentPhone, visit_at as visitAt
       FROM appointments WHERE id = ?`
    ).get(appointmentId) as any;
    if (!row) return false;
    const eb = row.propertyId;

    // Mark all pending turns as skipped
    this.db.db.prepare(
      `UPDATE visit_turns SET status = 'skipped' WHERE appointment_id = ? AND status = 'pending'`
    ).run(appointmentId);

    // Send cancellation message to BOTH parties
    const text = by === 'client'
      ? buildCancelledByClient(eb)
      : buildCancelledByOwner(eb);
    try {
      await this.deps.notifyClient(row.chatId, text);
    } catch (e) {
      console.error('[visit] client cancel notify failed:', (e as Error).message);
    }
    const owner = this.deps.owners.get(eb);
    try {
      await this.deps.notifyOwner(row.chatId, eb, text);
    } catch (e) {
      console.error('[visit] owner cancel notify failed:', (e as Error).message);
    }
    const ownerParty: Party | undefined = owner && (owner.name || owner.phone)
      ? { name: owner.name || 'Сопственик', phone: owner.phone || '?' }
      : undefined;
    await this.deps.notifyOperator(
      `[ЛОГ ПОСЕТА ЕБ ${eb}] CANCELLED by ${by} — OWNER: ${ownerParty?.name ?? '?'} / CLIENT: ${row.clientName} (${row.clientPhone})`);
    return true;
  }

  /** Send one text to owner AND client; returns the per-party statuses. */
  private async sendBoth(input: ArrangeInput, text: string): Promise<{ owner: 'OK' | 'FAIL'; client: 'OK' | 'FAIL' }> {
    const out = { owner: 'OK' as 'OK' | 'FAIL', client: 'OK' as 'OK' | 'FAIL' };
    try {
      await this.deps.notifyOwner(input.chatId, input.eb, text);
    } catch (e) {
      out.owner = 'FAIL';
      console.error('[visit] owner notify failed:', (e as Error).message);
    }
    try {
      await this.deps.notifyClient(input.chatId, text);
    } catch (e) {
      out.client = 'FAIL';
      console.error('[visit] client notify failed:', (e as Error).message);
    }
    return out;
  }

  /** The pinned visit datetime for an appointment (re-parse only as a last
   *  resort for rows arranged before the visit_at column existed). */
  private visitFor(row: { time: string; visitAt: number | null }): Date | undefined {
    if (row.visitAt) return new Date(row.visitAt);
    return parseVisitDateTime(row.time, this.now);
  }

  /** The periodic pass: fire every due turn exactly once. */
  async tick(): Promise<void> {
    const rows = this.db.db.prepare(
      `SELECT a.id, a.chat_id as chatId, a.client_name as clientName, a.client_phone as clientPhone,
              a.property_id as propertyId, a.time, a.agent_phone as agentPhone, a.visit_at as visitAt,
              a.corrected_address as correctedAddress, a.created_at as createdAt
       FROM appointments a WHERE a.status = 'finalized' AND a.time IS NOT NULL`
    ).all() as Array<{
      id: number; chatId: string; clientName: string; clientPhone: string;
      propertyId: number; time: string; agentPhone: string | null; visitAt: number | null;
      correctedAddress: string | null; createdAt: number;
    }>;

    // Due turns, visit-hour order for the morning batch.
    const due: Array<{ row: typeof rows[number]; turn: TurnName; visit: Date }> = [];
    for (const row of rows) {
      const visit = this.visitFor(row);
      if (!visit) continue; // already marked skipped at arrange
      // Defense-in-depth: never fire turns for a visit that already happened.
      // The arrange() skip handles the normal case; this catches stale rows
      // from before the fix or clock skew.
      const visitEnded = visit.getTime() + 2 * 3600_000 < this.now.getTime();
      // Block confirm/location until address_confirm is completed.
      const addrConfirmDone = !this.lookupTurn(row.id, 'address_confirm')
        || this.lookupTurn(row.id, 'address_confirm')!.status !== 'pending';
      for (const turn of ['address_confirm', 'confirm', 'location'] as TurnName[]) {
        const t = this.lookupTurn(row.id, turn);
        if (!t || t.status !== 'pending') continue;
        // Block turns 2+3 while address confirmation is still pending
        if ((turn === 'confirm' || turn === 'location') && !addrConfirmDone) continue;
        // address_confirm uses its own scheduled_at (2h from arrange);
        // confirm and location are computed from the visit time.
        const at = turn === 'address_confirm' ? new Date(t.scheduled_at)
          : turn === 'confirm' ? this.confirmTime(visit)
          : new Date(visit.getTime() - 2 * 3600_000);
        if (at.getTime() <= this.now.getTime()) {
          if (visitEnded) {
            this.db.db.prepare(
              `UPDATE visit_turns SET status = 'skipped' WHERE appointment_id = ? AND turn = ? AND status = 'pending'`
            ).run(row.id, turn);
            continue;
          }
          due.push({ row, turn, visit });
        }
      }
    }
    due.sort((a, b) =>
      (a.turn === b.turn ? a.visit.getTime() - b.visit.getTime() : 0) ||
      (a.turn === 'confirm' ? a.visit.getTime() - b.visit.getTime() : a.row.id - b.row.id));

    for (const d of due) {
      await this.dispatchTurn(d);
    }
  }

  /** TUI/testing: fire a specific turn NOW, regardless of its scheduled time
   *  (idempotent — a sent turn stays sent). */
  async forceTurn(appointmentId: number, turn: TurnName): Promise<boolean> {
    const t = this.lookupTurn(appointmentId, turn);
    if (!t || t.status !== 'pending') return false;
    const row = this.db.db.prepare(
      `SELECT id, chat_id as chatId, client_name as clientName, client_phone as clientPhone,
              property_id as propertyId, time, agent_phone as agentPhone, visit_at as visitAt,
              corrected_address as correctedAddress, created_at as createdAt
       FROM appointments WHERE id = ?`
    ).get(appointmentId) as any;
    if (!row) return false;
    const visit = this.visitFor(row);
    if (!visit) return false;
    await this.dispatchTurn({
      row, turn: turn, visit,
    });
    return true;
  }

  /** Send one due turn to both parties + operator log (idempotent caller). */
  private async dispatchTurn(d: { row: any; turn: TurnName; visit: Date }): Promise<void> {
    const row = d.row;
    const eb = row.propertyId;
    const owner = this.deps.owners.get(eb);
    const ownerParty: Party | undefined = owner && (owner.name || owner.phone)
      ? { name: owner.name || 'Сопственик', phone: owner.phone || '?' }
      : undefined;

    let text: string;
    let followup = false;
    let ownerOnly = false;
    if (d.turn === 'address_confirm') {
      // Turn 0 bump: remind the owner to confirm the address
      text = ADDRESS_CONFIRM_BUMP;
      ownerOnly = true;
    } else if (d.turn === 'confirm') {
      const prop = await this.deps.properties.getById(eb);
      const addr = row.correctedAddress || prop?.address;
      text = buildMorningConfirm(eb, d.visit, row.agentPhone ?? '', addr);
      followup = true;
    } else {
      const prop = await this.deps.properties.getById(eb);
      // Use owner-corrected address if available; fall back to feed address
      const addr = row.correctedAddress || (prop?.address ?? '');
      text = buildLocationMsg(eb, d.visit, row.agentPhone ?? '', addr, this.visitMapsLink(addr, prop?.location));
    }

    let status;
    if (ownerOnly) {
      // Address-confirm bump goes to OWNER ONLY — the client is not involved
      const out = { owner: 'OK' as 'OK' | 'FAIL', client: '-//-' as 'OK' | 'FAIL' | '-//-' };
      try {
        await this.deps.notifyOwner(row.chatId, eb, text);
      } catch (e) {
        out.owner = 'FAIL';
        console.error('[visit] owner bump failed:', (e as Error).message);
      }
      status = out;
    } else {
      status = await this.sendBoth({
        appointmentId: row.id, chatId: row.chatId, eb,
        time: row.time, agentPhone: row.agentPhone ?? '',
        clientName: row.clientName, clientPhone: row.clientPhone, owner: ownerParty,
      }, text);
    }
    if (followup && status.client === 'OK') {
      await this.deps.notifyClient(row.chatId, CLIENT_LOCATION_FOLLOWUP);
    }

    this.db.db.prepare(
      `UPDATE visit_turns SET status = 'sent', owner_status = ?, client_status = ?, sent_at = ?
       WHERE appointment_id = ? AND turn = ?`
    ).run(status.owner === 'OK' ? 'sent' : 'failed', status.client === 'OK' ? 'sent' : '-//-',
      Date.now(), row.id, d.turn);

    const logTurn = d.turn === 'address_confirm' ? 'arranged' : d.turn === 'confirm' ? 'confirm' : 'location';
    await this.deps.notifyOperator(buildOperatorLog(eb, logTurn, ownerParty,
      { name: row.clientName, phone: row.clientPhone },
      { owner: status.owner === 'OK' ? 'OK' : 'FAIL', client: status.client === 'OK' ? 'OK' : '-//-' }));
  }

  /** Background loop for the server/TUI. */
  start(intervalMs = 60_000): NodeJS.Timeout {
    const t = setInterval(() => { void this.tick().catch(e => console.error('[visit] tick failed:', (e as Error).message)); }, intervalMs);
    t.unref();
    return t;
  }
}
