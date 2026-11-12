// The visit-protocol messages — the exact staged disclosures the agency uses
// to keep the property address secret until the visit is locked in.
//
// ONE EVENT = ONE MESSAGE. Each turn below is delivered by exactly one site:
//
//   Turn 0 (at arrange)                — address confirm (OWNER only)
//   Turn 1 (at booking, inline in the handler) — DOGOVORENA POSETA (CLIENT)
//   Turn 2 (morning of the visit day)  — confirmation + agent contact (BOTH)
//   Turn 3 (2 hours before the visit)  — EXACT location + maps link (BOTH)
//
// Turn 1 is NOT the scheduler's: the handler sends the booking line
// (`buildVisitConfirmation`) the moment the owner agrees the term, and the
// scheduler must never send a second «ДОГОВОРЕНА ПОСЕТА» when the owner later
// confirms the address — two different formats for one event is exactly the
// double-notification this protocol had (#1 in the visit audit).
//
// ADDRESS DISCIPLINE: the street appears in the OWNER's Turn 0 (he is the
// source of truth and must see what he is confirming) and in the client's
// Turn 3 (the visit is already arranged by then, the client can no longer
// bypass the agency). It appears NOWHERE ELSE — Turn 2 names the agent and the
// term but no street, so a client cannot reach the flat hours early.
//
// These are protocol lines with structured fields — code-built, never
// LLM-written, so the format can't drift.

import { formatDateOnly, formatTimeOnly } from './time';
import { googleMapsLink } from '../geo/landmarks';
import { fullCoordsLink } from '../geo/precision';

/** Turn 0 — sent to OWNER ONLY: confirm the property address is correct.
 *  The client does NOT see this message; Turn 1 already went out at booking.
 *  Turn 2/3 wait for this answer. Includes the written address for elderly
 *  people who can't use Google Maps. */
export function buildAddressConfirm(eb: number, when: Date, address: string, mapsUrl: string): string {
  return `ДОГОВОРЕНА ПОСЕТА НА ЕВИДЕНТЕН БРОЈ ${eb}; ${formatDateOnly(when)}; ${formatTimeOnly(when)}\nАдреса: ${address}\n${mapsUrl}\n\nМи треба потврда од ваша страна за точната локација на недвижноста. Дали адресата е точна?`;
}

/** Turn 0 bump — sent to OWNER when no address confirmation received.
 *  Sent every 2 hours until the owner confirms, capped by the scheduler (a
 *  reminder is not a loop: it used to fire once, mark the turn sent and
 *  silently release the client's Turn 2/3 with an address nobody confirmed). */
export const ADDRESS_CONFIRM_BUMP =
  'Ми треба ваша потврда за точноста на локацијата, за организирање на посетата.';

/** Cancellation by CLIENT — sent to both owner and client. */
export function buildCancelledByClient(eb: number): string {
  return `Откажана посета по желба на клиент за Евидентен број ${eb}.\n\nМетрополис се извинува за непланираните околности.\nЌе бидеме во контакт.`;
}

/** The AMBIGUOUS-cancel ask — sent to the client when the chat has more than
 *  one arranged visit and the message does not say which one. Cancelling the
 *  wrong Евидентен број is worse than one extra question: the owner of an
 *  untouched property gets told his visit is off (the [21:57] capture). */
export function buildCancelWhichAsk(ebs: number[]): string {
  const list = ebs.length > 0 ? ` Моментално имаме договорени посети за Евидентен број ${ebs.join(' и ')}.` : '';
  return `За која посета се работи?${list} Кажете ми го Евидентниот број на недвижноста за да ја откажам вистинската посета.`;
}

/** Cancellation by OWNER — sent to both owner and client. */
export function buildCancelledByOwner(eb: number): string {
  return `Откажана посета по желба на сопственикот за Евидентен број ${eb}.\n\nМетрополис се извинува за непланираните околности.\nЌе бидеме во контакт.`;
}

/** The owner's ACK after he confirms the address. It replaces the old second
 *  «ДОГОВОРЕНА ПОСЕТА» block: the visit was already arranged at booking (the
 *  client has Turn 1), so the only new event here is HIS confirmation. */
export function buildAddressConfirmed(eb: number, correctedAddress?: string): string {
  return correctedAddress
    ? `Ви благодарам — ја запишав корегираната адреса за Евидентен број ${eb}: ${correctedAddress}. Ќе ја користам за посетата.`
    : `Ви благодарам — адресата за Евидентен број ${eb} е потврдена. Ќе Ве известам пред посетата.`;
}

/** Turn 2 — morning confirmation, sent to BOTH, with the agent contact and
 *  NO street (Turn 3 owns the disclosure). */
