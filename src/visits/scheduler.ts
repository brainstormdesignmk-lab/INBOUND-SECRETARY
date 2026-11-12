// VisitScheduler — the timed turns of the visit protocol.
//
// ONE EVENT = ONE MESSAGE. Turn 1 (the arranged line) is sent INLINE by the
// handler at booking; this scheduler owns Turn 0 and turns 2+3:
//   turn 'address_confirm' — Turn 0, to the OWNER, at arrange; then a 2-hour
//                      reminder loop (capped) until he confirms. While it is
//                      unresolved, turns 2 and 3 are HARD-BLOCKED: the client
//                      must never be handed a street nobody confirmed.
//   turn 'confirm'   — morning of the visit day: 09:00 (morning visit) or
//                      10:00 (afternoon visit, window 10:00-12:00). Multiple
//                      due visits are sent in visit-hour order (earliest
//                      visit hour first), per the agency's rule.
//   turn 'location'  — 2 hours before the visit: the EXACT location + maps
//                      link (the only address disclosure to the client).
// Every send is tracked per party (owner/client) in visit_turns, so a crash
// or double tick can never double-send; failures are recorded for the
// operator log. A free-text time that can't be resolved to a datetime marks
// the timed turns skipped once and tells the operator to confirm manually.
//
// THE OWNER IS A RECIPIENT, NOT AN IMPLIED ONE. A failed owner send (no phone
// on file, channel refusal) used to be swallowed while the turns stayed
// scheduled — the owner heard nothing for the whole visit. Every failure now
// escalates to the operator exactly once per turn (visit audit #4).

import { Db } from '../store/db';
import { EventStore } from '../store/events';
import { AddressChangeStore } from '../store/addressChanges';
import { OwnerStore } from '../store/owners';
import { PropertyService } from '../data/properties';
import type { OfflineMapStore } from '../geo/offlineMap';
import { parseVisitDateTime } from './time';
import {
  buildAddressConfirm, ADDRESS_CONFIRM_BUMP, buildAddressConfirmed,
  buildMorningConfirm, CLIENT_LOCATION_FOLLOWUP, buildLocationMsg, mapsLinkFor,
  buildOperatorLog, buildPlanLine, buildPlanReminder,
  buildAgentBrief, buildCancelledByClient, buildCancelledByOwner, Party,
} from './messages';

/** How often the owner is reminded that Turn 0 is still open. */
const ADDRESS_CONFIRM_BUMP_EVERY_MS = 2 * 3600_000;
/** Reminders per Turn 0 before the scheduler stops pinging the owner and asks
 *  the operator to confirm the address by hand. A reminder loop is not a
 *  harassment loop — and the client's turns stay blocked either way. */
const ADDRESS_CONFIRM_MAX_BUMPS = 4;

/** visit_turns.escalated bits — one warning per cause, per turn. */
const ESC_DELIVERY_FAILED = 1;
const ESC_STILL_UNCONFIRMED = 2;

export type TurnName = 'address_confirm' | 'confirm' | 'location' | 'plan_day_before';