export function buildMorningConfirm(eb: number, when: Date, agentPhone: string): string {
  return `ДОГОВОРЕНА ПОСЕТА НА ЕВИДЕНТЕН БРОЈ ${eb}; ${formatDateOnly(when)}; ${formatTimeOnly(when)}; АГЕНТ ЗА КОНТАКТ ${agentPhone}`;
}

/** The client's re-ping when the owner check has outlived its window and the
 *  funnel is still waiting. Without it «ќе Ве известам штом потврдам» could
 *  stand forever with no further word (visit audit #5). */
export const OWNER_CHECK_STILL_WAITING =
  'Терминот сè уште го проверувам со сопственикот. Ќе Ве известам веднаш штом добијам потврда.';

/** The visiting agent's brief. The agent has no channel of his own today (a
 *  Viber bot can only write to a subscriber id, and the agents table stores
 *  phone numbers), so this is delivered through the OPERATOR with the `[ЗА
 *  АГЕНТ]` prefix — one copy to forward, complete, instead of a phone number
 *  that only appears inside the client's copy (visit audit #6). */
export function buildAgentBrief(
  eb: number,
  when: Date,
  agentPhone: string,
  address: string,
  mapsUrl: string,
  client: Party,
): string {
  return `[ЗА АГЕНТ ${agentPhone}] ПОСЕТА ЕБ ${eb} — ${formatDateOnly(when)} во ${formatTimeOnly(when)}\n`
    + `КЛИЕНТ: ${client.name} (${client.phone})\n`
    + `АДРЕСА: ${address}${mapsUrl ? `\n${mapsUrl}` : ''}`;
}

/** Turn 2 — the client's follow-up after the morning confirmation. */
export const CLIENT_LOCATION_FOLLOWUP =
  'Ќе бидете известени за деталите и локацијата 2 часа пред посетата.';

/**
 * Turn 3 — the EXACT location, 2 hours before the visit, to BOTH. The maps
 * link is the one allowed disclosure of the real address (visit arranged).
 */
export function buildLocationMsg(eb: number, when: Date, agentPhone: string, address: string, mapsUrl: string): string {
  return `ЛОКАЦИЈА ЗА ЕВИДЕНТЕН БРОЈ ${eb}; ${formatDateOnly(when)}; ${formatTimeOnly(when)}; АГЕНТ ЗА КОНТАКТ ${agentPhone}\nАдреса: ${address}\n${mapsUrl}`;
}

/** Google Maps link for the REAL address (visit day) — built through the
 *  shared googleMapsLink so the customer always lands on Google Maps, never
 *  OSM. No API key needed.
 *  Coordinates PREFERRED, in the short @-view form: the written address is
 *  already in the message text, and putting it in the URL too would make a
 *  long percent-encoded Cyrillic link that the operator console truncates
 *  (the class of failure that produced "Google Maps can't find 41.99560" and
 *  the stray "П " search). The @-view opens the map exactly at the building.
 *  The address query is the fallback when no coordinates exist. */
export function mapsLinkFor(address: string | undefined, location: string | undefined, coords?: { lat: number; lon: number }): string {
  if (coords) return fullCoordsLink(coords.lat, coords.lon);
  if (address) return googleMapsLink([address, location, 'Скопје'].filter(Boolean).join(', '));
  return googleMapsLink([location, 'Скопје'].filter(Boolean).join(', '));
}

export interface Party { name: string; phone: string; }

/** THE PLANNED-VISIT LINE (owner-dictated format, the owner's 2026-11-11
 *  brief): `PLANIRANA POSETA NA NEDVIZNOST <EB> — <DAY> VO <HH:MM> — AGENT
 *  <phone>`, plus the address + map when the recipient is allowed them.
 *
 *  ADDRESS DISCIPLINE (the two owners' answers): the OWNER always gets the
 *  street and the map — he is the source of truth. The CLIENT's copy carries
 *  the EB and the hour ONLY; his street arrives in Turn 3, two hours before
 *  the visit. `withAddress` is what makes that difference explicit at every
 *  call site instead of a default nobody remembers. */
export function buildPlanLine(
  eb: number,
  when: Date,
  agentPhone: string,
  opts: { address?: string; mapsUrl?: string; withAddress?: boolean } = {},
): string {
  const head = `PLANIRANA POSETA NA NEDVIZNOST ${eb} — ${formatDateOnly(when)} VO ${formatTimeOnly(when)} — AGENT ${agentPhone || '—'}`;
  if (!opts.withAddress) return head;
  const addr = opts.address ? `\nАдреса: ${opts.address}` : '';
  const map = opts.mapsUrl ? `\n${opts.mapsUrl}` : '';
  return `${head}${addr}${map}`;
}

/** THE CHAIN ASK — the whole route in visit order, for ONE client decision.
 *  EB + hour only (the street stays in Turn 3), the honest note when a start
 *  hour had to move, and the flats that could not be linked. Ends with the
 *  confirmation question so the funnel has something to consume. */
export function buildChainAsk(
  stops: Array<{ eb: number; hour: number }>,
  opts: { dropped?: number[]; shiftedBy?: number } = {},
): string {
  const hh = (h: number): string => `${String(h).padStart(2, '0')}:00`;
  const lines = stops.map(s => `${hh(s.hour)} — Евидентен број ${s.eb}`);
  const shift = opts.shiftedBy
    ? ` Часовите почнав ${opts.shiftedBy > 0 ? 'подоцна' : 'порано'} за ${Math.abs(opts.shiftedBy)} ${Math.abs(opts.shiftedBy) === 1 ? 'час' : 'часа'}, за да бидат поврзани еден по друг.`
    : '';
  const dropped = opts.dropped && opts.dropped.length > 0
    ? `\nЗа жал, не можев да ги поврзам во истиот ден: Евидентен број ${opts.dropped.join(', ')} — за нив ќе најдеме друг термин.`
    : '';
  // ONE STOP is a single visit, whatever the route was meant to be (the others
  // were dropped) — «посетите» would promise visits that do not exist.
  const one = stops.length === 1;
  const head = one ? 'Посета:' : 'Посети по ред, една по друга:';
  const ask = one ? 'Дали да ја потврдам посетата?' : 'Дали да ги потврдам посетите?';
  return `${head}\n\n${lines.join('\n')}${dropped}${shift}\n\n${ask}`;
}

/** The day-before plan: the SAME lines the client got at confirmation, one per
 *  stop, in visit order. `stops` is the whole chain, so one message carries the
 *  day's route rather than N separate reminders. */
export function buildPlanReminder(
  stops: Array<{ eb: number; when: Date }>,
  agentPhone: string,
  withAddress: Array<{ address?: string; mapsUrl?: string }> = [],
): string {
  const lines = stops.map((s, i) => buildPlanLine(s.eb, s.when, agentPhone,
    withAddress[i] ? { ...withAddress[i], withAddress: true } : {}));
  return lines.join('\n\n');
}

/** The turn names AS THE OPERATOR READS THEM. One vocabulary for the log, the
 *  visit_turns table and this file — the old log mixed «ARRANGED VISIT» with
 *  «VISIT CONFIRMATION 2 TURN» / «3 TURN LOCATION SENT», so the operator could
 *  not tell which protocol step a line belonged to (visit audit #7). */
export type VisitLogTurn = 'address_confirm' | 'arranged' | 'confirm' | 'location' | 'plan_day_before';

const LOG_LABEL: Record<VisitLogTurn, string> = {
  address_confirm: 'TURN 0 ADDRESS CONFIRM',
  arranged: 'TURN 1 ARRANGED',
  confirm: 'TURN 2 MORNING CONFIRM',
  location: 'TURN 3 LOCATION',
  plan_day_before: 'PLAN DAY-BEFORE',
};

/** Operator log line per turn: who (owner/client) got what, with the dossier
 *  the operator actually needs (term, address, agent). The CLIENT: Name (phone)
 *  shape is a contract — the TUI routes a log line to its conversation by that
 *  phone, so it must stay verbatim. */
export function buildOperatorLog(
  eb: number,
  turn: VisitLogTurn,
  owner: Party | undefined,
  client: Party | undefined,
  status: { owner: 'OK' | 'FAIL' | '-//-'; client: 'OK' | 'FAIL' | '-//-' },
  detail: { when?: Date; address?: string; agentPhone?: string; note?: string } = {},
): string {
  const p = (x: Party | undefined, st: string): string =>
    x ? `${x.name} (${x.phone}) ${st}` : `непознат ${st}`;
  const tail: string[] = [];
  if (detail.when) tail.push(`КОГА: ${formatDateOnly(detail.when)} во ${formatTimeOnly(detail.when)}`);
  if (detail.address) tail.push(`АДРЕСА: ${detail.address}`);
  if (detail.agentPhone) tail.push(`АГЕНТ: ${detail.agentPhone}`);
  if (detail.note) tail.push(detail.note);
  return `[ЛОГ ПОСЕТА ЕБ ${eb}] ${LOG_LABEL[turn]} — OWNER: ${p(owner, status.owner)} / CLIENT: ${p(client, status.client)}`
    + (tail.length ? ` — ${tail.join(' — ')}` : '');
}