export interface ArrangeInput {
  appointmentId: number;
  chatId: string;         // the CLIENT's chat id
  eb: number;
  time: string;           // free text, e.g. "петок 11.06 во 17:30"
  agentPhone: string;
  clientName: string;
  clientPhone: string;
  owner?: Party;
  /** How many stops the day's route has (the handler's solved chain). Omitted
   *  for an ordinary single visit; `>= 2` makes Turn 0 carry the plan line. */
  chainSize?: number;
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
  /** The visiting agent as a RECIPIENT. Absent today (a Viber bot can only
   *  write to a subscriber id; the agents table holds phone numbers), so the
   *  scheduler falls back to the operator with a ready-to-forward
   *  `[ЗА АГЕНТ …]` brief — never to the silent assumption that he knows. */
  notifyAgent?: (agentPhone: string, text: string) => Promise<boolean>;
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
  /** Turn-0 reminders sent so far (the capped bump loop). */
  bumps: number;
  /** 1 once the operator has been told about this turn's failure — the
   *  escalation must not repeat on every tick. */
  escalated: number;
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
      `SELECT id, appointment_id, turn, scheduled_at, status, owner_status, client_status,
              bumps, escalated
       FROM visit_turns WHERE appointment_id = ? AND turn = ?`
    ).get(appointmentId, turn) as TurnRow | undefined;
  }

  /** THE DISCLOSURE GATE. Turns 2 and 3 may only fire for an address the owner
   *  actually CONFIRMED: a missing row (visits arranged before Turn 0 existed)
   *  counts as confirmed, any other state does not. This is deliberately NOT
   *  `status !== 'pending'` — a skipped/reminder-capped Turn 0 is an
   *  UNCONFIRMED address, and the old test let that release the client's
   *  morning confirm and exact location (visit audit #3). */
  private addressConfirmed(appointmentId: number): boolean {
    const t = this.lookupTurn(appointmentId, 'address_confirm');
    return !t || t.status === 'sent';
  }

  /** Deliver to the owner; a refusal is a fact the operator must hear about,
   *  never a console.error nobody reads. */
  private async notifyOwnerSafe(clientChatId: string, eb: number, text: string): Promise<boolean> {
    try {
      await this.deps.notifyOwner(clientChatId, eb, text);
      return true;
    } catch (e) {
      console.error('[visit] owner notify failed:', (e as Error).message);
      return false;
    }
  }

  /** Escalate a delivered-once operator warning for one turn. The flag lives
   *  on the turn row so a restart (or a tick every minute) can never repeat it.
   *  It is a BITMASK because one turn can deserve two different warnings (a
   *  failed delivery AND a still-unconfirmed address after the reminder cap) —
   *  a single flag silently swallowed the second one. */
  private async escalateOnce(appointmentId: number, turn: TurnName, bit: number, text: string): Promise<void> {
    const t = this.lookupTurn(appointmentId, turn);
    if (!t || (t.escalated & bit)) return;
    this.db.db.prepare(`UPDATE visit_turns SET escalated = escalated | ? WHERE appointment_id = ? AND turn = ?`)
      .run(bit, appointmentId, turn);
    await this.deps.notifyOperator(text);
  }

  /** The visiting agent's brief: direct when a channel exists, otherwise the
   *  operator gets a complete forwardable copy. Either way the operator log
   *  says which path delivered it. */
  private async briefAgent(
    eb: number,
    when: Date,
    agentPhone: string,
    address: string,
    mapsUrl: string,
    client: Party,
  ): Promise<void> {
    const text = buildAgentBrief(eb, when, agentPhone || '—', address, mapsUrl, client);
    let delivered = false;
    if (this.deps.notifyAgent) {
      try {
        delivered = await this.deps.notifyAgent(agentPhone, text);
      } catch (e) {
        console.error('[visit] agent notify failed:', (e as Error).message);
      }
    }
    if (!delivered) {
      await this.deps.notifyOperator(
        `[ЛОГ ПОСЕТА ЕБ ${eb}] АГЕНТ: нема директен канал — брифот е даден на операторот за препраќање\n${text}`);
    }
  }

  private upsertTurn(appointmentId: number, turn: TurnName, scheduledAt: number, skipped: boolean): void {
    this.db.db.prepare(
      `INSERT INTO visit_turns (appointment_id, turn, scheduled_at, status, owner_status, client_status)
       VALUES (?, ?, ?, ?, 'pending', 'pending')
       ON CONFLICT(appointment_id, turn) DO NOTHING`
    ).run(appointmentId, turn, scheduledAt, skipped ? 'skipped' : 'pending');
  }

  /**
   * Called by the handler the moment the visit is confirmed. Turn 1 (the
   * arranged line) has ALREADY been sent to the client inline — this method
   * only LOGS it, sends Turn 0 to the owner, and schedules turns 2+3 (or marks
   * them skipped when the time is vague). The CONCRETE visit datetime is
   * pinned on the appointment so the timed turns never re-parse free text
   * against a later clock ("утре" drifts).
   */
  async arrange(input: ArrangeInput): Promise<void> {
    const visit = parseVisitDateTime(input.time, this.now);
    this.db.db.prepare(`UPDATE appointments SET visit_at = ? WHERE id = ?`)
      .run(visit ? visit.getTime() : null, input.appointmentId);

    const client: Party = { name: input.clientName, phone: input.clientPhone };

    if (!visit) {
      // Vague time — no timed turns. The CLIENT already has Turn 1 (the handler
      // sends the booking line before calling in), so a second arranged message
      // here was the double-notification of visit audit #1. The OWNER gets the
      // booking note: nothing else will reach him before the manual call.
      const note = `Договорена е посета за Евидентен број ${input.eb}; точниот термин „${input.time}“ ќе биде потврден телефонски.`;
      const ownerOk = await this.notifyOwnerSafe(input.chatId, input.eb, note);
      await this.deps.notifyOperator(buildOperatorLog(input.eb, 'arranged',
        input.owner, client, { owner: ownerOk ? 'OK' : 'FAIL', client: 'OK' },
        { when: undefined, agentPhone: input.agentPhone }));
      if (!ownerOk) {
        await this.deps.notifyOperator(
          `[ЛОГ ПОСЕТА ЕБ ${input.eb}] OWNER NOT REACHABLE — сопственикот не доби порака за посетата (нема телефон или каналот одби). Проверете го рачно.`);
      }
      this.upsertTurn(input.appointmentId, 'confirm', 0, true);
      this.upsertTurn(input.appointmentId, 'location', 0, true);
      await this.deps.notifyOperator(
        `[ЛОГ ПОСЕТА ЕБ ${input.eb}] термин не може да се планира: „${input.time}“ — потребна е рачна потврда на датум/час.`);
      return;
    }

    // Turn 0: address confirmation to OWNER ONLY. Turn 1 already went to the
    // client inline, so it is only LOGGED here (one event, one message).
    const prop = await this.deps.properties.getById(input.eb);
    const address = prop?.address ?? '';
    const mapsUrl = this.visitMapsLink(address, prop?.location);
    // THE OWNER'S OWN LINE OF THE DAY'S ROUTE (the owner's 2026-11-11 brief):
    // `PLANIRANA POSETA NA NEDVIZNOST <EB> — <day/hour> — AGENT <phone>` with the
    // street and the map, attached to the address-confirmation ask so one
    // message both asks for the confirmation and shows him what he is expecting.
    // Only for a real chain that day — a single visit is the address confirm.
    const chainThatDay = (input.chainSize ?? this.chainLengthForDay(input.chatId, visit)) >= 2;
    const planLine = chainThatDay
      ? `\n\n${buildPlanLine(input.eb, visit, input.agentPhone, { address, mapsUrl, withAddress: true })}`
      : '';
    const addrConfirm = `${buildAddressConfirm(input.eb, visit, address, mapsUrl)}${planLine}`;
    const ownerOk = await this.notifyOwnerSafe(input.chatId, input.eb, addrConfirm);

    await this.deps.notifyOperator(buildOperatorLog(input.eb, 'arranged',
      input.owner, client, { owner: '-//-', client: 'OK' },
      { when: visit, agentPhone: input.agentPhone }));
    await this.deps.notifyOperator(buildOperatorLog(input.eb, 'address_confirm',
      input.owner, client, { owner: ownerOk ? 'OK' : 'FAIL', client: '-//-' },
      { when: visit, address }));

    // Schedule the reminder loop for address confirmation. The turn STAYS
    // PENDING while the reminders go out: that is what keeps turns 2+3 blocked.
    const bumpAt = this.now.getTime() + ADDRESS_CONFIRM_BUMP_EVERY_MS;
    this.upsertTurn(input.appointmentId, 'address_confirm', bumpAt, false);
    if (!ownerOk) {
      // The failure is a FACT on the row (not just a log line): the operator
      // screen and the reminder loop both read it.
      this.db.db.prepare(
        `UPDATE visit_turns SET owner_status = 'failed' WHERE appointment_id = ? AND turn = 'address_confirm'`
      ).run(input.appointmentId);
      await this.escalateOnce(input.appointmentId, 'address_confirm', ESC_DELIVERY_FAILED,
        `[ЛОГ ПОСЕТА ЕБ ${input.eb}] OWNER NOT REACHABLE — Turn 0 (адреса) не е доставен: нема телефон на сопственикот или каналот одби. Клиентот НЕМА да добие Turn 2/3 додека адресата не се потврди. Потврдете рачно.`);
    }

    // Turns 2+3 are scheduled; both stay blocked until addressConfirmed().
    const confirmAt = this.confirmTime(visit).getTime();
    const locationAt = visit.getTime() - 2 * 3600_000;
    const skipGraceMs = 30 * 60_000;
    this.upsertTurn(input.appointmentId, 'confirm', confirmAt,
      confirmAt < this.now.getTime() - skipGraceMs);
    this.upsertTurn(input.appointmentId, 'location', locationAt,
      locationAt < this.now.getTime() - skipGraceMs);
    // THE DAY-BEFORE PLAN (the owner's 2026-11-11 brief): the client and every
    // owner get the day's route again the afternoon before, as one message.
    // Scheduled for EVERY arrangement, because the chain is built one booking
    // at a time — at the first arrange the second flat has no term yet, so a
    // `chain length >= 2` gate here silently left the FIRST stop without a
    // turn. The dispatch decides instead: a day that ended up with a single
    // visit is skipped there (Turn 2 covers it).
    {
      const dayBefore = new Date(visit.getFullYear(), visit.getMonth(), visit.getDate() - 1, 10, 0, 0, 0);
      this.upsertTurn(input.appointmentId, 'plan_day_before', dayBefore.getTime(),
        dayBefore.getTime() < this.now.getTime() - skipGraceMs);
    }
  }

  /** The chat's confirmed chain on that calendar day, in visit order. */
  private chainForDay(chatId: string, visit: Date): Array<{ id: number; eb: number; visitAt: number }> {
    const from = new Date(visit.getFullYear(), visit.getMonth(), visit.getDate()).getTime();
    return this.db.db.prepare(
      `SELECT id, property_id as eb, visit_at as visitAt FROM appointments
       WHERE chat_id = ? AND status = 'finalized' AND visit_at IS NOT NULL
         AND visit_at >= ? AND visit_at < ?
       ORDER BY visit_at, id`
    ).all(chatId, from, from + 24 * 3600_000) as Array<{ id: number; eb: number; visitAt: number }>;
  }

  /** How many confirmed visits this chat has on that calendar day (the chain a
   *  day-before plan would describe). */
  private chainLengthForDay(chatId: string, visit: Date): number {
    const from = new Date(visit.getFullYear(), visit.getMonth(), visit.getDate()).getTime();
    const row = this.db.db.prepare(
      `SELECT COUNT(*) as c FROM appointments
       WHERE chat_id = ? AND status = 'finalized' AND visit_at IS NOT NULL
         AND visit_at >= ? AND visit_at < ?`
    ).get(chatId, from, from + 24 * 3600_000) as { c: number } | undefined;
    return row?.c ?? 0;
  }

  /** The appointment id whose Turn 0 address confirmation is still awaiting
   *  the owner's reply for this client chat — null when nothing is pending.
   *  The owner-reply seam (TUI ownerInput / channel) uses this to route the
   *  owner's answer to confirmAddress() instead of dropping it with
   *  'нема активна проверка'. */
  pendingAddressConfirm(clientChatId: string): number | null {
    // ONLY A VISIT THAT HAS NOT HAPPENED YET can be awaiting an address. A
    // Turn 0 that was never answered stays `pending` on purpose (a late answer
    // is welcome), so without this bound an owner sentence WEEKS later would be
    // routed into an expired appointment's address check.
    const row = this.db.db.prepare(
      `SELECT a.id
       FROM appointments a
       JOIN visit_turns t ON t.appointment_id = a.id AND t.turn = 'address_confirm'
       WHERE a.chat_id = ? AND t.status = 'pending'
         AND (a.visit_at IS NULL OR a.visit_at + ? > ?)
       ORDER BY a.id DESC
       LIMIT 1`
    ).get(clientChatId, 2 * 3600_000, this.now.getTime()) as { id: number } | undefined;
    return row?.id ?? null;
  }

  /** Owner confirms or corrects the address. Called by the handler / TUI when
   *  the owner replies to the Turn 0 address confirmation.
   *  - If confirmed (no new address): the owner gets a short ACK.
   *  - If corrected (new address provided): updates the appointment, queues the
   *    correction for the app, and the owner gets the correction ack.
   *  The CLIENT is deliberately NOT written to here: Turn 1 (the arranged
   *  line) already went out at booking, and a second «ДОГОВОРЕНА ПОСЕТА» in a
   *  different format was the double-notification of visit audit #1.
   *  Resolving this turn is what UNBLOCKS turns 2+3. */
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
    // so turns 2+3 use the real address instead of the feed address…
    if (newAddress) {
      this.db.db.prepare(
        `UPDATE appointments SET corrected_address = ? WHERE id = ?`
      ).run(newAddress, appointmentId);

      // …AND queue it for the app. This used to stop at the appointment, so the
      // owner's correction was used in this one visit's turns while the public
      // listing kept the feed's wrong street forever. The owner is the source of
      // truth for the address exactly as for the price, and the SAME 5-minute
      // Hermes pass that carries prices now carries this (no extra schedule).
      let queuedNote = '';
      try {
        const propNow = await this.deps.properties.getById(eb);
        const queued = new AddressChangeStore(this.db).insertIfChanged({
          eb,
          oldAddress: propNow?.address ?? null,
          newAddress,
          chatId: row.chatId,
        });
        queuedNote = queued
          ? ' — queued for Hermes to publish to the app.'
          : ' — already correct/queued, nothing to publish.';
      } catch (e) {
        // The queue write must never break the visit protocol: the appointment
        // already carries the corrected address and the operator is told.
        queuedNote = ` — QUEUE WRITE FAILED (${(e as Error).message}); still local-only.`;
      }
      await this.deps.notifyOperator(
        `[ЛОГ ПОСЕТА ЕБ ${eb}] ADDRESS CORRECTED by owner: "${newAddress}"${queuedNote}`);
    }

    // Mark address_confirm as sent
    this.db.db.prepare(
      `UPDATE visit_turns SET status = 'sent', owner_status = 'sent', sent_at = ?
       WHERE appointment_id = ? AND turn = 'address_confirm'`
    ).run(Date.now(), appointmentId);

    // The FINAL address this visit will use (Turn 2 names no street, Turn 3
    // discloses this one).
    const prop = await this.deps.properties.getById(eb);
    const finalAddress = newAddress || prop?.address || '';
    const mapsUrl = this.visitMapsLink(finalAddress, prop?.location);
    const client: Party = { name: row.clientName, phone: row.clientPhone };

    // The owner's ACK — the only new event on this turn.
    const owner = this.deps.owners.get(eb);
    const ownerParty: Party | undefined = owner && (owner.name || owner.phone)
      ? { name: owner.name || 'Сопственик', phone: owner.phone || '?' }
      : undefined;
    const acked = await this.notifyOwnerSafe(row.chatId, eb, buildAddressConfirmed(eb, newAddress));
    if (!acked) {
      await this.escalateOnce(appointmentId, 'address_confirm', ESC_DELIVERY_FAILED,
        `[ЛОГ ПОСЕТА ЕБ ${eb}] OWNER ACK FAILED — адресата е потврдена од сопственикот, но потврдата не му е доставена. Проверете рачно.`);
    }
    await this.deps.notifyOperator(buildOperatorLog(eb, 'address_confirm', ownerParty, client,
      { owner: acked ? 'OK' : 'FAIL', client: '-//-' },
      { when: visit, address: finalAddress, agentPhone: row.agentPhone ?? undefined,
        note: newAddress ? 'АДРЕСА КОРИГИРАНА' : 'АДРЕСА ПОТВРДЕНА' }));

    // The agent finally has the dossier (via the operator until he has a
    // channel of his own) — the address he walks to is the FINAL one.
    await this.briefAgent(eb, visit, row.agentPhone ?? '', finalAddress, mapsUrl, client);
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

    // Mark all pending turns as skipped — the visit-day protocol must go quiet
    // too (the morning confirmation and the exact-location turn are scheduled
    // hours ahead; without this the client gets «ДОГОВОРЕНА ПОСЕТА» for a visit
    // they cancelled). The count is reported to the operator below: it is the
    // only record of which protocol messages were deliberately dropped.
    const skipped = this.db.db.prepare(
      `UPDATE visit_turns SET status = 'skipped' WHERE appointment_id = ? AND status = 'pending'`
    ).run(appointmentId).changes;

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
    // Which turns the cancellation silenced is part of the operator's picture:
    // "3 pending turns skipped" means the morning confirm + location never sent,
    // "0" means everything had already gone out and the client cancels on the
    // day (the operator may want to call the owner).
    const turnWord = skipped === 1 ? 'pending turn' : 'pending turns';
    await this.deps.notifyOperator(
      `[ЛОГ ПОСЕТА ЕБ ${eb}] CANCELLED by ${by} — ${skipped} ${turnWord} skipped — OWNER: ${ownerParty?.name ?? '?'} / CLIENT: ${row.clientName} (${row.clientPhone})`);
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
      // HARD BLOCK: turns 2+3 wait for a CONFIRMED address — not merely for a
      // Turn 0 that stopped being 'pending' (a reminder cap or a skip is an
      // unconfirmed address; releasing the client on it was visit audit #3).
      const addrConfirmDone = this.addressConfirmed(row.id);
      for (const turn of ['address_confirm', 'confirm', 'location', 'plan_day_before'] as TurnName[]) {
        const t = this.lookupTurn(row.id, turn);
        if (!t || t.status !== 'pending') continue;
        // Block every DISCLOSING turn while the address is still unconfirmed
        if ((turn === 'confirm' || turn === 'location' || turn === 'plan_day_before') && !addrConfirmDone) continue;
        // address_confirm uses its own scheduled_at (2h from arrange);
        // confirm and location are computed from the visit time.
        // A MORNING confirmation that arrives after Turn 3 is due is stale:
        // the location message supersedes it, and sending both would tell the
        // client «утринска потврда» + «ќе бидете известени 2 часа пред» +
        // «локација» one after another (visit audit #3's second half).
        if (turn === 'confirm' && this.now.getTime() >= visit.getTime() - 2 * 3600_000) {
          this.db.db.prepare(
            `UPDATE visit_turns SET status = 'skipped' WHERE appointment_id = ? AND turn = ? AND status = 'pending'`
          ).run(row.id, turn);
          await this.escalateOnce(row.id, turn, ESC_DELIVERY_FAILED,
            `[ЛОГ ПОСЕТА ЕБ ${row.propertyId}] TURN 2 SUPERSEDED — утринската потврда стана бесмислена (посетата е за помалку од 2 часа); Turn 3 го носи целиот термин.`);
          continue;
        }
        const at = turn === 'address_confirm' || turn === 'plan_day_before'
          ? new Date(t.scheduled_at)
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
    // Forcing a turn must not become a way around the disclosure gate: the
    // operator can force Turn 2/3 only for a CONFIRMED address.
    if (turn !== 'address_confirm' && !this.addressConfirmed(appointmentId)) {
      await this.deps.notifyOperator(
        `[ЛОГ ПОСЕТА] TURN ${turn === 'confirm' ? 2 : 3} NOT FORCED — адресата не е потврдена од сопственикот (ЕБ ${this.ebOf(appointmentId)}).`);
      return false;
    }
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

    const client: Party = { name: row.clientName, phone: row.clientPhone };
    const prop = await this.deps.properties.getById(eb);
    const addr = row.correctedAddress || (prop?.address ?? '');
    const mapsUrl = this.visitMapsLink(addr, prop?.location);

    // ── Turn 0 reminder: OWNER ONLY, looped, and it NEVER marks the turn
    // sent. Marking it sent is what used to release turns 2+3 on an address
    // nobody confirmed (visit audit #3).
    if (d.turn === 'address_confirm') {
      const delivered = await this.notifyOwnerSafe(row.chatId, eb, ADDRESS_CONFIRM_BUMP);
      const t = this.lookupTurn(row.id, 'address_confirm');
      const bumps = (t?.bumps ?? 0) + 1;
      const capped = bumps >= ADDRESS_CONFIRM_MAX_BUMPS;
      // Capped reminders stop the OWNER pings but the turn stays PENDING: the
      // owner may still answer hours later and confirmAddress() must accept it
      // (a 'skipped' row would refuse the late answer AND silently mean
      // "address unconfirmed" forever). The next ping is a day out, so the
      // loop is quiet; the visit-end sweep retires the row.
      const nextAt = capped
        ? this.now.getTime() + 24 * 3600_000
        : this.now.getTime() + ADDRESS_CONFIRM_BUMP_EVERY_MS;
      this.db.db.prepare(
        `UPDATE visit_turns SET bumps = ?, owner_status = ?, scheduled_at = ?
         WHERE appointment_id = ? AND turn = 'address_confirm'`
      ).run(bumps, delivered ? 'sent' : 'failed', nextAt, row.id);
      await this.deps.notifyOperator(buildOperatorLog(eb, 'address_confirm', ownerParty, client,
        { owner: delivered ? 'OK' : 'FAIL', client: '-//-' },
        { when: d.visit, address: addr, note: `ПОТСЕТНИК ${bumps}/${ADDRESS_CONFIRM_MAX_BUMPS}` }));
      if (!delivered) {
        await this.escalateOnce(row.id, 'address_confirm', ESC_DELIVERY_FAILED,
          `[ЛОГ ПОСЕТА ЕБ ${eb}] OWNER NOT REACHABLE — потсетникот за адресата не е доставен. Клиентот останува блокиран за Turn 2/3 додека адресата не се потврди.`);
      }
      if (capped) {
        await this.escalateOnce(row.id, 'address_confirm', ESC_STILL_UNCONFIRMED,
          `[ЛОГ ПОСЕТА ЕБ ${eb}] ADDRESS STILL UNCONFIRMED after ${ADDRESS_CONFIRM_MAX_BUMPS} reminders — сопственикот не одговори. Клиентот НЕ доби Turn 2 (утринска потврда) ни Turn 3 (локација). Потврдете ја адресата рачно или известете го клиентот.`);
      }
      return;
    }

    // ── DAY-BEFORE PLAN (the owner's 2026-11-11 brief): the day's whole route
    // once for the CLIENT (EB + hour only — the street stays in Turn 3), and
    // his OWN stop with the address + map for each OWNER (he is the source of
    // truth and must see what he is expecting). Only the first appointment of
    // the day sends the client's copy: the others would repeat the same plan.
    if (d.turn === 'plan_day_before') {
      const chain = this.chainForDay(row.chatId, d.visit);
      if (chain.length >= 2) {
        if (chain[0]!.id === row.id) {
          const plan = buildPlanReminder(
            chain.map(c => ({ eb: c.eb, when: new Date(c.visitAt) })),
            row.agentPhone ?? '',
          );
          try {
            await this.deps.notifyClient(row.chatId, plan);
          } catch (e) {
            console.error('[visit] plan day-before client send failed:', (e as Error).message);
            await this.escalateOnce(row.id, 'plan_day_before', ESC_DELIVERY_FAILED,
              `[ЛОГ ПОСЕТА] PLAN DAY-BEFORE NOT DELIVERED to the client — јавете му се.`);
          }
        }
        const ownerLine = buildPlanLine(eb, d.visit, row.agentPhone ?? '',
          { address: addr, mapsUrl, withAddress: true });
        const ownerOk = await this.notifyOwnerSafe(row.chatId, eb, ownerLine);
        this.db.db.prepare(
          `UPDATE visit_turns SET status = 'sent', owner_status = ?, client_status = ?, sent_at = ?
           WHERE appointment_id = ? AND turn = 'plan_day_before'`
        ).run(ownerOk ? 'sent' : 'failed', chain[0]!.id === row.id ? 'sent' : 'skipped',
          Date.now(), row.id);
        await this.deps.notifyOperator(buildOperatorLog(eb, 'plan_day_before', ownerParty, client,
          { owner: ownerOk ? 'OK' : 'FAIL', client: chain[0]!.id === row.id ? 'OK' : '-//-' },
          { when: d.visit, agentPhone: row.agentPhone ?? undefined }));
        if (!ownerOk) {
          await this.escalateOnce(row.id, 'plan_day_before', ESC_DELIVERY_FAILED,
            `[ЛОГ ПОСЕТА ЕБ ${eb}] OWNER TURN (plan day-before) NOT DELIVERED — сопственикот не ја доби пораката. Проверете го рачно.`);
        }
        return;
      }
      // A chain that shrank to one stop needs no plan message: Turn 2 covers it.
      this.db.db.prepare(
        `UPDATE visit_turns SET status = 'skipped' WHERE appointment_id = ? AND turn = 'plan_day_before'`
      ).run(row.id);
      return;
    }

    // ── Turn 2: morning confirmation, NO street (Turn 3 owns the disclosure).
    const text = d.turn === 'confirm'
      ? buildMorningConfirm(eb, d.visit, row.agentPhone ?? '')
      : buildLocationMsg(eb, d.visit, row.agentPhone ?? '', addr, mapsUrl);

    const status = await this.sendBoth({
      appointmentId: row.id, chatId: row.chatId, eb,
      time: row.time, agentPhone: row.agentPhone ?? '',
      clientName: row.clientName, clientPhone: row.clientPhone, owner: ownerParty,
    }, text);
    if (d.turn === 'confirm' && status.client === 'OK') {
      await this.deps.notifyClient(row.chatId, CLIENT_LOCATION_FOLLOWUP);
    }

    this.db.db.prepare(
      `UPDATE visit_turns SET status = 'sent', owner_status = ?, client_status = ?, sent_at = ?
       WHERE appointment_id = ? AND turn = ?`
    ).run(status.owner === 'OK' ? 'sent' : 'failed', status.client === 'OK' ? 'sent' : 'failed',
      Date.now(), row.id, d.turn);

    const detail = d.turn === 'confirm'
      ? { when: d.visit, agentPhone: row.agentPhone ?? undefined }
      : { when: d.visit, address: addr, agentPhone: row.agentPhone ?? undefined };
    await this.deps.notifyOperator(buildOperatorLog(eb, d.turn, ownerParty, client,
      { owner: status.owner === 'OK' ? 'OK' : 'FAIL', client: status.client === 'OK' ? 'OK' : '-//-' },
      detail));

    // Turn 3 carries the FINAL dossier to whoever walks the flat.
    if (d.turn === 'location') {
      await this.briefAgent(eb, d.visit, row.agentPhone ?? '', addr, mapsUrl, client);
    }

    if (status.owner !== 'OK') {
      await this.escalateOnce(row.id, d.turn, ESC_DELIVERY_FAILED,
        `[ЛОГ ПОСЕТА ЕБ ${eb}] OWNER TURN ${d.turn === 'confirm' ? 2 : 3} NOT DELIVERED — сопственикот не ја доби пораката. Проверете го рачно.`);
    }
    if (status.client !== 'OK') {
      await this.escalateOnce(row.id, d.turn, ESC_DELIVERY_FAILED,
        `[ЛОГ ПОСЕТА ЕБ ${eb}] CLIENT TURN ${d.turn === 'confirm' ? 2 : 3} NOT DELIVERED — клиентот не ја доби пораката. Јавете му се.`);
    }
  }

  /** The appointment's EB — only for operator-facing messages. */
  private ebOf(appointmentId: number): number | string {
    const row = this.db.db.prepare(`SELECT property_id FROM appointments WHERE id = ?`)
      .get(appointmentId) as { property_id: number } | undefined;
    return row?.property_id ?? appointmentId;
  }

  /** Background loop for the server/TUI. */
  start(intervalMs = 60_000): NodeJS.Timeout {
    const t = setInterval(() => { void this.tick().catch(e => console.error('[visit] tick failed:', (e as Error).message)); }, intervalMs);
    t.unref();
    return t;
  }
}
